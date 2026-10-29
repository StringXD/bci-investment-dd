/**
 * i18n — 输出词表与 locale 解析
 *
 * 设计取舍(与常见 i18n 库不同的三处, 每处都有理由):
 *
 * 1. 中文不用词表, 用源码内联字面量作默认值。理由: 中英两套词表互为镜像时,
 *    任何一次「顺手统一措辞」都会静默改变中文输出, 而中文输出是 33 项 golden
 *    的比对基准。把中文留在调用点, 字节级不变就是构造上成立的, 不需要靠人守。
 *    需要一份可审阅的中文清单时用 `--dump-catalog` 生成 assets/i18n/zh-CN.json
 *    (生成物, 不是真源)。
 *
 * 2. 非中文 locale 缺 key 一律抛错, 不回落中文。回落会让英文报告里混进中文
 *    而看起来「成功」—— 这是本项目最忌讳的失败形态。
 *
 * 3. 占位符未声明即抛错, 不留空。`{curreny}` 这类拼错如果只在某个分支出现,
 *    靠肉眼审查是发现不了的。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const I18N_DIR = path.join(REPO_ROOT, "assets", "i18n");

export const DEFAULT_LOCALE = "zh-CN";
export const SUPPORTED_LOCALES = ["zh-CN", "en-US"];

/** 中文序号。英文用阿拉伯数字, 由 heading() 按 locale 选择。 */
const CN_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五"];

const cache = new Map();

/** dump 收集器: key → 中文默认值, 供 --dump-catalog 生成镜像文件 */
const dump = new Map();

export class I18nError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 把外部传入的 locale 归一化。只接受受支持的两个值:
 * 宁可报错也不做「就近匹配」—— en 与 en-US 如果表现不同, 报告就不可复现。
 */
export function normalizeLocale(raw) {
  if (!raw) return DEFAULT_LOCALE;
  const v = String(raw).trim();
  const hit = SUPPORTED_LOCALES.find((x) => x.toLowerCase() === v.toLowerCase());
  if (!hit) {
    // 中英并置: locale 非法时还不知道该用哪种语言回话, 猜错就等于没报错
    throw new I18nError(
      "E-LOCALE",
      `不支持的 locale: ${v}(可用: ${SUPPORTED_LOCALES.join(", ")}) / unsupported locale; available: ${SUPPORTED_LOCALES.join(", ")}`
    );
  }
  return hit;
}

export function listInstalledLocales() {
  if (!existsSync(I18N_DIR)) return [];
  return readdirSync(I18N_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/** 中文没有词表文件(见文件头取舍 1), 返回空对象 */
export function loadCatalog(locale) {
  if (cache.has(locale)) return cache.get(locale);
  let cat = {};
  if (locale !== DEFAULT_LOCALE) {
    const p = path.join(I18N_DIR, `${locale}.json`);
    if (!existsSync(p)) {
      throw new I18nError("E-LOCALE", `缺少词表 assets/i18n/${locale}.json`);
    }
    cat = JSON.parse(readFileSync(p, "utf8"));
    if (!cat || typeof cat !== "object" || Array.isArray(cat)) {
      throw new I18nError("E-LOCALE", `词表 assets/i18n/${locale}.json 必须是对象`);
    }
  }
  cache.set(locale, cat);
  return cat;
}

/** `{name}` 插值。未声明的占位符抛错, 不留空。 */
export function interpolate(template, vars, keyHint) {
  return String(template).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, name) => {
    if (!vars || !(name in vars)) {
      throw new I18nError("E-PLACEHOLDER", `文案 ${keyHint} 使用了未声明的占位符 {${name}}`);
    }
    const v = vars[name];
    return v === null || v === undefined ? "-" : String(v);
  });
}

/**
 * 造一个 i18n 上下文。
 * @param locale  zh-CN | en-US
 */
export function makeI18n(locale = DEFAULT_LOCALE) {
  const loc = normalizeLocale(locale);
  const cat = loadCatalog(loc);

  /**
   * @param key      词表 key(ASCII, 永不翻译)
   * @param zhDefault 中文默认值 —— 中文 locale 下直接用这个, 保证逐字不变
   * @param vars     插值变量
   */
  function t(key, zhDefault, vars) {
    if (typeof zhDefault === "undefined") {
      throw new I18nError("E-INTERNAL", `t(${key}) 缺少中文默认值`);
    }
    if (loc === DEFAULT_LOCALE) {
      dump.set(key, zhDefault);
      return vars ? interpolate(zhDefault, vars, key) : String(zhDefault);
    }
    const raw = cat[key];
    if (typeof raw !== "string") {
      throw new I18nError("E-I18N-MISSING", `词表 ${loc} 缺少 key: ${key}`);
    }
    return vars ? interpolate(raw, vars, key) : raw;
  }

  /** 不参与 dump 的取值(用于同一 key 需要第二默认值的情形, 仅测试使用) */
  function peek(key) {
    return loc === DEFAULT_LOCALE ? undefined : cat[key];
  }

  function numeral(n) {
    if (loc === "en-US") return String(n);
    return CN_NUMERALS[n - 1] || String(n);
  }

  return { locale: loc, t, peek, numeral, has: (k) => Object.prototype.hasOwnProperty.call(cat, k) };
}

/** 生成中文镜像词表(按 key 排序, 便于 diff) */
export function dumpCatalog() {
  const out = {};
  for (const k of [...dump.keys()].sort()) out[k] = dump.get(k);
  return out;
}

export function resetDump() {
  dump.clear();
}

/**
 * locale 与辖区解析优先级:
 *   CLI > 输入 meta.* > 环境变量 > 包根 profile.json > 内置
 * 冲突不静默: 记录 conflicts, 由调用方决定是否告警。
 */
export function resolveContext({ cliLocale, cliJurisdiction, meta = {}, env = process.env, profile = null } = {}) {
  const conflicts = [];
  const pick = (label, layers) => {
    const hit = layers.find((x) => x && x.value);
    if (!hit) return { value: null, source: "default" };
    for (const other of layers) {
      if (other !== hit && other && other.value && other.value !== hit.value) {
        conflicts.push({ field: label, used: hit.value, overridden: other.value, source: hit.name });
      }
    }
    return { value: hit.value, source: hit.name };
  };

  const locale = pick("locale", [
    { name: "cli", value: cliLocale },
    { name: "meta", value: meta.locale },
    { name: "env", value: env.DD_LANG },
    { name: "profile", value: profile?.default_locale },
  ]);
  const jurisdiction = pick("jurisdiction", [
    { name: "cli", value: cliJurisdiction },
    { name: "meta", value: meta.jurisdiction },
    { name: "env", value: env.DD_JURISDICTION },
    { name: "profile", value: profile?.default_jurisdiction },
  ]);

  return {
    locale: normalizeLocale(locale.value || DEFAULT_LOCALE),
    localeSource: locale.source,
    jurisdiction: (jurisdiction.value || "cn").toLowerCase(),
    jurisdictionSource: jurisdiction.source,
    conflicts,
  };
}
