#!/usr/bin/env node
/**
 * bci-ownership v0.2.0 — 脑机接口企业股权与控制权穿透
 * 仅用 Node 标准库, 无第三方依赖 (node >= 18)。
 *
 * 与通用股权穿透的差异(BCI 企业特有):
 *   1. 高校/院所职务发明作价入股 → 除比例外还要查权属链五节点是否走完
 *   2. 教授往往不持股而团队持股, 表决权与经济利益分离 → 单独计算控制权杠杆率
 *   3. 员工持股平台由创始人担任 GP → 以少量出资控制大量表决权
 *   4. 早期多轮可转债 / SAFE → 完全稀释口径必须含 as-converted
 *   5. 长周期赛道常配 IPO 时限回购 → 单独计算回购压力
 *
 * 用法:
 *   node scripts/ownership.mjs                  # 裸跑 = --example
 *   node scripts/ownership.mjs --example        # 内置示例(故意埋入 6 处告警情形)
 *   node scripts/ownership.mjs data.json        # 计算并输出 Markdown
 *   node scripts/ownership.mjs data.json --config fund.json   # 用外部参数集计算
 *   node scripts/ownership.mjs --print-defaults # 打印内置参数为一份合法 config
 *   node scripts/ownership.mjs data.json --lang en-US         # 英文输出
 *   node scripts/ownership.mjs data.json --jurisdiction us    # 辖区(暂只影响币种默认与 JSON 标注)
 *   node scripts/ownership.mjs --dump-catalog   # 导出中文词表到 stdout(供 tools/dump-catalog.mjs 合并)
 *
 * 语言: 中文是源码内联字面量(t() 的第二个参数), 英文查 assets/i18n/en-US.json。
 * 英文缺 key 一律抛错, 不回落中文 —— 回落会让报告混进中文而看起来「成功」。
 * 中文输出与 v0.4.0 逐字相同, 由 tests/run.sh 的 examples/03 比对守着。
 *
 * 参数集(--config)与标的输入必须分开, 理由见 dd_score.mjs 头部说明。
 * 本脚本只消费 config 的 params.ownership 一块, 其余块(dd_score 用的权重与倍数)
 * 一律忽略但不报错 —— 同一份机构口径文件应能同时喂给两个脚本。
 *
 * config.params.ownership 可覆盖字段:
 *   leverage_flag    number    表决权 / 经济利益 的提示阈值, 必须 > 1
 *   esop_floor       number    期权池占总股本的下限百分比, >= 5
 *   nominee_flag     number    代持比例提示阈值百分比, >= 1
 *   redeem_rules     [[阈值, 标签, 释义], ...]   必须严格递减, 至少 2 档
 *   board_tolerance  number    董事席位与股权错配容差, 0 至 1
 *   scenarios        [{label, dilution_pct, esop_topup_pct}]
 *   lines_add        [{threshold, short, desc}]  只允许新增控制线
 *
 * 锁死项(不可覆盖, 覆盖即 exit 2):
 *   LINES 中 66.67 / 50 / 33.34 / 10 / 1 五个法定阈值 —— 是《公司法》事实, 不是偏好
 *   UCHAIN_NODES 的 id 与名称   —— 与 references/08-legal-ip.md 同名同序
 *   TYPE_NAMES / ROLE_NAMES 的键 —— schema enum
 *
 * 输入 JSON 字段:
 *   meta        {as_of, currency?, params_ref?}    as_of 必填(股权基准日)
 *   cap_table   [{holder, type, pct?, shares?, voting_pct?, board_seats?, note?}]
 *               type ∈ founder|professor|staff|staff_platform|esop_pool|fund|corp|nominee|other
 *               pct 与 shares 二者取一(同时给则以 shares 为准并告警)
 *               voting_pct 缺省 = pct(用于 AB 股或已生效的表决权委托)
 *   concert     [[甲,乙,...], ...]                 一致行动分组
 *   university  {involved, institution?, ip_form?, equity_held_by_school?,
 *                professor_role?, part_time_approved?, license_written?,
 *                nodes:[{id, status, note?}]}
 *               ip_form ∈ assignment|license|capitalized|none
 *               professor_role ∈ none|pi|department_head|dean|legal_rep
 *               nodes.id ∈ N1..N5; status ∈ done|missing|na
 *   nominal_holders [{nominal, beneficial, pct, reason?, has_agreement?}]
 *   platforms   [{name, gp, gp_control, exec_partner?, lp_count?}]
 *               gp_control ∈ founder|committee|external
 *   convertibles[{type, principal?, valuation_cap?, discount?, as_converted_pct?}]
 *               type ∈ note|safe; as_converted_pct 按「完全稀释后总股本」的百分比填写
 *   esop        {total_pct?, granted_pct?, reserved_pct?}
 *               reserved_pct 按「完全稀释后总股本」的百分比填写
 *   terms       {liquidation_pref?, anti_dilution?, redemption_trigger?,
 *                redemption_amount?, personal_guarantee?, board?, veto_matters?}
 *               liquidation_pref ∈ 1x_np|1x|2x|other
 *               redemption_trigger ∈ ipo_deadline|material_breach|performance|none
 *               board {founder, investor, independent}
 *   financials  {cash?, undrawn_credit?}
 *   scenarios   [{label, dilution_pct, esop_topup_pct}]   缺省用内置四档
 *
 * 输出节序(契约):
 *   输入概要 [→ 参数口径与溯源(H3, 仅当参数与内置默认不同时出现)]
 *   → 一 全稀释穿透 → 二 高校成果转化权属链 → 三 代持与名义持有人还原
 *   → 四 持股平台与表决权杠杆 → 五 可转债 / SAFE 摊薄模拟
 *   → 六 对赌与回购触发压力 → 七 创始人控制权稳定性推演
 *   → 八 结论与待补文件清单 → 警告
 *   二/三/四/五 为条件节: 输入缺失时**节号保留**, 该节下输出一条「本节不适用」。
 *   (v0.4.0 及以前是整节省略且节号顺延, 结果是缺一节就把「结论」印成「七、」,
 *    与报告模板的跨章引用错位, 而且不报错。)
 *
 * 退出码: 0 正常 | 1 输入读取或解析失败 | 2 参数集非法或上下文非法(--config 与 --example 互斥同此)
 *
 * 纪律:
 *   - 所有比例数字以本脚本 stdout 为准, 禁止口算覆盖或改写。
 *   - 任何输入缺失只产出「警告」, 不中断计算: 能算多少算多少。
 *   - 参数集非法一律中断(exit 2): 阈值错了, 每个结论都是错的。
 *   - 控制权推演为摊薄近似(按稀释比例线性折算), 不替代律师的精确测算。
 *   - 本脚本输出为尽调辅助分析, 不构成法律意见, 亦不构成投资建议。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOCALE,
  dumpCatalog,
  makeI18n,
  normalizeLocale,
  resetDump,
  resolveContext,
} from "./lib/i18n.mjs";
import { formatMoney } from "./lib/money.mjs";
import { ProfileError, loadProfile } from "./lib/jurisdiction.mjs";

// ============================================================
// 常量区
// ============================================================

const VERSION = "0.3.0";

/**
 * 节位表。原来靠 `secNo += 1` 顺序发号, 条件节(二/三/四/五)缺失时后面所有
 * 节号整体前移一格 —— 「结论」会印成「六、」, 与 report-template 的引用错位,
 * 而且不报错。改成槽位寻址: 缺节留一条「本节不适用」, 编号不动。
 * 与 dd_score 的 sections.mjs 同一套思路, 但本脚本是独立成篇的报告, 故自持槽位。
 */
const OWN_SECTIONS = [
  { key: "cap", slot: 1, zh: "股权结构穿透(全稀释口径)" },
  { key: "uni", slot: 2, zh: "高校成果转化权属链核查", conditional: true },
  { key: "nom", slot: 3, zh: "代持与名义持有人还原", conditional: true },
  { key: "plat", slot: 4, zh: "持股平台与表决权杠杆", conditional: true },
  { key: "conv", slot: 5, zh: "可转债 / SAFE 转股摊薄模拟", conditional: true },
  { key: "redeem", slot: 6, zh: "对赌与回购触发压力" },
  { key: "ctrl", slot: 7, zh: "创始人控制权稳定性推演" },
  { key: "concl", slot: 8, zh: "结论与待补文件清单" },
];

/** 控制线: [阈值, 简称, 释义] */
/** 内置控制线(中国档)。运行时可能被辖区档替换, 见 applyProfile。 */
let LINES = [
  [66.67, "特别决议通过线", "修改章程、增减注册资本、合并分立解散、变更公司形式"],
  [50.0, "普通决议控制线", "多数日常经营与人事事项"],
  [33.34, "特别决议否决线", "单独或联合持有即可阻却特别决议"],
  [10.0, "会议召集线", "可请求召开临时股东会(具体比例按现行《公司法》核对)"],
  [1.0, "提案线", "可提出临时提案(股份公司口径, 须核对现行条文)"],
];

/**
 * 本辖区是否「控制线由章程约定」。
 * 美国档没有全国统一的持股阈值, 此时**不能**退回内置五条: 那等于把中国的
 * 法定线当成美国的常识。也不能输出「未达任何控制线」—— 那是把「不知道」
 * 写成「没有」, 是本框架最需要避免的一类错误。
 */
let CHARTER_DEFINED = false;

/**
 * 本辖区的控制线阈值处于 status=pending(未核实)。
 *
 * 这一位不能省: thresholds 有数值不代表它已被核实。档里写了五条 66.67/50/33.34/10/1
 * 但标 pending 时, 若仍照原样输出「已越过 50% 特别决议线」, 报告就把一个未核实的
 * 阈值当成法律事实引用了 —— 而读者完全看不出来。所以此时只留表决权数字, 判定改出拒答行。
 */
let LINES_PENDING = false;

