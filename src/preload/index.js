import { contextBridge, ipcRenderer } from 'electron'

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

  // fs
  readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
  rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  deleteItem: (path) => ipcRenderer.invoke('fs:delete', path),
  createFile: (path, content) => ipcRenderer.invoke('fs:createFile', path, content),
  createDir: (path) => ipcRenderer.invoke('fs:createDir', path),
  readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
  listFiles: (root) => ipcRenderer.invoke('fs:listFiles', root),
  openFolderTree: (dir) => ipcRenderer.invoke('fs:openFolderTree', dir),

  // watch
  watchStart: (dir) => ipcRenderer.invoke('watch:start', dir),
  watchStop: (dir) => ipcRenderer.invoke('watch:stop', dir),
  watchFile: (path) => ipcRenderer.invoke('watch:file', path),
  unwatchFile: (path) => ipcRenderer.invoke('watch:unfile', path),

  // shell
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showInFolder: (path) => ipcRenderer.invoke('shell:showInFolder', path),

  // events from main
  onOpenPaths: on('open-paths'),
  onMenu: on('menu'),
  onWatchChanged: on('watch:changed'),
  onFileChanged: on('file:changed'),

  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)
