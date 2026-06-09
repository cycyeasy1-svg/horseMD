import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Editor from './components/Editor.jsx'
import Sidebar from './components/Sidebar.jsx'
import Tabs from './components/Tabs.jsx'
import Outline from './components/Outline.jsx'
import StatusBar from './components/StatusBar.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import { Icon } from './components/icons.jsx'
import { THEMES, DEFAULT_THEME, applyTheme } from './themes.js'
import { I18nProvider, translate, DEFAULT_LANG } from './i18n.jsx'
import { welcomeDoc } from './onboarding.js'
import logoUrl from './assets/logo.png'

const ONBOARDED_KEY = 'horsemd.onboarded.v1'
const UPDATE_DISMISS_KEY = 'horsemd.update.dismissed'

// --------------------------- find-in-document helpers ----------------------
// Search is scoped to the editor content only (the rich .ProseMirror element or
// the source <textarea>), never the find bar or other UI — so the text typed in
// the find box is never itself matched. Highlighting uses the CSS Custom
// Highlight API, which paints ranges without touching the DOM.
const FIND_HL = 'hm-find'
const FIND_HL_CUR = 'hm-find-current'
const findHighlightSupported =
  typeof window !== 'undefined' && !!window.CSS?.highlights && typeof window.Highlight === 'function'

