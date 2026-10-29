#!/usr/bin/env node
/**
 * money 断言 —— 金额格式化的逐字向量表
 *
 * 向量表里的期望值是**按规则手写**的, 不是从实现快照导出的: 快照会把 bug 一起
 * 固化成「期望值」, 于是测试从此只证明「代码没变」, 不再证明「代码对」。
 *
 * 三条互相独立的规则, 任何一条写反都会让输出看起来还挺像那么回事:
 *   1. 量级词跟随 locale   (亿/万 vs B/M/K)  ← 12,000,000 zh 必须是「1200 万」
 *   2. 币种前缀跟随币种    (CNY 不加 vs $/€/£) ← 未知币种原样大写, 不猜符号
 *   3. 两者正交            (中文+美元 = "USD 12.5 亿")
 *
 * 第 6 组是尺子的自检: 把某条向量的期望值改一个字, 断言必须变红。
 * 第 7 组守「不许改回 Intl」: toLocaleString 的量级词随 ICU 版本变, 与本项目的
 * 确定性要求正面冲突, 而它读起来比手写实现干净得多, 所以特别容易被改回去。
 *
 * 用法: node tests/money.mjs     退出码 0 全过 / 1 有失败
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatMoney, formatPct, formatCount } from "../scripts/lib/money.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const VEC_PATH = path.join(HERE, "fixtures", "money-vectors.json");
const SRC_PATH = path.join(ROOT, "scripts", "lib", "money.mjs");

let fail = 0;
const ok = (m) => console.log(`  OK   ${m}`);
const ng = (m) => {
  console.log(`  FAIL ${m}`);
  fail = 1;
};
const show = (arr) => "\n         " + arr.slice(0, 5).join("\n         ") + (arr.length > 5 ? `\n         …另有 ${arr.length - 5} 条` : "");

const vec = JSON.parse(readFileSync(VEC_PATH, "utf8"));

// ---- 1. 向量表本身
const counts = { money: vec.money?.length ?? 0, pct: vec.pct?.length ?? 0, count: vec.count?.length ?? 0 };
if (vec.schema !== "money-vectors/1") {
  ng(`向量表 schema 异常: ${vec.schema}`);
} else if (counts.money < 30 || counts.pct < 3 || counts.count < 3) {
  ng(`向量太少(money ${counts.money}/pct ${counts.pct}/count ${counts.count}): 少于 30 条金额向量覆盖不到跨档进位与正交`);
} else {
  ok(`向量表可解析: money ${counts.money} 条, pct ${counts.pct} 条, count ${counts.count} 条`);
}

// ---- 2/3. 金额向量按 locale 分组逐字比对
// 分组而不是整表扫, 是因为失败时要知道「是中文口径错了还是英文口径错了」,
// 混在一起只能看到一串不匹配。
const moneyRun = (rows) => {
  const bad = [];
  for (const r of rows) {
    const got = formatMoney(r.x, { currency: r.c, locale: r.l });
    if (got !== r.want) bad.push(`${JSON.stringify(r.x)} ${r.c || "(空币种)"} ${r.l} → 得到 ${JSON.stringify(got)}, 期望 ${JSON.stringify(r.want)}${r.why ? ` [${r.why}]` : ""}`);
  }
  return bad;
};

const zhRows = vec.money.filter((r) => r.l === "zh-CN");
const enRows = vec.money.filter((r) => r.l === "en-US");
const otherRows = vec.money.filter((r) => r.l !== "zh-CN" && r.l !== "en-US");
if (otherRows.length) ng(`${otherRows.length} 条向量的 locale 既非 zh-CN 也非 en-US: 会落进 SCALES 的默认分支而掩盖缺失`);

const zhBad = moneyRun(zhRows);
if (zhBad.length === 0) ok(`中文金额 ${zhRows.length} 条逐字一致(含 1200 万 不进位、99999999 进位成 1 亿)`);
else ng(`中文金额 ${zhBad.length}/${zhRows.length} 条不一致:${show(zhBad)}`);

const enBad = moneyRun(enRows);
if (enBad.length === 0) ok(`英文金额 ${enRows.length} 条逐字一致(含 K 档一位小数、999.95M 进位成 \$1B)`);
else ng(`英文金额 ${enBad.length}/${enRows.length} 条不一致:${show(enBad)}`);

// ---- 4/5. 百分比与计数
const pctBad = vec.pct
  .map((r) => {
    const got = formatPct(r.x);
    return got === r.want ? null : `${JSON.stringify(r.x)} → ${JSON.stringify(got)}, 期望 ${JSON.stringify(r.want)}`;
  })
  .filter(Boolean);
if (pctBad.length === 0) ok(`百分比 ${vec.pct.length} 条逐字一致`);
else ng(`百分比 ${pctBad.length} 条不一致:${show(pctBad)}`);

const countBad = vec.count
  .map((r) => {
    const got = formatCount(r.x, { locale: r.l });
    return got === r.want ? null : `${JSON.stringify(r.x)} ${r.l} → ${JSON.stringify(got)}, 期望 ${JSON.stringify(r.want)}`;
  })
  .filter(Boolean);
if (countBad.length === 0) ok(`计数 ${vec.count.length} 条逐字一致(中文不加千分位, 英文加)`);
else ng(`计数 ${countBad.length} 条不一致:${show(countBad)}`);

// ---- 6. 正交性: 不靠向量间接覆盖, 显式断言两根轴互不影响
// 同一数值两种 locale: 量级词必须不同(否则说明 locale 没生效), 币种必须都在。
// 唯一的例外是 CNY 在中文侧: 中文报告不写「CNY 1200 万」, 那不是丢币种而是本币省略,
// 所以只对非 CNY 断言代码必须出现 —— 断言写宽了会假红, 写窄了会漏掉真丢币种。
const orth = [];
const probe = [
  { x: 1250000000, c: "USD" },
  { x: 12000000, c: "CNY" },
  { x: 999950000, c: "EUR" },
];
for (const p of probe) {
  const zh = formatMoney(p.x, { currency: p.c, locale: "zh-CN" });
  const en = formatMoney(p.x, { currency: p.c, locale: "en-US" });
  const zhUnit = zh.includes("亿") ? "亿" : zh.includes("万") ? "万" : "(无)";
  const enUnit = en.endsWith("B") ? "B" : en.endsWith("M") ? "M" : en.endsWith("K") ? "K" : "(无)";
  if (zhUnit === enUnit) orth.push(`${p.c} ${p.x}: 两种 locale 量级词都是 ${zhUnit} —— locale 没生效`);
  if (zh === en) orth.push(`${p.c} ${p.x}: 两种 locale 输出完全相同 ${zh}`);
  if (p.c !== "CNY" && !zh.includes(p.c)) orth.push(`${p.c} ${p.x}: 中文侧丢了币种代码 (${zh})`);
  if (p.c === "CNY" && /CNY/.test(zh)) orth.push(`${p.c} ${p.x}: 中文侧不该重复标注本币 (${zh})`);
  if (!en.includes(p.c) && !/[€$£]/.test(en)) orth.push(`${p.c} ${p.x}: 英文侧丢了币种 (${en})`);
}
if (orth.length === 0) ok(`量级词与币种正交: ${probe.length} 组同值双 locale 输出既不同也不丢币种`);
else ng(`正交性被破坏:${show(orth)}`);

// ---- 7. 尺子自检 + 依赖纪律
const mutated = moneyRun([{ ...zhRows[0], want: `${zhRows[0].want}X` }]);
const rulerOk = mutated.length === 1;

/** 去掉注释后再查。钱脚本自己的文件头就在解释「为什么不用 Intl」,
 *  不剥注释的话这条断言会被它自己的说明文档判红 —— 那种失败会训练人把它删掉。 */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split("\n")) {
    let s = line;
    if (inBlock) {
      const end = s.indexOf("*/");
      if (end === -1) continue;
      s = s.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = s.indexOf("/*");
      if (start === -1) break;
      const end = s.indexOf("*/", start + 2);
      if (end === -1) {
        s = s.slice(0, start);
        inBlock = true;
        break;
      }
      s = s.slice(0, start) + s.slice(end + 2);
    }
    out.push(s);
  }
  return out.join("\n");
}

const src = stripComments(readFileSync(SRC_PATH, "utf8"));
const banned = [];
if (/toLocaleString\s*\(/.test(src)) banned.push("toLocaleString");
if (/Intl\.NumberFormat/.test(src)) banned.push("Intl.NumberFormat");
if (banned.length === 0 && rulerOk) {
  ok("尺子自检通过(改期望值必红), 且实现不依赖 Intl/ICU");
} else {
  ng(
    [
      rulerOk ? null : "改期望值后比较仍返回空(尺子永远说 OK)",
      banned.length ? `实现里出现 ${banned.join(" / ")}: 量级词会随 Node/ICU 版本漂移` : null,
    ]
      .filter(Boolean)
      .join(" / ")
  );
}

console.log(fail ? "  存在失败项" : "  金额向量全部通过");
process.exit(fail);
