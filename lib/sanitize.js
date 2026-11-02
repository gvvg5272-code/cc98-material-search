/**
 * HTML 转义
 *
 * 为什么不用"塞进 div 再读 innerHTML"那种写法：
 * 那种做法只转义 `&` `<` `>`，**不转义引号**。而本项目大量这么用：
 *
 *     `<span title="${escapeHtml(topic.title)}">`
 *
 * 帖子标题里只要出现一个双引号，就能提前闭合属性、往页面里塞任意标签
 * （标题来自论坛，是别人可控的输入）。所以必须显式转义引号。
 */

const ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * 转义为可安全放进 HTML 文本节点或**带引号属性值**的字符串
 * @param {any} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, ch => ESCAPE_MAP[ch]);
}

/** Windows / Chrome 下载器不接受的字符 */
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

/** Windows 保留设备名，用作文件名会失败 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * 把任意字符串整理成 chrome.downloads.download 能接受的 filename
 *
 * 为什么必须做：附件名来自论坛 URL 末段，可能含 `/`、`:`、`?` 等字符
 * （`%2F` 解码后就是 `/`）。文件名非法时 `chrome.downloads.download`
 * **直接报错**，整个下载失败，而错误信息通常只有一句 "Invalid filename"。
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  let v = String(name ?? "").trim();

  if (!v) return "download";

  // 只取最后一段，防止 ../ 之类的路径穿越
  v = v.split("/").pop().split("\\").pop();

  v = v.replace(ILLEGAL_FILENAME_CHARS, "_");

  // 去掉首尾的点和空格（Windows 不允许）
  v = v.replace(/^[\s.]+|[\s.]+$/g, "");

  if (!v) return "download";

  if (RESERVED_NAMES.test(v)) v = `_${v}`;

  // 太长的名字按扩展名截断
  if (v.length > 120) {
    const idx = v.lastIndexOf(".");
    const ext = idx > 0 ? v.slice(idx) : "";
    v = v.slice(0, 120 - ext.length) + ext;
  }

  return v;
}
