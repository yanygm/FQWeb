# FQWeb-Server

番茄小说代理后端，基于 Python 标准库 `http.server` 实现。它将番茄小说的搜索、书籍详情、章节目录和章节正文接口封装为本地 HTTP API，并处理上游签名、字体映射还原和正文解密。

## 功能特性

- 搜索书籍，返回标准化后的 `book_data` 结构。
- 查询书籍详情，包括书名、作者、封面、简介、分类和最新章节标题。
- 查询整本书章节目录，卷与章节结构已归一化，章节标题已还原字体混淆。
- 获取章节正文，优先使用 App 渠道，失败时自动回退到 Web 渠道。
- App 渠道通过 DH 密钥交换、`x-argus` / `x-ladon` / `x-khronos` 签名和 AES-256-CBC 解密，返回无 PUA 字体混淆的明文内容；锁章也可返回全文。
- Web 渠道通过 `a_bogus` 签名和字体映射表还原正文；锁章在没有 SVIP Cookie 时只返回约 200 字试读。
- 目录结果带本地缓存，默认缓存 900 秒，最多缓存 128 本书。
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
| `GET /api/v1/search` | `query`、`offset`、`count` | 搜索书籍 |
| `GET /api/v1/books/{bookId}/detail` | 路径参数 `bookId` | 获取书籍详情 |
| `GET /api/v1/books/{bookId}/directory` | 路径参数 `bookId` | 获取章节目录 |
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

`offset / count` 会被换算成上游接口的 `page_index`。

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

### 3. 书籍详情

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

### 4. 章节目录

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
- 上游目录接口通常一次返回整本书全部章节；只有返回章节数少于 `allItemIds` 时才会继续翻页。
- 目录结果会缓存 900 秒，最多缓存 128 本书。

### 5. 章节正文

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

# 详情
curl "http://127.0.0.1:18921/api/v1/books/123/detail"

# 目录
curl "http://127.0.0.1:18921/api/v1/books/123/directory"

# 正文
curl "http://127.0.0.1:18921/api/v1/chapters/456/novel"
```

## 上游接口

| 用途 | 上游接口 | 说明 |
|---|---|---|
| 搜索 | `https://fanqienovel.com/api/author/search/search_book/v1` | 需要 `a_bogus` 网页签名 |
| 详情 | `https://fanqienovel.com/api/book/info` | 免签名 |
| 目录 | `https://fanqienovel.com/api/reader/directory/detail` | 免签名 |
| 正文 Web | `https://fanqienovel.com/api/reader/full` | 需要 `a_bogus` 和字体映射还原 |
| 正文 App | `https://novel.snssdk.com/api/novel/book/reader/content/v1` | DH 密钥交换、签名和 AES 解密 |

## 文件说明

| 文件 | 说明 |
|---|---|
| `fanqie_backend.py` | HTTP 服务入口、路由分发、上游请求和响应组装 |
| `appchannel.py` | App 渠道正文获取、签名、密钥交换与解密 |
| `abogus.py` | 网页端 `a_bogus` 签名生成 |
| `fontmap.py` | 正文 PUA 字符到汉字的映射 |
| `searchmap.py` | 搜索和列表 PUA 字符到汉字的映射 |
| `requirements.txt` | Python 依赖清单 |
