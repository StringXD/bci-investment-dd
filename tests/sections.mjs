#!/usr/bin/env node
/**
 * sections 断言 —— 报告章位的三方互锁
 *
 * 三方: SECTION_REGISTRY / report-template.md / 词表渲染(heading())。
 * sections.lock.json 只是快照, 所以这里**不拿锁当基准**: 每条断言都从源码与模板
 * 重新算一遍, 再与锁比对。锁自己跟自己一致(两边同时错)时必须能红。
 *
 * 第 6 条是「尺子的自检」: 拿内存内改了一个字的副本喂给比较器, 断言必须返回非空。
 * 一把永远说 OK 的尺子比没有尺子更坏, 而这类尺子只有自检才发现得了。
 *
 * 用法: node tests/sections.mjs     退出码 0 全过 / 1 有失败
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TPL_PATH = path.join(ROOT, "assets", "templates", "report-template.md");
const LOCK_PATH = path.join(ROOT, "assets", "templates", "sections.lock.json");

let fail = 0;
const ok = (m) => console.log(`  OK   ${m}`);
const ng = (m) => {
  console.log(`  FAIL ${m}`);
  fail = 1;
};
const show = (arr) => arr.slice(0, 6).join("\n         ") + (arr.length > 6 ? "\n         …" : "");

const tplRaw = readFileSync(TPL_PATH, "utf8");
const i18nOf = Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, makeI18n(l)]));
const rendered = Object.fromEntries(
  SUPPORTED_LOCALES.map((l) => [l, NUMBERED_SECTIONS.map((s) => heading(i18nOf[l], s.key))])
);

// ---- 1. 锁文件存在且 schema 对
if (!existsSync(LOCK_PATH)) {
  ng("sections.lock.json 不存在: 先跑 node tools/gen-sections-lock.mjs");
} else {
  let lock = null;
  try {
    lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  } catch (e) {
    ng(`sections.lock.json 解析失败: ${e.message}`);
  }
  if (lock && lock.schema === "sections-lock/1") ok("锁文件可解析且 schema=sections-lock/1");
  else if (lock) ng(`锁文件 schema 异常: ${lock.schema}`);
}

const lock = existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, "utf8")) : { slots: {}, titles: {} };

// ---- 2. 中文渲染逐字等于模板的编号 H2
const tplNumbered = parseNumberedH2(tplRaw);
if (tplNumbered.length !== NUMBERED_SECTIONS.length) {
  ng(`模板编号 H2 ${tplNumbered.length} 条, 注册表 ${NUMBERED_SECTIONS.length} 条: 多一条少一条都不是同一份版式`);
} else {
  const d = compareSlots(tplNumbered, rendered["zh-CN"], { label: "template↔zh" });
  if (d.length === 0) ok(`中文渲染 ${tplNumbered.length} 条逐字等于模板编号 H2`);
  else ng(`中文渲染与模板不一致:\n         ${show(d)}`);
}

// ---- 3. 英文渲染: 序号连续、零 CJK、条数与中文一致
const en = rendered["en-US"];
const enNums = en.map((h) => Number((h.match(/^##\s*(\d+)[.．]/) || [])[1]));
const seq = compareSlots(NUMBERED_SECTIONS.map((s) => s.slot), enNums, { label: "en.slot" });
const cjk = en.filter((h) => /[\u4e00-\u9fa5]/.test(h));
if (seq.length === 0 && cjk.length === 0 && en.length === rendered["zh-CN"].length) {
  ok(`英文渲染 ${en.length} 条, 序号 ${enNums.join(",")}, 零 CJK`);
} else {
  ng(`英文渲染不合格: 序号 ${seq.length ? show(seq) : "OK"} / CJK ${cjk.length} 条 / 条数 ${en.length}`);
}

// ---- 4. 模板指纹: 模板被改过而锁没跟着改, 这里必须红
const tplSha = createHash("sha256").update(tplRaw).digest("hex");
if (lock.generated_from?.template_sha256 === tplSha) ok("模板指纹与锁记录一致");
else ng(`模板指纹变了(锁 ${String(lock.generated_from?.template_sha256).slice(0, 12)} / 现 ${tplSha.slice(0, 12)}): 重跑 gen-sections-lock`);

// ---- 5. 锁不得自我认证: 用源码重算的值与锁里的值逐条比
const driftAll = [];
for (const loc of SUPPORTED_LOCALES) {
  driftAll.push(...compareSlots(rendered[loc], lock.slots?.[loc] ?? [], { label: `${loc}.slots` }));
}
const titlesRecomputed = Object.fromEntries(
  SUPPORTED_LOCALES.map((l) => [
    l,
    NUMBERED_SECTIONS.map((s) => i18nOf[l].t(`sections.${s.key}.title`, SECTION_TITLES_ZH[s.key])),
  ])
);
for (const loc of SUPPORTED_LOCALES) {
  driftAll.push(...compareSlots(titlesRecomputed[loc], lock.titles?.[loc] ?? [], { label: `${loc}.titles` }));
}
if (driftAll.length === 0) ok("锁与源码重算结果逐条一致(锁未自我认证)");
else ng(`锁与源码漂移:\n         ${show(driftAll)}`);

// ---- 6. 尺子自检: 改一个字必须变红(两处独立入口)
let rulerOk = true;
const rulerMsgs = [];
const z = rendered["zh-CN"].slice();
z[3] = z[3].replace("致命红旗筛查", "致命红旗检查");
if (compareSlots(tplNumbered, z).length === 0) {
  rulerOk = false;
  rulerMsgs.push("改渲染值后比较器仍返回空");
}
const tplMut = tplRaw.split("\n").map((l) => (l === "## 四、致命红旗筛查" ? "## 四、致命红旗检查" : l));
const mutNumbered = parseNumberedH2(tplMut.join("\n"));
if (compareSlots(mutNumbered, rendered["zh-CN"]).length === 0) {
  rulerOk = false;
  rulerMsgs.push("改模板行后比较器仍返回空");
}
if (rulerOk) ok("比较器自检: 任一侧改一个字均返回非空(尺子不会永远说 OK)");
else ng(`比较器自检失败: ${rulerMsgs.join(" / ")}`);

// ---- 7. 无编号节的记账: 模板里有哪些、脚本独有哪些
const tplUn = parseUnnumberedH2(tplRaw);
const unInTpl = {};
const notInTpl = [];
for (const s of SECTION_REGISTRY.filter((x) => !x.numbered)) {
  const zh = heading(i18nOf["zh-CN"], s.key);
  if (tplUn.includes(zh)) unInTpl[s.key] = zh;
  else notInTpl.push(s.key);
}
const unDrift = [
  ...compareSlots(Object.keys(unInTpl).sort(), Object.keys(lock.unnumbered_in_template ?? {}).sort(), { label: "unnumbered" }),
  ...compareSlots(notInTpl.slice().sort(), (lock.not_in_template ?? []).slice().sort(), { label: "not_in_template" }),
];
if (unDrift.length === 0) {
  ok(`无编号节记账一致: 模板内 ${Object.keys(unInTpl).join("/")}, 模板外 ${notInTpl.join("/")}`);
} else {
  ng(`无编号节记账不一致:\n         ${show(unDrift)}`);
}

console.log(fail ? "  存在失败项" : "  章位断言全部通过");
process.exit(fail);
