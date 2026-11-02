/**
 * Token 存储与管理模块
 *
 * MVP：用户手动粘贴 access token，保存在 chrome.storage.local
 * 增强版：chrome.identity.launchWebAuthFlow 走 OpenID 授权码流程
 */

const STORAGE_KEY_TOKEN = "cc98_access_token";
const STORAGE_KEY_TOKEN_STATUS = "cc98_token_status";

export class AuthManager {
  /**
   * 保存 token 到 chrome.storage.local
   * @param {string} token
   */
  async saveToken(token) {
    await chrome.storage.local.set({
      [STORAGE_KEY_TOKEN]: token,
      [STORAGE_KEY_TOKEN_STATUS]: "unknown",
    });
  }

  /**
   * 获取保存的 token
   * @returns {Promise<string|null>}
   */
  async getToken() {
    const data = await chrome.storage.local.get(STORAGE_KEY_TOKEN);
    return data[STORAGE_KEY_TOKEN] || null;
  }

  /**
   * 清除保存的 token
   */
  async clearToken() {
    await chrome.storage.local.remove([STORAGE_KEY_TOKEN, STORAGE_KEY_TOKEN_STATUS]);
  }

  /**
   * 获取 token 状态
   * @returns {Promise<'valid'|'expired'|'unknown'|'none'>}
   */
  async getTokenStatus() {
    const token = await this.getToken();
    if (!token) return "none";
    const data = await chrome.storage.local.get(STORAGE_KEY_TOKEN_STATUS);
    return data[STORAGE_KEY_TOKEN_STATUS] || "unknown";
  }

  /**
   * 更新 token 状态
   * @param {'valid'|'expired'|'unknown'} status
   */
  async setTokenStatus(status) {
    await chrome.storage.local.set({ [STORAGE_KEY_TOKEN_STATUS]: status });
  }

  /**
   * 获取 token 的脱敏展示（只显示后四位）
   * @returns {Promise<string>}
   */
  async getMaskedToken() {
    const token = await this.getToken();
    if (!token) return "(未设置)";
    if (token.length <= 8) return "****";
    return `****${token.slice(-4)}`;
  }

  /**
   * 验证 token 有效性（调用 /Me 接口）
   * @returns {Promise<{valid: boolean, user?: object, error?: string}>}
   */
  async validateToken() {
    const token = await this.getToken();
    if (!token) {
      return { valid: false, error: "未设置 Token" };
    }

    try {
      const res = await fetch("https://api.cc98.org/Me", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (res.ok) {
        const user = await res.json();
        await this.setTokenStatus("valid");
        return { valid: true, user };
      }

      if (res.status === 401) {
        await this.setTokenStatus("expired");
        return { valid: false, error: "Token 已过期" };
      }

      await this.setTokenStatus("unknown");
      return { valid: false, error: `验证失败 (HTTP ${res.status})` };
    } catch (e) {
      await this.setTokenStatus("unknown");
      return { valid: false, error: `网络错误: ${e.message}` };
    }
  }
}

/**
 * 自定义错误类型
 */
export class TokenExpiredError extends Error {
  constructor() {
    super("Token 已过期，请重新设置");
    this.name = "TokenExpiredError";
  }
}

export class NoTokenError extends Error {
  constructor() {
    super("请先设置 Access Token");
    this.name = "NoTokenError";
  }
}
