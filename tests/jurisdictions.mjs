#!/usr/bin/env node
/**
 * jurisdiction 断言 —— 辖区档的校验器(P-01..P-06)
 *
 * 结构: 每份坏档都由真档**改一处**得到, 并且断言的是「错误的编号」而不只是「反正失败了」。
 * 这一层很重要: 校验器如果先报了个不相干的错, exit 2 照样发生, 但读者被指向错误的位置,
 * 于是「按提示去修」这个动作会把档改成另一个错的样子。
 *
 * 第 5 组单独测 P-05: pending 必须**不**中止。这是全篇最容易被「修好」成 exit 的路径 ——
 * 有人会认为「有未核实项就不该出报告」, 而本框架的答案是出拒答行, 因为
 * 「不知道」本身也是结论的一部分, 静默不给才是错误。
 *
 * 最后一组是尺子的自检: 故意用错误的期望编号, 断言判定器会红。
 *
 * 用法: node tests/jurisdictions.mjs     退出码 0 全过 / 1 有失败
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProfileError, FORBIDDEN_KEYS, PROFILE_IDS, REQUIRED_TOP, TOP_KEYS, loadProfile, validateProfile } from "../scripts/lib/jurisdiction.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REAL_DIR = path.join(ROOT, "assets", "jurisdictions");

let fail = 0;
const ok = (m) => console.log(`  OK   ${m}`);
const ng = (m) => {
  console.log(`  FAIL ${m}`);
  fail = 1;
};

const tmp = mkdtempSync(path.join(os.tmpdir(), "bci-jd-"));
process.on("exit", () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不该让测试变红 */
  }
});

/** 两个键集合逐条比对(顺序无关)。返回差异说明; 空数组 = 一致。 */
function compare(a, b, label) {
  const A = [...a].sort();
  const B = [...b].sort();
  const out = [];
  for (const x of A) if (!B.includes(x)) out.push(`${label}: 一侧多出 ${x}`);
  for (const x of B) if (!A.includes(x)) out.push(`${label}: 另一侧缺少 ${x}`);
  return out;
}

const clone = (x) => JSON.parse(JSON.stringify(x));const base = JSON.parse(readFileSync(path.join(REAL_DIR, "cn.json"), "utf8"));

/**
 * 把 base 改一处后写进临时目录, 再走 loadProfile 的真实路径(读文件 + 解析 + 校验)。
 * 不直接调 validateProfile: 文件名与 id 的一致性只有 loadProfile 才查得到。
 */
function loadMutated(mutate, { id = "cn" } = {}) {
  const obj = clone(base);
  mutate(obj);
  const st = JSON.parse(JSON.stringify(obj));
  if (id !== "cn") st.id = id; // 文件名仍叫 cn.json, 用来造 id 不一致
  writeFileSync(path.join(tmp, "cn.json"), JSON.stringify(st, null, 2), "utf8");
  return loadProfile(tmp, "cn");
}

/** 期待抛错: 返回 { threw, code, msg }; 不抛时 threw=false */
function expectThrow(fn) {
  try {
    fn();
    return { threw: false, code: null, msg: null };
  } catch (e) {
    if (e instanceof ProfileError) return { threw: true, code: e.code, msg: e.message };
    return { threw: true, code: "NON-PROFILE-ERROR", msg: `${e.name}: ${e.message}` };
  }
}

// ---- 1. 三份真档必须通过, 且 pending 项与设计一致
const good = [];
for (const id of PROFILE_IDS) {
  const r = expectThrow(() => loadProfile(REAL_DIR, id));
  if (!r.threw) good.push(id);
  else ng(`真档 ${id}.json 校验未通过: ${r.msg}`);
}
if (good.length === PROFILE_IDS.length) {
  const pend = Object.fromEntries(PROFILE_IDS.map((id) => [id, loadProfile(REAL_DIR, id).pending]));
  const want = { cn: 0, us: 1, eu: 1 };
  const bad = PROFILE_IDS.filter((id) => pend[id].length !== want[id]);
  if (bad.length) {
    ng(`pending 项数不符: ${bad.map((id) => `${id} 期望 ${want[id]} 实得 ${pend[id].length}`).join(", ")}`);
  } else {
    const d =
      pend.us.some((x) => x.path === "$.rev_mult") && pend.eu.some((x) => x.path === "$.rev_mult")
        ? "OK"
        : "us/eu 的 pending 里没有 $.rev_mult(履约拒答的那一项)";
    if (d === "OK") ok(`三份真档通过校验, pending 数 cn 0 / us 1 / eu 1(均为收入档边界)`);
    else ng(d);
  }
}

