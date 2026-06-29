import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
// The Milkdown/Crepe rich editor pulls in the whole ProseMirror + KaTeX stack
// (~3.6 MB). It's only used when a tab opts into WYSIWYG (`milkdownForced`); the
// `.md` default is the lightweight source-backed KeepEditor. Loading it lazily
// keeps that heavy code (and its memory) out of startup for the common case.
const Editor = lazy(() => import('./components/Editor.jsx'))
import KeepEditor from './components/KeepEditor.jsx'
import Sidebar from './components/Sidebar.jsx'
import Tabs from './components/Tabs.jsx'
import Outline from './components/Outline.jsx'
import StatusBar from './components/StatusBar.jsx'
import SaveFab from './components/SaveFab.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import { Icon } from './components/icons.jsx'
import { THEMES, DEFAULT_THEME, applyTheme } from './themes.js'
import { I18nProvider, translate, DEFAULT_LANG } from './i18n.jsx'
import { welcomeDoc } from './onboarding.js'
import Welcome from './components/Welcome.jsx'
import WindowControls from './components/WindowControls.jsx'
import UpdateToast from './components/UpdateToast.jsx'
import RenameModal from './components/RenameModal.jsx'
import {
  loadSettings,
  saveSettings,
  applyPageWidth,
  applyFontSize,
  applyZoom,
  applyLineHeight,
  applyParagraphSpacing,
  normalizeZoom,
  ZOOM_STEP,
  DEFAULT_ZOOM
} from './settings.js'
import { applyCustomTheme } from './customThemes.js'
import { fireToast, HM_TOAST_EVENT } from './ui.js'
import logoUrl from './assets/logo.png'
import { clearFindHighlights, findRangesInEl, paintFindHighlights, scrollRangeIntoView, matchIndices, blockIndexForLine } from './find.js'
import {
  isNewerVersion, isAbsolutePath, sanitizeWorkspaces, baseName, dirName, joinPath,
  isPlainTextDoc, isHeavyDoc, genId, LS, loadSession, MD_DOC_RE
} from './paths.js'

const ONBOARDED_KEY = 'easymarkdown.onboarded.v1'
// One-time coach-mark explaining Keep vs Milkdown, shown on first run only.
const MODEHINT_KEY = 'easymarkdown.modehint.v1'
const UPDATE_DISMISS_KEY = 'easymarkdown.update.dismissed'

// Resolve a relative link path against a base directory (handles ./ and ../).
function resolveRelPath(dir, rel) {
  const base = (dir || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = base ? base.split('/') : []
  rel.replace(/\\/g, '/').split('/').forEach((seg) => {
    if (seg === '' || seg === '.') return
    if (seg === '..') parts.pop()
    else parts.push(seg)
  })
  return parts.join('/')
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Heading-anchor slug, Typora/GitHub-ish: trim, spaces→'-', drop punctuation.
const slugifyAnchor = (s) =>
  s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '')

// Find the 1-based source line an in-doc anchor points at. Tries, in order:
// a heading whose slug matches, an explicit id/name/{#id} anchor, then the first
// line that literally contains the anchor. Returns 0 when nothing matches.
function findAnchorLine(content, anchor) {
  if (!content || !anchor) return 0
  const lines = content.split('\n')
  const want = anchor.toLowerCase()
  const wantSlug = slugifyAnchor(anchor)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/)
    if (m && (slugifyAnchor(m[1]) === wantSlug || m[1].trim().toLowerCase() === want)) return i + 1
  }
  const re = new RegExp(`(?:id|name)\\s*=\\s*["']?${escapeRegExp(anchor)}["']?`, 'i')
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]) || lines[i].includes(`{#${anchor}}`)) return i + 1
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(anchor)) return i + 1
  }
  return 0
}

