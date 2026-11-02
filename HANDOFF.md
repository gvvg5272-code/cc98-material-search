# CC98 科目资料检索浏览器插件 — 交接文档

> 生成时间：2026-11-01（第一版）
> 修订：2026-11-01 第二轮 —— 修掉 5 个真 bug，并把项目复制到当前工作区
> **当前工作副本（以这份为准）**：`F:\03-项目竞赛\deepsek harness\cc98-material-search`
> 原项目：`C:\Users\23952\.zcode\workspace\default\cc98-material-search`（两份可能已分叉）

---

## 〇、第二轮修掉的 5 个真 bug

第一版的状态是"10 项测试全绿"，但**测试全绿不等于代码正确**。下面 5 个问题全都活在
"测试通过"的状态里——因为当时的用例只碰了网络契约和 UBB 正则，没碰错误路径、
没碰并发初始化、没碰 HTML 注入。

| # | 位置 | 症状 | 根因 | 守护它的测试 |
|---|---|---|---|---|
| 1 | `lib/cc98-api.js` `_handleError` | 网关返回 502 的 HTML 页面时，报 `TypeError: body used already`，真实状态码和响应体全丢 | 先 `res.json()`；它因响应不是 JSON 而失败时 **body 已经被消费**，再 `res.text()` 必然抛 | 「对照：先 json() 再 text() 确实会抛 TypeError」+「非 JSON 的 502 页面 → 可读 ApiError」 |
| 2 | `lib/search.js` `search` | Token 过期时，界面显示"未找到相关帖子" | 所有异常一律 `console.warn` + `break`，认证错误被静默吞掉，上层拿到空结果 | 「TokenExpiredError 必须原样上抛」 |
| 3 | `popup/popup.js` `escapeHtml` | 帖子标题里一个双引号就能闭合 `title="…"` 属性，注入任意标签 | 把文本塞进 `div.textContent` 再读 `innerHTML`——这种写法**只转义 `& < >`，不转义引号** | 「双引号必须被转义（属性注入）」 |
| 4 | `lib/download-queue.js` `_downloadFile` | 下载已经提交给浏览器、只是等待超时，却又走一遍降级分支 → **同一个附件下两遍**；失败路径还不 `revokeObjectURL`，blob 永久泄漏 | catch 里无条件降级；`revoke` 只写在成功路径 | 「下载已启动后失败 → 只启动一次，不降级重下」 |
| 5 | `background/service-worker.js` | SW 刚唤醒就收到消息时，`downloadQueue` 还是 `null`，入队/暂停/查状态直接 TypeError | `initialize()` 是异步的却被裸调用，消息处理没有等它 | **无测试**（需要 chrome 运行时，本文件未覆盖）——见下方"已知缺口" |
| 6 | `lib/download-queue.js` + `background/service-worker.js` 下载路径 | **整条下载链路一进浏览器就废**：`TypeError: URL.createObjectURL is not a function` | **MV3 的 Service Worker 全局作用域里没有 `URL.createObjectURL`**（那是 Window 的能力）。原实现走 `fetch → blob → createObjectURL → downloads`，第一步就炸 | 「直接下载：只调一次，URL 原样传，不创建 blob」——测试里把 `createObjectURL` 替成"一调用就抛错的假件"，正是 SW 里的真实行为 |

> 第 6 条是**离线测试完全测不到**的那一类：Node 里 `URL.createObjectURL` 是存在的，
> 老测试还给它打了假件，所以 28 条测试全绿也照样发现不了。修法顺便把设计简化了——
> 实测 `file.cc98.org` 的文件公开可下、不需要 `Authorization`，那就根本不用先 fetch 一遍，
> 直接把 URL 交给浏览器的下载器。省内存、少一次请求，还绕开了 SW 的限制。

> 同一个改动还顺手修了一个真机上必踩的坑：附件名来自 URL，可能含 `/` `:` `?`
> （`%2F` 解码就是 `/`），`chrome.downloads.download` 遇到非法文件名会直接失败。
> 现在统一过 `lib/sanitize.js::sanitizeFilename()`（剥路径、替换非法字符、处理 Windows 保留名、超长截断）。

### 🔴 第七、第八个 bug：附件永远解析不出来（用户实测反馈）

现象：**明明有附件的帖子，点「查看附件」却说没有**。

用 `scripts/dump-topic.mjs` 解剖真实帖子 `topic/6651651`（「高级数据结构与算法分析 讲义分享」）
后，根因是两条**叠加**的：

| # | 根因 | 证据 | 修法 |
|---|---|---|---|
| 7 | **`/Topic/{id}/Post` 的 `from` 是 0 基的**，代码写死 `from: 1` → **永远跳过 floor 1（楼主）**，而附件几乎都在楼主那层 | `from=0` → 楼层 `[1,2,3]`；`from=1` → `[2,3,4]`。该帖 `replyCount=103`，我们只拿到 103 层（2~104），楼主整层丢失 | `getPosts` 默认 `from: 0`；`service-worker` 的翻页起点改 0，页数上限提到 10（200 楼） |
| 8 | **正文是 Markdown，不是 UBB**；附件写法是 `[显示名](https://file.cc98.org/...)` | 楼主正文里是 `### 下载文件` 和 12 条 `[lec00-课程简介](https://file.cc98.org/v4-upload/d/2026/1008/wsyx4tyq.pdf)` | 先按 `[文本](URL)` 切 Markdown 链接（裸 URL 正则会把结尾的 `)` 吃进去），并**用显示名当文件名**；只认 `file.cc98.org`（否则 GitHub/知乎外链也会被当成附件） |

