#!/usr/bin/env node
/**
 * bci-dd-score v0.2.0 — 脑机接口投资尽调评分与门禁
 * 仅用 Node 标准库, 无第三方依赖 (node >= 18)。
 *
 * 用法:
 *   node scripts/dd_score.mjs                   # 裸跑 = --example
 *   node scripts/dd_score.mjs --example         # 内置示例(故意埋入 9 处告警情形)
 *   node scripts/dd_score.mjs data.json         # 计算并输出 Markdown
 *   node scripts/dd_score.mjs data.json --config fund.json    # 用外部参数集计算
 *   node scripts/dd_score.mjs --print-defaults # 打印内置参数为一份合法 config
 *
 * 参数集(--config)与标的输入(data.json)是两件事, 必须分开:
 *   - 标的输入记录「被评对象的事实」, 生命周期按项目;
 *   - 参数集记录「方法学假设」, 生命周期按季度, 且可能属于某一家机构。
 *   - 二者共用一个文件会导致: 转发标的做 peer review 时连带泄露机构权重;
 *     参数变更与标的变化无法区分, 报告的复算基线失去意义。
 *   故本脚本不接受把参数写进标的输入, 只接受独立文件。
 *
 * config 文件字段:
 *   config_version  string   必填, 当前 "1.0"
 *   id              string   必填, ^[a-z0-9][a-z0-9-]{2,39}$
 *   label           string   必填, 人类可读名
 *   as_of           string   参数观测截止日 YYYY-MM-DD
 *   effective_from  string   生效日
 *   expires_on      string   失效日; 早于运行日时输出标 STALE 并告警
 *   basis           {upstream_version?, builtin?}   内置来源标记
 *   params          见下; 每块要么全给, 要么全为 null(视为未覆盖)
 *   sources         [{id, claim, source, level, published?, verified?, status?, proxy?}]
 *   param_sources   {参数路径: [source_id,...]}    溯源声明
 *
 * params 可覆盖块(每块独立 $defs):
 *   weights {D1..D9}                       九维基础权重, 和必须 = 1
 *   stage_factor {seed|angel|pre_a|a|b|c|pre_ipo: {D1..D9}}
 *   gate_factor {7 个族名: {D1..D9}}        implant_class3 允许为空对象
 *   rev_mult {7 个族名: [[收入档, [下限,上限]], ...]}
 *   milestones {months: {族名: {L0..L6: [lo,hi]}}, buffer: {L4?, L5?, default?}}
 *   prob {L1..L6}                           下一里程碑达成概率, 必须严格递减
 *   confidence {high, medium, low}          high 必须 = 1.0
 *   runway {rules: [[阈值, 标签, 释义]], floor_months}
 *   w_cap number                            单维权重上限, >= 0.15
 *   deviation_threshold number              估值偏离提示阈值
 *   verdict_thresholds {preferred, pass, conditional}   0 < c < p < pf <= 100
 *   ownership {...}                         供 ownership.mjs 消费, 本脚本忽略
 *   rf_extensions []                        自定义警惕项, 只允许 severity=warn
 *
 * 锁死项(不可覆盖, 覆盖即 exit 2):
 *   RF_LIBRARY 的 id / severity / dim    —— 允许改 severity 等于允许把一票否决降级
 *   ASSET_FAMILIES 的 allow_option       —— 允许改等于允许给消费级套用期权法
 *   门禁判定逻辑本身                     —— 是判定规则不是参数
 *   MILESTONE_PATHS / CLASS_CODE_EXPECT  —— 一级监管事实
 *   VERDICTS 的名称与优先级              —— 报告语言, 且 hold / veto 语义不可调
 *   MILESTONES 的 evidence[].key         —— schema enum 与报告分母
 *   DIM_IDS / 节号                        —— 与报告模板互锁
 *
 * 输入 JSON 字段:
 *   meta        {as_of, schema_version?, currency?, analyst?, params_ref?}
 *               as_of 必填(数据截止日, YYYY-MM-DD)
 *               params_ref 可选, 记录本次计算所用参数集 <id>@<hash8>
 *   company     {name?, stage, founded_year?, headcount?, hq?}
 *               stage ∈ seed|angel|pre_a|a|b|c|pre_ipo
 *   asset       {class, modality, closed_loop, ai_based?, snr_db?, indication?, classification_code?}
 *               class ∈ implant_class3|nonimplant_class3|rehab_class2|consumer_nondevice|
 *                       research_tool|platform_hybrid
 *               closed_loop=false 将强制降级为 monitoring_only(单向监测)
 *   milestones  {items:[{id, status, date?, provided?, evidence_ref?}]}
 *               id ∈ L0..L6; status ∈ done|in_progress|planned|na
 *               provided 为已提供证据 key 数组, 与 MILESTONES[].evidence[].key 比对求缺
 *   dimensions  [{id, score, confidence?, checks_open?, evidence?, notes?}]
 *               id ∈ D1..D9; score 0-100; confidence ∈ high|medium|low
 *               evidence 每项 {claim, source, date}
 *   redflags    [{id, status, note?}]
 *               id 必须存在于 RF_LIBRARY(RF-01..RF-44)
 *               status ∈ open|mitigated|cleared|unknown
 *   financials  {cash?, undrawn_credit?, burn_monthly?, revenue_ttm?, revenue_prior_year?,
 *                gross_margin?, rd_ratio?, grant_ratio?, net_assets?}
 *               gross_margin / rd_ratio / grant_ratio 用 0-1 小数(>1 视为百分数并换算)
 *   valuation   {post_money?, round_size?, last_round_date?, liquidation_pref?}
 *   exit        {planned_path?, target_year?, core_product_phase2_approved?, market_cap_expectation?}
 *               planned_path ∈ ipo_star_5|ipo_hk_18a|ma|secondary|unknown
 *
 * 输出节序(契约, 报告模板按此对齐):
 *   输入概要 [→ 参数口径与溯源(H3, 仅当参数与内置默认不同时出现)]
 *   → 一 资产属性门禁 → 二 里程碑定位(L0-L6) → 三 九维加权评分
 *   → 四 致命红旗筛查 → 五 现金跑道与里程碑可达性 → 六 估值口径与偏离提示
 *   → 七 结论与证据缺口 → 警告
 *   参数溯源段刻意用 H3 且不占用中文序号: 13 个编号 H2 与 assets/templates/
 *   report-template.md 逐字互锁, 新增编号 H2 会破坏该契约与 CI 断言。
 *
 * 退出码: 0 正常 | 1 输入读取或解析失败 | 2 参数集非法(--config 与 --example 互斥同此)
 *
 * 纪律:
 *   - 所有数字以本脚本 stdout 为准, 禁止口算覆盖或改写。
 *   - 任何输入缺失只产出「警告」, 不中断计算: 能算多少算多少。
 *   - 参数集非法一律中断(exit 2): 参数错了, 算出来的每个数都是错的, 不存在「部分可用」。
 *   - 权重与阈值是方法学参数, 需按基金口径自行校准; 本脚本不提供估值结论。
 *   - 本脚本输出为尽调流程指标与偏离提示, 不构成估值结论、不构成投资建议、
 *     不构成法律、监管或会计意见。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  dumpCatalog,
  makeI18n,
  normalizeLocale,
  resolveContext,
} from "./lib/i18n.mjs";
import { formatMoney } from "./lib/money.mjs";
import { SECTION_REGISTRY, SECTION_TITLES_ZH, heading, notApplicable as secNA } from "./lib/sections.mjs";
import { ProfileError, loadProfile } from "./lib/jurisdiction.mjs";

// ============================================================
// 常量区 ——— 编号与阈值口径的唯一真源
// ============================================================

const VERSION = "0.4.0";
const SCHEMA_VERSION = "1.1";
const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

/**
 * 红旗影响路径: 等级回答「多严重」, 路径回答「扣在估值模型的哪一项」。
 * 两者正交 —— 一条一票否决也可能落在「折条款」而不是「归零」:
 * 回购条款有毒, 资产本身没问题; 相反, 一条警惕级的 IP 归属瑕疵, 只有在
 * 核心专利不在公司名下时才归零, 落在别人名下则是折倍数。
 * 归零类一旦成立, 估值结论作废而不是打折, 这是本表存在的唯一理由。
 */
const RF_IMPACTS = {
  gate: { label: "归零", fold: "成功后价值无意义, 概率按 0 处理", order: 0 },
  time: { label: "折时间", fold: "里程碑滑期: 概率再乘一次折扣, 折现期同时延长", order: 1 },
  prob: { label: "折概率", fold: "下一里程碑达成率下降, 隐含成功后价值被动抬高", order: 2 },
  mult: { label: "折倍数", fold: "退出可比下移, 收入法与消费品逻辑的倍数被打下来", order: 3 },
  deal: { label: "折条款", fold: "估值可不动, 对价结构须调整(分期/回购/托管/竞业)", order: 4 },
};

/** 资产属性 → 适用的估值口径族 */
const ASSET_FAMILIES = {
  implant_class3: {
    label: "医疗级·植入式三类",
    code: "12-00",
    approach: "期权法 + 器械收入法",
    allow_option: true,
  },
  nonimplant_class3: {
    label: "医疗级·非侵入三类",
    code: "09-00 / 19-00",
    approach: "期权法 + 器械收入法",
    allow_option: true,
  },
  rehab_class2: {
    label: "医疗级·二类康复",
    code: "19-00",
    approach: "器械收入法(传统商业逻辑)",
    allow_option: false,
  },
  consumer_nondevice: {
    label: "消费级·非医疗器械",
    code: "无(须明确不用于医疗目的)",
    approach: "消费品逻辑(收入/利润/复购)",
    allow_option: false,
  },
  research_tool: {
    label: "科研服务工具",
    code: "非器械或 21-00 之外单列判定",
    approach: "仪器收入法",
    allow_option: false,
  },
  platform_hybrid: {
    label: "多线并行平台",
    code: "分线判定",
    approach: "分线拆开各自定价后加总",
    allow_option: true,
  },
  monitoring_only: {
    label: "单向监测(降级)",
    code: "不适用 BCI 编码",
    approach: "器械收入法",
    allow_option: false,
  },
};

/** 管理类别速查: asset.class → 监管预期编码 (对照 NMPA 2026 年第 24 号通告) */
const CLASS_CODE_EXPECT = {
  implant_class3: ["12-00", "1200", "12"],
  nonimplant_class3: ["09-00", "0900", "09", "19-00", "1900", "19"],
  rehab_class2: ["19-00", "1900", "19"],
};

/** L0-L6 里程碑阶梯, 与 references/milestones.md 同源 */
const MILESTONES = [
  {
    id: "L0",
    name: "实验室原理验证(POC)",
    months: [3, 9],
    evidence: [
      { key: "subject", label: "受试者与样本说明" },
      { key: "task", label: "在线实时任务范式" },
      { key: "record", label: "可复现实验记录" },
    ],
  },
  {
    id: "L1",
    name: "型式检验与标准符合性",
    months: [6, 12],
    evidence: [
      { key: "electrical", label: "电气安全报告" },
      { key: "emc", label: "电磁兼容报告" },
      { key: "biocompat", label: "生物相容性报告" },
      { key: "software", label: "软件与算法文档" },
      { key: "dataset", label: "YY/T 2029 数据集自评" },
    ],
  },
  {
    id: "L2",
    name: "大动物安全性评价",
    months: [9, 18],
    evidence: [
      { key: "survival", label: "在体 ≥6 个月存活与安全" },
      { key: "impedance", label: "阻抗稳定性趋势" },
      { key: "pathology", label: "组织病理与排异评估" },
    ],
  },
  {
    id: "L3",
    name: "探索性临床(IIT / 可行性研究)",
    months: [9, 18],
    evidence: [
      { key: "ethics", label: "伦理批件" },
      { key: "filing", label: "临床备案或审批文件" },
      { key: "cases", label: "例数与随访表" },
      { key: "ae", label: "安全性事件汇总" },
    ],
  },
  {
    id: "L4",
    name: "多中心确证性临床",
    months: [18, 36],
    evidence: [
      { key: "protocol", label: "方案与对照设计" },
      { key: "endpoint", label: "主要终点预设" },
      { key: "sites", label: "中心数与例数" },
      { key: "report", label: "期中或结题报告" },
    ],
  },
  {
    id: "L5",
    name: "注册申报与技术审评",
    months: [9, 18],
    evidence: [
      { key: "acceptance", label: "受理通知书" },
      { key: "deficiency", label: "发补意见与答复" },
      { key: "audit", label: "体系核查结论" },
    ],
  },
  {
    id: "L6",
    name: "注册证与商业化准入",
    months: [3, 12],
    evidence: [
      { key: "cert", label: "医疗器械注册证" },
      { key: "reimburse", label: "医保编码或省级挂网" },
      { key: "order", label: "首批入院或订单" },
    ],
  },
];

/** 资产类别 → 里程碑主干路径(二类与消费级不走动物实验与确证性临床) */
const MILESTONE_PATHS = {
  rehab_class2: ["L0", "L1", "L3", "L5", "L6"],
  consumer_nondevice: ["L0", "L1", "L6"],
  research_tool: ["L0", "L1", "L6"],
  default: ["L0", "L1", "L2", "L3", "L4", "L5", "L6"],
};

const MILESTONE_BUFFER = { L4: 1.2, L5: 1.15, default: 1.0 };

/** 九维基础权重, 和为 1.00 */
const WEIGHTS = { D1: 0.13, D2: 0.09, D3: 0.14, D4: 0.16, D5: 0.12, D6: 0.11, D7: 0.08, D8: 0.09, D9: 0.08 };

/** 阶段因子: 同一维度在不同轮次的信息价值不同 */
const STAGE_FACTOR = {
  seed: { D1: 0.8, D2: 0.8, D3: 1.4, D4: 0.7, D5: 0.6, D6: 0.8, D7: 0.6, D8: 1.0, D9: 1.3 },
  angel: { D1: 0.9, D2: 0.9, D3: 1.3, D4: 0.8, D5: 0.8, D6: 0.9, D7: 0.7, D8: 1.0, D9: 1.2 },
  pre_a: { D1: 0.9, D2: 0.9, D3: 1.25, D4: 0.95, D5: 0.9, D6: 0.9, D7: 0.75, D8: 1.05, D9: 1.1 },
  a: { D1: 0.9, D2: 1.0, D3: 1.2, D4: 1.1, D5: 1.0, D6: 0.9, D7: 0.8, D8: 1.1, D9: 1.0 },
  b: { D1: 1.0, D2: 1.1, D3: 1.0, D4: 1.2, D5: 1.2, D6: 1.1, D7: 1.0, D8: 1.0, D9: 0.9 },
  c: { D1: 1.1, D2: 1.0, D3: 0.9, D4: 1.1, D5: 1.3, D6: 1.3, D7: 1.2, D8: 1.0, D9: 0.9 },
  pre_ipo: { D1: 1.1, D2: 1.0, D3: 0.8, D4: 1.2, D5: 1.4, D6: 1.4, D7: 1.3, D8: 1.0, D9: 0.8 },
};

/** 门禁因子: 资产属性判定后对权重做二次修正 */
const GATE_FACTOR = {
  implant_class3: {},
  nonimplant_class3: { D1: 1.05 },
  rehab_class2: { D1: 1.1, D5: 1.25, D4: 0.85, D7: 0.8 },
  consumer_nondevice: { D1: 1.2, D5: 1.3, D4: 0.5, D3: 1.1 },
  research_tool: { D1: 1.1, D5: 1.2, D4: 0.6, D2: 0.8 },
  platform_hybrid: { D1: 1.15 },
  monitoring_only: { D1: 1.3, D5: 1.1, D4: 0.8 },
};

const W_CAP = 0.25;
const CONF_DISCOUNT = { high: 1.0, medium: 0.9, low: 0.75 };

/** 现金跑道档位: 跑道月数 / 下一里程碑所需月数 */
const RUNWAY_RULES = [
  [1.25, "充足", "跑道覆盖下一里程碑典型耗时并留有余量"],
  [0.8, "偏紧", "跑道仅勉强覆盖, 需同步启动过桥或下一轮"],
  [0.0, "不足", "跑道无法覆盖下一里程碑, 估值与时间表需重排"],
];
const RUNWAY_FLOOR_MONTHS = 6;

/** 收入倍数区间: 资产家族 × 收入档(元) → [下限, 上限]; 参数为结构示意, 需自行校准 */
const REV_MULT = {
  implant_class3: [[0, [8, 15]], [1e8, [5, 10]], [5e8, [3, 6]]],
  nonimplant_class3: [[0, [7, 14]], [1e8, [5, 9]], [5e8, [3, 6]]],
  platform_hybrid: [[0, [6, 13]], [1e8, [4, 9]], [5e8, [3, 6]]],
  rehab_class2: [[0, [3, 6]], [1e8, [2, 4]], [5e8, [1.5, 3]]],
  consumer_nondevice: [[0, [1.5, 4]], [1e8, [1, 2.5]], [5e8, [0.8, 2]]],
  research_tool: [[0, [2, 5]], [1e8, [1.5, 3]], [5e8, [1, 2]]],
  monitoring_only: [[0, [1, 3]], [1e8, [1, 2]], [5e8, [0.8, 1.5]]],
};

