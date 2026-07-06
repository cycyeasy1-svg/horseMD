// Keep-mode webview — framework-free port of the app's KeepEditor.jsx.
//
// The TextDocument (in the extension host) is the single source of truth. This
// view renders it and, on every committed edit, posts a MINIMAL line-range diff
// ({startLine,endLine,lines}) back to the host, which applies one WorkspaceEdit —
// so untouched bytes never move (zero diff) and VSCode owns dirty/undo/save.
//
// We keep `lines` \r-stripped (host owns the EOL and re-joins with the document's
// own line-ending), which collapses the app's rawLines/viewLines distinction into
// one array and drops all the manual \r juggling.

import {
  renderDoc,
  renderBlockInner,
  inline,
  replaceCellInLine,
  insertColumnInLine,
  removeColumnInLine,
  buildTableRow,
  extractHeadings
} from '../../../src/renderer/src/keep-parser.js'
import { inlineRichStyles } from '../../../src/renderer/src/components/editor-copy.js'
import { isRelativePath } from '../../../src/renderer/src/components/editor-images.js'
import { enhanceKeepTables } from '../../../src/renderer/src/components/editor-tablescroll.js'
// Find-in-document reuses the app's pure helpers (CSS Custom Highlight API — paints
// ranges without mutating the DOM). We scope the search to #km-host and drop matches
// inside hover affordances / hidden sections in runFind below.
import {
  clearFindHighlights,
  findRangesInEl,
  paintFindHighlights,
  scrollRangeIntoView,
  findMatchesInText,
  replaceMatchesInText
} from '../../../src/renderer/src/find.js'
import {
  getMermaidSvg,
  peekMermaidSvg,
  setMermaidThemeResolver
} from '../../../src/renderer/src/components/editor-mermaid-core.js'
import { makeT } from './i18n.js'
// Layout controls share the app's pure settings module directly (apply* set CSS
// vars on the document root + the full-width body class; presets/bounds match).
// We persist via the host's globalState instead of localStorage.
import {
  applyPageWidth,
  applyFontSize,
  applyZoom,
  applyLineHeight,
  applyParagraphSpacing,
  DEFAULT_SETTINGS,
  PAGE_WIDTH_PRESETS,
  PAGE_WIDTH_MIN,
  PAGE_WIDTH_MAX,
  FONT_SIZE_PRESETS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  ZOOM_PRESETS,
  ZOOM_MIN,
  ZOOM_MAX,
  LINE_HEIGHT_PRESETS,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_MAX,
  PARA_SPACING_PRESETS,
  PARA_SPACING_MIN,
  PARA_SPACING_MAX
} from '../../../src/renderer/src/settings.js'
import './keep.css'
import 'katex/dist/katex.min.css'

const vscode = acquireVsCodeApi()

// An explicit keep theme (warm light / dark) overrides VSCode's own theme; else
// VSCode adds `vscode-dark` / `vscode-high-contrast` to <body> for dark themes.
setMermaidThemeResolver(() => {
  const c = document.body.classList
  if (c.contains('hm-theme-warm-dark')) return 'dark'
  if (c.contains('hm-theme-warm-light')) return 'default'
  return c.contains('vscode-dark') || c.contains('vscode-high-contrast') ? 'dark' : 'default'
})

const COPY_WRAP =
  'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#24292f;'

const host = document.getElementById('km-host')

// ── document state ──
let lines = [] // \r-stripped source mirror
let blocks = []
let filterState = {} // tableIdx -> { colIdx: Set(excluded values) }
let baseUri = '' // webview URI of the document folder, for relative images
let t = makeT('en')
let ready = false
let pendingAnchor = null // #fragment carried by a cross-file link, applied after first paint
let layout = { ...DEFAULT_SETTINGS } // page width / font size / zoom / line-height / para spacing
let theme = 'auto' // 'auto' (follow VSCode) | 'warm-light' | 'warm-dark'
let langPref = 'auto' // 'auto' | 'en' | 'zh' | 'ja' — the raw picker choice
const collapsed = new Set() // collapsed heading-section keys ("level:text"), survives re-render
let tableScroll = null // wide-table top-scrollbar + floating-header handle (editor-tablescroll)

const stripCR = (l) => (l.endsWith('\r') ? l.slice(0, -1) : l)
const escapeHtmlLocal = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttrLocal = (s) => escapeHtmlLocal(s).replace(/"/g, '&quot;')

// ── host messaging ──
window.addEventListener('message', (e) => {
  const msg = e.data
  if (!msg) return
  if (msg.type === 'init') {
    baseUri = (msg.baseUri || '').replace(/\/+$/, '')
    t = makeT(msg.lang || 'en')
    langPref = msg.langPref || 'auto'
    theme = msg.theme || 'auto'
    applyTheme(theme)
    if (msg.layout) layout = { ...DEFAULT_SETTINGS, ...msg.layout }
    applyLayout(layout)
    ensureSourceButton()
    ensureOutlineButton()
    ensureSettingsButton()
    if (msg.anchor) pendingAnchor = msg.anchor // consumed by finishRender
    setText(msg.text || '')
  } else if (msg.type === 'scrollToAnchor') {
    scrollToAnchor(msg.slug)
  } else if (msg.type === 'scrollToLine') {
    scrollToSourceLine(msg.line | 0)
  } else if (msg.type === 'update') {
    // External edit / undo / redo — reset the mirror and re-render. Any open edit
    // popover is torn down (its anchor may no longer exist).
    closeFloating()
    setText(msg.text || '')
  } else if (msg.type === 'imageSaved') {
    onImageSaved(msg)
  } else if (msg.type === 'imageError') {
    const p = imgPending.get(msg.reqId)
    imgPending.delete(msg.reqId)
    if (p) showToast(msg.code === 'untitled' ? t('img.untitled') : t('img.saveFailed') + ' ' + (msg.code || ''))
  }
})

function setText(text) {
  lines = text.split('\n').map(stripCR)
  filterState = {}
  rerender()
}

// Minimal-diff commit: trim the common prefix/suffix between the old and new
// `lines`, post just the changed range. `endLine < startLine` ⇒ a pure insertion.
function commit(oldLines) {
  const a = oldLines
  const b = lines
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const startLine = p
  const endLine = a.length - 1 - s
  const slice = b.slice(p, b.length - s)
  if (endLine < startLine && slice.length === 0) return // nothing actually changed
  vscode.postMessage({ type: 'replaceLines', startLine, endLine, lines: slice })
}

// Run a mutation against `lines`, then post its minimal diff to the host.
function mutate(fn) {
  const old = lines.slice()
  fn()
  commit(old)
}

// ── image src resolution (relative → webview URI) ──
function resolveImgSrcs(root) {
  if (!baseUri) return
  root.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src')
    if (src && isRelativePath(src)) {
      try {
        img.src = new URL(src, baseUri + '/').toString()
      } catch {
        /* leave as-is */
      }
    }
  })
}

// ── render ──
const LARGE_DOC_LINES = 1200
let afterPaintRaf = 0
let embedObserver = null
let katexPromise = null
const cancelAfterPaint = () => {
  if (afterPaintRaf) {
    cancelAnimationFrame(afterPaintRaf)
    afterPaintRaf = 0
  }
}

function rerender() {
  const r = renderDoc(lines, filterState, {
    srcEditLabel: t('keep.editSource'),
    collapseLabel: t('keep.toggleSection'),
    interactiveTasks: true // task checkboxes are clickable; onClick writes the toggle back
  })
  r.blocks.forEach((b, i) => {
    b.bi = i
  })
  blocks = r.blocks
  const html = r.html

  const paint = () => {
    host.innerHTML = html
    resolveImgSrcs(host)
    cancelAfterPaint()
    afterPaintRaf = requestAnimationFrame(finishRender)
  }

  cancelAfterPaint()
  if (blocks.length && lines.length > LARGE_DOC_LINES) {
    host.innerHTML =
      '<div class="km-loading"><span class="km-spinner"></span>' +
      escapeHtmlLocal(t('keep.loading')) +
      '</div>'
    afterPaintRaf = requestAnimationFrame(() => {
      afterPaintRaf = requestAnimationFrame(paint)
    })
  } else {
    paint()
  }
}

function finishRender() {
  applyMultilineFlags()
  applyCollapsed()
  Object.keys(filterState).forEach((ti) => applyFilter(parseInt(ti)))
  if (embedObserver) embedObserver.disconnect()
  observeEmbeds()
  // Wide-table affordances (in-flow top scrollbar + viewport-fixed floating header)
  // live partly outside the block flow (the float is appended to <body>), so rebuild
  // them once the document is painted and tear the old ones down first.
  tableScroll?.destroy()
  tableScroll = enhanceKeepTables(host, host.closest('.editor-scroll'), {
    onFilterClick: (clonedBtn) => openFilterPop(clonedBtn),
    onHeaderEdit: (clonedTh) => {
      // Resolve the clicked clone to the REAL <th> (same data-line/data-ci → same
      // source line) and edit that, anchoring the popup under the visible clone.
      const real = host.querySelector(
        'th[data-line="' +
          clonedTh.getAttribute('data-line') +
          '"][data-ci="' +
          clonedTh.getAttribute('data-ci') +
          '"]'
      )
      if (real) openCellPop(real, clonedTh)
    }
  })
  // A re-render replaces the DOM, invalidating any painted find ranges — recompute
  // against the fresh nodes so highlights survive edits / external updates.
  if (findBar && findBar.style.display !== 'none' && findQuery) runFind(findQuery)
  if (pendingAnchor) {
    const a = pendingAnchor
    pendingAnchor = null
    scrollToAnchor(a)
  }
}