复验：`node scripts/check-attachments.mjs --token <t> --topic 6651651`
→ **取到 104 层（1~104，含楼主 ✅），解析到 12 个 PDF**，文件名是「lec00-课程简介.pdf」这种可读形式。

> 这条教训值得记：前 6 个 bug 靠读代码 + 真实 API 就能发现，
> 第 7、8 条**只有真的去点一次「查看附件」才会暴露**。
> 而 `dump-topic.mjs` 这种"把原始数据原样倒出来、不做任何解析"的工具，
> 是定位这类问题的唯一有效手段——比继续猜格式快得多。

### 🟢 免手动复制 Token（2026-11-01 第三轮）

Token 本来就存在 CC98 页面的 `localStorage.accessToken` 里，而插件已有
`https://www.cc98.org/*` 的 host 权限，所以可以直接读回来：

- `manifest.json` 增加 `scripting` 权限；
- `popup.js::syncTokenFromCc98Tab()` 用 `chrome.scripting.executeScript`
  在已登录的 CC98 标签页里执行 `localStorage.getItem("accessToken")`，
  再走 `normalizeToken()` 归一化后保存；
- **打开插件时自动静默同步**（`trySilentTokenSync()`），但只在本机
  "没有 Token 或已过期"时才做，不会覆盖用户手动粘贴的有效 Token；
- 设置页另有一个「从 CC98 页面同步」按钮，可手动触发。

限制：必须有**开着的 CC98 标签页**且已登录；没有时回退到手动粘贴。
（真正零接触要等 refresh_token 自动续期，见待办。）

### 🤖 AI 总结（2026-11-01 第四轮）

**产品意义**：在这之前，这个插件只是"搜索 + 列链接"，和 CC98 自带搜索没有本质区别。
AI 层要解决的是**原站搜索永远做不到**的事：区分「分享贴」和「求资料贴」——标题都含"讲义"，
一半是求、一半是给，关键词搜索完全无解，必须读正文。

**新增文件**：`lib/ai.js`（纯函数 + 调用层），其余改动都在 SW / popup / manifest。

**四个设计约束**：
1. **OpenAI 兼容**：只认 `{baseURL}/v1/chat/completions`，DeepSeek / OpenAI / Moonshot /
   本地 Ollama 都能用，不写死任何一家；`buildEndpoint()` 兼容各种 baseURL 写法。
2. **key 只存本机**：`chrome.storage.local` 的 `cc98_ai_config`，不写进代码、不进日志；
   设置页留空表示"不修改已有 key"，避免用脱敏值覆盖真实值。
3. **AI 挂了不能变废功能**：`localScore()` 提供可解释的本地打分（附件数/收藏/回复/作者风评值），
   没配 key 或调用失败自动退回它，并在卡片上说明原因。
4. **省 token**：正文截断 6000 字、只取点赞最高的 5 条回复（各 300 字）、附件名全量。
   实测 `topic/6651651` 的 prompt 只有 3005 字符（约 2k tokens）。

**权限处理**：自定义接口地址走 `optional_host_permissions: ["https://*/*"]`，
保存时用 `chrome.permissions.request()` 在用户点击手势里按 origin 申请，不预先要一揽子权限。

**交互**：搜索结果每条有「🤖 总结」按钮 → SW 拉取帖子 + 全部楼层 + 作者资料 →
输出 `{kind 分享/求资料/讨论/其他, worth 1-5, oneLine, has[], missing, advice}`，
渲染成卡片并附本地分。设置页有「测试连接」（`AI_PING`，20 token 探活）。

**真实数据复验**（`topic/6651651`，不配 key 走本地兜底）：
104 层、12 个附件、作者 `yhwis` 风评值 64 / 获赞 3599 / 粉丝 210 → **本地分 80/100**，
依据逐条列出（附件 +40、收藏 434 次 +15、回复 103 +10、作者声誉 +15）。

**已知取舍**：
- `topic.boardName` 在 `/Topic/{id}` 里没有，prompt 里版面显示的是 `boardId`（无害）。
- `topic.likeCount` 实测常年为 0，真正有区分度的是 `favoriteCount`——`localScore` 已经按这个调过权重。

### 🔎 自动分拣（2026-11-01 第五轮）

用户的原话："最好不是说我手动探测，是他能够先主动排除掉一些没有实际资料的帖子再进行价值排序。"

**产品定位**：这一步才真正和 CC98 自带搜索拉开差距——搜索框只能按关键词给结果，
而**大部分结果根本不是资料**。实测 `关键词=数据结构` 的 10 条结果里，**只有 1 条真有资料**
（其余是出书、求书、讨论、求拉群）。

**两级成本设计**（关键，否则会把接口打爆）：

