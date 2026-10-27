#!/usr/bin/env node
/**
 * bci-ownership v0.1.0 — 脑机接口企业股权与控制权穿透
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
 *
 * 输入 JSON 字段:
 *   meta        {as_of, currency?}                 as_of 必填(股权基准日)
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
 *   输入概要 → 一 全稀释穿透 → 二 高校成果转化权属链 → 三 代持与名义持有人还原
 *   → 四 持股平台与表决权杠杆 → 五 可转债 / SAFE 摊薄模拟
 *   → 六 对赌与回购触发压力 → 七 创始人控制权稳定性推演
 *   → 八 结论与待补文件清单 → 警告
 *   条件节(二/三/四/五)在输入缺失时整节省略, 节号自动顺延。
 *
 * 纪律:
 *   - 所有比例数字以本脚本 stdout 为准, 禁止口算覆盖或改写。
 *   - 任何输入缺失只产出「警告」, 不中断计算: 能算多少算多少。
 *   - 控制权推演为摊薄近似(按稀释比例线性折算), 不替代律师的精确测算。
 *   - 本脚本输出为尽调辅助分析, 不构成法律意见, 亦不构成投资建议。
 */

import { readFileSync } from "node:fs";

// ============================================================
// 常量区
// ============================================================

const VERSION = "0.1.0";
const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 控制线: [阈值, 简称, 释义] */
const LINES = [
  [66.67, "特别决议通过线", "修改章程、增减注册资本、合并分立解散、变更公司形式"],
  [50.0, "普通决议控制线", "多数日常经营与人事事项"],
  [33.34, "特别决议否决线", "单独或联合持有即可阻却特别决议"],
  [10.0, "会议召集线", "可请求召开临时股东会(具体比例按现行《公司法》核对)"],
  [1.0, "提案线", "可提出临时提案(股份公司口径, 须核对现行条文)"],
];

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
// 工具
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

const pct = (x) => num(x, 2) + "%";

function hitsLines(v) {
  const out = [];
  for (const [th, short] of LINES) if (v >= th) out.push(`${pct(th)} ${short}`);
  return out;
}

// ============================================================
// 计算
// ============================================================

