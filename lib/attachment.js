/**
 * 附件解析模块
 *
 * ⚠️ 2026-11-01 实测修正（别再照抄旧假设）：
 *
 * 旧版这里只解析 `[upload=12345]名字[/upload]` 这类 UBB 占位符，URL 拼成
 * `file.cc98.org/file/{id}/{name}`。但真实数据（24 帖 / 105 楼）里：
 *
 *   1. `[upload=...]` / `[file=...]` 标记 **一次都没出现**；
 *   2. 文件地址实际长这样（图片实测确认，公开可下载、**不需要 Token**）：
 *        https://file.cc98.org/v4-upload/d/2026/1101/nco4dxf0.webp
 *      正文里直接以 `[img]...[/img]` 或裸 URL 出现，没有数字 fileId 可用。
 *
 * 所以现在的主路径是「直接从正文里抽 file.cc98.org 链接，按扩展名分类」，
 * UBB 占位符解析作为**遗留兼容**保留（万一老帖还有）。
 */

const FILE_HOST_RE = /https?:\/\/file\.cc98\.org\/[^\s[\]<>"'()）)，。；]+/g;

/**
 * Markdown 链接：[显示名](url)
 *
 * 2026-11-01 实测：CC98 v4 的正文是 **Markdown**（有 `###` 标题、`~~删除线~~`），
 * 附件的真实写法就是普通的 Markdown 链接：
 *
 *     [lec00-课程简介](https://file.cc98.org/v4-upload/d/2026/1008/wsyx4tyq.pdf)
 *
 * 裸 URL 正则会把结尾的 `)` 一起吃进去，得到 `…wsyx4tyq.pdf)` 这种坏链接。
 * 所以先按 Markdown 结构切，再补扫裸 URL；顺带把「显示名」拿来做文件名
 * （比 `wsyx4tyq.pdf` 有用得多）。
 */
const MARKDOWN_LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g;

/** 这些扩展名算图片，不算"学习资料附件" */
const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "avif", "ico",
]);

/**
 * 从正文里抽出所有 file.cc98.org 链接
 *
 * @param {string} content - 正文（Markdown 或 UBB 混排）
 * @returns {Array<{url: string, filename: string, ext: string, kind: 'image'|'file'}>}
 */
export function extractFileUrls(content) {
  if (!content) return [];

  // url → 显示名（Markdown 链接才有）
  const byUrl = new Map();

  // 1) Markdown 链接
  //    注意：Markdown 链接可以是**任意**网站（正文里常见 GitHub、知乎等外链），
  //    必须只认 file.cc98.org，否则会把"参考资料链接"也当成附件。
  MARKDOWN_LINK_RE.lastIndex = 0;
  let match;
  while ((match = MARKDOWN_LINK_RE.exec(content)) !== null) {
    const url = match[2];
    if (!isCc98FileHost(url)) continue;
    if (!byUrl.has(url)) byUrl.set(url, match[1].trim());
  }

  // 2) 裸 URL（含 [img]url[/img] 这种）
  FILE_HOST_RE.lastIndex = 0;
  while ((match = FILE_HOST_RE.exec(content)) !== null) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (!byUrl.has(url)) byUrl.set(url, null);
  }

  const found = [];
  for (const [url, text] of byUrl) {
    const base = filenameFromUrl(url);
    const ext = extensionOf(base);
    // 显示名已经带扩展名就直接用，否则补上 URL 里的扩展名
    const filename = text
      ? (extensionOf(text) ? text : (ext ? `${text}.${ext}` : text))
      : base;

    found.push({
      url,
      filename,
      ext,
      kind: IMAGE_EXTENSIONS.has(ext) ? "image" : "file",
    });
  }

  return found;
}

/**
 * 解析 UBB 内容中的附件
 *
 * 两条来源合并去重：
 *   1. 正文里的 file.cc98.org 链接（当前真实格式，图片不计入附件）
 *   2. 遗留的 UBB 占位符（[upload=...] / [file=...]）
 *
 * @param {string} content - UBB 格式的帖子内容
 * @returns {Array<{fileId: string|null, filename: string, mimeType: string|null, url: string}>}
 */