// ── heading section collapse / expand (display-only; never touches the source) ──
// A heading block carries `data-hlevel`. Collapsing one hides every following
// block until the next heading of the same or higher level. `collapsed` (a Set of
// section keys) survives the full re-render an edit triggers; the live
// `km-collapsed` class on heading blocks is what visibility is derived from.
function sectionKey(headEl) {
  const lvl = headEl.getAttribute('data-hlevel') || ''
  const h = headEl.querySelector('h1,h2,h3,h4,h5,h6')
  return lvl + ':' + (h ? (h.textContent || '').trim() : '')
}
function refreshVisibility() {
  const stack = []
  host.querySelectorAll('.km-block').forEach((el) => {
    const isHeading = el.hasAttribute('data-hlevel')
    const lvl = isHeading ? parseInt(el.getAttribute('data-hlevel')) : null
    if (isHeading) while (stack.length && stack[stack.length - 1] >= lvl) stack.pop()
    el.classList.toggle('km-section-hidden', stack.length > 0)
    if (isHeading && el.classList.contains('km-collapsed')) stack.push(lvl)
  })
}
function toggleSection(headEl) {
  const isCollapsed = !headEl.classList.contains('km-collapsed')
  headEl.classList.toggle('km-collapsed', isCollapsed)
  if (isCollapsed) collapsed.add(sectionKey(headEl))
  else collapsed.delete(sectionKey(headEl))
  refreshVisibility()
  tableScroll?.update() // hidden/shown tables change the layout
}
function applyCollapsed() {
  host.querySelectorAll('.km-block[data-hlevel]').forEach((el) => {
    el.classList.toggle('km-collapsed', collapsed.has(sectionKey(el)))
  })
  refreshVisibility()
}

function applyMultilineFlags() {
  const elByBi = new Map()
  host.querySelectorAll('.km-block').forEach((el) => {
    const bi = el.getAttribute('data-bi')
    if (bi != null) elByBi.set(Number(bi), el)
  })
  const baseFs = parseFloat(getComputedStyle(host).fontSize) || 16
  const pending = []
  blocks.forEach((b, bi) => {
    if (b.type === 'table') return
    const bl = elByBi.get(bi)
    if (!bl) return
    let multi = b.end > b.start
    if (!multi) {
      const content = Array.from(bl.children).find((c) => !c.classList.contains('km-src-edit'))
      if (content) multi = content.offsetHeight > baseFs * 2.2
    }
    pending.push([bl, multi])
  })
  pending.forEach(([bl, multi]) => bl.classList.toggle('km-multiline', multi))
}
function applyMultilineForBlock(bl, b) {
  if (!bl || b.type === 'table') return
  let multi = b.end > b.start
  if (!multi) {
    const content = Array.from(bl.children).find((c) => !c.classList.contains('km-src-edit'))
    if (content) {
      const fs = parseFloat(getComputedStyle(bl).fontSize) || 16
      multi = content.offsetHeight > fs * 2.2
    }
  }
  bl.classList.toggle('km-multiline', multi)
}

// ── embeds (mermaid / KaTeX) ──
const SVG_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
const icon = (w, body) => '<svg width="' + w + '" height="' + w + '" ' + SVG_ATTRS + '>' + body + '</svg>'
const ICON_ZOOM = icon(
  15,
  '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>'
)
const ICON_PLUS = icon(16, '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>')
const ICON_MINUS = icon(16, '<line x1="5" y1="12" x2="19" y2="12"/>')
const ICON_FIT = icon(
  16,
  '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'
)
const ICON_CLOSE = icon(16, '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')

// Paint a rendered diagram + append the magnifier affordance (opens the zoom
// lightbox). Serialization/copy strips `button`s, so this never pollutes output.
function setMermaidSvg(el, svg) {
  el.innerHTML = svg
  el.classList.add('km-mermaid-ready')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'km-mermaid-zoom'
  btn.title = t('mermaid.zoom')
  btn.setAttribute('aria-label', t('mermaid.zoom'))
  btn.innerHTML = ICON_ZOOM
  el.appendChild(btn)
}
function renderMermaidEl(el) {
  const code = el.getAttribute('data-code') || ''
  const cached = peekMermaidSvg(code)
  if (cached && cached.svg) {
    setMermaidSvg(el, cached.svg)
    return
  }
  el.classList.add('hm-mermaid-hint')
  el.textContent = t('mermaid.rendering')
  getMermaidSvg(code).then((res) => {
    if (!host.contains(el)) return
    el.classList.remove('hm-mermaid-hint')
    if (res && res.svg) setMermaidSvg(el, res.svg)
    else {
      el.classList.add('hm-mermaid-error')
      el.textContent = t('mermaid.error') + ' ' + ((res && res.error) || '')
    }
  })
}
function getKatex() {
  if (!katexPromise) {
    katexPromise = import('katex')
      .then((m) => m.default || m)
      .catch(() => null)
  }
  return katexPromise
}
function renderMathEl(el) {
  getKatex().then((katex) => {
    if (!katex || !host.contains(el)) return
    const tex = el.getAttribute('data-tex') || ''
    try {
      katex.render(tex, el, { displayMode: true, throwOnError: false })
    } catch (e) {
      el.classList.add('hm-mermaid-error')
      el.textContent = String((e && e.message) || e)
    }
  })
}
function ensureEmbedObserver() {
  if (!embedObserver) {
    embedObserver = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return
          obs.unobserve(e.target)
          if (e.target.classList.contains('km-mermaid')) renderMermaidEl(e.target)
          else renderMathEl(e.target)
        })
      },
      { root: host.closest('.editor-scroll') || null, rootMargin: '400px' }
    )
  }
  return embedObserver
}
function observeEmbed(el) {
  if (el.classList.contains('km-mermaid')) {
    const cached = peekMermaidSvg(el.getAttribute('data-code') || '')
    if (cached && cached.svg) {
      setMermaidSvg(el, cached.svg)
      return
    }
  }
  ensureEmbedObserver().observe(el)
}
function observeEmbeds(root) {
  ;(root || host).querySelectorAll('.km-mermaid, .km-math').forEach(observeEmbed)
}

// ── mermaid zoom lightbox ──
// A rendered diagram often shrinks to fit the column, so dense ones become
// unreadable. Its magnifier opens a full-viewport overlay with wheel-zoom
// (centered on the cursor) + drag pan. Display-only: clones the SVG, never
// touches the document.
let zoomOverlay = null
function onZoomKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeMermaidZoom()
  }
}
function closeMermaidZoom() {
  if (!zoomOverlay) return
  document.removeEventListener('keydown', onZoomKey)
  zoomOverlay.remove()
  zoomOverlay = null
}
function openMermaidZoom(svgEl) {
  closeMermaidZoom()
  const overlay = document.createElement('div')
  overlay.className = 'km-zoom-overlay'
  const stage = document.createElement('div')
  stage.className = 'km-zoom-stage'
  const svg = svgEl.cloneNode(true)
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  svg.style.width = ''
  svg.style.height = ''
  svg.style.maxWidth = 'none'
  svg.style.maxHeight = 'none'
  stage.appendChild(svg)
  overlay.appendChild(stage)

  let scale = 1
  let tx = 0
  let ty = 0
  const label = document.createElement('span')
  label.className = 'km-zoom-label'
  const apply = () => {
    stage.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'
    label.textContent = Math.round(scale * 100) + '%'
  }
  const zoomAt = (cx, cy, next) => {
    const ns = Math.min(8, Math.max(0.2, next))
    tx = cx - (cx - tx) * (ns / scale)
    ty = cy - (cy - ty) * (ns / scale)
    scale = ns
    apply()
  }

  const bar = document.createElement('div')
  bar.className = 'km-zoom-bar'
  const mkBtn = (html, title, fn) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'km-zoom-btn'
    b.title = title
    b.setAttribute('aria-label', title)
    b.innerHTML = html
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      fn()
    })
    return b
  }
  bar.appendChild(mkBtn(ICON_MINUS, t('mermaid.zoomOut'), () => zoomAt(0, 0, scale / 1.25)))
  bar.appendChild(label)
  bar.appendChild(mkBtn(ICON_PLUS, t('mermaid.zoomIn'), () => zoomAt(0, 0, scale * 1.25)))
  bar.appendChild(
    mkBtn(ICON_FIT, t('mermaid.zoomReset'), () => {
      scale = 1
      tx = 0
      ty = 0
      apply()
    })
  )
  bar.appendChild(mkBtn(ICON_CLOSE, t('mermaid.zoomClose'), closeMermaidZoom))
  overlay.appendChild(bar)

  overlay.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const r = overlay.getBoundingClientRect()
      const cx = e.clientX - r.left - r.width / 2
      const cy = e.clientY - r.top - r.height / 2
      zoomAt(cx, cy, scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12))
    },
    { passive: false }
  )

  let dragging = false
  let sx = 0
  let sy = 0
  stage.addEventListener('pointerdown', (e) => {
    dragging = true
    sx = e.clientX - tx
    sy = e.clientY - ty
    overlay.classList.add('km-zoom-grabbing')
    try {
      stage.setPointerCapture(e.pointerId)
    } catch {
      /* not all pointers are capturable */
    }
  })
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return
    tx = e.clientX - sx
    ty = e.clientY - sy
    apply()
  })
  const endDrag = () => {
    dragging = false
    overlay.classList.remove('km-zoom-grabbing')
  }
  stage.addEventListener('pointerup', endDrag)
  stage.addEventListener('pointercancel', endDrag)
  // Click / double-click the empty backdrop (not the diagram) closes.
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) closeMermaidZoom()
  })

  document.body.appendChild(overlay)
  document.addEventListener('keydown', onZoomKey)
  zoomOverlay = overlay
  apply()
}

