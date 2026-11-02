#!/usr/bin/env node

/**
 * 从前端 bundle 里找接口
 *
 * 用途：某些数据（比如"风评值"）不在已知的 API 返回里，
 * 但前端一定会调用某个接口去拿它。直接翻前端 JS 比瞎猜端点快得多。
 *
 * 用法：
 *   node scripts/probe-frontend.mjs 风评
 *   node scripts/probe-frontend.mjs "风评值" "/Rate"
 *
 * 只下载静态资源，不需要 Token，不写任何东西。
 */

const BASE = "https://www.cc98.org";

const terms = process.argv.slice(2);
if (!terms.length) {
  console.error("用法: node probe-frontend.mjs <关键词> [关键词2 ...]");
  process.exit(1);
}

// 中文在 bundle 里可能是 \uXXXX 转义，两种都搜
function escapeVariants(term) {
  const variants = new Set([term]);
  if (/[\u4e00-\u9fa5]/.test(term)) {
    const escaped = [...term]
      .map(ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    variants.add(escaped);
  }
  return [...variants];
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

function findScriptUrls(html) {
  const urls = new Set();
  const re = /<script[^>]+src=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    urls.add(new URL(m[1], BASE).toString());
  }
  // Vite 常用 modulepreload
  const re2 = /<link[^>]+href=["']([^"']+\.js)["']/g;
  while ((m = re2.exec(html)) !== null) {
    urls.add(new URL(m[1], BASE).toString());
  }
  return [...urls];
}

function contextAround(text, index, radius = 160) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, " ");
}

async function main() {
  console.log(`\n拉取 ${BASE}/ …`);
  const html = await fetchText(BASE + "/");
  console.log(`HTML 长度: ${html.length}`);

  const scripts = findScriptUrls(html);
  console.log(`发现 ${scripts.length} 个 JS 入口:`);
  for (const s of scripts) console.log(`  ${s}`);

  // 递归一层：入口里可能再 import 其他 chunk
  const visited = new Set();
  const queue = [...scripts];
  const allBodies = [];

  while (queue.length && visited.size < 40) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let body;
    try {
      body = await fetchText(url);
    } catch (e) {
      console.log(`  ! 跳过 ${url}: ${e.message}`);
      continue;
    }
    allBodies.push({ url, body });
    console.log(`  ✓ ${url} (${body.length} 字节)`);

    // 从 chunk 里再挖同源的 .js
    const re = /["'](\.{0,2}\/[^"']+?\.js)["']/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      try {
        const next = new URL(m[1], url).toString();
        if (next.startsWith(BASE) && !visited.has(next)) queue.push(next);
      } catch { /* 忽略坏路径 */ }
    }
  }

  console.log(`\n共下载 ${allBodies.length} 个 JS，开始搜索…\n`);

  for (const term of terms) {
    const variants = escapeVariants(term);
    console.log("═".repeat(70));
    console.log(`搜索: ${term}${variants.length > 1 ? ` （含转义形式 ${variants[1]}）` : ""}`);
    console.log("═".repeat(70));

    let total = 0;
    for (const { url, body } of allBodies) {
      for (const v of variants) {
        let idx = body.indexOf(v);
        let shown = 0;
        while (idx !== -1 && shown < 5) {
          total++;
          shown++;
          console.log(`\n[${url.split("/").pop()}] @${idx}`);
          console.log(`  …${contextAround(body, idx)}…`);
          idx = body.indexOf(v, idx + v.length);
        }
      }
    }
    if (total === 0) console.log("\n  （没找到）");
  }
}

main().catch(err => {
  console.error("出错:", err);
  process.exit(1);
});
