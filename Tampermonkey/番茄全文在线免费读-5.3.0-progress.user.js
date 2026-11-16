// ==UserScript==
// @name             番茄全文在线免费读
// @version          5.3.0-progress
// @description       自建后端替换番茄网页正文：锁章全文、阅读页「下载全文」、详情页一键下载全本；v5.3.0 新增：捕获官方 update_progress 模板并重放，把阅读进度同步到账号
// @description:zh-cn 自建后端替换番茄网页正文：锁章全文、阅读页「下载全文」、详情页一键下载全本；v5.3.0 新增：捕获官方 update_progress 模板并重放，把阅读进度同步到账号
// @description:en    Replace fanqienovel web content with a self-hosted API; locked chapters, full-book download; v5.3.0: capture & replay official update_progress to sync reading progress
// @author            ibxff / 修改版
// @license           MIT
// @match             https://fanqienovel.com/*
// @match             https://www.fanqienovel.com/*
// @grant             GM_xmlhttpRequest
// @grant             GM.xmlHttpRequest
// @grant             GM_registerMenuCommand
// @run-at            document-idle
// ==/UserScript==

(function () {
  'use strict';

  var API_BASE = 'http://127.0.0.1:18921';
  var CHAPTER_GAP_MS = 120;   // 下载时每章间隔，别把后端打爆
  var FETCH_TIMEOUT = 30000;

  // ------------------------------------------------------------------
  // 请求层：优先 GM_xmlhttpRequest（不受 CORS 限制），否则退回 fetch
  // ------------------------------------------------------------------
  var gmRequest =
    typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest :
    (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function')
      ? GM.xmlHttpRequest.bind(GM) : null;

  function getJson(path) {
    var url = API_BASE + path;
    if (gmRequest) {
      return new Promise(function (resolve, reject) {
        gmRequest({
          method: 'GET',
          url: url,
          timeout: FETCH_TIMEOUT,
          headers: { Accept: 'application/json' },
          onload: function (res) {
            if (res.status >= 200 && res.status < 300) {
              try { resolve(JSON.parse(res.responseText)); }
              catch (e) { reject(new Error('返回不是合法 JSON')); }
            } else {
              reject(new Error('HTTP ' + res.status));
            }
          },
          onerror: function () { reject(new Error('网络错误')); },
          ontimeout: function () { reject(new Error('请求超时')); }
        });
      });
    }
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // 后端：{"code":0,"data":{content,title,book_id,book_name,preview,source}}
  function fetchChapter(itemId) {
    return getJson('/api/v1/chapters/' + encodeURIComponent(itemId) + '/novel').then(function (j) {
      if (!j || (j.code !== 0 && j.code !== '0')) {
        throw new Error((j && j.message) || '接口返回异常');
      }
      var d = j.data || {};
      if (d.content == null && d.data) d = d.data;
      if (typeof d.content !== 'string' || !d.content) throw new Error('正文为空');
      return {
        content: d.content,
        title: d.title || '',
        bookId: d.book_id ? String(d.book_id) : '',
        bookName: d.book_name || '',
        preview: !!d.preview,
        source: d.source || ''
      };
    });
  }

  function fetchDirectory(bookId) {
    return getJson('/api/v1/books/' + encodeURIComponent(bookId) + '/directory').then(function (j) {
      if (!j || (j.code !== 0 && j.code !== '0')) {
        throw new Error((j && j.message) || '目录接口异常');
      }
      var vols = (j.data && j.data.chapterListWithVolume) || [];
      var list = [];
      vols.forEach(function (v) {
        (v.chapterList || []).forEach(function (c) {
          var id = c.itemId || c.item_id;
          if (!id) return;
          list.push({ id: String(id), title: c.chapter_title || c.title || '' });
        });
      });
      if (!list.length) throw new Error('目录为空');
      return list;
    });
  }

  // ------------------------------------------------------------------
  // 正文渲染
  // ------------------------------------------------------------------
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function textToHtml(text) {
    return text.split(/\r?\n/)
      .map(function (line) { return line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''); })
      .filter(function (line) { return line.length > 0; })
      .map(function (line) { return '<p>' + escapeHtml(line) + '</p>'; })
      .join('');
  }

  var OVERLAY_SELECTORS = ['.muye-to-vip', '.muye-to-fanqie', '.muye-to-vip-login-btn', '.muye-vip-mask'];

  function cleanOverlays() {
    OVERLAY_SELECTORS.forEach(function (sel) {
      Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) { el.remove(); });
    });
  }

  // ------------------------------------------------------------------
  // 状态条（左下角，避免压住阅读底栏和右下面板）
  // ------------------------------------------------------------------
  var badge = null;
  function showBadge(text, kind) {
    if (!document.body) return;
    if (!badge || !document.body.contains(badge)) {
      badge = document.createElement('div');
      badge.id = 'fq-badge';
      badge.style.cssText = [
        'position:fixed', 'left:16px', 'bottom:16px', 'z-index:2147483647',
        'padding:8px 14px', 'border-radius:8px', 'font-size:13px', 'line-height:1.4',
        'color:#fff', 'background:#4c4c4c', 'box-shadow:0 4px 16px rgba(0,0,0,.25)',
        'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
        'max-width:60vw', 'pointer-events:none', 'transition:opacity .3s'
      ].join(';');
      document.body.appendChild(badge);
    }
    var colors = { ok: '#2e7d32', warn: '#ef6c00', err: '#c62828', info: '#4c4c4c' };
    badge.textContent = text;
    badge.style.background = colors[kind] || colors.info;
    badge.style.opacity = '1';
    if (kind === 'ok') setTimeout(function () { if (badge) badge.style.opacity = '0'; }, 2500);
  }

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitFor(getter, timeout) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + (timeout || 8000);
      (function poll() {
        var el = null;
        try { el = getter(); } catch (e) { el = null; }
        if (el) return resolve(el);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(poll, 200);
      })();
    });
  }

  function itemIdFromUrl(url) {
    var m = String(url || '').match(/\/reader\/(\d{6,})/) || String(url || '').match(/\/(\d{6,})/);
    return m ? m[1] : '';
  }

  function isReader() { return /\/reader\/\d+/.test(location.pathname); }
  function isBookPage() { return /\/page\/\d+/.test(location.pathname); }

  // 页面内兜底取书籍信息：__INITIAL_STATE__ 里 reader.chapterData 带 bookId
  function deepFind(obj, key, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 8) return '';
    if (obj[key]) return String(obj[key]);
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (v && typeof v === 'object') {
        var r = deepFind(v, key, (depth || 0) + 1);
        if (r) return r;
      }
    }
    return '';
  }

  function bookIdFromPage() {
    try {
      var st = window.__INITIAL_STATE__;
      var found = st && deepFind(st, 'bookId');
      if (found && /^\d{6,}$/.test(found)) return found;
    } catch (e) { /* ignore */ }
    var m = (document.documentElement.innerHTML || '').match(/"bookId"\s*:\s*"(\d{6,})"/);
    return m ? m[1] : '';
  }

  function bookNameFromPage() {
    try {
      var st = window.__INITIAL_STATE__;
      var found = st && (deepFind(st, 'bookName') || deepFind(st, 'book_name'));
      if (found) return found;
    } catch (e) { /* ignore */ }
    var m = (document.documentElement.innerHTML || '').match(/"bookName"\s*:\s*"([^"]{1,})"/);
    return m ? m[1] : '';
  }

  function saveTxt(name, parts) {
    var text = parts.join('\n').replace(/\n{3,}/g, '\n\n');
    var blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (name || 'novel').replace(/[\\/:*?"<>|]/g, '_') + '.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // 逐章下载，onProgress(done,total,ok,fail)；返回 {ok, failed, cancelled}
  async function downloadChapters(name, chapters, onProgress) {
    var parts = [name, ''];
    var ok = 0;
    var failed = [];
    var cancelled = false;
    for (var i = 0; i < chapters.length; i++) {
      if (cancelFlag) { cancelled = true; break; }
      var c = chapters[i];
      if (onProgress) onProgress(i + 1, chapters.length, ok, failed.length);
      parts.push('', c.title || '');
      try {
        var ch = await fetchChapter(c.id);
        parts.push(ch.content);
        ok++;
      } catch (e) {
        try {                                   // 重试一次
          await sleep(300);
          var ch2 = await fetchChapter(c.id);
          parts.push(ch2.content);
          ok++;
        } catch (e2) {
          failed.push(c.title + '：' + e2.message);
          parts.push('[本章下载失败: ' + e2.message + ']');
        }
      }
      await sleep(CHAPTER_GAP_MS);
    }
    saveTxt(name, parts);
    if (failed.length) console.warn('[fq] 下载失败的章节：', failed);
    return { ok: ok, failed: failed, cancelled: cancelled };
  }

  var cancelFlag = false;
  var downloading = false;

  // ==================================================================
  // 进度上报模块（v5.3.0 新增）
  // 原理：官方阅读器切章时会 POST /api/reader/book/update_progress，
  // 我们挂钩 fetch / XMLHttpRequest，把这条请求的完整模板（含 a_bogus、
  // msToken、x-secsdk-csrf-token、body）捕获并存到 localStorage；
  // 之后脚本替换正文加载完一章时，把 body 里的 itemId 换成当前章节，
  // 用同源 fetch（自带登录 Cookie）重放上报。
  // ==================================================================
  var PROGRESS_PATH = '/api/reader/book/update_progress';
  var progressTpl = null;        // {path, msToken, a_bogus, headers:{}, body, itemId}
  var lastReportedItem = '';
  var reportingNow = false;
  var captureMode = false;       // 无模板时先不替换正文，让官方阅读器自己发一次 update_progress

  function tplLoad() {
    if (progressTpl) return progressTpl;
    try {
      var raw = localStorage.getItem('fq_progress_tpl');
      if (raw) progressTpl = JSON.parse(raw);
    } catch (e) { progressTpl = null; }
    // 旧版捕获代码存的是错误字段（itemId 实际为 book_id 且无 parsed），直接丢弃重抓
    if (progressTpl && !progressTpl.parsed) {
      console.warn('[fq-progress] 检测到旧版模板（字段不完整），已丢弃，请重新捕获');
      try { localStorage.removeItem('fq_progress_tpl'); } catch (e) { }
      progressTpl = null;
    }
    return progressTpl;
  }

  function tplSave() {
    try { localStorage.setItem('fq_progress_tpl', JSON.stringify(progressTpl)); } catch (e) { }
  }

  function tplClear() {
    progressTpl = null;
    try { localStorage.removeItem('fq_progress_tpl'); } catch (e) { }
    showBadge('上报模板已清除', 'info');
  }

  function captureProgressRequest(url, body, headers) {
    var u = String(url || '');
    if (u.indexOf(PROGRESS_PATH) === -1) return false;
    try {
      var parsed = new URL(u, location.origin);
      var tpl = {
        path: parsed.pathname,
        msToken: parsed.searchParams.get('msToken') || '',
        a_bogus: parsed.searchParams.get('a_bogus') || '',
        headers: {},
        body: body == null ? '' : String(body)
      };
      if (headers) {
        Object.keys(headers).forEach(function (k) {
          var lk = k.toLowerCase();
          if (lk === 'x-secsdk-csrf-token' || lk === 'content-type') tpl.headers[lk] = headers[k];
        });
      }
      // 解析 body：字段是 snake_case 的 item_id / book_id，不能用“第一个长数字”猜
      var parsedBody = null;
      try { parsedBody = JSON.parse(tpl.body); } catch (e) { }
      var itemIdInBody = parsedBody && parsedBody.item_id ? String(parsedBody.item_id) : '';
      if (!itemIdInBody) {
        var mm = tpl.body.match(/"item_id"\s*:\s*"(\d{6,})"/);
        itemIdInBody = mm ? mm[1] : '';
      }
      if (!itemIdInBody) {
        console.warn('[fq-progress] 捕获到 update_progress 但 body 里没找到 item_id：', tpl.body);
        return false;
      }
      tpl.itemId = itemIdInBody;
      tpl.parsed = parsedBody;
      tpl.bookId = parsedBody && parsedBody.book_id ? String(parsedBody.book_id) : '';
      progressTpl = tpl;
      tplSave();
      console.log('[fq-progress] 已捕获官方进度上报模板，重放功能就绪：', tpl);
      showBadge('已捕获进度上报模板，进度同步已就绪', 'ok');
      // 如果之前处于捕获模式（未替换正文），现在补替换当前章节正文
      if (captureMode) {
        captureMode = false;
        setTimeout(function () {
          var id = itemIdFromUrl(location.pathname);
          if (id && isReader()) runReader(id);
        }, 300);
      }
      return true;
    } catch (e) {
      console.warn('[fq-progress] 捕获异常', e);
      return false;
    }
  }

  function hookNetwork() {
    if (hookNetwork.done) return;
    hookNetwork.done = true;

    // fetch 挂钩
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          if (String(url).indexOf(PROGRESS_PATH) !== -1 && init && init.body) {
            var hs = {};
            if (init.headers) {
              if (typeof init.headers.forEach === 'function') {
                init.headers.forEach(function (v, k) { hs[k] = v; });
              } else { hs = init.headers; }
            }
            captureProgressRequest(url, init.body, hs);
          }
        } catch (e) { /* 不影响原请求 */ }
        return origFetch.apply(this, arguments);
      };
    }

    // XHR 挂钩（站点 axios 默认走 XHR）
    var OrigSRH = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try {
        this.__fq_headers = this.__fq_headers || {};
        this.__fq_headers[k] = v;
      } catch (e) { }
      return OrigSRH.apply(this, arguments);
    };
    var OrigOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__fq_url = url; } catch (e) { }
      return OrigOpen.apply(this, arguments);
    };
    var OrigSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (this.__fq_url && String(this.__fq_url).indexOf(PROGRESS_PATH) !== -1) {
          captureProgressRequest(this.__fq_url, body, this.__fq_headers);
        }
      } catch (e) { /* 不影响原请求 */ }
      return OrigSend.apply(this, arguments);
    };

    console.log('[fq-progress] 网络挂钩已安装，等待官方 update_progress 请求…');
  }

  function isLoggedIn() {
    return /(?:^|;\s*)sessionid=/.test(document.cookie);
  }

  function msTokenFromCookie() {
    var m = document.cookie.match(/(?:^|;\s*)msToken=([^;]+)/);
    return m ? m[1] : '';
  }

  // 章节序号：用目录缓存推算。offset 兼容 index 的 0/1 基准——
  // 用捕获模板里 index 与其章节在目录中位置的差值来对齐
  var dirCache = {};   // bookId -> {ids:[itemId...], ts}

  async function chapterIndexFor(bookId, itemId, tplItemId, tplIndex) {
    if (!bookId) return null;
    var cached = dirCache[bookId];
    if (!cached || Date.now() - cached.ts > 10 * 60 * 1000) {
      try {
        var list = await fetchDirectory(bookId);
        dirCache[bookId] = { ids: list.map(function (c) { return String(c.id); }), ts: Date.now() };
        cached = dirCache[bookId];
      } catch (e) {
        console.warn('[fq-progress] 获取目录失败，无法计算章节序号：', e.message);
        return null;
      }
    }
    var pos = cached.ids.indexOf(String(itemId));
    if (pos === -1) return null;
    var offset = 0;
    if (tplItemId && isFinite(Number(tplIndex))) {
      var tplPos = cached.ids.indexOf(String(tplItemId));
      if (tplPos !== -1) offset = Number(tplIndex) - (tplPos + 1);
    }
    return pos + 1 + offset;
  }

  async function tryReport(url, headers, body) {
    var h = {
      'accept': 'application/json, text/plain, */*',
      'content-type': (headers && headers['content-type']) || 'application/json'
    };
    if (headers && headers['x-secsdk-csrf-token']) {
      h['x-secsdk-csrf-token'] = headers['x-secsdk-csrf-token'];
    }
    var res = await fetch(url, { method: 'POST', headers: h, body: body, credentials: 'include' });
    var j = null;
    try { j = await res.json(); } catch (e) { }
    return { http: res.status, code: j ? j.code : null, msg: j ? (j.message || j.msg || '') : '' };
  }

  // 零模板模式：不依赖捕获，直接按已知的官方 body 格式构造请求。
  // 已验证该接口不校验 x-secsdk-csrf-token；a_bogus 可能也不强制，
  // 所以尝试链：带 cookie msToken → 完全裸发。
  async function reportZeroTemplate(itemId) {
    var bookId = currentBook && currentBook.id;
    if (!bookId) {
      console.warn('[fq-progress] 零模板模式：没有 book_id，无法上报');
      return false;
    }
    var idx = await chapterIndexFor(String(bookId), itemId, '', null);
    var bodyObj = {
      book_id: String(bookId),
      item_id: String(itemId),
      read_progress: 0,
      index: idx == null ? 1 : idx,
      read_timestamp: String(Math.floor(Date.now() / 1000)),
      genre_type: 0
    };
    var body = JSON.stringify(bodyObj);
    var token = msTokenFromCookie();
    var attempts = [
      '/api/reader/book/update_progress' + (token ? '?msToken=' + encodeURIComponent(token) : ''),
      '/api/reader/book/update_progress'
    ];
    for (var i = 0; i < attempts.length; i++) {
      try {
        var r = await tryReport(attempts[i], {}, body);
        console.log('[fq-progress] 零模板上报尝试 #' + (i + 1) + ' →', r, 'body=', body);
        if (r.http === 200 && (r.code === 0 || r.code === '0')) {
          lastReportedItem = itemId;
          showBadge('阅读进度已同步到账号（零模板模式）', 'ok');
          return true;
        }
      } catch (e) {
        console.warn('[fq-progress] 零模板尝试 #' + (i + 1) + ' 异常：', e);
      }
    }
    return false;
  }

  // 多重降级：1) cookie msToken + 捕获的 a_bogus；2) 不带 a_bogus；3) 完全按捕获时的 URL 重放
  async function reportProgress(itemId) {
    if (reportingNow) return false;
    // 注意：sessionid 等登录 Cookie 是 HttpOnly，document.cookie 读不到，
    // 不能据此判断登录态；同源 fetch 会自动携带全部 Cookie（含 HttpOnly），
    // 所以这里不做前置拦截，直接尝试上报，以响应结果为准。
    if (itemId === lastReportedItem) return true;
    var tpl = tplLoad();
    if (!tpl) {
      // 无模板 → 零模板模式直接构造请求，不再强求先捕获
      console.log('[fq-progress] 无模板，使用零模板模式直接上报');
      var ok = await reportZeroTemplate(itemId);
      if (!ok) showBadge('进度同步失败（零模板）。若多次失败：油猴菜单「重新捕获模板」后用官方界面翻一页', 'warn');
      return ok;
    }
    reportingNow = true;
    showBadge('正文加载完成，进度同步中…', 'info');
    try {
      // 正确构造 body：只改 item_id / book_id / index / read_timestamp，
      // 其余字段（read_progress、genre_type 等）沿用官方模板
      var parsed = null;
      try { parsed = JSON.parse(tpl.body); } catch (e) { }
      var newBody;
      if (parsed && parsed.item_id) {
        parsed.item_id = String(itemId);
        parsed.read_timestamp = String(Math.floor(Date.now() / 1000));
        if (parsed.read_progress != null) parsed.read_progress = 0;
        var bookId = (currentBook && currentBook.id) || tpl.bookId;
        if (bookId) parsed.book_id = String(bookId);
        var idx = await chapterIndexFor(parsed.book_id, itemId, tpl.itemId, parsed.index);
        if (idx != null) parsed.index = idx;
        newBody = JSON.stringify(parsed);
      } else {
        // 兜底：极端情况下按字符串整体替换（item_id 优先）
        newBody = tpl.body.split('"item_id":"' + tpl.itemId + '"').join('"item_id":"' + itemId + '"')
                          .split(tpl.itemId).join(itemId);
      }
      var token = msTokenFromCookie() || tpl.msToken;
      var attempts = [];
      attempts.push(tpl.path + '?msToken=' + encodeURIComponent(token) + (tpl.a_bogus ? '&a_bogus=' + tpl.a_bogus : ''));
      attempts.push(tpl.path + '?msToken=' + encodeURIComponent(token));
      if (tpl.msToken && tpl.msToken !== token) {
        attempts.push(tpl.path + '?msToken=' + encodeURIComponent(tpl.msToken) + (tpl.a_bogus ? '&a_bogus=' + tpl.a_bogus : ''));
      }

      for (var i = 0; i < attempts.length; i++) {
        try {
          var r = await tryReport(attempts[i], tpl.headers, newBody);
          console.log('[fq-progress] 上报尝试 #' + (i + 1) + ' →', r);
          if (r.http === 200 && (r.code === 0 || r.code === '0')) {
            lastReportedItem = itemId;
            showBadge('阅读进度已同步到账号', 'ok');
            return true;
          }
          if (r.http === 200 && r.code != null && r.code !== 0 && i === 0) {
            // 第一种被业务码拒绝，试试无 a_bogus
            continue;
          }
        } catch (e) {
          console.warn('[fq-progress] 尝试 #' + (i + 1) + ' 异常：', e);
        }
      }
      showBadge('进度同步失败，详情看控制台', 'warn');
      return false;
    } finally {
      reportingNow = false;
    }
  }

  // ------------------------------------------------------------------
  // 阅读页
  // ------------------------------------------------------------------
  var readerToken = 0;
  var currentBook = null;          // {id, name} 从正文响应里拿到，用于「下载全文」

  function injectStyle() {
    if (document.getElementById('fq-style')) return;
    var s = document.createElement('style');
    s.id = 'fq-style';
    s.textContent = [
      // 只压掉站点 hover 弹层（二维码），按钮本身要可点，所以不设 pointer-events:none
      '.reader-toolbar-item-download:hover::before,',
      '.reader-toolbar-item-download:hover::after{display:none !important;content:none !important;}',
      '.reader-toolbar-item-download [class*="qrcode"],',
      '.reader-toolbar-item-download [class*="qr-code"],',
      '.reader-toolbar-item-download [class*="qrCode"],',
      '.reader-toolbar-item-download [class*="tooltip"],',
      '.reader-toolbar-item-download [class*="popover"]{display:none !important;}',
      '#fq-dl-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;',
      'width:100%;height:100%;gap:2px;color:#333;cursor:pointer;user-select:none;}',
      '#fq-dl-btn .fq-dl-text{font-size:11px;line-height:1.1;white-space:nowrap;}',
      '.fq-loading{display:flex;align-items:center;justify-content:center;gap:8px;',
      'padding:120px 0;color:#9a9a9a;font-size:14px;letter-spacing:.5px;}',
      '.fq-loading .fq-spin{width:14px;height:14px;border:2px solid #e2e2e2;border-top-color:#ff6a00;',
      'border-radius:50%;animation:fq-spin .8s linear infinite;}',
      '@keyframes fq-spin{to{transform:rotate(360deg);}}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  var dlState = { label: '下载全文', color: '#333' };

  function setDlLabel(text, color) {
    dlState.label = text;
    dlState.color = color || '#333';
    var el = document.querySelector('#fq-dl-btn .fq-dl-text');
    if (el) { el.textContent = text; el.style.color = dlState.color; }
    var box = document.querySelector('#fq-dl-btn');
    if (box) box.style.color = dlState.color;
  }

  // 把站点「下载APP」项换成我们自己的「下载全文」按钮
  function hijackDownloadItem() {
    var item = document.querySelector('.reader-toolbar-item-download');
    if (!item) return null;
    if (item.querySelector('#fq-dl-btn')) return item;

    item.innerHTML = '';                 // 清掉站点 svg / 轮播文案 / 弹层触发器
    item.style.pointerEvents = 'auto';
    item.style.cursor = 'pointer';

    var btn = document.createElement('div');
    btn.id = 'fq-dl-btn';
    btn.title = '下载本书全文';
    btn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4 19h16"/></svg>' +
      '<div class="fq-dl-text"></div>';
    btn.querySelector('.fq-dl-text').textContent = dlState.label;
    btn.querySelector('.fq-dl-text').style.color = dlState.color;

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      onDownloadClick();
    });
    // 断掉站点的 hover 委托（二维码就是这个触发的）
    ['mouseenter', 'mouseover', 'pointerover'].forEach(function (t) {
      item.addEventListener(t, function (e) { e.stopPropagation(); }, true);
    });

    item.appendChild(btn);
    return item;
  }

  function ensureHijack() {
    var item = document.querySelector('.reader-toolbar-item-download');
    if (item && !item.querySelector('#fq-dl-btn')) hijackDownloadItem();
  }

  async function ensureBook() {
    if (currentBook && currentBook.id) return currentBook;

    // 1) 优先用后端正文接口给的 book_id
    var id = itemIdFromUrl(location.pathname);
    if (!id) throw new Error('无法识别当前章节');
    var ch = await fetchChapter(id);
    if (ch.bookId) {
      currentBook = { id: ch.bookId, name: ch.bookName || '' };
      return currentBook;
    }
    // 2) 老后端没返回时，从页面 __INITIAL_STATE__ / HTML 里兜底解析
    var bid = bookIdFromPage();
    if (bid) {
      currentBook = { id: bid, name: bookNameFromPage() || ch.bookName || '' };
      return currentBook;
    }
    throw new Error('没有拿到书籍 ID（请更新后端，或在详情页用面板下载）');
  }

  async function onDownloadClick() {
    if (downloading) { cancelFlag = true; setDlLabel('取消中…', '#ef6c00'); return; }
    downloading = true;
    cancelFlag = false;
    try {
      setDlLabel('准备中…', '#ef6c00');
      var book = await ensureBook();
      var chapters = await fetchDirectory(book.id);
      showBadge('开始下载《' + (book.name || '本书') + '》共 ' + chapters.length + ' 章', 'info');
      var res = await downloadChapters(book.name || book.id, chapters, function (done, total) {
        setDlLabel(done + '/' + total, '#ef6c00');
      });
      setDlLabel(res.cancelled ? '已取消' : '已保存', res.cancelled ? '#ef6c00' : '#2e7d32');
      showBadge(res.cancelled ? '已取消，保存了 ' + res.ok + ' 章'
                              : '下载完成：' + res.ok + ' 章' + (res.failed.length ? '，失败 ' + res.failed.length : ''),
                res.failed.length ? 'warn' : 'ok');
      setTimeout(function () { setDlLabel('下载全文', '#333'); }, 4000);
    } catch (e) {
      setDlLabel('失败', '#c62828');
      showBadge('下载失败：' + e.message, 'err');
      setTimeout(function () { setDlLabel('下载全文', '#333'); }, 4000);
    } finally {
      downloading = false;
      cancelFlag = false;
    }
  }

  var CONTENT_ANCHOR = '<span data-fq-anchor style="display:none"></span>';

  function getBox() { return document.querySelector('.muye-reader-content'); }

  // 切章瞬间先清空上一章内容，避免“新章节还没到、旧正文还在”的闪回
  function showLoading() {
    var box = getBox();
    if (!box) return;
    box.innerHTML = '<div class="fq-loading"><span class="fq-spin"></span>正文加载中…</div>';
  }

  function applyContent(html) {
    var box = getBox();
    if (!box) return false;
    box.classList.remove('noselect');
    box.innerHTML = html;
    return true;
  }

  // 加载期间：站点若重新渲染正文区，把占位重新写回去（最多守 8 秒）
  function guardLoading(token) {
    var start = Date.now();
    var timer = setInterval(function () {
      if (token !== readerToken) { clearInterval(timer); return; }
      var box = getBox();
      if (box && !box.querySelector('.fq-loading') && !box.querySelector('[data-fq-anchor]')) {
        box.innerHTML = '<div class="fq-loading"><span class="fq-spin"></span>正文加载中…</div>';
      }
      if (Date.now() - start > 8000) clearInterval(timer);
    }, 150);
    return function () { clearInterval(timer); };
  }

  // 站点自己的渲染可能在稍后覆盖我们的内容，短时看守并补写
  function guardApply(html, token) {
    var start = Date.now();
    var timer = setInterval(function () {
      if (token !== readerToken) { clearInterval(timer); return; }
      var box = getBox();
      if (box && !box.querySelector('[data-fq-anchor]')) {
        box.classList.remove('noselect');
        box.innerHTML = html;
        cleanOverlays();
      }
      if (Date.now() - start > 2500) clearInterval(timer);
    }, 200);
  }

  async function runReader(itemId) {
    var token = ++readerToken;
    showLoading();                               // 先清空旧章内容
    var box = await waitFor(getBox, 10000);
    if (!box) { showBadge('未找到正文容器，页面结构可能已变', 'err'); return; }
    if (token === readerToken) showLoading();     // 容器可能刚被重建
    var stopLoading = guardLoading(token);

    showBadge('正文加载中…', 'info');
    try {
      var ch = await fetchChapter(itemId);
      stopLoading();
      if (token !== readerToken) return;           // 已切章，丢弃过期结果

      var html = CONTENT_ANCHOR + textToHtml(ch.content);
      applyContent(html);
      guardApply(html, token);
      cleanOverlays();
      if (ch.bookId) {
        currentBook = { id: ch.bookId, name: ch.bookName };
      } else if (!currentBook) {
        var bid = bookIdFromPage();
        if (bid) currentBook = { id: bid, name: bookNameFromPage() || ch.bookName || '' };
      }

      var extra = ch.preview ? '（后端仅返回试读）' : '';
      showBadge('已替换正文 ' + ch.content.length + ' 字' + extra, ch.preview ? 'warn' : 'ok');
      document.title = document.title.replace(/_?在线免费阅读_番茄小说官网$/, '');

      // v5.3.0：正文加载成功后，延迟一下向官方重放进度上报
      // （官方阅读器切章自己也会发 update_progress，挂钩会顺带捕获模板）
      setTimeout(function () {
        if (token === readerToken) reportProgress(itemId);
      }, 1500);
    } catch (e) {
      stopLoading();
      showBadge('正文加载失败：' + e.message, 'err');
      var eb = getBox();
      if (eb) {
        eb.innerHTML = '<div class="fq-loading" style="color:#c62828">正文加载失败：' +
                       escapeHtml(e.message) + '</div>';
      }
    }
  }

  var readerWatching = false;

  function watchReader() {
    // 切章会改变 pathname 从而再次 boot()，这里只允许初始化一次，
    // 否则每切一章就多一个 setInterval + 多一次重复请求
    if (readerWatching) return;
    readerWatching = true;

    var lastUrl = '';
    injectStyle();
    hijackDownloadItem();
    function tick() {
      if (!isReader()) return;
      ensureHijack();
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      // 捕获模式：不替换正文，让官方阅读器自己发 update_progress 供挂钩捕获
      if (captureMode) {
        showBadge('进度同步初始化：请用官方界面正常翻一页以捕获上报模板（本章为官方渲染）', 'info');
        return;
      }
      var id = itemIdFromUrl(location.pathname);
      if (id) runReader(id);
    }
    tick();
    setInterval(tick, 250);                     // 轮询要快，切章时才能立刻清屏

    // 点「上一章/下一章」时先清空，别等下一轮轮询
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (!t.closest('.muye-reader-btns, .chapter-btn, .btn-next-relative-container')) return;
      showLoading();
    }, true);
  }

  // ------------------------------------------------------------------
  // 详情页：悬浮面板「下载全本」
  // ------------------------------------------------------------------
  var panel = null;

  function panelStatus(text, color) {
    if (!panel) return;
    var el = panel.querySelector('.fq-status');
    if (el) { el.textContent = text; el.style.color = color || '#666'; }
  }

  function bookName() {
    var h1 = document.querySelector('.page-header-info .info-name h1') ||
             document.querySelector('.info-name h1') || document.querySelector('h1');
    var name = h1 ? h1.textContent.trim() : (document.title || 'novel');
    return name.replace(/[\\/:*?"<>|]/g, '_');
  }

  function collectChapters() {
    var anchors = Array.prototype.slice.call(document.querySelectorAll('.chapter a[href*="/reader/"]'));
    if (!anchors.length) {
      anchors = Array.prototype.slice.call(document.querySelectorAll('a[href*="/reader/"]'))
        .filter(function (a) { return !a.closest('.info-last') && !a.closest('.page-header-info'); });
    }
    var seen = {};
    var list = [];
    anchors.forEach(function (a) {
      var id = itemIdFromUrl(a.getAttribute('href'));
      if (!id || seen[id]) return;
      seen[id] = 1;
      list.push({ id: id, title: (a.textContent || '').replace(/\s+/g, ' ').trim() });
    });
    return list;
  }

  function ensurePanel() {
    if (panel && document.body && document.body.contains(panel)) return panel;

    panel = document.createElement('div');
    panel.id = 'fq-panel';
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'width:230px', 'padding:12px 14px', 'border-radius:10px',
      'background:#fff', 'color:#222', 'box-shadow:0 8px 28px rgba(0,0,0,.22)',
      'font:13px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
      'border:1px solid rgba(0,0,0,.06)'
    ].join(';');

    var head = document.createElement('div');
    head.textContent = '番茄全文助手';
    head.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:6px';

    var status = document.createElement('div');
    status.className = 'fq-status';
    status.style.cssText = 'font-size:12px;color:#666;margin-bottom:8px;word-break:break-all';
    status.textContent = '准备中…';

    var btn = document.createElement('button');
    btn.className = 'fq-download-btn';
    btn.textContent = '下载全本';
    btn.style.cssText = 'width:100%;padding:7px 0;border:0;border-radius:6px;cursor:pointer;' +
                        'background:#ff6a00;color:#fff;font-size:13px;font-weight:600';
    btn.addEventListener('click', function () {
      if (downloading) { cancelFlag = true; btn.textContent = '正在取消…'; return; }
      downloadAllFromPage(btn);
    });

    var tplRow = document.createElement('div');
    tplRow.style.cssText = 'margin-top:6px;display:flex;gap:6px';
    var tplBtn = document.createElement('button');
    tplBtn.textContent = '清除上报模板';
    tplBtn.title = '删除捕获的 update_progress 模板（localStorage: fq_progress_tpl）';
    tplBtn.style.cssText = 'flex:1;padding:5px 0;border:1px solid #ddd;border-radius:6px;' +
                           'background:#fafafa;color:#666;font-size:12px;cursor:pointer';
    tplBtn.addEventListener('click', tplClear);
    tplRow.appendChild(tplBtn);

    panel.appendChild(head);
    panel.appendChild(status);
    panel.appendChild(btn);
    panel.appendChild(tplRow);
    document.body.appendChild(panel);
    return panel;
  }

  async function downloadAllFromPage(btn) {
    var chapters = collectChapters();
    if (!chapters.length) { panelStatus('未找到章节列表，请等页面加载完再点', '#c62828'); return; }
    downloading = true;
    cancelFlag = false;
    btn.disabled = true;
    try {
      var res = await downloadChapters(bookName(), chapters, function (done, total, ok, fail) {
        panelStatus('下载中 ' + done + '/' + total + '（成功 ' + ok + '，失败 ' + fail + '）');
      });
      panelStatus('完成：成功 ' + res.ok + ' 章' + (res.failed.length ? '，失败 ' + res.failed.length + ' 章' : ''),
                  res.failed.length ? '#ef6c00' : '#2e7d32');
      showBadge('下载完成：成功 ' + res.ok + ' 章' + (res.failed.length ? '，失败 ' + res.failed.length + ' 章' : ''),
                res.failed.length ? 'warn' : 'ok');
    } catch (e) {
      panelStatus('下载失败：' + e.message, '#c62828');
    } finally {
      downloading = false;
      cancelFlag = false;
      btn.disabled = false;
      btn.textContent = '下载全本';
    }
  }

  var pageWatching = false;

  function watchBookPage() {
    ensurePanel();
    if (pageWatching) return;
    pageWatching = true;
    var tries = 0;
    (function refresh() {
      var n = collectChapters().length;
      if (panel && !downloading) panelStatus(n ? '共 ' + n + ' 章，可下载' : '正在读取章节列表…', n ? '#2e7d32' : '#666');
      if (!n && tries++ < 30) setTimeout(refresh, 500);
    })();
  }

  // ------------------------------------------------------------------
  // 入口
  // ------------------------------------------------------------------
  function removePanel() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
  }

  function boot() {
    hookNetwork();                  // 尽早挂钩，捕获官方 update_progress
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('重新捕获进度上报模板', function () {
        tplClear();
        location.reload();
      });
    }
    if (isReader()) {
      removePanel();
      // v5.3.1：零模板模式可直接构造上报，不再强制先捕获模板；
      // 捕获模式仅在零模板被服务端拒绝时通过油猴菜单手动进入
      captureMode = false;
      watchReader();
    } else if (isBookPage()) {
      watchBookPage();
    } else {
      removePanel();
    }
  }

  boot();

  var lastPath = location.pathname;
  setInterval(function () {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    boot();
  }, 600);
})();