// ── floating popovers (cell editor / filter / table menu / confirm) ──
let activeCellPop = null
let activeBlockEdit = null
let activeConfirm = null
let activePop = null
let activePopBtn = null
let activeMenu = null

function closeFloating() {
  closePop()
  closeMenu()
  closeConfirm()
  closeCellPop()
  closeSettingsPop()
  closeOutlinePop()
}

// ── table cell editing ──
function closeCellPop() {
  if (activeCellPop) {
    activeCellPop.pop.remove()
    activeCellPop = null
  }
}
function repositionCellPop() {
  if (!activeCellPop) return
  const { pop } = activeCellPop
  const r = (activeCellPop.anchor || activeCellPop.td).getBoundingClientRect()
  const pw = pop.offsetWidth || 360
  const ph = pop.offsetHeight || 160
  const left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8))
  let top = r.bottom + 6
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6)
  pop.style.left = left + 'px'
  pop.style.top = top + 'px'
  const sc = host.closest('.editor-scroll')
  if (sc) {
    const sr = sc.getBoundingClientRect()
    pop.style.visibility = r.bottom < sr.top || r.top > sr.bottom ? 'hidden' : 'visible'
  }
}
function repositionFilterPop() {
  if (!activePop || !activePopBtn) return
  const r = activePopBtn.getBoundingClientRect()
  activePop.style.left = Math.min(r.left, window.innerWidth - 260) + 'px'
  activePop.style.top = r.bottom + 4 + 'px'
  const sc = host.closest('.editor-scroll')
  if (sc) {
    const sr = sc.getBoundingClientRect()
    activePop.style.visibility = r.bottom < sr.top || r.top > sr.bottom ? 'hidden' : 'visible'
  }
}
function commitCellPop() {
  const cur = activeCellPop
  if (!cur) return
  const ta = cur.pop.querySelector('textarea')
  const val = ta ? ta.value.replace(/\n/g, '<br>') : cur.raw
  const td = cur.td
  closeCellPop()
  if (val === cur.raw) return
  mutate(() => {
    lines[cur.lineIdx] = stripCR(replaceCellInLine(lines[cur.lineIdx], cur.colIdx, val))
  })
  if (td && host.contains(td)) {
    td.setAttribute('data-raw', val)
    if (td.tagName === 'TH') {
      const span = td.querySelector('.km-th-content')
      if (span) span.innerHTML = inline(val)
      tableScroll?.refreshContent() // keep the floating-header clone's text in sync
    } else {
      td.innerHTML = inline(val)
    }
    resolveImgSrcs(td)
  } else {
    rerender()
  }
}

// ── block source edit ──
function closeBlockEdit(commitChange) {
  const cur = activeBlockEdit
  if (!cur) return
  activeBlockEdit = null
  if (commitChange) {
    const { ta, b } = cur
    const newLines = ta.value.split('\n').map(stripCR)
    mutate(() => {
      lines.splice(b.start, b.end - b.start + 1, ...newLines)
    })
    rerender()
    return
  }
  const b = cur.b
  const bi = b.bi != null ? b.bi : blocks.indexOf(b)
  const blockDiv = bi >= 0 ? host.querySelector('.km-block[data-bi="' + bi + '"]') : null
  if (blockDiv) {
    blockDiv.innerHTML = renderBlockInner(b, bi, lines, {
      srcEditLabel: t('keep.editSource'),
      filterState,
      interactiveTasks: true
    })
    resolveImgSrcs(blockDiv)
    applyMultilineForBlock(blockDiv, b)
    observeEmbeds(blockDiv)
  } else {
    rerender()
  }
}

// ── confirm modal ──
function closeConfirm() {
  if (activeConfirm) {
    activeConfirm.remove()
    activeConfirm = null
  }
}
function showConfirm(message, { onSave, onDiscard }) {
  closeConfirm()
  const wrap = document.createElement('div')
  const backdrop = document.createElement('div')
  backdrop.className = 'menu-backdrop'
  backdrop.style.zIndex = '1400'
  const box = document.createElement('div')
  box.className = 'hm-rename-modal'
  box.style.zIndex = '1401'
  box.style.animation = 'fadeIn 0.12s var(--ease-out)'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  const title = document.createElement('div')
  title.className = 'hm-rename-title'
  title.textContent = message
  const actions = document.createElement('div')
  actions.className = 'hm-rename-actions'
  const discard = document.createElement('button')
  discard.type = 'button'
  discard.textContent = t('keep.editDiscardBtn')
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = t('edit.cancel')
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary'
  save.textContent = t('keep.editSaveBtn')
  actions.append(save, discard, cancel)
  box.append(title, actions)
  wrap.append(backdrop, box)
  document.body.appendChild(wrap)
  activeConfirm = wrap
  const done = (fn) => () => {
    closeConfirm()
    fn?.()
  }
  backdrop.onclick = done(null)
  cancel.onclick = done(null)
  discard.onclick = done(onDiscard)
  save.onclick = done(onSave)
  save.focus({ preventScroll: true })
}

// Enforce "one edit bar": close whatever is open (prompting if dirty), then build.
function openAfterClose(build) {
  const cell = activeCellPop
  const blk = activeBlockEdit
  if (!cell && !blk) return build()
  const msg = t('confirm.keepEditSave')
  if (cell) {
    const ta = cell.pop.querySelector('textarea')
    const val = ta ? ta.value.replace(/\n/g, '<br>') : cell.raw
    if (val === cell.raw) {
      closeCellPop()
      return build()
    }
    return showConfirm(msg, {
      onSave: () => {
        commitCellPop()
        build()
      },
      onDiscard: () => {
        closeCellPop()
        build()
      }
    })
  }
  if (blk.ta.value === blk.originalRaw) {
    closeBlockEdit(false)
    return build()
  }
  return showConfirm(msg, {
    onSave: () => {
      closeBlockEdit(true)
      build()
    },
    onDiscard: () => {
      closeBlockEdit(false)
      build()
    }
  })
}

function openCellPop(td, anchorEl) {
  openAfterClose(() => {
    if (!host.contains(td)) {
      const lineAttr = td.getAttribute('data-line')
      const ciAttr = td.getAttribute('data-ci')
      const sel =
        'td[data-line="' + lineAttr + '"][data-ci="' + ciAttr + '"],' +
        'th[data-line="' + lineAttr + '"][data-ci="' + ciAttr + '"]'
      td = host.querySelector(sel)
      if (!td) return
    }
    const raw = td.getAttribute('data-raw') || ''
    const lineIdx = parseInt(td.getAttribute('data-line'))
    const colIdx = parseInt(td.getAttribute('data-ci'))
    const pop = document.createElement('div')
    pop.className = 'km-cell-pop'
    const ta = document.createElement('textarea')
    ta.className = 'km-cp-input'
    ta.value = raw.replace(/<br\s*\/?>/gi, '\n')
    const act = document.createElement('div')
    act.className = 'km-cp-actions'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'ok'
    ok.textContent = t('keep.editConfirmKey')
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = t('edit.cancel')
    act.appendChild(ok)
    act.appendChild(cancel)
    pop.appendChild(ta)
    pop.appendChild(act)
    document.body.appendChild(pop)
    activeCellPop = { pop, td, anchor: anchorEl && document.body.contains(anchorEl) ? anchorEl : td, raw, lineIdx, colIdx }
    repositionCellPop()
    ta.focus()
    ta.select()
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeCellPop()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        commitCellPop()
      }
    })
    cancel.onclick = () => closeCellPop()
    ok.onclick = () => commitCellPop()
  })
}

function startBlockEdit(bi) {
  openAfterClose(() => {
    const b = blocks[bi]
    if (!b) return
    const blockDiv = host.querySelector('.km-block[data-bi="' + bi + '"]')
    if (!blockDiv) return
    const raw = lines.slice(b.start, b.end + 1).join('\n')
    const ta = document.createElement('textarea')
    ta.className = 'km-src-editor'
    ta.value = raw
    ta.rows = Math.min(20, raw.split('\n').length + 1)
    const act = document.createElement('div')
    act.className = 'km-src-actions'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'ok'
    ok.textContent = t('keep.editConfirmKey')
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = t('edit.cancel')
    act.appendChild(ok)
    act.appendChild(cancel)
    blockDiv.innerHTML = ''
    blockDiv.appendChild(ta)
    blockDiv.appendChild(act)
    ta.focus()
    activeBlockEdit = { ta, b, originalRaw: raw }
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeBlockEdit(false)
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        closeBlockEdit(true)
      }
    })
    cancel.onclick = () => closeBlockEdit(false)
    ok.onclick = () => closeBlockEdit(true)
  })
}

// ── structural table edits ──
const getTable = (ti) => blocks.filter((b) => b.type === 'table')[ti]

