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

echo
if [ "$FAIL" -eq 0 ]; then echo "全部通过"; else echo "存在失败项"; fi
exit "$FAIL"