function analyze(d) {
  const warnings = [];
  const w = (m) => warnings.push(m);

  const meta = d.meta || {};
  if (!meta.as_of) w("meta.as_of 缺失, 请以股权基准日填写");

  // ---- 0. cap table 归一
  const cap = Array.isArray(d.cap_table) ? d.cap_table.filter((x) => x && x.holder) : [];
  if (!cap.length) w("cap_table 为空: 无法进行股权穿透");

  cap.forEach((row) => {
    if (row.pct !== undefined && row.shares !== undefined) {
      w(`股东「${row.holder}」同时提供 pct 与 shares, 以 shares 折算为准, 请核对原始数据`);
    }
    if (row.pct === undefined && row.shares === undefined) {
      w(`股东「${row.holder}」既无 pct 也无 shares, 按 0 处理`);
    }
    if (row.type && !TYPE_NAMES[row.type]) {
      w(`股东「${row.holder}」的 type=${row.type} 不在取值域内, 按 other 处理`);
    }
  });

  // 以 pct 为工作口径(有 shares 时按 shares 占比折算)
  const hasShares = cap.some((x) => x.shares !== undefined);
  let curTotal;
  if (hasShares) {
    const totalShares = cap.reduce((a, x) => a + (Number(x.shares) || 0), 0);
    if (totalShares <= 0) {
      w("全部股东的 shares 合计为 0: 无法折算比例");
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
    w(`现有股东持股合计 ${pct(curTotal)} 不等于 100%: 可能遗漏股东(含未登记的代持或期权池), 请补齐`);
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
        w(`可转债第 ${i + 1} 笔未提供 as_converted_pct, 已按 本金 / 估值上限 估算为 ${pct(v)}, 需以协议约定为准`);
      } else {
        v = 0;
        w(`可转债第 ${i + 1} 笔缺少 as_converted_pct 且无法按估值上限估算, 摊薄模拟将偏低`);
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
    w(`期权池同时以股东行(${pct(cap.filter((x) => x.type === "esop_pool").reduce((a, x) => a + x._pct, 0))})与 esop.reserved_pct(${pct(reservedRaw)})出现, 已按股东行口径计算, 请核对是否存在重复填报`);
  }
  const fdTotal = curTotal + convTotal + reserved;
  if (fdTotal <= 0) w("完全稀释后总股本为 0: 无法计算稀释口径");

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
  const nodes = (Array.isArray(uni.nodes) ? uni.nodes : []).map((n) => {
    const meta2 = UCHAIN_NODES.find((u) => u.id === n.id);
    return { id: n.id, name: meta2 ? meta2.name : n.id, risk: meta2 ? meta2.risk : "", status: n.status || "missing", note: n.note || "" };
  });
  UCHAIN_NODES.forEach((u) => {
    if (uniInvolved && !nodes.find((n) => n.id === u.id)) {
      nodes.push({ id: u.id, name: u.name, risk: u.risk, status: "missing", note: "未提供" });
    }
  });
  nodes.sort((a, b) => UCHAIN_NODES.findIndex((u) => u.id === a.id) - UCHAIN_NODES.findIndex((u) => u.id === b.id));
  const applicable = nodes.filter((n) => n.status !== "na");
  const doneCnt = applicable.filter((n) => n.status === "done").length;
  const uniCompleteness = applicable.length ? doneCnt / applicable.length : 0;

  if (uniInvolved) {
    const nodeOf = (id) => nodes.find((n) => n.id === id) || { status: "missing" };
    if (Number(uni.equity_held_by_school) > 0 && nodeOf("N3").status !== "done") {
      w("学校或资产公司已持股但缺第三方评估作价报告(N3): 存在出资不实风险, 影响后续融资与申报");
    }
    if (["department_head", "dean", "legal_rep"].includes(uni.professor_role) && uni.part_time_approved !== true) {
      w(`教授担任${ROLE_NAMES[uni.professor_role] || uni.professor_role}但未取得兼职或离岗创业批准: 存在任职合规与职务成果归属风险`);
    }
    if (nodeOf("N2").status === "done" && nodeOf("N4").status !== "done") {
      w("学校审批已完成但未办理工商登记(N4 缺失): 协议已签而权属未转移");
    }
    if (uni.ip_form === "license" && uni.license_written !== true) {
      w("知识产权为许可形态但无书面许可协议: 权属链断裂, 独占性不成立");
    }
    if (uniCompleteness < 1) {
      w(`成果转化权属链完整度 ${doneCnt}/${applicable.length}: 未闭合节点 ${applicable.filter((n) => n.status !== "done").map((n) => n.id).join("、")}`);
    }
  }

  // ---- 3. 代持还原
  const nom = Array.isArray(d.nominal_holders) ? d.nominal_holders.filter(Boolean) : [];
  nom.forEach((n) => {
    if (!n.has_agreement) w(`代持「${n.nominal} → ${n.beneficial}」无书面代持协议: 还原主张缺乏证据, 申报前必须清理`);
    if (Number(n.pct) >= NOMINEE_FLAG) w(`代持比例 ${pct(Number(n.pct))} 达到 ${NOMINEE_FLAG}% 以上: 还原后表决权结构发生实质变化`);
  });

  // ---- 4. 平台与表决权杠杆
  const platforms = Array.isArray(d.platforms) ? d.platforms.filter(Boolean) : [];
  platforms.forEach((p) => {
    if (!p.gp) w(`持股平台「${p.name}」未标明 GP: 无法判断表决权归属`);
    if (p.gp_control && !["founder", "committee", "external"].includes(p.gp_control)) {
      w(`持股平台「${p.name}」的 gp_control=${p.gp_control} 不在取值域内, 按 external 处理`);
    }
  });

  // ---- 创始人核心组
  const core = new Set(cap.filter((x) => ["founder", "professor"].includes(x.type)).map((x) => x.holder));
  const concert = Array.isArray(d.concert) ? d.concert.filter(Array.isArray) : [];
  const concertApplied = [];
  concert.forEach((g) => {
    const members = g.filter((m) => cap.some((x) => x.holder === m));
    if (members.length < 2) {
      w(`一致行动组 [${g.join("、")}] 有效成员不足 2 人, 已忽略`);
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
  if (leverage !== null && leverage > LEVERAGE_FLAG) {
    w(`创始人「${principalRow.holder}」以 ${pct(principalRow.pctNow)} 的经济利益控制 ${pct(principalRow.vote)} 表决权(杠杆 ${num(leverage, 2)} 倍): 差额来自表决权委托或特别表决权安排, 需核查有效期、可撤销性与失效条件`);
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
    for (const [th, label, desc] of REDEEM_RULES) {
      if (redeemRatio >= th) { redeemTier = { th, label, desc }; break; }
    }
  }
  if (terms.personal_guarantee === true) w("存在创始人个人连带责任: 需核对担保范围与个人资产敞口");
  if (terms.redemption_trigger && !["ipo_deadline", "material_breach", "performance", "none"].includes(terms.redemption_trigger)) {
    w(`terms.redemption_trigger=${terms.redemption_trigger} 不在取值域内`);
  }
  if (redeem > 0 && cash === null) w("存在回购义务但未提供现金数据: 无法计算回购压力");

  // ---- 6. 控制权稳定性推演
  const scenarios = (Array.isArray(d.scenarios) && d.scenarios.length ? d.scenarios : CONTROL_SCENARIOS).map((s) => {
    const dil = Number(s.dilution_pct) || 0;
    const top = Number(s.esop_topup_pct) || 0;
    // 近似: 新增股本 = 稀释比例 + 期权池补足(均按占现股本百分比), 原股东按比例摊薄
    const after = coreVote * (100 / (100 + dil + top));
    return {
      label: s.label || `稀释 ${dil}%`,
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
    w(`创始人提名董事 ${boardFounder}/${boardTotal} 席未过半: 组织控制弱于股权口径, 需结合一票否决事项评估`);
  }
  if (boardSeats > 0 && coreVote >= 50 && founderSeats / boardSeats < coreVote / 100 - BOARD_TOLERANCE) {
    w(`席位与股权错配: 表决权 ${pct(coreVote)} 但董事席位占比仅 ${pct((founderSeats / boardSeats) * 100)}`);
  }

  // ---- 期权池
  const esopTotal = isFinite(Number(esop.total_pct)) ? Number(esop.total_pct) : 0;
  if (esopTotal > 0 && esopTotal < ESOP_FLOOR) {
    w(`期权池占总股本 ${pct(esopTotal)} 低于 ${ESOP_FLOOR}% 的常见下限: BCI 关键人才竞争激烈, 后续授予空间可能不足`);
  }

  // ---- 清算优先
  if (terms.liquidation_pref && !["1x_np", "1x", "2x", "other"].includes(terms.liquidation_pref)) {
    w(`terms.liquidation_pref=${terms.liquidation_pref} 不在取值域内`);
  }
  if (terms.liquidation_pref === "2x") {
    w("清算优先为 2 倍: 低估值退出情形下普通股可能拿不到对价, 需做清算瀑布测算");
  }

  // ---- 结论与待补文件
  const todo = [];
  if (!cap.length) todo.push("完整股权结构表(含全部股东、持股平台与期权池)");
  if (uniInvolved && uniCompleteness < 1) todo.push("成果转化五节点全套文件(发明人确认、学校批文与公示、评估报告、工商档案、收益分配协议)");
  if (nom.some((n) => !n.has_agreement)) todo.push("代持协议原件与资金往来凭证(或代持解除协议)");
  if (convs.some((c) => c._estimated)) todo.push("可转债 / SAFE 全套协议(含转股价、估值上限、折扣与到期安排)");
  if (redeem > 0) todo.push("对赌与回购条款全文(触发条件、义务人、金额上限、豁免机制)");
  if (terms.personal_guarantee) todo.push("创始人个人连带担保文件与资产状况说明");
  if (boardSeats === 0) todo.push("公司章程与董事会构成、一票否决事项清单");
  if (!todo.length) todo.push("无重大缺口, 建议补充最近一次融资的 SHA 全文以复核条款");

  return {
    meta, capOut, curTotal, convTotal, reserved, fdTotal,
    uniInvolved, nodes, applicable, doneCnt, uniCompleteness, uni,
    nom, platforms, concertApplied, convs,
    core, coreRows, coreEcon, coreVote, principalRow, leverage,
    terms, cash, credit, liquidity, redeem, redeemRatio, redeemTier,
    scenarios, boardTotal, boardFounder, boardSeats, founderSeats,
    esopTotal, todo, warnings,
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
  p(`BCI OWNERSHIP & CONTROL  v${VERSION}`);
  p(bar);
  p("");

  p("## 输入概要");
  p(`- 股权基准日: ${r.meta.as_of || "-"} | 币种: ${r.meta.currency || "CNY"}`);
  p(`- 股东数: ${r.capOut.length} | 现股本口径合计: ${pct(r.curTotal)}`);
  p(`- 完全稀释调整: ${[r.convTotal > 0 ? `可转债 ${pct(r.convTotal)}` : null, r.reserved > 0 ? `期权池预留 ${pct(r.reserved)}` : null].filter(Boolean).join(" + ") || "无"} → 稀释后总口径 ${pct(r.fdTotal)}`);
  p(`- 创始人核心组: ${[...r.core].join("、") || "未识别"}`);
  p("");

  // ---- 一、全稀释穿透
  p(sec("股权结构穿透(全稀释口径)"));
  p("| 主体 | 类型 | 现持股 | 全稀释 | 表决权 | 董事席位 | 备注 |");
  p("|---|---|---|---|---|---|---|");
  for (const x of [...r.capOut].sort((a, b) => b.pctNow - a.pctNow)) {
    const isCore = r.core.has(x.holder);
    p(`| ${isCore ? `**${x.holder}**` : x.holder} | ${TYPE_NAMES[x.type] || x.type} | ${pct(x.pctNow)} | ${pct(x.pctFd)} | ${pct(x.vote)} | ${x.board || "-"} | ${x.note || "-"} |`);
  }
  if (r.convTotal > 0) {
    p(`| 可转债 / SAFE(未转股) | 未转股工具 | - | ${pct(r.convTotal)} | ${pct(r.convTotal)} | - | 转股后成为普通股 |`);
  }
  p(`| **合计** | | **${pct(r.capOut.reduce((a, x) => a + x.pctNow, 0))}** | **${pct(r.capOut.reduce((a, x) => a + x.pctFd, 0) + (r.convTotal > 0 && r.fdTotal > 0 ? (r.convTotal / r.fdTotal) * 100 : 0))}** | **${pct(r.capOut.reduce((a, x) => a + x.vote, 0))}** | **${r.capOut.reduce((a, x) => a + x.board, 0)}** | |`);
  p("");
  if (r.concertApplied.length) {
    p(`- 已合并的一致行动组: ${r.concertApplied.map((g) => `[${g.join("、")}]`).join("; ")}`);
  }
  p("");

  // ---- 二、成果转化权属链(条件节)
  if (r.uniInvolved) {
    p(sec("高校成果转化权属链核查"));
    p("> 比例对不等于权属对。五节点任一缺失, 都可能使核心技术的权属在申报或诉讼中被质疑。");
    p("");
    p("| 节点 | 名称 | 状态 | 若缺失的风险 | 备注 |");
    p("|---|---|---|---|---|");
    for (const n of r.nodes) {
      p(`| ${n.id} | ${n.name} | ${n.status === "done" ? "已闭合" : n.status === "na" ? "不适用" : "**未闭合**"} | ${n.risk} | ${n.note || "-"} |`);
    }
    p("");
    p(`- 完整度: **${r.doneCnt}/${r.applicable.length}**(${pct(r.uniCompleteness * 100)})`);
    p(`- 知识产权形态: ${r.uni.ip_form || "未说明"} | 学校或资产公司持股: ${pct(Number(r.uni.equity_held_by_school) || 0)} | 教授在校职务: ${ROLE_NAMES[r.uni.professor_role] || "未说明"} | 兼职批准: ${r.uni.part_time_approved === true ? "已批" : "**未批或未提供**"}`);
    p("");
  }

  // ---- 三、代持还原(条件节)
  if (r.nom.length) {
    p(sec("代持与名义持有人还原"));
    p("| 名义持有人 | 实际持有人 | 比例 | 原因 | 书面协议 | 风险 |");
    p("|---|---|---|---|---|---|");
    for (const n of r.nom) {
      p(`| ${n.nominal} | ${n.beneficial} | ${pct(Number(n.pct) || 0)} | ${n.reason || "-"} | ${n.has_agreement ? "有" : "**无**"} | ${n.has_agreement ? "还原路径可执行, 但申报前仍须清理" : "还原主张缺证据, 存在权属争议与申报障碍"} |`);
    }
    p("");
    p("> 代持还原同时转移经济利益与表决权。报告中须并列呈现「还原前」与「还原后」两套口径, 不得自行取舍。");
    p("");
  }

  // ---- 四、平台与杠杆(条件节)
  if (r.platforms.length) {
    p(sec("持股平台与表决权杠杆"));
    p("| 平台 | GP | 控制归属 | 执行事务合伙人 | LP 数 |");
    p("|---|---|---|---|---|");
    for (const x of r.platforms) {
      p(`| ${x.name} | ${x.gp || "-"} | ${x.gp_control || "未说明"} | ${x.exec_partner || "-"} | ${x.lp_count || "-"} |`);
    }
    p("");
    p(`- 创始人核心组: 经济利益 ${pct(r.coreEcon)}, 有效表决权 ${pct(r.coreVote)}`);
    if (r.principalRow) {
      p(`- 首席创始人「${r.principalRow.holder}」: 经济利益 ${pct(r.principalRow.pctNow)}, 表决权 ${pct(r.principalRow.vote)}, 杠杆率 **${r.leverage !== null ? num(r.leverage, 2) : "-"}**`);
    }
    if (r.leverage !== null && r.leverage > LEVERAGE_FLAG) {
      p(`- 杠杆存在意味着表决权多于经济利益, 来源通常是平台 GP 控制、表决权委托或特别表决权安排。该安排的价值在于稳定性, 风险在于可撤销性: 需核查合伙协议中 GP 更换、退伙与份额转让条款, 以及一致行动协议的有效期与解除条件。`);
    } else {
      p(`- 表决权与经济利益基本一致(杠杆率不大于 ${num(LEVERAGE_FLAG, 2)}), 控制权主要依赖股权本身而非协议安排。`);
    }
    p("");
  }

  // ---- 五、可转债摊薄(条件节)
  if (r.convs.length) {
    p(sec("可转债 / SAFE 转股摊薄模拟"));
    p("| 序号 | 类型 | 本金 | 估值上限 | 折扣 | 计入稀释 | 说明 |");
    p("|---|---|---|---|---|---|---|");
    r.convs.forEach((c, i) => {
      p(`| ${i + 1} | ${c.type || "-"} | ${money(Number(c.principal))} | ${money(Number(c.valuation_cap))} | ${c.discount ? num(Number(c.discount) * 100, 0) + "%" : "-"} | ${pct(c._pct)} | ${c._estimated ? "按估值上限估算, 需以协议为准" : "按协议约定"} |`);
    });
    p("");
    p(`- 转股后合计稀释: ${pct(r.convTotal)}; 该部分已在第一节的全稀释列体现。`);
    p(`- 需重点核对: 下一轮投前估值低于估值上限时按上限转股、高于上限时按折扣转股, 两种情形对创始团队的稀释差可能达到数个百分点。`);
    p("");
  }

  // ---- 六、对赌与回购
  p(sec("对赌与回购触发压力"));
  p("| 项 | 内容 |");
  p("|---|---|");
  p(`| 清算优先 | ${r.terms.liquidation_pref || "未提供"} |`);
  p(`| 反稀释 | ${r.terms.anti_dilution || "未提供"} |`);
  p(`| 回购触发条件 | ${r.terms.redemption_trigger || "未提供"} |`);
  p(`| 回购义务金额 | ${money(r.redeem)} |`);
  p(`| 可动用流动性 | ${money(r.liquidity)} |`);
  p(`| 回购 / 流动性 | ${r.redeemRatio !== null ? num(r.redeemRatio, 2) + " 倍" : "-"} |`);
  p(`| 压力档位 | ${r.redeemTier ? `**${r.redeemTier.label}**` : "-"} |`);
  p(`| 创始人个人连带 | ${r.terms.personal_guarantee === true ? "**有**" : "无或未提供"} |`);
  p("");
  if (r.redeemTier) p(`- 判定: ${r.redeemTier.desc}`);
  if (Array.isArray(r.terms.veto_matters) && r.terms.veto_matters.length) {
    p(`- 投资人一票否决事项: ${r.terms.veto_matters.join("、")}`);
  }
  p("");

  // ---- 七、控制权推演
  p(sec("创始人控制权稳定性推演"));
  p("> 按稀释比例线性折算的近似推演, 用于识别临界点, 不替代律师的精确测算。");
  p("");
  p("| 情景 | 新增稀释 | 期权池补足 | 核心组表决权 | 距 50% | 距 33.34% | 守住否决线还需联合 |");
  p("|---|---|---|---|---|---|---|");
  for (const s of r.scenarios) {
    p(`| ${s.label} | ${s.dilution}% | ${s.topup}% | **${pct(s.vote)}** | ${s.d50 >= 0 ? "+" : ""}${num(s.d50, 2)} | ${s.d3334 >= 0 ? "+" : ""}${num(s.d3334, 2)} | ${s.needFor3334 > 0 ? pct(s.needFor3334) : "无需"} |`);
  }
  p("");
  const firstLoss = r.scenarios.find((s) => s.vote < 33.34);
  const firstNo50 = r.scenarios.find((s) => s.vote < 50);
  if (firstNo50) p(`- 在「${firstNo50.label}」情景下核心组表决权跌破 50%, 失去普通决议单方控制。`);
  if (firstLoss) p(`- 在「${firstLoss.label}」情景下核心组表决权跌破 33.34%, 失去特别决议否决权: 后续任何增资、章程修改均可能被动接受。`);
  p(`- 董事会: 创始人提名 ${r.founderSeats}/${r.boardSeats} 席${r.boardSeats > 0 && r.founderSeats > r.boardSeats / 2 ? ", 已过半" : ", 未过半"}`);
  p("");

  // ---- 八、结论与待补
  p(sec("结论与待补文件清单"));
  const concl = [];
  if (r.uniInvolved && r.uniCompleteness < 1) concl.push(`成果转化权属链未闭合(${r.doneCnt}/${r.applicable.length})`);
  if (r.nom.some((n) => !n.has_agreement)) concl.push("存在无书面协议的代持");
  if (r.redeemTier && ["严重", "偏高"].includes(r.redeemTier.label)) concl.push(`回购压力${r.redeemTier.label}`);
  if (r.terms.personal_guarantee === true) concl.push("创始人个人连带");
  if (r.leverage !== null && r.leverage > LEVERAGE_FLAG) concl.push(`控制权依赖协议杠杆(${num(r.leverage, 2)} 倍)`);
  p(concl.length ? `- 主要风险点: ${concl.join("; ")}。` : "- 未发现结构性控制权风险。");
  p(`- 核心组表决权 ${pct(r.coreVote)}, 对应控制线: ${hitsLines(r.coreVote).join("; ") || "未达任何控制线"}`);
  p("");
  p("### 待补文件");
  for (const t of r.todo) p(`- ${t}`);
  p("");

  p("## 警告");
  const uniq = [...new Set(r.warnings)];
  if (uniq.length) for (const x of uniq) p(`- ⚠ ${x}`);
  else p("- 未发现需要提示的异常; 现有股东合计校验通过, 未检出循环持股与口径冲突。");
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
  console.error("缺少 meta.as_of(股权基准日, YYYY-MM-DD)");
  process.exit(1);
}
process.stdout.write(render(analyze(data)));