function doInsertRow(ti, ri, where) {
  const b = getTable(ti)
  if (!b) return
  let at
  if (where === 'first') at = b.sepLine + 1
  else if (where === 'above') at = b.dataRows[ri]?.lineIdx
  else at = (b.dataRows[ri]?.lineIdx ?? b.sepLine) + 1
  if (at == null) return
  const row = stripCR(buildTableRow(b.headers.length, lines[b.headerLine] || ''))
  mutate(() => lines.splice(at, 0, row))
  rerender()
}
function doDeleteRow(ti, ri) {
  const b = getTable(ti)
  if (!b) return
  const dr = b.dataRows[ri]
  if (!dr) return
  mutate(() => lines.splice(dr.lineIdx, 1))
  rerender()
}
function doInsertColumn(ti, colIdx) {
  const b = getTable(ti)
  if (!b) return
  mutate(() => {
    for (let ln = b.start; ln <= b.end; ln++) {
      const content = ln === b.sepLine ? '---' : ''
      lines[ln] = stripCR(insertColumnInLine(lines[ln], colIdx, content))
    }
  })
  delete filterState[ti]
  rerender()
}
function doDeleteColumn(ti, colIdx) {
  const b = getTable(ti)
  if (!b || b.headers.length <= 1) return
  mutate(() => {
    for (let ln = b.start; ln <= b.end; ln++) {
      lines[ln] = stripCR(removeColumnInLine(lines[ln], colIdx))
    }
  })
  delete filterState[ti]
  rerender()
}

// ── context menu ──
function closeMenu() {
  if (activeMenu) {
    activeMenu.remove()
    activeMenu = null
  }
}
function openMenu(x, y, items) {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'km-table-menu'
  items.forEach((it) => {
    if (it === 'sep') {
      const hr = document.createElement('div')
      hr.className = 'km-tm-sep'
      menu.appendChild(hr)
      return
    }
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'km-tm-item' + (it.disabled ? ' disabled' : '')
    el.textContent = it.label
    if (!it.disabled)
      el.onclick = () => {
        closeMenu()
        it.fn()
      }
    menu.appendChild(el)
  })
  document.body.appendChild(menu)
  const mw = menu.offsetWidth || 180
  const mh = menu.offsetHeight || 0
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px'
  activeMenu = menu
}
function buildTableItems(items, ti, ri, ci, isHeader) {
  const b = getTable(ti)
  if (isHeader) {
    items.push({ label: t('keep.rowInsertFirst'), fn: () => doInsertRow(ti, ri, 'first') })
  } else {
    items.push({ label: t('keep.rowInsertAbove'), fn: () => doInsertRow(ti, ri, 'above') })
    items.push({ label: t('keep.rowInsertBelow'), fn: () => doInsertRow(ti, ri, 'below') })
  }
  items.push('sep')
  items.push({ label: t('keep.colInsertLeft'), fn: () => doInsertColumn(ti, ci) })
  items.push({ label: t('keep.colInsertRight'), fn: () => doInsertColumn(ti, ci + 1) })
  items.push('sep')
  if (!isHeader) items.push({ label: t('keep.rowDelete'), fn: () => doDeleteRow(ti, ri) })
  items.push({
    label: t('keep.colDelete'),
    fn: () => doDeleteColumn(ti, ci),
    disabled: !b || b.headers.length <= 1
  })
  // Filter clearing lives here because the webview has no status bar to host a
  // document-wide affordance (unlike the Electron app's filter badge).
  items.push('sep')
  items.push({
    label: t('keep.clearTableFilter'),
    fn: () => clearTableFilter(ti),
    disabled: !tableHasFilter(ti)
  })
  items.push({
    label: t('keep.clearAllFilters'),
    fn: () => clearAllFilters(),
    disabled: !anyFilterActive()
  })
}

// ── rich copy ──
function writeClipboard(html, plain) {
  const text = plain || ''
  try {
    navigator.clipboard
      .write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        })
      ])
      .catch(() => navigator.clipboard.writeText(text).catch(() => {}))
  } catch {
    navigator.clipboard?.writeText?.(text).catch(() => {})
  }
}
function richHtml(node) {
  const wrap = document.createElement('div')
  wrap.appendChild(node)
  wrap.querySelectorAll('.km-src-edit, .km-filter-btn, button').forEach((el) => el.remove())
  inlineRichStyles(wrap)
  return { html: `<div style="${COPY_WRAP}">${wrap.innerHTML}</div>`, text: wrap.textContent || '' }
}
function writeRich(node, plain) {
  const r = richHtml(node)
  writeClipboard(r.html, plain != null ? plain : r.text)
}
const copyElement = (el) => writeRich(el.cloneNode(true))
function copySelection(sel) {
  try {
    writeRich(sel.getRangeAt(0).cloneContents(), sel.toString())
  } catch {
    /* nothing selected */
  }
}
function cellPlain(c) {
  if (!c) return ''
  const cl = c.cloneNode(true)
  cl.querySelectorAll('.km-filter-btn').forEach((el) => el.remove())
  cl.querySelectorAll('br').forEach((br) => br.replaceWith(' '))
  return (cl.textContent || '').trim()
}
function wrapRows(rows) {
  const tbl = document.createElement('table')
  const tb = document.createElement('tbody')
  rows.forEach((tr) => tb.appendChild(tr))
  tbl.appendChild(tb)
  return tbl
}
function copyTable(table) {
  const rows = [...table.querySelectorAll('tr')]
  const tsv = rows.map((tr) => [...tr.children].map(cellPlain).join('\t')).join('\n')
  writeRich(table.cloneNode(true), tsv)
}
function copyRow(tr) {
  const tsv = [...tr.children].map(cellPlain).join('\t')
  writeRich(wrapRows([tr.cloneNode(true)]), tsv)
}
function copyColumn(table, ci) {
  const rows = [...table.querySelectorAll('tr')]
  const tsv = rows.map((tr) => cellPlain(tr.children[ci])).join('\n')
  const colRows = rows
    .map((tr) => tr.children[ci])
    .filter(Boolean)
    .map((c) => {
      const tr = document.createElement('tr')
      tr.appendChild(c.cloneNode(true))
      return tr
    })
  writeRich(wrapRows(colRows), tsv)
}
function onCopy(e) {
  if (activeCellPop) return
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !host.contains(sel.anchorNode)) return
  try {
    const wrap = document.createElement('div')
    wrap.appendChild(sel.getRangeAt(0).cloneContents())
    wrap.querySelectorAll('.km-src-edit, .km-filter-btn, button').forEach((el) => el.remove())
    inlineRichStyles(wrap)
    const plain = sel.toString()
    if (!wrap.innerHTML.trim() && !plain) return
    e.clipboardData.setData('text/html', `<div style="${COPY_WRAP}">${wrap.innerHTML}</div>`)
    e.clipboardData.setData('text/plain', plain)
    e.preventDefault()
  } catch {
    /* default copy */
  }
}

