// ==UserScript==
// @name             番茄全文在线免费读
// @version          5.7.4-progress
// @description       自建后端替换番茄网页正文：锁章全文、正文图片、阅读页「下载全文」、详情页一键下载全本；v5.7.4：语音朗读防中断、断点续读
// @description:zh-cn 自建后端替换番茄网页正文：锁章全文、正文图片、阅读页「下载全文」、详情页一键下载全本；v5.7.4：语音朗读防中断、断点续读
// @description:en    Replace fanqienovel web content with a self-hosted API; locked chapters, images, full-book download; v5.7.4: TTS anti-drop and resume
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
    // fetch 回退也要有超时，否则后端挂起会让正文区永久停在 loading（表现为空白页）
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT) : 0;
    return fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function (e) {
        if (timer) clearTimeout(timer);
        if (e && e.name === 'AbortError') throw new Error('请求超时');
        throw e;
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
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var IMG_MARK_RE = /\[fqimg\]([\s\S]*?)\[\/fqimg\]/gi;
  var RAW_IMG_RE = /<img\b[^>]*>/gi;

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  }

  function normalizeImageUrl(raw) {
    var u = decodeEntities(raw).replace(/[\r\n\t]/g, '').trim();
    if (!u) return '';
    if (/^\/\//.test(u)) u = location.protocol + u;
    if (/^\/[^/]/.test(u)) u = location.origin + u;
    if (!/^(https?:|data:image\/)/i.test(u)) return '';
    return u;
  }

  function urlFromRawImg(tag) {
    var m = String(tag).match(
      /\b(src|data-src|data-original|data-lazy-src|data-url|data-source|original|lazy-src|srcset|data-srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
    );
    if (!m) return '';
    var val = m[2] || m[3] || m[4] || '';
    if (/srcset$/i.test(m[1])) {
      val = (val.split(',')[0] || '').trim().split(/\s+/)[0] || '';
    }
    return val;
  }

  function imgTag(url) {
    return '<div class="fq-img"><img src="' + escapeAttr(url) +
      '" alt="正文图片" loading="lazy" data-fq-img></div>';
  }

  // 图片标记 / 后端直接返回的 <img> 统一渲染；其它文本仍然严格转义
  function renderInline(text) {
    var src = String(text).replace(RAW_IMG_RE, function (tag) {
      var u = urlFromRawImg(tag);
      return u ? '[fqimg]' + u + '[/fqimg]' : '';
    });
    var out = '';
    var last = 0;
    var m;
    IMG_MARK_RE.lastIndex = 0;
    while ((m = IMG_MARK_RE.exec(src)) !== null) {
      out += escapeHtml(src.slice(last, m.index));
      var url = normalizeImageUrl(m[1]);
      out += url ? imgTag(url) : '[图片地址无效]';
      last = m.index + m[0].length;
    }
    out += escapeHtml(src.slice(last));
    return out;
  }

  function stripImagesForCheck(text) {
    IMG_MARK_RE.lastIndex = 0;
    RAW_IMG_RE.lastIndex = 0;
    return String(text).replace(IMG_MARK_RE, '').replace(RAW_IMG_RE, '')
      .replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  }

  function textToHtml(text) {
    return String(text).split(/\r?\n/)
      .map(function (line) { return line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''); })
      .filter(function (line) { return line.length > 0; })
      .map(function (line) {
        var html = renderInline(line);
        // 整行只有有效图片时不套 <p>，避免浏览器自动拆段
        var onlyImage = stripImagesForCheck(line) === '' && html.indexOf('[图片地址无效]') === -1;
        return onlyImage ? html : '<p>' + html + '</p>';
      })
      .join('');
  }

  // TXT 下载无法嵌图，保留成可读的图片地址
  function contentToTxt(text) {
    RAW_IMG_RE.lastIndex = 0;
    IMG_MARK_RE.lastIndex = 0;
    return String(text)
      .replace(RAW_IMG_RE, function (tag) {
        var u = normalizeImageUrl(urlFromRawImg(tag));
        return u ? '[fqimg]' + u + '[/fqimg]' : '';
      })
      .replace(IMG_MARK_RE, function (_, url) {
        return '【图片】' + (normalizeImageUrl(url) || url);
      });
  }

  function countImages(text) {
    var n = 0;
    IMG_MARK_RE.lastIndex = 0;
    RAW_IMG_RE.lastIndex = 0;
    while (IMG_MARK_RE.exec(text) !== null) n++;
    while (RAW_IMG_RE.exec(text) !== null) n++;
    return n;
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
        parts.push(contentToTxt(ch.content));
        ok++;
      } catch (e) {
        try {                                   // 重试一次
          await sleep(300);
          var ch2 = await fetchChapter(c.id);
          parts.push(contentToTxt(ch2.content));
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
  // 进度上报模块：不捕获官方请求模板，直接构造 body 用同源 fetch 上报。
  // 同源 fetch 会自动携带全部登录 Cookie（含 HttpOnly 的 sessionid），
  // 因此无需捕获 a_bogus / x-secsdk-csrf-token 等模板参数。
  // ==================================================================
  var PROGRESS_PATH = '/api/reader/book/update_progress';
  var lastReportedItem = '';
  var reportingNow = false;

  function msTokenFromCookie() {
    var m = document.cookie.match(/(?:^|;\s*)msToken=([^;]+)/);
    return m ? m[1] : '';
  }

  // 章节序号：用目录缓存推算，item_id 在目录中的位置即 index
  var dirCache = {};   // bookId -> {ids:[itemId...], ts}

  async function chapterIndexFor(bookId, itemId) {
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
    return pos === -1 ? null : pos + 1;
  }

  async function tryReport(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      credentials: 'include',   // 关键：同源 fetch 自动携带登录 Cookie（含 HttpOnly）
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json'
      },
      body: body
    });
    var j = null;
    try { j = await res.json(); } catch (e) { }
    return { http: res.status, code: j ? j.code : null, msg: j ? (j.message || j.msg || '') : '' };
  }

  // 直接用同源 fetch 上报，不依赖任何捕获模板，只上报一次，失败即放弃。
  async function reportProgress(itemId) {
    if (reportingNow) return false;
    // sessionid 等登录 Cookie 是 HttpOnly，document.cookie 读不到，
    // 不能据此判断登录态；同源 fetch 会自动携带全部 Cookie，以响应结果为准。
    if (itemId === lastReportedItem) return true;
    var bookId = currentBook && currentBook.id;
    if (!bookId) {
      console.warn('[fq-progress] 没有 book_id，无法上报');
      return false;
    }
    reportingNow = true;
    try {
      var idx = await chapterIndexFor(String(bookId), itemId);
      var body = JSON.stringify({
        book_id: String(bookId),
        item_id: String(itemId),
        read_progress: 0,
        index: idx == null ? 1 : idx,
        read_timestamp: String(Math.floor(Date.now() / 1000)),
        genre_type: 0
      });
      var token = msTokenFromCookie();
      var url = PROGRESS_PATH + (token ? '?msToken=' + encodeURIComponent(token) : '');
      try {
        var r = await tryReport(url, body);
        console.log('[fq-progress] 上报 →', r, 'body=', body);
        if (r.http === 200 && (r.code === 0 || r.code === '0')) {
          lastReportedItem = itemId;
          showBadge('阅读进度已同步到账号', 'ok');
          return true;
        }
      } catch (e) {
        console.warn('[fq-progress] 上报异常：', e);
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
      '@keyframes fq-spin{to{transform:rotate(360deg);}}',
      '.muye-reader-content .fq-img{text-align:center;margin:18px 0;}',
      '.muye-reader-content img[data-fq-img]{display:block;max-width:100% !important;',
      'width:auto !important;height:auto !important;margin:0 auto;border-radius:4px;}',
      '.muye-reader-content .fq-img-error{color:#c62828;font-size:12px;line-height:1.5;',
      'word-break:break-all;padding:8px 0;}',
      '#fq-autoread{position:fixed;right:16px;top:78px;z-index:2147483647;width:172px;',
      'padding:10px 12px;border-radius:10px;background:#fff;color:#222;',
      'border:1px solid rgba(0,0,0,.06);box-shadow:0 6px 22px rgba(0,0,0,.18);',
      'font:12px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;',
      'user-select:none;}',
      '#fq-autoread .fq-ar-head{display:flex;align-items:center;justify-content:space-between;',
      'gap:8px;font-weight:600;font-size:12px;margin-bottom:6px;}',
      '#fq-autoread button{cursor:pointer;border:1px solid #ddd;background:#fafafa;color:#444;',
      'border-radius:5px;padding:4px 6px;font-size:12px;}',
      '#fq-autoread .fq-ar-toggle{width:100%;padding:6px 0;background:#ff6a00;color:#fff;',
      'border-color:#ff6a00;font-weight:600;}',
      '#fq-autoread .fq-ar-toggle.on{background:#2e7d32;border-color:#2e7d32;}',
      '#fq-autoread .fq-ar-row{display:flex;gap:6px;align-items:center;margin-top:8px;}',
      '#fq-autoread .fq-ar-row input[type=range]{flex:1;min-width:0;accent-color:#ff6a00;}',
      '#fq-autoread .fq-speed-val{min-width:42px;text-align:right;font-weight:600;',
      'font-variant-numeric:tabular-nums;color:#ff6a00;font-size:11px;}',
      '#fq-autoread .fq-ar-hint{color:#888;font-size:11px;margin-top:6px;}',
      '#fq-autoread button:disabled{opacity:.5;cursor:not-allowed;}',
      '#fq-autoread .fq-tts-box{margin-top:8px;padding-top:8px;border-top:1px solid #eee;}',
      '#fq-autoread .fq-tts-title{font-weight:600;font-size:12px;margin-bottom:6px;}',
      '#fq-autoread .fq-tts-toggle{width:100%;padding:6px 0;background:#1976d2;color:#fff;',
      'border-color:#1976d2;font-weight:600;}',
      '#fq-autoread .fq-tts-toggle.on{background:#c62828;border-color:#c62828;}',
      '#fq-autoread .fq-tts-pause{width:100%;margin-top:6px;}',
      '#fq-autoread .fq-tts-row{display:flex;gap:6px;align-items:center;margin-top:6px;}',
      '#fq-autoread .fq-tts-row input[type=range]{flex:1;min-width:0;accent-color:#1976d2;}',
      '#fq-autoread .fq-tts-row .fq-speed-val{color:#1976d2;}',
      '#fq-autoread .fq-tts-voice-label{font-size:11px;color:#666;margin-top:8px;}',
      '#fq-autoread .fq-tts-voice{width:100%;margin-top:3px;padding:4px 6px;font-size:12px;',
      'border:1px solid #ddd;border-radius:5px;background:#fff;color:#444;}',
      '#fq-autoread .fq-tts-status{color:#888;font-size:11px;margin-top:6px;}',
      '#fq-autoread .fq-ar-collapse{padding:2px 6px !important;font-size:11px !important;',
      'line-height:1.2;flex:0 0 auto;}',
      '#fq-autoread .fq-ar-rail{display:none;}',
      '#fq-autoread.fq-collapsed{right:0;top:50%;transform:translateY(-50%);width:34px;',
      'padding:8px 0;border-radius:10px 0 0 10px;box-shadow:-4px 0 16px rgba(0,0,0,.18);}',
      '#fq-autoread.fq-collapsed .fq-ar-head,',
      '#fq-autoread.fq-collapsed .fq-ar-body{display:none;}',
      '#fq-autoread.fq-collapsed .fq-ar-rail{display:flex;flex-direction:column;',
      'align-items:center;gap:8px;}',
      '#fq-autoread .fq-ar-rail-btn{width:26px;height:86px;padding:0 !important;border:0 !important;',
      'background:linear-gradient(180deg,#ff6a00,#1976d2) !important;color:#fff !important;',
      'border-radius:6px 0 0 6px;font-size:12px !important;line-height:1.2;',
      'writing-mode:vertical-rl;letter-spacing:2px;}',
      '#fq-autoread .fq-ar-rail-dots{display:flex;flex-direction:column;gap:5px;align-items:center;cursor:pointer;}',
      '#fq-autoread .fq-ar-rail-dot{width:8px;height:8px;border-radius:50%;background:#ddd;}',
      '#fq-autoread .fq-ar-rail-dot.fq-dot-ar.ar-on{background:#ff6a00;',
      'box-shadow:0 0 0 2px rgba(255,106,0,.2);}',
      '#fq-autoread .fq-ar-rail-dot.fq-dot-tts.tts-on{background:#1976d2;',
      'box-shadow:0 0 0 2px rgba(25,118,210,.2);}',
      '.muye-reader-content p.fq-speaking{background:rgba(255,106,0,.12);',
      'border-radius:4px;box-shadow:0 0 0 4px rgba(255,106,0,.12);}'
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
  var lastRender = { itemId: '', html: '' };   // 最近一次成功渲染的正文，用于稳态自愈

  function getBox() { return document.querySelector('.muye-reader-content'); }

  // 切章瞬间先清空上一章内容，避免“新章节还没到、旧正文还在”的闪回
  function showLoading() {
    var box = getBox();
    if (!box) return;
    box.innerHTML = '<div class="fq-loading"><span class="fq-spin"></span>正文加载中…</div>';
  }

  // 图片加载失败时先尝试用 GM 跨域请求取回（绕开 CSP / 防盗链），再给提示
  function decorateImages() {
    var box = getBox();
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('img[data-fq-img]'), function (img) {
      if (img.getAttribute('data-fq-bound')) return;
      img.setAttribute('data-fq-bound', '1');

      function showTip() {
        var wrap = img.parentNode;
        if (!wrap || wrap.querySelector('.fq-img-error')) return;
        var tip = document.createElement('div');
        tip.className = 'fq-img-error';
        tip.textContent = '图片加载失败：' + img.getAttribute('src');
        wrap.appendChild(tip);
        img.style.display = 'none';
      }

      img.addEventListener('error', function () {
        var src = img.getAttribute('src') || '';
        if (img.getAttribute('data-fq-fetched') || !gmRequest || !/^https?:\/\//i.test(src)) {
          showTip();
          return;
        }
        img.setAttribute('data-fq-fetched', '1');
        try {
          gmRequest({
            method: 'GET',
            url: src,
            responseType: 'blob',
            timeout: 15000,
            onload: function (res) {
              try {
                var blob = res.response && res.response.size != null
                  ? res.response
                  : new Blob([res.responseText || res.response], { type: 'image/*' });
                img.src = URL.createObjectURL(blob);
              } catch (e) { showTip(); }
            },
            onerror: showTip,
            ontimeout: showTip
          });
        } catch (e) { showTip(); }
      });
    });
  }

  function applyContent(html) {
    var box = getBox();
    if (!box) return false;
    box.classList.remove('noselect');
    box.innerHTML = html;
    decorateImages();
    return true;
  }

  // 加载期间：站点若重新渲染正文区，把占位重新写回去。
  // 覆盖整个 fetch 超时窗口（FETCH_TIMEOUT），避免慢加载时露出空白。
  function guardLoading(token) {
    var start = Date.now();
    var timer = setInterval(function () {
      if (token !== readerToken) { clearInterval(timer); return; }
      var box = getBox();
      if (box && !box.querySelector('.fq-loading') && !box.querySelector('[data-fq-anchor]')) {
        box.innerHTML = '<div class="fq-loading"><span class="fq-spin"></span>正文加载中…</div>';
      }
      if (Date.now() - start > FETCH_TIMEOUT + 2000) clearInterval(timer);
    }, 150);
    return function () { clearInterval(timer); };
  }

  // 稳态自愈：正文渲染好后，站点若在之后重新渲染清空了正文区，
  // 且我们这一章的内容还在缓存里，就补回去。只在当前 URL 章节与已渲染章节一致时生效。
  var lastHealTs = 0;
  function healReader() {
    if (!lastRender.html) return;
    var id = itemIdFromUrl(location.pathname);
    if (!id || id !== lastRender.itemId) return;
    var now = Date.now();
    if (now - lastHealTs < 200) return;
    lastHealTs = now;
    var box = getBox();
    if (!box) return;
    // 有锚点=我们的正文还在；有 loading=正在加载中，都不要动
    if (box.querySelector('[data-fq-anchor]') || box.querySelector('.fq-loading')) return;
    box.classList.remove('noselect');
    box.innerHTML = lastRender.html;
    decorateImages();
  }

  // 站点自己的渲染可能在稍后覆盖我们的内容，延长看守窗口并补写
  function guardApply(html, token) {
    var start = Date.now();
    var timer = setInterval(function () {
      if (token !== readerToken) { clearInterval(timer); return; }
      var box = getBox();
      if (box && !box.querySelector('[data-fq-anchor]')) {
        box.classList.remove('noselect');
        box.innerHTML = html;
        decorateImages();
        cleanOverlays();
      }
      if (Date.now() - start > 10000) clearInterval(timer);
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
      lastRender = { itemId: String(itemId), html: html };   // 缓存，供稳态自愈
      guardApply(html, token);
      cleanOverlays();
      // 通知类回调与正文渲染隔离：即使它们抛错也不能把刚写好的正文冲掉
      try { notifyAutoReadContentLoaded(); } catch (ne) { console.warn('[fq] autoRead 通知异常', ne); }
      try { notifySpeechContentLoaded(); } catch (ne) { console.warn('[fq] 语音通知异常', ne); }
      if (ch.bookId) {
        currentBook = { id: ch.bookId, name: ch.bookName };
      } else if (!currentBook) {
        var bid = bookIdFromPage();
        if (bid) currentBook = { id: bid, name: bookNameFromPage() || ch.bookName || '' };
      }

      var imgCount = countImages(ch.content);
      var extra = ch.preview ? '（后端仅返回试读）' : '';
      if (imgCount) extra += '（图片 ' + imgCount + ' 张）';
      showBadge('已替换正文 ' + ch.content.length + ' 字' + extra, ch.preview ? 'warn' : 'ok');
      document.title = document.title.replace(/_?在线免费阅读_番茄小说官网$/, '');

      // 正文加载成功后，直接用同源 fetch（自带登录 Cookie）上报阅读进度
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

  // ------------------------------------------------------------------
  // 自动阅读：自动滚动正文，章末自动翻到下一章
  // ------------------------------------------------------------------
  // 自动阅读速度用倍率表示：1.0 = 60px/秒 = 60fps 下每帧约 1.0px
  var AUTO_SPEED_MIN = 0.1, AUTO_SPEED_MAX = 2.0, AUTO_SPEED_STEP = 0.1;
  var AUTO_BASE_PX = 60;

  function normAutoSpeed(v) {
    if (v === null || v === undefined || v === '') return 1;
    v = Number(v);
    if (!isFinite(v)) return 1;
    if (v < AUTO_SPEED_MIN) v = AUTO_SPEED_MIN;
    if (v > AUTO_SPEED_MAX) v = AUTO_SPEED_MAX;
    return Number((Math.round(v / AUTO_SPEED_STEP) * AUTO_SPEED_STEP).toFixed(1));
  }

  function fmtSpeed(v) {
    return Number(v).toFixed(1) + 'x';
  }

  var autoRead = {
    on: false,
    speed: normAutoSpeed(ssGet('fq_autoread_speed')),
    raf: 0,
    lastTs: 0,
    atBottomSince: 0,
    remainder: 0,          // 累积不足 1px 的位移，慢速才不会被整数 scrollTop 抹掉
    startDelayUntil: 0,    // 正文加载后 / 初次开启后，先停 1.2 秒再滚
    changing: false,
    panel: null,
    hooksInstalled: false
  };

  function ssGet(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }

  function ssSet(key, val) {
    try { sessionStorage.setItem(key, val); } catch (e) { }
  }

  // 正文可能在 window 上滚，也可能在某个 overflow 容器里滚，这里统一找出来
  function getScrollEl() {
    var el = getBox();
    while (el && el !== document.body && el !== document.documentElement) {
      var st = window.getComputedStyle(el);
      var oy = st && st.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
          el.scrollHeight > el.clientHeight + 4) {
        return el;
      }
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement || document.body;
  }

  function updateAutoReadPanel() {
    var p = autoRead.panel;
    if (!p) return;
    var btn = p.querySelector('.fq-ar-toggle');
    if (btn) {
      btn.textContent = autoRead.on ? '暂停自动阅读' : '开始自动阅读';
      btn.className = 'fq-ar-toggle' + (autoRead.on ? ' on' : '');
    }
    var slider = p.querySelector('.fq-ar-speed');
    if (slider && Number(slider.value) !== autoRead.speed) slider.value = String(autoRead.speed);
    var val = p.querySelector('.fq-ar-speed-val');
    if (val) {
      val.textContent = fmtSpeed(autoRead.speed);
      val.title = Math.round(autoRead.speed * AUTO_BASE_PX) + ' px/秒';
    }
    var dot = p.querySelector('.fq-dot-ar');
    if (dot) {
      dot.className = 'fq-ar-rail-dot fq-dot-ar' + (autoRead.on ? ' ar-on' : '');
      dot.title = autoRead.on ? '自动阅读中' : '自动阅读未开启';
    }
  }

  function setAutoReadCollapsed(collapsed) {
    collapsed = !!collapsed;
    ssSet('fq_autoread_collapsed', collapsed ? '1' : '0');
    var p = autoRead.panel;
    if (!p) return;
    if (collapsed) p.classList.add('fq-collapsed');
    else p.classList.remove('fq-collapsed');
    var btn = p.querySelector('.fq-ar-collapse');
    if (btn) {
      btn.textContent = collapsed ? '展开' : '收起';
      btn.title = collapsed ? '展开阅读控制面板' : '收入右侧边栏';
    }
    updateAutoReadPanel();
    updateSpeechPanel();
  }

  function collapseAutoReadPanel() { setAutoReadCollapsed(true); }
  function expandAutoReadPanel() { setAutoReadCollapsed(false); }

  function ensureAutoReadPanel() {
    if (!isReader() || !document.body) return;
    if (autoRead.panel && document.body.contains(autoRead.panel)) return;

    var p = document.createElement('div');
    p.id = 'fq-autoread';

    var head = document.createElement('div');
    head.className = 'fq-ar-head';
    var headTitle = document.createElement('span');
    headTitle.textContent = '阅读控制';
    head.appendChild(headTitle);
    var collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'fq-ar-collapse';
    collapseBtn.title = '收入右侧边栏';
    collapseBtn.addEventListener('click', collapseAutoReadPanel);
    head.appendChild(collapseBtn);
    p.appendChild(head);

    var rail = document.createElement('div');
    rail.className = 'fq-ar-rail';
    var railBtn = document.createElement('button');
    railBtn.type = 'button';
    railBtn.className = 'fq-ar-rail-btn';
    railBtn.textContent = '阅读控制';
    railBtn.title = '展开自动阅读 / 语音朗读面板';
    railBtn.addEventListener('click', expandAutoReadPanel);
    rail.appendChild(railBtn);
    var railDots = document.createElement('div');
    railDots.className = 'fq-ar-rail-dots';
    var dotAr = document.createElement('div');
    dotAr.className = 'fq-ar-rail-dot fq-dot-ar';
    dotAr.title = '自动阅读状态';
    railDots.appendChild(dotAr);
    var dotTts = document.createElement('div');
    dotTts.className = 'fq-ar-rail-dot fq-dot-tts';
    dotTts.title = '语音朗读状态';
    railDots.appendChild(dotTts);
    railDots.addEventListener('click', expandAutoReadPanel);
    rail.appendChild(railDots);
    p.appendChild(rail);

    var body = document.createElement('div');
    body.className = 'fq-ar-body';
    p.appendChild(body);

    var toggle = document.createElement('button');
    toggle.className = 'fq-ar-toggle';
    toggle.addEventListener('click', toggleAutoRead);
    body.appendChild(toggle);

    var row = document.createElement('div');
    row.className = 'fq-ar-row';

    var speedSlider = document.createElement('input');
    speedSlider.type = 'range';
    speedSlider.className = 'fq-ar-speed';
    speedSlider.min = String(AUTO_SPEED_MIN);
    speedSlider.max = String(AUTO_SPEED_MAX);
    speedSlider.step = String(AUTO_SPEED_STEP);
    speedSlider.value = String(autoRead.speed);
    speedSlider.title = '自动阅读速度 ' + fmtSpeed(autoRead.speed);
    speedSlider.addEventListener('input', function () {
      setAutoSpeed(normAutoSpeed(speedSlider.value));
    });
    row.appendChild(speedSlider);

    var speedVal = document.createElement('span');
    speedVal.className = 'fq-speed-val fq-ar-speed-val';
    speedVal.textContent = fmtSpeed(autoRead.speed);
    row.appendChild(speedVal);

    body.appendChild(row);

    var hint = document.createElement('div');
    hint.className = 'fq-ar-hint';
    hint.textContent = '章末自动下一章 · 手动滚动会暂停';
    body.appendChild(hint);

    var ttsBox = document.createElement('div');
    ttsBox.className = 'fq-tts-box';

    var ttsTitle = document.createElement('div');
    ttsTitle.className = 'fq-tts-title';
    ttsTitle.textContent = '语音朗读';
    ttsBox.appendChild(ttsTitle);

    var ttsToggle = document.createElement('button');
    ttsToggle.className = 'fq-tts-toggle';
    ttsToggle.addEventListener('click', toggleSpeech);
    ttsBox.appendChild(ttsToggle);

    var pauseBtn = document.createElement('button');
    pauseBtn.className = 'fq-tts-pause';
    pauseBtn.addEventListener('click', toggleSpeechPause);
    ttsBox.appendChild(pauseBtn);

    var ttsRow = document.createElement('div');
    ttsRow.className = 'fq-tts-row';

    var rateSlider = document.createElement('input');
    rateSlider.type = 'range';
    rateSlider.className = 'fq-tts-rate';
    rateSlider.min = String(TTS_RATE_MIN);
    rateSlider.max = String(TTS_RATE_MAX);
    rateSlider.step = String(TTS_RATE_STEP);
    rateSlider.value = String(tts.rate);
    rateSlider.title = '语音语速 ' + fmtSpeed(tts.rate);
    rateSlider.addEventListener('input', function () {
      setTtsRate(normTtsRate(rateSlider.value));
    });
    ttsRow.appendChild(rateSlider);

    var rateVal = document.createElement('span');
    rateVal.className = 'fq-speed-val fq-tts-rate-val';
    rateVal.textContent = fmtSpeed(tts.rate);
    ttsRow.appendChild(rateVal);

    ttsBox.appendChild(ttsRow);

    var voiceLabel = document.createElement('div');
    voiceLabel.className = 'fq-tts-voice-label';
    voiceLabel.textContent = '朗读声音（音色）';
    ttsBox.appendChild(voiceLabel);

    var voiceSelect = document.createElement('select');
    voiceSelect.className = 'fq-tts-voice';
    voiceSelect.addEventListener('change', function () {
      setTtsVoice(voiceSelect.value);
    });
    ttsBox.appendChild(voiceSelect);

    var ttsStatus = document.createElement('div');
    ttsStatus.className = 'fq-tts-status';
    ttsBox.appendChild(ttsStatus);

    var ttsSeekHint = document.createElement('div');
    ttsSeekHint.className = 'fq-ar-hint';
    ttsSeekHint.textContent = '朗读时用鼠标选中文字，从选中处续读';
    ttsBox.appendChild(ttsSeekHint);

    body.appendChild(ttsBox);

    document.body.appendChild(p);
    autoRead.panel = p;
    setAutoReadCollapsed(ssGet('fq_autoread_collapsed') === '1');
    ensureVoicesListener();
    refreshVoiceSelect();
    updateAutoReadPanel();
    updateSpeechPanel();
  }

  function removeAutoReadPanel() {
    if (autoRead.panel && autoRead.panel.parentNode) {
      autoRead.panel.parentNode.removeChild(autoRead.panel);
    }
    autoRead.panel = null;
  }

  function startAutoRead(silent) {
    if (autoRead.on) return;
    autoRead.on = true;
    autoRead.atBottomSince = 0;
    autoRead.lastTs = 0;
    autoRead.remainder = 0;
    autoRead.startDelayUntil = Date.now() + 1200;
    ssSet('fq_autoread_on', '1');
    updateAutoReadPanel();
    if (!silent) showBadge('自动阅读已开启', 'ok');
    autoRead.raf = requestAnimationFrame(autoScrollStep);
  }

  function stopAutoRead(silent) {
    autoRead.on = false;
    if (autoRead.raf) {
      cancelAnimationFrame(autoRead.raf);
      autoRead.raf = 0;
    }
    ssSet('fq_autoread_on', '0');
    updateAutoReadPanel();
    if (!silent) showBadge('自动阅读已暂停', 'info');
  }

  function toggleAutoRead() {
    if (autoRead.on) stopAutoRead(false);
    else startAutoRead(false);
  }

  function setAutoSpeed(v) {
    autoRead.speed = normAutoSpeed(v);
    autoRead.remainder = 0;
    ssSet('fq_autoread_speed', String(autoRead.speed));
    updateAutoReadPanel();
    showBadge('自动阅读速度：' + fmtSpeed(autoRead.speed), 'info');
  }

  function pauseAutoReadByUser() {
    stopAutoRead(true);
    showBadge('检测到手动操作，自动阅读已暂停', 'info');
  }

  function isVisible(el) {
    return !!(el && el.getClientRects && el.getClientRects().length);
  }

  // 优先点页面自带的「下一章」；没有再按目录 ID 跳
  function findNextChapterLink() {
    var cur = itemIdFromUrl(location.pathname);
    var sels = [
      '.muye-reader-btns a[href*="/reader/"]',
      '.chapter-btn a[href*="/reader/"]',
      '.btn-next-relative-container a[href*="/reader/"]',
      'a[href*="/reader/"]'
    ];
    var all = [];
    sels.forEach(function (sel) {
      Array.prototype.forEach.call(document.querySelectorAll(sel), function (a) {
        if (isVisible(a) && all.indexOf(a) === -1) all.push(a);
      });
    });
    var named = all.filter(function (a) {
      var id = itemIdFromUrl(a.getAttribute('href'));
      return id && id !== cur && /下一章|下一回|next/i.test(a.textContent || '');
    });
    if (named.length) return named[named.length - 1];
    var others = all.filter(function (a) {
      var id = itemIdFromUrl(a.getAttribute('href'));
      return id && id !== cur;
    });
    if (others.length) return others[others.length - 1];

    // 有些版本「下一章」不是 <a>，而是绑定了事件的 div/span
    var textBtns = Array.prototype.slice.call(
      document.querySelectorAll('button,div,span,a')
    ).filter(function (el) {
      var txt = (el.textContent || '').replace(/\s+/g, '');
      return (txt === '下一章' || txt === '下一回') && isVisible(el);
    });
    return textBtns.length ? textBtns[textBtns.length - 1] : null;
  }

  async function gotoNextChapterById() {
    var cur = itemIdFromUrl(location.pathname);
    var bookId = (currentBook && currentBook.id) || bookIdFromPage();
    if (!cur || !bookId) return false;
    var list;
    try { list = await fetchDirectory(bookId); } catch (e) { return false; }
    var ids = list.map(function (c) { return String(c.id); });
    var pos = ids.indexOf(String(cur));
    if (pos === -1 || pos + 1 >= ids.length) return false;
    location.href = '/reader/' + ids[pos + 1];
    return true;
  }

  async function advanceChapter() {
    if (autoRead.changing) return;
    autoRead.changing = true;
    autoRead.atBottomSince = 0;
    showBadge('自动翻到下一章…', 'info');
    try {
      var link = findNextChapterLink();
      if (link) { link.click(); return; }
      var ok = await gotoNextChapterById();
      if (!ok) {
        showBadge('已是最后一章，或目录获取失败，已停止自动翻页', 'warn');
        stopAutoRead(true);
        // 语音朗读连续模式下到达末章：清掉待续读标记并停止
        if (tts.pendingStartOnLoad) {
          tts.pendingStartOnLoad = false;
          tts.continuous = false;
          stopSpeech(true);
        }
      }
    } finally {
      autoRead.changing = false;
    }
  }

  function autoScrollStep(ts) {
    if (!autoRead.on || !isReader()) { stopAutoRead(true); return; }
    if (!autoRead.lastTs) autoRead.lastTs = ts;
    var dt = Math.min(100, ts - autoRead.lastTs);
    autoRead.lastTs = ts;

    // 正文加载后 / 初次开启后，和章末一样先停 1.2 秒
    if (autoRead.startDelayUntil && Date.now() < autoRead.startDelayUntil) {
      autoRead.remainder = 0;
      autoRead.raf = requestAnimationFrame(autoScrollStep);
      return;
    }

    // 正文还没替换好时不要误判到底
    var box = getBox();
    if (box && !box.querySelector('[data-fq-anchor]')) {
      autoRead.atBottomSince = 0;
      autoRead.raf = requestAnimationFrame(autoScrollStep);
      return;
    }

    var el = getScrollEl();
    var max = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
    if (max > 4) {
      var rawStep = autoRead.speed * AUTO_BASE_PX * dt / 1000 + autoRead.remainder;
      var step = Math.floor(rawStep);
      autoRead.remainder = rawStep - step;
      if (step > 0) {
        el.scrollTop = Math.min(max, (el.scrollTop || 0) + step);
      }
      if (el.scrollTop >= max - 2) {
        if (!autoRead.atBottomSince) autoRead.atBottomSince = Date.now();
      } else {
        autoRead.atBottomSince = 0;
      }
    } else {
      if (!autoRead.atBottomSince) autoRead.atBottomSince = Date.now();
    }

    if (!autoRead.changing && autoRead.atBottomSince &&
        Date.now() - autoRead.atBottomSince > 1200) {
      advanceChapter();
    }
    autoRead.raf = requestAnimationFrame(autoScrollStep);
  }

  function resetAutoReadForChapter() {
    if (!autoRead.on) return;
    autoRead.atBottomSince = 0;
    autoRead.lastTs = 0;
    autoRead.remainder = 0;
    autoRead.startDelayUntil = 0;   // 等新章正文真正加载完再重新计时
    try { getScrollEl().scrollTop = 0; } catch (e) { }
  }

  // 正文渲染完成后调用：和章末一样先停 1.2 秒再开始滚
  function notifyAutoReadContentLoaded() {
    if (!autoRead.on) return;
    autoRead.atBottomSince = 0;
    autoRead.lastTs = 0;
    autoRead.remainder = 0;
    autoRead.startDelayUntil = Date.now() + 1200;
  }

  function installAutoReadHooks() {
    if (autoRead.hooksInstalled) return;
    autoRead.hooksInstalled = true;
    document.addEventListener('wheel', function () {
      if (autoRead.on) pauseAutoReadByUser();
    }, { passive: true });
    document.addEventListener('touchstart', function () {
      if (autoRead.on) pauseAutoReadByUser();
    }, { passive: true });
    document.addEventListener('keydown', function (e) {
      if (!autoRead.on || !e || !e.key) return;
      if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(e.key)) {
        pauseAutoReadByUser();
      }
    });
  }

  function restoreAutoReadState() {
    autoRead.speed = normAutoSpeed(ssGet('fq_autoread_speed'));
    ensureAutoReadPanel();
    updateAutoReadPanel();
    if (ssGet('fq_autoread_on') === '1') startAutoRead(true);
  }

  // ------------------------------------------------------------------
  // 语音朗读正文（Web Speech API）
  // ------------------------------------------------------------------
  // 语音语速倍率：与 Web Speech 的 rate 一致，1.0 = 正常速度
  var TTS_RATE_MIN = 0.1, TTS_RATE_MAX = 2.0, TTS_RATE_STEP = 0.1;

  function normTtsRate(v) {
    if (v === null || v === undefined || v === '') return 1;
    v = Number(v);
    if (!isFinite(v)) return 1;
    if (v < TTS_RATE_MIN) v = TTS_RATE_MIN;
    if (v > TTS_RATE_MAX) v = TTS_RATE_MAX;
    return Number((Math.round(v / TTS_RATE_STEP) * TTS_RATE_STEP).toFixed(1));
  }

  var tts = {
    speaking: false,
    paused: false,
    rate: normTtsRate(ssGet('fq_tts_rate')),
    paragraphs: [],
    units: [],                  // 把长段切成短句，绕开浏览器长文本朗读中断
    index: 0,                   // 当前段落序号（高亮用）
    unitIndex: 0,               // 当前短句序号（续读用）
    unitOffset: 0,              // 当前短句内已经读到的字符偏移
    utterance: null,
    startedAt: 0,
    watchdog: 0,
    keepAlive: 0,
    retry: 0,
    cancelGuard: false,         // 主动取消时不要让 onerror 触发自动续读
    voice: null,
    voiceURI: ssGet('fq_tts_voice') || '',  // 用户选择的音色（系统语音唯一标识）
    voicesListenerInstalled: false,
    hooksInstalled: false,
    continuous: false,          // 朗读完是否自动翻下一章继续听
    pendingStartOnLoad: false
  };

  var TTS_POS_KEY = 'fq_tts_pos_v1';
  var TTS_CHUNK_LEN = 56;       // 约 10 秒/句（1.0x），降低 Chrome 长文本中断概率

  function ttsSupported() {
    return !!(window && window.speechSynthesis &&
              typeof window.SpeechSynthesisUtterance === 'function');
  }

  function pickChineseVoice() {
    try {
      var voices = window.speechSynthesis.getVoices() || [];
      return voices.filter(function (v) { return /^zh/i.test(v.lang || ''); })[0] ||
             voices.filter(function (v) { return /chinese|中文/i.test(v.name || ''); })[0] || null;
    } catch (e) { return null; }
  }

  // 列出系统可用语音，中文音色排在前面
  function getVoicesList() {
    var voices = [];
    try { voices = (window.speechSynthesis.getVoices() || []).slice(); } catch (e) { }
    voices.sort(function (a, b) {
      var az = /^zh/i.test(a.lang || '') ? 0 : 1;
      var bz = /^zh/i.test(b.lang || '') ? 0 : 1;
      if (az !== bz) return az - bz;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    return voices;
  }

  function voiceKey(v) {
    return v && (v.voiceURI || v.name) || '';
  }

  function findVoiceByURI(uri) {
    if (!uri) return null;
    var voices = getVoicesList();
    for (var i = 0; i < voices.length; i++) {
      if (voiceKey(voices[i]) === uri) return voices[i];
    }
    return null;
  }

  // 用系统返回的语音列表填充下拉框（首次可能为空，等 voiceschanged 再填）
  function refreshVoiceSelect() {
    var p = autoRead.panel;
    if (!p) return;
    var sel = p.querySelector('.fq-tts-voice');
    if (!sel) return;
    var voices = getVoicesList();

    // 还没选过音色时，默认挑第一个中文语音
    if (!tts.voiceURI && voices.length) {
      var def = voices.filter(function (v) { return /^zh/i.test(v.lang || ''); })[0] || voices[0];
      tts.voiceURI = voiceKey(def);
      tts.voice = def;
    }

    while (sel.children && sel.children.length) {
      sel.removeChild(sel.children[sel.children.length - 1]);
    }
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = voices.length ? '系统默认' : '加载语音列表中…';
    sel.appendChild(placeholder);

    voices.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = voiceKey(v);
      opt.textContent = (v.name || '未知语音') + (v.lang ? '  [' + v.lang + ']' : '');
      sel.appendChild(opt);
    });
    sel.value = tts.voiceURI || '';
  }

  function ensureVoicesListener() {
    if (tts.voicesListenerInstalled) return;
    tts.voicesListenerInstalled = true;
    try {
      if (window.speechSynthesis.addEventListener) {
        window.speechSynthesis.addEventListener('voiceschanged', function () {
          refreshVoiceSelect();
          if (tts.voiceURI) tts.voice = findVoiceByURI(tts.voiceURI) || tts.voice;
        });
      }
    } catch (e) { }
  }

  function setTtsVoice(uri) {
    var v = findVoiceByURI(uri);
    tts.voiceURI = uri || '';
    tts.voice = v || null;
    ssSet('fq_tts_voice', tts.voiceURI);
    updateSpeechPanel();
    if (tts.speaking && tts.utterance) {
      var ui = tts.unitIndex;
      var off = tts.unitOffset || 0;
      cancelCurrentUtterance();
      tts.paused = false;
      speakUnit(ui, off);
    }
    showBadge('朗读声音：' + (v ? (v.name || v.lang) : '系统默认'), 'info');
  }

  function getSpeechParagraphs() {
    var box = getBox();
    if (!box || !box.querySelector('[data-fq-anchor]')) return [];
    return Array.prototype.slice.call(box.querySelectorAll('p'))
      .map(function (p) { return (p.textContent || '').replace(/\s+/g, ' ').trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  function currentReaderItemId() {
    var id = itemIdFromUrl(location.pathname);
    return id ? String(id) : '';
  }

  // 长段切成短句：浏览器（尤其 Chrome）朗读长文本容易中途断掉
  function splitSpeechParagraph(text, pIndex) {
    var s = String(text || '');
    var out = [];
    var start = 0;
    while (start < s.length) {
      var end = Math.min(start + TTS_CHUNK_LEN, s.length);
      if (end < s.length) {
        var seg = s.slice(start, end);
        var cuts = /[，。！？；、,.!?;：:\s]/g;
        var best = -1, m;
        while ((m = cuts.exec(seg)) !== null) best = m.index;
        if (best >= Math.floor(TTS_CHUNK_LEN * 0.55)) end = start + best + 1;
      }
      var chunk = s.slice(start, end);
      if (chunk.replace(/\s/g, '')) {
        out.push({ pIndex: pIndex, start: start, text: chunk });
      }
      start = end;
    }
    return out;
  }

  function buildSpeechUnits(paragraphs) {
    var units = [];
    for (var i = 0; i < paragraphs.length; i++) {
      Array.prototype.push.apply(units, splitSpeechParagraph(paragraphs[i], i));
    }
    return units;
  }

  function unitIndexFor(pIndex, offset) {
    offset = Math.max(0, Number(offset) || 0);
    var i, u;
    for (i = 0; i < tts.units.length; i++) {
      u = tts.units[i];
      if (u.pIndex === pIndex && offset >= u.start && offset < u.start + u.text.length) return i;
    }
    for (i = 0; i < tts.units.length; i++) {
      if (tts.units[i].pIndex === pIndex) return i;
    }
    return 0;
  }

  function saveTtsPosition() {
    var u = tts.units[tts.unitIndex];
    if (!u) return;
    ssSet(TTS_POS_KEY, JSON.stringify({
      itemId: currentReaderItemId(),
      unit: tts.unitIndex,
      offset: Math.max(0, tts.unitOffset || 0),
      p: u.pIndex
    }));
  }

  function loadTtsPosition() {
    try {
      var raw = ssGet(TTS_POS_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || o.itemId !== currentReaderItemId()) return null;
      return o;
    } catch (e) { return null; }
  }

  function clearTtsPosition() {
    ssSet(TTS_POS_KEY, '');
  }

  function clearSpeechHighlight() {
    var box = getBox();
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('p.fq-speaking'), function (p) {
      p.classList.remove('fq-speaking');
    });
  }

  function highlightSpeechParagraph(i) {
    var box = getBox();
    if (!box) return;
    clearSpeechHighlight();
    var p = box.querySelectorAll('p')[i];
    if (!p) return;
    p.classList.add('fq-speaking');
    if (p.scrollIntoView) {
      try { p.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { }
    }
  }

  function updateSpeechPanel() {
    var p = autoRead.panel;
    if (!p) return;

    var btn = p.querySelector('.fq-tts-toggle');
    if (btn) {
      btn.textContent = tts.speaking ? '停止朗读' : '朗读本章';
      btn.className = 'fq-tts-toggle' + (tts.speaking ? ' on' : '');
    }

    var pause = p.querySelector('.fq-tts-pause');
    if (pause) {
      pause.disabled = !tts.speaking;
      pause.textContent = tts.paused ? '继续朗读' : '暂停朗读';
    }

    var status = p.querySelector('.fq-tts-status');
    if (status) {
      if (!ttsSupported()) status.textContent = '当前浏览器不支持语音朗读';
      else if (!tts.speaking) status.textContent = '就绪';
      else if (tts.paused) status.textContent = '已暂停';
      else status.textContent = '朗读中 ' + (tts.index + 1) + '/' + tts.paragraphs.length;
    }

    var slider = p.querySelector('.fq-tts-rate');
    if (slider && Number(slider.value) !== tts.rate) slider.value = String(tts.rate);
    var val = p.querySelector('.fq-tts-rate-val');
    if (val) val.textContent = fmtSpeed(tts.rate);

    var sel = p.querySelector('.fq-tts-voice');
    if (sel && tts.voiceURI && sel.value !== tts.voiceURI) sel.value = tts.voiceURI;

    var dot = p.querySelector('.fq-dot-tts');
    if (dot) {
      dot.className = 'fq-ar-rail-dot fq-dot-tts' + (tts.speaking ? ' tts-on' : '');
      dot.title = tts.speaking ? (tts.paused ? '语音朗读已暂停' : '语音朗读中') : '语音朗读未开启';
    }
  }

  function clearSpeechWatchdog() {
    if (tts.watchdog) { clearTimeout(tts.watchdog); tts.watchdog = 0; }
  }

  function stopSpeechKeepAlive() {
    if (tts.keepAlive) { clearInterval(tts.keepAlive); tts.keepAlive = 0; }
  }

  // Chrome/Edge 长时间朗读会自己断；定期 pause/resume 可显著降低概率
  function startSpeechKeepAlive() {
    stopSpeechKeepAlive();
    tts.keepAlive = setInterval(function () {
      if (!tts.speaking || tts.paused || !window.speechSynthesis.speaking) return;
      try { window.speechSynthesis.pause(); window.speechSynthesis.resume(); } catch (e) { }
    }, 8000);
  }

  function cancelCurrentUtterance() {
    clearSpeechWatchdog();
    tts.cancelGuard = true;
    if (tts.utterance) {
      tts.utterance.onend = null;
      tts.utterance.onerror = null;
      tts.utterance = null;
    }
    try { window.speechSynthesis.cancel(); } catch (e) { }
  }

  function armSpeechWatchdog(utterance, text) {
    clearSpeechWatchdog();
    var est = Math.max(4000, text.length * 260 / Math.max(0.1, tts.rate));
    var wait = Math.min(60000, Math.max(8000, est * 2));
    tts.watchdog = setTimeout(function () {
      if (!tts.speaking || tts.paused || tts.utterance !== utterance) return;
      console.warn('[fq-tts] 朗读无响应，自动续读');
      handleSpeechBreak(tts.unitIndex, tts.unitOffset, true);
    }, wait);
  }

  // 朗读意外中断：从当前短句重试几次，仍失败才跳到下一句
  function handleSpeechBreak(ui, offset, fromWatchdog) {
    if (!tts.speaking || tts.paused) return;
    clearSpeechWatchdog();
    var unit = tts.units[ui];
    if (!unit) { speakUnit(ui + 1, 0); return; }
    if (tts.retry < 3) {
      tts.retry++;
      cancelCurrentUtterance();
      var delay = fromWatchdog ? 120 : 300;
      setTimeout(function () {
        if (tts.speaking && !tts.paused) speakUnit(ui, offset, true);
      }, delay);
    } else {
      tts.retry = 0;
      speakUnit(ui + 1, 0);
    }
  }

  function speakUnit(ui, offset, keepRetry) {
    clearSpeechWatchdog();
    if (!tts.speaking) return;
    ui = Math.max(0, Number(ui) || 0);
    offset = Math.max(0, Number(offset) || 0);
    if (ui >= tts.units.length) { onSpeechChapterDone(); return; }
    if (!keepRetry) tts.retry = 0;

    var unit = tts.units[ui];
    var text = unit.text;
    if (offset > 0) text = text.slice(offset);
    if (!text) { speakUnit(ui + 1, 0); return; }

    tts.unitIndex = ui;
    tts.unitOffset = offset;
    tts.index = unit.pIndex;
    highlightSpeechParagraph(unit.pIndex);
    saveTtsPosition();

    var utterance = new window.SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = tts.rate;
    utterance.pitch = 1;
    utterance.volume = 1;
    if (tts.voice) utterance.voice = tts.voice;
    tts.utterance = utterance;
    tts.startedAt = Date.now();
    tts.cancelGuard = false;

    utterance.onend = function () {
      if (!tts.speaking || tts.paused || tts.utterance !== utterance) return;
      var elapsed = Date.now() - tts.startedAt;
      var minMs = Math.min(3000, Math.max(500, text.length * 90 / Math.max(0.1, tts.rate)));
      if (elapsed < minMs && tts.retry < 3) {
        tts.retry++;
        cancelCurrentUtterance();
        setTimeout(function () {
          if (tts.speaking && !tts.paused) speakUnit(ui, offset, true);
        }, 250);
        return;
      }
      tts.retry = 0;
      speakUnit(ui + 1, 0);
    };

    utterance.onerror = function (ev) {
      if (!tts.speaking || tts.utterance !== utterance || tts.cancelGuard) return;
      console.warn('[fq-tts] 朗读中断：', ev && ev.error);
      if (tts.retry < 3) {
        tts.retry++;
        cancelCurrentUtterance();
        setTimeout(function () {
          if (tts.speaking && !tts.paused) speakUnit(ui, offset, true);
        }, 300);
      } else {
        tts.retry = 0;
        stopSpeech(true);
        showBadge('语音朗读多次中断，已停止', 'warn');
      }
    };

    startSpeechKeepAlive();
    armSpeechWatchdog(utterance, text);
    try { window.speechSynthesis.speak(utterance); }
    catch (e) {
      handleSpeechBreak(ui, offset, true);
    }
  }

  // 兼容段落 + 段内偏移的调用（鼠标选区续读）
  function speakParagraph(i, offset) {
    if (!tts.speaking || tts.paused) return;
    if (i >= tts.paragraphs.length) { onSpeechChapterDone(); return; }
    var ui = unitIndexFor(i, offset || 0);
    var unit = tts.units[ui];
    var local = unit ? Math.max(0, (offset || 0) - unit.start) : 0;
    speakUnit(ui, local);
  }

  // 鼠标选中正文后，从选中位置续读
  function restartSpeechFromSelection() {
    if (!tts.speaking) return;
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var box = getBox();
    if (!box) return;

    var range = sel.getRangeAt(0);
    var p = range.startContainer;
    if (p && p.nodeType === 3) p = p.parentNode;
    while (p && p !== box && p !== document.body &&
           !(p.nodeType === 1 && p.tagName && p.tagName.toLowerCase() === 'p')) {
      p = p.parentNode;
    }
    if (!p || p === box || p === document.body ||
        !p.tagName || p.tagName.toLowerCase() !== 'p' || !box.contains(p)) return;

    var allP = box.querySelectorAll('p');
    var idx = -1;
    for (var i = 0; i < allP.length; i++) {
      if (allP[i] === p) { idx = i; break; }
    }
    if (idx < 0 || idx >= tts.paragraphs.length) return;

    // 段内字符偏移：统计段首到选区起点之间的文字（与正文归一化方式一致）
    var offset = 0;
    try {
      var pre = range.cloneRange();
      pre.selectNodeContents(p);
      pre.setEnd(range.startContainer, range.startOffset);
      offset = pre.toString().replace(/\s+/g, ' ').replace(/^\s/, '').length;
    } catch (e) { offset = 0; }
    var paraText = tts.paragraphs[idx] || '';
    if (offset < 0 || offset >= paraText.length) offset = 0;

    // 取消当前朗读，从选中处重读
    cancelCurrentUtterance();
    tts.paused = false;
    updateSpeechPanel();
    showBadge('已从选中位置继续朗读', 'info');
    speakParagraph(idx, offset);
  }

  function installSpeechHooks() {
    if (tts.hooksInstalled) return;
    tts.hooksInstalled = true;
    document.addEventListener('mouseup', function () {
      if (tts.speaking) restartSpeechFromSelection();
    });
  }

  function startSpeech(silent, keepContinuous) {
    if (!ttsSupported()) {
      showBadge('当前浏览器不支持语音朗读（建议用 Chrome / Edge）', 'warn');
      return;
    }
    if (tts.speaking) return;

    tts.paragraphs = getSpeechParagraphs();
    if (!tts.paragraphs.length) {
      showBadge('正文还没加载好，暂无可朗读内容', 'warn');
      return;
    }
    tts.units = buildSpeechUnits(tts.paragraphs);
    if (!tts.units.length) {
      showBadge('正文暂无可朗读内容', 'warn');
      return;
    }

    // 同一章内重开朗读，从上次停下的短句继续，不再从头开始
    var saved = loadTtsPosition();
    var startUnit = 0, startOffset = 0;
    if (saved && saved.unit >= 0 && saved.unit < tts.units.length) {
      startUnit = saved.unit;
      var savedUnit = tts.units[startUnit];
      startOffset = Math.max(0, Math.min(Number(saved.offset) || 0, savedUnit.text.length - 1));
    }

    tts.speaking = true;
    tts.paused = false;
    tts.unitIndex = startUnit;
    tts.unitOffset = startOffset;
    tts.index = tts.units[startUnit].pIndex;
    tts.retry = 0;
    // 语音朗读始终自动翻下一章；结束、开始均无延迟
    tts.continuous = true;
    // 恢复用户选择的音色，没选过才回退到中文语音
    if (!tts.voice && tts.voiceURI) tts.voice = findVoiceByURI(tts.voiceURI);
    if (!tts.voice) tts.voice = pickChineseVoice();

    // 朗读时交给语音推进视图，避免和自动滚动打架
    if (autoRead.on) stopAutoRead(true);

    ensureVoicesListener();
    refreshVoiceSelect();

    updateSpeechPanel();
    if (!silent) {
      if (startUnit > 0 || startOffset > 0) showBadge('语音朗读已从上次位置继续', 'ok');
      else showBadge(tts.continuous ? '语音朗读已开启（读完自动下一章）' : '语音朗读已开启', 'ok');
    }
    speakUnit(startUnit, startOffset);
  }

  function stopSpeech(silent) {
    tts.speaking = false;
    tts.paused = false;
    tts.pendingStartOnLoad = false;
    tts.continuous = false;
    tts.retry = 0;
    cancelCurrentUtterance();
    stopSpeechKeepAlive();
    clearSpeechHighlight();
    updateSpeechPanel();
    // 保留当前章节的朗读位置，下次开启从这里继续
    if (!silent) showBadge('语音朗读已停止（下次从此处继续）', 'info');
  }

  function pauseSpeech() {
    if (!tts.speaking || tts.paused) return;
    tts.paused = true;
    clearSpeechWatchdog();
    stopSpeechKeepAlive();
    try { window.speechSynthesis.pause(); } catch (e) { }
    updateSpeechPanel();
    showBadge('语音朗读已暂停', 'info');
  }

  function resumeSpeech() {
    if (!tts.speaking || !tts.paused) return;
    tts.paused = false;
    try { window.speechSynthesis.resume(); } catch (e) { }
    if (tts.utterance) {
      var unit = tts.units[tts.unitIndex];
      if (unit) armSpeechWatchdog(tts.utterance, unit.text.slice(tts.unitOffset || 0));
    }
    startSpeechKeepAlive();
    updateSpeechPanel();
    showBadge('语音朗读已继续', 'ok');
  }

  function toggleSpeechPause() {
    if (tts.paused) resumeSpeech();
    else pauseSpeech();
  }

  function toggleSpeech() {
    if (tts.speaking) stopSpeech(false);
    else startSpeech(false, false);
  }

  function setTtsRate(v) {
    tts.rate = normTtsRate(v);
    ssSet('fq_tts_rate', String(tts.rate));
    updateSpeechPanel();
    if (tts.speaking && tts.utterance) {
      var ui = tts.unitIndex;
      var off = tts.unitOffset || 0;
      cancelCurrentUtterance();
      tts.paused = false;
      speakUnit(ui, off);
    }
    showBadge('语音语速：' + fmtSpeed(tts.rate), 'info');
  }

  function onSpeechChapterDone() {
    clearSpeechWatchdog();
    stopSpeechKeepAlive();
    tts.speaking = false;
    tts.utterance = null;
    tts.paused = false;
    tts.retry = 0;
    clearTtsPosition();
    clearSpeechHighlight();
    updateSpeechPanel();
    if (tts.continuous && isReader()) {
      tts.pendingStartOnLoad = true;
      showBadge('本章朗读完毕，正在翻到下一章…', 'info');
      advanceChapter();
    } else {
      showBadge('本章朗读完毕', 'ok');
    }
  }

  function notifySpeechContentLoaded() {
    if (tts.pendingStartOnLoad) {
      tts.pendingStartOnLoad = false;
      startSpeech(true, true);
    } else if (tts.speaking) {
      // 手动切章时正在朗读，改读新章
      var wasContinuous = tts.continuous;
      stopSpeech(true);
      tts.continuous = wasContinuous;
      startSpeech(true, true);
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
    restoreAutoReadState();
    installAutoReadHooks();
    installSpeechHooks();
    function tick() {
      if (!isReader()) return;
      ensureHijack();
      if (location.href === lastUrl) {
        // URL 没变：稳态下检查正文是否被站点清空，被清空就补回（防空白）
        healReader();
        return;
      }
      lastUrl = location.href;
      resetAutoReadForChapter();
      var id = itemIdFromUrl(location.pathname);
      if (id) runReader(id);
    }
    tick();
    setInterval(tick, 250);                     // 轮询要快，切章时才能立刻清屏
    // 不再在点「上一章/下一章」时无条件清空正文：
    // 有些点击并不切章（如目录弹层、当前章按钮），提前清空会导致永久 loading/空白。
    // 清屏统一交给 runReader 在确认 URL 变化后进行。
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

    panel.appendChild(head);
    panel.appendChild(status);
    panel.appendChild(btn);
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

  var menuRegistered = false;

  function boot() {
    if (typeof GM_registerMenuCommand === 'function' && !menuRegistered) {
      menuRegistered = true;
      GM_registerMenuCommand('开启/关闭自动阅读', function () {
        if (!isReader()) {
          showBadge('请到小说阅读页再开启自动阅读', 'warn');
          return;
        }
        ensureAutoReadPanel();
        toggleAutoRead();
      });
      GM_registerMenuCommand('朗读本章 / 停止朗读', function () {
        if (!isReader()) {
          showBadge('请到小说阅读页再使用语音朗读', 'warn');
          return;
        }
        ensureAutoReadPanel();
        toggleSpeech();
      });
      GM_registerMenuCommand('选择朗读声音（音色）', function () {
        if (!isReader()) {
          showBadge('请到小说阅读页再选择朗读声音', 'warn');
          return;
        }
        ensureAutoReadPanel();
        refreshVoiceSelect();
        var sel = autoRead.panel && autoRead.panel.querySelector('.fq-tts-voice');
        if (sel && sel.focus) sel.focus();
        showBadge('已在阅读面板中展开声音列表', 'info');
      });
      GM_registerMenuCommand('展开 / 收起阅读控制面板', function () {
        if (!isReader()) {
          showBadge('请到小说阅读页再使用阅读控制面板', 'warn');
          return;
        }
        ensureAutoReadPanel();
        setAutoReadCollapsed(!autoRead.panel.classList.contains('fq-collapsed'));
      });
    }
    if (isReader()) {
        removePanel();
        watchReader();
    } else if (isBookPage()) {
      removePanel();
      removeAutoReadPanel();
      stopAutoRead(true);
      stopSpeech(true);
      watchBookPage();
    } else {
      removePanel();
      removeAutoReadPanel();
      stopAutoRead(true);
      stopSpeech(true);
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
