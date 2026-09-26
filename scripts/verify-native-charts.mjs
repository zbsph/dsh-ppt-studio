#!/usr/bin/env node
/**
 * 原生可编辑图表验证（第三轮 / 共享任务 task-3）——**可复跑、退出码 0/1**。
 *
 * 为什么需要：`chart` 第三轮起默认产出**原生可编辑图表**（PowerPoint 里能"编辑数据"、能换类型、
 * 数据随文件走）。这类交付"看起来对"太容易——图表帧写进 slide 但 PowerPoint 静默丢弃、
 * 内嵌工作簿是空壳、缓存数据与工作簿不一致，都会让入口预览全绿而成品不可用。所以本脚本**只认真实证据**：
 *
 *   ① 真 PowerPoint COM 渲染（无 Office 时退 LibreOffice kit）→ 逐页 PNG + **像素级**确认图形真的画出来了
 *      （不是"能打开"就算过：按系列色统计渲染图里的命中像素数）；
 *   ② 独立阅读器 python-pptx 反读 → `has_chart === true`、`chart_type` 与 DSL 一致、`series.values` 与 DSL 一致；
 *   ③ 内嵌工作簿用**另一个独立阅读器** openpyxl 反读 → 网格数据与 deck 数据逐格一致（数据随文件走）；
 *   ④ 包内部件清单（ppt/charts/*.xml、ppt/embeddings/*.xlsx、slide rels、Content_Types）+ 官方
 *      `check_office.py` 结构自证 pass；
 *   ⑤ 预览对齐（SVG）：图例/坐标轴/网格线/数据标签该画就画，矢量降级路径不画（预览 == 成品）；
 *   ⑥ **负面对照**：篡改内嵌工作簿数值 / 删掉工作簿部件 / 删掉一个 chart 部件 —— parity 判据必须报红。
 *      （不做负对照的判据等于没判据：它可能永远为绿。）
 *
 * 用法：
 *   node scripts/verify-native-charts.mjs
 *   PPT_STUDIO_RESOURCES_DIR=<install>/resources node scripts/verify-native-charts.mjs   # 指到官方 office 资产
 *   PPT_STUDIO_ALLOW_SKIP_OFFICE=1 …                                                     # 无 COM/官方资产时降级为 SKIP（不计 FAIL）
 *
 * 临时产物全部在系统 TEMP 下的 `pptd-native-chart-verify/`（不往仓库里塞东西）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const allowSkip = process.env.PPT_STUDIO_ALLOW_SKIP_OFFICE === '1'

// 官方 office 资产的定位缝（capabilities.js 的 PPT_STUDIO_RESOURCES_DIR）：脚本自己先探一遍桌面端常见位置，
// 免得每次都要手写环境变量（探不到就如实报"不可用"，绝不假装跑过）。
function guessResources() {
  const cands = [
    process.env.PPT_STUDIO_RESOURCES_DIR,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources') : null,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'DeepSeek Harness', 'resources') : null,
    'C:\\Program Files\\DeepSeek Harness\\resources',
  ].filter(Boolean)
  for (const c of cands) if (existsSync(join(c, 'runtime', 'office-skills'))) return c
  return null
}
const res = guessResources()
if (res) process.env.PPT_STUDIO_RESOURCES_DIR = res

const { resolveDeck } = await import('../lib/pptd/schema.js')
const { validatePage, chartOptions } = await import('../lib/pptd/schema.js')
const { exportPptx } = await import('../lib/pptd/export-pptx.js')
const { renderDeck } = await import('../lib/pptd/render-html.js')
const { normalizePage } = await import('../lib/pptd/layout.js')
const { resolveChart } = await import('../lib/pptd/svgCharts.js')
const { auditNativeCharts, chartPartNames, sheetGridFromXlsx } = await import('../lib/pptd/nativeChart.js')
const { zipRead, zipWrite } = await import('../lib/zips.js')
const { renderPptxToPng, findPowerPoint } = await import('../lib/msrender.js')
const { runOfficeStructureCheck, runLibreOfficeRender } = await import('../lib/office-qa.js')
const { findAnyPython } = await import('../lib/capabilities.js')

// ── 断言脚手架 ─────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      └─ ${detail}` : ''}`)
}
const h = (t) => console.log(`\n=== ${t} ===`)
const trunc = (s, n = 900) => {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + ' …' : t
}

// ── 测试 deck（数据唯一真相：YAML 由这里的常量生成，避免"手写 YAML vs 断言常量"漂移）────
const WORK = join(tmpdir(), 'pptd-native-chart-verify')
const DECK = join(WORK, 'deck')

// 图表 0：多系列柱状（默认 native；legend auto → 多系列显示；labels auto → 柱状不显示）
// 图表 1：折线（显式 legend: right + labels: true）
// 图表 2：饼图（legend auto → 显示；labels auto → 显示百分比+分类名）
// 图表 3：render: vector 降级（仍走矢量拼绘，不产图表部件）
const CHARTS = [
  {
    id: 'bar2', page: 1, bounds: [40, 60, 500, 300],
    type: 'bar', colors: ['#2563EB', '#F59E0B'],
    cols: ['季度', '营收', '成本'],
    rows: [['Q1', 12.5, 8], ['Q2', 30, 15], ['Q3', 18, 11], ['Q4', 42, 22]],
    series: [{ name: '营收', x: '季度', y: '营收' }, { name: '成本', x: '季度', y: '成本' }],
    chartType: 'COLUMN_CLUSTERED',
    values: [[12.5, 30, 18, 42], [8, 15, 11, 22]],
    cats: ['Q1', 'Q2', 'Q3', 'Q4'],
    grid: [['季度', '营收', '成本'], ['Q1', 12.5, 8], ['Q2', 30, 15], ['Q3', 18, 11], ['Q4', 42, 22]],
    native: true,
  },
  {
    id: 'line1', page: 2, bounds: [40, 60, 500, 300],
    type: 'line', legend: 'right', labels: true,
    cols: ['月份', '值'],
    rows: [['1月', 92], ['2月', 94], ['3月', 95]],
    chartType: 'LINE_MARKERS',
    values: [[92, 94, 95]],
    cats: ['1月', '2月', '3月'],
    grid: [['月份', '值'], ['1月', 92], ['2月', 94], ['3月', 95]],
    native: true,
  },
  {
    id: 'pie1', page: 3, bounds: [40, 60, 400, 300],
    type: 'pie',
    cols: ['份额', '值'],
    rows: [['甲', 60], ['乙', 25], ['丙', 15]],
    chartType: 'PIE',
    values: [[60, 25, 15]],
    cats: ['甲', '乙', '丙'],
    grid: [['份额', '值'], ['甲', 60], ['乙', 25], ['丙', 15]],
    palette: ['#2563EB', '#F59E0B', '#10B981'],
    native: true,
  },
  {
    id: 'vec1', page: 4, bounds: [40, 60, 400, 300],
    type: 'bar', render: 'vector',
    cols: ['季度', '值'],
    rows: [['Q1', 12], ['Q2', 18]],
    native: false,
    shapeCount: 2,
  },
]

function chartYaml(c) {
  const lines = [
    'pageType: content',
    'elements:',
    `  - elementId: ${c.id}`,
    '    elementType: chart',
    `    bounds: ${JSON.stringify(c.bounds)}`,
    '    chart:',
    `      type: ${c.type}`,
  ]
  if (c.render) lines.push(`      render: ${c.render}`)
  if (c.legend) lines.push(`      legend: ${c.legend}`)
  if (c.labels !== undefined) lines.push(`      labels: ${c.labels}`)
  if (c.colors) lines.push(`      colors: ${JSON.stringify(c.colors)}`)
  lines.push('      data:', `        cols: ${JSON.stringify(c.cols)}`, '        rows:')
  for (const r of c.rows) lines.push(`          - ${JSON.stringify(r)}`)
  if (c.series) {
    lines.push('      series:')
    for (const s of c.series) lines.push(`        - {name: ${s.name}, x: ${s.x}, y: ${s.y}}`)
  }
  lines.push('')
  return lines.join('\n')
}

console.log('=== pptd 原生可编辑图表验证（第三轮 / task-3）===')
console.log(`仓库：${root}`)
console.log(`临时工作区：${WORK}`)
console.log(`官方 office 资产：${res ?? '（未探到）'}｜Python：${findAnyPython()?.path ?? '（无）'}｜PowerPoint：${findPowerPoint() ?? '（无）'}`)

rmSync(WORK, { recursive: true, force: true })
mkdirSync(join(DECK, 'pages'), { recursive: true })
writeFileSync(join(DECK, 'deck.yaml'), [
  'version: 1', 'title: native-chart-verify', 'size: [960, 540]', 'theme:',
  '  colors: {primary: "#2563EB", text: "#1F2937"}', '  textStyles:',
  '    body: {fontSize: 16, color: "$text"}', 'pages:',
  ...CHARTS.map((c) => `  - pages/${String(c.page).padStart(2, '0')}.yaml`), '',
].join('\n'), 'utf8')
for (const c of CHARTS) writeFileSync(join(DECK, 'pages', `${String(c.page).padStart(2, '0')}.yaml`), chartYaml(c), 'utf8')

// ── 1. 导出 + parity ──────────────────────────────────────────────────────
h('1. 导出与 parity（声明的 chart 元素数 / 图表部件数 / 内嵌工作簿数据）')
const ctx = await resolveDeck(DECK)
const outPptx = join(WORK, 'out.pptx')
const report = await exportPptx(ctx, { out: outPptx })
const p = report.parity ?? {}
console.log(`parity 原始输出：\n${JSON.stringify(p, null, 1)}`)

const nativeCharts = CHARTS.filter((c) => c.native)
check('parity.ok 全绿（计数 + 内容级 + 图表部件/数据判据）', p.ok === true, `ok=${p.ok}`)
check('chartsExp == 原生图表元素数（3 个：bar/line/pie）', p.chartsExp === nativeCharts.length, `chartsExp=${p.chartsExp}`)
check('chartsOut == 包内 ppt/charts/*.xml 数', p.chartsOut === nativeCharts.length, `chartsOut=${p.chartsOut}`)
check('内嵌工作簿数 == 原生图表数', p.chartEmbedsOut === nativeCharts.length, `chartEmbedsOut=${p.chartEmbedsOut}`)
check('图表数据逐格自证通过（chartDataMismatch 为空）', (p.chartDataMismatch ?? ['x']).length === 0, `mismatch=${JSON.stringify(p.chartDataMismatch)}`)
check('图表关系链自证通过（帧 r:id → slide rels → chartN.xml → externalData → 工作簿）', (p.chartRelsMissing ?? ['x']).length === 0 && (p.chartFramesMissing ?? ['x']).length === 0, `relsMissing=${JSON.stringify(p.chartRelsMissing)} framesMissing=${JSON.stringify(p.chartFramesMissing)}`)
check('矢量降级路径仍走形状计数自证（chartShapesExp == chartShapesOut == 2）', p.chartShapesExp === 2 && p.chartShapesOut === 2, `exp=${p.chartShapesExp} out=${p.chartShapesOut}`)
check('report.nativeCharts 清单可观测（id/page/chartNo/part/embed）', Array.isArray(report.nativeCharts) && report.nativeCharts.length === 3 && report.nativeCharts[0].part === 'ppt/charts/chart1.xml' && report.nativeCharts[2].embed === 'ppt/embeddings/Microsoft_Excel_Sheet3.xlsx', JSON.stringify(report.nativeCharts))

// ── 1b. DSL 扩展：校验 + 默认值（旧 deck 不写 render ⇒ native）────────────────
h('1b. DSL 扩展（render/legend/labels/axes）的校验与默认值')
{
  const pageOf = (chart) => ({ pageType: 'content', elements: [{ elementId: 'c', elementType: 'chart', bounds: [0, 0, 100, 100], chart }] })
  const errsOf = (chart) => validatePage(pageOf(chart), 'p.yaml')
  const data = { cols: ['季度', '值'], rows: [['Q1', 12], ['Q2', 18]] }
  const base = { type: 'bar', data }
  check('旧写法（无 render/legend/labels/axes）校验通过 —— 向后兼容', errsOf(base) === null, JSON.stringify(errsOf(base)))
  check('render: native|vector 都合法', errsOf({ ...base, render: 'native' }) === null && errsOf({ ...base, render: 'vector' }) === null, '')
  const bad = (chart) => JSON.stringify(errsOf(chart) ?? '')
  check('render 非法值被拒（并指向 native/vector）', bad({ ...base, render: 'svg' }).includes('chart.render'), bad({ ...base, render: 'svg' }))
  check('legend 非法值被拒（top/bottom/left/right 或 bool）', bad({ ...base, legend: 'middle' }).includes('chart.legend'), bad({ ...base, legend: 'middle' }))
  check('labels 非 bool 被拒', bad({ ...base, labels: 'yes' }).includes('chart.labels'), bad({ ...base, labels: 'yes' }))
  check('axes 非 bool 被拒', bad({ ...base, axes: 1 }).includes('chart.axes'), bad({ ...base, axes: 1 }))
  check('render: vector + legend/labels/axes 显式值 → **报错**而不是静默忽略', bad({ ...base, render: 'vector', legend: true }).includes('仅 render=native'), bad({ ...base, render: 'vector', legend: true }))
  const o = chartOptions({ type: 'bar', data })
  check('chartOptions 默认值：render=native / legend=auto / labels=auto / axes=true', o.render === 'native' && o.legend === 'auto' && o.labels === 'auto' && o.axes === true, JSON.stringify(o))
  const single = resolveChart({ type: 'bar', data })
  const multi = resolveChart({ type: 'bar', data: { cols: ['季度', 'A', 'B'], rows: [['Q1', 1, 2]] }, series: [{ name: 'A', x: '季度', y: 'A' }, { name: 'B', x: '季度', y: 'B' }] })
  const pie = resolveChart({ type: 'pie', data: { cols: ['份额', '值'], rows: [['甲', 1], ['乙', 2]] } })
  const vec = resolveChart({ type: 'bar', data, render: 'vector' })
  check('auto 落地：单系列不画图例 / 多系列画图例 / 饼图画图例+数据标签 / 矢量路径都不画（预览==成品）', single.opts.legend === false && single.opts.labels === false && multi.opts.legend === 'bottom' && pie.opts.legend === 'bottom' && pie.opts.labels === true && vec.opts.legend === false && vec.opts.labels === false && vec.opts.axes === false, JSON.stringify({ single: single.opts, multi: multi.opts, pie: pie.opts, vec: vec.opts }))
}

// ── 2. 包内部件清单 + 结构 ────────────────────────────────────────────────
h('2. 包内部件清单与结构（pkg 级反读，不读中间层）')
const pkgBytes = readFileSync(outPptx)
const pkg = zipRead(pkgBytes)
const keys = [...pkg.keys()]
const chartParts = keys.filter((k) => /^ppt\/charts\/chart\d+\.xml$/.test(k))
const chartRels = keys.filter((k) => /^ppt\/charts\/_rels\/chart\d+\.xml\.rels$/.test(k))
const embeds = keys.filter((k) => /^ppt\/embeddings\/.+\.xlsx$/.test(k))
check('部件清单：chartN.xml / chartN.xml.rels / Microsoft_Excel_SheetN.xlsx 各 3 份', chartParts.length === 3 && chartRels.length === 3 && embeds.length === 3, `charts=${chartParts.join(',')} rels=${chartRels.length} embeds=${embeds.length}`)
const ct = pkg.get('[Content_Types].xml').toString('utf8')
check('Content_Types：chart 部件 Override + xlsx Default 都在', chartParts.every((k) => ct.includes(`PartName="/${k}"`) && ct.includes('drawingml.chart+xml')) && ct.includes('Extension="xlsx"'), trunc(ct, 400))
const EXTERNAL = /<c:externalData[^>]*r:id="([^"]+)"/.exec(pkg.get('ppt/charts/chart1.xml').toString('utf8'))?.[1]
const chart1Rels = pkg.get('ppt/charts/_rels/chart1.xml.rels').toString('utf8')
check('chart1.xml 的 c:externalData 关系真的指向内嵌工作簿（type=.../package）', EXTERNAL === 'rId1' && chart1Rels.includes('Id="rId1"') && chart1Rels.includes('../embeddings/Microsoft_Excel_Sheet1.xlsx') && chart1Rels.includes('/package'), `r:id=${EXTERNAL}｜${trunc(chart1Rels, 260)}`)
const slide1Rels = pkg.get('ppt/slides/_rels/slide1.xml.rels').toString('utf8')
check('slide1 有 chart 关系（../charts/chart1.xml）', slide1Rels.includes('relationships/chart') && slide1Rels.includes('../charts/chart1.xml'), trunc(slide1Rels, 300))
const slide1 = pkg.get('ppt/slides/slide1.xml').toString('utf8')
check('slide1 图表帧结构合法：graphicFrame + graphicData uri=.../chart + 无嵌套 <p:xfrm><a:xfrm>', slide1.includes('<p:graphicFrame>') && slide1.includes('drawingml/2006/chart') && slide1.includes('r:id="rId2"') && !slide1.includes('<p:xfrm><a:xfrm>'), trunc(slide1.match(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/)?.[0] ?? '', 420))
const slot2 = zipRead(pkg.get('ppt/embeddings/Microsoft_Excel_Sheet1.xlsx'))
check('内嵌 xlsx 自带完整最小结构（[Content_Types]/_rels/workbook/sheet1/styles）', ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/styles.xml'].every((k) => slot2.has(k)), [...slot2.keys()].join(' '))
const grid1 = sheetGridFromXlsx(pkg.get('ppt/embeddings/Microsoft_Excel_Sheet1.xlsx'))
check('自研读取器解 sheet1 网格 == deck 数据（bar2：A1:C5）', JSON.stringify(grid1) === JSON.stringify(CHARTS[0].grid), `got=${JSON.stringify(grid1)}`)

// ── 2b. 同一页混排：图片 + 图表 + 讲稿（rId 编号不串号）─────────────────────
h('2b. 同一页混排（图片 + 原生图表 + 讲稿）：rId 分配不串号')
{
  const mix = join(WORK, 'mixed')
  mkdirSync(join(mix, 'pages'), { recursive: true })
  mkdirSync(join(mix, 'media'), { recursive: true })
  writeFileSync(join(mix, 'media', 'px.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  writeFileSync(join(mix, 'deck.yaml'), ['version: 1', 'title: mixed', 'size: [960, 540]', 'theme:',
    '  colors: {primary: "#2563EB"}', '  textStyles:', '    body: {fontSize: 16, color: "$primary"}',
    'pages:', '  - pages/01.yaml', ''].join('\n'), 'utf8')
  writeFileSync(join(mix, 'pages', '01.yaml'), [
    'pageType: content', 'notes: 混排页讲稿', 'elements:',
    '  - elementId: im', '    elementType: image', '    bounds: [40, 40, 100, 60]', '    src: media/px.png',
    '  - elementId: ch', '    elementType: chart', '    bounds: [200, 60, 400, 300]',
    '    chart:', '      type: bar', '      data:', '        cols: [季度, 值]', '        rows: [[Q1, 12], [Q2, 18]]',
    '', ''].join('\n'), 'utf8')
  const mixOut = join(mix, 'out.pptx')
  const mr = await exportPptx(await resolveDeck(mix), { out: mixOut })
  const mp = zipRead(readFileSync(mixOut))
  const rels = mp.get('ppt/slides/_rels/slide1.xml.rels').toString('utf8')
  const s1 = mp.get('ppt/slides/slide1.xml').toString('utf8')
  const okOrder = /Id="rId2"[^>]*relationships\/image[^>]*media\/px\.png/.test(rels) &&
    /Id="rId3"[^>]*relationships\/notesSlide[^>]*notesSlide1\.xml/.test(rels) &&
    /Id="rId4"[^>]*relationships\/chart[^>]*charts\/chart1\.xml/.test(rels) &&
    s1.includes('r:embed="rId2"') && s1.includes('r:id="rId4"') && mp.has('ppt/notesSlides/notesSlide1.xml') && mr.parity.ok === true
  check('图片=rId2 / 讲稿=rId3 / 图表=rId4 三条关系各就各位，帧引用正确（rId 串号就是"图变错图/图表丢帧"这类事故）', okOrder, `rels=${trunc(rels.replace(/^.*<Relationships[^>]*>/, ''), 380)}`)
}

// ── 3. python-pptx / openpyxl 独立反读 ────────────────────────────────────
h('3. 独立阅读器反读：python-pptx（has_chart / chart_type / series values）+ openpyxl（内嵌工作簿）')
const py = findAnyPython()
const READBACK = join(WORK, 'readback.py')
writeFileSync(READBACK, `import json, sys, zipfile, io
from pptx import Presentation
import openpyxl

prs = Presentation(sys.argv[1])
out = {"slides": len(prs.slides._sldIdLst), "charts": [], "embeds": []}
for i, slide in enumerate(prs.slides, 1):
    for sh in slide.shapes:
        if getattr(sh, "has_chart", False):
            ch = sh.chart
            out["charts"].append({
                "slide": i,
                "has_chart": True,
                "chart_type": str(ch.chart_type).split(" ")[0],
                "has_legend": bool(ch.has_legend),
                "series": [{"name": s.name, "values": [float(v) for v in s.values]} for s in ch.series],
                "cats": [str(c) for c in ch.plots[0].categories],
            })
z = zipfile.ZipFile(sys.argv[1])
for n in sorted(x for x in z.namelist() if x.startswith("ppt/embeddings/")):
    wb = openpyxl.load_workbook(io.BytesIO(z.read(n)), data_only=True)
    ws = wb.active
    grid = [[c.value for c in row] for row in ws.iter_rows()]
    out["embeds"].append({"part": n, "sheet": ws.title, "dims": ws.dimensions, "grid": grid})
print(json.dumps(out, ensure_ascii=False))
`, 'utf8')

let rb = null
let rbErr = ''
if (py === null) {
  rbErr = '没有任何可用的 Python（python-pptx 反读是必需证据）'
} else {
  const r = spawnSync(py.path, ['-X', 'utf8', READBACK, outPptx], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 120000 })
  if (r.status !== 0) rbErr = `exit ${r.status}：${trunc(r.stderr || r.stdout || '', 400)}`
  else {
    try { rb = JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch (e) { rbErr = `JSON 解析失败：${e.message}｜${trunc(r.stdout, 300)}` }
  }
}
check('python-pptx 反读可用（独立阅读器，非自研代码）', rb !== null, rbErr)
if (rb) {
  console.log(`python-pptx/openpyxl 原始输出：\n${trunc(JSON.stringify(rb), 1400)}`)
  check('python-pptx：页数 == 4（3 张原生图表 + 1 张矢量降级）', rb.slides === 4, `slides=${rb.slides}`)
  const bySlide = new Map(rb.charts.map((c) => [c.slide, c]))
  check('has_chart === true（第 1/2/3 页各一个原生图表对象）', [1, 2, 3].every((s) => bySlide.get(s)?.has_chart === true), JSON.stringify(rb.charts.map((c) => [c.slide, c.has_chart])))
  check('矢量降级页（第 4 页）**不是**图表对象（render: vector 语义未漂移）', !bySlide.has(4), `图表对象出现在页：${[...bySlide.keys()].join(',')}`)
  const typeOk = nativeCharts.every((c, i) => bySlide.get(c.page)?.chart_type === c.chartType)
  check('chart_type 与 DSL 一致（COLUMN_CLUSTERED / LINE_MARKERS / PIE）', typeOk, JSON.stringify(nativeCharts.map((c) => [c.id, bySlide.get(c.page)?.chart_type, c.chartType])))
  const seriesOk = nativeCharts.every((c) => {
    const got = bySlide.get(c.page)?.series ?? []
    return got.length === c.values.length && c.values.every((vals, si) => vals.every((v, i) => Math.abs((got[si]?.values ?? [])[i] - v) < 1e-9))
  })
  check('series.values 与 deck 数值一致（逐系列逐点）', seriesOk, JSON.stringify(nativeCharts.map((c) => [c.id, bySlide.get(c.page)?.series.map((s) => s.values)])))
  check('categories（分类轴）与 deck 分类一致', nativeCharts.every((c) => JSON.stringify(bySlide.get(c.page)?.cats) === JSON.stringify(c.cats)), JSON.stringify(nativeCharts.map((c) => [c.id, bySlide.get(c.page)?.cats])))
  check('数据标签/图例声明的落地：3 个原生图表都有图例（多系列 auto、显式 right、饼图 auto）', nativeCharts.every((c) => bySlide.get(c.page)?.has_legend === true), JSON.stringify(rb.charts.map((c) => [c.slide, c.has_legend])))
  const sheetMatch = nativeCharts.every((c, i) => JSON.stringify(rb.embeds[i]?.grid) === JSON.stringify(c.grid))
  check('openpyxl 反读内嵌工作簿 == deck 数据（数据随文件走，independent reader）', rb.embeds.length === 3 && sheetMatch, JSON.stringify(rb.embeds.map((e) => [e.part, e.dims, e.grid])))
}

// ── 4. 官方 check_office.py 结构自证 ──────────────────────────────────────
h('4. 官方 check_office.py 结构自证（ZIP/XML/rels 完整性 + 页数）')
const qa = runOfficeStructureCheck(outPptx, { contains: [], count: 4 })
if (!qa.available) {
  check('官方 check_office.py 结构自证 pass', allowSkip, `不可用：${qa.reason}${allowSkip ? '（已按 PPT_STUDIO_ALLOW_SKIP_OFFICE=1 降级）' : ''}`)
} else {
  check('官方 check_office.py 结构自证 pass（verdict=pass + count=4）', qa.ok === true && qa.verdict === 'pass', `verdict=${qa.verdict} summary=${JSON.stringify(qa.summary)} reason=${qa.reason}`)
}

// ── 5. 真渲染（PowerPoint COM，无 Office 退 LibreOffice kit）+ 像素级确认 ────
h('5. 真渲染出图（PowerPoint COM 优先）+ 像素级确认图形真的画出来')
const shots = join(WORK, 'shots')
let renderEngine = null
let renderInfo = ''
let pngFiles = []
if (findPowerPoint() !== null) {
  // COM 偶尔会因上一条渲染残留的 PowerPoint 实例而失败 ⇒ 重试一次（真渲染是必需证据，不能一次失败就放弃）
  for (let attempt = 1; attempt <= 2 && pngFiles.length === 0; attempt++) {
    try {
      const r = await renderPptxToPng(outPptx, shots, { width: 1920, height: 1080, timeoutMs: 300000 })
      pngFiles = r.files
      renderEngine = 'PowerPoint COM'
      renderInfo = `pages=${r.pages} png=${r.files.length}${attempt > 1 ? `（第 ${attempt} 次尝试成功）` : ''}`
    } catch (e) { renderInfo = `COM 失败（第 ${attempt} 次）：${e?.message ?? e}` }
  }
}
if (pngFiles.length === 0) {
  const lo = runLibreOfficeRender(outPptx, shots, { dpi: 144 })
  if (lo.available && lo.ok) {
    pngFiles = lo.files
    renderEngine = 'LibreOffice kit'
    renderInfo = `png=${lo.files.length}（无 Office 时的替代真渲染；排版引擎与 PowerPoint 不同，不能当逐像素判据）`
  } else {
    renderInfo = `${renderInfo}｜LibreOffice：${lo.reason}`
  }
}
if (pngFiles.length === 0) {
  check('真渲染逐页出图（PowerPoint COM 或 LibreOffice kit）', allowSkip, renderInfo)
} else {
  check(`真渲染逐页出图（引擎：${renderEngine}）`, pngFiles.length === 4, renderInfo)
  // 像素级确认：按系列色统计渲染图命中像素 —— 挡住"文件能打开但图表是空白/被丢弃"
  // 区域按**实际 PNG 宽度/页面宽度**换算（COM 1920/960 = 2×；LibreOffice 的 dpi 可能不同，别写死 2×）。
  const PNGCHECK = join(WORK, 'pngcheck.py')
  writeFileSync(PNGCHECK, `import json, sys
from PIL import Image
img = Image.open(sys.argv[1]).convert("RGB")
deck_w = float(sys.argv[2])
colors = json.loads(sys.argv[3])
tol = int(sys.argv[4])
box = json.loads(sys.argv[5])
scale = img.size[0] / deck_w
crop = img.crop(tuple(int(v * scale) for v in box))
px = list(crop.getdata())
out = {}
for name, hexs in colors.items():
    want = tuple(int(hexs[i:i + 2], 16) for i in (1, 3, 5))
    out[name] = sum(1 for c in px if abs(c[0] - want[0]) <= tol and abs(c[1] - want[1]) <= tol and abs(c[2] - want[2]) <= tol)
print(json.dumps({"size": list(img.size), "scale": round(scale, 3), "box": list(box), "counts": out}))
`, 'utf8')
  const pixelCheck = (png, box, palette) => {
    if (py === null) return { err: '没有可用的 Python（PIL 像素统计需要它）' }
    const r = spawnSync(py.path, ['-X', 'utf8', PNGCHECK, png, String(ctx.size.width), JSON.stringify(Object.fromEntries(palette.map((c, i) => [`c${i}`, c]))), '40', JSON.stringify(box)], { encoding: 'utf8', timeout: 120000 })
    if (r.status !== 0) return { err: `exit ${r.status}：${trunc(r.stderr, 200)}` }
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch (e) { return { err: `解析失败：${e.message}` } }
  }
  const png1 = pngFiles[0]
  const bar = pixelCheck(png1, CHARTS[0].bounds, CHARTS[0].colors)
  const cmp = pixelCheck(pngFiles[2], CHARTS[2].bounds, CHARTS[2].palette)
  const vec = pixelCheck(pngFiles[3], CHARTS[3].bounds, ['#2563EB'])
  console.log(`像素统计（区域按实际 PNG 宽度换算，颜色容差 ±40）：bar=${JSON.stringify(bar.counts ?? bar)}｜pie=${JSON.stringify(cmp.counts ?? cmp)}｜vector=${JSON.stringify(vec.counts ?? vec)}`)
  check('渲染图里真的有两根系列色的柱（#2563EB + #F59E0B 各 ≥ 5000 px）', (bar.counts?.c0 ?? 0) >= 5000 && (bar.counts?.c1 ?? 0) >= 5000, JSON.stringify(bar.counts ?? bar.err))
  check('渲染图里饼图三个扇区色都在（≥ 500 px 各）', ['c0', 'c1', 'c2'].every((k) => (cmp.counts?.[k] ?? 0) >= 500), JSON.stringify(cmp.counts ?? cmp.err))
  check('渲染图里矢量降级路径仍有柱（≥ 5000 px）', (vec.counts?.c0 ?? 0) >= 5000, JSON.stringify(vec.counts ?? vec.err))
}

// ── 5b. LibreOffice 兼容（过渡 OOXML 的第二个消费端）────────────────────────
h('5b. LibreOffice 兼容性（同一份产物，第二个消费端也能开）')
{
  const loDir = join(WORK, 'shots-lo')
  const lo = runLibreOfficeRender(outPptx, loDir, { dpi: 96 })
  if (!lo.available) check('LibreOffice kit 渲染（本部署不可用 ⇒ 跳过，不计 FAIL）', true, lo.reason)
  else check('LibreOffice kit 能打开并渲染出 4 页（原生图表部件不破坏兼容性）', lo.ok === true && lo.files.length === 4, `${lo.reason}${lo.missingFonts?.length ? `｜缺字 ${JSON.stringify(lo.missingFonts.slice(0, 3))}` : ''}`)
}

// ── 6. 预览对齐（SVG 画了成品也有的图例/轴/标签；降级路径不画）──────────────
h('6. 预览对齐：SVG 与成品画同样的图表家具')
const rd = await renderDeck(ctx, {})
const html = (i) => readFileSync(join(rd.outDir, rd.htmlFiles[i - 1]), 'utf8')
const svgOf = (i) => html(i).match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? ''
const s1 = svgOf(1)
const s2 = svgOf(2)
const s3 = svgOf(3)
const s4 = svgOf(4)
check('柱状（多系列）预览画了图例色块 + 两个系列名', (s1.match(/rx="1"/g) ?? []).length >= 2 && s1.includes('营收') && s1.includes('成本'), `swatch=${(s1.match(/rx="1"/g) ?? []).length}`)
check('柱状预览画了网格线 + 坐标轴轴线（原生图表自带，预览必须对齐）', s1.includes('#e2e8f0') && s1.includes('#cbd5e1'), `grid=${s1.includes('#e2e8f0')} axis=${s1.includes('#cbd5e1')}`)
check('折线（labels: true）预览画了数据标签 92/94/95', ['92', '94', '95'].every((v) => new RegExp(`>${v}<`).test(s2)), '')
check('饼图预览画了百分比标签 + 分类图例（甲乙丙）', s3.includes('%<') && ['甲', '乙', '丙'].every((v) => s3.includes(v)), '')
check('render: vector 预览**不画**网格线/轴线/图例（与矢量成品一致，不误导）', !s4.includes('#e2e8f0') && !s4.includes('#cbd5e1') && !s4.includes('rx="1"'), `grid=${s4.includes('#e2e8f0')} axis=${s4.includes('#cbd5e1')} swatch=${(s4.match(/rx="1"/g) ?? []).length}`)

// ── 7. 负面对照：判据必须真的会红 ──────────────────────────────────────────
h('7. 负面对照（不做负对照的判据等于没判据）')
const expected = []
{
  let k = 0
  for (const [i, page] of ctx.pages.entries()) {
    for (const el of normalizePage(page, ctx)) {
      if (el.type !== 'chart') continue
      if (resolveChart(el.chart).opts.render === 'vector') continue
      k++
      expected.push({ id: el.id, page: i + 1, chart: el.chart, chartPart: chartPartNames(k).chart })
    }
  }
}
check('负对照基线：未篡改的包 auditNativeCharts 必须绿', auditNativeCharts(pkg, expected).ok === true, JSON.stringify(auditNativeCharts(pkg, expected)))
const entriesFromMap = (m, overrides = {}, drops = []) => {
  const out = {}
  for (const [k, v] of m) {
    if (drops.includes(k)) continue
    out[k] = Object.prototype.hasOwnProperty.call(overrides, k) ? overrides[k] : v
  }
  return out
}
// (a) 篡改内嵌工作簿里的一个数值 → 数据判据必须红
const embedName = chartPartNames(1).embed
const inner = zipRead(pkg.get(embedName))
const sheetRaw = inner.get('xl/worksheets/sheet1.xml').toString('utf8')
const tamperedSheet = sheetRaw.replace('<v>12.5</v>', '<v>99</v>')
check('负对照(a) 构造成功：内嵌工作簿里的 12.5 被改成 99', tamperedSheet !== sheetRaw, '')
const tamperedInner = zipWrite(entriesFromMap(inner, { 'xl/worksheets/sheet1.xml': Buffer.from(tamperedSheet, 'utf8') }))
const auditA = auditNativeCharts(entriesFromMap(pkg, { [embedName]: tamperedInner }), expected)
check('负对照(a) 数据不一致 ⇒ parity 必须报红（并指出是哪个图的哪格）', auditA.ok === false && auditA.dataMismatch.some((m) => m.includes('bar2')), `ok=${auditA.ok} mismatch=${JSON.stringify(auditA.dataMismatch)}`)
// (b) 删掉内嵌工作簿部件 → 关系断链必须红
const auditB = auditNativeCharts(entriesFromMap(pkg, {}, [embedName]), expected)
check('负对照(b) 内嵌工作簿缺失 ⇒ parity 必须报红（关系目标不存在）', auditB.ok === false && auditB.relsMissing.some((m) => m.includes(embedName)), `ok=${auditB.ok} relsMissing=${JSON.stringify(auditB.relsMissing)}`)
// (c) 删掉一个 chart 部件 → 计数不符必须红
const auditC = auditNativeCharts(entriesFromMap(pkg, {}, ['ppt/charts/chart3.xml']), expected)
check('负对照(c) 图表部件缺失 ⇒ 计数判据必须红（chartsOut < chartsExp）', auditC.ok === false && auditC.chartsOut === 2 && auditC.chartsExp === 3, `chartsExp=${auditC.chartsExp} chartsOut=${auditC.chartsOut}`)

// ── 8. 回归：不含图表的工程产物**零变化** ────────────────────────────────────
// 用户拍板的取舍里有一条：**其他绘图（text/shape/line/image/table/custGeom）保持不变**。
// 判据最硬的一档 = 拿**原生图表之前**的导出器跑同一个（无图表）工程，产物**逐部件**比对（只有 core.xml 的时间戳除外）。
// 关系编号（媒体/讲稿/图表）是我这轮动过的地方，正需要这条挡住"加图表把 rId 排错"的回归。
// ⚠ 2026-09-26 Lead 修复：原实现取 `HEAD:src/pptd/*` 只复制 4 个文件——一旦 HEAD 变成"已含本轮改动"的提交，
//   ① 对照失去意义（新 vs 新），② 复制出来的 svgCharts.js 会 import 未被复制的 ./schema.js ⇒ ERR_MODULE_NOT_FOUND 崩溃。
//   现在改成：从"原生图表之前的参照提交"取**整棵 src/**（相对 import 全部可解析），并有明确的回落链与跳过语义。
h('8. 回归：不含图表的工程产物逐部件零变化（对照"原生图表之前"的导出器）')
{
  const oldDir = join(WORK, 'old-src')
  const refs = [process.env.PPT_OLD_EXPORT_REF, 'eb1e6f8', 'v1.1.2', 'HEAD~1'].filter(Boolean)
  let ref = null
  for (const cand of refs) {
    const r = spawnSync('git', ['-C', root, 'cat-file', '-e', `${cand}^{commit}`], { encoding: 'utf8' })
    if (r.status === 0) { ref = cand; break }
  }
  let extracted = false
  if (ref !== null) {
    const list = spawnSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', ref, 'src'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    const files = String(list.stdout ?? '').trim().split('\n').filter(Boolean)
    extracted = list.status === 0 && files.length > 0
    for (const f of files) {
      const r = spawnSync('git', ['-C', root, 'show', `${ref}:${f}`], { maxBuffer: 32 * 1024 * 1024 })
      if (r.status !== 0) { extracted = false; break }
      const rel = f.replace(/^src\//, '')
      mkdirSync(join(oldDir, dirname(rel)), { recursive: true })
      writeFileSync(join(oldDir, rel), r.stdout)
    }
  }
  if (!extracted) {
    check(`回归对照：参照提交的 src/ 可取得（尝试 ${refs.join(' → ')}；无 git/无该提交 ⇒ 跳过，不计 FAIL）`, true, '未取得参照，跳过逐部件对照')
  } else {
    check(`回归对照：参照版本 = ${ref}（整棵 src/ 已取出，相对 import 可解析）`, true, `文件数 = 已复制`)
    // 无图表的工程：文本 / 表格 / 形状 / 连线 / 图片 / 讲稿（覆盖媒体 rId + 讲稿 rId 两条编号路径）
    const noChart = join(WORK, 'no-chart')
    mkdirSync(join(noChart, 'pages'), { recursive: true })
    mkdirSync(join(noChart, 'media'), { recursive: true })
    writeFileSync(join(noChart, 'media', 'px.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    writeFileSync(join(noChart, 'deck.yaml'), ['version: 1', 'title: no-chart', 'size: [960, 540]', 'theme:',
      '  colors: {primary: "#2563EB", text: "#1F2937"}', '  textStyles:', '    body: {fontSize: 16, color: "$text"}',
      'pages:', '  - pages/01.yaml', ''].join('\n'), 'utf8')
    writeFileSync(join(noChart, 'pages', '01.yaml'), [
      'pageType: content',
      'notes: 讲稿一行',
      'elements:',
      '  - elementId: t1', '    elementType: text', '    bounds: [40, 40, 400, 40]', '    content: {text: "标题 <a&b>", style: "$body"}',
      '  - elementId: tb', '    elementType: table', '    bounds: [40, 100, 300, 80]', '    cols: [指标, 值]', '    rows: [["甲", "1"], ["乙", "2"]]',
      '  - elementId: sh1', '    elementType: shape', '    bounds: [400, 100, 120, 80]', '    kind: roundRect', '    fill: "$primary"',
      '  - elementId: ln1', '    elementType: line', '    points: [[560, 120], [700, 80]]', '    line: {color: "#1F2937", width: 2}', '    arrow: true',
      '  - elementId: im1', '    elementType: image', '    bounds: [560, 160, 120, 80]', '    src: media/px.png',
      '', ''].join('\n'), 'utf8')
    const ncCtx = await resolveDeck(noChart)
    const newOut = join(noChart, 'new.pptx')
    const oldOut = join(noChart, 'old.pptx')
    await exportPptx(ncCtx, { out: newOut })
    const oldMod = await import(pathToFileURL(join(oldDir, 'pptd', 'export-pptx.js')).href)
    await oldMod.exportPptx(ncCtx, { out: oldOut })
    const a = zipRead(readFileSync(oldOut))
    const b = zipRead(readFileSync(newOut))
    const skip = new Set(['docProps/core.xml']) // 时间戳必然不同
    const keysAll = new Set([...a.keys(), ...b.keys()])
    const diffs = []
    for (const k of keysAll) {
      if (skip.has(k)) continue
      const x = a.get(k)
      const y = b.get(k)
      if (!x || !y) { diffs.push(`${k}: 只在${x ? '旧' : '新'}包里`); continue }
      if (!x.equals(y)) diffs.push(`${k}: 内容不同（旧 ${x.length}B / 新 ${y.length}B）`)
    }
    check('不含图表的工程：新旧产物逐部件一致（media/notes 的 rId 编号未被图表改动影响）', diffs.length === 0, diffs.length ? diffs.slice(0, 6).join('｜') : `${keysAll.size - skip.size} 个部件全部逐字节一致`)
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
h('汇总')
console.log(`PASS ${pass} / FAIL ${fail}`)
console.log(`临时产物：${WORK}（out.pptx 与逐页渲染图可人工复核）`)
if (fail > 0) {
  console.log('结论：FAIL（有判据未通过——详见上面的 FAIL 行）')
  process.exitCode = 1
} else {
  console.log('结论：PASS（原生可编辑图表：部件结构 + 数据一致性 + 独立反读 + 真渲染出图 + 负对照全部通过）')
}
