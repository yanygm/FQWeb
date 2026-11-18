#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
番茄小说 代理后端（纯 Python）。

元数据策略（2026-11-18 APK 反编译 + 实测更新：APP 接口可用，Web 作兜底）：
  - 详情  APP api.fanqiesdk.com/api/novel/book/directory/list/v1（xGorgon 签名）
          失败回退官网 Web /api/book/info（免签名，字段完整）
  - 目录  APP directory/list 的 item_list + directory/detail（免签批量补章节标题）
          失败回退官网 Web /api/reader/directory/detail（一次返回整本）
  - 章节详情 APP /api/novel/book/directory/detail/v1（免签，item_ids 逗号分隔，实测 12 章/次）
  - 搜索  两路聚合：APP + Web，按 book_id + book_name/别名去重合并
      - APP    reading.snssdk.com/reading/bookapi/search/search/v1（xGorgon，索引与 APP 详情一致，
               自带改名映射 book_short_name/original_book_name）+ novel.snssdk 频道搜索 x-ladon/x-argus（aid=13）
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
from concurrent.futures import ThreadPoolExecutor, as_completed
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

# 说明：详情/目录默认走 APP 接口（反编译还原 + 实测可用），失败回退官网 Web。
#       META_CHANNEL=web / DIR_SOURCE=web 可强制只走 Web。
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


# --------------------------------------------------------------------------
# 封面 URL 规范化
# 背景（2026-11）：番茄 CDN 的 p*-tt.bytecdn.cn 裸域名已返回 403
# {"code":1004,"error":"domain forbidden"}，带签名的 *-sign.*.com 可用但会过期。
# 稳定的免签方案：p6-novel.byteimg.com/img/<novel-pic|novel-static>/<hash>~tplv-resize:225:0.image
# 实测该 host 200，可从上游裸 thumb_uri 直接构造，不依赖签名/时效。
# --------------------------------------------------------------------------
_COVER_IMG_HOST = "https://p6-novel.byteimg.com/img/"
# 这些 host 是带签名的、当前可用的，原样保留即可
_COVER_OK_HOST_RE = re.compile(
    r"(?:fqnovelpic|fanqiesdkpic|fqnovelpic|byteimg|novel.byteimg)\.com$", re.I)


def normalize_cover(url):
    """把任意上游封面 URL 统一为可访问的免签 URL（或原样保留可用 URL）。"""
    if not url:
        return ""
    u = str(url).strip()
    if not u:
        return ""
    # 已经是完整 URL
    if u.startswith("http://") or u.startswith("https://"):
        host = urllib.parse.urlparse(u).netloc.lower()
        # 可用 host（带签名或 byteimg）原样保留
        if _COVER_OK_HOST_RE.search(host):
            return u
        # bytecdn.cn 等被封禁 host：提取路径里的 novel-pic/novel-static 资源
        m = re.search(r"(novel-(?:pic|static)/[^?~]+)", u)
        if m:
            return _COVER_IMG_HOST + m.group(1) + "~tplv-resize:225:0.image"
        return u
    # 裸路径：novel-pic/xxx / novel-static/xxx 或带前导斜杠
    u = u.lstrip("/")
    if u.startswith("novel-pic/") or u.startswith("novel-static/"):
        return _COVER_IMG_HOST + u.split("?", 1)[0] + "~tplv-resize:225:0.image"
    return u


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
# 反编译确认的真实元数据 host（Retrofit baseUrl，可被服务端配置覆盖）
APP_NOVEL_HOST = os.environ.get("FQ_APP_NOVEL_HOST", "https://api.fanqiesdk.com").strip().rstrip("/")
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
    # 关键：参考实现是 split("&").sort().join("&")，即把每个 key=value 拆开
    # 逐段排序；旧实现把 params/device 整串当作单个元素排序，导致 X-Gorgon
    # 与实际 URL 参数顺序都不匹配，服务端静默返回空 body。
    flat = []
    for part in parts:
        if not part:
            continue
        for seg in part.split("&"):
            if seg:
                flat.append(seg)
    query = "&".join(sorted(flat))
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