/** 高校成果转化权属链五节点, 与 references/08-legal-ip.md 同名同序 */
const UCHAIN_NODES = [
  { id: "N1", name: "职务发明认定与发明人清单", risk: "发明人含在校学生或离职人员而未签署权属确认" },
  { id: "N2", name: "学校(或资产经营公司)审批与公示", risk: "未履行公示或审批, 转化行为的效力可被质疑" },
  { id: "N3", name: "第三方评估作价报告", risk: "无评估报告将导致出资不实, 后续融资与申报受阻" },
  { id: "N4", name: "工商登记与股权交付", risk: "协议已签但未办理登记, 权属未真正转移" },
  { id: "N5", name: "收益分配与产业化考核协议", risk: "学校分成比例或考核条款与商业计划冲突" },
];

/** 控制权稳定性推演情景(缺省四档) */
const CONTROL_SCENARIOS = [
  { label: "基准", dilution_pct: 0, esop_topup_pct: 0 },
  { label: "下一轮稀释 10%", dilution_pct: 10, esop_topup_pct: 5 },
  { label: "下一轮稀释 20%", dilution_pct: 20, esop_topup_pct: 5 },
  { label: "下一轮稀释 30%", dilution_pct: 30, esop_topup_pct: 8 },
];

const REDEEM_RULES = [
  [3.0, "严重", "回购义务金额达流动性 3 倍以上, 一旦触发即构成偿付危机"],
  [1.5, "偏高", "回购义务金额超过流动性, 需提前安排替代方案或豁免"],
  [1.0, "临界", "回购义务接近流动性上限, 需披露触发条件与豁免机制"],
  [0.0, "可控", "回购义务在流动性覆盖范围内"],
];

const ESOP_FLOOR = 10;
const NOMINEE_FLAG = 5;

/** 表决权杠杆提示阈值: 表决权 / 经济利益, 超过即认定控制依赖协议安排 */
const LEVERAGE_FLAG = 1.05;

/** 董事会席位与股权错配容差: 席位占比低于表决权占比减该值即视为错配 */
const BOARD_TOLERANCE = 0.15;

const TYPE_NAMES = {
  founder: "创始人",
  professor: "高校教师",
  staff: "员工",
  staff_platform: "员工持股平台",
  esop_pool: "期权池",
  fund: "投资机构",
  corp: "产业方",
  nominee: "名义持有人",
  other: "其他",
};

/** 高校人员在校职务 → 中文表述 */
const ROLE_NAMES = {
  none: "无在校职务",
  pi: "课题负责人(PI)",
  department_head: "院系负责人",
  dean: "院长",
  legal_rep: "法定代表人",
};

/**
 * 枚举的显示名。键是 schema enum(永不翻译), 值是中文默认值。
 * 未登记的键回退为键本身 —— 输入里出现枚举外的值时, 报警告比静默显示空更好。
 */
const typeName = (k) => t(`own.type.${k}`, TYPE_NAMES[k] || k);
const roleName = (k) => t(`own.role.${k}`, ROLE_NAMES[k] || k);

const EXAMPLE_OBJ = {
  meta: { as_of: "2026-09-30", currency: "CNY" },
  cap_table: [
    { holder: "创始人 A", type: "founder", pct: 24.5, voting_pct: 30.5, board_seats: 2, note: "含教授 C 委托的 6% 表决权" },
    { holder: "联合创始人 B", type: "founder", pct: 11.0, voting_pct: 11.0, board_seats: 1 },
    { holder: "教授 C", type: "professor", pct: 6.0, voting_pct: 0, board_seats: 0, note: "表决权已委托创始人 A" },
    { holder: "某大学资产经营公司", type: "corp", pct: 4.5, voting_pct: 4.5, board_seats: 0 },
    { holder: "员工持股平台(有限合伙)", type: "staff_platform", pct: 9.0, voting_pct: 9.0, board_seats: 0 },
    { holder: "名义持有人 D", type: "nominee", pct: 3.0, voting_pct: 3.0, board_seats: 0 },
    { holder: "天使基金 E", type: "fund", pct: 12.0, voting_pct: 12.0, board_seats: 1 },
    { holder: "A 轮基金 F", type: "fund", pct: 18.0, voting_pct: 18.0, board_seats: 1 },
    { holder: "产业方 G", type: "corp", pct: 8.0, voting_pct: 8.0, board_seats: 0 },
    { holder: "期权池(预留未授予)", type: "esop_pool", pct: 4.0, voting_pct: 0, board_seats: 0 },
  ],
  concert: [["创始人 A", "联合创始人 B"]],
  university: {
    involved: true,
    institution: "某大学",
    ip_form: "capitalized",
    equity_held_by_school: 4.5,
    professor_role: "department_head",
    part_time_approved: false,
    license_written: false,
    nodes: [
      { id: "N1", status: "done", note: "发明人 3 人已签权属确认" },
      { id: "N2", status: "done", note: "2021 年第 7 次校务会审议通过并公示" },
      { id: "N3", status: "missing", note: "仅有内部协商作价, 无第三方评估报告" },
      { id: "N4", status: "done", note: "已办理工商变更" },
      { id: "N5", status: "missing", note: "收益分配比例尚未书面约定" },
    ],
  },
  nominal_holders: [
    { nominal: "名义持有人 D", beneficial: "创始人 A", pct: 3.0, reason: "早期为简化登记", has_agreement: false },
  ],
  platforms: [
    { name: "员工持股平台(有限合伙)", gp: "创始人 A", gp_control: "founder", exec_partner: "创始人 A", lp_count: 26 },
  ],
  convertibles: [
    { type: "note", principal: 20000000, valuation_cap: 600000000, discount: 0.8, as_converted_pct: 3.2 },
  ],
  esop: { total_pct: 13.0, granted_pct: 9.0, reserved_pct: 0 },
  terms: {
    liquidation_pref: "1x_np",
    anti_dilution: "broad_based",
    redemption_trigger: "ipo_deadline",
    redemption_amount: 260000000,
    personal_guarantee: true,
    board: { founder: 3, investor: 2, independent: 0 },
    veto_matters: ["章程修改", "新增融资", "核心资产处置", "高管任免"],
  },
  financials: { cash: 12000000, undrawn_credit: 3000000 },
  scenarios: CONTROL_SCENARIOS,
};

// ============================================================
// 运行期上下文: locale / 辖区 / 币种
// ============================================================

/**
 * 与 dd_score.mjs 同一套取舍: 三项运行期状态放模块级变量, 不逐层透传。
 * 理由: 中文输出必须逐字不变, 而原有函数签名里没有 locale 位置, 为传 locale
 * 去改上百个调用点的签名, 等于把「不改中文」这条约束本身变成风险源。
 * 代价是同一进程内不能并发跑两个 locale —— 本脚本是单次命令行进程, 成立。
 */
let LOCALE = DEFAULT_LOCALE;
let JURISDICTION = "cn";
let CURRENCY = "CNY";
let I18N = makeI18n(DEFAULT_LOCALE);

/** 取文案。第二个参数是中文默认值 —— 中文 locale 下原样返回, 英文查词表。 */
const t = (key, zhDefault, vars) => I18N.t(key, zhDefault, vars);
/** 列举分隔符: 中文顿号, 英文逗号。写死「、」在英文里会粘成一坨。 */
const sep = () => t("ui.sep", "、");
const list = (arr) => (Array.isArray(arr) ? arr : [arr]).join(sep());

function setContext({ locale, jurisdiction, currency }) {
  if (locale) {
    LOCALE = normalizeLocale(locale);
    I18N = makeI18n(LOCALE);
  }
  if (jurisdiction) JURISDICTION = String(jurisdiction).toLowerCase();
  if (currency) CURRENCY = String(currency).toUpperCase();
}

// ============================================================
// 工具
// ============================================================

function num(x, d = 1) {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  let s = Number(x).toFixed(d);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "" || s === "-0") s = "0";
  return s;
}

/** 金额格式化。量级词跟随 locale, 币种符号跟随币种, 两者正交(见 lib/money.mjs)。 */
function money(x) {
  return formatMoney(x, { currency: CURRENCY, locale: LOCALE });
}

const pct = (x) => num(x, 2) + "%";

/**
 * 命中哪些控制线。简称走词表: 法定阈值本身是法律事实, 但它的中文名字不是,
 * 直接拼进英文报告会得到 "66.67% 特别决议通过线" 这种半英半中。
 */
/** 内置五条的快照: 档覆盖后仍要用它做「阈值 → 简称」的对照。 */
const BUILTIN_LINES = LINES;

let PROFILE_DIR = fileURLToPath(new URL("../assets/jurisdictions/", import.meta.url));

/**
 * 用辖区档替换控制线。
 *
 * 档里只给阈值, 简称仍由词表按阈值寻址(own.line.<阈值>) —— 标签只住词表。
 * 所以档里出现一个词表没有的阈值时必须中止: 否则报告会印出「20% 」这种
 * 没有名字的线, 读者无从判断它是什么。
 */
function applyProfile(profile) {
  const cl = profile.control_lines || {};
  CHARTER_DEFINED = cl.charter_defined === true;
  // 阈值有数值 ≠ 阈值已核实。pending 时保留 LINES(还要靠它做阈值→简称的对照),
  // 但结论行不再据此判定, 见 renderOwn 里的 LINES_PENDING 分支。
  LINES_PENDING = cl.status === "pending" && Array.isArray(cl.thresholds) && cl.thresholds.length > 0;
  if (CHARTER_DEFINED) {
    LINES = [];
    return;
  }
  const ths = Array.isArray(cl.thresholds) ? cl.thresholds.map(Number) : null;
  if (!ths) {
    LINES = BUILTIN_LINES;
    return;
  }
  const unknown = ths.filter((th) => !BUILTIN_LINES.some((l) => l[0] === th));
  if (unknown.length) {
    throw new ProfileError(
      "P-02",
      "$.control_lines.thresholds",
      `阈值 ${unknown.join(", ")} 没有对应的词表条目(own.line.<阈值>): 报告会印出没有名字的控制线`
    );
  }
  LINES = ths.map((th) => BUILTIN_LINES.find((l) => l[0] === th));
}

