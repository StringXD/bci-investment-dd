#!/usr/bin/env node
/**
 * bci-dd-score v0.1.0 — 脑机接口投资尽调评分与门禁
 * 仅用 Node 标准库, 无第三方依赖 (node >= 18)。
 *
 * 用法:
 *   node scripts/dd_score.mjs                   # 裸跑 = --example
 *   node scripts/dd_score.mjs --example         # 内置示例(故意埋入 9 处告警情形)
 *   node scripts/dd_score.mjs data.json         # 计算并输出 Markdown
 *
 * 输入 JSON 字段:
 *   meta        {as_of, schema_version?, currency?, analyst?}
 *               as_of 必填(数据截止日, YYYY-MM-DD)
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
 *   输入概要 → 一 资产属性门禁 → 二 里程碑定位(L0-L6) → 三 九维加权评分
 *   → 四 致命红旗筛查 → 五 现金跑道与里程碑可达性 → 六 估值口径与偏离提示
 *   → 七 结论与证据缺口 → 警告
 *
 * 纪律:
 *   - 所有数字以本脚本 stdout 为准, 禁止口算覆盖或改写。
 *   - 任何输入缺失只产出「警告」, 不中断计算: 能算多少算多少。
 *   - 权重与阈值是方法学参数, 需按基金口径自行校准; 本脚本不提供估值结论。
 *   - 本脚本输出为尽调流程指标与偏离提示, 不构成估值结论、不构成投资建议、
 *     不构成法律、监管或会计意见。
 */

import { readFileSync } from "node:fs";

// ============================================================
// 常量区 ——— 编号与阈值口径的唯一真源
// ============================================================

const VERSION = "0.1.0";
const SCHEMA_VERSION = "1.0";
const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

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

/** 下一里程碑达成概率占位值(用于反算隐含成功后价值); 需按基金口径校准 */
const PROB_BY_MILESTONE = { L1: 0.75, L2: 0.6, L3: 0.45, L4: 0.3, L5: 0.18, L6: 0.1 };

