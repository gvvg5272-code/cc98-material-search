/**
 * AI 总结模块
 *
 * 设计原则：
 * 1. **OpenAI 兼容**：只认 `{baseURL}/v1/chat/completions` 这种标准形状，
 *    所以 DeepSeek / OpenAI / Moonshot / 本地 Ollama 都能用，不写死任何一家。
 * 2. **key 只存本机**：`chrome.storage.local`，不写进代码、不进日志。
 * 3. **AI 挂了不能变成废功能**：`localScore()` 提供纯本地的可解释打分，
 *    没配 key 或调用失败时用它兜底。
 * 4. **省 token**：正文截断、只取高赞回复、附件名全量（名字很短且信息量大）。
 */

export const DEFAULT_AI_CONFIG = {
  baseURL: "https://api.deepseek.com",
  model: "deepseek-chat",
  apiKey: "",
  enabled: false,
  maxTokens: 700,
};

/** 送进模型的正文上限（字符） */
const CONTENT_LIMIT = 6000;
/** 送进模型的高赞回复条数与单条上限 */
const REPLY_LIMIT = 5;
const REPLY_CHAR_LIMIT = 300;

/**
 * 拼出 chat/completions 的完整地址
 * @param {string} baseURL
 * @returns {string}
 */
export function buildEndpoint(baseURL) {
  let base = String(baseURL || "").trim().replace(/\/+$/, "");
  if (!base) base = DEFAULT_AI_CONFIG.baseURL;
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * 从 URL 取出 origin，用于申请 host 权限
 * @param {string} baseURL
 * @returns {string|null}
 */
export function originOf(baseURL) {
  try {
    return new URL(baseURL).origin;
  } catch {
    return null;
  }
}

/**
 * 组装给模型的消息
 *
 * @param {object} input
 * @param {object} input.topic - /Topic/{id} 的返回
 * @param {Array} input.posts - 楼层数组
 * @param {Array} input.attachments - collectAttachmentsFromPosts 的结果
 * @param {object|null} input.author - /user/{id} 的返回
 * @returns {Array<{role: string, content: string}>}
 */
export function buildTopicMessages({ topic, posts, attachments, author }) {
  const lz = (posts || []).find(p => p.floor === 1) || posts?.[0] || {};

  const lzContent = String(lz.content || "").slice(0, CONTENT_LIMIT);
  const truncated = String(lz.content || "").length > CONTENT_LIMIT;

  const attachmentList = (attachments || []).length
    ? attachments.map((a, i) => `${i + 1}. ${a.filename}`).join("\n")
    : "（没有解析到 file.cc98.org 上的附件链接）";

  const topReplies = [...(posts || [])]
    .filter(p => p.floor !== 1 && String(p.content || "").trim())
    .sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))
    .slice(0, REPLY_LIMIT)
    .map(p => {
      const text = String(p.content).replace(/\s+/g, " ").slice(0, REPLY_CHAR_LIMIT);
      return `- [${p.likeCount || 0} 赞] ${p.userName || "匿名"}：${text}`;
    })
    .join("\n") || "（无）";

  const authorLine = author
    ? `${author.name}（风评值 ${author.popularity ?? 0}，威望 ${author.prestige ?? 0}，粉丝 ${author.fanCount ?? 0}，获赞 ${author.receivedLikeCount ?? 0}，发帖 ${author.postCount ?? 0}）`
    : (topic.userName || "未知");

  const system = [
    "你是一个帮大学生筛选学习资料的助手。",
    "用户从 CC98 论坛（浙大校内论坛）搜索到一个帖子，需要你判断它到底有没有可用的学习资料、值不值得下载。",
    "注意：很多帖子的标题看起来像分享资料，实际上是「求资料」「求推荐」或者只是讨论。请重点区分。",
    "只输出一个 JSON 对象，不要输出 JSON 以外的任何文字、不要加 markdown 代码块。",
  ].join("");

  const user = [
    "【帖子信息】",
    `标题：${topic.title || ""}`,
    `版面：${topic.boardName || topic.boardId || ""}`,
    `作者：${authorLine}`,
    `数据：回复 ${topic.replyCount ?? 0}，浏览 ${topic.hitCount ?? 0}，点赞 ${topic.likeCount ?? 0}，收藏 ${topic.favoriteCount ?? 0}，精华 ${topic.bestState ? "是" : "否"}`,
    "",
    "【楼主正文】",
    lzContent || "（空）",
    truncated ? `……（正文共 ${String(lz.content).length} 字，已截断）` : "",
    "",
    `【解析到的附件】共 ${(attachments || []).length} 个`,
    attachmentList,
    "",
    "【点赞最高的回复】",
    topReplies,
    "",
    "请输出 JSON，字段如下：",
    "{",
    '  "kind": "分享" 或 "求资料" 或 "讨论" 或 "其他",',
    '  "worth": 1 到 5 的整数（5 = 强烈建议下载，1 = 别下）,',
    '  "oneLine": "一句话结论，30 字以内",',
    '  "has": ["这份帖子里实际包含的资料，逐项列出；没有就空数组"],',
    '  "missing": "缺什么、有什么坑；没有就空字符串",',
    '  "advice": "给下载者的建议，40 字以内"',
    "}",
  ].filter(Boolean).join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 调用 OpenAI 兼容的 chat/completions
 *
 * @param {object} config - { baseURL, model, apiKey, maxTokens }
 * @param {Array} messages
 * @param {object} [options]
 * @param {number} [options.timeoutMs=60000]
 * @returns {Promise<string>} - 模型返回的文本
 */
