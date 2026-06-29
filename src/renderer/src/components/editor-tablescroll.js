// Keep-mode wide-table affordances.
//
// Per rendered `.km-table-wrap` we add:
//   (1) a synced horizontal scrollbar ABOVE the table (in document flow), so wide
//       columns can be scrolled sideways without first scrolling to the table's
//       bottom; and
//   (2) a viewport-fixed "floating" header — its OWN top scrollbar plus a clone
//       of the `<thead>` — shown while the real header has scrolled past the top
//       of the editor viewport, so the column names, their filter ▼, AND the
//       horizontal scrollbar stay reachable while reading deep rows.
//
// Why JS and not plain CSS `position: sticky`: the wrapper needs `overflow-x:auto`
// for horizontal scroll, and per the CSS overflow spec that forces `overflow-y`
// to compute to `auto` too — which makes the wrapper a vertical scroll container
// and defeats a sticky header anchored to the *page* scroller. So we clone the
// header into a `position: fixed` element and sync width + horizontal scroll by
// hand. Mirrors the standalone Markdown viewer's approach.
//
// `scroller` is the keep doc's scroll parent (`.editor-scroll`); the float pins to
// the top of THAT element's viewport (the app has a top bar above it), and drops
// below the find bar while it's open so it never covers the search box.
// `onFilterClick(clonedBtn)` is invoked when a cloned ▼ is clicked so the host can
// open the real filter dropdown anchored to the (visible) clone.

