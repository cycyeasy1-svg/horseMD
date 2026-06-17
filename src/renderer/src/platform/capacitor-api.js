// Capacitor implementation of the window.api contract (see src/preload/index.js).
//
// On desktop, window.api is injected by Electron's preload over IPC. On mobile
// there is no preload, so this module provides the SAME interface backed by
// Capacitor plugins. The renderer (App.jsx etc.) only knows the contract, so it
// runs unchanged. Desktop-only capabilities (file watching, window controls,
// native menus, PDF export, image-host exec) degrade to safe no-ops and are
// also advertised via `capabilities` so the UI can hide what isn't available.
//
// File model (MVP): an app-private library under Documents/HorseMD. Paths handed
// to the renderer are POSIX-relative to that Documents directory (e.g.
// "HorseMD/notes.md"); the renderer treats `path` as an opaque string.
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { FilePicker } from '@capawesome/capacitor-file-picker'

const DIR = Directory.Documents
const LIB = 'HorseMD' // library root inside Documents
const MD_RE = /\.(md|markdown|mdx)$/i

const stat = async (path) => {
  try {
    const s = await Filesystem.stat({ path, directory: DIR })
    return s.mtime || 0
  } catch {
    return 0
  }
}

// Ensure the library folder exists (best effort; mkdir is idempotent enough).
const ensureLib = async () => {
  try {
    await Filesystem.mkdir({ path: LIB, directory: DIR, recursive: true })
  } catch {
    /* already exists */
  }
}

const readFile = async (path) => {
  const res = await Filesystem.readFile({ path, directory: DIR, encoding: Encoding.UTF8 })
  return { content: res.data, mtimeMs: await stat(path) }
}

const writeFile = async (path, content) => {
  await Filesystem.writeFile({
    path,
    directory: DIR,
    data: content,
    encoding: Encoding.UTF8,
    recursive: true
  })
  return { mtimeMs: await stat(path) }
}

const exists = async (path) => {
  try {
    await Filesystem.stat({ path, directory: DIR })
    return true
  } catch {
    return false
  }
}

const createFile = async (path, content = '') => {
  if (await exists(path)) throw new Error('A file with that name already exists.')
  await Filesystem.writeFile({
    path,
    directory: DIR,
    data: content,
    encoding: Encoding.UTF8,
    recursive: true
  })
  return true
}

const createDir = async (path) => {
  await Filesystem.mkdir({ path, directory: DIR, recursive: true })
  return true
}

const rename = async (oldPath, newPath) => {
  if (newPath.toLowerCase() !== oldPath.toLowerCase() && (await exists(newPath))) {
    throw new Error('A file or folder with that name already exists.')
  }
  await Filesystem.rename({ from: oldPath, to: newPath, directory: DIR, toDirectory: DIR })
  return true
}

const deleteItem = async (path) => {
  // Try as file first, then as directory.
  try {
    await Filesystem.deleteFile({ path, directory: DIR })
  } catch {
    await Filesystem.rmdir({ path, directory: DIR, recursive: true })
  }
  return true
}

const dropExt = (name) => name.replace(/\.[^.]+$/, '')
const extOf = (name) => (name.match(/\.[^.]+$/) || [''])[0]
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseOf = (path) => (path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path)

const duplicate = async (path) => {
  const { content } = await readFile(path)
  const dir = dirOf(path)
  const name = baseOf(path)
  let copy = `${dropExt(name)} copy${extOf(name)}`
  let target = dir ? `${dir}/${copy}` : copy
  let n = 2
  while (await exists(target)) {
    copy = `${dropExt(name)} copy ${n++}${extOf(name)}`
    target = dir ? `${dir}/${copy}` : copy
  }
  await writeFile(target, content)
  return true
}