| 级别 | 请求数 | 做什么 |
|---|---|---|
| 第一级 | 1 次/帖（`from=0&size=1` 只取楼主） | 抽附件、判断像不像"求资料" |
| 第二级 | 仅当有附件时 +2 次 | `/Topic/{id}` 拿收藏/精华 + `/user/{id}` 拿作者风评值，算完整分 |

**新增**：`lib/triage.js`（纯函数：`looksLikeSeeking` / `rankTriage` / `triageBadge`）、
SW 的 `TRIAGE_TOPIC`、popup 的自动扫描循环 + 「只看有资料的」开关。

**交互**：搜索后**自动**逐条扫描（进度可见 `正在自动筛选 3/20`），结果显示
`📎 12 · 80 分` / `求资料` / `无附件` 标签；扫完按 **有附件 > 分数 > 回复数** 重排，
并折叠无资料的结果。若一条都没资料，**自动取消勾选**并说明，避免用户面对空列表。

**求资料识别**：标题和正文都看。求帖正文经常只有"如题"两个字，只看正文会漏——
所以"标题以「求」开头"直接定性（有附件时例外）。

**已知取舍**：
- 自动扫描上限 30 条（`MAX_TRIAGE`），避免一次搜索打出上百请求。
- 分拣是**本地规则**，不消耗 AI token；AI 只在用户点「🤖 总结」时才调用。

### 🔧 第六轮：用户实测「电工电子学」暴露的三个问题

用户反馈：搜「电工电子学」只筛出一条实验报告，想要的「小测/复习资料」根本不出现。
拿真实 Token 复现后，三个原因全部坐实：

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| 9 | **搜索只取了 1 页（20 条）** | 接口 `size` 上限就是 **20**（传 50 → `400 invalid_from_or_size`），想多要只能翻页；而当时为了避开限流把 `maxPages` 砍成 1 | `maxPages` 默认改 **3（60 条）**，UI 加「20/60/100 条」选择；别名 >2 个时自动降回每词 1 页，防请求爆炸 |
| 10 | **分拣只扫 floor 1** | 「sallerina 的大二秋冬资源楼」这种帖子，资料在 2、3 楼，被误判"无附件"直接折叠 | 分拣改成一次取 **前 20 层**（`size=20`，仍是 1 次请求），用 `collectAttachmentsFromPosts` 扫**全部楼层** |
| 11 | **卖书帖/求书帖没被识别**，把资源帖挤出视野 | 20 条结果里「长期三折出书…」「求一本电工电子学实验教程」等占了大半 | 新增 `lib/triage.js::classifyPostType()` 分四类：**卖书 / 求资料 / 资源 / 讨论**；资源楼排序最前，卖书帖单独标注 |

**顺带确认**：`condition=1`（标题+内容）与默认（仅标题）返回**完全一样**的 20 条——
说明这个参数在当前接口上可能并未生效，别指望它扩大召回。

**已知取舍**：
- 分拣扫前 20 层而不是全部楼层：资源楼的资料若在 21 楼以后仍会漏，但那是极少情况。
- 3 页 ≈ 3 次请求 × 3 秒，搜索会比之前慢约 6 秒（状态栏有提示）。

### 🐛 第七轮：「只看有资料的」开关形同虚设

用户反馈：勾了「只看有资料的」，结果里有资料的和没资料的还是混在一起。

**根因是两个 bug 叠加**：

1. **`visibleResults()` 用了全局开关**：写成 `if (!list.every(t => t._triage)) return list;`。
   只要有一条没被扫描到，`every()` 就是 `false` → 直接返回**未过滤的完整列表**。
   这个 bug 的特点是**静默**——没有报错，只是开关没反应。
2. **扫描上限 30 条，而用户可选 60/100 条**：后 30 条永远没有 `_triage`，
   于是第 1 条 bug 必然被触发。两个 bug 互相放大。

**修法**：
- `MAX_TRIAGE` 30 → **120**（覆盖所有可选条数），扫描全部结果；
- 筛选逻辑抽成**纯函数** `lib/triage.js::filterWithMaterial()`，逐条判断：
  扫描失败（`_triageError`）→ 保留，不把"不知道"当"没有"；未扫描 → 保留；确认 0 附件 → 折叠。
- 扫描失败的条目显示灰色「扫描失败」标签，不再混进"无资料"被悄悄折叠。

**为什么这个 bug 之前没被测出来**：筛选逻辑长在 `popup.js` 里，而 popup 依赖 DOM，无法 import 测试。
抽成纯函数后补了 1 条回归（含"全都没扫到时必须保留"这条正是旧写法的失效场景）。

修法的共同点：**错误分类改成读结构，不再猜字符串**（`DownloadError` 带 `retryable` /
`allowFallback`，`_isRetryable` 直接读它）；**不允许"降级成没有错"**（搜索的错误记进
`errors` 字段交上层展示，认证错误一律上抛）。

### 顺带的结构改动：加 `package.json`

`lib/*.js` 是 ESM，但项目原先没有 `package.json`，Node 会按 CommonJS 解析 `.js`，
于是 `import` 直接报错——**测试根本 import 不了自己的源码**。

