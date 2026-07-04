import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Install this before the renderer bundle mounts. If a user drops a file while
// the cold-start splash is still up, Electron's default behavior is to navigate
// the whole window to file://... Preventing default here keeps the app intact;
// App.jsx's richer drop handler still receives the event after React is ready.
const isFileDrag = (event) => event.dataTransfer?.types?.includes('Files')
window.addEventListener(
  'dragover',
  (event) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  },
  true
)
window.addEventListener(
  'drop',
  (event) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
  },
  true
)

// Subscribe to a main→renderer channel; returns an unsubscribe function.
const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.removeListener(channel, fn)
}

const api = {
  // dialogs
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  saveAs: (defaultName) => ipcRenderer.invoke('dialog:saveAs', defaultName),
  exportPDF: (html, defaultName) => ipcRenderer.invoke('export:pdf', { html, defaultName }),
  exportHTML: (html, defaultName, title) =>
    ipcRenderer.invoke('export:html', { html, defaultName, title }),
  printHTML: (html) => ipcRenderer.invoke('print:html', { html }),

  // fs
  readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
  rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  deleteItem: (path) => ipcRenderer.invoke('fs:delete', path),
  createFile: (path, content) => ipcRenderer.invoke('fs:createFile', path, content),
  createDir: (path) => ipcRenderer.invoke('fs:createDir', path),
  duplicate: (path) => ipcRenderer.invoke('fs:duplicate', path),
  readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
  readDirRecursive: (dir) => ipcRenderer.invoke('fs:readDirRecursive', dir),
  listFiles: (root) => ipcRenderer.invoke('fs:listFiles', root),
  openFolderTree: (dir) => ipcRenderer.invoke('fs:openFolderTree', dir),

  // workspace full-text search (streaming: batches + done arrive as events)
  searchStart: (payload) => ipcRenderer.invoke('search:start', payload),
  searchCancel: () => ipcRenderer.invoke('search:cancel'),
  onSearchBatch: on('search:batch'),
  onSearchDone: on('search:done'),

  // watch
  watchStart: (dir) => ipcRenderer.invoke('watch:start', dir),
  watchStop: (dir) => ipcRenderer.invoke('watch:stop', dir),
  watchFile: (path) => ipcRenderer.invoke('watch:file', path),
  unwatchFile: (path) => ipcRenderer.invoke('watch:unfile', path),

  // Resolve the absolute path of a dropped/picked File. Electron 34 removed the
  // renderer-side File.path for security, so OS file drag-and-drop must go
  // through webUtils. Returns '' if the File isn't backed by a real path.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },

  // shell
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showInFolder: (path) => ipcRenderer.invoke('shell:showInFolder', path),

  // save a pasted/dropped image into the document's assets/ folder; returns
  // { ok, path } with a relative path to insert into Markdown.
  saveImage: (docPath, name, bytes) =>
    ipcRenderer.invoke('image:save', docPath, name, bytes),
  // save an image pasted into an UNSAVED doc to the global paste folder; returns
  // { ok, url } (a file:// URL) so it shows as a real path, not a base64 blob.
  savePaste: (name, bytes) => ipcRenderer.invoke('image:savePaste', name, bytes),
  // at save time, move base64 / paste-folder images into the doc's assets/ and
  // rewrite the Markdown to relative paths; returns { content, changed }.
  inlineForSave: (content, targetPath) =>
    ipcRenderer.invoke('image:inlineForSave', content, targetPath),

  // custom themes (user CSS files in userData/themes)
  themesList: () => ipcRenderer.invoke('themes:list'),
  themeRead: (file) => ipcRenderer.invoke('themes:read', file),
  themesReveal: () => ipcRenderer.invoke('themes:reveal'),

  // window controls (custom title-bar buttons on Windows/Linux)
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // update check (notify-only)
  checkUpdate: () => ipcRenderer.invoke('update:check'),

  // report the UI language so the native application menu follows it
  setAppLang: (lang) => ipcRenderer.invoke('app:setLang', lang),

  // toggle the built-in spellchecker (settings preference)
  setSpellcheck: (enabled) => ipcRenderer.invoke('spell:set', enabled),

  // app close: main asks before closing so the renderer can warn about unsaved
  // changes, then calls confirmAppClose() to proceed or cancelAppClose() to abort.
  confirmAppClose: () => ipcRenderer.send('app:confirm-close'),
  cancelAppClose: () => ipcRenderer.send('app:cancel-close'),

  // events from main
  onOpenPaths: on('open-paths'),
  onOpenFolderPath: on('open-folder'),
  onMenu: on('menu'),
  onWatchChanged: on('watch:changed'),
  onFileChanged: on('file:changed'),
  onWindowMaximized: on('window:maximized'),
  onAppCloseRequest: on('app-close-request'),

  platform: process.platform,

  // Feature capabilities for the renderer to gate UI uniformly across desktop /
  // mobile (mobile provides its own set via the Capacitor shim). Exposed HERE,
  // not added later in the renderer: contextBridge freezes this object, so
  // assigning `window.api.capabilities` from the renderer throws ("object is not
  // extensible") and white-screens the app. Desktop supports everything.
  capabilities: {
    folderWorkspace: true,
    workspaceSearch: true,
    watch: true,
    windowControls: true,
    pdfExport: true,
    htmlExport: true,
    print: true,
    spellcheck: true,
    nativeMenus: true,
    externalShell: true,
    revealInFolder: true,
    splitView: true
  }
}

contextBridge.exposeInMainWorld('api', api)