function hitsLines(v, extraLines = []) {
  const all = [...LINES, ...extraLines].sort((a, b) => Number(b[0]) - Number(a[0]));
  const out = [];
  for (const [th, short] of all) {
    // 内置五条按阈值寻址; lines_add 新增的线没有内置译名, 原样输出(属机构数据)
    const label = LINES.some((l) => l[0] === th && l[1] === short)
      ? t(`own.line.${th}`, short)
      : short;
    if (v >= th) out.push(`${pct(th)} ${label}`);
  }
  return out;
}

// ============================================================
// 参数集: 校验与合并
// ============================================================

const isPlain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const hasVal = (x) => x !== undefined && x !== null;
const today = () => new Date().toISOString().slice(0, 10);

/** 内置默认参数集: 只含本脚本消费的字段 */
const DEFAULTS = Object.freeze({
  LEVERAGE_FLAG,
  ESOP_FLOOR,
  NOMINEE_FLAG,
  REDEEM_RULES,
  BOARD_TOLERANCE,
  SCENARIOS: CONTROL_SCENARIOS,
  LINES_ADD: [],
});

/** config 顶层允许的键: 与 dd_score 共用同一份文件, 故取并集 */
const CONFIG_KEYS = ["config_version", "id", "label", "as_of", "effective_from", "expires_on", "basis", "params", "sources", "param_sources", "derived_from", "_doc"];

/** params 允许的键: 取两个脚本的并集, 未消费的块一律忽略但不报错 */
const PARAM_KEYS = ["weights", "stage_factor", "gate_factor", "rev_mult", "milestones", "prob", "confidence", "runway", "w_cap", "deviation_threshold", "verdict_thresholds", "ownership", "rf_extensions", "_doc"];

/** params.ownership 允许的键 */
const OWN_KEYS = ["leverage_flag", "esop_floor", "nominee_flag", "redeem_rules", "board_tolerance", "scenarios", "lines_add", "_doc"];

const OWN_LABELS = {
  leverage_flag: ["LEVERAGE_FLAG", 1],
  esop_floor: ["ESOP_FLOOR", 1],
  nominee_flag: ["NOMINEE_FLAG", 1],
  redeem_rules: ["REDEEM_RULES", 4],
  board_tolerance: ["BOARD_TOLERANCE", 1],
  scenarios: ["CONTROL_SCENARIOS", 4],
  lines_add: ["LINES_ADD", 0],
};

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** 块内是否至少有一个非 null 值。数组视为一个整体: 非空即已声明 */
const blockDeclared = (b) => (Array.isArray(b) ? b.length > 0 : isPlain(b) && Object.keys(b).some((k) => k !== "_doc" && hasVal(b[k])));

function validateConfig(cfg) {
  const errors = [];
  const warns = [];
  const E = (c, m) => errors.push(`${c} ${m}`);
  const W = (c, m) => warns.push(`${c} ${m}`);

  if (!isPlain(cfg)) {
    E("V-01", "参数集必须是一个 JSON 对象");
    return { errors, warns, stale: false, proxyCount: 0, sourceRefs: [] };
  }
  for (const k of Object.keys(cfg)) {
    if (!CONFIG_KEYS.includes(k)) E("V-01", `顶层出现未知键 "${k}", 已拒绝: 拼写错误被静默忽略会让整份参数集失效而无人察觉`);
  }
  const p = isPlain(cfg.params) ? cfg.params : {};
  if (cfg.params !== undefined && !isPlain(cfg.params)) E("V-01", "params 必须是对象");
  for (const k of Object.keys(p)) {
    if (!PARAM_KEYS.includes(k)) E("V-01", `params 出现未知键 "${k}", 已拒绝`);
  }
  if (!cfg.config_version) E("V-01", "config_version 缺失, 当前应为 \"1.0\"");
  if (!cfg.id || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(String(cfg.id))) E("V-01", `id=${cfg.id || "(缺失)"} 不合规: 须匹配 ^[a-z0-9][a-z0-9-]{2,39}$`);
  if (!cfg.label) E("V-01", "label 缺失");
  if (!cfg.as_of) E("V-01", "as_of 缺失(参数观测截止日)");

  const o = isPlain(p.ownership) ? p.ownership : {};
  for (const k of Object.keys(o)) {
    if (!OWN_KEYS.includes(k)) E("V-01", `params.ownership 出现未知键 "${k}", 已拒绝`);
  }

  // 标量阈值
  const scalar = (key, min, max, unit) => {
    if (!hasVal(o[key])) return;
    const v = Number(o[key]);
    if (!isFinite(v)) E("V-04", `ownership.${key}=${o[key]} 不是数值`);
    else if (v < min || v > max) E("V-04", `ownership.${key}=${o[key]} 超出 ${min} 至 ${max} ${unit}`);
  };
  scalar("leverage_flag", 1.0001, 10, "倍");
  scalar("esop_floor", 5, 30, "%");
  scalar("nominee_flag", 1, 50, "%");
  scalar("board_tolerance", 0, 1, "");

  // 回购档位
  if (blockDeclared(o.redeem_rules)) {
    const rows = o.redeem_rules;
    if (!Array.isArray(rows) || rows.length < 2) E("V-05", "ownership.redeem_rules 至少两档");
    else {
      let prev = Infinity;
      rows.forEach((r, i) => {
        const th = Number(Array.isArray(r) ? r[0] : NaN);
        if (!isFinite(th)) E("V-05", `ownership.redeem_rules[${i}] 阈值非数值`);
        else if (th >= prev) E("V-05", `ownership.redeem_rules[${i}] 阈值 ${th} 未严格递减`);
        if (Array.isArray(r) && !String(r[1] || "").trim()) E("V-05", `ownership.redeem_rules[${i}] 缺档位标签`);
        prev = isFinite(th) ? th : prev;
      });
    }
  }

  // 情景
  if (blockDeclared(o.scenarios)) {
    if (!Array.isArray(o.scenarios) || !o.scenarios.length) E("V-05", "ownership.scenarios 必须是非空数组");
    else {
      o.scenarios.forEach((s, i) => {
        if (!isPlain(s)) { E("V-05", `ownership.scenarios[${i}] 必须是对象`); return; }
        const d = Number(s.dilution_pct);
        const t = Number(s.esop_topup_pct);
        if (!isFinite(d) || d < 0 || d > 100) E("V-05", `ownership.scenarios[${i}].dilution_pct=${s.dilution_pct} 非法`);
        if (!isFinite(t) || t < 0 || t > 100) E("V-05", `ownership.scenarios[${i}].esop_topup_pct=${s.esop_topup_pct} 非法`);
      });
    }
  }

  // 只允许新增控制线, 不允许改动法定阈值
  if (blockDeclared(o.lines_add)) {
    if (!Array.isArray(o.lines_add)) E("V-01", "ownership.lines_add 必须是数组");
    else {
      const legal = LINES.map((x) => x[0]);
      o.lines_add.forEach((r, i) => {
        const th = Number(r && r.threshold);
        if (!isFinite(th) || th <= 0 || th >= 100) { E("V-05", `ownership.lines_add[${i}].threshold 非法`); return; }
        if (legal.some((x) => Math.abs(x - th) < 1e-9)) {
          E("V-05", `ownership.lines_add[${i}] 试图改动 ${th}%: 66.67 / 50 / 33.34 / 10 / 1 五个阈值是《公司法》事实, 不是可由口径调整的偏好`);
        }
      });
    }
  }

  // 溯源(只统计 ownership.* 的引用, 其余块归 dd_score.mjs)
  const srcs = Array.isArray(cfg.sources) ? cfg.sources : [];
  const refs = isPlain(cfg.param_sources) ? cfg.param_sources : {};
  const allRefs = [...new Set(Object.entries(refs).filter(([k]) => String(k).startsWith("ownership")).flatMap(([, v]) => (Array.isArray(v) ? v : [])).filter((x) => typeof x === "string"))];
  const srcIds = new Set(srcs.map((s) => s && s.id));
  for (const r of allRefs) if (!srcIds.has(r)) E("V-16", `param_sources 引用了不存在的来源 ${r}: 强制溯源, 不留后门`);
  const levels = new Map(srcs.map((s) => [s && s.id, s && s.level]));
  const prim = allRefs.filter((r) => ["一级", "二级"].includes(levels.get(r)));
  const overridden = OWN_KEYS.filter((k) => k !== "_doc" && blockDeclared(o[k]));
  if (overridden.length && !allRefs.length) W("V-19", `参数集覆盖了 ${overridden.length} 个块但未声明任何来源: 输出将标注「未溯源」`);
  else if (allRefs.length && !prim.length) E("V-17", "param_sources 全部为三级或更低来源: 生效中参数至少需要 1 条一级或二级来源");

  let stale = false;
  if (cfg.expires_on) {
    if (String(cfg.expires_on) < today()) {
      stale = true;
      W("V-18", `参数集已于 ${cfg.expires_on} 过失效日: 输出将标注 STALE, 不阻断计算, 但结论时效性由使用方承担`);
    }
  } else {
    stale = true;
    W("V-18", "参数集未声明 expires_on: 无法判断时效性, 输出将标注 STALE");
  }

  return { errors, warns, stale, proxyCount: srcs.filter((s) => s && s.proxy === true && allRefs.includes(s.id)).length, sourceRefs: allRefs };
}