// ── column filter (display only) ──
function closePop() {
  if (activePop) {
    activePop.remove()
    activePop = null
  }
  activePopBtn = null
}
function openFilterPop(btn) {
  closePop()
  const ti = parseInt(btn.getAttribute('data-ti'))
  const ci = parseInt(btn.getAttribute('data-ci'))
  const table = host.querySelector('table[data-ti="' + ti + '"]')
  if (!table) return
  filterState[ti] = filterState[ti] || {}
  const tState = filterState[ti]
  const excluded = tState[ci] || new Set()
  const cellVal = (tr, c) => {
    const v = (tr.children[c]?.getAttribute('data-raw') || '').trim()
    return v === '' ? '(空白)' : v
  }
  // Excel semantics: list only values from rows that survive the OTHER columns'
  // filters — filtering B after A offers just A's survivors. This column's own
  // filter is ignored so its currently-excluded values stay listed (otherwise
  // they could never be re-checked).
  const values = new Set()
  table.querySelectorAll('tbody tr').forEach((tr) => {
    const hidden = Object.keys(tState).some(
      (c) => parseInt(c) !== ci && tState[c].has(cellVal(tr, c))
    )
    if (!hidden) values.add(cellVal(tr, ci))
  })

  const pop = document.createElement('div')
  pop.className = 'km-filter-pop'
  pop.innerHTML =
    '<input class="km-fp-search" placeholder="' +
    escapeAttrLocal(t('keep.filterSearch')) +
    '">' +
    '<div class="km-fp-tools"><a data-all="1">' +
    escapeHtmlLocal(t('keep.selectAll')) +
    '</a><a data-all="0">' +
    escapeHtmlLocal(t('keep.selectNone')) +
    '</a></div>' +
    '<div class="km-fp-list"></div>' +
    '<div class="km-fp-actions"><button type="button" class="ok">' +
    escapeHtmlLocal(t('edit.confirm')) +
    '</button><button type="button" class="cancel">' +
    escapeHtmlLocal(t('edit.cancel')) +
    '</button></div>'
  const list = pop.querySelector('.km-fp-list')
  const sorted = [...values].sort((a, b) => a.localeCompare(b, 'ja'))
  const buildList = (filter) => {
    list.innerHTML = ''
    sorted
      .filter((v) => !filter || v.replace(/<br>/g, ' ').includes(filter))
      .forEach((v) => {
        const lab = document.createElement('label')
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = !excluded.has(v)
        cb.dataset.v = v
        const span = document.createElement('span')
        span.innerHTML = inline(v)
        lab.appendChild(cb)
        lab.appendChild(span)
        list.appendChild(lab)
      })
  }
  buildList('')
  pop.querySelector('.km-fp-search').addEventListener('input', (e) => buildList(e.target.value))
  pop.querySelectorAll('.km-fp-tools a').forEach((a) => {
    a.onclick = () => {
      const on = a.dataset.all === '1'
      list.querySelectorAll('input').forEach((cb) => (cb.checked = on))
    }
  })
  pop.querySelector('.cancel').onclick = closePop
  pop.querySelector('.ok').onclick = () => {
    // Excel-style (matches the app's KeepEditor): confirming keeps only the
    // values that are BOTH visible (match the search) AND checked, and excludes
    // every other listed value — so search-then-confirm filters the table down
    // to the matching rows.
    const keep = new Set(
      [...list.querySelectorAll('input')].filter((cb) => cb.checked).map((cb) => cb.dataset.v)
    )
    // Values whose rows are hidden by OTHER columns' filters aren't listed, so
    // they can't be toggled here — carry their exclusion over unchanged.
    const ex = new Set([...excluded].filter((v) => !values.has(v)))
    sorted.forEach((v) => {
      if (!keep.has(v)) ex.add(v)
    })
    if (ex.size > 0) filterState[ti][ci] = ex
    else delete filterState[ti][ci]
    closePop()
    applyFilter(ti)
    const cols = filterState[ti]
    const isActive = !!(cols && cols[ci] && cols[ci].size > 0)
    // Toggle ▼ active on every copy of this column's button — the live header AND
    // the floating-header clone (which may be the one that was clicked).
    host
      .querySelectorAll('.km-filter-btn[data-ti="' + ti + '"][data-ci="' + ci + '"]')
      .forEach((b) => b.classList.toggle('active', isActive))
    document
      .querySelectorAll('.km-float-header .km-filter-btn[data-ti="' + ti + '"][data-ci="' + ci + '"]')
      .forEach((b) => b.classList.toggle('active', isActive))
    // Hiding rows can reflow column widths — re-measure the floating header.
    tableScroll?.update()
  }
  document.body.appendChild(pop)
  activePop = pop
  activePopBtn = btn
  repositionFilterPop()
}
function applyFilter(ti) {
  const table = host.querySelector('table[data-ti="' + ti + '"]')
  if (!table) return
  const cols = filterState[ti] || {}
  table.querySelectorAll('tbody tr').forEach((tr) => {
    let hide = false
    Object.keys(cols).forEach((ci) => {
      const td = tr.children[ci]
      let v = (td?.getAttribute('data-raw') || '').trim()
      if (v === '') v = '(空白)'
      if (cols[ci].has(v)) hide = true
    })
    tr.classList.toggle('km-filtered', hide)
  })
}
// A table's filters are active only if some column holds a non-empty excluded set
// (openFilterPop pre-creates an empty per-table object even on cancel).
function tableHasFilter(ti) {
  const cols = filterState[ti]
  return !!cols && Object.keys(cols).length > 0
}
function anyFilterActive() {
  return Object.keys(filterState).some((ti) => tableHasFilter(ti))
}
// Drop every filter on one table / on the whole document (context-menu entries).
// Display-only, like the filters themselves: un-hide the rows and un-mark the ▼
// buttons (live header + floating clone). closePop() guards against a stale open
// dropdown whose checkbox state was captured before the clear.
function clearTableFilter(ti) {
  if (!tableHasFilter(ti)) return
  closePop()
  delete filterState[ti]
  applyFilter(ti)
  const sel = '.km-filter-btn[data-ti="' + ti + '"]'
  host.querySelectorAll(sel).forEach((b) => b.classList.remove('active'))
  document.querySelectorAll('.km-float-header ' + sel).forEach((b) => b.classList.remove('active'))
  tableScroll?.update()
}
function clearAllFilters() {
  const tis = Object.keys(filterState).filter((ti) => tableHasFilter(ti))
  if (!tis.length) return
  closePop()
  filterState = {}
  tis.forEach((ti) => applyFilter(parseInt(ti)))
  host.querySelectorAll('.km-filter-btn').forEach((b) => b.classList.remove('active'))
  document
    .querySelectorAll('.km-float-header .km-filter-btn')
    .forEach((b) => b.classList.remove('active'))
  tableScroll?.update()
}

// ── settings panel (theme · language · layout) ──
// The gear button opens one popover holding the color theme, UI language, and the
// layout controls (page width / font size / zoom / line height / para spacing).
// Every choice persists via the host (globalState) and is shared across editors.
let settingsPop = null
let settingsBtn = null
let sourceBtn = null
let outlinePop = null
let outlineBtn = null

function applyLayout(L) {
  applyPageWidth(L.pageWidth)
  applyFontSize(L.fontSize)
  applyZoom(L.zoom)
  applyLineHeight(L.lineHeight)
  applyParagraphSpacing(L.paragraphSpacing)
}
function postLayout() {
  vscode.postMessage({ type: 'layout', layout: layout })
}
function setLayout(key, value) {
  layout = { ...layout, [key]: value }
  applyLayout(layout)
  postLayout()
}

// ── theme (color scheme) ──
// 'auto' clears the class (keep.css maps tokens to --vscode-*); the two named
// themes override every design token with the app's warm palettes.
function applyTheme(name) {
  const c = document.body.classList
  c.remove('hm-theme-warm-light', 'hm-theme-warm-dark')
  if (name === 'warm-light') c.add('hm-theme-warm-light')
  else if (name === 'warm-dark') c.add('hm-theme-warm-dark')
  // Mermaid is theme-keyed (light vs dark); re-render any already-painted diagram
  // in place so it matches the new scheme without a full document rebuild.
  if (host) {
    host.querySelectorAll('.km-mermaid').forEach((el) => {
      el.innerHTML = ''
      observeEmbed(el)
    })
  }
}
function setTheme(name) {
  theme = name
  applyTheme(name)
  vscode.postMessage({ type: 'theme', theme: name })
}

// ── language ──
// A picker choice of 'auto' resolves against the webview's own navigator.language
// (init already arrives host-resolved). Changing it relabels the chrome, re-renders
// the document (the "edit source" pills carry localized labels), and reopens the
// settings popover so its own text switches too.
function resolveLangCode(pref) {
  if (pref && pref !== 'auto') return pref
  const l = (navigator.language || 'en').toLowerCase()
  if (l.startsWith('zh')) return 'zh'
  if (l.startsWith('ja')) return 'ja'
  return 'en'
}
function applyLangChrome() {
  if (sourceBtn) {
    sourceBtn.title = t('mode.source')
    const s = sourceBtn.querySelector('span')
    if (s) s.textContent = t('mode.source')
  }
  if (outlineBtn) {
    outlineBtn.title = t('outline.title')
    outlineBtn.setAttribute('aria-label', t('outline.title'))
  }
  if (settingsBtn) {
    settingsBtn.title = t('settings.title')
    settingsBtn.setAttribute('aria-label', t('settings.title'))
  }
  if (findInput) findInput.placeholder = t('find.placeholder')
  if (replaceInput) replaceInput.placeholder = t('find.replacePlaceholder')
}
function setLang(pref) {
  langPref = pref
  t = makeT(resolveLangCode(pref))
  applyLangChrome()
  rerender()
  vscode.postMessage({ type: 'lang', lang: pref })
  if (settingsPop) {
    closeSettingsPop()
    openSettingsPop()
  }
}

function closeSettingsPop() {
  if (settingsPop) {
    settingsPop.remove()
    settingsPop = null
  }
  if (settingsBtn) settingsBtn.classList.remove('active')
}

// A label + a row of chips (segmented control, no slider) for a discrete choice.
// `getCurrent` is read to highlight the active chip; `onPick(value)` applies it.
function buildChoiceRow(label, options, getCurrent, onPick) {
  const row = document.createElement('div')
  row.className = 'km-lo-row'
  const head = document.createElement('div')
  head.className = 'km-lo-head'
  const lab = document.createElement('span')
  lab.className = 'km-lo-label'
  lab.textContent = label
  head.appendChild(lab)
  row.appendChild(head)
  const chips = document.createElement('div')
  chips.className = 'km-lo-presets'
  const sync = () =>
    chips.querySelectorAll('.km-lo-chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.v === String(getCurrent()))
    })
  options.forEach((o) => {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'km-lo-chip'
    chip.textContent = o.label
    chip.dataset.v = o.value
    chip.onclick = () => {
      onPick(o.value)
      sync()
    }
    chips.appendChild(chip)
  })
  row.appendChild(chips)
  sync()
  return row
}

// One row: a label, preset chips, and a fine-tune slider. `presets` is an array
// of { label, value }; `value === layout[key]` highlights the chip. `fmt` renders
// the current numeric value. pageWidth is special-cased ('full' has no slider value).
function buildLayoutRow({ label, key, presets, min, max, step, fmt }) {
  const row = document.createElement('div')
  row.className = 'km-lo-row'
  const head = document.createElement('div')
  head.className = 'km-lo-head'
  const lab = document.createElement('span')
  lab.className = 'km-lo-label'
  lab.textContent = label
  const val = document.createElement('span')
  val.className = 'km-lo-val'
  head.append(lab, val)
  row.appendChild(head)

  const chips = document.createElement('div')
  chips.className = 'km-lo-presets'
  const slider = document.createElement('input')
  slider.type = 'range'
  slider.className = 'km-lo-slider'
  slider.min = String(min)
  slider.max = String(max)
  slider.step = String(step)

  const sync = () => {
    const cur = layout[key]
    val.textContent = fmt(cur)
    chips.querySelectorAll('.km-lo-chip').forEach((c) => {
      c.classList.toggle('active', String(c.dataset.v) === String(cur))
    })
    if (cur === 'full') {
      slider.disabled = true
      slider.value = String(max)
    } else {
      slider.disabled = false
      slider.value = String(cur)
    }
  }

  presets.forEach((p) => {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'km-lo-chip'
    chip.textContent = p.label
    chip.dataset.v = p.value
    chip.onclick = () => {
      setLayout(key, p.value)
      sync()
    }
    chips.appendChild(chip)
  })
  slider.addEventListener('input', () => {
    setLayout(key, key === 'pageWidth' ? parseInt(slider.value) : parseFloat(slider.value))
    sync()
  })
  row.appendChild(chips)
  row.appendChild(slider)
  sync()
  return row
}

