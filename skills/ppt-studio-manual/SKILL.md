---
name: ppt-studio-manual
description: PPT 工作室（dsh-ppt-studio）答疑手册——**只在用户提问时加载**：用户问"这个插件怎么用/XX 怎么写/为什么报错/怎么只改一页/有没有单页版"时，在这里找条款回答。**制作任务进行中不要加载本手册**（正在做 PPT 而只是自己不确定写法时，`ppt_schema` / `ppt_check` / `ppt_verify` 的输出才是权威）。
whenToUse: 用户消息里出现用法、语法、报错、最佳实践一类的**提问**（或用户说"报错了/不生效/怎么用"需要定位原因）时加载。反之——正在定纲、写页面、审阅、导出，只是自己拿不准某个 DSL 写法或工具语义时，**不要加载**，改调 `ppt_schema`（DSL 速查）/ `ppt_check` / `ppt_verify`。
---

# PPT 工作室 · 提问式手册

> **本手册只服务"用户提问"**：用户问怎么用 / 怎么写 / 为什么报错时读它。
> **制作任务进行中不要读它**——正在做 PPT 而只是自己不确定写法时，直接调
> `ppt_schema`（DSL 权威速查）/ `ppt_check` / `ppt_verify`，它们的输出比本手册更准（本手册可能落后于源码）。
>
> 本手册是对应 README 的"问答版"。回答用户问题前先在这里找到对应条款；
> 拿不准细节（字段枚举、报错措辞）时，让用户/调用 `ppt_schema` 或 `ppt_check` 获得权威输出。

## 1. 一句话定位

DSH 上做 PPT 的工作区：说需求 → 四类任务工作流 → 「数字门禁 + 视觉审阅 + 真渲染复核」三轨保证质量 → 交付可编辑 .pptx + 中间层工程。核心不变量：**元素区块冲突（重叠/出界/溢出）必须被机器防住；设计意图用声明制表达。**

**同级还有三本制作手册**（同样按需加载，都不改门禁与铁律）：`ppt-studio-craft`（叙事与版式：页序、结论式标题、按内容量选构图）、`ppt-studio-data`（图表与数据：选型、成品标签补齐、口径与来源）、`ppt-studio-copy`（中文文案：标题/要点写法、成组 AI 味信号、before→after）。本手册管"这个插件怎么用"，那三本管"怎么做好"。

## 2. 用户常见问题速查