def _discovery_book(b):
    """把 APP 首页流里的 ApiBookInfo 归一化成书卡（明文字段，无需字体解码）。"""
    if not isinstance(b, dict):
        return None
    bid = str(b.get("book_id") or b.get("bookId") or "")
    name = re.sub(r"</?em>", "", str(b.get("book_name") or b.get("title") or ""))
    if not bid or not name:
        return None
    cover = (b.get("thumb_url") or b.get("cover_url") or b.get("thumb_uri")
             or b.get("cover_uri") or b.get("expand_thumb_url") or b.get("horiz_thumb_url") or "")
    return {
        "book_id": bid,
        "book_name": dec_search(name),
        "author_name": dec_search(str(b.get("author") or b.get("author_name") or "")),
        "cover_url": normalize_cover(cover),
        "abstract": dec_search(str(b.get("abstract") or b.get("book_abstract_v2")
                                   or b.get("sub_abstract") or "")),
        "category": dec_search(str(b.get("category") or b.get("complete_category") or "")),
        "new_chapter_title": dec_search(str(b.get("last_chapter_title") or b.get("new_chapter_title") or "")),
        "word_number": b.get("word_number") or "",
        "score": b.get("score") or "",
    }


# 首页流缓存：cell 列表变化的频度低，缓存 10 分钟避免每次都拉 500KB
_DISCOVERY_CACHE = {}   # channel -> {groups, ts}


def _fetch_homepage_cells(channel, timeout=20):
    """拉 APP 首页信息流，返回 [{name, books:[书卡]}, ...]。

    channel: male -> bookstore/homepage（男频），female -> bookmall/homepage（女频）。
    每个 cell 自带 book_data（书卡），cell_name 即推荐/榜单名称。
    """
    path = "bookmall/homepage" if str(channel).lower() in ("female", "girl", "女频", "女") \
        else "bookstore/homepage"
    cached = _DISCOVERY_CACHE.get(path)
    if cached and time.time() - cached["ts"] < 600 and cached.get("groups"):
        return cached["groups"]
    url, headers = _app_xgorgon(path, "")
    raw = _app_http_get(url, headers=headers, timeout=timeout)
    if not raw or not raw.strip():
        raise RuntimeError("首页流返回空响应: %s" % path)
    j = json.loads(raw)
    if str(j.get("code")) != "0":
        raise RuntimeError("首页流 code=%s" % j.get("code"))
    groups = []
    seen_cell = set()
    for c in (j.get("data") or []):
        if not isinstance(c, dict):
            continue
        name = dec_search(str(c.get("cell_name") or c.get("cell_title") or c.get("title") or "")).strip()
        bd = c.get("book_data") or c.get("data") or []
        if isinstance(bd, dict):
            bd = bd.get("data") or bd.get("book_list") or []
        books = []
        for x in (bd if isinstance(bd, list) else []):
            b = x.get("book_info") if isinstance(x, dict) else None
            card = _discovery_book(b if isinstance(b, dict) else x)
            if card:
                books.append(card)
        if not books:
            continue
        key = name or ("cell_%d" % len(groups))
        if key in seen_cell:
            continue
        seen_cell.add(key)
        groups.append({"name": name or ("榜单%d" % (len(groups) + 1)), "books": books})
    if not groups:
        raise RuntimeError("首页流未解析到书单: %s" % path)
    _DISCOVERY_CACHE[path] = {"groups": groups, "ts": time.time()}
    return groups


def fetch_discovery(channel="male", cell=None, listing=False):
    """发现页推荐/榜单。

    listing=True  -> 返回分组元信息（名称 + 数量 + 索引），不返回书卡。
    cell 为索引数字或分组名 -> 只返回该组书卡（search 风格 {search_tabs:[...]}）。
    cell 为 None   -> 返回全部分组书卡。
    """
    groups = _fetch_homepage_cells(channel)
    if listing:
        return {"code": 0, "data": {"groups": [
            {"index": i, "name": g["name"], "count": len(g["books"])}
            for i, g in enumerate(groups)
        ]}}
    picked = []
    if cell is None or str(cell) == "":
        picked = groups
    else:
        cs = str(cell)
        if cs.isdigit():
            idx = int(cs)
            if 0 <= idx < len(groups):
                picked = [groups[idx]]
        else:
            for g in groups:
                if g["name"] == cs:
                    picked = [g]
                    break
    tabs = [{"title": g["name"], "data": [{"book_data": b} for b in g["books"]]}
            for g in picked]
    return {"code": 0, "data": {"search_tabs": tabs}}