function openSettingsPop() {
  closeFloating()
  const pop = document.createElement('div')
  pop.className = 'km-layout-pop'
  pop.appendChild(
    buildChoiceRow(
      t('settings.themeLabel'),
      [
        { label: t('settings.theme.auto'), value: 'auto' },
        { label: t('settings.theme.warmLight'), value: 'warm-light' },
        { label: t('settings.theme.warmDark'), value: 'warm-dark' }
      ],
      () => theme,
      setTheme
    )
  )
  pop.appendChild(
    buildChoiceRow(
      t('settings.langLabel'),
      [
        { label: t('settings.lang.auto'), value: 'auto' },
        { label: t('settings.lang.zh'), value: 'zh' },
        { label: t('settings.lang.ja'), value: 'ja' },
        { label: t('settings.lang.en'), value: 'en' }
      ],
      () => langPref,
      setLang
    )
  )
  const sep = document.createElement('div')
  sep.className = 'km-lo-sep'
  pop.appendChild(sep)
  pop.appendChild(
    buildLayoutRow({
      label: t('settings.pageWidth'),
      key: 'pageWidth',
      presets: PAGE_WIDTH_PRESETS.map((p) => ({
        label: t('settings.width.' + p.id),
        value: p.width
      })),
      min: PAGE_WIDTH_MIN,
      max: PAGE_WIDTH_MAX,
      step: 20,
      fmt: (v) => (v === 'full' ? t('settings.width.full') : v + 'px')
    })
  )
  pop.appendChild(
    buildLayoutRow({
      label: t('settings.fontSize'),
      key: 'fontSize',
      presets: FONT_SIZE_PRESETS.map((p) => ({ label: t('settings.font.' + p.id), value: p.size })),
      min: FONT_SIZE_MIN,
      max: FONT_SIZE_MAX,
      step: 1,
      fmt: (v) => v + 'px'
    })
  )
  pop.appendChild(
    buildLayoutRow({
      label: t('settings.zoom'),
      key: 'zoom',
      presets: ZOOM_PRESETS.map((p) => ({ label: Math.round(p.zoom * 100) + '%', value: p.zoom })),
      min: ZOOM_MIN,
      max: ZOOM_MAX,
      step: 0.05,
      fmt: (v) => Math.round(v * 100) + '%'
    })
  )
  pop.appendChild(
    buildLayoutRow({
      label: t('settings.lineHeight'),
      key: 'lineHeight',
      presets: LINE_HEIGHT_PRESETS.map((p) => ({
        label: t('settings.lineHeightPreset.' + p.id),
        value: p.value
      })),
      min: LINE_HEIGHT_MIN,
      max: LINE_HEIGHT_MAX,
      step: 0.05,
      fmt: (v) => Number(v).toFixed(2)
    })
  )
  pop.appendChild(
    buildLayoutRow({
      label: t('settings.paragraphSpacing'),
      key: 'paragraphSpacing',
      presets: PARA_SPACING_PRESETS.map((p) => ({
        label: t('settings.paraSpacingPreset.' + p.id),
        value: p.value
      })),
      min: PARA_SPACING_MIN,
      max: PARA_SPACING_MAX,
      step: 0.1,
      fmt: (v) => Number(v).toFixed(1) + 'em'
    })
  )
  document.body.appendChild(pop)
  settingsPop = pop
  if (settingsBtn) settingsBtn.classList.add('active')
}

function ensureSettingsButton() {
  if (settingsBtn) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'km-layout-btn'
  btn.title = t('settings.title')
  btn.setAttribute('aria-label', t('settings.title'))
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
  btn.onclick = (e) => {
    e.stopPropagation()
    if (settingsPop) closeSettingsPop()
    else openSettingsPop()
  }
  document.body.appendChild(btn)
  settingsBtn = btn
}

// In-editor "source" button: one click back to the text editor (the host reopens
// this file with the default editor). Mirrors the title-bar icon, but on the page.
function ensureSourceButton() {
  if (sourceBtn) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'km-source-btn'
  btn.title = t('mode.source')
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg><span>' +
    escapeHtmlLocal(t('mode.source')) +
    '</span>'
  btn.onclick = () => vscode.postMessage({ type: 'switchToSource' })
  document.body.appendChild(btn)
  sourceBtn = btn
}

// ── outline (heading navigator) ──
function closeOutlinePop() {
  if (outlinePop) {
    outlinePop.remove()
    outlinePop = null
  }
  if (outlineBtn) outlineBtn.classList.remove('active')
}
// Expand every collapsed ancestor section hiding `block` (mirrors the app's
// revealHeading), so a buried block is reachable by outline jump / anchor /
// scroll sync alike.
function expandAncestors(block) {
  let need = block.hasAttribute('data-hlevel') ? parseInt(block.getAttribute('data-hlevel')) : Infinity
  let node = block.previousElementSibling
  while (node && need > 1) {
    if (node.classList && node.classList.contains('km-block') && node.hasAttribute('data-hlevel')) {
      const lvl = parseInt(node.getAttribute('data-hlevel'))
      if (lvl < need) {
        if (node.classList.contains('km-collapsed')) {
          node.classList.remove('km-collapsed')
          collapsed.delete(sectionKey(node))
        }
        need = lvl
      }
    }
    node = node.previousElementSibling
  }
  refreshVisibility()
}
// Jump to a heading block by its index, expanding whatever hides it first.
function jumpToHeading(bi) {
  const block = host.querySelector('.km-block[data-bi="' + bi + '"]')
  if (!block) return
  expandAncestors(block)
  block.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
// Strip inline markdown from a heading's raw text for a clean list label.
function plainHeading(text) {
  const tmp = document.createElement('div')
  tmp.innerHTML = inline(text)
  return tmp.textContent || ''
}
function openOutlinePop() {
  closeFloating()
  const heads = extractHeadings(blocks)
  const pop = document.createElement('div')
  pop.className = 'km-outline-pop'
  if (!heads.length) {
    const empty = document.createElement('div')
    empty.className = 'km-ol-empty'
    empty.textContent = t('outline.empty')
    pop.appendChild(empty)
  } else {
    const minLvl = Math.min(...heads.map((h) => h.level))
    heads.forEach((h) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'km-ol-item'
      item.style.paddingLeft = 10 + (h.level - minLvl) * 14 + 'px'
      item.textContent = plainHeading(h.text)
      item.onclick = () => {
        jumpToHeading(h.bi)
        closeOutlinePop()
      }
      pop.appendChild(item)
    })
  }
  document.body.appendChild(pop)
  outlinePop = pop
  if (outlineBtn) outlineBtn.classList.add('active')
}
function ensureOutlineButton() {
  if (outlineBtn) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'km-outline-btn'
  btn.title = t('outline.title')
  btn.setAttribute('aria-label', t('outline.title'))
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>'
  btn.onclick = (e) => {
    e.stopPropagation()
    if (outlinePop) closeOutlinePop()
    else openOutlinePop()
  }
  document.body.appendChild(btn)
  outlineBtn = btn
}

// ── find in document (Ctrl/Cmd+F) ──
// Scoped to #km-host via the app's CSS Custom Highlight helpers. Matches inside
// hover affordances (edit pills / filter buttons / fold toggles) and hidden /
// collapsed / filtered sections are dropped so only visible body text counts.
let findBar = null
let findInput = null
let findCountEl = null
let findRanges = []
let findIdx = 0
let findQuery = ''
let replaceRow = null
let replaceInput = null
let replaceToggle = null
let replCursor = 0 // source-match cursor for "replace one"

function ensureFindBar() {
  if (findBar) return
  const bar = document.createElement('div')
  bar.className = 'km-findbar'
  const row1 = document.createElement('div')
  row1.className = 'km-fb-row'
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'km-fb-input'
  input.placeholder = t('find.placeholder')
  const count = document.createElement('span')
  count.className = 'km-fb-count'
  const mkBtn = (glyph, title, fn, cls) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = cls || 'km-fb-btn'
    b.textContent = glyph
    b.title = title
    b.onclick = fn
    return b
  }
  const toggle = mkBtn('▸', t('find.toggleReplace'), () => toggleReplaceRow())
  const prev = mkBtn('‹', t('find.prev'), () => stepFind(-1))
  const next = mkBtn('›', t('find.next'), () => stepFind(1))
  const close = mkBtn('✕', t('find.close'), closeFind)
  row1.append(toggle, input, count, prev, next, close)
  input.addEventListener('input', () => {
    replCursor = 0
    runFind(input.value)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      stepFind(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeFind()
    }
  })
  // Replace row (chevron-toggled). Replacement is SOURCE-LINE based — the same
  // pure helpers the desktop app's three editors share — so a replace commits
  // through the normal minimal-diff path and stays zero-diff. Per-line matching:
  // multi-line queries are not supported (matches how the view renders anyway).
  const row2 = document.createElement('div')
  row2.className = 'km-fb-row km-fb-replace'
  const rInput = document.createElement('input')
  rInput.type = 'text'
  rInput.className = 'km-fb-input'
  rInput.placeholder = t('find.replacePlaceholder')
  const rOne = mkBtn(t('find.replace'), t('find.replaceTip'), () => replaceOne(), 'km-fb-btn km-fb-act')
  const rAll = mkBtn(t('find.replaceAll'), t('find.replaceAllTip'), () => replaceAll(), 'km-fb-btn km-fb-act')
  row2.append(rInput, rOne, rAll)
  rInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      replaceOne()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeFind()
    }
  })
  bar.append(row1, row2)
  document.body.appendChild(bar)
  findBar = bar
  findInput = input
  findCountEl = count
  replaceRow = row2
  replaceInput = rInput
  replaceToggle = toggle
}
function toggleReplaceRow(open) {
  if (!replaceRow) return
  const on = open != null ? open : !replaceRow.classList.contains('open')
  replaceRow.classList.toggle('open', on)
  if (replaceToggle) replaceToggle.textContent = on ? '▾' : '▸'
  if (on) replaceInput.focus()
}