const EXIT_PATHS = {
  ipo_star_5: "科创板第五套标准",
  ipo_hk_18a: "港交所第 18A 章",
  ma: "产业方并购",
  secondary: "老股转让 / S 基金",
  unknown: "未明确",
};

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
  { id: "RF-01", dim: "G0", severity: "veto", name: "只有论文或 POC 演示, 无任何可运行实体或工程样机", action: "索取样机演示录像(含失败片段)、BOM、测试记录" },
  { id: "RF-02", dim: "G0", severity: "veto", name: "单向采集或单向刺激产品对外称脑机接口", action: "要求出示闭环链路图与反馈环节实现证据, 对照分类界定四特征逐条核" },
  { id: "RF-03", dim: "G0", severity: "veto", name: "全部证据来自公司自述(BP / 路演), 无第三方材料", action: "按证据索取清单发正式函, 限期 10 个工作日" },
  { id: "RF-04", dim: "G0", severity: "warn", name: "门禁阶段即出现估值口径与资产属性明显错配", action: "转估值口径校验, 核对隐含倍数与所在档区间" },
  { id: "RF-05", dim: "G0", severity: "warn", name: "拒绝提供样机或拒绝现场演示", action: "记录拒绝事实与时点, 列为观察项并写入资料收集状态" },

  { id: "RF-06", dim: "D1", severity: "veto", name: "消费级或科研级资产、零收入或极低收入, 却按硬科技期权叙事定价", action: "要求拆出与叙事对应的收入线, 按消费品口径重算隐含倍数" },
  { id: "RF-07", dim: "D1", severity: "veto", name: "无闭环的单向监测产品按 BCI 平台估值", action: "核对闭环链路, 按监测设备口径重估并重排退出预期" },
  { id: "RF-08", dim: "D1", severity: "warn", name: "七成以上收入来自与核心叙事无关的传统业务, 对外只讲前沿线", action: "按产品线拆收入与毛利, 单独评估前沿线的单位经济" },
  { id: "RF-09", dim: "D1", severity: "warn", name: "市场规模引用多家机构口径不一且只取最高值", action: "要求同源同口径数据, 并说明 BCI 边界定义差异" },

  { id: "RF-10", dim: "D2", severity: "veto", name: "风险收益比倒挂: 高侵入方案的功能增益可被低风险方案替代", action: "列出现有替代方案清单, 逐项比较增益与风险" },
  { id: "RF-11", dim: "D2", severity: "fatal", name: "需求由技术自证, 无独立临床需求证据", action: "提供至少 5 位不相关临床专家的独立访谈记录" },
  { id: "RF-12", dim: "D2", severity: "warn", name: "单一适应症且支付方缺位(无医保、无自费能力)", action: "核实该适应症的支付路径与单例可支付金额" },

  { id: "RF-13", dim: "D3", severity: "veto", name: "仅有离线公开数据集交叉验证, 无在线实时闭环验证", action: "要求在线实时 demo 与跨天跨被试泛化数据" },
  { id: "RF-14", dim: "D3", severity: "veto", name: "宣称无创 EEG 解码复杂语义、数十汉字或完整思维", action: "要求关闭 EMG / EOG 通道后的对照结果与物理可行性说明" },
  { id: "RF-15", dim: "D3", severity: "veto", name: "无闭环反馈, 单向监测却称 BCI", action: "指出反馈通路的具体实现环节与延迟指标" },
  { id: "RF-16", dim: "D3", severity: "fatal", name: "核心性能由通用大模型先验补全, 非神经信号", action: "要求消融实验: 断开神经信号输入后性能下降幅度" },
  { id: "RF-17", dim: "D3", severity: "warn", name: "实验室效果好, 院内无法稳定使用", action: "要求院内连续多日实测记录与佩戴稳定性数据" },
  { id: "RF-18", dim: "D3", severity: "warn", name: "六件套缺关键环节(无自研电极工艺、无电源管理方案等)", action: "逐项确认电极、芯片、通信、电源、算法、工艺的实物与来源" },

  { id: "RF-19", dim: "D4", severity: "veto", name: "无明确注册路径, 或完全按研发思路做产品", action: "要求提交注册策略文件与分类界定申请或沟通记录" },
  { id: "RF-20", dim: "D4", severity: "veto", name: "临床数据仅个案报道, 无对照、无随访", action: "要求完整方案、对照设计与随访表, 核主要终点" },
  { id: "RF-21", dim: "D4", severity: "fatal", name: "绕开安全性与长期稳定性谈技术突破", action: "要求大动物在体时长与阻抗稳定性趋势数据" },
  { id: "RF-22", dim: "D4", severity: "warn", name: "产品成型但不具可销售条件(无医保、无采购路径)", action: "核实医保编码、省级挂网与收费项目立项进度" },
  { id: "RF-23", dim: "D4", severity: "warn", name: "定型后才启动型式检验, 导致技术路线返工", action: "核对型检启动时点与设计定型时点, 评估返工概率" },

  { id: "RF-24", dim: "D5", severity: "veto", name: "讲不清谁付钱、付多少, 只讲技术指标领先", action: "要求列出支付方、单价、采购决策链与已成交合同" },
  { id: "RF-25", dim: "D5", severity: "fatal", name: "商业计划依赖搞定关键人即可成交", action: "核查是否存在可复制的渠道与标准化销售流程" },
  { id: "RF-26", dim: "D5", severity: "warn", name: "把合作数量当商业进展, 单场景未闭环", action: "逐笔核对合作是否产生收入或交付验收" },
  { id: "RF-27", dim: "D5", severity: "warn", name: "单一客户或单一渠道依赖度超过一半", action: "按客户与渠道拆分收入, 评估替换成本" },

  { id: "RF-28", dim: "D6", severity: "fatal", name: "跑道不足 6 个月且无已签投资意向书、无过桥安排", action: "要求资金计划表与已签 TS, 评估过桥可行性" },
  { id: "RF-29", dim: "D6", severity: "fatal", name: "收入主要来自补助与关联方, 经营性现金流长期为负", action: "要求补助与关联交易明细, 剔除后重算收入" },
  { id: "RF-30", dim: "D6", severity: "warn", name: "无预算管控, 融资后支出随意", action: "索取预算表与实际执行对比, 核对大额支出审批" },
  { id: "RF-31", dim: "D6", severity: "warn", name: "研发资本化比例显著高于同行, 利润被修饰", action: "要求资本化政策与同行对比, 按费用化口径重算利润" },

  { id: "RF-32", dim: "D7", severity: "veto", name: "融资条款含高额回购或创始人无限连带责任", action: "逐条读取回购触发条件、义务人范围与金额上限" },
  { id: "RF-33", dim: "D7", severity: "fatal", name: "退出路径单一且不满足任何硬门槛, 却已按可退出定价", action: "对照各通道硬门槛逐条打勾, 反算退出所需条件" },
  { id: "RF-34", dim: "D7", severity: "warn", name: "存在明显估值倒挂风险的后续轮次安排", action: "做下一轮平轮与降轮情形的稀释与清算优先测算" },
  { id: "RF-35", dim: "D7", severity: "warn", name: "对赌触发条件与短期经营指标强绑定, 与长周期赛道冲突", action: "核对触发指标与临床周期是否可兼容, 争取里程碑化改写" },

  { id: "RF-36", dim: "D8", severity: "veto", name: "核心专利归属不清, 尤其高校成果转化未走完评估、审批与登记", action: "跑股权与权属链核查, 索取五节点全部文件" },
  { id: "RF-37", dim: "D8", severity: "veto", name: "数据采集无知情同意, 或临床数据来源不合规", action: "索取知情同意模板、伦理批件与数据来源台账" },
  { id: "RF-38", dim: "D8", severity: "warn", name: "创始人承担个人连带责任", action: "核对担保文件与个人资产敞口, 评估对决策的影响" },
  { id: "RF-39", dim: "D8", severity: "warn", name: "核心人员无竞业与保密约束", action: "索取劳动合同、竞业协议与保密协议" },
  { id: "RF-40", dim: "D8", severity: "warn", name: "对外宣传存在明确功效断言, 或量产宣称与事实不符", action: "留档全部宣传材料, 核对与注册证载明范围是否一致" },

  { id: "RF-41", dim: "D9", severity: "fatal", name: "核心技术人员一人独大, 无备份与文档沉淀", action: "核查关键模块的负责人分布与设计文档完整度" },
  { id: "RF-42", dim: "D9", severity: "fatal", name: "合伙人无书面协议, 权责不清", action: "索取合伙协议、分工文件与退出机制约定" },
  { id: "RF-43", dim: "D9", severity: "warn", name: "纯技术团队, 缺临床、注册、销售关键角色", action: "核对组织架构图与关键岗位在岗情况" },
  { id: "RF-44", dim: "D9", severity: "warn", name: "创始人长期高压透支, 决策质量下降", action: "多轮访谈观察决策一致性, 核查近一年重大决策记录" },
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

