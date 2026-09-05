/**
 * 新手引导（反馈 B2 ★）：语法速查 + 一键样例工程。
 * - SCHEMA_REF：pptd DSL 语法速查（ppt_schema 工具输出）。
 * - scaffoldProject(dir)：生成一个可跑通全链路的样例工程（ppt_new 工具）。
 */
import { writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'

export const SCHEMA_REF = `# PPTD v1 语法速查（deck 工程 = deck.yaml + pages/*.yaml + media/）

## 工程骨架（deck.yaml）
\`\`\`yaml
version: 1
title: 我的演示
size: [960, 540]              # 或 {width, height}；1px = 1pt，原点左上
theme:                        # 样式只在这里定义，页面元素引用 token
  colors: {primary: "#2563EB", ink: "#1F2937"}
  textStyles: {title: {fontSize: 32, color: "$ink", bold: true}, body: {fontSize: 16, color: "$ink"}}
  safeArea: {top: 20, bottom: 20}   # 可选：模板背景非内容区（logo/页眉页脚带）
  minFontSize: 12             # 可选：用户给出字号下限时设置（如"不得小于14号" → 14）；缺省无强制下限
pages:
  - pages/01_cover.yaml
\`\`\`

## 页面元素（元素通用字段）
\`\`\`yaml
elements:
  - elementId: 页内唯一字符串   # 必须
    elementType: text|shape|line|image|table|chart
    bounds: [x, y, w, h]       # 必须（line 可省略：由 points 的 AABB 自动推导）
    role: content|background|decoration   # 可选：层叠语义；decoration 完全豁免重叠与出界（可合法落在模板页眉页脚带）
\`\`\`

### text
\`\`\`yaml
- elementId: t1
  elementType: text
  bounds: [60, 60, 400, 50]
  content:
    text: "正文，长句在语义断点显式 \\n 换行"
    style: "$body"            # 引用 theme.textStyles；或直接写字段
    # 也可内联：fontSize: 14 / color: "$ink" / bold / align: left|center|right / lineHeight / wrap: false
    # ⚠ 样式键必须写在 content 内部（上例）。写在元素级（elementType 同级）无效——
    #   v0.15.0 起 ppt_check 直接报错（此前静默忽略按默认 18pt 度量，曾产生 146 条假错误）
    # ✗ 错误示范（元素级样式键）：
    #   elementType: text
    #   fontSize: 14            ← 无效！应放在 content: {text: "...", fontSize: 14} 内
\`\`\`

### shape（kind = rect|roundRect|ellipse|triangle|custGeom + 常见 prst：rightArrow/leftArrow/upArrow/downArrow/leftRightArrow/pentagon/hexagon/chevron/parallelogram/diamond/octagon/star5/flowchartProcess|Decision|Data|Terminator）
\`\`\`yaml
- elementId: card
  elementType: shape
  kind: roundRect
  bounds: [60, 60, 400, 200]
  fill: "$colors.primary"     # #hex | {color, alpha}（v0.11 透明度）或渐变对象：
  # fill:
  #   type: gradient
  #   stops: [{pos: 0, color: "#79C9E2"}, {pos: 100, color: "#0485A8", alpha: 40}]
  #   angle: 90               # OOXML lin@ang 顺时针
  line: {color: "#FFFFFF", width: 1}
  rotation: 0                 # 度
# 自定义几何（v0.11 候选 C，模板曲线装饰保真）：
# - elementId: ribbon
#   elementType: shape
#   kind: custGeom
#   bounds: [40, 40, 400, 160]
#   path: {w: 100000, h: 40000, commands: [{cmd: moveTo, pts: [[0,0]]}, {cmd: cubicBezTo, pts: [[30000,0],[70000,40000],[100000,40000]]}, {cmd: arcTo, wR: 10000, hR: 10000, stAng: 0, swAng: 5400000}, {cmd: close}]}
#   # commands: moveTo|lnTo|quadBezTo|cubicBezTo|arcTo(wR/hR/stAng/swAng)|close；坐标 = 路径空间抽象单位
\`\`\`

### line（bounds 可省略；**仅 2 点**，多点折线请拆成多条 line——P2-3）
\`\`\`yaml
- elementId: arrow
  elementType: line
  points: [[100, 100], [300, 100]]   # 恰好 2 点；或 {x1,y1,x2,y2}
  arrow: true
  line: {color: "#2563EB", width: 2}
\`\`\`

### image / table / chart
\`\`\`yaml
- elementId: img
  elementType: image
  bounds: [60, 100, 400, 300]
  src: media/pic.png          # 相对 deck 根
  fit: cover                  # cover|contain|fill
- elementId: tbl
  elementType: table
  bounds: [60, 420, 840, 80]
  cols: ["指标", "数值"]
  rows: [["A", "1"], ["B", "2"]]
  header: true
- elementId: bar
  elementType: chart
  bounds: [60, 80, 400, 240]
  chart: {type: bar, data: {cols: ["指标", "值"], rows: [["甲", 10], ["乙", 20]]}}
\`\`\`  # chart.type: bar|line|pie；数据格式 = 宽表（cols: [分类, 值1, ...]；多系列用 series 映射）。
# 单列 pairs 格式（cols 只写类别列、每行 [类别, 值]）自动兼容（v0.6.1），但**建议用宽表**；
# 图表数据解析为全零时 render/export 会给出显式警告（不再静默）。

## 页面级字段
\`\`\`yaml
pageType: cover|content
background: "#FFFFFF"        # 或 "$themeRef" / {type: solid, color} / {type: image, src, fit}
safeArea: {top: 20}          # 可选：覆盖主题安全区
expectedOverlaps:            # 设计阶段声明"有意"重叠（审阅与声明对照）
  - {pair: [card, t1]}       # 色块衬底/图片标注等；内容互压 text×text 不可声明，永远错误
expectedOutOfSafeArea:       # 有意落在"安全区外/模板页眉页脚带"的元素（logo/角标/水印）
  - logo                     # 逐元素手工声明（autoDeclare 不自动生成出界声明）；id 必须存在
contrastExempt:              # P1-1：已确认对比度正常但启发式误报 → 豁免对比度建议
  - inText                   # id 必须存在；用于"色块上再嵌深色框"的架构场景
overlapMode: declared        # declared（默认）| lenient（草稿缓冲：未声明仅提示）
\`\`\`

## 层叠角色推断（不在 expectedOverlaps 的规则）
- text/table/chart = content；shape/image = background（承载）；line = line（引脚线/箭头）。
- content×content 重叠 → ERROR content-collision（不可声明豁免）。
- content×background / line×任意 → 警告级，未声明则 ERROR unexpected-overlap（修正布局或补声明）。
- role: decoration → 只豁免**重叠**（装饰性是设计意图声明）；**不豁免出界**（要落在页眉页脚带 → 走 expectedOutOfSafeArea 声明）。
- **声明闭包（P0-2）**：嵌套承载只需声明**相邻层**（card×inBox、inBox×inText），隔层组合（card×inText）由包含关系传递自动通过——声明 45 对变 30 对，传递对不再人肉补。
- **出界分级**：超页面边界（放映不可见）→ 永远 ERROR，不可声明；超安全区（模板带内）→ 声明制（expectedOutOfSafeArea 命中 ✓ 预期出界，未命中 ERROR）；页面 overlapMode: lenient → 未声明仅提示。
- 声明自证（D1）：autoDeclare 写入后应输出"声明清单"（每对附一句意图，如色块衬底/图上标注/箭头跨越）；说不清意图的对子必须改布局而不是声明。

## 审阅/导出约定
- ppt_render → preview/*.html + layout.json；ppt_verify 错误（[✗]）清零是门禁，
  [·] 为审美建议（非门禁，但请斟酌）。宽 > 窄 的元素安全：加 safeArea 后安全区外 = 出界。
- ppt_verify autoDeclare=true：把警告级未声明重叠一键写入 expectedOverlaps（内容互压仍要手工修）。
- ppt_export 的 out 支持绝对路径（原样使用）或文件名（相对 deck 目录）。
- 度量：预览/校验/导出共用同一保守估算；**字号下限 = 用户指令**（写入 theme.minFontSize，导出缩字同步遵守；未给下限不设强制，仅 60% 保底防荒谬）。
- 需要完整可跑样例：ppt_new 生成示例工程；回归样例在插件 examples/smoke。
`

/** 一键生成可跑通全链路的样例工程。已存在 deck.yaml 时拒绝（防覆盖）。 */
export async function scaffoldProject(dir, { name = 'my-deck' } = {}) {
  const deckFile = join(dir, 'deck.yaml')
  try {
    await access(deckFile)
    throw new Error(`目标目录已存在 deck.yaml（${deckFile}），拒绝覆盖；请换一个空目录`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const pagesDir = join(dir, 'pages')
  await mkdir(pagesDir, { recursive: true })
  await mkdir(join(dir, 'media'), { recursive: true })
  await writeFile(deckFile, [
    'version: 1',
    `title: ${name}`,
    'size: [960, 540]',
    'theme:',
    '  colors:',
    '    primary: "#2563EB"',
    '    ink: "#1F2937"',
    '    lighter: "#E8EEFB"',
    '    accent: "#FFD966"',
    '  textStyles:',
    '    title: {fontSize: 32, color: "$ink", bold: true}',
    '    body: {fontSize: 16, color: "$ink"}',
    '    label: {fontSize: 12, color: "$ink"}',
    '  safeArea: {top: 16, bottom: 16}',
    'pages:',
    '  - pages/01_cover.yaml',
    '  - pages/02_content.yaml',
    '  - pages/03_cardgrid.yaml',
    '  - pages/04_architecture.yaml',
    '',
  ].join('\n'))
  await writeFile(join(pagesDir, '01_cover.yaml'), [
    'pageType: cover',
    'background: {type: solid, color: "$primary"}',
    'safeArea: {top: 24, bottom: 24}',
    'elements:',
    '  - elementId: title',
    '    elementType: text',
    '    bounds: [160, 200, 640, 70]',
    '    content: {text: "标题：PPT 工作室一键样例", style: "$title", color: "#FFFFFF"}',
    '  - elementId: sub',
    '    elementType: text',
    '    bounds: [160, 280, 640, 30]',
    '    content: {text: "副标题：日期 / 作者", style: "$body", color: "#E8EEFB"}',
    '  - elementId: rule',
    '    elementType: line',
    '    points: [[160, 260], [800, 260]]',
    '    line: {color: "#FFFFFF", width: 1}',
    '',
  ].join('\n'))
  await writeFile(join(pagesDir, '02_content.yaml'), [
    'pageType: content',
    'elements:',
    '  - elementId: head',
    '    elementType: text',
    '    bounds: [60, 48, 840, 50]',
    '    content: {text: "内容页：色块衬底 + 文字", style: "$title"}',
    '  - elementId: panel',
    '    elementType: shape',
    '    kind: roundRect',
    '    bounds: [60, 120, 420, 240]',
    '    fill: "$lighter"',
    '  - elementId: ptext',
    '    elementType: text',
    '    bounds: [90, 150, 360, 180]',
    '    content: {text: "文字放在色块卡片上是有意设计：\\n本页演示 expectedOverlaps 声明。", style: "$body"}',
    '  - elementId: note',
    '    elementType: text',
    '    bounds: [60, 440, 840, 26]',
    '    content: {text: "提示：卡片上的文字需要声明预期重叠（见本页 expectedOverlaps）。", style: "$label"}',
    'expectedOverlaps:',
    '  - {pair: [panel, ptext]}',
    '',
  ].join('\n'))
  await writeFile(join(pagesDir, '03_cardgrid.yaml'), [
    'pageType: content',
    'elements:',
    '  - elementId: head2',
    '    elementType: text',
    '    bounds: [60, 48, 840, 50]',
    '    content: {text: "要素卡片：8px 网格 + 统一间距", style: "$title"}',
    '  - elementId: c1',
    '    elementType: shape',
    '    kind: rect',
    '    bounds: [60, 130, 260, 160]',
    '    fill: "$lighter"',
    '  - elementId: c2',
    '    elementType: shape',
    '    kind: rect',
    '    bounds: [350, 130, 260, 160]',
    '    fill: "$lighter"',
    '  - elementId: c3',
    '    elementType: shape',
    '    kind: rect',
    '    bounds: [640, 130, 260, 160]',
    '    fill: "$lighter"',
    '  - elementId: t1',
    '    elementType: text',
    '    bounds: [80, 150, 220, 40]',
    '    content: {text: "要点一", style: "$body", bold: true}',
    '  - elementId: t2',
    '    elementType: text',
    '    bounds: [370, 150, 220, 40]',
    '    content: {text: "要点二", style: "$body", bold: true}',
    '  - elementId: t3',
    '    elementType: text',
    '    bounds: [660, 150, 220, 40]',
    '    content: {text: "要点三", style: "$body", bold: true}',
    'expectedOverlaps:',
    '  - {pair: [c1, t1]}',
    '  - {pair: [c2, t2]}',
    '  - {pair: [c3, t3]}',
    '',
  ].join('\n'))
  await writeFile(join(pagesDir, '04_architecture.yaml'), [
    'pageType: content',
    '# P2-1/P0-2 常见模式：架构图 = 面板 → 深色框 → 文字 的三层嵌套；',
    '# 只需声明【相邻层】对（panel×inBox、inBox×inText），隔层组合 (panel×inText) 由声明闭包自动通过',
    'expectedOverlaps:',
    '  - {pair: [panel, inBox]}',
    '  - {pair: [inBox, inText]}',
    '  - {pair: [panel, chip]}',
    '  - {pair: [chip, chipT]}',
    '  - {pair: [panel, arrow]}',
    '  - {pair: [badge, badgeT]}',
    'contrastExempt: [badgeT]',
    '# P1-1：白字衬在浅色徽标上是既有设计 → contrastExempt 豁免对比度建议（id 必须存在）',
    'elements:',
    '  - elementId: head',
    '    elementType: text',
    '    bounds: [60, 48, 840, 50]',
    '    content: {text: "架构页：嵌套承载 + 声明闭包（声明相邻层即可）", style: "$title"}',
    '  - elementId: panel',
    '    elementType: shape',
    '    kind: roundRect',
    '    bounds: [60, 120, 840, 340]',
    '    fill: "$lighter"',
    '  - elementId: inBox',
    '    elementType: shape',
    '    kind: rect',
    '    bounds: [100, 180, 300, 220]',
    '    fill: "$primary"',
    '  - elementId: inText',
    '    elementType: text',
    '    bounds: [130, 240, 240, 90]',
    '    content: {text: "深色框上的白字（最上层承载）", style: "$body", color: "#FFFFFF"}',
    '  - elementId: chip',
    '    elementType: shape',
    '    kind: rect',
    '    bounds: [460, 180, 120, 80]',
    '    fill: "#FFD966"',
    '  - elementId: chipT',
    '    elementType: text',
    '    bounds: [470, 200, 100, 40]',
    '    content: {text: "芯片", style: "$body"}',
    '  - elementId: arrow',
    '    elementType: line',
    '    points: [[400, 290], [450, 290]]',
    '    arrow: true',
    '    line: {color: "#2563EB", width: 2}',
    '  - elementId: badge',
    '    elementType: shape',
    '    kind: rect',
    '    bounds: [700, 470, 120, 44]',
    '    fill: "$lighter"',
    '  - elementId: badgeT',
    '    elementType: text',
    '    bounds: [720, 482, 80, 22]',
    '    content: {text: "徽标", style: "$label", color: "#FFFFFF"}',
    '',
  ].join('\n'))
  return { dir, deckFile, files: [deckFile, join(pagesDir, '01_cover.yaml'), join(pagesDir, '02_content.yaml'), join(pagesDir, '03_cardgrid.yaml'), join(pagesDir, '04_architecture.yaml')] }
}