export default function App() {
  const session = useRef(loadSession()).current
  // Mobile (Capacitor) builds run the same renderer; a few affordances differ
  // (drawer sidebar, no split button). Desktop is unaffected.
  const isMobile = window.api.platform === 'ios' || window.api.platform === 'android'
  const [tabs, setTabs] = useState([])
  const [activeId, setActiveId] = useState(null)
  // Multi-root workspace: an array of { rootPath, rootName }, each rendered as its
  // own collapsible tree in the sidebar. Upgrading users with the old single
  // `session.workspace` get it migrated to the first root.
  const [workspaces, setWorkspaces] = useState(() =>
    sanitizeWorkspaces(session.workspaces, session.workspace)
  )
  // On phones the sidebar overlays the editor, so it starts closed to keep the
  // writing surface front-and-center (desktop keeps its previous default).
  const [sidebarOpen, setSidebarOpen] = useState(session.sidebarOpen ?? !isMobile)
  const [sidebarMode, setSidebarMode] = useState(session.sidebarMode || 'files') // 'files' or 'outline'
  // Desktop sidebar width (px), dragged via the divider on its right edge and
  // persisted across sessions. Ignored on mobile (the sidebar overlays).
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Math.min(560, Math.max(180, Number(session.sidebarWidth) || 260))
  )
  const [theme, setTheme] = useState(session.theme || DEFAULT_THEME)
  // Active custom CSS theme (filename in userData/themes), or null. Overlays the
  // built-in base theme. `customThemes` is the list scanned from that folder.
  const [customTheme, setCustomTheme] = useState(session.customTheme || null)
  const [customThemes, setCustomThemes] = useState([])
  const [lang, setLang] = useState(session.lang || DEFAULT_LANG)
  const [recents, setRecents] = useState(session.recents || [])
  const [sourceMode, setSourceMode] = useState(false)
  // Live mirror of sourceMode for ref-based reads inside stable callbacks.
  const sourceModeRef = useRef(sourceMode)
  sourceModeRef.current = sourceMode
  const [paletteOpen, setPaletteOpen] = useState(false)
  // "Home" shows the welcome/landing page while keeping open tabs mounted (so
  // returning to a document doesn't re-create its editor). Cleared whenever a
  // tab is activated or a file is opened.
  const [home, setHome] = useState(false)
  // Split view: id of the tab shown in the right pane (null = no split). The left
  // pane always shows the active tab; the right pane shows this one. A second,
  // independent editor — both panes are fully editable. Driven by the tab
  // right-click menu ("Open in Split") and the top-bar toggle.
  const [splitId, setSplitId] = useState(null)
  // Fraction of the editor area given to the left pane (0..1), dragged via the
  // divider between the two panes.
  const [splitRatio, setSplitRatio] = useState(0.5)
  // Which split pane is focused ('left' = active tab, 'right' = split tab). A tab
  // click loads into the focused pane, so both panes are switchable from the one
  // tab strip. Always 'left' when not split.
  const [focusedPane, setFocusedPane] = useState('left')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [files, setFiles] = useState([])
  // `mode` is 'text' (content search) or 'line' (jump to a markdown source line).
  const [find, setFind] = useState({ open: false, query: '', matches: 0, active: 0, mode: 'text' })
  // Current match set: Range objects (rich editor) or character offsets (source
  // textarea). Held in a ref so next/prev don't trigger re-renders.
  const findRangesRef = useRef([])
  // "New version available" toast — populated by the startup update check below.
  const [update, setUpdate] = useState(null)
  // Transient bottom-center toast (e.g. "Copied"), fired via a `hm:toast` event.
  const [toast, setToast] = useState(null)
  // Rename-from-tab-menu modal: { id, value } or null. (Electron has no
  // window.prompt, so renaming a tab's file uses this small inline dialog.)
  const [renameState, setRenameState] = useState(null)
  // Mobile "save as": prompt for a filename before writing an untitled doc into
  // the local library (desktop uses the native save dialog instead).
  const [saveNameState, setSaveNameState] = useState(null)
  // User preferences (page width, font size, zoom). Persisted separately from
  // the session; see settings.js.
  const [settings, setSettings] = useState(loadSettings)
  // Keep-mode table-filter results per tab id ({ shown, total } or null) — drives
  // the status-bar "filtered N/M" badge for the active tab.
  const [keepFilters, setKeepFilters] = useState({})

  const editorHostRef = useRef(null) // active rich editor's scroll container
  const editorAreaRef = useRef(null) // flex row holding the editor panes (for split-drag math)
  const paneLeftRef = useRef(null) // sidebar <aside> (for resize-drag math)
  const sourceRef = useRef(null) // active source-mode <textarea>
  const scrollRatioRef = useRef(null) // pending scroll position to restore across a mode switch
  const pendingSourceLineRef = useRef(null) // 0-based line to select after entering source mode
  const findInputRef = useRef(null)
  // Registry of each tab's editor API (by tab id). Several markdown editors can
  // be mounted at once (a tab stays mounted after its first activation), so a
  // single ref would get stuck on whichever editor mounted last; keying by tab
  // id lets commands act on the *currently active* document.
  const editorApis = useRef({})
  // The tab id of whichever editor pane last had focus — so Save / Export target
  // the pane you're actually editing in split view, not always the left one.
  const focusedTabRef = useRef(null)
  // Latest session snapshot, kept in a ref so the close/flush path can persist it
  // synchronously without waiting on the debounced write.
  const sessionRef = useRef(null)
  // Write the latest snapshot now (close / pagehide / debounce all funnel here,
  // so the persisted shape lives in exactly one place).
  const flushSession = useCallback(() => {
    if (!sessionRef.current) return
    try {
      localStorage.setItem(LS, JSON.stringify(sessionRef.current))
    } catch {
      /* quota / serialization failure — skip this snapshot */
    }
  }, [])
  const [activeBlock, setActiveBlock] = useState('paragraph')
  // Lazy mounting: a rich (Crepe) editor is only created once its tab has been
  // activated, then kept mounted so later tab switches stay instant. This keeps
  // startup/session-restore fast — only the active tab spins up an editor
  // instead of every restored tab parsing its whole document at once.
  const [mountedIds, setMountedIds] = useState(() => new Set())
  // Tab ids the user explicitly chose to render richly despite being "heavy"
  // (would otherwise open in the fast plain-text editor to avoid a long freeze).
  const [richForced, setRichForced] = useState(() => new Set())
  // Tab ids the user explicitly switched to the Milkdown (Crepe) editor. `.md`
  // docs default to the source-backed "keep" editor (zero-diff saves); this Set
  // opts a tab into full WYSIWYG instead. Mirrors `richForced` (heavy-doc opt-in).
  const [milkdownForced, setMilkdownForced] = useState(() => new Set())
  // First-run only: a one-time bubble over the status-bar mode button explaining
  // Keep vs Milkdown. Set when the welcome doc opens; dismissed (and remembered)
  // on "Got it" or the first mode switch. Existing users never trigger it.
  const [showModeHint, setShowModeHint] = useState(false)
  const dismissModeHint = useCallback(() => {
    setShowModeHint(false)
    try {
      localStorage.setItem(MODEHINT_KEY, '1')
    } catch {
      /* ignore */
    }
  }, [])

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) || null, [tabs, activeId])
  const activePath = activeTab?.path || null
  // Native (OS-separator) paths of every open tab — used by the sidebar to expand
  // the tree to each open file (must match the tree's `node.path` format).
  // Keyed on the joined path list (not `tabs`) so the array identity stays stable
  // while typing — a content edit doesn't change any path, so the memoized Sidebar
  // skips re-rendering. Only opening/closing/renaming a tab moves this.
  const openPathsKey = tabs.map((t) => t.path || '').join('\n')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const openTabPathsRaw = useMemo(() => tabs.map((t) => t.path).filter(Boolean), [openPathsKey])
  // Same paths normalized to forward slashes — the sidebar marks these rows with a
  // dot. Normalized so Windows backslashes don't break the comparison.
  const openTabPaths = useMemo(
    () => new Set(openTabPathsRaw.map((p) => p.replace(/\\/g, '/'))),
    [openTabPathsRaw]
  )
  // Split is "live" only when the right-pane tab exists and differs from the
  // active (left) one. Hidden on the welcome/home screen.
  const splitTab = useMemo(
    () => (splitId != null ? tabs.find((t) => t.id === splitId) || null : null),
    [tabs, splitId]
  )
  const split = !home && !!splitTab && splitId !== activeId
  // Always-current activeId for callbacks that fire after a tab switch.
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  // Always-current snapshot of tabs for use inside async callbacks / event
  // handlers that must not capture a stale `tabs` closure.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  // Drop editor APIs for tabs that have closed.
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id))
    for (const id of Object.keys(editorApis.current)) {
      if (!live.has(id)) delete editorApis.current[id]
    }
    // Forget mount records for closed tabs (so the Set doesn't grow unbounded).
    setMountedIds((prev) => {
      let changed = false
      const next = new Set()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
    setRichForced((prev) => {
      if (!prev.size) return prev
      let changed = false
      const next = new Set()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
    setMilkdownForced((prev) => {
      if (!prev.size) return prev
      let changed = false
      const next = new Set()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [tabs])

  // Mark the active tab as mounted (and keep it mounted thereafter).
  useEffect(() => {
    if (activeId == null) return
    setMountedIds((prev) => (prev.has(activeId) ? prev : new Set(prev).add(activeId)))
  }, [activeId])

  // The right-pane tab must be mounted too (it's a second visible editor).
  useEffect(() => {
    if (splitId == null) return
    setMountedIds((prev) => (prev.has(splitId) ? prev : new Set(prev).add(splitId)))
  }, [splitId])

  // Drop the split when its tab is gone, or it collapsed onto the active tab
  // (e.g. the user clicked the right-pane's tab in the strip).
  useEffect(() => {
    if (splitId != null && (splitId === activeId || !tabs.some((t) => t.id === splitId))) {
      setSplitId(null)
    }
  }, [tabs, splitId, activeId])

  // Once there's no right pane, tab clicks must target the left pane again.
  useEffect(() => {
    if (splitId == null && focusedPane !== 'left') setFocusedPane('left')
  }, [splitId, focusedPane])

  // ----------------------------- theme / i18n -----------------------------
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // ----------------------------- settings ---------------------------------
  // Apply the editor page width live, and persist any settings change.
  useEffect(() => {
    applyPageWidth(settings.pageWidth)
  }, [settings.pageWidth])
  useEffect(() => {
    applyFontSize(settings.fontSize)
  }, [settings.fontSize])
  useEffect(() => {
    applyZoom(settings.zoom)
  }, [settings.zoom])
  useEffect(() => {
    applyLineHeight(settings.lineHeight)
  }, [settings.lineHeight])
  useEffect(() => {
    applyParagraphSpacing(settings.paragraphSpacing)
  }, [settings.paragraphSpacing])
  useEffect(() => {
    saveSettings(settings)
  }, [settings])
  // Merge a partial settings change (from the Settings modal).
  const updateSettings = useCallback((partial) => {
    setSettings((prev) => ({ ...prev, ...partial }))
  }, [])
  // Step the overall zoom by a delta, clamped/snapped. Functional update so the
  // keyboard/wheel handlers (mounted once) always read the latest zoom.
  const bumpZoom = useCallback((delta) => {
    setSettings((prev) => ({ ...prev, zoom: normalizeZoom((prev.zoom ?? DEFAULT_ZOOM) + delta) }))
  }, [])

  // Ctrl/Cmd + mouse wheel over the editor → zoom (Excel/browser convention).
  // The +/-/0 keys are the View-menu accelerators (handled via onMenu), so only
  // the wheel needs wiring here. Non-passive so we can cancel the native scroll.
  useEffect(() => {
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (!e.target.closest?.('.editor-area')) return
      e.preventDefault()
      bumpZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel, { passive: false })
  }, [bumpZoom])

  // ----------------------------- custom themes ----------------------------
  const refreshThemes = useCallback(() => {
    window.api.themesList?.().then(setCustomThemes).catch(() => {})
  }, [])
  useEffect(() => {
    refreshThemes()
  }, [refreshThemes])
  // Inject the selected custom theme's CSS (or clear it). If its file vanished,
  // fall back to no custom theme.
  useEffect(() => {
    if (!customTheme) {
      applyCustomTheme(null)
      return
    }
    let alive = true
    window.api
      .themeRead(customTheme)
      .then((css) => alive && applyCustomTheme(css))
      .catch(() => {
        if (!alive) return
        applyCustomTheme(null)
        setCustomTheme(null)
      })
    return () => {
      alive = false
    }
  }, [customTheme])
  // Picking a built-in theme clears any custom overlay; picking a custom one
  // keeps the built-in as the base (chrome + light/dark).
  const pickBuiltinTheme = useCallback((id) => {
    setTheme(id)
    setCustomTheme(null)
  }, [])

  const t = useCallback((key, vars) => translate(lang, key, vars), [lang])
  // Always-current translator for stable callbacks (e.g. openPaths) that must
  // not be recreated on every language change.
  const tRef = useRef(t)
  tRef.current = t
  const cycleTheme = useCallback(() => {
    setTheme((cur) => {
      const i = THEMES.findIndex((x) => x.id === cur)
      return THEMES[(i + 1) % THEMES.length].id
    })
    setCustomTheme(null)
  }, [])

  // Toggle source/rich mode while keeping the reading position. The two modes
  // use different DOM (a <textarea> vs. the Crepe editor) with different content
  // heights, so we preserve a *scroll ratio* (0…1) rather than a pixel offset:
  // capture it from the outgoing view here, restore it onto the incoming view in
  // the layout effect below once it has rendered.
  const toggleSource = useCallback(() => {
    const el = sourceModeRef.current ? sourceRef.current : editorHostRef.current
    if (el) {
      const denom = el.scrollHeight - el.clientHeight
      scrollRatioRef.current = denom > 0 ? el.scrollTop / denom : 0
    } else {
      scrollRatioRef.current = null
    }
    setSourceMode((v) => !v)
  }, [])

  // From keep mode's "open source here": force global source mode on and remember
  // the 0-based source line to select once the textarea mounts. We null the scroll
  // ratio so the scroll-restore effect yields to our line-positioning effect.
  const openSourceAtLine = useCallback((lineIdx) => {
    pendingSourceLineRef.current = Number.isFinite(lineIdx) ? lineIdx : 0
    scrollRatioRef.current = null
    setSourceMode(true)
  }, [])

  // Switch the active Markdown tab between keep mode (source-backed, default) and
  // the Milkdown WYSIWYG editor. Skips plain-text (`.txt`) tabs. A heavy doc CAN be
  // toggled — it just lands in the plain-source + "load rich" banner path instead of
  // a freeze-prone Crepe render (heavyAsSource in the editor routing).
  const toggleEditorMode = useCallback(() => {
    const id = activeIdRef.current
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab || isPlainTextDoc(tab)) return
    setMilkdownForced((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        // Milkdown → keep: Milkdown re-serializes the whole document, so its
        // content may differ byte-wise from the original. Going back to keep
        // adopts that reformatted text as the new source — warn if it's unsaved.
        if (tab.content !== tab.savedContent && !window.confirm(tRef.current('confirm.switchKeepUnsaved'))) {
          return prev
        }
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  useLayoutEffect(() => {
    const ratio = scrollRatioRef.current
    if (ratio == null) return
    scrollRatioRef.current = null
    const apply = () => {
      const el = sourceMode ? sourceRef.current : editorHostRef.current
      if (!el) return
      const denom = el.scrollHeight - el.clientHeight
      if (denom > 0) el.scrollTop = ratio * denom
    }
    // Apply immediately, then again as async layout settles — the rich editor
    // (Crepe) fills its content over a few frames after it remounts, growing
    // scrollHeight, so a single pass would land short.
    const raf = requestAnimationFrame(apply)
    const t1 = setTimeout(apply, 90)
    const t2 = setTimeout(apply, 220)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [sourceMode])

  // After "open source here" flips into source mode, select the target line and
  // center it. Retried as the textarea mounts/grows over a few frames.
  useEffect(() => {
    if (!sourceMode) return
    const line = pendingSourceLineRef.current
    if (line == null) return
    pendingSourceLineRef.current = null
    const apply = () => {
      const el = sourceRef.current
      if (!el) return
      const lines = el.value.split('\n')
      const ln = Math.min(Math.max(0, line), lines.length - 1)
      let off = 0
      for (let k = 0; k < ln; k++) off += lines[k].length + 1
      el.focus()
      el.setSelectionRange(off, off + (lines[ln] || '').length)
      const cs = getComputedStyle(el)
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20
      el.scrollTop = Math.max(0, ln * lh - el.clientHeight / 2)
    }
    const raf = requestAnimationFrame(apply)
    const t1 = setTimeout(apply, 90)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t1)
    }
  }, [sourceMode])

  // --------------------------- open files --------------------------
  const openPaths = useCallback(async (paths, silent = false) => {
    if (!paths || !paths.length) return
    let lastId = null
    const seen = new Set()
    const remember = (fp) => {
      const n = fp.replace(/\\/g, '/')
      setRecents((prev) =>
        [
          { path: fp, name: baseName(fp), dir: dirName(fp), openedAt: Date.now() },
          ...prev.filter((r) => (r.path || '').replace(/\\/g, '/') !== n)
        ].slice(0, 8)
      )
    }
    for (const path of paths) {
      const norm = path.replace(/\\/g, '/')
      if (seen.has(norm)) continue // dedupe within this call
      seen.add(norm)
      // Synchronous check against the live tab list (no setState race).
      const existing = tabsRef.current.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
      if (existing) {
        lastId = existing.id
        remember(path)
        continue
      }
      try {
        const { content, mtimeMs } = await window.api.readFile(path)
        // Re-check after the await in case a concurrent open added this path.
        const concurrent = tabsRef.current.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
        if (concurrent) {
          lastId = concurrent.id
          remember(path)
          continue
        }
        const id = genId()
        lastId = id
        const newTab = {
          id,
          path,
          title: baseName(path),
          content,
          savedContent: content,
          mtimeMs,
          reloadNonce: 0,
          heavy: isHeavyDoc(content)
        }
        tabsRef.current = [...tabsRef.current, newTab] // keep snapshot current for the next iteration
        setTabs((prev) => [...prev, newTab])
        remember(path)
      } catch (e) {
        // File was moved/deleted (e.g. a stale "recent" entry). Drop it from the
        // recents list so the dead link disappears, and show a friendly message
        // instead of the raw IPC error.
        const missing = e?.message?.includes('ENOENT')
        setRecents((prev) => prev.filter((r) => (r.path || '').replace(/\\/g, '/') !== norm))
        // Startup restore skips missing files quietly; an explicit open (clicking
        // a Recent, File > Open) still tells the user what happened.
        if (!silent) {
          window.alert(
            tRef.current(missing ? 'error.fileMissing' : 'error.openFailed', { name: baseName(path) })
          )
        }
      }
    }
    if (lastId) {
      setActiveId(lastId)
      setHome(false)
    }
  }, [])

  const newTab = useCallback(() => {
    const id = genId()
    setTabs((prev) => [
      ...prev,
      { id, path: null, title: t('tab.untitled'), content: '', savedContent: '', mtimeMs: null, reloadNonce: 0 }
    ])
    // New (untitled) markdown opens in Milkdown WYSIWYG; opened files default to
    // the source-backed keep editor. Keyed by tab id so it survives a later save
    // (path change) without flipping the editor mid-edit.
    setMilkdownForced((prev) => new Set(prev).add(id))
    setActiveId(id)
    setHome(false)
  }, [t])

  const updateContent = useCallback((id, md, isInitial) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t
        if (isInitial) {
          // Rebaseline a clean doc against Crepe's normalized output; keep the
          // existing baseline if the doc already had unsaved edits.
          if (t.content === t.savedContent) return { ...t, content: md, savedContent: md }
          return { ...t, content: md }
        }
        return { ...t, content: md }
      })
    )
  }, [])

  const closeTab = useCallback(
    (id) => {
      setTabs((prev) => {
        const tab = prev.find((x) => x.id === id)
        if (tab && tab.content !== tab.savedContent) {
          if (!window.confirm(tRef.current('confirm.closeUnsaved', { name: tab.title }))) return prev
        }
        const idx = prev.findIndex((x) => x.id === id)
        const next = prev.filter((x) => x.id !== id)
        setActiveId((cur) => {
          if (cur !== id) return cur
          if (next.length === 0) return null
          return next[Math.min(idx, next.length - 1)].id
        })
        return next
      })
    },
    []
  )

  // Show a tab in the right (split) pane. If it's currently the active tab, move
  // the left pane to a different tab so the two panes differ.
  const openRight = useCallback((id) => {
    setHome(false)
    if (id === activeIdRef.current) {
      const others = tabsRef.current.filter((t) => t.id !== id)
      if (!others.length) return // only one tab — nothing to split against
      setActiveId(others[others.length - 1].id)
    }
    setSplitId(id)
  }, [])

  // Toggle split: off → on picks the next tab as the right pane; on → off closes it.
  const toggleSplit = useCallback(() => {
    setSplitId((cur) => {
      if (cur != null) return null
      const list = tabsRef.current
      if (list.length < 2) {
        fireToast(tRef.current('split.needTwo'))
        return null
      }
      const i = list.findIndex((t) => t.id === activeIdRef.current)
      return list[(i + 1) % list.length].id
    })
    setHome(false)
  }, [])

  // Drag the divider on the sidebar's right edge to resize it. Width is measured
  // from the sidebar's own left so the activity bar offset doesn't matter.
  const startSidebarDrag = useCallback((e) => {
    e.preventDefault()
    const left = paneLeftRef.current?.getBoundingClientRect().left ?? 0
    const onMove = (ev) => {
      setSidebarWidth(Math.min(560, Math.max(180, Math.round(ev.clientX - left))))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('hm-col-resizing')
    }
    document.body.classList.add('hm-col-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Drag the divider between the two split panes to change their ratio.
  const startSplitDrag = useCallback((e) => {
    e.preventDefault()
    const area = editorAreaRef.current
    if (!area) return
    const rect = area.getBoundingClientRect()
    const onMove = (ev) => {
      const r = (ev.clientX - rect.left) / rect.width
      setSplitRatio(Math.min(0.8, Math.max(0.2, r)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('hm-col-resizing')
    }
    document.body.classList.add('hm-col-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Open a file (by path) directly into the right split pane — used by the
  // sidebar's "Open in Split" so it works even if the file isn't open yet.
  const openFileRight = useCallback(
    async (path) => {
      await openPaths([path])
      const norm = (path || '').replace(/\\/g, '/')
      const tab = tabsRef.current.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
      if (tab) openRight(tab.id)
    },
    [openPaths, openRight]
  )

  // --- File operations shared by the tab menu and the sidebar menu, so both
  //     right-click menus offer the same actions on a file. ---
  // Open the rename dialog for a tab's file (Electron has no window.prompt).
  const renameTabFile = useCallback((id) => {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab?.path) return
    setRenameState({ id, value: baseName(tab.path) })
  }, [])

  // Commit a tab-file rename from the dialog.
  const commitTabRename = useCallback(async (id, rawName) => {
    setRenameState(null)
    const tab = tabsRef.current.find((t) => t.id === id)
    const name = (rawName || '').trim()
    if (!tab?.path || !name) return
    if (name === baseName(tab.path)) return
    if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
      window.alert(tRef.current('err.invalidName') + name)
      return
    }
    const newPath = joinPath(dirName(tab.path), name)
    try {
      await window.api.rename(tab.path, newPath)
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, path: newPath, title: name } : t)))
      setRefreshNonce((n) => n + 1)
    } catch (e) {
      window.alert(
        /eexist|already exists/i.test(e.message)
          ? tRef.current('err.nameExists')
          : tRef.current('err.rename') + e.message
      )
    }
  }, [])

  const duplicateTabFile = useCallback(async (id) => {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab?.path) return
    try {
      await window.api.duplicate(tab.path)
      setRefreshNonce((n) => n + 1)
    } catch (e) {
      window.alert(
        /eexist|already exists/i.test(e.message)
          ? tRef.current('err.nameExists')
          : tRef.current('err.duplicate') + e.message
      )
    }
  }, [])

  const deleteTabFile = useCallback(async (id) => {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab?.path) return
    if (!window.confirm(tRef.current('confirm.trash', { name: tab.title }))) return
    try {
      await window.api.deleteItem(tab.path)
      // Remove the tab outright (the file is gone; don't re-prompt about unsaved edits).
      setTabs((prev) => {
        const idx = prev.findIndex((x) => x.id === id)
        const next = prev.filter((x) => x.id !== id)
        setActiveId((cur) => (cur !== id ? cur : next.length ? next[Math.min(idx, next.length - 1)].id : null))
        return next
      })
      setRefreshNonce((n) => n + 1)
    } catch (e) {
      window.alert(tRef.current('err.delete') + e.message)
    }
  }, [])

  // Close every tab except `keepId` (from the tab right-click menu).
  const closeOthers = useCallback((keepId) => {
    setTabs((prev) => {
      const others = prev.filter((t) => t.id !== keepId)
      const firstDirty = others.find((t) => t.content !== t.savedContent)
      if (firstDirty && !window.confirm(tRef.current('confirm.closeUnsaved', { name: firstDirty.title }))) {
        return prev
      }
      setActiveId(keepId)
      setSplitId(null)
      return prev.filter((t) => t.id === keepId)
    })
  }, [])

  // Close every tab on one side of `pivotId` (from the tab right-click menu).
  // `side` is 'left' (lower indexes) or 'right' (higher indexes).
  const closeSide = useCallback((pivotId, side) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === pivotId)
      if (idx === -1) return prev
      const toClose = side === 'left' ? prev.slice(0, idx) : prev.slice(idx + 1)
      if (!toClose.length) return prev
      const firstDirty = toClose.find((t) => t.content !== t.savedContent)
      if (firstDirty && !window.confirm(tRef.current('confirm.closeUnsaved', { name: firstDirty.title }))) {
        return prev
      }
      const next = side === 'left' ? prev.slice(idx) : prev.slice(0, idx + 1)
      const survives = (id) => id != null && next.some((t) => t.id === id)
      setActiveId((cur) => (survives(cur) ? cur : pivotId))
      setSplitId((cur) => (survives(cur) ? cur : null))
      return next
    })
  }, [])

  const writeTab = useCallback(async (tab, targetPath) => {
    try {
      // Move pasted images (base64 blobs / global paste-folder files) into the
      // doc's ./assets and rewrite links to relative paths, so the saved file is
      // clean and portable (Typora-style). No-op when there are none / on mobile.
      const { content: written, changed } = window.api.inlineForSave
        ? await window.api.inlineForSave(tab.content, targetPath)
        : { content: tab.content, changed: false }
      const { mtimeMs } = await window.api.writeFile(targetPath, written)
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tab.id
            ? changed
              ? // Images were moved to assets/: adopt the rewritten content and
                // remount the editor so it shows the relative-path images.
                {
                  ...t,
                  path: targetPath,
                  title: baseName(targetPath),
                  content: written,
                  savedContent: written,
                  mtimeMs,
                  reloadNonce: t.reloadNonce + 1
                }
              : { ...t, path: targetPath, title: baseName(targetPath), savedContent: t.content, mtimeMs }
            : t
        )
      )
      setRefreshNonce((n) => n + 1)
      // On mobile, where files land in a system folder, confirm what + where —
      // sticky so the user can read the location before dismissing it.
      if (isMobile) {
        const loc =
          window.api.platform === 'ios' ? tRef.current('save.locIos') : tRef.current('save.locAndroid')
        fireToast(tRef.current('save.savedTo', { name: baseName(targetPath), loc }), {
          sticky: true,
          duration: 5000
        })
      }
    } catch (e) {
      // Never fail silently — surface the real error so saving is debuggable.
      fireToast(tRef.current('save.failed', { msg: e?.message || String(e) }), { sticky: true })
    }
  }, [isMobile])

  const saveTab = useCallback(
    async (id, forceDialog = false) => {
      const tab = tabs.find((t) => t.id === id)
      if (!tab) return
      let target = tab.path
      if (!target || forceDialog) {
        // Mobile has no native save dialog: ask for a filename, then write into
        // the local library (see commitMobileSave). Desktop keeps the dialog.
        if (isMobile) {
          const base = (tab.title || 'Untitled').replace(/\.(md|markdown|mdx)$/i, '')
          setSaveNameState({ id, value: base + '.md' })
          return
        }
        target = await window.api.saveAs(tab.title.endsWith('.md') ? tab.title : tab.title + '.md')
        if (!target) return
      }
      await writeTab(tab, target)
    },
    [tabs, writeTab, isMobile]
  )

  // Commit a mobile "save as": let the platform layer place the named file in
  // the local library (it returns a de-duplicated path), then write it.
  const commitMobileSave = useCallback(
    async (id, rawName) => {
      setSaveNameState(null)
      const tab = tabsRef.current.find((t) => t.id === id)
      let name = (rawName || '').trim()
      if (!tab || !name) return
      if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
        window.alert(tRef.current('err.invalidName') + name)
        return
      }
      if (!/\.(md|markdown|mdx)$/i.test(name)) name += '.md'
      const target = await window.api.saveAs(name)
      if (!target) return
      await writeTab(tab, target)
    },
    [writeTab]
  )

  // Export a file (by path) to PDF: open/focus it, wait for its editor to mount,
  // then reuse the same HTML→PDF pipeline as the menu command. Driven from the
  // sidebar's right-click menu, where the file may not be open yet.
  const exportPathToPdf = useCallback(
    async (path) => {
      await openPaths([path])
      const norm = (path || '').replace(/\\/g, '/')
      const tab = tabsRef.current.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
      if (!tab) return
      let html = null
      for (let i = 0; i < 40 && !html; i++) {
        html = editorApis.current[tab.id]?.getDocHTML?.()
        if (!html) await new Promise((r) => setTimeout(r, 75))
      }
      if (!html) {
        window.alert(tRef.current('error.exportPdfUnavailable'))
        return
      }
      const base = (tab.title || 'Untitled').replace(/\.(md|markdown|mdx|txt)$/i, '')
      await window.api.exportPDF(html, base + '.pdf')
    },
    [openPaths]
  )

  // --------------------------- workspace ---------------------------
  // Add a folder as a new root (deduped by path). Multiple roots coexist in the
  // sidebar, each its own tree — opening another project never closes the others.
  const addWorkspace = useCallback((dir) => {
    if (!dir || !isAbsolutePath(dir)) return
    setWorkspaces((ws) =>
      ws.some((w) => w.rootPath === dir) ? ws : [...ws, { rootPath: dir, rootName: baseName(dir) }]
    )
    setSidebarMode('files')
    setSidebarOpen(true)
  }, [])

  const removeWorkspace = useCallback((rootPath) => {
    setWorkspaces((ws) => ws.filter((w) => w.rootPath !== rootPath))
  }, [])

  // Reorder roots by dragging their headers: move `fromPath` to just before/after
  // `toPath`. Index is recomputed after the removal so the math stays correct.
  const reorderWorkspaces = useCallback((fromPath, toPath, pos) => {
    if (!fromPath || !toPath || fromPath === toPath) return
    setWorkspaces((ws) => {
      const from = ws.findIndex((w) => w.rootPath === fromPath)
      if (from < 0 || !ws.some((w) => w.rootPath === toPath)) return ws
      const next = ws.slice()
      const [moved] = next.splice(from, 1)
      let insert = next.findIndex((w) => w.rootPath === toPath)
      if (pos === 'after') insert += 1
      next.splice(insert, 0, moved)
      return next
    })
  }, [])

  const openFolder = useCallback(async () => {
    const dir = await window.api.openFolder()
    if (!dir) return
    addWorkspace(dir)
  }, [addWorkspace])

  // Stable handler for the memoized Sidebar (an inline arrow would defeat memo).
  const onSidebarOpenFile = useCallback(
    (p) => { openPaths([p]); if (isMobile) setSidebarOpen(false) },
    [openPaths, isMobile]
  )

  // A stable key for the set of roots, so the watch/list effects only re-run when
  // the roots actually change (not on every array-identity churn).
  const rootsKey = workspaces.map((w) => w.rootPath).join('\n')

  // The cross-root file index (for the command palette's quick-open) is built
  // LAZILY — recursively scanning two whole trees at launch stalled startup. We
  // build it the first time the palette opens, then keep it fresh on changes.
  const filesBuiltRef = useRef(false)
  const relistTimerRef = useRef(null)
  const relistFiles = useCallback(() => {
    const roots = workspaces.map((w) => w.rootPath)
    filesBuiltRef.current = true
    if (!roots.length) {
      setFiles([])
      return
    }
    Promise.all(roots.map((r) => window.api.listFiles(r).catch(() => [])))
      .then((arrs) => setFiles(arrs.flat()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey])

  // Build the index on first palette open; rebuild on root-set change if already
  // built (so a newly added folder shows up in quick-open).
  useEffect(() => {
    if (paletteOpen && !filesBuiltRef.current) relistFiles()
  }, [paletteOpen, relistFiles])
  useEffect(() => {
    if (filesBuiltRef.current) relistFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey])

  // Watch every root. chokidar's initial recursive crawl is heavy, so we DEFER it
  // past first paint and stagger the roots — starting all watchers at once on
  // launch saturated the main process and made the UI stutter for a while.
  useEffect(() => {
    const roots = workspaces.map((w) => w.rootPath)
    let cancelled = false
    const started = []
    const schedule = (fn) =>
      window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 600 }) : setTimeout(fn, 80)
    const startNext = (i) => {
      if (cancelled || i >= roots.length) return
      window.api.watchStart(roots[i])
      started.push(roots[i])
      schedule(() => startNext(i + 1))
    }
    schedule(() => startNext(0))
    return () => {
      cancelled = true
      started.forEach((r) => window.api.watchStop(r))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey])

  useEffect(() => {
    const off = window.api.onWatchChanged(() => {
      setRefreshNonce((n) => n + 1) // cheap: Sidebar only reloads already-open dirs
      // Refresh the quick-open index only if it's been built, and debounce so a
      // burst of fs events triggers one rescan, not one per event.
      if (filesBuiltRef.current) {
        clearTimeout(relistTimerRef.current)
        relistTimerRef.current = setTimeout(relistFiles, 400)
      }
    })
    return off
  }, [relistFiles])

  // --------- auto-reload open files edited by external programs ----------
  const watchedRef = useRef(new Set())

  // Keep a per-file watcher in sync with the set of open file paths.
  useEffect(() => {
    const want = new Set(tabs.map((t) => t.path).filter(Boolean))
    for (const p of want) if (!watchedRef.current.has(p)) window.api.watchFile(p)
    for (const p of watchedRef.current) if (!want.has(p)) window.api.unwatchFile(p)
    watchedRef.current = want
  }, [tabs])

  const reloadTabFromDisk = useCallback(async (id, path) => {
    try {
      const { content, mtimeMs } = await window.api.readFile(path)
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t
          // Bail if the user has started editing since the change fired —
          // never clobber unsaved work.
          if (t.content !== t.savedContent) return t
          if (t.content === content) return { ...t, mtimeMs }
          return {
            ...t,
            content,
            savedContent: content,
            mtimeMs,
            reloadNonce: t.reloadNonce + 1,
            heavy: isHeavyDoc(content)
          }
        })
      )
    } catch {
      /* file vanished mid-reload; leave the tab as-is */
    }
  }, [])

  useEffect(() => {
    const off = window.api.onFileChanged(({ path, mtimeMs }) => {
      const norm = (path || '').replace(/\\/g, '/')
      const tab = tabsRef.current.find((t) => (t.path || '').replace(/\\/g, '/') === norm)
      if (!tab) return
      // Ignore the echo from our own save (same or older mtime).
      if (tab.mtimeMs && mtimeMs && mtimeMs <= tab.mtimeMs) return
      // Don't overwrite unsaved local edits.
      if (tab.content !== tab.savedContent) return
      reloadTabFromDisk(tab.id, tab.path)
    })
    return off
  }, [reloadTabFromDisk])

  // --------------------------- outline jump ------------------------
  const jumpToHeading = useCallback((index) => {
    // Make sure the document (not the Home page) is showing — otherwise the
    // active editor is hidden and editorHostRef isn't attached, so the jump
    // would silently do nothing. setHome(false) is a no-op when already not home.
    setHome(false)
    // On mobile the outline lives in the drawer; close it so the jumped-to
    // content is actually visible instead of hidden behind the drawer.
    if (isMobile) setSidebarOpen(false)
    const doJump = () => {
      const host = editorHostRef.current
      let hs = host
        ? host.querySelectorAll(
            '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'
          )
        : null
      // Keep mode: no ProseMirror — jump within the visible rendered `.km-doc`.
      if (!hs || !hs.length) {
        const kms = editorAreaRef.current?.querySelectorAll('.km-doc') || []
        let km = null
        kms.forEach((k) => {
          if (!km && k.offsetParent !== null) km = k
        })
        hs = km ? km.querySelectorAll('h1, h2, h3, h4, h5, h6') : []
      }
      const el = hs[index]
      if (!el) return false
      // Keep mode: the target heading may be folded inside a collapsed section
      // (display:none → not scrollable). Ask the keep editors to expand its
      // ancestors first, then scroll.
      if (el.offsetParent === null)
        Object.values(editorApis.current).forEach((api) => api?.revealHeading?.(el))
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return true
    }
    // Works synchronously in the normal case; if we just left Home, the editor
    // needs a frame to re-render and re-attach the ref before we can scroll it.
    if (doJump()) return
    requestAnimationFrame(() => {
      if (!doJump()) requestAnimationFrame(doJump)
    })
  }, [])

  // Outline scrollspy: highlight the heading you're currently viewing (the last
  // one scrolled past the top), mirroring how the file tree marks the open file.
  // Rich editor only — editorHostRef is the active pane's .editor-scroll; in
  // source mode it isn't attached, so the outline shows no active item there.
  // On large docs the per-scroll querySelectorAll + getBoundingClientRect chain
  // is a forced reflow that freezes the main thread → scroll "chase" (#17).
  // Throttle to at most once per 300ms (not per frame) and skip entirely while
  // the user is actively scrolling fast (resume on settle).
  const [activeHeading, setActiveHeading] = useState(-1)
  useEffect(() => {
    if (home || !sidebarOpen || sidebarMode !== 'outline' || sourceMode) {
      setActiveHeading(-1)
      return
    }
    const scroller = editorHostRef.current
    if (!scroller) return

    // Reflow-free scrollspy. The previous version re-queried and called
    // getBoundingClientRect() on EVERY heading on every throttle tick. On a
    // large doc each call forces a full-document layout recalc, which
    // (a) froze the main thread during scroll (#17 "chase" lag) and (b) used a
    // leading-edge-only throttle with no trailing update — so when scrolling
    // stopped the last compute was up to 300ms stale and the outline landed on
    // the WRONG heading. Fix: measure each heading's content-offset ONCE (a
    // single layout pass, rebuilt every 2s / on resize), then compare against
    // the cheap scrollTop on scroll. No layout read per frame, so it can update
    // every frame and always reflects the exact current position.
    let tops = null // heading content-offsets (px from content top); stable across scroll
    let builtAt = 0
    let raf = 0
    let lastIdx = -1
    let tries = 0

    const build = () => {
      const els = scroller.querySelectorAll(
        '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6'
      )
      if (!els.length) {
        tops = null
        return
      }
      // Read every rect in one synchronous block = ONE reflow, not N. Convert
      // each to a content-offset (Y = rect.top − scroller.top + scrollTop); Y is
      // invariant under scrolling, so the cache stays valid while scrolling.
      const base = scroller.getBoundingClientRect().top
      const top0 = scroller.scrollTop
      tops = new Array(els.length)
      for (let i = 0; i < els.length; i++) tops[i] = els[i].getBoundingClientRect().top - base + top0
      builtAt = Date.now()
    }
    const compute = () => {
      raf = 0
      const now = Date.now()
      if (!tops || now - builtAt > 2000) {
        build()
        if (!tops) {
          // Editor still mounting (no headings yet) — retry briefly.
          if (tries++ < 30) raf = requestAnimationFrame(compute)
          return
        }
        tries = 0
      }
      // scrollTop is a cheap scroll-offset read — no layout, no reflow — so this
      // can run every frame without freezing and lands on the exact heading.
      const limit = scroller.scrollTop + 90
      let idx = 0
      for (let i = 0; i < tops.length; i++) {
        if (tops[i] <= limit) idx = i
        else break
      }
      if (idx !== lastIdx) {
        lastIdx = idx
        setActiveHeading(idx) // only re-render the outline when the active row actually changes
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute) // coalesce to ≤ once per frame
    }
    compute()
    scroller.addEventListener('scroll', schedule, { passive: true })
    // Resize (and the layout-settings popover) reflow heading offsets → rebuild.
    const invalidate = () => {
      tops = null
      schedule()
    }
    window.addEventListener('resize', invalidate, { passive: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', invalidate)
    }
  }, [home, sidebarOpen, sidebarMode, sourceMode, activeId])

  // ------------------------- menu / shortcuts ----------------------
  // In split view, target the pane you're actually editing (last focused), as
  // long as it's one of the two visible panes; otherwise the active (left) tab.
  const pickEditableId = () => {
    const f = focusedTabRef.current
    if (f && (f === activeId || f === splitId)) return f
    return activeId
  }

  const handlers = useRef({})
  handlers.current = {
    home: () => {
      setHome(true)
      if (isMobile) setSidebarOpen(false) // jump straight to Home, don't leave the drawer over it
    },
    new: newTab,
    open: async () => openPaths(await window.api.openFiles()),
    openFolder,
    save: () => {
      const id = pickEditableId()
      if (id) saveTab(id)
    },
    saveAs: () => {
      const id = pickEditableId()
      if (id) saveTab(id, true)
    },
    exportPdf: async () => {
      const id = pickEditableId()
      const html = editorApis.current[id]?.getDocHTML?.()
      if (!html) {
        window.alert(tRef.current('error.exportPdfUnavailable'))
        return
      }
      const tab = tabs.find((x) => x.id === id)
      const base = (tab?.title || 'Untitled').replace(/\.(md|markdown|mdx|txt)$/i, '')
      await window.api.exportPDF(html, base + '.pdf')
    },
    closeTab: () => activeId && closeTab(activeId),
    palette: () => setPaletteOpen((v) => !v),
    toggleSidebar: () => setSidebarOpen((v) => !v),
    toggleOutline: () => {
      setSidebarMode('outline')
      setSidebarOpen(true)
    },
    toggleFiles: () => {
      setSidebarMode('files')
      setSidebarOpen(true)
    },
    toggleSource,
    toggleEditorMode,
    toggleTheme: cycleTheme,
    // Overall editor zoom — also the View menu's zoom items (repurposed from
    // Electron's whole-window webFrame zoom to this content-only zoom).
    zoomIn: () => bumpZoom(ZOOM_STEP),
    zoomOut: () => bumpZoom(-ZOOM_STEP),
    zoomReset: () => setSettings((prev) => ({ ...prev, zoom: DEFAULT_ZOOM })),
    find: () => {
      // Leave the Home page so find acts on the visible document, not a hidden one.
      setHome(false)
      setFind((f) => ({ ...f, open: true }))
      setTimeout(() => findInputRef.current?.focus(), 0)
    }
  }

  useEffect(() => {
    const offMenu = window.api.onMenu((cmd) => handlers.current[cmd]?.())
    const offOpen = window.api.onOpenPaths((paths) => openPaths(paths))
    // A folder path arriving from Explorer's "Open with EasyMarkdown" folder menu.
    const offFolder = window.api.onOpenFolderPath?.((dir) => {
      // never open a relative path as a workspace; add as a new root (kept alongside any existing ones)
      addWorkspace(dir)
    })
    const onOpenFolderEvt = () => openFolder()
    window.addEventListener('mm:openFolder', onOpenFolderEvt)
    // Main asks before the window closes so we can warn about unsaved changes.
    const offClose = window.api.onAppCloseRequest?.(() => {
      // Flush the latest session before we (maybe) quit, so a recent edit that's
      // still inside the debounce window isn't lost.
      flushSession()
      const dirty = tabsRef.current.some((t) => t.content !== t.savedContent)
      if (!dirty || window.confirm(tRef.current('confirm.quitUnsaved'))) {
        window.api.confirmAppClose()
      } else {
        window.api.cancelAppClose?.()
      }
    })
    return () => {
      offMenu()
      offOpen()
      offFolder?.()
      offClose?.()
      window.removeEventListener('mm:openFolder', onOpenFolderEvt)
    }
  }, [openPaths, openFolder, addWorkspace])

  // --- Drop OS files/folders onto the window to open them ---
  // A markdown (or any) file dragged from the Finder/Explorer onto the app
  // opens as a tab; a dropped folder opens as the workspace. Handlers run in
  // the CAPTURE phase so we beat ProseMirror's own drop handling, and we always
  // preventDefault on a file drop — otherwise Electron navigates the window to
  // file://… and the whole app is replaced. Image files dropped into the
  // writing area are left to the editor's own insert handling (Editor.jsx).
  useEffect(() => {
    const isFileDrag = (e) => e.dataTransfer?.types?.includes('Files')
    const onDragOver = (e) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e) => {
      const dt = e.dataTransfer
      if (!isFileDrag(e)) return
      e.preventDefault() // block the navigate-to-file default, always
      const inEditor = e.target.closest?.('.milkdown, .ProseMirror, .cm-editor, textarea')
      // webkitGetAsEntry() must be read synchronously, before any await, while
      // the DataTransfer is still live.
      const items = [...(dt.items || [])]
      const dirs = []
      const files = []
      ;[...(dt.files || [])].forEach((f, i) => {
        if (items[i]?.webkitGetAsEntry?.()?.isDirectory) dirs.push(f)
        else files.push(f)
      })
      // Images dropped onto the writing area belong to the editor — skip them.
      const docFiles = files.filter((f) => !(inEditor && f.type.startsWith('image/')))
      if (!dirs.length && !docFiles.length) return
      e.stopPropagation()
      // Each dropped folder is added as a new root, alongside any already open.
      dirs.forEach((d) => addWorkspace(window.api.pathForFile(d)))
      const paths = docFiles.map((f) => window.api.pathForFile(f)).filter(Boolean)
      if (paths.length) openPaths(paths)
    }
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [openPaths, addWorkspace])

  // Ctrl+Tab cycling + restore session tabs on first mount
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        setTabs((prev) => {
          if (prev.length < 2) return prev
          const i = prev.findIndex((t) => t.id === activeId)
          const ni = (i + (e.shiftKey ? -1 : 1) + prev.length) % prev.length
          setActiveId(prev[ni].id)
          setHome(false)
          return prev
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId])

  // Ctrl/Cmd+B toggles the sidebar. Handled here in the CAPTURE phase so it
  // fires before the editor's "bold" keybinding (which would otherwise eat it
  // and made the shortcut feel unreliable). No menu accelerator, so it can't
  // double-fire either.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyB') {
        e.preventDefault()
        e.stopPropagation()
        handlers.current.toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    const paths = (session.openPaths || []).filter(Boolean)
    const untitled = (session.untitled || []).filter((u) => u && (u.content || '').trim())
    // Recreate unsaved scratch tabs (no path) from the last session.
    const addUntitled = () => {
      if (!untitled.length) return null
      const created = untitled.map((u) => ({
        id: genId(),
        path: null,
        title: u.title || tRef.current('tab.untitled'),
        content: u.content,
        // No prior save, so the baseline is empty → the tab shows as unsaved.
        savedContent: '',
        mtimeMs: null,
        reloadNonce: 0,
        heavy: isHeavyDoc(u.content)
      }))
      tabsRef.current = [...tabsRef.current, ...created]
      setTabs((prev) => [...prev, ...created])
      // Restored scratch docs are new (unsaved) markdown → Milkdown WYSIWYG.
      setMilkdownForced((prev) => {
        const next = new Set(prev)
        created.forEach((c) => next.add(c.id))
        return next
      })
      return created
    }
    // Restore silently: skip files that were deleted/moved since last session
    // without popping an error for each one.
    if (paths.length) {
      openPaths(paths, true).then(() => {
        addUntitled()
        if (session.activePath) {
          setTabs((prev) => {
            const t = prev.find((x) => x.path === session.activePath)
            if (t) setActiveId(t.id)
            return prev
          })
        }
      })
    } else {
      const created = addUntitled()
      if (created && created.length) setActiveId(created[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --------------------------- persistence -------------------------
  useEffect(() => {
    const data = {
      workspaces,
      // Keep the legacy single field as the first root, so downgrading to an older
      // build still opens (at least) one of the folders instead of nothing.
      workspace: workspaces[0] || null,
      theme,
      customTheme,
      lang,
      recents,
      sidebarOpen,
      sidebarMode,
      sidebarWidth,
      openPaths: tabs.map((t) => t.path).filter(Boolean),
      // Persist unsaved scratch/new tabs (no path, with edited content) so they
      // survive a restart — closing the app no longer silently loses them. Only
      // dirty tabs are stored, so the untouched welcome doc / empty new tabs
      // don't keep coming back. Saved files are reopened from disk instead.
      untitled: tabs
        .filter((t) => !t.path && t.content !== t.savedContent && (t.content || '').trim())
        .map((t) => ({ title: t.title, content: t.content })),
      activePath
    }
    sessionRef.current = data
    // Debounce the write: this effect runs on every keystroke (tabs/content
    // change), and JSON.stringify-ing the whole session — including the full
    // text of large unsaved scratch docs — plus a synchronous localStorage write
    // on every keypress is enough to make typing in big documents stutter. Wait
    // for a brief pause, then write once. The close path flushes the last edit.
    const id = setTimeout(flushSession, 400)
    return () => clearTimeout(id)
  }, [workspaces, theme, customTheme, lang, recents, sidebarOpen, sidebarMode, sidebarWidth, tabs, activePath, flushSession])

  // Flush the pending session snapshot immediately when the window is closing,
  // so the debounce above never drops the user's last few keystrokes.
  useEffect(() => {
    window.addEventListener('pagehide', flushSession)
    window.addEventListener('beforeunload', flushSession)
    return () => {
      window.removeEventListener('pagehide', flushSession)
      window.removeEventListener('beforeunload', flushSession)
    }
  }, [flushSession])

  // ------------------------- update check (notify-only) ------------
  useEffect(() => {
    let alive = true
    window.api.checkUpdate?.().then((r) => {
      if (!alive || !r?.ok || !r.latest) return
      const dismissed = localStorage.getItem(UPDATE_DISMISS_KEY)
      if (isNewerVersion(r.latest, r.current) && r.latest !== dismissed) {
        setUpdate({ latest: r.latest, current: r.current, url: r.url, notes: r.notes, name: r.name })
      }
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Lightweight transient toast (copy feedback, etc.). Any component can fire one
  // via `fireToast(msg)` from ui.js.
  useEffect(() => {
    let timer = null
    const onToast = (e) => {
      const d = e?.detail
      const msg = typeof d === 'string' ? d : d?.msg
      const sticky = typeof d === 'object' && !!d?.sticky
      const duration = typeof d === 'object' ? d?.duration : undefined
      if (!msg) return
      setToast({ msg, key: Date.now() + Math.random(), sticky })
      clearTimeout(timer)
      // duration wins; otherwise sticky stays until ✕, plain toasts hide quickly.
      const ms = duration || (sticky ? 0 : 1600)
      if (ms) timer = setTimeout(() => setToast(null), ms)
    }
    window.addEventListener(HM_TOAST_EVENT, onToast)
    return () => {
      window.removeEventListener(HM_TOAST_EVENT, onToast)
      clearTimeout(timer)
    }
  }, [])

  const dismissUpdate = useCallback(() => {
    setUpdate((u) => {
      if (u) localStorage.setItem(UPDATE_DISMISS_KEY, u.latest)
      return null
    })
  }, [])

  // ------------------------- first-run onboarding ------------------
  useEffect(() => {
    if (localStorage.getItem(ONBOARDED_KEY)) return
    localStorage.setItem(ONBOARDED_KEY, '1')
    // Only greet on a genuinely fresh start (no restored session — neither saved
    // files nor unsaved scratch tabs).
    if ((session.openPaths || []).filter(Boolean).length || (session.untitled || []).length) return
    const doc = welcomeDoc(session.lang || DEFAULT_LANG)
    const id = genId()
    setTabs((prev) => [
      ...prev,
      { id, path: null, title: doc.title, content: doc.content, savedContent: doc.content, mtimeMs: null, reloadNonce: 0 }
    ])
    // The welcome doc showcases the editor → render it in Milkdown WYSIWYG.
    setMilkdownForced((prev) => new Set(prev).add(id))
    setActiveId(id)
    // First run → point at the mode button and explain the two modes, once.
    if (!localStorage.getItem(MODEHINT_KEY)) setShowModeHint(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --------------------------- commands ----------------------------
  const commands = useMemo(
    () => {
      const caps = window.api.capabilities || {}
      return [
        { id: 'cmd.new', title: t('cmd.new'), icon: 'file-plus', run: () => handlers.current.new() },
        { id: 'cmd.open', title: t('cmd.open'), icon: 'file', run: () => handlers.current.open() },
        { id: 'cmd.openFolder', title: t('cmd.openFolder'), icon: 'folder', run: () => handlers.current.openFolder() },
        { id: 'cmd.save', title: t('cmd.save'), icon: 'save', run: () => handlers.current.save() },
        { id: 'cmd.saveAs', title: t('cmd.saveAs'), icon: 'save', run: () => handlers.current.saveAs() },
        // Export-to-PDF needs a save dialog / print pipeline that doesn't exist on mobile.
        caps.pdfExport && { id: 'cmd.exportPdf', title: t('cmd.exportPdf'), icon: 'file', run: () => handlers.current.exportPdf() },
        { id: 'cmd.sidebar', title: t('cmd.sidebar'), icon: 'sidebar', run: () => handlers.current.toggleSidebar() },
        { id: 'cmd.files', title: t('cmd.files'), icon: 'folder', run: () => handlers.current.toggleFiles() },
        { id: 'cmd.outline', title: t('cmd.outline'), icon: 'outline', run: () => handlers.current.toggleOutline() },
        { id: 'cmd.source', title: t('cmd.source'), icon: 'code', run: () => handlers.current.toggleSource() },
        { id: 'cmd.toggleKeep', title: t('cmd.toggleKeep'), icon: 'shield', run: () => handlers.current.toggleEditorMode() },
        { id: 'cmd.theme', title: t('cmd.theme'), icon: 'moon', run: () => handlers.current.toggleTheme() },
        { id: 'cmd.find', title: t('cmd.find'), icon: 'search', run: () => handlers.current.find() }
      ].filter(Boolean)
    },
    [t]
  )

  // Discriminate the active view: the source <textarea> sets sourceRef only when
  // it's mounted (source mode or a .txt doc); otherwise we're in the rich editor.
  // Keep mode has no ProseMirror — fall back to the visible rendered `.km-doc`
  // so find still searches the document content there.
  const richRoot = () => {
    const pm = editorHostRef.current?.querySelector('.ProseMirror')
    if (pm) return pm
    const kms = editorAreaRef.current?.querySelectorAll('.km-doc') || []
    for (const km of kms) if (km.offsetParent !== null) return km // the on-screen one
    return null
  }
  const findQueryRef = useRef('')
  const activeIdxRef = useRef(-1)
  const findModeRef = useRef('text')
  const lineBiRef = useRef(-1) // last located block index (line mode)
  useEffect(() => { findModeRef.current = find.mode }, [find.mode])

  // Run a fresh search for `query`, scoped to the editor content.
  const runFind = useCallback((query) => {
    const q = query ?? ''
    findQueryRef.current = q
    clearFindHighlights()
    findRangesRef.current = []
    activeIdxRef.current = -1
    if (sourceRef.current) {
      // Source textarea: live-count only (selecting would steal the find input's
      // focus); Enter / next / prev jump to a match.
      const hits = matchIndices(sourceRef.current.value, q)
      findRangesRef.current = hits
      setFind((f) => ({ ...f, matches: hits.length, active: 0 }))
      return
    }
    const root = richRoot()
    const ranges = q ? findRangesInEl(root, q) : []
    findRangesRef.current = ranges
    if (ranges.length) {
      activeIdxRef.current = 0
      paintFindHighlights(ranges, 0)
      scrollRangeIntoView(ranges[0], root.closest('.editor-scroll'))
    }
    setFind((f) => ({ ...f, matches: ranges.length, active: ranges.length ? 1 : 0 }))
  }, [])

  // Live "highlight as you type" walks the whole editor DOM, so debounce it: clear
  // instantly on empty (feels responsive), otherwise coalesce keystrokes. Enter /
  // next / prev still call runFind/stepFind directly for an immediate jump.
  const findDebounceRef = useRef(0)
  const runFindDebounced = useCallback((q) => {
    clearTimeout(findDebounceRef.current)
    if (!q) { runFind(''); return }
    findDebounceRef.current = setTimeout(() => runFind(q), 160)
  }, [runFind])

  // Move to the next / previous match (wrapping around).
  const stepFind = useCallback((backwards = false) => {
    const items = findRangesRef.current
    if (!items.length) return
    let i = activeIdxRef.current + (backwards ? -1 : 1)
    if (i < 0) i = items.length - 1
    if (i >= items.length) i = 0
    activeIdxRef.current = i
    if (sourceRef.current) {
      const el = sourceRef.current
      el.focus()
      el.setSelectionRange(items[i], items[i] + findQueryRef.current.length)
    } else {
      paintFindHighlights(items, i)
      scrollRangeIntoView(items[i], richRoot()?.closest('.editor-scroll'))
    }
    setFind((f) => ({ ...f, active: i + 1 }))
  }, [])

  // ── Line-number locate ──
  // Briefly highlight a preview block (display-only class) and scroll it center.
  const flashBlock = (el) => {
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove('hm-line-flash')
    void el.offsetWidth // restart the animation if the same block is re-targeted
    el.classList.add('hm-line-flash')
    window.setTimeout(() => el.classList.remove('hm-line-flash'), 1500)
  }

  // Jump the preview to the block that renders markdown source line `raw`. In
  // source mode this is an exact line jump; in keep/rich mode it resolves the
  // containing top-level block (`.km-block[data-bi]` / Nth .ProseMirror child).
  // `commit` (Enter/next/prev) is allowed to steal focus to show a text selection;
  // live typing (commit=false) only scrolls so the find input keeps focus.
  const runLineJump = useCallback((raw, commit = false) => {
    const str = String(raw ?? '').trim()
    findQueryRef.current = str
    if (sourceRef.current) {
      const el = sourceRef.current
      const lines = el.value.split('\n')
      const total = lines.length
      const n = parseInt(str, 10)
      if (!str || !Number.isFinite(n)) { setFind((f) => ({ ...f, matches: total, active: 0 })); return }
      const ln = Math.min(Math.max(1, n), total)
      const cs = getComputedStyle(el)
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20
      el.scrollTop = Math.max(0, (ln - 1) * lh - el.clientHeight / 2)
      if (commit) {
        let off = 0
        for (let k = 0; k < ln - 1; k++) off += lines[k].length + 1
        el.focus()
        el.setSelectionRange(off, off + lines[ln - 1].length)
      }
      setFind((f) => ({ ...f, matches: total, active: ln }))
      return
    }
    const tab = tabsRef.current.find((x) => x.id === activeIdRef.current)
    const content = tab?.content ?? ''
    const n = parseInt(str, 10)
    const { bi, total } = blockIndexForLine(content, Number.isFinite(n) ? n : 1)
    if (!str || !Number.isFinite(n)) { lineBiRef.current = -1; setFind((f) => ({ ...f, matches: total, active: 0 })); return }
    lineBiRef.current = bi
    const root = richRoot()
    let block = null
    if (root && bi >= 0) {
      block = root.classList.contains('km-doc')
        ? root.querySelector(`.km-block[data-bi="${bi}"]`)
        : root.children[bi] || null
    }
    flashBlock(block)
    setFind((f) => ({ ...f, matches: total, active: Math.min(Math.max(1, n), total) }))
  }, [])

  // Next/prev in line mode steps the target line by ±1 and re-jumps.
  const stepLine = useCallback((backwards = false) => {
    const n = parseInt(String(findQueryRef.current).trim(), 10)
    const cur = Number.isFinite(n) ? n : 1
    const next = Math.max(1, cur + (backwards ? -1 : 1))
    setFind((f) => ({ ...f, query: String(next) }))
    runLineJump(String(next), true)
  }, [runLineJump])

  // Reveal an anchor (heading slug / explicit id / literal text) in a doc. The
  // target may have just opened, so we retry until its block/textarea is mounted.
  const jumpToAnchor = useCallback((anchor, targetPath) => {
    const norm = (p) => (p || '').replace(/\\/g, '/')
    const tab = targetPath
      ? tabsRef.current.find((t) => norm(t.path) === norm(targetPath))
      : tabsRef.current.find((t) => t.id === activeIdRef.current)
    const content = tab?.content ?? ''
    const line = findAnchorLine(content, anchor) // 1-based, 0 if not found
    if (!line) return
    let tries = 0
    const attempt = () => {
      // Wait until the target tab is the active/visible one, so we don't flash a
      // block in the previously-shown doc before React commits the tab switch.
      if (targetPath && tab && activeIdRef.current !== tab.id) {
        if (tries++ < 16) setTimeout(attempt, 70)
        return
      }
      if (sourceRef.current) {
        const el = sourceRef.current
        const lines = el.value.split('\n')
        const ln = Math.min(Math.max(1, line), lines.length)
        let off = 0
        for (let k = 0; k < ln - 1; k++) off += lines[k].length + 1
        el.focus()
        el.setSelectionRange(off, off + (lines[ln - 1] || '').length)
        const cs = getComputedStyle(el)
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20
        el.scrollTop = Math.max(0, (ln - 1) * lh - el.clientHeight / 2)
        return
      }
      const { bi } = blockIndexForLine(content, line)
      const root = richRoot()
      const block =
        root && bi >= 0
          ? root.classList.contains('km-doc')
            ? root.querySelector(`.km-block[data-bi="${bi}"]`)
            : root.children[bi] || null
          : null
      if (block) {
        flashBlock(block)
        return
      }
      if (tries++ < 16) setTimeout(attempt, 70) // wait for the editor to mount/render
    }
    attempt()
  }, [])

  // ── in-app document links ──
  // A keep-mode link like [POL-001](L2_xxx.md#POL-001) opens the target doc as a
  // tab (or reuses it) and jumps to the anchor; a same-file / pure #anchor link
  // just jumps. External http(s)/mailto links are handled in the editors.
  const openDocLink = useCallback(
    async (relPath, anchor, fromPath) => {
      const base =
        fromPath || tabsRef.current.find((t) => t.id === activeIdRef.current)?.path || ''
      let targetPath = null
      if (relPath) {
        const p = relPath.replace(/\\/g, '/')
        targetPath = isAbsolutePath(p) ? p : resolveRelPath(dirName(base), p)
        // Only markdown opens in-app; extensionless links are treated as `.md`
        // (wiki-style). Other file types are out of scope (ignored).
        let openable = null
        if (MD_DOC_RE.test(targetPath)) openable = targetPath
        else if (!/\.[a-z0-9]+$/i.test(targetPath)) openable = targetPath + '.md'
        if (!openable) return
        targetPath = openable
        const already = tabsRef.current.find(
          (t) => (t.path || '').replace(/\\/g, '/') === targetPath.replace(/\\/g, '/')
        )
        await openPaths([targetPath])
        // openPaths shows its own alert if the file is missing; bail on failure.
        if (!already && !tabsRef.current.find(
          (t) => (t.path || '').replace(/\\/g, '/') === targetPath.replace(/\\/g, '/')
        ))
          return
      }
      if (anchor) jumpToAnchor(anchor, targetPath)
    },
    [openPaths]
  )

  const toggleFindMode = useCallback(() => {
    clearFindHighlights()
    findRangesRef.current = []
    activeIdxRef.current = -1
    lineBiRef.current = -1
    findQueryRef.current = ''
    setFind((f) => ({ ...f, mode: f.mode === 'line' ? 'text' : 'line', query: '', matches: 0, active: 0 }))
    setTimeout(() => findInputRef.current?.focus(), 0)
  }, [])

  const closeFind = useCallback(() => {
    clearTimeout(findDebounceRef.current)
    clearFindHighlights()
    findRangesRef.current = []
    activeIdxRef.current = -1
    lineBiRef.current = -1
    findQueryRef.current = ''
    setFind((f) => ({ open: false, query: '', matches: 0, active: 0, mode: f.mode }))
  }, [])

  // Re-run the search/jump when switching tabs while the find bar is open, so it
  // points at the newly-visible document.
  useEffect(() => {
    if (!find.open) return
    if (findModeRef.current === 'line') runLineJump(findQueryRef.current, false)
    else runFind(findQueryRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const platformClass =
    ({ win32: ' is-win', darwin: ' is-mac', ios: ' is-ios is-mobile', android: ' is-android is-mobile' }[
      window.api.platform
    ] || '')

  return (
    <I18nProvider lang={lang} setLang={setLang}>
    <div className={`app${platformClass}${isMobile && sidebarOpen ? ' drawer-open' : ''}`}>
      <div className="activity-bar">
        <button
          className={`activity-item activity-home${home ? ' active' : ''}`}
          title={t('nav.home')}
          onClick={() => handlers.current.home()}
        >
          <img className="activity-logo" src={logoUrl} alt="EasyMarkdown" />
        </button>
        <button
          className={`activity-item${sidebarMode === 'files' ? ' active' : ''}`}
          title={t('cmd.files')}
          onClick={() => handlers.current.toggleFiles()}
        >
          <Icon name="folder" size={20} />
        </button>
        <button
          className={`activity-item${sidebarMode === 'outline' ? ' active' : ''}`}
          title={t('outline.title')}
          onClick={() => handlers.current.toggleOutline()}
        >
          <Icon name="outline" size={20} />
        </button>
        <div className="activity-spacer" />
        <button
          className="activity-item"
          title={sidebarOpen ? t('side.collapsePane') : t('side.expandPane')}
          onClick={() => setSidebarOpen((v) => !v)}
        >
          <Icon name={sidebarOpen ? 'panel-left-close' : 'panel-left-open'} size={20} />
        </button>
      </div>

      <div className="topbar">
        {isMobile && (
          <button
            className="icon-btn drag-no hm-menu-btn"
            title={t('cmd.files')}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <Icon name="menu" size={20} />
          </button>
        )}
        <Tabs
          tabs={tabs}
          activeId={home ? null : activeId}
          splitId={home ? null : splitId}
          focusedPane={focusedPane}
          onActivate={(id) => {
            setHome(false)
            // Load into whichever pane is focused, so both panes are switchable.
            if (split && focusedPane === 'right' && id !== activeId) {
              setSplitId(id)
            } else {
              setActiveId(id)
            }
          }}
          onClose={closeTab}
          onNew={newTab}
          onCloseOthers={closeOthers}
          onCloseLeft={(id) => closeSide(id, 'left')}
          onCloseRight={(id) => closeSide(id, 'right')}
          onOpenRight={openRight}
          onRename={renameTabFile}
          onDuplicate={duplicateTabFile}
          onDelete={deleteTabFile}
          onExportPdf={exportPathToPdf}
        />
        <div className="topbar-spacer" />
        <button className="icon-btn drag-no" title={`${t('welcome.newFile')} (Ctrl+N)`} onClick={newTab}>
          <Icon name="plus" size={18} />
        </button>
        {!isMobile && (
          <button
            className={`icon-btn drag-no${split ? ' active' : ''}`}
            title={split ? t('split.close') : t('split.toggle')}
            onClick={toggleSplit}
          >
            <Icon name="columns" size={16} />
          </button>
        )}
        <button className="icon-btn drag-no" title="Command palette (Ctrl+P)" onClick={() => setPaletteOpen(true)}>
          <Icon name="command" size={16} />
        </button>
        {window.api.platform === 'win32' && <WindowControls t={t} />}
      </div>

      {isMobile && sidebarOpen && (
        <div className="hm-scrim" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="body">
        <aside
          ref={paneLeftRef}
          className={`pane-left${sidebarOpen ? '' : ' collapsed'}`}
          style={!isMobile && sidebarOpen ? { width: sidebarWidth, maxWidth: sidebarWidth } : undefined}
        >
          {sidebarOpen && (
            sidebarMode === 'files' ? (
              <Sidebar
                workspaces={workspaces}
                activePath={activePath}
                openTabPaths={openTabPaths}
                openTabPathsRaw={openTabPathsRaw}
                onOpenFile={onSidebarOpenFile}
                onOpenRight={openFileRight}
                onExportPdf={exportPathToPdf}
                onAddFolder={openFolder}
                onRemoveFolder={removeWorkspace}
                onReorderFolder={reorderWorkspaces}
                refreshNonce={refreshNonce}
              />
            ) : (
              <Outline content={activeTab?.content || ''} activeIndex={activeHeading} onJump={jumpToHeading} />
            )
          )}
        </aside>

        {!isMobile && sidebarOpen && (
          <div className="hm-sidebar-divider" onMouseDown={startSidebarDrag} title={t('side.dragResize')} />
        )}

        <main className="pane-center">
          {find.open && (
            <div className="findbar">
              <button
                className={`findbar-mode${find.mode === 'line' ? ' active' : ''}`}
                title={t(find.mode === 'line' ? 'find.modeLine' : 'find.modeText')}
                onClick={toggleFindMode}
              >
                <Icon name={find.mode === 'line' ? 'hash' : 'search'} size={14} />
              </button>
              <input
                ref={findInputRef}
                value={find.query}
                inputMode={find.mode === 'line' ? 'numeric' : undefined}
                placeholder={t(find.mode === 'line' ? 'find.linePlaceholder' : 'find.placeholder')}
                onChange={(e) => {
                  const q = e.target.value
                  setFind((f) => ({ ...f, query: q }))
                  if (find.mode === 'line') runLineJump(q, false) // live: scroll to the line
                  else runFindDebounced(q) // live: highlight as you type (debounced)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (find.mode === 'line') runLineJump(find.query, true)
                    else stepFind(e.shiftKey)
                  }
                  if (e.key === 'Escape') closeFind()
                }}
              />
              <span className="findbar-count">
                {find.query && find.matches ? `${find.active}/${find.matches}` : ''}
              </span>
              <button
                title={t(find.mode === 'line' ? 'find.linePrev' : 'find.prev')}
                onClick={() => (find.mode === 'line' ? stepLine(true) : stepFind(true))}
              >
                <Icon name="chevron-up" size={14} />
              </button>
              <button
                title={t(find.mode === 'line' ? 'find.lineNext' : 'find.next')}
                onClick={() => (find.mode === 'line' ? stepLine(false) : stepFind(false))}
              >
                <Icon name="chevron-down" size={14} />
              </button>
              <button title={t('find.close')} onClick={closeFind}>
                <Icon name="close" size={14} />
              </button>
            </div>
          )}

          {/* Editor area — a flex row so the active (left) and split (right) tabs
              can sit side by side. Editors are siblings here; only the one(s) in
              view are shown (the rest are display:none but stay mounted, so tab
              switches / toggling split never re-create an editor). Hidden as a
              whole on the welcome/home screen so it doesn't fight Welcome for space. */}
          <div
            ref={editorAreaRef}
            className={`editor-area${split ? ' is-split' : ''}`}
            style={{ display: home || !activeTab ? 'none' : undefined }}
          >
            {tabs.map((tab) => {
              // Which pane (if any) this tab occupies. `split` already excludes
              // home and the case where the two ids are equal.
              const isLeft = !home && tab.id === activeId
              const isRight = split && tab.id === splitId
              const inView = isLeft || isRight
              // Flex order: left pane (1) · divider (2) · right pane (3).
              // Irrelevant for hidden tabs (display:none removes them from layout).
              const order = isRight ? 3 : 1
              // Mark the focused pane (only meaningful while split) so the user
              // can see which pane a tab click will load into.
              const isFocusedPane = split && ((isRight && focusedPane === 'right') || (isLeft && focusedPane === 'left'))
              const paneClass =
                (isRight ? ' hm-pane-right' : isLeft ? ' hm-pane-left' : '') + (isFocusedPane ? ' hm-focused' : '')
              const onPaneFocus = () => {
                focusedTabRef.current = tab.id
                if (split) setFocusedPane(isRight ? 'right' : 'left')
              }
              // In split view the left pane holds a fixed fraction; the right pane
              // grows to fill the rest. Outside split, panes fill the row.
              const paneFlex = split && isLeft ? `0 0 calc(${(splitRatio * 100).toFixed(2)}% - 3px)` : undefined

              // Plain-text docs always use the textarea; the active pane also uses
              // it in global source mode (the right pane never shows it).
              // "Heavy" only matters for the Milkdown (Crepe) editor — its
              // near-quadratic handling of one giant paragraph freezes the thread.
              // The source-backed keep editor is plain DOM and renders heavy docs
              // fine, so only fall back to plain source for a Milkdown-bound tab
              // (and only until the user opts into rich-despite-heavy).
              const heavyAsSource =
                tab.heavy && milkdownForced.has(tab.id) && !richForced.has(tab.id)
              const usesTextarea = isPlainTextDoc(tab) || heavyAsSource || (sourceMode && isLeft)
              if (usesTextarea) {
                if (!inView) return null
                return (
                  <textarea
                    key={tab.id}
                    ref={isLeft ? sourceRef : undefined}
                    className={`source-editor${paneClass}`}
                    value={tab.content}
                    spellCheck={false}
                    style={{ order, flex: paneFlex }}
                    onFocus={onPaneFocus}
                    onMouseDown={onPaneFocus}
                    onChange={(e) => updateContent(tab.id, e.target.value, false)}
                  />
                )
              }
              // `.md` default: the source-backed "keep" editor (zero-diff saves).
              // The user can opt this tab into Milkdown WYSIWYG (milkdownForced).
              // Reaching here means it's a Markdown doc not shown as plain source.
              const usesKeep = !milkdownForced.has(tab.id)
              if (usesKeep) {
                if (!inView && !mountedIds.has(tab.id)) return null
                return (
                  <div
                    // Distinct key prefix from the Milkdown wrapper so toggling
                    // modes fully remounts (no ref/child reconciliation surprises).
                    key={`keep:${tab.id}:${tab.reloadNonce}`}
                    className={`editor-scroll km-scroll${paneClass}`}
                    style={{ display: inView ? undefined : 'none', order, flex: paneFlex }}
                    onFocusCapture={onPaneFocus}
                    onMouseDownCapture={onPaneFocus}
                  >
                    <KeepEditor
                      inView={inView}
                      initialContent={tab.content}
                      docPath={tab.path}
                      onChange={(md, isInitial) => updateContent(tab.id, md, isInitial)}
                      onReady={(api) => {
                        editorApis.current[tab.id] = api
                      }}
                      onFilterChange={(info) =>
                        setKeepFilters((m) => {
                          if (!info && !(tab.id in m)) return m
                          return { ...m, [tab.id]: info }
                        })
                      }
                      onOpenSource={openSourceAtLine}
                      onOpenDocLink={openDocLink}
                    />
                  </div>
                )
              }
              // Lazy mount: don't create a Crepe editor for a tab the user hasn't
              // opened yet (keeps session-restore of many tabs fast). Panes in
              // view always mount; visited tabs stay mounted.
              if (!inView && !mountedIds.has(tab.id)) return null
              return (
                <div
                  // Include reloadNonce so an external-edit reload remounts the
                  // Crepe editor with the new content (the create effect only
                  // runs on mount). tab switches keep the same key → stay mounted.
                  key={`${tab.id}:${tab.reloadNonce}`}
                  className={`editor-scroll${paneClass}`}
                  ref={isLeft && !sourceMode ? editorHostRef : undefined}
                  style={{ display: inView ? undefined : 'none', order, flex: paneFlex }}
                  onFocusCapture={onPaneFocus}
                  onMouseDownCapture={onPaneFocus}
                >
                  <Suspense fallback={null}>
                    <Editor
                      tabId={`${tab.id}:${tab.reloadNonce}`}
                      initialContent={tab.content}
                      docPath={tab.path}
                      onChange={(md, isInitial) => updateContent(tab.id, md, isInitial)}
                      onReady={(api) => {
                        editorApis.current[tab.id] = api
                      }}
                      onActiveBlock={(id) => {
                        if (tab.id === activeIdRef.current) setActiveBlock(id)
                      }}
                    />
                  </Suspense>
                </div>
              )
            })}

            {/* Heavy-doc notice: only shown when a Milkdown-bound doc is being
                displayed as plain source to stay responsive (the keep editor
                renders heavy docs directly); offer a one-click switch to rich. */}
            {!home &&
              activeTab &&
              activeTab.heavy &&
              milkdownForced.has(activeTab.id) &&
              !richForced.has(activeTab.id) && (
              <div className="hm-heavy-banner">
                <span>{t('heavy.notice')}</span>
                <button onClick={() => setRichForced((s) => new Set(s).add(activeTab.id))}>
                  {t('heavy.loadRich')}
                </button>
              </div>
            )}

            {split && (
              <div
                className="hm-split-divider"
                style={{ order: 2 }}
                onMouseDown={startSplitDrag}
                title={t('split.drag')}
              />
            )}

            {split && (
              <button className="hm-split-close" title={t('split.close')} onClick={() => setSplitId(null)}>
                <Icon name="close" size={14} />
              </button>
            )}
          </div>

          {(home || !activeTab) && (
            <Welcome
              t={t}
              lang={lang}
              recents={recents}
              onNew={newTab}
              onOpen={() => handlers.current.open()}
              onOpenFolder={openFolder}
              onOpenRecent={(p) => openPaths([p])}
            />
          )}
        </main>
      </div>

      <StatusBar
        tab={home ? null : activeTab}
        isMobile={isMobile}
        onSave={() => handlers.current.save()}
        onShare={() => {
          if (!activeTab) return
          if (!activeTab.path) {
            fireToast(tRef.current('save.shareNeedsSave'), { sticky: true })
            return
          }
          window.api.shareFile?.(activeTab.path)
        }}
        theme={theme}
        setTheme={pickBuiltinTheme}
        cycleTheme={cycleTheme}
        customThemes={customThemes}
        customTheme={customTheme}
        onPickCustom={setCustomTheme}
        onRefreshThemes={refreshThemes}
        onOpenThemesFolder={() => window.api.themesReveal?.()}
        onGetMoreThemes={() => window.api.openExternal('https://theme.typora.io/')}
        lang={lang}
        setLang={setLang}
        sourceMode={sourceMode}
        onToggleSource={toggleSource}
        keepEligible={
          // Heavy docs keep the toggle too: switching one to Milkdown lands in the
          // safe plain-source + "load rich" banner path (heavyAsSource above), never
          // the freeze-prone Crepe render — so there's no reason to hide the button
          // (it just vanishing on big files / big-table docs was confusing).
          !!activeTab && !isPlainTextDoc(activeTab) && !sourceMode
        }
        keepMode={!!activeTab && !milkdownForced.has(activeTab.id)}
        onToggleKeep={() => {
          dismissModeHint()
          handlers.current.toggleEditorMode()
        }}
        showModeHint={showModeHint}
        onDismissModeHint={dismissModeHint}
        activeBlock={activeBlock}
        onPickBlock={(id) => editorApis.current[activeId]?.setBlock(id)}
        pageWidth={settings.pageWidth}
        onSetPageWidth={(w) => updateSettings({ pageWidth: w })}
        fontSize={settings.fontSize}
        onSetFontSize={(s) => updateSettings({ fontSize: s })}
        zoom={settings.zoom}
        onSetZoom={(z) => updateSettings({ zoom: normalizeZoom(z) })}
        lineHeight={settings.lineHeight}
        onSetLineHeight={(v) => updateSettings({ lineHeight: v })}
        paragraphSpacing={settings.paragraphSpacing}
        onSetParagraphSpacing={(v) => updateSettings({ paragraphSpacing: v })}
        filterInfo={activeTab ? keepFilters[activeTab.id] : null}
      />

      <SaveFab
        visible={!home && !!activeTab && activeTab.content !== activeTab.savedContent}
        onSave={() => handlers.current.save()}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        files={files}
        onOpenFile={(p) => { openPaths([p]); if (isMobile) setSidebarOpen(false) }}
      />

      {toast && (
        <div className={`hm-toast${toast.sticky ? ' sticky' : ''}`} role="status" key={toast.key}>
          <span className="hm-toast-msg">{toast.msg}</span>
          {toast.sticky && (
            <button className="hm-toast-close" onClick={() => setToast(null)} aria-label="Close">
              <Icon name="close" size={15} />
            </button>
          )}
        </div>
      )}

      {renameState && (
        <RenameModal
          t={t}
          initial={renameState.value}
          onConfirm={(name) => commitTabRename(renameState.id, name)}
          onCancel={() => setRenameState(null)}
        />
      )}

      {saveNameState && (
        <RenameModal
          t={t}
          title={t('save.nameTitle')}
          initial={saveNameState.value}
          onConfirm={(name) => commitMobileSave(saveNameState.id, name)}
          onCancel={() => setSaveNameState(null)}
        />
      )}

      {update && (
        <UpdateToast
          t={t}
          latest={update.latest}
          current={update.current}
          notes={update.notes}
          onDownload={() => {
            window.api.openExternal(update.url)
            dismissUpdate()
          }}
          onDismiss={dismissUpdate}
        />
      )}
    </div>
    </I18nProvider>
  )
}