def _search_rows_to_items(rows):
    """把各搜索源的书籍行统一成书源期望的 {book_data:{...}} 结构。

    搜索/列表类接口的字体混淆用 SEARCH_MAP（dec_search），与正文的
    FONT_MAP（dec_text）是两套不同映射，混用会把书名解成乱码（例如
    Web 搜索的 PUA 书名只能用 SEARCH_MAP 还原）。各源进入本函数时若已
    是明文则 dec_search 不会再改动，故统一用 dec_search 是安全的。
    """
    out = []
    for b in rows:
        name = re.sub(r"</?em>", "", str(b.get("book_name") or b.get("title") or ""))
        bid = str(b.get("book_id") or b.get("bookId") or "")
        if not bid or not name:
            continue
        item = {"book_data": {
            "book_id": bid,
            "book_name": dec_search(name),
            "author_name": dec_search(str(b.get("author_name") or b.get("author") or "")),
            "cover_url": normalize_cover(b.get("cover_url") or b.get("thumb_url") or b.get("thumbUri") or b.get("thumb_uri") or ""),
            "abstract": dec_search(str(b.get("abstract") or b.get("book_abstract") or "")),
            "category": dec_search(str(b.get("category") or "")),
            "new_chapter_title": dec_search(str(b.get("new_chapter_title") or b.get("last_chapter_title") or "")),
            "word_number": b.get("word_number") or "",
            "score": b.get("score") or "",
        }}
        aliases = [dec_search(str(a)) for a in (b.get("alias_names") or []) if a]
        if aliases:
            item["book_data"]["alias_names"] = aliases
        out.append(item)
    return out


def _app_search_signed(query, offset=0, count=10):
    """APP 搜索（x-ladon/x-argus 签名，novel.snssdk.com，aid=13 番茄 APP 本体）。

    reading.snssdk.com 的 xGorgon search/tab 在部分出口稳定空 body（实测，签名
    已与参考实现逐字节一致仍空），属服务端风控。本接口与正文同款 x-ladon/x-argus
    签名，实测稳定可用。关键修复：旧实现只从 offset+count（第 11 条）取，
    跳过了首屏——确切书名几乎都排在首屏，导致「知道书名却搜不到」。现在
    首屏(offset)必取，仍附带下一页(offset+count)以贡献差异化结果。
    """
    if appchannel is None:
        raise RuntimeError("appchannel 不可用，无法签名 APP 搜索")
    offsets = [int(offset)]
    second = int(offset) + int(count)
    if second != int(offset):
        offsets.append(second)
    rows = []
    seen_id = set()
    for start in offsets:
        qs = ("aid=13&q=%s&offset=%d"
              % (urllib.parse.quote(str(query)), start))
        url = "https://novel.snssdk.com/api/novel/channel/homepage/search/search/v1?" + qs
        ts = int(time.time())
        dev = "7202757412345678901"
        headers = {
            "User-Agent": appchannel.UA_NOVEL,
            "Accept-Encoding": "gzip, deflate",
            "y": appchannel.generate_y()[0],
            "x-ss-req-ticket": str(ts * 1000),
            "x-khronos": str(ts),
            "x-ladon": appchannel.ladon_encrypt(ts, appchannel._LC_ID, 13),
            "x-argus": appchannel.argus_sign(qs, ts, 13, appchannel._LC_ID, dev),
        }
        raw = _app_http_get(url, headers=headers, timeout=12)
        if not raw.strip():
            raise RuntimeError("APP 搜索(签名)返回空响应")
        j = json.loads(raw)
        if str(j.get("code")) != "0":
            raise RuntimeError("APP 搜索(签名) code=%s" % j.get("code"))
        for b in ((j.get("data") or {}).get("ret_data") or []):
            bid = str(b.get("book_id") or "")
            if bid and bid in seen_id:
                continue
            if bid:
                seen_id.add(bid)
            rows.append(b)
    items = []
    for b in rows:
        title = re.sub(r"</?em>", "", str(b.get("title") or b.get("book_name") or ""))
        items.append({
            "book_id": str(b.get("book_id") or ""),
            "book_name": title,
            "author_name": str(b.get("author") or b.get("author_name") or ""),
            "cover_url": normalize_cover(b.get("thumb_url") or b.get("cover_url") or b.get("thumb_uri") or ""),
            "abstract": str(b.get("abstract") or ""),
            "category": str(b.get("category") or ""),
            "new_chapter_title": str(b.get("last_chapter_title") or ""),
            "word_number": b.get("word_number") or "",
            "score": b.get("score") or "",
            "source": "app",
        })
    return items


