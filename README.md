# @dsh-external/dsh-ppt-studio — PPT 工作室

PPT 插件：四类任务（从头/补完/修改/总结）工作流 + 布局工程（元素冲突防治）+ PPTD 中间层工具链。
配套 agent preset「PPT 工作室」（copy standard，标准模式全功能 + 本插件行）。

## 文档档案库（`docs/`，长期迭代必备）

| 文件 | 用途 |
|---|---|
| `docs/00-设计源.md` | 原始设计文档（537 行 + 决策记录；归档，勿直接改） |
| `docs/01-需求与目标.md` | **初始需求/目标/决策/冲突清单（改需求先读这里）** |
| `docs/02-技术报告.md` | 实现级参考：模块/数据流/机制/验证矩阵/波及面速查 |
| `docs/03-更新日志.md` | 每次迭代的目的、改动、验证、影响 |
| `docs/04-路线图与里程碑.md` | 长期任务清单与验收标准 |
| `docs/05-迭代流程.md` | 改动检查单 / git 约定 / 反馈处理模板 |

## 构建与注入

```bash
node scripts/build.mjs          # 免 tsc：src → lib 复制（纯 ESM JS，源码即产物）
npm test                        # build + smoke（133 断言）
npm run test:real               # 真实资产回归（19 页 deck + WPS fixture，缺失自动跳过）
# 注入器环境内：dev_inject_plugin <本目录>
# 注意：本插件免编译 → dev_build_plugin 不需 DSH_CHECKOUT（其 build.sh 只跑 build.mjs）；
#       dev_reload_package 仅命中"注入器装配"的包——本插件经 agent preset 会话装配，改码走重启。
```

## 工具面

`ppt_check` 校验 / `ppt_render` 渲染 / `ppt_shot` 截图 / `ppt_verify` 数字审阅（可 `autoDeclare=true` 一键声明；audit 档禁用）/
`ppt_export` 导出（out 支持绝对路径；auto=pptd 优先，硬失败自动回退 python-pptx 并醒目标注）/ `ppt_import` 导入 / `ppt_status` 工作流状态 / `ppt_media` 图片元数据 / `ppt_state` 会话状态
+ `ppt_schema` **语法速查** / `ppt_new` **一键样例工程**（v0.3.0）
+ `ppt_patch` **手术模式**（v0.10.0，候选 B）：模板真身贴内容——只改文本/表格 <a:t>，rPr/几何/渐变/字体/图片原样保留（"看起来就是模板原样"）；未动页内容 sha256 验证。与 `ppt_export` 并存：常规导出走渲染，贴模板保真走手术
+ `/ppt` 命令面（on/off/**quick/normal**/free|mid|strict/fidelity/review/engine/quality/pause-after/help）。

## 新手入门（v0.3.0，对应真实任务反馈 B2 ★）

- **语法自述**：不熟悉 deck.yaml / 元素字段 / 主题 token / 重叠声明怎么写 → 先调 `ppt_schema`（内置完整速查）。
- **一键样例**：`ppt_new(dir)` 生成可跑通全链路的示例工程（deck.yaml + 3 页，含主题 token、色块衬底+expectedOverlaps、safeArea、line 无 bounds 写法），已存在 deck.yaml 时拒绝覆盖。
- **line 可省略 bounds**（D1 ★）：`line` 的 bounds 由 points 的 AABB 自动推导（w/h ≥ 1px），schema 不再要求手写。

## 背景模板安全区（v0.3.0，反馈 D5 ★）

模板背景图常自带 **logo/页眉/页脚色带**（如"页脚从 y≈515 开始"），内容扑上去视觉就毁掉。现在可以声明：

```yaml
# deck.yaml（主题级，所有页生效）
theme:
  safeArea: {top: 20, bottom: 24}
# 页面级可选覆盖
safeArea: {top: 46, bottom: 26}
```

