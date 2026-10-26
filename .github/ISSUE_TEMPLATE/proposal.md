name: 内容或方法建议
description: 补充检查项、修正监管事实、贡献可复算参数
title: "[Proposal] "
labels: ["enhancement"]
body:
  - type: markdown
    attributes:
      value: |
        本框架对「新增内容」有三条硬要求, 不满足的提议会被退回:

        1. **数字须带来源。** 任何外部事实必须给出发布日与访问日, 按 `references/sources.md` 的登记格式提交; 媒体口径只能进「待核区」。
        2. **编号须连续。** 新增红旗从 RF-45 起顺延; 新增检查项在该维度内顺延。**不得**重排已有编号, 因为编号是脚本、分片与报告模板三方共用的契约。
        3. **不得构成投资建议。** 不写目标价、收益率预测、回报承诺, 不指名批评具体机构。

  - type: dropdown
    id: kind
    attributes:
      label: 提议类型
      options:
        - 新增检查项
        - 修正或补充监管 / 标准事实
        - 新增或修正红旗
        - 贡献可复算参数(权重 / 倍数区间 / 里程碑耗时)
        - 新增脚本能力
        - 新增脱敏案例
        - 文档与结构改进
    validations:
      required: true

  - type: textarea
    id: gap
    attributes:
      label: 现有框架的缺口
      description: 这个提议解决了什么具体的判断错误? 请给出场景, 不要只写「不够全面」。
    validations:
      required: true

  - type: textarea
    id: proposal
    attributes:
      label: 具体方案
      description: 建议的条目文本、归属维度/红旗编号、判定规则。若涉及参数, 给出取值与依据。
    validations:
      required: true

  - type: textarea
    id: sources
    attributes:
      label: 来源
      description: 每条事实一行, 格式为「主张 | 来源 | 级别 | 发布日 | 访问日」。访谈与自述级来源请注明。
    validations:
      required: false
