/**
 * 批量下载队列模块
 *
 * 功能：
 * - 下载项排队，逐个处理
 * - 下载间隔控制
 * - 失败重试（最多 1 次）
 * - 队列状态持久化到 chrome.storage.session（防止 Service Worker 被终止丢失状态）
 * - 状态通知
 */

import { sanitizeFilename } from "./sanitize.js";

const DOWNLOAD_INTERVAL_MS = 1000;
const MAX_RETRIES = 1;
const STORAGE_KEY = "cc98_download_queue";

/**
 * 下载项状态
 * @readonly
 * @enum {string}
 */
export const DownloadStatus = {
  PENDING: "pending",
  DOWNLOADING: "downloading",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
};

/**
 * 下载失败
 *
 * 带上 `retryable` 判定，避免调用方靠字符串匹配错误消息来决定要不要重试：
 * 5xx / 网络抖动 / 浏览器一开始就没接住下载，重试有意义；
 * 而"超时"不重试——文件可能还在下，重试就会下两遍。
 */
export class DownloadError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "DownloadError";
    this.retryable = retryable;
  }
}

export class DownloadQueue {
  /**
   * @param {import('./cc98-api.js').CC98API} api
   */
  constructor(api) {
    this.api = api;
    /** @type {DownloadItem[]} */
    this.items = [];
    this._processing = false;
    this._paused = false;
    this._listeners = new Set();
  }

  /**
   * 添加下载项到队列
   * @param {object} attachment - 附件信息
   * @param {string} attachment.fileId
   * @param {string} attachment.filename
   * @param {string} attachment.url
   * @returns {DownloadItem}
   */
  enqueue(attachment) {
    // 去重：同一 fileId 不重复加入
    if (this.items.some(item => item.fileId === attachment.fileId && item.status !== DownloadStatus.FAILED)) {
      return null;
    }

    const item = {
      id: `${attachment.fileId}_${Date.now()}`,
      fileId: String(attachment.fileId),
      filename: attachment.filename,
      url: attachment.url,
      mimeType: attachment.mimeType || null,
      status: DownloadStatus.PENDING,
      retryCount: 0,
      error: null,
      addedAt: Date.now(),
      completedAt: null,
    };

    this.items.push(item);
    this._notify();
    this._persist();

    if (!this._processing && !this._paused) {
      this.processNext();
    }

    return item;
  }

  /**
   * 批量添加
   * @param {Array} attachments
   * @returns {DownloadItem[]}
   */
  enqueueBatch(attachments) {
    const added = [];
    for (const att of attachments) {
      const item = this.enqueue(att);
      if (item) added.push(item);
    }
    return added;
  }

  /**
   * 处理队列中的下一个下载项
   */
  async processNext() {
    if (this._paused || this._processing) return;

    const next = this.items.find(item => item.status === DownloadStatus.PENDING);
    if (!next) {
      this._processing = false;
      return;
    }

    this._processing = true;
    next.status = DownloadStatus.DOWNLOADING;
    this._notify();

    try {
      await this._downloadFile(next);
      next.status = DownloadStatus.COMPLETED;
      next.completedAt = Date.now();
      next.error = null;
    } catch (e) {
      next.error = e.message;

      if (next.retryCount < MAX_RETRIES && this._isRetryable(e)) {
        next.retryCount++;
        next.status = DownloadStatus.PENDING;
        // 重试前等待
        await this._sleep(2000);
      } else {
        next.status = DownloadStatus.FAILED;
      }
    }

    this._notify();
    this._persist();

    // 下载间隔
    await this._sleep(DOWNLOAD_INTERVAL_MS);

    this._processing = false;
    this.processNext();
  }

  /**
   * 执行单个文件下载
   *
   * ⚠️ 2026-11-01 修正：**不要用 fetch + blob + URL.createObjectURL**。
   *
   * MV3 的 Service Worker 全局作用域里 **没有 `URL.createObjectURL`**
   * （它是 Window/Worker 的能力，Service Worker 不暴露）。旧实现在 SW 里调它，
   * 一进浏览器就是 `TypeError: URL.createObjectURL is not a function`，
   * 整条下载链路直接废掉——而 Node 里的离线测试用假件把它替掉了，所以没抓到。
   *
   * 另外实测 `file.cc98.org` 的文件**公开可下载、不需要 Authorization**，
   * 先 fetch 一遍再转 blob 本来也是白费内存。
   *
   * 所以：直接把 URL 交给浏览器的下载器。
   *
   * @param {DownloadItem} item
   */
  async _downloadFile(item) {
    let downloadId;
    try {
      downloadId = await chrome.downloads.download({
        url: item.url,
        // 文件名来自论坛，可能含 / : ? 等非法字符，不洗会让下载直接失败
        filename: sanitizeFilename(item.filename),
        saveAs: false,
      });
    } catch (e) {
      // chrome.* 的失败通常抛的是字符串，不是 Error
      throw new DownloadError(`无法开始下载: ${e?.message || e}`, { retryable: true });
    }

    await this._waitForDownloadComplete(downloadId);
  }

