#!/usr/bin/env node

/**
 * CC98 API 接口验证脚本
 *
 * 验证三个核心链路：
 *   1. 搜索帖子
 *   2. 读取帖子内容与附件
 *   3. 附件下载
 *
 * 用法：
 *   node api-verify.mjs --token <access_token> [--keyword <搜索关键词>] [--topic-id <帖子ID>]
 *
 * 环境变量：
 *   CC98_TOKEN - access token（也可用 --token 传入）
 */

const API_BASE = "https://api.cc98.org";
const FILE_BASE = "https://file.cc98.org";
const FORUM_BASE = "https://www.cc98.org";

// ── 工具函数 ──────────────────────────────────────────────

function log(section, msg) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${section}`);
  console.log(`${"═".repeat(60)}`);
  if (msg) console.log(msg);
}

function logResult(label, data) {
  console.log(`\n  ▸ ${label}:`);
  if (typeof data === "object") {
    console.log(JSON.stringify(data, null, 2).split("\n").map(l => "    " + l).join("\n"));
  } else {
    console.log(`    ${data}`);
  }
}

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

  const headers = {
    "Accept": "application/json",
    ...options.headers,
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url.toString(), {
    method: options.method || "GET",
    headers,
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  return {
    status: res.status,
    ok: res.ok,
    headers: Object.fromEntries(res.headers.entries()),
    json,
    text,
  };
}

// ── 链路 1：搜索帖子 ─────────────────────────────────────

async function verifySearch(token, keyword) {
  log("链路 1：搜索帖子", `关键词: "${keyword}"`);

  // 1a. 不带 token 搜索（应返回 401）
  logResult("1a. 无 Token 搜索", "预期返回 401");
  const noAuth = await cc98Request("/Topic/Search", null, {
    params: { keyword, boardId: 0, page: 1, size: 5 },
  });
  logResult("状态码", noAuth.status);
  logResult("响应", noAuth.json || noAuth.text);

  // 1b. 带 token 搜索
  logResult("1b. 带 Token 搜索", `GET /Topic/Search?keyword=${keyword}&boardId=0&page=1&size=5`);
  const withAuth = await cc98Request("/Topic/Search", token, {
    params: { keyword, boardId: 0, page: 1, size: 5 },
  });
  logResult("状态码", withAuth.status);

  if (withAuth.ok && Array.isArray(withAuth.json)) {
    logResult("返回条数", withAuth.json.length);
    if (withAuth.json.length > 0) {
      const first = withAuth.json[0];
      logResult("首条帖子字段", Object.keys(first));
      logResult("首条帖子示例", first);
    }
  } else {
    logResult("响应", withAuth.json || withAuth.text);
  }

  // 1c. 搜索参数变体：带 condition
  logResult("1c. 带 condition 搜索", `condition=1 (标题+内容)`);
  const withCondition = await cc98Request("/Topic/Search", token, {
    params: { keyword, boardId: 0, page: 1, size: 5, condition: 1 },
  });
  logResult("状态码", withCondition.status);
  if (withCondition.ok) {
    logResult("返回条数", withCondition.json?.length ?? "N/A");
  }

  // 1d. 分页测试
  logResult("1d. 分页测试", "page=2&size=3");
  const page2 = await cc98Request("/Topic/Search", token, {
    params: { keyword, boardId: 0, page: 2, size: 3 },
  });
  logResult("状态码", page2.status);
  if (page2.ok) {
    logResult("第2页条数", page2.json?.length ?? "N/A");
  }

  return withAuth.ok ? withAuth.json : null;
}

// ── 链路 2：读取帖子内容 ──────────────────────────────────

async function verifyTopicContent(token, topicId) {
  log("链路 2：读取帖子内容", `帖子 ID: ${topicId}`);

  // 2a. 获取帖子详情
  logResult("2a. 帖子详情", `GET /Topic/${topicId}`);
  const topicDetail = await cc98Request(`/Topic/${topicId}`, token);
  logResult("状态码", topicDetail.status);

  let topicData = null;
  if (topicDetail.ok) {
    topicData = topicDetail.json;
    logResult("字段列表", Object.keys(topicData));
    logResult("帖子标题", topicData.title);
    logResult("帖子数据", topicData);
  } else {
    logResult("响应", topicDetail.json || topicDetail.text);
  }

  // 2b. 获取帖子楼层
  logResult("2b. 帖子楼层", `GET /Topic/${topicId}/Post?from=1&size=10`);
  const posts = await cc98Request(`/Topic/${topicId}/Post`, token, {
    params: { from: 1, size: 10 },
  });
  logResult("状态码", posts.status);

  let attachments = [];
  if (posts.ok) {
    const postData = posts.json;
    logResult("返回结构", Array.isArray(postData) ? `数组，${postData.length} 条` : typeof postData);
    if (Array.isArray(postData) && postData.length > 0) {
      const firstPost = postData[0];
      logResult("首条楼层字段", Object.keys(firstPost));
      logResult("首条楼层示例", firstPost);

      // 尝试解析 UBB 内容中的附件占位符
      const content = firstPost.content || firstPost.body || firstPost.rawContent || "";
      attachments = parseUBBAttachments(content);
      logResult("解析到的附件", attachments.length > 0 ? attachments : "（内容中未发现附件占位符）");

      // 也检查是否有单独的附件字段
      if (firstPost.attachments || firstPost.fileList || firstPost.uploadFileList) {
        const attField = firstPost.attachments || firstPost.fileList || firstPost.uploadFileList;
        logResult("帖子中的附件字段", attField);
        attachments = attField;
      }
    } else if (postData && !Array.isArray(postData)) {
      // 可能返回的是对象而非数组
      logResult("返回数据结构", postData);
    }
  } else {
    logResult("响应", posts.json || posts.text);
  }

  return { topicData, attachments };
}

// ── UBB 附件占位符解析 ────────────────────────────────────

function parseUBBAttachments(content) {
  if (!content) return [];

  const attachments = [];

  // 格式1: [upload=fileId,type=mimeType]filename[/upload]
  const re1 = /\[upload=(\d+)(?:,type=([^\]]+))?\]([^\[]+)\[\/upload\]/g;
  let match;
  while ((match = re1.exec(content)) !== null) {
    attachments.push({
      fileId: match[1],
      mimeType: match[2] || null,
      filename: match[3],
      url: `${FILE_BASE}/file/${match[1]}/${encodeURIComponent(match[3])}`,
    });
  }

  // 格式2: [upload=fileId]filename[/upload] (无 type)
  if (attachments.length === 0) {
    const re2 = /\[upload=(\d+)\]([^\[]+)\[\/upload\]/g;
    while ((match = re2.exec(content)) !== null) {
      attachments.push({
        fileId: match[1],
        mimeType: null,
        filename: match[2],
        url: `${FILE_BASE}/file/${match[1]}/${encodeURIComponent(match[2])}`,
      });
    }
  }

  // 格式3: [file=fileId]filename[/file]
  if (attachments.length === 0) {
    const re3 = /\[file=(\d+)\]([^\[]+)\[\/file\]/g;
    while ((match = re3.exec(content)) !== null) {
      attachments.push({
        fileId: match[1],
        mimeType: null,
        filename: match[2],
        url: `${FILE_BASE}/file/${match[1]}/${encodeURIComponent(match[2])}`,
      });
    }
  }

  return attachments;
}

// ── 链路 3：附件下载 ──────────────────────────────────────

async function verifyAttachmentDownload(token, attachments) {
  log("链路 3：附件下载", `待测试附件数: ${attachments.length}`);

  if (attachments.length === 0) {
    logResult("提示", "未从帖子内容中解析到附件，尝试直接访问 file.cc98.org 探测格式");
    await probeFileEndpoint(token);
    return;
  }

  const att = attachments[0];
  logResult("3a. 测试附件", att.filename);

  // 3a. 无鉴权直连
  logResult("3a-1. 无鉴权直连", `GET ${att.url}`);
  try {
    const direct = await fetch(att.url, {
      method: "HEAD",
      signal: AbortSignal.timeout(10000),
    });
    logResult("状态码", direct.status);
    logResult("Content-Type", direct.headers.get("content-type"));
    logResult("Content-Length", direct.headers.get("content-length"));
    logResult("Content-Disposition", direct.headers.get("content-disposition"));
  } catch (e) {
    logResult("直连错误", e.message);
  }

  // 3b. Bearer token 鉴权
  logResult("3b. Bearer Token 鉴权", `GET ${att.url} with Authorization header`);
  try {
    const withToken = await fetch(att.url, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    logResult("状态码", withToken.status);
    logResult("Content-Type", withToken.headers.get("content-type"));
    logResult("Content-Length", withToken.headers.get("content-length"));
  } catch (e) {
    logResult("鉴权下载错误", e.message);
  }

  // 3c. 带 Referer
  logResult("3c. 带 Referer 鉴权", `GET ${att.url} with Referer: ${FORUM_BASE}`);
  try {
    const withReferer = await fetch(att.url, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${token}`,
        Referer: FORUM_BASE,
      },
      signal: AbortSignal.timeout(10000),
    });
    logResult("状态码", withReferer.status);
  } catch (e) {
    logResult("带 Referer 错误", e.message);
  }

  // 3d. 尝试不同的 URL 格式
  const altUrls = [
    `${FILE_BASE}/${att.fileId}/${encodeURIComponent(att.filename)}`,
    `${API_BASE}/File/${att.fileId}`,
    `${API_BASE}/File/Download/${att.fileId}`,
  ];
  for (const url of altUrls) {
    logResult("3d. 替代 URL", url);
    try {
      const alt = await fetch(url, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      logResult("状态码", alt.status);
      if (alt.ok) {
        logResult("Content-Type", alt.headers.get("content-type"));
        logResult("Content-Length", alt.headers.get("content-length"));
      }
    } catch (e) {
      logResult("错误", e.message);
    }
  }
}

