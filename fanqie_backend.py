#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
番茄小说 代理后端（纯 Python）。

元数据策略（2026-11 实测：App 详情/目录接口在当前出口稳定空 body，故详情/目录仅用官网 Web）：
  - 详情  仅官网 Web  /api/book/info               （免签名，字段完整）
  - 目录  仅官网 Web  /api/reader/directory/detail （免签名，一次返回整本）
  - 搜索  三路聚合：APP bookapi + 头条 novel.snssdk + Web a_bogus，按 book_id 去重合并
      - APP    api5 /reading/bookapi/search/page 或 xGorgon search/tab（部分 IP 空 body，容错跳过）
      - 头条   novel.snssdk.com/.../channel/homepage/search/search/v1 aid=2329（免签，精确匹配）
      - Web    /api/author/search/search_book/v1（a_bogus 网页签名，本地生成）

正文默认走 App 渠道（appchannel.py，移植自 fqapp-master）：
  - novel.snssdk.com/api/novel/book/reader/content/v1
  - x-argus / x-ladon / x-khronos 签名 + DH 密钥交换 + AES-256-CBC
  - 返回明文 HTML（无 PUA 字体混淆），锁章（isChapterLock）也是整章全文
回退链路：App 渠道失败 → 网页 /api/reader/full（需 a_bogus + FONT_MAP 字体解密；
锁章未带 SVIP Cookie 时只有约 200 字试读）。

依赖：gmssl（SM3）、pycryptodome（AES）、abogus.py、fontmap.py、appchannel.py。

运行：
    pip install gmssl pycryptodome
    python fanqie_backend.py                 # 默认监听 18921，正文走 App 渠道
    python fanqie_backend.py --port=18921
    python fanqie_backend.py --channel=web   # 强制走网页接口
    python fanqie_backend.py --test          # 端到端冒烟测试（需联网）

可选：SVIP 账号的网页 Cookie（仅 --channel=web 时用于读锁章全文）
    export FQ_COOKIE="sessionid=..."  或  --cookie="sessionid=..."
