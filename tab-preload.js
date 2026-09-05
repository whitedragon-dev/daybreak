const { contextBridge, ipcRenderer } = require('electron');

// This preload is attached to every tab's WebContentsView, including tabs
// showing arbitrary websites — so the bridge is only exposed when the
// document being loaded is one of our own internal "browser://" pages.
// Regular http/https pages never see window.internalAPI.
if (window.location.protocol === 'browser:') {
  contextBridge.exposeInMainWorld('internalAPI', {
    getBookmarks: () => ipcRenderer.invoke('bookmarks:list'),
    addBookmark: (url, title) => ipcRenderer.invoke('bookmarks:add', { url, title }),
    removeBookmark: (id) => ipcRenderer.invoke('bookmarks:remove', id),

    getHistory: () => ipcRenderer.invoke('history:list'),
    removeHistory: (id) => ipcRenderer.invoke('history:remove', id),
    clearHistory: () => ipcRenderer.invoke('history:clear'),

    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSettings: (partial) => ipcRenderer.invoke('settings:set', partial)
  });
}
