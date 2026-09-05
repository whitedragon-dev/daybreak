const { app, BaseWindow, WebContentsView, ipcMain, protocol, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const pages = require('./pages.js');

const BASE_TOPBAR_HEIGHT = 42;
const BOOKMARKS_BAR_HEIGHT = 32;
let overlayExtra = 0; // extra height temporarily reserved for floating UI (menu / tab context menu)

protocol.registerSchemesAsPrivileged([
  { scheme: 'daybreak', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

let win = null;
let overlayView = null;

/** @type {Map<string, { view: import('electron').WebContentsView, title: string, url: string, loading: boolean, pinned: boolean, lastHistoryId: string|null }>} */
const tabs = new Map();
let activeId = null;

// ---------------- persisted data ----------------

function dataFile(name) {
  return path.join(app.getPath('userData'), name);
}

function loadJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(name), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function saveJSON(name, data) {
  try {
    fs.writeFileSync(dataFile(name), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save', name, e);
  }
}

let bookmarks = loadJSON('bookmarks.json', []);
let history = loadJSON('history.json', []);
let downloads = loadJSON('downloads.json', []);
let settings = Object.assign(
  { theme: 'light', homepage: 'daybreak://newtab', searchEngine: 'google', showBookmarksBar: true },
  loadJSON('settings.json', {})
);

function saveBookmarks() { saveJSON('bookmarks.json', bookmarks); }
function saveHistory() { saveJSON('history.json', history); }
function saveDownloads() { saveJSON('downloads.json', downloads); }
function saveSettings() { saveJSON('settings.json', settings); }

// ---------------- layout ----------------

function chromeHeight() {
  return BASE_TOPBAR_HEIGHT + (settings.showBookmarksBar ? BOOKMARKS_BAR_HEIGHT : 0);
}

function overlayBoundsHeight() {
  return chromeHeight() + overlayExtra;
}

function getContentSize() {
  const [width, height] = win.getContentSize();
  return { width, height };
}

function layout() {
  if (!win) return;
  const { width, height } = getContentSize();
  const tabTop = chromeHeight();

  // The overlay may be temporarily taller than the toolbar (e.g. while a
  // menu is open) so it can paint over the top of the tab area — but the
  // tab view itself always starts at the fixed toolbar height, so opening a
  // menu never resizes or reflows the page underneath.
  overlayView.setBounds({ x: 0, y: 0, width, height: overlayBoundsHeight() });

  for (const [id, tab] of tabs) {
    if (id === activeId) {
      tab.view.setBounds({ x: 0, y: tabTop, width, height: Math.max(0, height - tabTop) });
    } else {
      tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }
}

// ---------------- state push ----------------

function serializeState() {
  return {
    activeId,
    settings,
    tabs: [...tabs.entries()].map(([id, tab]) => {
      const wc = tab.view.webContents;
      return {
        id,
        title: tab.title || tab.url || 'New Tab',
        url: tab.url,
        loading: tab.loading,
        pinned: !!tab.pinned,
        canGoBack: wc.isDestroyed() ? false : wc.navigationHistory.canGoBack(),
        canGoForward: wc.isDestroyed() ? false : wc.navigationHistory.canGoForward(),
        bookmarked: bookmarks.some((b) => b.url === tab.url)
      };
    })
  };
}

function pushState() {
  if (!overlayView || overlayView.webContents.isDestroyed()) return;
  overlayView.webContents.send('tabs:update', serializeState());
}

function pushWinState() {
  if (!overlayView || overlayView.webContents.isDestroyed() || !win) return;
  overlayView.webContents.send('win:state', { maximized: win.isMaximized() });
}

// ---------------- url helpers ----------------

function normalizeUrl(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return settings.homepage;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i.test(trimmed)) return 'http://' + trimmed;
  return 'https://' + trimmed;
}

function looksLikeUrl(str) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(str)) return true;
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i.test(str)) return true;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(str) && !/\s/.test(str)) return true;
  return false;
}

const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q='
};

function resolveInput(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return settings.homepage;
  if (looksLikeUrl(trimmed)) return normalizeUrl(trimmed);
  const base = SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.google;
  return base + encodeURIComponent(trimmed);
}

// ---------------- tabs ----------------