- `ppt_verify` 把安全区外的元素判为 **out-of-page ERROR**（"元素超出安全区"）。
- `ppt_render debug=true` 会在预览里画出安全区参考框（蓝色虚线），摆放时直接对齐。
- 页面用图片背景但未配置 safeArea 时，verify 给出 `[·]` 建议（非门禁）。

## 一键声明（v0.3.0，反馈 D2 ★★）

"卡片上放文字"这类**警告级未声明重叠**要逐对写 `expectedOverlaps` 很费劲——现在：

```text
ppt_verify(dir, autoDeclare=true)
```

把页面所有未声明的警告级重叠对（色块衬底/图片标注/箭头跨越，**不含内容互压**）合并写入页面 yaml（parseDocument 保留注释），然后重渲染重验；报告剩余错误（若为 content-collision，声明制不可豁免，仍需手工改布局）。

> 写法等价（v0.14.6 回归确认）：`expectedOverlaps: [{pair: [a, b]}]`（流式）与
> `expectedOverlaps:\n  - pair: [a, b]`（块式）完全等价，解析归一，可混用。
> 局部审阅：`ppt_verify(dir, pages="2,5-7")` 只检查指定页（不改写 layout.json，其余页不受影响）。

## 度量与导出下限（v0.3.0，反馈 D4/E2 ★★）

- **保守估算**：混合文本（中文+数字+英文+括号）按偏宽系数估算（CJK 1em / Latin·数字 0.6em / 空格 0.4em），宁可误报不可漏报；渲染（浏览器）与导出（pptd）共用同一度量与阈值（溢出 > 1px）。
- **导出不再静默缩字**：`verify 通过 ⇒ 导出不缩放`；缩字下限 = `theme.minFontSize`（默认 12pt，且不超过原字号）；到达下限仍溢出 → 导出报告 `✗ 达到字号下限仍溢出`（一定要修复，不要接受 <12pt）。
- verify 新增 `[·]` 启发式建议：**前景/背景对比度**（D6）、**自动换行末行孤字**（D7）——均为建议，非门禁。

## Office 真渲染通道（v0.8.0，先看后做 + 成品视觉审核）

**能力探测**：本机有 Microsoft Office（PowerPoint COM）→ 通道可用；**无 Office 自动隐藏，工作流行为与之前完全一致**。

```text
ppt_visual(pptx)   # ① 理解用户原稿：参考任务先渲染逐页 PNG → read_image 真看 → 视觉理解写入设计摘要
                   # ② 成品视觉审核：导出后对 out.pptx 渲染 → 审核真实观感（渐变/阴影/形状语言）
audit 档导出       # 自动 Office 真渲染（有 Office 时），报告附渲染路径；standard 档手动调用
```

- **双渲染审核制**：HTML 预览档（快、处处可用）+ Office 真渲染档（准、有条件才用）——有条件时审核以 Office 档为准；
- 无 Office 机器：自动标注"未经 Office 真渲染审核"，回退 HTML 预览 + 结构断言（现状）；
- 渲染副作用：PowerPoint 窗口短暂闪现（COM 需要）；只读打开、finally 释放、超时杀残留进程。

## 对话内预览（v0.6.0，需求 A）

做完一版/几页后调用 `ppt_preview(dir)` → 渲染 + 静态服务 → 返回**同源预览链接**（本页 + 整览），用户在 GUI 内点击即可直接看 PPT（翻页/整览），**不用打开本地文件**；预览随每轮制作刷新（链接 token 稳定，重新生成即替换内容）。

```text
ppt_preview(dir)   # 链接附在交付信息里（绝对地址，点击即可查看）；用户看 → 提意见 → 继续改
```

