/**
 * Token 归一化
 *
 * 用户从 CC98 的 localStorage 里复制出来的值**不是**裸 JWT。2026-11-01 实测到的真实形态：
 *
 *     str-Bearer eyJhbGciOiJSUzI1NiIs...
 *     └4字符┘└Bearer ┘└────── JWT ──────┘
 *
 * 也就是「4 字符随机前缀」+「Bearer 」两层包装。旧实现只认「4 字符前缀后直接跟 eyJ」，
 * 碰到这层 `Bearer ` 就整串当 token 发出去，实际发出的是
 *
 *     Authorization: Bearer str-Bearer eyJ...
 *
 * 必然 401。所以这里按「反复剥掉已知包装，直到不再变化」来写，顺序无关。
 */

/**
 * 把各种包装形态整理成纯 JWT
 * @param {string} value - 用户粘贴的原始值
 * @returns {string} - 纯 JWT（或原值，如果认不出任何包装）
 */
export function normalizeToken(value) {
  let v = String(value ?? "").trim();

  for (let guard = 0; guard < 5; guard++) {
    const before = v;

    // 1) 去掉 "Bearer "（大小写不敏感，允许多余空格）
    v = v.replace(/^bearer\s+/i, "");

    // 2) 去掉 4 字符随机前缀：仅当剩下的部分看起来确实是 token
    if (!v.startsWith("eyJ") && v.length > 4) {
      const rest = v.slice(4);
      if (/^(eyJ|bearer\s)/i.test(rest)) v = rest;
    }

    if (v === before) break;
  }

  return v;
}

/**
 * 判断一个字符串看起来像不像 JWT
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeJwt(value) {
  return /^eyJ[A-Za-z0-9_-]+\./.test(String(value ?? ""));
}
