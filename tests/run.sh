#!/usr/bin/env bash
# 回归测试: 覆盖「输出可复现」与「参数集纪律」两组断言。
# 用法: bash tests/run.sh
# 退出码: 0 全通过 | 1 有失败项

set -u
cd "$(dirname "$0")/.." || exit 1

FAIL=0
TMP=".test-tmp"
rm -rf "$TMP" 2>/dev/null || true
mkdir -p "$TMP"
trap 'rm -rf "$TMP" 2>/dev/null || true' EXIT

ok() { printf '  OK   %s\n' "$1"; }
ng() { printf '  FAIL %s\n' "$1"; FAIL=1; }

expect_eq() { # 名称 期望 实际
  if [ "$2" = "$3" ]; then ok "$1"; else ng "$1 (期望 $2, 实际 $3)"; fi
}

# ---------- 1. 三份示例可复现 ----------
node scripts/dd_score.mjs  examples/01-implant-class3.json > "$TMP/01.md"
node scripts/dd_score.mjs  examples/02-consumer-eeg.json   > "$TMP/02.md"
node scripts/ownership.mjs examples/03-cap-table.json      > "$TMP/03.md"
for n in 01 02 03; do
  if diff -q "examples/$n-output.md" "$TMP/$n.md" > /dev/null; then ok "示例 $n 输出可复现"; else ng "示例 $n 输出漂移"; fi
done

# ---------- 2. 空参数集 = 无参数集 ----------
node scripts/dd_score.mjs examples/01-implant-class3.json --config tests/fixtures/config-identity.json > "$TMP/i1.md"
if diff -q "examples/01-output.md" "$TMP/i1.md" > /dev/null; then ok "identity 参数集与无参数集逐字等价"; else ng "identity 参数集改变了输出"; fi

# ---------- 3. --print-defaults 回灌等价(两脚本自证) ----------
node scripts/dd_score.mjs  --print-defaults > "$TMP/dd-defaults.json"
node scripts/dd_score.mjs  examples/01-implant-class3.json --config "$TMP/dd-defaults.json" > "$TMP/dd-rt.md"
if diff -q "examples/01-output.md" "$TMP/dd-rt.md" > /dev/null; then ok "dd_score 默认参数往返回等价"; else ng "dd_score 往返不等价"; fi

node scripts/ownership.mjs --print-defaults > "$TMP/own-defaults.json"
node scripts/ownership.mjs examples/03-cap-table.json --config "$TMP/own-defaults.json" > "$TMP/own-rt.md"
if diff -q "examples/03-output.md" "$TMP/own-rt.md" > /dev/null; then ok "ownership 默认参数往返等价"; else ng "ownership 往返不等价"; fi

# ---------- 4. 覆盖确实生效 ----------
node scripts/dd_score.mjs examples/01-implant-class3.json --config tests/fixtures/config-override.json > "$TMP/ov.md"
if grep -q "params: fixture-override@" "$TMP/ov.md"; then ok "覆盖后 banner 标注参数集指纹"; else ng "banner 未标注参数集"; fi
if grep -q "MILESTONES.months" "$TMP/ov.md"; then ok "参数段列出覆盖范围"; else ng "参数段缺覆盖范围"; fi
if grep -q "对应分级阈值 58 / 72 / 88" "$TMP/ov.md"; then ok "覆盖后的分级阈值生效"; else ng "分级阈值未生效"; fi
if awk '/^## 一、/{f=1} f&&/资产属性门禁/{print "ok"}' "$TMP/ov.md" | grep -q ok; then ok "参数段未挤占中文节号"; else ng "节号被参数段挤偏"; fi

# ---------- 5. 参数集非法必须中止 ----------
for c in bad-sum typo rf-downgrade; do
  node scripts/dd_score.mjs examples/01-implant-class3.json --config "tests/fixtures/config-$c.json" > /dev/null 2> "$TMP/e.txt"
  expect_eq "非法参数集 $c 退出码" 2 "$?"
  if grep -q "V-0" "$TMP/e.txt"; then ok "非法参数集 $c 报出校验编号"; else ng "非法参数集 $c 未报编号"; fi
done

# ---------- 6. 互斥与边界 ----------
node scripts/dd_score.mjs --example --config tests/fixtures/config-override.json > /dev/null 2>&1
expect_eq "--example 与 --config 互斥退出码" 2 "$?"

node scripts/dd_score.mjs --nope > /dev/null 2>&1
expect_eq "未知参数退出码" 2 "$?"

printf '{"meta":{"as_of":"2026-10-01"}}' > "$TMP/min.json"
node scripts/dd_score.mjs "$TMP/min.json" > "$TMP/min-out.md" 2>&1
expect_eq "最小输入不崩溃" 0 "$?"
if grep -q "资料不足" "$TMP/min-out.md"; then ok "最小输入不出结论"; else ng "最小输入未压到资料不足"; fi