// ---- 2. 三份真档的语义约定: 该给的不给要红, 不该给的给了也要红
const sem = [];
const cn = loadProfile(REAL_DIR, "cn").profile;
const us = loadProfile(REAL_DIR, "us").profile;
const eu = loadProfile(REAL_DIR, "eu").profile;
if (cn.admission_only !== false) sem.push("cn.admission_only 应为 false(中国档要能评分)");
if (us.admission_only !== false) sem.push("us.admission_only 应为 false(美国档要能评分)");
if (eu.admission_only !== true) sem.push("eu.admission_only 应为 true(欧盟档只做准入对照, 否则 P-06 永不触发)");
if (cn.control_lines.charter_defined) sem.push("cn 档不该声明 charter_defined(中国有法定阈值)");
if (!us.control_lines.charter_defined) sem.push("us 档必须声明 charter_defined(没有全国统一持股阈值这回事)");
if (us.rev_mult.edges.length !== 0) sem.push("us 的 rev_mult 标了 pending 却给了 edges: 给了数字就不再是「未核实」");
if (!eu.rev_mult.edges.length === 0) sem.push("eu 的 rev_mult 标了 pending, edges 应为空数组");
for (const [id, p] of [["cn", cn], ["us", us], ["eu", eu]]) {
  if (!p.exit_channels.some((c) => c.key === "unknown")) sem.push(`${id} 缺 unknown 通道`);
  if (!p.exit_channels.some((c) => c.applicable === false)) sem.push(`${id} 没有任何 applicable:false 的通道: 「本辖区不适用」这条表达没被用上`);
  if (p.exit_channels.some((c) => /^(?:不适用|N\/A)/i.test(String(c.source_ref || "")))) {
    sem.push(`${id} 的 source_ref 自带「不适用」前缀: 模板已经写了, 会印成「不适用: 不适用: …」`);
  }
}
if (sem.length === 0) ok("三份档的语义约定成立(admission_only / charter_defined / pending 不给数 / unknown 通道)");
else ng(`真档语义不符: ${sem.join("; ")}`);

// ---- 3. 12 份坏档: 每份改一处, 断言编号
// 每条都写清「为什么要单独测这一次」, 否则删掉一条时没人知道丢了什么保障。
const BAD = [
  ["$\u002econtrol_lines 里塞 label", (o) => { o.control_lines.label = "法定控制线"; }, "P-01"],
  ["数组元素里塞 name(递归要走到数组)", (o) => { o.exit_channels[2].name = "并购"; }, "P-01"],
  ["顶层拼错键名", (o) => { o.revenue_mult = o.rev_mult; }, "P-02"],
  ["schema 写成旧版", (o) => { o.schema = "jurisdiction-profile/0"; }, "P-02"],
  ["文件名叫 cn.json 但 id 写 us", (o) => {}, "P-02"],
  ["charter_defined 与 thresholds 并存", (o) => { o.control_lines.charter_defined = true; }, "P-02"],
  ["thresholds 给空数组(等于「没有控制线」)", (o) => { o.control_lines.thresholds = []; }, "P-02"],
  ["edges 不严格递增(档位会重叠)", (o) => { o.rev_mult.edges = [0, 500000000, 100000000]; }, "P-02"],
  ["删掉 unknown 通道", (o) => { o.exit_channels = o.exit_channels.filter((c) => c.key !== "unknown"); }, "P-02"],
  ["用 eval 表达式写门槛", (o) => { o.control_lines.eval = "pct >= 50"; }, "P-03"],
  ["阈值缺 as_of", (o) => { delete o.control_lines.as_of; }, "P-04"],
  ["status 写成未知值", (o) => { o.exit_channels[0].status = "probably"; }, "P-04"],
];

const badFails = [];
for (const [why, mutate, wantCode] of BAD) {
  const r = expectThrow(() => loadMutated(mutate, why.includes("id 写 us") ? { id: "us" } : {}));
  if (!r.threw) badFails.push(`${why}: 未中止(期望 ${wantCode})`);
  else if (r.code !== wantCode) badFails.push(`${why}: 期望 ${wantCode}, 实得 ${r.code} — ${r.msg}`);
}
if (badFails.length === 0) ok(`12 份坏档均以正确编号中止(P-01×2 / P-02×7 / P-03×1 / P-04×2)`);
else ng(`坏档判定有偏差:\n         ${badFails.join("\n         ")}`);

