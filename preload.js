const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // tabs
  createTab: (url) => ipcRenderer.invoke('tabs:create', url),
  switchTab: (id) => ipcRenderer.invoke('tabs:switch', id),
  closeTab: (id) => ipcRenderer.invoke('tabs:close', id),
  closeOtherTabs: (id) => ipcRenderer.invoke('tabs:closeOthers', id),
  duplicateTab: (id) => ipcRenderer.invoke('tabs:duplicate', id),
  togglePinTab: (id) => ipcRenderer.invoke('tabs:togglePin', id),

  // navigation
  navigate: (id, url) => ipcRenderer.invoke('nav:go', { id, url }),
  goBack: (id) => ipcRenderer.invoke('nav:back', id),
  goForward: (id) => ipcRenderer.invoke('nav:forward', id),
  reload: (id) => ipcRenderer.invoke('nav:reload', id),

  // window controls
  minimizeWindow: () => ipcRenderer.invoke('win:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('win:maximize'),
  closeWindow: () => ipcRenderer.invoke('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:isMaximized'),

  // let the overlay temporarily grow to fit floating UI (e.g. an open menu)
  setOverlayExtra: (px) => ipcRenderer.invoke('ui:setOverlayExtra', px),

  // bookmarks
  getBookmarks: () => ipcRenderer.invoke('bookmarks:list'),
  addBookmark: (url, title) => ipcRenderer.invoke('bookmarks:add', { url, title }),
  removeBookmark: (id) => ipcRenderer.invoke('bookmarks:remove', id),
  removeBookmarkByUrl: (url) => ipcRenderer.invoke('bookmarks:removeByUrl', url),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),

  // push events from main
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('tabs:update', listener);
    return () => ipcRenderer.removeListener('tabs:update', listener);
  },
  onWinState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('win:state', listener);
    return () => ipcRenderer.removeListener('win:state', listener);
  },
  onFocusUrlbar: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('focus-urlbar', listener);
    return () => ipcRenderer.removeListener('focus-urlbar', listener);
  }
});
