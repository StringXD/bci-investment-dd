#!/usr/bin/env node
/**
 * 重新生成中文镜像词表 assets/i18n/zh-CN.json
 *
 * 为什么需要这个工具而不是各脚本自己写文件:
 *   中文词表跨两个脚本(dd_score / ownership), 各自 --dump-catalog 只知道自己那部分。
 *   如果让脚本直接写同一个文件, 后跑的会把先跑的整片覆盖掉 —— 而且是静默的,
 *   因为留下的那一半看起来完全正常。所以由本工具收集两份输出后合并写回。
 *
 * 定位提醒: zh-CN.json 是**生成物**, 不是真源。真源是源码里 t(key, "中文") 的
 * 第二个参数。改文案请改源码, 然后重跑本工具。
 *
 * 用法: node tools/dump-catalog.mjs [--check]
 *   --check  只比对不写盘; 有差异时 exit 1(供 CI 用)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "assets", "i18n", "zh-CN.json");
const SCRIPTS = ["scripts/dd_score.mjs", "scripts/ownership.mjs"];

const check = process.argv.includes("--check");
const merged = {};

for (const rel of SCRIPTS) {
  const r = spawnSync(process.execPath, [path.join(ROOT, rel), "--dump-catalog"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`${rel} --dump-catalog 失败(退出码 ${r.status}):\n${(r.stderr || "").trim()}`);
    process.exit(2);
  }
  let obj;
  try {
    obj = JSON.parse(r.stdout);
  } catch (e) {
    console.error(`${rel} --dump-catalog 输出不是合法 JSON: ${e.message}`);
    process.exit(2);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k in merged && merged[k] !== v) {
      // 同一个 key 两个脚本给了不同的中文默认值: 这是一处真源分叉, 必须报出来
      console.error(`key ${k} 在多个脚本中出现且默认值不同:\n  ${merged[k]}\n  ${v}`);
      process.exit(2);
    }
    merged[k] = v;
  }
}

const next = {};
for (const k of Object.keys(merged).sort()) next[k] = merged[k];
const text = JSON.stringify(next, null, 2) + "\n";

if (check) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (cur !== text) {
    console.error("assets/i18n/zh-CN.json 与源码不同步, 请运行 node tools/dump-catalog.mjs");
    process.exit(1);
  }
  console.log(`中文镜像已同步(${Object.keys(next).length} 条)`);
  process.exit(0);
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
console.log(`已写入 ${path.relative(ROOT, OUT)}(${Object.keys(next).length} 条)`);
