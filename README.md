# FQWeb-Server

番茄小说代理后端，基于 Python 标准库 `http.server` 实现。它将番茄小说的搜索、书籍详情、章节目录和章节正文接口封装为本地 HTTP API，并处理上游签名、字体映射还原和正文解密。

## 功能特性

- 搜索书籍，APP 渠道（`novel.snssdk.com`，x-ladon/x-argus 签名）与 Web 渠道（`fanqienovel.com`，`a_bogus` 签名）双路聚合、按 `book_id` + 书名去重后返回标准化 `book_data` 结构；任一路失败另一路仍可用。
- 发现页推荐/榜单，按男频（`bookstore/homepage`）/ 女频（`bookmall/homepage`）拉取 APP 首页信息流并分组，无需登录；支持按分组索引取单组书卡。
- 查询书籍详情，包括书名、作者、封面、简介、分类和最新章节标题，APP 主路 + Web 兜底。
- 查询整本书章节目录，APP 采用两阶段加载（`directory/list` 拿章节 ID → `directory/detail` 并发补标题），卷与章节结构已归一化，章节标题已还原字体混淆；Web 兜底可一次返回整本。
- 封面 URL 规范化：被 CDN 封禁的 `bytecdn` 域名自动改写为可用的 `byteimg` 域名。
- 获取章节正文，优先使用 App 渠道，失败时自动回退到 Web 渠道。
- App 渠道通过 DH 密钥交换、`x-argus` / `x-ladon` / `x-khronos` 签名和 AES-256-CBC 解密，返回无 PUA 字体混淆的明文内容；锁章也可返回全文。
- Web 渠道通过 `a_bogus` 签名和字体映射表还原正文；锁章在没有 SVIP Cookie 时只返回约 200 字试读。
- 搜索/列表与正文使用两套独立的字体映射（`SEARCH_MAP` / `FONT_MAP`），混用会导致书名或正文乱码。
- 目录结果带本地缓存，默认缓存 900 秒，最多缓存 128 本书；发现页首页流缓存 600 秒。
- CORS 全开，所有响应统一为 UTF-8 JSON。

## 环境依赖

- Python 3
- `pycryptodome>=3.20`
- `gmssl`

安装依赖：

```bash
pip install -r requirements.txt
```

## 启动服务

默认监听 `18921` 端口，同时支持 IPv4 和 IPv6：

```bash
python fanqie_backend.py
```

指定端口：

```bash
python fanqie_backend.py --port=18921
```

强制正文走 Web 渠道：

```bash
python fanqie_backend.py --channel=web
```

设置上游番茄网页 SVIP Cookie，用于 Web 渠道读取锁章全文：

```bash
# Linux / macOS
export FQ_COOKIE="sessionid=..."
```

```powershell
# Windows PowerShell
$env:FQ_COOKIE="sessionid=..."
```

也可以通过启动参数设置 Cookie：

```bash
python fanqie_backend.py --cookie="sessionid=..."
```

端到端冒烟测试，需要联网：

```bash
python fanqie_backend.py --test
```

> `FQ_COOKIE` / `--cookie` 是访问番茄上游接口时使用的 Cookie，不是调用本服务时需要提供的鉴权信息。本服务对外不鉴权。

### 渠道与上游配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FQ_CHANNEL` | `app` | 正文渠道。`web` 关闭 App DH 通道，改用网页接口（锁章在无 SVIP Cookie 时仅试读）。 |
| `FQ_META_CHANNEL` | `app` | 详情渠道。`web` 强制详情只走官网 Web。 |
| `FQ_DIR_SOURCE` | `auto` | 目录来源。`auto` 为 APP 主路失败回退 Web，`web` 强制只走官网 Web。 |
| `FQ_APP_NOVEL_HOST` | `https://api.fanqiesdk.com` | APP 详情/目录/章节详情接口 host。 |
| `FQ_SEARCH_PER_SOURCE` | `10` | 搜索聚合时每路最多取多少条。 |
| `FQ_SEARCH_TOTAL` | `30` | 搜索聚合返回总上限。 |

> 详情、目录默认走 APP 接口（反编译还原并实测可用），失败自动回退官网 Web；正文默认走 App DH 加密通道。发现页推荐/榜单用公开签名即可，**无需登录**。

## API 接口

默认基础地址：

```text
http://127.0.0.1:18921
```

所有业务接口仅支持 `GET`。`HEAD` 会复用 `GET` 逻辑，但不返回响应体。