function createTab(url, opts) {
  const id = randomUUID();
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'tab-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const initialUrl = url || settings.homepage;
  const tab = {
    view,
    title: 'New Tab',
    url: initialUrl,
    loading: false,
    pinned: !!(opts && opts.pinned),
    lastHistoryId: null
  };
  tabs.set(id, tab);

  // Insert at the bottom of the z-order: the overlay (added once, in
  // createWindow) must always stay visually on top so its menus can paint
  // over the tab area instead of being covered by it.
  win.contentView.addChildView(view, 0);

  const wc = view.webContents;
  wc.on('did-start-loading', () => { tab.loading = true; pushState(); });
  wc.on('did-stop-loading', () => { tab.loading = false; pushState(); });

  wc.on('did-navigate', (_e, navUrl) => {
    tab.url = navUrl;
    if (/^https?:\/\//i.test(navUrl)) {
      const entry = { id: randomUUID(), url: navUrl, title: '', timestamp: Date.now() };
      history.push(entry);
      tab.lastHistoryId = entry.id;
      saveHistory();
    } else {
      tab.lastHistoryId = null;
    }
    pushState();
  });

  wc.on('did-navigate-in-page', (_e, navUrl) => { tab.url = navUrl; pushState(); });

  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    if (tab.lastHistoryId) {
      const entry = history.find((h) => h.id === tab.lastHistoryId);
      if (entry) { entry.title = title; saveHistory(); }
    }
    pushState();
  });

  wc.on('before-input-event', (_e, input) => handleShortcut(input, id));

  wc.loadURL(normalizeUrl(initialUrl));

  setActiveTab(id);
  return id;
}

function setActiveTab(id) {
  if (!tabs.has(id)) return;
  activeId = id;
  layout();
  pushState();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;

  win.contentView.removeChildView(tab.view);
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  tabs.delete(id);

  if (activeId === id) {
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) setActiveTab(remaining[remaining.length - 1]);
    else createTab(settings.homepage);
  } else {
    layout();
    pushState();
  }
}

function closeOtherTabs(keepId) {
  [...tabs.keys()].forEach((id) => { if (id !== keepId) closeTab(id); });
}

function duplicateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  createTab(tab.url, { pinned: tab.pinned });
}

function togglePinTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.pinned = !tab.pinned;
  pushState();
}

// ---------------- keyboard shortcuts ----------------

function handleShortcut(input, sourceTabId) {
  if (input.type !== 'keyDown') return;
  const ctrl = input.control || input.meta;

  if (ctrl && input.key.toLowerCase() === 't') { createTab(settings.homepage); }
  else if (ctrl && input.key.toLowerCase() === 'w') { closeTab(sourceTabId || activeId); }
  else if (ctrl && input.key.toLowerCase() === 'r') { const t = tabs.get(activeId); if (t) t.view.webContents.reload(); }
  else if (ctrl && input.key.toLowerCase() === 'l') { overlayView.webContents.send('focus-urlbar'); }
  else if (ctrl && input.shift && input.key.toLowerCase() === 'd') { if (activeId) duplicateTab(activeId); }
  else if (input.alt && input.key === 'ArrowLeft') { const t = tabs.get(activeId); if (t && t.view.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack(); }
  else if (input.alt && input.key === 'ArrowRight') { const t = tabs.get(activeId); if (t && t.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); }
  else return;
}

// ---------------- window ----------------

function createWindow() {
  win = new BaseWindow({
    width: 1200,
    height: 800,
    frame: false,
    transparent: false,
    backgroundColor: '#ffffff',
    minWidth: 480,
    minHeight: 360
  });
  win.setTitle('Daybreak');

  overlayView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.contentView.addChildView(overlayView);
  // Transparent by default: only the toolbar/bookmarks-bar/dropdown elements
  // draw their own opaque backgrounds (see index.html). Anything else in the
  // overlay's bounds — including the extra space reserved while a menu is
  // open — stays see-through so it doesn't blank out the tab view beneath it.
  overlayView.setBackgroundColor('#00000000');
  overlayView.webContents.loadFile(path.join(__dirname, 'index.html'));
  overlayView.webContents.on('before-input-event', (_e, input) => handleShortcut(input, null));

  win.on('resize', layout);
  win.on('maximize', pushWinState);
  win.on('unmaximize', pushWinState);

  overlayView.webContents.once('did-finish-load', () => {
    createTab(settings.homepage);
    pushWinState();
  });
}

function setupDownloads() {
  session.defaultSession.on('will-download', (_event, item) => {
    const id = randomUUID();
    const entry = {
      id,
      filename: item.getFilename(),
      url: item.getURL(),
      total: item.getTotalBytes(),
      received: 0,
      state: 'progressing',
      savePath: null,
      timestamp: Date.now()
    };
    downloads.push(entry);
    saveDownloads();

    item.on('updated', (_e2, state) => {
      entry.received = item.getReceivedBytes();
      entry.state = state;
      saveDownloads();
    });
    item.once('done', (_e2, state) => {
      entry.state = state;
      entry.savePath = item.getSavePath();
      entry.received = item.getReceivedBytes();
      saveDownloads();
    });
  });
}

app.whenReady().then(() => {
  protocol.handle('daybreak', (request) => {
    const url = new URL(request.url);
    const host = url.hostname;
    let html;
    if (host === 'newtab' || host === 'home' || host === '') html = pages.newTabPage();
    else if (host === 'bookmarks') html = pages.bookmarksPage();
    else if (host === 'history') html = pages.historyPage();
    else if (host === 'settings') html = pages.settingsPage();
    else if (host === 'downloads') html = pages.downloadsPage();
    else if (host === 'about') html = pages.aboutPage();
    else return new Response('Not found', { status: 404 });

    return new Response(html, { headers: { 'content-type': 'text/html' } });
  });

  setupDownloads();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!win) createWindow();
});

