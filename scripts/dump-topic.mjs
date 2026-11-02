#!/usr/bin/env node

/**
 * 帖子解剖工具
 *
 * 目的：把指定帖子的楼层正文**原样**倒出来，回答"附件到底长什么样"。
 * 不做任何解析、不做任何猜测——只如实打印。
 *
 * 用法：
 *   node scripts/dump-topic.mjs --token <token> --topic <帖子ID>
 *   node scripts/dump-topic.mjs --token <token> --url https://www.cc98.org/topic/1234567
 *   node scripts/dump-topic.mjs --token <token> --topic 123 --only-with-files
 *
 * 输出四块：
 *   1. 帖子基本信息
 *   2. 楼层对象里所有非空字段名（找"藏在别的字段里的附件"）
 *   3. 每个楼层：正文原样（截断到 --maxlen，默认 3000 字符）
 *   4. 汇总：出现过的全部 UBB 标签 + 全部链接
 */

const API_BASE = "https://api.cc98.org";
const REQUEST_GAP_MS = 800;
const PAGE_SIZE = 20;

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

async function req(path, params, token) {
  const url = new URL(path, API_BASE);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }
  await sleep(REQUEST_GAP_MS);
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${path} → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

function extractTopicId(args) {
  if (args.topic) return String(args.topic).trim();
  if (args.url) {
    const m = String(args.url).match(/topic\/(\d+)/i);
    if (m) return m[1];
  }
  return null;
}

/** 正文里出现的全部 UBB 标签名（去重、带出现次数） */
function collectUbbTags(text) {
  const tags = new Map();
  const re = /\[(\/?)([a-zA-Z][a-zA-Z0-9_]*)([=\]][^\]]*)?\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = `${m[1]}${m[2].toLowerCase()}`;
    tags.set(name, (tags.get(name) || 0) + 1);
  }
  return [...tags.entries()].sort((a, b) => b[1] - a[1]);
}

function collectLinks(text) {
  const links = new Set();
  const re = /https?:\/\/[^\s[\]<>"')]+/g;
  let m;
  while ((m = re.exec(text)) !== null) links.add(m[0]);
  return [...links];
}

function nonEmptyKeys(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" &&
      !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => {
      let preview;
      if (typeof v === "string") preview = v.length > 80 ? `${v.slice(0, 80)}…` : v;
      else if (Array.isArray(v)) preview = `[${v.length} 项]`;
      else if (typeof v === "object") preview = "{…}";
      else preview = String(v);
      return `${k} = ${preview}`;
    });
}

async function main() {
  const args = parseArgs();
  const token = args.token || process.env.CC98_TOKEN;
  const topicId = extractTopicId(args);
  const maxLen = parseInt(args.maxlen || "3000", 10);
  const onlyWithFiles = args["only-with-files"] !== undefined;

  if (!token) {
    console.error("需要 token：--token <token>");
    process.exit(1);
  }
  if (!topicId) {
    console.error("需要帖子 ID：--topic <id> 或 --url https://www.cc98.org/topic/<id>");
    process.exit(1);
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`解剖帖子 ${topicId}`);
  console.log("═".repeat(70));

  const topic = await req(`/Topic/${topicId}`, null, token);
  console.log(`\n标题: ${topic.title}`);
  console.log(`版面: ${topic.boardName || topic.boardId}`);
  console.log(`作者: ${topic.userName}`);
  console.log(`时间: ${topic.time}`);
  console.log(`楼层数(replyCount): ${topic.replyCount}`);

  // ── 拉全部楼层 ──
  const posts = [];
  for (let from = 1; posts.length < 200; from += PAGE_SIZE) {
    const page = await req(`/Topic/${topicId}/Post`, { from, size: PAGE_SIZE }, token);
    if (!Array.isArray(page) || page.length === 0) break;
    posts.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  console.log(`\n实际取到楼层: ${posts.length}`);

  // ── 楼层对象字段总览 ──
  const keySet = new Map();
  for (const p of posts) {
    for (const k of Object.keys(p)) keySet.set(k, (keySet.get(k) || 0) + 1);
  }
  console.log(`\n楼层对象字段（出现次数）:`);
  console.log("  " + [...keySet.entries()].map(([k, n]) => `${k}(${n})`).join(", "));

  // 找任何"看起来像附件列表"的字段
  const suspicious = new Set();
  for (const p of posts) {
    for (const [k, v] of Object.entries(p)) {
      if (Array.isArray(v) && v.length > 0 && v.some(x => x && typeof x === "object")) {
        suspicious.add(k);
      }
    }
  }
  if (suspicious.size) {
    console.log(`\n⚠️ 含对象数组的字段（可能藏附件）: ${[...suspicious].join(", ")}`);
    for (const p of posts.slice(0, 3)) {
      for (const k of suspicious) {
        if (Array.isArray(p[k]) && p[k].length) {
          console.log(`  楼层 floor=${p.floor} 的 ${k}: ${JSON.stringify(p[k]).slice(0, 400)}`);
        }
      }
    }
  }

  // ── 逐楼打印正文 ──
  const allTags = new Map();
  const allLinks = new Set();

  for (const p of posts) {
    const content = String(p.content || "");
    for (const [tag, n] of collectUbbTags(content)) {
      allTags.set(tag, (allTags.get(tag) || 0) + n);
    }
    for (const l of collectLinks(content)) allLinks.add(l);

    if (onlyWithFiles && !/\[upload|\[file|\[attach|file\.cc98\.org/i.test(content)) continue;

    console.log(`\n${"─".repeat(70)}`);
    console.log(`楼层 ${p.floor} | ${p.userName} | ${p.time}`);
    console.log(`其他非空字段: ${nonEmptyKeys(p).filter(s => !s.startsWith("content =")).join("; ")}`);
    console.log(`${"─".repeat(70)}`);
    const shown = content.length > maxLen ? `${content.slice(0, maxLen)}\n…（共 ${content.length} 字符，已截断）` : content;
    console.log(shown || "（空）");
  }

  // ── 汇总 ──
  console.log(`\n${"═".repeat(70)}`);
  console.log("汇总");
  console.log("═".repeat(70));

  console.log(`\n出现过的全部 UBB 标签（次数）:`);
  if (allTags.size === 0) console.log("  （一个都没有）");
  else for (const [tag, n] of [...allTags.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  [${tag}] × ${n}`);
  }

  console.log(`\n出现过的全部链接:`);
  if (allLinks.size === 0) console.log("  （一个都没有）");
  else for (const l of allLinks) console.log(`  ${l}`);
}

main().catch(err => {
  console.error("\n❌ 出错:", err.message);
  process.exit(1);
});