function resolveParams(cfg, opts = {}) {
  if (!cfg) return DEFAULTS;
  const o = isPlain(cfg.params) && isPlain(cfg.params.ownership) ? cfg.params.ownership : {};
  const out = {
    LEVERAGE_FLAG: DEFAULTS.LEVERAGE_FLAG,
    ESOP_FLOOR: DEFAULTS.ESOP_FLOOR,
    NOMINEE_FLAG: DEFAULTS.NOMINEE_FLAG,
    REDEEM_RULES: DEFAULTS.REDEEM_RULES,
    BOARD_TOLERANCE: DEFAULTS.BOARD_TOLERANCE,
    SCENARIOS: DEFAULTS.SCENARIOS,
    LINES_ADD: DEFAULTS.LINES_ADD,
  };
  const ov = [];
  if (hasVal(o.leverage_flag)) { out.LEVERAGE_FLAG = Number(o.leverage_flag); ov.push("leverage_flag"); }
  if (hasVal(o.esop_floor)) { out.ESOP_FLOOR = Number(o.esop_floor); ov.push("esop_floor"); }
  if (hasVal(o.nominee_flag)) { out.NOMINEE_FLAG = Number(o.nominee_flag); ov.push("nominee_flag"); }
  if (hasVal(o.board_tolerance)) { out.BOARD_TOLERANCE = Number(o.board_tolerance); ov.push("board_tolerance"); }
  if (blockDeclared(o.redeem_rules)) {
    out.REDEEM_RULES = o.redeem_rules.map((r) => [Number(r[0]), String(r[1]), String(r[2] || "")]);
    ov.push("redeem_rules");
  }
  if (blockDeclared(o.scenarios)) {
    out.SCENARIOS = o.scenarios.map((s) => ({ label: s.label || `稀释 ${Number(s.dilution_pct) || 0}%`, dilution_pct: Number(s.dilution_pct) || 0, esop_topup_pct: Number(s.esop_topup_pct) || 0 }));
    ov.push("scenarios");
  }
  if (blockDeclared(o.lines_add)) {
    out.LINES_ADD = o.lines_add.map((r) => [Number(r.threshold), String(r.short || ""), String(r.desc || "")]);
    ov.push("lines_add");
  }

  const same = Object.keys(DEFAULTS).every((k) => deepEqual(out[k], DEFAULTS[k]));
  if (same) return DEFAULTS;

  const v = validateConfig(cfg);
  out.__meta = {
    id: String(cfg.id || "unnamed"),
    hash8: opts.hash8 || "00000000",
    label: String(cfg.label || ""),
    overrides: ov,
    asOf: cfg.as_of || "",
    effectiveFrom: cfg.effective_from || "",
    expiresOn: cfg.expires_on || "",
    stale: v.stale,
    proxyCount: v.proxyCount,
    sourceRefs: v.sourceRefs,
    untraced: !v.sourceRefs.length,
    warns: v.warns,
    checks: v.warns.length ? `通过(V-01..V-19, 含 ${v.warns.length} 条提示)` : "通过(V-01..V-19)",
  };
  return out;
}

function defaultsAsConfig() {
  return {
    config_version: "1.0",
    id: "builtin-default",
    label: t("ui.builtinLabel", "内置默认参数"),
    as_of: today(),
    effective_from: today(),
    expires_on: "9999-12-31",
    basis: { upstream_version: VERSION, builtin: true },
    params: {
      ownership: {
        leverage_flag: DEFAULTS.LEVERAGE_FLAG,
        esop_floor: DEFAULTS.ESOP_FLOOR,
        nominee_flag: DEFAULTS.NOMINEE_FLAG,
        redeem_rules: DEFAULTS.REDEEM_RULES,
        board_tolerance: DEFAULTS.BOARD_TOLERANCE,
        scenarios: DEFAULTS.SCENARIOS,
        lines_add: DEFAULTS.LINES_ADD,
      },
    },
    sources: [],
    param_sources: {},
  };
}

function describeOverrides(list) {
  return list.map((k) => {
    const m = OWN_LABELS[k];
    return m ? `${m[0]}(${m[1]})` : k;
  }).join(", ");
}

// ============================================================
// 计算
// ============================================================