function money(x) {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  const a = Math.abs(x);
  if (a >= 1e8) return num(x / 1e8, 2) + " 亿";
  if (a >= 1e4) return num(x / 1e4, 1) + " 万";
  return num(x, 0);
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
// 计算
// ============================================================

function analyze(d) {
  const warnings = [];
  const w = (msg) => warnings.push(msg);

  // ---- 0. 输入归一
  const meta = d.meta || {};
  const company = d.company || {};
  const asset = d.asset || {};
  const fin = d.financials || {};
  const val = d.valuation || {};
  const exit = d.exit || {};

  if (!meta.as_of) w("meta.as_of 缺失, 已按运行日作为数据截止日");
  if (meta.schema_version && meta.schema_version !== SCHEMA_VERSION) {
    w(`输入 schema_version=${meta.schema_version} 与脚本 ${SCHEMA_VERSION} 不一致, 未识别字段将被忽略`);
  }
  if (meta.currency && meta.currency !== "CNY") {
    w(`meta.currency=${meta.currency} 暂不支持换算, 金额一律按原值处理, 跨币种结论不可比`);
  }
  if (!company.name) w("company.name 缺失, 输出以「未命名主体」占位");
  if (!company.stage || !STAGE_FACTOR[company.stage]) {
    w(`company.stage=${company.stage || "缺失"} 不在取值域内, 权重按 a 轮处理`);
  }
  const stage = STAGE_FACTOR[company.stage] ? company.stage : "a";

  // ---- 1. 资产属性门禁
  let familyKey = asset.class;
  if (!familyKey || !ASSET_FAMILIES[familyKey]) {
    w(`asset.class=${familyKey || "缺失"} 不在取值域内, 保守按「单向监测(降级)」处理`);
    familyKey = "monitoring_only";
  }
  const declaredClass = familyKey;
  let downgraded = false;
  if (asset.closed_loop === false) {
    if (familyKey !== "monitoring_only") {
      w(`asset.closed_loop=false: 按 NMPA 分类界定四特征中「实时双向交互或闭环反馈」一项不满足, 资产由「${ASSET_FAMILIES[familyKey].label}」降级为「单向监测(降级)」, 期权法不再适用`);
      familyKey = "monitoring_only";
      downgraded = true;
    }
  } else if (asset.closed_loop === undefined) {
    w("asset.closed_loop 缺失: 闭环真实性未经确认, 建议索取闭环链路图");
  }
  const family = ASSET_FAMILIES[familyKey];

  if (declaredClass === "rehab_class2" && asset.ai_based === true) {
    w("asset.class=rehab_class2 且 ai_based=true: 按 2026 年第 24 号通告, 脑卒中肢体运动康复训练若采用人工智能技术应按第三类管理, 二类路径需复核");
  }
  if (asset.class === "consumer_nondevice" && asset.ai_based === true) {
    w("asset.class=consumer_nondevice: 非医疗器械不得声称改善、修复或替代中枢神经系统功能的医疗效果, 对外表述需与注册属性一致");
  }
  if (asset.class && !asset.classification_code) {
    w(`asset.classification_code 缺失: 对照 2026 年第 24 号通告, ${ASSET_FAMILIES[asset.class] ? ASSET_FAMILIES[asset.class].code : "该类产品"} 应为预期分类编码, 请核实分类界定结论`);
  }
  if (asset.classification_code && CLASS_CODE_EXPECT[asset.class]) {
    const ok = CLASS_CODE_EXPECT[asset.class].some((c) => String(asset.classification_code).replace(/-/g, "") === c.replace(/-/g, ""));
    if (!ok) {
      w(`asset.classification_code=${asset.classification_code} 与 asset.class=${asset.class} 的预期编码(${CLASS_CODE_EXPECT[asset.class].join(" / ")})不一致`);
    }
  }
  if (asset.snr_db !== null && asset.snr_db !== undefined && isFinite(asset.snr_db)) {
    const indications = Array.isArray(asset.indication) ? asset.indication.join("") : "";
    const semantic = /语义|思维|语言|汉字|意图/.test(indications);
    if (semantic && asset.snr_db < -10 && asset.modality && String(asset.modality).startsWith("noninvasive")) {
      w(`asset.snr_db=${asset.snr_db} dB 且宣称涉及语义或意图解码: 该信噪比条件下高精度语义解码缺乏物理可行性, 要求提供关闭 EMG / EOG 通道后的对照结果`);
    }
  }
  if (asset.modality === undefined) w("asset.modality 缺失: 技术路线未确认, 影响后续技术维度评分与注册路径判定");

  // ---- 2. 里程碑定位
  const path = MILESTONE_PATHS[declaredClass] || MILESTONE_PATHS.default;
  const items = (d.milestones && Array.isArray(d.milestones.items)) ? d.milestones.items : [];
  if (!items.length) w("milestones.items 为空: 无法定位里程碑, 跑道与估值口径校验将降级");
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
    w(`里程碑 ${it.id} 标记为 done 但未提供达成日期, 其可核性不足`);
  });
  const doneOffPath = [...doneSet].filter((id) => !path.includes(id));
  if (doneOffPath.length) {
    w(`里程碑 ${doneOffPath.join("、")} 不在该类资产的典型路径上, 请确认路径判定是否准确`);
  }
  const skipped = path.slice(0, path.length).filter((id, i) => i > 0 && doneSet.has(id) && !doneSet.has(path[i - 1]));
  if (skipped.length) {
    w(`证据链断档: ${skipped.map((id) => `${id} 已达成但 ${path[path.indexOf(id) - 1]} 未达成`).join("; ")}`);
  }

  const nextMeta = nextId ? MILESTONES.find((m) => m.id === nextId) : null;
  const nextBuf = MILESTONE_BUFFER[nextId] || MILESTONE_BUFFER.default;
  const needLo = nextMeta ? nextMeta.months[0] * nextBuf : null;
  const needHi = nextMeta ? nextMeta.months[1] * nextBuf : null;
  const needMid = nextMeta ? mid(nextMeta.months) * nextBuf : null;

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
      w(`里程碑 ${id} 标记为 done 但证据不完整(${m.evidence.length - lack.length}/${m.evidence.length}), 缺: ${lack.map((e) => e.label).join("、")}`);
    }
  }

  // ---- 3. 九维加权评分
  const dimIn = Array.isArray(d.dimensions) ? d.dimensions : [];
  const dimMap = new Map(dimIn.map((x) => [x.id, x]));
  if (!dimIn.length) w("dimensions 为空: 九维评分无法计算");
  const missingDims = DIM_IDS.filter((id) => !dimMap.has(id));
  if (dimIn.length && missingDims.length) w(`维度缺评: ${missingDims.join("、")}, 按 0 分计入加权`);

  const rawW = {};
  for (const id of DIM_IDS) {
    const sf = (STAGE_FACTOR[stage] || {})[id] || 1;
    const gf = (GATE_FACTOR[familyKey] || {})[id] || 1;
    rawW[id] = WEIGHTS[id] * sf * gf;
  }
  let sumW = DIM_IDS.reduce((a, id) => a + rawW[id], 0);
  DIM_IDS.forEach((id) => { rawW[id] = rawW[id] / sumW; });
  let capped = false;
  DIM_IDS.forEach((id) => { if (rawW[id] > W_CAP) { rawW[id] = W_CAP; capped = true; } });
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
      if (dimIn.length) w(`维度 ${id} 的 score 缺失或非数值, 按 0 分处理`);
      score = 0;
    }
    if (score < 0 || score > 100) {
      w(`维度 ${id} 的 score=${score} 越界, 已截断至 0-100`);
      score = clamp(score, 0, 100);
    }
    const conf = CONF_DISCOUNT[dim.confidence] !== undefined ? dim.confidence : "medium";
    if (dim.confidence && CONF_DISCOUNT[dim.confidence] === undefined) {
      w(`维度 ${id} 的 confidence=${dim.confidence} 不在取值域内, 按 medium 处理`);
    }
    const evList = Array.isArray(dim.evidence) ? dim.evidence : [];
    evList.forEach((e, i) => {
      if (!e || !e.source) w(`维度 ${id} 第 ${i + 1} 条证据缺 source: 该条不可追溯`);
      if (!e || !e.date) w(`维度 ${id} 第 ${i + 1} 条证据缺 date: 该条未标注时点, 与当前结论的可比性下降`);
    });
    const eff = score * CONF_DISCOUNT[conf];
    const contrib = finalW[id] * eff;
    total += contrib;
    rows.push({ id, score, conf, eff, weight: finalW[id], contrib, open: (dim.checks_open || []), notes: dim.notes || "" });
  }

  // ---- 4. 致命红旗筛查
  const rfIn = Array.isArray(d.redflags) ? d.redflags : [];
  const knownIds = new Set(RF_LIBRARY.map((r) => r.id));
  rfIn.forEach((r) => {
    if (!r || !knownIds.has(r.id)) w(`红旗编号 ${r && r.id} 不存在于 RF_LIBRARY(RF-01 至 RF-44), 已忽略`);
    if (r && !["open", "mitigated", "cleared", "unknown"].includes(r.status)) {
      w(`红旗 ${r.id} 的 status=${r.status} 不在取值域内, 按 unknown 处理`);
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
    for (const [th, label, desc] of RUNWAY_RULES) {
      if (ratio >= th) { runwayTier = { th, label, desc }; break; }
    }
  }
  if (cash !== null && cash < 0) w("financials.cash 为负: 现金及等价物不应为负数, 请核对科目口径");
  if (burn === null && cash !== null) w("financials.burn_monthly 缺失或非正数: 无法计算现金跑道");
  if (runway !== null && runway < RUNWAY_FLOOR_MONTHS) {
    w(`现金跑道 ${num(runway, 1)} 个月低于 ${RUNWAY_FLOOR_MONTHS} 个月红线(只计现金与未使用授信, 未含应付账款展期)`);
  }

  const rev = Number.isFinite(Number(fin.revenue_ttm)) ? Number(fin.revenue_ttm) : null;
  const prior = Number.isFinite(Number(fin.revenue_prior_year)) ? Number(fin.revenue_prior_year) : null;
  const post = Number.isFinite(Number(val.post_money)) ? Number(val.post_money) : null;
  const growth = rev !== null && prior !== null && prior > 0 ? rev / prior - 1 : null;
  const gm = ratio01(fin.gross_margin, "gross_margin", warnings);
  const rd = ratio01(fin.rd_ratio, "rd_ratio", warnings);
  const grant = ratio01(fin.grant_ratio, "grant_ratio", warnings);

  if (gm !== null && gm < 0.3 && familyKey !== "consumer_nondevice") {
    w(`毛利率 ${num(gm * 100, 1)}% 低于 30%: 硬件型医疗设备的毛利结构需解释是否含低毛利集成或工程项目收入`);
  }
  if (grant !== null && grant > 0.3) {
    w(`政府补助占收入 ${num(grant * 100, 1)}%: 剔除补助后的经营性收入质量需单独评估`);
  }
  if (rd !== null && rd > 0.5) {
    w(`研发费用率 ${num(rd * 100, 1)}% 偏高: 与收入规模匹配度及后续融资依赖度需说明`);
  }

  // ---- 6. 估值口径与偏离
  const impliedPS = rev !== null && rev > 0 && post !== null ? post / rev : null;
  let band = null;
  let bandLabel = "";
  if (REV_MULT[familyKey]) {
    const buckets = REV_MULT[familyKey];
    const r = rev === null ? 0 : rev;
    for (let i = 0; i < buckets.length; i += 1) {
      if (r >= buckets[i][0]) {
        band = buckets[i][1];
        bandLabel = buckets[i][0] === 0 ? "零收入至 1 亿" : (buckets[i][0] === 1e8 ? "1 亿至 5 亿" : "5 亿以上");
      }
    }
  }
  const deviation = impliedPS !== null && band ? impliedPS / band[1] : null;
  const isMismatch = deviation !== null && deviation > 1.5 && !family.allow_option;

  // 申报口径下的对照区间: 降级情形下用于说明「按申报口径衡量需要被解释多少」
  let declaredBand = null;
  if (REV_MULT[declaredClass]) {
    const buckets = REV_MULT[declaredClass];
    const rr = rev === null ? 0 : rev;
    for (let i = 0; i < buckets.length; i += 1) {
      if (rr >= buckets[i][0]) declaredBand = buckets[i][1];
    }
  }
  const declaredDeviation = impliedPS !== null && declaredBand ? impliedPS / declaredBand[1] : null;

  if (isMismatch) {
    w(`估值口径错配: 按当前判定口径「${family.label}」衡量, 隐含 P/S ${num(impliedPS, 1)} 为区间上沿(${band[1]})的 ${num(deviation, 1)} 倍, 且该资产类别不适用期权法`);
  }

  const probNext = nextId ? PROB_BY_MILESTONE[nextId] : null;
  const impliedSuccessValue = probNext && post !== null ? post / probNext : null;

  // ---- 7. 结论分级
  let grade = total >= 85 ? "preferred" : total >= 70 ? "pass" : total >= 55 ? "conditional" : "watch";
  const capReasons = [];

  // 证据覆盖不足时不输出分级: 零证据下的任何结论都会误导
  const scoredDims = rows.filter((x) => x.score > 0).length;
  if (scoredDims === 0 || !items.length) {
    grade = "hold";
    capReasons.push(`可用评分维度 ${scoredDims}/9、已填里程碑 ${items.length}/7, 未达出结论的最低证据要求`);
  }

  if (grade !== "hold" && vetoOpen.length) {
    grade = "veto";
    capReasons.push(`存在 ${vetoOpen.length} 条未闭合的一票否决项(${vetoOpen.map((r) => r.id).join("、")})`);
  }
  if (grade !== "veto") {
    if (vetoUnknown.length || fatalOpen.length) {
      if (VERDICT_INDEX[grade] > VERDICT_INDEX.watch) {
        grade = "watch";
        capReasons.push(`存在状态不明的一票否决项(${vetoUnknown.map((r) => r.id).join("、") || "无"})或未闭合致命项(${fatalOpen.map((r) => r.id).join("、") || "无"}), 分数不作为通过依据`);
      }
    }
    if (isMismatch && VERDICT_INDEX[grade] > VERDICT_INDEX.watch) {
      grade = "watch";
      capReasons.push("估值口径错配, 计价范式需先澄清");
    }
    if (grade === "preferred" && (!currentId || !["L4", "L5", "L6"].includes(currentId))) {
      grade = "pass";
      capReasons.push(`里程碑当前为 ${currentId || "尚未启动"}, 未达 L4, 不进入加注评估`);
    }
    if (grade === "preferred" && runwayTier && runwayTier.label !== "充足") {
      grade = "pass";
      capReasons.push(`跑道档位为「${runwayTier.label}」, 未达充足`);
    }
  }
  const verdict = VERDICTS[VERDICT_INDEX[grade]];

  // ---- 证据缺口
  const gaps = [];
  missingEvidence.forEach((e) => gaps.push({ item: e.label, type: "里程碑证据", where: `${nextId}`, owner: "标的方", due: "下一轮交割前" }));
  [...vetoOpen, ...vetoUnknown, ...fatalOpen].forEach((r) =>
    gaps.push({ item: `${r.id} ${r.name}`, type: "红旗核查", where: r.action, owner: "标的方 + 第三方核验", due: "尽调期内" })
  );
  rows
    .filter((r) => r.open.length)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .forEach((r) => gaps.push({ item: `${r.id} 未完成检查项 ${r.open.join("、")}`, type: "维度检查项", where: r.id, owner: "标的方", due: "尽调期内" }));

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
  };
}

