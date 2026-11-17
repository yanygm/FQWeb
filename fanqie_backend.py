#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
番茄小说 代理后端（纯 Python）。

目录/搜索/详情优先 App 渠道（参考 shareBookSource.json）：
  - 搜索  novel.snssdk.com/api/novel/channel/homepage/search/search/v1（免签名）
  - 详情  reading.snssdk.com/reading/bookapi/detail/v          （X-Gorgon + 设备注册）
  - 目录  reading.snssdk.com/reading/bookapi/directory/all_items/v（X-Gorgon + 设备注册）
App 详情/目录若因签名、设备或环境返回空响应，则自动回退原 Web 接口：
  - 搜索  /api/author/search/search_book/v1 （需要 a_bogus 网页签名，本地生成）
  - 详情  /api/book/info                       （免签名）
  - 目录  /api/reader/directory/detail         （免签名）

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

# 元数据渠道（搜索/详情/目录）：app 优先，失败自动回退 web。
# 用 FQ_META_CHANNEL=web 或 --meta-channel=web 可强制走旧网页接口。
META_CHANNEL = os.environ.get("FQ_META_CHANNEL", "app").strip().lower() or "app"

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


def app_fetch_search(query, offset=0, count=10):
    """App 搜索：novel.snssdk.com 公共搜索接口（实测免签名、无 PUA）。"""
    params = {
        "aid": "13",
        "q": query,
        "offset": str(int(offset)),
    }
    url = ("https://novel.snssdk.com/api/novel/channel/homepage/search/search/v1?"
           + urllib.parse.urlencode(params))
    j = json.loads(_app_http_get(url, timeout=12))
    if str(j.get("code")) != "0":
        raise RuntimeError("App 搜索返回 code=%s：%s"
                           % (j.get("code"), j.get("message", "")))
    rows = ((j.get("data") or {}).get("ret_data") or [])
    out = []
    for b in rows:
        name = re.sub(r"</?em>", "", str(b.get("title") or b.get("book_name") or ""))
        bd = {
            "book_id": str(b.get("book_id") or ""),
            "book_name": name,
            "author_name": str(b.get("author") or b.get("author_name") or ""),
            "cover_url": b.get("thumb_url") or b.get("cover_url") or "",
            "abstract": str(b.get("abstract") or ""),
            "category": str(b.get("category") or ""),
            "new_chapter_title": str(b.get("last_chapter_title") or ""),
            "word_number": b.get("word_number") or "",
            "score": b.get("score") or "",
        }
        out.append({"book_data": bd})
    return {"code": 0,
            "search_tabs": [{"data": out}],
            "data": {"search_book_data_list": out}}


def app_fetch_detail(book_id):
    """App 详情：reading.bookapi/detail（X-Gorgon + 设备注册）。"""
    j = _app_api_json("detail", "book_id=" + urllib.parse.quote(str(book_id), safe=""))
    d = j.get("page") or j.get("data") or {}
    if isinstance(d, list):
        d = d[0] if d else {}
    if not isinstance(d, dict):
        d = {}
    info = d.get("book_info") or d.get("bookInfo") or d
    name = (info.get("book_name") or info.get("bookName")
            or info.get("title") or "")
    if not name:
        raise RuntimeError("App 详情返回空数据")
    return {"code": 0, "data": {
        "book_id": str(info.get("book_id") or info.get("bookId") or book_id),
        "book_name": dec_text(str(name)),
        "author_name": dec_text(str(info.get("author") or info.get("author_name") or "")),
        "cover_url": info.get("thumb_url") or info.get("cover_url") or "",
        "abstract": dec_text(str(info.get("abstract") or "")),
        "category": dec_text(str(info.get("category") or "")),
        "new_chapter_title": dec_text(str(info.get("last_chapter_title") or "")),
    }}


