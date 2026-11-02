/**
 * CC98 API 接口验证测试用例
 *
 * 用法：
 *   node api-verify.test.mjs --token <access_token>
 *
 * 或设置环境变量：
 *   CC98_TOKEN=<token> node api-verify.test.mjs
 */

const API_BASE = "https://api.cc98.org";

// 直接用真实模块，不再手抄一份实现。
// 手抄的那份测的是"抄写是否正确"，而不是"线上代码是否正确"——
// 一旦 lib/attachment.js 改了正则，手抄的测试照样绿，等于没有覆盖。
import { parseAttachments } from "../lib/attachment.js";

let passed = 0;
let failed = 0;
let skipped = 0;

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      parsed[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return parsed;
}

async function cc98Request(path, token, options = {}) {
  const url = new URL(path, API_BASE);
  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  const headers = { Accept: "application/json", ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url.toString(), {
    method: options.method || "GET",
    headers,
    signal: AbortSignal.timeout(15000),
  });

  let json = null;
  try { json = await res.json(); } catch {}

  return { status: res.status, ok: res.ok, json };
}

// ── 测试框架 ──────────────────────────────────────────────

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

function skip(name, reason) {
  skipped++;
  console.log(`  ⏭️  ${name} (${reason})`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || "Not equal"}: expected ${expected}, got ${actual}`);
}

function assertIncludes(arr, item, message) {
  if (!arr.includes(item)) throw new Error(`${message || "Not included"}: ${item} not in array`);
}

// ── 测试用例 ──────────────────────────────────────────────

async function runPublicTests() {
  console.log("\n📦 公开端点测试");

  await test("GET /Topic/Hot 返回 200 和数组", async () => {
    const res = await cc98Request("/Topic/Hot", null);
    assertEqual(res.status, 200, "Status");
    assert(Array.isArray(res.json), "Should be array");
    assert(res.json.length > 0, "Should have items");
  });

  await test("GET /Topic/Hot 返回正确字段", async () => {
    const res = await cc98Request("/Topic/Hot", null);
    const first = res.json[0];
    const requiredFields = ["id", "title", "boardId", "boardName", "createTime", "authorName"];
    for (const field of requiredFields) {
      assert(field in first, `Missing field: ${field}`);
    }
  });

  await test("GET /Board/All 返回 200 和数组", async () => {
    const res = await cc98Request("/Board/All", null);
    assertEqual(res.status, 200, "Status");
    assert(Array.isArray(res.json), "Should be array");
  });
}

async function runAuthTests(token) {
  console.log("\n🔒 认证端点测试");

  await test("GET /Topic/Search 无 Token 返回 401", async () => {
    const res = await cc98Request("/Topic/Search", null, {
      params: { keyword: "测试", boardId: 0, page: 1, size: 5 },
    });
    assertEqual(res.status, 401, "Should return 401");
  });

  if (!token) {
    skip("所有需 Token 的测试", "未提供 Token");
    return;
  }

  await test("GET /Me 带 Token 返回 200", async () => {
    const res = await cc98Request("/Me", token);
    assertEqual(res.status, 200, "Status");
  });

  await test("GET /Topic/Search 带 Token 返回结果", async () => {
    const res = await cc98Request("/Topic/Search", token, {
      params: { keyword: "数据结构", boardId: 0, page: 1, size: 5 },
    });
    assertEqual(res.status, 200, "Status");
    assert(Array.isArray(res.json), "Should be array");
  });

  await test("搜索结果包含必要字段", async () => {
    const res = await cc98Request("/Topic/Search", token, {
      params: { keyword: "数据结构", boardId: 0, page: 1, size: 5 },
    });
    if (res.json.length > 0) {
      const first = res.json[0];
      assert("id" in first, "Missing id");
      assert("title" in first, "Missing title");
      assert("boardName" in first, "Missing boardName");
    }
  });
}

async function runTopicContentTests(token) {
  console.log("\n📝 帖子内容测试");

  if (!token) {
    skip("帖子内容相关测试", "未提供 Token");
    return;
  }

  // 先搜索获取一个帖子 ID
  const searchRes = await cc98Request("/Topic/Search", token, {
    params: { keyword: "数据结构", boardId: 0, page: 1, size: 1 },
  });

  if (!searchRes.ok || !searchRes.json?.length) {
    skip("帖子详情测试", "搜索无结果");
    return;
  }

  const topicId = searchRes.json[0].id;

  await test(`GET /Topic/${topicId} 返回帖子详情`, async () => {
    const res = await cc98Request(`/Topic/${topicId}`, token);
    assertEqual(res.status, 200, "Status");
    assert("title" in res.json, "Missing title");
  });

  await test(`GET /Topic/${topicId}/Post 返回楼层列表`, async () => {
    const res = await cc98Request(`/Topic/${topicId}/Post`, token, {
      params: { from: 1, size: 10 },
    });
    assertEqual(res.status, 200, "Status");
    assert(Array.isArray(res.json), "Should be array");
  });

  await test("楼层内容包含 content 字段", async () => {
    const res = await cc98Request(`/Topic/${topicId}/Post`, token, {
      params: { from: 1, size: 1 },
    });
    if (res.json.length > 0) {
      assert("content" in res.json[0] || "body" in res.json[0], "Missing content/body field");
    }
  });
}

async function runPaginationTests(token) {
  console.log("\n📄 分页测试");

  if (!token) {
    skip("分页测试", "未提供 Token");
    return;
  }

  await test("分页 page=1 和 page=2 返回不同结果", async () => {
    const p1 = await cc98Request("/Topic/Search", token, {
      params: { keyword: "数据结构", boardId: 0, page: 1, size: 5 },
    });
    const p2 = await cc98Request("/Topic/Search", token, {
      params: { keyword: "数据结构", boardId: 0, page: 2, size: 5 },
    });

    if (p1.ok && p2.ok && p1.json.length > 0 && p2.json.length > 0) {
      assert(p1.json[0].id !== p2.json[0].id, "First items should differ between pages");
    }
  });

  await test("size 参数控制返回条数", async () => {
    const res = await cc98Request("/Topic/Search", token, {
      params: { keyword: "数据结构", boardId: 0, page: 1, size: 3 },
    });
    if (res.ok) {
      assert(res.json.length <= 3, "Should return at most 3 items");
    }
  });
}

async function runErrorHandlingTests(token) {
  console.log("\n⚠️ 错误处理测试");

  await test("不存在的帖子返回 404 或 403", async () => {
    const res = await cc98Request("/Topic/99999999", token);
    assert(res.status === 404 || res.status === 403, `Expected 404 or 403, got ${res.status}`);
  });

  if (!token) {
    skip("Token 过期测试", "未提供 Token");
    return;
  }

  await test("无效 Token 返回 401", async () => {
    const res = await cc98Request("/Me", "invalid_token_value");
    assertEqual(res.status, 401, "Should return 401");
  });
}

// ── UBB 附件解析测试 ──────────────────────────────────────

async function runAttachmentParsingTests() {
  console.log("\n📎 UBB 附件解析测试");

  await test("解析 [upload=id,type=mime]name[/upload] 格式", async () => {
    const content = "请看附件[upload=12345,type=application/pdf]复习资料.pdf[/upload]";
    const atts = parseAttachments(content);
    assertEqual(atts.length, 1, "Should find 1 attachment");
    assertEqual(atts[0].fileId, "12345", "fileId");
    assertEqual(atts[0].filename, "复习资料.pdf", "filename");
    assertEqual(atts[0].mimeType, "application/pdf", "mimeType");
  });

  await test("解析 [upload=id]name[/upload] 格式（无 type）", async () => {
    const content = "[upload=67890]作业.docx[/upload]";
    const atts = parseAttachments(content);
    assertEqual(atts.length, 1, "Should find 1 attachment");
    assertEqual(atts[0].fileId, "67890", "fileId");
    assertEqual(atts[0].mimeType, null, "mimeType should be null");
  });

  await test("解析多个附件", async () => {
    const content = "[upload=1]file1.pdf[/upload]和[upload=2]file2.zip[/upload]";
    const atts = parseAttachments(content);
    assertEqual(atts.length, 2, "Should find 2 attachments");
  });

  await test("无附件内容返回空数组", async () => {
    const content = "这是一段没有附件的普通文字。";
    const atts = parseAttachments(content);
    assertEqual(atts.length, 0, "Should return empty array");
  });

  await test("空内容返回空数组", async () => {
    const atts = parseAttachments("");
    assertEqual(atts.length, 0, "Should return empty array");
  });
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const token = args.token || process.env.CC98_TOKEN;

  console.log(`
╔══════════════════════════════════════════════╗
║     CC98 API 接口验证测试                    ║
╚══════════════════════════════════════════════╝

  Token: ${token ? `${token.slice(0, 6)}...${token.slice(-4)}` : "(未提供)"}
`);

  await runPublicTests();
  await runAuthTests(token);
  await runTopicContentTests(token);
  await runPaginationTests(token);
  await runErrorHandlingTests(token);
  await runAttachmentParsingTests();

  console.log(`
──────────────────────────────────────
  结果: ✅ ${passed} 通过 | ❌ ${failed} 失败 | ⏭️  ${skipped} 跳过
──────────────────────────────────────`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("测试执行出错:", err.message);
  process.exit(1);
});
