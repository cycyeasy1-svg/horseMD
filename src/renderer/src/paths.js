// Shared pure helpers: paths, filenames, doc classification, session, ids.
// All stateless — no React, no DOM mutation — so safe to import anywhere in the
// renderer. (The main process has its own copies; it can't import this module.)

// Compare dotted versions: is `a` newer than `b`? (e.g. '0.1.5' > '0.1.4')
export function isNewerVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0
  }
  return false
}

// An absolute path: POSIX "/…", Windows "C:\…"/"C:/…", or a UNC "\\…". A relative
// path like "." would resolve against the process CWD (= "/" under launchd), so a
// workspace must be absolute — otherwise the file tree / watcher target the wrong
// place (and recursively watching "/" crashes the app).
export const isAbsolutePath = (p) =>
  typeof p === 'string' && (/^\//.test(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p))
export const sanitizeWorkspace = (ws) => (ws && isAbsolutePath(ws.rootPath) ? ws : null)

// Multi-root workspaces: keep only absolute-path roots, de-duplicated by rootPath,
// each normalized to { rootPath, rootName }. `legacy` is the old single-workspace
// session field — when no array exists, fall back to it so upgrading users keep
// the folder they had open (it just becomes the first root).
export const sanitizeWorkspaces = (input, legacy) => {
  const arr = Array.isArray(input) ? input : (legacy ? [legacy] : [])
  const seen = new Set()
  const out = []
  for (const w of arr) {
    if (!w || !isAbsolutePath(w.rootPath) || seen.has(w.rootPath)) continue
    seen.add(w.rootPath)
    out.push({ rootPath: w.rootPath, rootName: w.rootName || baseName(w.rootPath) })
  }
  return out
}

export const baseName = (p) => (p ? p.split(/[\\/]/).pop() : 'Untitled')
export const dirName = (p) => (p ? p.replace(/[\\/][^\\/]*$/, '') : '')
export const joinPath = (dir, name) => `${dir.replace(/[\\/]+$/, '')}/${name}`

// Files that open in the rich Markdown editor. Anything else with a path (e.g.
// .txt) is treated as plain text and opened in the fast textarea — feeding plain
// text through Milkdown collapses its line breaks and bogs down on large files.
export const MD_DOC_RE = /\.(md|markdown|mdx)$/i
export const isMarkdownName = (name) => MD_DOC_RE.test(name || '')
export const isPlainTextDoc = (tab) => !!(tab && tab.path && !MD_DOC_RE.test(tab.path))

// A valid single path-segment name: no separators / reserved chars, not "."/"..".
export const isValidName = (name) => !!name && !/[\\/:*?"<>|]/.test(name) && name !== '.' && name !== '..'
// Does this fs error mean "a file/folder with that name already exists"?
export const isExistsError = (e) => /eexist|already exists/i.test(e?.message || '')

// A Markdown doc is "heavy" to render richly when:
//   ① it has a huge run of non-blank lines OUTSIDE code fences (no paragraph
//     breaks → one giant paragraph / table, the ProseMirror slow path);
//   ② total chars > 400 K;
//   ③ total lines > 50 K → even with normal blank-line breaks, the sheer number
//     of nodes (50 K+ paragraphs) makes the full parse + DOM render block the
//     main thread for many seconds.
// Such docs open in the fast plain-text editor by default (instant); the user
// can opt into the rich editor per-tab.
//
// Fenced code lines don't count toward the run: a fence is ONE CodeMirror node
// however long, and rich-mode open time measured flat (~350 ms at 300 / 900 /
// 3000 code lines), so a long code block flagging an ordinary doc as heavy was
// a pure false positive. The run threshold is 1000 for what remains (prose
// runs, tables): measured ≈0.5 s for a 900-line paragraph run and ≈1.3 s for a
// 900-row table — noticeable but nowhere near the multi-second freeze this
// guard exists for, and rich mode is opt-in per tab anyway.
const HEAVY_MAX_BLOCK_LINES = 1000
const HEAVY_MAX_TOTAL = 400000
const HEAVY_MAX_LINES = 50000
const HEAVY_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
export function isHeavyDoc(content) {
  if (!content) return false
  if (content.length > HEAVY_MAX_TOTAL) return true
  let run = 0
  let lines = 0
  let fence = null // { char, len } while inside a fenced code block
  for (const line of content.split('\n')) {
    if (++lines > HEAVY_MAX_LINES) return true // ← P0-1: line-count guard
    if (fence) {
      const m = line.match(HEAVY_FENCE_RE)
      if (m && m[1][0] === fence.char && m[1].length >= fence.len) fence = null
      continue
    }
    const open = line.match(HEAVY_FENCE_RE)
    if (open) {
      fence = { char: open[1][0], len: open[1].length }
      run = 0 // a fence is a block boundary
    } else if (/^[ \t]*$/.test(line)) {
      run = 0
    } else if (++run > HEAVY_MAX_BLOCK_LINES) {
      return true
    }
  }
  return false
}

// ---- Recent files (welcome screen) -----------------------------------------
// Entries are { path, name, dir, openedAt, pinned? }. Pinned entries always
// survive and sort first; only the unpinned tail is capped. Paths compare
// normalized (\ → /) so a Windows path recorded both ways stays one entry.
export const RECENTS_MAX = 8
const normPath = (p) => (p || '').replace(/\\/g, '/')
const samePath = (a, b) => normPath(a) === normPath(b)

export function rememberRecent(prev, entry) {
  const list = prev || []
  const old = list.find((r) => samePath(r.path, entry.path))
  const next = [
    { ...entry, pinned: !!old?.pinned },
    ...list.filter((r) => !samePath(r.path, entry.path))
  ]
  return [
    ...next.filter((r) => r.pinned),
    ...next.filter((r) => !r.pinned).slice(0, RECENTS_MAX)
  ]
}

export const removeRecentPath = (prev, path) =>
  (prev || []).filter((r) => !samePath(r.path, path))

// "Clear" keeps pinned entries — pinning is an explicit "don't lose this".
export const clearUnpinnedRecents = (prev) => (prev || []).filter((r) => r.pinned)

export function toggleRecentPinned(prev, path) {
  const next = (prev || []).map((r) =>
    samePath(r.path, path) ? { ...r, pinned: !r.pinned } : r
  )
  return [...next.filter((r) => r.pinned), ...next.filter((r) => !r.pinned)]
}

let idCounter = 0
export const genId = () => `t${++idCounter}_${Date.now()}`

export const LS = 'easymarkdown.session.v1'
export const loadSession = () => {
  try {
    return JSON.parse(localStorage.getItem(LS)) || {}
  } catch {
    return {}
  }
}

// Build the persistable tab slices of a session snapshot from the live tabs.
//   • openPaths   — every saved tab's path (reopened from disk on restart).
//   • pinnedPaths — the pinned subset, so pins survive a restart (order comes
//     from openPaths; this is just the membership set).
//   • untitled    — unsaved scratch/new tabs (no path) kept ONLY when they're
//     DIRTY and non-blank, carrying just {title, content}. So a restart restores
//     real unsaved work but never resurrects the untouched welcome doc or an
//     empty new tab (content === savedContent, or whitespace-only → dropped).
// Pure so the data-loss contract is unit-testable; see App.jsx persistence effect.
export const buildSessionTabs = (tabs) => ({
  openPaths: (tabs || []).map((t) => t.path).filter(Boolean),
  pinnedPaths: (tabs || []).filter((t) => t.pinned && t.path).map((t) => t.path),
  untitled: (tabs || [])
    .filter((t) => !t.path && t.content !== t.savedContent && (t.content || '').trim())
    .map((t) => ({ title: t.title, content: t.content }))
})

// Reorder the tab list by dragging: move `fromId` to `toId`'s position, then
// stable-partition pinned-first so a drag can never mix the two regions (a
// pinned tab dropped into the unpinned zone snaps back to the pinned group's
// tail, and vice versa — relative order inside each group is preserved).
export function reorderTabsList(tabs, fromId, toId) {
  const list = [...(tabs || [])]
  const from = list.findIndex((t) => t.id === fromId)
  const to = list.findIndex((t) => t.id === toId)
  if (from === -1 || to === -1 || from === to) return tabs
  const [moved] = list.splice(from, 1)
  list.splice(to, 0, moved)
  return [...list.filter((t) => t.pinned), ...list.filter((t) => !t.pinned)]
}

// Toggle a tab's pinned flag and regroup pinned-first.
export function toggleTabPinnedInList(tabs, id) {
  const list = (tabs || []).map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))
  return [...list.filter((t) => t.pinned), ...list.filter((t) => !t.pinned)]
}