"""
import sys
import os
import re
import json
import html as _html
import ssl
import socket
import time
import base64
import gzip
import hashlib
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

try:
    from abogus import ABogus
except Exception as e:  # noqa
    sys.stderr.write("[fanqie] 无法加载 abogus（请 pip install gmssl）：%s\n" % e)
    ABogus = None

try:
    from fontmap import FONT_MAP
except Exception as e:  # noqa
    sys.stderr.write("[fanqie] 无法加载 fontmap：%s\n" % e)
    FONT_MAP = {}

try:
    from searchmap import SEARCH_MAP
except Exception as e:  # noqa
    sys.stderr.write("[fanqie] 无法加载 searchmap：%s\n" % e)
    SEARCH_MAP = {}

try:
    import appchannel  # App 渠道正文（DH 加密），可读锁章全文
except Exception as e:  # noqa
    sys.stderr.write("[fanqie] 无法加载 appchannel（需 pycryptodome + gmssl）：%s\n" % e)
    appchannel = None

DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
REF_BASE = "https://fanqienovel.com/"

# Web 侧对 isChapterLock=true 的章节只返回约 200 字试读（页面提示：
# 「扫码下载APP免费读，SVIP网页畅读」/「会员登录后，可在网页畅读全文」）。
# 传入 SVIP 账号的网页 Cookie 后，/api/reader/full 才会返回整章。
# 用法：export FQ_COOKIE="sessionid=xxx; ..."  或  --cookie="sessionid=xxx"
COOKIE = os.environ.get("FQ_COOKIE", "").strip()

# 正文渠道：app（默认，走 DH 加密通道，锁章也能拿全文）| web（旧的网页接口）
# 用 FQ_CHANNEL=web 或 --channel=web 关闭 App 渠道。
CHANNEL = os.environ.get("FQ_CHANNEL", "app").strip().lower() or "app"

# 说明：详情/目录已固定仅用官网 Web（App 接口在多数出口返回空 body），
#       META_CHANNEL / DIR_SOURCE 仅保留兼容旧命令行参数，不再影响这两项。
META_CHANNEL = os.environ.get("FQ_META_CHANNEL", "app").strip().lower() or "app"
DIR_SOURCE = os.environ.get("FQ_DIR_SOURCE", "auto").strip().lower() or "auto"

# 全局 SSL 上下文（对部分环境放宽校验）
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

PUA_RE = re.compile(r"[\ue000-\uf8ff]", re.IGNORECASE)

# 正文里的图片保留为标记，油猴脚本负责渲染（与 appchannel.py 保持一致）
IMG_TOKEN = "[fqimg]%s[/fqimg]"
_RE_IMG = re.compile(r"(?is)<img\b[^>]*>")
_IMG_URL_ATTRS = ("src", "data-src", "data-original", "data-lazy-src",
                  "data-url", "data-source", "original", "lazy-src",
                  "srcset", "data-srcset")
_RE_IMG_ATTR = re.compile(
    r"(?is)\b(" + "|".join(_IMG_URL_ATTRS) + r")\s*=\s*"
    r"(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))"
)


def image_url_from_tag(tag):
    attrs = {}
    for m in _RE_IMG_ATTR.finditer(tag):
        attrs.setdefault(m.group(1).lower(), m.group(2) or m.group(3) or m.group(4) or "")
    for key in _IMG_URL_ATTRS:
        raw = _html.unescape(attrs.get(key, "")).strip()
        if not raw:
            continue
        if key.endswith("srcset"):
            parts = raw.split(",")[0].strip().split()
            raw = parts[0] if parts else ""
            if not raw:
                continue
        if raw.startswith("//"):
            raw = "https:" + raw
        elif raw.startswith("/") and not raw.startswith("//"):
            raw = "https://fanqienovel.com" + raw
        if re.match(r"(?i)^https?://", raw) or re.match(r"(?i)^data:image/", raw):
            return raw
    return ""


def dec_text(s):
    """把字符串里的私有区（PUA）码点还原为真实汉字（内容正文用 FONT_MAP）。"""
    if not s:
        return s
    return PUA_RE.sub(lambda m: FONT_MAP.get(ord(m.group(0)), m.group(0)), s)


def dec_search(s):
    """把搜索/列表接口的 PUA 码点还原为真实汉字（用 SEARCH_MAP）。"""
    if not s:
        return s
    return PUA_RE.sub(lambda m: SEARCH_MAP.get(ord(m.group(0)), m.group(0)), s)


def http_get(url, headers=None, timeout=20, binary=False):
    h = {"User-Agent": DEFAULT_UA}
    if COOKIE:
        h["Cookie"] = COOKIE
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    resp = urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX)
    body = resp.read()
    return body if binary else body.decode("utf-8", "ignore")


def http_get_json(url, headers=None, timeout=20):
    raw = http_get(url, headers=headers, timeout=timeout)
    return json.loads(raw)


# --------------------------------------------------------------------------
# App 渠道元数据（搜索 / 详情 / 目录，参考 shareBookSource.json）
# --------------------------------------------------------------------------
APP_UA = "com.dragon.read"
APP_META_HOST = "https://reading.snssdk.com"
_APP_DEVICE_HEADER = None
_APP_DEVICE_LOCK = threading.Lock()


def _app_http_get(url, headers=None, timeout=10):
    h = {"User-Agent": APP_UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    resp = urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX)
    body = resp.read()
    if ((resp.headers.get("content-encoding") or "").lower() == "gzip"
            or body[:2] == b"\x1f\x8b"):
        body = gzip.decompress(body)
    return body.decode("utf-8", "ignore")


def _app_tt_encrypt(data):
    """设备注册的 TT 加密（ shareBookSource.json 的 TT() 移植）。"""
    if appchannel is None:
        raise RuntimeError("appchannel 不可用，无法注册 App 设备")
    const_key = base64.b64decode(
        "TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/"
        "COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA==")
    value = os.urandom(32)
    arr = hashlib.sha512(hashlib.sha512(value).digest() + const_key).digest()
    key, iv = arr[:16], arr[16:32]
    gz = gzip.compress(data.encode("utf-8"), mtime=0)
    plain = hashlib.sha512(gz).digest() + gz
    ct = appchannel._aes_cbc_enc(appchannel._pkcs7_align(plain), key, iv)
    return bytes([116, 99, 5, 16, 0, 0]) + value + ct


def _app_device_header():
    """注册/缓存 device_id & iid，返回 xGorgon 所需的公共参数串。"""
    global _APP_DEVICE_HEADER
    with _APP_DEVICE_LOCK:
        if _APP_DEVICE_HEADER:
            return _APP_DEVICE_HEADER
        android_id = os.urandom(8).hex()
        digest = hashlib.md5(android_id.encode("ascii")).hexdigest()
        openudid = (digest + digest[:8]).lower()
        model = "25053RT47C"
        payload = {
            "header": {
                "package": "com.dragon.read",
                "openudid": openudid,
                "device_model": model,
            }
        }
        body = _app_tt_encrypt(json.dumps(payload, ensure_ascii=False,
                                          separators=(",", ":")))
        req = urllib.request.Request(
            "https://i.snssdk.com/service/2/device_register/",
            data=body,
            method="POST",
            headers={"User-Agent": APP_UA, "Content-Type": "application/json"},
        )
        resp = urllib.request.urlopen(req, timeout=10, context=_SSL_CTX)
        j = json.loads(resp.read().decode("utf-8", "ignore"))
        device_id = str(j.get("device_id_str") or j.get("device_id") or "")
        install_id = str(j.get("install_id_str") or j.get("install_id") or "")
        if not device_id or not install_id:
            raise RuntimeError("App 设备注册响应缺少 device_id/install_id")
        _APP_DEVICE_HEADER = ("device_id=%s&device_type=%s&iid=%s"
                              % (device_id, model, install_id))
        return _APP_DEVICE_HEADER


def _rhex_byte(n):
    return int(format(n, "02x")[::-1], 16)


def _rbin_byte(n):
    return int(format(n, "08b")[::-1], 2)


def _app_xgorgon(path, params):
    """shareBookSource.json 中 xGorgon() 的 0404b0d30000 版本。"""
    parts = [params, "aid=1967", "channel=0", "os_version=0",
             "app_name=novelapp", "version_code=99999",
             "device_platform=android", _app_device_header()]
    query = "&".join(sorted(p for p in parts if p))
    url = APP_META_HOST + "/reading/bookapi/" + path + "/v/?" + query

    hexs = hashlib.md5(query.encode("utf-8")).hexdigest() + "0" * 64
    key = [0xDF, 0x77, 0xB9, 0x40, 0xB9, 0x9B, 0x84, 0x83,
           0xD1, 0xB9, 0xCB, 0xD1, 0xF7, 0xC2, 0xB9, 0x85,
           0xC3, 0xD0, 0xFB, 0xC3]
    values = []
    for i in range(0, 9, 4):
        chunk = hexs[i * 8:(i + 1) * 8]
        values.extend(int(chunk[j * 2:j * 2 + 2], 16) for j in range(4))
    ts = int(time.time())
    values += [0, 6, 11, 28,
               (ts >> 24) & 255, (ts >> 16) & 255,
               (ts >> 8) & 255, ts & 255]
    values = [values[i] ^ key[i % 20] for i in range(20)]
    for i in range(20):
        c = _rbin_byte(_rhex_byte(values[i]) ^ values[(i + 1) % 20])
        values[i] = ((c ^ 0xFFFFFFFF) ^ 20) & 255
    sig = "0404b0d30000" + "".join("%02x" % v for v in values)
    return url, {"User-Agent": APP_UA, "X-Khronos": str(ts), "X-Gorgon": sig}


def _app_api_json(path, params, timeout=10):
    url, headers = _app_xgorgon(path, params)
    raw = _app_http_get(url, headers=headers, timeout=timeout)
    if not raw.strip():
        raise RuntimeError("App 接口返回空响应: %s" % path)
    return json.loads(raw)


def _search_rows_to_items(rows):
    """把各搜索源的书籍行统一成书源期望的 {book_data:{...}} 结构。"""
    out = []
    for b in rows:
        name = re.sub(r"</?em>", "", str(b.get("book_name") or b.get("title") or ""))
        bid = str(b.get("book_id") or b.get("bookId") or "")
        if not bid or not name:
            continue
        out.append({"book_data": {
            "book_id": bid,
            "book_name": dec_text(name),
            "author_name": dec_text(str(b.get("author_name") or b.get("author") or "")),
            "cover_url": b.get("cover_url") or b.get("thumb_url") or b.get("thumbUri") or "",
            "abstract": dec_text(str(b.get("abstract") or b.get("book_abstract") or "")),
            "category": dec_text(str(b.get("category") or "")),
            "new_chapter_title": dec_text(str(b.get("new_chapter_title") or b.get("last_chapter_title") or "")),
            "word_number": b.get("word_number") or "",
            "score": b.get("score") or "",
        }})
    return out


def toutiao_search(query, offset=0, count=10, aid="2329"):
    """头条搜索：novel.snssdk.com 频道搜索（免签名、精确匹配，实测可用）。"""
    params = {"aid": aid, "q": query, "offset": str(int(offset))}
    url = ("https://novel.snssdk.com/api/novel/channel/homepage/search/search/v1?"
           + urllib.parse.urlencode(params))
    j = json.loads(_app_http_get(url, timeout=12))
    if str(j.get("code")) != "0":
        raise RuntimeError("头条搜索 code=%s：%s" % (j.get("code"), j.get("message", "")))
    rows = ((j.get("data") or {}).get("ret_data") or [])
    items = []
    for b in rows:
        # 头条 title 字段即书名，常带 <em> 高亮标签；thumb_url 有时是签名缩略图，可用
        title = re.sub(r"</?em>", "", str(b.get("title") or b.get("book_name") or ""))
        items.append({
            "book_id": str(b.get("book_id") or ""),
            "book_name": title,
            "author_name": str(b.get("author") or ""),
            "cover_url": b.get("thumb_url") or "",
            "abstract": str(b.get("abstract") or ""),
            "category": str(b.get("category") or ""),
            "new_chapter_title": str(b.get("last_chapter_title") or ""),
            "word_number": b.get("word_number") or "",
            "score": b.get("score") or "",
            "source": "toutiao",
        })
    return items


def app_fetch_search(query, offset=0, count=10):
    """APP 搜索：reading.snssdk bookapi search/tab（xGorgon + 设备注册）。

    当前部分出口 IP 返回空 body（实测），聚合时失败会被跳过，不影响其它两路。
    失败会抛异常，由 fetch_search 捕获。
    """
    j = _app_api_json("search/tab",
                      "tab_type=3&query=%s&passback=%d"
                      % (urllib.parse.quote(query), int(offset)), timeout=12)
    if str(j.get("code")) not in ("0", 0):
        raise RuntimeError("APP 搜索 code=%s" % j.get("code"))
    tabs = j.get("search_tabs") or []
    # tab_type=3 通常是「搜书」，兼容取有数据的 tab
    rows = []
    for t in tabs:
        d = t.get("data") or []
        if d:
            rows = d
            break
    items = []
    for b in rows:
        items.append({
            "book_id": str(b.get("book_id") or ""),
            "book_name": str(b.get("book_name") or b.get("title") or ""),
            "author_name": str(b.get("author") or b.get("author_name") or ""),
            "cover_url": b.get("thumb_url") or b.get("cover_url") or "",
            "abstract": str(b.get("abstract") or ""),
            "category": str(b.get("category") or ""),
            "new_chapter_title": str(b.get("last_chapter_title") or ""),
            "word_number": b.get("word_number") or "",
            "score": b.get("score") or "",
            "source": "app",
        })
    return items


# --------------------------------------------------------------------------
# App 元数据辅助：借「正文接口」拿 novel_data（含书籍元数据 + next_item_id）
# 说明：reading.bookapi/detail 与 directory/all_items 在部分出口 IP 会被静默
#       拒绝（返回空 body）。正文接口 reader/content 用的是另一套签名
#       （x-ladon/x-argus），实测稳定可用；其 novel_data 同时带书籍元数据、
#       章节标题、字数和 next/pre_item_id，可据此拼出详情与整本目录。
# --------------------------------------------------------------------------
def _app_novel_meta(item_id, timeout=12):
    """用正文渠道签名请求，只取 novel_data（不解密正文），返回 dict。"""
    if appchannel is None:
        raise RuntimeError("appchannel 不可用")
    query = appchannel.build_query(item_id)
    y, a = appchannel.generate_y()
    ts = int(time.time())
    headers = {
        "User-Agent": appchannel.UA_NOVEL,
        "Accept-Encoding": "gzip, deflate",
        "y": y,
        "x-ss-req-ticket": str(ts * 1000),
        "x-khronos": str(ts),
        "x-ladon": appchannel.ladon_encrypt(ts, appchannel._LC_ID, 13),
        "x-argus": appchannel.argus_sign(query, ts, 13, appchannel._LC_ID),
    }
    url = appchannel.HOST_CONTENT + "?" + query
    req = urllib.request.Request(url, headers=headers)
    resp = urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX)
    body = resp.read()
    if ((resp.headers.get("content-encoding") or "").lower() == "gzip"
            or body[:2] == b"\x1f\x8b"):
        body = gzip.decompress(body)
    j = json.loads(body.decode("utf-8", "ignore"))
    if str(j.get("code")) not in ("0", 0):
        raise RuntimeError("正文元数据接口 code=%s" % j.get("code"))
    return (j.get("data") or {}).get("novel_data") or {}


def _app_first_item(book_id, timeout=12):
    """用 App 搜索结果里的 item_schema_url 提取该书首章 item_id。"""
    url = ("https://novel.snssdk.com/api/novel/channel/homepage/search/search/v1?"
           + urllib.parse.urlencode({"aid": "13", "q": str(book_id), "offset": "0"}))
    # 按书号直接搜常搜不到，改为按书名搜（详情调用方通常有书名；这里再兜底）
    j = json.loads(_app_http_get(url, timeout=timeout))
    rows = ((j.get("data") or {}).get("ret_data") or [])
    for b in rows:
        if str(b.get("book_id")) == str(book_id):
            schema = urllib.parse.unquote(str(b.get("item_schema_url") or ""))
            m = re.search(r"item_id=(\d+)", schema)
            if m:
                return m.group(1)
    # 没精确命中：取第一条结果的 item_id（按书号搜索 Book_id 相关时通常就是它）
    if rows:
        schema = urllib.parse.unquote(str(rows[0].get("item_schema_url") or ""))
        m = re.search(r"item_id=(\d+)", schema)
        if m and str(rows[0].get("book_id")) == str(book_id):
            return m.group(1)
    return ""


def _app_first_item_by_name(name, book_id, timeout=12):
    """按书名搜，命中指定 book_id 时返回其首章 item_id 和书籍元数据。"""
    url = ("https://novel.snssdk.com/api/novel/channel/homepage/search/search/v1?"
           + urllib.parse.urlencode({"aid": "13", "q": name, "offset": "0"}))
    j = json.loads(_app_http_get(url, timeout=timeout))
    rows = ((j.get("data") or {}).get("ret_data") or [])
    for b in rows:
        if str(b.get("book_id")) == str(book_id):
            schema = urllib.parse.unquote(str(b.get("item_schema_url") or ""))
            m = re.search(r"item_id=(\d+)", schema)
            return (m.group(1) if m else ""), b
    return "", None


def app_fetch_detail(book_id):
    """App 详情：优先 reading.bookapi，失败则用正文 novel_data 补全（纯 App）。"""
    # 方案 A：官方详情接口（有些出口 IP 可用）
    try:
        j = _app_api_json("detail", "book_id=" + urllib.parse.quote(str(book_id), safe=""))
        d = j.get("page") or j.get("data") or {}
        if isinstance(d, list):
            d = d[0] if d else {}
        info = (d.get("book_info") or d.get("bookInfo") or d) if isinstance(d, dict) else {}
        name = (info.get("book_name") or info.get("bookName") or info.get("title") or "")
        if name:
            return {"code": 0, "data": {
                "book_id": str(info.get("book_id") or info.get("bookId") or book_id),
                "book_name": dec_text(str(name)),
                "author_name": dec_text(str(info.get("author") or info.get("author_name") or "")),
                "cover_url": info.get("thumb_url") or info.get("cover_url") or "",
                "abstract": dec_text(str(info.get("abstract") or "")),
                "category": dec_text(str(info.get("category") or "")),
                "new_chapter_title": dec_text(str(info.get("last_chapter_title") or "")),
            }}
    except Exception:
        pass

    # 方案 B：先从 Web 详情拿书名（Web /api/book/info 稳定），再用书名走 App 搜索
    #         拿首章 item_id，最后用正文 novel_data 补全为完整 App 元数据。
    web = _fetch_detail_web(book_id)
    name = (web.get("data") or {}).get("book_name") or ""
    first_item = ""
    app_row = None
    if name:
        first_item, app_row = _app_first_item_by_name(name, book_id)
    if not first_item:
        first_item = _app_first_item(book_id)
    nv = _app_novel_meta(first_item) if first_item else {}
    src = nv or (app_row or {})
    book_name = (nv.get("book_name") or nv.get("title")
                 or (app_row or {}).get("title") or name)
    if not book_name:
        return web  # 实在拿不到 App 数据，回退 Web
    # 合并：书籍级字段以搜索/Web 为准（novel_data 的首章 word_number/chapter_title
    # 是「首章」而非全书，不能当书籍字数/最新章节用）；novel_data 只补它独有的字段。
    web_data = web.get("data") or {}
    return {"code": 0, "data": {
        "book_id": str(nv.get("book_id") or book_id),
        "book_name": dec_text(str(book_name)),
        "author_name": dec_text(str((app_row or {}).get("author")
                                    or nv.get("author") or web_data.get("author_name") or "")),
        "cover_url": ((app_row or {}).get("thumb_url")
                      or nv.get("thumb_url") or web_data.get("cover_url") or ""),
        "abstract": dec_text(str((app_row or {}).get("abstract")
                                 or web_data.get("abstract") or "")),
        "category": dec_text(str((app_row or {}).get("category")
                                 or nv.get("category") or web_data.get("category") or "")),
        "new_chapter_title": dec_text(str(web_data.get("new_chapter_title") or "")),
        "word_number": (app_row or {}).get("word_number") or web_data.get("word_number") or "",
        "copyright_info": dec_text(str(nv.get("copyright_info") or "")),
        "source": dec_text(str(nv.get("source") or "")),
        "isbn": str(nv.get("isbn") or ""),
    }}


def app_fetch_directory(book_id, max_chapters=5000, timeout=12):
    """App 目录：优先 reading.bookapi，失败则沿 novel_data.next_item_id 链遍历。"""
    # 方案 A：官方目录接口（有些出口 IP 可用）
    try:
        j = _app_api_json("directory/all_items",
                          "book_id=" + urllib.parse.quote(str(book_id), safe=""))
        d = j.get("data") or j.get("page") or {}
        items = ((d.get("item_data_list") or d.get("itemDataList") or d.get("chapterList"))
                 if isinstance(d, dict) else []) or []
        vols = []
        all_ids = []
        for c in items:
            if not isinstance(c, dict):
                continue
            iid = str(c.get("item_id") or c.get("itemId") or "")
            if not iid:
                continue
            vname = str(c.get("volume_name") or c.get("volumeName") or "第一卷：默认")
            if not vols or vols[-1].get("volumeName") != vname:
                vols.append({"volumeName": vname,
                             "volumeId": str(c.get("volume_id") or c.get("volumeId") or ""),
                             "chapterList": []})
            vols[-1]["chapterList"].append({
                "itemId": iid,
                "chapter_title": dec_text(str(c.get("title") or c.get("chapter_title") or "")),
                "firstPassTime": c.get("first_pass_time") or c.get("firstPassTime") or "",
                "chapterWordNumber": c.get("chapter_word_number") or c.get("chapterWordNumber") or "",
            })
            all_ids.append(iid)
        if vols:
            return {"code": 0, "data": {"chapterListWithVolume": vols, "allItemIds": all_ids}}
    except Exception:
        pass

    # 方案 B：从首章沿 next_item_id 链遍历（正文接口签名可用）
    # 先取首章：按书号搜不到时用 Web 详情拿书名再搜
    first_item = _app_first_item(book_id)
    if not first_item:
        try:
            web = _fetch_detail_web(book_id)
            name = (web.get("data") or {}).get("book_name") or ""
            if name:
                first_item, _ = _app_first_item_by_name(name, book_id)
        except Exception:
            pass
    if not first_item:
        raise RuntimeError("App 目录无法定位首章 item_id")

    chapters = []
    seen = set()
    cur = first_item
    while cur and cur not in seen and len(chapters) < max_chapters:
        seen.add(cur)
        nv = _app_novel_meta(cur, timeout=timeout)
        chapters.append({
            "itemId": cur,
            "chapter_title": dec_text(str(nv.get("chapter_title")
                                          or nv.get("origin_chapter_title") or "")),
            "firstPassTime": nv.get("first_pass_time") or "",
            "chapterWordNumber": nv.get("word_number") or "",
        })
        cur = str(nv.get("next_item_id") or "")
    if not chapters:
        raise RuntimeError("App 目录遍历无结果")
    return {"code": 0, "data": {
        "chapterListWithVolume": [{
            "volumeName": "正文卷",
            "volumeId": "",
            "chapterList": chapters,
        }],
        "allItemIds": [c["itemId"] for c in chapters],
    }}


# --------------------------------------------------------------------------
# a_bogus 生成（懒加载，避免重复实例化）
# --------------------------------------------------------------------------
_AB = None


def abogus_for(params_dict):
    global _AB
    if _AB is None:
        if ABogus is None:
            raise RuntimeError("abogus 不可用：请先 pip install gmssl")
        _AB = ABogus(DEFAULT_UA)
    return _AB.generate_a_bogus(params_dict)


# --------------------------------------------------------------------------
# 各路由实现
# --------------------------------------------------------------------------
# 搜索聚合时每路最多取多少条（避免某路刷屏，头条/Web 各 10 条典型）
_SEARCH_PER_SOURCE = int(os.environ.get("FQ_SEARCH_PER_SOURCE", "10") or 10)
# 聚合结果总上限
_SEARCH_TOTAL = int(os.environ.get("FQ_SEARCH_TOTAL", "30") or 30)


def fetch_search(query, offset=0, count=10):
    """搜索聚合：APP（xGorgon）+ 头条（免签）+ Web（a_bogus）三路合一。

    各路独立容错，任一成功即可返回；按 book_id 去重，先成功的源优先，
    后续源只补空缺字段（如某路无字数/评分）。返回结构保持与单路一致，
    兼容 番茄小说书源.json 的 ruleSearch。
    """
    per = max(int(count), _SEARCH_PER_SOURCE)
    collected = []       # item 列表（带 source）
    seen_ids = set()

    def absorb(items, name):
        for it in (items or []):
            bid = str(it.get("book_id") or "")
            if not bid:
                continue
            if bid in seen_ids:
                # 已存在：仅补齐空缺字段（不覆盖先到源的值）
                for prev in collected:
                    if str(prev.get("book_id")) == bid:
                        for k, v in it.items():
                            if k == "source":
                                continue
                            if not prev.get(k) and v:
                                prev[k] = v
                        break
                continue
            seen_ids.add(bid)
            collected.append(dict(it))

    # 1) 头条（当前出口最稳、精确匹配）
    try:
        absorb(toutiao_search(query, offset, per), "toutiao")
    except Exception as e:  # noqa
        sys.stderr.write("[fanqie] 头条搜索失败: %s\n" % e)

    # 2) Web（需 a_bogus，字段较全）
    try:
        absorb(_fetch_search_web(query, offset, per), "web")
    except Exception as e:  # noqa
        sys.stderr.write("[fanqie] Web 搜索失败: %s\n" % e)

    # 3) APP（xGorgon + 设备注册；部分 IP 空 body，失败跳过）
    try:
        absorb(app_fetch_search(query, offset, per), "app")
    except Exception as e:  # noqa
        sys.stderr.write("[fanqie] APP 搜索失败: %s\n" % e)

    collected = collected[:_SEARCH_TOTAL]
    out = _search_rows_to_items(collected)
    return {"code": 0, "search_tabs": [{"data": out}],
            "data": {"search_book_data_list": out}}


def _fetch_search_web(query, offset=0, count=10):
    """搜索（Web）：/api/author/search/search_book/v1 （需 a_bogus，本地生成）。"""
    page_index = int(offset) // int(count) if int(count) else 0
    params = {
        "filter": "127,127,127,127",
        "page_count": str(count),
        "page_index": str(page_index),
        "query_type": "0",
        "query_word": query,
    }
    params["a_bogus"] = abogus_for(params)
    url = "https://fanqienovel.com/api/author/search/search_book/v1?" + urllib.parse.urlencode(params)
    j = http_get_json(url, headers={"Referer": REF_BASE})
    if j.get("code") != 0:
        msg = j.get("message", "未知错误")
        raise RuntimeError("搜索接口返回 code=%s：%s" % (j.get("code"), msg))
    books = (j.get("data") or {}).get("search_book_data_list") or []
    items = []
    for b in books:
        items.append({
            "book_id": str(b.get("book_id") or ""),
            "book_name": dec_search(b.get("book_name")),
            "author_name": dec_search(b.get("author")),
            "cover_url": b.get("thumb_url") or b.get("thumb_uri") or "",
            "abstract": dec_search(b.get("book_abstract")),
            "category": dec_search(b.get("category")),
            "new_chapter_title": dec_search(b.get("last_chapter_title")),
            "word_number": b.get("word_number") or "",
            "score": "",
            "source": "web",
        })
    return items


def fetch_detail(book_id):
    """详情：仅官网 Web /api/book/info（免签名，字段完整）。

    App reading.bookapi/detail 在当前出口稳定空 body，且需要 X-Gorgon +
    设备注册，收益低，故不再作为详情来源。
    """
    return _fetch_detail_web(book_id)


def _category_from_v2(raw):
    """从 categoryV2（JSON 数组字符串）里取分类名，兼容空 category/completeCategory。"""
    if not raw:
        return ""
    try:
        arr = json.loads(raw) if isinstance(raw, str) else raw
        names = [str(x.get("Name") or "") for x in arr if isinstance(x, dict) and x.get("Name")]
        return " ".join(names)
    except Exception:
        return str(raw) if isinstance(raw, str) else ""


def _fetch_detail_web(book_id):
    """详情：官网 Web /api/book/info （免签名）。"""
    url = "https://fanqienovel.com/api/book/info?bookId=" + str(book_id)
    j = http_get_json(url, headers={"Referer": REF_BASE + "page/" + str(book_id)})
    d = j.get("data") or {}
    category = (d.get("category") or d.get("completeCategory")
                or _category_from_v2(d.get("categoryV2")))
    return {
        "code": 0,
        "data": {
            "book_id": d.get("bookId"),
            "book_name": dec_text(d.get("bookName")),
            "author_name": dec_text(d.get("author")),
            "cover_url": d.get("thumbUrl") or d.get("thumbUri"),
            "abstract": dec_text(d.get("abstract")),
            "category": dec_text(category),
            "new_chapter_title": dec_text(d.get("lastChapterTitle")),
            "word_number": d.get("wordNumber") or "",
            "last_chapter_update_time": d.get("lastPublishTime") or "",
            "read_count": d.get("readCount") or "",
            "creation_status": d.get("creationStatus") if d.get("creationStatus") is not None else "",
        },
    }


_DIR_CACHE = {}    # book_id -> (缓存时间, 目录结果)
_DIR_TTL = 900     # 目录缓存有效期（秒）
_DIR_MAX = 128     # 最多缓存多少本书
_DIR_LOCK = threading.Lock()


def _dir_cache_get(book_id):
    with _DIR_LOCK:
        hit = _DIR_CACHE.get(book_id)
        if hit is None:
            return None
        if time.time() - hit[0] > _DIR_TTL:
            _DIR_CACHE.pop(book_id, None)
            return None
        return hit[1]


def _dir_cache_put(book_id, result):
    with _DIR_LOCK:
        if len(_DIR_CACHE) >= _DIR_MAX and book_id not in _DIR_CACHE:
            oldest = min(_DIR_CACHE, key=lambda k: _DIR_CACHE[k][0])
            _DIR_CACHE.pop(oldest, None)
        _DIR_CACHE[book_id] = (time.time(), result)


def _norm_directory(vols):
    """把上游 chapterListWithVolume 归一化为 [{volumeName, volumeId, chapterList}]。

    上游返回的是「卷列表」，每个元素是章节 dict 的数组（list[list[dict]]），
    而非 {volume, chapterList} 结构。
    """
    out = []
    for v in vols:
        if isinstance(v, list):
            out.append({
                "volumeName": v[0].get("volume_name", "") if v else "",
                "volumeId": v[0].get("volumeId", "") if v else "",
                "chapterList": [dict(c) for c in v],
            })
        elif isinstance(v, dict):
            out.append(v)
    for v in out:
        for c in v.get("chapterList", []):
            c["chapter_title"] = dec_text(c.get("chapter_title") or c.get("title"))
    return out


def fetch_directory(book_id, page_count=500):
    """目录：仅官网 Web /api/reader/directory/detail（免签名，一次返回整本）。

    App directory/all_items 在当前出口稳定空 body；App 链遍历（沿
    next_item_id）虽可用但首本约 30 秒，收益低，故不再作为目录来源。
    """
    book_id = str(book_id)
    cached = _dir_cache_get(book_id)
    if cached is not None:
        return cached
    try:
        r = _fetch_directory_web(book_id, page_count)
        _dir_cache_put(book_id, r)
        return r
    except Exception as e:  # noqa
        sys.stderr.write("[fanqie] Web 目录失败: bookId=%s %s\n" % (book_id, e))
        return {"code": -1, "data": {"chapterListWithVolume": []}}


def _fetch_directory_web(book_id, page_count=500):
    """目录（Web 回退）：/api/reader/directory/detail （免签名）。

    实测：上游忽略 page_num，一次就返回整本书全部章节（allItemIds 即总数）。
    因此这里只请求一次；仅当返回数少于 allItemIds 时才继续翻页，并按 itemId
    去重，避免同一页被反复累加（旧实现会翻到安全阀 50 页，导致响应体膨胀
    30 倍以上、耗时数十秒并被客户端读超时）。
    """
    book_id = str(book_id)
    cached = _dir_cache_get(book_id)
    if cached is not None:
        return cached

    seen = set()
    all_vols = []
    all_ids = []
    page = 1
    while True:
        url = ("https://fanqienovel.com/api/reader/directory/detail?bookId=%s"
               "&page_num=%d&page_count=%d" % (book_id, page, page_count))
        j = http_get_json(url, headers={"Referer": REF_BASE + "page/" + str(book_id)})
        data = j.get("data") or {}
        if data.get("allItemIds"):
            all_ids = data["allItemIds"]
        new_in_page = 0
        for v in _norm_directory(data.get("chapterListWithVolume") or []):
            kept = []
            for c in v.get("chapterList", []):
                cid = str(c.get("itemId") or "")
                if cid:
                    if cid in seen:
                        continue
                    seen.add(cid)
                kept.append(c)
            if kept:
                v["chapterList"] = kept
                new_in_page += len(kept)
                all_vols.append(v)
        # 没有新章节（上游忽略了分页参数）或已收齐：结束
        if new_in_page == 0 or new_in_page < page_count:
            break
        if all_ids and len(seen) >= len(all_ids):
            break
        page += 1
        if page > 50:  # 安全阀
            break

    result = {"code": 0, "data": {"chapterListWithVolume": all_vols,
                                  "allItemIds": all_ids}}
    _dir_cache_put(book_id, result)
    return result


def decode_content(html):
    html = dec_text(html)
    html = re.sub(r"(?i)</p>", "\n", html)
    html = re.sub(r"(?i)<br\s*/?>", "\n", html)

    # 图片先占位，避免被下面的通用标签清理删掉
    imgs = []

    def keep_img(match):
        url = image_url_from_tag(match.group(0))
        if not url:
            return ""
        key = "\x00FQIMG%d\x00" % len(imgs)
        imgs.append(url)
        return key

    html = _RE_IMG.sub(keep_img, html)
    html = re.sub(r"<[^>]+>", "", html)  # 去掉其余标签（<style> 等）
    html = _html.unescape(html)
    for i, url in enumerate(imgs):
        html = html.replace("\x00FQIMG%d\x00" % i, IMG_TOKEN % url)
    return html.strip()


def fetch_chapter(item_id):
    """正文：优先 App 渠道（DH 通道，锁章也是全文），失败回退 Web 接口。"""
    if CHANNEL != "web" and appchannel is not None:
        try:
            r = appchannel.fetch_chapter(item_id)
            return {"code": 0,
                    "data": {"content": r["content"],
                             "title": r["title"],
                             "book_id": r.get("book_id") or "",
                             "book_name": r.get("book_name") or "",
                             "word_number": len(r["content"]),
                             "is_locked": False,
                             "preview": False,
                             "source": "app"}}
        except Exception as e:  # noqa
            sys.stderr.write("[fanqie] App 渠道失败，回退 Web: itemId=%s %s\n" % (item_id, e))
    return fetch_chapter_web(item_id)


def fetch_chapter_web(item_id):
    """正文（Web）：/api/reader/full?itemId= （需 a_bogus + 字体解密）。

    锁章（isChapterLock=true）未带 SVIP Cookie 时上游只返回约 200 字试读，
    此时返回 is_locked / preview 标记，便于排查「正文不全」。
    """
    params = {"itemId": str(item_id)}
    params["a_bogus"] = abogus_for(params)
    url = "https://fanqienovel.com/api/reader/full?" + urllib.parse.urlencode(params)
    headers = {"Referer": REF_BASE, "ismobile": "0"}
    j = http_get_json(url, headers=headers)
    if j.get("code") != 0:
        raise RuntimeError("正文接口返回 code=%s：%s" % (j.get("code"), j.get("message", "")))
    cd = (j.get("data") or {}).get("chapterData") or {}
    text = decode_content(cd.get("content") or "")
    try:
        words = int(cd.get("chapterWordNumber") or 0)
    except (TypeError, ValueError):
        words = 0
    preview = bool(cd.get("isChapterLock")) and words > len(text) * 2
    if preview and not COOKIE:
        sys.stderr.write("[fanqie] 锁章试读: itemId=%s 仅返回 %d/%d 字（设置 FQ_COOKIE 为 SVIP 网页 Cookie 可读全文）\n"
                         % (item_id, len(text), words))
    return {"code": 0,
            "data": {"content": text,
                     "book_id": str(cd.get("bookId") or ""),
                     "book_name": cd.get("bookName") or "",
                     "word_number": words,
                     "is_locked": bool(cd.get("isChapterLock")),
                     "preview": preview}}


# --------------------------------------------------------------------------
# 路由分发
# --------------------------------------------------------------------------
def route_search(qs):
    query = qs.get("query", [""])[0]
    offset = qs.get("offset", ["0"])[0]
    count = qs.get("count", ["10"])[0]
    return fetch_search(query, offset, count)


def route_detail(path):
    m = re.match(r"^/api/v1/books/([^/]+)/detail$", path)
    return fetch_detail(m.group(1))


def route_directory(path):
    m = re.match(r"^/api/v1/books/([^/]+)/directory$", path)
    return fetch_directory(m.group(1))


def route_chapter(path):
    m = re.match(r"^/api/v1/chapters/([^/]+)/novel$", path)
    return fetch_chapter(m.group(1))


def dispatch(method, path, qs):
    if method != "GET":
        raise RuntimeError("仅支持 GET")
    if path == "/api/v1/search" or path.startswith("/api/v1/search?"):
        return route_search(qs)
    if re.match(r"^/api/v1/books/[^/]+/detail$", path):
        return route_detail(path)
    if re.match(r"^/api/v1/books/[^/]+/directory$", path):
        return route_directory(path)
    if re.match(r"^/api/v1/chapters/[^/]+/novel$", path):
        return route_chapter(path)
    raise RuntimeError("未匹配的路由: " + path)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, obj, code=200, ctype="application/json; charset=utf-8"):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/favicon.ico",):
            self._send({"code": 404}, 404)
            return
        if parsed.path in ("/api/v1/health", "/health"):
            self._send({"code": 0, "message": "ok"})
            return
        try:
            qs = urllib.parse.parse_qs(parsed.query)
            result = dispatch(self.command, parsed.path, qs)
            self._send(result)
        except Exception as e:  # noqa
            import traceback as _tb
            sys.stderr.write("[fanqie] ERROR " + "".join(_tb.format_exception(type(e), e, e.__traceback__)))
            self._send({"code": 500, "message": str(e)}, 500)

    do_HEAD = do_GET

    def log_message(self, *a):  # 静默默认访问日志
        pass


def make_server(port=18921):
    """创建监听服务器：优先 IPv6 双栈（:: 并关闭 v6only 以同时接受 IPv4），
    若当前环境无 IPv6 栈则回退到 IPv4（0.0.0.0）。"""
    class DualStackServer(ThreadingHTTPServer):
        address_family = socket.AF_INET6

        def server_bind(self):
            # 关闭 v6only 让同一端口同时接受 IPv4（映射为 ::ffff:x.x.x.x）与 IPv6。
            try:
                self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            except (AttributeError, OSError):
                pass
            super().server_bind()

    try:
        return DualStackServer(("::", port), Handler)
    except OSError:
        return ThreadingHTTPServer(("0.0.0.0", port), Handler)


def run_server(port=18921):
    srv = make_server(port)
    sys.stderr.write("番茄小说代理后端已启动: http://127.0.0.1:%d  (IPv4+IPv6 双栈)\n" % port)
    sys.stderr.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


def smoke_test():
    print("== 番茄小说网页版后端冒烟测试 ==")
    # 1) 搜索（带重试，避免偶发网络抖动）
    books = []
    for _ in range(3):
        r = fetch_search("西游记")
        books = [b["book_data"] for b in r["data"]["search_book_data_list"]]
        if books:
            break
        time.sleep(0.5)
    if not books:
        print("[搜索] 失败：接口连续 3 次返回空")
        return
    print("[搜索] 命中 %d 本，首本：%s / %s" % (len(books), books[0]["book_name"], books[0]["author_name"]))
    bid = books[0]["book_id"]
    # 2) 详情
    d = fetch_detail(bid)["data"]
    print("[详情] %s | %s | 分类：%s" % (d["book_name"], d["author_name"], d["category"]))
    # 3) 目录
    di = fetch_directory(bid)["data"]
    vols = di["chapterListWithVolume"]
    n = sum(len(v.get("chapterList", [])) for v in vols)
    print("[目录] 共 %d 卷，%d 章；首章：%s" % (len(vols), n, vols[0]["chapterList"][0]["chapter_title"]))
    iid = vols[0]["chapterList"][0]["itemId"]
    # 4) 正文
    c = fetch_chapter(iid)["data"]["content"]
    print("[正文] 长度 %d，前 80 字：\n%s" % (len(c), c[:80].replace("\n", " ")))
    print("== 测试通过 ==")


if __name__ == "__main__":
    args = sys.argv[1:]
    port = 18921
    for a in args:
        if a.startswith("--port="):
            port = int(a.split("=")[1])
        elif a.startswith("--cookie="):
            COOKIE = a.split("=", 1)[1].strip()
        elif a.startswith("--channel="):
            CHANNEL = a.split("=", 1)[1].strip().lower() or "app"
        elif a.startswith("--meta-channel="):
            META_CHANNEL = a.split("=", 1)[1].strip().lower() or "app"
        elif a.startswith("--dir-source="):
            DIR_SOURCE = a.split("=", 1)[1].strip().lower() or "auto"
    if "--test" in args:
        smoke_test()
    else:
        if COOKIE:
            sys.stderr.write("已启用 Web Cookie（锁章可读全文）\n")
        sys.stderr.write("正文渠道: %s；详情/目录: 仅官网 Web；搜索: APP+头条+Web 三路聚合去重\n"
                         % ("app（DH 通道，锁章全文）" if CHANNEL != "web" and appchannel is not None
                            else "web（锁章仅试读）"))
        run_server(port)
