#!/usr/bin/env bash
# 回归测试: 13 组, 覆盖「输出可复现」「参数集纪律」「双语输出」「辖区档与金额」。
# 组号与下面的 `# ---------- N.` 一一对应 —— 增删分组时这里和 tools/baseline.mjs 的
# COUNTS 要一起改, 否则「测试项数」这个人工锚点会变成一句假话。
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

# 契约里必须带「已本地化的维度名」与「已格式化的金额」。让下游自己拼, 它就得复制
# 一份词表与一套金额规则 —— 那份副本一定先漂移, 而且只会漂成「英文报告里的 12.5 亿」。
node scripts/dd_score.mjs examples/01-implant-class3.json --json > "$TMP/01.json"
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(".test-tmp/01.json", "utf8"));
if (!j.rows.every((r) => typeof r.dimLabel === "string" && r.dimLabel.length)) { console.log("NO-DIMLABEL"); process.exit(1); }
if (/[\u4e00-\u9fa5]/.test(j.rows[0].dimLabel) === false) { console.log("DIMLABEL-NOT-ZH"); process.exit(1); }
if (typeof j.post_display !== "string" || !/亿|万/.test(j.post_display)) { console.log("NO-DISPLAY"); process.exit(1); }
if (typeof j.post !== "number") { console.log("LOST-RAW-NUMBER"); process.exit(1); }
if (!j.val || typeof j.val.post_money_display !== "string") { console.log("NO-VAL-DISPLAY"); process.exit(1); }
' > /dev/null 2>&1 && ok "--json 携带 dimLabel 与金额 *_display(原始数值仍在)" || ng "--json 缺 dimLabel 或 *_display"

# 英文侧: 维度名与量级词都要跟着 locale 走, 而且不能残留中文
node scripts/dd_score.mjs examples/01-implant-class3.json --json --lang en-US > "$TMP/01-en.json"
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(".test-tmp/01-en.json", "utf8"));
const cjk = /[\u4e00-\u9fa5]/;
if (j.rows.some((r) => cjk.test(r.dimLabel))) { console.log("CJK-DIMLABEL"); process.exit(1); }
if (cjk.test(j.post_display) || !/[KMB]$/.test(j.post_display)) { console.log("DISPLAY-NOT-EN"); process.exit(1); }
' > /dev/null 2>&1 && ok "英文 --json 的 dimLabel 与 *_display 均已本地化" || ng "英文 --json 仍是中文口径"

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

# ---------- 10. 词表与英文输出 ----------
# 中文是源码内联字面量(构造上逐字不变), 英文靠词表。这一组守的是:
# 词表与源码不同步时立刻红, 而不是等买家在英文报告里看到半截中文。
if node tests/i18n.mjs > /dev/null 2>&1; then ok "词表与源码同步(占位符/空值/CJK 均通过)"; else ng "词表与源码不同步"; fi

node scripts/dd_score.mjs examples/01-implant-class3.json --lang en-US > "$TMP/en01.md" 2> "$TMP/en01.err"
expect_eq "英文输出退出码" 0 "$?"
if grep -q '^## 1\. Asset-class gate' "$TMP/en01.md"; then ok "英文节号用阿拉伯数字"; else ng "英文节号未本地化"; fi
if grep -q '^## 四、' "$TMP/en01.md"; then ng "英文输出里出现了中文节号(半英半中)"; else ok "英文输出无中文节号"; fi
# 允许的残留中文只有输入数据本身(公司名/分析人), 它们不是文案
LEAK=$(grep -cv -e '^- Entity:' -e '^- Data as of:' -e '^$' <(grep -P '[\x{4e00}-\x{9fa5}]' "$TMP/en01.md"))
expect_eq "英文输出无中文文案残留" 0 "$LEAK"

