import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n.jsx'
import {
  renderDoc,
  renderBlockInner,
  inline,
  replaceCellInLine,
  insertColumnInLine,
  removeColumnInLine,
  buildTableRow
} from '../keep-parser.js'
import { inlineRichStyles } from './editor-copy.js'
import { dirOf } from './editor-images.js'
import { getMermaidSvg, peekMermaidSvg } from './editor-mermaid.js'
import { enhanceKeepTables } from './editor-tablescroll.js'

// Wrapper style for rich-text copy (mirrors the Crepe editor's onCopy payload) so
// pasted output keeps a sensible default font in apps that ignore external CSS.
const COPY_WRAP =
  'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#24292f;'

/**
 * Keep mode (source-backed editing) — the default editor for `.md`.
 *
 * The original file text is the single source of truth (`rawLines`, kept WITH
 * trailing \r). We render it read-only, and editing is location-scoped — a table
 * cell or a block's source — so only the touched lines are rewritten. Nothing
 * else is re-serialized, so saving produces a byte-for-byte diff of exactly the
 * change and nothing more (the "zero diff" requirement for Git-tracked specs).
 *
 * Unlike the Crepe editor this is plain DOM (innerHTML + event delegation) wrapped
 * in a thin React shell — there's no ProseMirror, no document model. After every
 * edit we re-parse rawLines and re-render; filters are re-applied on top.
 *
 * Contract with App:
 *   - initialContent → rawLines on mount. NO initial onChange (that would let the
 *     savedContent baseline be overwritten by a normalized form → spurious diff).
 *   - onChange(rawLines.join('\n'), false) fires ONLY when the user commits an edit.
 *   - onReady({ getMarkdown, getDocHTML, setBlock }) — save reads tab.content, but
 *     PDF export calls getDocHTML, and setBlock is a no-op (no block model here).
 *   - Remount (key includes reloadNonce) re-reads initialContent on external edits.
 */
