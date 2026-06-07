import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [files, setFiles] = useState([])
  const [find, setFind] = useState({ open: false, query: '' })

  const editorHostRef = useRef(null)
  const findInputRef = useRef(null)
  // Registry of each tab's editor API (by tab id). All markdown tabs stay
  // mounted, so a single ref would get stuck on whichever editor mounted last;
  // keying by tab id lets commands act on the *currently active* document.
  const editorApis = useRef({})
  const [activeBlock, setActiveBlock] = useState('paragraph')

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
  }, [tabs])

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
        const t = prev.find((x) => x.id === id)
        if (t && t.content !== t.savedContent) {
          if (!window.confirm(`"${t.title}" has unsaved changes. Close anyway?`)) return prev
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
    toggleSource: () => setSourceMode((v) => !v),
    toggleTheme: cycleTheme,
    find: () => {
      setFind((f) => ({ ...f, open: true }))
      setTimeout(() => findInputRef.current?.focus(), 0)
    }
  }

  useEffect(() => {
    const offMenu = window.api.onMenu((cmd) => handlers.current[cmd]?.())
    const offOpen = window.api.onOpenPaths((paths) => openPaths(paths))
    const onOpenFolderEvt = () => openFolder()
    window.addEventListener('mm:openFolder', onOpenFolderEvt)
    return () => {
      offMenu()
      offOpen()
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

  const runFind = (backwards = false) => {
    if (!find.query) return
    // eslint-disable-next-line no-undef
    window.find(find.query, false, backwards, true, false, true, false)
  }

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
      </div>

      <div className="body">
        <aside className={`pane-left${sidebarOpen ? '' : ' collapsed'}`}>
          {sidebarOpen && (
            sidebarMode === 'files' ? (
              <Sidebar
                workspace={workspace}
                activePath={activePath}
                onOpenFile={(p) => openPaths([p])}
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
                onChange={(e) => setFind((f) => ({ ...f, query: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') runFind(e.shiftKey)
                  if (e.key === 'Escape') setFind({ open: false, query: '' })
                }}
              />
              <button onClick={() => runFind(false)}>{t('find.next')}</button>
              <button onClick={() => runFind(true)}>{t('find.prev')}</button>
              <button onClick={() => setFind({ open: false, query: '' })}>
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
              if (sourceMode || isPlainTextDoc(tab)) {
                if (!isActive) return null
                return (
                  <textarea
                    key={tab.id}
                    className="source-editor"
                    value={tab.content}
                    spellCheck={false}
                    onChange={(e) => updateContent(tab.id, e.target.value, false)}
                  />
                )
              }
              return (
                <div
                  // Include reloadNonce so an external-edit reload remounts the
                  // Crepe editor with the new content (the create effect only
                  // runs on mount). tab switches keep the same key → stay mounted.
                  key={`${tab.id}:${tab.reloadNonce}`}
                  className="editor-scroll"
                  ref={isActive ? editorHostRef : undefined}
                  style={{ display: isActive ? undefined : 'none' }}
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
        onToggleSource={() => setSourceMode((v) => !v)}
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
    </div>
    </I18nProvider>
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