def app_fetch_search(query, offset=0, count=10):
    """APP 搜索：优先 x-ladon/x-argus 签名链路（实测可用），失败回退 xGorgon。

    签名链路失败会先尝试旧 reading.snssdk search/tab；两者都失败才抛异常，
    由 fetch_search 捕获并跳过该路，不影响其余搜索源。
    """
    try:
        return _app_search_signed(query, offset, count)
    except Exception as e:  # noqa
        sys.stderr.write("[fanqie] APP 搜索(签名链路)失败: %s，回退 xGorgon\n" % e)

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
            "cover_url": normalize_cover(b.get("thumb_url") or b.get("cover_url") or b.get("thumb_uri") or ""),
            "abstract": str(b.get("abstract") or ""),
            "category": str(b.get("category") or ""),
            "new_chapter_title": str(b.get("last_chapter_title") or ""),
            "word_number": b.get("word_number") or "",
            "score": b.get("score") or "",
            "source": "app",
        })
    return items


def reading_bookapi_search(query, offset=0, count=10, timeout=15):
    """APP 真实搜索：reading.snssdk.com/reading/bookapi/search/search/v1（xGorgon）。

    这是番茄 App 搜索框实际用的接口，索引与 App 详情一致（用「新名」）。
    实测同一 id 用新名/旧名都能命中；返回的条目同时带：
      - book_name         展示名（改名后的新名，如「修仙界第一混乱」）
      - book_short_name / original_book_name  原始名（如「我的法宝都是规则系」）
    上游已自带改名映射，故无需本地维护别名表即可「知道任一书名都搜到」。
    """
    params = "q=%s&offset=%d&search_id=" % (
        urllib.parse.quote(str(query)), max(int(offset), 0))
    url, headers = _app_xgorgon("search/search", params)
    raw = _app_http_get(url, headers=headers, timeout=timeout)
    if not raw.strip():
        raise RuntimeError("reading.bookapi 搜索返回空响应")
    j = json.loads(raw)
    if str(j.get("code")) != "0":
        raise RuntimeError("reading.bookapi 搜索 code=%s" % j.get("code"))
    rows = ((j.get("data") or {}).get("search_result")
            or (j.get("data") or {}).get("result") or [])
    items = []
    for b in rows:
        if not isinstance(b, dict):
            continue
        bid = str(b.get("book_id") or b.get("bookId") or "")
        name = str(b.get("book_name") or b.get("title") or "")
        # 上游改名字段：主名用展示名，原始名作为别名
        primary = name or str(b.get("book_short_name") or "")
        alt = str(b.get("book_short_name") or b.get("original_book_name") or "")
        alias_names = []
        for nm in (alt, str(b.get("original_book_name") or ""),
                   str(b.get("book_flight_alias_name") or "")):
            if nm and nm != primary and nm not in alias_names:
                alias_names.append(nm)
        if not bid or not primary:
            continue
        # 优先带签名的 thumb_url，其次裸 thumb_uri；统一走 normalize_cover 规避被封禁的 bytecdn host
        cover = b.get("thumb_url") or b.get("thumb_uri") or b.get("cover_uri") or ""
        items.append({
            "book_id": bid,
            "book_name": primary,
            "alias_names": alias_names,
            "author_name": str(b.get("author") or b.get("author_name") or ""),
            "cover_url": normalize_cover(cover),
            "abstract": str(b.get("book_abstract_v2") or b.get("abstract") or b.get("book_abstract") or ""),
            "category": str(b.get("category") or b.get("complete_category") or ""),
            "new_chapter_title": str(b.get("last_chapter_title") or b.get("new_chapter_title") or ""),
            "word_number": b.get("word_number") or "",
            "score": b.get("score") or "",
            "source": "reading",
        })
    return items