export function enhanceKeepTables(host, scroller, { onFilterClick, onHeaderEdit } = {}) {
  const noop = { update() {}, hide() {}, destroy() {} }
  if (!host) return noop

  const cleanups = []
  const floats = []

  host.querySelectorAll('.km-table-wrap').forEach((wrap) => {
    const table = wrap.querySelector('table.km-table')
    if (!table) return
    const thead = table.querySelector('thead')

    // One horizontal scroll position shared by every surface that scrolls the
    // table sideways: the wrap itself, the in-flow top bar, the float's top bar,
    // and the float's clipped header. A re-entrancy guard stops the echo loop.
    const hGroup = []
    let hsyncing = false
    const syncH = (src) => {
      if (hsyncing) return
      hsyncing = true
      const x = src.scrollLeft
      for (const el of hGroup) if (el !== src) el.scrollLeft = x
      hsyncing = false
    }
    const addH = (el, listen) => {
      hGroup.push(el)
      if (listen) {
        const fn = () => syncH(el)
        el.addEventListener('scroll', fn, { passive: true })
        cleanups.push(() => el.removeEventListener('scroll', fn))
      }
    }
    addH(wrap, true)

    // ── (1) in-flow top scrollbar ───────────────────────────────────────────
    const topBar = document.createElement('div')
    topBar.className = 'km-table-scrolltop'
    const topInner = document.createElement('div')
    topInner.className = 'km-table-scrolltop-inner'
    topBar.appendChild(topInner)
    wrap.parentNode.insertBefore(topBar, wrap)
    addH(topBar, true)

    const syncTopWidth = () => {
      const tw = table.scrollWidth
      topInner.style.width = tw + 'px'
      topBar.classList.toggle('km-hidden', tw <= wrap.clientWidth + 1)
    }
    // Filtering can resize the table (auto-layout columns reflow) — re-measure.
    const ro = new ResizeObserver(syncTopWidth)
    ro.observe(table)
    ro.observe(wrap)
    syncTopWidth()
    // topBar lives inside `host` (wiped on full re-render); remove it explicitly
    // for in-place teardown and drop the observer.
    cleanups.push(() => {
      ro.disconnect()
      topBar.remove()
    })

    if (!thead) return

    // ── (2) floating header: own top scrollbar + cloned thead ───────────────
    const floatEl = document.createElement('div')
    floatEl.className = 'km-float-header'
    // A visual duplicate of the live header — keep it out of the accessibility
    // tree (and out of find/copy intent) so it isn't announced twice.
    floatEl.setAttribute('aria-hidden', 'true')

    const fTop = document.createElement('div')
    fTop.className = 'km-float-scrolltop'
    const fTopInner = document.createElement('div')
    fTopInner.className = 'km-table-scrolltop-inner'
    fTop.appendChild(fTopInner)

    const fscroll = document.createElement('div')
    fscroll.className = 'km-float-header-scroll'
    const cloneTable = document.createElement('table')
    cloneTable.className = table.className
    const cloneThead = thead.cloneNode(true)
    cloneTable.appendChild(cloneThead)
    fscroll.appendChild(cloneTable)

    floatEl.appendChild(fTop)
    floatEl.appendChild(fscroll)
    // Append inside .pane-center (the find bar's stacking parent) so a plain
    // z-index reliably orders the float below the find bar / dropdowns and above
    // document content — no need to out-z-index a separate root-level layer.
    // position:fixed still pins it to the viewport (no transformed ancestor).
    ;(host.closest('.pane-center') || document.body).appendChild(floatEl)
    addH(fTop, true)
    addH(fscroll, false) // clipped (overflow hidden); driven, never the source

    // Cloned ▼ buttons forward to the host, which opens the real dropdown anchored
    // to the (visible) clone. stopPropagation keeps the document-level
    // outside-click handler from closing it in the same gesture.
    cloneThead.querySelectorAll('.km-filter-btn').forEach((cb) => {
      cb.addEventListener('click', (e) => {
        e.stopPropagation()
        onFilterClick?.(cb)
      })
    })
    // Double-clicking a cloned header cell edits the column header — the host
    // resolves the clone to the REAL <th> (same data-line/data-ci → same source
    // line) so the edit writes back to the one source of truth, then re-syncs the
    // clone's content (below) so both headers stay identical.
    cloneThead.addEventListener('dblclick', (e) => {
      if (e.target.closest('.km-filter-btn')) return
      const th = e.target.closest('th')
      if (th) onHeaderEdit?.(th)
    })
    // Copy the live header's rendered content + data-raw onto the clone (called
    // after a header cell is edited in place, when no full re-render rebuilds us).
    const syncContent = () => {
      const o = thead.querySelectorAll('th')
      const c = cloneThead.querySelectorAll('th')
      o.forEach((th, i) => {
        if (!c[i]) return
        c[i].setAttribute('data-raw', th.getAttribute('data-raw') || '')
        const os = th.querySelector('.km-th-content')
        const cs = c[i].querySelector('.km-th-content')
        if (os && cs) cs.innerHTML = os.innerHTML
      })
    }

    // Match the clone's total + per-column widths to the live header. Re-measured
    // on every show, so it tracks edits / filtering / font-size / zoom changes.
    const syncWidths = () => {
      cloneTable.style.width = table.offsetWidth + 'px'
      fTopInner.style.width = table.scrollWidth + 'px'
      const o = thead.querySelectorAll('th')
      const c = cloneThead.querySelectorAll('th')
      o.forEach((th, i) => {
        if (!c[i]) return
        const px = th.offsetWidth + 'px'
        c[i].style.width = px
        c[i].style.minWidth = px
        c[i].style.maxWidth = px
      })
    }
    // Mirror each column's active-filter state onto the clone (live header is the
    // source of truth; the host keeps both in sync when a filter changes).
    const syncActive = () => {
      const o = thead.querySelectorAll('.km-filter-btn')
      const c = cloneThead.querySelectorAll('.km-filter-btn')
      o.forEach((ob, i) => {
        if (c[i]) c[i].classList.toggle('active', ob.classList.contains('active'))
      })
    }

    const hide = () => floatEl.classList.remove('km-visible')
    const update = () => {
      const sRect = scroller
        ? scroller.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight }
      const topOffset = sRect.top
      const theadRect = thead.getBoundingClientRect()
      const tableRect = table.getBoundingClientRect()
      // Show once the real header has scrolled above the offset line AND enough of
      // the table is still on screen to be worth a header for. (theadRect.height is
      // the visual height — matches topOffset/tableRect, both zoom-affected.)
      const show =
        theadRect.top < topOffset &&
        tableRect.bottom > topOffset + theadRect.height + 24 &&
        tableRect.top < sRect.bottom
      if (!show) {
        hide()
        return
      }
      syncWidths()
      syncActive()
      // The float carries the editor's `zoom` (so its cloned text/cells render at
      // the exact same scale). Under zoom, an element's own top/left are scaled
      // too, so divide the viewport coords by it; widths stay in layout px (the
      // zoom scales them up to match the live table, same as offsetWidth above).
      const z = parseFloat(getComputedStyle(host).getPropertyValue('--editor-zoom')) || 1
      // Align the float's content box with the table's visible viewport: the wrap's
      // padding box (inside its border → clientLeft/clientWidth), not its border box.
      const wrapRect = wrap.getBoundingClientRect()
      floatEl.style.top = topOffset / z + 'px'
      floatEl.style.left = wrapRect.left / z + wrap.clientLeft + 'px'
      floatEl.style.width = wrap.clientWidth + 'px'
      fTop.classList.toggle('km-hidden', table.scrollWidth <= wrap.clientWidth + 1)
      // Catch the float's horizontal position up to the table only on the
      // hidden→shown transition. Do NOT do it every call: update() runs from the
      // window 'scroll' CAPTURE handler, which fires BEFORE the float bar's own
      // scroll listener — re-setting scrollLeft here would clobber (freeze) a drag
      // on the float's own scrollbar. While shown, hGroup keeps it in sync.
      if (!floatEl.classList.contains('km-visible')) {
        fscroll.scrollLeft = wrap.scrollLeft
        fTop.scrollLeft = wrap.scrollLeft
      }
      floatEl.classList.add('km-visible')
    }

    floats.push({ update, hide, syncContent })
    cleanups.push(() => floatEl.remove())
  })

  return {
    update: () => floats.forEach((f) => f.update()),
    hide: () => floats.forEach((f) => f.hide()),
    refreshContent: () => floats.forEach((f) => f.syncContent()),
    destroy: () => cleanups.forEach((fn) => fn())
  }
}
