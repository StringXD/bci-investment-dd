#!/usr/bin/env node
/**
 * i18n 断言 —— 英文输出与词表的一致性
 *
 * 这里刻意不复用运行时 dump 出来的中文镜像来判等:
 * 镜像是「跑到了哪些分支」的产物, 覆盖不全就少 key, 拿它当基准会把
 * 「漏翻译」误判成通过。基准改成**源码里出现的全部字面 key**, 与运行路径无关。
 *
 * 用法: node tests/i18n.mjs      退出码 0 全过 / 1 有失败
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC =
  readFileSync(path.join(ROOT, "scripts", "dd_score.mjs"), "utf8") +
  "\n" +
  readFileSync(path.join(ROOT, "scripts", "ownership.mjs"), "utf8") +
  "\n" +
  readFileSync(path.join(ROOT, "scripts", "lib", "sections.mjs"), "utf8");
const EN = JSON.parse(readFileSync(path.join(ROOT, "assets", "i18n", "en-US.json"), "utf8"));

let fail = 0;
const ok = (m) => console.log(`  OK   ${m}`);
const ng = (m) => {
  console.log(`  FAIL ${m}`);
  fail = 1;
};

// ---- 1. 源码字面 key 全在英文词表里
const re = /\bt\("([a-zA-Z0-9_.-]+)",\s*"((?:[^"\\]|\\.)*)"/g;
const pairs = new Map();
let m;
while ((m = re.exec(SRC))) if (!pairs.has(m[1])) pairs.set(m[1], m[2]);

// 取全部 key(不限第二个参数的引号形态): 有 5 处中文默认值用了模板字符串
const allKeys = new Set();
for (const mm of SRC.matchAll(/\bt\(\s*"([a-zA-Z0-9_.-]+)"/g)) allKeys.add(mm[1]);

const missing = [...allKeys].filter((k) => !(k in EN));
if (missing.length === 0) ok(`源码 ${allKeys.size} 个字面 key 均在英文词表内`);
else ng(`英文词表缺 ${missing.length} 个 key: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`);

// ---- 2. 占位符两侧一致（写错占位符 = 运行时抛错, 或更糟: 静默少一段话）
const ph = (s) => [...String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((x) => x[1]).sort().join(",");
const phBad = [...pairs.entries()].filter(([k, zh]) => k in EN && ph(zh) !== ph(EN[k]));
if (phBad.length === 0) ok("中英占位符集合一致");
else ng(`占位符不一致: ${phBad.slice(0, 5).map(([k]) => k).join(", ")}`);

// ---- 3. 英文值不得含中日韩字符、不得为空
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const cjk = Object.entries(EN).filter(([, v]) => CJK.test(v)).map(([k]) => k);
const empty = Object.entries(EN).filter(([, v]) => !String(v).trim()).map(([k]) => k);
if (cjk.length === 0) ok("英文词表无中日韩字符");
else ng(`英文词表含 CJK: ${cjk.slice(0, 5).join(", ")}`);
if (empty.length === 0) ok("英文词表无空值");
else ng(`英文词表有空值: ${empty.slice(0, 5).join(", ")}`);

// ---- 4. 同一 key 的英文值不得等于中文默认值（漏翻的典型形态是原样留下）
// 只对含中文的默认值做这条断言: 纯 ASCII 的值(如分类编码 12-00)本来就该两侧相同
const same = [...pairs.entries()].filter(([k, zh]) => CJK.test(zh) && k in EN && EN[k] === zh).map(([k]) => k);
if (same.length === 0) ok("无原样保留的中文值");
else ng(`以下 key 的英文值与中文默认值完全相同（疑似漏翻）: ${same.slice(0, 5).join(", ")}`);

// ---- 5. 中文镜像必须是生成物且被 .gitignore 之外的方式管理: 至少要与源码 key 同源
//      允许镜像缺 key（覆盖不全）, 但不允许镜像里出现源码中不存在的 key。
const zhMirror = JSON.parse(readFileSync(path.join(ROOT, "assets", "i18n", "zh-CN.json"), "utf8"));
// 动态拼接的 key(family.${k}.label 之类)正则抓不到, 按前缀放行。
// own.* 只放行真正由枚举/常量派生的那几组: own.s.* / own.w.* / own.tbl.* 等
// 都是字面 key, 放行整片 own. 会把「漏翻译」也一起放过。
const DYNAMIC = /^(family|milestone|rf|dim|verdict|impact|runway|exit|sections)\.|^own\.(sec|skip|type|role|line|redeem|gpc|uchain|scen)\./;
const orphan = Object.keys(zhMirror).filter((k) => !allKeys.has(k) && !DYNAMIC.test(k));
if (orphan.length === 0) ok("中文镜像无孤儿 key");
else ng(`中文镜像含源码中不存在的 key（多半是改了代码没重导）: ${orphan.slice(0, 5).join(", ")}`);

console.log(fail === 0 ? "  OK   i18n 词表检查通过" : "  FAIL i18n 词表检查未通过");
process.exit(fail);