后果在第一版里已经发生了：`test/api-verify.test.mjs` 的 `parseAttachments` 是**手抄的一份实现**
（注释还写着"无法 import ESM"）。手抄的那份测的是"抄写对不对"，源码改了它照样绿。
现在已改成直接 import 真实模块。

加了 `"type": "module"` 之后测试才能 import 源码。**Chrome 不读 `package.json`，对插件无影响。**

### 怎么验证

```bash
cd "F:\03-项目竞赛\deepsek harness\cc98-material-search"
node test/regression.test.mjs      # 46 项，离线、不联网、可反复跑
node test/api-verify.test.mjs      # 10 项通过 + 4 项跳过（需 token 的自动跳过）
node scripts/api-verify.mjs --token <token>   # 三条真实链路验证
```

### 已知缺口（诚实清单）

- 上面第 5 条（Service Worker 初始化竞态）**没有回归测试**：它需要 `chrome.runtime` /
  `chrome.storage` 的完整假件，成本高于收益。改动本身是"先 await 再处理消息"，逻辑很薄。
- `chrome.downloads.download` 的真实行为（blob URL 能否下载、文件名是否被清洗）只能在
  浏览器里验，Node 测试用的是假件。

---

## 一、项目目的

浙江大学 CC98 论坛中，学习资料以帖子附件形式分散存在。本项目开发一个 Chrome/Edge Manifest V3 浏览器插件，让用户按科目关键词检索 CC98 相关帖子，查看帖子与附件信息，并下载用户有权限访问的附件。

### 核心约束（必须遵守）

1. **只读操作**：只做搜索、读帖、下载附件；不发帖、不回帖、不点赞
2. **不绕过权限**：不绕过登录、验证码、付费、回复可见、积分限制
3. **不硬编码密钥**：不在前端代码中写死 client_secret、token、API key
4. **控制频率**：搜索请求 ≥500ms 间隔，下载 ≥1000ms 间隔，不做全站爬取
5. **官方 API 优先**：调用 `api.cc98.org` REST API，不解析页面 DOM
6. **MVP 不依赖自建后端和 LLM API key**

---

## 二、项目架构

### 2.1 目录结构

```
cc98-material-search/
├── manifest.json                     # Manifest V3 配置
├── README.md                         # 项目说明
├── background/
│   └── service-worker.js             # Service Worker：API调用、下载队列、消息分发
├── popup/
│   ├── popup.html                    # Popup 三标签页 UI
│   ├── popup.css                    # 样式（420px 宽，CSS Variables）
│   └── popup.js                     # Popup 交互逻辑 + Token 自动处理
├── lib/
│   ├── cc98-api.js                  # CC98 API 封装层（频率控制锁、错误分类）
│   ├── auth.js                      # Token 存储管理（chrome.storage.local）
│   ├── search.js                    # 搜索服务（别名展开、聚合去重、排序）
│   ├── attachment.js                # UBB 附件解析（多种格式兼容）
│   └── download-queue.js            # 批量下载队列（重试、持久化、状态通知）
├── config/
│   └── subject-aliases.json         # 科目别名配置（30+ 科目映射）
├── content/
│   └── content-script.js            # Content Script（空壳预留）
├── scripts/
│   └── api-verify.mjs               # 接口验证脚本（三大链路验证）
├── test/
│   └── api-verify.test.mjs          # 测试用例（公共/认证/分页/错误/UBB解析）
├── docs/
│   ├── api-analysis.md              # CC98 接口分析文档（含前端源码分析发现）
│   ├── usage.md                     # 使用说明（含 Token 获取方法）
│   └── compliance.md                # 合规说明
└── icons/
    ├── icon16.png                    # 插件图标
    ├── icon48.png
    └── icon128.png
```

### 2.2 模块依赖关系

```
popup.js ──sendMessage──► service-worker.js
                                │
                                ├── auth.js (Token 存储/验证/脱敏)
                                ├── cc98-api.js (API请求封装 + 频率锁)
                                │       └── auth.js (getToken)
                                ├── search.js (别名展开 + 搜索聚合)
                                │       └── cc98-api.js
                                ├── attachment.js (UBB解析，纯函数，无依赖)
                                └── download-queue.js (批量下载队列)
                                        └── cc98-api.js
```

### 2.3 消息通信协议

Popup ↔ Service Worker 通过 `chrome.runtime.sendMessage` 通信，所有消息格式为 `{ type: string, ...data }`：