/**
 * 敏感性表的折现率三档。原先是渲染函数里的字面量 [0.08, 0.12, 0.15],
 * 提为参数的理由: 基金口径不同(人民币基金与美元基金的 hurdle 不一样),
 * 而它一旦进参数集, 就不可能再被顺手改成一个「看起来更合理」的数而不留痕。
 * 辖区档里的 sensitivity_rates 声明同一组值, 二者不一致时由一致性检查拦下。
 */
const SENSITIVITY_RATES = [0.08, 0.12, 0.15];

/** 估值偏离提示阈值: 隐含倍数相对所在档区间上沿的倍数, 超过即需解释来源 */
const DEVIATION_FLAG = 1.5;

/** 下一里程碑达成概率占位值(用于反算隐含成功后价值); 需按基金口径校准 */
const PROB_BY_MILESTONE = { L1: 0.75, L2: 0.6, L3: 0.45, L4: 0.3, L5: 0.18, L6: 0.1 };

/** 结论分级阈值: 低于 conditional 为观察, 介于 conditional 与 pass 之间为有条件通过 */
const VERDICT_THRESHOLDS = { preferred: 85, pass: 70, conditional: 55 };

/** 里程碑典型耗时的按族口径。默认只有 default 一族; 同一 L 级在不同资产类别
 *  不是一个东西(二类康复不走大动物与确证性临床), 故允许按族覆盖。 */
const MILESTONE_MONTHS = {
  default: Object.fromEntries(MILESTONES.map((m) => [m.id, m.months])),
};

/**
 * 内置默认参数集: 所有可被 --config 覆盖的方法学参数集中在此。
 * 冻结以防运行期被意外改写; 嵌套对象为引用共享, analyze 只读不写。
 * 若某份 config 解析结果与本对象值完全一致, 视为「未覆盖」, 输出不含参数段。
 */
const DEFAULTS = Object.freeze({
  WEIGHTS,
  STAGE_FACTOR,
  GATE_FACTOR,
  REV_MULT,
  MILESTONE_MONTHS,
  MILESTONE_BUFFER,
  PROB_BY_MILESTONE,
  CONF_DISCOUNT,
  W_CAP,
  RUNWAY_RULES,
  RUNWAY_FLOOR_MONTHS,
  DEVIATION_FLAG,
  VERDICT_THRESHOLDS,
  sensitivity_rates: SENSITIVITY_RATES,
});

/** config 顶层允许的键(V-01 用): 多一个即报错, 防止拼写错误被静默忽略 */
const CONFIG_KEYS = ["config_version", "id", "label", "as_of", "effective_from", "expires_on", "basis", "params", "sources", "param_sources", "derived_from", "_doc"];

/** config.params 允许的键(V-01 用) */
const PARAM_KEYS = ["weights", "stage_factor", "gate_factor", "rev_mult", "milestones", "prob", "confidence", "runway", "w_cap", "deviation_threshold", "verdict_thresholds", "sensitivity_rates", "ownership", "rf_extensions", "_doc"];

/** 覆盖块 → 中文标注(V-13 与参数段显示用) */
const BLOCK_LABELS = {
  weights: ["WEIGHTS", 9],
  stage_factor: ["STAGE_FACTOR", "7×9"],
  gate_factor: ["GATE_FACTOR", "7族"],
  rev_mult: ["REV_MULT", "7族×3档"],
  milestones_months: ["MILESTONES.months", "7族"],
  milestones_buffer: ["MILESTONE_BUFFER", 3],
  prob: ["PROB_BY_MILESTONE", 6],
  confidence: ["CONF_DISCOUNT", 3],
  runway_rules: ["RUNWAY_RULES", 3],
  runway_floor: ["RUNWAY_FLOOR_MONTHS", 1],
  w_cap: ["W_CAP", 1],
  deviation_threshold: ["DEVIATION_FLAG", 1],
  verdict_thresholds: ["VERDICT_THRESHOLDS", 3],
  sensitivity_rates: ["SENSITIVITY_RATES", 3],
};

/**
 * 退出通道的中文名。**只是词表默认值, 不是辖区事实** —— 哪个通道在哪个辖区
 * 适用, 由 assets/jurisdictions/<id>.json 决定(applicable 字段)。
 * 两件事分开的理由: 通道名是措辞, 适用性是监管事实, 变更频率完全不同。
 */
const EXIT_PATHS = {
  ipo_star_5: "科创板第五套标准",
  ipo_hk_18a: "港交所第 18A 章",
  ipo_us: "美股 IPO(NASDAQ / NYSE)",
  ma: "产业方并购",
  secondary: "老股转让 / S 基金",
  unknown: "未明确",
};

/** 本辖区对该通道的登记。查不到返回 null —— 不猜。 */
function exitChannel(key) {
  return (PROFILE && Array.isArray(PROFILE.exit_channels) ? PROFILE.exit_channels : []).find((c) => c.key === key) || null;
}

/** 结论分级: 索引越大越好 */
const VERDICTS = [
  { key: "hold", label: "资料不足, 不出结论", desc: "关键输入缺失或证据覆盖不足, 任何分级都会误导" },
  { key: "veto", label: "否决", desc: "存在一票否决级致命红旗且未闭合" },
  { key: "watch", label: "观察", desc: "有效加权分低于 55, 或致命项状态不明" },
  { key: "conditional", label: "有条件通过", desc: "55 至 70 分, 或存在未解释的致命项" },
  { key: "pass", label: "通过", desc: "70 至 85 分, 无未闭合致命项" },
  { key: "preferred", label: "优选", desc: "85 分以上且里程碑不早于 L4 且跑道充足" },
];
const VERDICT_INDEX = { hold: 0, veto: 1, watch: 2, conditional: 3, pass: 4, preferred: 5 };

/** 红旗库: id → 名称 / 所属维度 / 等级 / 是否一票否决 / 核查动作
 *  severity: veto(一票否决) | fatal(致命, 需解释) | warn(警惕)
 */
const RF_LIBRARY = [
  { id: "RF-01", dim: "G0", severity: "veto", impact: "gate", name: "只有论文或 POC 演示, 无任何可运行实体或工程样机", action: "索取样机演示录像(含失败片段)、BOM、测试记录" },
  { id: "RF-02", dim: "G0", severity: "veto", impact: "gate", name: "单向采集或单向刺激产品对外称脑机接口", action: "要求出示闭环链路图与反馈环节实现证据, 对照分类界定四特征逐条核" },
  { id: "RF-03", dim: "G0", severity: "veto", impact: "gate", name: "全部证据来自公司自述(BP / 路演), 无第三方材料", action: "按证据索取清单发正式函, 限期 10 个工作日" },
  { id: "RF-04", dim: "G0", severity: "warn", impact: "mult", name: "门禁阶段即出现估值口径与资产属性明显错配", action: "转估值口径校验, 核对隐含倍数与所在档区间" },
  { id: "RF-05", dim: "G0", severity: "warn", impact: "prob", name: "拒绝提供样机或拒绝现场演示", action: "记录拒绝事实与时点, 列为观察项并写入资料收集状态" },

  { id: "RF-06", dim: "D1", severity: "veto", impact: "mult", name: "消费级或科研级资产、零收入或极低收入, 却按硬科技期权叙事定价", action: "要求拆出与叙事对应的收入线, 按消费品口径重算隐含倍数" },
  { id: "RF-07", dim: "D1", severity: "veto", impact: "mult", name: "无闭环的单向监测产品按 BCI 平台估值", action: "核对闭环链路, 按监测设备口径重估并重排退出预期" },
  { id: "RF-08", dim: "D1", severity: "warn", impact: "mult", name: "七成以上收入来自与核心叙事无关的传统业务, 对外只讲前沿线", action: "按产品线拆收入与毛利, 单独评估前沿线的单位经济" },
  { id: "RF-09", dim: "D1", severity: "warn", impact: "mult", name: "市场规模引用多家机构口径不一且只取最高值", action: "要求同源同口径数据, 并说明 BCI 边界定义差异" },

  { id: "RF-10", dim: "D2", severity: "veto", impact: "gate", name: "风险收益比倒挂: 高侵入方案的功能增益可被低风险方案替代", action: "列出现有替代方案清单, 逐项比较增益与风险" },
  { id: "RF-11", dim: "D2", severity: "fatal", impact: "prob", name: "需求由技术自证, 无独立临床需求证据", action: "提供至少 5 位不相关临床专家的独立访谈记录" },
  { id: "RF-12", dim: "D2", severity: "warn", impact: "prob", name: "单一适应症且支付方缺位(无医保、无自费能力)", action: "核实该适应症的支付路径与单例可支付金额" },

  { id: "RF-13", dim: "D3", severity: "veto", impact: "prob", name: "仅有离线公开数据集交叉验证, 无在线实时闭环验证", action: "要求在线实时 demo 与跨天跨被试泛化数据" },
  { id: "RF-14", dim: "D3", severity: "veto", impact: "gate", name: "宣称无创 EEG 解码复杂语义、数十汉字或完整思维", action: "要求关闭 EMG / EOG 通道后的对照结果与物理可行性说明" },
  { id: "RF-15", dim: "D3", severity: "veto", impact: "gate", name: "无闭环反馈, 单向监测却称 BCI", action: "指出反馈通路的具体实现环节与延迟指标" },
  { id: "RF-16", dim: "D3", severity: "fatal", impact: "gate", name: "核心性能由通用大模型先验补全, 非神经信号", action: "要求消融实验: 断开神经信号输入后性能下降幅度" },
  { id: "RF-17", dim: "D3", severity: "warn", impact: "time", name: "实验室效果好, 院内无法稳定使用", action: "要求院内连续多日实测记录与佩戴稳定性数据" },
  { id: "RF-18", dim: "D3", severity: "warn", impact: "time", name: "六件套缺关键环节(无自研电极工艺、无电源管理方案等)", action: "逐项确认电极、芯片、通信、电源、算法、工艺的实物与来源" },

  { id: "RF-19", dim: "D4", severity: "veto", impact: "time", name: "无明确注册路径, 或完全按研发思路做产品", action: "要求提交注册策略文件与分类界定申请或沟通记录" },
  { id: "RF-20", dim: "D4", severity: "veto", impact: "prob", name: "临床数据仅个案报道, 无对照、无随访", action: "要求完整方案、对照设计与随访表, 核主要终点" },
  { id: "RF-21", dim: "D4", severity: "fatal", impact: "prob", name: "绕开安全性与长期稳定性谈技术突破", action: "要求大动物在体时长与阻抗稳定性趋势数据" },
  { id: "RF-22", dim: "D4", severity: "warn", impact: "mult", name: "产品成型但不具可销售条件(无医保、无采购路径)", action: "核实医保编码、省级挂网与收费项目立项进度" },
  { id: "RF-23", dim: "D4", severity: "warn", impact: "time", name: "定型后才启动型式检验, 导致技术路线返工", action: "核对型检启动时点与设计定型时点, 评估返工概率" },

  { id: "RF-24", dim: "D5", severity: "veto", impact: "gate", name: "讲不清谁付钱、付多少, 只讲技术指标领先", action: "要求列出支付方、单价、采购决策链与已成交合同" },
  { id: "RF-25", dim: "D5", severity: "fatal", impact: "prob", name: "商业计划依赖搞定关键人即可成交", action: "核查是否存在可复制的渠道与标准化销售流程" },
  { id: "RF-26", dim: "D5", severity: "warn", impact: "prob", name: "把合作数量当商业进展, 单场景未闭环", action: "逐笔核对合作是否产生收入或交付验收" },
  { id: "RF-27", dim: "D5", severity: "warn", impact: "mult", name: "单一客户或单一渠道依赖度超过一半", action: "按客户与渠道拆分收入, 评估替换成本" },

  { id: "RF-28", dim: "D6", severity: "fatal", impact: "gate", name: "跑道不足 6 个月且无已签投资意向书、无过桥安排", action: "要求资金计划表与已签 TS, 评估过桥可行性" },
  { id: "RF-29", dim: "D6", severity: "fatal", impact: "mult", name: "收入主要来自补助与关联方, 经营性现金流长期为负", action: "要求补助与关联交易明细, 剔除后重算收入" },
  { id: "RF-30", dim: "D6", severity: "warn", impact: "prob", name: "无预算管控, 融资后支出随意", action: "索取预算表与实际执行对比, 核对大额支出审批" },
  { id: "RF-31", dim: "D6", severity: "warn", impact: "mult", name: "研发资本化比例显著高于同行, 利润被修饰", action: "要求资本化政策与同行对比, 按费用化口径重算利润" },

  { id: "RF-32", dim: "D7", severity: "veto", impact: "deal", name: "融资条款含高额回购或创始人无限连带责任", action: "逐条读取回购触发条件、义务人范围与金额上限" },
  { id: "RF-33", dim: "D7", severity: "fatal", impact: "mult", name: "退出路径单一且不满足任何硬门槛, 却已按可退出定价", action: "对照各通道硬门槛逐条打勾, 反算退出所需条件" },
  { id: "RF-34", dim: "D7", severity: "warn", impact: "deal", name: "存在明显估值倒挂风险的后续轮次安排", action: "做下一轮平轮与降轮情形的稀释与清算优先测算" },
  { id: "RF-35", dim: "D7", severity: "warn", impact: "deal", name: "对赌触发条件与短期经营指标强绑定, 与长周期赛道冲突", action: "核对触发指标与临床周期是否可兼容, 争取里程碑化改写" },

  { id: "RF-36", dim: "D8", severity: "veto", impact: "gate", name: "核心专利归属不清, 尤其高校成果转化未走完评估、审批与登记", action: "跑股权与权属链核查, 索取五节点全部文件" },
  { id: "RF-37", dim: "D8", severity: "veto", impact: "gate", name: "数据采集无知情同意, 或临床数据来源不合规", action: "索取知情同意模板、伦理批件与数据来源台账" },
  { id: "RF-38", dim: "D8", severity: "warn", impact: "deal", name: "创始人承担个人连带责任", action: "核对担保文件与个人资产敞口, 评估对决策的影响" },
  { id: "RF-39", dim: "D8", severity: "warn", impact: "deal", name: "核心人员无竞业与保密约束", action: "索取劳动合同、竞业协议与保密协议" },
  { id: "RF-40", dim: "D8", severity: "warn", impact: "prob", name: "对外宣传存在明确功效断言, 或量产宣称与事实不符", action: "留档全部宣传材料, 核对与注册证载明范围是否一致" },

  { id: "RF-41", dim: "D9", severity: "fatal", impact: "prob", name: "核心技术人员一人独大, 无备份与文档沉淀", action: "核查关键模块的负责人分布与设计文档完整度" },
  { id: "RF-42", dim: "D9", severity: "fatal", impact: "deal", name: "合伙人无书面协议, 权责不清", action: "索取合伙协议、分工文件与退出机制约定" },
  { id: "RF-43", dim: "D9", severity: "warn", impact: "prob", name: "纯技术团队, 缺临床、注册、销售关键角色", action: "核对组织架构图与关键岗位在岗情况" },
  { id: "RF-44", dim: "D9", severity: "warn", impact: "prob", name: "创始人长期高压透支, 决策质量下降", action: "多轮访谈观察决策一致性, 核查近一年重大决策记录" },
];

const DIM_NAMES = {
  D1: "资产属性与估值范式",
  D2: "临床需求与适应症价值",
  D3: "技术真实性与工程化",
  D4: "注册路径与临床证据",
  D5: "商业化与支付",
  D6: "财务质量与现金跑道",
  D7: "资本结构、条款与退出",
  D8: "法律、IP、数据与控制权",
  D9: "组织、创始人与产业生态位",
};
const DIM_IDS = Object.keys(DIM_NAMES);