function analyze(d, P = DEFAULTS, extra = []) {
  const warnings = [];
  const w = (m) => warnings.push(m);
  if (P.__meta && Array.isArray(P.__meta.warns)) P.__meta.warns.forEach((x) => w(x));
  extra.forEach((x) => w(x));

  const meta = d.meta || {};
  if (!meta.as_of) w(t("own.w.asOf", "meta.as_of 缺失, 请以股权基准日填写"));

  // ---- 0. cap table 归一
  const cap = Array.isArray(d.cap_table) ? d.cap_table.filter((x) => x && x.holder) : [];
  if (!cap.length) w(t("own.w.capEmpty", "cap_table 为空: 无法进行股权穿透"));

  cap.forEach((row) => {
    if (row.pct !== undefined && row.shares !== undefined) {
      w(t("own.w.pctShares", "股东「{holder}」同时提供 pct 与 shares, 以 shares 折算为准, 请核对原始数据", { holder: row.holder }));
    }
    if (row.pct === undefined && row.shares === undefined) {
      w(t("own.w.noPctShares", "股东「{holder}」既无 pct 也无 shares, 按 0 处理", { holder: row.holder }));
    }
    if (row.type && !TYPE_NAMES[row.type]) {
      w(t("own.w.typeOut", "股东「{holder}」的 type={type} 不在取值域内, 按 other 处理", { holder: row.holder, type: row.type }));
    }
  });

  // 以 pct 为工作口径(有 shares 时按 shares 占比折算)
  const hasShares = cap.some((x) => x.shares !== undefined);
  let curTotal;
  if (hasShares) {
    const totalShares = cap.reduce((a, x) => a + (Number(x.shares) || 0), 0);
    if (totalShares <= 0) {
      w(t("own.w.sharesZero", "全部股东的 shares 合计为 0: 无法折算比例"));
      curTotal = 0;
    } else {
      curTotal = 100;
      cap.forEach((x) => {
        x._pct = Number(x.shares) ? (Number(x.shares) / totalShares) * 100 : 0;
      });
    }
  }
  if (!hasShares) {
    curTotal = cap.reduce((a, x) => a + (Number(x.pct) || 0), 0);
    cap.forEach((x) => { x._pct = Number(x.pct) || 0; });
  }
  if (curTotal > 0 && Math.abs(curTotal - 100) > 0.5) {
    w(t("own.w.totalNot100", "现有股东持股合计 {total} 不等于 100%: 可能遗漏股东(含未登记的代持或期权池), 请补齐", { total: pct(curTotal) }));
  }
  cap.forEach((x) => {
    x._vote = x.voting_pct !== undefined && x.voting_pct !== null ? Number(x.voting_pct) : x._pct;
    if (!isFinite(x._vote)) x._vote = x._pct;
  });

  // ---- 1. 全稀释
  const convs = Array.isArray(d.convertibles) ? d.convertibles.filter(Boolean) : [];
  const esop = d.esop || {};
  let convTotal = 0;
  convs.forEach((c, i) => {
    let v = Number(c.as_converted_pct);
    if (!isFinite(v) || v <= 0) {
      if (Number(c.principal) > 0 && Number(c.valuation_cap) > 0) {
        v = (Number(c.principal) / Number(c.valuation_cap)) * 100;
        w(t("own.w.convEstimated", "可转债第 {i} 笔未提供 as_converted_pct, 已按 本金 / 估值上限 估算为 {pct}, 需以协议约定为准", { i: i + 1, pct: pct(v) }));
      } else {
        v = 0;
        w(t("own.w.convMissing", "可转债第 {i} 笔缺少 as_converted_pct 且无法按估值上限估算, 摊薄模拟将偏低", { i: i + 1 }));
      }
      c._estimated = true;
    }
    c._pct = v;
    convTotal += v;
  });
  const reservedRaw = isFinite(Number(esop.reserved_pct)) ? Number(esop.reserved_pct) : 0;
  // 期权池若已作为股东行列入 cap_table, 不再额外计入, 避免重复计算
  const hasPoolRow = cap.some((x) => x.type === "esop_pool");
  const reserved = hasPoolRow ? 0 : reservedRaw;
  if (hasPoolRow && reservedRaw > 0) {
    w(t("own.w.poolDouble", "期权池同时以股东行({row})与 esop.reserved_pct({reserved})出现, 已按股东行口径计算, 请核对是否存在重复填报", {
      row: pct(cap.filter((x) => x.type === "esop_pool").reduce((a, x) => a + x._pct, 0)),
      reserved: pct(reservedRaw),
    }));
  }
  const fdTotal = curTotal + convTotal + reserved;
  if (fdTotal <= 0) w(t("own.w.fdZero", "完全稀释后总股本为 0: 无法计算稀释口径"));

  const capOut = cap.map((x) => ({
    holder: x.holder,
    type: x.type || "other",
    pctNow: x._pct,
    pctFd: fdTotal > 0 ? (x._pct / fdTotal) * 100 : 0,
    vote: x._vote,
    board: Number(x.board_seats) || 0,
    note: x.note || "",
  }));

  // ---- 2. 高校成果转化权属链
  const uni = d.university || {};
  const uniInvolved = uni.involved === true;
  // 节点名与风险说明是文案(不是输入数据), 走词表; 用户自填的 note 保持原样
  const uniNodeName = (id, fallback) => (fallback ? t(`own.uchain.${id}.name`, fallback) : id);
  const uniNodeRisk = (id, fallback) => (fallback ? t(`own.uchain.${id}.risk`, fallback) : "");
  const nodes = (Array.isArray(uni.nodes) ? uni.nodes : []).map((n) => {
    const meta2 = UCHAIN_NODES.find((u) => u.id === n.id);
    return { id: n.id, name: uniNodeName(n.id, meta2 && meta2.name), risk: uniNodeRisk(n.id, meta2 && meta2.risk), status: n.status || "missing", note: n.note || "" };
  });
  UCHAIN_NODES.forEach((u) => {
    if (uniInvolved && !nodes.find((n) => n.id === u.id)) {
      nodes.push({ id: u.id, name: uniNodeName(u.id, u.name), risk: uniNodeRisk(u.id, u.risk), status: "missing", note: t("own.ui.notProvided", "未提供") });
    }
  });
  nodes.sort((a, b) => UCHAIN_NODES.findIndex((u) => u.id === a.id) - UCHAIN_NODES.findIndex((u) => u.id === b.id));
  const applicable = nodes.filter((n) => n.status !== "na");
  const doneCnt = applicable.filter((n) => n.status === "done").length;
  const uniCompleteness = applicable.length ? doneCnt / applicable.length : 0;

  if (uniInvolved) {
    const nodeOf = (id) => nodes.find((n) => n.id === id) || { status: "missing" };
    if (Number(uni.equity_held_by_school) > 0 && nodeOf("N3").status !== "done") {
      w(t("own.w.n3Missing", "学校或资产公司已持股但缺第三方评估作价报告(N3): 存在出资不实风险, 影响后续融资与申报"));
    }
    if (["department_head", "dean", "legal_rep"].includes(uni.professor_role) && uni.part_time_approved !== true) {
      w(t("own.w.roleNotApproved", "教授担任{role}但未取得兼职或离岗创业批准: 存在任职合规与职务成果归属风险", { role: roleName(uni.professor_role) }));
    }
    if (nodeOf("N2").status === "done" && nodeOf("N4").status !== "done") {
      w(t("own.w.n4Missing", "学校审批已完成但未办理工商登记(N4 缺失): 协议已签而权属未转移"));
    }
    if (uni.ip_form === "license" && uni.license_written !== true) {
      w(t("own.w.licenseNoWritten", "知识产权为许可形态但无书面许可协议: 权属链断裂, 独占性不成立"));
    }
    if (uniCompleteness < 1) {
      w(t("own.w.chainIncomplete", "成果转化权属链完整度 {done}/{total}: 未闭合节点 {nodes}", {
        done: doneCnt,
        total: applicable.length,
        nodes: list(applicable.filter((n) => n.status !== "done").map((n) => n.id)),
      }));
    }
  }

  // ---- 3. 代持还原
  const nom = Array.isArray(d.nominal_holders) ? d.nominal_holders.filter(Boolean) : [];
  nom.forEach((n) => {
    if (!n.has_agreement) w(t("own.w.nomNoAgreement", "代持「{nominal} → {beneficial}」无书面代持协议: 还原主张缺乏证据, 申报前必须清理", { nominal: n.nominal, beneficial: n.beneficial }));
    if (Number(n.pct) >= P.NOMINEE_FLAG) w(t("own.w.nomPct", "代持比例 {pct} 达到 {flag}% 以上: 还原后表决权结构发生实质变化", { pct: pct(Number(n.pct)), flag: P.NOMINEE_FLAG }));
  });

  // ---- 4. 平台与表决权杠杆
  const platforms = Array.isArray(d.platforms) ? d.platforms.filter(Boolean) : [];
  platforms.forEach((p) => {
    if (!p.gp) w(t("own.w.platNoGp", "持股平台「{name}」未标明 GP: 无法判断表决权归属", { name: p.name }));
    if (p.gp_control && !["founder", "committee", "external"].includes(p.gp_control)) {
      w(t("own.w.platGpDomain", "持股平台「{name}」的 gp_control={v} 不在取值域内, 按 external 处理", { name: p.name, v: p.gp_control }));
    }
  });

  // ---- 创始人核心组
  const core = new Set(cap.filter((x) => ["founder", "professor"].includes(x.type)).map((x) => x.holder));
  const concert = Array.isArray(d.concert) ? d.concert.filter(Array.isArray) : [];
  const concertApplied = [];
  concert.forEach((g) => {
    const members = g.filter((m) => cap.some((x) => x.holder === m));
    if (members.length < 2) {
      w(t("own.w.concertTooSmall", "一致行动组 [{members}] 有效成员不足 2 人, 已忽略", { members: list(g) }));
      return;
    }
    if (members.some((m) => core.has(m))) {
      members.forEach((m) => core.add(m));
      concertApplied.push(members);
    }
  });
  platforms.forEach((p) => {
    if (p.gp_control === "founder" && core.has(p.gp)) core.add(p.name);
  });

  const coreRows = capOut.filter((r) => core.has(r.holder));
  const coreEcon = coreRows.reduce((a, r) => a + r.pctNow, 0);
  const coreVote = coreRows.reduce((a, r) => a + r.vote, 0);

  // 杠杆率针对单个创始人计算: 组内互相委托会在组层面相互抵消, 掩盖真实的控制权来源
  const founderRows = capOut.filter((r) => {
    const raw = cap.find((x) => x.holder === r.holder);
    return raw && raw.type === "founder";
  });
  const principalRow = founderRows.length ? founderRows.reduce((a, b) => (b.vote > a.vote ? b : a)) : null;
  const leverage = principalRow && principalRow.pctNow > 0 ? principalRow.vote / principalRow.pctNow : null;
  if (leverage !== null && leverage > P.LEVERAGE_FLAG) {
    w(t("own.w.leverage", "创始人「{holder}」以 {econ} 的经济利益控制 {vote} 表决权(杠杆 {lev} 倍): 差额来自表决权委托或特别表决权安排, 需核查有效期、可撤销性与失效条件", {
      holder: principalRow.holder,
      econ: pct(principalRow.pctNow),
      vote: pct(principalRow.vote),
      lev: num(leverage, 2),
    }));
  }

  // ---- 5. 回购压力
  const terms = d.terms || {};
  const fin = d.financials || {};
  const cash = isFinite(Number(fin.cash)) ? Number(fin.cash) : null;
  const credit = isFinite(Number(fin.undrawn_credit)) ? Number(fin.undrawn_credit) : 0;
  const liquidity = cash === null ? null : cash + credit;
  const redeem = isFinite(Number(terms.redemption_amount)) ? Number(terms.redemption_amount) : 0;
  const redeemRatio = liquidity && liquidity > 0 ? redeem / liquidity : null;
  let redeemTier = null;
  if (redeemRatio !== null) {
    P.REDEEM_RULES.forEach(([th, label, desc], idx) => {
      if (redeemRatio >= th && !redeemTier) {
        // 档位标签与释义走词表; idx 保留下来给下游判定用, 不再靠中文标签比对
        redeemTier = {
          th,
          idx,
          label: t(`own.redeem.${idx}.label`, label),
          desc: t(`own.redeem.${idx}.desc`, desc),
        };
      }
    });
  }
  if (terms.personal_guarantee === true) w(t("own.w.personalGuarantee", "存在创始人个人连带责任: 需核对担保范围与个人资产敞口"));
  if (terms.redemption_trigger && !["ipo_deadline", "material_breach", "performance", "none"].includes(terms.redemption_trigger)) {
    w(t("own.w.triggerDomain", "terms.redemption_trigger={v} 不在取值域内", { v: terms.redemption_trigger }));
  }
  if (redeem > 0 && cash === null) w(t("own.w.redeemNoCash", "存在回购义务但未提供现金数据: 无法计算回购压力"));

  // ---- 6. 控制权稳定性推演
  const scenSrc = Array.isArray(d.scenarios) && d.scenarios.length ? d.scenarios : P.SCENARIOS;
  // 内置四档的标签是文案, 要跟着语言走; 输入或参数集给的标签是数据, 一律原样保留
  const fromDefaults = scenSrc === CONTROL_SCENARIOS;
  const SCEN_KEY = ["base", "next10", "next20", "next30"];
  const scenarios = scenSrc.map((s, i) => {
    const dil = Number(s.dilution_pct) || 0;
    const top = Number(s.esop_topup_pct) || 0;
    // 近似: 新增股本 = 稀释比例 + 期权池补足(均按占现股本百分比), 原股东按比例摊薄
    const after = coreVote * (100 / (100 + dil + top));
    const label = fromDefaults && SCEN_KEY[i]
      ? t(`own.scen.${SCEN_KEY[i]}`, s.label)
      : s.label || t("own.scen.diluted", "稀释 {dil}%", { dil });
    return {
      label,
      dilution: dil,
      topup: top,
      vote: after,
      d50: after - 50,
      d3334: after - 33.34,
      needFor3334: after >= 33.34 ? 0 : 33.34 - after,
    };
  });

  // ---- 董事会
  const board = terms.board || {};
  const boardTotal = ["founder", "investor", "independent"].reduce((a, k) => a + (Number(board[k]) || 0), 0);
  const boardFounder = Number(board.founder) || 0;
  const boardCapSum = coreRows.reduce((a, r) => a + r.board, 0);
  const boardSeats = boardTotal > 0 ? boardTotal : capOut.reduce((a, r) => a + r.board, 0);
  const founderSeats = boardTotal > 0 ? boardFounder : boardCapSum;
  if (boardTotal > 0 && boardFounder > boardTotal / 2) {
    // 过半席位: 记录但不告警
  } else if (boardTotal > 0) {
    w(t("own.w.boardMinority", "创始人提名董事 {f}/{t} 席未过半: 组织控制弱于股权口径, 需结合一票否决事项评估", { f: boardFounder, t: boardTotal }));
  }
  if (boardSeats > 0 && coreVote >= 50 && founderSeats / boardSeats < coreVote / 100 - P.BOARD_TOLERANCE) {
    w(t("own.w.boardMismatch", "席位与股权错配: 表决权 {vote} 但董事席位占比仅 {seats}", {
      vote: pct(coreVote),
      seats: pct((founderSeats / boardSeats) * 100),
    }));
  }

  // ---- 期权池
  const esopTotal = isFinite(Number(esop.total_pct)) ? Number(esop.total_pct) : 0;
  if (esopTotal > 0 && esopTotal < P.ESOP_FLOOR) {
    w(t("own.w.esopLow", "期权池占总股本 {pct} 低于 {floor}% 的常见下限: BCI 关键人才竞争激烈, 后续授予空间可能不足", { pct: pct(esopTotal), floor: P.ESOP_FLOOR }));
  }

  // ---- 清算优先
  if (terms.liquidation_pref && !["1x_np", "1x", "2x", "other"].includes(terms.liquidation_pref)) {
    w(t("own.w.prefDomain", "terms.liquidation_pref={v} 不在取值域内", { v: terms.liquidation_pref }));
  }
  if (terms.liquidation_pref === "2x") {
    w(t("own.w.pref2x", "清算优先为 2 倍: 低估值退出情形下普通股可能拿不到对价, 需做清算瀑布测算"));
  }

  // ---- 结论与待补文件
  const todo = [];
  if (!cap.length) todo.push(t("own.todo.capTable", "完整股权结构表(含全部股东、持股平台与期权池)"));
  if (uniInvolved && uniCompleteness < 1) todo.push(t("own.todo.uniChain", "成果转化五节点全套文件(发明人确认、学校批文与公示、评估报告、工商档案、收益分配协议)"));
  if (nom.some((n) => !n.has_agreement)) todo.push(t("own.todo.nominee", "代持协议原件与资金往来凭证(或代持解除协议)"));
  if (convs.some((c) => c._estimated)) todo.push(t("own.todo.convertible", "可转债 / SAFE 全套协议(含转股价、估值上限、折扣与到期安排)"));
  if (redeem > 0) todo.push(t("own.todo.redeem", "对赌与回购条款全文(触发条件、义务人、金额上限、豁免机制)"));
  if (terms.personal_guarantee) todo.push(t("own.todo.guarantee", "创始人个人连带担保文件与资产状况说明"));
  if (boardSeats === 0) todo.push(t("own.todo.charter", "公司章程与董事会构成、一票否决事项清单"));
  if (!todo.length) todo.push(t("own.todo.none", "无重大缺口, 建议补充最近一次融资的 SHA 全文以复核条款"));

  return {
    meta, capOut, curTotal, convTotal, reserved, fdTotal,
    uniInvolved, nodes, applicable, doneCnt, uniCompleteness, uni,
    nom, platforms, concertApplied, convs,
    core, coreRows, coreEcon, coreVote, principalRow, leverage,
    terms, cash, credit, liquidity, redeem, redeemRatio, redeemTier,
    scenarios, boardTotal, boardFounder, boardSeats, founderSeats,
    esopTotal, todo, warnings,
    paramsMeta: P.__meta || null,
  };
}

