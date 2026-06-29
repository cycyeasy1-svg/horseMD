// Smart paste for Markdown.
//
// Milkdown's default paste does NOT parse pasted Markdown source — pasting a doc
// with `#` headings / tables / blockquotes / `$$` math / ```fences / `---` front
// matter lands as flat text. This handler runs in the DOM CAPTURE phase (before
// ProseMirror's own paste handler, which would build a slice from text/html and
// bypass us), reads text/plain from the clipboard, and — when it clearly IS
// Markdown — runs it through Milkdown's own remark parser so it renders with full
// fidelity. Scoped triggers:
//   (1) raw mermaid code that starts with a diagram header → a mermaid block;
//   (2) any strong Markdown block marker → parse the whole clipboard as Markdown.
// Never takes over when pasting INTO a code block (append code there).
import { Slice, Fragment } from '@milkdown/prose/model'

// Mermaid diagram-header detection (inlined so this module stays independent of
// the mermaid renderer). A header is a direction-qualified flow/graph or a
// standalone diagram keyword; the direction requirement avoids matching common
// words (`graph`, `pie`) inside ordinary prose.
const DIRECTIONS = '(?:TB|TD|BT|RL|LR)'
const DIAGRAM_HEADER = new RegExp(
  '(?:flowchart|graph)\\s+' + DIRECTIONS + '\\b' +
    '|(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context)(?=\\s|$)',
  'gi'
)

// Does `text` begin with a mermaid diagram header?
function startsAsMermaid(text) {
  const t = String(text || '').trim()
  if (!t) return false
  DIAGRAM_HEADER.lastIndex = 0
  const m = DIAGRAM_HEADER.exec(t)
  return !!m && m.index === 0
}

function looksLikeMarkdown(text) {
  if (/^#{1,6}\s/m.test(text)) return true
  if (/^```/m.test(text)) return true
  if (/^>\s/m.test(text)) return true
  if (/^\|.*\|.*\n/m.test(text)) return true
  if (/^([-*+]\s|\d+\.\s)/m.test(text)) return true
  if (/\$\$/.test(text)) return true
  if (/^(\*\*\*|---)\s*$/m.test(text)) return true // hr / front-matter fence
  return false
}

// Attach a capture-phase paste listener on the editor DOM. Returns a cleanup fn.
export function attachMdPasteHandler(view, parse) {
  const onPaste = (event) => {
    // Pasting INTO a code block should append code, not restructure.
    if (view.state.selection.$from.parent.type.name === 'code_block') return
    const text = event.clipboardData?.getData('text/plain') || ''
    if (!text) return
    const schema = view.state.schema

    let handled = false
    if (startsAsMermaid(text)) {
      const body = text.replace(/\s+$/, '')
      const node = schema.nodes.code_block.create(
        { language: 'mermaid' },
        body ? schema.text(body) : null
      )
      handled = insert(view, Fragment.from(node))
    } else if (looksLikeMarkdown(text)) {
      const doc = parse(text)
      if (doc && doc.content && doc.content.size > 0) {
        handled = insert(view, doc.content)
      }
    }

    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  // capture = true so we run BEFORE ProseMirror's own paste handler (which would
  // build a slice from text/html and skip us).
  view.dom.addEventListener('paste', onPaste, true)
  return () => view.dom.removeEventListener('paste', onPaste, true)
}

function insert(view, fragment) {
  try {
    const tr = view.state.tr.replaceSelection(new Slice(fragment, 0, 0))
    tr.scrollIntoView()
    view.dispatch(tr)
    return true
  } catch {
    return false
  }
}
