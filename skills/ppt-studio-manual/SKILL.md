---
name: ppt-studio-manual
description: PPT 工作室（dsh-ppt-studio）使用手册——按问题查阅：如何开始/四类任务/DSL 语法速查/重叠声明与门禁/只改原稿某一页（splice）/单页版/贴模板/常见报错处理。用户问"这个 PPT 插件怎么用/XX 怎么写/为什么报错"时加载。
whenToUse: 用户处于 PPT 工作室且询问用法、语法、报错原因、最佳实践；或模型不确定某一 DSL 写法/工具语义/交付路径时。
---

# PPT 工作室 · 提问式手册

> 本手册是对应 README 的"问答版"。回答用户问题前先在这里找到对应条款；
> 拿不准细节（字段枚举、报错措辞）时，让用户/调用 `ppt_schema` 或 `ppt_check` 获得权威输出。

## 1. 一句话定位

DSH 上做 PPT 的工作区：说需求 → 四类任务工作流 → 「数字门禁 + 视觉审阅 + 真渲染复核」三轨保证质量 → 交付可编辑 .pptx + 中间层工程。核心不变量：**元素区块冲突（重叠/出界/溢出）必须被机器防住；设计意图用声明制表达。**

## 2. 用户常见问题速查

| 用户问 | 答 |
|---|---|
| "先帮我做个 PPT" | 问一句主题+页数即可（工作流自动进入）；建议先 `ppt_new` 立骨架或选模板 |
| "你想看模板吗" | `ppt_templates` 展示；用户模板文件 > 内置模板 > 从零定调 |
| "怎么只改原稿第 15 页" | `ppt_import` 读真身 → 改工作区页（verify 清零）→ `ppt_splice`（替换进源，其余页 SHA256 逐字节不变）→ 可选 `ppt_slice` 单页版 → `ppt_visual pages="15"` 抽查 |
| "为什么报重叠错误，我明明想要这样" | design-intent 声明制：把有意重叠对加入该页 `expectedOverlaps`（流式 `[{pair: [a,b]}]` 或块式 `- pair: [a,b]`，每对一行），重验即 ✓；说不清意图的对子改布局；**内容互压（文字×文字）永远不能声明** |
| "样式没生效" | 样式键必须在 `content` 内部（元素级 fontSize/color/bold/... 无效，`ppt_check` 现在会直接报错） |
| "字号可以 11pt 吗" | 不可（默认铁律 12pt；`theme.minFontSize` 可调但导出缩字不会低于它；到下限仍溢出会明确报 ✗） |
| "为什么导出会缩字" | verify 已报溢出 → 先清零（扩容器/精简文案/显式 `\n`）；verify 通过 ⇒ 导出不缩字 |
| "预览链接 404" | 路由在 PPT 工作室会话挂载时注册——确认当前是 PPT 工作室会话（不是默认会话） |
| "图表能画什么" | bar/line/pie（矢量拼绘）；python-pptx 兜底引擎降级表格；复杂图表用图片或 Shape 拼 |
| "用别人的模板做" | `ppt_import`（带参考层：source.pptx + 真渲染整页 + 全量色板）→ 先 read_image 看 `reference/previews/*.png` 真身再动手 |
| "要 100% 像模板" | `ppt_patch`（手术模式：只换文字/表格内容，XML 原样） |

## 3. DSL 快速参考（写页面时对照）

- 工程：`deck.yaml` + `pages/*.yaml` + `media/`；1px=1pt，原点左上；默认 960×540。
- `theme`：`colors {name: hex}`、`textStyles {name: {fontSize,color,bold,fontFamily,align,lineHeight,wrap}}`、`safeArea`、`minFontSize`（默认12）、`themeConformance: strict|suggest|off`。
- 元素通用：`elementId`（页内唯一）、`elementType: text|shape|line|image|table|chart`、`bounds: [x,y,w,h]`（line 可省，由 points 推导）、`role: background|content|decoration`。
- text：`content: {text, style: "$name" 或内联样式键}`；**样式键必须在 content 内**。
- shape：`kind: rect|roundRect|ellipse|triangle + prst(箭头/菱形/五边形/flowchart…) + custGeom path`；`fill #hex | {color,alpha} | {type: gradient, stops: [{pos,color,alpha}], angle}`；`line {color,width}`；`rotation`。
- line：`points: [[x1,y1],[x2,y2]]`；`arrow: true`。
- image：`src: "media/xx.png"`；`fit: cover|contain|fill`。
- table：`cols: [列名...]`、`rows: [[..]]`、`header: true|false`。
- chart：`type: bar|line|pie`、`data: [{label, value...}]`、`cols`（宽表）、`colors`（可选 $ref 数组）。
- 声明：`expectedOverlaps: [{pair: [a,b]}]`；出界：`expectedOutOfSafeArea: [idA]`；对比度豁免：`contrastExempt: [id]`；`source: "依据标注"`（数据核查表）；`overlapMode: declared|lenient`。

