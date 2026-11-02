# CC98 接口分析文档

> 基于接口验证脚本 (`scripts/api-verify.mjs`) 和 CC98 前端源码分析编写。
> 最后更新：2026-11-01

## 0. 前端源码分析发现

基于 CC98 前端 HTML 源码（版本 3.5.0）分析得出：

### 0.1 localStorage 值有 4 字符前缀

CC98 前端对 localStorage 值添加了 4 字符随机前缀作为简单混淆：

```javascript
// 读取时用 .slice(4) 去掉前缀
localStorage.getItem("use-theme").slice(4)
JSON.parse(localStorage.getItem("userInfo").slice(4))
```

**对 Token 的影响**（2026-11-01 实测更正）：

- 键名是 **`accessToken`**（驼峰），不是 `access_token`；
- 值是 **两层包装**：4 字符随机前缀 + `Bearer ` + JWT，实测形态：

```
str-Bearer eyJhbGciOiJSUzI1NiIs...
└4字符┘└Bearer ┘└────── JWT ──────┘
```

```javascript
// 最省事：拿到整串，交给插件的 normalizeToken() 处理
localStorage.getItem('accessToken')
```

> 插件的 `lib/token.js::normalizeToken()` 会反复剥掉「`Bearer `」和「4 字符前缀」直到不再变化；
> 认不出的值原样返回，不猜。

### 0.2 前端 API 调用模式

- 使用自定义 fetch 封装函数 `Ua(url, options)` 发起请求
- URL 路径为相对路径（如 `/topic/123`），由封装函数拼接 `api.cc98.org` 域名
- Authorization Header：`(new Headers).append("Authorization", token)`，token 由 `xa()` 函数获取
- 前端使用 `upload` 标签渲染附件（UBB `[upload=...]...[/upload]`）

### 0.3 前端页面路由

| 路由 | 说明 |
|------|------|
| `/topic/:id` | 帖子详情页 |
| `/topic/:id/:page` | 帖子详情页（指定页码） |
| `/board/:boardId` | 版面页 |
| `/topic/hot-weekly` | 周热帖 |
| `/topic/hot-monthly` | 月热帖 |
| `/topic/hot-history` | 历史热帖 |

## 1. API 概览

| 域名 | 用途 |
|------|------|
| `api.cc98.org` | REST API 主域名 |
| `file.cc98.org` | 附件/文件存储域名 |
| `www.cc98.org` | 论坛前端网站 |
| `openid.cc98.org` | OpenID Connect 认证服务 |

**认证方式：** Bearer Token（`Authorization: Bearer {access_token}`）

---

## 2. 公开端点（无需 Token）

### 2.1 热门帖子 ✅ 已验证

```
GET https://api.cc98.org/Topic/Hot
```

**响应：** JSON 数组，返回 10 条热门帖子

| 字段 | 类型 | 说明 | 已验证 |
|------|------|------|--------|
| `id` | number | 帖子 ID | ✅ |
| `title` | string | 标题 | ✅ |
| `boardId` | number | 版面 ID | ✅ |
| `boardName` | string | 版面名称 | ✅ |
| `participantCount` | number | 参与人数 | ✅ |
| `replyCount` | number | 回复数 | ✅ |
| `hitCount` | number | 点击数 | ✅ |
| `authorName` | string \| null | 作者昵称（匿名时为 null） | ✅ |
| `authorUserId` | number | 作者用户 ID（匿名时为 -1） | ✅ |
| `createTime` | string | 发帖时间 (ISO 8601, 如 `2026-10-30T14:56:00`) | ✅ |
| `type` | number | 帖子类型 | ✅ |
| `isAnonymous` | boolean | 是否匿名 | ✅ |
| `hotTopicType` | number | 热帖类型 | ✅ |

> ⚠️ **不要把这个结构当成通行的帖子对象**（2026-11-01 实测）：
> `/Topic/Search` 和 `/Topic/{id}` 用的是**另一套字段名**——
>
> | 含义 | `/Topic/Hot` | `/Topic/Search`、`/Topic/{id}` |
> |---|---|---|
> | 发帖时间 | `createTime` | **`time`** |
> | 作者名 | `authorName` | **`userName`** |
> | 作者 ID | `authorUserId` | **`userId`** |
>
> 照抄 `/Topic/Hot` 的字段名去读搜索结果，会得到 `undefined`：
> 排序变成 `NaN`（等于没排序）、作者显示成"匿名"、日期空白。