// ============================================================
// 渲染
// ============================================================

function render(r, P = DEFAULTS) {
  const L = [];
  const p = (s = "") => L.push(s);

  // 节号按槽位取(OWN_SECTIONS.slot), 不再由发射顺序自增
  const secDef = (key) => {
    const d = OWN_SECTIONS.find((s) => s.key === key);
    if (!d) throw new Error(`ownership: 未登记的节 ${key}`);
    return d;
  };
  const sec = (key) => {
    const d = secDef(key);
    return t("ui.format.h2", "## {num}、{title}", {
      num: I18N.numeral(d.slot),
      title: t(`own.sec.${key}.title`, d.zh),
    });
  };
  /** 条件节缺数据时的占位。不能直接不输出: 后面所有节号会整体前移一格。 */
  const secSkip = (key, zhReason) => {
    p(sec(key));
    p("");
    p(t("ui.sectionSkipped", "> 本节不适用: {reason}", { reason: t(`own.skip.${key}`, zhReason) }));
    p("");
  };

  const bar = "=".repeat(56);
  p(bar);
  p(r.paramsMeta ? `BCI OWNERSHIP & CONTROL  v${VERSION}  |  params: ${r.paramsMeta.id}@${r.paramsMeta.hash8}` : `BCI OWNERSHIP & CONTROL  v${VERSION}`);
  p(bar);
  p("");

  p("## " + t("sections.inputBrief.title", "输入概要"));
  p(t("own.s.brief.asOf", "- 股权基准日: {asOf} | 币种: {cur}", { asOf: r.meta.as_of || "-", cur: CURRENCY }));
  p(t("own.s.brief.holders", "- 股东数: {n} | 现股本口径合计: {total}", { n: r.capOut.length, total: pct(r.curTotal) }));
  p(t("own.s.brief.fdAdjust", "- 完全稀释调整: {adjust} → 稀释后总口径 {total}", {
    adjust: [
      r.convTotal > 0 ? t("own.s.brief.convPart", "可转债 {pct}", { pct: pct(r.convTotal) }) : null,
      r.reserved > 0 ? t("own.s.brief.reservedPart", "期权池预留 {pct}", { pct: pct(r.reserved) }) : null,
    ].filter(Boolean).join(" + ") || t("own.s.brief.none", "无"),
    total: pct(r.fdTotal),
  }));
  p(t("own.s.brief.core", "- 创始人核心组: {members}", { members: list([...r.core]) || t("own.s.brief.coreNone", "未识别") }));
  p("");

  // ---- 参数口径与溯源(H3, 刻意不编号, 理由同 dd_score.mjs)
  if (r.paramsMeta) {
    const m = r.paramsMeta;
    p("### " + t("sections.params.title", "参数口径与溯源"));
    p(t("own.s.params.id", "- 参数集: {id} | 基线: 内置默认 v{v} | 校验: {checks}", { id: m.id, v: VERSION, checks: m.checks }));
    p(t("own.s.params.range", "- 覆盖范围: {overrides} | 其余沿用默认", { overrides: describeOverrides(m.overrides) || t("own.s.brief.none", "无") }));
    p(t("own.s.params.src", "- 参数来源: {refs} | 未溯源项: {untraced} | 代理样本项: {proxy}", {
      refs: m.sourceRefs.length ? m.sourceRefs.join(", ") : t("own.s.params.undeclared", "未声明"),
      untraced: m.untraced ? m.overrides.length : 0,
      proxy: m.proxyCount,
    }));
    p(t("own.s.params.dates", "- 生效日: {from} | 失效日: {to} | 状态: {status}", {
      from: m.effectiveFrom || "-",
      to: m.expiresOn || "-",
      status: m.stale ? "STALE" : t("own.s.params.active", "生效中"),
    }));
    p(t("own.s.params.note", "> 本节说明本次计算所用的方法学参数来源与版本。参数为方法学假设, 不构成对任何主体的法律意见。"));
    p("");
  }

  // ---- 一、全稀释穿透
  p(sec("cap"));
  p(t("own.tbl.cap.header", "| 主体 | 类型 | 现持股 | 全稀释 | 表决权 | 董事席位 | 备注 |"));
  p("|---|---|---|---|---|---|---|");
  for (const x of [...r.capOut].sort((a, b) => b.pctNow - a.pctNow)) {
    const isCore = r.core.has(x.holder);
    p(`| ${isCore ? `**${x.holder}**` : x.holder} | ${typeName(x.type)} | ${pct(x.pctNow)} | ${pct(x.pctFd)} | ${pct(x.vote)} | ${x.board || "-"} | ${x.note || "-"} |`);
  }
  if (r.convTotal > 0) {
    p(t("own.tbl.cap.convRow", "| 可转债 / SAFE(未转股) | 未转股工具 | - | {fd} | {vote} | - | 转股后成为普通股 |", {
      fd: pct(r.convTotal),
      vote: pct(r.convTotal),
    }));
  }
  p(t("own.tbl.cap.total", "| **合计** | | **{now}** | **{fd}** | **{vote}** | **{board}** | |", {
    now: pct(r.capOut.reduce((a, x) => a + x.pctNow, 0)),
    fd: pct(r.capOut.reduce((a, x) => a + x.pctFd, 0) + (r.convTotal > 0 && r.fdTotal > 0 ? (r.convTotal / r.fdTotal) * 100 : 0)),
    vote: pct(r.capOut.reduce((a, x) => a + x.vote, 0)),
    board: r.capOut.reduce((a, x) => a + x.board, 0),
  }));
  p("");
  if (r.concertApplied.length) {
    p(t("own.s.cap.concert", "- 已合并的一致行动组: {groups}", { groups: r.concertApplied.map((g) => `[${list(g)}]`).join("; ") }));
  }
  p("");

  // ---- 二、成果转化权属链(条件节)
  if (r.uniInvolved) {
    p(sec("uni"));
    p(t("own.s.uni.note", "> 比例对不等于权属对。五节点任一缺失, 都可能使核心技术的权属在申报或诉讼中被质疑。"));
    p("");
    p(t("own.tbl.uni.header", "| 节点 | 名称 | 状态 | 若缺失的风险 | 备注 |"));
    p("|---|---|---|---|---|");
    for (const n of r.nodes) {
      const st = n.status === "done"
        ? t("own.status.done", "已闭合")
        : n.status === "na"
          ? t("own.status.na", "不适用")
          : t("own.status.missing", "**未闭合**");
      p(`| ${n.id} | ${n.name} | ${st} | ${n.risk} | ${n.note || "-"} |`);
    }
    p("");
    p(t("own.s.uni.completeness", "- 完整度: **{done}/{total}**({pct})", {
      done: r.doneCnt,
      total: r.applicable.length,
      pct: pct(r.uniCompleteness * 100),
    }));
    p(t("own.s.uni.facts", "- 知识产权形态: {ip} | 学校或资产公司持股: {equity} | 教授在校职务: {role} | 兼职批准: {approved}", {
      ip: r.uni.ip_form || t("own.s.uni.ipUndeclared", "未说明"),
      equity: pct(Number(r.uni.equity_held_by_school) || 0),
      role: r.uni.professor_role ? roleName(r.uni.professor_role) : t("own.s.uni.ipUndeclared", "未说明"),
      approved: r.uni.part_time_approved === true
        ? t("own.s.uni.approved", "已批")
        : t("own.s.uni.notApproved", "**未批或未提供**"),
    }));
    p("");
  } else {
    secSkip("uni", "输入未涉及高校或院所成果转化");
  }

  // ---- 三、代持还原(条件节)
  if (r.nom.length) {
    p(sec("nom"));
    p(t("own.tbl.nom.header", "| 名义持有人 | 实际持有人 | 比例 | 原因 | 书面协议 | 风险 |"));
    p("|---|---|---|---|---|---|");
    for (const n of r.nom) {
      const agreed = n.has_agreement ? t("own.nom.has", "有") : t("own.nom.hasNot", "**无**");
      const risk = n.has_agreement
        ? t("own.nom.riskOk", "还原路径可执行, 但申报前仍须清理")
        : t("own.nom.riskNo", "还原主张缺证据, 存在权属争议与申报障碍");
      p(`| ${n.nominal} | ${n.beneficial} | ${pct(Number(n.pct) || 0)} | ${n.reason || "-"} | ${agreed} | ${risk} |`);
    }
    p("");
    p(t("own.s.nom.note", "> 代持还原同时转移经济利益与表决权。报告中须并列呈现「还原前」与「还原后」两套口径, 不得自行取舍。"));
    p("");
  } else {
    secSkip("nom", "输入未提供代持或名义持有人信息");
  }

  // ---- 四、平台与杠杆(条件节)
  if (r.platforms.length) {
    p(sec("plat"));
    p(t("own.tbl.plat.header", "| 平台 | GP | 控制归属 | 执行事务合伙人 | LP 数 |"));
    p("|---|---|---|---|---|");
    for (const x of r.platforms) {
      p(`| ${x.name} | ${x.gp || "-"} | ${x.gp_control ? t(`own.gpc.${x.gp_control}`, x.gp_control) : t("own.s.uni.ipUndeclared", "未说明")} | ${x.exec_partner || "-"} | ${x.lp_count || "-"} |`);
    }
    p("");
    p(t("own.s.plat.core", "- 创始人核心组: 经济利益 {econ}, 有效表决权 {vote}", { econ: pct(r.coreEcon), vote: pct(r.coreVote) }));
    if (r.principalRow) {
      p(t("own.s.plat.principal", "- 首席创始人「{holder}」: 经济利益 {econ}, 表决权 {vote}, 杠杆率 **{lev}**", {
        holder: r.principalRow.holder,
        econ: pct(r.principalRow.pctNow),
        vote: pct(r.principalRow.vote),
        lev: r.leverage !== null ? num(r.leverage, 2) : "-",
      }));
    }
    if (r.leverage !== null && r.leverage > P.LEVERAGE_FLAG) {
      p(t("own.s.plat.leveraged", "- 杠杆存在意味着表决权多于经济利益, 来源通常是平台 GP 控制、表决权委托或特别表决权安排。该安排的价值在于稳定性, 风险在于可撤销性: 需核查合伙协议中 GP 更换、退伙与份额转让条款, 以及一致行动协议的有效期与解除条件。"));
    } else {
      p(t("own.s.plat.aligned", "- 表决权与经济利益基本一致(杠杆率不大于 {flag}), 控制权主要依赖股权本身而非协议安排。", { flag: num(P.LEVERAGE_FLAG, 2) }));
    }
    p("");
  } else {
    secSkip("plat", "输入未提供持股平台信息");
  }

  // ---- 五、可转债摊薄(条件节)
  if (r.convs.length) {
    p(sec("conv"));
    p(t("own.tbl.conv.header", "| 序号 | 类型 | 本金 | 估值上限 | 折扣 | 计入稀释 | 说明 |"));
    p("|---|---|---|---|---|---|---|");
    r.convs.forEach((c, i) => {
      const basis = c._estimated
        ? t("own.s.conv.estimated", "按估值上限估算, 需以协议为准")
        : t("own.s.conv.agreed", "按协议约定");
      p(`| ${i + 1} | ${c.type || "-"} | ${money(Number(c.principal))} | ${money(Number(c.valuation_cap))} | ${c.discount ? num(Number(c.discount) * 100, 0) + "%" : "-"} | ${pct(c._pct)} | ${basis} |`);
    });
    p("");
    p(t("own.s.conv.total", "- 转股后合计稀释: {pct}; 该部分已在第一节的全稀释列体现。", { pct: pct(r.convTotal) }));
    p(t("own.s.conv.check", "- 需重点核对: 下一轮投前估值低于估值上限时按上限转股、高于上限时按折扣转股, 两种情形对创始团队的稀释差可能达到数个百分点。"));
    p("");
  } else {
    secSkip("conv", "输入未提供可转债或 SAFE");
  }

  // ---- 六、对赌与回购
  p(sec("redeem"));
  p(t("own.tbl.redeem.header", "| 项 | 内容 |"));
  p("|---|---|");
  p(t("own.s.redeem.pref", "| 清算优先 | {v} |", { v: r.terms.liquidation_pref || t("own.ui.notProvided", "未提供") }));
  p(t("own.s.redeem.anti", "| 反稀释 | {v} |", { v: r.terms.anti_dilution || t("own.ui.notProvided", "未提供") }));
  p(t("own.s.redeem.trigger", "| 回购触发条件 | {v} |", { v: r.terms.redemption_trigger || t("own.ui.notProvided", "未提供") }));
  p(t("own.s.redeem.amount", "| 回购义务金额 | {v} |", { v: money(r.redeem) }));
  p(t("own.s.redeem.liquidity", "| 可动用流动性 | {v} |", { v: money(r.liquidity) }));
  p(t("own.s.redeem.ratio", "| 回购 / 流动性 | {v} |", {
    v: r.redeemRatio !== null ? t("own.s.redeem.times", "{v} 倍", { v: num(r.redeemRatio, 2) }) : "-",
  }));
  p(t("own.s.redeem.tier", "| 压力档位 | {v} |", { v: r.redeemTier ? `**${r.redeemTier.label}**` : "-" }));
  p(t("own.s.redeem.guarantee", "| 创始人个人连带 | {v} |", {
    v: r.terms.personal_guarantee === true ? t("own.s.redeem.has", "**有**") : t("own.s.redeem.none", "无或未提供"),
  }));
  p("");
  if (r.redeemTier) p(t("own.s.redeem.verdict", "- 判定: {desc}", { desc: r.redeemTier.desc }));
  if (Array.isArray(r.terms.veto_matters) && r.terms.veto_matters.length) {
    p(t("own.s.redeem.veto", "- 投资人一票否决事项: {items}", { items: list(r.terms.veto_matters) }));
  }
  p("");

  // ---- 七、控制权推演
  p(sec("ctrl"));
  p(t("own.s.ctrl.note", "> 按稀释比例线性折算的近似推演, 用于识别临界点, 不替代律师的精确测算。"));
  p("");
  p(t("own.tbl.ctrl.header", "| 情景 | 新增稀释 | 期权池补足 | 核心组表决权 | 距 50% | 距 33.34% | 守住否决线还需联合 |"));
  p("|---|---|---|---|---|---|---|");
  for (const s of r.scenarios) {
    p(`| ${s.label} | ${s.dilution}% | ${s.topup}% | **${pct(s.vote)}** | ${s.d50 >= 0 ? "+" : ""}${num(s.d50, 2)} | ${s.d3334 >= 0 ? "+" : ""}${num(s.d3334, 2)} | ${s.needFor3334 > 0 ? pct(s.needFor3334) : t("own.s.ctrl.noNeed", "无需")} |`);
  }
  p("");
  const firstLoss = r.scenarios.find((s) => s.vote < 33.34);
  const firstNo50 = r.scenarios.find((s) => s.vote < 50);
  if (firstNo50) p(t("own.s.ctrl.lose50", "- 在「{label}」情景下核心组表决权跌破 50%, 失去普通决议单方控制。", { label: firstNo50.label }));
  if (firstLoss) p(t("own.s.ctrl.loseVeto", "- 在「{label}」情景下核心组表决权跌破 33.34%, 失去特别决议否决权: 后续任何增资、章程修改均可能被动接受。", { label: firstLoss.label }));
  p(t("own.s.ctrl.board", "- 董事会: 创始人提名 {f}/{total} 席{majority}", {
    f: r.founderSeats,
    total: r.boardSeats,
    majority: r.boardSeats > 0 && r.founderSeats > r.boardSeats / 2
      ? t("own.s.ctrl.majority", ", 已过半")
      : t("own.s.ctrl.minority", ", 未过半"),
  }));
  p("");

  // ---- 八、结论与待补
  p(sec("concl"));
  const concl = [];
  if (r.uniInvolved && r.uniCompleteness < 1) {
    concl.push(t("own.concl.uniChain", "成果转化权属链未闭合({done}/{total})", { done: r.doneCnt, total: r.applicable.length }));
  }
  if (r.nom.some((n) => !n.has_agreement)) concl.push(t("own.concl.nominee", "存在无书面协议的代持"));
  // 档位判定看 idx 不看标签: 标签是文案, 一改文案判定就静默失效
  if (r.redeemTier && r.redeemTier.idx <= 1) {
    concl.push(t("own.concl.redeem", "回购压力{label}", { label: r.redeemTier.label }));
  }
  if (r.terms.personal_guarantee === true) concl.push(t("own.concl.guarantee", "创始人个人连带"));
  if (r.leverage !== null && r.leverage > P.LEVERAGE_FLAG) {
    concl.push(t("own.concl.leverage", "控制权依赖协议杠杆({lev} 倍)", { lev: num(r.leverage, 2) }));
  }
  p(concl.length
    ? t("own.s.concl.risks", "- 主要风险点: {items}。", { items: concl.join("; ") })
    : t("own.s.concl.none", "- 未发现结构性控制权风险。"));
  // 三种「不知道」必须分开写, 混成一句会把风险读反:
  //   章程约定       → 不知道阈值是多少(且本辖区没有统一阈值这回事)
  //   status=pending → 阈值有草稿但没核实过
  //   未达任何线     → 知道阈值, 且确实一条都没到
  if (LINES_PENDING) {
    p(t("own.s.concl.voteOnly", "- 核心组表决权 {vote}。", { vote: pct(r.coreVote) }));
    p(
      t(
        "own.s.concl.pendingLines",
        "> 拒答: 本辖区({jd})的控制线阈值未核实(辖区档 status=pending), 因此不判定核心组表决权是否越过任何控制线。原因: 未核实的阈值一旦被当作事实引用, 结论会被读成「已越过 50%」。补齐来源后重跑本脚本。",
        { jd: JURISDICTION }
      )
    );
  } else {
    p(t("own.s.concl.line", "- 核心组表决权 {vote}, 对应控制线: {lines}", {
      vote: pct(r.coreVote),
      // 「本档不给默认阈值」与「没达到任何线」是两件完全不同的事。
      // 前者是不知道, 后者是知道且为零 —— 混成一句会把风险读反。
      lines: CHARTER_DEFINED
        ? t("own.s.concl.charterLines", "控制线由公司章程与投资人协议约定, 本档不给默认阈值(未取得章程前不作为结论依据)")
        : hitsLines(r.coreVote, P.LINES_ADD).join("; ") || t("own.s.concl.noLine", "未达任何控制线"),
    }));
  }
  p("");
  p("### " + t("own.ui.todo", "待补文件"));
  // 变量名不能叫 t: 会遮蔽模块级的取文案函数
  for (const item of r.todo) p(`- ${item}`);
  p("");

  p("## " + t("sections.warnings.title", "警告"));
  const uniq = [...new Set(r.warnings)];
  if (uniq.length) for (const x of uniq) p(`- ⚠ ${x}`);
  else p(t("own.s.warn.none", "- 未发现需要提示的异常; 现有股东合计校验通过, 未检出循环持股与口径冲突。"));
  p("");

  return L.join("\n");
}

