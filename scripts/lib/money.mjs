/**
 * money — 金额格式化的唯一实现
 *
 * 为什么不用 Intl.NumberFormat({notation:"compact"}): ICU 数据随 Node 版本变,
 * `1.2B` 与 `1.2 billion` 的取舍不可控, 而本项目的全部纪律建立在「同一个输入,
 * 任何人任何机器跑出逐字相同的字符串」上。所以自己实现, 并配向量表回归。
 *
 * 量级词跟随 locale, 币种符号跟随币种 —— 两者正交:
 *   中文 + 美元  → "USD 12.5 亿"   (中文读者要的是亿, 不是 billion)
 *   英文 + 人民币 → "CNY 1.25B"    (英文读者要的是 B, 不是亿)
 * 混着来会同时得罪两边读者。
 */

/** 与 dd_score 原有 num() 完全同构: 去尾零、去掉孤立的 "0"、"-0" 归零 */
export function trimNum(x, d = 1) {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  let s = Number(x).toFixed(d);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "" || s === "-0") s = "0";
  return s;
}

/**
 * 档位表。min 是「达到该量级」的下界, 从大到小匹配。
 * zh 的兑换比是 1e4 (万→亿), 所以不会出现进位溢出;
 * en 的兑换比是 1e3 (K→M→B), 会 —— 见 promote()。
 */
const SCALES = {
  "zh-CN": [
    { min: 1e8, div: 1e8, unit: "亿", decimals: 2 },
    { min: 1e4, div: 1e4, unit: "万", decimals: 1 },
    { min: 0, div: 1, unit: "", decimals: 0 },
  ],
  "en-US": [
    { min: 1e9, div: 1e9, unit: "B", decimals: 2 },
    { min: 1e6, div: 1e6, unit: "M", decimals: 1 },
    // K 档留一位小数: 0 位会把 1,234 印成 "$1K"(23% 的误差), 而金额的精度损失
    // 不会被读者察觉, 只会被当成事实引用
    { min: 1e3, div: 1e3, unit: "K", decimals: 1 },
    { min: 0, div: 1, unit: "", decimals: 0 },
  ],
};

const ZH_NO_PREFIX = new Set(["CNY", "RMB"]);
const EN_SYMBOLS = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" };

function prefixOf(currency, locale) {
  if (!currency) return "";
  const c = String(currency).toUpperCase();
  if (locale === "zh-CN") return ZH_NO_PREFIX.has(c) ? "" : `${c} `;
  if (EN_SYMBOLS[c]) return EN_SYMBOLS[c];
  return `${c} `;
}

/**
 * 跨档进位。999,950 按 K/M 档 0/1 位小数会印成 "1000.0M", 必须进位为 "$1B"
 * 并按新档精度重算 —— 这是最典型的「看起来对」的错误。
 *
 * 进位条件是「**舍入后真的溢出到上一档**」, 不是「值的量级够大」:
 *   12,000,000 → 1200 万 (1200 万本来就是合法写法, 进位成「0.12 亿」反而没人这么读)
 *   99,999,999 → 1 亿    (按万档四舍五入得 10000 万, 那是个不存在的说法)
 * 用「相邻档换算比」判定的旧写法在两个例子上都会判错, 因为中英的进制不同(1e4 / 1e3)。
 */
function pickScale(x, scales) {
  const a = Math.abs(x);
  let i = scales.findIndex((s) => a >= s.min);
  if (i < 0) i = scales.length - 1;
  for (let guard = 0; guard < scales.length; guard += 1) {
    const s = scales[i];
    const v = Number((x / s.div).toFixed(s.decimals));
    const coarser = i > 0 ? scales[i - 1] : null;
    if (!coarser) return { scale: s, value: v };
    // 舍入后绝对值已达到上一档的下界 → 进位, 用上一档的精度重算
    if (Math.abs(v) * s.div >= coarser.min) {
      i -= 1;
      continue;
    }
    return { scale: s, value: v };
  }
  return { scale: scales[0], value: x / scales[0].div };
}

/**
 * @param x        数值(原币种最小单位, 通常为元/美元)
 * @param currency ISO 币种码。空串/null 视为「不标币种」。
 * @param locale   zh-CN | en-US
 */
export function formatMoney(x, { currency = "CNY", locale = "zh-CN" } = {}) {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  const scales = SCALES[locale] || SCALES["zh-CN"];
  const { scale, value } = pickScale(Number(x), scales);
  const body = trimNum(value, scale.decimals);
  const neg = body.startsWith("-");
  const digits = neg ? body.slice(1) : body;
  const sign = neg ? "-" : "";
  const prefix = prefixOf(currency, locale);

  if (locale === "zh-CN") {
    // "12.5 亿" / "USD -1200 万" / "0"
    return scale.unit ? `${prefix}${sign}${digits} ${scale.unit}` : `${prefix}${sign}${digits}`;
  }
  // "$1.25B" / "CNY 1.25B" / "-$12M"
  return `${sign}${prefix}${digits}${scale.unit}`;
}

/** 百分比: 0.125 → "12.5%" */
export function formatPct(x, { decimals = 1 } = {}) {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  return `${trimNum(Number(x) * 100, decimals)}%`;
}

/** 计数: 1234 → "1,234"。中文报告里原本不用千分位, 故 zh 默认关闭。
 *  不用 toLocaleString —— 它同样依赖 ICU 数据, 与确定性要求冲突。 */
export function formatCount(x, { locale = "zh-CN", group = null } = {}) {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  const n = Number(x);
  const s = String(Math.round(n));
  const useGroup = group === null ? locale !== "zh-CN" : group;
  if (!useGroup) return s;
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 档位标签的边界显示: 与 formatMoney 同源, 避免"边界 1e8 / 标签 1 亿"两处各写 */
export function formatBandEdge(x, opts) {
  return formatMoney(x, opts);
}