// ---- 4. P-06 属于脚本层: 校验器对 admission_only 档本身不报错
const euValid = validateProfile(eu, { id: "eu" });
if (euValid.errors.length === 0) ok("admission_only 档在校验层合法(P-06 由脚本在评分入口处拦)");
else ng(`admission_only 档被判非法: ${euValid.errors[0].code} ${euValid.errors[0].msg}`);

// ---- 5. P-05: pending 不许中止, 但必须出现在 pending 列表里
const p05 = [];
try {
  const { pending } = loadMutated((o) => {
    o.control_lines.status = "pending";
  });
  if (!pending.some((x) => x.path === "$.control_lines")) {
    p05.push("控制线 pending 没有进 pending 列表: 报告里将既不判定也不说为什么");
  }
  if (!pending.some((x) => /控制线/.test(x.msg))) p05.push("pending 的说明里看不出是哪一项");
} catch (e) {
  p05.push(`pending 档被中止了(${e.code}): P-05 的语义是「不 exit, 出拒答行」`);
}
const p05b = (() => {
  try {
    const { pending } = loadMutated((o) => {
      o.rev_mult.status = "pending";
      o.rev_mult.edges = [];
    });
    return pending.some((x) => x.path === "$.rev_mult") ? null : "rev_mult pending 未进列表";
  } catch (e) {
    return `pending 的 rev_mult 被中止了(${e.code})`;
  }
})();
if (p05b) p05.push(p05b);
if (p05.length === 0) ok("P-05: pending 不中止且进入 pending 列表(控制线与收入档边界各验一次)");
else ng(`P-05 行为不对: ${p05.join("; ")}`);

// ---- 6. 尺子自检: 拿一个「实际必抛 P-01」的档去期待 P-02, 判定器必须红
const selfCheck = expectThrow(() => loadMutated((o) => { o.control_lines.desc = "x"; }));
const rulerOk = selfCheck.threw && selfCheck.code === "P-01" && selfCheck.code !== "P-02";
if (rulerOk) ok("尺子自检: 实际编号与期望编号不符时能被区分(不会把任何失败都算过)");
else ng(`尺子自检失败: P-01 的档被判成 ${selfCheck.code}`);

// ---- 7. schema 的键面必须与校验器一致
// schema 只是编辑器提示与 CI 预检, 权威在校验器。但两张表各改各的时候, schema
// 会继续对一份它不认识的档说「合法」—— 比没有 schema 更坏。所以这里只锁键面:
// 多一个键、少一个必需键、或把禁区键写进 properties, 都必须红。
const SCHEMA_PATH = path.join(ROOT, "assets", "schema", "jurisdiction.schema.json");
let schema = null;
try {
  schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
} catch (e) {
  ng(`jurisdiction.schema.json 不可解析: ${e.message}`);
}
if (schema) {
  const props = Object.keys(schema.properties || {});
  const drift = [
    ...compare(props, TOP_KEYS, "properties↔TOP_KEYS"),
    ...compare(schema.required || [], REQUIRED_TOP, "required↔REQUIRED_TOP"),
    ...FORBIDDEN_KEYS.filter((k) => props.includes(k)).map((k) => `properties 里出现禁区键 ${k}`),
  ];
  if (schema.additionalProperties !== false) drift.push("additionalProperties 必须为 false(否则未知键会被静默放过)");
  if (schema.$schema && !/draft-07/.test(schema.$schema)) drift.push(`$schema 不是 draft-07: ${schema.$schema}`);
  // 必需键必须是允许键的子集: 少写一个 properties 会让 required 指向空气
  for (const k of REQUIRED_TOP) if (!props.includes(k)) drift.push(`required 里的 ${k} 不在 properties 中`);
  if (drift.length === 0) ok(`schema 键面与校验器逐条一致(${props.length} 个允许键 / ${REQUIRED_TOP.length} 个必需键 / 无禁区键)`);
  else ng(`schema 与校验器漂移:\n         ${drift.join("\n         ")}`);
}

console.log(fail ? "  存在失败项" : "  辖区档断言全部通过");
process.exit(fail);