| 消息类型 | 方向 | 数据 | 返回 |
|----------|------|------|------|
| `SAVE_TOKEN` | Popup→SW | `{ token }` | `{ success }` |
| `CLEAR_TOKEN` | Popup→SW | — | `{ success }` |
| `GET_TOKEN_STATUS` | Popup→SW | — | `{ status, masked }` |
| `VALIDATE_TOKEN` | Popup→SW | — | `{ valid, user?, error? }` |
| `SEARCH` | Popup→SW | `{ keyword, options }` | `{ results, searchedKeywords, totalPages }` |
| `GET_TOPIC_DETAIL` | Popup→SW | `{ topicId }` | `{ topic, posts, attachments }` |
| `GET_BOARDS` | Popup→SW | — | 版面数组 |
| `GET_HOT_TOPICS` | Popup→SW | — | 热帖数组 |
| `DOWNLOAD_FILE` | Popup→SW | `{ attachment }` | `{ success?, error? }` |
| `ENQUEUE_DOWNLOAD` | Popup→SW | `{ attachment }` | `{ success, item? }` |
| `ENQUEUE_BATCH` | Popup→SW | `{ attachments }` | `{ success, count }` |
| `PAUSE_DOWNLOADS` | Popup→SW | — | `{ success }` |
| `RESUME_DOWNLOADS` | Popup→SW | — | `{ success }` |
| `RETRY_FAILED_DOWNLOADS` | Popup→SW | — | `{ success }` |
| `CLEAR_COMPLETED_DOWNLOADS` | Popup→SW | — | `{ success }` |
| `GET_DOWNLOAD_STATUS` | Popup→SW | — | `{ status, items }` |
| `GET_ALIAS_CONFIG` | Popup→SW | — | 别名配置对象 |
| `UPDATE_ALIAS_CONFIG` | Popup→SW | `{ config }` | `{ success }` |
| `EXPAND_ALIASES` | Popup→SW | `{ keyword }` | `{ aliases }` |
| `DOWNLOAD_STATUS_UPDATE` | SW→Popup | (广播) | — |

---

## 三、项目代码详解

### 3.1 manifest.json

- Manifest V3，`background.type = "module"` 支持 ES Module import
- 权限：`storage`（存 token/配置）、`downloads`（文件下载）、`alarms`（预留定时）
- host_permissions：`api.cc98.org`、`file.cc98.org`、`www.cc98.org`、`openid.cc98.org`
- 未声明 content_scripts（MVP 不需要）

### 3.2 lib/auth.js — Token 管理

```javascript
export class AuthManager {
  async saveToken(token)        // 存入 chrome.storage.local，key = "cc98_access_token"
  async getToken()              // 读取，返回 string|null
  async clearToken()            // 清除
  async getTokenStatus()        // 返回 'valid'|'expired'|'unknown'|'none'
  async setTokenStatus(status)  // 更新状态
  async getMaskedToken()        // 脱敏展示，如 "****1a2b"
  async validateToken()         // 调用 GET /Me 验证有效性
}
// 导出错误类：TokenExpiredError, NoTokenError
```

**关键设计**：token 存储不明文展示，验证调用 `/Me` 接口，401 时自动标记过期。

### 3.3 lib/cc98-api.js — API 封装

```javascript
export class CC98API {
  constructor(tokenGetter)              // tokenGetter = () => auth.getToken()
  async getHotTopics()                  // GET /Topic/Hot（公开）
  async getAllBoards()                  // GET /Board/All（公开）
  async searchTopics(keyword, options)  // GET /Topic/Search（需认证）
  async getTopic(topicId)              // GET /Topic/{id}（需认证）
  async getPosts(topicId, options)     // GET /Topic/{id}/Post（需认证）
  async getMe()                        // GET /Me（需认证）
  getAttachmentUrl(fileId, filename)   // 构造附件 URL
  async fetchAttachment(url, options)  // 下载附件（带 token）
}
// 导出错误类：ApiError, PermissionDeniedError, ResourceNotFoundError, RateLimitError
```

**频率控制**：使用 `_requestLock` 互斥锁序列化并发请求，确保请求间隔 ≥500ms。多个并发调用会依次等待，不会同时通过检查。

**错误分类**：401→TokenExpiredError，403→PermissionDeniedError，404→ResourceNotFoundError，429→RateLimitError。

### 3.4 lib/search.js — 搜索服务

```javascript
export class SearchService {
  constructor(api, aliasConfig)
  async search(keyword, options)       // 主搜索：展开别名→逐个搜索→聚合去重→排序
  expandAliases(keyword)               // 展开科目别名（含反向查找）
  filterByBoard(results, boardIds)     // 按版面筛选
  filterWithAttachments(results)       // 筛选有附件的帖子
}
```

**别名展开逻辑**：
1. 输入 "高数下" → 从配置查到 `["高等数学（二）", "微积分B", "高数下"]`
2. 反向查找：如果输入是某个别名的值，也加入主关键词
3. 所有别名逐个搜索（顺序执行，遵守频率限制）
4. 结果按帖子 ID 去重，按发帖时间降序排序

### 3.5 lib/attachment.js — UBB 附件解析

```javascript
export function parseAttachments(content)              // 解析 UBB 中的附件占位符
export function extractAttachmentsFromPost(post)       // 从帖子对象提取附件
export function collectAttachmentsFromPosts(posts)     // 从所有楼层收集附件（去重）
export function getAttachmentCategory(filename)        // 返回 { category, icon }
export function formatFileSize(bytes)                  // 格式化文件大小
```

**支持的 UBB 附件格式**：
- `[upload=12345,type=application/pdf]复习资料.pdf[/upload]` — 带 mimeType
- `[upload=12345]复习资料.pdf[/upload]` — 无 mimeType
- `[file=12345]复习资料.pdf[/file]` — file 标签

**附件 URL 构造**：`https://file.cc98.org/file/{fileId}/{filename}`（⚠️ 格式需用真实 Token 验证确认）