/** 内置示例: 故意埋入 9 处告警情形, 既是自解释样例也是回归基线 */
const EXAMPLE_OBJ = {
  meta: { as_of: "2026-09-30", schema_version: "1.0", currency: "CNY", analyst: "示例" },
  company: { name: "示例神经科技有限公司", stage: "a", founded_year: 2021, headcount: 84, hq: "上海" },
  asset: {
    class: "implant_class3",
    modality: "invasive",
    closed_loop: false,
    ai_based: true,
    snr_db: -12,
    indication: ["手部运动功能代偿", "语义意图解码"],
    classification_code: "",
  },
  milestones: {
    items: [
      { id: "L0", status: "done", date: "2023-05-18", provided: ["subject", "task", "record"], evidence_ref: "POC-2023" },
      { id: "L1", status: "done", date: "2024-09-02", provided: ["electrical", "emc", "biocompat", "software"], evidence_ref: "STR-2024" },
      { id: "L2", status: "done", date: "2025-11-20", provided: ["survival", "impedance"], evidence_ref: "ANIMAL-2025" },
      { id: "L3", status: "planned", provided: [], evidence_ref: "" },
      { id: "L4", status: "done", date: "2026-08-15", provided: ["protocol", "endpoint", "sites"], evidence_ref: "MULTI-2026" },
      { id: "L5", status: "planned", provided: [], evidence_ref: "" },
      { id: "L6", status: "planned", provided: [], evidence_ref: "" },
    ],
  },
  dimensions: [
    {
      id: "D1",
      score: 42,
      confidence: "medium",
      checks_open: ["D1-10", "D1-12"],
      evidence: [{ claim: "对外叙事为侵入式平台, 实际收入来自脑电采集设备", source: "BP v3.2 第 18 页", date: "2026-08-01" }],
      notes: "平台叙事与收入结构存在距离",
    },
    { id: "D2", score: 58, confidence: "medium", checks_open: [], evidence: [{ claim: "适应症为手部运动代偿", source: "临床方案 v1", date: "2026-03-02" }] },
    {
      id: "D3",
      score: 46,
      confidence: "low",
      checks_open: ["D3-06", "D3-07"],
      evidence: [{ claim: "解码准确率 91%", source: "内部测试报告", date: "" }],
      notes: "缺跨被试泛化数据",
    },
    { id: "D4", score: 55, confidence: "medium", checks_open: ["D4-09"], evidence: [{ claim: "已获受理通知书", source: "受理通知影印件", date: "2026-07-20" }] },
    {
      id: "D5",
      score: 38,
      confidence: "medium",
      checks_open: ["D5-09"],
      evidence: [
        { claim: "2026 上半年签约 3 家医院", source: "销售台账", date: "2026-07-05" },
        { claim: "单台毛利率 18%", source: "管理报表", date: "2026-08-10" },
      ],
    },
    { id: "D6", score: 40, confidence: "medium", checks_open: [], evidence: [{ claim: "月均净流出 360 万元", source: "银行流水汇总", date: "2026-09-01" }] },
    { id: "D7", score: 50, confidence: "low", checks_open: ["D7-05", "D7-09"], evidence: [] },
    { id: "D8", score: 62, confidence: "medium", checks_open: ["D8-02"], evidence: [{ claim: "核心专利 3 项在审", source: "专利清单", date: "2026-06-30" }] },
    { id: "D9", score: 65, confidence: "medium", checks_open: [], evidence: [{ claim: "创始团队 4 人, 技术背景 3 人", source: "组织架构图", date: "2026-05-12" }] },
  ],
  redflags: [
    { id: "RF-02", status: "open", note: "对外宣传为脑机接口, 但反馈通路未实现, 仅单向采集" },
    { id: "RF-14", status: "unknown", note: "宣称可解码语义意图, 尚未提供伪影对照实验" },
    { id: "RF-29", status: "open", note: "政府补助占收入 41%" },
    { id: "RF-31", status: "mitigated", note: "研发资本化比例 12%, 与同行持平" },
  ],
  financials: {
    cash: 12000000,
    undrawn_credit: 3000000,
    burn_monthly: 3600000,
    revenue_ttm: 8000000,
    revenue_prior_year: 5100000,
    gross_margin: 0.18,
    rd_ratio: 0.62,
    grant_ratio: 0.41,
    net_assets: 41000000,
  },
  valuation: { post_money: 1200000000, round_size: 200000000, last_round_date: "2026-02-11", liquidation_pref: "2x" },
  exit: { planned_path: "ipo_star_5", target_year: 2029, core_product_phase2_approved: false, market_cap_expectation: 4500000000 },
};

// ============================================================
// 工具函数
// ============================================================

function num(x, d = 1) {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  let s = Number(x).toFixed(d);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "" || s === "-0") s = "0";
  return s;
}

// ============================================================
// 运行期上下文: locale / 辖区 / 币种
// ============================================================

/**
 * 这三项在参数解析后由 setContext() 改写。之所以用模块级变量而不是一路透传:
 * 中文输出必须逐字不变, 而原有函数签名里没有 locale 位置; 为了传 locale 去改
 * 60 多个调用点的签名, 等于把「不改中文」这条约束本身变成风险源。
 * 代价是同一进程内不能并发跑两个 locale —— 本脚本是单次命令行进程, 成立。
 */
let LOCALE = DEFAULT_LOCALE;
let JURISDICTION = "cn";
let CURRENCY = "CNY";
let I18N = makeI18n(DEFAULT_LOCALE);

/**
 * 辖区档。只在 applyContext 里落地, 之后全程只读。
 * PROFILE_PENDING 是档里 status=pending 的项 —— 它们不中止运行, 而是变成
 * 报告里的拒答行与 gaps: 「不知道」与「没有」必须长得不一样。
 */
let PROFILE_DIR = fileURLToPath(new URL("../assets/jurisdictions/", import.meta.url));
let PROFILE = null;
let PROFILE_PENDING = [];

/** 取文案。第二个参数是中文默认值 —— 中文 locale 下原样返回, 英文查词表。 */
const t = (key, zhDefault, vars) => I18N.t(key, zhDefault, vars);
const sep = () => t("ui.sep", "、");

function setContext({ locale, jurisdiction, currency }) {
  if (locale) {
    LOCALE = normalizeLocale(locale);
    I18N = makeI18n(LOCALE);
  }
  if (jurisdiction) JURISDICTION = String(jurisdiction).toLowerCase();
  if (currency) CURRENCY = String(currency).toUpperCase();
}

/** 金额格式化。量级词跟随 locale, 币种符号跟随币种, 两者正交。 */
function money(x) {
  return formatMoney(x, { currency: CURRENCY, locale: LOCALE });
}

/**
 * 收入档位标签: 由边界派生, 不写死。
 * 原来写死「零收入至 1 亿 / 1 亿至 5 亿 / 5 亿以上」, 后果是档位边界一旦被
 * --config 覆盖(REV_MULT 可覆盖), 标签就开始骗人 —— 而它不会被任何测试抓到。
 */
function bandLabelFor(i, edges) {
  const f = (x) => money(x);
  if (i === 0) return t("s.val.bandFirst", "零收入至 {hi}", { hi: f(edges[1] ?? edges[0]) });
  if (i >= edges.length - 1) return t("s.val.bandLast", "{lo}以上", { lo: f(edges[i]) });
  return t("s.val.bandMid", "{lo}至 {hi}", { lo: f(edges[i]), hi: f(edges[i + 1]) });
}

function ratio01(x, field, warnings) {
  if (x === null || x === undefined) return null;
  const v = Number(x);
  if (!isFinite(v)) return null;
  if (v > 1) {
    if (v > 100) {
      warnings.push(`financials.${field} 取值 ${v} 超出合理范围(0-1 或 0-100), 已忽略`);
      return null;
    }
    warnings.push(`financials.${field} 取值为 ${v}, 按百分数理解已换算为 ${num(v / 100, 3)}`);
    return v / 100;
  }
  return v;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function mid(arr) {
  return (arr[0] + arr[1]) / 2;
}

// ============================================================
// 参数集: 校验与合并
// ============================================================

const isPlain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const hasVal = (x) => x !== undefined && x !== null;
const today = () => new Date().toISOString().slice(0, 10);

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
function blockDeclared(blk) {
  if (Array.isArray(blk)) return blk.length > 0;
  return isPlain(blk) && Object.keys(blk).some((k) => k !== "_doc" && hasVal(blk[k]));
}

/** 块内是否「填了一部分」: 整块覆盖只允许全给或全不给, 半填会让剩余项静默沿用默认 */
function blockPartial(blk) {
  if (!isPlain(blk)) return false;
  const keys = Object.keys(blk).filter((k) => k !== "_doc");
  if (!keys.length) return false;
  const filled = keys.filter((k) => hasVal(blk[k]));
  return filled.length > 0 && filled.length < keys.length;
}

/**
 * 校验参数集。返回 {errors, warns, stale, proxyCount, sourceRefs}。
 * errors 非空即 exit 2 —— 参数错了, 算出来的每个数都是错的, 不存在「部分可用」。
 */
function validateConfig(cfg, opts = {}) {
  const errors = [];
  const warns = [];
  const E = (c, m) => errors.push(`${c} ${m}`);
  const W = (c, m) => warns.push(`${c} ${m}`);

  if (!isPlain(cfg)) {
    E("V-01", "参数集必须是一个 JSON 对象");
    return { errors, warns, stale: false, proxyCount: 0, sourceRefs: [] };
  }

  // ---- V-01 未知键
  for (const k of Object.keys(cfg)) {
    if (!CONFIG_KEYS.includes(k)) E("V-01", `顶层出现未知键 "${k}", 已拒绝: 拼写错误被静默忽略会让整份参数集失效而无人察觉`);
  }
  const p = isPlain(cfg.params) ? cfg.params : {};
  if (cfg.params !== undefined && !isPlain(cfg.params)) E("V-01", "params 必须是对象");
  for (const k of Object.keys(p)) {
    if (!PARAM_KEYS.includes(k)) E("V-01", `params 出现未知键 "${k}", 已拒绝`);
  }
  // 必填元数据
  if (!cfg.config_version) E("V-01", "config_version 缺失, 当前应为 \"1.0\"");
  if (!cfg.id || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(String(cfg.id))) {
    E("V-01", `id=${cfg.id || "(缺失)"} 不合规: 须匹配 ^[a-z0-9][a-z0-9-]{2,39}$`);
  }
  if (!cfg.label) E("V-01", "label 缺失");
  if (!cfg.as_of) E("V-01", "as_of 缺失(参数观测截止日)");

  const FAM = Object.keys(ASSET_FAMILIES);
  const STAGES = Object.keys(STAGE_FACTOR);
  const DIMS = DIM_IDS;

  // ---- V-02 / V-04 权重
  if (blockDeclared(p.weights)) {
    if (blockPartial(p.weights)) E("V-03", "weights 只填了一部分: 九维权重必须整块给出, 半填会让剩余维度静默沿用默认, 产生不可解释的权重");
    let sum = 0;
    for (const d of DIMS) {
      const v = p.weights[d];
      if (!hasVal(v)) { E("V-03", `weights 缺少 ${d}`); continue; }
      const n = Number(v);
      if (!isFinite(n)) { E("V-04", `weights.${d}=${v} 不是数值`); continue; }
      if (n <= 0) E("V-04", `weights.${d}=${v} 不为正: 0 权重等于把该维度踢出评分, 请直接删维度而不是设 0`);
      sum += n;
    }
    if (Math.abs(sum - 1) > 1e-9) {
      if (opts.normalizeWeights) {
        W("V-02", `weights 合计 ${sum.toFixed(6)} 不等于 1, 已按 --normalize-weights 归一化; 原始合计 ${sum.toFixed(6)}`);
      } else {
        E("V-02", `weights 合计 ${sum.toFixed(6)} 不等于 1: 不做自动归一, 因为那会让 0.31 / 0.09 这类录入错误静默通过; 确需归一请显式加 --normalize-weights`);
      }
    }
  }

  // ---- V-04 因子
  for (const [key, label] of [["stage_factor", "stage_factor"], ["gate_factor", "gate_factor"]]) {
    const blk = p[key];
    if (!blockDeclared(blk)) continue;
    for (const s of Object.keys(blk)) {
      if (s === "_doc") continue;
      if (!hasVal(blk[s])) continue;
      const row = blk[s];
      if (!isPlain(row)) { E("V-04", `${label}.${s} 必须是对象`); continue; }
      for (const d of Object.keys(row)) {
        if (d === "_doc") continue;
        const v = Number(row[d]);
        if (!isFinite(v)) E("V-04", `${label}.${s}.${d} 不是数值`);
        else if (v <= 0) E("V-04", `${label}.${s}.${d}=${row[d]} 不为正`);
      }
    }
    // ---- V-14 族/阶段名与覆盖完整性
    if (key === "stage_factor") {
      const given = Object.keys(blk).filter((k) => k !== "_doc" && hasVal(blk[k]));
      for (const s of given) if (!STAGES.includes(s)) E("V-14", `stage_factor 出现未知阶段 "${s}"`);
      if (given.length !== STAGES.length) {
        E("V-14", `stage_factor 只覆盖了 ${given.length}/${STAGES.length} 个阶段: 未覆盖的阶段会与默认值静默混合, 造成新旧口径并存`);
      }
    } else {
      const given = Object.keys(blk).filter((k) => k !== "_doc" && hasVal(blk[k]));
      for (const f of given) if (!FAM.includes(f)) E("V-14", `gate_factor 出现未知资产族 "${f}"`);
      const lack = FAM.filter((f) => !given.includes(f));
      if (lack.length) E("V-14", `gate_factor 未覆盖: ${lack.join("、")}: 部分覆盖会让同一份报告里两族用不同口径`);
    }
  }

  // ---- V-05 / V-06 / V-14 / V-10 收入倍数
  if (blockDeclared(p.rev_mult)) {
    const given = Object.keys(p.rev_mult).filter((k) => k !== "_doc" && hasVal(p.rev_mult[k]));
    for (const f of given) if (!FAM.includes(f)) E("V-14", `rev_mult 出现未知资产族 "${f}"`);
    const lack = FAM.filter((f) => !given.includes(f));
    if (lack.length) E("V-14", `rev_mult 未覆盖: ${lack.join("、")}: 跨族比较是框架的主要用法, 单族覆盖会让比较失去一致性`);
    for (const f of given) {
      const buckets = p.rev_mult[f];
      if (!Array.isArray(buckets) || !buckets.length) { E("V-05", `rev_mult.${f} 必须是非空数组`); continue; }
      let prevTh = -Infinity;
      let prevHi = Infinity;
      for (const b of buckets) {
        if (!Array.isArray(b) || b.length !== 2 || !Array.isArray(b[1]) || b[1].length !== 2) {
          E("V-05", `rev_mult.${f} 的元素必须是 [[收入档, [下限, 上限]], ...]`);
          continue;
        }
        const th = Number(b[0]);
        const lo = Number(b[1][0]);
        const hi = Number(b[1][1]);
        if (!isFinite(th) || th < 0) E("V-05", `rev_mult.${f} 收入档 ${b[0]} 非法`);
        if (!isFinite(lo) || !isFinite(hi)) { E("V-05", `rev_mult.${f} 区间含非数值`); continue; }
        if (lo <= 0) E("V-05", `rev_mult.${f}[${th}] 下限 ${lo} 不为正`);
        if (lo > hi) E("V-05", `rev_mult.${f}[${th}] 下限 ${lo} 大于上限 ${hi}`);
        if (lo > 0 && hi / lo > 5) E("V-06", `rev_mult.${f}[${th}] 区间跨度 ${(hi / lo).toFixed(2)} 倍超过 5 倍: 跨度越大越接近「没给区间」, 请收窄或改口径`);
        if (th <= prevTh) E("V-05", `rev_mult.${f} 收入档未递增: ${th} 出现在 ${prevTh} 之后`);
        if (hi > prevHi) E("V-10", `rev_mult.${f}[${th}] 上限 ${hi} 高于更低收入档的上限 ${prevHi}: 收入越高区间应收窄, 这是方法的骨架`);
        prevTh = th;
        prevHi = hi;
      }
    }
  }

  // ---- V-07 / V-08 / V-09 里程碑耗时
  if (blockDeclared(p.milestones) && isPlain(p.milestones)) {
    for (const k of Object.keys(p.milestones)) {
      if (!["months", "buffer", "_doc"].includes(k)) E("V-01", `params.milestones 出现未知键 "${k}"`);
    }
    const mm = p.milestones.months;
    if (blockDeclared(mm)) {
      if (!isPlain(mm.default)) E("V-14", "milestones.months 必须包含 default 族: 未覆盖的族按 default 回退");
      for (const f of Object.keys(mm)) {
        if (f === "_doc") continue;
        if (!hasVal(mm[f])) continue;
        if (f !== "default" && !FAM.includes(f)) E("V-14", `milestones.months 出现未知资产族 "${f}"`);
        if (!isPlain(mm[f])) { E("V-07", `milestones.months.${f} 必须是对象`); continue; }
        for (const lv of Object.keys(mm[f])) {
          if (lv === "_doc") continue;
          if (!MILESTONES.some((m) => m.id === lv)) { E("V-14", `milestones.months.${f} 出现未知级别 "${lv}"`); continue; }
          const pair = mm[f][lv];
          if (!Array.isArray(pair) || pair.length !== 2) { E("V-07", `milestones.months.${f}.${lv} 必须是 [下限, 上限]`); continue; }
          const a = Number(pair[0]);
          const b = Number(pair[1]);
          if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) E("V-07", `milestones.months.${f}.${lv}=[${pair[0]},${pair[1]}] 必须是正整数月`);
          if (a > b) E("V-05", `milestones.months.${f}.${lv} 下限 ${a} 大于上限 ${b}`);
          if (b > 60) E("V-08", `milestones.months.${f}.${lv} 上限 ${b} 个月超过 60: 单级超过 5 年通常是单位填错(月/季)`);
        }
      }
      // V-09 累计单调: 沿每条主干路径, 累计中值必须严格递增
      const monthsOfIn = (fam, id) => {
        const row = isPlain(mm[fam]) ? mm[fam] : {};
        const def = isPlain(mm.default) ? mm.default : {};
        const v = hasVal(row[id]) ? row[id] : def[id];
        return Array.isArray(v) ? v : null;
      };
      for (const pk of Object.keys(MILESTONE_PATHS)) {
        if (pk !== "default" && !FAM.includes(pk)) continue;
        let cum = 0;
        let prevCum = -1;
        for (const id of MILESTONE_PATHS[pk]) {
          const pair = monthsOfIn(pk, id);
          if (!pair) continue;
          cum += (Number(pair[0]) + Number(pair[1])) / 2;
          if (cum <= prevCum) {
            E("V-09", `路径 ${pk} 在 ${id} 处累计耗时未递增: 会产生「注册比临床快」的反物理排期`);
          }
          prevCum = cum;
        }
      }
    }
    const buf = p.milestones.buffer;
    if (blockDeclared(buf)) {
      for (const k of Object.keys(buf)) {
        if (k === "_doc") continue;
        if (!["L4", "L5", "default"].includes(k)) E("V-01", `params.milestones.buffer 出现未知键 "${k}"`);
        const v = Number(buf[k]);
        if (!isFinite(v) || v < 1 || v > 3) E("V-05", `milestones.buffer.${k}=${buf[k]} 非法: 缓冲系数应在 1 至 3 之间`);
      }
    }
  }

  // ---- V-11 概率
  if (blockDeclared(p.prob)) {
    const order = ["L1", "L2", "L3", "L4", "L5", "L6"];
    let prev = Infinity;
    for (const lv of order) {
      const v = p.prob[lv];
      if (!hasVal(v)) { E("V-11", `prob 缺少 ${lv}`); continue; }
      const n = Number(v);
      if (!isFinite(n) || n <= 0 || n >= 1) E("V-11", `prob.${lv}=${v} 必须在 0 与 1 之间(不含端点)`);
      else if (n >= prev) E("V-11", `prob.${lv}=${v} 未严格低于上一级 ${prev}: 概率不递减会让期权法反算的隐含成功后价值失去意义`);
      prev = isFinite(n) ? n : prev;
    }
    for (const k of Object.keys(p.prob)) {
      if (k === "_doc") continue;
      if (!order.includes(k)) E("V-01", `params.prob 出现未知键 "${k}"`);
    }
  }

  // ---- V-12 置信折价
  if (blockDeclared(p.confidence)) {
    const hi = Number(p.confidence.high);
    const md = Number(p.confidence.medium);
    const lo = Number(p.confidence.low);
    if (hi !== 1) E("V-12", `confidence.high=${p.confidence.high} 必须等于 1.0: 高于 1 等于给「自觉准」加分`);
    if (!(lo > 0 && lo <= md && md <= hi)) E("V-12", `confidence 必须满足 0 < low <= medium <= high, 当前 ${lo} / ${md} / ${hi}`);
  }

  // ---- V-13 跑道档位
  if (blockDeclared(p.runway) && isPlain(p.runway)) {
    for (const k of Object.keys(p.runway)) {
      if (!["rules", "floor_months", "_doc"].includes(k)) E("V-01", `params.runway 出现未知键 "${k}"`);
    }
    if (blockDeclared(p.runway.rules)) {
      const rules = p.runway.rules;
      if (!Array.isArray(rules) || rules.length !== 3) E("V-13", "runway.rules 必须是三档");
      else {
        const want = ["充足", "偏紧", "不足"];
        let prev = Infinity;
        rules.forEach((row, i) => {
          const th = Number(Array.isArray(row) ? row[0] : NaN);
          const label = Array.isArray(row) ? row[1] : "";
          if (!isFinite(th)) E("V-13", `runway.rules[${i}] 阈值非数值`);
          else if (th >= prev) E("V-13", `runway.rules[${i}] 阈值 ${th} 未严格递减`);
          if (label !== want[i]) E("V-13", `runway.rules[${i}] 标签应为「${want[i]}」, 当前「${label}」: 档位标签是报告语言, 锁死才能让不同口径的报告互相引用`);
          prev = isFinite(th) ? th : prev;
        });
      }
    }
    if (hasVal(p.runway.floor_months)) {
      const v = Number(p.runway.floor_months);
      if (!isFinite(v) || v < 3) E("V-04", `runway.floor_months=${p.runway.floor_months} 不得低于 3 个月`);
    }
  }

  // ---- V-04 标量
  if (hasVal(p.w_cap)) {
    const v = Number(p.w_cap);
    if (!isFinite(v) || v < 0.15 || v > 1) E("V-04", `w_cap=${p.w_cap} 非法: 应在 0.15 至 1 之间, 下限防单维绑架, 下限过低则失去约束意义`);
  }
  if (hasVal(p.deviation_threshold)) {
    const v = Number(p.deviation_threshold);
    if (!isFinite(v) || v <= 1) E("V-04", `deviation_threshold=${p.deviation_threshold} 非法: 必须大于 1`);
  }

  // ---- V-15 结论阈值
  if (blockDeclared(p.verdict_thresholds)) {
    const c = Number(p.verdict_thresholds.conditional);
    const pa = Number(p.verdict_thresholds.pass);
    const pf = Number(p.verdict_thresholds.preferred);
    if (!(c > 0 && c < pa && pa < pf && pf <= 100)) {
      E("V-15", `verdict_thresholds 必须满足 0 < conditional < pass < preferred <= 100, 当前 ${c} / ${pa} / ${pf}`);
    }
  }

  // ---- 自定义警惕项
  if (hasVal(p.rf_extensions)) {
    if (!Array.isArray(p.rf_extensions)) E("V-01", "rf_extensions 必须是数组");
    else {
      p.rf_extensions.forEach((x, i) => {
        if (!isPlain(x) || !/^RF-(4[5-9]|[5-9]\d)$/.test(String(x.id))) E("V-01", `rf_extensions[${i}] 的 id 必须是 RF-45 起的编号`);
        if (x && x.severity !== "warn") E("V-01", `rf_extensions[${i}] 只允许 severity=warn: 允许新增一票否决会让红旗计数在不同客户间不可比, 也给「自定义否决以压价」留了口子`);
        if (x && x.dim !== "EXT") E("V-01", `rf_extensions[${i}] 的 dim 必须是 "EXT"`);
      });
    }
  }

  // ---- V-16 / V-17 溯源(只统计本脚本消费的块, ownership.* 归另一个脚本)
  const srcs = Array.isArray(cfg.sources) ? cfg.sources : [];
  const refs = isPlain(cfg.param_sources) ? cfg.param_sources : {};
  const allRefs = [...new Set(Object.entries(refs).filter(([k]) => !String(k).startsWith("ownership")).flatMap(([, v]) => (Array.isArray(v) ? v : [])).filter((x) => typeof x === "string"))];
  const srcIds = new Set(srcs.map((s) => s && s.id));
  for (const r of allRefs) {
    if (!srcIds.has(r)) E("V-16", `param_sources 引用了不存在的来源 ${r}: 强制溯源, 不留后门`);
  }
  const levels = new Map(srcs.map((s) => [s && s.id, s && s.level]));
  const prim = allRefs.filter((r) => ["一级", "二级"].includes(levels.get(r)));
  const overridden = PARAM_KEYS.filter((k) => k !== "_doc" && k !== "ownership" && k !== "rf_extensions" && blockDeclared(p[k]));
  if (overridden.length && !allRefs.length) {
    W("V-19", `参数集覆盖了 ${overridden.length} 个块但未声明任何来源(param_sources 为空): 输出将标注「未溯源」`);
  } else if (allRefs.length && !prim.length) {
    E("V-17", `param_sources 全部为三级或更低来源: 生效中参数至少需要 1 条一级或二级来源, 三级只能作代理样本标注`);
  }

  // ---- V-18 失效
  let stale = false;
  if (cfg.expires_on) {
    const exp = String(cfg.expires_on);
    if (exp < today()) {
      stale = true;
      W("V-18", `参数集已于 ${exp} 过失效日: 输出将标注 STALE, 不阻断计算(回溯测试场景需要), 但结论时效性由使用方承担`);
    }
  } else {
    W("V-18", "参数集未声明 expires_on: 无法判断时效性, 输出将标注 STALE");
    stale = true;
  }

  const proxyCount = srcs.filter((s) => s && s.proxy === true && allRefs.includes(s.id)).length;
  return { errors, warns, stale, proxyCount, sourceRefs: allRefs };
}

