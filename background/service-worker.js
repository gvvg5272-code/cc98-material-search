/**
 * Background Service Worker
 *
 * 职责：
 * - 初始化并持有 API、搜索、下载等模块实例
 * - 监听来自 Popup 的消息并分发
 * - 管理下载队列
 * - Service Worker 唤醒时恢复状态
 */

import { AuthManager } from "../lib/auth.js";
import { CC98API } from "../lib/cc98-api.js";
import { SearchService } from "../lib/search.js";
import { parseAttachments, extractAttachmentsFromPost, collectAttachmentsFromPosts } from "../lib/attachment.js";
import { DownloadQueue, DownloadStatus } from "../lib/download-queue.js";
import { sanitizeFilename } from "../lib/sanitize.js";
import {
  DEFAULT_AI_CONFIG,
  buildTopicMessages,
  chatCompletion,
  parseAiJson,
  normalizeSummary,
  localScore,
} from "../lib/ai.js";
import { looksLikeSeeking, classifyPostType } from "../lib/triage.js";

// ── 初始化模块实例 ────────────────────────────────────────

const auth = new AuthManager();
const api = new CC98API(() => auth.getToken());
let searchService = null;
let downloadQueue = null;
let aliasConfig = {};

/**
 * 单次初始化
 *
 * 原来 initialize() 在模块顶层被直接调用、而它是异步的：
 * Service Worker 在初始化完成前就可能收到消息，此时 downloadQueue / searchService
 * 还是 null，任何涉及队列的消息（入队/暂停/查状态）都会抛 TypeError。
 * 现在改成"单飞 promise"，所有消息处理前先 await 它。
 */
let initPromise = null;

function ensureInitialized() {
  if (!initPromise) {
    initPromise = initialize().catch(err => {
      // 初始化失败不缓存失败结果，下次消息还能重试
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

// ── Service Worker 生命周期 ───────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log("CC98 科目资料检索插件已安装");
  ensureInitialized().catch(err => console.error("初始化失败:", err));
});

chrome.runtime.onStartup.addListener(() => {
  ensureInitialized().catch(err => console.error("初始化失败:", err));
});

async function initialize() {
  // 加载科目别名配置
  try {
    const url = chrome.runtime.getURL("config/subject-aliases.json");
    const res = await fetch(url);
    aliasConfig = await res.json();
  } catch {
    aliasConfig = {};
  }

  // 允许用户覆盖默认配置
  const stored = await chrome.storage.local.get("cc98_alias_config");
  if (stored.cc98_alias_config) {
    aliasConfig = { ...aliasConfig, ...stored.cc98_alias_config };
  }

  searchService = new SearchService(api, aliasConfig);
  downloadQueue = new DownloadQueue(api);
  await downloadQueue.restore();

  // 下载队列状态变更时通知 Popup
  downloadQueue.onStatusChange(() => {
    broadcastMessage({
      type: "DOWNLOAD_STATUS_UPDATE",
      status: downloadQueue.getStatus(),
      items: downloadQueue.items,
    });
  });
}

// 确保 initialize 在 Service Worker 唤醒时也执行
ensureInitialized().catch(err => console.error("初始化失败:", err));

// ── 消息处理 ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message, errorType: err.name }));

  return true; // 保持消息通道开放（异步响应）
});