**正则表达式**：
```javascript
/\[upload=(\d+)(?:,type=([^\]]+))?\]([^\[]+)\[\/upload\]/gi
/\[file=(\d+)\]([^\[]+)\[\/file\]/gi
```

### 3.6 lib/download-queue.js — 批量下载队列

```javascript
export const DownloadStatus = { PENDING, DOWNLOADING, COMPLETED, FAILED, SKIPPED }
export class DownloadQueue {
  constructor(api)
  enqueue(attachment)         // 加入队列（自动去重）
  enqueueBatch(attachments)  // 批量加入
  processNext()              // 处理下一个（自动触发）
  pause() / resume()         // 暂停/恢复
  clearCompleted()           // 清除已完成和失败项
  retryFailed()              // 重试失败项
  getStatus()                // 返回 { pending, downloading, completed, failed, total }
  onStatusChange(listener)   // 注册状态变更监听
  _persist() / restore()     // 持久化到 chrome.storage.session / 恢复
}
```

**下载策略**：
1. 先用 `fetch(url, { Authorization: Bearer token })` 获取 blob
2. 用 `URL.createObjectURL(blob)` 创建临时 URL
3. 调用 `chrome.downloads.download({ url: blobUrl, filename })` 保存
4. 如果 fetch 失败（如附件可直连），fallback 到 `chrome.downloads.download({ url })`

**失败重试**：最多重试 1 次，仅对网络类错误重试。Token 过期/权限不足/附件不存在不重试。

**持久化**：队列状态存入 `chrome.storage.session`，Service Worker 被终止后可恢复。

### 3.7 background/service-worker.js — Service Worker

**职责**：初始化模块实例 → 监听 Popup 消息 → 分发到对应模块 → 返回结果

**初始化流程**：
1. 加载 `config/subject-aliases.json`（默认别名）
2. 合并用户自定义别名（`chrome.storage.local` 中的 `cc98_alias_config`）
3. 创建 SearchService 和 DownloadQueue 实例
4. 恢复下载队列状态
5. 注册下载状态变更广播

**getTopicDetail 逻辑**：获取帖子详情 → 分页读取楼层（最多 5 页）→ 从所有楼层收集附件 → 返回 `{ topic, posts, attachments }`

### 3.8 popup/popup.js — Popup 交互

**三标签页**：搜索 / 下载 / 设置

**Token 自动处理**（`lib/token.js` 的 `normalizeToken()`）：
- 真实值形如 `str-Bearer eyJ...`：4 字符随机前缀 + `Bearer ` + JWT，**两层包装**
- 归一化逻辑：反复剥掉「`Bearer ` 前缀」和「4 字符前缀（当剩余部分以 `eyJ`/`Bearer` 开头时）」，直到不再变化
- 认不出的值原样返回，不猜

**搜索流程**：输入关键词 → 展开别名提示 → 发送 SEARCH 消息 → 渲染结果列表 → 点击"查看附件"→ GET_TOPIC_DETAIL → 渲染附件列表 → 下载/入队

**版面列表**：`loadBoards()` 加载版面树，`addBoardOptions()` 递归处理子版面（支持缩进显示）

---

## 四、CC98 API 接口详情

### 4.1 已确认的端点

| 端点 | 认证 | 状态 | 说明 |
|------|------|------|------|
| `GET /Topic/Hot` | 公开 | ✅ 已验证 | 返回 10 条热门帖子 |
| `GET /Board/All` | 公开 | ✅ 已验证 | 返回 12 个版面分类 |
| `GET /Topic/Search?keyword=…&boardId=0&page=1&size=20` | 需 Token | ✅ 端点存在 | 无 Token 返回 401 |
| `GET /Topic/{id}` | 需 Token | ✅ 端点存在 | 无 Token 返回 401 |
| `GET /Topic/{id}/Post?from=1&size=10` | 需 Token | ✅ 端点存在 | 无 Token 返回 401 |
| `GET /Me` | 需 Token | ✅ 端点存在 | 无 Token 返回 401 |
| OpenID 配置 | 公开 | ✅ 已验证 | `openid.cc98.org/.well-known/openid-configuration` |

### 4.2 帖子对象字段（已从 /Topic/Hot 确认）

```json
{
  "id": 6680687,
  "title": "帖子标题",
  "boardId": 758,
  "boardName": "版面名",
  "participantCount": 214,
  "replyCount": 277,
  "hitCount": 21024,
  "authorName": "作者昵称",    // 匿名时为 null
  "authorUserId": -1,          // 匿名时为 -1
  "createTime": "2026-10-30T14:56:00",
  "type": 0,
  "isAnonymous": false,
  "hotTopicType": 1
}
```

### 4.3 版面对象字段（已从 /Board/All 确认）

```json
{
  "id": 1,
  "name": "分类名",
  "order": 0,
  "masters": [],
  "boards": [
    { "id": 81, "name": "版面名", ... }
  ]
}
```

### 4.4 OpenID 认证信息

| 项目 | 值 |
|------|-----|
| Token 端点 | `https://openid.cc98.org/connect/token` |
| 授权端点 | `https://openid.cc98.org/connect/authorize` |
| 支持的 Grant Types | authorization_code, refresh_token, password, client_credentials, implicit, device_code, ciba |
| Token Auth Methods | client_secret_basic, client_secret_post |
| 相关 Scopes | openid, profile, cc98-api, read-public-post, read-private-post, file-upload |