/** 把外部参数集与内置默认合并。返回的对象若与默认完全等价, 直接返回 DEFAULTS 本体。 */
function resolveParams(cfg, opts = {}) {
  if (!cfg) return DEFAULTS;
  const p = isPlain(cfg.params) ? cfg.params : {};
  const out = {
    WEIGHTS: DEFAULTS.WEIGHTS,
    STAGE_FACTOR: DEFAULTS.STAGE_FACTOR,
    GATE_FACTOR: DEFAULTS.GATE_FACTOR,
    REV_MULT: DEFAULTS.REV_MULT,
    MILESTONE_MONTHS: DEFAULTS.MILESTONE_MONTHS,
    MILESTONE_BUFFER: DEFAULTS.MILESTONE_BUFFER,
    PROB_BY_MILESTONE: DEFAULTS.PROB_BY_MILESTONE,
    CONF_DISCOUNT: DEFAULTS.CONF_DISCOUNT,
    W_CAP: DEFAULTS.W_CAP,
    RUNWAY_RULES: DEFAULTS.RUNWAY_RULES,
    RUNWAY_FLOOR_MONTHS: DEFAULTS.RUNWAY_FLOOR_MONTHS,
    DEVIATION_FLAG: DEFAULTS.DEVIATION_FLAG,
    VERDICT_THRESHOLDS: DEFAULTS.VERDICT_THRESHOLDS,
    sensitivity_rates: DEFAULTS.sensitivity_rates,
  };
  const ov = [];
  const pick = (blk) => Object.fromEntries(Object.entries(blk).filter(([k, v]) => k !== "_doc" && hasVal(v)));

  if (blockDeclared(p.weights)) {
    let w = pick(p.weights);
    if (opts.normalizeWeights) {
      const sum = Object.values(w).reduce((a, v) => a + Number(v), 0);
      if (sum > 0) w = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Number(v) / sum]));
    }
    out.WEIGHTS = w;
    ov.push("weights");
  }
  if (blockDeclared(p.stage_factor)) {
    const s = {};
    for (const st of Object.keys(STAGE_FACTOR)) s[st] = pick(p.stage_factor[st] || {});
    out.STAGE_FACTOR = s;
    ov.push("stage_factor");
  }
  if (blockDeclared(p.gate_factor)) {
    const g = {};
    for (const f of Object.keys(ASSET_FAMILIES)) g[f] = pick(p.gate_factor[f] || {});
    out.GATE_FACTOR = g;
    ov.push("gate_factor");
  }
  if (blockDeclared(p.rev_mult)) {
    const r = {};
    for (const f of Object.keys(p.rev_mult)) {
      if (f === "_doc" || !hasVal(p.rev_mult[f])) continue;
      r[f] = p.rev_mult[f].map((b) => [Number(b[0]), [Number(b[1][0]), Number(b[1][1])]]);
    }
    out.REV_MULT = r;
    ov.push("rev_mult");
  }
  if (blockDeclared(p.milestones) && isPlain(p.milestones)) {
    if (blockDeclared(p.milestones.months)) {
      const mm = { ...MILESTONE_MONTHS };
      for (const f of Object.keys(p.milestones.months)) {
        if (f === "_doc" || !hasVal(p.milestones.months[f])) continue;
        const row = {};
        for (const lv of Object.keys(p.milestones.months[f])) {
          if (lv === "_doc") continue;
          const pair = p.milestones.months[f][lv];
          if (Array.isArray(pair)) row[lv] = [Number(pair[0]), Number(pair[1])];
        }
        mm[f] = { ...(mm[f] || {}), ...row };
      }
      out.MILESTONE_MONTHS = mm;
      ov.push("milestones_months");
    }
    if (blockDeclared(p.milestones.buffer)) {
      out.MILESTONE_BUFFER = { ...MILESTONE_BUFFER, ...pick(p.milestones.buffer) };
      ov.push("milestones_buffer");
    }
  }
  if (blockDeclared(p.prob)) {
    out.PROB_BY_MILESTONE = Object.fromEntries(Object.entries(pick(p.prob)).map(([k, v]) => [k, Number(v)]));
    ov.push("prob");
  }
  if (blockDeclared(p.confidence)) {
    out.CONF_DISCOUNT = Object.fromEntries(Object.entries(pick(p.confidence)).map(([k, v]) => [k, Number(v)]));
    ov.push("confidence");
  }
  if (blockDeclared(p.runway) && isPlain(p.runway)) {
    if (blockDeclared(p.runway.rules)) {
      out.RUNWAY_RULES = p.runway.rules.map((r) => [Number(r[0]), String(r[1]), String(r[2] || "")]);
      ov.push("runway_rules");
    }
    if (hasVal(p.runway.floor_months)) {
      out.RUNWAY_FLOOR_MONTHS = Number(p.runway.floor_months);
      ov.push("runway_floor");
    }
  }
  if (hasVal(p.w_cap)) { out.W_CAP = Number(p.w_cap); ov.push("w_cap"); }
  if (hasVal(p.deviation_threshold)) { out.DEVIATION_FLAG = Number(p.deviation_threshold); ov.push("deviation_threshold"); }
  if (blockDeclared(p.verdict_thresholds)) {
    out.VERDICT_THRESHOLDS = Object.fromEntries(Object.entries(pick(p.verdict_thresholds)).map(([k, v]) => [k, Number(v)]));
    ov.push("verdict_thresholds");
  }
  if (hasVal(p.sensitivity_rates)) {
    // 三档是硬约束: 报告的表头就是三列, 给两档或四档会让表格与数据错位
    const rates = Array.isArray(p.sensitivity_rates) ? p.sensitivity_rates.map(Number) : [];
    out.sensitivity_rates = rates.length === 3 && rates.every(isFinite) ? rates : DEFAULTS.sensitivity_rates;
    ov.push("sensitivity_rates");
  }

  // 值与默认等价时回到 DEFAULTS 本体: 保证「等价输入产出逐字相同的输出」
  const same = Object.keys(DEFAULTS).every((k) => deepEqual(out[k], DEFAULTS[k]));
  if (same) return DEFAULTS;

  const v = validateConfig(cfg, opts);
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

/** schema 兼容判定: 主版本相同且次版本不高于脚本, 视为可解析
 *  (新增可选字段属兼容变更, 不应让旧输入的每一份报告都跳告警) */
function schemaCompatible(v) {
  const a = String(v).split(".").map((x) => Number(x));
  const b = SCHEMA_VERSION.split(".").map((x) => Number(x));
  if (!isFinite(a[0]) || !isFinite(a[1] === undefined ? 0 : a[1])) return false;
  const aMinor = a[1] === undefined ? 0 : a[1];
  return a[0] === b[0] && aMinor <= b[1];
}

/** 把内置默认参数导出为一份合法 config, 供 --print-defaults 使用 */
function defaultsAsConfig() {
  return {
    config_version: "1.0",
    id: "builtin-default",
    // 标签也跟着语言走: 打印出来的是一份会被回灌的 config, 不是给人看的报告
    label: t("ui.builtinLabel", "内置默认参数"),
    as_of: today(),
    effective_from: today(),
    expires_on: "9999-12-31",
    basis: { upstream_version: VERSION, builtin: true },
    params: {
      weights: { ...DEFAULTS.WEIGHTS },
      stage_factor: DEFAULTS.STAGE_FACTOR,
      gate_factor: DEFAULTS.GATE_FACTOR,
      rev_mult: DEFAULTS.REV_MULT,
      milestones: { months: DEFAULTS.MILESTONE_MONTHS, buffer: DEFAULTS.MILESTONE_BUFFER },
      prob: DEFAULTS.PROB_BY_MILESTONE,
      confidence: DEFAULTS.CONF_DISCOUNT,
      runway: { rules: DEFAULTS.RUNWAY_RULES, floor_months: DEFAULTS.RUNWAY_FLOOR_MONTHS },
      w_cap: DEFAULTS.W_CAP,
      deviation_threshold: DEFAULTS.DEVIATION_FLAG,
      verdict_thresholds: DEFAULTS.VERDICT_THRESHOLDS,
      sensitivity_rates: [...DEFAULTS.sensitivity_rates],
    },
    sources: [],
    param_sources: {},
  };
}

/** 覆盖项 → 显示串 */
function describeOverrides(list) {
  return list.map((k) => {
    const m = BLOCK_LABELS[k];
    return m ? `${m[0]}(${m[1]})` : k;
  }).join(", ");
}

