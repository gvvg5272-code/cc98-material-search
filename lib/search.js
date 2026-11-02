/**
 * 搜索服务模块
 *
 * 功能：
 * - 科目别名展开（如 "高数下" → ["高等数学（二）", "微积分B", "高数下"]）
 * - 多关键词搜索聚合
 * - 结果去重与排序
 *
 * ⚠️ 2026-11-01 实测修正：
 *
 * 1. **搜索接口限流很严**。连续 8 次、间隔 600ms 的搜索会从第 2 次开始一直返回 **403**。
 *    3 秒间隔是实测可用的。所以这里默认只取 1 页、并强制每次请求之间留 2.5 秒。
 *    （403 在搜索上既可能是"权限不足"也可能是"搜太快"，无法从响应区分——见下面 catch。）
 *
 * 2. **搜索结果里没有 createTime，只有 time**。旧代码按 `new Date(createTime)` 排序，
 *    结果全是 NaN，等于**根本没排序**（稳定排序会把原顺序原样留下）。
 */

/**
 * 这些错误一旦发生，继续搜别的关键词没有任何意义，必须原样交给上层
 * （上层据此提示"Token 已过期，请重新设置"，而不是"未找到"）。
 */
const AUTH_ERROR_NAMES = new Set(["TokenExpiredError", "NoTokenError", "PermissionDeniedError"]);

/** 实测：搜索请求之间至少要 3 秒，取 2.5 秒留一点余地（再短会稳定 403） */
const DEFAULT_SEARCH_GAP_MS = 2500;

/**
 * 默认翻 3 页（20 条/页 = 60 条）。
 *
 * 为什么不是 1 页：实测「电工电子学」的第 1 页 20 条里，一半是卖书帖、
 * 一堆是求书帖，真正的资源楼排在第 8 位之后；用户想要的小测/复习资料
 * 往往在更后面。只取 1 页会直接把它们丢掉。
 *
 * 代价：每多一页多一次会被限流的请求（约 3 秒）。
 * 别名很多的科目会自动降到 1 页，避免请求数爆炸。
 */
const DEFAULT_MAX_PAGES = 3;

/** 别名超过这个数量时，每个别名只翻 1 页（否则请求数 = 别名数 × 页数，太慢） */
const MAX_ALIASES_FOR_MULTI_PAGE = 2;

export class SearchService {
  /**
   * @param {import('./cc98-api.js').CC98API} api
   * @param {object} aliasConfig - 科目别名配置
   */
  constructor(api, aliasConfig) {
    this.api = api;
    this.aliasConfig = aliasConfig || {};
  }

  /**
   * 更新别名配置
   * @param {object} config
   */
  setAliasConfig(config) {
    this.aliasConfig = config;
  }

