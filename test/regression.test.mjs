/**
 * 离线回归测试
 *
 * 与 api-verify.test.mjs 的分工：
 * - api-verify.test.mjs 打真实网络，验证"接口契约是否和推断一致"；
 * - 本文件**不联网**，验证"我们自己写的逻辑对不对"，可以在任何环境反复跑。
 *
 * 用法：node test/regression.test.mjs
 *
 * 每个修过的 bug 都有一条对应断言，防止改回去。
 */

import { CC98API, ApiError } from "../lib/cc98-api.js";
import { SearchService } from "../lib/search.js";
import { escapeHtml, sanitizeFilename } from "../lib/sanitize.js";
import { normalizeToken } from "../lib/token.js";
import { DownloadQueue, DownloadError } from "../lib/download-queue.js";
import { parseAttachments, extractFileUrls } from "../lib/attachment.js";
import {
  buildEndpoint,
  parseAiJson,
  normalizeSummary,
  localScore,
  buildTopicMessages,
} from "../lib/ai.js";
import { looksLikeSeeking, rankTriage, triageBadge, classifyPostType, filterWithMaterial } from "../lib/triage.js";

// ── 迷你测试框架 ──────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "断言失败");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "不相等"}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// ── 1. 错误响应体只能消费一次（cc98-api.js） ──────────────