export default function KeepEditor({
  inView = true,
  initialContent,
  docPath,
  onChange,
  onReady,
  onOutline,
  onFilterChange,
  onOpenSource,
  onOpenDocLink
}) {
  const { t, lang } = useI18n()
  const tRef = useRef(t)
  tRef.current = t
  const onOpenSourceRef = useRef(onOpenSource)
  onOpenSourceRef.current = onOpenSource
  const onOpenDocLinkRef = useRef(onOpenDocLink)
  onOpenDocLinkRef.current = onOpenDocLink
  const docPathRef = useRef(docPath)
  docPathRef.current = docPath

  const hostRef = useRef(null)
  // Mutable doc state held in refs (this component drives the DOM directly).
  const rawLinesRef = useRef([]) // \r-inclusive source of truth
  const viewLinesRef = useRef([]) // \r-stripped view (parse/display)
  const blocksRef = useRef([]) // source map from the last render
  const filterStateRef = useRef({}) // tableIdx -> { colIdx: Set(excluded values) }
  const collapsedRef = useRef(new Set()) // collapsed section keys ("level:text"), persisted across re-renders
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onOutlineRef = useRef(onOutline)
  onOutlineRef.current = onOutline
  const onFilterChangeRef = useRef(onFilterChange)
  onFilterChangeRef.current = onFilterChange

  // Live edit handles so blur/outside-click can commit/close the right one.
  const activeCellPopRef = useRef(null) // { pop, raw, lineIdx, colIdx } during a cell edit
  const activeBlockEditRef = useRef(null) // { ta, b, originalRaw } during a block source edit
  const activeConfirmRef = useRef(null) // the open "save changes?" modal (custom, not window.confirm)
  const activePopRef = useRef(null) // the open filter dropdown element
  const activePopBtnRef = useRef(null) // the ▼ button that opened it (for toggle)
  const activeMenuRef = useRef(null) // the open table context menu element
  const tableScrollRef = useRef(null) // wide-table top-scrollbar + floating-header handle
  // Tear down every body-appended popover (cell pop / filter pop / table menu /
  // confirm modal). Set inside the mount effect; called when the pane leaves view
  // so a floating edit bar never lingers over another tab's document.
  const closeFloatingRef = useRef(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let destroyed = false

    rawLinesRef.current = (initialContent || '').split('\n')
    filterStateRef.current = {}

    const emitChange = () => {
      if (destroyed) return
      onChangeRef.current?.(rawLinesRef.current.join('\n'), false)
    }

    const pushOutline = () => {
      if (!onOutlineRef.current) return
      const heads = blocksRef.current
        .filter((b) => b.type === 'heading')
        .map((b) => ({ level: b.level, text: b.text, bi: b.bi ?? b.start }))
      onOutlineRef.current(heads)
    }

    // Docs above this many lines build tens of thousands of DOM nodes in one
    // synchronous innerHTML — enough to stall the main thread for a visible beat.
    // For those we paint a "loading…" placeholder and yield a frame first.
    const LARGE_DOC_LINES = 1200
    let afterPaintRaf = 0 // pending requestAnimationFrame id (cancelled on re-render/destroy)
    let embedObserver = null // IntersectionObserver: render mermaid/math only when near view
    let katexPromise = null // lazily-loaded KaTeX module (one import per session)
    const cancelAfterPaint = () => {
      if (afterPaintRaf) {
        cancelAnimationFrame(afterPaintRaf)
        afterPaintRaf = 0
      }
    }

    // Full re-render from rawLines (re-parse → innerHTML). The layout-measuring and
    // embed work is pushed PAST first paint (finishRender) so the document is
    // visible/scrollable immediately and the main thread is free for input (the
    // :hover highlight, caret) instead of stalling on a whole-doc reflow.
    const rerender = () => {
      if (destroyed) return
      const { html, blocks, viewLines } = renderDoc(rawLinesRef.current, filterStateRef.current, {
        srcEditLabel: tRef.current('keep.editSource'),
        collapseLabel: tRef.current('keep.toggleSection'),
        baseDir: dirOf(docPathRef.current)
      })
      // tag blocks with their index so the outline can reference them
      blocks.forEach((b, i) => {
        b.bi = i
      })
      blocksRef.current = blocks
      viewLinesRef.current = viewLines

      const paint = () => {
        if (destroyed) return
        host.innerHTML = html
        pushOutline()
        cancelAfterPaint()
        afterPaintRaf = requestAnimationFrame(finishRender)
      }

      cancelAfterPaint()
      if (blocks.length && rawLinesRef.current.length > LARGE_DOC_LINES) {
        // Show the placeholder, then yield two frames so it actually paints before
        // the blocking innerHTML build (one frame to commit, one to let it display).
        host.innerHTML =
          '<div class="km-loading"><span class="km-spinner"></span>' +
          escapeHtmlLocal(tRef.current('keep.loading')) +
          '</div>'
        afterPaintRaf = requestAnimationFrame(() => {
          afterPaintRaf = requestAnimationFrame(paint)
        })
      } else {
        paint()
      }
    }

    // Post-paint batch: the layout-dependent + lazy work that needn't block the
    // first paint. Runs one frame after innerHTML so the doc is already on screen.
    const finishRender = () => {
      if (destroyed) return
      applyMultilineFlags()
      applyCollapsed() // restore folded sections AFTER measuring (hidden blocks measure 0)
      Object.keys(filterStateRef.current).forEach((ti) => applyFilter(parseInt(ti)))
      reportFilter()
      // Wide-table affordances: the top synced horizontal scrollbar + the
      // viewport-fixed floating header live outside the normal block flow (the
      // float is appended to body), so rebuild them on every full re-render and
      // tear the old ones down first.
      tableScrollRef.current?.destroy()
      tableScrollRef.current = enhanceKeepTables(host, host.closest('.editor-scroll'), {
        onFilterClick: (clonedBtn) => openFilterPop(clonedBtn),
        // Editing a floating-header cell: resolve the clone to the REAL <th> (same
        // data-line/data-ci → same source line) and edit that, but anchor the
        // editor popup under the clicked clone so it appears where the user clicked.
        onHeaderEdit: (clonedTh) => {
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
      if (embedObserver) embedObserver.disconnect() // drop stale observations from the old DOM
      observeEmbeds()
    }

    // Tag multi-line blocks so the edit button pins to the top-right; single-line
    // blocks keep it vertically centered. Primary signal is the source line span; a
    // height check also catches a long single line that wraps. Two phases — read all
    // layout first, THEN write all classes — so writes don't force a reflow on the
    // next read. The font size is uniform across the writing area, so read it ONCE
    // (not getComputedStyle per block — that per-block style recalc was a chunk of
    // the startup stall on docs with many short blocks).
    const applyMultilineFlags = () => {
      const elByBi = new Map()
      host.querySelectorAll('.km-block').forEach((el) => {
        const bi = el.getAttribute('data-bi')
        if (bi != null) elByBi.set(Number(bi), el)
      })
      const baseFs = parseFloat(getComputedStyle(host).fontSize) || 16
      const pending = []
      blocksRef.current.forEach((b, bi) => {
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
    // Single-block variant for scoped restores (one getComputedStyle is fine).
    const applyMultilineForBlock = (bl, b) => {
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

    // ── heading section collapse / expand (display-only; never touches rawLines) ──
    // A heading block carries `data-hlevel`. Collapsing one hides every following
    // block until the next heading of the same or higher level. State is kept as a
    // Set of section keys (so it survives the full re-render an edit triggers) while
    // the live `km-collapsed` class on heading blocks is the source of truth the DOM
    // derives visibility from. Nesting works: a block is hidden if ANY ancestor
    // heading is collapsed (recomputed each time, not cached per block).
    const sectionKey = (headEl) => {
      const lvl = headEl.getAttribute('data-hlevel') || ''
      const h = headEl.querySelector('h1,h2,h3,h4,h5,h6')
      return lvl + ':' + (h ? (h.textContent || '').trim() : '')
    }
    // Re-derive `km-section-hidden` on every block from the `km-collapsed` headings.
    const refreshVisibility = () => {
      const stack = [] // levels of currently-open collapsed ancestor headings
      host.querySelectorAll('.km-block').forEach((el) => {
        const isHeading = el.hasAttribute('data-hlevel')
        const lvl = isHeading ? parseInt(el.getAttribute('data-hlevel')) : null
        if (isHeading) while (stack.length && stack[stack.length - 1] >= lvl) stack.pop()
        el.classList.toggle('km-section-hidden', stack.length > 0)
        if (isHeading && el.classList.contains('km-collapsed')) stack.push(lvl)
      })
    }
    const toggleSection = (headEl) => {
      const collapsed = !headEl.classList.contains('km-collapsed')
      headEl.classList.toggle('km-collapsed', collapsed)
      if (collapsed) collapsedRef.current.add(sectionKey(headEl))
      else collapsedRef.current.delete(sectionKey(headEl))
      refreshVisibility()
      tableScrollRef.current?.update() // hidden/shown tables change the layout
    }
    // Re-apply the persisted collapse state after a full re-render rebuilt the DOM.
    const applyCollapsed = () => {
      host.querySelectorAll('.km-block[data-hlevel]').forEach((el) => {
        el.classList.toggle('km-collapsed', collapsedRef.current.has(sectionKey(el)))
      })
      refreshVisibility()
    }
    // Expand every collapsed ancestor section that hides `el` (an <hN>), so an
    // outline jump to a buried heading can actually scroll to it. The heading's OWN
    // collapse state is left alone (it hides only its children, not itself).
    const revealHeading = (el) => {
      if (!el || !host.contains(el)) return false
      const block = el.closest('.km-block')
      if (!block) return false
      let need = block.hasAttribute('data-hlevel') ? parseInt(block.getAttribute('data-hlevel')) : Infinity
      let node = block.previousElementSibling
      while (node && need > 1) {
        if (node.classList?.contains('km-block') && node.hasAttribute('data-hlevel')) {
          const lvl = parseInt(node.getAttribute('data-hlevel'))
          if (lvl < need) {
            if (node.classList.contains('km-collapsed')) {
              node.classList.remove('km-collapsed')
              collapsedRef.current.delete(sectionKey(node))
            }
            need = lvl
          }
        }
        node = node.previousElementSibling
      }
      refreshVisibility()
      return true
    }

    // ── embeds (mermaid / KaTeX), rendered only when scrolled near view ──
    // renderDoc leaves placeholders; ```mermaid → diagram (async, cached, shared
    // with the rich editor) and $$…$$ → KaTeX. Rendering every diagram on mount was
    // a heavy synchronous chunk on diagram-heavy docs, so an IntersectionObserver
    // defers each one until it's about to scroll into view. `host.contains(el)`
    // guards a late async result whose element a newer re-render already replaced.
    const renderMermaidEl = (el) => {
      const T = tRef.current
      const code = el.getAttribute('data-code') || ''
      const cached = peekMermaidSvg(code)
      if (cached && cached.svg) {
        el.innerHTML = cached.svg
        return
      }
      el.classList.add('hm-mermaid-hint')
      el.textContent = T('mermaid.rendering')
      getMermaidSvg(code).then((res) => {
        if (destroyed || !host.contains(el)) return
        el.classList.remove('hm-mermaid-hint')
        if (res && res.svg) {
          el.innerHTML = res.svg
        } else {
          el.classList.add('hm-mermaid-error')
          el.textContent = T('mermaid.error') + ' ' + ((res && res.error) || '')
        }
      })
    }
    const getKatex = () => {
      if (!katexPromise) {
        // KaTeX styles ship with the Crepe theme, which only loads when the rich
        // editor mounts — a keep-only session needs the stylesheet pulled in here.
        import('katex/dist/katex.min.css').catch(() => {})
        katexPromise = import('katex')
          .then((m) => m.default || m)
          .catch(() => null)
      }
      return katexPromise
    }
    const renderMathEl = (el) => {
      getKatex().then((katex) => {
        if (!katex || destroyed || !host.contains(el)) return
        const tex = el.getAttribute('data-tex') || ''
        try {
          katex.render(tex, el, { displayMode: true, throwOnError: false })
        } catch (e) {
          el.classList.add('hm-mermaid-error')
          el.textContent = String((e && e.message) || e)
        }
      })
    }
    const ensureEmbedObserver = () => {
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
    const observeEmbed = (el) => {
      // An already-rendered (cache hit) diagram paints immediately — no need to wait
      // for it to scroll into view or to flash the "rendering…" hint.
      if (el.classList.contains('km-mermaid')) {
        const cached = peekMermaidSvg(el.getAttribute('data-code') || '')
        if (cached && cached.svg) {
          el.innerHTML = cached.svg
          return
        }
      }
      ensureEmbedObserver().observe(el)
    }
    const observeEmbeds = (root) => {
      ;(root || host).querySelectorAll('.km-mermaid, .km-math').forEach(observeEmbed)
    }

    // Tell the parent how many rows survive the active filters (status bar). Only
    // counts tables that actually have a filter applied; null = no filter active.
    const reportFilter = () => {
      if (!onFilterChangeRef.current) return
      let total = 0
      let shown = 0
      let anyActive = false
      host.querySelectorAll('table.km-table').forEach((table) => {
        const ti = table.getAttribute('data-ti')
        const cols = filterStateRef.current[ti]
        if (!cols || Object.keys(cols).length === 0) return
        anyActive = true
        table.querySelectorAll('tbody tr').forEach((tr) => {
          total++
          if (!tr.classList.contains('km-filtered')) shown++
        })
      })
      onFilterChangeRef.current(anyActive ? { shown, total } : null)
    }

    // ── table cell editing: an enlarged floating editor anchored to the cell ──
    // Rewrites only that one cell on that one raw line on commit. The popover is
    // position:fixed but re-anchored to the cell on scroll/resize so it tracks the
    // cell (instead of drifting over other content) — a roomy textarea for long
    // cells, replacing the cramped single-line input that lived inside the <td>.
    const closeCellPop = () => {
      if (activeCellPopRef.current) {
        activeCellPopRef.current.pop.remove()
        activeCellPopRef.current = null
      }
    }
    // Re-place the open editor under its cell; hide it while the cell is scrolled
    // out of the editor's viewport so it never floats over unrelated content.
    const repositionCellPop = () => {
      const cur = activeCellPopRef.current
      if (!cur) return
      const { pop } = cur
      // Anchor to the element the user actually clicked (the floating-header clone
      // when editing from there) so the editor sits under it, even though the edit
      // targets the real cell (`td`).
      const r = (cur.anchor || cur.td).getBoundingClientRect()
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
    // Re-anchor the open filter dropdown under its ▼ header button on scroll/resize
    // (position:fixed → viewport coords), and hide it while the header is scrolled
    // out of the editor's viewport so it stays pinned to the column header.
    const repositionFilterPop = () => {
      const pop = activePopRef.current
      const btn = activePopBtnRef.current
      if (!pop || !btn) return
      const r = btn.getBoundingClientRect()
      pop.style.left = Math.min(r.left, window.innerWidth - 260) + 'px'
      pop.style.top = r.bottom + 4 + 'px'
      const sc = host.closest('.editor-scroll')
      if (sc) {
        const sr = sc.getBoundingClientRect()
        pop.style.visibility = r.bottom < sr.top || r.top > sr.bottom ? 'hidden' : 'visible'
      }
    }
    const commitCellPop = () => {
      const cur = activeCellPopRef.current
      if (!cur) return
      const ta = cur.pop.querySelector('textarea')
      const val = ta ? ta.value.replace(/\n/g, '<br>') : cur.raw
      const td = cur.td
      closeCellPop()
      if (val === cur.raw) return
      rawLinesRef.current[cur.lineIdx] = replaceCellInLine(
        rawLinesRef.current[cur.lineIdx],
        cur.colIdx,
        val
      )
      // Keep the \r-stripped view in sync for this one line (block source edits read it).
      const rl = rawLinesRef.current[cur.lineIdx]
      viewLinesRef.current[cur.lineIdx] = rl.endsWith('\r') ? rl.slice(0, -1) : rl
      emitChange()
      // Scoped DOM update: a cell edit changes exactly one cell and shifts no line or
      // block index, so repaint just this <td>/<th> instead of rebuilding the whole
      // document. (A full rerender of a 2000-row table for one cell was seconds of
      // jank.) A header cell keeps its filter ▼, so patch only its content span.
      if (td && host.contains(td)) {
        td.setAttribute('data-raw', val)
        if (td.tagName === 'TH') {
          const span = td.querySelector('.km-th-content')
          if (span) span.innerHTML = inline(val)
          // Mirror the edit onto the floating-header clone so it stays identical.
          tableScrollRef.current?.refreshContent()
        } else {
          td.innerHTML = inline(val)
        }
      } else {
        rerender() // cell somehow detached — fall back to a full re-render
      }
    }
    // ── one edit bar at a time ──
    // Close the open block source editor, optionally committing it. Cancel and
    // commit both re-render (cancel must rebuild the block whose innerHTML we
    // replaced with the textarea); only commit rewrites rawLines first.
    const closeBlockEdit = (commit) => {
      const cur = activeBlockEditRef.current
      if (!cur) return
      activeBlockEditRef.current = null
      if (commit) {
        const { ta, b } = cur
        // Inherit this block's original EOL style (\r presence) so untouched
        // bytes never shift; every replacement line follows the same convention.
        const eol = (rawLinesRef.current[b.start] || '').endsWith('\r') ? '\r' : ''
        const newLines = ta.value
          .split('\n')
          .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l) + eol)
        rawLinesRef.current.splice(b.start, b.end - b.start + 1, ...newLines)
        emitChange()
        rerender() // line count may change → indices shift → rebuild the document
        return
      }
      // Clean cancel: nothing changed. Restore just THIS block's DOM (its innerHTML
      // was swapped for the textarea) instead of re-rendering — and re-serializing —
      // the whole document. (Block edits are only on non-table blocks; a no-op cancel
      // on a huge-table doc was the reported 2–3s stall.)
      const b = cur.b
      const bi = b.bi != null ? b.bi : blocksRef.current.indexOf(b)
      const blockDiv = bi >= 0 ? host.querySelector('.km-block[data-bi="' + bi + '"]') : null
      if (blockDiv) {
        blockDiv.innerHTML = renderBlockInner(b, bi, viewLinesRef.current, {
          srcEditLabel: tRef.current('keep.editSource'),
          collapseLabel: tRef.current('keep.toggleSection'),
          filterState: filterStateRef.current,
          baseDir: dirOf(docPathRef.current)
        })
        applyMultilineForBlock(blockDiv, b)
        observeEmbeds(blockDiv) // a restored ```mermaid / $$ block re-arms its embed
      } else {
        rerender()
      }
    }
    // Custom "save changes?" modal — deliberately NOT window.confirm. A native
    // dialog leaves the webContents unable to receive keyboard input after it
    // returns, so a textarea opened right after it is dead until reload. This is
    // plain DOM (same channel as the cell pop / context menu), styled like
    // RenameModal. Save = primary (Enter), Esc / click-away = cancel (keep editing).
    const closeConfirm = () => {
      if (activeConfirmRef.current) {
        activeConfirmRef.current.remove()
        activeConfirmRef.current = null
      }
    }
    const showConfirm = (message, { onSave, onDiscard }) => {
      closeConfirm()
      const T = tRef.current
      const wrap = document.createElement('div')
      const backdrop = document.createElement('div')
      backdrop.className = 'menu-backdrop'
      backdrop.style.zIndex = '1400' // above the cell pop / table menu (1300)
      const box = document.createElement('div')
      box.className = 'hm-rename-modal'
      box.style.zIndex = '1401'
      // .hm-rename-modal centers via `transform: translateX(-50%)`, but its default
      // `menuFadeIn` animation also sets `transform: scale(...)`, which overrides the
      // centering for the animation's duration then snaps back → a sideways jump.
      // Use an opacity-only fade so the centering transform is never clobbered.
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
      discard.textContent = T('keep.editDiscardBtn')
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.textContent = T('edit.cancel')
      const save = document.createElement('button')
      save.type = 'button'
      save.className = 'primary'
      save.textContent = T('keep.editSaveBtn')
      // Order: save (primary) → discard → cancel.
      actions.append(save, discard, cancel)
      box.append(title, actions)
      wrap.append(backdrop, box)
      document.body.appendChild(wrap)
      activeConfirmRef.current = wrap
      const done = (fn) => () => {
        closeConfirm()
        fn?.()
      }
      backdrop.onclick = done(null) // click-away = cancel (do nothing, keep editing)
      cancel.onclick = done(null)
      discard.onclick = done(onDiscard)
      save.onclick = done(onSave)
      // preventScroll: a plain focus() would scrollIntoView the button, scrolling
      // the editor behind it and toggling a scrollbar → the centered modal jumps.
      save.focus({ preventScroll: true })
    }
    // Enforce "one edit bar": close whatever editor is open, then build the new
    // one. A clean editor closes silently; a dirty one prompts (save / discard /
    // cancel). Closing re-renders the doc (except a clean cell pop), so the build
    // re-resolves any DOM it captured — see the open helpers.
    const openAfterClose = (build) => {
      const cell = activeCellPopRef.current
      const blk = activeBlockEditRef.current
      if (!cell && !blk) return build()
      const msg = tRef.current('confirm.keepEditSave')
      if (cell) {
        const ta = cell.pop.querySelector('textarea')
        const val = ta ? ta.value.replace(/\n/g, '<br>') : cell.raw
        if (val === cell.raw) {
          closeCellPop() // clean: no re-render, captured td still valid
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
        closeBlockEdit(false) // clean discard still re-renders to restore the block
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

    const openCellPop = (td, anchor) =>
      openAfterClose(() => {
        if (destroyed) return
        // A commit re-rendered the doc → the original cell is detached; re-resolve.
        // Match both <td> (body) and <th> (header) — headers are editable too.
        if (!host.contains(td)) {
          const lineAttr = td.getAttribute('data-line')
          const ciAttr = td.getAttribute('data-ci')
          const sel =
            'td[data-line="' + lineAttr + '"][data-ci="' + ciAttr + '"],' +
            'th[data-line="' + lineAttr + '"][data-ci="' + ciAttr + '"]'
          td = host.querySelector(sel)
          if (!td) return
        }
        const T = tRef.current
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
        ok.textContent = T('keep.editConfirmKey')
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.textContent = T('edit.cancel')
        // Confirm first, cancel after — same button order as the block source editor.
        act.appendChild(ok)
        act.appendChild(cancel)
        pop.appendChild(ta)
        pop.appendChild(act)
        document.body.appendChild(pop)
        // `anchor` is the (possibly floating-header) element to position under; it
        // falls back to the real cell. Re-resolve it too if it got detached.
        const anchorEl = anchor && anchor.isConnected ? anchor : td
        activeCellPopRef.current = { pop, td, anchor: anchorEl, raw, lineIdx, colIdx }
        repositionCellPop() // anchor below the cell, flip/clamp to stay on screen
        ta.focus()
        ta.select()
        // Ctrl/Cmd+Enter commits; a plain Enter inserts a newline (cells can be
        // multi-line, serialized back as <br>). Esc cancels.
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

    // ── block "edit source": swap a non-table block's raw lines via a textarea ──
    const startBlockEdit = (bi) =>
      openAfterClose(() => {
        // only one edit bar at a time; openAfterClose re-renders on a save, so
        // resolve the block fresh here (not before the close).
        if (destroyed) return
        const b = blocksRef.current[bi]
        if (!b) return
        const blockDiv = host.querySelector('.km-block[data-bi="' + bi + '"]')
        if (!blockDiv) return
        const raw = viewLinesRef.current.slice(b.start, b.end + 1).join('\n')
        const ta = document.createElement('textarea')
        ta.className = 'km-src-editor'
        ta.value = raw
        ta.rows = Math.min(20, raw.split('\n').length + 1)
        const act = document.createElement('div')
        act.className = 'km-src-actions'
        const ok = document.createElement('button')
        ok.type = 'button'
        ok.className = 'ok'
        ok.textContent = tRef.current('keep.editConfirmKey')
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.textContent = tRef.current('edit.cancel')
        act.appendChild(ok)
        act.appendChild(cancel)
        blockDiv.innerHTML = ''
        blockDiv.appendChild(ta)
        blockDiv.appendChild(act)
        ta.focus()
        activeBlockEditRef.current = { ta, b, originalRaw: raw }
        // Ctrl/Cmd+Enter commits; a plain Enter stays a newline (block source is
        // multi-line). Esc cancels.
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

    // ── structural table edits: add / remove rows & columns ──
    // Each rewrites only lines within the table's range, then re-parses. The
    // ti → table-block lookup is resolved fresh at call time (line indices shift
    // after a structural edit, so we never cache a stale block).
    const getTable = (ti) => blocksRef.current.filter((b) => b.type === 'table')[ti]

    const doInsertRow = (ti, ri, where) => {
      const b = getTable(ti)
      if (!b) return
      let at
      if (where === 'first') at = b.sepLine + 1
      else if (where === 'above') at = b.dataRows[ri]?.lineIdx
      else at = (b.dataRows[ri]?.lineIdx ?? b.sepLine) + 1
      if (at == null) return
      const row = buildTableRow(b.headers.length, rawLinesRef.current[b.headerLine] || '')
      rawLinesRef.current.splice(at, 0, row)
      emitChange()
      rerender()
    }
    const doDeleteRow = (ti, ri) => {
      const b = getTable(ti)
      if (!b) return
      const dr = b.dataRows[ri]
      if (!dr) return
      rawLinesRef.current.splice(dr.lineIdx, 1)
      emitChange()
      rerender()
    }
    const doInsertColumn = (ti, colIdx) => {
      const b = getTable(ti)
      if (!b) return
      for (let ln = b.start; ln <= b.end; ln++) {
        const content = ln === b.sepLine ? '---' : ''
        rawLinesRef.current[ln] = insertColumnInLine(rawLinesRef.current[ln], colIdx, content)
      }
      delete filterStateRef.current[ti] // column indices shifted — drop stale filters
      emitChange()
      rerender()
    }
    const doDeleteColumn = (ti, colIdx) => {
      const b = getTable(ti)
      if (!b || b.headers.length <= 1) return // never delete the last column
      for (let ln = b.start; ln <= b.end; ln++) {
        rawLinesRef.current[ln] = removeColumnInLine(rawLinesRef.current[ln], colIdx)
      }
      delete filterStateRef.current[ti] // column indices shifted — drop stale filters
      emitChange()
      rerender()
    }

    const closeMenu = () => {
      if (activeMenuRef.current) {
        activeMenuRef.current.remove()
        activeMenuRef.current = null
      }
    }
    // Build a context menu from an items array ({label, fn, disabled} | 'sep').
    const openMenu = (x, y, items) => {
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
      activeMenuRef.current = menu
    }
    // Table-specific row/column entries, appended to a menu's items array.
    const buildTableItems = (items, ti, ri, ci, isHeader) => {
      const T = tRef.current
      const b = getTable(ti)
      if (isHeader) {
        items.push({ label: T('keep.rowInsertFirst'), fn: () => doInsertRow(ti, ri, 'first') })
      } else {
        items.push({ label: T('keep.rowInsertAbove'), fn: () => doInsertRow(ti, ri, 'above') })
        items.push({ label: T('keep.rowInsertBelow'), fn: () => doInsertRow(ti, ri, 'below') })
      }
      items.push('sep')
      items.push({ label: T('keep.colInsertLeft'), fn: () => doInsertColumn(ti, ci) })
      items.push({ label: T('keep.colInsertRight'), fn: () => doInsertColumn(ti, ci + 1) })
      items.push('sep')
      if (!isHeader) items.push({ label: T('keep.rowDelete'), fn: () => doDeleteRow(ti, ri) })
      items.push({
        label: T('keep.colDelete'),
        fn: () => doDeleteColumn(ti, ci),
        disabled: !b || b.headers.length <= 1
      })
    }

    // ── rich-text copy & "open source here" (general right-click / Ctrl+C) ──
    // The single source of truth is rawLines; "open source here" hands the parent
    // a 0-based source line so it can flip global source mode and place the caret.
    const lineForBlock = (block) => {
      if (!block) return 0
      const bi = parseInt(block.getAttribute('data-bi'))
      const b = blocksRef.current[bi]
      return b ? b.start : 0
    }
    const blockOfNode = (node) => {
      const el = node && (node.nodeType === 1 ? node : node.parentElement)
      return el && host.contains(el) ? el.closest('.km-block') : null
    }
    const openSourceAt = (lineIdx) => {
      closeMenu()
      onOpenSourceRef.current?.(lineIdx)
    }
    // Low-level: put a rich (html) + plain payload on the clipboard.
    const writeClipboard = (html, plain) => {
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
    // Clone a node, drop editor-only chrome, inline styles → { html, text }.
    const richHtml = (node) => {
      const wrap = document.createElement('div')
      wrap.appendChild(node)
      wrap.querySelectorAll('.km-src-edit, .km-filter-btn, button').forEach((el) => el.remove())
      inlineRichStyles(wrap)
      return { html: `<div style="${COPY_WRAP}">${wrap.innerHTML}</div>`, text: wrap.textContent || '' }
    }
    const writeRich = (node, plain) => {
      const r = richHtml(node)
      writeClipboard(r.html, plain != null ? plain : r.text)
    }
    const copyElement = (el) => writeRich(el.cloneNode(true))
    const copySelection = (sel) => {
      try {
        writeRich(sel.getRangeAt(0).cloneContents(), sel.toString())
      } catch {
        /* nothing meaningful selected */
      }
    }
    // ── table copy: cell / row / column / whole table ──
    // Plain text is TSV so it lands in a spreadsheet grid; the HTML carries a real
    // <table> so Excel/Word paste keeps the grid (not one crammed cell).
    const cellPlain = (c) => {
      if (!c) return ''
      const cl = c.cloneNode(true)
      cl.querySelectorAll('.km-filter-btn').forEach((el) => el.remove())
      cl.querySelectorAll('br').forEach((br) => br.replaceWith(' '))
      return (cl.textContent || '').trim()
    }
    const wrapRows = (rows) => {
      // rows: array of <tr> clones → a standalone <table> for rich paste.
      const t = document.createElement('table')
      const tb = document.createElement('tbody')
      rows.forEach((tr) => tb.appendChild(tr))
      t.appendChild(tb)
      return t
    }
    const copyTable = (table) => {
      const rows = [...table.querySelectorAll('tr')]
      const tsv = rows.map((tr) => [...tr.children].map(cellPlain).join('\t')).join('\n')
      writeRich(table.cloneNode(true), tsv)
    }
    const copyRow = (tr) => {
      const tsv = [...tr.children].map(cellPlain).join('\t')
      writeRich(wrapRows([tr.cloneNode(true)]), tsv)
    }
    const copyColumn = (table, ci) => {
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
    // Ctrl/Cmd+C over a drag selection → rich HTML, not just plain text.
    const onCopy = (e) => {
      if (activeCellPopRef.current) return // editing a cell: let the textarea copy
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
        /* fall back to default copy */
      }
    }

    // ── Excel-style column filter (display only — never touches rawLines) ──
    const closePop = () => {
      if (activePopRef.current) {
        activePopRef.current.remove()
        activePopRef.current = null
      }
      activePopBtnRef.current = null
    }
    const openFilterPop = (btn) => {
      closePop()
      const ti = parseInt(btn.getAttribute('data-ti'))
      const ci = parseInt(btn.getAttribute('data-ci'))
      const table = host.querySelector('table[data-ti="' + ti + '"]')
      if (!table) return
      const values = new Set()
      table.querySelectorAll('tbody tr').forEach((tr) => {
        const td = tr.children[ci]
        const v = (td?.getAttribute('data-raw') || '').trim()
        values.add(v === '' ? '(空白)' : v)
      })
      filterStateRef.current[ti] = filterStateRef.current[ti] || {}
      const excluded = filterStateRef.current[ti][ci] || new Set()

      const pop = document.createElement('div')
      pop.className = 'km-filter-pop'
      pop.innerHTML =
        '<input class="km-fp-search" placeholder="' +
        escapeAttrLocal(tRef.current('keep.filterSearch')) +
        '">' +
        '<div class="km-fp-tools"><a data-all="1">' +
        escapeHtmlLocal(tRef.current('keep.selectAll')) +
        '</a><a data-all="0">' +
        escapeHtmlLocal(tRef.current('keep.selectNone')) +
        '</a></div>' +
        '<div class="km-fp-list"></div>' +
        // Confirm first, cancel after — matches the cell / block source editors.
        '<div class="km-fp-actions"><button type="button" class="ok">' +
        escapeHtmlLocal(tRef.current('edit.confirm')) +
        '</button><button type="button" class="cancel">' +
        escapeHtmlLocal(tRef.current('edit.cancel')) +
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
        // Excel-style: the search box narrows the visible list; confirming keeps
        // only the values that are BOTH visible (match the search) AND checked,
        // and excludes everything else. So typing a search term and confirming
        // filters the table down to the matching rows. (Previously the hidden,
        // non-matching values were silently kept unless already excluded, so a
        // search-then-confirm with no manual unchecking did nothing.)
        const keep = new Set(
          [...list.querySelectorAll('input')]
            .filter((cb) => cb.checked)
            .map((cb) => cb.dataset.v)
        )
        const ex = new Set()
        sorted.forEach((v) => {
          if (!keep.has(v)) ex.add(v)
        })
        if (ex.size > 0) filterStateRef.current[ti][ci] = ex
        else delete filterStateRef.current[ti][ci]
        closePop()
        // A filter only toggles row visibility — it never touches rawLines or block
        // structure. Apply it directly instead of a full re-render (rebuilding a
        // huge table just to hide a few rows was needless seconds of work), and sync
        // the ▼ button's active state since renderTable didn't re-run to set it.
        applyFilter(ti)
        reportFilter()
        const cols = filterStateRef.current[ti]
        const isActive = !!(cols && cols[ci] && cols[ci].size > 0)
        // Toggle the ▼ active state on every copy of this column's button — the
        // live header AND the floating-header clone (which may be the one clicked).
        host
          .querySelectorAll('.km-filter-btn[data-ti="' + ti + '"][data-ci="' + ci + '"]')
          .forEach((b) => b.classList.toggle('active', isActive))
        document
          .querySelectorAll('.km-float-header .km-filter-btn[data-ti="' + ti + '"][data-ci="' + ci + '"]')
          .forEach((b) => b.classList.toggle('active', isActive))
        // Hiding rows can reflow column widths — re-measure the floating header so
        // it stays aligned with the (now narrower/wider) live table.
        tableScrollRef.current?.update()
      }
      document.body.appendChild(pop)
      activePopRef.current = pop
      activePopBtnRef.current = btn
      repositionFilterPop()
    }
    const applyFilter = (ti) => {
      const table = host.querySelector('table[data-ti="' + ti + '"]')
      if (!table) return
      const cols = filterStateRef.current[ti] || {}
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

    // Classify a clicked link: external → system browser; in-app doc link or
    // pure #anchor → hand the (path, anchor, fromPath) to the parent so it opens
    // the markdown tab and jumps. Other schemes (file:, etc.) open externally.
    const activateLink = (href) => {
      if (/^(https?:|mailto:)/i.test(href)) {
        window.api?.openExternal?.(href)
        return
      }
      const hashIdx = href.indexOf('#')
      const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href
      const anchor = hashIdx >= 0 ? safeDecode(href.slice(hashIdx + 1)) : ''
      const path = safeDecode(rawPath)
      if (/^[a-z][a-z\d+.-]*:/i.test(path)) {
        // a non-http scheme with a path (file:, vscode:, …) — let the OS handle it
        window.api?.openExternal?.(href)
        return
      }
      onOpenDocLinkRef.current?.(path, anchor, docPathRef.current)
    }

    // ── event delegation on the host container ──
    let linkTimerRef = null // pending single-click link-open (cancelled by dblclick)
    const onDblClick = (e) => {
      clearTimeout(linkTimerRef) // a double-click is an edit, not a link navigation
      if (e.target.closest('.km-collapse-toggle')) return // a fold toggle, not an edit
      // Edit any table cell — body (<td>) or header (<th>). The filter ▼ lives in
      // the header; a double-click on it is a filter toggle, not a cell edit.
      const cell = e.target.closest('td, th')
      if (cell && host.contains(cell) && !e.target.closest('.km-filter-btn')) {
        openCellPop(cell)
        return
      }
      // Double-clicking the highlighted area of an editable (non-table) block
      // enters source edit — same affordance as the pencil button. The guard
      // (a direct `.km-src-edit` child) excludes tables and skips a block that's
      // already editing, where the button is replaced by the textarea.
      const block = e.target.closest('.km-block')
      if (block && host.contains(block) && block.querySelector(':scope > .km-src-edit')) {
        startBlockEdit(parseInt(block.getAttribute('data-bi')))
      }
    }
    const onClick = (e) => {
      // Fold/unfold a heading's section. Handled first so it never falls through to
      // link-open or block-edit; stopPropagation keeps the block hover-edit quiet.
      const ct = e.target.closest('.km-collapse-toggle')
      if (ct) {
        e.stopPropagation()
        const head = ct.closest('.km-block[data-hlevel]')
        if (head) toggleSection(head)
        return
      }
      // A plain click on a link opens it (keep mode is a read-only preview). The
      // open is deferred briefly and cancelled by a following dblclick, so
      // double-clicking a cell/block that contains a link still enters edit. Skip
      // when a drag selection is active (don't navigate on select-ends-on-link).
      const a = e.target.closest('a')
      if (a && host.contains(a) && !e.shiftKey && (window.getSelection()?.isCollapsed ?? true)) {
        const href = a.getAttribute('href')
        if (href && href !== '#') {
          e.preventDefault()
          clearTimeout(linkTimerRef)
          linkTimerRef = setTimeout(() => activateLink(href), 230)
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
        // Toggle: clicking the same ▼ that opened the dropdown closes it.
        if (activePopRef.current && activePopBtnRef.current === fb) closePop()
        else openFilterPop(fb)
      }
    }
    // Right-click anywhere in the document → context menu. A drag selection wins
    // (copy selection / open source at its start); else a table cell shows copy +
    // open-source + its row/column ops; else a plain block shows copy + open-source.
    const onContextMenu = (e) => {
      const T = tRef.current
      const sel = window.getSelection()
      const hasSel =
        sel && !sel.isCollapsed && host.contains(sel.anchorNode) && host.contains(sel.focusNode)
      const items = []
      if (hasSel) {
        const line = lineForBlock(blockOfNode(sel.getRangeAt(0).startContainer))
        items.push({ label: T('keep.copySel'), fn: () => copySelection(sel) })
        items.push({ label: T('keep.openSource'), fn: () => openSourceAt(line) })
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
          const line = parseInt(cell.getAttribute('data-line'))
          items.push({ label: T('keep.copyCell'), fn: () => copyElement(cell) })
          items.push({ label: T('keep.copyRow'), fn: () => copyRow(tr) })
          items.push({ label: T('keep.copyCol'), fn: () => copyColumn(table, ci) })
          items.push({ label: T('keep.copyTable'), fn: () => copyTable(table) })
          if (Number.isFinite(line))
            items.push({ label: T('keep.openSource'), fn: () => openSourceAt(line) })
          items.push('sep')
          buildTableItems(items, ti, ri, ci, isHeader)
        } else {
          const block = e.target.closest('.km-block')
          if (!block || !host.contains(block)) return
          const line = lineForBlock(block)
          items.push({ label: T('keep.copy'), fn: () => copyElement(block) })
          items.push({ label: T('keep.openSource'), fn: () => openSourceAt(line) })
        }
      }
      if (!items.length) return
      e.preventDefault()
      openMenu(e.clientX, e.clientY, items)
    }
    // Close the filter dropdown / context menu on an outside click. A cell editor
    // is NOT auto-committed here: it stays open like a block source editor and is
    // only closed via its own buttons/Esc, or with a save prompt when another
    // editor opens (openAfterClose) — one consistent "one edit bar" rule.
    const onDocDown = (e) => {
      if (
        activePopRef.current &&
        !activePopRef.current.contains(e.target) &&
        !e.target.classList.contains('km-filter-btn')
      ) {
        closePop()
      }
      if (activeMenuRef.current && !activeMenuRef.current.contains(e.target)) closeMenu()
    }
    const onEsc = (e) => {
      if (e.key !== 'Escape') return
      if (activeConfirmRef.current) closeConfirm() // Esc on the modal = cancel
      else if (activeMenuRef.current) closeMenu()
    }
    // Scrolling abandons an open right-click menu (its anchor moved away). The
    // cell editor stays open on purpose (it may hold unsaved edits) and is
    // re-anchored to its cell so it tracks the cell instead of drifting.
    const onScroll = () => {
      closeMenu()
      repositionCellPop()
      repositionFilterPop()
      tableScrollRef.current?.update()
    }
    const onResize = () => {
      repositionCellPop()
      repositionFilterPop()
      tableScrollRef.current?.update()
    }

    // Close every body-level popover at once (a cell editor included — its unsaved
    // edits are dropped, which beats it floating over an unrelated document).
    closeFloatingRef.current = () => {
      closePop()
      closeMenu()
      closeConfirm()
      closeCellPop()
      tableScrollRef.current?.hide() // a fixed floating header would otherwise linger
    }

    host.addEventListener('dblclick', onDblClick)
    host.addEventListener('click', onClick)
    host.addEventListener('contextmenu', onContextMenu)
    host.addEventListener('copy', onCopy)
    document.addEventListener('click', onDocDown)
    document.addEventListener('keydown', onEsc)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)

    rerender()

    onReady?.({
      getMarkdown: () => rawLinesRef.current.join('\n'),
      // PDF export: a clean snapshot without the edit affordances / filter ▼. The
      // export render leaves mermaid/math as empty placeholders (they fill async in
      // the live DOM), so copy each already-rendered diagram/formula across by index
      // — both come from the same rawLines, so the Nth placeholder matches.
      getDocHTML: () => {
        const tmp = document.createElement('div')
        tmp.innerHTML = renderDoc(rawLinesRef.current, {}, { forExport: true, baseDir: dirOf(docPathRef.current) }).html
        // Embeds now render lazily (only when scrolled near view), so the live host
        // may not hold a diagram the export needs. Fill mermaid from the shared
        // session cache first (covers anything ever rendered), then copy the live
        // DOM by index for whatever the cache misses / for math.
        tmp.querySelectorAll('.km-mermaid').forEach((el) => {
          const c = peekMermaidSvg(el.getAttribute('data-code') || '')
          if (c && c.svg) el.innerHTML = c.svg
        })
        const inject = (sel) => {
          const live = [...host.querySelectorAll(sel)]
          ;[...tmp.querySelectorAll(sel)].forEach((el, i) => {
            if (live[i] && live[i].innerHTML) el.innerHTML = live[i].innerHTML
          })
        }
        inject('.km-mermaid')
        inject('.km-math')
        return tmp.innerHTML
      },
      setBlock: () => {}, // no block model in keep mode
      // Outline jump: if the target heading is buried in a collapsed section, expand
      // its ancestors first so App's scrollIntoView lands on a visible element.
      revealHeading: (el) => revealHeading(el)
    })

    return () => {
      destroyed = true
      cancelAfterPaint()
      if (embedObserver) embedObserver.disconnect()
      clearTimeout(linkTimerRef)
      closePop()
      closeMenu()
      closeConfirm()
      closeCellPop()
      tableScrollRef.current?.destroy() // remove body-appended floating headers
      tableScrollRef.current = null
      activeBlockEditRef.current = null // drop block-edit tracking (host is torn down)
      onFilterChangeRef.current?.(null) // drop this tab's filter badge on unmount
      host.removeEventListener('dblclick', onDblClick)
      host.removeEventListener('click', onClick)
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('copy', onCopy)
      document.removeEventListener('click', onDocDown)
      document.removeEventListener('keydown', onEsc)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When this tab's pane leaves view (sidebar file click, tab switch, split
  // close), the wrapper goes display:none — but the floating popovers are
  // appended to document.body, so they'd keep showing over the next document.
  // Tear them down here. (A still-open block source editor lives inside the
  // hidden host, so it's hidden with the wrapper; no need to touch it.)
  useEffect(() => {
    if (!inView) closeFloatingRef.current?.()
  }, [inView])

  // Hot-swap the static "edit source" labels when the UI language changes. The
  // doc HTML is rendered once on mount (rerender lives in a []-deps effect), so
  // the baked-in labels would otherwise stay in the original language. Patch them
  // in place instead of re-rendering, to preserve any active edit/filter state.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const label = tRef.current('keep.editSource')
    host.querySelectorAll('.km-src-edit').forEach((btn) => {
      btn.title = label
      const span = btn.querySelector('span')
      if (span) span.textContent = label
    })
  }, [lang])

  return <div className="km-doc" ref={hostRef} />
}

// Decode a URL component, tolerating malformed escapes (return the input as-is).
function safeDecode(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// Tiny local escapers (avoid importing if tree-shaking matters; mirror parser).
function escapeHtmlLocal(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeAttrLocal(s) {
  return escapeHtmlLocal(s).replace(/"/g, '&quot;')
}