// All (lineIdx, matchIdx) source matches of the current query, in document order.
function sourceMatches(q) {
  const out = []
  for (let li = 0; li < lines.length; li++) {
    const { matches } = findMatchesInText(lines[li], q)
    for (let k = 0; k < matches.length; k++) out.push({ li, k, index: matches[k].index })
  }
  return out
}
function replaceOne() {
  const q = findInput.value
  if (!q) return
  const repl = replaceInput.value
  const all = sourceMatches(q)
  if (!all.length) {
    updateFindCount()
    return
  }
  if (replCursor >= all.length) replCursor = 0
  const { li, k, index } = all[replCursor]
  let newLine = null
  mutate(() => {
    const r = replaceMatchesInText(lines[li], q, repl, {}, k)
    newLine = r.text
    lines[li] = newLine
  })
  // Advance past the replacement (and any matches the replacement itself
  // introduced), so repeated presses can't loop on their own output.
  const earlier = replCursor - k // matches on lines before li — unchanged
  const { matches: after } = findMatchesInText(newLine, q)
  replCursor = earlier + after.filter((m) => m.index < index + repl.length).length
  rerender()
  requestAnimationFrame(() =>
    requestAnimationFrame(() => scrollToSourceLine(li))
  )
}
function replaceAll() {
  const q = findInput.value
  if (!q) return
  const repl = replaceInput.value
  let count = 0
  mutate(() => {
    for (let li = 0; li < lines.length; li++) {
      const r = replaceMatchesInText(lines[li], q, repl, {})
      if (r.count) {
        lines[li] = r.text
        count += r.count
      }
    }
  })
  replCursor = 0
  if (count) rerender()
  showToast(t('find.replacedCount', { n: count }))
}
function openFind() {
  ensureFindBar()
  findBar.style.display = 'flex'
  const sel = (window.getSelection?.().toString() || '').trim()
  if (sel && sel.length <= 80 && !sel.includes('\n')) findInput.value = sel
  findInput.focus()
  findInput.select()
  if (findInput.value) runFind(findInput.value)
  else updateFindCount()
}
function closeFind() {
  if (!findBar) return
  findBar.style.display = 'none'
  findQuery = ''
  findRanges = []
  clearFindHighlights()
}
function runFind(q) {
  findQuery = q
  clearFindHighlights()
  const raw = q ? findRangesInEl(host, q).ranges : []
  findRanges = raw.filter((r) => {
    const el = r.startContainer.parentElement
    return (
      el &&
      el.offsetParent !== null && // skip hidden / collapsed / filtered text
      !el.closest('.km-src-edit, .km-filter-btn, .km-collapse-toggle')
    )
  })
  findIdx = 0
  paintFindHighlights(findRanges, findIdx)
  updateFindCount()
  if (findRanges[findIdx]) scrollRangeIntoView(findRanges[findIdx], host.closest('.editor-scroll'))
}
function stepFind(dir) {
  if (!findRanges.length) return
  findIdx = (findIdx + dir + findRanges.length) % findRanges.length
  paintFindHighlights(findRanges, findIdx)
  updateFindCount()
  scrollRangeIntoView(findRanges[findIdx], host.closest('.editor-scroll'))
}
function updateFindCount() {
  if (!findCountEl) return
  if (!findQuery) findCountEl.textContent = ''
  else findCountEl.textContent = findRanges.length ? findIdx + 1 + '/' + findRanges.length : t('find.noResults')
}

// ── links ──
function safeDecode(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
function activateLink(href) {
  if (href.startsWith('#')) {
    scrollToAnchor(href.slice(1))
    return
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    vscode.postMessage({ type: 'openExternal', url: href })
    return
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    vscode.postMessage({ type: 'openExternal', url: href })
    return
  }
  // Relative file link (optionally with #fragment) — the host resolves it
  // against the document folder and opens it in VSCode.
  vscode.postMessage({ type: 'openRelative', href })
}

// ── anchors (#heading) ──
// GitHub-style slugs computed from the parsed headings: strip inline markdown,
// lowercase, drop punctuation, spaces → '-', duplicates get -1/-2… suffixes.
function slugifyHeading(text) {
  return plainHeading(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}
function headingSlugs() {
  const used = new Map()
  return extractHeadings(blocks).map((h) => {
    let s = slugifyHeading(h.text)
    const n = used.get(s) || 0
    used.set(s, n + 1)
    if (n > 0) s = s + '-' + n
    return { slug: s, bi: h.bi }
  })
}
function scrollToAnchor(slug) {
  const dec = safeDecode(String(slug || '')).toLowerCase()
  const list = headingSlugs()
  // Exact slug match first; then tolerate a raw-heading-text fragment.
  const hit = list.find((h) => h.slug === dec) || list.find((h) => h.slug === slugifyHeading(dec))
  if (hit) jumpToHeading(hit.bi)
}

// ── scroll sync (with a side-by-side source editor; host relays both ways) ──
// Outbound: debounced top-visible-block line → host reveals it in text editors.
// Inbound: host posts scrollToLine → align that block's top with the scroller.
// A timestamp window suppresses echo — programmatic scrolls emit event streams,
// so a one-shot flag would leak.
let syncSuppressUntil = 0
let syncEmitTimer = 0
let lastSentLine = -1

function topVisibleLine() {
  const scroller = host.closest('.editor-scroll')
  if (!scroller) return 0
  const top = scroller.getBoundingClientRect().top
  for (const el of host.querySelectorAll('.km-block')) {
    if (el.classList.contains('km-section-hidden')) continue
    if (el.getBoundingClientRect().bottom > top + 4) {
      const b = blocks[parseInt(el.getAttribute('data-bi'))]
      return b ? b.start : 0
    }
  }
  return 0
}
function emitScrollSync() {
  if (Date.now() < syncSuppressUntil) return
  clearTimeout(syncEmitTimer)
  syncEmitTimer = setTimeout(() => {
    if (Date.now() < syncSuppressUntil) return
    const line = topVisibleLine()
    if (line !== lastSentLine) {
      lastSentLine = line
      vscode.postMessage({ type: 'visibleLine', line })
    }
  }, 100)
}
function scrollToSourceLine(line) {
  const scroller = host.closest('.editor-scroll')
  if (!scroller || !blocks.length) return
  // The block containing the line; a blank-gap line takes the next block.
  let bi = -1
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k]
    if (line >= b.start && line <= b.end) {
      bi = k
      break
    }
    if (b.start > line) {
      bi = k
      break
    }
  }
  if (bi === -1) bi = blocks.length - 1
  const el = host.querySelector('.km-block[data-bi="' + bi + '"]')
  if (!el) return
  if (el.classList.contains('km-section-hidden')) expandAncestors(el)
  syncSuppressUntil = Date.now() + 250
  // Direct scrollTop math, NOT smooth scrollIntoView — a smooth scroll's event
  // stream would outlive the suppression window and echo back to the editor.
  const r = el.getBoundingClientRect()
  const sr = scroller.getBoundingClientRect()
  scroller.scrollTop += r.top - sr.top - 8
}

// ── toast (transient notice, bottom center) ──
let toastEl = null
let toastTimer = 0
function showToast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.className = 'km-toast'
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = msg
  toastEl.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600)
}

// ── image paste & drop ──
// The webview reads the image bytes and asks the host to write them into the
// document's ./assets folder (the host owns the filesystem); the reply carries
// the relative path and the INSERT happens here, through the same mutate()/
// commit() minimal-diff path as every other edit. Keep mode has no cursor, so
// the insert anchor is: the drop-highlighted block (drop), the open edit
// textarea's caret (paste while editing), the last-interacted block (paste),
// or end-of-file.
const IMG_MAX_BYTES = 20 * 1024 * 1024
let imgReqSeq = 0
const imgPending = new Map() // reqId -> { at, ta } (line anchor + optional textarea)
let lastInteractedBi = -1

function imageFileName(file) {
  if (file.name && file.name.includes('.')) return file.name
  const ext = (file.type && file.type.split('/')[1]) || 'png'
  const d = new Date()
  const pad = (x) => String(x).padStart(2, '0')
  return (
    'image-' +
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    '.' +
    ext
  )
}

