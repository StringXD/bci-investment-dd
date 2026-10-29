#!/usr/bin/env node
/**
 * gen-sections-lock — 报告章位的三表互锁
 *
 * 三方: SECTION_REGISTRY(槽位声明) / report-template.md(人读的版式) / 词表渲染(heading())。
 * 生成物 sections.lock.json 是这三方的**快照**, 目的是让「两边一起改」这件事留下痕迹:
 * 今天改注册表标题不会红, 改模板标题也不会红, 只有人眼能发现报告与模板对不上。
 *
 * 纪律: 先比对, 不一致就打印逐条 diff 并 exit 2, **一个字节都不写**。
 * 先写后报错会留下一个「看起来是新的」锁文件, 比没有锁更危险。
 *
 * 用法:
 *   node tools/gen-sections-lock.mjs            # 生成/覆盖
 *   node tools/gen-sections-lock.mjs --check    # 只比对, 漂移即 exit 2
 *   node tools/gen-sections-lock.mjs --template <file>   # 用别的模板比对(负向验证用)
 *
 * 退出码: 0 一致 | 2 漂移或模板非法
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SUPPORTED_LOCALES, makeI18n } from "../scripts/lib/i18n.mjs";
import {
  SECTION_REGISTRY,
  SECTION_TITLES_ZH,
  NUMBERED_SECTIONS,
  compareSlots,
  heading,
  parseNumberedH2,
  parseUnnumberedH2,
} from "../scripts/lib/sections.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TEMPLATE = path.join(ROOT, "assets", "templates", "report-template.md");
const DEFAULT_OUT = path.join(ROOT, "assets", "templates", "sections.lock.json");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) die(`${name} 需要一个值`);
  return v;
};
const die = (msg) => {
  console.error(msg);
  process.exit(2);
};

const check = flag("--check");
const tplPath = path.resolve(opt("--template", DEFAULT_TEMPLATE));
const outPath = path.resolve(opt("--out", DEFAULT_OUT));

if (!existsSync(tplPath)) die(`模板不存在: ${tplPath}`);
const tplRaw = readFileSync(tplPath, "utf8");
const tplSha = createHash("sha256").update(tplRaw).digest("hex");

// ---- 1. 注册表自洽: slot 必须恰好是 1..N 且与数组顺序一致
const slotsSeen = NUMBERED_SECTIONS.map((s) => s.slot);
const expectSeq = Array.from({ length: NUMBERED_SECTIONS.length }, (_, i) => i + 1);
const seqDrift = compareSlots(expectSeq, slotsSeen, { label: "registry.slot" });
if (seqDrift.length) {
  console.error("注册表槽位不连续或与顺序不一致(缺节会让整篇节号前移, 且不报错):");
  for (const x of seqDrift) console.error("  " + x);
  process.exit(2);
}

// ---- 2. 两 locale 各渲染一遍
const i18nOf = Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, makeI18n(l)]));
const slots = {};
const titles = {};
for (const loc of SUPPORTED_LOCALES) {
  const i = i18nOf[loc];
  slots[loc] = NUMBERED_SECTIONS.map((s) => heading(i, s.key));
  // 默认值必须传 SECTION_TITLES_ZH, 不能传 "": zh locale 下 t() 原样返回默认值,
  // 传空串会得到一整列空标题, 而且 --check 会自证一致(两边都空)。第一版就这样翻过车。
  titles[loc] = NUMBERED_SECTIONS.map((s) => i.t(`sections.${s.key}.title`, SECTION_TITLES_ZH[s.key]));
  const empty = titles[loc].filter((x) => !x);
  if (empty.length) die(`${loc} 有 ${empty.length} 个空标题: 词表缺 sections.*.title`);
}

// ---- 3. 模板侧
const tplNumbered = parseNumberedH2(tplRaw);
const tplUnnumbered = parseUnnumberedH2(tplRaw);
if (!tplNumbered.length) die("模板里没有带编号的 H2: 版式可能改成了列表或 H3");

// ---- 4. 中文渲染 vs 模板(模板只有中文版, 这是 template_locales 的唯一成员)
const tplDrift = compareSlots(tplNumbered, slots["zh-CN"], { label: "template↔zh" });
if (tplDrift.length) {
  console.error("模板与中文渲染不一致。改标题请同时改 SECTION_TITLES_ZH(词表) 与模板, 再重跑本脚本:");
  for (const x of tplDrift) console.error("  " + x);
  process.exit(2);
}

// ---- 5. 英文侧: 数量一致、无 CJK、格式串走 {num}. {title}
const enDrift = compareSlots(
  NUMBERED_SECTIONS.map((s) => s.slot),
  slots["en-US"].map((h) => Number((h.match(/^##\s*(\d+)[.．]/) || [])[1])),
  { label: "en.slot" }
);
if (enDrift.length) {
  console.error("英文标题的序号与槽位不一致(英文格式应为 `## {num}. {title}`):");
  for (const x of enDrift) console.error("  " + x);
  process.exit(2);
}
const enCjk = slots["en-US"].filter((h) => /[\u4e00-\u9fa5]/.test(h));
if (enCjk.length) die(`英文标题里出现中文:\n  ${enCjk.join("\n  ")}`);

// ---- 6. 无编号节: 哪些在模板里、哪些只由脚本输出
const unnumberedInTpl = {};
const notInTemplate = [];
for (const s of SECTION_REGISTRY.filter((x) => !x.numbered)) {
  const zh = heading(i18nOf["zh-CN"], s.key);
  if (tplUnnumbered.includes(zh)) unnumberedInTpl[s.key] = zh;
  else notInTemplate.push(s.key);
}

const lock = {
  schema: "sections-lock/1",
  generated_by: "tools/gen-sections-lock.mjs",
  generated_from: {
    registry: "scripts/lib/sections.mjs#SECTION_REGISTRY",
    template: path.relative(ROOT, tplPath).split(path.sep).join("/"),
    template_sha256: tplSha,
  },
  // 模板只有中文版。英文标题只存在于词表与 lock 里 —— 这是记账, 不是缺陷:
  // 英文版式一旦有人做, 这里要加 "en-US", 并且 §5 的断言会自动开始比对英文模板。
  template_locales: ["zh-CN"],
  slots,
  titles,
  unnumbered_in_template: unnumberedInTpl,
  not_in_template: notInTemplate,
};

// ---- 7. --check 只比对; 生成则先保证上面全部通过再落盘
if (check) {
  if (!existsSync(outPath)) die(`锁文件不存在, 先不带 --check 跑一次: ${outPath}`);
  const cur = JSON.parse(readFileSync(outPath, "utf8"));
  const drift = [];
  if (cur.generated_from?.template_sha256 !== lock.generated_from.template_sha256) {
    drift.push(`模板指纹变了: 锁 ${cur.generated_from?.template_sha256?.slice(0, 12)} / 现 ${lock.generated_from.template_sha256.slice(0, 12)}`);
  }
  for (const loc of SUPPORTED_LOCALES) {
    drift.push(...compareSlots(cur.slots?.[loc] ?? [], lock.slots[loc], { label: `${loc}.slots` }));
    drift.push(...compareSlots(cur.titles?.[loc] ?? [], lock.titles[loc], { label: `${loc}.titles` }));
  }
  drift.push(...compareSlots(cur.not_in_template ?? [], lock.not_in_template, { label: "not_in_template" }));
  if (drift.length) {
    console.error("章位漂移(模板/注册表/词表有一处被单独改过):");
    for (const x of drift) console.error("  " + x);
    process.exit(2);
  }
  console.log(`章位一致: ${NUMBERED_SECTIONS.length} 槽 × ${SUPPORTED_LOCALES.length} locale, 模板 ${lock.generated_from.template_sha256.slice(0, 12)}`);
  process.exit(0);
}

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
console.log(
  `已写入 ${path.relative(ROOT, outPath)}: ${NUMBERED_SECTIONS.length} 槽 × ${SUPPORTED_LOCALES.length} locale, ` +
    `模板 ${lock.generated_from.template_sha256.slice(0, 12)}, 不在模板中的无编号节 ${notInTemplate.join("/") || "无"}`
);