export async function chatCompletion(config, messages, options = {}) {
  const endpoint = buildEndpoint(config.baseURL);
  const timeoutMs = options.timeoutMs ?? 60000;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey || ""}`,
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_AI_CONFIG.model,
      messages,
      temperature: 0.2,
      max_tokens: config.maxTokens || DEFAULT_AI_CONFIG.maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();

  if (!res.ok) {
    // 常见状态码翻译成人话，别把原始 JSON 甩给用户
    if (res.status === 401) throw new Error("API Key 无效或已过期（HTTP 401）");
    if (res.status === 403) throw new Error("没有访问该模型的权限（HTTP 403）");
    if (res.status === 404) throw new Error(`接口不存在，检查 baseURL（HTTP 404）：${endpoint}`);
    if (res.status === 429) throw new Error("请求太频繁或额度用尽（HTTP 429）");
    const brief = text.replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`AI 接口报错 (HTTP ${res.status})：${brief}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`AI 返回的不是 JSON：${text.slice(0, 200)}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 返回内容为空");
  return String(content);
}

/**
 * 从模型输出里抠出 JSON
 *
 * 模型经常会加 ```json 围栏或者前后废话，这里容错处理。
 * @param {string} text
 * @returns {object}
 */
export function parseAiJson(text) {
  let s = String(text || "").trim();

  // 去掉 markdown 代码围栏
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  // 直接试
  try {
    return JSON.parse(s);
  } catch { /* 继续尝试 */ }

  // 抠第一个 { 到最后一个 }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch { /* 落到报错 */ }
  }

  throw new Error(`AI 返回的不是合法 JSON：${s.slice(0, 160)}`);
}

/**
 * 校验并归一化 AI 结果
 * @param {object} raw
 * @returns {{kind: string, worth: number, oneLine: string, has: string[], missing: string, advice: string}}
 */
export function normalizeSummary(raw) {
  const kinds = new Set(["分享", "求资料", "讨论", "其他"]);
  const worth = Math.round(Number(raw?.worth));

  return {
    kind: kinds.has(raw?.kind) ? raw.kind : "其他",
    worth: Number.isFinite(worth) ? Math.min(5, Math.max(1, worth)) : 3,
    oneLine: String(raw?.oneLine || "").slice(0, 120),
    has: Array.isArray(raw?.has) ? raw.has.slice(0, 20).map(x => String(x).slice(0, 120)) : [],
    missing: String(raw?.missing || "").slice(0, 200),
    advice: String(raw?.advice || "").slice(0, 200),
  };
}

/**
 * 纯本地打分（不依赖 AI）
 *
 * 用途：没配 key、AI 报错、或用户就想快速看一眼时兜底。
 * 分数是**可解释**的：返回每一项的加减分理由。
 *
 * @param {object} input - { topic, attachments, author }
 * @returns {{score: number, reasons: string[]}}
 */
export function localScore({ topic, attachments, author }) {
  let score = 0;
  const reasons = [];

  const attCount = (attachments || []).length;
  if (attCount > 0) {
    const add = Math.min(attCount * 8, 40);
    score += add;
    reasons.push(`解析到 ${attCount} 个附件（+${add}）`);
  } else {
    reasons.push("没解析到附件（+0）");
  }

  const likes = topic.likeCount || 0;
  if (likes > 0) {
    const add = Math.min(likes * 2, 20);
    score += add;
    reasons.push(`帖子被点赞 ${likes} 次（+${add}）`);
  }

  const favs = topic.favoriteCount || 0;
  if (favs > 0) {
    const add = Math.min(favs * 3, 15);
    score += add;
    reasons.push(`被收藏 ${favs} 次（+${add}）`);
  }

  if (topic.bestState) {
    score += 10;
    reasons.push("精华帖（+10）");
  }

  const replies = topic.replyCount || 0;
  if (replies >= 20) {
    score += 10;
    reasons.push(`回复 ${replies} 条，讨论活跃（+10）`);
  } else if (replies >= 5) {
    score += 5;
    reasons.push(`回复 ${replies} 条（+5）`);
  }

  if (author) {
    const rep = (author.popularity || 0) + Math.min((author.receivedLikeCount || 0) / 50, 10);
    if (rep > 0) {
      const add = Math.min(Math.round(rep), 15);
      score += add;
      reasons.push(`作者风评值 ${author.popularity ?? 0}、获赞 ${author.receivedLikeCount ?? 0}（+${add}）`);
    }
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}
