// Live Mermaid rendering for ```mermaid code blocks — via Crepe's built-in
// code-block "preview" mechanism, the same one LaTeX uses. The diagram is the
// block's preview, shown by default with the source hidden; the code block's own
// toolbar gets a Hide/Edit toggle (next to Copy). No custom widget decoration.
//
// The render engine (lazy import, theme-keyed LRU cache, concurrency gate,
// retry) lives in editor-mermaid-core.js — Milkdown-free so the VSCode
// extension webview bundles the SAME implementation. This module keeps only the
// ProseMirror-facing half and re-exports the keep-mode API so existing imports
// (KeepEditor, Editor) stay unchanged. The shared cache means a diagram drawn
// in keep mode paints instantly in the rich editor and vice-versa.
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { ensureRender, curTheme, peekMermaidSvg, getMermaidSvg } from './editor-mermaid-core.js'

export { peekMermaidSvg, getMermaidSvg }

// ---- rich-editor preview (Crepe code-block renderPreview) ---------------------
// The HTML string to show as the block's preview for a given mermaid source.
// Kicks off (or reuses) a render; `onUpdate` fires when an async render lands.
function previewHtml(code, t, onUpdate) {
  const trimmed = (code || '').trim()
  if (!trimmed) return ''
  const c = peekMermaidSvg(trimmed)
  if (c && c.svg) return c.svg
  if (c && c.error) return `<div class="hm-mermaid-error">${t('mermaid.error')} ${escapeHtml(c.error)}</div>`
  ensureRender(curTheme(), trimmed, onUpdate)
  return `<div class="hm-mermaid-hint">${t('mermaid.rendering')}</div>`
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

// Build the `renderPreview(language, text, setPreview)` for codeBlockConfig.
// Returns null for non-mermaid blocks (no preview, no toggle → normal code
// block). For mermaid, returns the diagram HTML synchronously when cached, or
// kicks the async render and updates via setPreview when it lands.
export function createMermaidPreviewRenderer(getT) {
  const t = (k) => (getT ? getT(k) : k)
  return (language, text, setPreview) => {
    const lang = String(language || '').toLowerCase()
    if (lang !== 'mermaid') return null
    const html = previewHtml(text, t, () => setPreview(previewHtml(text, t, () => {})))
    return html // a string return sets the preview immediately (sync path)
  }
}

// ---- multi-diagram split ------------------------------------------------------
// Mermaid diagram-type keywords that START a new diagram. A diagram header = a
// directional keyword + direction (`flowchart TD` / `graph LR`) OR a standalone
// keyword (`sequenceDiagram`, …). The direction requirement avoids matching
// common words (`graph`, `pie`) inside labels/text.
const DIRECTIONS = '(?:TB|TD|BT|RL|LR)'
const DIAGRAM_HEADER = new RegExp(
  '(?:flowchart|graph)\\s+' + DIRECTIONS + '\\b' +
    '|(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context)(?=\\s|$)',
  'gi'
)

// Does `text` begin with a mermaid diagram header? (Kept here for parity with
// upstream; the paste handler carries its own inlined copy in editor-md-paste.js.)
export function startsAsMermaid(text) {
  const t = String(text || '').trim()
  if (!t) return false
  DIAGRAM_HEADER.lastIndex = 0
  const m = DIAGRAM_HEADER.exec(t)
  return !!m && m.index === 0
}

// Split mermaid source into one chunk per diagram, by finding every diagram
// header ANYWHERE (a 2nd paste often concatenates mid-line: `…Car]flowchart TD`,
// so a line-start check misses it). Returns [] for a single/empty diagram.
function splitDiagrams(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n')
  DIAGRAM_HEADER.lastIndex = 0
  const idx = []
  let m
  while ((m = DIAGRAM_HEADER.exec(t))) idx.push(m.index)
  if (idx.length <= 1) return []
  const segs = []
  for (let i = 0; i < idx.length; i++) {
    const seg = t.slice(idx[i], idx[i + 1] ?? t.length).replace(/^\s+|\s+$/g, '')
    if (seg) segs.push(seg)
  }
  return segs
}

// appendTransaction plugin: when a mermaid block ends up holding 2+ diagrams,
// split it into one code_block per diagram. Catches the "paste a 2nd diagram
// into the block" mashup (the paste itself is handled by CodeMirror, below the
// ProseMirror layer, so we react after the fact). Idempotent — each resulting
// block has one diagram, so it won't re-split.
export function createMermaidSplitPlugin() {
  return new Plugin({
    key: new PluginKey('hm-mermaid-split'),
    appendTransaction(transs, _oldState, newState) {
      if (!transs.some((t) => t.docChanged)) return null
      const jobs = []
      newState.doc.descendants((node, pos) => {
        if (
          node.type.name === 'code_block' &&
          String(node.attrs.language || '').toLowerCase() === 'mermaid'
        ) {
          const segs = splitDiagrams(node.textContent)
          if (segs.length > 1) jobs.push({ pos, size: node.nodeSize, segs })
        }
        return true
      })
      if (!jobs.length) return null
      const tr = newState.tr
      // Replace from the last block back so earlier positions stay valid.
      jobs.sort((a, b) => b.pos - a.pos)
      for (const { pos, size, segs } of jobs) {
        const type = newState.schema.nodes.code_block
        const nodes = segs.map((s) => type.create({ language: 'mermaid' }, s ? newState.schema.text(s) : null))
        tr.replaceWith(pos, pos + size, nodes)
      }
      return tr.setMeta('addToHistory', false)
    }
  })
}
