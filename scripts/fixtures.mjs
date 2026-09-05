#!/usr/bin/env node
/**
 * 1.0.0 自包含测试夹具生成器（用户已清理历史工作区——此后测试不求外部资产）：
 * 生成 examples/fx/：
 *   fx-pro    —— 高难度综合 12 页（声明制/安全区/对比度/渐变/alpha/custGeom/嵌套卡/表格/图表/跨页数字/来源标注）
 *   fx-mini   —— 3 页迷你（单元素/空白页/极简）——快速路径
 * 再导出 fx-pro 为 seed.pptx（splice/slice 的自产 source）。
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { resolveDeck } from '../lib/pptd/schema.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fx = join(root, 'examples', 'fx')

const THEME = `theme:
  colors:
    ink: "#1F2937"      # 主墨
    primary: "#2563EB"  # 主蓝
    accent: "#F59E0B"   # 强调橙
    danger: "#C0392B"   # 警示红
    steel: "#64748B"    # 辅助灰蓝
    bg: "#F8FAFC"       # 页面底
    deep: "#0F172A"     # 深底（白字承载）
    # 扩展档（夹具调色：蓝/紫/绿阶 + 浅底）
    blue-soft: "#DBEAFE"
    blue-deep: "#1E3A8A"
    blue-mid: "#3B82F6"
    slate-deep: "#334155"
    slate-soft: "#CBD5E1"
    slate-lite: "#E2E8F0"
    amber-soft: "#FEF3C7"
    amber-deep: "#92400E"
    amber-dark: "#78350F"
    violet: "#8B5CF6"
    green: "#10B981"
    green-soft: "#D1FAE5"
    green-deep: "#065F46"
  textStyles:
    title: {fontSize: 32, color: "$ink", bold: true, fontFamily: "微软雅黑"}
    h1: {fontSize: 22, color: "$ink", bold: true, fontFamily: "微软雅黑"}
    h2: {fontSize: 16, color: "$ink", bold: true, fontFamily: "微软雅黑"}
    body: {fontSize: 14, color: "$ink", fontFamily: "微软雅黑"}
    small: {fontSize: 12, color: "$steel", fontFamily: "微软雅黑"}
  safeArea: {top: 34, bottom: 26, left: 40, right: 40}
  minFontSize: 12
`

const P = (name, body) => [name, body].join('')

const pages = {
  'pages/01_cover.yaml': P('pageType: cover\nbackground: "#F8FAFC"\nexpectedOutOfSafeArea: [band]\n', `elements:
  - elementId: band
    elementType: shape
    kind: rect
    bounds: [0, 0, 960, 540]
    fill: {type: gradient, stops: [{pos: 0, color: "#0F172A"}, {pos: 100, color: "#2563EB"}], angle: 90}
  - elementId: glow
    elementType: shape
    kind: ellipse
    bounds: [660, 34, 260, 260]
    fill: {color: "#FFFFFF", alpha: 18}
  - elementId: title
    elementType: text
    bounds: [80, 150, 700, 90]
    content: {text: "能力验证演示（自建夹具）", style: "$title", color: "#FFFFFF"}
  - elementId: sub
    elementType: text
    bounds: [80, 260, 600, 50]
    content: {text: "PPTD 中间层 · 声明制 · 双轨审阅", style: "$h1", color: "#CBD5E1"}
  - elementId: badge
    elementType: shape
    kind: chevron
    bounds: [80, 420, 200, 56]
    fill: "#F59E0B"
  - elementId: badge_t
    elementType: text
    bounds: [100, 430, 160, 40]
    content: {text: "v1.0.0", style: "$h2", color: "#0F172A", align: center}
expectedOverlaps:
  - {pair: [band, glow]}
  - {pair: [band, title]}
  - {pair: [band, sub]}
  - {pair: [band, badge]}
  - {pair: [band, badge_t]}
  - {pair: [glow, title]}
  - {pair: [glow, sub]}
  - {pair: [badge, badge_t]}
`),
  'pages/02_arch.yaml': P('pageType: content\nbackground: "#F8FAFC"\nsource: "夹具自造架构示意（三层嵌套 + 声明闭包）"\n', `elements:
  - elementId: panel
    elementType: shape
    kind: roundRect
    bounds: [60, 80, 840, 380]
    fill: "#FFFFFF"
    line: {color: "#CBD5E1", width: 1}
  - elementId: box_a
    elementType: shape
    kind: rect
    bounds: [100, 130, 350, 240]
    fill: "#DBEAFE"
    line: {color: "#2563EB", width: 1}
  - elementId: box_a_t
    elementType: text
    bounds: [120, 150, 310, 60]
    content: {text: "领域本体（知识层）", style: "$h2", color: "#1E3A8A"}
  - elementId: box_a_b
    elementType: text
    bounds: [120, 230, 310, 120]
    content: {text: "对象·属性·关系·约束\\n换场景 = 换实例，零重构", style: "$body", color: "#334155"}
  - elementId: box_b
    elementType: shape
    kind: rect
    bounds: [510, 130, 350, 240]
    fill: "#FEF3C7"
    line: {color: "#F59E0B", width: 1}
  - elementId: box_b_t
    elementType: text
    bounds: [530, 150, 310, 60]
    content: {text: "仿真内核（执行层）", style: "$h2", color: "#92400E"}
  - elementId: box_b_b
    elementType: text
    bounds: [530, 230, 310, 120]
    content: {text: "车间生产·负载评估·计划跟踪\\n结论可迁移（泛化性）", style: "$body", color: "#78350F"}
  - elementId: arrow
    elementType: line
    points: [[450, 250], [508, 250]]
    arrow: true
    line: {color: "#2563EB", width: 2}
  - elementId: foot
    elementType: text
    bounds: [100, 470, 760, 40]
    content: {text: "知识层 → 映射 → 执行层：本体驱动仿真的泛化范式（A8 场景也在本页）", style: "$small"}
expectedOverlaps:
  - {pair: [panel, box_a]}
  - {pair: [panel, box_b]}
  - {pair: [box_a, box_a_t]}
  - {pair: [box_a, box_a_b]}
  - {pair: [box_b, box_b_t]}
  - {pair: [box_b, box_b_b]}
  # 声明闭包：panel×box_a_t 等隔层对由包含关系传递自动通过，无需声明
`),
  'pages/03_table.yaml': P('pageType: content\nbackground: "#F8FAFC"\nsource: "夹具自造表（数据为演示样本）"\n', `elements:
  - elementId: t_head
    elementType: text
    bounds: [60, 60, 400, 40]
    content: {text: "对策-指标对照表", style: "$h1"}
  - elementId: tbl
    elementType: table
    bounds: [60, 120, 840, 300]
    cols: [对策, 指标A, 指标B, 说明]
    rows:
      - [线表决策辅助, 决策响应-32%, 准确率+12%, 基线 45.6%]
      - [排程优化, 交付周期-18%, 利用率+9%, 中型场景]
      - [生产流程仿真, 节拍-15%, 一次合格率+8%, 泛化验证]
  - elementId: t_note
    elementType: text
    bounds: [60, 450, 840, 40]
    content: {text: "注：数据为演示样本（45.6% 为跨页对账演示数字）", style: "$small"}
`),
  'pages/04_chart.yaml': P('pageType: content\nbackground: "#F8FAFC"\nsource: "夹具自造折线（演示）"\n', `elements:
  - elementId: c_head
    elementType: text
    bounds: [60, 60, 400, 40]
    content: {text: "仿真运行趋势", style: "$h1"}
  - elementId: chart
    elementType: chart
    bounds: [60, 130, 480, 300]
    chart:
      type: line
      data:
        cols: [month, pass]
        rows:
          - ["1月", 92]
          - ["2月", 94]
          - ["3月", 95]
          - ["4月", 96]
      series:
        - {name: 一次合格率, x: month, y: pass}
      colors: ["$primary"]
  - elementId: key
    elementType: shape
    kind: roundRect
    bounds: [580, 130, 320, 300]
    fill: "#FFFFFF"
    line: {color: "#CBD5E1", width: 1}
  - elementId: key_t
    elementType: text
    bounds: [610, 160, 260, 60]
    content: {text: "关键指标", style: "$h2"}
  - elementId: key_body
    elementType: text
    bounds: [610, 240, 260, 160]
    content: {text: "一次合格率 96%（+8pt）\\n综合评 45.6% 提升\\n节拍 −15%", style: "$body"}
expectedOverlaps:
  - {pair: [key, key_t]}
  - {pair: [key, key_body]}
`),
  'pages/05_timeline.yaml': P('pageType: content\nbackground: "#F8FAFC"\n', `elements:
  - elementId: tl_head
    elementType: text
    bounds: [60, 60, 500, 40]
    content: {text: "实施路线（五阶段）", style: "$h1"}
  - elementId: tl_line
    elementType: line
    points: [[80, 200], [860, 200]]
    line: {color: "#94A3B8", width: 2}
  - elementId: st1
    elementType: shape
    kind: pentagon
    bounds: [60, 140, 140, 60]
    fill: "#2563EB"
  - elementId: st1_t
    elementType: text
    bounds: [70, 148, 120, 44]
    content: {text: "建模", style: "$h2", color: "#FFFFFF", align: center}
  - elementId: st2
    elementType: shape
    kind: pentagon
    bounds: [220, 140, 140, 60]
    fill: "#3B82F6"
  - elementId: st2_t
    elementType: text
    bounds: [230, 148, 120, 44]
    content: {text: "映射", style: "$h2", color: "#FFFFFF", align: center}
  - elementId: st3
    elementType: shape
    kind: pentagon
    bounds: [380, 140, 140, 60]
    fill: "#F59E0B"
  - elementId: st3_t
    elementType: text
    bounds: [390, 148, 120, 44]
    content: {text: "仿真", style: "$h2", color: "#FFFFFF", align: center}
  - elementId: st4
    elementType: shape
    kind: pentagon
    bounds: [540, 140, 140, 60]
    fill: "#8B5CF6"
  - elementId: st4_t
    elementType: text
    bounds: [550, 148, 120, 44]
    content: {text: "验证", style: "$h2", color: "#FFFFFF", align: center}
  - elementId: st5
    elementType: shape
    kind: pentagon
    bounds: [700, 140, 140, 60]
    fill: "#10B981"
  - elementId: st5_t
    elementType: text
    bounds: [710, 148, 120, 44]
    content: {text: "推广", style: "$h2", color: "#FFFFFF", align: center}
  - elementId: tl_note
    elementType: text
    bounds: [80, 300, 800, 100]
    content: {text: "单向推进 + 每阶段门禁：建模评审 → 映射校验 → 仿真对标 → 验证报告 → 批量复制\\n（时间线为示意图，非真实排期）", style: "$body"}
expectedOverlaps:
  - {pair: [st1, tl_line]}
  - {pair: [st2, tl_line]}
  - {pair: [st3, tl_line]}
  - {pair: [st4, tl_line]}
  - {pair: [st5, tl_line]}
  - {pair: [st1, st1_t]}
  - {pair: [st2, st2_t]}
  - {pair: [st3, st3_t]}
  - {pair: [st4, st4_t]}
  - {pair: [st5, st5_t]}
`),
  'pages/06_longtext.yaml': P('pageType: content\nbackground: "#F8FAFC"\n', `elements:
  - elementId: lt_head
    elementType: text
    bounds: [60, 60, 500, 40]
    content: {text: "长文本容纳（保守估算 + 显式断行）", style: "$h1"}
  - elementId: lt_body
    elementType: text
    bounds: [60, 130, 840, 340]
    content:
      text: "这一段用于验证长文本在保守估算下的处理：中文全角加粗按 1.06 系数、行高 1.2、标点禁则——\\n显式断行是长句的最佳实践，容器也必须给足高度。\\n本夹具故意把每行控制在 40 字以内，并预留 340px 高度（约 20 行×16.8px），确保门禁零错误，\\n同时验证保守估算不误报：若容器足够，estimate 与实测应一致。"
      style: "$body"
`),
  'pages/07_safearea.yaml': P('pageType: content\nbackground: "#F8FAFC"\nexpectedOutOfSafeArea: [logo, logo_t, footer, footer_t]\n', `elements:
  - elementId: logo
    elementType: shape
    kind: ellipse
    bounds: [895, 8, 40, 30]
    fill: "#2563EB"
  - elementId: logo_t
    elementType: text
    bounds: [897, 12, 36, 24]
    content: {text: "S", style: "$body", color: "#FFFFFF", align: center}
  - elementId: sa_title
    elementType: text
    bounds: [60, 70, 600, 40]
    content: {text: "安全区与页脚带声明（logo 落在安全区外）", style: "$h1"}
  - elementId: sa_body
    elementType: text
    bounds: [60, 140, 840, 200]
    content: {text: "主题 safeArea 定义为顶/底/左/右 34/26/40/40px：内容不得侵入。\\n页脚带（y≥514）属于安全区外——如需放角标，用 expectedOutOfSafeArea 声明（已声明 logo）。", style: "$body"}
  - elementId: footer
    elementType: shape
    kind: rect
    bounds: [0, 514, 960, 26]
    fill: "#E2E8F0"
  - elementId: footer_t
    elementType: text
    bounds: [60, 518, 300, 20]
    content: {text: "页脚带：夹具页脚 © v1.0.0", style: "$small"}
expectedOverlaps:
  - {pair: [logo, logo_t]}
  - {pair: [footer, footer_t]}
`),
  'pages/08_contrast.yaml': P('pageType: content\nbackground: "#F8FAFC"\n', `elements:
  - elementId: ct_head
    elementType: text
    bounds: [60, 60, 600, 40]
    content: {text: "对比度承载面（渐变深底白字）", style: "$h1"}
  - elementId: carrier
    elementType: shape
    kind: parallelogram
    bounds: [60, 150, 400, 180]
    fill: {type: gradient, stops: [{pos: 0, color: "#0F172A"}, {pos: 100, color: "#2563EB"}], angle: 90}
  - elementId: carrier_t
    elementType: text
    bounds: [110, 230, 300, 60]
    content: {text: "深底上的白字", style: "$h2", color: "#FFFFFF", align: center}
  - elementId: ct_note
    elementType: text
    bounds: [520, 170, 380, 140]
    content: {text: '对比度启发式以最近承载面（渐变中途 stop）为基准——本页不应报"白字 vs 页面背景"误报。', style: "$body"}
expectedOverlaps:
  - {pair: [carrier, carrier_t]}
`),
  'pages/09_custgeom.yaml': P('pageType: content\nbackground: "#F8FAFC"\nexpectedOutOfSafeArea: [arc]\n', `elements:
  - elementId: cg_head
    elementType: text
    bounds: [60, 60, 600, 40]
    content: {text: "custGeom 自定义几何（弧带装饰）", style: "$h1"}
  - elementId: arc
    elementType: shape
    kind: custGeom
    bounds: [600, 320, 320, 200]
    path:
      w: 320
      h: 200
      commands:
        - {cmd: moveTo, pts: [[0, 200]]}
        - {cmd: arcTo, pts: [[160, 100]], wR: 160, hR: 100, stAng: 0, swAng: 5400000}
        - {cmd: lnTo, pts: [[200, 60]]}
        - {cmd: cubicBezTo, pts: [[180, 40], [120, 20], [0, 20]]}
        - {cmd: close}
    fill: {color: "#2563EB", alpha: 35}
  - elementId: cg_body
    elementType: text
    bounds: [60, 140, 500, 160]
    content: {text: "弧带为装饰层（role: decoration 豁免重叠）；几何：moveTo/arcTo/lnTo/cubicBezTo/close。", style: "$body"}
  - elementId: deco
    elementType: shape
    kind: ellipse
    bounds: [700, 60, 120, 120]
    fill: {color: "#F59E0B", alpha: 30}
    role: decoration
`),
  'pages/10_numbers.yaml': P('pageType: content\nbackground: "#F8FAFC"\nsource: "夹具自造摘要（45.6% 与 04 页跨页）"\n', `elements:
  - elementId: num_card
    elementType: shape
    kind: roundRect
    bounds: [60, 90, 380, 220]
    fill: "#FFFFFF"
    line: {color: "#CBD5E1", width: 1}
  - elementId: num_v
    elementType: text
    bounds: [100, 120, 300, 80]
    content: {text: "45.6%", style: "$title", color: "#2563EB", align: center}
  - elementId: num_l
    elementType: text
    bounds: [100, 220, 300, 40]
    content: {text: "综合效率提升（与 04 页同值）", style: "$small", align: center}
  - elementId: num_note
    elementType: text
    bounds: [480, 120, 420, 160]
    content: {text: "跨页对账演示：本页 45.6% 与第 04 页 key_body 的 45.6% 应被 ppt_crosscheck 归为一组。", style: "$body"}
expectedOverlaps:
  - {pair: [num_card, num_v]}
  - {pair: [num_card, num_l]}
`),
  'pages/11_section.yaml': P('pageType: content\nbackground: "#F8FAFC"\nexpectedOutOfSafeArea: [sec_band]\n', `elements:
  - elementId: sec_band
    elementType: shape
    kind: rect
    bounds: [0, 0, 960, 540]
    fill: "#0F172A"
  - elementId: sec_num
    elementType: text
    bounds: [80, 180, 300, 120]
    content: {text: "03", style: "$title", color: "#F59E0B"}
  - elementId: sec_t
    elementType: text
    bounds: [400, 200, 480, 80]
    content: {text: "验证与展望", style: "$title", color: "#FFFFFF"}
expectedOverlaps:
  - {pair: [sec_band, sec_num]}
  - {pair: [sec_band, sec_t]}
`),
  'pages/12_summary.yaml': P('pageType: content\nbackground: "#F8FAFC"\n', `elements:
  - elementId: sm_head
    elementType: text
    bounds: [60, 60, 600, 40]
    content: {text: "总结：一条可验证的生产线", style: "$h1"}
  - elementId: sm_a
    elementType: shape
    kind: roundRect
    bounds: [60, 130, 260, 180]
    fill: "#DBEAFE"
  - elementId: sm_a_t
    elementType: text
    bounds: [80, 150, 220, 60]
    content: {text: "声明制", style: "$h2", color: "#1E3A8A", align: center}
  - elementId: sm_a_b
    elementType: text
    bounds: [80, 220, 220, 70]
    content: {text: "冲突防不住？声明设计意图", style: "$body"}
  - elementId: sm_b
    elementType: shape
    kind: roundRect
    bounds: [350, 130, 260, 180]
    fill: "#FEF3C7"
  - elementId: sm_b_t
    elementType: text
    bounds: [370, 150, 220, 60]
    content: {text: "双轨审阅", style: "$h2", color: "#92400E", align: center}
  - elementId: sm_b_b
    elementType: text
    bounds: [370, 220, 220, 70]
    content: {text: "数字门禁 + 视觉审阅 + 真渲染", style: "$body"}
  - elementId: sm_c
    elementType: shape
    kind: roundRect
    bounds: [640, 130, 260, 180]
    fill: "#D1FAE5"
  - elementId: sm_c_t
    elementType: text
    bounds: [660, 150, 220, 60]
    content: {text: "保真交付", style: "$h2", color: "#065F46", align: center}
  - elementId: sm_c_b
    elementType: text
    bounds: [660, 220, 220, 70]
    content: {text: "splice / slice / patch", style: "$body"}
  - elementId: sm_foot
    elementType: text
    bounds: [60, 360, 840, 90]
    content: {text: "结论：元素区块冲突被机器防住（声明制），质量可验证（三轨），保真可一指令（splice）。", style: "$body"}
expectedOverlaps:
  - {pair: [sm_a, sm_a_t]}
  - {pair: [sm_a, sm_a_b]}
  - {pair: [sm_b, sm_b_t]}
  - {pair: [sm_b, sm_b_b]}
  - {pair: [sm_c, sm_c_t]}
  - {pair: [sm_c, sm_c_b]}
`),
}

const miniPages = {
  'pages/01.yaml': 'pageType: content\nelements:\n  - elementId: only\n    elementType: text\n    bounds: [60, 60, 400, 60]\n    content: {text: "唯一元素页", style: "$body"}\n',
  'pages/02.yaml': 'pageType: content\n# 空页（仅背景）\n',
  'pages/03.yaml': 'pageType: content\nelements:\n  - elementId: t\n    elementType: text\n    bounds: [40, 40, 300, 40]\n    content: {text: "极简页", style: "$body"}\n',
}

export async function genFixtures() {
  await rm(fx, { recursive: true, force: true })
  await mkdir(join(fx, 'fx-pro', 'pages'), { recursive: true })
  await mkdir(join(fx, 'fx-mini', 'pages'), { recursive: true })
  await writeFile(join(fx, 'fx-pro', 'deck.yaml'), `# 高难度综合夹具（v1.0.0 自包含测试案例；声明齐备 → verify 应 0 错误）
version: 1
title: "能力验证演示"
size: [960, 540]
${THEME}pages:
${Object.keys(pages).map((k) => `  - ${k}`).join('\n')}
`)
  for (const [k, body] of Object.entries(pages)) await writeFile(join(fx, 'fx-pro', k), body)
  await writeFile(join(fx, 'fx-mini', 'deck.yaml'), `# 迷你夹具（快速路径）
version: 1
title: "迷你演示"
size: [960, 540]
${THEME}pages:
  - pages/01.yaml
  - pages/02.yaml
  - pages/03.yaml
`)
  for (const [k, body] of Object.entries(miniPages)) await writeFile(join(fx, 'fx-mini', k), body)
  // 自产 seed：fx-pro 导出（splice/slice 的自产 source——不依赖任何外部资产）
  const ctx = await resolveDeck(join(fx, 'fx-pro'))
  const r = await exportPptx(ctx, { out: join(fx, 'seed.pptx'), engine: 'pptd' })
  return { fx, seed: r.file, pages: ctx.pages.length }
}

if (process.argv[1] && import.meta.url.replace(/\\/g, '/').endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const info = await genFixtures()
  console.log('fixtures generated:', info.fx, '| seed:', info.seed, '| pages:', info.pages)
}