# --------------------------------------------------------------------------
# APP 元数据接口（2026-11-18 反编译还原 + 实测可用）
# 实测结论：
#   GET /api/novel/book/directory/list/v1  + xGorgon  → code=0，book_info + item_list
#   GET /api/novel/book/directory/detail/v1  免签      → code=0，支持 item_ids 批量
#   注意 _app_api_json 拼的是 reading.snssdk.com/reading/bookapi/...，那是老路径，
#   必须换成下面的 api.fanqiesdk.com/api/novel/... 才有效。
# --------------------------------------------------------------------------
def _app_novel_api(api_path, biz_params, sign_path="directory/list", timeout=12):
    """用 xGorgon 签名请求 api.fanqiesdk.com/api/novel/...，返回 data 节点。"""
    # _app_xgorgon 会按公共参数排序生成 query 与 X-Gorgon 头；它自带的 URL 前缀
    # 是 reading.bookapi，这里只取 query，拼到反编译确认的真实 host/path 上。
    fake_url, headers = _app_xgorgon(sign_path, biz_params)
    query = fake_url.split("?", 1)[1]
    url = APP_NOVEL_HOST + "/api/novel/" + api_path + "?" + query
    raw = _app_http_get(url, headers=headers, timeout=timeout)
    if not raw.strip():
        raise RuntimeError("APP 接口返回空响应: %s" % api_path)
    j = json.loads(raw)
    code = j.get("code")
    if str(code) not in ("0", 0):
        raise RuntimeError("APP 接口 %s code=%s: %s"
                           % (api_path, code, j.get("message", "")))
    return j.get("data") or {}


def app_fetch_chapter_details(item_ids, batch=100, timeout=12, workers=8):
    """章节详情（免签）：item_ids 逗号分隔批量查，返回 {item_id: 原始章节 dict}。

    大书目录（数千章）若串行分批需十几秒，会超过阅读器超时导致「目录加载失败」；
    改为 batch=100 + 并发拉取，实测 2712 章从 ~17s 降到 ~3s。
    注意：上游单批 200 会静默返回空，故 batch 上限设为 100。
    """
    ids = [str(x).strip() for x in (item_ids or []) if str(x).strip()]
    if not ids:
        return {}
    batch = max(1, min(int(batch or 100), 100))
    workers = max(1, min(int(workers or 8), 16))
    chunks = [ids[i:i + batch] for i in range(0, len(ids), batch)]

    def _fetch_chunk(chunk):
        params = {
            "aid": "13", "device_platform": "android", "version_code": "74532",
            "item_ids": ",".join(chunk), "epub_parser_level": "0",
        }
        url = APP_NOVEL_HOST + "/api/novel/book/directory/detail/v1?" + urllib.parse.urlencode(params)
        last = None
        for _ in range(2):  # 单批失败重试 1 次，避免偶发抖动拖垮整本
            try:
                raw = _app_http_get(url, timeout=timeout)
                if not raw.strip():
                    raise RuntimeError("章节详情接口返回空响应")
                j = json.loads(raw)
                if str(j.get("code")) not in ("0", 0):
                    raise RuntimeError("章节详情接口 code=%s" % j.get("code"))
                return j.get("data") or []
            except Exception as e:  # noqa
                last = e
        raise last

    out = {}
    if len(chunks) == 1:
        batches = [_fetch_chunk(chunks[0])]
    else:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            fut = {ex.submit(_fetch_chunk, c): i for i, c in enumerate(chunks)}
            ordered = [None] * len(chunks)
            for f in as_completed(fut):
                ordered[fut[f]] = f.result()  # 有失败则抛出，交给上层回退
        batches = ordered
    for data in batches:
        for c in (data or []):
            iid = str(c.get("item_id") or "")
            if iid:
                out[iid] = c
    return out


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
    """APP 详情：directory/list（xGorgon）拿 book_info → 后端统一详情结构。"""
    data = _app_novel_api(
        "book/directory/list/v1",
        "book_id=%s&parent_enterfrom=&novel_sdk_ver=&epub_parser_level=0"
        % urllib.parse.quote(str(book_id), safe=""))
    bi = data.get("book_info") or {}
    name = bi.get("book_name") or bi.get("bookName") or bi.get("title") or ""
    if not name:
        raise RuntimeError("APP 详情缺少 book_name")
    author = bi.get("author") or bi.get("author_name") or ""
    authors = bi.get("original_authors") or []
    if not author and authors and isinstance(authors[0], dict):
        author = authors[0].get("AuthorName") or ""
    category = (bi.get("category") or bi.get("completeCategory")
                or _category_from_v2(bi.get("categoryV2")) or bi.get("source") or "")
    return {"code": 0, "data": {
        "book_id": str(bi.get("book_id") or bi.get("bookId") or book_id),
        "book_name": dec_text(str(name)),
        "author_name": dec_text(str(author)),
        "cover_url": normalize_cover(bi.get("thumb_uri") or bi.get("thumb_url") or ""),
        "abstract": dec_text(str(bi.get("abstract") or bi.get("sub_abstract") or "")),
        "category": dec_text(str(category)),
        "new_chapter_title": dec_text(str(bi.get("last_chapter_title") or "")),
        "word_number": bi.get("word_number") or "",
        "score": bi.get("score") or "",
        "source": "app",
    }}