  /**
   * 执行搜索：展开别名 → 逐个搜索 → 聚合去重 → 排序
   *
   * @param {string} keyword - 用户输入的搜索关键词
   * @param {object} [options]
   * @param {number} [options.boardId] - 版面 ID
   * @param {number} [options.page] - 页码
   * @param {number} [options.size] - 每页条数
   * @param {number} [options.condition] - 搜索条件（0=标题，1=标题+内容）
   * @param {number} [options.maxPages=1] - 每个关键词最多翻几页
   * @param {number} [options.gapMs] - 请求间隔（测试时传 0）
   * @returns {Promise<{results: Array, searchedKeywords: string[], totalPages: number, errors: Array}>}
   */
  async search(keyword, options = {}) {
    const {
      maxPages = DEFAULT_MAX_PAGES,
      gapMs = DEFAULT_SEARCH_GAP_MS,
      ...apiOptions
    } = options;

    const aliases = this.expandAliases(keyword);

    // 别名多的时候单个别名少翻几页，保证总请求数可控
    const pagesPerAlias = aliases.length > MAX_ALIASES_FOR_MULTI_PAGE ? 1 : maxPages;

    const allResults = new Map(); // id → topic
    const searchedKeywords = [];
    const errors = [];
    let totalPages = 0;
    let firstRequest = true;

    for (const kw of aliases) {
      searchedKeywords.push(kw);
      for (let page = 1; page <= pagesPerAlias; page++) {
        // 限流：除第一次外，每次请求前都等一会儿
        if (!firstRequest && gapMs > 0) {
          await this._sleep(gapMs);
        }
        firstRequest = false;

        let results;
        try {
          results = await this.api.searchTopics(kw, { ...apiOptions, page });
        } catch (e) {
          // 认证/权限类错误必须上抛。
          // 原实现对所有异常一律 console.warn + break，于是 Token 过期会被静默吞掉：
          // 上层拿到空结果，界面上显示"未找到相关帖子"，而真实原因是登录失效。
          // 这是最容易误判的一类失败，不能降级成"没搜到"。
          if (AUTH_ERROR_NAMES.has(e.name)) throw e;

          // 其它错误（网络抖动/5xx）不假装成功：记进 errors 交给上层展示
          errors.push({ keyword: kw, page, errorType: e.name, message: e.message });
          break;
        }

        if (!Array.isArray(results) || results.length === 0) {
          break;
        }

        for (const topic of results) {
          if (!allResults.has(topic.id)) {
            allResults.set(topic.id, {
              ...topic,
              _matchedKeywords: [kw],
            });
          } else {
            allResults.get(topic.id)._matchedKeywords.push(kw);
          }
        }

        totalPages += 1;

        // 不足一页说明没有下一页了（接口默认一页 20 条）
        const pageSize = typeof apiOptions.size === "number" ? apiOptions.size : 20;
        if (results.length < pageSize) {
          break;
        }
      }
    }

    // 按发帖时间降序排序
    // 搜索接口给的是 time，帖子详情也是 time；createTime 只出现在 /Topic/Hot 里。
    // 两者都认，避免以后再被字段名坑一次。
    const timeValue = topic => {
      const raw = topic.time ?? topic.createTime ?? topic.lastPostTime;
      const ms = raw ? new Date(raw).getTime() : NaN;
      return Number.isNaN(ms) ? 0 : ms;
    };

    const results = Array.from(allResults.values()).sort((a, b) => timeValue(b) - timeValue(a));

    return { results, searchedKeywords, totalPages, errors };
  }

  /**
   * 展开科目别名
   * @param {string} keyword
   * @returns {string[]} - 包含原始关键词和所有别名的数组
   */
  expandAliases(keyword) {
    const aliases = new Set();
    aliases.add(keyword);

    // 从配置中查找别名
    if (this.aliasConfig[keyword]) {
      for (const alias of this.aliasConfig[keyword]) {
        aliases.add(alias);
      }
    }

    // 反向查找：如果 keyword 是某个别名的值，也加入主关键词
    for (const [mainKey, aliasList] of Object.entries(this.aliasConfig)) {
      if (Array.isArray(aliasList) && aliasList.includes(keyword)) {
        aliases.add(mainKey);
        for (const alias of aliasList) {
          aliases.add(alias);
        }
      }
    }

    return Array.from(aliases);
  }

  /**
   * 在搜索结果中筛选指定版面
   * @param {Array} results
   * @param {number[]} boardIds
   * @returns {Array}
   */
  filterByBoard(results, boardIds) {
    if (!boardIds || boardIds.length === 0) return results;
    const idSet = new Set(boardIds);
    return results.filter(t => idSet.has(t.boardId));
  }

  /**
   * 在搜索结果中筛选有附件的帖子
   * 注意：搜索结果本身不含附件信息，需额外请求帖子详情
   * @param {Array} results - 已获取附件信息的帖子列表
   * @returns {Array}
   */
  filterWithAttachments(results) {
    return results.filter(t => t._attachments && t._attachments.length > 0);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