### 4.5 ✅ 原「待验证项」——已用真实 Token 全部确认（结论见第五节）

下表是**第一版当时的推测**，保留它是因为"推测 vs 实测"的对照本身有价值。
实际结论见「五、已完成 vs 待完成 → ✅ 曾经"待验证"的 6 项」。

| 当时的待验证项 | 当时的推测 | 实测结论 |
|----------|----------|------------|
| 搜索返回结构 | 同 /Topic/Hot 的帖子对象 | ❌ 不一样，见第五节 |
| 帖子详情字段 | id, title, content, authorName 等 | ❌ 是 `time`/`userName`，没有 `content` |
| 楼层内容字段 | id, content, authorName, floor 等 | ✅ 就是 `content` |
| UBB 附件占位符 | `[upload=id,type=mime]name[/upload]` | ❌ 105 楼里出现 0 次，基本废弃 |
| 附件 URL 格式 | `file.cc98.org/file/{fileId}/{filename}` | ❌ 已换代成 `/v4-upload/d/{年}/{月日}/{随机}.{ext}` |
| 附件鉴权方式 | Bearer Token in Authorization header | ✅ **不需要任何鉴权** |

### 4.6 CC98 前端源码分析发现

基于 CC98 前端 HTML（版本 3.5.0）分析：

- **localStorage 4 字符前缀**：值存储时加了 4 字符前缀，读取用 `.slice(4)` 去掉
  ```javascript
  localStorage.getItem("use-theme").slice(4)
  JSON.parse(localStorage.getItem("userInfo").slice(4))
  ```
  → 获取 access_token 时也需 `.slice(4)`

- **API 调用封装**：前端用 `Ua(url, options)` 函数，URL 为相对路径（如 `/topic/123`）
- **Authorization Header**：`(new Headers).append("Authorization", token)`，token 由 `xa()` 函数获取
- **附件渲染**：前端用 `upload` 标签处理 UBB 中的 `[upload=...]...[/upload]`
- **版本管理**：localStorage 中 `version` 键存 `"3.5.0"`，版本不匹配时清空 localStorage

---

## 五、已完成 vs 待完成

### ✅ 已完成

| 项目 | 状态 |
|------|------|
| 项目目录结构 | ✅ 30 个文件（第二轮新增 `lib/sanitize.js`、`lib/token.js`、`package.json`、`.gitignore`、`test/regression.test.mjs`、`scripts/probe-attachments.mjs`、`scripts/dump-topic.mjs`、`scripts/check-attachments.mjs`） |
| manifest.json (MV3) | ✅ 8 项合规检查全通过 |
| lib/auth.js Token 管理 | ✅ 存储/验证/脱敏/过期处理 |
| lib/cc98-api.js API 封装 | ✅ 频率控制锁/错误分类/6 个端点（第二轮修错误体消费、403 文案、size 上限） |
| lib/search.js 搜索服务 | ✅ 别名展开/聚合去重/排序（第二轮修认证错误被吞、排序字段、限流间隔） |
| lib/attachment.js 附件解析 | ✅ **已按真实数据重写**：v4 直链抽取为主，UBB 占位符降为遗留兼容 |
| lib/download-queue.js 下载队列 | ✅ 批量/暂停/重试/持久化/状态通知（第二轮修重复下载 + blob 泄漏） |
| lib/sanitize.js | ✅ 新增：属性安全的 HTML 转义 |
| lib/token.js | ✅ 新增：真实 Token 形态（`str-Bearer eyJ...` 两层包装）的归一化 |
| background/service-worker.js | ✅ 消息分发/初始化/广播（第二轮修初始化竞态） |
| popup/ 三件套 | ✅ 三标签页/Token自动处理/版面递归（第二轮修属性注入、字段名、Token 归一化） |
| config/subject-aliases.json | ✅ 30+ 科目别名映射 |
| scripts/api-verify.mjs | ✅ 三大链路验证（**已用真实 Token 跑通**） |
| scripts/probe-attachments.mjs | ✅ 新增：从真实帖子扫附件格式的探针 |
| test/api-verify.test.mjs | ✅ 10 项通过（已改为 import 真实模块，不再手抄解析器） |
| test/regression.test.mjs | ✅ **新增 46 项离线回归** |
| docs/ 三份文档 | ✅ 接口分析/使用说明/合规说明 |
| 安全检查 | ✅ 无硬编码密钥/无 client_secret |
| 语法检查 | ✅ 所有 `.js`/`.mjs` `node --check` 通过 |

### ✅ 曾经"待验证"的 6 项，现已用真实 Token 全部确认

2026-11-01 用真实 Token 跑了 `scripts/api-verify.mjs` 和 `scripts/probe-attachments.mjs`
（24 帖 / 105 楼），第一版里所有"推测"项现在都有结论：