### 2.2 版面列表 ✅ 已验证

```
GET https://api.cc98.org/Board/All
```

**响应：** JSON 数组，12 个版面分类。每个分类对象结构：

| 字段 | 类型 | 说明 | 已验证 |
|------|------|------|--------|
| `id` | number | 分类 ID | ✅ |
| `name` | string | 分类名称 | ✅ |
| `order` | number | 排序 | ✅ |
| `masters` | array | 管理员列表 | ✅ |
| `boards` | array | 子版面数组 | ✅ |

每个 `boards` 子项包含 `id`、`name` 等字段。

主要分类：置顶、学习、信息、兴趣、交易、情感、生活、教师答疑、院系交流、社团风采、天下一家、论坛管理。

---

## 3. 需认证端点

### 3.1 搜索帖子 ✅ 端点已确认（需 Token 验证返回结构）

```
GET https://api.cc98.org/Topic/Search?keyword={keyword}&boardId={boardId}&page={page}&size={size}
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `keyword` | string | 是 | 搜索关键词 |
| `boardId` | number | 否 | 版面 ID，0 表示全站搜索 |
| `page` | number | 否 | 页码，从 1 开始 |
| `size` | number | 否 | 每页条数 |
| `condition` | number | 否 | 搜索条件（推测：0=仅标题，1=标题+内容） |
| `authorId` | number | 否 | 按作者筛选 |

**已确认行为：**
- 无 Token 请求返回 **401 Unauthorized**
- 带 Token 请求返回 200（需真实 Token 验证返回结构）

**预期响应：** JSON 数组，结构同 2.1 中的帖子对象。

### 3.2 帖子详情 ✅ 端点已确认（需 Token 验证返回结构）

```
GET https://api.cc98.org/Topic/{topicId}
```

**已确认行为：**
- 无 Token 请求返回 **401 Unauthorized**
- 不存在的帖子返回 **404 Not Found** 或 **403 Forbidden**

**预期响应：** JSON 对象，包含帖子完整信息（id, title, boardId, boardName, content, authorName, createTime, replyCount, hitCount 等）。

### 3.3 帖子楼层/回复 ✅ 端点已确认（需 Token 验证返回结构）

```
GET https://api.cc98.org/Topic/{topicId}/Post?from={from}&size={size}
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `from` | number | 否 | 起始楼层，从 1 开始 |
| `size` | number | 否 | 每页条数 |

**已确认行为：**
- 带 Token 请求返回 **401**（未验证带 Token 的情况）

**预期响应：** JSON 数组，每项为一条楼层/回复。

**UBB 内容中的附件占位符：**

帖子的 `content` 字段为 UBB 格式，附件以占位符形式嵌入：

```
[upload={fileId},type={mimeType}]{filename}[/upload]
```

示例：
```
[upload=12345,type=application/pdf]数据结构期末复习.pdf[/upload]
```

> ⚠️ 占位符具体格式需通过真实 Token 从帖子内容中确认。已实现的解析器支持以下变体：
> - `[upload=12345,type=application/pdf]file.pdf[/upload]`（带 type）
> - `[upload=12345]file.pdf[/upload]`（无 type）
> - `[file=12345]file.pdf[/file]`（file 标签）

### 3.4 当前用户信息 ✅ 端点已确认

```
GET https://api.cc98.org/Me
```

**已确认行为：** 无 Token 返回 **401 Unauthorized**

---

## 4. 附件下载 ⚠️ 待验证

### 4.1 附件 URL 格式

基于 UBB 占位符解析，附件 URL 推测为：

```
https://file.cc98.org/file/{fileId}/{filename}
```

> ⚠️ 此格式需通过真实 Token 验证。可能的变体：
> - `https://file.cc98.org/{fileId}/{filename}`
> - `https://file.cc98.org/file/{fileId}`
> - 通过 API 端点下载：`https://api.cc98.org/File/{fileId}`

### 4.2 鉴权方式

附件下载的鉴权方式需验证，可能的情况：

| 方式 | 说明 |
|------|------|
| 无需鉴权 | 附件 URL 可直接访问 |
| Bearer Token | 请求时带 `Authorization: Bearer {token}` Header |
| Cookie | 需要 CC98 登录后的 Cookie |
| Referer 检查 | 需要 `Referer: https://www.cc98.org` |

