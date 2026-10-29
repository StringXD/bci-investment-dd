/**
 * jurisdiction — 辖区档的唯一加载器与校验器
 *
 * 为什么与词表分开：语言是「同一件事换个说法」，辖区是「这件事本身不一样」。
 * 两者的变更频率、责任人、出错后果都不同 —— 混在一起改，一次措辞调整就可能
 * 悄悄改掉一条监管事实。
 *
 * 为什么档里不许出现 label/desc/name/title：G1 起所有标签都住在词表里。
 * 同一句话两处来源，改一处不改另一处时报告会自相矛盾，而且**没有任何测试会红**。
 * 所以这不是风格约定，是硬校验(P-01, 出现即 exit 2)。
 *
 * 校验码：
 *   P-01 禁区字段(标签类键)        → exit 2
 *   P-02 缺必需字段 / 类型错 / 未知键 → exit 2
 *   P-03 未支持的构造(如 eval 表达式) → exit 2   ← 本版白名单为空: 未实现即拒绝
 *   P-04 数值缺 source_ref + as_of + status → exit 2
 *   P-05 status = pending          → **不 exit**: 出拒答行并计入 gaps
 *   P-06 admission_only 档被请求评分 → exit 2
 */

import { readFileSync } from "node:fs";

export const PROFILE_SCHEMA = "jurisdiction-profile/1";
export const PROFILE_IDS = ["cn", "us", "eu"];

/** 禁区键：这些内容只能来自词表。见文件头注释。 */
export const FORBIDDEN_KEYS = ["label", "desc", "description", "name", "title", "text"];

/** status 语义见下方 STATUS_DOC；只有 pending 会触发拒答。 */
export const STATUSES = ["verified", "methodology", "pending"];
export const STATUS_DOC = {
  verified: "数值本身有一手来源, 且本次逐条核到原文",
  methodology: "方法学假设或规则名称可查, 但具体条款/口径未逐条核到原文",
  pending: "尚未核实: 不出数字, 出拒答行并计入 gaps",
};

/**
 * 顶层允许的键。多一个即 P-02 —— 拼写错误不能被静默忽略。
 *
 * 导出是为了让 assets/schema/jurisdiction.schema.json 的键面能被断言锁住:
 * 那份 schema 只服务编辑器提示与 CI 预检, 权威仍是本文件。两张表一旦各改各的,
 * schema 会继续对一份它不认识的档说「合法」, 而那是比没有 schema 更坏的结果。
 */
export const TOP_KEYS = ["schema", "id", "as_of", "currency", "admission_only", "control_lines", "rev_mult", "sensitivity_rates", "exit_channels", "gaps", "_doc"];

/** 顶层必需键(与 validateProfile 里的检查逐条对应)。 */
export const REQUIRED_TOP = ["schema", "id", "as_of", "currency", "admission_only", "control_lines", "rev_mult", "sensitivity_rates", "exit_channels"];

export class ProfileError extends Error {
  constructor(code, path, msg) {
    super(`[${code}] ${path}: ${msg}`);
    this.name = "ProfileError";
    this.code = code;
    this.path = path;
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

/** 递归找禁区键。命中即 P-01 —— 一处都不放过, 因为「只加一个 label」正是最常见的破口。 */
function scanForbidden(node, path, out) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanForbidden(v, `${path}[${i}]`, out));
    return;
  }
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN_KEYS.includes(k)) out.push({ code: "P-01", path: `${path}.${k}`, msg: `禁止在辖区档里写 "${k}": 文案只住词表, 两处来源必然有一天自相矛盾` });
    scanForbidden(v, `${path}.${k}`, out);
  }
}

/**
 * 递归找未实现的构造(表达式)。必须递归, 且必须与禁区扫描分开写:
 * 顶层 `"eval" in obj` 看不到 control_lines.eval, 而写在 thresholds 旁边的表达式
 * 恰恰是「门槛看起来生效了」的典型形态 —— 读者以为 66.67 被换成了他的公式,
 * 实际上那行被无声跳过, 报告继续用内置阈值出结论。
 */
const CONSTRUCT_KEYS = ["eval"];
function scanConstructs(node, path, out) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanConstructs(v, `${path}[${i}]`, out));
    return;
  }
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (CONSTRUCT_KEYS.includes(k)) {
      out.push({ code: "P-03", path: `${path}.${k}`, msg: "本版不支持 eval 表达式(白名单为空), 门槛请写成结构化数值" });
    }
    scanConstructs(v, `${path}.${k}`, out);
  }
}