| 项目 | 第一版推测 | **实测结论** |
|------|-----------|-------------|
| 搜索返回结构 | "同 /Topic/Hot 的帖子对象" | ❌ **不一样**。搜索给 `time`/`userName`/`userId`，`/Topic/Hot` 给 `createTime`/`authorName`/`authorUserId`。代码原来只读后者 → 排序全是 `NaN`（等于没排）、作者全显示"匿名"、日期空白 |
| 帖子详情字段 | id/title/content/authorName | ❌ 同样是 `time`/`userName`；有 `userInfo`、`tag1/tag2`、`mediaContent` 等，**没有 `content`** |
| 楼层内容字段 | 需确认 content 字段名 | ✅ 就是 `content`。另有 `floor`/`time`/`isLZ`/`isAnonymous`/`likeCount` |
| UBB 附件占位符 | `[upload=id,type=mime]name[/upload]` | ❌ **基本已废弃**：105 楼里 `[upload=...]`/`[file=...]` 出现 **0 次** |
| 附件 URL 格式 | `file.cc98.org/file/{id}/{name}` | ❌ **已换代**：真实是 `https://file.cc98.org/v4-upload/d/{yyyy}/{MMdd}/{随机}.{ext}`，正文里以 `[img]…[/img]` 或裸链接出现，**没有数字 fileId** |
| 附件鉴权方式 | Bearer Token / Cookie / Referer 待试 | ✅ **完全不需要鉴权**：同一 URL 无 Token 与带 Token 都返回 `200`、同样的 `Content-Type` 和 `Content-Length` |

### 顺带测出来的三个硬约束（会影响使用体验）

1. **搜索限流很严**：间隔 600ms 连发 8 次，从第 2 次起一直 **403**；间隔 3 秒才稳定可用。
   所以 `search.js` 默认只取 1 页、每次请求之间强制等 2.5 秒。
   副作用：别名多的科目（如"高数下"有 4 个别名）一次搜索要 7~8 秒。
2. **楼层接口 `size` 上限是 20**：传 50 直接 `400`。`getPosts` 里已做 clamp。
3. **403 是二义的**：搜索时它可能是"搜太快"，也可能是"权限不足"，响应体区分不出来。
   所以错误文案改成"权限不足或请求过于频繁"，两种可能都保留。

### ⚠️ 仍然待完成

| 项目 | 说明 |
|------|------|
| 浏览器实际加载测试 | 需在 Chrome/Edge 中加载插件端到端测试（离线测试覆盖不到 `chrome.*` 真实行为） |
| 文档/图片类附件的下载实测 | 只实测过 `.webp` 图片的公开可下；若真有 `.pdf` 直链，行为应一致但**未直接验证** |
| 正式图标 | 当前为程序生成的占位图标，需替换设计稿 |
| Content Script | 空壳预留，MVP 不需要 |
| 增强版：OpenID 授权码流程 | 用 `chrome.identity.launchWebAuthFlow` 自动获取 Token |
| 增强版：WebVPN 支持 | 校外无 IPv6 时的访问方案 |
| 增强版：AI 语义匹配 | 如需加入，API key 必须放后端 |

---

## 六、运行与验证

### 运行接口验证（最关键的第一步）

```bash
cd "F:\03-项目竞赛\deepsek harness\cc98-material-search"

# 无 Token（只测公共端点）
node scripts/api-verify.mjs

# 有 Token（完整验证三大链路）
node scripts/api-verify.mjs --token <your_token> --keyword "数据结构"
```

### 运行测试

```bash
# 离线回归（46 项，不联网，先跑这个）
node test/regression.test.mjs

# 真实网络测试（无 Token 时自动跳过需要认证的用例）
node test/api-verify.test.mjs

# 有 Token（完整测试）
node test/api-verify.test.mjs --token <your_token>
```

### 获取 Token

在 CC98 登录后，`Ctrl + Shift + J` 打开 Console 执行：

```javascript
localStorage.getItem('accessToken')
```

复制输出的**整串值**粘进插件即可。两个实测坑：
- 键名是 `accessToken`（驼峰），写 `access_token` 会拿到 `null`；
- 值是 `str-Bearer eyJ...`（4 字符前缀 + `Bearer ` + JWT），不是裸 JWT，
  `lib/token.js` 的 `normalizeToken()` 会负责剥干净。

### 加载插件

Chrome: `chrome://extensions/` → 开发者模式 → 加载已解压扩展程序 → 选择 `cc98-material-search` 目录
Edge: `edge://extensions/` → 开发人员模式 → 加载扩展 → 同上

---

## 七、注意事项与风险点

1. **附件 URL 格式未确认**：当前 `file.cc98.org/file/{fileId}/{filename}` 为推测，验证后可能需修改 `lib/attachment.js` 的 `buildFileUrl` 函数
2. **UBB 占位符格式未确认**：当前正则支持 3 种变体，但从真实帖子中可能发现新格式
3. **Service Worker 生命周期**：MV3 的 Service Worker 会被浏览器终止，下载队列状态通过 `chrome.storage.session` 持久化，但长时间下载可能中断
4. **Token 有效期**：CC98 access token 有效期较短（通常数小时），无 refresh token 自动刷新（MVP）
5. **频率限制阈值未知**：500ms 间隔为保守估计，CC98 可能有更严格的风控
6. **校园网限制**：`api.cc98.org` 和 `file.cc98.org` 可能仅校园网可访问