| 用户问 | 答 |
|---|---|
| "先帮我做个 PPT" | 问一句主题+页数即可（工作流自动进入；"帮我做一个 5 页的产品介绍 PPT"这类带修饰语的说法也认得）；建议先 `ppt_new` 立骨架或选模板 |
| "工作流怎么没自动进入 / 手册哪儿来的" | 进入靠语义判据（名词+任务动词邻近共现；只提一句 PPT 不激活），也可 `/ppt on` 强制；本手册由插件**内嵌注册**（跟着插件走，PPT 会话内即时生效），安装器另把它镜像到 `<dshHome>/skills/` 供非 PPT 会话查阅——让模型调 `ppt_state`，看 `manualSkill.visible` 即知当前通道 |
| "你想看模板吗" | `ppt_templates` 展示；用户模板文件 > 内置模板 > 从零定调 |
| "怎么装/怎么升级这个插件" | **一键（推荐）**：`dsh plugin --profile web add <Releases 页面上的资产 URL>`（profile 级，装完即挂载，**不需要 npm 账号**；装完重启 dsh web）。**升级必须换更新的 URL，但不需要先卸载**——资产名 = `版本-构建时间-构建戳`（页面保留历次构建，取**时间最新**那条），同一 URL 覆盖内容后包管理器不会重取（实测）。备选：`node scripts/install.mjs` + 预设行（会话级，带"PPT 工作室"预设）。**别同时用**：会挂两次（插件有防重、不会崩，但按纪律二选一）。排查：`dsh plugin --profile web list` → `dsh --profile web --dump-config` 找 `ppt-studio` 行 → 重启 |
| "怎么只改原稿第 15 页" | `ppt_import` 读真身 → 改工作区页（verify 清零）→ `ppt_splice`（替换进源，其余页 SHA256 逐字节不变）→ 可选 `ppt_slice` 单页版 → `ppt_visual pages="15"` 抽查 |
| "为什么报重叠错误，我明明想要这样" | design-intent 声明制：把有意重叠对加入该页 `expectedOverlaps`（流式 `[{pair: [a,b]}]` 或块式 `- pair: [a,b]`，每对一行），重验即 ✓；说不清意图的对子改布局；**内容互压（文字×文字）永远不能声明** |
| "样式没生效" | 样式键必须在 `content` 内部（元素级 fontSize/color/bold/... 无效，`ppt_check` 现在会直接报错） |
| "字号可以 11pt 吗" | **可以**（下限 = 用户指令）：用户给了下限（如"不得小于14号"）→ 写入 theme.minFontSize 并严格遵守；用户没给 → 不设任何强制下限（插件无默认）。 |
| "为什么导出会缩字" | verify 已报溢出 → 先清零（扩容器/精简文案/显式 `\n`）；verify 通过 ⇒ 导出不缩字 |
| "预览链接 404" | 路由在 PPT 工作室会话挂载时注册——确认当前是 PPT 工作室会话（不是默认会话） |
| "图表能画什么" | bar/line/pie（矢量拼绘）；python-pptx 兜底引擎降级表格；复杂图表用图片或 Shape 拼 |
| "用别人的模板做" | `ppt_import`（带参考层：source.pptx + 真渲染整页 + 全量色板）→ 先 read_image 看 `reference/previews/*.png` 真身再动手 |
| "要 100% 像模板" | `ppt_patch`（手术模式：只换文字/表格内容，XML 原样） |
| "网页预览对，打开 pptx 线条不对" | 旧引擎三个连线编码 bug（四个症状：斜线镜像 / × 少一笔 / 箭头消失 / 水平线变斜），**均已修复**——看 `ppt_export` 报告的"线方向 N/N"自证；修复前导出的产物重新 `ppt_export` |
| "表格在 PowerPoint 里空白" | 旧引擎 graphicFrame 结构 bug，**已修复**；parity 回读（表 N/N）自证；旧产物重导 |

## 3. DSL 快速参考（写页面时对照）

- 工程：`deck.yaml` + `pages/*.yaml` + `media/`；1px=1pt，原点左上；默认 960×540。
- `theme`：`colors {name: hex}`、`textStyles {name: {fontSize,color,bold,fontFamily,align,lineHeight,wrap}}`、`safeArea`、`minFontSize`（用户给出字号下限时设置；缺省无强制下限）、`themeConformance: strict|suggest|off`。
- 元素通用：`elementId`（页内唯一）、`elementType: text|shape|line|image|table|chart`、`bounds: [x,y,w,h]`（line 可省，由 points 推导）、`role: background|content|decoration`。
- text：`content: {text, style: "$name" 或内联样式键}`；**样式键必须在 content 内**。
- shape：`kind: rect|roundRect|ellipse|triangle + prst(箭头/菱形/五边形/flowchart…) + custGeom path`；`fill #hex | {color,alpha} | {type: gradient, stops: [{pos,color,alpha}], angle}`；`line {color,width}`；`rotation`。
- line：`points: [[x1,y1],[x2,y2]]`（**每条只有两点**，多点折线不支持——时间轴/折线拆成首尾相接的多条 line）；`arrow: true`（箭头在第二个点那一端）。
- image：`src: "media/xx.png"`；`fit: cover|contain|fill`。
- table：`cols: [列名...]`、`rows: [[..]]`、`header: true|false`。
- chart：`chart: {type: bar|line|pie, data: {cols: [列名…], rows: [[…]]}, series: [{name,x,y}]（多系列时显式写）, colors}`。
  **`data` 只认 `cols` + `rows` 两件**（写成 `data: [{label, value}]` 会被 schema 直接拒绝）；单列 pairs 兼容（`cols: [分类]` + `rows: [[类, 值]]` 自动补"值"列），**推荐宽表** `cols: [分类, 值]`。
  chart 里**没有**分类名/数值/单位/图例字段——那些要自己用 `text` 元素补（见 `ppt-studio-data` §2）。
- 页面级：`pageType`、`background`、`safeArea`（页面级覆盖主题）、`notes`（讲稿文本 → **导出为 pptx 备注页**；多行用 `notes: |` 块标量；没有 `notes` 的页不产生任何备注部件）。
- 声明：`expectedOverlaps: [{pair: [a,b]}]`；出界：`expectedOutOfSafeArea: [idA]`；对比度豁免：`contrastExempt: [id]`；`source: "依据标注"`（数据核查表）；`overlapMode: declared|lenient`。