// ---------------- IPC: tabs & navigation ----------------

ipcMain.handle('tabs:create', (_e, url) => createTab(url || settings.homepage));
ipcMain.handle('tabs:switch', (_e, id) => { setActiveTab(id); });
ipcMain.handle('tabs:close', (_e, id) => { closeTab(id); });
ipcMain.handle('tabs:closeOthers', (_e, id) => { closeOtherTabs(id); });
ipcMain.handle('tabs:duplicate', (_e, id) => { duplicateTab(id); });
ipcMain.handle('tabs:togglePin', (_e, id) => { togglePinTab(id); });

ipcMain.handle('nav:go', (_e, { id, url }) => {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.view.webContents.loadURL(resolveInput(url));
});

ipcMain.handle('nav:back', (_e, id) => {
  const tab = tabs.get(id);
  if (tab && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
});

ipcMain.handle('nav:forward', (_e, id) => {
  const tab = tabs.get(id);
  if (tab && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
});

ipcMain.handle('nav:reload', (_e, id) => {
  const tab = tabs.get(id);
  if (tab) tab.view.webContents.reload();
});

// ---------------- IPC: window controls ----------------

ipcMain.handle('win:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.handle('win:close', () => { if (win) win.close(); });
ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false));

ipcMain.handle('ui:setOverlayExtra', (_e, extra) => {
  overlayExtra = Math.max(0, Number(extra) || 0);
  layout();
});

// ---------------- IPC: bookmarks ----------------

ipcMain.handle('bookmarks:list', () => bookmarks);
ipcMain.handle('bookmarks:add', (_e, { url, title }) => {
  if (!bookmarks.some((b) => b.url === url)) {
    bookmarks.push({ id: randomUUID(), url, title: title || url, timestamp: Date.now() });
    saveBookmarks();
    pushState();
  }
  return bookmarks;
});
ipcMain.handle('bookmarks:remove', (_e, id) => {
  bookmarks = bookmarks.filter((b) => b.id !== id);
  saveBookmarks();
  pushState();
  return bookmarks;
});
ipcMain.handle('bookmarks:removeByUrl', (_e, url) => {
  bookmarks = bookmarks.filter((b) => b.url !== url);
  saveBookmarks();
  pushState();
  return bookmarks;
});

// ---------------- IPC: history ----------------

ipcMain.handle('history:list', () => history);
ipcMain.handle('history:remove', (_e, id) => {
  history = history.filter((h) => h.id !== id);
  saveHistory();
  return history;
});
ipcMain.handle('history:clear', () => {
  history = [];
  saveHistory();
  return history;
});

// ---------------- IPC: downloads ----------------

ipcMain.handle('downloads:list', () => downloads);
ipcMain.handle('downloads:open', (_e, id) => {
  const d = downloads.find((x) => x.id === id);
  if (d && d.savePath) shell.openPath(d.savePath);
});
ipcMain.handle('downloads:showInFolder', (_e, id) => {
  const d = downloads.find((x) => x.id === id);
  if (d && d.savePath) shell.showItemInFolder(d.savePath);
});
ipcMain.handle('downloads:clear', () => {
  downloads = [];
  saveDownloads();
  return downloads;
});

// ---------------- IPC: settings ----------------

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, partial) => {
  settings = Object.assign({}, settings, partial);
  saveSettings();
  layout();
  pushState();
  return settings;
});