def app_fetch_directory(book_id, max_chapters=5000, timeout=12):
    """APP 目录：directory/list（xGorgon）拿 item_list，directory/detail（免签）批量补标题。"""
    data = _app_novel_api(
        "book/directory/list/v1",
        "book_id=%s&parent_enterfrom=&novel_sdk_ver=&epub_parser_level=0"
        % urllib.parse.quote(str(book_id), safe=""), timeout=timeout)
    ids = [str(x).strip() for x in (data.get("item_list") or []) if str(x).strip()][:max_chapters]
    if not ids:
        raise RuntimeError("APP 目录 item_list 为空")
    details = app_fetch_chapter_details(ids, timeout=timeout)
    chapters = []
    for iid in ids:
        c = details.get(iid) or {}
        chapters.append({
            "itemId": iid,
            "chapter_title": dec_text(str(c.get("title") or c.get("chapter_title") or "")),
            "firstPassTime": c.get("first_pass_time") or "",
            "chapterWordNumber": c.get("word_number") or "",
        })
    return {"code": 0, "data": {
        "chapterListWithVolume": [{
            "volumeName": "正文卷", "volumeId": "", "chapterList": chapters,
        }],
        "allItemIds": ids,
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
# 搜索聚合时每路最多取多少条（避免某路刷屏，APP/Web 各 10 条典型）
_SEARCH_PER_SOURCE = int(os.environ.get("FQ_SEARCH_PER_SOURCE", "10") or 10)
# 聚合结果总上限
_SEARCH_TOTAL = int(os.environ.get("FQ_SEARCH_TOTAL", "30") or 30)


# 搜索去重用的书名归一化：去掉搜索结果常见的 <em> 高亮标签与首尾空白，
# 只有归一化后完全一致才视为同一本书（避免同 id 不同名被错误合并）。
def _dedup_book_name(name):
    return re.sub(r"</?em>", "", str(name or "")).strip()


def fetch_search(query, offset=0, count=10):
    """搜索聚合：APP（reading.bookapi xGorgon + x-ladon/x-argus）+ Web（a_bogus）两路合一。

    各路独立容错，任一成功即可返回；按 book_id + book_name/别名去重：仅当
    book_id 相同且书名（去 <em>、去空白后）或别名一致时才合并为同一本，先成功
    的源优先，后续源只补空缺字段（如某路无字数/评分）。返回结构保持与单路一致，
    兼容 番茄小说书源.json 的 ruleSearch。
    """
    per = max(int(count), _SEARCH_PER_SOURCE)
    collected = []       # item 列表（带 source）

    def absorb(items, name):
        for it in (items or []):
            bid = str(it.get("book_id") or "")
            if not bid:
                continue
            nm = _dedup_book_name(it.get("book_name"))
            in_names = set(nm.split()) if nm else set()
            for alt in it.get("alias_names") or []:
                a = _dedup_book_name(alt)
                if a:
                    in_names.add(a)
            matched = None
            for prev in collected:
                if str(prev.get("book_id")) != bid:
                    continue
                # 先判完全同名（保持原有行为）
                if _dedup_book_name(prev.get("book_name")) == nm:
                    matched = prev
                    break
                # 改名书：同 id 且新条目的名字出现在既有条目的名字/别名里（或反之），
                # 视为同一本，避免同一本改名书占两条。
                prev_names = set()
                for v in [prev.get("book_name")] + list(prev.get("alias_names") or []):
                    d = _dedup_book_name(v)
                    if d:
                        prev_names.add(d)
                if in_names & prev_names:
                    matched = prev
                    break
            if matched is not None:
                # 同 id 同名/别名：补齐空缺字段 + 合并别名（不覆盖先到源的值）
                for k, v in it.items():
                    if k == "source":
                        continue
                    if k == "alias_names":
                        cur = list(matched.get("alias_names") or [])
                        base = matched.get("book_name")
                        for a in v:
                            if a and a != base and a not in cur:
                                cur.append(a)
                        matched["alias_names"] = cur
                        continue
                    if not matched.get(k) and v:
                        matched[k] = v
                continue
            # 全新 id：作为独立结果保留
            collected.append(dict(it))

    # 1) APP 真实搜索（reading.bookapi，索引与 App 详情一致，自带改名映射）
    try:
        reading_items = reading_bookapi_search(query, offset, per)
        absorb(reading_items, "reading")
        sys.stderr.write("[fanqie] reading.bookapi 搜索命中 %d 本\n" % len(reading_items))
    except Exception as e:  # noqa
        sys.stderr.write("[fanqie] reading.bookapi 搜索失败: %s\n" % e)

    # 2) APP（x-ladon/x-argus 签名，取下一页贡献差异化书籍）
    try:
        app_items = app_fetch_search(query, offset, per)
        absorb(app_items, "app")
        sys.stderr.write("[fanqie] APP 搜索命中 %d 本\n" % len(app_items))
    except Exception as e:  # noqa
        sys.stderr.write("[fanqie] APP 搜索失败: %s\n" % e)

    # 3) Web（需 a_bogus，字段较全）
    try:
        absorb(_fetch_search_web(query, offset, per), "web")
    except Exception as e:  # noqa
        sys.stderr.write("[fanqie] Web 搜索失败: %s\n" % e)

    # 书名匹配度排序：用户「知道书名」时，精确同名 / 以查询词开头的书必须排最前，
    # 否则会被 _SEARCH_TOTAL 上限截断而表现为「搜不到」。稳定排序，同分组保持
    # 来源优先级（reading > APP > Web）。改名书的别名也参与匹配。
    q_norm = _dedup_book_name(query).lower()

    def _match_rank(it):
        # 主名或任一别名与查询词匹配，都算精确命中
        names = [_dedup_book_name(it.get("book_name"))]
        names += [_dedup_book_name(a) for a in (it.get("alias_names") or [])]
        names = [n.lower() for n in names if n]
        if not q_norm:
            return 2
        if q_norm in names:
            return 0          # 书名/别名精确等于查询词
        if any(n.startswith(q_norm) or (q_norm.startswith(n) and len(n) >= 2) for n in names):
            return 1          # 前缀 / 被包含且足够长
        return 2

    collected.sort(key=_match_rank)
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
            "cover_url": normalize_cover(b.get("thumb_url") or b.get("thumb_uri") or ""),
            "abstract": dec_search(b.get("book_abstract")),
            "category": dec_search(b.get("category")),
            "new_chapter_title": dec_search(b.get("last_chapter_title")),
            "word_number": b.get("word_number") or "",
            "score": "",
            "source": "web",
        })
    return items