// ============================================================
// 计算
// ============================================================

function analyze(d, P = DEFAULTS, extra = []) {
  const warnings = [];
  const w = (msg) => warnings.push(msg);
  if (P.__meta && Array.isArray(P.__meta.warns)) P.__meta.warns.forEach((x) => w(x));
  extra.forEach((x) => w(x));

  // ---- 0. 输入归一
  const meta = d.meta || {};
  const company = d.company || {};
  const asset = d.asset || {};
  const fin = d.financials || {};
  const val = d.valuation || {};
  const exit = d.exit || {};

  if (!meta.as_of) w(t("warn.asOf", "meta.as_of 缺失, 已按运行日作为数据截止日"));
  if (meta.schema_version && !schemaCompatible(meta.schema_version)) {
    w(t("warn.schemaVersion", "输入 schema_version={v} 与脚本 {cur} 不兼容(主版本不同或次版本更高), 未识别字段将被忽略", { v: meta.schema_version, cur: SCHEMA_VERSION }));
  }
  if (meta.currency && meta.currency !== "CNY") {
    w(t("warn.currency", "meta.currency={v} 暂不支持换算, 金额一律按原值处理, 跨币种结论不可比", { v: meta.currency }));
  }
  if (!company.name) w(t("warn.companyName", "company.name 缺失, 输出以「未命名主体」占位"));
  if (!company.stage || !P.STAGE_FACTOR[company.stage]) {
    w(t("warn.stageDomain", "company.stage={v} 不在取值域内, 权重按 a 轮处理", { v: company.stage || t("ui.missing", "缺失") }));
  }
  const stage = P.STAGE_FACTOR[company.stage] ? company.stage : "a";

  // ---- 1. 资产属性门禁
  let familyKey = asset.class;
  if (!familyKey || !ASSET_FAMILIES[familyKey]) {
    w(t("warn.classDomain", "asset.class={v} 不在取值域内, 保守按「单向监测(降级)」处理", { v: familyKey || t("ui.missing", "缺失") }));
    familyKey = "monitoring_only";
  }
  const declaredClass = familyKey;
  let downgraded = false;
  if (asset.closed_loop === false) {
    if (familyKey !== "monitoring_only") {
      w(t("warn.openLoop", "asset.closed_loop=false: 按 NMPA 分类界定四特征中「实时双向交互或闭环反馈」一项不满足, 资产由「{from}」降级为「{to}」, 期权法不再适用", { from: t(`family.${familyKey}.label`, ASSET_FAMILIES[familyKey].label), to: t("family.monitoring_only.label", ASSET_FAMILIES.monitoring_only.label) }));
      familyKey = "monitoring_only";
      downgraded = true;
    }
  } else if (asset.closed_loop === undefined) {
    w(t("warn.closedLoopMissing", "asset.closed_loop 缺失: 闭环真实性未经确认, 建议索取闭环链路图"));
  }
  const family = ASSET_FAMILIES[familyKey];

  if (declaredClass === "rehab_class2" && asset.ai_based === true) {
    w(t("warn.aiRehab", "asset.class=rehab_class2 且 ai_based=true: 按 2026 年第 24 号通告, 脑卒中肢体运动康复训练若采用人工智能技术应按第三类管理, 二类路径需复核"));
  }
  if (asset.class === "consumer_nondevice" && asset.ai_based === true) {
    w(t("warn.consumerClaim", "asset.class=consumer_nondevice: 非医疗器械不得声称改善、修复或替代中枢神经系统功能的医疗效果, 对外表述需与注册属性一致"));
  }
  // NMPA 编码警告只在 cn 辖区下有意义: 对一家走 FDA 路径的公司说
  // 「应按 2026 年第 24 号通告编码」是口径噪音。
  if (asset.class && !asset.classification_code && JURISDICTION === "cn") {
    w(t("warn.classCodeMissing", "asset.classification_code 缺失: 对照 2026 年第 24 号通告, {code} 应为预期分类编码, 请核实分类界定结论", { code: ASSET_FAMILIES[asset.class] ? t(`family.${asset.class}.code`, ASSET_FAMILIES[asset.class].code) : t("ui.thisClass", "该类产品") }));
  }
  if (asset.classification_code && JURISDICTION === "cn" && CLASS_CODE_EXPECT[asset.class]) {
    const ok = CLASS_CODE_EXPECT[asset.class].some((c) => String(asset.classification_code).replace(/-/g, "") === c.replace(/-/g, ""));
    if (!ok) {
      w(t("warn.classCodeMismatch", "asset.classification_code={got} 与 asset.class={cls} 的预期编码({expect})不一致", { got: asset.classification_code, cls: asset.class, expect: CLASS_CODE_EXPECT[asset.class].join(" / ") }));
    }
  }
  if (asset.snr_db !== null && asset.snr_db !== undefined && isFinite(asset.snr_db)) {
    const indications = Array.isArray(asset.indication) ? asset.indication.join("") : "";
    const semantic = /语义|思维|语言|汉字|意图/.test(indications);
    if (semantic && asset.snr_db < -10 && asset.modality && String(asset.modality).startsWith("noninvasive")) {
      w(t("warn.snr", "asset.snr_db={v} dB 且宣称涉及语义或意图解码: 该信噪比条件下高精度语义解码缺乏物理可行性, 要求提供关闭 EMG / EOG 通道后的对照结果", { v: asset.snr_db }));
    }
  }
  if (asset.modality === undefined) w(t("warn.modalityMissing", "asset.modality 缺失: 技术路线未确认, 影响后续技术维度评分与注册路径判定"));

  // ---- 2. 里程碑定位
  const path = MILESTONE_PATHS[declaredClass] || MILESTONE_PATHS.default;
  const items = (d.milestones && Array.isArray(d.milestones.items)) ? d.milestones.items : [];
  if (!items.length) w(t("warn.msEmpty", "milestones.items 为空: 无法定位里程碑, 跑道与估值口径校验将降级"));
  const byId = new Map(items.map((it) => [it.id, it]));
  const doneSet = new Set(items.filter((it) => it.status === "done").map((it) => it.id));

  let prefix = 0;
  for (const id of path) {
    if (doneSet.has(id)) prefix += 1;
    else break;
  }
  const currentId = prefix > 0 ? path[prefix - 1] : null;
  const nextId = prefix < path.length ? path[prefix] : null;

  items.filter((it) => it.status === "done" && !it.date).forEach((it) => {
    w(t("warn.msNoDate", "里程碑 {id} 标记为 done 但未提供达成日期, 其可核性不足", { id: it.id }));
  });
  const doneOffPath = [...doneSet].filter((id) => !path.includes(id));
  if (doneOffPath.length) {
    w(t("warn.msOffPath", "里程碑 {ids} 不在该类资产的典型路径上, 请确认路径判定是否准确", { ids: doneOffPath.join(sep()) }));
  }
  const skipped = path.slice(0, path.length).filter((id, i) => i > 0 && doneSet.has(id) && !doneSet.has(path[i - 1]));
  if (skipped.length) {
    w(t("warn.msChain", "证据链断档: {list}", { list: skipped.map((id) => t("warn.msChain.item", "{id} 已达成但 {prev} 未达成", { id, prev: path[path.indexOf(id) - 1] })).join("; ") }));
  }

  // 里程碑耗时按族取: 二类康复的 L3 与植入式的 L3 不是一个东西, 故不支持全局一刀切
  const monthsOf = (id) => {
    const bf = P.MILESTONE_MONTHS || {};
    const fam = isPlain(bf[familyKey]) ? bf[familyKey] : {};
    const def = isPlain(bf.default) ? bf.default : {};
    const v = hasVal(fam[id]) ? fam[id] : def[id];
    if (Array.isArray(v) && v.length === 2) return v;
    const m = MILESTONES.find((x) => x.id === id);
    return m ? m.months : null;
  };

  const nextMeta = nextId ? MILESTONES.find((m) => m.id === nextId) : null;
  const nextMonths = nextId ? monthsOf(nextId) : null;
  const nextBuf = P.MILESTONE_BUFFER[nextId] || P.MILESTONE_BUFFER.default;
  const needLo = nextMonths ? nextMonths[0] * nextBuf : null;
  const needHi = nextMonths ? nextMonths[1] * nextBuf : null;
  const needMid = nextMonths ? mid(nextMonths) * nextBuf : null;

  const providedSet = new Set(nextId && byId.get(nextId) ? (byId.get(nextId).provided || []) : []);
  const missingEvidence = nextMeta ? nextMeta.evidence.filter((e) => !providedSet.has(e.key)) : [];

  // 已达成里程碑的证据完整性: 声称 done 但证据不足, 是「伪达成」的主要来源
  for (const id of path) {
    const it = byId.get(id);
    if (!it || it.status !== "done") continue;
    const m = MILESTONES.find((x) => x.id === id);
    const prov = new Set(it.provided || []);
    const lack = m.evidence.filter((e) => !prov.has(e.key));
    if (lack.length) {
      w(t("warn.msEvidence", "里程碑 {id} 标记为 done 但证据不完整({got}/{total}), 缺: {lack}", { id, got: m.evidence.length - lack.length, total: m.evidence.length, lack: lack.map((e) => t(`milestone.${id}.evidence.${e.key}`, e.label)).join(sep()) }));
    }
  }

  // ---- 3. 九维加权评分
  const dimIn = Array.isArray(d.dimensions) ? d.dimensions : [];
  const dimMap = new Map(dimIn.map((x) => [x.id, x]));
  if (!dimIn.length) w(t("warn.dimEmpty", "dimensions 为空: 九维评分无法计算"));
  const missingDims = DIM_IDS.filter((id) => !dimMap.has(id));
  if (dimIn.length && missingDims.length) w(t("warn.dimMissing", "维度缺评: {ids}, 按 0 分计入加权", { ids: missingDims.join(sep()) }));

  const rawW = {};
  for (const id of DIM_IDS) {
    const sf = (P.STAGE_FACTOR[stage] || {})[id] || 1;
    const gf = (P.GATE_FACTOR[familyKey] || {})[id] || 1;
    rawW[id] = P.WEIGHTS[id] * sf * gf;
  }
  let sumW = DIM_IDS.reduce((a, id) => a + rawW[id], 0);
  DIM_IDS.forEach((id) => { rawW[id] = rawW[id] / sumW; });
  let capped = false;
  DIM_IDS.forEach((id) => { if (rawW[id] > P.W_CAP) { rawW[id] = P.W_CAP; capped = true; } });
  if (capped) {
    sumW = DIM_IDS.reduce((a, id) => a + rawW[id], 0);
    DIM_IDS.forEach((id) => { rawW[id] = rawW[id] / sumW; });
  }
  const finalW = rawW;

  const rows = [];
  let total = 0;
  for (const id of DIM_IDS) {
    const dim = dimMap.get(id) || {};
    let score = Number(dim.score);
    if (!isFinite(score)) {
      if (dimIn.length) w(t("warn.dimScoreMissing", "维度 {id} 的 score 缺失或非数值, 按 0 分处理", { id }));
      score = 0;
    }
    if (score < 0 || score > 100) {
      w(t("warn.dimScoreRange", "维度 {id} 的 score={score} 越界, 已截断至 0-100", { id, score }));
      score = clamp(score, 0, 100);
    }
    const conf = P.CONF_DISCOUNT[dim.confidence] !== undefined ? dim.confidence : "medium";
    if (dim.confidence && P.CONF_DISCOUNT[dim.confidence] === undefined) {
      w(t("warn.confDomain", "维度 {id} 的 confidence={v} 不在取值域内, 按 medium 处理", { id, v: dim.confidence }));
    }
    const evList = Array.isArray(dim.evidence) ? dim.evidence : [];
    evList.forEach((e, i) => {
      if (!e || !e.source) w(t("warn.evidenceSource", "维度 {id} 第 {n} 条证据缺 source: 该条不可追溯", { id, n: i + 1 }));
      if (!e || !e.date) w(t("warn.evidenceDate", "维度 {id} 第 {n} 条证据缺 date: 该条未标注时点, 与当前结论的可比性下降", { id, n: i + 1 }));
    });
    const eff = score * P.CONF_DISCOUNT[conf];
    const contrib = finalW[id] * eff;
    total += contrib;
    rows.push({ id, score, conf, eff, weight: finalW[id], contrib, open: (dim.checks_open || []), notes: dim.notes || "" });
  }

  // ---- 4. 致命红旗筛查
  const rfIn = Array.isArray(d.redflags) ? d.redflags : [];
  const knownIds = new Set(RF_LIBRARY.map((r) => r.id));
  rfIn.forEach((r) => {
    if (!r || !knownIds.has(r.id)) w(t("warn.rfUnknown", "红旗编号 {id} 不存在于 RF_LIBRARY(RF-01 至 RF-44), 已忽略", { id: r && r.id }));
    if (r && !["open", "mitigated", "cleared", "unknown"].includes(r.status)) {
      w(t("warn.rfStatus", "红旗 {id} 的 status={v} 不在取值域内, 按 unknown 处理", { id: r.id, v: r.status }));
    }
  });
  const statusOf = (id) => {
    const hit = rfIn.find((r) => r && r.id === id);
    if (!hit) return "not_listed";
    return ["open", "mitigated", "cleared", "unknown"].includes(hit.status) ? hit.status : "unknown";
  };
  const vetoOpen = RF_LIBRARY.filter((r) => r.severity === "veto" && statusOf(r.id) === "open");
  const vetoUnknown = RF_LIBRARY.filter((r) => r.severity === "veto" && statusOf(r.id) === "unknown");
  const fatalOpen = RF_LIBRARY.filter((r) => r.severity === "fatal" && statusOf(r.id) === "open");
  const warnOpen = RF_LIBRARY.filter((r) => r.severity === "warn" && statusOf(r.id) === "open");

  // ---- 5. 现金跑道
  const cash = Number.isFinite(Number(fin.cash)) ? Number(fin.cash) : null;
  const credit = Number.isFinite(Number(fin.undrawn_credit)) ? Number(fin.undrawn_credit) : 0;
  const burn = Number.isFinite(Number(fin.burn_monthly)) && Number(fin.burn_monthly) > 0 ? Number(fin.burn_monthly) : null;
  const liquidity = cash === null ? null : cash + credit;
  const runway = liquidity !== null && burn !== null ? liquidity / burn : null;
  const ratio = runway !== null && needMid ? runway / needMid : null;
  let runwayTier = null;
  if (ratio !== null) {
    for (const [i, rule] of P.RUNWAY_RULES.entries()) {
      const [th, label, desc] = rule;
      if (ratio >= th) { runwayTier = { th, label, desc, idx: i }; break; }
    }
  }
  if (cash !== null && cash < 0) w(t("warn.cashNegative", "financials.cash 为负: 现金及等价物不应为负数, 请核对科目口径"));
  if (burn === null && cash !== null) w(t("warn.burnMissing", "financials.burn_monthly 缺失或非正数: 无法计算现金跑道"));
  if (runway !== null && runway < P.RUNWAY_FLOOR_MONTHS) {
    w(t("warn.runwayFloor", "现金跑道 {v} 个月低于 {floor} 个月红线(只计现金与未使用授信, 未含应付账款展期)", { v: num(runway, 1), floor: P.RUNWAY_FLOOR_MONTHS }));
  }

  const rev = Number.isFinite(Number(fin.revenue_ttm)) ? Number(fin.revenue_ttm) : null;
  const prior = Number.isFinite(Number(fin.revenue_prior_year)) ? Number(fin.revenue_prior_year) : null;
  const post = Number.isFinite(Number(val.post_money)) ? Number(val.post_money) : null;
  const growth = rev !== null && prior !== null && prior > 0 ? rev / prior - 1 : null;
  const gm = ratio01(fin.gross_margin, "gross_margin", warnings);
  const rd = ratio01(fin.rd_ratio, "rd_ratio", warnings);
  const grant = ratio01(fin.grant_ratio, "grant_ratio", warnings);

  if (gm !== null && gm < 0.3 && familyKey !== "consumer_nondevice") {
    w(t("warn.grossMargin", "毛利率 {v}% 低于 30%: 硬件型医疗设备的毛利结构需解释是否含低毛利集成或工程项目收入", { v: num(gm * 100, 1) }));
  }
  if (grant !== null && grant > 0.3) {
    w(t("warn.grant", "政府补助占收入 {v}%: 剔除补助后的经营性收入质量需单独评估", { v: num(grant * 100, 1) }));
  }
  if (rd !== null && rd > 0.5) {
    w(t("warn.rdRatio", "研发费用率 {v}% 偏高: 与收入规模匹配度及后续融资依赖度需说明", { v: num(rd * 100, 1) }));
  }

  // ---- 6. 估值口径与偏离
  const impliedPS = rev !== null && rev > 0 && post !== null ? post / rev : null;
  let band = null;
  let bandLabel = "";
  // 收入档边界在本辖区 pending 时, 内置(cn 口径)的档区间一个数字都不能漏出来:
  // 印出 8–15x 会让人以为这是本辖区的核实边界 —— 那正是 pending 想拦住的事。
  const revMultPending = PROFILE && PROFILE.rev_mult && PROFILE.rev_mult.status === "pending";
  if (!revMultPending && P.REV_MULT[familyKey]) {
    const buckets = P.REV_MULT[familyKey];
    const r = rev === null ? 0 : rev;
    for (let i = 0; i < buckets.length; i += 1) {
      if (r >= buckets[i][0]) {
        band = buckets[i][1];
        bandLabel = bandLabelFor(i, buckets.map((b) => b[0]));
      }
    }
  }
  const deviation = impliedPS !== null && band ? impliedPS / band[1] : null;
  const isMismatch = deviation !== null && deviation > P.DEVIATION_FLAG && !family.allow_option;

  // 申报口径下的对照区间: 降级情形下用于说明「按申报口径衡量需要被解释多少」
  let declaredBand = null;
  if (!revMultPending && P.REV_MULT[declaredClass]) {
    const buckets = P.REV_MULT[declaredClass];
    const rr = rev === null ? 0 : rev;
    for (let i = 0; i < buckets.length; i += 1) {
      if (rr >= buckets[i][0]) declaredBand = buckets[i][1];
    }
  }
  const declaredDeviation = impliedPS !== null && declaredBand ? impliedPS / declaredBand[1] : null;

  if (isMismatch) {
    w(
      t(
        "warn.mismatch",
        "估值口径错配: 按当前判定口径「{family}」衡量, 隐含 P/S {ps} 为区间上沿({cap})的 {dev} 倍, 且该资产类别不适用期权法",
        { family: t(`family.${familyKey}.label`, family.label), ps: num(impliedPS, 1), cap: band[1], dev: num(deviation, 1) }
      )
    );
  }

  const probNext = nextId ? P.PROB_BY_MILESTONE[nextId] : null;
  const impliedSuccessValue = probNext && post !== null ? post / probNext : null;

  // ---- 7. 结论分级
  const VT = P.VERDICT_THRESHOLDS;
  let grade = total >= VT.preferred ? "preferred" : total >= VT.pass ? "pass" : total >= VT.conditional ? "conditional" : "watch";
  const capReasons = [];

  // 证据覆盖不足时不输出分级: 零证据下的任何结论都会误导
  const scoredDims = rows.filter((x) => x.score > 0).length;
  if (scoredDims === 0 || !items.length) {
    grade = "hold";
    capReasons.push(
      t("cap.hold", "可用评分维度 {dims}/9、已填里程碑 {ms}/7, 未达出结论的最低证据要求", { dims: scoredDims, ms: items.length })
    );
  }

  if (grade !== "hold" && vetoOpen.length) {
    grade = "veto";
    capReasons.push(
      t("cap.veto", "存在 {n} 条未闭合的一票否决项({ids})", { n: vetoOpen.length, ids: vetoOpen.map((r) => r.id).join(sep()) })
    );
  }
  if (grade !== "veto") {
    if (vetoUnknown.length || fatalOpen.length) {
      if (VERDICT_INDEX[grade] > VERDICT_INDEX.watch) {
        grade = "watch";
        capReasons.push(
          t("cap.watchUnknown", "存在状态不明的一票否决项({unknown})或未闭合致命项({fatal}), 分数不作为通过依据", {
            unknown: vetoUnknown.map((r) => r.id).join(sep()) || t("ui.noneShort", "无"),
            fatal: fatalOpen.map((r) => r.id).join(sep()) || t("ui.noneShort", "无"),
          })
        );
      }
    }
    if (isMismatch && VERDICT_INDEX[grade] > VERDICT_INDEX.watch) {
      grade = "watch";
      capReasons.push(t("cap.mismatch", "估值口径错配, 计价范式需先澄清"));
    }
    if (grade === "preferred" && (!currentId || !["L4", "L5", "L6"].includes(currentId))) {
      grade = "pass";
      capReasons.push(
        t("cap.milestone", "里程碑当前为 {ms}, 未达 L4, 不进入加注评估", { ms: currentId || t("ui.notStarted", "尚未启动") })
      );
    }
    if (grade === "preferred" && runwayTier && runwayTier.idx !== 0) {
      grade = "pass";
      capReasons.push(
        t("cap.runway", "跑道档位为「{tier}」, 未达{full}", {
          tier: t(`runway.${runwayTier.idx}.label`, runwayTier.label),
          full: t(`runway.0.label`, P.RUNWAY_RULES[0][1]),
        })
      );
    }
  }
  const verdict = VERDICTS[VERDICT_INDEX[grade]];

  /** 辖区档 pending 标签的渲染映射。校验器(jurisdiction.mjs)发的是中文短标签,
   *  与 RF/里程碑枚举同性质: 源码枚举是唯一真源, 译名进词表。未知标签原样透传
   *  —— 显示 `rev_mult` 也比显示一个猜错的译名安全。 */
  const profilePendingMsg = (pg) => {
    if (pg.msg === "收入档边界") return t("gap.msg.revMult", "收入档边界");
    if (pg.msg === "控制线阈值") return t("gap.msg.controlLines", "控制线阈值");
    const m = /^退出通道 (.+)$/.exec(pg.msg);
    if (m) return t("gap.msg.exitChannel", "退出通道 {key}", { key: m[1] });
    return pg.msg;
  };

  // ---- 证据缺口
  const gaps = [];
  missingEvidence.forEach((e) =>
    gaps.push({
      item: t(`milestone.${nextId}.evidence.${e.key}`, e.label),
      type: t("gap.type.evidence", "里程碑证据"),
      where: `${nextId}`,
      owner: t("gap.owner.target", "标的方"),
      due: t("gap.due.preClose", "下一轮交割前"),
    })
  );
  [...vetoOpen, ...vetoUnknown, ...fatalOpen].forEach((r) =>
    gaps.push({
      item: `${r.id} ${t(`rf.${r.id}.name`, r.name)}`,
      type: t("gap.type.redflag", "红旗核查"),
      where: t(`rf.${r.id}.action`, r.action),
      owner: t("gap.owner.targetThirdParty", "标的方 + 第三方核验"),
      due: t("gap.due.dd", "尽调期内"),
    })
  );
  // 辖区档自陈的未核实项进证据缺口。不写进这里, 「不知道」就会在报告里
  // 变成「没有问题」—— 这是本框架最容易犯也最难发现的错。
  for (const pg of PROFILE_PENDING) {
    gaps.push({
      // msg 是校验器发的中文短标签(数据性枚举), 渲染层经词表映射 —— 与 withLocalizedText 同法:
      // 标签住在源码枚举里, 译名住在词表里, 两处各司其职。
      item: t("gap.item.profilePending", "辖区档 {path} 未核实: {msg}", { path: pg.path, msg: profilePendingMsg(pg) }),
      type: t("gap.type.profile", "辖区档门槛"),
      where: `assets/jurisdictions/${JURISDICTION}.json`,
      owner: t("gap.owner.analyst", "本仓库维护人"),
      due: t("gap.due.nextRelease", "下一版发布前"),
    });
  }
  // 缺数据的「本节不适用」也必须进缺口表, 否则跑道章的拒答行只说了「不适用」,
  // 读者却找不到谁负责补 —— 拒答的义务是可行动。
  if (fin.cash == null || fin.burn_monthly == null) {
    gaps.push({
      item: t("gap.item.runwayData", "现金余额与月均净流出未提供, 现金跑道无法计算"),
      type: t("gap.type.data", "输入数据缺失"),
      where: "financials.cash / financials.burn_monthly",
      owner: t("gap.owner.target", "标的方"),
      due: t("gap.due.dd", "尽调期内"),
    });
  }
  rows
    .filter((r) => r.open.length)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .forEach((r) => gaps.push({ item: t("gap.item.dimOpen", "{id} 未完成检查项 {open}", { id: r.id, open: r.open.join(sep()) }), type: t("gap.type.dimOpen", "维度检查项"), where: r.id, owner: t("gap.owner.target", "标的方"), due: t("gap.due.dd", "尽调期内") }));

  return {
    meta, company, asset, fin, val, exit,
    stage, familyKey, family, declaredClass, downgraded,
    path, items, byId, doneSet, prefix, currentId, nextId, nextMeta, needLo, needHi, needMid,
    missingEvidence, skipped, doneOffPath,
    rows, total, finalW, capped,
    vetoOpen, vetoUnknown, fatalOpen, warnOpen, statusOf,
    rfTouched: RF_LIBRARY.filter((x) => statusOf(x.id) !== "not_listed").length,
    cash, credit, liquidity, burn, runway, ratio, runwayTier,
    rev, prior, growth, gm, rd, grant, post, impliedPS, band, bandLabel, deviation, isMismatch,
    declaredBand, declaredDeviation,
    probNext, impliedSuccessValue,
    grade, verdict, capReasons, gaps, warnings,
    paramsMeta: P.__meta || null,
  };
}

