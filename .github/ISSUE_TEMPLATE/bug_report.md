name: 缺陷报告
description: 脚本报错、输出异常、编号或路径对不上
title: "[Bug] "
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: |
        感谢反馈。请勿粘贴真实标的的未公开信息; 复现数据请脱敏, 或直接使用 `examples/` 下的示例改造后用 `examples/` 的格式贴出。

  - type: dropdown
    id: area
    attributes:
      label: 涉及部分
      options:
        - scripts/dd_score.mjs
        - scripts/ownership.mjs
        - references(内容与编号)
        - assets/schema(输入契约)
        - assets/templates(报告模板)
        - 文档与链接
        - 其他
    validations:
      required: true

  - type: textarea
    id: what-happened
    attributes:
      label: 现象
      description: 你期望的结果与实际结果分别是什么。
      placeholder: |
        期望: ...
        实际: ...
    validations:
      required: true

  - type: textarea
    id: repro
    attributes:
      label: 复现步骤
      description: 命令与原样输出。若涉及输入数据, 贴出最小的脱敏 JSON。
      placeholder: |
        ```bash
        node scripts/dd_score.mjs examples/01-implant-class3.json
        ```
    validations:
      required: true

  - type: input
    id: version
    attributes:
      label: 版本与环境
      placeholder: "v0.1.0 / Node 22.x / Windows 11"
    validations:
      required: true

  - type: checkboxes
    id: checks
    attributes:
      label: 确认
      options:
        - label: 我已确认输入数据为脱敏或虚构数据
          required: true
        - label: 我已尝试运行 `--example` 对照, 且问题在示例模式下同样存在(或不适用)