| 接口 | 参数 | 功能 |
|---|---|---|
| `GET /api/v1/health` | 无 | 健康检查 |
| `GET /health` | 无 | 健康检查，别名接口 |
| `GET /api/v1/search` | `query`、`offset`、`count` | 搜索书籍（APP+Web 聚合） |
| `GET /api/v1/discovery` | `channel`、`cell`、`listing` | 发现页推荐/榜单 |
| `GET /api/v1/books/{bookId}/detail` | 路径参数 `bookId` | 获取书籍详情 |
| `GET /api/v1/books/{bookId}/directory` | 路径参数 `bookId` | 获取章节目录 |
| `GET /api/v1/chapters/details` | `item_ids`、`book_id` | 批量查询章节元数据（标题/字数，APP 免签） |
| `GET /api/v1/chapters/{itemId}/novel` | 路径参数 `itemId` | 获取章节正文 |
| `GET /favicon.ico` | 无 | 占位接口，返回 404 JSON |

### 1. 健康检查

```text
GET /api/v1/health
GET /health
```

返回示例：

```json
{
  "code": 0,
  "message": "ok"
}
```

### 2. 搜索书籍

```text
GET /api/v1/search?query=关键词&offset=0&count=10
```

参数说明：

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `query` | string | 空字符串 | 搜索关键词 |
| `offset` | int | `0` | 结果偏移量 |
| `count` | int | `10` | 每页数量 |

`offset / count` 会被换算成上游接口的 `page_index`。搜索会并发请求 APP 与 Web 两路，按 `book_id` + 书名（含 `alias_names`）去重后合并，先成功/先返回的源优先；仅当两路都失败时才返回空。改名书（同 id 不同名）会保留别名，不重复占位。封面域名若被 CDN 封禁会自动改写。

返回示例：

```json
{
  "code": 0,
  "search_tabs": [
    {
      "data": [
        {
          "book_data": {
            "book_id": "123",
            "book_name": "书名",
            "author_name": "作者",
            "cover_url": "https://...",
            "abstract": "简介",
            "category": "分类",
            "new_chapter_title": "最新章节"
          }
        }
      ]
    }
  ],
  "data": {
    "search_book_data_list": [
      {
        "book_data": {
          "book_id": "123",
          "book_name": "书名",
          "author_name": "作者",
          "cover_url": "https://...",
          "abstract": "简介",
          "category": "分类",
          "new_chapter_title": "最新章节"
        }
      }
    ]
  }
}
```

### 3. 发现页推荐/榜单

```text
GET /api/v1/discovery?channel=male&listing=1
GET /api/v1/discovery?channel=female&cell=0
GET /api/v1/discovery?channel=male
```

参数说明：

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `channel` | string | `male` | `male` 男频（`bookstore/homepage`）/ `female` 女频（`bookmall/homepage`） |
| `listing` | string | `0` | `1` 时只返回分组元信息（名称+数量+索引），不返回书卡 |
| `cell` | string | 空 | 分组索引数字或分组名，只返回该组书卡；留空返回全部分组 |

`listing=1` 返回示例：

```json
{
  "code": 0,
  "data": {
    "groups": [
      { "index": 0, "name": "推荐", "count": 8 }
    ]
  }
}
```

指定 `cell` 或不带 `listing` 时，返回与搜索一致的 `data.search_tabs` 结构，便于书源直接复用解析规则。该接口基于 APP 首页信息流，公开签名即可访问，**不需要登录**；结果缓存 600 秒。

### 4. 书籍详情

```text
GET /api/v1/books/{bookId}/detail
```

返回示例：

```json
{
  "code": 0,
  "data": {
    "book_id": "123",
    "book_name": "书名",
    "author_name": "作者",
    "cover_url": "https://...",
    "abstract": "简介",
    "category": "分类",
    "new_chapter_title": "最新章节"
  }
}
```

### 5. 章节目录

```text
GET /api/v1/books/{bookId}/directory
```

返回示例：

```json
{
  "code": 0,
  "data": {
    "chapterListWithVolume": [
      {
        "volumeName": "卷名",
        "volumeId": "卷 ID",
        "chapterList": [
          {
            "itemId": "章节 ID",
            "chapter_title": "章节标题"
          }
        ]
      }
    ],
    "allItemIds": ["章节 ID"]
  }
}
```

说明：

- 章节标题会经过字体映射还原。
- APP 主路采用两阶段加载，与官方 APP 一致：`directory/list`（xGorgon）拿章节 ID 列表，`directory/detail`（免签）按 `item_ids` 分批补标题。两阶段是必需的——`directory/list` 只返回纯 ID 列表，服务端不下发带标题的 `catalog_list`。
- 补标题以每批 100 章并发拉取（实测单批 200 会被上游静默返回空），并带单批失败重试；2712 章大书从串行的约 17 秒降到约 2 秒，避免阅读器超时。结果按章节顺序组装，返回结构不变。
- APP 主路失败时回退官网 Web `/api/reader/directory/detail`（一次返回整本）。
- 目录结果会缓存 900 秒，最多缓存 128 本书；缓存命中时直接返回，不再请求上游。

