// Generates the internal "browser://" pages. Plain strings, no build step —
// each page is a full HTML document with inline CSS/JS, talking to main
// process only through window.internalAPI (see tab-preload.js).

const BASE_STYLE = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    background: #ffffff;
    color: #202124;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 20px; font-weight: 500; margin: 0 0 20px; }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid #e8eaed;
  }
  .row:hover { background: #f8f9fa; }
  .row .main { min-width: 0; flex: 1; }
  .row .title { font-size: 13px; color: #202124; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .url { font-size: 11px; color: #5f6368; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .meta { font-size: 11px; color: #5f6368; flex-shrink: 0; }
  .row a.title-link { color: #202124; text-decoration: none; }
  .row a.title-link:hover { text-decoration: underline; }
  button.icon-btn {
    border: none; background: transparent; color: #5f6368; cursor: pointer;
    font-size: 13px; padding: 4px 8px; border-radius: 4px; flex-shrink: 0;
  }
  button.icon-btn:hover { background: #e8eaed; color: #202124; }
  .empty { color: #5f6368; font-size: 13px; padding: 20px 0; text-align: center; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
  input[type="text"], input[type="search"] {
    flex: 1; padding: 8px 12px; border: 1px solid #dadce0; border-radius: 6px;
    font-size: 13px; outline: none; color: #202124;
  }
  input[type="text"]:focus, input[type="search"]:focus { border-color: #1a73e8; }
  button.action {
    padding: 8px 16px; border: none; border-radius: 6px; background: #1a73e8;
    color: #fff; font-size: 13px; cursor: pointer;
  }
  button.action:hover { background: #1765cc; }
  button.action.danger { background: #d93025; }
  button.action.danger:hover { background: #b0271b; }
`;

function shell(title, bodyHtml, script) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${BASE_STYLE}</style>
</head>
<body>
<div class="wrap">
${bodyHtml}
</div>
<script>${script}</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function newTabPage() {
  const body = `
    <h1>New Tab</h1>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search or enter address" autofocus>
    </div>
    <div id="bookmarkTiles"></div>
  `;
  const script = `
    var engines = {
      google: 'https://www.google.com/search?q=',
      bing: 'https://www.bing.com/search?q=',
      duckduckgo: 'https://duckduckgo.com/?q='
    };
    var q = document.getElementById('q');
    q.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var val = q.value.trim();
      if (!val) return;
      window.internalAPI.getSettings().then(function (settings) {
        var isUrl = /^[a-z][a-z0-9+.-]*:\\/\\//i.test(val) || /^[\\w-]+(\\.[\\w-]+)+(:\\d+)?(\\/.*)?$/i.test(val);
        if (isUrl) {
          location.href = /^[a-z][a-z0-9+.-]*:\\/\\//i.test(val) ? val : 'https://' + val;
        } else {
          var base = engines[settings.searchEngine] || engines.google;
          location.href = base + encodeURIComponent(val);
        }
      });
    });
    window.internalAPI.getBookmarks().then(function (list) {
      var el = document.getElementById('bookmarkTiles');
      if (!list.length) return;
      var html = '<h1 style="font-size:14px;margin-top:24px">Bookmarks</h1>';
      list.slice(0, 10).forEach(function (b) {
        html += '<div class="row"><div class="main"><a class="title-link" href="' + b.url + '"><div class="title">' + (b.title || b.url) + '</div><div class="url">' + b.url + '</div></a></div></div>';
      });
      el.innerHTML = html;
    });
  `;
  return shell('New Tab', body, script);
}

function bookmarksPage() {
  const body = `
    <h1>Bookmarks</h1>
    <div id="list"><div class="empty">Loading…</div></div>
  `;
  const script = `
    function render(list) {
      var el = document.getElementById('list');
      if (!list.length) { el.innerHTML = '<div class="empty">No bookmarks yet</div>'; return; }
      el.innerHTML = list.slice().reverse().map(function (b) {
        return '<div class="row"><div class="main"><a class="title-link" href="' + b.url + '"><div class="title">' + (b.title || b.url) + '</div><div class="url">' + b.url + '</div></a></div>' +
          '<button class="icon-btn" data-id="' + b.id + '">Remove</button></div>';
      }).join('');
      el.querySelectorAll('button[data-id]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          window.internalAPI.removeBookmark(btn.getAttribute('data-id')).then(render);
        });
      });
    }
    window.internalAPI.getBookmarks().then(render);
  `;
  return shell('Bookmarks', body, script);
}

function historyPage() {
  const body = `
    <h1>History</h1>
    <div class="toolbar">
      <input type="search" id="filter" placeholder="Search history">
      <button class="action danger" id="clearBtn">Clear all</button>
    </div>
    <div id="list"><div class="empty">Loading…</div></div>
  `;
  const script = `
    var all = [];
    function render(list) {
      var el = document.getElementById('list');
      if (!list.length) { el.innerHTML = '<div class="empty">No history yet</div>'; return; }
      el.innerHTML = list.slice().reverse().map(function (h) {
        var date = new Date(h.timestamp);
        return '<div class="row"><div class="main"><a class="title-link" href="' + h.url + '"><div class="title">' + (h.title || h.url) + '</div><div class="url">' + h.url + '</div></a></div>' +
          '<span class="meta">' + date.toLocaleString() + '</span>' +
          '<button class="icon-btn" data-id="' + h.id + '">Remove</button></div>';
      }).join('');
      el.querySelectorAll('button[data-id]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          window.internalAPI.removeHistory(btn.getAttribute('data-id')).then(function (list) { all = list; render(all); });
        });
      });
    }
    window.internalAPI.getHistory().then(function (list) { all = list; render(all); });
    document.getElementById('filter').addEventListener('input', function (e) {
      var q = e.target.value.toLowerCase();
      render(all.filter(function (h) { return (h.title || '').toLowerCase().indexOf(q) >= 0 || h.url.toLowerCase().indexOf(q) >= 0; }));
    });
    document.getElementById('clearBtn').addEventListener('click', function () {
      window.internalAPI.clearHistory().then(function () { all = []; render(all); });
    });
  `;
  return shell('History', body, script);
}

function settingsPage() {
  const body = `
    <h1>Settings</h1>
    <div class="row"><div class="main"><div class="title">Homepage / new tab</div></div>
      <input type="text" id="homepage" style="max-width:280px" placeholder="browser://newtab"></div>
    <div class="row"><div class="main"><div class="title">Default search engine</div></div>
      <select id="searchEngine" style="padding:6px;border:1px solid #dadce0;border-radius:6px">
        <option value="google">Google</option>
        <option value="bing">Bing</option>
        <option value="duckduckgo">DuckDuckGo</option>
      </select></div>
    <div class="row"><div class="main"><div class="title">Show bookmarks bar</div></div>
      <input type="checkbox" id="showBookmarksBar"></div>
    <div class="row"><div class="main"><div class="title">Theme</div></div>
      <select id="theme" style="padding:6px;border:1px solid #dadce0;border-radius:6px">
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select></div>
    <div style="margin-top:16px"><button class="action" id="saveBtn">Save</button> <span id="savedMsg" style="font-size:12px;color:#188038;margin-left:8px;display:none">Saved</span></div>
  `;
  const script = `
    window.internalAPI.getSettings().then(function (s) {
      document.getElementById('homepage').value = s.homepage || 'browser://newtab';
      document.getElementById('searchEngine').value = s.searchEngine || 'google';
      document.getElementById('showBookmarksBar').checked = !!s.showBookmarksBar;
      document.getElementById('theme').value = s.theme || 'light';
    });
    document.getElementById('saveBtn').addEventListener('click', function () {
      window.internalAPI.setSettings({
        homepage: document.getElementById('homepage').value.trim() || 'browser://newtab',
        searchEngine: document.getElementById('searchEngine').value,
        showBookmarksBar: document.getElementById('showBookmarksBar').checked,
        theme: document.getElementById('theme').value
      }).then(function () {
        var msg = document.getElementById('savedMsg');
        msg.style.display = 'inline';
        setTimeout(function () { msg.style.display = 'none'; }, 1500);
      });
    });
  `;
  return shell('Settings', body, script);
}

module.exports = { newTabPage, bookmarksPage, historyPage, settingsPage, escapeHtml };