- 预览根隔离（`~/.dsh/ppt-studio/preview/<token>/`，含 `.meta.json` 源映射，跨进程/重启后链接仍有效）；
- 图表数据全零会以显式警告出现在 render/export 报告（v0.6.1，不再静默）；**单列 pairs 图表格式自动兼容**（建议宽表 `cols: [分类, 值]`）；
- 与审阅暂停点配合：`/ppt pause-after pages|overall` → 出预览 → 等用户意见 → 根据批注文字进入修改（**批注面板 = B 阶段，路线图**）；
- 技术：webServer prefix 路由 `/ppt-preview`（实测：path 不带尾斜杠才命中）+ 绝对 URL（webServer.port 契约）。（v0.6.0 版曾输出成纯文字链接——已修复为绝对地址。）

## 内置模板库（v0.5.0，需求 2/4）

**用户模板文件 > 内置模板库 > 从零定调** 三级降级。4 套风格版权自研：**business-blue 商务蓝 / academic-white 学术会议 / tech-dark 科技深色 / pitch-bold 路演大字**（每套 = 完整 theme + 6 张版式母版页：封面/内容/流程/图表/对比/结尾 + 自动生成缩略图）。

```text
ppt_templates              # 清单 + 风格/场景/预览图路径（S0 展示给用户选）
ppt_new dir=<目录> template=<id>   # 从模板复制工作区（v0.7：母版=参考不进门禁；01_opening=正式页先 autoDeclare）
ppt_template_add dir=<导入工程>    # 外部模板收纳（v0.5.1）：任意 deck 工程 → 模板库（theme/页面/媒体入包 + 自动缩略图 + 洗涤：有意叠层/出界自动声明 + 剩余分类元数据）
ppt_template_styleaudit <id>       # 模板风格审计（v0.9）：read_image 看整页真渲染 → 视觉理解写成 styleAudit（配色/字体/版式/装饰），一次生成多次复用
/ppt template <id>          # 记录本会话默认模板
```

- **模板工作区语义（v0.7.0）**：`pages/_*.yaml` 是**参考母版**（不注册进 deck.pages，**不进 render/verify 门禁**——模板设计叠层是"设计意料之内"，加载阶段不需"设计"步骤）；`pages/01_opening.yaml` 是模板首母版的**正式副本**（注册进门禁，先 `ppt_verify autoDeclare=true` 声明模板固有叠层 → 剩余错误是模板原文案残留，替换后自然干净）。新增正式页 = 复制母版去 `_` 前缀 + 注册进 deck.yaml pages。
- **模板双轨（v0.9.0）**：模板 = **骨架层**（YAML 母版，结构机器可验证、无 Office 也可用）+ **真相层**（原始 `template.pptx` + Office 真渲染整页 `previews/NN.png` + `styleAudit` 视觉审计）。`ppt_template_add` 自动保留原始 pptx；物化工作区后 `reference/`（template.pptx/previews/audit.yaml）+ deck.yaml 顶部 `referenceTemplate`。**"按模板做" = "参考用户给的 ppt 制作"**：创作前先 read_image 看 `reference/previews/*.png` + 读 `reference/audit.yaml` 再动手，不再从有损近似里猜风格。
- **外部模板收纳（v0.5.1）**：你自己的模板 / 公司采购模板 / 任何你有权使用的模板 → `ppt_import`（保留 `source.pptx` 真相层）→ `ppt_template_add` → 永久进库（**用户模板 > 导入模板 > 内置模板** 三级增长；模板数量随使用增长，不必预置几百套）。
- **模板一致性门禁**：verify `theme-conformance`（strict 默认）——页面颜色必须 ∈ `theme.colors` 或中性灰，出板=ERROR；字号/字体为 `[·]` 建议；`theme.themeConformance: suggest|off` 可降档。模板文件路径也可用：`ppt_import` 模板 → 启用其 theme 聚合块。
- 维护：`node scripts/build-templates.mjs` 重建全部 preview.png（render+截图）。

## 快速生成模式（Quick Mode）

