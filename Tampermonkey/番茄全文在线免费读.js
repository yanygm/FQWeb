// ==UserScript==
// @name             番茄全文在线免费读
// @version          5.8.4-tts-continue
// @description       自建后端替换番茄网页正文：锁章全文、正文图片、阅读进度上报、阅读页「下载全文」、详情页一键下载全本；所有书自动替换正文并上报进度，「脚本读」按钮仅给受限书提供手动入口；阅读页左上角返回统一回书架
// @description:zh-cn 自建后端替换番茄网页正文：锁章全文、正文图片、阅读进度上报、阅读页「下载全文」、详情页一键下载全本；所有书自动替换正文并上报进度，「脚本读」按钮仅给受限书提供手动入口；阅读页左上角返回统一回书架
// @description:en    Replace fanqienovel web content with a self-hosted API; locked chapters, images, progress report, full-book download; all books auto-replace content & report progress, "Script read" button only for copyright-restricted books; reader back button always goes to bookshelf
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

  // 所有书在阅读页都会自动用自建后端替换正文并上报进度（脚本核心功能）。
  // 「脚本读」按钮/标记只用于受限书的手动入口：官网不给正文时，从书架/详情页点它可直接进入。
  // 标记仍保留（openScriptReader 写入），但正文替换不再依赖它。
  var SCRIPT_ITEM_KEY = 'fq_script_item_';
  var SCRIPT_BOOK_KEY = 'fq_script_book_';

  function setScriptReadFlag(bookId, itemId) {
    try {
      if (itemId) sessionStorage.setItem(SCRIPT_ITEM_KEY + itemId, '1');
      if (bookId) sessionStorage.setItem(SCRIPT_BOOK_KEY + bookId, '1');
    } catch (e) { /* ignore */ }
  }

  function clearScriptReadFlag(bookId, itemId) {
    try {
      if (itemId) sessionStorage.removeItem(SCRIPT_ITEM_KEY + itemId);
      if (bookId) sessionStorage.removeItem(SCRIPT_BOOK_KEY + bookId);
    } catch (e) { /* ignore */ }
  }

  function isScriptRead(bookId, itemId) {
    try {
      if (itemId && sessionStorage.getItem(SCRIPT_ITEM_KEY + itemId) === '1') return true;
      if (bookId && sessionStorage.getItem(SCRIPT_BOOK_KEY + bookId) === '1') return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  // 服务端版权字段（来自书架 multidetail）：受限书 final_platform_visibility=0、
  // item_show_title 为空、real_chapter_order='0'。前端只读这些字段判断，不改官网状态。
  function isRestrictedMeta(meta) {
    if (!meta || typeof meta !== 'object') return false;
    if (meta.final_platform_visibility !== undefined &&
        String(meta.final_platform_visibility) === '0') return true;
    if (meta.item_show_title !== undefined &&
        String(meta.item_show_title) === '') return true;
    if (meta.real_chapter_order !== undefined &&
        String(meta.real_chapter_order) === '0') return true;
    if (String(meta.genre || '').toUpperCase() === 'OTHER') return true;
    return false;
  }

  function hasCopyrightNotice(text) {
    return /因版权问题|暂不支持浏览器阅读/.test(String(text || ''));
  }

  // 阅读页兜底识别：正文容器空 + 页面状态里带受限字段时，自动切到脚本读。
  function isRestrictedBookPage() {
    if (hasCopyrightNotice(document.body && document.body.innerText)) return true;
    try {
      var html = document.documentElement.innerHTML || '';
      if (/"final_platform_visibility"\s*:\s*"?0"?/.test(html)) return true;
      if (/"real_chapter_order"\s*:\s*"?0"?/.test(html)) return true;
      if (/"item_show_title"\s*:\s*""/.test(html)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  // 用自建后端打开一本书：优先续读上次章节 -> 书架 itemId -> 目录第一章。
  // bookId / itemId 至少给一个。
  async function openScriptReader(bookId, itemId) {
    if (!bookId && !itemId) { showBadge('未获取到书籍信息', 'warn'); return; }
    var target = '';
    // 续读：若该书有记忆进度，优先回到上次读到的章节
    if (bookId) {
      var remembered = getLastItem(bookId);
      if (remembered) target = remembered;
    }
    if (!target) target = itemId || '';
    if (!target && bookId) {
      showBadge('正在读取目录…', 'info');
      try {
        var chapters = await fetchDirectory(bookId);
        if (!chapters.length) throw new Error('目录为空');
        target = chapters[0].id;
      } catch (e) {
        showBadge('读取目录失败：' + e.message, 'err');
        return;
      }
    }
    if (!target) { showBadge('未找到章节入口', 'warn'); return; }
    setScriptReadFlag(bookId, target);
    location.href = '/reader/' + target;
  }

  function findAddShelfButton() {
    var exact = document.querySelector('.add-bookshelf-btn');
    if (exact) return exact;
    var all = document.querySelectorAll('button, a, div[role="button"]');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || '').replace(/\s+/g, '');
      if (t === '加入书架') return all[i];
    }
    return null;
  }

  function findReaderHref() {
    var a = document.querySelector('.info-btn a[href*="/reader/"]') ||
            document.querySelector('a[href*="/reader/"]');
    return a ? a.getAttribute('href') : '';
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
    // 详情页 URL 自带 bookId（/page/<id>），最可靠，优先用
    var u = String(location.pathname || '').match(/\/page\/(\d{6,})/);
    if (u) return u[1];
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
      'border-radius:4px;box-shadow:0 0 0 4px rgba(255,106,0,.12);}',
      // 脚本自建阅读导航：底部翻页条 + 全屏目录抽屉（受限书官网不渲染这些，故自建）
      '#fq-readnav{position:fixed;left:0;right:0;bottom:0;z-index:2147483646;display:flex;',
      'align-items:center;justify-content:center;gap:14px;padding:9px 14px;',
      'background:rgba(255,255,255,.97);color:#222;border-top:1px solid rgba(0,0,0,.08);',
      'box-shadow:0 -3px 16px rgba(0,0,0,.12);font:13px/1.4 system-ui,-apple-system,',
      '"PingFang SC","Microsoft YaHei",sans-serif;user-select:none;}',
      '#fq-readnav button{cursor:pointer;border:1px solid #ddd;background:#fff;color:#333;',
      'border-radius:6px;padding:6px 14px;font-size:13px;min-width:74px;}',
      '#fq-readnav button:hover:not(:disabled){border-color:#ff6a00;color:#ff6a00;}',
      '#fq-readnav button:disabled{opacity:.4;cursor:not-allowed;}',
      '#fq-readnav .fq-rn-info{text-align:center;min-width:132px;font-variant-numeric:tabular-nums;}',
      '#fq-readnav .fq-rn-prog{color:#ff6a00;font-weight:600;font-size:12px;}',
      '#fq-readnav .fq-rn-title{color:#888;font-size:11px;max-width:230px;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 auto;}',
      '#fq-toc-drawer{position:fixed;inset:0;z-index:2147483646;display:none;',
      'background:rgba(0,0,0,.4);align-items:flex-end;justify-content:center;}',
      '#fq-toc-drawer.fq-open{display:flex;}',
      '#fq-toc-drawer .fq-toc-panel{width:min(560px,94vw);max-height:78vh;display:flex;',
      'flex-direction:column;background:#fff;border-radius:14px 14px 0 0;overflow:hidden;',
      'box-shadow:0 -6px 30px rgba(0,0,0,.25);}',
      '#fq-toc-drawer .fq-toc-head{display:flex;align-items:center;justify-content:space-between;',
      'padding:14px 18px;border-bottom:1px solid #eee;font-weight:600;font-size:15px;}',
      '#fq-toc-drawer .fq-toc-head button{cursor:pointer;border:0;background:#f5f5f5;',
      'border-radius:6px;padding:4px 12px;font-size:13px;color:#555;}',
      '#fq-toc-drawer .fq-toc-list{overflow:auto;padding:6px 0;flex:1;}',
      '#fq-toc-drawer .fq-toc-item{padding:10px 18px;font-size:13px;color:#333;cursor:pointer;',
      'border-bottom:1px solid #fafafa;display:flex;gap:10px;align-items:baseline;}',
      '#fq-toc-drawer .fq-toc-item:hover{background:#faf5f0;}',
      '#fq-toc-drawer .fq-toc-item.fq-cur{color:#ff6a00;font-weight:600;background:#fff6ef;}',
      '#fq-toc-drawer .fq-toc-idx{color:#bbb;font-size:11px;min-width:30px;text-align:right;}',
      '#fq-toc-drawer .fq-toc-status{padding:16px;color:#999;font-size:13px;text-align:center;}'
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

  // ------------------------------------------------------------------
  // 官网阅读页左上角返回：统一「返回书架」
  // 目标元素：.muye-reader-nav-title（标题/返回区）、.muyeicon-icon-reader-icon-back（返回图标）
  // 官网原逻辑可能走 history.back()（回到上一页），这里强制跳到书架。
  // ------------------------------------------------------------------
  var backHijacked = false;

  function goBackToShelf() {
    location.href = '/bookshelf';
  }

  function hijackReaderBack() {
    if (backHijacked) return;
    backHijacked = true;
    // 捕获阶段拦截，先于 React 根容器的合成事件，官网回退逻辑不会再执行
    document.addEventListener('click', function (e) {
      if (!isReader()) return;
      var t = e.target;
      if (!t || !t.closest) return;
      var hit = t.closest('.muye-reader-nav-title') ||
                t.closest('.muyeicon-icon-reader-icon-back');
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      goBackToShelf();
    }, true);
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

  // ------------------------------------------------------------------
  // 脚本自建阅读导航：目录驱动翻页 + 进度显示 + 续读记忆
  // 版权受限书官网不渲染目录/上一章/下一章，这里完全自建，不依赖官网 DOM。
  // ------------------------------------------------------------------
  var LAST_ITEM_KEY = 'fq_last_item_';   // + bookId -> 最后阅读的 itemId
  var readNav = { bookId: '', chapters: [], index: -1, panel: null, drawer: null };

  function rememberLastItem(bookId, itemId) {
    if (bookId && itemId) ssSet(LAST_ITEM_KEY + bookId, String(itemId));
  }
  function getLastItem(bookId) {
    var v = bookId ? ssGet(LAST_ITEM_KEY + bookId) : '';
    return (v && /^\d{6,}$/.test(v)) ? v : '';
  }

  // 带标题的目录，复用 dirCache（10 分钟有效），供导航与进度上报共用
  function getDirWithTitles(bookId) {
    var cached = dirCache[bookId];
    if (cached && cached.list && Date.now() - cached.ts < 10 * 60 * 1000) {
      return Promise.resolve(cached.list);
    }
    return fetchDirectory(bookId).then(function (list) {
      var we = dirCache[bookId] || {};
      we.list = list;
      we.ids = list.map(function (c) { return String(c.id); });
      we.ts = Date.now();
      dirCache[bookId] = we;
      return list;
    });
  }

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

  // 构建底部翻页条 + 目录抽屉（只建一次）
  function ensureReadNavDom() {
    if (readNav.panel && document.body && document.body.contains(readNav.panel)) return;
    if (!document.body) return;

    var nav = document.createElement('div');
    nav.id = 'fq-readnav';

    var prev = document.createElement('button');
    prev.className = 'fq-rn-prev';
    prev.textContent = '← 上一章';
    prev.addEventListener('click', function () { stepChapter(-1); });
    nav.appendChild(prev);

    var info = document.createElement('div');
    info.className = 'fq-rn-info';
    var prog = document.createElement('div');
    prog.className = 'fq-rn-prog';
    prog.textContent = '目录加载中…';
    var title = document.createElement('div');
    title.className = 'fq-rn-title';
    info.appendChild(prog);
    info.appendChild(title);
    nav.appendChild(info);

    var tocBtn = document.createElement('button');
    tocBtn.className = 'fq-rn-toc';
    tocBtn.textContent = '目录';
    tocBtn.addEventListener('click', openTocDrawer);
    nav.appendChild(tocBtn);

    var next = document.createElement('button');
    next.className = 'fq-rn-next';
    next.textContent = '下一章 →';
    next.addEventListener('click', function () { stepChapter(1); });
    nav.appendChild(next);

    var drawer = document.createElement('div');
    drawer.id = 'fq-toc-drawer';
    var dpanel = document.createElement('div');
    dpanel.className = 'fq-toc-panel';
    var dhead = document.createElement('div');
    dhead.className = 'fq-toc-head';
    var dtitle = document.createElement('span');
    dtitle.className = 'fq-toc-title';
    dtitle.textContent = '目录';
    dhead.appendChild(dtitle);
    var dclose = document.createElement('button');
    dclose.textContent = '关闭';
    dclose.addEventListener('click', closeTocDrawer);
    dhead.appendChild(dclose);
    dpanel.appendChild(dhead);
    var dlist = document.createElement('div');
    dlist.className = 'fq-toc-list';
    dpanel.appendChild(dlist);
    drawer.appendChild(dpanel);
    drawer.addEventListener('click', function (e) {
      if (e.target === drawer) closeTocDrawer();
    });

    document.body.appendChild(nav);
    document.body.appendChild(drawer);
    readNav.panel = nav;
    readNav.drawer = drawer;
  }

  function removeReadNavDom() {
    [readNav.panel, readNav.drawer].forEach(function (el) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    readNav.panel = null;
    readNav.drawer = null;
    readNav.bookId = '';
    readNav.chapters = [];
    readNav.index = -1;
  }

  function updateReadNav() {
    var nav = readNav.panel;
    if (!nav) return;
    var total = readNav.chapters.length;
    var idx = readNav.index;
    var prog = nav.querySelector('.fq-rn-prog');
    var title = nav.querySelector('.fq-rn-title');
    var prev = nav.querySelector('.fq-rn-prev');
    var next = nav.querySelector('.fq-rn-next');
    if (prog) {
      prog.textContent = total
        ? ('第 ' + (idx >= 0 ? idx + 1 : '?') + ' / 共 ' + total + ' 章')
        : '目录加载中…';
    }
    if (title) {
      var ch = idx >= 0 ? readNav.chapters[idx] : null;
      title.textContent = ch && ch.title ? ch.title : '';
    }
    if (prev) prev.disabled = idx <= 0;
    if (next) next.disabled = idx < 0 || idx >= total - 1;
  }

  // 加载目录并按当前章节定位导航（每个阅读页调用）
  function setupReadNav(bookId, itemId) {
    if (!bookId || !itemId || !isReader()) return;
    readNav.bookId = String(bookId);
    ensureReadNavDom();
    updateReadNav();
    getDirWithTitles(bookId).then(function (list) {
      if (!isReader() || readNav.bookId !== String(bookId)) return;
      readNav.chapters = list;
      var pos = -1;
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(itemId)) { pos = i; break; }
      }
      readNav.index = pos;
      rememberLastItem(bookId, itemId);
      updateReadNav();
      renderToc();
    }).catch(function (e) {
      var prog = readNav.panel && readNav.panel.querySelector('.fq-rn-prog');
      if (prog) prog.textContent = '目录加载失败';
      var dl = document.querySelector('#fq-toc-drawer .fq-toc-list');
      if (dl) dl.innerHTML = '<div class="fq-toc-status">目录加载失败：' + escapeHtml(e.message) + '</div>';
    });
  }

  function renderToc() {
    var dlist = document.querySelector('#fq-toc-drawer .fq-toc-list');
    if (!dlist) return;
    if (!readNav.chapters.length) {
      dlist.innerHTML = '<div class="fq-toc-status">目录加载中…</div>';
      return;
    }
    var cur = itemIdFromUrl(location.pathname) || (readNav.index >= 0 ? readNav.chapters[readNav.index].id : '');
    var html = '';
    for (var i = 0; i < readNav.chapters.length; i++) {
      var c = readNav.chapters[i];
      var active = String(c.id) === String(cur) ? ' fq-cur' : '';
      html += '<div class="fq-toc-item' + active + '" data-fq-id="' + escapeAttr(c.id) + '">' +
              '<span class="fq-toc-idx">' + (i + 1) + '</span>' +
              '<span>' + escapeHtml(c.title || ('第' + (i + 1) + '章')) + '</span></div>';
    }
    dlist.innerHTML = html;
    Array.prototype.forEach.call(dlist.querySelectorAll('.fq-toc-item'), function (it) {
      it.addEventListener('click', function () {
        gotoChapter(this.getAttribute('data-fq-id'));
      });
    });
    // 把当前章滚到可见
    var curEl = dlist.querySelector('.fq-cur');
    if (curEl && curEl.scrollIntoView) {
      try { curEl.scrollIntoView({ block: 'center' }); } catch (e) { }
    }
  }

  function openTocDrawer() {
    if (!readNav.drawer) return;
    renderToc();
    readNav.drawer.classList.add('fq-open');
  }
  function closeTocDrawer() {
    if (readNav.drawer) readNav.drawer.classList.remove('fq-open');
  }

  // 按目录顺序翻章；目录没加载好时用当前 URL 的 ID 兜底从 fetchDirectory 找
  function stepChapter(delta) {
    var target = '';
    var cur = itemIdFromUrl(location.pathname);
    if (readNav.chapters.length) {
      var pos = -1;
      for (var i = 0; i < readNav.chapters.length; i++) {
        if (String(readNav.chapters[i].id) === String(cur)) { pos = i; break; }
      }
      var next = pos + delta;
      if (pos === -1 || next < 0 || next >= readNav.chapters.length) return;
      target = String(readNav.chapters[next].id);
    } else {
      gotoNextChapterById();   // 异步兜底
      return;
    }
    gotoChapter(target);
  }

  function gotoChapter(itemId) {
    if (!itemId) return;
    closeTocDrawer();
    if (readNav.bookId) rememberLastItem(readNav.bookId, itemId);
    ssSet('fq_autoread_on', ssGet('fq_autoread_on') || '0');  // 维持自动阅读开关状态
    location.href = '/reader/' + itemId;
  }

  // 普通书：保留官网正文，只监听官网内容加载完成，供自动阅读/语音使用。
  // 若官网正文一直为空且页面带受限版权字段，自动补上脚本读标记。
  var officialWatchToken = 0;
  function watchOfficialContent(itemId) {
    var token = ++officialWatchToken;
    var start = Date.now();
    var timer = setInterval(function () {
      if (token !== officialWatchToken || !isReader() ||
          itemIdFromUrl(location.pathname) !== String(itemId)) {
        clearInterval(timer);
        return;
      }
      var box = getBox();
      var text = box ? String(box.textContent || '').replace(/\s+/g, '') : '';
      if (text.length > 30) {
        clearInterval(timer);
        try { notifyAutoReadContentLoaded(); } catch (e) { console.warn('[fq] autoRead 通知异常', e); }
        try { notifySpeechContentLoaded(); } catch (e) { console.warn('[fq] 语音通知异常', e); }
        return;
      }
      if (Date.now() - start > 3500) {
        clearInterval(timer);
        if (isRestrictedBookPage()) {
          setScriptReadFlag(bookIdFromPage(), itemId);
          runReader(itemId);
        }
      }
    }, 300);
  }

  async function runReader(itemId) {
    var token = ++readerToken;
    var box = await waitFor(getBox, 10000);
    if (!box) { showBadge('未找到正文容器，页面结构可能已变', 'err'); return; }
    if (token !== readerToken) return;

    // 所有书统一用自建后端替换正文（锁章全文 + 正文图片）并上报阅读进度，
    // 这是脚本的核心功能；「脚本读」按钮只针对受限书，是官网不给正文时的手动入口。
    showLoading();                               // 先清空旧章内容
    box = getBox() || box;
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
      // 自建阅读导航（受限书官网无目录/翻页，这里自建）
      if (currentBook && currentBook.id) {
        try { setupReadNav(currentBook.id, itemId); } catch (ne) { console.warn('[fq] 阅读导航异常', ne); }
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
        eb.innerHTML = '<div class="fq-loading" style="color:#c62828;flex-direction:column">' +
                       '<div>正文加载失败：' + escapeHtml(e.message) + '</div>' +
                       '<div style="font-size:11px;color:#999;margin-top:4px">请确认自建后端已启动（127.0.0.1:18921）</div>' +
                       '<button class="fq-retry-load" style="margin-top:10px;padding:6px 14px;' +
                       'border:1px solid #ff6a00;border-radius:6px;background:#fff6ef;color:#ff6a00;' +
                       'cursor:pointer;font-size:12px">重试加载正文</button></div>';
        var retryBtn = eb.querySelector('.fq-retry-load');
        if (retryBtn) {
          retryBtn.addEventListener('click', function () { runReader(itemId); });
        }
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
      // 自建目录已加载时，按目录 ID 翻章最可靠（受限书官网无「下一章」按钮）
      var curId = itemIdFromUrl(location.pathname);
      var pos = -1;
      for (var i = 0; i < readNav.chapters.length; i++) {
        if (String(readNav.chapters[i].id) === String(curId)) { pos = i; break; }
      }
      if (pos >= 0 && pos + 1 < readNav.chapters.length) {
        gotoChapter(String(readNav.chapters[pos + 1].id));
        return;
      }
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
          ssSet(TTS_NEXT_KEY, '');
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
    closeTocDrawer();
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
    pendingStartOnLoad: false,
    lastAutoStart: 0            // 避免同一次加载被多个通知重复启动/重启朗读
  };

  var TTS_POS_KEY = 'fq_tts_pos_v1';
  // 翻章会重新加载页面，内存里的 pendingStartOnLoad 会丢失，必须跨页保存
  var TTS_NEXT_KEY = 'fq_tts_pending_next_v1';
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
    tts.lastAutoStart = Date.now();
    ssSet(TTS_NEXT_KEY, '');
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
    ssSet(TTS_NEXT_KEY, '');
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
      ssSet(TTS_NEXT_KEY, '1');
      showBadge('本章朗读完毕，正在翻到下一章…', 'info');
      advanceChapter();
    } else {
      showBadge('本章朗读完毕', 'ok');
    }
  }

  function notifySpeechContentLoaded() {
    // 同一次正文加载会被 watch/runReader 通知两次，避免刚启动就被 cancel 掉
    if (tts.speaking && Date.now() - tts.lastAutoStart < 2000) return;
    // 翻章后是全新页面，pending 标记存在 sessionStorage 里
    var pending = tts.pendingStartOnLoad || ssGet(TTS_NEXT_KEY) === '1';
    if (pending) {
      tts.pendingStartOnLoad = false;
      ssSet(TTS_NEXT_KEY, '');
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
    hijackReaderBack();
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

  // 详情页「脚本读本章」：优先用页面上的阅读入口章节，否则从后端目录取第一章
  function readFromBookPage() {
    var bid = bookIdFromPage();
    var href = findReaderHref();
    var iid = href ? itemIdFromUrl(href) : '';
    openScriptReader(bid, iid);
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

    var shelfBtn = document.createElement('button');
    shelfBtn.className = 'fq-shelf-btn';
    shelfBtn.textContent = '脚本读本章（仅受限书）';
    shelfBtn.style.cssText = 'width:100%;padding:7px 0;margin-top:8px;border:1px solid #ff6a00;' +
                             'border-radius:6px;cursor:pointer;background:#fff6ef;color:#ff6a00;' +
                             'font-size:12px;font-weight:600;display:none';
    shelfBtn.addEventListener('click', readFromBookPage);

    panel.appendChild(head);
    panel.appendChild(status);
    panel.appendChild(btn);
    panel.appendChild(shelfBtn);
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
      var limited = hasCopyrightNotice(document.body && document.body.innerText);
      var shelfBtn = panel && panel.querySelector('.fq-shelf-btn');
      if (shelfBtn) shelfBtn.style.display = limited ? '' : 'none';
      if (panel && !downloading) {
        if (limited) panelStatus('版权受限：点「脚本读本章」用自建后端阅读', '#ef6c00');
        else panelStatus(n ? '共 ' + n + ' 章，可下载 / 官网阅读' : '正在读取章节列表…', n ? '#2e7d32' : '#666');
      }
      if (!n && tries++ < 30) setTimeout(refresh, 500);
    })();
  }

  // 从 React fiber 里提取 book_id / item_id 及版权受限元数据
  function bookIdsFromFiber(node) {
    var result = { bookId: '', itemId: '', restricted: false, meta: {} };
    var fiber = null;
    for (var k in node) {
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
        fiber = node[k];
        break;
      }
    }
    var metaKeys = ['final_platform_visibility', 'item_show_title',
                    'real_chapter_order', 'genre'];
    var depth = 0;
    while (fiber && depth++ < 15) {
      // React 元素的 key（书封 key 就是 book_id）
      if (!result.bookId && fiber.key && /^\d{6,}$/.test(String(fiber.key))) {
        result.bookId = String(fiber.key);
      }
      var props = fiber.memoizedProps || fiber.pendingProps || null;
      if (props) {
        var b = props.book || props.data || props.item || null;
        var bd = props.bookDetail || props.detail || props.book_detail || null;
        [b, bd, props].forEach(function (o) {
          if (!o || typeof o !== 'object') return;
          metaKeys.forEach(function (mk) {
            if (result.meta[mk] === undefined && o[mk] !== undefined) {
              result.meta[mk] = o[mk];
            }
          });
        });
        var bid = (b && (b.book_id || b.bookId)) || (bd && (bd.book_id || bd.bookId)) ||
                  props.book_id || props.bookId;
        var iid = (bd && (bd.item_id || bd.itemId)) || (b && (b.item_id || b.itemId)) ||
                  props.item_id || props.itemId;
        if (bid && /^\d{6,}$/.test(String(bid))) result.bookId = String(bid);
        if (iid && /^\d{6,}$/.test(String(iid))) result.itemId = String(iid);
      }
      if (result.bookId && result.itemId && result.restricted) break;
      fiber = fiber.return;
    }
    result.restricted = isRestrictedMeta(result.meta);
    return result;
  }

  function makeShelfReadButton(bid, iid) {
    var b = document.createElement('div');
    b.className = 'fq-shelf-read';
    b.textContent = '脚本读';
    b.title = '仅版权受限书：用自建后端阅读';
    if (bid) b.setAttribute('data-fq-bid', bid);
    if (iid) b.setAttribute('data-fq-iid', iid);
    b.style.cssText = 'position:absolute;top:4px;right:4px;z-index:99999;padding:2px 6px;' +
      'background:#ff6a00;color:#fff;border-radius:4px;font-size:11px;line-height:1.4;' +
      'cursor:pointer;opacity:.95;box-shadow:0 1px 5px rgba(0,0,0,.3)';
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();   // 阻止冒泡到书卡的 onClick（否则受限书只弹版权 toast）
      openScriptReader(this.getAttribute('data-fq-bid') || '',
                       this.getAttribute('data-fq-iid') || '');
    });
    return b;
  }

  // ------------------------------------------------------------------
  // 书架/列表页：仅给版权受限书卡片注入「脚本读」入口，绕过官网版权弹窗
  // ------------------------------------------------------------------
  var shelfInjectTimer = null;
  function injectShelfReadButtons() {
    if (!document.body || isReader()) return;

    var pageLimited = hasCopyrightNotice(document.body && document.body.innerText);

    // 策略 A：详情页/搜索页里的 <a href="/page/..."> 链接（仅受限书）
    var links = document.querySelectorAll('a[href*="/page/"]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.getAttribute('data-fq-read-bound') === '1') continue;
      var m = String(a.getAttribute('href') || '').match(/\/page\/(\d{6,})/);
      if (!m) continue;
      var idsA = bookIdsFromFiber(a);
      if (!pageLimited && !idsA.restricted) continue;   // 普通书不显示脚本读
      a.setAttribute('data-fq-read-bound', '1');
      var hostA = a;
      var pa = a.parentElement;
      for (var ja = 0; ja < 4 && pa; ja++) {
        var posA = '';
        try { posA = (window.getComputedStyle && window.getComputedStyle(pa).position) || ''; } catch (e) { }
        if (posA === 'relative' || posA === 'absolute' || posA === 'fixed') { hostA = pa; break; }
        pa = pa.parentElement;
      }
      if (hostA === a) { try { a.style.position = 'relative'; } catch (e) { } }
      hostA.appendChild(makeShelfReadButton(m[1], ''));
    }

    // 策略 B：书架页 React 书卡 div.book-card（无 <a href>），从 fiber 取 book_id / item_id
    // 只取根节点（class 含 "book-card-"，排除 book-card__normal / book-card-skeleton 等子元素）
    var allCardish = document.querySelectorAll('div[class*="book-card"]');
    var cards = [];
    for (var q = 0; q < allCardish.length; q++) {
      var cls = String(allCardish[q].className || '');
      if (/\bbook-card-\w+/.test(cls) && !/__/.test(cls) && cls.indexOf('skeleton') < 0) {
        cards.push(allCardish[q]);
      }
    }
    for (var j = 0; j < cards.length; j++) {
      var card = cards[j];
      if (card.getAttribute('data-fq-read-bound') === '1') continue;
      var ids = bookIdsFromFiber(card);
      // 兜底：从封面图节点（key=book_id）再取一次
      if (!ids.bookId && card.querySelector) {
        var cover = card.querySelector('[class*="book-group-cover-image"]');
        if (cover) {
          var cids = bookIdsFromFiber(cover);
          if (cids.bookId) ids.bookId = cids.bookId;
          if (cids.itemId) ids.itemId = cids.itemId;
          if (cids.restricted) { ids.restricted = true; ids.meta = cids.meta; }
        }
      }
      if (!ids.bookId && !ids.itemId) continue;   // 拿不到 ID，等下次扫描（React 可能还没渲染好）
      if (!ids.restricted) continue;              // 普通书走官网，不注入脚本读
      card.setAttribute('data-fq-read-bound', '1');
      var pos = '';
      try { pos = (window.getComputedStyle && window.getComputedStyle(card).position) || ''; } catch (e) { }
      if (pos === 'static') { try { card.style.position = 'relative'; } catch (e) { } }
      card.appendChild(makeShelfReadButton(ids.bookId, ids.itemId));
    }
  }

  function watchShelf() {
    if (shelfInjectTimer) return;
    shelfInjectTimer = setInterval(injectShelfReadButtons, 1000);
    injectShelfReadButtons();
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
      GM_registerMenuCommand('重新加载自建正文', function () {
        if (!isReader()) {
          showBadge('请到小说阅读页再重新加载正文', 'warn');
          return;
        }
        var id = itemIdFromUrl(location.pathname);
        setScriptReadFlag(bookIdFromPage(), id);
        showBadge('正在用自建后端重新加载正文…', 'info');
        runReader(id);
      });
    }
    if (isReader()) {
      removePanel();
      watchReader();
    } else {
      // 书架页、详情页、首页等非阅读页：注入「脚本读」入口
      removeReadNavDom();
      watchShelf();
      if (isBookPage()) {
        removeAutoReadPanel();
        stopAutoRead(true);
        stopSpeech(true);
        watchBookPage();
      } else {
        removeAutoReadPanel();
        stopAutoRead(true);
        stopSpeech(true);
      }
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
