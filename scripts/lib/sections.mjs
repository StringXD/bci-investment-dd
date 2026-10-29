/**
 * sections — 报告节位的唯一真源
 *
 * 现状的问题不是「标题写在哪里」, 而是「编号由发射顺序决定」。原来的 sec()
 * 是 `secNo += 1`, 只要某个条件节不输出, 后面所有节号就整体前移一格:
 * 「结论」会印成「五、」, 与报告模板第七章、gaps 定位、跨章引用全部错位,
 * 而且不报错。改成槽位寻址后, 缺节会留下一条明确的「本节不适用」, 编号不动。
 *
 * slot 的取值与 assets/templates/report-template.md 的编号 H2 一一对应:
 *   1 资产属性门禁 … 7 结论与证据缺口, 8 股权与控制权专项(由 ownership.mjs 输出)。
 */

export const SECTION_REGISTRY = [
  { key: "inputBrief", numbered: false },
  { key: "summary", numbered: false },
  { key: "params", numbered: false, level: 3 },
  { key: "gate", slot: 1, numbered: true },
  { key: "milestones", slot: 2, numbered: true },
  { key: "scoring", slot: 3, numbered: true },
  { key: "redflags", slot: 4, numbered: true },
  { key: "runway", slot: 5, numbered: true, conditional: true },
  { key: "valuation", slot: 6, numbered: true, conditional: true },
  { key: "conclusion", slot: 7, numbered: true },
  { key: "equity", slot: 8, numbered: true },
  { key: "warnings", numbered: false },
];

/** 中文标题。中文 locale 下 t() 直接用这个默认值, 所以它是中文输出的唯一真源。 */
export const SECTION_TITLES_ZH = {
  inputBrief: "输入概要",
  summary: "摘要",
  params: "参数口径与溯源",
  gate: "资产属性门禁",
  milestones: "里程碑定位(L0-L6)",
  scoring: "九维加权评分",
  redflags: "致命红旗筛查",
  runway: "现金跑道与里程碑可达性",
  valuation: "估值口径与偏离提示",
  conclusion: "结论与证据缺口",
  equity: "股权与控制权专项",
  warnings: "警告",
};

export const NUMBERED_SECTIONS = SECTION_REGISTRY.filter((s) => s.numbered);

/** 只给编号节用: 一、二、…(zh) / 1. 2. …(en) */
export function heading(i18n, key) {
  const def = SECTION_REGISTRY.find((s) => s.key === key);
  if (!def) throw new Error(`sections: 未登记的节 ${key}`);
  const title = i18n.t(`sections.${key}.title`, SECTION_TITLES_ZH[key]);
  const hashes = "#".repeat(def.level || 2);
  if (!def.numbered) return `${hashes} ${title}`;
  return i18n.t("ui.format.h2", "## {num}、{title}", { num: i18n.numeral(def.slot), title });
}

/** 缺条件节时的占位说明。刻意不返回空字符串: 空白会让人以为这一节忘了写。 */
export function notApplicable(i18n, key, reason) {
  const def = SECTION_REGISTRY.find((s) => s.key === key);
  const title = i18n.t(`sections.${key}.title`, SECTION_TITLES_ZH[key]);
  const head = def?.numbered
    ? i18n.t("ui.format.h2", "## {num}、{title}", { num: i18n.numeral(def.slot), title })
    : `## ${title}`;
  // 独立的 key。曾与单元格值 "**不适用**" 共用 ui.notApplicable, 后果是英文版
  // 只剩 "**Not applicable**", 不适用原因整句丢失 —— 而中文版看不出问题。
  const body = i18n.t("ui.sectionSkipped", "> 本节不适用: {reason}", { reason });
  return [head, "", body];
}

/**
 * 逐条比对两串标题。返回空数组 = 一致。
 *
 * 单独抽出来是为了让「尺子本身」可以被测: tests/sections.mjs 会拿一份内存内
 * 改了一个字的副本喂进来, 断言它必须返回非空。一步到位的 `every(...)` 写法
 * 没法被测试, 而一把永远说 OK 的尺子比没有尺子更坏。
 */
export function compareSlots(expected, actual, { label = "slots" } = {}) {
  const out = [];
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i += 1) {
    const e = expected[i] ?? null;
    const a = actual[i] ?? null;
    if (e !== a) out.push(`${label}[${i}]: 期望 ${JSON.stringify(e)} / 实际 ${JSON.stringify(a)}`);
  }
  return out;
}

/** 模板里所有「带编号的 H2」, 按出现顺序。附录等无编号 H2 不在其中。 */
export function parseNumberedH2(markdown) {
  return String(markdown || "")
    .split(/\r?\n/)
    .filter((l) => /^##\s*(?:[一二三四五六七八九十]+|\d+)[、.．]/.test(l));
}

/** 模板里所有无编号 H2(摘要、附录 A-D 等)。用于区分「模板里有但不编号」与「模板里根本没有」。 */
export function parseUnnumberedH2(markdown) {
  return String(markdown || "")
    .split(/\r?\n/)
    .filter((l) => /^##\s/.test(l) && !/^##\s*(?:[一二三四五六七八九十]+|\d+)[、.．]/.test(l));
}

/**
 * 从 Markdown 里按序号取第 n 个「带编号 H2」的块。
 *
 * 为什么不按标题字符串匹配: 中英标题不同、措辞会改, 而标题一改, 匹配就静默
 * 返回 null, 长研报那一章会变成「拒答」或整块消失 —— 不报错。
 * 为什么不加 {#sec-payer} 锚点: 锚点会进入正文, 也会被 Pdf 渲染成可见文本。
 */
export function sectionBySlot(text, slot, { hashes = "##" } = {}) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  const re = new RegExp(`^${hashes}\\s*(?:[一二三四五六七八九十]+|\\d+)[、.．]`);
  let seen = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!re.test(lines[i])) continue;
    if (seen === slot - 1) {
      start = i;
      break;
    }
    seen += 1;
  }
  if (start < 0) return null;
  let end = lines.length;
  const fence = { on: false };
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) fence.on = !fence.on;
    if (!fence.on && /^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}