## 4. 质量门禁（答复"为什么还要改"的依据）

- ERROR 必须清零：`overlap 未声明`（修布局或补声明）、`content-collision`（永远不可声明）、`out-of-page 超页面`（不可声明）、`out-of-safe-area 未声明`（有意则声明）、`text-overflow`（扩容器/缩字到≥12pt 或精简）。
- 声明命中显示为 ✓ 预期重叠/✓ 预期出界（确认，不算错误）。
- `[·]` 建议（美学/对比度/孤字/密度/near-align）永不是门禁，但逐条斟酌。
- 三层审阅节奏：`ppt_verify`（数）→ `ppt_shot`+读图（视）→ `ppt_visual`（Office 真，有条件时）；audit 档禁 autoDeclare、导出自动回读断言 + 自动真渲染。
- 一键声明：`ppt_verify autoDeclare=true`——只处理警告级；写入后必须附"声明清单 + 每对一句意图"（说不清意图的对子改布局）。

## 5. 交付路径（按场景）

| 场景 | 路径 |
|---|---|
| 从头做 | 模板/定调 → 逐页 → export（缺省 pptd）→ 交付说明 |
| 快速交付 | `/ppt quick`：≤8 页、≤40 字/块、跳视觉审阅（交付标注"未经视觉审阅"） |
| 改整个原稿 | import 全稿 → 逐页改 → export（注意：近似稿整册重渲会伤其余页——若非全部重做，用下一行） |
| 只改原稿某页 | import → 改该页 → `ppt_splice`（只替换这页进源）→ 可选 `ppt_slice` |
| 贴模板 | `ppt_patch`（模板为底版，文本/表格槽替换） |
| 加页 | 复制母版去 `_` + 注册 deck.pages，或新写页 |
| 总结 | import 全稿 → 提炼重排 → export |

交付说明必须含：素材来源、未经视觉审阅项（如有）、修改指引；重要数字页给 `ppt_crosscheck` 的数据来源核查表。

## 6. 常见报错与解法

| 报错 | 解法 |
|---|---|
| `Unexpected seq-item-ind token` | YAML 一行写了多个 `- {pair: ...}` → 每对一行 |
| `样式键 ... 写在元素级` | 把 fontSize/color/bold 等移进 `content: {}` |
| `"x" 不是本页元素 id`（声明/豁免类） | 防呆：声明必须指向真实元素（查 elementId 拼写、该页是否注册） |
| `YAML 解析失败：...` | 常见笔误：flow 项拆行；缩进层面检查 |
| `theme-conformance 颜色出板` | 颜色加入 theme.colors（或中性灰）；导入工程的全量色板已内置 |
| `autoDeclare 被禁` | audit 质量档（C2 决定）：切回 standard，或逐对手工声明 |
| `pptd 失败 + python-pptx 兜底失败` | 看新报告的 exit code/stderr；多半是环境（python 缺失/媒体占位）——有媒体缺失会提示 |
| 预览 404 | 进 PPT 工作室会话（路由随会话挂载注册） |
| Office 渲染"文件或目录损坏" | 产物经 zip 手术时校验 rels/Content_Types（splice/slice 已自证）；手工改过 OOXML 时用 `ppt_visual` 验证 |

## 7. 开发维护（仅改插件时用）

- 改码：`src/` → `node scripts/build.mjs` → **重启 host**（插件经 agent preset 会话装配；`dev_reload_package` 只覆盖注入器装配包）。
- 回归：`node scripts/smoke.mjs`（139 断言）→ `node scripts/preflight-1.0.mjs`（发布预检）→ `node scripts/regression-real.mjs`。
- 文档链：改需求/决策 → docs/01；改机制 → docs/02；每次 → docs/03；验收 → docs/04；发布前 → docs/06。
- 装配：preset 行是唯一装配源；junction 保留（preset 解析包名用）。