// ============================================================
// 渲染
// ============================================================

function render(r) {
  const L = [];
  const p = (s = "") => L.push(s);
  let secNo = 0;
  const sec = (t) => {
    const i = secNo;
    secNo += 1;
    return `## ${CN[i] || String(i + 1)}、${t}`;
  };

  const bar = "=".repeat(56);
  p(bar);
  p(`BCI INVESTMENT DD SCORECARD  v${VERSION}`);
  p(bar);
  p("");

  // ---- 输入概要
  const dimCount = r.rows.filter((x) => x.score > 0 || x.open.length).length;
  p("## 输入概要");
  p(`- 主体: ${r.company.name || "未命名主体"} | 阶段: ${r.stage} | 成立: ${r.company.founded_year || "-"} | 人数: ${r.company.headcount || "-"}`);
  p(`- 申报资产类别: ${r.declaredClass}${r.downgraded ? " → 降级为 monitoring_only" : ""} | 技术路线: ${r.asset.modality || "-"}`);
  p(`- 数据截止: ${r.meta.as_of || new Date().toISOString().slice(0, 10)} | 币种: ${r.meta.currency || "CNY"} | 分析: ${r.meta.analyst || "-"}`);
  p(`- 维度完成度: ${dimCount}/9 | 里程碑状态已填: ${r.items.length}/7 | 红旗登记 ${r.rfTouched} 条`);
  p("");

  // ---- 一、资产属性门禁
  p(sec("资产属性门禁"));
  p("> 核心问题: 这是哪一类资产, 该用哪一把尺子量? 口径错则全篇错。");
  p("");
  p("| 项 | 判定 |");
  p("|---|---|");
  p(`| 申报类别 | ${r.declaredClass} |`);
  p(`| 实际口径族 | **${r.family.label}** |`);
  p(`| 监管预期编码 | ${r.family.code} |`);
  p(`| 允许期权法 | ${r.family.allow_option ? "是" : "**否**"} |`);
  p(`| 适用估值族 | ${r.family.approach} |`);
  p(`| 闭环真实性 | ${r.asset.closed_loop === true ? "已确认闭环" : r.asset.closed_loop === false ? "**未闭合, 按单向监测降级**" : "未确认"} |`);
  if (r.downgraded) {
    p("");
    p(`> 降级依据: 分类界定要求同时具备四项核心特征, 其中「实时双向交互或闭环反馈」不满足时, 产品按现行分类目录执行, 不再适用脑机接口医疗器械编码, 亦不再适用平台期权叙事。`);
  }
  p("");

  // ---- 二、里程碑定位
  p(sec("里程碑定位(L0-L6)"));
  p(`> 该类资产主干路径: ${r.path.join(" → ")}`);
  p("");
  p("| 级别 | 名称 | 状态 | 达成日 | 证据完整度 | 证据引用 |");
  p("|---|---|---|---|---|---|");
  for (const id of MILESTONES.map((m) => m.id)) {
    const meta = MILESTONES.find((m) => m.id === id);
    const it = r.byId.get(id) || { status: "未填", provided: [] };
    const onPath = r.path.includes(id);
    const prov = new Set(it.provided || []);
    const full = meta.evidence.filter((e) => prov.has(e.key)).length;
    const st = !onPath ? "不适用" : it.status === "planned" || it.status === "in_progress" ? it.status : it.status;
    p(`| ${id} | ${meta.name} | ${st} | ${it.date || "-"} | ${onPath ? `${full}/${meta.evidence.length}` : "-"} | ${it.evidence_ref || "-"} |`);
  }
  p("");
  p(`- 当前级: **${r.currentId || "尚未启动"}**${r.nextId ? ` | 下一级: **${r.nextId} ${r.nextMeta.name}**` : " | 已完成主干路径全部节点"}`);
  if (r.nextMeta) {
    p(`- 下一级典型耗时: ${num(r.needLo, 1)} 至 ${num(r.needHi, 1)} 个月(中值 ${num(r.needMid, 1)} 个月, 已含缓冲系数)`);
    p(`- 下一级缺口证据: ${r.missingEvidence.length ? r.missingEvidence.map((e) => e.label).join("、") : "无, 证据齐备"}`);
  }
  p("");

  // ---- 三、九维加权评分
  p(sec("九维加权评分"));
  p(`> 有效分 = 原分 × 置信折价(high 1.00 / medium 0.90 / low 0.75); 权重已按阶段因子与门禁因子修正并归一化, 单维上限 ${W_CAP}。`);
  p("");
  p("| 维度 | 名称 | 原分 | 置信 | 折价后 | 有效权重 | 加权贡献 | 未完成检查项 |");
  p("|---|---|---|---|---|---|---|---|");
  for (const row of r.rows) {
    p(`| ${row.id} | ${DIM_NAMES[row.id]} | ${num(row.score, 0)} | ${row.conf} | ${num(row.eff, 1)} | ${num(row.weight * 100, 1)}% | ${num(row.contrib, 1)} | ${row.open.length ? row.open.join("、") : "-"} |`);
  }
  p(`| **合计** | | | | | **${num(r.rows.reduce((a, x) => a + x.weight, 0) * 100, 1)}%** | **${num(r.total, 1)}** | |`);
  p("");
  const topW = [...r.rows].sort((a, b) => b.weight - a.weight).slice(0, 3);
  p(`- 权重最高的三维: ${topW.map((x) => `${x.id} ${DIM_NAMES[x.id]}(${num(x.weight * 100, 1)}%)`).join("、")}。阶段因子解释了同一维度在不同轮次的信息价值差异; 门禁因子解释了资产定性对口径的修正。`);
  p("");

  // ---- 四、致命红旗筛查
  p(sec("致命红旗筛查"));
  p("| 编号 | 维度 | 现象 | 等级 | 状态 | 核查动作 |");
  p("|---|---|---|---|---|---|");
  const touched = RF_LIBRARY.filter((x) => r.statusOf(x.id) !== "not_listed");
  if (!touched.length) {
    p("| - | - | 未登记任何红旗 | - | - | - |");
  } else {
    for (const x of touched) {
      const st = r.statusOf(x.id);
      const mark = x.severity === "veto" ? "🔴 一票否决" : x.severity === "fatal" ? "🔴 致命" : "🟡 警惕";
      p(`| ${x.id} | ${x.dim} | ${x.name} | ${mark} | ${st} | ${x.action} |`);
    }
  }
  p("");
  p(`- 一票否决项未闭合: ${r.vetoOpen.length} 条${r.vetoOpen.length ? `(${r.vetoOpen.map((x) => x.id).join("、")})` : ""}`);
  p(`- 一票否决项状态不明: ${r.vetoUnknown.length} 条${r.vetoUnknown.length ? `(${r.vetoUnknown.map((x) => x.id).join("、")})` : ""}`);
  p(`- 致命项未闭合: ${r.fatalOpen.length} 条${r.fatalOpen.length ? `(${r.fatalOpen.map((x) => x.id).join("、")})` : ""}`);
  p("");

  // ---- 五、现金跑道(条件节)
  if (r.runway !== null) {
    p(sec("现金跑道与里程碑可达性"));
    p("| 现金及等价物 | 未使用授信 | 可动用流动性 | 月均净流出 | 跑道(月) | 下一里程碑需时(月) | 比值 | 档位 |");
    p("|---|---|---|---|---|---|---|---|");
    p(`| ${money(r.cash)} | ${money(r.credit)} | ${money(r.liquidity)} | ${money(r.burn)} | **${num(r.runway, 1)}** | ${r.needMid ? num(r.needMid, 1) : "-"} | ${r.ratio !== null ? num(r.ratio, 2) : "-"} | ${r.runwayTier ? `**${r.runwayTier.label}**` : "-"} |`);
    p("");
    if (r.runwayTier) p(`- 判定: ${r.runwayTier.desc}`);
    if (r.growth !== null) p(`- 收入同比: ${r.growth >= 0 ? "+" : ""}${num(r.growth * 100, 1)}%(上年 ${money(r.prior)} → 本年 ${money(r.rev)})`);
    p("");
  }

  // ---- 六、估值口径(条件节)
  if (r.impliedPS !== null || r.post !== null) {
    p(sec("估值口径与偏离提示"));
    p("> 本段为口径校验, 不构成估值结论。倍数区间为结构示意, 需按基金口径与可比交易自行校准。");
    p("");
    p("| 项 | 数值 |");
    p("|---|---|");
    p(`| 最近一轮投后估值 | ${money(r.post)} |`);
    p(`| 最近 12 个月收入 | ${money(r.rev)} |`);
    p(`| 隐含 P/S | ${r.impliedPS !== null ? num(r.impliedPS, 1) + " 倍" : "不适用(零收入或无收入数据)"} |`);
    p(`| 所在档区间 | ${r.band ? `${r.bandLabel} 档 [${r.band[0]}, ${r.band[1]}]` : "-"} |`);
    p(`| 相对区间上沿 | ${r.deviation !== null ? num(r.deviation, 2) + " 倍" : "-"} |`);
    p(`| 期权法适用性 | ${r.family.allow_option ? "适用" : "**不适用**"} |`);
    p("");
    if (r.isMismatch) {
      p(`- **口径错配**: 按当前判定口径「${r.family.label}」衡量, 隐含 P/S ${num(r.impliedPS, 1)} 已达区间上沿(${r.band ? r.band[1] : "-"})的 ${num(r.deviation, 1)} 倍, 而该类别不能由技术叙事支撑倍数, 只能由收入与利润解释。`);
      if (r.declaredDeviation !== null && r.declaredClass !== r.familyKey) {
        p(`- 对照申报口径「${r.declaredClass}」的区间上沿 ${r.declaredBand ? r.declaredBand[1] : "-"}, 隐含倍数为 ${num(r.declaredDeviation, 2)} 倍; 该溢价需由明确的临床里程碑跳升来解释, 且必须先解决闭环与分类判定问题。`);
      }
    } else if (r.deviation !== null && r.deviation > 1.5 && r.family.allow_option) {
      p(`- 溢价部分需由里程碑跳升解释: 当前隐含倍数为区间上沿的 ${num(r.deviation, 1)} 倍。`);
      if (r.probNext && r.impliedSuccessValue !== null) {
        p(`- 若下一里程碑(${r.nextId})达成概率按占位值 ${num(r.probNext, 2)} 折算, 当前定价对应的隐含成功后价值为 ${money(r.impliedSuccessValue)}, 请核该值是否落在同档可比区间。`);
      }
    } else if (r.deviation !== null) {
      p(`- 隐含倍数 ${num(r.impliedPS, 1)} 落在或低于所在档区间上沿, 未触发口径偏离提示。`);
    }
    p("");
    if (r.exit.planned_path) {
      p(`- 计划退出路径: ${EXIT_PATHS[r.exit.planned_path] || r.exit.planned_path}${r.exit.target_year ? `, 目标年份 ${r.exit.target_year}` : ""}`);
    }
    if (r.exit.planned_path === "ipo_star_5" && r.exit.core_product_phase2_approved === false) {
      p(`- **退出硬门槛未满足**: 科创板第五套标准要求预计市值不低于 40 亿元, 且医药行业企业需至少有一项核心产品获准开展二期临床试验; 当前标记为未取得该项批准。`);
    }
    p("");
  }

  // ---- 七、结论与证据缺口
  p(sec("结论与证据缺口"));
  p(`### 结论: **${r.verdict.label}**`);
  p("");
  p(`> ${r.verdict.desc}`);
  p("");
  p(`- 有效加权分 **${num(r.total, 1)}**(满分 100), 对应分级阈值 55 / 70 / 85。`);
  p(`- 里程碑当前为 **${r.currentId || "尚未启动"}**${r.nextId ? `, 下一级 ${r.nextId} 需时约 ${num(r.needMid, 1)} 个月` : ""}${r.runway !== null ? `; 跑道 ${num(r.runway, 1)} 个月, 档位「${r.runwayTier ? r.runwayTier.label : "-"}」` : ""}。`);
  p(`- 未闭合致命项 ${r.vetoOpen.length + r.fatalOpen.length} 条, 状态不明 ${r.vetoUnknown.length} 条; 警惕项未闭合 ${r.warnOpen.length} 条。`);
  if (r.capReasons.length) {
    p("");
    p("**分级修正说明**");
    for (const c of r.capReasons) p(`- ${c}`);
  }
  p("");
  p("### 证据缺口");
  if (!r.gaps.length) {
    p("无未闭合缺口。结论仍受输入证据完备度与样本范围约束。");
  } else {
    p("| 缺口 | 类型 | 定位 | 责任方 | 建议期限 |");
    p("|---|---|---|---|---|");
    const seen = new Set();
    for (const g of r.gaps) {
      const k = g.item + g.type;
      if (seen.has(k)) continue;
      seen.add(k);
      p(`| ${g.item} | ${g.type} | ${g.where} | ${g.owner} | ${g.due} |`);
    }
  }
  p("");

  // ---- 警告(恒为末节)
  p("## 警告");
  const uniq = [...new Set(r.warnings)];
  if (uniq.length) {
    for (const x of uniq) p(`- ⚠ ${x}`);
  } else {
    p("- 未发现需要提示的异常; 上述结论仍受输入证据完备度约束。");
  }
  p("");

  return L.join("\n");
}

// ============================================================
// main
// ============================================================

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--example")) {
  process.stdout.write(render(analyze(EXAMPLE_OBJ)));
  process.exit(0);
}

const file = args.find((a) => a !== "--example");
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
process.stdout.write(render(analyze(data)));