// ============================================================
// main
// ============================================================

const argv = process.argv.slice(2);
const KNOWN_FLAGS = ["--example", "--print-defaults", "--json", "--dump-catalog"];

let configPath = null;
let cliLocale = null;
let cliJurisdiction = null;
let cliProfileDir = null;
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--config" || a === "--profiles") {
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      console.error(`${a} 需要一个${a === "--profiles" ? "目录" : "文件"}路径`);
      process.exit(2);
    }
    if (a === "--config") configPath = next;
    else cliProfileDir = next;
    i += 1;
    continue;
  }
  if (a.startsWith("--config=")) {
    configPath = a.slice("--config=".length);
    continue;
  }
  if (a.startsWith("--profiles=")) {
    cliProfileDir = a.slice("--profiles=".length);
    continue;
  }
  if (a === "--lang" || a === "--jurisdiction") {
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      console.error(`${a} 需要一个值`);
      process.exit(2);
    }
    if (a === "--lang") cliLocale = next;
    else cliJurisdiction = next;
    i += 1;
    continue;
  }
  if (a.startsWith("--lang=")) {
    cliLocale = a.slice("--lang=".length);
    continue;
  }
  if (a.startsWith("--jurisdiction=")) {
    cliJurisdiction = a.slice("--jurisdiction=".length);
    continue;
  }
  rest.push(a);
}