  /**
   * 等待 chrome.downloads 下载完成
   * @param {number} downloadId
   * @returns {Promise<void>}
   */
  _waitForDownloadComplete(downloadId) {
    return new Promise((resolve, reject) => {
      let timer = null;

      function cleanup() {
        chrome.downloads.onChanged.removeListener(onChanged);
        if (timer) clearTimeout(timer);
      }

      function onChanged(delta) {
        if (delta.id !== downloadId) return;
        if (delta.state && delta.state.current === "complete") {
          cleanup();
          resolve();
        }
        if (delta.state && delta.state.current === "interrupted") {
          cleanup();
          // 中断可以重试；但"超时"不能——文件可能还在下载，重试就会下两遍
          reject(new DownloadError("下载被中断", { retryable: true }));
        }
      }

      chrome.downloads.onChanged.addListener(onChanged);

      // 超时 60s
      timer = setTimeout(() => {
        cleanup();
        reject(new DownloadError("下载超时", { retryable: false }));
      }, 60000);
    });
  }

  /**
   * 暂停队列
   */
  pause() {
    this._paused = true;
    this._notify();
  }

  /**
   * 恢复队列
   */
  resume() {
    this._paused = false;
    this._notify();
    this.processNext();
  }

  /**
   * 清空已完成和失败的项
   */
  clearCompleted() {
    this.items = this.items.filter(
      item => item.status === DownloadStatus.PENDING || item.status === DownloadStatus.DOWNLOADING
    );
    this._notify();
    this._persist();
  }

  /**
   * 重试失败的项
   */
  retryFailed() {
    for (const item of this.items) {
      if (item.status === DownloadStatus.FAILED) {
        item.status = DownloadStatus.PENDING;
        item.retryCount = 0;
        item.error = null;
      }
    }
    this._notify();
    this._persist();
    if (!this._paused) this.processNext();
  }

  /**
   * 获取队列状态摘要
   * @returns {{pending: number, downloading: number, completed: number, failed: number, total: number}}
   */
  getStatus() {
    const counts = { pending: 0, downloading: 0, completed: 0, failed: 0 };
    for (const item of this.items) {
      counts[item.status] = (counts[item.status] || 0) + 1;
    }
    return { ...counts, total: this.items.length };
  }

  /**
   * 注册状态变更监听器
   * @param {function} listener
   * @returns {function} - 取消监听函数
   */
  onStatusChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * 持久化队列状态到 chrome.storage.session
   */
  async _persist() {
    try {
      const data = this.items.filter(
        item => item.status !== DownloadStatus.COMPLETED
      );
      await chrome.storage.session.set({ [STORAGE_KEY]: data });
    } catch {
      // storage.session 可能不可用，静默失败
    }
  }

  /**
   * 从 chrome.storage.session 恢复队列状态
   */
  async restore() {
    try {
      const data = await chrome.storage.session.get(STORAGE_KEY);
      if (data[STORAGE_KEY]) {
        this.items = data[STORAGE_KEY];
        this._notify();
      }
    } catch {
      // 静默失败
    }
  }

  _notify() {
    const status = this.getStatus();
    for (const listener of this._listeners) {
      try { listener(status, this.items); } catch {}
    }
  }

  _isRetryable(error) {
    // 新代码抛 DownloadError，直接读它自带的判定结果
    if (error && typeof error.retryable === "boolean") return error.retryable;

    // 兼容：不认识的外部错误，仍按消息关键字判断
    const msg = error?.message || "";
    // Token 过期、权限不足、附件不存在不重试
    if (msg.includes("Token 已过期")) return false;
    if (msg.includes("权限不足")) return false;
    if (msg.includes("附件不存在")) return false;
    return true;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
