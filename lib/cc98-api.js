/**
 * CC98 REST API 封装层
 *
 * 所有 API 请求通过此类统一管理，包括：
 * - Bearer Token 认证
 * - 请求频率控制
 * - 错误处理与分类
 */

import { TokenExpiredError, NoTokenError } from "./auth.js";

const API_BASE = "https://api.cc98.org";
const FILE_BASE = "https://file.cc98.org";
const REQUEST_INTERVAL_MS = 500;

export class CC98API {
  /**
   * @param {() => Promise<string|null>} tokenGetter - 获取 token 的回调
   */
  constructor(tokenGetter) {
    this.getToken = tokenGetter;
    this._lastRequestTime = 0;
    this._requestLock = Promise.resolve();
  }

  // ── 公开端点 ──────────────────────────────────────────

  /**
   * 获取热门帖子
   * @returns {Promise<Array>}
   */
  async getHotTopics() {
    return this._request("/Topic/Hot", { requireAuth: false });
  }

  /**
   * 获取版面列表
   * @returns {Promise<Array>}
   */
  async getAllBoards() {
    return this._request("/Board/All", { requireAuth: false });
  }

  // ── 需认证端点 ────────────────────────────────────────

  /**
   * 搜索帖子
   * @param {string} keyword - 搜索关键词
   * @param {object} [options]
   * @param {number} [options.boardId=0] - 版面 ID，0 = 全站
   * @param {number} [options.page=1] - 页码
   * @param {number} [options.size=20] - 每页条数
   * @param {number} [options.condition] - 搜索条件（0=标题，1=标题+内容）
   * @returns {Promise<Array>}
   */
  async searchTopics(keyword, options = {}) {
    const params = {
      keyword,
      boardId: options.boardId ?? 0,
      page: options.page ?? 1,
      size: options.size ?? 20,
    };
    if (options.condition !== undefined) {
      params.condition = options.condition;
    }
    return this._request("/Topic/Search", { params, requireAuth: true });
  }

  /**
   * 获取帖子详情
   * @param {number} topicId
   * @returns {Promise<object>}
   */
  async getTopic(topicId) {
    return this._request(`/Topic/${topicId}`, { requireAuth: true });
  }

  /**
   * 获取帖子楼层/回复
   *
   * ⚠️ `from` 是 **0 基的**（2026-11-01 实测）：
   *   from=0 → 楼层 1,2,3…（含楼主）
   *   from=1 → 楼层 2,3,4…（**跳过楼主**）
   *
   * 旧代码默认 from=1，导致**永远读不到楼主那一层**，而附件几乎都在楼主帖里。
   * 这就是"明明有附件却一个也解析不出来"的真正原因。
   *
   * @param {number} topicId
   * @param {object} [options]
   * @param {number} [options.from=0] - 起始索引（0 基，0 = 楼主）
   * @param {number} [options.size=20] - 每页条数（上限 20）
   * @returns {Promise<Array>}
   */
  async getPosts(topicId, options = {}) {
    // 实测：size 上限是 20，传 50 会直接 400
    const size = Math.min(Math.max(1, options.size ?? 20), 20);
    const params = {
      from: Math.max(0, options.from ?? 0),
      size,
    };
    return this._request(`/Topic/${topicId}/Post`, { params, requireAuth: true });
  }

  /**
   * 获取当前用户信息
   * @returns {Promise<object>}
   */
  async getMe() {
    return this._request("/Me", { requireAuth: true });
  }

  /**
   * 获取指定用户资料
   *
   * `popularity` 就是页面上显示的「风评值」，另有 prestige(威望)、fanCount(粉丝)、
   * receivedLikeCount(获赞) —— 这些是判断"发资料的人靠不靠谱"的主要信号。
   *
   * @param {number} userId
   * @returns {Promise<object>}
   */
  async getUser(userId) {
    return this._request(`/user/${userId}`, { requireAuth: true });
  }

  // ── 附件相关 ──────────────────────────────────────────

  /**
   * 获取附件下载 URL
   * @param {string|number} fileId
   * @param {string} filename
   * @returns {string}
   */
  getAttachmentUrl(fileId, filename) {
    return `${FILE_BASE}/file/${fileId}/${encodeURIComponent(filename)}`;
  }

  /**
   * 下载附件（返回 Response 对象供调用方处理）
   * @param {string} url - 附件 URL
   * @param {object} [options]
   * @param {boolean} [options.withToken=true] - 是否带 token
   * @returns {Promise<Response>}
   */
  async fetchAttachment(url, options = {}) {
    const withToken = options.withToken ?? true;
    const headers = { Accept: "*/*" };

    if (withToken) {
      const token = await this.getToken();
      if (!token) throw new NoTokenError();
      headers.Authorization = `Bearer ${token}`;
    }

    return fetch(url, { headers });
  }

