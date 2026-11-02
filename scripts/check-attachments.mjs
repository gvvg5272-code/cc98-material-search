#!/usr/bin/env node

/**
 * 附件链路真机自检
 *
 * 用**真实的 lib 代码**去读一个真实帖子，打印解析出来的附件。
 * 这是"离线测试通过"和"线上真的能用"之间的最后一道验证。
 *
 * 用法：
 *   node scripts/check-attachments.mjs --token <token> --topic 6651651
 */

import { CC98API } from "../lib/cc98-api.js";
import { collectAttachmentsFromPosts } from "../lib/attachment.js";

const PAGE_SIZE = 20;
const MAX_POSTS = 200;

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

async function main() {
  const args = parseArgs();
  const token = args.token || process.env.CC98_TOKEN;
  const topicId = args.topic;

  if (!token) {
    console.error("需要 --token <token>");
    process.exit(1);
  }
  if (!topicId) {
    console.error("需要 --topic <帖子ID>");
    process.exit(1);
  }

  const api = new CC98API(async () => token);

  const topic = await api.getTopic(topicId);
  console.log(`\n帖子: ${topic.title}`);
  console.log(`作者: ${topic.userName}   回复数: ${topic.replyCount}`);

  // 与 background/service-worker.js 里的 getTopicDetail 保持同样的取法
  const posts = [];
  let from = 0;
  while (posts.length < MAX_POSTS) {
    const page = await api.getPosts(topicId, { from, size: PAGE_SIZE });
    if (!Array.isArray(page) || page.length === 0) break;
    posts.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const floors = posts.map(p => p.floor);
  console.log(`\n取到楼层: ${posts.length} 层（${Math.min(...floors)} ~ ${Math.max(...floors)}）`);

  const hasFirstFloor = floors.includes(1);
  console.log(`含楼主（floor 1）: ${hasFirstFloor ? "✅ 是" : "❌ 否 —— 附件大概率漏掉了"}`);

  const attachments = collectAttachmentsFromPosts(posts);
  console.log(`\n解析到附件: ${attachments.length} 个`);
  for (const [i, att] of attachments.entries()) {
    console.log(`  ${i + 1}. ${att.filename}`);
    console.log(`     ${att.url}`);
  }

  if (attachments.length === 0) {
    console.log("\n⚠️ 一个都没解析到。下一步：看楼主那层的正文长什么样。");
    const first = posts.find(p => p.floor === 1);
    if (first) {
      console.log("\n--- floor 1 正文（前 800 字符）---");
      console.log(String(first.content).slice(0, 800));
    }
  }
}

main().catch(err => {
  console.error("\n❌ 出错:", err.message);
  process.exit(1);
});