// ============================================================
// 渲染
// ============================================================

function render(r, P = DEFAULTS) {
  const L = [];
  const p = (s = "") => L.push(s);
  // 节号按槽位取, 不由发射顺序自增: 条件节缺失时编号不许前移(见 lib/sections.mjs)
  const sec = (key) => heading(I18N, key);

  const bar = "=".repeat(56);
  p(bar);
  p(r.paramsMeta ? `BCI INVESTMENT DD SCORECARD  v${VERSION}  |  params: ${r.paramsMeta.id}@${r.paramsMeta.hash8}` : `BCI INVESTMENT DD SCORECARD  v${VERSION}`);
  p(bar);
  p("");

  // ---- 输入概要
  const dimCount = r.rows.filter((x) => x.score > 0 || x.open.length).length;
  p(heading(I18N, "inputBrief"));
  p(
    t("s.inputBrief.line1", "- 主体: {name} | 阶段: {stage} | 成立: {founded} | 人数: {headcount}", {
      name: r.company.name || t("ui.unnamed", "未命名主体"),
      stage: r.stage,
      founded: r.company.founded_year || "-",
      headcount: r.company.headcount || "-",
    })
  );
  p(
    t("s.inputBrief.line2", "- 申报资产类别: {cls}{downgrade} | 技术路线: {modality}", {
      cls: r.declaredClass,
      downgrade: r.downgraded ? t("s.inputBrief.downgraded", " → 降级为 monitoring_only") : "",
      modality: r.asset.modality || "-",
    })
  );
  p(
    t("s.inputBrief.line3", "- 数据截止: {asOf} | 币种: {cur} | 分析: {analyst}", {
      asOf: r.meta.as_of || new Date().toISOString().slice(0, 10),
      // 打的是**实际生效**的币种, 不是 meta 里那个字符串:
      // meta 没写时要按辖区取默认值, 否则会出现「币种: CNY」而金额印成 $1M
      cur: CURRENCY,
      analyst: r.meta.analyst || "-",
    })
  );
  p(
    t("s.inputBrief.line4", "- 维度完成度: {done}/9 | 里程碑状态已填: {filled}/7 | 红旗登记 {rf} 条", {
      done: dimCount,
      filled: r.items.length,
      rf: r.rfTouched,
    })
  );
  p("");

  // ---- 参数口径与溯源
  // 刻意用 H3 且不调 sec(): 13 个编号 H2 与 assets/templates/report-template.md
  // 逐字互锁, 新增编号 H2 会让「一、」变「二、」并打断 CI 断言。
  if (r.paramsMeta) {
    const m = r.paramsMeta;
    p(sec("params"));
    p(
      t("s.params.line1", "- 参数集: {id} | 基线: 内置默认 v{ver} | 校验: {checks}", {
        id: m.id,
        ver: VERSION,
        checks: m.checks,
      })
    );
    p(
      t("s.params.line2", "- 覆盖范围: {scope} | 其余沿用默认", {
        scope: describeOverrides(m.overrides) || t("ui.none", "无"),
      })
    );
    p(
      t("s.params.line3", "- 参数来源: {src} | 未溯源项: {untraced} | 代理样本项: {proxy}", {
        src: m.sourceRefs.length ? m.sourceRefs.join(", ") : t("ui.undeclared", "未声明"),
        untraced: m.untraced ? m.overrides.length : 0,
        proxy: m.proxyCount,
      })
    );
    p(
      t("s.params.line4", "- 生效日: {from} | 失效日: {to} | 状态: {status}", {
        from: m.effectiveFrom || "-",
        to: m.expiresOn || "-",
        status: m.stale ? "STALE" : t("ui.active", "生效中"),
      })
    );
    p(t("s.params.note", "> 本节说明本次计算所用的方法学参数来源与版本。参数为方法学假设, 不构成对任何标的的估值结论。"));
    p("");
  }

  // ---- 一、资产属性门禁
  p(sec("gate"));
  p(t("s.gate.note", "> 核心问题: 这是哪一类资产, 该用哪一把尺子量? 口径错则全篇错。"));
  p("");
  p(t("s.gate.th", "| 项 | 判定 |"));
  p("|---|---|");
  p(t("s.gate.r1", "| 申报类别 | {v} |", { v: r.declaredClass }));
  p(t("s.gate.r2", "| 实际口径族 | **{v}** |", { v: t(`family.${r.familyKey}.label`, r.family.label) }));
  p(t("s.gate.r3", "| 监管预期编码 | {v} |", {
    // 12-00 等编码是 NMPA 2026 年 24 号通告的口径; 非 cn 辖区下把它印出来
    // 会让人误以为 FDA/CE 审评也按这个编码走 —— 编码随辖区, 不是随资产。
    v:
      JURISDICTION === "cn"
        ? t(`family.${r.familyKey}.code`, r.family.code)
        : t("s.gate.codeNA", "不适用(本辖区不按 NMPA 编码分类)"),
  }));
  p(t("s.gate.r4", "| 允许期权法 | {v} |", { v: r.family.allow_option ? t("ui.yes", "是") : t("ui.noStrong", "**否**") }));
  p(t("s.gate.r5", "| 适用估值族 | {v} |", { v: t(`family.${r.familyKey}.approach`, r.family.approach) }));
  p(
    t("s.gate.r6", "| 闭环真实性 | {v} |", {
      v:
        r.asset.closed_loop === true
          ? t("s.gate.closed.yes", "已确认闭环")
          : r.asset.closed_loop === false
            ? t("s.gate.closed.no", "**未闭合, 按单向监测降级**")
            : t("s.gate.closed.unknown", "未确认"),
    })
  );
  if (r.downgraded) {
    p("");
    p(
      t(
        "s.gate.downgrade",
        `> 降级依据: 分类界定要求同时具备四项核心特征, 其中「实时双向交互或闭环反馈」不满足时, 产品按现行分类目录执行, 不再适用脑机接口医疗器械编码, 亦不再适用平台期权叙事。`
      )
    );
  }
  p("");

  // ---- 二、里程碑定位
  p(sec("milestones"));
  p(t("s.ms.path", "> 该类资产主干路径: {path}", { path: r.path.join(" → ") }));
  p("");
  p(t("s.ms.th", "| 级别 | 名称 | 状态 | 达成日 | 证据完整度 | 证据引用 |"));
  p("|---|---|---|---|---|---|");
  for (const id of MILESTONES.map((m) => m.id)) {
    const meta = MILESTONES.find((m) => m.id === id);
    const it = r.byId.get(id) || { status: t("ui.status.blank", "未填"), provided: [] };
    const onPath = r.path.includes(id);
    const prov = new Set(it.provided || []);
    const full = meta.evidence.filter((e) => prov.has(e.key)).length;
    const st = !onPath ? t("ui.status.na", "不适用") : it.status;
    p(
      t("s.ms.row", "| {id} | {name} | {st} | {date} | {cov} | {ref} |", {
        id,
        name: t(`milestone.${id}.name`, meta.name),
        st,
        date: it.date || "-",
        cov: onPath ? `${full}/${meta.evidence.length}` : "-",
        ref: it.evidence_ref || "-",
      })
    );
  }
  p("");
  p(`- ${t("s.ms.current", "当前级: ")}**${r.currentId || t("ui.notStarted", "尚未启动")}**${r.nextId ? ` | ${t("s.ms.next", "下一级: ")}**${r.nextId} ${t(`milestone.${r.nextId}.name`, r.nextMeta.name)}**` : ` | ${t("s.ms.allDone", "已完成主干路径全部节点")}`}`);
  if (r.nextMeta) {
    p(
      t("s.ms.duration", "- 下一级典型耗时: {lo} 至 {hi} 个月(中值 {mid} 个月, 已含缓冲系数)", {
        lo: num(r.needLo, 1),
        hi: num(r.needHi, 1),
        mid: num(r.needMid, 1),
      })
    );
    p(
      t("s.ms.gap", "- 下一级缺口证据: {list}", {
        list: r.missingEvidence.length
          ? r.missingEvidence.map((e) => t(`milestone.${r.nextId}.evidence.${e.key}`, e.label)).join(sep())
          : t("ui.noneEvidence", "无, 证据齐备"),
      })
    );
  }
  p("");

  // ---- 三、九维加权评分
  p(sec("scoring"));
  p(
    t(
      "s.score.note",
      "> 有效分 = 原分 × 置信折价(high {high} / medium {mid} / low {low}); 权重已按阶段因子与门禁因子修正并归一化, 单维上限 {cap}。",
      {
        high: P.CONF_DISCOUNT.high.toFixed(2),
        mid: P.CONF_DISCOUNT.medium.toFixed(2),
        low: P.CONF_DISCOUNT.low.toFixed(2),
        cap: P.W_CAP,
      }
    )
  );
  p("");
  p(t("s.score.th", "| 维度 | 名称 | 原分 | 置信 | 折价后 | 有效权重 | 加权贡献 | 未完成检查项 |"));
  p("|---|---|---|---|---|---|---|---|");
  for (const row of r.rows) {
    p(
      t("s.score.row", "| {id} | {name} | {score} | {conf} | {eff} | {w}% | {contrib} | {open} |", {
        id: row.id,
        name: t(`dim.${row.id}.name`, DIM_NAMES[row.id]),
        score: num(row.score, 0),
        conf: row.conf,
        eff: num(row.eff, 1),
        w: num(row.weight * 100, 1),
        contrib: num(row.contrib, 1),
        open: row.open.length ? row.open.join(sep()) : "-",
      })
    );
  }
  p(
    t("s.score.total", "| **合计** | | | | | **{w}%** | **{total}** | |", {
      w: num(r.rows.reduce((a, x) => a + x.weight, 0) * 100, 1),
      total: num(r.total, 1),
    })
  );
  p("");
  const topW = [...r.rows].sort((a, b) => b.weight - a.weight).slice(0, 3);
  p(
    t(
      "s.score.topw",
      "- 权重最高的三维: {list}。阶段因子解释了同一维度在不同轮次的信息价值差异; 门禁因子解释了资产定性对口径的修正。",
      {
        list: topW
          .map((x) => `${x.id} ${t(`dim.${x.id}.name`, DIM_NAMES[x.id])}(${num(x.weight * 100, 1)}%)`)
          .join(sep()),
      }
    )
  );
  p("");

  // ---- 四、致命红旗筛查
  p(sec("redflags"));
  p(t("s.rf.th", "| 编号 | 维度 | 现象 | 等级 | 状态 | 核查动作 |"));
  p("|---|---|---|---|---|---|");
  const touched = RF_LIBRARY.filter((x) => r.statusOf(x.id) !== "not_listed");
  if (!touched.length) {
    p(t("s.rf.empty", "| - | - | 未登记任何红旗 | - | - | - |"));
  } else {
    for (const x of touched) {
      const st = r.statusOf(x.id);
      const mark =
        x.severity === "veto"
          ? t("ui.sev.veto", "🔴 一票否决")
          : x.severity === "fatal"
            ? t("ui.sev.fatal", "🔴 致命")
            : t("ui.sev.warn", "🟡 警惕");
      p(
        t("s.rf.row", "| {id} | {dim} | {name} | {mark} | {st} | {action} |", {
          id: x.id,
          dim: x.dim,
          name: t(`rf.${x.id}.name`, x.name),
          mark,
          st,
          action: t(`rf.${x.id}.action`, x.action),
        })
      );
    }
  }
  p("");
  const idsOf = (arr) => (arr.length ? `(${arr.map((x) => x.id).join(sep())})` : "");
  p(t("s.rf.vetoOpen", "- 一票否决项未闭合: {n} 条{suffix}", { n: r.vetoOpen.length, suffix: idsOf(r.vetoOpen) }));
  p(t("s.rf.vetoUnknown", "- 一票否决项状态不明: {n} 条{suffix}", { n: r.vetoUnknown.length, suffix: idsOf(r.vetoUnknown) }));
  p(t("s.rf.fatalOpen", "- 致命项未闭合: {n} 条{suffix}", { n: r.fatalOpen.length, suffix: idsOf(r.fatalOpen) }));
  p("");

  // 影响路径: 把定性红旗接到估值模型上。用 H3 不新增编号 H2, 避免打断与报告模板互锁的节号。
  if (touched.length) {
    p(t("s.rf.impact.h3", "### 影响路径(红旗折在哪)"));
    p(
      t(
        "s.rf.impact.note",
        "> 等级回答「多严重」, 路径回答「扣在哪」。两者正交: 一条一票否决也可能落在「折条款」而资产本身没问题; 一条警惕级的 IP 瑕疵若核心专利不在公司名下则归零。"
      )
    );
    p("");
    p(t("s.rf.impact.th", "| 影响路径 | 扣什么 | 条数 | 编号 |"));
    p("|---|---|---|---|");
    for (const k of Object.keys(RF_IMPACTS).sort((a, b) => RF_IMPACTS[a].order - RF_IMPACTS[b].order)) {
      const list = touched.filter((x) => x.impact === k);
      if (!list.length) continue;
      p(
        t("s.rf.impact.row", "| {label} | {fold} | {n} | {ids} |", {
          label: t(`impact.${k}.label`, RF_IMPACTS[k].label),
          fold: t(`impact.${k}.fold`, RF_IMPACTS[k].fold),
          n: list.length,
          ids: list.map((x) => x.id).join(sep()),
        })
      );
    }
    p("");
    const gates = touched.filter((x) => x.impact === "gate");
    if (gates.length) {
      p(t("s.rf.impact.gates", "- **归零类 {n} 条**: 一旦成立, 估值结论作废而不是打折, 后续倍数与概率的讨论一并失去意义。", { n: gates.length }));
    }
    p(
      t(
        "s.rf.impact.dist",
        "- 路径分布不等于严重度: 5 条「折倍数」累积起来是压价, 1 条「归零」是停止。两者不能相加, 也不该放在同一张表里比大小。"
      )
    );
    p("");
  }

  // ---- 五、现金跑道(条件节)
  if (r.runway !== null) {
    p(sec("runway"));
    p(t("s.runway.th", "| 现金及等价物 | 未使用授信 | 可动用流动性 | 月均净流出 | 跑道(月) | 下一里程碑需时(月) | 比值 | 档位 |"));
    p("|---|---|---|---|---|---|---|---|");
    p(
      t("s.runway.row", "| {cash} | {credit} | {liq} | {burn} | **{runway}** | {need} | {ratio} | {tier} |", {
        cash: money(r.cash),
        credit: money(r.credit),
        liq: money(r.liquidity),
        burn: money(r.burn),
        runway: num(r.runway, 1),
        need: r.needMid ? num(r.needMid, 1) : "-",
        ratio: r.ratio !== null ? num(r.ratio, 2) : "-",
        tier: r.runwayTier ? `**${t(`runway.${r.runwayTier.idx}.label`, r.runwayTier.label)}**` : "-",
      })
    );
    p("");
    if (r.runwayTier) p(t("s.runway.verdict", "- 判定: {desc}", { desc: t(`runway.${r.runwayTier.idx}.desc`, r.runwayTier.desc) }));
    if (r.growth !== null)
      p(
        t("s.runway.growth", "- 收入同比: {sign}{pct}%(上年 {prior} → 本年 {rev})", {
          sign: r.growth >= 0 ? "+" : "",
          pct: num(r.growth * 100, 1),
          prior: money(r.prior),
          rev: money(r.rev),
        })
      );
    p("");
  } else {
    // 缺财务数据时不再整节消失: 消失会让后面所有节号前移, 与模板错位且不报错
    for (const line of secNA(I18N, "runway", t("s.runway.na", "缺 financials.cash 或 burn_monthly, 无法计算跑道"))) p(line);
    p("");
  }

  // ---- 六、估值口径(条件节)
  if (r.impliedPS !== null || r.post !== null) {
    p(sec("valuation"));
    p(t("s.val.note", "> 本段为口径校验, 不构成估值结论。倍数区间为结构示意, 需按基金口径与可比交易自行校准。"));
    p("");
    // 辖区档的 status=pending 意味着「边界没核实」。此时正确的输出是拒答, 不是
    // 拿别处的倍数顶上: 没有可比样本的倍数会被读者当成结论引用。
    const rmPending = PROFILE_PENDING.some((x) => x.path === "$.rev_mult");
    if (rmPending) {
      p(
        t(
          "s.val.pendingRefuse",
          "> 拒答: 本辖区({jd})的收入倍数档边界未核实(辖区档 status=pending), 因此不输出档区间、隐含倍数判读与偏离提示。原因: 没有可比样本的倍数是编造; 缺口已列入第七章。",
          { jd: JURISDICTION }
        )
      );
      p("");
    } else {
    p(t("s.val.th", "| 项 | 数值 |"));
    p("|---|---|");
    p(t("s.val.post", "| 最近一轮投后估值 | {v} |", { v: money(r.post) }));
    p(t("s.val.rev", "| 最近 12 个月收入 | {v} |", { v: money(r.rev) }));
    p(
      t("s.val.ps", "| 隐含 P/S | {v} |", {
        v: r.impliedPS !== null ? t("s.val.times", "{v} 倍", { v: num(r.impliedPS, 1) }) : t("s.val.psNA", "不适用(零收入或无收入数据)"),
      })
    );
    p(
      t("s.val.band", "| 所在档区间 | {v} |", {
        v: r.band
          ? t("s.val.bandRange", "{label} 档 [{lo}, {hi}]", { label: r.bandLabel, lo: r.band[0], hi: r.band[1] })
          : "-",
      })
    );
    p(t("s.val.dev", "| 相对区间上沿 | {v} |", { v: r.deviation !== null ? t("s.val.times", "{v} 倍", { v: num(r.deviation, 2) }) : "-" }));
    p(t("s.val.option", "| 期权法适用性 | {v} |", { v: r.family.allow_option ? t("ui.applicable", "适用") : t("ui.notApplicable", "**不适用**") }));
    p("");
    if (r.isMismatch) {
      p(
        t(
          "s.val.mismatch1",
          "- **口径错配**: 按当前判定口径「{family}」衡量, 隐含 P/S {ps} 已达区间上沿({cap})的 {dev} 倍, 而该类别不能由技术叙事支撑倍数, 只能由收入与利润解释。",
          {
            family: t(`family.${r.familyKey}.label`, r.family.label),
            ps: num(r.impliedPS, 1),
            cap: r.band ? r.band[1] : "-",
            dev: num(r.deviation, 1),
          }
        )
      );
      if (r.declaredDeviation !== null && r.declaredClass !== r.familyKey) {
        p(
          t(
            "s.val.mismatch2",
            "- 对照申报口径「{cls}」的区间上沿 {cap}, 隐含倍数为 {dev} 倍; 该溢价需由明确的临床里程碑跳升来解释, 且必须先解决闭环与分类判定问题。",
            {
              cls: r.declaredClass,
              cap: r.declaredBand ? r.declaredBand[1] : "-",
              dev: num(r.declaredDeviation, 2),
            }
          )
        );
      }
    } else if (r.deviation !== null && r.deviation > P.DEVIATION_FLAG && r.family.allow_option) {
      p(t("s.val.premium", "- 溢价部分需由里程碑跳升解释: 当前隐含倍数为区间上沿的 {dev} 倍。", { dev: num(r.deviation, 1) }));
      if (r.probNext && r.impliedSuccessValue !== null) {
        p(
          t(
            "s.val.impliedSuccess",
            "- 若下一里程碑({ms})达成概率按占位值 {prob} 折算, 当前定价对应的隐含成功后价值为 {v}, 请核该值是否落在同档可比区间。",
            { ms: r.nextId, prob: num(r.probNext, 2), v: money(r.impliedSuccessValue) }
          )
        );
      }
    } else if (r.deviation !== null) {
      p(
        t("s.val.inBand", "- 隐含倍数 {ps} 落在或低于所在档区间上沿, 未触发口径偏离提示。", {
          ps: num(r.impliedPS, 1),
        })
      );
    }
    p("");

    // 情景与敏感性: 单点估值不可信。用 H3 不新增编号 H2, 避免打断与报告模板互锁的节号。
    if (r.family.allow_option && r.impliedSuccessValue !== null && r.probNext) {
      const base = r.probNext;
      const RATES = P.sensitivity_rates;
      p(t("s.val.sens.h3", "### 情景与敏感性"));
      p(
        t(
          "s.val.sens.note",
          "> 下面两张表只回答「什么变了、它变多少」, 数值全部由脚本算出, 不含人工调整。**脚本给摆动幅度, 不给可比区间** —— 隐含成功后价值是否合理, 须拿同档可比交易来核, 这一步不由脚本出结论。"
        )
      );
      p("");
      p(
        t(
          "s.val.sens.prob",
          "**一、成功率摆动。** 基准假设下一里程碑({ms})达成率 {base}, 投后 {post}。成功率每降 10 个百分点, 隐含成功后价值抬高的倍数 = 基准率 / (基准率 − 0.10), 也就是说定价没变, 只是把未来的成功想得更值钱。",
          { ms: r.nextId || "-", base: num(base, 2), post: money(r.post) }
        )
      );
      p("");
      p(t("s.val.sens.probTh", "| 成功率假设 | 隐含成功后价值 | 相对基准 |"));
      p("|---|---|---|");
      for (const d of [-0.1, 0, 0.1]) {
        const pv = Math.min(0.99, Math.max(0.01, base + d));
        const v = r.post / pv;
        const tag = d === 0 ? t("s.val.sens.base", " (基准)") : ` (${d > 0 ? "+" : ""}${(d * 100).toFixed(0)}pp)`;
        p(t("s.val.sens.probRow", "| {pv}{tag} | {v} | {mult} |", { pv: num(pv, 2), tag, v: money(v), mult: t("s.val.times", "{v} 倍", { v: num(v / r.impliedSuccessValue, 2) }) }));
      }
      p("");
      p(t("s.val.sens.delay", "**二、延迟折损。** 里程碑滑期不只是晚一点: 概率要再乘一次折扣, 折现期同时延长。下表给「同等投后下, 成功后价值须上浮的倍数」。"));
      p("");
      p(`| ${t("s.val.sens.delayTh", "延迟(月)")} | ${RATES.map((x) => t("s.val.sens.rateTh", "折现率 {r}%", { r: (x * 100).toFixed(0) })).join(" | ")} |`);
      p(`|---|${RATES.map(() => "---").join("|")}|`);
      for (const n of [0, 12, 24]) {
        p(`| ${n} | ${RATES.map((x) => (n === 0 ? t("s.val.sens.unit", "1.00 倍") : t("s.val.times", "{v} 倍", { v: num(Math.pow(1 + x, n / 12), 2) }))).join(" | ")} |`);
      }
      p("");
      p(
        t(
          "s.val.sens.anchor",
          "- **延迟 24 个月、折现率 12% 时, 同等投后意味着成功后价值须再高 {v} 倍**; 而这 24 个月里通常还要再融一轮, 稀释与折现在同一段时间里发生, 两者不相抵。这是植入式器械排期最容易被低估的一项, 也是本框架把注册路径放在 D4(权重 0.16, 九维最高)而不是商务维的原因。",
          { v: num(Math.pow(1.12, 2), 2) }
        )
      );
      p("");
    }
    }

    if (r.exit.planned_path) {
      p(
        t("s.val.exit", "- 计划退出路径: {path}{year}", {
          path: t(`exit.${r.exit.planned_path}.label`, EXIT_PATHS[r.exit.planned_path] || r.exit.planned_path),
          year: r.exit.target_year ? t("s.val.exitYear", ", 目标年份 {y}", { y: r.exit.target_year }) : "",
        })
      );
      const ch = exitChannel(r.exit.planned_path);
      if (ch && ch.applicable === false) {
        p(t("s.val.exitNA", "- **该路径在本辖区({jd})不适用**: {why}", { jd: JURISDICTION, why: ch.source_ref }));
      }
    }
    if (r.exit.planned_path === "ipo_star_5" && r.exit.core_product_phase2_approved === false) {
      p(t("s.val.exitGate", "- **退出硬门槛未满足**: 科创板第五套标准要求预计市值不低于 40 亿元, 且医药行业企业需至少有一项核心产品获准开展二期临床试验; 当前标记为未取得该项批准。"));
    }
    p("");
  } else {
    for (const line of secNA(I18N, "valuation", t("s.val.na", "缺 valuation.post_money 与 financials.revenue_ttm, 无法校验口径"))) p(line);
    p("");
  }

  // ---- 七、结论与证据缺口
  p(sec("conclusion"));
  p(t("s.concl.head", "### 结论: **{v}**", { v: t(`verdict.${r.verdict.key}.label`, r.verdict.label) }));
  p("");
  p(`> ${t(`verdict.${r.verdict.key}.desc`, r.verdict.desc)}`);
  p("");
  p(
    t("s.concl.score", "- 有效加权分 **{total}**(满分 100), 对应分级阈值 {cond} / {pass} / {pref}。", {
      total: num(r.total, 1),
      cond: P.VERDICT_THRESHOLDS.conditional,
      pass: P.VERDICT_THRESHOLDS.pass,
      pref: P.VERDICT_THRESHOLDS.preferred,
    })
  );
  p(
    t("s.concl.milestone", "- 里程碑当前为 **{cur}**{next}{runway}。", {
      cur: r.currentId || t("ui.notStarted", "尚未启动"),
      next: r.nextId ? t("s.concl.milestoneNext", ", 下一级 {id} 需时约 {m} 个月", { id: r.nextId, m: num(r.needMid, 1) }) : "",
      runway:
        r.runway !== null
          ? t("s.concl.milestoneRunway", "; 跑道 {m} 个月, 档位「{tier}」", {
              m: num(r.runway, 1),
              tier: r.runwayTier ? t(`runway.${r.runwayTier.idx}.label`, r.runwayTier.label) : "-",
            })
          : "",
    })
  );
  p(
    t("s.concl.flags", "- 未闭合致命项 {severe} 条, 状态不明 {unknown} 条; 警惕项未闭合 {warn} 条。", {
      severe: r.vetoOpen.length + r.fatalOpen.length,
      unknown: r.vetoUnknown.length,
      warn: r.warnOpen.length,
    })
  );
  if (r.capReasons.length) {
    p("");
    p(t("s.concl.capHead", "**分级修正说明**"));
    for (const c of r.capReasons) p(`- ${c}`);
  }
  p("");
  p(t("s.concl.gapsHead", "### 证据缺口"));
  if (!r.gaps.length) {
    p(t("s.concl.noGaps", "无未闭合缺口。结论仍受输入证据完备度与样本范围约束。"));
  } else {
    p(t("s.concl.gapTh", "| 缺口 | 类型 | 定位 | 责任方 | 建议期限 |"));
    p("|---|---|---|---|---|");
    const seen = new Set();
    for (const g of r.gaps) {
      const k = g.item + g.type;
      if (seen.has(k)) continue;
      seen.add(k);
      p(t("s.concl.gapRow", "| {item} | {type} | {where} | {owner} | {due} |", g));
    }
  }
  p("");

  // ---- 警告(恒为末节)
  p(heading(I18N, "warnings"));
  const uniq = [...new Set(r.warnings)];
  if (uniq.length) {
    for (const x of uniq) p(`- ⚠ ${x}`);
  } else {
    p(t("s.warn.none", "- 未发现需要提示的异常; 上述结论仍受输入证据完备度约束。"));
  }
  p("");

  return L.join("\n");
}