# --json 是另一条出口: 渲染路径的「使用点翻译」管不到它, 而下游(长研报)会把
# JSON 里的每个字符串当数据豁免 —— 漏翻的文案因此能一路印进英文报告而不报错。
# 允许的残留只有输入数据本身, 逐条列白名单, 不用「有中文就放过」的模糊规则。
node scripts/dd_score.mjs examples/01-implant-class3.json --lang en-US --json > "$TMP/en01.json" 2>/dev/null
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const DATA = /^(meta\.analyst|company\.(name|hq)|asset\.indication(\[\d+\])?|rows\[\d+\]\.notes)$/;
const CJK = /[\u4e00-\u9fa5]/;
const leaks = [];
const walk = (n, p) => {
  if (typeof n === "string") { if (CJK.test(n) && !DATA.test(p)) leaks.push(p + " = " + n); return; }
  if (Array.isArray(n)) return n.forEach((v, i) => walk(v, p + "[" + i + "]"));
  if (n && typeof n === "object") Object.entries(n).forEach(([k, v]) => walk(v, p ? p + "." + k : k));
};
walk(j, "");
if (leaks.length) { console.error(leaks.join("\n")); process.exit(1); }
' "$TMP/en01.json" 2> "$TMP/en01.leak" && ok "--json 英文出口零中文文案(仅输入数据保留原文)" || ng "英文 JSON 残留中文文案: $(head -2 "$TMP/en01.leak" | tr '\n' ' ')"

node scripts/dd_score.mjs examples/01-implant-class3.json --lang fr-FR > /dev/null 2>&1
expect_eq "不支持的 locale 退出码" 2 "$?"

# ---------- 11. 股权脚本的英文输出 ----------
# 用一份数据全英文的 fixture, 才能把「英文输出里零 CJK」当成零容忍断言。
# 中文示例里的股东名与备注是数据不是文案, 用同一把尺子量会假阳性。
node scripts/ownership.mjs tests/fixtures/ownership-en.json --lang en-US > "$TMP/own-en.md" 2> "$TMP/own-en.err"
expect_eq "股权脚本英文输出退出码" 0 "$?"
LEAK2=$(grep -c -P '[\x{4e00}-\x{9fa5}]' "$TMP/own-en.md" || true)
expect_eq "股权脚本英文输出零中文" 0 "$LEAK2"
if grep -q '^## 8\. ' "$TMP/own-en.md"; then ok "股权脚本英文节号用阿拉伯数字"; else ng "股权脚本英文节号未本地化"; fi
if grep -q '^## 八、' "$TMP/own-en.md"; then ng "股权脚本英文输出出现中文节号"; else ok "股权脚本英文输出无中文节号"; fi
# 币种符号与量级词正交: 美元输入必须是 $30M, 不能是「3000 万」
if grep -q '| 1 | note | \$30M |' "$TMP/own-en.md"; then ok "英文金额跟随币种与量级"; else ng "英文金额未按币种/量级格式化"; fi

# 条件节缺失时不许让后面的节号前移(原来 secNo 自增, 缺一节就整体错位且不报错)
cat > "$TMP/own-min.json" <<'JSON'
{"meta":{"as_of":"2026-01-31","currency":"USD"},
 "cap_table":[{"holder":"Founder A","type":"founder","pct":60,"voting_pct":60,"board_seats":2},
              {"holder":"Fund Z","type":"fund","pct":40,"voting_pct":40,"board_seats":1}],
 "terms":{"board":{"founder":2,"investor":1,"independent":0}},"financials":{"cash":5000000}}
JSON
node scripts/ownership.mjs "$TMP/own-min.json" > "$TMP/own-min.md" 2>&1
SLOTS=$(grep -c '^## [一二三四五六七八]、' "$TMP/own-min.md")
expect_eq "缺条件节时八节仍在位" 8 "$SLOTS"
SKIPPED=$(grep -c '^> 本节不适用: ' "$TMP/own-min.md")
expect_eq "缺条件节留下不适用占位" 4 "$SKIPPED"
if grep -q '^## 八、结论与待补文件清单' "$TMP/own-min.md"; then ok "缺条件节时末节号不前移"; else ng "缺条件节导致节号错位"; fi

node scripts/ownership.mjs --print-defaults --lang en-US > "$TMP/own-def-en.json" 2>&1
if grep -q '"label": "Built-in defaults"' "$TMP/own-def-en.json"; then ok "打印参数集标签跟随语言"; else ng "打印参数集标签未本地化"; fi
# 中文侧不受影响: 标签仍是中文, 回灌后输出与 golden 逐字一致
node scripts/ownership.mjs --print-defaults > "$TMP/own-def.json"
node scripts/ownership.mjs examples/03-cap-table.json --config "$TMP/own-def.json" > "$TMP/own-rt2.md"
if diff -q "examples/03-output.md" "$TMP/own-rt2.md" > /dev/null; then ok "股权脚本默认参数往返仍等价"; else ng "股权脚本往返不等价"; fi

