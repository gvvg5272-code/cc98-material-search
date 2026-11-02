/**
 * 结果分拣（triage）
 *
 * 目标：搜索结果里大部分是噪音——「求一份讲义」「有没有人上过这门课」这类帖子
 * 标题里同样带关键词，关键词搜索完全无法区分。这里用**便宜的本地规则**先筛一遍，
 * 只让真正有附件的帖子进入后续（更贵）的评分和 AI 总结。
 *
 * 成本设计：
 *   第一级：每个帖子只取 floor 1（1 次请求）→ 有没有附件、像不像求资料
 *   第二级：只有"有附件"的才去取 /Topic/{id} 和作者资料（再 1~2 次请求）
 *
 * 这样 20 条结果通常只有 2~5 条进入第二级，不会把接口打爆。
 */

/** 求资料类帖子的典型措辞（正文） */
const SEEK_PATTERNS = [
  /求[一\s份个套本]?[^\n]{0,8}(资料|讲义|课件|真题|笔记|答案|PPT|pdf|教材|课本|电子版|书)/i,
  /(有没有|有无|哪位|请问)[^\n]{0,12}(资料|讲义|课件|真题|笔记|教材|电子版|书|推荐)/,
  /(跪求|急求|蹲一个|求分享|求资源|求推荐|求一本|求个|求购)/,
  /如题[。！!\s]*$/,
  /^求[^\n]{0,14}[。！!？?\s]*$/,
];

/** 标题里的求资料信号更强（求帖的正文往往只有"如题"两个字） */
const SEEK_TITLE_PATTERNS = [
  /^求[^\n]{0,20}$/,
  /^\[?求[购\] ]/,
  /(求|收|出)?一本/,
  /(有没有|求推荐|求分享)/,
];

/**
 * 帖子类型分类（本地规则，不花 token）
 *
 * 实测「电工电子学」的 20 条搜索结果里，一半是**卖书帖**（"长期三折出书…"），
 * 一堆是**求书帖**，真正的资源楼被挤到后面。分类之后就能把这些噪音折叠掉。
 *
 * @param {{title?: string, content?: string}} input
 * @returns {'卖书'|'求资料'|'资源'|'讨论'}
 */
export function classifyPostType({ title, content }) {
  const t = String(title || "").trim();
  const c = String(content || "");

  // 卖书帖优先判：它的标题里也常带"资料""讲义"字样，顺序不能反
  if (/(出书|出售|转让|三折|半价|低价出|出教材|送信箱|自提|可送|求购|收一本)/.test(t)) {
    return "卖书";
  }

  if (/^\[?求/.test(t) || /(跪求|急求|求分享|求推荐|求一本)/.test(t)) {
    return "求资料";
  }

  // 资源楼/汇总帖：这类才是真正有货的
  if (/(资源楼|资料汇总|资料合集|资源合集|课程资料|课程总结|经验总结|资料分享)/.test(t)) {
    return "资源";
  }

  // 标题没特征时看正文：长文且提到整理/汇总，更像资源帖
  if (c.length > 300 && /(整理|汇总|分享|供参考)/.test(c)) return "资源";

  return "讨论";
}

/** 求资料帖通常不长；长文更可能是在认真分享 */
const SEEK_MAX_LENGTH = 800;

/**
 * 判断一个帖子是不是在「求」资料
 *
 * 有附件就一定不是（已经给了东西）。标题和正文都看：
 * 求帖的正文经常只有"如题"两个字，光看正文会漏。
 *
 * @param {{content?: string, title?: string, attachmentCount: number}} input
 * @returns {boolean}
 */
export function looksLikeSeeking({ content, title, attachmentCount }) {
  if (attachmentCount > 0) return false;

  const text = String(content || "");
  if (text.length > SEEK_MAX_LENGTH) return false;

  const heading = String(title || "").trim();

  // 标题命中"求"字开头，基本可以定性（正文常常只有"如题"）
  if (heading && /^求/.test(heading)) return true;
  if (heading && SEEK_TITLE_PATTERNS.some(re => re.test(heading)) && text.length < 60) return true;

  return SEEK_PATTERNS.some(re => re.test(text));
}

/**
 * 分拣结果的排序规则
 *
 * 优先级：有附件 > 分数高 > 回复多
 * （"有资料"是硬门槛，其余只是同档内排序）
 *
 * @param {Array} items - 每项需含 { attachmentCount, score, replyCount }
 * @returns {Array} 新数组，不改原数组
 */
export function rankTriage(items) {
  return [...(items || [])].sort((a, b) => {
    // 资源楼/汇总帖排最前
    const aRes = a.type === "资源" ? 1 : 0;
    const bRes = b.type === "资源" ? 1 : 0;
    if (aRes !== bRes) return bRes - aRes;

    const aHas = (a.attachmentCount || 0) > 0 ? 1 : 0;
    const bHas = (b.attachmentCount || 0) > 0 ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;

    const aScore = a.score ?? 0;
    const bScore = b.score ?? 0;
    if (aScore !== bScore) return bScore - aScore;

    return (b.replyCount || 0) - (a.replyCount || 0);
  });
}

/**
 * 「只看有资料的」筛选（纯函数，方便测）
 *
 * 规则：
 * - 开关关闭 → 原样返回
 * - 扫描失败（`_triageError`）→ **保留**，不能把"不知道"当成"没有"
 * - 还没扫到（`_triage` 为空）→ **保留**，避免扫描中途列表塌陷
 * - 已扫描且附件数为 0 → 折叠
 *
 * ⚠️ 不能用 `items.every(t => t._triage)` 当全局开关：
 * 只要有一条没扫到，every() 就是 false，整个筛选会静默失效。
 *
 * @param {Array} items
 * @param {boolean} enabled
 * @returns {Array}
 */
export function filterWithMaterial(items, enabled) {
  const list = Array.isArray(items) ? items : [];
  if (!enabled) return list;

  return list.filter(t => {
    if (t._triageError) return true;
    const tr = t._triage;
    if (!tr) return true;
    return (tr.attachmentCount || 0) > 0;
  });
}

/**
 * 生成列表项上的小标签文案
 * @param {object|null} triage
 * @returns {{text: string, tone: 'good'|'meh'|'bad'|'pending'}}
 */
export function triageBadge(triage) {
  if (!triage) return { text: "", tone: "pending" };

  if (triage.type === "卖书") return { text: "卖书", tone: "meh" };
  if (triage.type === "求资料") return { text: "求资料", tone: "bad" };

  const n = triage.attachmentCount || 0;
  if (n === 0) {
    return { text: triage.type === "资源" ? "资源楼·未找到附件" : "无附件", tone: "meh" };
  }

  const prefix = triage.type === "资源" ? "资源 " : "";
  return { text: `${prefix}📎 ${n} · ${triage.score ?? 0} 分`, tone: "good" };
}