// ============================================================
// main
// ============================================================

const argv = process.argv.slice(2);
const KNOWN_FLAGS = ["--example", "--print-defaults", "--normalize-weights", "--json", "--dump-catalog"];

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
  console.error(`未知参数 ${unknown}; 可用: ${KNOWN_FLAGS.join(" ")} --config <file> --profiles <dir>`);
  process.exit(2);
}
// 档目录可换。存在的理由是测试: 「档里 status=pending 时结论行必须变拒答行」这类
// 缺陷出在渲染层, 校验器本身完全正确 —— 不给一个能喂坏档的入口, 这条路径就只能靠人工试。
// 目录不存在时立刻中止: 静默回落到内置目录会让测试以为自己验证了坏档。
if (cliProfileDir) {
  PROFILE_DIR = path.resolve(cliProfileDir);
  if (!existsSync(PROFILE_DIR)) {
    console.error(`--profiles 目录不存在: ${PROFILE_DIR}`);
    process.exit(2);
  }
}
const wantExample = rest.includes("--example");
const wantPrint = rest.includes("--print-defaults");
const normalizeWeights = rest.includes("--normalize-weights");
const wantJson = rest.includes("--json");
const positional = rest.filter((a) => !a.startsWith("--"));

/**
 * 输出出口。--json 时输出机器可读对象, 否则输出终端报告。
 *
 * 为什么要有 JSON: 终端报告是给人扫的, 但下游(版式转换、多标的对比、
 * 跨期跟踪、投委会幻灯片)都需要同一份结构化结果。让下游去解析终端
 * 文本等于把渲染细节变成接口, 任何一次排版调整都会打断下游。
 * JSON 是稳定契约, 排版是自由变量。
 */