# 币种要打「实际生效」的那个, 不是 meta 里的字符串: meta 未写时按辖区取默认,
# 否则会出现「币种: CNY」而金额印成 $1M —— 两个数字都对, 合起来是错的
cat > "$TMP/own-us.json" <<'JSON'
{"meta":{"as_of":"2026-02-28"},
 "cap_table":[{"holder":"A","type":"founder","pct":100}],
 "convertibles":[{"type":"note","principal":30000000,"valuation_cap":900000000}],
 "terms":{"redemption_amount":1000000},"financials":{"cash":9000000}}
JSON
node scripts/ownership.mjs "$TMP/own-us.json" --lang en-US --jurisdiction us > "$TMP/own-us.md" 2>&1
if grep -q 'Currency: USD' "$TMP/own-us.md" && grep -q '| Redemption obligation | \$1M |' "$TMP/own-us.md"; then
  ok "辖区默认币种与金额符号一致"
else
  ng "辖区默认币种与金额符号不一致(标 CNY 却印 \$)"
fi
# 正交性反证: 中文 locale + 欧元辖区 → 量级词是「万」, 前缀是 EUR
node scripts/ownership.mjs "$TMP/own-us.json" --jurisdiction eu > "$TMP/own-eu.md" 2>&1
if grep -q '币种: EUR' "$TMP/own-eu.md" && grep -q '| 回购义务金额 | EUR 100 万 |' "$TMP/own-eu.md"; then
  ok "中文量级词与外币符号正交"
else
  ng "中文量级词与外币符号未正交"
fi

# 中文镜像必须是生成物且与源码同步(跨两个脚本, 由 tools/dump-catalog.mjs 合并)
if node tools/dump-catalog.mjs --check > /dev/null 2>&1; then ok "中文词表镜像与源码同步"; else ng "中文词表镜像与源码不同步(请运行 node tools/dump-catalog.mjs)"; fi

# ---------- 12. 报告章位的三方互锁 ----------
if node tests/sections.mjs > "$TMP/sections.log" 2>&1; then ok "章位三方互锁(注册表/模板/词表, 含尺子自检)"; else ng "章位三方互锁失败: $(head -3 "$TMP/sections.log" | tr '\n' ' ')"; fi
if node tools/gen-sections-lock.mjs --check > /dev/null 2>&1; then ok "章位锁文件未漂移"; else ng "章位锁文件已漂移(请运行 node tools/gen-sections-lock.mjs)"; fi
# 负向: 模板里改一个字, 必须 exit 2 —— 否则这套锁只能证明「文件存在」
sed 's/^## 四、致命红旗筛查/## 四、致命红旗检查/' assets/templates/report-template.md > "$TMP/tpl-mut.md"
node tools/gen-sections-lock.mjs --check --template "$TMP/tpl-mut.md" > /dev/null 2>&1
expect_eq "模板改一个字必须报错" 2 "$?"

# ---------- 13. 辖区档与金额格式化 ----------
# 辖区档是「同一件事在不同辖区本身就不一样」的唯一载体。这一组守三件事:
# 三份真档能过校验、坏档必被拦、以及 pending 不许被静默当成已知事实。
if node tests/money.mjs > "$TMP/money.log" 2>&1; then
  ok "金额向量表 $(grep -c OK "$TMP/money.log") 组全过(跨档进位/正交/负数/未知币种)"
else
  ng "金额向量不一致: $(grep FAIL "$TMP/money.log" | head -2 | tr '\n' ' ')"
fi
if node tests/jurisdictions.mjs > "$TMP/jd.log" 2>&1; then
  ok "辖区档判定 $(grep -c 'OK  ' "$TMP/jd.log") 组全过(12 份坏档各断言编号)"
else
  ng "辖区档判定失败: $(grep FAIL "$TMP/jd.log" | head -2 | tr '\n' ' ')"
fi