### 6. 批量章节元数据

```text
GET /api/v1/chapters/details?item_ids=章节ID1,章节ID2&book_id=可选
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `item_ids` | string | 逗号/分号/空格分隔的章节 ID，必填 |
| `book_id` | string | 可选，用于缺失项的 Web 兜底 |

返回示例：

```json
{
  "code": 0,
  "data": {
    "chapterDetails": {
      "章节ID1": { "item_id": "章节ID1", "title": "章节标题", "word_number": 1234 }
    }
  }
}
```

基于 APP `directory/detail` 免签接口批量查询；个别缺失项在有 `book_id` 时用 Web 目录补齐。

### 7. 章节正文

```text
GET /api/v1/chapters/{itemId}/novel
```

默认优先走 App 渠道，失败时回退到 Web 渠道。

App 渠道返回示例：

```json
{
  "code": 0,
  "data": {
    "content": "章节正文",
    "title": "章节标题",
    "word_number": 1234,
    "is_locked": false,
    "preview": false,
    "source": "app"
  }
}
```

Web 渠道返回示例：

```json
{
  "code": 0,
  "data": {
    "content": "章节正文",
    "word_number": 1234,
    "is_locked": false,
    "preview": false
  }
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `content` | 章节正文，HTML 标签已被清理 |
| `title` | 章节标题，App 渠道提供 |
| `word_number` | 上游标记的总字数 |
| `is_locked` | 是否为锁章 |
| `preview` | 是否只是试读内容 |
| `source` | 正文来源，App 渠道固定为 `app` |

如果使用 `--channel=web` 强制走 Web 渠道，且没有设置 SVIP Cookie，锁章可能只返回约 200 字试读，此时 `is_locked` 和 `preview` 会标记出来。

## 响应约定

成功响应：

```json
{
  "code": 0,
  "data": {}
}
```

失败响应：

```json
{
  "code": 500,
  "message": "错误信息"
}
```

其他约定：

- HTTP 状态码：正常为 `200`，异常为 `500`，`favicon.ico` 为 `404`。
- 响应头：`Content-Type: application/json; charset=utf-8`。
- 跨域：`Access-Control-Allow-Origin: *`。
- 鉴权：无，所有接口可直接访问。
- 方法：仅实现 `GET` 和 `HEAD`，未实现 `POST`、`PUT`、`DELETE` 等。

## 调用示例

```bash
# 健康检查
curl "http://127.0.0.1:18921/api/v1/health"

# 搜索
curl "http://127.0.0.1:18921/api/v1/search?query=小说&offset=0&count=10"

# 发现页分组列表 / 取单组 / 全量
curl "http://127.0.0.1:18921/api/v1/discovery?channel=male&listing=1"
curl "http://127.0.0.1:18921/api/v1/discovery?channel=female&cell=0"
curl "http://127.0.0.1:18921/api/v1/discovery?channel=male"

# 详情
curl "http://127.0.0.1:18921/api/v1/books/123/detail"

# 目录
curl "http://127.0.0.1:18921/api/v1/books/123/directory"

# 批量章节元数据
curl "http://127.0.0.1:18921/api/v1/chapters/details?item_ids=456,789"

# 正文
curl "http://127.0.0.1:18921/api/v1/chapters/456/novel"
```

## 上游接口

搜索、详情、目录默认 APP 优先，Web 兜底；正文默认走 App DH 通道。

| 用途 | 上游接口 | 说明 |
|---|---|---|
| 搜索 App | `https://novel.snssdk.com/api/novel/channel/homepage/search/search/v1` | `x-ladon` / `x-argus` 签名，字体用 `SEARCH_MAP` 还原 |
| 搜索 Web | `https://fanqienovel.com/api/author/search/search_book/v1` | 需要 `a_bogus` 网页签名 |
| 详情 App | `https://api.fanqiesdk.com/api/novel/book/directory/list/v1` | xGorgon 签名，取 `book_info` |
| 详情 Web | `https://fanqienovel.com/api/book/info` | 免签名，兜底 |
| 目录 App ① | `https://api.fanqiesdk.com/api/novel/book/directory/list/v1` | xGorgon 签名，取 `item_list` 章节 ID |
| 目录 App ② | `https://api.fanqiesdk.com/api/novel/book/directory/detail/v1` | 免签名，`item_ids` 批量补标题（每批 100，并发） |
| 目录 Web | `https://fanqienovel.com/api/reader/directory/detail` | 免签名，一次返回整本，兜底 |
| 发现页 男频 | `bookstore/homepage`（`reading.snssdk.com`） | xGorgon 签名，公开可用 |
| 发现页 女频 | `bookmall/homepage`（`reading.snssdk.com`） | xGorgon 签名，公开可用 |
| 章节元数据 | `https://api.fanqiesdk.com/api/novel/book/directory/detail/v1` | 免签名，批量查标题/字数 |
| 正文 Web | `https://fanqienovel.com/api/reader/full` | 需要 `a_bogus` 和字体映射还原 |
| 正文 App | `https://novel.snssdk.com/api/novel/book/reader/content/v1` | DH 密钥交换、签名和 AES 解密 |

> APP 原生分类接口（`new_category/front`、`bookmall/tab` 等）依赖 native 强签名且需登录态，本地后端无法复现，故发现页改用公开可用的首页推荐/榜单信息流。

## 文件说明

| 文件 | 说明 |
|---|---|
| `fanqie_backend.py` | HTTP 服务入口、路由分发、上游请求和响应组装（搜索/发现/详情/目录/正文） |
| `appchannel.py` | App 渠道正文获取、签名、密钥交换与解密 |
| `abogus.py` | 网页端 `a_bogus` 签名生成 |
| `fontmap.py` | 正文 PUA 字符到汉字的映射（`FONT_MAP`） |
| `searchmap.py` | 搜索和列表 PUA 字符到汉字的映射（`SEARCH_MAP`） |
| `番茄小说书源.json` | 阅读 App 书源，对接本服务的搜索/发现/详情/目录正文接口 |
| `番茄全文在线免费读.js` | 油猴脚本，番茄网页正文增强（图片、自动阅读、TTS、悬浮侧栏、自建目录等） |
| `novelapp_反编译分析.md` | APP 反编译分析报告：接口清单、签名方案、目录两阶段加载等还原结论 |
| `requirements.txt` | Python 依赖清单 |

## 改动记录

### 目录加载超时优化（最近）

- **问题**：章节多的书（如 2712 章）目录加载失败，直接请求接口响应约 17 秒，超过阅读器超时；章节少的书正常。
- **原因**：APP 目录补标题阶段（`directory/detail`）原为每批 50 章**串行**请求，大书要几十次串行 HTTP。
- **修复**：改为每批 100 章 + 并发 8 拉取，单批失败重试 1 次，保持章节顺序与返回结构不变。实测 2712 章由约 17 秒降到 **2.11 秒**，1282 章 1.14 秒，282 章 1.01 秒；缓存命中直接返回。
- 说明：单批 200 会被上游静默返回空，故批量上限固定为 100。

### 书源书籍 URL / 目录 URL 修复

- **问题**：从「发现页 → 我的书架」进入的书籍，书籍 URL 为 `fanqienovel.com/api/v1/books/{id}/detail`，目录 URL 缺 ID（`/api/v1/books//directory`）。
- **原因**：书架书卡由官网 `bookshelf/info` 接口提供，阅读器据此把相对路径拼到 `fanqienovel.com`，而该域名的 `/api/v1` 返回 404，详情解析失败导致目录 ID 取空。
- **修复**：书源 `ruleExplore/bookUrl`、`ruleSearch/bookUrl`、`ruleBookInfo/tocUrl` 改为绝对 URL，且只引用 `source.bookSourceUrl` 动态拼接（跟随实际书源地址，不写死域名），彻底摆脱列表接口 base 影响。
- 注意：已加入书架并固化了错误 URL 的旧书，需在阅读器删除重加或「更换书源」重新解析。

### 发现页改版

- 由搜索标签拼凑改为 APP 官方首页推荐/榜单流（`bookstore/homepage` / `bookmall/homepage`），覆盖男生/女生两大类及各 cell 分组，公开可用、无需登录；不再走 `/api/v1/search`。
- 新增 `/api/v1/discovery` 接口支持分组列表、按组取书、全量返回三种模式；首页流缓存 600 秒。
- 原生分类接口因依赖 native 强签名 + 登录态、本地无法复现而未采用。

### 搜索与封面

- 搜索由单一 Web 改为 APP + Web 双路聚合与去重，接入 APP 搜索真实接口；移除本地手写别名表与头条搜索，改名书用上游 `alias_names` 字段。
- 新增封面 URL 规范化：被 CDN 封禁的 `bytecdn` 域名改写为 `byteimg`，修复封面全部加载失败。
- 正文与搜索分别使用 `FONT_MAP` / `SEARCH_MAP` 两套字体映射，避免混用导致乱码。
