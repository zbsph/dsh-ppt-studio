# @dsh-external/dsh-ppt-studio — PPT 工作室（v1.0.0）

在 DeepSeek Harness 上做一个 PPT 的完整工作区：**DSH 里说需求 → 插件做 PPT → 可验证地交付**。
配套 agent preset「PPT 工作室」（= standard 全量功能 + 本插件行），四类任务（从头 / 补完 / 修改 / 总结）共用同一个 PPTD 中间层，质量由「数字门禁 + 视觉审阅 + 真渲染复核」三轨保证。

> **新手不用读完本文档**：进入 PPT 工作室后直接说需求（如"帮我做一个 10 页的年度总结 PPT"），工作流会引导你；语法细节问模型即可（模型内置本手册 skill —— 你可以直接问"expectedOverlaps 怎么写"、"怎么只改原稿的某一页"）。

---

## 目录

0. [安装与上手（新用户：从下载到可用）](#0-安装与上手新用户从下载到可用)
1. [快速开始](#1-快速开始)
2. [四类任务与工作流](#2-四类任务与工作流)
3. [工具面全表](#3-工具面全表)
4. [PPTD 中间层（deck.yaml）](#4-pptd-中间层deckyaml)
5. [质量门禁体系（为什么不会元素打架）](#5-质量门禁体系为什么不会元素打架)
6. [保真与贴模板（三重通道）](#6-保真与贴模板三重通道)
7. [内置模板库](#7-内置模板库)
8. [常见问题 FAQ](#8-常见问题-faq)
9. [环境与能力边界](#9-环境与能力边界)
10. [开发与维护（给改插件的人）](#10-开发与维护给改插件的人)

---

## 0. 安装与上手（新用户：从下载到可用）

### 0.1 前提

- **DSH（DeepSeek Harness）web 实例**已在本机运行（`dsh web`）；本插件是预设+插件形态，不改变 DSH 安装。
- 可选增强（没有也能用，自动降级）：本机 Microsoft Office（真渲染通道）、Edge/Chrome（截图与 M2 实测）、python + python-pptx（兜底引擎）。

### 0.2 方式 A：下载发布包（推荐）

1. 在本仓库 [Releases](https://github.com/zbsph/dsh-ppt-studio/releases) 页面下载 `dsh-external-dsh-ppt-studio-<版本>.tgz`（v1.0.0 起）。
2. 解压到任意目录（如 `D:\plugins\dsh-ppt-studio`）：
   ```powershell
   tar -xzf dsh-external-dsh-ppt-studio-1.0.0.tgz -C D:\plugins
   # 得到 D:\plugins\package\（内含 lib/ scripts/ agent-presets/ docs/ skills/ templates/）
   ```
3. **一键安装**（会做三件事：链包进 profile node_modules、保证 yaml 依赖、写入 PPT 工作室预设）：
   ```powershell
   node D:\plugins\package\scripts\install.mjs
   # 自定义 DSH_HOME 时：node ...\install.mjs --prefix <你的 .dsh 目录>
   # 重装/强制：--force；只装包不写预设（配合注入器）：--no-preset
   ```
   安装器是幂等的——重复运行自动跳过已存在项。
4. **重启 dsh web** → 会话左上角/预设切换器选择「**PPT 工作室**」→ 直接提需求。
5. 验证安装成功：在 PPT 工作室里说"帮我做一个简单 PPT，用内置模板"——模型应开始走 PPT 工作流；或直接问模型"dsh-ppt-studio 怎么用"（内置 skill 手册会回答）。

### 0.3 方式 B：git clone 源码（开发者/尝鲜）

```powershell
git clone https://github.com/dsh-external/dsh-ppt-studio.git
cd dsh-ppt-studio
npm install            # 仅需 yaml（本地开发依赖）
node scripts/build.mjs # 免 tsc：src → lib
node scripts/install.mjs
# 重启 dsh web → 进入「PPT 工作室」
```

### 0.4 方式 C：已有 dsh-super-injector（生态惯例）

在注入器环境内：`dev_inject_plugin <解压目录>`（或源码目录）→ 注入器负责 junction + 重启恢复；预设同上（仓库 `agent-presets/ppt/agent.cordis.yml` 复制到 `~/.dsh/.agent-presets/ppt/`，或让安装器写：`node scripts/install.mjs --prefix <DSH_HOME> --no-preset` 后手工放预设）。

### 0.5 安装后的自检（三句命令）

```powershell
node scripts/smoke.mjs          # 139 断言（含全链路）
node scripts/preflight-1.0.mjs  # 11 断言（坏输入/边界/幂等/性能）
node scripts/e2e-1.0.mjs        # 12 断言（真浏览器测量 + 真 Office 渲染 + splice/slice 自证；约 2-3 分钟）
```
全部绿色 = 本机环境完整可用；无 Office/Edge 的机器 e2e 会自动降级标注（不是失败）。

### 0.6 卸载

删除 `~/.dsh/.agent-presets/ppt/` 与 `~/.dsh/profiles/web/node_modules/@dsh-external/dsh-ppt-studio`（junction，删链接即可），重启 dsh web。

---

## 1. 快速开始

**三步交付**：

1. **进入 PPT 工作室**（agent 预设）——说需求。四类任务自动识别，也可 `/ppt` 命令面显式控制：
   ```
   /ppt quick        # 快速模式：低 token 快交付（质量底线不变）
   /ppt normal       # 完整模式：S0-S6 全流程（默认）
   /ppt quality audit  # 从严档：禁一键声明 + 强制视觉审阅 + 导出回读断言 + 自动真渲染审核
   /ppt template <id>    # 记录本会话默认模板
   /ppt help
   ```
2. **跟着工作流走**：S0 规格澄清 → S1 大纲 → S2 视觉定调（用内置模板或参考素材）→ S3 逐页制作 → S4 页审循环 → S5 整体审 → S6 导出交付。每页制作后自动跑 `ppt_render → ppt_verify → ppt_shot`。
3. **交付**：`.pptx`（默认 pptd 引擎）+ 中间层工程 + 交付说明；对话内可点 `ppt_preview` 链接直接看。**如果要改"已有精美 PPT 的某一页"：见 [第 6 节 splice](#6-保真与贴模板三重通道)。**

**最快试跑**：
```text
ppt_new(dir=D:\demo)                 # 一键生成可跑通全链路的示例工程（3 页，含全部范本）
ppt_render(D:\demo) → ppt_verify(D:\demo) → ppt_export(D:\demo)
```

---

## 2. 四类任务与工作流

| 类型 | 触发词 | 路径 | 交付 |
|---|---|---|---|
| **from-scratch 从头** | "做一个 XX 主题的 PPT" | 模板/定调 → 逐页制作 | 完整工程 + pptx |
| **augment 补完** | "补两页 / 加一个章节" | 默认可复用模板工作区；新增页 = 复制母版去 `_` 前缀 + 注册 deck.pages | 追加后的完整工程 + pptx（或 `ppt_splice` 进原稿） |
| **edit 修改** | "改第 15 页 / 美化这页" | `ppt_import` 读参考层真身 → 独立改该页 → **`ppt_splice` 替换回原稿** | 整册只变一页 + 单页版（`ppt_slice`） |
| **summarize 总结** | "把这 50 页总结成 10 页" | `ppt_import` 全稿 → 提炼 → 重排 | 新工程 + pptx |

> 任务识别是**语义路由**（明确 PPT 意图才进入工作流；只提一句无关话题不会误切）——非 PPT 需求行为与标准模式完全一致。

---

## 3. 工具面全表

**创作链**：

| 工具 | 用途 |
|---|---|
| `ppt_schema` | **语法速查**（deck.yaml / 元素 / 主题 token / 声明 / 安全区）——不熟 DSL 先调它 |
| `ppt_new` | 一键生成示例工程（现成范本：主题 token / 色块衬底声明 / safeArea / line 无 bounds 写法） |
| `ppt_check` | 结构校验（deck/页面 YAML、元素、主题引用 `$ref`、声明 id 防呆） |
| `ppt_render` | deck → `preview/*.html` + `layout.json`（数字审阅数据源）；`debug=true` 画安全区参考框 |
| `ppt_verify` | **数字审阅门禁**：重叠/出界/溢出/对齐/密度。`autoDeclare=true` 一键声明；`measured=true` 交叉实测档；`pages="2,5-7"` 局部审阅 |
| `ppt_shot` | Edge headless 截图 → PNG（视觉审阅；`index=N` 单页 / `overview=true` 整览） |
| `ppt_measure` | **M2 实测档**：浏览器真实排版测量（行盒/溢出/几何）→ `measured.json`；`ppt_verify measured=true` 交叉（实测=终审） |
| `ppt_crosscheck` | **M3 数据连贯**：跨页数字对账 + 数据来源核查表（交付说明用） |
| `ppt_preview` | 对话内预览：同源链接（整览+单页），用户点击即看 |

**输入链**：

| 工具 | 用途 |
|---|---|
| `ppt_import` | 任意 .pptx → deck 工程（内容保真 + 参考层：`source.pptx` 真相 + Office 真渲染整页 + theme 聚合） |
| `ppt_visual` | Office PPT COM 真渲染 → 逐页 PNG；`pages="15"` 只渲指定页（页号=源原页号） |
| `ppt_media` | 图片元数据（尺寸/格式，估算 media 用量） |

**交付链**：

| 工具 | 用途 |
|---|---|
| `ppt_export` | 导出 .pptx（`auto`=pptd 主引擎，硬失败自动回退 python-pptx 并醒目标注；`out` 支持绝对路径） |
| `ppt_patch` | **手术模式**：以模板 .pptx 为底版贴内容（只改文本/表格 `<a:t>`，样式/几何/图片原样保留；未动页 sha256 验证） |
| `ppt_splice` | **替换进原稿**：工作区某页替换进源 .pptx（保留母版横幅/页脚/备注/媒体；其余页条目 SHA256 逐字节一致——自动自证） |
| `ppt_slice` | **单页版**：从 .pptx 修剪出"单页 + 完整母版/布局/主题"独立文件 |

**状态链**：`ppt_status`（工作流状态）/ `ppt_state`（会话状态）/ `ppt_templates`（模板清单）/ `/ppt` 命令面。

---

## 4. PPTD 中间层（deck.yaml）

**唯一事实源**：`deck.yaml` + `pages/*.yaml` + `media/`。导出/渲染/校验共用，1px = 1pt，原点左上，默认尺寸 960×540（约 10 英寸 × 5.63 英寸）。

```yaml
version: 1
title: 我的演示
size: [960, 540]              # 或 {width, height}
theme:                        # 样式只在 theme 定义元素引用 token；新增风格先改这
  colors: {primary: "#2563EB", ink: "#1F2937"}
  textStyles: {title: {fontSize: 32, color: "$ink", bold: true}, body: {fontSize: 16, color: "$ink"}}
  safeArea: {top: 20, bottom: 20}   # 可选：模板背景非内容区（logo/页眉页脚带）
  minFontSize: 12             # 可选：导出 auto-fit 缩字下限（默认 12；中文最小 12pt 铁律）
pages:
  - pages/01_cover.yaml
```

页面元素（`pages/01_cover.yaml`）：
```yaml
pageType: cover
background: "#F5F6F7"         # hex / $themeRef / {type: solid,color} / {type: image,src,fit}
elements:
  - elementId: 页内唯一字符串   # 必须
    elementType: text|shape|line|image|table|chart
    bounds: [x, y, w, h]       # 必须（line 可省略：由 points 的 AABB 自动推导）
  # text：
  - elementId: t1
    elementType: text
    bounds: [60, 60, 400, 50]
    content:
      text: "正文，长句在语义断点显式 \n 换行"
      style: "$body"            # 引用 theme.textStyles；或直接写字段（**必须写在 content 内**！）
      # fontSize: 14 / color: "$ink" / bold / align / lineHeight / wrap
  # shape（常用 prst：rightArrow/leftArrow/upArrow/downArrow/leftRightArrow/pentagon/hexagon/
  #         chevron/parallelogram/diamond/octagon/star5/flowchartProcess|Decision|Data|Terminator
  #         + roundRect/ellipse/triangle/rect + custGeom 自定义路径）
  - elementId: card
    elementType: shape
    kind: roundRect
    bounds: [60, 60, 400, 200]
    fill: "$colors.primary"     # #hex | {color, alpha}（透明度）| {type: gradient, stops: [...], angle}
    line: {color: "#FFFFFF", width: 1}
    rotation: 0                 # 度
```

- **样式键必须在 `content` 内部**（元素级 `fontSize/color/…` 无效——v1.0.0 起 `ppt_check` 直接报错）。
- `expectedOverlaps` 流式/块式**等价**：`[{pair: [a,b]}]` 与 `- pair: [a,b]`，每对一行。
- 完整速查永远可以问模型（`ppt_schema`）或直接看 `examples/smoke` 样例工程。

---

## 5. 质量门禁体系（为什么不会元素打架）

**核心：重叠的合法性由"设计意图"决定，而非元素类型：设计时声明，审阅时对照。**

### 5.1 重叠声明制（expectedOverlaps）

- 设计时把**有意**重叠对记入页面 `expectedOverlaps: [{pair: [idA, idB]}, ...]`（图片标注/色块衬底/箭头跨越/装饰叠加）。
- 审阅（`ppt_verify`）逐对对照：命中 → ✓ 预期重叠（确认）；未命中 → **ERROR**（修正布局，或确认有意 → 补声明重验）。
- **声明闭包**：嵌套承载只需声明**相邻层**（面板→框→文字），隔层由包含关系传递自动通过（架构图声明省 1/3）。
- **内容互压（content-collision）永远 ERROR，不可声明**（文字/表格/图表相互遮挡——真正要防的冲突）。
- `role: decoration` 只豁免**重叠**，不豁免出界。
- 批量：`ppt_verify autoDeclare=true`（写入后附"声明清单 + 每对一句意图"；**audit 档禁用**）。

### 5.2 出界分级（与声明制同构）

- 超**页面边界** = 永远 ERROR，不可声明（放映不可见）。
- 超**安全区**（模板 logo/页眉页脚带）= 声明制：`expectedOutOfSafeArea: [idA, ...]` 手工声明（id 必须存在）。

### 5.3 文本度量与 12pt 铁律

- 保守估算（CJK 1em·加粗 ×1.06 / Latin 数字 0.6em / 空格 0.4em），宁可误报不可漏报；渲染/校验/导出**同一度量**（溢出 > 1px 才缩字，缩字下限 `theme.minFontSize` 默认 12pt）。
- verify 通过 ⇒ 导出不缩字；到达下限仍溢出 → 报告 ✗（修复：扩大容器/精简文案，不要接受 <12pt 缩字）。
- **M2 实测档**（`ppt_measure` + `ppt_verify measured=true`）：浏览器真实排版测量——实测溢出且估算没报 = 新 error（估算漏报）；估算报但实测通过 = warning（字体差异，人工确认）。实测=终审、估算=预检。

### 5.4 主题一致性（统一基础样式）

- `theme-conformance` strict（默认）：页面颜色必须 ∈ `theme.colors` 或中性灰，出板 = ERROR；新增颜色先加进 theme。
- 字号/字体为建议级（[·]），单页多处时聚合出一条。
- 导入工程自动带**原稿全量色板**（c1-c7 高频 + 扩展），不再误报原稿色。

### 5.5 审阅节奏（三层校验）

```text
ppt_render + ppt_verify   # ① 数字门禁：ERROR 清零（快）
ppt_shot + read_image     # ② 视觉审阅：构图失衡/断行/比重（慢但必要，数字门禁发现不了）
ppt_visual                # ③ Office 真渲染复核（有条件时；audit 档导出自动跑）
```

`[·]` 建议（美学/对比度/孤字/密度）永不作为门禁——但请逐条斟酌采纳。

---

## 6. 保真与贴模板（三重通道）

| 通道 | 工具 | 适用 | 保真度 |
|---|---|---|---|
| **参考双轨**（想"像"） | `ppt_import` → `reference/previews/*.png` 真身 → 读 `audit.yaml` → 创作 | 按模板做/参考用户 PPT 做；导入改稿 | 风格级（新版式由你掌控） |
| **手术模式**（要"贴"） | `ppt_patch` | 成品要"看起来就是模板原样"（只换文字/表格内容） | 结构级（模板 XML 原样，只改文本槽） |
| **替换/单页**（要"保"） | `ppt_splice` / `ppt_slice` | **编辑既有精美 PPT 的某一页**——只换一页，其余逐字节不动，母版横幅/页脚/备注保留 | 逐字节级（其余页 SHA256 自证） |

**edit 任务的标准姿势（v1.0.0 起一键）**：
```text
ppt_import(<源.pptx>, D:\work)        # 读参考层真身（先 read_image 看 reference/previews）
# 改 D:\work\pages\slide_15.yaml → ppt_render → ppt_verify（0 错误）
ppt_splice(dir=D:\work, source=<源.pptx>, page=15)      # 整册副本，只变第 15 页
ppt_slice(source=<spliced产物>, page=15)                 # 单页版（可选）
ppt_visual(pptx=<spliced产物>, pages="15")               # 抽查该页真实观感（按页渲染）
```

---

## 7. 内置模板库

4 套版权自研风格（business-blue 商务蓝 / academic-white 学术会议 / tech-dark 科技深色 / pitch-bold 路演大字，各含 theme + 6 张版式母版）+ 外部模板（实用毕业设计/极简部门总结/深蓝质感答辩/简约商务等，双轨含真实模板 pptx + 真渲染预览）。

- `ppt_templates` 看清单与预览；`/ppt template <id>` 记默认。
- `ppt_new(dir, template=<id>)` 物化工作区：`pages/_*.yaml` 是**参考母版**（不进门禁）；`01_opening.yaml` 是正式副本（先 `ppt_verify autoDeclare=true` 声明模板固有叠层 → 剩余错误是模板原文案残留，替换后自然干净）。
- 你自己的模板：`ppt_import`（保留 source.pptx）→ `ppt_template_add` 永久进库 → 以后直接物化使用。

---

## 8. 常见问题 FAQ

**Q：为什么 verify 报重叠但我的设计是有意的？**
→ 这是设计意图声明制：把这对元素加进页面 `expectedOverlaps` 再重验（命中即 ✓）。说明不清意图的对子请改布局；内容互压（文字×文字）永远不能声明。

**Q：autoDeclare 为什么不声明全部？**
→ 只声明警告级（承载/装饰模式），内容互压不可声明（硬底线）；audit 档禁一键声明。写入后模型必须输出"每对一句意图"。

**Q：样式写了但效果不对/按 18pt 计量？**
→ 样式键必须写在 `content` 内。元素级 `fontSize` 无效（v1.0.0 起 ppt_check 直接报错并指引）。

**Q：预览链接打不开（404）？**
→ 路由由 PPT 工作室会话挂载时注册：请确认当前会话在 PPT 工作室；进入后链接即恢复。

**Q：Office 渲染时窗口闪一下？**
→ 正常（PowerPoint COM 需要）；只读打开、结束自动释放。

**Q：无 Edge/无 Office 还能用吗？**
→ 能。截图/实测/真渲染自动降级并标注（HTML 预览 + 结构断言仍在）；交付说明会标注"未经视觉审阅"。

**Q：图表支持哪些？**
→ bar/line/pie（矢量拼绘，可编辑）；python-pptx 兜底引擎下降级为表格（报告醒目标注）；复杂图表建议作为图片或直接用 Shape 拼。

**Q：如何只改原稿第 15 页？** → `ppt_splice`（第 6 节）。**如何导出单页版？** → `ppt_slice`。

**Q：模板页脚带被 logo 占着，内容放哪？**
→ deck.yaml `theme.safeArea` 声明安全区 → verify 把关；logo 类有意元素加 `expectedOutOfSafeArea`。

**Q：中文长句会被误报溢出？**
→ 估算保守（宁可误报）——按提示加宽容器/缩小字号/在语义断点显式 `\n` 换行；`ppt_measure` 实测档复核（实测=终审）。

**Q：导出总是 auto-fit 缩字？**
→ 先看 verify 是否已经报溢出；溢出清零后导出不再缩字。若仅个别页（导入近似稿存量问题）→ 改某页用 `ppt_splice` 而非整册重渲。

**Q：新增一页怎么注册？**
→ 复制母版去 `_` 前缀改名（如 `_06_...` → `06_...`）+ 在 deck.yaml `pages:` 注册；或新写完整页。

---

## 9. 环境与能力边界

**环境**：DSH web（Windows 主机）。Office/Edge 为**可选增强**（探测失败自动降级）；python-pptx 为**可选兜底**。路径/中间层一律 UTF-8；已兼容 WPS 导出的 UTF-16 文件。

**支持矩阵（PPTD v1 视觉子集）**：

| 类别 | 支持 | 说明 |
|---|---|---|
| 元素 | text / shape / line / image / table / chart | chart：bar/line/pie；line **仅 2 点**（多点拆多条） |
| shape | rect/roundRect/ellipse/triangle + **prst 常见形状**（箭头/菱形/五边形/流程图等）+ **custGeom 自定义路径** + rotation + 纯色/渐变/alpha fill | roundRect 圆角 8%；custGeom：moveTo/lnTo/quadBezTo/cubicBezTo/arcTo/close |
| 文本 | 主题引用、fontSize/family/color/bold/italic/align/lineHeight/wrap | 中文换行带标点禁则 |
| 背景 | hex / `$themeRef` / solid / image（cover/contain/fill + 媒体嵌入） | 渲染/导出/导入三端一致 |
| 图表 | 矢量拼绘（可编辑）；python-pptx 引擎降级为表格 | 数据全零显式警告 |

**诚实边界**（不承诺，均有替代路径）：
- 文本度量是**估算档 + 实测档**双档（实测依赖浏览器）；与 Office 原生排版存在字体级系统差（加粗 CJK 已计 1.06 补偿）。
- 导入：阴影/动画/超链接/母版继承不支持；渐变归一主色（stops 保留在 import-styles.json）；chart 降级为占位；**EMF 媒体**与跨实现（WPS）打开未验证。
- 引擎：pptxgenjs 第三引擎未实现（v1.0 前按计划不动）；python-pptx 仅兜底/显式指定。
- dsh 网页内嵌预览面板（client 面板）未实现——对话内预览已有 `ppt_preview` + `ppt_shot overview` 覆盖。
- 跨平台：COM/Edge 探测路径面向 Windows（macOS/Linux 主机需要对应适配，当前未验证）。

---

## 10. 开发与维护（给改插件的人）

```bash
node scripts/build.mjs          # 免 tsc：src → lib 复制（纯 ESM JS，源码即产物）
npm test                        # build + smoke（139 断言）
npm run test:real               # 真实资产回归（WPS fixture；19 页 deck 缺失自动跳过）
node scripts/preflight-1.0.mjs  # 发布前预检（坏输入/边界/幂等/性能/媒体 splice——11 断言）
```

- **装配**：agent preset `C:\Users\11867\.dsh\.agent-presets\ppt\agent.cordis.yml` 插件行（**唯一装配源**）；`profiles/web/node_modules/@dsh-external/dsh-ppt-studio` 是 junction → 本仓库。改码 = build + **重启 host**（`dev_reload_package` 只覆盖注入器装配的包——本插件走 preset 行，重启是唯一可靠生效路径）。
- **文档链（每次改动必同步）**：`docs/01-需求与目标.md`（需求/决策/冲突）· `docs/02-技术报告.md`（实现级）· `docs/03-更新日志.md`（版本记录）· `docs/04-路线图与里程碑.md`（验收）· `docs/05-迭代流程.md`(检查单) · `docs/06-评审与测试.md`（发布前评审/测试矩阵）。
- **git 约定**：一个功能/修复一个 commit；message `vX.Y.Z: <一句话目的>（反馈编号）`；lib/ 不提交（build 产物）。
- **既有的自动化验证**：smoke（139 断言，全链路）→ preflight（发布预检）→ regression-real（真实资产）→ 真实任务闭环（参考 docs/06 的测试矩阵与历轮反馈）。

**版本规则**：semver。`major` 破坏中间层/接口兼容；`minor` 新特性；`patch` 修复/文档。v1.0.0 = 三轮真实端到端测试通过后的稳定基线。
