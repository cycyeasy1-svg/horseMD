// find-in-document helpers
// Search is scoped to the editor content only (the rich .ProseMirror element or
// the source <textarea>), never the find bar or other UI — so the text typed in
// the find box is never itself matched. Highlighting uses the CSS Custom
// Highlight API, which paints ranges without touching the DOM.
import { parseDoc, toViewLines } from './keep-parser.js'
const FIND_HL = 'hm-find'
const FIND_HL_CUR = 'hm-find-current'
const findHighlightSupported =
  typeof window !== 'undefined' && !!window.CSS?.highlights && typeof window.Highlight === 'function'

export function clearFindHighlights() {
  if (!findHighlightSupported) return
  CSS.highlights.delete(FIND_HL)
  CSS.highlights.delete(FIND_HL_CUR)
}
export function findRangesInEl(root, query) {
  const ranges = []
  if (!root || !query) return ranges
  const q = query.toLowerCase()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const val = node.nodeValue
    if (!val) continue
    const lower = val.toLowerCase()
    let idx = lower.indexOf(q)
    while (idx !== -1) {
      const r = document.createRange()
      r.setStart(node, idx)
      r.setEnd(node, idx + query.length)
      ranges.push(r)
      idx = lower.indexOf(q, idx + query.length)
    }
  }
  return ranges
}
export function paintFindHighlights(ranges, activeIdx) {
  if (!findHighlightSupported) return
  CSS.highlights.delete(FIND_HL)
  CSS.highlights.delete(FIND_HL_CUR)
  if (!ranges.length) return
  CSS.highlights.set(FIND_HL, new Highlight(...ranges))
  if (ranges[activeIdx]) {
    const cur = new Highlight(ranges[activeIdx])
    cur.priority = 1
    CSS.highlights.set(FIND_HL_CUR, cur)
  }
}
export function scrollRangeIntoView(range, scroller) {
  if (!range || !scroller) return
  // Reveal the match inside any *nested* scroll containers first — e.g. keep-mode
  // table boxes (`.km-table-wrap`, overflow:auto, sticky header) clip both axes
  // with their own scroll position. scrollIntoView walks ALL scrollable ancestors
  // (the table box AND the outer scroller), which the manual scrollTop math below
  // cannot, and `inline:'nearest'` recovers columns hidden by horizontal scroll.
  const node = range.startContainer
  const el = node.nodeType === 3 ? node.parentElement : node
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  // Then center it in the editor scroller for comfortable reading.
  const rect = range.getBoundingClientRect()
  const sr = scroller.getBoundingClientRect()
  if (!rect.height && !rect.width) return
  if (rect.top < sr.top + 12 || rect.bottom > sr.bottom - 12) {
    scroller.scrollTop += (rect.top + rect.bottom) / 2 - (sr.top + sr.bottom) / 2
  }
}
// ── line-number locate ──
// Map a markdown *source line* to the top-level block that renders it, so the
// rich/keep preview can jump there. Uses the same block segmentation keep mode
// renders with (parseDoc), so a block's index equals its `.km-block[data-bi]`
// (keep) and lines up with the Nth top-level node in the Crepe/.ProseMirror tree.
export function docBlocks(content) {
  return parseDoc(toViewLines(String(content ?? '').split('\n')))
}
// Returns { bi, total } for a 1-based `lineNo`: bi = the containing block's
// index (or the next block when the line is a blank gap; -1 when there are no
// blocks), total = total line count. Out-of-range lines clamp to the ends.
export function blockIndexForLine(content, lineNo) {
  const total = String(content ?? '').split('\n').length
  const blocks = docBlocks(content)
  if (!blocks.length) return { bi: -1, total }
  const target = Math.max(0, Math.min(total - 1, (lineNo | 0) - 1)) // 0-based, clamped
  let bi = -1
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k]
    if (target >= b.start && target <= b.end) { bi = k; break }
    if (b.start > target) { bi = k; break } // line fell in a blank gap → next block
  }
  if (bi === -1) bi = blocks.length - 1 // past the last block → last block
  return { bi, total }
}
export function matchIndices(text, query) {
  const out = []
  if (!text || !query) return out
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let idx = lower.indexOf(q)
  while (idx !== -1) {
    out.push(idx)
    idx = lower.indexOf(q, idx + query.length)
  }
  return out
}