# 显式指定 cn 必须与默认档逐字一致: 否则「默认就是中国口径」这句话不成立
node scripts/dd_score.mjs examples/01-implant-class3.json --jurisdiction cn > "$TMP/cn-jd.md" 2>&1
if diff -q "examples/01-output.md" "$TMP/cn-jd.md" > /dev/null; then ok "显式 --jurisdiction cn 与默认档逐字一致"; else ng "显式 cn 档改变了输出"; fi

# P-06: 只做准入对照的档被请求评分时必须中止, 不能悄悄用别处阈值算出一个数
node scripts/dd_score.mjs examples/01-implant-class3.json --jurisdiction eu > /dev/null 2> "$TMP/eu.err"
expect_eq "admission_only 档评分退出码" 2 "$?"
if grep -q "准入对照" "$TMP/eu.err"; then ok "P-06 说明「只做准入对照」"; else ng "P-06 未说清原因"; fi

# P-07(隐含): 未知辖区必须中止并列出可用值, 否则会静默回落到内置目录
node scripts/dd_score.mjs examples/01-implant-class3.json --jurisdiction jp > /dev/null 2> "$TMP/jp.err"
expect_eq "未知辖区退出码" 2 "$?"
if grep -q "P-02.*未知辖区" "$TMP/jp.err"; then ok "未知辖区报 P-02 并列出可用值"; else ng "未知辖区未报 P-02"; fi

# us 档: 收入倍数边界 pending → 估值节出拒答行, 且该缺口进第七章
node scripts/dd_score.mjs examples/01-implant-class3.json --jurisdiction us > "$TMP/us.md" 2>&1
if grep -q '^> 拒答: 本辖区(us)的收入倍数档边界未核实' "$TMP/us.md"; then ok "us 档 pending 出估值拒答行"; else ng "us 档 pending 仍出了倍数判读"; fi
if grep -q '| 辖区档 \$.rev_mult 未核实: 收入档边界 | 辖区档门槛 | assets/jurisdictions/us.json |' "$TMP/us.md"; then
  ok "pending 项同时列入证据缺口(拒答行里的指引成立)"
else
  ng "pending 项未列入缺口: 拒答行说「已列入第七章」而第七章没有"
fi
# us 档不许出现中国的法定阈值: 那等于把 66.67% 当成美国常识
if grep -q '66.67%' "$TMP/us.md"; then ng "us 档里出现了中国法定阈值"; else ok "us 档不含中国法定阈值"; fi
node scripts/ownership.mjs examples/03-cap-table.json --jurisdiction us > "$TMP/own-usjd.md" 2>&1
if grep -q '控制线由公司章程与投资人协议约定' "$TMP/own-usjd.md"; then ok "us 档控制线改为章程约定(不是「未达任何线」)"; else ng "us 档控制线表述不对"; fi
if grep -q '66.67%' "$TMP/own-usjd.md"; then ng "us 档股权报告里出现了中国法定阈值"; else ok "us 档股权报告不含中国法定阈值"; fi

# P-05 的渲染侧: 阈值有数值但 status=pending 时, 数值不得当事实印出来。
# 这条只能用坏档实测 —— 校验器本身是对的, 缺陷在渲染层, 单测看不见。
mkdir -p "$TMP/profiles"
node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("assets/jurisdictions/cn.json", "utf8"));
p.control_lines.status = "pending";
fs.writeFileSync(process.argv[1] + "/profiles/cn.json", JSON.stringify(p, null, 2));
' "$TMP"
node scripts/ownership.mjs examples/03-cap-table.json --profiles "$TMP/profiles" > "$TMP/own-pend.md" 2> "$TMP/own-pend.err"
expect_eq "pending 阈值不中止运行" 0 "$?"
if grep -q '^> 拒答: 本辖区(cn)的控制线阈值未核实' "$TMP/own-pend.md"; then ok "pending 阈值改出拒答行"; else ng "pending 阈值未出拒答行"; fi
if grep -q '对应控制线' "$TMP/own-pend.md"; then ng "pending 阈值仍被当已知事实列出"; else ok "pending 阈值未被当已知事实列出"; fi

node scripts/ownership.mjs examples/03-cap-table.json --profiles "$TMP/nope" > /dev/null 2>&1
expect_eq "--profiles 目录不存在退出码" 2 "$?"

echo
if [ "$FAIL" -eq 0 ]; then echo "全部通过"; else echo "存在失败项"; fi
exit "$FAIL"