### 4.3 权限限制

以下情况可能无法下载附件：
- **回复可见：** 帖子设置为"回复后可见附件"，用户未回复
- **积分限制：** 需要达到一定积分才能下载
- **付费附件：** 需要使用论坛货币购买
- **版面权限：** 用户无权访问该版面

---

## 5. OpenID Connect 认证 ✅ 已验证

### 5.1 配置端点

```
GET https://openid.cc98.org/.well-known/openid-configuration
```

### 5.2 关键端点

| 端点 | URL |
|------|-----|
| Authorization | `https://openid.cc98.org/connect/authorize` |
| Token | `https://openid.cc98.org/connect/token` |
| End Session | `https://openid.cc98.org/connect/endsession` |
| Check Session | `https://openid.cc98.org/connect/checksession` |
| JWKS | `https://openid.cc98.org/.well-known/openid-configuration/jwks` |

### 5.3 支持的 Grant Types

- `authorization_code` — 推荐用于浏览器插件增强版
- `refresh_token` — 用于 token 刷新
- `password` — ROPC 流程（不推荐用于前端）
- `client_credentials`
- `implicit`
- `urn:ietf:params:oauth:grant-type:device_code`
- `urn:openid:params:grant-type:ciba`

### 5.4 相关 Scopes

| Scope | 说明 |
|-------|------|
| `openid` | OpenID Connect 基础 scope |
| `profile` | 用户基本资料 |
| `profile.forum` | 论坛相关资料 |
| `cc98-api` | CC98 API 访问 |
| `cc98-api.get-content-check-data` | 内容检查数据 |
| `cc98-api.manage-cache` | 缓存管理 |
| `read-public-post` | 读取公开帖子 |
| `read-private-post` | 读取私密帖子 |
| `read-message` | 读取消息 |
| `file-upload` | 文件上传 |
| `write-post` | 发帖（本项目不使用） |
| `write-message` | 发消息（本项目不使用） |

### 5.5 Token Endpoint Auth Methods

- `client_secret_basic`
- `client_secret_post`

---

## 6. 错误码

| HTTP 状态码 | 含义 | 处理方式 |
|-------------|------|----------|
| 200 | 成功 | 正常处理 |
| 400 | 请求参数错误 | 检查请求参数 |
| 401 | 未认证 / Token 过期 | 提示用户重新设置 Token |
| 403 | 权限不足 | 提示用户无权访问 |
| 404 | 资源不存在 | 提示帖子或附件不存在 |
| 405 | 方法不允许 | 检查 HTTP 方法 |
| 429 | 请求过于频繁 | 降低频率，等待后重试 |
| 500 | 服务器错误 | 提示服务暂时不可用 |

---

## 7. 频率控制

- 搜索请求间隔：≥ 500ms
- 帖子内容请求间隔：≥ 500ms
- 附件下载间隔：≥ 1000ms
- 不做全站爬取，单次搜索限制在合理分页范围（如 ≤ 3 页）

---

## 8. 验证清单

运行 `scripts/api-verify.mjs --token <your_token>` 后，在此补充验证结果：

- [x] 搜索端点存在（`/Topic/Search`，无 Token 返回 401）
- [x] 帖子详情端点存在（`/Topic/{id}`，无 Token 返回 401）
- [x] 楼层端点存在（`/Topic/{id}/Post`，无 Token 返回 401）
- [x] `/Me` 端点存在（无 Token 返回 401）
- [x] 热门帖子端点正常（`/Topic/Hot` 返回 200 + 10 条数据）
- [x] 版面列表端点正常（`/Board/All` 返回 200 + 12 分类）
- [x] OpenID 配置正常
- [ ] ~~搜索返回结构~~ → 需真实 Token 验证
- [ ] ~~帖子详情返回字段~~ → 需真实 Token 验证
- [ ] ~~楼层内容返回字段~~ → 需真实 Token 验证
- [ ] ~~UBB 附件占位符格式~~ → 需真实 Token 验证
- [ ] ~~附件 URL 格式~~ → 需真实 Token 验证
- [ ] ~~附件鉴权方式~~ → 需真实 Token 验证
- [ ] ~~分页参数命名~~ → 需真实 Token 验证
- [ ] ~~频率限制阈值~~ → 需真实 Token 验证