def fetch_detail(book_id):
    """详情：APP directory/list（xGorgon）优先，失败回退官网 Web /api/book/info。

    改名书的书名映射由上游搜索字段（book_short_name/original_book_name）在搜索侧
    处理，详情侧直接返回来源书名，不依赖本地别名表。
    """
    if META_CHANNEL != "web":
        try:
            r = app_fetch_detail(book_id)
            if (r.get("data") or {}).get("book_name"):
                return r
        except Exception as e:  # noqa
            sys.stderr.write("[fanqie] APP 详情失败，回退 Web: bookId=%s %s\n" % (book_id, e))
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
            "cover_url": normalize_cover(d.get("thumbUrl") or d.get("thumbUri") or ""),
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
    """目录：APP directory/list + directory/detail 优先，失败回退官网 Web。"""
    book_id = str(book_id)
    cached = _dir_cache_get(book_id)
    if cached is not None:
        return cached
    if DIR_SOURCE != "web" and META_CHANNEL != "web":
        try:
            r = app_fetch_directory(book_id)
            vols = (r.get("data") or {}).get("chapterListWithVolume") or []
            if vols and any(v.get("chapterList") for v in vols):
                _dir_cache_put(book_id, r)
                return r
        except Exception as e:  # noqa
            sys.stderr.write("[fanqie] APP 目录失败，回退 Web: bookId=%s %s\n" % (book_id, e))
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


