/**
 * Popup 交互逻辑
 *
 * 负责：
 * - 标签页切换
 * - 搜索输入与结果展示
 * - Token 设置与验证
 * - 下载队列状态展示与控制
 * - 与 Service Worker 的消息通信
 */

import { escapeHtml } from "../lib/sanitize.js";
import { normalizeToken, looksLikeJwt } from "../lib/token.js";
import { rankTriage, triageBadge, filterWithMaterial } from "../lib/triage.js";

// ── 消息通信 ──────────────────────────────────────────────

function sendMessage(type, data = {}) {
  return chrome.runtime.sendMessage({ type, ...data });
}

// ── 标签页切换 ────────────────────────────────────────────

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${tab}`).classList.add("active");

    if (tab === "downloads") refreshDownloadList();
    if (tab === "settings") loadSettings();
  });
});

// ── 搜索视图 ──────────────────────────────────────────────

const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const searchStatus = document.getElementById("search-status");
const searchStatusText = document.getElementById("search-status-text");
const searchResults = document.getElementById("search-results");
const aliasHint = document.getElementById("alias-hint");
const aliasList = document.getElementById("alias-list");
const tokenHint = document.getElementById("token-hint");
const tokenHintText = document.getElementById("token-hint-text");
const tokenHintAction = document.getElementById("token-hint-action");
const boardFilter = document.getElementById("board-filter");
const conditionFilter = document.getElementById("condition-filter");

let currentSearchKeyword = "";
let currentSearchOptions = {};
let searchResultCache = []; // 缓存搜索结果，用于附件展开

// 搜索输入时展开别名提示
let aliasDebounce = null;
searchInput.addEventListener("input", () => {
  clearTimeout(aliasDebounce);
  aliasDebounce = setTimeout(() => {
    const kw = searchInput.value.trim();
    if (kw.length >= 2) {
      sendMessage("EXPAND_ALIASES", { keyword: kw }).then(res => {
        if (res.aliases && res.aliases.length > 1) {
          aliasHint.style.display = "block";
          aliasList.textContent = res.aliases.join("、");
        } else {
          aliasHint.style.display = "none";
        }
      });
    } else {
      aliasHint.style.display = "none";
    }
  }, 300);
});

// 搜索
searchBtn.addEventListener("click", doSearch);
searchInput.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });

async function doSearch() {
  const keyword = searchInput.value.trim();
  if (!keyword) return;

  const boardId = parseInt(boardFilter.value) || 0;
  const condition = conditionFilter.value ? parseInt(conditionFilter.value) : undefined;

  // 用户选的条数 → 页数（接口一页固定 20 条，size 上限就是 20）
  const maxPages = parseInt(document.getElementById("result-count").value) || 3;

  currentSearchKeyword = keyword;
  currentSearchOptions = { boardId, condition, maxPages };

  showSearchStatus(`搜索中…（最多 ${maxPages * 20} 条，每页约 3 秒）`, "loading");
  searchResults.innerHTML = "";
  searchResultCache = [];

  const res = await sendMessage("SEARCH", { keyword, options: currentSearchOptions });

  if (res.error) {
    showSearchStatus(res.error, "error");
    if (res.errorType === "NoTokenError" || res.errorType === "TokenExpiredError") {
      showTokenHint(res.error);
    }
    return;
  }

  searchResultCache = res.results || [];
  hideSearchStatus();

  if (searchResultCache.length === 0) {
    searchResults.innerHTML = renderEmpty("未找到相关帖子");
    return;
  }

  showSearchStatus(`找到 ${searchResultCache.length} 条结果（搜索了：${res.searchedKeywords?.join("、") || keyword}）`);
  renderSearchResults(searchResultCache);

  // 自动分拣：逐条扫描前 20 层，剔除没资料的
  startTriage();
}

// ── 自动分拣 ──────────────────────────────────────────────

const onlyMaterial = document.getElementById("only-material");
let triageToken = 0;

/** 扫描上限：只作为一个兜底，正常等于用户选择的结果数（20/60/100） */
const MAX_TRIAGE = 120;

/**
 * 逐条扫描搜索结果，标注"有没有资料"，最后按价值重排
 *
 * 采用**逐条推进**而不是一次请求全部：这样界面上能实时看到进度，
 * 而且每条之间天然被 API 的频率锁隔开，不会打爆接口。
 */
async function startTriage() {
  const token = ++triageToken;
  // ⚠️ 必须扫描**全部**结果。之前限制 30 条，而用户可能选了 60 条，
  // 后 30 条永远没有 _triage，导致下面的筛选判断直接失效（看似没生效）。
  const list = searchResultCache.slice(0, MAX_TRIAGE);
  if (!list.length) return;

  const total = list.length;
  let done = 0;
  let found = 0;

  for (const topic of list) {
    if (token !== triageToken) return; // 开了新搜索，这轮作废

    const info = await sendMessage("TRIAGE_TOPIC", { topicId: topic.id, title: topic.title });
    if (token !== triageToken) return;

    done++;
    if (info && !info.error) {
      topic._triage = info;
      if ((info.attachmentCount || 0) > 0) found++;
    } else if (info && info.error) {
      // 扫描失败：标记出来，不要混进"无资料"里被悄悄折叠
      topic._triageError = info.error;
    }
    paintBadge(topic, info);

    showSearchStatus(`正在自动筛选 ${done}/${total}（已找到 ${found} 条有资料）`, "loading");
  }

  if (token !== triageToken) return;

  searchResultCache = rankTriage(searchResultCache);

  // 一条有资料的都没有时，别让用户面对一个空列表
  if (found === 0 && onlyMaterial.checked) {
    onlyMaterial.checked = false;
    renderSearchResults(searchResultCache);
    showSearchStatus(`扫描完成：这 ${total} 条都没解析到附件链接（已自动取消「只看有资料的」）`);
    return;
  }

  const shown = visibleResults();
  renderSearchResults(shown);

  const hidden = searchResultCache.length - shown.length;
  const tail = onlyMaterial.checked && hidden > 0 ? `，已折叠 ${hidden} 条无资料结果` : "";
  showSearchStatus(`扫描完成：${found}/${total} 条有实际资料${tail}`);
}

function paintBadge(topic, info) {
  const idx = searchResultCache.indexOf(topic);
  if (idx < 0) return;
  const el = document.getElementById(`badge-${idx}`);
  if (!el) return;

  if (info && info.error) {
    el.textContent = "扫描失败";
    el.className = "result-badge badge-meh";
    return;
  }

  const { text, tone } = triageBadge(info);
  el.textContent = text;
  el.className = `result-badge badge-${tone}`;
}

/** 渲染结果行上的分拣标签（带 id 便于逐条实时更新） */
function badgeHtml(triage, idx) {
  const { text, tone } = triageBadge(triage);
  return `<span class="result-badge badge-${tone}" id="badge-${idx}">${escapeHtml(text)}</span>`;
}

/**
 * 当前该显示哪些结果（受"只看有资料的"开关影响）
 *
 * ⚠️ 必须**逐条**判断。早期版本用 `list.every(t => t._triage)` 当全局开关，
 * 结果是：只要有一条没扫到（或扫描失败），every() 就是 false，
 * 整个筛选被静默跳过——用户看到的效果就是"这个开关没用"。
 */
function visibleResults() {
  return filterWithMaterial(searchResultCache, !!(onlyMaterial && onlyMaterial.checked));
}

onlyMaterial.addEventListener("change", () => {
  if (!searchResultCache.length) return;
  renderSearchResults(visibleResults());
});

// 加载版面列表
async function loadBoards() {
  try {
    const boards = await sendMessage("GET_BOARDS");
    if (Array.isArray(boards)) {
      for (const category of boards) {
        const categoryBoards = category.boards || category.subBoards;
        if (categoryBoards && Array.isArray(categoryBoards)) {
          const group = document.createElement("optgroup");
          group.label = category.name || category.categoryName || "";
          addBoardOptions(group, categoryBoards, 0);
          boardFilter.appendChild(group);
        }
      }
    }
  } catch {
    // 版面列表加载失败不影响使用
  }
}

function addBoardOptions(group, boards, depth) {
  const indent = depth > 0 ? "\u00A0\u00A0".repeat(depth) + "└ " : "";
  for (const board of boards) {
    const opt = document.createElement("option");
    opt.value = board.id || board.boardId;
    opt.textContent = indent + (board.name || board.boardName);
    group.appendChild(opt);

    // 递归处理子版面
    const children = board.boards || board.subBoards || board.children;
    if (Array.isArray(children) && children.length > 0) {
      addBoardOptions(group, children, depth + 1);
    }
  }
}

// 渲染搜索结果
function renderSearchResults(results) {
  if (!results.length) {
    searchResults.innerHTML = renderEmpty("没有「有资料」的结果（取消勾选「只看有资料的」可查看全部）");
    return;
  }

  searchResults.innerHTML = results.map((topic, idx) => `
    <div class="result-item" data-index="${idx}">
      <a class="result-title" href="https://www.cc98.org/topic/${topic.id}" target="_blank" title="${escapeHtml(topic.title)}">
        ${escapeHtml(topic.title)}
      </a>
      <div class="result-meta">
        <span class="result-meta-item">📋 ${escapeHtml(topic.boardName || "")}</span>
        <span class="result-meta-item">👤 ${escapeHtml(topicAuthor(topic))}</span>
        <span class="result-meta-item">📅 ${escapeHtml(formatDate(topicTime(topic)))}</span>
        <span class="result-meta-item">💬 ${topic.replyCount ?? 0}</span>
        <span class="result-meta-item">👁 ${topic.hitCount ?? 0}</span>
      </div>
      <div class="result-actions">
        ${badgeHtml(topic._triage, idx)}        <button class="btn-secondary attachment-load-btn" data-topic-id="${topic.id}" data-index="${idx}">
          📎 查看附件
        </button>
        <button class="btn-secondary ai-summary-btn" data-topic-id="${topic.id}" data-index="${idx}">
          🤖 总结
        </button>
      </div>
      <div class="result-attachments" id="attachments-${idx}" style="display:none;"></div>
      <div class="result-ai" id="ai-${idx}" style="display:none;"></div>
    </div>
  `).join("");

  // 绑定"查看附件"按钮
  searchResults.querySelectorAll(".attachment-load-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const topicId = parseInt(btn.dataset.topicId);
      const idx = parseInt(btn.dataset.index);
      const container = document.getElementById(`attachments-${idx}`);

      if (container.style.display !== "none" && container.innerHTML) {
        container.style.display = "none";
        btn.textContent = "📎 查看附件";
        return;
      }

      btn.disabled = true;
      btn.textContent = "⏳ 加载中…";

      const res = await sendMessage("GET_TOPIC_DETAIL", { topicId });
      btn.disabled = false;

      if (res.error) {
        btn.textContent = "❌ 加载失败";
        container.innerHTML = `<div class="hint-error" style="padding:4px 8px;font-size:11px;">${escapeHtml(res.error)}</div>`;
        container.style.display = "block";
        return;
      }

      const attachments = res.attachments || [];
      if (attachments.length === 0) {
        btn.textContent = "📎 无附件";
        container.innerHTML = '<div style="padding:4px 8px;font-size:11px;color:#999;">此帖子没有附件</div>';
        container.style.display = "block";
        return;
      }

      btn.textContent = `📎 ${attachments.length} 个附件`;
      container.innerHTML = renderAttachments(attachments);
      container.style.display = "block";

      // 绑定下载和入队按钮
      bindAttachmentButtons(container, attachments);
    });
  });

  // 绑定 "AI 总结" 按钮
  searchResults.querySelectorAll(".ai-summary-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const topicId = parseInt(btn.dataset.topicId);
      const idx = parseInt(btn.dataset.index);
      const box = document.getElementById(`ai-${idx}`);

      if (box.style.display !== "none" && box.innerHTML) {
        box.style.display = "none";
        btn.textContent = "🤖 总结";
        return;
      }

      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "⏳ 分析中…";

      const res = await sendMessage("AI_SUMMARIZE_TOPIC", { topicId });

      btn.disabled = false;
      btn.textContent = original;

      box.innerHTML = renderAiCard(res);
      box.style.display = "block";
    });
  });
}

/**
 * 把 AI / 本地打分结果渲染成卡片
 */
function renderAiCard(res) {
  if (!res) return '<div class="hint-error">没有返回结果</div>';
  if (res.error) return `<div class="hint-error">${escapeHtml(res.error)}</div>`;

  const parts = [];

  if (res.source === "ai" && res.summary) {
    const s = res.summary;
    const stars = "★".repeat(s.worth) + "☆".repeat(5 - s.worth);
    const kindClass = s.kind === "分享" ? "ai-kind-share" : "ai-kind-no";
    parts.push(`
      <div class="ai-head">
        <span class="ai-kind ${kindClass}">${escapeHtml(s.kind)}</span>
        <span class="ai-stars">${stars}</span>
        <span class="ai-oneline">${escapeHtml(s.oneLine)}</span>
      </div>`);

    if (s.has.length) {
      parts.push(`<div class="ai-block"><b>包含</b><ul>${s.has.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>`);
    }
    if (s.missing) parts.push(`<div class="ai-block"><b>缺少/注意</b>${escapeHtml(s.missing)}</div>`);
    if (s.advice) parts.push(`<div class="ai-block"><b>建议</b>${escapeHtml(s.advice)}</div>`);
    parts.push(`<div class="ai-foot">模型 ${escapeHtml(res.model || "")} ｜ 本地分 ${res.local?.score ?? "-"}</div>`);
  } else {
    parts.push(`
      <div class="ai-head">
        <span class="ai-kind ai-kind-no">本地打分</span>
        <span class="ai-stars">${res.score ?? 0} / 100</span>
      </div>`);
    if (res.reason) parts.push(`<div class="ai-block ai-warn">${escapeHtml(res.reason)}</div>`);
    if (Array.isArray(res.reasons) && res.reasons.length) {
      parts.push(`<div class="ai-block"><b>依据</b><ul>${res.reasons.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>`);
    }
  }

  return parts.join("");
}

// 渲染附件列表
function renderAttachments(attachments) {
  return attachments.map((att, i) => {
    const cat = getAttachmentCategory(att.filename);
    return `
      <div class="attachment-item">
        <span class="attachment-icon">${cat.icon}</span>
        <span class="attachment-name" title="${escapeHtml(att.filename)}">${escapeHtml(att.filename)}</span>
        <button class="btn-primary attachment-download-btn" data-index="${i}" title="立即下载">下载</button>
        <button class="btn-secondary attachment-enqueue-btn" data-index="${i}" title="加入下载队列">入队</button>
      </div>
    `;
  }).join("");
}

function bindAttachmentButtons(container, attachments) {
  container.querySelectorAll(".attachment-download-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const att = attachments[parseInt(btn.dataset.index)];
      btn.disabled = true;
      btn.textContent = "下载中…";
      const res = await sendMessage("DOWNLOAD_FILE", { attachment: att });
      btn.disabled = false;
      btn.textContent = res.success ? "✅" : "❌";
      if (!res.success) btn.title = res.error;
    });
  });

  container.querySelectorAll(".attachment-enqueue-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const att = attachments[parseInt(btn.dataset.index)];
      const res = await sendMessage("ENQUEUE_DOWNLOAD", { attachment: att });
      btn.textContent = res.success ? "已入队" : "已在队列";
      btn.disabled = true;
    });
  });
}

function showSearchStatus(text, type = "") {
  searchStatus.style.display = "block";
  searchStatusText.textContent = text;
  searchStatus.className = `status-bar ${type}`;
}

function hideSearchStatus() {
  searchStatus.style.display = "none";
}

function showTokenHint(text) {
  tokenHint.style.display = "flex";
  tokenHintText.textContent = text;
}

tokenHintAction.addEventListener("click", () => {
  document.querySelector('[data-tab="settings"]').click();
});

// ── 下载视图 ──────────────────────────────────────────────

const downloadList = document.getElementById("download-list");
const downloadSummary = document.getElementById("download-summary");
const dlPauseBtn = document.getElementById("dl-pause-btn");
const dlResumeBtn = document.getElementById("dl-resume-btn");
const dlRetryBtn = document.getElementById("dl-retry-btn");
const dlClearBtn = document.getElementById("dl-clear-btn");

dlPauseBtn.addEventListener("click", () => sendMessage("PAUSE_DOWNLOADS").then(refreshDownloadList));
dlResumeBtn.addEventListener("click", () => sendMessage("RESUME_DOWNLOADS").then(refreshDownloadList));
dlRetryBtn.addEventListener("click", () => sendMessage("RETRY_FAILED_DOWNLOADS").then(refreshDownloadList));
dlClearBtn.addEventListener("click", () => sendMessage("CLEAR_COMPLETED_DOWNLOADS").then(refreshDownloadList));

async function refreshDownloadList() {
  const res = await sendMessage("GET_DOWNLOAD_STATUS");
  if (!res || !res.status) return;

  const { status, items } = res;

  downloadSummary.textContent = `总计 ${status.total} | 等待 ${status.pending} | 下载中 ${status.downloading} | 完成 ${status.completed} | 失败 ${status.failed}`;

  dlPauseBtn.disabled = status.pending === 0 && status.downloading === 0;
  dlResumeBtn.disabled = status.pending === 0;
  dlRetryBtn.disabled = status.failed === 0;
  dlClearBtn.disabled = status.completed === 0 && status.failed === 0;

  if (!items || items.length === 0) {
    downloadList.innerHTML = renderEmpty("下载队列为空");
    return;
  }

  downloadList.innerHTML = items.map(item => `
    <div class="download-item">
      <span class="download-item-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</span>
      <span class="download-item-status status-${item.status}">${statusLabel(item.status)}</span>
      ${item.error ? `<span class="download-item-error" title="${escapeHtml(item.error)}">${escapeHtml(item.error)}</span>` : ""}
    </div>
  `).join("");
}

function statusLabel(status) {
  const labels = { pending: "等待", downloading: "下载中", completed: "完成", failed: "失败", skipped: "跳过" };
  return labels[status] || status;
}

// 监听 Service Worker 推送的下载状态更新
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "DOWNLOAD_STATUS_UPDATE") {
    // 仅在下载标签页激活时更新
    if (document.getElementById("tab-downloads").classList.contains("active")) {
      refreshDownloadList();
    }
  }
});

// ── 设置视图 ──────────────────────────────────────────────

const tokenInput = document.getElementById("token-input");
const tokenSaveBtn = document.getElementById("token-save-btn");
const tokenValidateBtn = document.getElementById("token-validate-btn");
const tokenSyncBtn = document.getElementById("token-sync-btn");
const tokenStatusText = document.getElementById("token-status-text");
const aliasEditor = document.getElementById("alias-editor");
const aliasSaveBtn = document.getElementById("alias-save-btn");

tokenSaveBtn.addEventListener("click", async () => {
  const raw = tokenInput.value.trim();
  if (!raw) return;
  tokenSaveBtn.disabled = true;

  const token = normalizeToken(raw);

  await sendMessage("SAVE_TOKEN", { token });
  tokenInput.value = "";
  tokenSaveBtn.disabled = false;

  // 保存后自动验证
  await updateTokenStatus();
  const res = await sendMessage("VALIDATE_TOKEN");
  if (res && res.valid) {
    showTokenHint("Token 有效，可以开始搜索了");
    setTimeout(() => { tokenHint.style.display = "none"; }, 2000);
  }
});

/**
 * 直接从已登录的 CC98 标签页读出 Token
 *
 * Token 就存在 CC98 页面的 localStorage 里，插件有 www.cc98.org 的 host 权限，
 * 所以可以把这个值读回来——用户不用再手动复制粘贴。
 *
 * 注意：executeScript 的 func 跑在页面的隔离世界（isolated world），
 * 拿到的 localStorage 是**页面源**的存储，正是我们要的那个。
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function syncTokenFromCc98Tab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://www.cc98.org/*" });
  } catch (e) {
    return { ok: false, reason: `无法枚举标签页: ${e.message}` };
  }

  if (!tabs.length) {
    return { ok: false, reason: "没有打开的 CC98 页面，请先打开 www.cc98.org 并登录" };
  }

  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          try {
            return localStorage.getItem("accessToken");
          } catch {
            return null;
          }
        },
      });

      const raw = injection?.result;
      if (!raw) continue;

      const token = normalizeToken(raw);
      if (!looksLikeJwt(token)) continue;

      await sendMessage("SAVE_TOKEN", { token });
      return { ok: true };
    } catch {
      // 这个标签页没权限/已关闭，换下一个
    }
  }

  return { ok: false, reason: "CC98 页面里没读到 Token（可能还没登录）" };
}

/**
 * 静默同步：只在本机还没有有效 Token 时才去读，
 * 避免把用户手动粘贴的 Token 覆盖掉。
 */
async function trySilentTokenSync() {
  try {
    const status = await sendMessage("GET_TOKEN_STATUS");
    if (status && status.status === "valid") return;
    await syncTokenFromCc98Tab();
  } catch {
    // 静默失败，回退到手动方式
  }
}

tokenSyncBtn.addEventListener("click", async () => {
  tokenSyncBtn.disabled = true;
  tokenStatusText.textContent = "正在从 CC98 页面读取…";
  const res = await syncTokenFromCc98Tab();
  tokenSyncBtn.disabled = false;

  if (!res.ok) {
    tokenStatusText.className = "unknown";
    tokenStatusText.textContent = `❌ ${res.reason}`;
    return;
  }

  const v = await sendMessage("VALIDATE_TOKEN");
  if (v && v.valid) {
    tokenStatusText.className = "valid";
    tokenStatusText.textContent = `✅ 已同步并验证通过（${v.user?.name || v.user?.userName || "unknown"}）`;
  } else {
    tokenStatusText.className = "expired";
    tokenStatusText.textContent = `⚠️ 读到了 Token 但验证失败：${v?.error || "未知原因"}`;
  }
});

tokenValidateBtn.addEventListener("click", async () => {
  tokenValidateBtn.disabled = true;
  tokenStatusText.textContent = "验证中…";
  const res = await sendMessage("VALIDATE_TOKEN");
  tokenValidateBtn.disabled = false;
  if (res.valid) {
    tokenStatusText.className = "valid";
    tokenStatusText.textContent = `✅ 有效（用户: ${res.user?.name || res.user?.userName || "unknown"}）`;
  } else {
    tokenStatusText.className = res.error?.includes("过期") ? "expired" : "unknown";
    tokenStatusText.textContent = `❌ ${res.error}`;
  }
});

// ── AI 设置 ──────────────────────────────────────────────

const aiBase = document.getElementById("ai-base");
const aiModel = document.getElementById("ai-model");
const aiKey = document.getElementById("ai-key");
const aiSaveBtn = document.getElementById("ai-save-btn");
const aiTestBtn = document.getElementById("ai-test-btn");
const aiStatus = document.getElementById("ai-status");

async function loadAiSettings() {
  const cfg = await sendMessage("GET_AI_CONFIG");
  if (!cfg) return;

  aiBase.value = cfg.baseURL || "";
  aiModel.value = cfg.model || "";
  aiKey.value = "";
  aiKey.placeholder = cfg.hasKey ? "已保存 Key（留空表示不修改）" : "API Key";

  aiStatus.className = cfg.hasKey ? "valid" : "";
  aiStatus.textContent = cfg.hasKey ? "✅ 已配置" : "未配置（会退回本地打分）";
}

/**
 * 向浏览器申请访问自定义接口地址的权限
 * 必须在用户点击手势里调用，否则 chrome.permissions.request 会失败
 */
async function ensureHostPermission(baseURL) {
  let origin;
  try {
    origin = new URL(baseURL).origin;
  } catch {
    return false;
  }
  const pattern = `${origin}/*`;
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

aiSaveBtn.addEventListener("click", async () => {
  const baseURL = aiBase.value.trim() || "https://api.deepseek.com";
  const model = aiModel.value.trim() || "deepseek-chat";
  const apiKey = aiKey.value.trim();

  aiSaveBtn.disabled = true;

  const granted = await ensureHostPermission(baseURL);
  if (!granted) {
    aiSaveBtn.disabled = false;
    aiStatus.className = "expired";
    aiStatus.textContent = "❌ 没拿到访问该地址的权限，无法保存";
    return;
  }

  const res = await sendMessage("SET_AI_CONFIG", { config: { baseURL, model, apiKey } });
  aiSaveBtn.disabled = false;

  if (res && res.success) {
    aiKey.value = "";
    await loadAiSettings();
    aiStatus.textContent = res.hasKey ? "✅ 已保存" : "⚠️ 已保存地址/模型，但还没有 Key";
  }
});

aiTestBtn.addEventListener("click", async () => {
  aiTestBtn.disabled = true;
  aiStatus.className = "";
  aiStatus.textContent = "测试中…";

  const res = await sendMessage("AI_PING");
  aiTestBtn.disabled = false;

  if (res && res.ok) {
    aiStatus.className = "valid";
    aiStatus.textContent = `✅ 可用（${res.model}，${res.latencyMs} ms）`;
  } else {
    aiStatus.className = "expired";
    aiStatus.textContent = `❌ ${res?.error || "测试失败"}`;
  }
});

aliasSaveBtn.addEventListener("click", async () => {
  try {
    const config = JSON.parse(aliasEditor.value);
    aliasSaveBtn.disabled = true;
    await sendMessage("UPDATE_ALIAS_CONFIG", { config });
    aliasSaveBtn.disabled = false;
    alert("科目别名已保存");
  } catch {
    alert("JSON 格式错误，请检查输入");
  }
});

async function loadSettings() {
  updateTokenStatus();
  loadAiSettings();
  const config = await sendMessage("GET_ALIAS_CONFIG");
  if (config) {
    aliasEditor.value = JSON.stringify(config, null, 2);
  }
}

async function updateTokenStatus() {
  const res = await sendMessage("GET_TOKEN_STATUS");
  if (!res) return;

  const statusMap = {
    valid: { text: `✅ Token 有效 (${res.masked})`, cls: "valid" },
    expired: { text: `❌ Token 已过期 (${res.masked})`, cls: "expired" },
    unknown: { text: `⚠️ Token 未验证 (${res.masked})`, cls: "unknown" },
    none: { text: "未设置", cls: "" },
  };

  const info = statusMap[res.status] || statusMap.none;
  tokenStatusText.className = info.cls;
  tokenStatusText.textContent = info.text;

  // 搜索视图提示
  if (res.status === "none" || res.status === "expired") {
    showTokenHint(res.status === "none" ? "请先设置 Access Token" : "Token 已过期，请重新设置");
  } else {
    tokenHint.style.display = "none";
  }
}

// ── 辅助函数 ──────────────────────────────────────────────

/**
 * 取帖子作者名
 * 搜索/详情接口给的是 userName；只有 /Topic/Hot 给 authorName。两者都认。
 */
function topicAuthor(topic) {
  if (topic.isAnonymous === true) return "匿名";
  return topic.userName || topic.authorName || "匿名";
}

/**
 * 取帖子时间
 * 搜索/详情接口给的是 time（实测），/Topic/Hot 给的是 createTime。
 * 旧代码只读 createTime，导致搜索结果的时间列永远是空的。
 */
function topicTime(topic) {
  return topic.time || topic.createTime || topic.lastPostTime || "";
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / 3600000);
    if (diffHours === 0) return `${Math.floor(diffMs / 60000)} 分钟前`;
    return `${diffHours} 小时前`;
  }
  if (diffDays < 7) return `${diffDays} 天前`;

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getAttachmentCategory(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const map = {
    pdf: { icon: "📄" }, doc: { icon: "📄" }, docx: { icon: "📄" },
    ppt: { icon: "📊" }, pptx: { icon: "📊" },
    xls: { icon: "📋" }, xlsx: { icon: "📋" },
    zip: { icon: "📦" }, rar: { icon: "📦" }, "7z": { icon: "📦" },
    jpg: { icon: "🖼️" }, jpeg: { icon: "🖼️" }, png: { icon: "🖼️" },
    mp4: { icon: "🎬" }, mp3: { icon: "🎵" },
    txt: { icon: "📝" }, md: { icon: "📝" },
  };
  return map[ext] || { icon: "📎" };
}

function renderEmpty(text) {
  return `<div class="empty-state"><div class="empty-state-icon">📭</div>${text}</div>`;
}

// ── 初始化 ────────────────────────────────────────────────

async function init() {
  // 打开弹窗时先静默尝试从 CC98 页面同步 Token（只在还没有有效 Token 时）
  await trySilentTokenSync();
  await updateTokenStatus();
  loadBoards();
}

init();