/** 数值块的来源三元组。缺任何一个都是 P-04。 */
function requireProvenance(node, path, errors) {
  if (!isStr(node.source_ref)) errors.push({ code: "P-04", path: `${path}.source_ref`, msg: "缺来源说明" });
  if (!isDate(node.as_of)) errors.push({ code: "P-04", path: `${path}.as_of`, msg: "缺 as_of(YYYY-MM-DD)" });
  if (!STATUSES.includes(node.status)) {
    errors.push({ code: "P-04", path: `${path}.status`, msg: `status 必须是 ${STATUSES.join("/")}, 收到 ${JSON.stringify(node.status)}` });
    return null;
  }
  return node.status;
}

/**
 * 校验一份辖区档。返回 { errors, pending, profile }：
 *   errors  → 调用方 exit 2
 *   pending → 不 exit，转成报告里的拒答行与 gaps
 */
export function validateProfile(obj, { id = null } = {}) {
  const errors = [];
  const pending = [];

  if (!isObj(obj)) return { errors: [{ code: "P-02", path: "$", msg: "档必须是对象" }], pending };

  scanForbidden(obj, "$", errors);

  // 未实现的构造一律拒绝: 静默忽略一个 eval 会让「门槛看起来生效了」。
  // 必须排在未知键检查之前 —— eval 不在白名单里, 否则它只会被当成「拼错的键」报 P-02,
  // 而真正的原因(本版不支持表达式)一次也说不出口。
  scanConstructs(obj, "$", errors);
  for (const k of Object.keys(obj)) {
    if (CONSTRUCT_KEYS.includes(k)) continue;
    if (!TOP_KEYS.includes(k)) errors.push({ code: "P-02", path: `$.${k}`, msg: `未知键(拼写错误会被静默忽略, 所以直接拒绝)` });
  }

  if (obj.schema !== PROFILE_SCHEMA) errors.push({ code: "P-02", path: "$.schema", msg: `应为 ${PROFILE_SCHEMA}` });
  if (!PROFILE_IDS.includes(obj.id)) errors.push({ code: "P-02", path: "$.id", msg: `id 必须是 ${PROFILE_IDS.join("/")}` });
  if (id && obj.id !== id) errors.push({ code: "P-02", path: "$.id", msg: `文件名 ${id}.json 与 id=${obj.id} 不一致` });
  if (!isDate(obj.as_of)) errors.push({ code: "P-02", path: "$.as_of", msg: "缺编制日(YYYY-MM-DD)" });
  if (!/^[A-Z]{3}$/.test(obj.currency || "")) errors.push({ code: "P-02", path: "$.currency", msg: "币种须为三位大写代码" });
  if (typeof obj.admission_only !== "boolean") errors.push({ code: "P-02", path: "$.admission_only", msg: "admission_only 须为布尔值" });

  // ---- control_lines: 要么给阈值数组, 要么显式声明由章程约定
  const cl = obj.control_lines;
  if (!isObj(cl)) {
    errors.push({ code: "P-02", path: "$.control_lines", msg: "缺 control_lines" });
  } else {
    const charter = cl.charter_defined === true;
    const hasTh = Array.isArray(cl.thresholds);
    if (!charter && !hasTh) errors.push({ code: "P-02", path: "$.control_lines", msg: "要么给 thresholds, 要么 charter_defined: true" });
    if (hasTh) {
      if (!cl.thresholds.length) errors.push({ code: "P-02", path: "$.control_lines.thresholds", msg: "空数组等价于「没有控制线」, 请改用 charter_defined" });
      if (!cl.thresholds.every(isNum)) errors.push({ code: "P-02", path: "$.control_lines.thresholds", msg: "阈值须为数值" });
      if (cl.thresholds.some((x) => x < 0 || x > 100)) errors.push({ code: "P-02", path: "$.control_lines.thresholds", msg: "阈值应在 0-100" });
      const st = requireProvenance(cl, "$.control_lines", errors);
      if (st === "pending") pending.push({ path: "$.control_lines", msg: "控制线阈值" });
    }
    if (charter && hasTh) errors.push({ code: "P-02", path: "$.control_lines", msg: "charter_defined 与 thresholds 互斥: 二者并存时读者无法判断以哪套为准" });
  }

  // ---- rev_mult: 收入档边界。允许 pending(此时估值节出拒答而不是出数字)
  const rm = obj.rev_mult;
  if (!isObj(rm)) {
    errors.push({ code: "P-02", path: "$.rev_mult", msg: "缺 rev_mult" });
  } else {
    // pending 允许 edges 为空: 那正是「什么都不给」的写法。
    // 不给数字与给错数字是两件事, 前者出拒答, 后者出错误结论。
    const pendingNoNumbers = rm.status === "pending" && Array.isArray(rm.edges) && rm.edges.length === 0;
    if (!pendingNoNumbers) {
      if (!Array.isArray(rm.edges) || rm.edges.length < 2 || !rm.edges.every(isNum)) {
        errors.push({ code: "P-02", path: "$.rev_mult.edges", msg: "edges 至少两档且须为数值(pending 档可用空数组)" });
      } else if (rm.edges.some((x, i) => i > 0 && x <= rm.edges[i - 1])) {
        errors.push({ code: "P-02", path: "$.rev_mult.edges", msg: "edges 必须严格递增(否则档位重叠, 报告会挑错档)" });
      }
    }
    const st = requireProvenance(rm, "$.rev_mult", errors);
    if (st === "pending") pending.push({ path: "$.rev_mult", msg: "收入档边界" });
  }

  // ---- sensitivity_rates: 折现率档
  if (!Array.isArray(obj.sensitivity_rates) || obj.sensitivity_rates.length !== 3 || !obj.sensitivity_rates.every(isNum)) {
    errors.push({ code: "P-02", path: "$.sensitivity_rates", msg: "须为三个数值(与报告的三列敏感性格对应)" });
  } else if (obj.sensitivity_rates.some((x, i) => i > 0 && x <= obj.sensitivity_rates[i - 1])) {
    errors.push({ code: "P-02", path: "$.sensitivity_rates", msg: "须严格递增" });
  }

  // ---- exit_channels
  if (!Array.isArray(obj.exit_channels) || !obj.exit_channels.length) {
    errors.push({ code: "P-02", path: "$.exit_channels", msg: "缺退出通道清单" });
  } else {
    const seen = new Set();
    obj.exit_channels.forEach((ch, i) => {
      const p = `$.exit_channels[${i}]`;
      if (!isObj(ch)) { errors.push({ code: "P-02", path: p, msg: "须为对象" }); return; }
      if (!isStr(ch.key)) errors.push({ code: "P-02", path: `${p}.key`, msg: "缺 key(标签由词表 key 提供, 档里不写文案)" });
      else if (seen.has(ch.key)) errors.push({ code: "P-02", path: `${p}.key`, msg: `重复通道 ${ch.key}` });
      else seen.add(ch.key);
      if (typeof ch.is_channel !== "boolean") errors.push({ code: "P-02", path: `${p}.is_channel`, msg: "须为布尔值(unknown 之类不是真通道)" });
      if (typeof ch.applicable !== "boolean") errors.push({ code: "P-02", path: `${p}.applicable`, msg: "须为布尔值(本辖区是否适用)" });
      const st = requireProvenance(ch, p, errors);
      if (st === "pending") pending.push({ path: p, msg: `退出通道 ${ch.key}` });
      // eval 已由 scanConstructs 递归覆盖, 此处不再单独查: 两处都报会得到
      // 两条同路径的错, 修复时按第一条改完仍不通过, 白烧一轮。
    });
    if (!seen.has("unknown")) errors.push({ code: "P-02", path: "$.exit_channels", msg: "缺少 unknown 通道: 输入未填退出路径时必须能落到一个明确的「未明确」" });
  }

  // ---- gaps: 本档自己承认的缺口, 进报告
  if (obj.gaps !== undefined) {
    if (!Array.isArray(obj.gaps) || !obj.gaps.every(isObj)) errors.push({ code: "P-02", path: "$.gaps", msg: "gaps 须为对象数组" });
  }

  return { errors, pending };
}

/**
 * 读档 + 校验。任何一条 P-01..P-04 都直接抛 —— 档错了, 报告里每个数字都错。
 * P-05(pending) 不抛, 由调用方转成拒答行。
 */
export function loadProfile(dir, id) {
  if (!PROFILE_IDS.includes(id)) throw new ProfileError("P-02", "$.id", `未知辖区 ${id}(可用: ${PROFILE_IDS.join(", ")})`);
  const file = `${dir}/${id}.json`;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new ProfileError("P-02", file, `读不到辖区档: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new ProfileError("P-02", file, `不是合法 JSON: ${e.message}`);
  }
  const { errors, pending } = validateProfile(obj, { id });
  if (errors.length) {
    const e = errors[0];
    throw new ProfileError(e.code, e.path, `${e.msg}${errors.length > 1 ? `(另有 ${errors.length - 1} 条)` : ""}`);
  }
  return { profile: obj, pending };
}