  // ── 通用请求 ──────────────────────────────────────────

  /**
   * 发起 API 请求
   * @param {string} path - API 路径（相对于 API_BASE）
   * @param {object} [options]
   * @param {boolean} [options.requireAuth=true]
   * @param {object} [options.params] - URL 查询参数
   * @param {string} [options.method='GET']
   * @returns {Promise<any>} - 解析后的 JSON 响应
   */
  async _request(path, options = {}) {
    const requireAuth = options.requireAuth ?? true;

    // 频率控制：确保请求间隔
    await this._rateLimit();

    // 构建 URL
    const url = new URL(path, API_BASE);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }

    // 构建请求头
    const headers = { Accept: "application/json" };
    if (requireAuth) {
      const token = await this.getToken();
      if (!token) throw new NoTokenError();
      headers.Authorization = `Bearer ${token}`;
    }

    // 发起请求
    const res = await fetch(url.toString(), {
      method: options.method || "GET",
      headers,
    });

    // 处理响应
    if (res.ok) {
      return res.json();
    }

    // 错误处理
    return this._handleError(res, path);
  }

  /**
   * 频率控制：确保两次请求间有足够间隔
   * 使用锁机制序列化并发请求，避免多请求同时通过检查
   */
  async _rateLimit() {
    const lock = this._requestLock;
    let release;
    this._requestLock = new Promise(resolve => { release = resolve; });
    await lock;

    const now = Date.now();
    const elapsed = now - this._lastRequestTime;
    if (elapsed < REQUEST_INTERVAL_MS) {
      await this._sleep(REQUEST_INTERVAL_MS - elapsed);
    }
    this._lastRequestTime = Date.now();
    release();
  }

  /**
   * 错误处理
   *
   * ⚠️ 顺序很重要：必须**先**读成文本，再尝试按 JSON 解析。
   * fetch 的 body 只能消费一次——如果先 `res.json()` 且它因为响应不是 JSON 而抛错，
   * body 已经被消费掉了，此时再 `res.text()` 只会抛 `TypeError: body used already`，
   * 把真实的状态码和响应体一起埋掉。而"响应不是 JSON"恰恰是最常见的情形：
   * 网关 502/504 的 HTML 错误页、反代超时页、登录重定向页。
   * 本项目 scripts/api-verify.mjs 里用的就是"先 text 后 parse"这个正确顺序。
   */
  async _handleError(res, path) {
    const status = res.status;

    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }

    let body = text;
    if (text) {
      try { body = JSON.parse(text); } catch { /* 不是 JSON，保留原始文本 */ }
    }

    const detail = this._describeBody(body);

    switch (status) {
      case 401:
        throw new TokenExpiredError();
      case 403:
        // 实测：搜索接口连发也会返回 403（限流），与真正的"权限不足"无法从响应区分，
        // 所以文案里两种可能都要说，不能只写"权限不足"误导人。
        throw new PermissionDeniedError(`权限不足或请求过于频繁（HTTP 403）: ${path}${detail}`, body);
      case 404:
        throw new ResourceNotFoundError(`资源不存在: ${path}${detail}`, body);
      case 429:
        throw new RateLimitError(`请求过于频繁，请稍后重试${detail}`, body);
      default:
        throw new ApiError(`API 错误 (HTTP ${status}): ${path}${detail}`, status, body);
    }
  }

  /**
   * 把响应体压成一句能读的话，附在错误信息后面
   * @param {any} body
   * @returns {string} - 形如 " — 502 Bad Gateway"，没有可用内容时返回空串
   */
  _describeBody(body) {
    if (body === null || body === undefined || body === "") return "";
    let text;
    if (typeof body === "string") {
      text = body;
    } else {
      try { text = JSON.stringify(body); } catch { return ""; }
    }
    const compact = String(text).replace(/\s+/g, " ").trim();
    if (!compact) return "";
    return ` — ${compact.length > 200 ? `${compact.slice(0, 200)}…` : compact}`;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── 自定义错误 ────────────────────────────────────────────

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export class PermissionDeniedError extends ApiError {
  constructor(message, body) {
    super(message, 403, body);
    this.name = "PermissionDeniedError";
  }
}

export class ResourceNotFoundError extends ApiError {
  constructor(message, body) {
    super(message, 404, body);
    this.name = "ResourceNotFoundError";
  }
}

export class RateLimitError extends ApiError {
  constructor(message, body) {
    super(message, 429, body);
    this.name = "RateLimitError";
  }
}