const OUTPUT_SCHEMA = "dd-score-output/1";

/**
 * JSON 里补两类「已加工好」的字段, 下游不必再自己拼:
 *   rows[].dimLabel      维度名的当前语言文案
 *   *_display            金额按「本辖区币种 + 当前 locale 量级词」格式化后的字符串
 *
 * 为什么要给: 下游(版式转换、多标的对比、幻灯片)若自己拼, 就得复制一份词表
 * 与一套金额规则 —— 那份副本一定先漂移, 而且漂移时不报错, 只是英文报告里
 * 出现「12.5 亿」这种半截中文。契约里带成品, 副本就没有存在理由。
 * 金额同时保留原始数值: 下游做算术要用数字, 展示才用 _display。
 */
const DISPLAY_FIELDS = ["cash", "credit", "liquidity", "burn", "rev", "prior", "post", "impliedPS", "impliedSuccessValue"];

/**
 * 发射边界统一翻译: 常量表里的文案在 `render()` 里是「使用点翻译」的,
 * 但 `--json` 走另一条出口, 那里没人翻 —— 于是 `verdict.label` 这类会原样
 * 带着中文进入 JSON。
 *
 * 这比「少翻一句」严重得多: 下游拿到 JSON 只会当数据打印, 而它的
 * 「把输入/评分 JSON 里的字符串当数据豁免」逻辑会顺带放过这些文案。
 * 结果就是英文报告里印着「有条件通过」而零中文断言全绿 —— 一个不被
 * 任何测试覆盖的失败形态。
 *
 * 只翻「表里的文案」, 不碰输入里的数据(公司名、分析师、维度备注、适应症原文):
 * 那些是分析对象本身, 翻掉就等于改写证据。
 */
function withLocalizedText(r) {
  // 中文是源语言: 常量表里的字符串本来就是中文, 原样返回, 零风险
  if (LOCALE === DEFAULT_LOCALE) return r;
  const evLabel = (msId, e) => t(`milestone.${msId}.evidence.${e.key}`, e.label);
  // 红旗是同一批文案(id → rf.<id>.name/action), 四个数组共用一条映射:
  // 漏翻一组不会报错, 只会让某份输入的英文报告里出现小半句中文。
  const rf = (x) => ({ ...x, name: t(`rf.${x.id}.name`, x.name), action: t(`rf.${x.id}.action`, x.action) });
  return {
    ...r,
    verdict: r.verdict
      ? {
          ...r.verdict,
          label: t(`verdict.${r.verdict.key}.label`, r.verdict.label),
          desc: t(`verdict.${r.verdict.key}.desc`, r.verdict.desc),
        }
      : r.verdict,
    family: r.family
      ? {
          ...r.family,
          label: t(`family.${r.familyKey}.label`, r.family.label),
          code: t(`family.${r.familyKey}.code`, r.family.code),
          approach: t(`family.${r.familyKey}.approach`, r.family.approach),
        }
      : r.family,
    runwayTier: r.runwayTier
      ? {
          ...r.runwayTier,
          label: t(`runway.${r.runwayTier.idx}.label`, r.runwayTier.label),
          desc: t(`runway.${r.runwayTier.idx}.desc`, r.runwayTier.desc),
        }
      : r.runwayTier,
    nextMeta: r.nextMeta
      ? {
          ...r.nextMeta,
          name: t(`milestone.${r.nextId}.name`, r.nextMeta.name),
          evidence: (r.nextMeta.evidence || []).map((e) => ({ ...e, label: evLabel(r.nextId, e) })),
        }
      : r.nextMeta,
    missingEvidence: (r.missingEvidence || []).map((e) => ({ ...e, label: evLabel(r.nextId, e) })),
    vetoOpen: (r.vetoOpen || []).map(rf),
    vetoUnknown: (r.vetoUnknown || []).map(rf),
    fatalOpen: (r.fatalOpen || []).map(rf),
    warnOpen: (r.warnOpen || []).map(rf),
  };
}

function withDisplay(r) {
  const out = { ...r };
  out.rows = r.rows.map((row) => ({ ...row, dimLabel: t(`dim.${row.id}.name`, DIM_NAMES[row.id]) }));
  for (const k of DISPLAY_FIELDS) {
    if (typeof r[k] === "number" && isFinite(r[k])) out[`${k}_display`] = money(r[k]);
  }
  if (r.val && typeof r.val === "object") {
    out.val = { ...r.val };
    for (const k of ["post_money", "round_size"]) {
      if (typeof r.val[k] === "number" && isFinite(r.val[k])) out.val[`${k}_display`] = money(r.val[k]);
    }
  }
  return out;
}

const emit = (r) => {
  if (!wantJson) {
    process.stdout.write(render(r, P));
    return;
  }
  // locale / jurisdiction / currency 是契约的一部分: 不写进 JSON,
  // 下游就无法判断这份数字是用哪套口径、哪种语言算出来的
  process.stdout.write(
    JSON.stringify(
      { schema: OUTPUT_SCHEMA, script_version: VERSION, locale: LOCALE, jurisdiction: JURISDICTION, currency: CURRENCY, ...withDisplay(withLocalizedText(r)) },
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
  applyContext({});
  process.stdout.write(JSON.stringify(defaultsAsConfig(), null, 2) + "\n");
  process.exit(0);
}
if (wantExample && configPath) {
  console.error("--example 与 --config 互斥: 内置示例是三份 CI 回归基线之一, 不接受口径覆盖");
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
  const v = validateConfig(cfg, { normalizeWeights });
  if (v.errors.length) {
    console.error("参数集校验未通过, 已中止(参数错了, 算出来的每个数都是错的):");
    for (const x of v.errors) console.error(`  - ${x}`);
    process.exit(2);
  }
  hash8 = createHash("sha256").update(raw).digest("hex").slice(0, 8);
}
const P = resolveParams(cfg, { normalizeWeights, hash8 });

/**
 * 档与代码的一致性检查。
 *
 * 档说「本辖区用这些档位边界」, 代码说「怎么按边界挑桶」。两边都存的时候,
 * 只比对、不覆盖 —— 覆盖会让 --config 与辖区档争同一件事, 而争的结果取决于
 * 加载顺序, 没人能预测。cn 档的边界必须与内置 REV_MULT 完全相同, 否则
 * 报告会按 A 边界挑桶、按 B 边界印标签。
 */
function assertProfileConsistency(profile) {
  const rm = profile.rev_mult || {};
  if (rm.status === "pending") return;
  const codeEdges = [...new Set(Object.values(REV_MULT).map((buckets) => buckets.map((b) => b[0]).join(",")))];
  const profEdges = (rm.edges || []).join(",");
  if (!codeEdges.includes(profEdges)) {
    throw new ProfileError(
      "P-02",
      "$.rev_mult.edges",
      `档声明 ${profEdges}, 与内置 REV_MULT 的档位边界(${codeEdges.join(" / ")})不一致: 挑桶与印标签会用两套边界`
    );
  }
}

/**
 * 解析并落地运行期上下文。冲突不静默: 采用哪一层、忽略了哪一层, 一律报出来。
 * 语言与辖区是两个独立维度, 允许交叉(英文看中国标的 / 中文看美国标的)。
 */
function applyContext(meta = {}, { forceLocale = null, forScoring = true } = {}) {
  let ctx;
  try {
    ctx = resolveContext({
      cliLocale: forceLocale || cliLocale,
      cliJurisdiction,
      meta,
    });
    setContext({ locale: ctx.locale, jurisdiction: ctx.jurisdiction });
  } catch (e) {
    // locale / 辖区属于参数, 非法即中止(exit 2): 语言错了, 整份报告的措辞都不可用
    console.error(`上下文非法: ${e.message}`);
    process.exit(2);
  }
  // ---- 辖区档: 档错了, 报告里每个数字都错, 所以校验不过就直接中止
  try {
    const { profile, pending } = loadProfile(PROFILE_DIR, JURISDICTION);
    assertProfileConsistency(profile);
    PROFILE = profile;
    PROFILE_PENDING = pending;
    // 币种优先级: 输入声明 > 辖区档。档是「本辖区的默认计价」, 输入声明的是
    // 「这份数据实际用什么记的」, 后者更具体。两者都不给才兜底 CNY。
    CURRENCY = meta.currency ? String(meta.currency).toUpperCase() : profile.currency;
    // P-06: 只做准入对照的档不产出评分。悄悄用别处的阈值算出一个数是更坏的结果。
    if (profile.admission_only && forScoring) {
      console.error(
        `辖区 ${JURISDICTION} 只做准入对照(admission_only), 不产出评分。` +
          `做评分请用 --jurisdiction cn 或 us; 看欧盟准入请读 content/regulatory/01-crosswalk.md。`
      );
      process.exit(2);
    }
  } catch (e) {
    if (e instanceof ProfileError) {
      console.error(`辖区档校验未通过: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  for (const c of ctx.conflicts) {
    console.error(`上下文冲突(${c.field}): 采用 ${c.used}(来自 ${c.source}), 忽略 ${c.overridden}`);
  }
  return ctx;
}

// ---- 导出中文词表镜像: 中文是源码内联字面量, 这份 json 是生成物, 供审阅与 key 比对
if (rest.includes("--dump-catalog")) {
  applyContext(EXAMPLE_OBJ.meta, { forceLocale: DEFAULT_LOCALE });
  // 先结构遍历常量, 保证覆盖率与「跑到了哪条分支」无关
  for (const [fk, fam] of Object.entries(ASSET_FAMILIES)) {
    t(`family.${fk}.label`, fam.label);
    t(`family.${fk}.code`, fam.code);
    t(`family.${fk}.approach`, fam.approach);
  }
  for (const m of MILESTONES) {
    t(`milestone.${m.id}.name`, m.name);
    for (const e of m.evidence) t(`milestone.${m.id}.evidence.${e.key}`, e.label);
  }
  for (const x of RF_LIBRARY) {
    t(`rf.${x.id}.name`, x.name);
    t(`rf.${x.id}.action`, x.action);
  }
  for (const v of VERDICTS) {
    t(`verdict.${v.key}.label`, v.label);
    t(`verdict.${v.key}.desc`, v.desc);
  }
  for (const k of Object.keys(DIM_NAMES)) t(`dim.${k}.name`, DIM_NAMES[k]);
  for (const k of Object.keys(RF_IMPACTS)) {
    t(`impact.${k}.label`, RF_IMPACTS[k].label);
    t(`impact.${k}.fold`, RF_IMPACTS[k].fold);
  }
  P.RUNWAY_RULES.forEach((rule, i) => {
    t(`runway.${i}.label`, rule[1]);
    t(`runway.${i}.desc`, rule[2]);
  });
  for (const k of Object.keys(EXIT_PATHS)) t(`exit.${k}.label`, EXIT_PATHS[k]);
  for (const sec of SECTION_REGISTRY) t(`sections.${sec.key}.title`, SECTION_TITLES_ZH[sec.key]);

  // 再跑一遍示例, 补齐只在渲染分支里出现的 key
  const exDir = new URL("../examples/", import.meta.url);
  const files = readdirSync(exDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(new URL(f, exDir), "utf8"));
      applyContext(d.meta || {}, { forceLocale: DEFAULT_LOCALE });
      render(analyze(d, P), P);
    } catch {
      /* 非评分输入的示例(如股权表)跳过, 不影响词表覆盖 */
    }
  }
  applyContext(EXAMPLE_OBJ.meta, { forceLocale: DEFAULT_LOCALE });
  render(analyze(EXAMPLE_OBJ, P), P);
  // 只输出到 stdout, 由 tools/dump-catalog.mjs 统一合并写盘:
  // 中文词表跨两个脚本, 各自写同一个文件会静默互相覆盖。
  process.stdout.write(JSON.stringify(dumpCatalog(), null, 2) + "\n");
  process.exit(0);
}

// ---- 无输入文件时以内置示例演示参数效果(便于快速看口径差异)
if (!positional.length) {
  applyContext(EXAMPLE_OBJ.meta);
  emit(analyze(EXAMPLE_OBJ, P));
  process.exit(0);
}

const file = positional[0];
let data;
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
  console.error("缺少 meta.as_of(数据截止日, YYYY-MM-DD)");
  process.exit(1);
}

// ---- 复算基线校验: 输入声明的参数集与实际加载的不一致, 说明报告无法被同一口径复现
applyContext(data.meta);
const extra = [];
if (data.meta.params_ref) {
  const actual = P.__meta ? `${P.__meta.id}@${P.__meta.hash8}` : null;
  if (!actual) {
    extra.push(`输入声明 meta.params_ref=${data.meta.params_ref}, 但本次未加载参数集(--config): 该输入的结论不可按声明口径复算`);
  } else if (actual !== data.meta.params_ref) {
    extra.push(`输入声明 meta.params_ref=${data.meta.params_ref}, 实际加载 ${actual}: 复算基线已失效`);
  }
}
emit(analyze(data, P, extra));