def app_fetch_directory(book_id):
    """App 目录：reading.bookapi/directory/all_items。"""
    j = _app_api_json("directory/all_items",
                      "book_id=" + urllib.parse.quote(str(book_id), safe=""))
    d = j.get("data") or j.get("page") or {}
    if isinstance(d, list):
        d = d[0] if d else {}
    if not isinstance(d, dict):
        d = {}
    items = (d.get("item_data_list") or d.get("itemDataList")
             or d.get("chapterList") or [])
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
            vols.append({
                "volumeName": vname,
                "volumeId": str(c.get("volume_id") or c.get("volumeId") or ""),
                "chapterList": [],
            })
        vols[-1]["chapterList"].append({
            "itemId": iid,
            "chapter_title": dec_text(str(c.get("title")
                                          or c.get("chapter_title") or "")),
            "firstPassTime": c.get("first_pass_time") or c.get("firstPassTime") or "",
            "chapterWordNumber": (c.get("chapter_word_number")
                                  or c.get("chapterWordNumber") or ""),
        })
        all_ids.append(iid)
    if not vols:
        raise RuntimeError("App 目录返回空章节列表")
    return {"code": 0, "data": {"chapterListWithVolume": vols,
                                  "allItemIds": all_ids}}


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
def fetch_search(query, offset=0, count=10):
    """搜索：优先 App 公共搜索接口，失败回退 Web（需 a_bogus）。"""
    if META_CHANNEL != "web":
        try:
            return app_fetch_search(query, offset, count)
        except Exception as e:  # noqa
            sys.stderr.write("[fanqie] App 搜索失败，回退 Web: %s\n" % e)
    return _fetch_search_web(query, offset, count)


def _fetch_search_web(query, offset=0, count=10):
    """搜索（Web 回退）：/api/author/search/search_book/v1 （需 a_bogus）。"""
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
    out = []
    for b in books:
        bd = {
            "book_id": b.get("book_id"),
            "book_name": dec_search(b.get("book_name")),
            "author_name": dec_search(b.get("author")),
            "cover_url": b.get("thumb_url") or b.get("thumb_uri"),
            "abstract": dec_search(b.get("book_abstract")),
            "category": dec_search(b.get("category")),
            "new_chapter_title": dec_search(b.get("last_chapter_title")),
        }
        # 套一层 book_data 以匹配 番茄小说书源.json 的 ruleSearch 子规则
        out.append({"book_data": bd})
    return {"code": 0, "search_tabs": [{"data": out}],
            "data": {"search_book_data_list": out}}


def fetch_detail(book_id):
    """详情：优先 App reading.bookapi/detail，失败回退 /api/book/info。"""
    if META_CHANNEL != "web":
        try:
            return app_fetch_detail(book_id)
        except Exception as e:  # noqa
            sys.stderr.write("[fanqie] App 详情失败，回退 Web: bookId=%s %s\n" % (book_id, e))
    return _fetch_detail_web(book_id)


def _fetch_detail_web(book_id):
    """详情（Web 回退）：/api/book/info （免签名）。"""
    url = "https://fanqienovel.com/api/book/info?bookId=" + str(book_id)
    j = http_get_json(url, headers={"Referer": REF_BASE + "page/" + str(book_id)})
    d = j.get("data") or {}
    return {
        "code": 0,
        "data": {
            "book_id": d.get("bookId"),
            "book_name": dec_text(d.get("bookName")),
            "author_name": dec_text(d.get("author")),
            "cover_url": d.get("thumbUrl") or d.get("thumbUri"),
            "abstract": dec_text(d.get("abstract")),
            "category": dec_text(d.get("category") or d.get("completeCategory")),
            "new_chapter_title": dec_text(d.get("lastChapterTitle")),
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
    """目录：优先 App reading.bookapi/directory/all_items，失败回退 Web。"""
    book_id = str(book_id)
    cached = _dir_cache_get(book_id)
    if cached is not None:
        return cached
    if META_CHANNEL != "web":
        try:
            result = app_fetch_directory(book_id)
            _dir_cache_put(book_id, result)
            return result
        except Exception as e:  # noqa
            sys.stderr.write("[fanqie] App 目录失败，回退 Web: bookId=%s %s\n" % (book_id, e))
    return _fetch_directory_web(book_id, page_count)


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
    # 1) 搜索
    r = fetch_search("我的")
    books = r["data"]["search_book_data_list"]
    books = [b["book_data"] for b in books]
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
    if "--test" in args:
        smoke_test()
    else:
        if COOKIE:
            sys.stderr.write("已启用 Web Cookie（锁章可读全文）\n")
        sys.stderr.write("正文渠道: %s；元数据渠道: %s（失败自动回退 Web）\n"
                         % ("app（DH 通道，锁章全文）" if CHANNEL != "web" and appchannel is not None
                            else "web（锁章仅试读）", META_CHANNEL))
        run_server(port)