function clearFindHighlights() {
  if (!findHighlightSupported) return
  CSS.highlights.delete(FIND_HL)
  CSS.highlights.delete(FIND_HL_CUR)
}
function findRangesInEl(root, query) {
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
function paintFindHighlights(ranges, activeIdx) {
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
function scrollRangeIntoView(range, scroller) {
  if (!range || !scroller) return
  const rect = range.getBoundingClientRect()
  const sr = scroller.getBoundingClientRect()
  if (!rect.height && !rect.width) return
  if (rect.top < sr.top + 12 || rect.bottom > sr.bottom - 12) {
    scroller.scrollTop += (rect.top + rect.bottom) / 2 - (sr.top + sr.bottom) / 2
  }
}
function matchIndices(text, query) {
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

// Compare dotted versions: is `a` newer than `b`? (e.g. '0.1.5' > '0.1.4')
function isNewerVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0
  }
  return false
}

const baseName = (p) => (p ? p.split(/[\\/]/).pop() : 'Untitled')
const dirName = (p) => (p ? p.replace(/[\\/][^\\/]*$/, '') : '')
// Files that open in the rich Markdown editor. Anything else with a path (e.g.
// .txt) is treated as plain text and opened in the fast textarea — feeding plain
// text through Milkdown collapses its line breaks and bogs down on large files.
const MD_DOC_RE = /\.(md|markdown|mdx)$/i
const isPlainTextDoc = (tab) => !!(tab && tab.path && !MD_DOC_RE.test(tab.path))
let idCounter = 0
const genId = () => `t${++idCounter}_${Date.now()}`

const LS = 'minimd.session.v1'
const loadSession = () => {
  try {
    return JSON.parse(localStorage.getItem(LS)) || {}
  } catch {
    return {}
  }
}

export default function App() {
  const session = useRef(loadSession()).current
  const [tabs, setTabs] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [workspace, setWorkspace] = useState(session.workspace || null)
  const [sidebarOpen, setSidebarOpen] = useState(session.sidebarOpen ?? true)
  const [sidebarMode, setSidebarMode] = useState(session.sidebarMode || 'files') // 'files' or 'outline'
  const [theme, setTheme] = useState(session.theme || DEFAULT_THEME)
  const [lang, setLang] = useState(session.lang || DEFAULT_LANG)
  const [recents, setRecents] = useState(session.recents || [])
  const [sourceMode, setSourceMode] = useState(false)
  // Live mirror of sourceMode for ref-based reads inside stable callbacks.
  const sourceModeRef = useRef(sourceMode)
  sourceModeRef.current = sourceMode
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [files, setFiles] = useState([])
  const [find, setFind] = useState({ open: false, query: '', matches: 0, active: 0 })
  // Current match set: Range objects (rich editor) or character offsets (source
  // textarea). Held in a ref so next/prev don't trigger re-renders.
  const findRangesRef = useRef([])
  // "New version available" toast — populated by the startup update check below.
  const [update, setUpdate] = useState(null)

  const editorHostRef = useRef(null) // active rich editor's scroll container
  const sourceRef = useRef(null) // active source-mode <textarea>
  const scrollRatioRef = useRef(null) // pending scroll position to restore across a mode switch
  const findInputRef = useRef(null)
  // Registry of each tab's editor API (by tab id). Several markdown editors can
  // be mounted at once (a tab stays mounted after its first activation), so a
  // single ref would get stuck on whichever editor mounted last; keying by tab
  // id lets commands act on the *currently active* document.
  const editorApis = useRef({})
  const [activeBlock, setActiveBlock] = useState('paragraph')
  // Lazy mounting: a rich (Crepe) editor is only created once its tab has been
  // activated, then kept mounted so later tab switches stay instant. This keeps
  // startup/session-restore fast — only the active tab spins up an editor
  // instead of every restored tab parsing its whole document at once.
  const [mountedIds, setMountedIds] = useState(() => new Set())

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) || null, [tabs, activeId])
  const activePath = activeTab?.path || null
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
  }, [tabs])

  // Mark the active tab as mounted (and keep it mounted thereafter).
  useEffect(() => {
    if (activeId == null) return
    setMountedIds((prev) => (prev.has(activeId) ? prev : new Set(prev).add(activeId)))
  }, [activeId])

  // ----------------------------- theme / i18n -----------------------------
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

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
          reloadNonce: 0
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
    if (lastId) setActiveId(lastId)
  }, [])

  const newTab = useCallback(() => {
    const id = genId()
    setTabs((prev) => [
      ...prev,
      { id, path: null, title: t('tab.untitled'), content: '', savedContent: '', mtimeMs: null, reloadNonce: 0 }
    ])
    setActiveId(id)
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

  const writeTab = useCallback(async (tab, targetPath) => {
    const { mtimeMs } = await window.api.writeFile(targetPath, tab.content)
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tab.id
          ? { ...t, path: targetPath, title: baseName(targetPath), savedContent: t.content, mtimeMs }
          : t
      )
    )
    setRefreshNonce((n) => n + 1)
  }, [])

  const saveTab = useCallback(
    async (id, forceDialog = false) => {
      const tab = tabs.find((t) => t.id === id)
      if (!tab) return
      let target = tab.path
      if (!target || forceDialog) {
        target = await window.api.saveAs(tab.title.endsWith('.md') ? tab.title : tab.title + '.md')
        if (!target) return
      }
      await writeTab(tab, target)
    },
    [tabs, writeTab]
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
  const openFolder = useCallback(async () => {
    const dir = await window.api.openFolder()
    if (!dir) return
    const rootName = baseName(dir)
    setWorkspace({ rootPath: dir, rootName })
    setSidebarOpen(true)
  }, [])

  useEffect(() => {
    if (!workspace) {
      setFiles([])
      return
    }
    window.api.watchStart(workspace.rootPath)
    window.api.listFiles(workspace.rootPath).then(setFiles)
    return () => window.api.watchStop(workspace.rootPath)
  }, [workspace])

  useEffect(() => {
    const off = window.api.onWatchChanged(() => {
      setRefreshNonce((n) => n + 1)
      if (workspace) window.api.listFiles(workspace.rootPath).then(setFiles)
    })
    return off
  }, [workspace])

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
            reloadNonce: t.reloadNonce + 1
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
    const host = editorHostRef.current
    if (!host) return
    const hs = host.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6')
    hs[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // ------------------------- menu / shortcuts ----------------------
  const handlers = useRef({})
  handlers.current = {
    new: newTab,
    open: async () => openPaths(await window.api.openFiles()),
    openFolder,
    save: () => activeId && saveTab(activeId),
    saveAs: () => activeId && saveTab(activeId, true),
    exportPdf: async () => {
      const html = editorApis.current[activeId]?.getDocHTML?.()
      if (!html) {
        window.alert(tRef.current('error.exportPdfUnavailable'))
        return
      }
      const base = (activeTab?.title || 'Untitled').replace(/\.(md|markdown|mdx|txt)$/i, '')
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
    toggleTheme: cycleTheme,
    find: () => {
      setFind((f) => ({ ...f, open: true }))
      setTimeout(() => findInputRef.current?.focus(), 0)
    }
  }

  useEffect(() => {
    const offMenu = window.api.onMenu((cmd) => handlers.current[cmd]?.())
    const offOpen = window.api.onOpenPaths((paths) => openPaths(paths))
    // A folder path arriving from Explorer's "Open with HorseMD" folder menu.
    const offFolder = window.api.onOpenFolderPath?.((dir) => {
      if (!dir) return
      setWorkspace({ rootPath: dir, rootName: baseName(dir) })
      setSidebarMode('files')
      setSidebarOpen(true)
    })
    const onOpenFolderEvt = () => openFolder()
    window.addEventListener('mm:openFolder', onOpenFolderEvt)
    return () => {
      offMenu()
      offOpen()
      offFolder?.()
      window.removeEventListener('mm:openFolder', onOpenFolderEvt)
    }
  }, [openPaths, openFolder])

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
    // Restore silently: skip files that were deleted/moved since last session
    // without popping an error for each one.
    if (paths.length) openPaths(paths, true).then(() => {
      if (session.activePath) {
        setTabs((prev) => {
          const t = prev.find((x) => x.path === session.activePath)
          if (t) setActiveId(t.id)
          return prev
        })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --------------------------- persistence -------------------------
  useEffect(() => {
    const data = {
      workspace,
      theme,
      lang,
      recents,
      sidebarOpen,
      sidebarMode,
      openPaths: tabs.map((t) => t.path).filter(Boolean),
      activePath
    }
    localStorage.setItem(LS, JSON.stringify(data))
  }, [workspace, theme, lang, recents, sidebarOpen, sidebarMode, tabs, activePath])

  // ------------------------- update check (notify-only) ------------
  useEffect(() => {
    let alive = true
    window.api.checkUpdate?.().then((r) => {
      if (!alive || !r?.ok || !r.latest) return
      const dismissed = localStorage.getItem(UPDATE_DISMISS_KEY)
      if (isNewerVersion(r.latest, r.current) && r.latest !== dismissed) {
        setUpdate({ latest: r.latest, current: r.current, url: r.url })
      }
    }).catch(() => {})
    return () => {
      alive = false
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
    // Only greet on a genuinely fresh start (no restored session).
    if ((session.openPaths || []).filter(Boolean).length) return
    const doc = welcomeDoc(session.lang || DEFAULT_LANG)
    const id = genId()
    setTabs((prev) => [
      ...prev,
      { id, path: null, title: doc.title, content: doc.content, savedContent: doc.content, mtimeMs: null, reloadNonce: 0 }
    ])
    setActiveId(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --------------------------- commands ----------------------------
  const commands = useMemo(
    () => [
      { id: 'cmd.new', title: t('cmd.new'), icon: 'file-plus', run: () => handlers.current.new() },
      { id: 'cmd.open', title: t('cmd.open'), icon: 'file', run: () => handlers.current.open() },
      { id: 'cmd.openFolder', title: t('cmd.openFolder'), icon: 'folder', run: () => handlers.current.openFolder() },
      { id: 'cmd.save', title: t('cmd.save'), icon: 'save', run: () => handlers.current.save() },
      { id: 'cmd.saveAs', title: t('cmd.saveAs'), icon: 'save', run: () => handlers.current.saveAs() },
      { id: 'cmd.exportPdf', title: t('cmd.exportPdf'), icon: 'file', run: () => handlers.current.exportPdf() },
      { id: 'cmd.sidebar', title: t('cmd.sidebar'), icon: 'sidebar', run: () => handlers.current.toggleSidebar() },
      { id: 'cmd.files', title: t('cmd.files'), icon: 'folder', run: () => handlers.current.toggleFiles() },
      { id: 'cmd.outline', title: t('cmd.outline'), icon: 'outline', run: () => handlers.current.toggleOutline() },
      { id: 'cmd.source', title: t('cmd.source'), icon: 'code', run: () => handlers.current.toggleSource() },
      { id: 'cmd.theme', title: t('cmd.theme'), icon: 'moon', run: () => handlers.current.toggleTheme() },
      { id: 'cmd.find', title: t('cmd.find'), icon: 'search', run: () => handlers.current.find() }
    ],
    [t]
  )

  // Discriminate the active view: the source <textarea> sets sourceRef only when
  // it's mounted (source mode or a .txt doc); otherwise we're in the rich editor.
  const richRoot = () => editorHostRef.current?.querySelector('.ProseMirror') || null
  const findQueryRef = useRef('')
  const activeIdxRef = useRef(-1)

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

  const closeFind = useCallback(() => {
    clearFindHighlights()
    findRangesRef.current = []
    activeIdxRef.current = -1
    findQueryRef.current = ''
    setFind({ open: false, query: '', matches: 0, active: 0 })
  }, [])

  // Re-run the search when switching tabs while the find bar is open, so ranges
  // point at the newly-visible document.
  useEffect(() => {
    if (find.open) runFind(findQueryRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const platformClass = { win32: ' is-win', darwin: ' is-mac' }[window.api.platform] || ''

  return (
    <I18nProvider lang={lang} setLang={setLang}>
    <div className={`app${platformClass}`}>
      <div className="activity-bar">
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
        <Tabs
          tabs={tabs}
          activeId={activeId}
          onActivate={setActiveId}
          onClose={closeTab}
          onNew={newTab}
        />
        <div className="topbar-spacer" />
        <button className="icon-btn drag-no" title={`${t('welcome.newFile')} (Ctrl+N)`} onClick={newTab}>
          <Icon name="plus" size={18} />
        </button>
        <button className="icon-btn drag-no" title="Command palette (Ctrl+P)" onClick={() => setPaletteOpen(true)}>
          <Icon name="command" size={16} />
        </button>
        {window.api.platform === 'win32' && <WindowControls t={t} />}
      </div>

      <div className="body">
        <aside className={`pane-left${sidebarOpen ? '' : ' collapsed'}`}>
          {sidebarOpen && (
            sidebarMode === 'files' ? (
              <Sidebar
                workspace={workspace}
                activePath={activePath}
                onOpenFile={(p) => openPaths([p])}
                onExportPdf={exportPathToPdf}
                refreshNonce={refreshNonce}
              />
            ) : (
              <Outline content={activeTab?.content || ''} onJump={jumpToHeading} />
            )
          )}
        </aside>

        <main className="pane-center">
          {find.open && (
            <div className="findbar">
              <Icon name="search" size={14} />
              <input
                ref={findInputRef}
                value={find.query}
                placeholder={t('find.placeholder')}
                onChange={(e) => {
                  const q = e.target.value
                  setFind((f) => ({ ...f, query: q }))
                  runFind(q) // live: highlight as you type
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey) }
                  if (e.key === 'Escape') closeFind()
                }}
              />
              <span className="findbar-count">
                {find.query ? `${find.active}/${find.matches}` : ''}
              </span>
              <button title={t('find.prev')} onClick={() => stepFind(true)}>
                <Icon name="chevron-up" size={14} />
              </button>
              <button title={t('find.next')} onClick={() => stepFind(false)}>
                <Icon name="chevron-down" size={14} />
              </button>
              <button title={t('find.close')} onClick={closeFind}>
                <Icon name="close" size={14} />
              </button>
            </div>
          )}

          {activeTab ? (
            /* Each tab picks its editor. Plain-text docs (.txt) and global source
               mode use the textarea (active tab only — it's cheap). Markdown docs
               use Crepe and stay mounted so tab switches don't re-create them. */
            tabs.map((tab) => {
              const isActive = tab.id === activeId
              // The plain <textarea> is used for .txt docs, and for the *active*
              // Markdown doc while source mode is on. Crucially, only the active
              // tab swaps to source — background Markdown editors stay mounted
              // (hidden) below, so toggling source mode no longer destroys and
              // recreates every other tab's editor (that was the switch lag).
              if (isPlainTextDoc(tab) || (sourceMode && isActive)) {
                if (!isActive) return null
                return (
                  <textarea
                    key={tab.id}
                    ref={isActive ? sourceRef : undefined}
                    className="source-editor"
                    value={tab.content}
                    spellCheck={false}
                    onChange={(e) => updateContent(tab.id, e.target.value, false)}
                  />
                )
              }
              // Hidden when this isn't the visible view: a background tab, or the
              // active tab currently being shown as source above.
              const hidden = !isActive || sourceMode
              // Lazy mount: don't create a Crepe editor for a tab the user
              // hasn't opened yet (keeps session-restore of many tabs fast).
              // The active tab always mounts; visited tabs stay mounted.
              if (!isActive && !mountedIds.has(tab.id)) return null
              return (
                <div
                  // Include reloadNonce so an external-edit reload remounts the
                  // Crepe editor with the new content (the create effect only
                  // runs on mount). tab switches keep the same key → stay mounted.
                  key={`${tab.id}:${tab.reloadNonce}`}
                  className="editor-scroll"
                  ref={isActive && !sourceMode ? editorHostRef : undefined}
                  style={{ display: hidden ? 'none' : undefined }}
                >
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
                </div>
              )
            })
          ) : (
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
        tab={activeTab}
        theme={theme}
        setTheme={setTheme}
        cycleTheme={cycleTheme}
        lang={lang}
        setLang={setLang}
        sourceMode={sourceMode}
        onToggleSource={toggleSource}
        activeBlock={activeBlock}
        onPickBlock={(id) => editorApis.current[activeId]?.setBlock(id)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        files={files}
        onOpenFile={(p) => openPaths([p])}
      />

      {update && (
        <UpdateToast
          t={t}
          latest={update.latest}
          current={update.current}
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

// Custom Windows/Linux caption buttons (the native overlay is disabled in the
// main process). macOS uses its native traffic lights, so this isn't rendered
// there. The maximize icon reflects the live window state.
function WindowControls({ t }) {
  const [max, setMax] = useState(false)
  useEffect(() => {
    let alive = true
    window.api.windowIsMaximized?.().then((v) => alive && setMax(!!v))
    const off = window.api.onWindowMaximized?.((v) => setMax(!!v))
    return () => {
      alive = false
      off?.()
    }
  }, [])
  return (
    <div className="win-controls drag-no">
      <button className="win-ctrl" title={t('tip.minimize')} onClick={() => window.api.windowMinimize()}>
        <Icon name="win-min" size={14} strokeWidth={1.6} />
      </button>
      <button
        className="win-ctrl"
        title={t(max ? 'tip.restore' : 'tip.maximize')}
        onClick={async () => setMax(!!(await window.api.windowToggleMaximize()))}
      >
        <Icon name={max ? 'win-restore' : 'win-max'} size={13} strokeWidth={1.6} />
      </button>
      <button className="win-ctrl close" title={t('tip.close')} onClick={() => window.api.windowClose()}>
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

// Notify-only "new version available" toast — slides in at the bottom-right.
function UpdateToast({ t, latest, current, onDownload, onDismiss }) {
  return (
    <div className="update-toast" role="alert">
      <button className="update-toast-close" onClick={onDismiss} title={t('update.later')}>
        <Icon name="close" size={13} />
      </button>
      <div className="update-toast-head">
        <span className="update-toast-icon">
          <Icon name="sparkle" size={18} />
        </span>
        <div className="update-toast-text">
          <div className="update-toast-title">{t('update.title')}</div>
          <div className="update-toast-sub">
            v{current} <span className="update-toast-arrow">→</span> <b>v{latest}</b>
          </div>
        </div>
      </div>
      <button className="update-toast-primary" onClick={onDownload}>
        {t('update.download')}
      </button>
    </div>
  )
}

function relTime(ts, lang, t) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('time.justNow')
  if (min < 60) return t('time.minutesAgo', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('time.hoursAgo', { n: hr })
  const days = Math.floor(hr / 24)
  if (days === 1) return t('time.yesterday')
  try {
    return new Date(ts).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric'
    })
  } catch {
    return ''
  }
}

function Welcome({ t, lang, recents, onNew, onOpen, onOpenFolder, onOpenRecent }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <img className="welcome-logo" src={logoUrl} alt="HorseMD" />
        <h1>HorseMD</h1>
        <p className="welcome-tagline">{t('welcome.tagline')}</p>
        <div className="welcome-actions">
          <button className="btn-primary" onClick={onNew}>
            <Icon name="file-plus" size={16} /> {t('welcome.newFile')}
          </button>
          <button onClick={onOpen}>
            <Icon name="file" size={16} /> {t('welcome.openFile')}
          </button>
          <button onClick={onOpenFolder}>
            <Icon name="folder" size={16} /> {t('welcome.openFolder')}
          </button>
        </div>

        {recents && recents.length > 0 && (
          <div className="welcome-recents">
            <div className="welcome-recents-head">{t('welcome.recent')}</div>
            <div className="welcome-recents-list">
              {recents.map((r) => (
                <button key={r.path} className="recent-item" onClick={() => onOpenRecent(r.path)} title={r.path}>
                  <Icon name="file" size={16} className="recent-icon" />
                  <span className="recent-main">
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-path">{r.dir}</span>
                  </span>
                  <span className="recent-time">{relTime(r.openedAt, lang, t)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="welcome-hints">
          <span><kbd>Ctrl</kbd><kbd>P</kbd> {t('hint.palette')}</span>
          <span><kbd>Ctrl</kbd><kbd>B</kbd> {t('hint.sidebar')}</span>
          <span><kbd>Ctrl</kbd><kbd>N</kbd> {t('hint.new')}</span>
          <span><kbd>Ctrl</kbd><kbd>S</kbd> {t('hint.save')}</span>
        </div>
      </div>
    </div>
  )
}