async function probeFileEndpoint(token) {
  // 尝试探测 file.cc98.org 的 URL 格式
  const probes = [
    { url: `${FILE_BASE}/`, desc: "file.cc98.org 根路径" },
    { url: `${API_BASE}/File`, desc: "api.cc98.org/File" },
  ];

  for (const { url, desc } of probes) {
    logResult(`探测: ${desc}`, url);
    try {
      const res = await fetch(url, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      logResult("状态码", res.status);
      logResult("Allow", res.headers.get("allow"));
    } catch (e) {
      logResult("错误", e.message);
    }
  }
}

// ── 公开端点验证（无需 token）─────────────────────────────

async function verifyPublicEndpoints() {
  log("公共端点验证（无需 Token）");

  // 热门帖子
  logResult("热门帖子", "GET /Topic/Hot");
  const hot = await cc98Request("/Topic/Hot", null);
  logResult("状态码", hot.status);
  if (hot.ok && hot.json?.length > 0) {
    logResult("热门帖子字段", Object.keys(hot.json[0]));
    logResult("热门帖子数", hot.json.length);
  }

  // 版面列表
  logResult("版面列表", "GET /Board/All");
  const boards = await cc98Request("/Board/All", null);
  logResult("状态码", boards.status);
  if (boards.ok) {
    const boardData = boards.json;
    if (Array.isArray(boardData)) {
      logResult("版面分类数", boardData.length);
      if (boardData.length > 0) {
        logResult("首个分类字段", Object.keys(boardData[0]));
      }
    } else {
      logResult("版面数据结构", typeof boardData);
    }
  }

  // OpenID 配置
  logResult("OpenID 配置", "GET openid.cc98.org/.well-known/openid-configuration");
  try {
    const oidc = await fetch("https://openid.cc98.org/.well-known/openid-configuration", {
      signal: AbortSignal.timeout(10000),
    });
    const oidcData = await oidc.json();
    logResult("token_endpoint", oidcData.token_endpoint);
    logResult("authorization_endpoint", oidcData.authorization_endpoint);
    logResult("scopes_supported (部分)", oidcData.scopes_supported?.filter(s => s.startsWith("cc98") || s === "openid" || s === "profile"));
  } catch (e) {
    logResult("OpenID 获取错误", e.message);
  }
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const token = args.token || process.env.CC98_TOKEN;
  const keyword = args["keyword"] || args["search"] || "数据结构";
  const topicId = args["topic-id"];

  console.log(`
╔════════════════════════════════════════════════════════╗
║        CC98 API 接口验证脚本 v0.1.0                    ║
║        验证搜索、读帖、附件下载三个链路                  ║
╚════════════════════════════════════════════════════════╝

  API Base:  ${API_BASE}
  File Base: ${FILE_BASE}
  Token:     ${token ? `${token.slice(0, 6)}...${token.slice(-4)}` : "(未提供)"}
  关键词:    ${keyword}
  帖子 ID:   ${topicId || "(未指定，将从搜索结果中选取)"}
`);

  // 0. 公开端点验证
  await verifyPublicEndpoints();

  if (!token) {
    console.log("\n⚠️  未提供 access token，跳过需要认证的链路验证。");
    console.log("   请通过 --token 参数或 CC98_TOKEN 环境变量提供 token。");
    console.log("   用法: node api-verify.mjs --token <your_token>");
    process.exit(0);
  }

  // 1. 搜索帖子
  const searchResults = await verifySearch(token, keyword);

  // 2. 读取帖子内容
  let targetTopicId = topicId;
  if (!targetTopicId && searchResults && searchResults.length > 0) {
    targetTopicId = searchResults[0].id;
    console.log(`\n  ▸ 从搜索结果中选取帖子 ID: ${targetTopicId} (${searchResults[0].title})`);
  }

  let attachments = [];
  if (targetTopicId) {
    const contentResult = await verifyTopicContent(token, targetTopicId);
    attachments = contentResult.attachments || [];
  } else {
    log("链路 2：读取帖子内容", "⚠️ 无可用帖子 ID，跳过");
  }

  // 3. 附件下载
  if (attachments.length > 0 || targetTopicId) {
    await verifyAttachmentDownload(token, attachments);
  } else {
    log("链路 3：附件下载", "⚠️ 无附件信息，跳过");
  }

  // 汇总
  log("验证汇总");
  console.log(`
  ✅ 公开端点（/Topic/Hot, /Board/All, OpenID）: 已验证
  ${searchResults ? "✅" : "❌"} 搜索帖子链路: ${searchResults ? `成功（返回 ${searchResults.length} 条）` : "失败"}
  ${targetTopicId ? "✅" : "❌"} 读取帖子内容链路: ${targetTopicId ? `已测试 (ID: ${targetTopicId})` : "未测试"}
  ${attachments.length > 0 ? "✅" : "⚠️ "} 附件下载链路: ${attachments.length > 0 ? `发现 ${attachments.length} 个附件` : "未发现附件"}

  📋 下一步:
  1. 如附件 URL 格式有误，根据实际响应修正 attachment.js 中的 URL 构造逻辑
  2. 如 UBB 占位符格式不同，修正 parseUBBAttachments 正则
  3. 确认附件鉴权方式后，完善下载策略
  `);
}

main().catch(err => {
  console.error("\n❌ 脚本执行出错:", err.message);
  process.exit(1);
});