def route_discovery(qs):
    channel = qs.get("channel", ["male"])[0]
    cell = qs.get("cell", [None])[0]
    listing = str(qs.get("listing", ["0"])[0]) in ("1", "true", "yes")
    return fetch_discovery(channel, cell, listing)


def route_detail(path):
    m = re.match(r"^/api/v1/books/([^/]+)/detail$", path)
    return fetch_detail(m.group(1))


def route_directory(path):
    m = re.match(r"^/api/v1/books/([^/]+)/directory$", path)
    return fetch_directory(m.group(1))


def route_chapter(path):
    m = re.match(r"^/api/v1/chapters/([^/]+)/novel$", path)
    return fetch_chapter(m.group(1))


def route_chapter_details(qs):
    """章节元数据（APP 免签批量，缺失项用 Web 目录兜底）。"""
    raw = qs.get("item_ids", [""])[0]
    ids = [x for x in re.split(r"[,;\s]+", raw) if x]
    if not ids:
        raise RuntimeError("缺少 item_ids 参数")
    details = app_fetch_chapter_details(ids)
    missing = [i for i in ids if i not in details]
    if missing:
        bid = qs.get("book_id", [""])[0]
        if not bid and details:
            bid = str(next(iter(details.values())).get("book_id") or "")
        if bid:
            try:
                web = _fetch_directory_web(bid)
                for v in (web.get("data") or {}).get("chapterListWithVolume") or []:
                    for c in v.get("chapterList") or []:
                        cid = str(c.get("itemId") or "")
                        if cid in missing:
                            details[cid] = {"item_id": cid, "title": c.get("chapter_title") or "",
                                            "word_number": c.get("chapterWordNumber") or ""}
            except Exception as e:  # noqa
                sys.stderr.write("[fanqie] 章节详情 Web 兜底失败: %s\n" % e)
    return {"code": 0, "data": {"chapterDetails": details}}


def dispatch(method, path, qs):
    if method != "GET":
        raise RuntimeError("仅支持 GET")
    if path == "/api/v1/chapters/details":
        return route_chapter_details(qs)
    if path == "/api/v1/search" or path.startswith("/api/v1/search?"):
        return route_search(qs)
    if path == "/api/v1/discovery":
        return route_discovery(qs)
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
        sys.stderr.write("正文渠道: %s；详情/目录: APP(xGorgon+免签批量)→Web 兜底；搜索: APP+Web 两路聚合（book_id+book_name/别名 去重）\n"
                         % ("app（DH 通道，锁章全文）" if CHANNEL != "web" and appchannel is not None
                            else "web（锁章仅试读）"))
        run_server(port)