function requestImageSave(file, at, ta) {
  if (file.size > IMG_MAX_BYTES) {
    showToast(t('img.tooLarge'))
    return
  }
  const reqId = ++imgReqSeq
  imgPending.set(reqId, { at, ta })
  file.arrayBuffer().then(
    (buf) => vscode.postMessage({ type: 'saveImage', reqId, name: imageFileName(file), bytes: new Uint8Array(buf) }),
    () => imgPending.delete(reqId)
  )
}

// Line index to insert at when nothing more specific applies.
function insertAnchor() {
  const b = blocks[lastInteractedBi]
  return b ? b.end + 1 : lines.length
}

function onImageSaved(msg) {
  const p = imgPending.get(msg.reqId)
  imgPending.delete(msg.reqId)
  if (!p) return
  const md = '![](' + msg.relPath + ')'
  // Pasted while an edit textarea was open (still is): insert at its caret; the
  // normal commit of that editor carries the image line into the source.
  if (p.ta && p.ta.isConnected) {
    const s = p.ta.selectionStart ?? p.ta.value.length
    p.ta.setRangeText(md, s, p.ta.selectionEnd ?? s, 'end')
    p.ta.focus()
    return
  }
  const at = Math.max(0, Math.min(p.at, lines.length))
  const ins = []
  if (at > 0 && (lines[at - 1] || '').trim() !== '') ins.push('')
  const mdLine = at + ins.length
  ins.push(md)
  if (at < lines.length && (lines[at] || '').trim() !== '') ins.push('')
  mutate(() => lines.splice(at, 0, ...ins))
  // Later pending inserts at/after this anchor shift down by what we inserted.
  imgPending.forEach((v) => {
    if (v.at >= at) v.at += ins.length
  })
  rerender()
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const bi = blocks.findIndex((b) => mdLine >= b.start && mdLine <= b.end)
      const el = bi >= 0 ? host.querySelector('.km-block[data-bi="' + bi + '"]') : null
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  )
}

function onPaste(e) {
  const items = e.clipboardData?.items
  if (!items) return
  const files = []
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) files.push(f)
    }
  }
  if (!files.length) return
  e.preventDefault()
  const ae = document.activeElement
  const ta = ae && ae.tagName === 'TEXTAREA' ? ae : null
  const at = insertAnchor()
  files.forEach((f) => requestImageSave(f, at, ta))
}

// Drop: highlight the block under the pointer with an insertion bar; the file
// lands right after it. preventDefault on dragover/drop is required or the
// VSCode workbench swallows the drop.
let dropTargetEl = null
function clearDropTarget() {
  dropTargetEl?.classList.remove('km-drop-after')
  dropTargetEl = null
}
function onDragOver(e) {
  const items = e.dataTransfer?.items
  if (!items || ![...items].some((it) => it.kind === 'file')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  const blk = e.target.closest?.('.km-block')
  if (blk !== dropTargetEl) {
    clearDropTarget()
    if (blk && host.contains(blk)) {
      dropTargetEl = blk
      blk.classList.add('km-drop-after')
    }
  }
}
function onDrop(e) {
  const target = dropTargetEl
  clearDropTarget()
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'))
  if (!files.length) return
  e.preventDefault()
  const bi = target ? parseInt(target.getAttribute('data-bi')) : -1
  const at = bi >= 0 && blocks[bi] ? blocks[bi].end + 1 : lines.length
  files.forEach((f) => requestImageSave(f, at))
}

// ── event delegation ──
let linkTimer = null
function trackInteraction(e) {
  const blk = e.target.closest?.('.km-block')
  if (blk && host.contains(blk)) lastInteractedBi = parseInt(blk.getAttribute('data-bi'))
}
function onDblClick(e) {
  clearTimeout(linkTimer)
  trackInteraction(e)
  if (e.target.closest('.km-collapse-toggle')) return // a fold toggle, not an edit
  if (e.target.closest('input.km-task-cb')) return // fast double-click on a checkbox ≠ block edit
  const cell = e.target.closest('td, th')
  if (cell && host.contains(cell) && !e.target.closest('.km-filter-btn')) {
    openCellPop(cell)
    return
  }
  const block = e.target.closest('.km-block')
  if (block && host.contains(block) && block.querySelector(':scope > .km-src-edit')) {
    startBlockEdit(parseInt(block.getAttribute('data-bi')))
  }
}
function onClick(e) {
  trackInteraction(e)
  // GFM task checkbox: the browser already flipped `checked`; write the toggle
  // back to exactly one source line. No re-render needed — the DOM is the new
  // state, and the minimal diff is that single line.
  const cb = e.target.closest('input.km-task-cb')
  if (cb && host.contains(cb)) {
    const n = parseInt(cb.getAttribute('data-line'))
    if (!Number.isNaN(n) && lines[n] != null) {
      const on = cb.checked
      mutate(() => {
        lines[n] = lines[n].replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/, '$1[' + (on ? 'x' : ' ') + ']')
      })
    }
    return
  }
  const mz = e.target.closest('.km-mermaid-zoom')
  if (mz && host.contains(mz)) {
    e.preventDefault()
    e.stopPropagation()
    const svgEl = mz.closest('.km-mermaid')?.querySelector('svg')
    if (svgEl) openMermaidZoom(svgEl)
    return
  }
  const ct = e.target.closest('.km-collapse-toggle')
  if (ct && host.contains(ct)) {
    const head = ct.closest('.km-block[data-hlevel]')
    if (head) toggleSection(head)
    return
  }
  const a = e.target.closest('a')
  if (a && host.contains(a) && !e.shiftKey && (window.getSelection()?.isCollapsed ?? true)) {
    const href = a.getAttribute('href')
    if (href && href !== '#') {
      e.preventDefault()
      clearTimeout(linkTimer)
      linkTimer = setTimeout(() => activateLink(href), 230)
      return
    }
  }
  const se = e.target.closest('.km-src-edit')
  if (se) {
    startBlockEdit(parseInt(se.getAttribute('data-bi')))
    return
  }
  const fb = e.target.closest('.km-filter-btn')
  if (fb) {
    e.stopPropagation()
    if (activePop && activePopBtn === fb) closePop()
    else openFilterPop(fb)
  }
}
function onContextMenu(e) {
  const sel = window.getSelection()
  const hasSel =
    sel && !sel.isCollapsed && host.contains(sel.anchorNode) && host.contains(sel.focusNode)
  const items = []
  if (hasSel) {
    items.push({ label: t('keep.copySel'), fn: () => copySelection(sel) })
  } else {
    const cell = e.target.closest('td, th')
    if (cell && host.contains(cell)) {
      const table = cell.closest('table.km-table')
      if (!table) return
      const ti = parseInt(table.getAttribute('data-ti'))
      const ci = parseInt(cell.getAttribute('data-ci'))
      const isHeader = cell.tagName === 'TH'
      const tr = cell.closest('tr')
      const ri = isHeader ? -1 : parseInt(tr.getAttribute('data-ri'))
      items.push({ label: t('keep.copyCell'), fn: () => copyElement(cell) })
      items.push({ label: t('keep.copyRow'), fn: () => copyRow(tr) })
      items.push({ label: t('keep.copyCol'), fn: () => copyColumn(table, ci) })
      items.push({ label: t('keep.copyTable'), fn: () => copyTable(table) })
      items.push('sep')
      buildTableItems(items, ti, ri, ci, isHeader)
    } else {
      const block = e.target.closest('.km-block')
      if (!block || !host.contains(block)) return
      items.push({ label: t('keep.copy'), fn: () => copyElement(block) })
    }
  }
  if (!items.length) return
  e.preventDefault()
  openMenu(e.clientX, e.clientY, items)
}
function onDocDown(e) {
  if (activePop && !activePop.contains(e.target) && !e.target.classList.contains('km-filter-btn')) {
    closePop()
  }
  if (activeMenu && !activeMenu.contains(e.target)) closeMenu()
  if (
    settingsPop &&
    !settingsPop.contains(e.target) &&
    settingsBtn &&
    !settingsBtn.contains(e.target)
  ) {
    closeSettingsPop()
  }
  if (
    outlinePop &&
    !outlinePop.contains(e.target) &&
    outlineBtn &&
    !outlineBtn.contains(e.target)
  ) {
    closeOutlinePop()
  }
}
function onEsc(e) {
  if (e.key !== 'Escape') return
  if (activeConfirm) closeConfirm()
  else if (activeMenu) closeMenu()
}
function onScroll(e) {
  closeMenu()
  repositionCellPop()
  repositionFilterPop()
  tableScroll?.update()
  // Only the main editor scroller drives sync (not nested table-wrap scrolls).
  const tg = e && e.target
  if (!tg || tg === document || (tg.classList && tg.classList.contains('editor-scroll'))) {
    emitScrollSync()
  }
}
function onResize() {
  repositionCellPop()
  repositionFilterPop()
  tableScroll?.update()
}

host.addEventListener('dblclick', onDblClick)
host.addEventListener('click', onClick)
host.addEventListener('contextmenu', onContextMenu)
host.addEventListener('copy', onCopy)
document.addEventListener('paste', onPaste)
document.addEventListener('dragover', onDragOver)
document.addEventListener('drop', onDrop)
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) clearDropTarget() // left the window
})
document.addEventListener('click', onDocDown)
document.addEventListener('keydown', onEsc)
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    openFind()
  }
})
window.addEventListener('scroll', onScroll, true)
window.addEventListener('resize', onResize)

// Tell the host we're ready to receive the initial document.
if (!ready) {
  ready = true
  vscode.postMessage({ type: 'ready' })
}