## 4. 质量门禁（答复"为什么还要改"的依据）

- ERROR 必须清零：`unexpected-overlap`（未声明重叠：修布局或补声明）、`content-collision`（文字/表格/图表互压，永远不可声明）、`out-of-page`（超**页面边界**不可声明；超**安全区**可声明——同一个 code，message 里写的是"超出页面安全区"）、`text-overflow`（扩容器/精简文案；缩字下限按用户指令，未给则 max(6pt, 60% 原字号) 保底防荒谬）、`theme-conformance`（strict 档默认开：元素颜色必须 ∈ `theme.colors` 或中性灰）、`measured-overflow`（M2 实测交叉：实测=终审，估算漏报也会报错）、`measured-unpaired`（M2 两档页号对不上：多为旧版 `measured.json` 或测量后又增删了页面——**重新跑一次 `ppt_measure` 即可**；契约破坏会报错而不是静默跳过）。
- 声明命中显示为 ✓ 预期重叠/✓ 预期出界（确认，不算错误）。
- 报告里的标记：`[✗]` 错误（进 `门禁：N 个错误` 计数）、`[~]` 警告（进页头"N 警告"，不入门禁）、`[·]` 建议（美学层）。`[⚠]` 不是主清单的警告标记——它只出现在 M2 实测交叉段和其它提示行。
- `[·]` 建议（美学/对比度/孤字/长句/网格/贴边）**永不是门禁**，但逐条斟酌；`density`/`hotspot`/`near-align` 是 `[~]` 警告（同样不入门禁计数，但先看它们）。
- 三层审阅节奏：`ppt_verify`（数）→ `ppt_shot`+读图（视）→ `ppt_visual`（Office 真，有条件时）；audit 档禁 autoDeclare、导出自动回读断言 + 自动真渲染。
- 一键声明：`ppt_verify autoDeclare=true`——只处理警告级；写入后必须附"声明清单 + 每对一句意图"（说不清意图的对子改布局）。

## 5. 交付路径（按场景）

| 场景 | 路径 |
|---|---|
| 从头做 | 模板/定调 → 逐页 → export（缺省 pptd）→ 交付说明 |
| 快速交付 | `/ppt quick`：≤8 页（用户指定除外）、文本 ≤40 字/块（用户要求可放宽）、跳视觉审阅（交付标注"未经视觉审阅"） |
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

- 改码：`src/` → `node scripts/build.mjs` → **重启 host**（插件经 agent preset 会话装配；`dev_reload_package` 只覆盖注入器装配包，且注入器 junction 已存在时会指向旧安装根）。
- 回归：`node scripts/smoke.mjs`（222 断言）→ `node scripts/preflight-1.0.mjs`（发布预检）→ `node scripts/regression-real.mjs`。
- 跨层验证纪律：**预览层与成品层必须互相验证**——`ppt_render`+`ppt_verify` 只管 HTML/估算层，OOXML 层靠 `ppt_export` 的 parity 自证（表/图/线方向）+ `ppt_visual` 真渲染抽检；只跑单层会漏掉"预览对、成品错"（2026-09-14 连线方向事故）。
- 文档链：改需求/决策 → docs/01；改机制 → docs/02；每次 → docs/03；验收 → docs/04；发布前 → docs/06。
- 装配：**标准装法是 profile bundle 行**（`dsh plugin --profile <p> add <Releases 资产 URL>`，profile 级、随 profile 启动装配）；preset 插件行只用于"离线 junction / 不想动 profile"场景，且与前者**互斥**（`scripts/install.mjs` 按环境二选一，检测到 bundle 安装会主动删掉 preset 行——手工删行会被下次同步装回来，所以互斥逻辑在安装器里）。排查：`dsh plugin --profile web list` → `dsh --profile web --dump-config` 找 `ppt-studio` 行 → 重启 `dsh web`。
- 宿主升级（DSH 换版本）：本手册 §开发维护 与 docs/05「宿主升级纪律」——契约逐项 Inspect 核对 + headless 覆盖层真进程验证，别只看单测。