async function testErrorBodyConsumption() {
  console.log("\n🔴 错误处理：响应体不能被消费两次");

  const api = new CC98API(async () => "dummy-token");

  // 对照测试：证明下面那条断言不是空转 —— 旧写法真的会把状态码埋成 TypeError
  await test("对照：先 json() 再 text() 确实会抛 TypeError", async () => {
    const res = new Response("<html>502 Bad Gateway</html>", { status: 502 });
    let outcome = "none";
    try {
      await res.json();
    } catch {
      try {
        await res.text();
        outcome = "text-ok";
      } catch (e2) {
        outcome = e2.name;
      }
    }
    assertEqual(outcome, "TypeError", "旧写法应当抛出 TypeError（body used already）");
  });

  await test("非 JSON 的 502 页面 → 可读 ApiError，且带上响应体内容", async () => {
    const res = new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
    let err = null;
    try {
      await api._handleError(res, "/Topic/Search");
    } catch (e) {
      err = e;
    }
    assert(err instanceof ApiError, `应当抛 ApiError，实际 ${err && err.name}`);
    assertEqual(err.status, 502, "状态码");
    assert(/HTTP 502/.test(err.message), `错误信息应含状态码：${err.message}`);
    assert(err.message.includes("502 Bad Gateway"), `错误信息应带上响应体：${err.message}`);
    assert(!/body used/i.test(err.message), "不应暴露 body used 这类底层异常");
  });

  await test("JSON 错误体 → 解析成对象并压进消息", async () => {
    const res = new Response(JSON.stringify({ message: "参数 keyword 不能为空" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    let err = null;
    try {
      await api._handleError(res, "/Topic/Search");
    } catch (e) {
      err = e;
    }
    assertEqual(err.status, 400, "状态码");
    assert(err.message.includes("参数 keyword 不能为空"), `应带出服务端原因：${err.message}`);
  });

  await test("401 仍然映射为 TokenExpiredError", async () => {
    const res = new Response("", { status: 401 });
    let err = null;
    try {
      await api._handleError(res, "/Me");
    } catch (e) {
      err = e;
    }
    assertEqual(err.name, "TokenExpiredError", "401 应映射为 TokenExpiredError");
  });

  await test("getPosts 默认从 from=0 开始（否则漏掉楼主那层）", async () => {
    const urls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async url => {
      urls.push(String(url));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const a = new CC98API(async () => "tok");
      await a.getPosts(123);
      assert(urls.length === 1, "应当只发一次请求");
      assert(urls[0].includes("from=0"), `应请求 from=0，实际是 ${urls[0]}`);
      assert(urls[0].includes("size=20"), "默认 size 应为 20");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

// ── 2. 搜索不能吞掉认证错误（search.js） ─────────────────

async function testSearchErrorPropagation() {
  console.log("\n🔴 搜索：认证错误不能被降级成「没搜到」");

  const authErrorApi = {
    async searchTopics() {
      const e = new Error("Token 已过期，请重新设置");
      e.name = "TokenExpiredError";
      throw e;
    },
  };

  await test("TokenExpiredError 必须原样上抛", async () => {
    const svc = new SearchService(authErrorApi, {});
    let caught = null;
    try {
      await svc.search("数据结构");
    } catch (e) {
      caught = e;
    }
    assert(caught, "应当抛出异常，而不是返回空结果");
    assertEqual(caught.name, "TokenExpiredError", "应当保留原始错误类型");
  });

  await test("普通错误不假装成功，记进 errors", async () => {
    const svc = new SearchService(
      { async searchTopics() { throw new Error("网络抖动"); } },
      {}
    );
    const r = await svc.search("数据结构", { gapMs: 0 });
    assertEqual(r.results.length, 0, "结果应为空");
    assertEqual(r.errors.length, 1, "应当记录一条错误");
    assertEqual(r.errors[0].message, "网络抖动", "错误信息");
  });

  await test("默认翻 3 页（只取 1 页会漏掉真正的资料帖）", async () => {
    const calls = [];
    const svc = new SearchService(
      {
        async searchTopics(kw, opts) {
          calls.push(opts.page);
          return Array.from({ length: 20 }, (_, i) => ({
            id: (opts.page - 1) * 20 + i,
            time: "2026-10-01T00:00:00+08:00",
          }));
        },
      },
      {}
    );
    const r = await svc.search("电工电子学", { gapMs: 0 });
    assertEqual(calls.length, 3, `应翻 3 页，实际 ${calls.length}`);
    assertEqual(r.results.length, 60, "应收齐 60 条");
  });

  await test("别名很多时自动降到每词 1 页，避免请求爆炸", async () => {
    const calls = [];
    const svc = new SearchService(
      {
        async searchTopics(kw, opts) {
          calls.push(`${kw}#${opts.page}`);
          return Array.from({ length: 20 }, (_, i) => ({ id: `${kw}${opts.page}${i}` }));
        },
      },
      { 高数下: ["高等数学（二）", "微积分B"] }
    );
    await svc.search("高数下", { gapMs: 0 });
    // 3 个别名 × 1 页 = 3 次
    assertEqual(calls.length, 3, `应为 3 次请求，实际 ${calls.length}：${calls.join(",")}`);
  });

  await test("按 time 字段倒序排序（真实接口给的是 time，不是 createTime）", async () => {
    const svc = new SearchService(
      {
        async searchTopics() {
          return [
            { id: 1, title: "旧", time: "2026-10-01T00:00:00+08:00" },
            { id: 2, title: "新", time: "2026-10-05T00:00:00+08:00" },
            { id: 3, title: "中", time: "2026-10-03T00:00:00+08:00" },
          ];
        },
      },
      {}
    );
    const r = await svc.search("任意", { gapMs: 0 });
    assertEqual(r.results.map(t => t.id).join(","), "2,3,1", "应当按时间倒序");
  });

  await test("别名展开：正向 + 反向 + 去重", async () => {
    const svc = new SearchService(
      { async searchTopics() { return []; } },
      { 高数下: ["高等数学（二）", "高数下"] }
    );

    const forward = svc.expandAliases("高数下");
    assert(forward.includes("高等数学（二）"), "正向查找应展开别名");
    assertEqual(new Set(forward).size, forward.length, "别名不应重复");

    const reverse = svc.expandAliases("高等数学（二）");
    assert(reverse.includes("高数下"), "反向查找应回到主关键词");
  });
}

// ── 3. HTML 转义必须处理引号（sanitize.js） ───────────────

async function testEscapeHtml() {
  console.log("\n🔴 HTML 转义：属性里的引号必须转义");

  await test("双引号必须被转义（属性注入）", async () => {
    assertEqual(escapeHtml('标题" onmouseover="alert(1)'), "标题&quot; onmouseover=&quot;alert(1)", "双引号");
  });

  await test("单引号 / 尖括号 / & 全部转义", async () => {
    assertEqual(escapeHtml("<script>"), "&lt;script&gt;", "尖括号");
    assertEqual(escapeHtml("a&b"), "a&amp;b", "&");
    assertEqual(escapeHtml("it's"), "it&#39;s", "单引号");
  });

  await test("null / undefined / 数字不炸", async () => {
    assertEqual(escapeHtml(null), "", "null");
    assertEqual(escapeHtml(undefined), "", "undefined");
    assertEqual(escapeHtml(0), "0", "0");
  });

  await test("文件名清洗：非法字符替换、路径剥离", async () => {
    assertEqual(sanitizeFilename("a/b.pdf"), "b.pdf", "应剥掉路径");
    assertEqual(sanitizeFilename("讲义:第1章?.pdf"), "讲义_第1章_.pdf", "非法字符换成下划线");
    assertEqual(sanitizeFilename("../../etc/passwd"), "passwd", "防路径穿越");
    assertEqual(sanitizeFilename(""), "download", "空名应有兜底");
    assertEqual(sanitizeFilename("   "), "download", "全空格应有兜底");
  });

  await test("文件名清洗：保留名与超长名", async () => {
    assert(sanitizeFilename("CON.txt").startsWith("_"), `Windows 保留名要加前缀：${sanitizeFilename("CON.txt")}`);
    const long = sanitizeFilename(`${"长".repeat(200)}.pdf`);
    assert(long.length <= 120, `超长名应截断，实际 ${long.length}`);
    assert(long.endsWith(".pdf"), "截断后应保留扩展名");
  });
}

// ── 3.5 Token 归一化（token.js） ─────────────────────────

async function testTokenNormalization() {
  console.log("\n🔴 Token 归一化：真实值有两层包装");

  const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiI3OTMxMTAifQ.c2lnbmF0dXJl";

  await test("去掉 str- 前缀 + Bearer 两层（真实观测到的形态）", async () => {
    assertEqual(normalizeToken(`str-Bearer ${JWT}`), JWT, "应当剥净两层");
  });

  await test("只带 Bearer 一层", async () => {
    assertEqual(normalizeToken(`Bearer ${JWT}`), JWT, "应当去掉 Bearer");
    assertEqual(normalizeToken(`bearer   ${JWT}`), JWT, "大小写与空格");
  });

  await test("只有 4 字符前缀", async () => {
    assertEqual(normalizeToken(`abcd${JWT}`), JWT, "应当去掉 4 字符前缀");
  });

  await test("已经是裸 JWT / 带首尾空白", async () => {
    assertEqual(normalizeToken(JWT), JWT, "裸 JWT 不变");
    assertEqual(normalizeToken(`  ${JWT}  `), JWT, "应去首尾空白");
  });

  await test("认不出的值原样返回（不猜）", async () => {
    assertEqual(normalizeToken("随便一段文字"), "随便一段文字", "不应乱改");
    assertEqual(normalizeToken(""), "", "空串");
  });
}

// ── 4. 下载：Service Worker 里没有 createObjectURL ───────

async function withStubs(stubs, fn) {
  const saved = {
    chrome: globalThis.chrome,
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
  };
  if (stubs.chrome !== undefined) globalThis.chrome = stubs.chrome;
  // 关键：把 createObjectURL 换成一调用就抛错的假件。
  // MV3 的 Service Worker 全局作用域里**根本没有**这个函数，
  // 所以"代码又回头去用 blob URL"必须在这里就炸出来，而不是等到浏览器里。
  URL.createObjectURL = stubs.createObjectURL || (() => {
    throw new TypeError("URL.createObjectURL is not a function");
  });
  URL.revokeObjectURL = stubs.revokeObjectURL || (() => {});
  try {
    return await fn();
  } finally {
    globalThis.chrome = saved.chrome;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  }
}

function makeChromeStub(calls) {
  return {
    downloads: {
      async download(opts) {
        calls.push(opts);
        return calls.length;
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
}

async function testDownloadQueue() {
  console.log("\n🔴 下载：不碰 createObjectURL、失败不重复下载");

  await test("直接下载：只调一次，URL 原样传，不创建 blob", async () => {
    const calls = [];
    let blobCalls = 0;

    await withStubs(
      {
        chrome: makeChromeStub(calls),
        createObjectURL: () => { blobCalls++; return "blob:fake"; },
      },
      async () => {
        const q = new DownloadQueue({ async getToken() { return "tok"; } });
        q._waitForDownloadComplete = async () => {};

        const url = "https://file.cc98.org/v4-upload/d/2026/1101/abc123.pdf";
        await q._downloadFile({ url, filename: "abc123.pdf" });

        assertEqual(calls.length, 1, "只应调用一次");
        assertEqual(calls[0].url, url, "应直接使用原始 URL");
        assertEqual(blobCalls, 0, "不应创建 blob URL（SW 里没有这个函数）");
      }
    );
  });

  await test("等待超时 → 抛 DownloadError，且只启动一次（不下两遍）", async () => {
    const calls = [];

    await withStubs({ chrome: makeChromeStub(calls) }, async () => {
      const q = new DownloadQueue({ async getToken() { return "tok"; } });
      q._waitForDownloadComplete = async () => {
        throw new DownloadError("下载超时", { retryable: false });
      };

      let caught = null;
      try {
        await q._downloadFile({ url: "https://file.cc98.org/a.pdf", filename: "a.pdf" });
      } catch (e) {
        caught = e;
      }

      assert(caught instanceof DownloadError, "应当抛出 DownloadError");
      assertEqual(calls.length, 1, "chrome.downloads.download 只应被调用一次");
      assertEqual(q._isRetryable(caught), false, "超时不应重试（文件可能还在下）");
    });
  });

  await test("下载被中断 → 可重试", async () => {
    let listener = null;
    const chromeStub = {
      downloads: {
        async download() { return 7; },
        onChanged: {
          addListener(fn) { listener = fn; },
          removeListener() {},
        },
      },
    };

    await withStubs({ chrome: chromeStub }, async () => {
      const q = new DownloadQueue({ async getToken() { return "tok"; } });
      const pending = q._downloadFile({ url: "https://x/y.pdf", filename: "y.pdf" });

      await new Promise(r => setTimeout(r, 10));
      listener({ id: 7, state: { current: "interrupted" } });

      let caught = null;
      try {
        await pending;
      } catch (e) {
        caught = e;
      }

      assert(caught instanceof DownloadError, "应当抛 DownloadError");
      assertEqual(q._isRetryable(caught), true, "中断可以重试");
    });
  });

  await test("chrome.downloads.download 抛错 → 包装成可读 DownloadError", async () => {
    const chromeStub = {
      downloads: {
        async download() { throw new Error("Invalid URL"); },
        onChanged: { addListener() {}, removeListener() {} },
      },
    };

    await withStubs({ chrome: chromeStub }, async () => {
      const q = new DownloadQueue({ async getToken() { return "tok"; } });

      let caught = null;
      try {
        await q._downloadFile({ url: "bad-url", filename: "x.pdf" });
      } catch (e) {
        caught = e;
      }

      assert(caught instanceof DownloadError, "应当抛 DownloadError");
      assert(caught.message.includes("无法开始下载"), `消息应可读：${caught.message}`);
      assert(caught.message.includes("Invalid URL"), `应带出原始原因：${caught.message}`);
      assertEqual(q._isRetryable(caught), true, "开始阶段失败可以重试");
    });
  });
}

// ── 5. UBB 附件解析（直接测真实模块，不再手抄一份） ───────

async function testAttachmentParsing() {
  console.log("\n📎 UBB 附件解析（导入真实模块）");

  await test("三种占位符格式都能解析", async () => {
    const withMime = parseAttachments("[upload=12345,type=application/pdf]复习资料.pdf[/upload]");
    assertEqual(withMime.length, 1, "带 mime 的数量");
    assertEqual(withMime[0].fileId, "12345", "fileId");
    assertEqual(withMime[0].mimeType, "application/pdf", "mimeType");

    const noMime = parseAttachments("[upload=67890]作业.docx[/upload]");
    assertEqual(noMime[0].mimeType, null, "无 mime 时应为 null");

    const fileTag = parseAttachments("[file=111]讲义.zip[/file]");
    assertEqual(fileTag.length, 1, "file 标签数量");
    assertEqual(fileTag[0].filename, "讲义.zip", "file 标签文件名");
  });

  await test("同一 fileId 只出现一次", async () => {
    const atts = parseAttachments(
      "[upload=1]a.pdf[/upload] 中间文字 [upload=1]a.pdf[/upload]"
    );
    assertEqual(atts.length, 1, "应去重");
  });

  await test("文件名里的空格与中文要正确编码进 URL", async () => {
    const atts = parseAttachments("[upload=9]复习 资料.pdf[/upload]");
    assertEqual(
      atts[0].url,
      `https://file.cc98.org/file/9/${encodeURIComponent("复习 资料.pdf")}`,
      "URL 编码"
    );
  });

  await test("无附件 / 空内容返回空数组", async () => {
    assertEqual(parseAttachments("普通文字").length, 0, "普通文字");
    assertEqual(parseAttachments("").length, 0, "空串");
    assertEqual(parseAttachments(null).length, 0, "null");
  });

  await test("v4 直链：图片不算附件，文档算", async () => {
    const content = [
      "[img]https://file.cc98.org/v4-upload/d/2026/1101/nco4dxf0.webp[/img]",
      "讲义在 https://file.cc98.org/v4-upload/d/2026/1101/abc123.pdf 这里",
    ].join("\n");

    const urls = extractFileUrls(content);
    assertEqual(urls.length, 2, "应抽出两个链接");
    assertEqual(urls[0].kind, "image", "webp 应判为图片");
    assertEqual(urls[1].kind, "file", "pdf 应判为文件");

    const atts = parseAttachments(content);
    assertEqual(atts.length, 1, "图片不应计入附件");
    assertEqual(atts[0].filename, "abc123.pdf", "文件名取自 URL 末段");
    assertEqual(
      atts[0].url,
      "https://file.cc98.org/v4-upload/d/2026/1101/abc123.pdf",
      "URL 原样保留，不再拼接"
    );
  });

  await test("同一个直链只算一次", async () => {
    const u = "https://file.cc98.org/v4-upload/d/2026/1101/x.zip";
    assertEqual(parseAttachments(`${u} 和 ${u}`).length, 1, "应去重");
  });

  await test("Markdown 链接：URL 不带右括号，文件名用显示名", async () => {
    const content = [
      "### 下载文件",
      "",
      "[lec00-课程简介](https://file.cc98.org/v4-upload/d/2026/1008/wsyx4tyq.pdf)",
      "",
      "[lec01-AVL, Splay, 摊还分析](https://file.cc98.org/v4-upload/d/2026/1008/uitt2cje.pdf)",
    ].join("\n");

    const atts = parseAttachments(content);
    assertEqual(atts.length, 2, "应解析出两个附件");
    assertEqual(
      atts[0].url,
      "https://file.cc98.org/v4-upload/d/2026/1008/wsyx4tyq.pdf",
      "URL 不应把结尾的 ) 吃进来"
    );
    assertEqual(atts[0].filename, "lec00-课程简介.pdf", "文件名应取 Markdown 显示名 + 扩展名");
    assertEqual(atts[1].filename, "lec01-AVL, Splay, 摊还分析.pdf", "带逗号和空格的显示名");
  });

  await test("Markdown 外链（非 file.cc98.org）不算附件", async () => {
    const content = [
      "参考[图灵课程指南](https://zju-turing.github.io/TuringCourses/major/ads/)",
      "[讲义](https://file.cc98.org/v4-upload/d/2026/1008/pdf1.pdf)",
      "还可以看 [知乎](https://zhuanlan.zhihu.com/p/123456)",
    ].join("\n");

    const atts = parseAttachments(content);
    assertEqual(atts.length, 1, `只应有 1 个附件，实际 ${atts.length}：${atts.map(a => a.url).join(", ")}`);
    assertEqual(atts[0].url, "https://file.cc98.org/v4-upload/d/2026/1008/pdf1.pdf", "只认 file.cc98.org");
  });
}

// ── 6. AI 层（lib/ai.js，纯函数，不联网） ────────────────

async function testAiHelpers() {
  console.log("\n🤖 AI：端点拼装 / 输出解析 / 本地兜底");

  await test("buildEndpoint 兼容各种 baseURL 写法", async () => {
    assertEqual(
      buildEndpoint("https://api.deepseek.com"),
      "https://api.deepseek.com/v1/chat/completions",
      "裸域名应补 /v1"
    );
    assertEqual(
      buildEndpoint("https://api.deepseek.com/"),
      "https://api.deepseek.com/v1/chat/completions",
      "结尾斜杠"
    );
    assertEqual(
      buildEndpoint("https://api.openai.com/v1"),
      "https://api.openai.com/v1/chat/completions",
      "已带 /v1 不应重复"
    );
    assertEqual(
      buildEndpoint("https://x.com/v1/chat/completions"),
      "https://x.com/v1/chat/completions",
      "完整地址原样保留"
    );
  });

  await test("parseAiJson 能处理代码围栏和前后废话", async () => {
    const plain = '{"worth":4}';
    assertEqual(parseAiJson(plain).worth, 4, "纯 JSON");

    const fenced = '```json\n{"worth":5}\n```';
    assertEqual(parseAiJson(fenced).worth, 5, "带 json 围栏");

    const noisy = '好的，分析如下：\n{"kind":"分享","worth":3}\n希望对你有帮助。';
    assertEqual(parseAiJson(noisy).kind, "分享", "前后有废话");

    let threw = false;
    try { parseAiJson("完全不是 JSON"); } catch { threw = true; }
    assert(threw, "非法内容应当抛错，而不是静默返回空对象");
  });

  await test("normalizeSummary 把越界值夹回合法范围", async () => {
    const s = normalizeSummary({ kind: "神仙帖", worth: 99, oneLine: "测试", has: null });
    assertEqual(s.kind, "其他", "未知 kind 回落");
    assertEqual(s.worth, 5, "worth 上限夹到 5");
    assertEqual(s.has.length, 0, "has 非数组应变成空数组");

    const low = normalizeSummary({ worth: -3 });
    assertEqual(low.worth, 1, "worth 下限夹到 1");
  });

  await test("localScore：有附件 + 有赞 → 分数明显更高", async () => {
    const rich = localScore({
      topic: { likeCount: 10, favoriteCount: 5, replyCount: 30, bestState: true },
      attachments: Array.from({ length: 12 }, (_, i) => ({ filename: `f${i}.pdf` })),
      author: { popularity: 5, receivedLikeCount: 200 },
    });
    const poor = localScore({ topic: {}, attachments: [], author: null });

    assert(rich.score > poor.score, `有资料应高于空帖：${rich.score} vs ${poor.score}`);
    assert(rich.score <= 100, "分数不应超过 100");
    assert(rich.reasons.some(r => r.includes("附件")), "理由里应说明附件数");
    assertEqual(poor.score, 0, "什么都没有应为 0");
  });

  await test("buildTopicMessages 含标题/附件名/作者风评值，且截断正文", async () => {
    const longBody = "很长的正文".repeat(2000);
    const msgs = buildTopicMessages({
      topic: { title: "ADS 讲义分享", boardName: "学习天地", replyCount: 103, likeCount: 7, bestState: true },
      posts: [
        { floor: 1, content: longBody },
        { floor: 2, content: "感谢分享", likeCount: 9, userName: "同学A" },
      ],
      attachments: [{ filename: "lec00-课程简介.pdf" }],
      author: { name: "yhwis", popularity: 12, fanCount: 3, receivedLikeCount: 40, postCount: 100 },
    });

    assertEqual(msgs.length, 2, "system + user 两条");
    const u = msgs[1].content;
    assert(u.includes("ADS 讲义分享"), "应含标题");
    assert(u.includes("lec00-课程简介.pdf"), "应含附件名");
    assert(u.includes("风评值 12"), "应含作者风评值");
    assert(u.includes("已截断"), "超长正文应标注截断");
    assert(u.length < longBody.length, "确实截断了");
  });
}

// ── 7. 自动分拣（lib/triage.js，纯函数） ─────────────────

async function testTriage() {
  console.log("\n🔎 自动分拣：识别求资料帖 + 按价值排序");

  await test("识别「求资料」类措辞", async () => {
    assert(looksLikeSeeking({ content: "有没有人有这门课的讲义资料？", attachmentCount: 0 }), "有没有…资料");
    assert(looksLikeSeeking({ content: "跪求一份往年真题", attachmentCount: 0 }), "跪求");
    assert(looksLikeSeeking({ content: "哪位大佬分享一下课件", attachmentCount: 0 }), "哪位…分享");
  });

  await test("有附件 / 长文 / 普通内容都不算求资料", async () => {
    assert(!looksLikeSeeking({ content: "求一份讲义", attachmentCount: 3 }), "有附件就不算求");
    assert(!looksLikeSeeking({ content: "求一份讲义".repeat(300), attachmentCount: 0 }), "长文不算");
    assert(!looksLikeSeeking({ content: "这是我整理的笔记，见附件", attachmentCount: 0 }), "普通分享描述");
    assert(!looksLikeSeeking({ content: "", attachmentCount: 0 }), "空内容");
  });

  await test("标题信号：求帖正文只有「如题」也能识别", async () => {
    assert(
      looksLikeSeeking({ content: "如题", title: "求数据结构与算法电子教材中文版", attachmentCount: 0 }),
      "标题以「求」开头"
    );
    assert(
      looksLikeSeeking({ content: "", title: "求一本数据结构", attachmentCount: 0 }),
      "求一本…"
    );
    assert(
      !looksLikeSeeking({ content: "我整理了完整讲义", title: "数据结构讲义分享", attachmentCount: 0 }),
      "分享帖标题不应误判"
    );
    assert(
      !looksLikeSeeking({ content: "求", title: "求分享", attachmentCount: 2 }),
      "有附件的求字帖也不算"
    );
  });

  await test("排序：有附件优先，其次分数，再看回复数", async () => {
    const ranked = rankTriage([
      { id: 1, attachmentCount: 0, score: 0, replyCount: 500 },
      { id: 2, attachmentCount: 12, score: 80, replyCount: 10 },
      { id: 3, attachmentCount: 3, score: 55, replyCount: 99 },
      { id: 4, attachmentCount: 0, score: 0, replyCount: 3 },
    ]);
    assertEqual(ranked.map(t => t.id).join(","), "2,3,1,4", "应先有资料、再按分数、最后按回复");
  });

  await test("badge 文案：卖书 / 求资料 / 无附件 / 有资料", async () => {
    assertEqual(triageBadge({ type: "卖书", attachmentCount: 0 }).text, "卖书", "卖书");
    assertEqual(triageBadge({ type: "求资料", attachmentCount: 0 }).text, "求资料", "求资料");
    assertEqual(triageBadge({ type: "讨论", attachmentCount: 0 }).text, "无附件", "无附件");
    assertEqual(triageBadge({ type: "资源", attachmentCount: 12, score: 80 }).text, "资源 📎 12 · 80 分", "资源楼");
    assertEqual(triageBadge(null).text, "", "未扫描时为空");
  });

  await test("分类：卖书 / 求资料 / 资源 / 讨论", async () => {
    assertEqual(classifyPostType({ title: "长期三折出书（部分赠送资料）" }), "卖书", "出书");
    assertEqual(classifyPostType({ title: "zjg/yq出书（普化…电工电子学及实验…）" }), "卖书", "出书2");
    assertEqual(classifyPostType({ title: "求电工电子学答案" }), "求资料", "求");
    assertEqual(classifyPostType({ title: "（已求到）求一本电工电子学实验教程" }), "求资料", "求一本");
    assertEqual(classifyPostType({ title: "sallerina的大二秋冬资源楼（tags:…）" }), "资源", "资源楼");
    assertEqual(classifyPostType({ title: "25-26春夏 大二下课程经验总结分享" }), "资源", "经验总结");
    assertEqual(classifyPostType({ title: "电工电子学概论" }), "讨论", "普通标题");
    assertEqual(classifyPostType({ title: "低价出书（含复习资料）" }), "卖书", "卖书应优先于资料字样");
  });

  await test("「只看有资料的」筛选：逐条判断，不能因为一条没扫到就整体失效", async () => {
    const list = [
      { id: 1, _triage: { attachmentCount: 12 } }, // 有资料
      { id: 2, _triage: { attachmentCount: 0 } },  // 无资料 → 应折叠
      { id: 3 },                                   // 还没扫到 → 保留
      { id: 4, _triageError: "HTTP 403" },         // 扫描失败 → 保留
    ];

    assertEqual(filterWithMaterial(list, false).length, 4, "关闭开关应全部显示");
    assertEqual(
      filterWithMaterial(list, true).map(t => t.id).join(","),
      "1,3,4",
      "只折叠确认无资料的"
    );

    // 回归：全都没扫到时，早期用 every() 会整体失效；现在应逐条保留
    assertEqual(filterWithMaterial([{ id: 9 }, { id: 10 }], true).length, 2, "未扫描时应保留");
  });

  await test("排序：资源楼最前，其次有附件", async () => {
    const ranked = rankTriage([
      { id: 1, type: "讨论", attachmentCount: 3, score: 90, replyCount: 5 },
      { id: 2, type: "资源", attachmentCount: 1, score: 20, replyCount: 5 },
      { id: 3, type: "卖书", attachmentCount: 0, score: 0, replyCount: 0 },
    ]);
    assertEqual(ranked.map(t => t.id).join(","), "2,1,3", "资源楼应排第一");
  });
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  console.log(`
╔══════════════════════════════════════════════╗
║   CC98 插件离线回归测试                      ║
╚══════════════════════════════════════════════╝`);

  await testErrorBodyConsumption();
  await testSearchErrorPropagation();
  await testEscapeHtml();
  await testTokenNormalization();
  await testDownloadQueue();
  await testAttachmentParsing();
  await testAiHelpers();
  await testTriage();

  console.log(`
──────────────────────────────────────
  结果: ✅ ${passed} 通过 | ❌ ${failed} 失败
──────────────────────────────────────`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("测试执行出错:", err);
  process.exit(1);
});
