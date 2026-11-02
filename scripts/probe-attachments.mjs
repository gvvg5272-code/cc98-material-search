#!/usr/bin/env node

/**
 * 附件格式探针
 *
 * 目的：从**真实帖子正文**里找出附件的 UBB 写法和下载 URL 形态，
 * 结束 lib/attachment.js 里"靠猜"的状态。
 *
 * 用法：
 *   node scripts/probe-attachments.mjs --token <token> [--limit 20]
 *
 * 只读：只调搜索和楼层接口，不写任何东西。
 */

const API_BASE = "https://api.cc98.org";
const REQUEST_GAP_MS = 800;   // 普通请求间隔
const SEARCH_GAP_MS = 3000;   // 搜索接口限流严格得多：连发会直接 403
const PAGE_SIZE = 20;         // 楼层接口 size 上限是 20，50 会返回 400

const KEYWORDS = [
  "资料", "真题", "ppt", "pdf",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      out[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let requestCount = 0;

async function req(path, params, token, gap = REQUEST_GAP_MS) {
  const url = new URL(path, API_BASE);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }
  await sleep(gap);
  requestCount++;
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    console.log(`  ! ${path} → HTTP ${res.status}`);
    return null;
  }
  return res.json();
}

// ── 要扫的模式 ────────────────────────────────────────────

const PATTERNS = [
  { name: "UBB upload", re: /\[upload=[^\]]*\][^\[]*\[\/upload\]/gi },
  { name: "UBB file", re: /\[file=[^\]]*\][^\[]*\[\/file\]/gi },
  { name: "UBB attach", re: /\[attach[^\]]*\]/gi },
  { name: "UBB img", re: /\[img\][^\[]*\[\/img\]/gi },
  { name: "file.cc98.org URL", re: /https?:\/\/file\.cc98\.org\/[^\s[\]<>"')]+/gi },
  { name: "api.cc98.org URL", re: /https?:\/\/api\.cc98\.org\/[^\s[\]<>"')]+/gi },
];

function scan(content, hits) {
  if (!content) return;
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const text = m[0];
      if (!hits.has(name)) hits.set(name, new Map());
      const bucket = hits.get(name);
      // 同样的形态只记一次，避免刷屏
      const signature = name === "file.cc98.org URL" || name === "api.cc98.org URL"
        ? text.replace(/[a-z0-9]{8,}/gi, "<id>").replace(/\/\d{4}\/\d{4}\//g, "/<日期>/")
        : text.slice(0, 120);
      if (!bucket.has(signature)) {
        bucket.set(signature, { sample: text.slice(0, 300), count: 0 });
      }
      bucket.get(signature).count++;
    }
  }
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const token = args.token || process.env.CC98_TOKEN;
  const limit = parseInt(args.limit || "20", 10);

  if (!token) {
    console.error("需要 token：--token <token> 或 CC98_TOKEN 环境变量");
    process.exit(1);
  }

  console.log(`\n收集候选帖子（关键词 ${KEYWORDS.length} 个）…`);

  const topicIds = [];
  const seen = new Set();
  for (const kw of KEYWORDS) {
    const results = await req("/Topic/Search", { keyword: kw, boardId: 0, page: 1, size: 10 }, token, SEARCH_GAP_MS);
    if (!Array.isArray(results)) continue;
    for (const t of results) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        topicIds.push({ id: t.id, title: String(t.title || "").slice(0, 40) });
      }
    }
    console.log(`  ${kw}: 累计 ${topicIds.length} 个帖子`);
    if (topicIds.length >= limit) break;
  }

  console.log(`\n读取 ${Math.min(topicIds.length, limit)} 个帖子的楼层并扫描正文…\n`);

  const hits = new Map();
  let scannedTopics = 0;
  let scannedPosts = 0;

  for (const topic of topicIds.slice(0, limit)) {
    const posts = await req(`/Topic/${topic.id}/Post`, { from: 1, size: PAGE_SIZE }, token);
    if (!Array.isArray(posts)) continue;
    scannedTopics++;
    for (const post of posts) {
      scannedPosts++;
      scan(post.content, hits);
    }
  }

  console.log("═".repeat(60));
  console.log(`扫描完成：${scannedTopics} 帖 / ${scannedPosts} 楼 / ${requestCount} 次请求`);
  console.log("═".repeat(60));

  if (hits.size === 0) {
    console.log("\n❌ 一条都没命中。说明这批帖子里没有附件也没有外链文件。");
  }

  for (const [name, bucket] of hits) {
    console.log(`\n▸ ${name}（${bucket.size} 种形态）`);
    let i = 0;
    for (const [sig, info] of bucket) {
      console.log(`  形态 ${++i}: 出现 ${info.count} 次`);
      console.log(`    ${info.sample}`);
      if (i >= 6) {
        if (bucket.size > 6) console.log(`   … 还有 ${bucket.size - 6} 种未显示`);
        break;
      }
    }
  }
}

main().catch(err => {
  console.error("探针出错:", err);
  process.exit(1);
});