const readTree = async (dir) => {
  let files
  try {
    files = (await Filesystem.readdir({ path: dir || LIB, directory: DIR })).files
  } catch {
    return []
  }
  const nodes = []
  for (const e of files) {
    if (e.name.startsWith('.')) continue
    const full = dir ? `${dir}/${e.name}` : e.name
    if (e.type === 'directory') nodes.push({ name: e.name, path: full, type: 'dir', children: null })
    else if (MD_RE.test(e.name)) nodes.push({ name: e.name, path: full, type: 'file' })
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

const listFilesFlat = async (root, dir, acc, depth) => {
  if (depth > 12 || acc.length > 5000) return
  let files
  try {
    files = (await Filesystem.readdir({ path: dir, directory: DIR })).files
  } catch {
    return
  }
  for (const e of files) {
    if (e.name.startsWith('.')) continue
    const full = `${dir}/${e.name}`
    if (e.type === 'directory') await listFilesFlat(root, full, acc, depth + 1)
    else if (MD_RE.test(e.name))
      acc.push({ name: e.name, path: full, rel: full.slice(root.length + 1) })
  }
}

const listFiles = async (root) => {
  const acc = []
  await listFilesFlat(root, root, acc, 0)
  return acc
}

const openFolderTree = async (dir) => ({
  root: { name: baseOf(dir), path: dir, type: 'dir' },
  children: await readTree(dir)
})

// Pick markdown/text file(s) from anywhere (Files app / SAF) and copy them into
// the library so the rest of the app can read them by path like any local file.
const openFiles = async () => {
  let picked
  try {
    picked = await FilePicker.pickFiles({ readData: true })
  } catch {
    return [] // user cancelled
  }
  await ensureLib()
  const out = []
  for (const f of picked.files || []) {
    const name = f.name || 'Untitled.md'
    let path = `${LIB}/${name}`
    let n = 2
    while (await exists(path)) path = `${LIB}/${dropExt(name)} ${n++}${extOf(name)}`
    // f.data is base64 of the raw bytes; write without text encoding to preserve them.
    await Filesystem.writeFile({ path, directory: DIR, data: f.data || '', recursive: true })
    out.push(path)
  }
  return out
}

// No native folder picker on iOS (sandbox). The library acts as the workspace.
const openFolder = async () => LIB

// "Save As" within the library: hand back a non-clobbering library path; the
// renderer then writeFile()s the content to it.
const saveAs = async (defaultName) => {
  await ensureLib()
  const name = defaultName || 'Untitled.md'
  let path = `${LIB}/${name}`
  let n = 2
  while (await exists(path)) path = `${LIB}/${dropExt(name)} ${n++}${extOf(name)}`
  return path
}

// ---- main→renderer events ---------------------------------------------------
// Most desktop event sources (watch, menus, window state, close-request) don't
// exist on mobile, so their subscribers are no-ops returning an unsubscribe fn.
const noopOff = () => () => {}

// File associations: another app opening a .md routes here via appUrlOpen.
const onOpenPaths = (cb) => {
  let handle
  CapApp.addListener('appUrlOpen', (e) => {
    if (e?.url) cb([e.url])
  }).then((h) => (handle = h))
  return () => handle?.remove()
}

const platform = Capacitor.getPlatform() // 'ios' | 'android' | 'web'

const capabilities = {
  folderWorkspace: false, // iOS sandbox; Android SAF comes later
  watch: false,
  windowControls: false,
  pdfExport: false, // no print-to-PDF save dialog on mobile
  imageHostExec: false,
  nativeMenus: false,
  externalShell: true,
  revealInFolder: false, // no Finder/Explorer on mobile
  splitView: false // not enough width on a phone
}

export function makeCapacitorApi() {
  ensureLib()
  return {
    // dialogs
    openFiles,
    openFolder,
    saveAs,
    exportPDF: async () => ({ ok: false, error: 'unsupported' }),

    // fs
    readFile,
    writeFile,
    rename,
    deleteItem,
    createFile,
    createDir,
    duplicate,
    readDir: readTree,
    listFiles,
    openFolderTree,

    // watch (no-op on mobile)
    watchStart: async () => true,
    watchStop: async () => true,
    watchFile: async () => true,
    unwatchFile: async () => true,

    // shell
    openExternal: (url) => Browser.open({ url }).catch(() => {}),
    showInFolder: async () => false,

    // image host (no Node subprocess on mobile)
    uploadImage: async () => ({ ok: false, error: 'unsupported' }),

    // custom themes — none bundled on mobile yet
    themesList: async () => [],
    themeRead: async () => '',
    themesReveal: async () => false,

    // window controls (no-op)
    windowMinimize: async () => {},
    windowToggleMaximize: async () => {},
    windowClose: async () => {},
    windowIsMaximized: async () => false,

    // update check — wired up later (CSP/network)
    checkUpdate: async () => null,

    // app close (no "close window" on mobile)
    confirmAppClose: () => {},
    cancelAppClose: () => {},

    // events
    onOpenPaths,
    onOpenFolderPath: noopOff,
    onMenu: noopOff,
    onWatchChanged: noopOff,
    onFileChanged: noopOff,
    onWindowMaximized: noopOff,
    onAppCloseRequest: noopOff,

    platform,
    capabilities
  }
}