# ---------- 7. 共用一份参数集可同时喂两个脚本 ----------
node scripts/ownership.mjs examples/03-cap-table.json --config tests/fixtures/config-override.json > "$TMP/own-ov.md"
expect_eq "共用参数集喂 ownership" 0 "$?"
if grep -q "重大影响线" "$TMP/own-ov.md"; then ok "ownership 新增控制线生效"; else ng "ownership 新增控制线未生效"; fi

# ---------- 8. --json 契约 ----------
# 下游(文档排版/多标的对比/跨期跟踪)依赖 JSON, 因此这里锁三件事:
# 形状对、可解析、且与文本报告来自同一次计算(分数必须一模一样)。
node scripts/dd_score.mjs examples/01-implant-class3.json --json > "$TMP/01.json" 2>&1
node -e '
const fs = require("fs");
let j;
try { j = JSON.parse(fs.readFileSync(".test-tmp/01.json", "utf8")); }
catch (e) { console.log("NOT-JSON"); process.exit(1); }
if (j.schema !== "dd-score-output/1") { console.log("BAD-SCHEMA"); process.exit(1); }
if (typeof j.total !== "number" || !Array.isArray(j.rows) || j.rows.length !== 9) {
  console.log("BAD-SHAPE"); process.exit(1);
}
process.stdout.write(j.total.toFixed(1));
' > "$TMP/score-json" 2>&1
expect_eq "--json 是合法 JSON 且形状正确" 0 "$?"

TXT_SCORE=$(grep -o '有效加权分 \*\*[0-9][0-9.]*\*\*' "$TMP/01.md" | grep -o '[0-9][0-9.]*' | head -1)
JSON_SCORE=$(cat "$TMP/score-json" 2>/dev/null)
expect_eq "--json 与文本报告分数同源" "$TXT_SCORE" "$JSON_SCORE"

# 终端装饰字符不得混进 JSON: 混进去说明下游还得再解析一遍文本
if grep -qE '^=|SCORECARD|^\s*\|' "$TMP/01.json"; then ng "--json 混入终端装饰"; else ok "--json 不含终端装饰"; fi

# 参数集指纹必须随 --json 一起走, 否则下游无法在报告上标注口径
node scripts/dd_score.mjs examples/01-implant-class3.json --json --config tests/fixtures/config-override.json > "$TMP/01-cfg.json"
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(".test-tmp/01-cfg.json", "utf8"));
if (!j.paramsMeta || !/^[a-z0-9-]+@[0-9a-f]{8}$/.test(j.paramsMeta.id + "@" + j.paramsMeta.hash8)) {
  console.log("NO-PARAMS-META"); process.exit(1);
}
' > /dev/null 2>&1 && ok "--json 携带参数集指纹" || ng "--json 缺参数集指纹"

node scripts/ownership.mjs examples/03-cap-table.json --json > "$TMP/03.json" 2>&1
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(".test-tmp/03.json", "utf8"));
if (j.schema !== "ownership-output/1") process.exit(1);
' > /dev/null 2>&1 && ok "ownership --json 契约一致" || ng "ownership --json 异常"

# ---------- 9. 影响路径与敏感性 ----------
# 这两块把「定性红旗」接到「估值模型」上, 是本框架唯一让两章互通的机制。
# 一旦被静默改坏, 报告仍然能出, 但红旗与估值重新变成两张互不相干的表。
if grep -q '### 影响路径(红旗折在哪)' "$TMP/01.md"; then ok "红旗表附影响路径"; else ng "红旗表缺影响路径(红旗与估值重新断链)"; fi
# 用 02 断言: 该示例命中了归零类(RF-02), 01 恰好没有命中, 用 01 测会假阴性
if grep -q '\*\*归零类' "$TMP/02.md"; then ok "归零类单列"; else ng "归零类未单列(会被平均进大表稀释)"; fi

# 五类路径必须全部出现在文档与脚本两侧, 否则「映射」只是部分映射
FIV=$(grep -c '^| \*\*\(归零\|折时间\|折概率\|折倍数\|折条款\)\*\* ' references/red-flags.md)
expect_eq "red-flags.md 五类路径汇总齐全" 5 "$FIV"

# 敏感性只对允许期权法的资产类别输出。消费级(02)若也出了这张表, 说明条件节守门失效。
if grep -q '### 情景与敏感性' "$TMP/01.md"; then ok "植入式资产输出敏感性"; else ng "植入式资产缺敏感性(单点估值不可信)"; fi
if grep -q '### 情景与敏感性' "$TMP/02.md"; then ng "消费级资产也出了敏感性(期权法不适用却仍折概率)"; else ok "消费级资产正确地不出敏感性"; fi

# 延迟折损必须可复算: 24 个月 / 12% = 1.12^2 = 1.25
if grep -q '| 24 | 1.17 倍 | 1.25 倍 | 1.32 倍 |' "$TMP/01.md"; then ok "延迟折损表可复算"; else ng "延迟折损表数值不对(1.12^2 应为 1.25)"; fi

echo
if [ "$FAIL" -eq 0 ]; then echo "全部通过"; else echo "存在失败项"; fi
exit "$FAIL"