const unknown = rest.find((a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a));
if (unknown) {
  console.error(`未知参数 ${unknown}; 可用: ${KNOWN_FLAGS.join(" ")} --config <file> --profiles <dir> --lang <zh-CN|en-US> --jurisdiction <cn|us|eu>`);
  process.exit(2);
}
// 档目录可换: 让「status=pending 的阈值不许被当事实印出来」这条能被实测到。
// 目录不存在时立刻中止 —— 静默回落内置目录会让测试以为自己验证了坏档。
if (cliProfileDir) {
  PROFILE_DIR = path.resolve(cliProfileDir);
  if (!existsSync(PROFILE_DIR)) {
    console.error(`--profiles 目录不存在: ${PROFILE_DIR}`);
    process.exit(2);
  }
}
const wantExample = rest.includes("--example");
const wantPrint = rest.includes("--print-defaults");
const wantJson = rest.includes("--json");
const positional = rest.filter((a) => !a.startsWith("--"));

/**
 * 解析并落地运行期上下文。locale / 辖区属于参数, 非法即中止(exit 2):
 * 语言错了, 整份报告的措辞都不可用; 辖区错了, 监管口径整章都是错的。
 */
function applyContext(meta = {}, { forceLocale = null } = {}) {
  let ctx;
  try {
    ctx = resolveContext({ cliLocale: forceLocale || cliLocale, cliJurisdiction, meta });
  } catch (e) {
    console.error(`上下文非法: ${e.message}`);
    process.exit(2);
  }
  setContext({ locale: ctx.locale, jurisdiction: ctx.jurisdiction });
  // ---- 辖区档: 控制线属于法定事实, 不能由代码内置一套就当全世界通用
  try {
    const { profile } = loadProfile(PROFILE_DIR, JURISDICTION);
    applyProfile(profile);
    // 币种优先级: 输入声明 > 辖区档。两者都不给才兜底 CNY。
    CURRENCY = meta.currency ? String(meta.currency).toUpperCase() : profile.currency;
  } catch (e) {
    if (e instanceof ProfileError) {
      console.error(`辖区档校验未通过: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  if (ctx.conflicts.length) {
    for (const c of ctx.conflicts) {
      console.error(`⚠ 上下文冲突: ${c.field} 取 ${c.source} 的 ${c.used}, 覆盖了 ${c.overridden}`);
    }
  }
  return ctx;
}

/** 输出出口。--json 输出机器可读对象, 否则输出终端报告。
 *  与 dd_score 同一约定: 终端排版是自由变量, JSON 才是稳定契约。
 *  locale / jurisdiction / currency 是契约的一部分: 不写进 JSON, 下游无法判断
 *  这份数字是用哪套口径和哪种语言算出来的。 */
const OUTPUT_SCHEMA = "ownership-output/1";
const emit = (r) => {
  if (!wantJson) {
    process.stdout.write(render(r, P));
    return;
  }
  process.stdout.write(
    JSON.stringify(
      {
        schema: OUTPUT_SCHEMA,
        script_version: VERSION,
        locale: LOCALE,
        jurisdiction: JURISDICTION,
        currency: CURRENCY,
        ...r,
      },
      null,
      2
    ) + "\n"
  );
};

if (wantPrint) {
  if (configPath) {
    console.error("--print-defaults 与 --config 互斥: 前者输出内置默认参数, 后者加载外部参数集");
    process.exit(2);
  }
  // 标签也要跟着语言走: 打印出来的是一份会被回灌的 config, 不是给人看的报告
  applyContext({});
  process.stdout.write(JSON.stringify(defaultsAsConfig(), null, 2) + "\n");
  process.exit(0);
}
if (wantExample && configPath) {
  console.error("--example 与 --config 互斥: 内置示例是 CI 回归基线之一, 不接受口径覆盖");
  process.exit(2);
}
if (positional.length > 1) {
  console.error(`只接受一个输入文件, 收到 ${positional.length} 个: ${positional.join(", ")}`);
  process.exit(2);
}

// ---- 加载参数集: 非法即中止, 不做「部分可用」
let cfg = null;
let hash8 = null;
if (configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (e) {
    console.error(`读取参数集失败: ${e.message}`);
    process.exit(2);
  }
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error(`参数集解析失败: ${e.message}`);
    process.exit(2);
  }
  const v = validateConfig(cfg);
  if (v.errors.length) {
    console.error("参数集校验未通过, 已中止(阈值错了, 每个结论都是错的):");
    for (const x of v.errors) console.error(`  - ${x}`);
    process.exit(2);
  }
  hash8 = createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

// ---- 上下文必须在 resolveParams 之前落地:
// 参数集校验的提示语(V-18/V-19)会随 warn 流进报告, 语言定得晚了它们就是中文
const file = positional.length ? positional[0] : null;
let data = null;
if (file) {
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`读取或解析失败: ${e.message}`);
    process.exit(1);
  }
  if (!data || typeof data !== "object") {
    console.error("输入必须是一个 JSON 对象");
    process.exit(1);
  }
  if (!data.meta || !data.meta.as_of) {
    console.error("缺少 meta.as_of(股权基准日, YYYY-MM-DD)");
    process.exit(1);
  }
}

// --dump-catalog 只生成中文镜像, 强制 zh(与 dd_score 同一约定: 镜像由 zh 生成)
if (rest.includes("--dump-catalog")) {
  applyContext(EXAMPLE_OBJ.meta, { forceLocale: DEFAULT_LOCALE });
  resetDump();
  // 结构遍历: 常量区里没有被任何示例触达的分支也要收进词表
  OWN_SECTIONS.forEach((s) => {
    t(`own.sec.${s.key}.title`, s.zh);
    if (s.conditional) t(`own.skip.${s.key}`, "本节不适用");
  });
  Object.keys(TYPE_NAMES).forEach((k) => typeName(k));
  Object.keys(ROLE_NAMES).forEach((k) => roleName(k));
  LINES.forEach(([th, short]) => t(`own.line.${th}`, short));
  REDEEM_RULES.forEach(([, label, desc], i) => {
    t(`own.redeem.${i}.label`, label);
    t(`own.redeem.${i}.desc`, desc);
  });
  UCHAIN_NODES.forEach((u) => {
    t(`own.uchain.${u.id}.name`, u.name);
    t(`own.uchain.${u.id}.risk`, u.risk);
  });
  ["founder", "committee", "external"].forEach((k) => t(`own.gpc.${k}`, k));
  ["base", "next10", "next20", "next30"].forEach((k, i) => t(`own.scen.${k}`, CONTROL_SCENARIOS[i].label));
  const P0 = resolveParams(cfg, { hash8 });
  // 渲染遍历: 示例 + 缺条件节的分支都跑一遍, 把只在渲染时出现的文案收进来
  render(analyze(EXAMPLE_OBJ, P0), P0);
  render(analyze({ meta: { as_of: "2000-01-01" }, cap_table: [{ holder: "x", type: "other", pct: 100 }] }, P0), P0);
  if (data) render(analyze(data, P0), P0);
  process.stdout.write(JSON.stringify(dumpCatalog(), null, 2) + "\n");
  process.exit(0);
}

applyContext(data ? data.meta || {} : EXAMPLE_OBJ.meta || {});
const P = resolveParams(cfg, { hash8 });

if (!file) {
  emit(analyze(EXAMPLE_OBJ, P));
  process.exit(0);
}

const extra = [];
if (data.meta.params_ref) {
  const actual = P.__meta ? `${P.__meta.id}@${P.__meta.hash8}` : null;
  if (!actual) {
    extra.push(t("own.w.paramsRefMissing", "输入声明 meta.params_ref={ref}, 但本次未加载参数集(--config): 该输入的结论不可按声明口径复算", { ref: data.meta.params_ref }));
  } else if (actual !== data.meta.params_ref) {
    extra.push(t("own.w.paramsRefStale", "输入声明 meta.params_ref={ref}, 实际加载 {actual}: 复算基线已失效", { ref: data.meta.params_ref, actual }));
  }
}
emit(analyze(data, P, extra));