async function handleMessage(message) {
  // 所有消息都先等初始化完成，保证 downloadQueue / searchService 已就绪
  await ensureInitialized();

  switch (message.type) {
    // ── 认证相关 ──
    case "SAVE_TOKEN":
      await auth.saveToken(message.token);
      return { success: true };

    case "CLEAR_TOKEN":
      await auth.clearToken();
      return { success: true };

    case "GET_TOKEN_STATUS":
      return {
        status: await auth.getTokenStatus(),
        masked: await auth.getMaskedToken(),
      };

    case "VALIDATE_TOKEN":
      return auth.validateToken();

    // ── 搜索相关 ──
    case "SEARCH":
      return performSearch(message.keyword, message.options);

    case "GET_TOPIC_DETAIL":
      return getTopicDetail(message.topicId);

    // ── 版面相关 ──
    case "GET_BOARDS":
      return api.getAllBoards();

    case "GET_HOT_TOPICS":
      return api.getHotTopics();

    // ── 下载相关 ──
    case "DOWNLOAD_FILE":
      return downloadSingleFile(message.attachment);

    case "ENQUEUE_DOWNLOAD":
      const item = downloadQueue.enqueue(message.attachment);
      return { success: !!item, item };

    case "ENQUEUE_BATCH":
      const added = downloadQueue.enqueueBatch(message.attachments);
      return { success: true, count: added.length };

    case "PAUSE_DOWNLOADS":
      downloadQueue.pause();
      return { success: true };

    case "RESUME_DOWNLOADS":
      downloadQueue.resume();
      return { success: true };

    case "CLEAR_COMPLETED_DOWNLOADS":
      downloadQueue.clearCompleted();
      return { success: true };

    case "RETRY_FAILED_DOWNLOADS":
      downloadQueue.retryFailed();
      return { success: true };

    case "GET_DOWNLOAD_STATUS":
      return {
        status: downloadQueue.getStatus(),
        items: downloadQueue.items,
      };

    // ── 别名配置 ──
    case "GET_ALIAS_CONFIG":
      return aliasConfig;

    case "UPDATE_ALIAS_CONFIG":
      await chrome.storage.local.set({ cc98_alias_config: message.config });
      aliasConfig = { ...aliasConfig, ...message.config };
      searchService.setAliasConfig(aliasConfig);
      return { success: true };

    // ── 扩展别名 ──
    case "EXPAND_ALIASES":
      return {
        aliases: searchService ? searchService.expandAliases(message.keyword) : [message.keyword],
      };

    // ── AI 总结 ──
    case "GET_AI_CONFIG": {
      const cfg = await getAiConfig();
      return {
        baseURL: cfg.baseURL,
        model: cfg.model,
        hasKey: !!cfg.apiKey,
      };
    }

    case "SET_AI_CONFIG": {
      const current = await getAiConfig();
      const incoming = message.config || {};
      const next = {
        ...current,
        baseURL: incoming.baseURL ?? current.baseURL,
        model: incoming.model ?? current.model,
        // 留空 = 不修改，避免用脱敏后的值把真实 key 覆盖掉
        apiKey: incoming.apiKey ? String(incoming.apiKey).trim() : current.apiKey,
      };
      await chrome.storage.local.set({ cc98_ai_config: next });
      return { success: true, hasKey: !!next.apiKey };
    }

    case "AI_PING":
      return aiPing();

    case "AI_SUMMARIZE_TOPIC":
      return summarizeTopic(message.topicId);

    case "TRIAGE_TOPIC":
      return triageTopic(message.topicId, message.title);

    default:
      return { error: `未知消息类型: ${message.type}` };
  }
}

// ── 业务逻辑 ──────────────────────────────────────────────

/**
 * 执行搜索
 */
async function performSearch(keyword, options = {}) {
  const token = await auth.getToken();
  if (!token) {
    return { error: "请先设置 Access Token", errorType: "NoTokenError" };
  }

  try {
    const result = await searchService.search(keyword, options);
    return result;
  } catch (e) {
    if (e.name === "TokenExpiredError") {
      await auth.setTokenStatus("expired");
    }
    return { error: e.message, errorType: e.name };
  }
}

/**
 * 获取帖子详情（含附件信息）
 */
async function getTopicDetail(topicId) {
  try {
    const topic = await api.getTopic(topicId);

    // 获取所有楼层以收集附件
    // ⚠️ from 是 0 基的：从 0 开始才包含楼主（floor 1），附件几乎都在那一层
    let allPosts = [];
    let from = 0;
    const pageSize = 20;
    const maxPages = 10; // 最多读取 10 页楼层（200 楼）

    for (let i = 0; i < maxPages; i++) {
      const posts = await api.getPosts(topicId, { from, size: pageSize });
      if (!Array.isArray(posts) || posts.length === 0) break;
      allPosts = allPosts.concat(posts);
      if (posts.length < pageSize) break;
      from += pageSize;
    }

    const attachments = collectAttachmentsFromPosts(allPosts);

    return {
      topic,
      posts: allPosts,
      attachments,
    };
  } catch (e) {
    if (e.name === "TokenExpiredError") {
      await auth.setTokenStatus("expired");
    }
    return { error: e.message, errorType: e.name };
  }
}

/**
 * 单个文件下载（立即下载，不入队）
 *
 * ⚠️ 同 lib/download-queue.js：Service Worker 里没有 URL.createObjectURL，
 * 不能走 fetch → blob → blobURL 那条路。文件是公开可下的，直接给 URL。
 */
async function downloadSingleFile(attachment) {
  if (!attachment || !attachment.url) {
    return { error: "缺少下载地址" };
  }

  try {
    await chrome.downloads.download({
      url: attachment.url,
      filename: sanitizeFilename(attachment.filename),
      saveAs: false,
    });
    return { success: true };
  } catch (e) {
    return { error: `无法开始下载: ${e?.message || e}` };
  }
}