// Field-wise equality of two session snapshots. App's persistence effect uses
// it to skip re-writing localStorage when nothing persistable changed — e.g.
// typing in a SAVED file rebuilds the snapshot every keystroke but only its
// array identities differ, not their contents. Arrays App passes through by
// state identity (workspaces, recents) compare by reference — a conservative
// "changed" answer just means one extra write. The rebuilt openPaths/untitled
// arrays compare by value; untouched tabs keep their exact string references,
// so those item compares are O(1) reference hits.
export const sessionSnapshotEqual = (a, b) => {
  if (!a || !b) return false
  if (
    a.workspaces !== b.workspaces ||
    a.theme !== b.theme ||
    a.customTheme !== b.customTheme ||
    a.lang !== b.lang ||
    a.recents !== b.recents ||
    a.sidebarOpen !== b.sidebarOpen ||
    a.sidebarMode !== b.sidebarMode ||
    a.sidebarWidth !== b.sidebarWidth ||
    a.activePath !== b.activePath
  ) {
    return false
  }
  const ap = a.openPaths || []
  const bp = b.openPaths || []
  if (ap.length !== bp.length) return false
  for (let i = 0; i < ap.length; i++) if (ap[i] !== bp[i]) return false
  const app = a.pinnedPaths || []
  const bpp = b.pinnedPaths || []
  if (app.length !== bpp.length) return false
  for (let i = 0; i < app.length; i++) if (app[i] !== bpp[i]) return false
  const au = a.untitled || []
  const bu = b.untitled || []
  if (au.length !== bu.length) return false
  for (let i = 0; i < au.length; i++) {
    if (au[i].title !== bu[i].title || au[i].content !== bu[i].content) return false
  }
  return true
}
