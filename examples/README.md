# 示例

三组**完全虚构**的脱敏输入, 用于演示输入格式、输出结构与判定逻辑。所有公司名、人员、金额、临床数据均为编制示例所虚构, 与任何真实企业无关, 不得作为可比交易或估值参照。

| 文件 | 内容 | 用来演示什么 |
|---|---|---|
| `01-implant-class3.json` | 植入式三类, B 轮后, 里程碑走到 L4 在途 | 医疗级资产的完整九维流程; 跑道 20 个月覆盖不了 L4 的 32.4 个月典型耗时, 结论被里程基金句压到「有条件通过」 |
| `02-consumer-eeg.json` | 消费级脑电头环, pre-A | 门禁的降级机制: `closed_loop: false` 把资产从「消费级非器械」降级为「单向监测」, 期权法被禁用; 6.8 亿投后对 4200 万收入的隐含 P/S 16.2 触发口径错配告警 |
| `03-cap-table.json` | 高校成果转化型股权结构 | 权属链五节点缺 N3 与 N5、无书面代持、创始人个人连带、回购压力、控制权在下一轮跌破 50% |
| `01-output.md` / `02-output.md` / `03-output.md` | 由脚本真实生成的输出 | 报告模板第一至八章应粘贴的原始材料 |

## 重新生成

```bash
node scripts/dd_score.mjs examples/01-implant-class3.json  > examples/01-output.md
node scripts/dd_score.mjs examples/02-consumer-eeg.json    > examples/02-output.md
node scripts/ownership.mjs examples/03-cap-table.json      > examples/03-output.md
```

输出只依赖输入与脚本版本, 不含时间戳外的随机因素。若重新生成后与仓库内文件不一致, 说明脚本或输入有改动, 请在 PR 中一并更新。`bash tests/run.sh` 会逐字比对这三份文件, CI 亦同。

## 参数集示例

本目录的三份输出都用**内置默认参数**生成 —— 也就是说, 它们演示的是方法与结构, 不是任何一家机构的真实口径。要看参数集注入的效果, 用 `tests/fixtures/config-override.json`(夹具, 数值全部虚构):

```bash
node scripts/dd_score.mjs examples/01-implant-class3.json --config tests/fixtures/config-override.json
```

覆盖生效后, banner 会多出一段 `| params: fixture-override@<hash8>`, 「输入概要」后也会多一段 `### 参数口径与溯源`。这两处出现与否, 是判断「这一份报告到底用了哪套尺子」的唯一依据。

## 怎么读

1. **先看第二节(里程碑)与第五节(跑道)。** 这两节决定时间与钱能不能对上, 是长周期赛道最先出问题的地方。
2. **再看第四节(红旗)。** 一票否决项只要有一条 open, 后面的分数就不必讨论。
3. **最后看第六节(估值口径)。** 它给的是「隐含倍数相对所在档区间的位置」, 不是价格结论。倍数区间是结构示意参数, 换市场、换口径都要重新校准。
4. **`## 警告` 段必读。** 输入里每一个缺失字段都会在这里现身, 并带主体名与具体数值。警告数量多不代表项目差, 只代表「还没看完」。

## 填入自己的数据

1. 复制 `01-implant-class3.json`, 按 `assets/schema/dd-score.schema.json` 逐字段替换。
2. 填不出的字段直接删掉或留空 —— 留空会产生警告, 编数字会产生错误结论。
3. 九维 `score` 用 0-100, 标尺见 `references/sourcing-rules.md`; 每个维度至少给一条带 `source` 的 `evidence`, 否则分数无法追溯。
4. `redflags` 的 `id` 必须是 `RF-01` 至 `RF-44`。编号与现象的对应关系见 `references/red-flags.md`, 脚本内置同一份库, 填错编号会告警。
5. 股权部分单独填 `03-cap-table.json` 的结构, 与评分输入分开运行。