export function parseAttachments(content) {
  if (!content) return [];

  const attachments = [];
  const seenUrls = new Set();
  const seenIds = new Set();

  // ── 来源 1：正文里的直链（当前真实格式） ──
  for (const file of extractFileUrls(content)) {
    if (file.kind !== "file") continue;
    if (seenUrls.has(file.url)) continue;
    seenUrls.add(file.url);
    attachments.push({
      fileId: null,
      filename: file.filename,
      mimeType: null,
      url: file.url,
      ext: file.ext,
    });
  }

  // ── 来源 2：遗留 UBB 占位符 ──
  // 格式1: [upload=fileId,type=mimeType]filename[/upload]
  const re1 = /\[upload=(\d+)(?:,type=([^\]]+))?\]([^\[]+)\[\/upload\]/gi;
  let match;
  while ((match = re1.exec(content)) !== null) {
    pushLegacy(attachments, seenIds, match[1], match[3], match[2]);
  }

  // 格式2: [file=fileId]filename[/file]
  const re2 = /\[file=(\d+)\]([^\[]+)\[\/file\]/gi;
  while ((match = re2.exec(content)) !== null) {
    pushLegacy(attachments, seenIds, match[1], match[2], null);
  }

  return attachments;
}

/**
 * 从帖子对象中提取附件
 *
 * @param {object} post - 帖子/楼层对象
 * @returns {Array}
 */
export function extractAttachmentsFromPost(post) {
  if (!post) return [];

  // 楼层正文的字段名实测就是 content（/Topic/{id}/Post 返回）
  const content = post.content || post.body || post.rawContent || "";
  const fromContent = parseAttachments(content);
  if (fromContent.length > 0) return fromContent;

  // 兜底：某些接口可能单独给附件数组
  const attFields = ["attachments", "fileList", "uploadFileList", "files"];
  for (const field of attFields) {
    if (Array.isArray(post[field]) && post[field].length > 0) {
      return post[field].map(att => {
        const id = att.id || att.fileId || att.uploadId;
        const name = att.fileName || att.name || att.filename || `file_${id}`;
        return {
          fileId: id != null ? String(id) : null,
          filename: name,
          mimeType: att.type || att.mimeType || att.contentType || null,
          size: att.size || att.fileSize || null,
          url: att.url || att.downloadUrl || buildFileUrl(id, name),
        };
      });
    }
  }

  return [];
}

/**
 * 从帖子所有楼层中收集附件
 *
 * @param {Array} posts - 楼层数组
 * @returns {Array} - 去重后的附件列表
 */
export function collectAttachmentsFromPosts(posts) {
  if (!Array.isArray(posts)) return [];

  const allAtts = [];
  const seen = new Set();

  for (const post of posts) {
    for (const att of extractAttachmentsFromPost(post)) {
      // 优先用 URL 去重（新格式没有 fileId）；没有 URL 时退回 fileId
      const key = att.url || att.fileId;
      if (key && !seen.has(key)) {
        seen.add(key);
        allAtts.push(att);
      }
    }
  }

  return allAtts;
}

/**
 * 获取附件的文件类型图标/分类
 *
 * @param {string} filename
 * @returns {{category: string, icon: string}}
 */
export function getAttachmentCategory(filename) {
  const ext = extensionOf(String(filename || ""));

  const categories = {
    pdf: { category: "文档", icon: "📄" },
    doc: { category: "文档", icon: "📄" },
    docx: { category: "文档", icon: "📄" },
    ppt: { category: "演示", icon: "📊" },
    pptx: { category: "演示", icon: "📊" },
    xls: { category: "表格", icon: "📋" },
    xlsx: { category: "表格", icon: "📋" },
    csv: { category: "表格", icon: "📋" },
    zip: { category: "压缩包", icon: "📦" },
    rar: { category: "压缩包", icon: "📦" },
    "7z": { category: "压缩包", icon: "📦" },
    tar: { category: "压缩包", icon: "📦" },
    gz: { category: "压缩包", icon: "📦" },
    jpg: { category: "图片", icon: "🖼️" },
    jpeg: { category: "图片", icon: "🖼️" },
    png: { category: "图片", icon: "🖼️" },
    webp: { category: "图片", icon: "🖼️" },
    gif: { category: "图片", icon: "🖼️" },
    mp4: { category: "视频", icon: "🎬" },
    mp3: { category: "音频", icon: "🎵" },
    txt: { category: "文本", icon: "📝" },
    md: { category: "文本", icon: "📝" },
  };

  return categories[ext] || { category: "其他", icon: "📎" };
}

/**
 * 格式化文件大小
 *
 * @param {number|null} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "未知大小";
  if (bytes === 0) return "0 B";
  if (bytes < 0) return "未知大小";

  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ── 内部函数 ──────────────────────────────────────────────

function pushLegacy(list, seenIds, fileId, filename, mimeType) {
  if (seenIds.has(fileId)) return;
  seenIds.add(fileId);
  const name = String(filename).trim();
  list.push({
    fileId: String(fileId),
    filename: name,
    mimeType: mimeType || null,
    url: buildFileUrl(fileId, name),
  });
}

/**
 * 判断一个链接是不是 CC98 自己的文件服务
 * @param {string} url
 * @returns {boolean}
 */
function isCc98FileHost(url) {
  try {
    return new URL(url).hostname === "file.cc98.org";
  } catch {
    return false;
  }
}

function filenameFromUrl(url) {
  const withoutQuery = url.split("?")[0].split("#")[0];
  const last = withoutQuery.split("/").pop() || "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function extensionOf(filename) {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

/**
 * 遗留 UBB 占位符的 URL 构造
 *
 * ⚠️ 未经验证：实测中 v4 的文件都走 /v4-upload/ 直链，这个 /file/{id}/{name}
 * 形态在真实数据里一次都没被用到。只有当某帖子确实用了 [upload=数字] 时才会走到这里，
 * 届时若下载 404，就说明这条遗留路径已经失效，可以把整个分支删掉。
 */
function buildFileUrl(fileId, filename) {
  return `https://file.cc98.org/file/${fileId}/${encodeURIComponent(filename)}`;
}
