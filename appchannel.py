#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""番茄 App 渠道正文（DH 加密通道）。

移植自 fqapp-master（rust/src/sign/{argus,ladon,simon,protobuf}.rs、
rust/src/upstream/dh.rs、rust/src/endpoints/dhcontent.rs）。

为什么需要它：Web 接口 /api/reader/full 对 isChapterLock=true 的章节只返回
约 200 字试读；App 的 novel/book/reader/content/v1 走 DH 密钥交换，返回整章
明文 HTML，且不需要设备注册（Signed 模式只对 query 签名）。

链路：
  1. 生成 32 字节私钥 a，计算 A = 2^a mod P（3071 bit 安全素数）；
  2. y 头 = base64(iv + AES-128-CBC(PKCS7(Java 大整数编码(A))))；
  3. 请求头带 x-khronos / x-ss-req-ticket / x-ladon / x-argus；
  4. 响应头 y = 服务端公钥 B，c 或 data.content = base64(iv + AES-256-CBC 密文)；
  5. 共享密钥 S = B^a mod P，取 S 大端表示的前 32 字节做 AES-256-CBC 密钥。

依赖：pycryptodome（AES）、gmssl（SM3，x-argus 用）。
"""
import base64
import gzip
import hashlib
import html as _html
import json
import os
import random
import re
import time
import urllib.parse
import urllib.request

try:  # pycryptodome
    from Crypto.Cipher import AES
except Exception:  # pragma: no cover
    AES = None

try:  # gmssl（与 abogus 同一个依赖）
    from gmssl.sm3 import sm3_hash as _sm3_hash
except Exception:  # pragma: no cover
    _sm3_hash = None


# --------------------------------------------------------------------------
# protobuf（仅编码，x-argus 用）
# --------------------------------------------------------------------------
class _Proto(object):
    def __init__(self):
        self._fields = []
        self._blobs = []

    def varint(self, idx, v):
        self._fields.append((idx, 0, v & 0xFFFFFFFFFFFFFFFF, None))

    def utf8(self, idx, s):
        self.blob(idx, s.encode("utf-8"))

    def blob(self, idx, data):
        self._blobs.append(data)
        self._fields.append((idx, 2, 0, len(self._blobs) - 1))

    def msg(self, idx, sub):
        self.blob(idx, sub.buf())

    def buf(self):
        out = bytearray()
        for idx, typ, v, bi in self._fields:
            out += _vi(((idx << 3) | (typ & 7)) & 0xFFFFFFFF)
            if typ == 2:
                b = self._blobs[bi]
                out += _vi(len(b))
                out += b
            else:
                out += _vi(v)
        return bytes(out)


def _vi(v):
    """v 先截断到 32 位，与上游实现一致。"""
    v &= 0xFFFFFFFF
    out = bytearray()
    while v >= 128:
        out.append((v & 127) | 128)
        v >>= 7
    out.append(v & 127)
    return bytes(out)


# --------------------------------------------------------------------------
# Simon 分组密码（128-bit key / 64-bit block / 72 轮）
# --------------------------------------------------------------------------
_SIMON_Z = 0x3DC94C3A046D678B
_M64 = 0xFFFFFFFFFFFFFFFF


def _rotr(v, n):
    return ((v >> n) | (v << (64 - n))) & _M64


def _rotl(v, n):
    return ((v << n) | (v >> (64 - n))) & _M64


def _simon_enc(pt, k):
    key = [0] * 72
    key[0:4] = list(k)
    for i in range(4, 72):
        tmp = _rotr(key[i - 1], 3) ^ key[i - 3]
        tmp ^= _rotr(tmp, 1)
        bit = (_SIMON_Z >> ((i - 4) % 62)) & 1
        key[i] = (~key[i - 4] & _M64) ^ tmp ^ bit ^ 3
    xi, xi1 = pt
    for rk in key:
        tmp = xi1
        f = _rotl(xi1, 1) & _rotl(xi1, 8)
        xi1 = xi ^ f ^ _rotl(xi1, 2) ^ rk
        xi = tmp
    return [xi, xi1]


# --------------------------------------------------------------------------
# x-argus
# --------------------------------------------------------------------------
_ARGUS_SIGN_KEY = bytes.fromhex(
    "fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304")
_ARGUS_AES_KEY = bytes.fromhex("d31e3718288a1027baab59f146a09a9c")
_ARGUS_AES_IV = bytes.fromhex("ea180a0336ed352fcd24e4d50018ae54")
_ARGUS_MAGIC8 = bytes([0xF2, 0xF7, 0xFC, 0xFF, 0xF2, 0xF7, 0xFC, 0xFF])
_ARGUS_TAIL9 = bytes([0xEA, 0xFB, 0x2C, 0xFE, 0x85, 0x68, 0x51, 0x91, 0x54])
_ARGUS_AES_KEY_LIST = [
    int.from_bytes(_ARGUS_SIGN_KEY[i * 8:i * 8 + 8], "little") for i in range(4)]


def _pkcs7_align(data):
    pad = 16 - (len(data) % 16)
    return data + bytes([pad]) * pad


def _aes_cbc_enc(data, key, iv):
    if AES is None:
        raise RuntimeError("需要 pycryptodome：pip install pycryptodome")
    return AES.new(key, AES.MODE_CBC, iv).encrypt(data)


def _aes_cbc_dec(data, key, iv):
    if AES is None:
        raise RuntimeError("需要 pycryptodome：pip install pycryptodome")
    return AES.new(key, AES.MODE_CBC, iv).decrypt(data)


def _sm3_prefix6(msg):
    if _sm3_hash is None:
        raise RuntimeError("需要 gmssl：pip install gmssl")
    return bytes.fromhex(_sm3_hash(list(msg)))[:6]


def _simon_encrypt_padded(pb):
    out = bytearray(len(pb))
    for i in range(len(pb) // 16):
        blk = pb[i * 16:(i + 1) * 16]
        ct = _simon_enc([int.from_bytes(blk[:8], "little"),
                         int.from_bytes(blk[8:], "little")], _ARGUS_AES_KEY_LIST)
        out[i * 16:i * 16 + 8] = ct[0].to_bytes(8, "little")
        out[i * 16 + 8:i * 16 + 16] = ct[1].to_bytes(8, "little")
    return bytes(out)


def _argus_encrypt_551(bean):
    pb = _pkcs7_align(bean.buf())
    enc = _simon_encrypt_padded(pb)
    un = _ARGUS_MAGIC8 + enc + _ARGUS_TAIL9
    buf = bytearray(len(un))
    buf[:8] = _ARGUS_MAGIC8
    for i in range(8, len(un)):
        buf[i] = un[i] ^ _ARGUS_MAGIC8[i % 8]
    buf.reverse()
    buf += b"ao"
    buf = _pkcs7_align(bytes(buf))
    out = _aes_cbc_enc(buf, _ARGUS_AES_KEY, _ARGUS_AES_IV)
    return base64.b64encode(b"\xf2\x81" + out).decode()


def query_param(query, name):
    for k, v in urllib.parse.parse_qsl(query, keep_blank_values=True):
        if k == name:
            return v
    return None


def argus_sign(query, ts, aid, license_id, device_id="", install_id=""):
    """x-argus（551 版绑定）。"""
    bean = _Proto()
    bean.varint(1, 1077940818)
    bean.varint(2, 2)
    bean.varint(3, random.randint(-2 ** 31, 2 ** 31 - 1))
    bean.utf8(4, str(aid))
    bean.utf8(5, device_id or "")
    bean.utf8(6, str(license_id))
    bean.utf8(7, query_param(query, "version_name") or "")
    bean.utf8(8, "v04.04.05-ov-android")
    bean.varint(9, 134744640)
    bean.blob(10, b"\x00" * 8)
    bean.varint(11, 0)
    bean.varint(12, ts << 1)
    bean.blob(13, _sm3_prefix6(b"\x00" * 16))          # body hash（GET 无 body）
    bean.blob(14, _sm3_prefix6(query.encode()) if query else _sm3_prefix6(b"\x00" * 16))
    sub15 = _Proto()
    sub15.varint(1, 1)
    sub15.varint(2, 1)
    sub15.varint(3, 1)
    sub15.varint(7, 0xC792ECCC)
    bean.msg(15, sub15)
    bean.utf8(16, install_id or "")
    bean.utf8(20, "none")
    bean.varint(21, 738)
    sub23 = _Proto()
    sub23.utf8(1, "NX551J")
    sub23.varint(2, 8196)
    sub23.varint(4, 0x80E0D800)
    bean.msg(23, sub23)
    bean.varint(25, 2)
    return _argus_encrypt_551(bean)


# --------------------------------------------------------------------------
# x-ladon（34 轮 ARX）
# --------------------------------------------------------------------------
def _ladon_table(md5_hex):
    ht = bytearray(288)
    raw = md5_hex.encode("ascii")[:32]
    ht[:len(raw)] = raw
    temp = [int.from_bytes(ht[i * 8:i * 8 + 8], "little") for i in range(4)]
    b0, b8 = temp[0], temp[1]
    temp = temp[2:]
    for i in range(34):
        x9 = b0
        x8 = _rotr(b8, 8)
        x8 = (x8 + x9) & _M64
        x8 ^= i
        temp.append(x8)
        x8 ^= _rotl(x9, 3)
        ht[(i + 1) * 8:(i + 1) * 8 + 8] = (x8 & _M64).to_bytes(8, "little")
        b0 = x8
        b8 = temp.pop(0)
    return bytes(ht)


def _ladon_block(ht, blk):
    d0 = int.from_bytes(blk[:8], "little")
    d1 = int.from_bytes(blk[8:], "little")
    for i in range(34):
        h = int.from_bytes(ht[i * 8:i * 8 + 8], "little")
        d1 = h ^ ((d0 + _rotr(d1, 8)) & _M64)
        d0 = d1 ^ _rotl(d0, 3)
    return (d0 & _M64).to_bytes(8, "little") + (d1 & _M64).to_bytes(8, "little")


def ladon_encrypt(ts, lc_id, aid):
    """x-ladon: base64(random4 + 加密("<ts>-<lcId>-<aid>"))。"""
    rnd = os.urandom(4)
    md5_hex = hashlib.md5(rnd + str(aid).encode()).hexdigest()
    ht = _ladon_table(md5_hex)
    data = ("%d-%d-%d" % (ts, lc_id, aid)).encode()
    pad = 16 - len(data) % 16
    buf = data + bytes([pad]) * pad
    out = b"".join(_ladon_block(ht, buf[i * 16:(i + 1) * 16])
                   for i in range(len(buf) // 16))
    return base64.b64encode(rnd + out).decode()


# --------------------------------------------------------------------------
# DH 密钥交换
# --------------------------------------------------------------------------
_DH_P = int(
    "2410312426921032588552076022197566074856950548502459942654116941958108831682612228890093858261341614673227141477904012196503648957050582631942730706805009223062734745341073406696246014589361659774041027169249453200378729434170325843778659198143763193776859869524088940195577346119843545301547043747207749969763750084308926339295559968882457872412993810129130294592999947926365264059284647209730384947211681434464714438488520940127459844288859336526896320919633919")
_DH_Q = (_DH_P - 1) // 2
_DH_REQ_KEY = base64.b64decode("rCXGfd2POMGzeiNIgo4iLg==")
_LC_ID = 1611921764


def _java_bigint(n):
    """Java BigInteger.toByteArray(): 大端，最高位为 1 时补 0x00。"""
    if n == 0:
        return b""
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return (b"\x00" + b) if b[0] & 0x80 else b


def generate_y():
    """生成 y 请求头和私钥 a。"""
    a = os.urandom(32)
    pub = pow(2, int.from_bytes(a, "big"), _DH_P)
    iv = os.urandom(16)
    ct = _aes_cbc_enc(_pkcs7_align(_java_bigint(pub)), _DH_REQ_KEY, iv)
    return base64.b64encode(iv + ct).decode(), a


def decrypt_dh(server_y_b64, content_b64, a):
    b = int.from_bytes(base64.b64decode(server_y_b64), "big")
    if b < 2 or b > _DH_P - 2 or pow(b, _DH_Q, _DH_P) != 1:
        raise RuntimeError("服务端 DH 公钥非法")
    s = pow(b, int.from_bytes(a, "big"), _DH_P)
    if s == 0:
        raise RuntimeError("共享密钥为 0")
    sb = s.to_bytes((s.bit_length() + 7) // 8, "big")
    if len(sb) < 32:
        raise RuntimeError("共享密钥过短: %d" % len(sb))
    key = sb[:32]
    raw = base64.b64decode(content_b64)
    if len(raw) < 32:
        raise RuntimeError("密文过短: %d" % len(raw))
    iv, ct = raw[:16], raw[16:]
    if len(ct) % 16:
        raise RuntimeError("密文未按块对齐: %d" % len(ct))
    pt = _aes_cbc_dec(ct, key, iv)
    pad = pt[-1] if pt else 0
    if not 1 <= pad <= 16 or pt[-pad:] != bytes([pad]) * pad:
        raise RuntimeError("PKCS7 填充非法")
    pt = pt[:-pad]
    if pt[:2] == b"\x1f\x8b":
        pt = gzip.decompress(pt)
    return pt


# --------------------------------------------------------------------------
# 正文清洗
# --------------------------------------------------------------------------
_RE_HEADER = re.compile(r"(?is)<header>(.*?)</header>")
_RE_ARTICLE = re.compile(r"(?is)<article>(.*?)</article>")
_RE_P_OPEN = re.compile(r"(?i)<p[^>]*>")
_RE_BR = re.compile(r"(?i)<br\s*/?>")
_RE_IMG = re.compile(r"(?is)<img[^>]*>")
_RE_TAG = re.compile(r"(?s)<[^>]+>")
_RE_SPACES = re.compile(r"[ \t\u00a0\u200b\ufeff\u3000]+")


def clean_content(html):
    """把 App 渠道的正文 HTML 转成 {title, text}。"""
    title = ""
    m = _RE_HEADER.search(html)
    if m:
        title = _html.unescape(_RE_TAG.sub("", m.group(1))).strip()
    m = _RE_ARTICLE.search(html)
    body = m.group(1) if m else html
    body = _RE_P_OPEN.sub("\n", body)
    body = _RE_BR.sub("\n", body)
    body = _RE_IMG.sub("", body)
    body = _RE_TAG.sub("", body)
    body = _html.unescape(body)
    body = _RE_SPACES.sub(" ", body)
    lines = [ln.strip() for ln in body.split("\n")]
    return title, "\n".join(ln for ln in lines if ln)


# --------------------------------------------------------------------------
# 请求
# --------------------------------------------------------------------------
UA_NOVEL = ("com.ss.android.article.news/13400 (Linux; U; Android 10; zh_CN; "
            "tb8788p1_64_bsp; Build/QQ3A.200805.001; Cronet/TTNetVersion:fc4cebd3 "
            "2024-12-10 QuicVersion:d9628e3d 2024-10-11)")
HOST_CONTENT = "https://novel.snssdk.com/api/novel/book/reader/content/v1"


def build_query(item_id, aid=13):
    return ("aid=%d&app_name=novelapp&channel=0&device_platform=android"
            "&device_type=25053RT47C&item_id=%s&os_version=10&support_image=1"
            "&version_code=66.9" % (aid, urllib.parse.quote(str(item_id), safe="")))


def fetch_chapter(item_id, timeout=20, retries=2):
    """拉取整章正文，返回 {"title", "content", "raw_html", "pay_status"}。"""
    if AES is None:
        raise RuntimeError("需要 pycryptodome：pip install pycryptodome")
    last = None
    for _ in range(max(1, retries)):
        try:
            return _fetch_once(item_id, timeout)
        except Exception as e:  # noqa
            last = e
            time.sleep(0.5)
    raise RuntimeError("App 渠道正文获取失败: %s" % last)


def _fetch_once(item_id, timeout):
    query = build_query(item_id)
    url = HOST_CONTENT + "?" + query
    y, a = generate_y()
    ts = int(time.time())
    aid = int(query_param(query, "aid") or 13)
    headers = {
        "User-Agent": UA_NOVEL,
        "Accept-Encoding": "gzip, deflate",
        "y": y,
        "x-ss-req-ticket": str(ts * 1000),
        "x-khronos": str(ts),
        "x-ladon": ladon_encrypt(ts, _LC_ID, aid),
        "x-argus": argus_sign(query, ts, aid, _LC_ID,
                              query_param(query, "device_id") or ""),
    }
    req = urllib.request.Request(url, headers=headers)
    resp = urllib.request.urlopen(req, timeout=timeout)
    body = resp.read()
    if (resp.headers.get("content-encoding") or "").lower() == "gzip":
        body = gzip.decompress(body)
    if resp.status != 200:
        raise RuntimeError("HTTP %d" % resp.status)
    payload = json.loads(body.decode("utf-8", "ignore"))
    if payload.get("code") not in (0, "0"):
        raise RuntimeError("接口返回 code=%s：%s"
                           % (payload.get("code"), payload.get("message")))

    data = payload.get("data") or {}
    c_resp = resp.headers.get("c") or ""
    content_b64 = data.get("content") or ""
    if c_resp in ("", "1"):
        c_resp = content_b64
    server_y = resp.headers.get("y") or ""
    if not server_y or not c_resp:
        raise RuntimeError("响应缺少 DH 密钥或密文")

    plain = decrypt_dh(server_y, c_resp, a)
    html = plain.decode("utf-8", "ignore")
    title, text = clean_content(html)
    if not text:
        raise RuntimeError("解密后的正文为空")
    return {"title": title or data.get("title") or "",
            "content": text,
            "raw_html": html,
            "pay_status": data.get("pay_status")}