- **触发**：`/ppt quick`（命令）或明确语义指令（"简单做一个 PPT"、"快速弄个"等——仅 PPT 任务上下文生效，误触率低）。
- **省什么**：视觉定调（用模板骨架）、素材搜索/复杂图表（色块图形）、截图视觉审阅与美学迭代、S0 多轮确认（≤1 问）。
- **不省什么（质量底线）**：数字门禁全跑——内容互压/出界/文本溢出/预期外重叠（设计意图声明制）必须清零；字号 ≥12pt；pptd 引擎。
- **交付**：.pptx + 说明（标注"快速模式：未经视觉审阅"）。回到完整模式：`/ppt normal`。

## 标准四步闭环（复制即用）

每次页面制作/修改后：

```text
ppt_render(dir)  → 预览 HTML + layout.json（数字审阅数据源）
ppt_verify(dir)  → 断言重叠/出界/溢出/对齐（ERROR 清零是页级门禁）
ppt_shot(dir)    → 截图 PNG（有读图能力时 read_image 人工审：格局/断行/比重）
ppt_export(dir)  → 导出 .pptx（默认 pptd 引擎；python-pptx 需 python 环境）
```

- **数字门禁（快）**：verify 的 ERROR（overlap/out-of-page/text-overflow）必须清零。
- **视觉审阅（慢但必要）**：数字审阅发现不了"图片都挤在上半部、下方空白"这类**构图失衡**——务必 `ppt_shot` 后读图确认。无读图能力时在交付说明中标注"未经视觉审阅"。
- 应用双轨后按需回改（改 yaml 或字号 → 重新 render→verify→shot）。

## Windows/中文提示

- 素材、中间层、预览一律 **UTF-8**；pwsh 处理中文文件请显式 `-Encoding UTF8` / `[System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)`，否则中文会变乱码（含 HTML 重写入）。
- 分析 .pptx 内部（xml/媒体/关系）**不要手动解压**：插件已内置 `zips.js`（zip 读写）与 XML 解析，`ppt_import` 会正确提取媒体（兼容 UTF-16 的 WPS 文件）；如需自定义读取，用受管工具或 node 脚本调用 `lib/zips.js`。
- 沙箱在 workspace-write 模式会拦截**手动启动** Edge/Chrome——截图请走受管工具 `ppt_shot`（spawn 自身允许）。
- **导入模板时**：`ppt_import` 会自动探测跨页页眉/页脚带并把建议 `safeArea` 写入 deck.yaml **注释**（不自动启用）；确认是模板后取消注释并微调即可。

## PPTD v1 视觉子集（当前支持，超出部分导出时近似/降级）

| 类别 | 支持 | 说明 |
|---|---|---|
| 元素 | text / shape / line / image / table / chart | chart 类型 bar/line/pie；line **仅 2 点**（多点折线请拆多条） |
| 页面背景 | `'#hex'` / `$themeRef` / `{type: solid}` / **`{type: image, src, fit}`** | 渲染/导出/导入三端一致；导入识别原生 `p:bg` 与满页图并提升为背景 |
| shape | rect / **roundRect** / ellipse / triangle + **rotation** + 纯色 fill/line | roundRect 圆角 8% |
| 文本 | 主题引用（$key）、fontSize/family/color/bold/italic/align/lineHeight/wrap | 中文换行带标点禁则 |
| 图表 | 矢量拼绘（可编辑形状）；python-pptx 引擎下降级为表格 | — |
| **导入保样式（v0.4.0，P0-1）** | fill/line/字体/斜体/对齐/行高/主题色（schemeClr）全映射；**渐变归一为主色**（stops 保留注释 + import-styles.json 原始值）；deck.yaml 自动写 **theme 聚合建议块** | "改版求一致"场景不再需要手工挖 XML |

> ppt_import 对不支持的样式做近似映射（roundRect 保留、渐变→主色 + import-styles.json 保留 stops、阴影标记）；chart 降级为文本占位并在导入报告明示。

## 布局工程规则（ppt_verify 的 overlap 语义：设计意图声明制）

**重叠的合法性由"设计意图"决定，而非元素类型：设计时声明，审阅时对照。**