// ── AI 总结 ──────────────────────────────────────────────

/**
 * 读取 AI 配置（key 只存在本机）
 */
async function getAiConfig() {
  const stored = await chrome.storage.local.get("cc98_ai_config");
  return { ...DEFAULT_AI_CONFIG, ...(stored.cc98_ai_config || {}) };
}

/**
 * 探活：用极小的请求确认 baseURL / model / key 都通
 */
async function aiPing() {
  const cfg = await getAiConfig();
  if (!cfg.apiKey) return { ok: false, error: "还没填 API Key" };

  const started = Date.now();
  try {
    const text = await chatCompletion(
      { ...cfg, maxTokens: 20 },
      [{ role: "user", content: "只回复两个字：可用" }],
      { timeoutMs: 30000 }
    );
    return { ok: true, model: cfg.model, latencyMs: Date.now() - started, reply: text.slice(0, 40) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 对一个帖子做总结
 *
 * 返回结构：
 *   { source: "ai", summary: {...}, local: {...} }      AI 成功
 *   { source: "local", score, reasons, reason, local }  AI 未配置/失败，退回本地打分
 */
async function summarizeTopic(topicId) {
  const detail = await getTopicDetail(topicId);
  if (detail.error) return detail;

  const { topic, posts, attachments } = detail;

  // 作者信誉：拿不到不算错
  let author = null;
  if (topic.userId && topic.userId > 0) {
    try {
      author = await api.getUser(topic.userId);
    } catch {
      author = null;
    }
  }

  const local = localScore({ topic, attachments, author });
  const cfg = await getAiConfig();

  if (!cfg.apiKey) {
    return { source: "local", ...local, reason: "还没配置 AI，以下为本地打分" };
  }

  try {
    const messages = buildTopicMessages({ topic, posts, attachments, author });
    const text = await chatCompletion(cfg, messages);
    const summary = normalizeSummary(parseAiJson(text));
    return { source: "ai", summary, local, model: cfg.model };
  } catch (e) {
    return { source: "local", ...local, reason: `AI 调用失败：${e.message}` };
  }
}

/**
 * 轻量分拣：只判断"这个帖子有没有真东西"
 *
 * 第一级只发 **1 个请求**（取 floor 1），从楼主正文里抽附件。
 * 只有抽到附件的帖子才值得再花 2 个请求（/Topic/{id} + 作者资料）去算完整分数。
 * 这样 20 条搜索结果通常只有少数几条进入第二级。
 *
 * @param {number} topicId
 * @returns {Promise<object>}
 */
async function triageTopic(topicId, title = "") {
  let posts = [];
  try {
    // 一次取前 20 层：资源楼的资料经常在 2、3 楼，
    // 只看 floor 1 会把「大二秋冬资源楼」这类帖子误判成"无附件"。
    const page = await api.getPosts(topicId, { from: 0, size: 20 });
    posts = Array.isArray(page) ? page : [];
  } catch (e) {
    return { topicId, error: e.message, attachmentCount: 0, score: 0, type: "讨论" };
  }

  const lz = posts.find(p => p.floor === 1) || posts[0] || {};
  const content = String(lz.content || "");

  // 扫**所有楼层**，不只楼主那层
  const attachments = collectAttachmentsFromPosts(posts);
  const type = classifyPostType({ title, content });

  const result = {
    topicId,
    attachmentCount: attachments.length,
    sampleFiles: attachments.slice(0, 4).map(a => a.filename),
    type,
    seeking: type === "求资料",
    score: 0,
    reasons: [],
  };

  // 没附件就不用再花请求了
  if (attachments.length === 0) {
    result.reasons = [
      type === "卖书" ? "卖书/求购帖"
        : type === "求资料" ? "看起来是在求资料"
          : "前 20 层里没有附件链接",
    ];
    return result;
  }

  // 第二级：拿收藏/精华/作者声誉
  let topic = null;
  let author = null;
  try {
    topic = await api.getTopic(topicId);
  } catch { /* 拿不到就用默认值打分 */ }

  if (topic?.userId > 0) {
    try {
      author = await api.getUser(topic.userId);
    } catch { author = null; }
  }

  const scored = localScore({
    topic: topic || { replyCount: 0 },
    attachments,
    author,
  });

  result.score = scored.score;
  result.reasons = scored.reasons;
  result.authorName = author?.name || topic?.userName || null;
  result.authorPopularity = author?.popularity ?? null;
  result.favoriteCount = topic?.favoriteCount ?? null;

  return result;
}

// ── 广播消息到 Popup ──────────────────────────────────────

function broadcastMessage(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup 未打开时忽略错误
  });
}