- **设计阶段**：把**有意**重叠的元素对记入页面 `expectedOverlaps: [{pair: [idA, idB]}, ...]`（图片上标注、色块衬底、箭头跨越、装饰叠加）。
- **审阅阶段**（警示级重叠逐对对照）：
  - 命中设计声明 → **✓ 预期重叠（确认）**，不出现在错误/警告中；
  - 未命中声明 → **ERROR `unexpected-overlap`（设计预期外重叠）**：修正布局，或若确为有意 → 补声明后重验；
  - **声明闭包**（v0.4.0，P0-2）：嵌套承载（面板→框→文字）**只需声明相邻层对**，隔层组合（如 panel×inText）由包含关系传递自动通过——架构图页声明量约省 1/3；
  - **内容互压**（text/table/chart 相互遮挡，code `content-collision`）→ **永远 ERROR，不支持声明豁免**（"元素区块冲突"真正要防的）；
  - `role: decoration` 元素 → 只豁免**重叠**（装饰性=设计意图声明；**不豁免出界**——要落在模板页眉页脚带请走下方声明制）；
  - 页面级 `overlapMode: lenient` → 未声明重叠仅提示（草稿/旧项目缓冲）；
  - **批量声明**：`ppt_verify autoDeclare=true` 一键写入全部警告级未声明重叠对（写入后附"声明清单+每对一句意图"，说不清意图的对子必须改布局；audit 质量档禁用）。
- **出界分级声明制**（与重叠同构，v0.3.2）：
  - 超**页面边界**（放映不可见）= 永远 ERROR，**不可声明**；
  - 超**安全区**（模板页眉页脚带内）= 声明制：有意元素（logo/角标/水印）逐项写入页面 `expectedOutOfSafeArea: [idA, ...]`（**必须手工**，id 必须存在，防呆校验）→ 命中 ✓ 预期出界（确认）；未命中 ERROR。
- 出界 / 文本溢出 → ERROR 门禁；美学建议 `[·]` 辅助、非门禁。
- **对齐/噪声过滤（v0.4.0）**：near-align 只在**同排相邻**元素间比较（跨区块不比）、线元素（line/箭头）豁免；信息密度按**内容元素**（文本/表格/图表 ≥12）计数（纯图形架构页不再误报）；相邻贴边 <4px 输出 `[·]` 建议清单（P2-4）。
- **对比度按 z-order 最上层承载计算**（v0.4.0，P1-1）：色块上再嵌深色框的架构场景不再假阳性；已确认正常但算法仍建议 → 页级 `contrastExempt: [id]` 豁免（id 必须存在）。
- 建议中文长句在语义断点处显式使用 `\n`；导出缩字不低于主题 `minFontSize`，到下限仍溢出会明确报告（v0.3.0）。

## 已知边界（对应设计待细化清单）

- 文本度量是**估算档**（保守系数 + 换行禁则模拟），预览/校验/导出三端共用同一度量；渲染回读**实测档**为下一阶段（浏览器逐字符实测）；pptx XML 几何断言精确。
- chart 在 python-pptx 引擎下降级为表格（引擎 A 支持矢量拼绘）。
- 导入的**渐变归一为主色**（stops 保留在 import-styles.json）；阴影/动画/超链接/母版继承不支持。
- **改一页原稿**的姿势（实测反馈 3.2）：`ppt_import` 单页风格 → **独立单页工程**做改造（不要在全 deck 工程重导出，会降级其余页）→ 完成后复制回原稿。
- `ppt_shot` 只对 deck 工程（HTML 预览）截图；**直接对 .pptx 产物截图**未实现（路线图 M4）——"导出后视觉回归"目前靠：XML 回读断言 + 用户实机打开。
- dsh 网页内嵌预览（client 面板）、pptxgenjs 第三引擎未实现（设计后续阶段）。
- verify 的对比度/孤字/安全区提示均为启发式建议（非门禁），极端样式（渐变、图片上的文字）不参与计算。
