/**
 * 原生可编辑图表部件生成（第三轮主目标，2026-09-27）——**PowerPoint 里能"编辑数据"的真图表**。
 *
 * 背景（用户实测确认）：旧 `chart` 是**矢量拼绘**（柱=矩形、折线=连线+圆点、饼=饼形扇区），
 * 在 PowerPoint 里只是一个图形组合——没有"编辑数据"、不能换类型、改数字不重算、没有内嵌数据工作簿。
 * 本模块产出真正的 DrawingML 图表部件，`render: 'vector'` 仍保留矢量降级路径（见 export-pptx.js 的 chartSp）。
 *
 * 部件结构（以官方 office 技能 python-pptx 产物为结构蓝本，逐件对照过）：
 *   ppt/charts/chartN.xml                       ← c:chartSpace（barChart/lineChart/pieChart + catAx/valAx + legend + dLbls）
 *   ppt/charts/_rels/chartN.xml.rels            ← rId1 → ../embeddings/Microsoft_Excel_SheetN.xlsx（type=.../package）
 *   ppt/embeddings/Microsoft_Excel_SheetN.xlsx  ← 最小但**合法**的 xlsx（数据随文件走，与 deck 数据逐格一致）
 *   ppt/slides/slideN.xml                       ← p:graphicFrame + graphicData uri=".../chart" + c:chart r:id（见 export-pptx.js）
 *   [Content_Types].xml                         ← xlsx Default + 每个 chartN.xml 的 Override
 *
 * 内嵌工作簿布局（与 python-pptx 同构，`Sheet1!$A$2:$A$5` 这类公式引用才成立）：
 *   A1 = 分类列名，B1..= 系列名；A2.. = 分类值；B2.. = 各系列数值。
 *
 * 自证（parity，见 export-pptx.js）：`auditNativeCharts()` 从**产物**反读——
 * ① 声明的 chart 元素数 == 包内 ppt/charts/*.xml 数；② 每个 chart 的 externalData 关系真的指向一个存在的
 * 内嵌工作簿；③ 解 `xl/worksheets/sheet1.xml` 取值，与 deck 数据逐格比对（不一致即 parity 报红）。
 */
import { zipWrite, zipRead, decodeXml } from '../zips.js'
import { resolveChart } from './svgCharts.js'

const XM = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const HEX = (c) => (c ?? '#000000').replace('#', '').toUpperCase().slice(0, 6).padEnd(6, '0')

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const C_NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
/** 图表文字（轴标签/图例/数据标签）统一字号与颜色：与预览 SVG 的 9px/#64748b 语义对齐。 */
const CHART_SZ = 900
const TICK_COLOR = '64748B'
const GRID_COLOR = 'E2E8F0'
const AXIS_COLOR = 'CBD5E1'

/** chartN 的三件套部件名（唯一命名来源：export-pptx / 自证 / 验证脚本共用）。 */
export function chartPartNames(chartNo) {
  return {
    chart: `ppt/charts/chart${chartNo}.xml`,
    rels: `ppt/charts/_rels/chart${chartNo}.xml.rels`,
    embed: `ppt/embeddings/Microsoft_Excel_Sheet${chartNo}.xlsx`,
  }
}

/** 0 → A、25 → Z、26 → AA（工作表列号）。 */
export function colName(i) {
  let n = Number(i) + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** 数值 → 工作表/缓存里的字面量（两处必须同一函数，否则内嵌数据与缓存会对不上）。 */
function numText(v) {
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : '0'
}

/**
 * deck 图表数据 → 内嵌工作簿的二维网格（**唯一真相**：chart XML 的公式引用、工作簿内容、
 * parity 的期望值三者都由它派生）。
 * @returns {{header: string[], rows: Array<Array<string|number>>}}
 */
export function expectedSheetGrid(chart) {
  const m = resolveChart(chart)
  const header = [m.catHeader, ...m.series.map((s, i) => String(s.name ?? `系列${i + 1}`))]
  const rows = m.categories.map((cat, ri) => [String(cat), ...m.series.map((s) => {
    const v = Number(s.values[ri] ?? 0)
    return Number.isFinite(v) ? v : 0
  })])
  return { header, rows }
}

/** 系列公式列：系列 i 落在第 i+1 列（A=分类列）。 */
function seriesCol(i) { return colName(i + 1) }

// ── 内嵌工作簿（最小 xlsx：inlineStr 免 sharedStrings）────────────────────────
function sheetXml(grid) {
  const ncols = Math.max(1, grid.header.length)
  const nrows = grid.rows.length + 1
  const cellRef = (ri, ci) => `${colName(ci)}${ri + 1}`
  const textCell = (ri, ci, v) => `<c r="${cellRef(ri, ci)}" t="inlineStr"><is><t xml:space="preserve">${XM(v)}</t></is></c>`
  const numCell = (ri, ci, v) => `<c r="${cellRef(ri, ci)}"><v>${XM(numText(v))}</v></c>`
  const rowXml = (ri, cells) => `<row r="${ri + 1}" spans="1:${ncols}">${cells}</row>`
  const out = [rowXml(0, grid.header.map((h, ci) => textCell(0, ci, h)))]
  grid.rows.forEach((r, ri) => out.push(rowXml(ri + 1, r.map((v, ci) => (ci === 0 ? textCell(ri + 1, ci, v) : numCell(ri + 1, ci, v))))))
  const dim = `A1:${colName(ncols - 1)}${nrows}`
  return XML_HEAD + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<dimension ref="${dim}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>`
    + '<sheetFormatPr defaultRowHeight="15"/><sheetData>' + out.join('') + '</sheetData>'
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
}

const XLSX_CONTENT_TYPES = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '</Types>'

const XLSX_RELS = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>'

const XLSX_WORKBOOK = XML_HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
  + '<workbookPr defaultThemeVersion="124226"/><bookViews><workbookView xWindow="240" yWindow="15" windowWidth="16095" windowHeight="9660"/></bookViews>'
  + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
  + '<calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>'

const XLSX_WORKBOOK_RELS = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>'

/** 最小样式表。**不能省**：很多 xlsx 消费端（含 Excel/PowerPoint 的"编辑数据"）假定 styles.xml 存在。 */
const XLSX_STYLES = XML_HEAD + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/></styleSheet>'

/**
 * 内嵌数据工作簿（xlsx 字节）——图表"数据随文件走"的载体。
 * 数据完全由 `expectedSheetGrid(chart)` 派生 ⇒ 与 chart XML 的 numCache/strCache 同源。
 */
export function embeddedWorkbook(chart) {
  return zipWrite({
    '[Content_Types].xml': XLSX_CONTENT_TYPES,
    '_rels/.rels': XLSX_RELS,
    'xl/workbook.xml': XLSX_WORKBOOK,
    'xl/_rels/workbook.xml.rels': XLSX_WORKBOOK_RELS,
    'xl/styles.xml': XLSX_STYLES,
    'xl/worksheets/sheet1.xml': sheetXml(expectedSheetGrid(chart)),
  })
}

// ── chartN.xml ───────────────────────────────────────────────────────────
function catRef(colLetter, count) {
  const n = Math.max(0, Number(count) || 0)
  const last = n > 0 ? n + 1 : 2 // 空数据也要给出**合法**的引用（$B$2:$B$1 是非法区间）
  return `Sheet1!$${colLetter}$2:$${colLetter}$${last}`
}

function serTx(colLetter, name) {
  return '<c:tx><c:strRef><c:f>' + XM(`Sheet1!$${colLetter}$1`) + '</c:f><c:strCache><c:ptCount val="1"/>'
    + '<c:pt idx="0"><c:v>' + XM(name) + '</c:v></c:pt></c:strCache></c:strRef></c:tx>'
}

function catXml(m) {
  const n = m.categories.length
  const pts = m.categories.map((c, i) => `<c:pt idx="${i}"><c:v>${XM(c)}</c:v></c:pt>`).join('')
  return '<c:cat><c:strRef><c:f>' + XM(catRef('A', n)) + '</c:f><c:strCache><c:ptCount val="' + n + '"/>' + pts + '</c:strCache></c:strRef></c:cat>'
}

function valXml(m, si) {
  const s = m.series[si]
  const n = s.values.length
  const col = seriesCol(si)
  const pts = s.values.map((v, i) => `<c:pt idx="${i}"><c:v>${XM(numText(v))}</c:v></c:pt>`).join('')
  return '<c:val><c:numRef><c:f>' + XM(catRef(col, n)) + '</c:f><c:numCache><c:formatCode>General</c:formatCode>'
    + '<c:ptCount val="' + n + '"/>' + pts + '</c:numCache></c:numRef></c:val>'
}

function solidFill(hex) { return '<a:solidFill><a:srgbClr val="' + HEX(hex) + '"/></a:solidFill>' }

function txPrXml() {
  return '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="' + CHART_SZ + '" b="0">'
    + '<a:solidFill><a:srgbClr val="' + TICK_COLOR + '"/></a:solidFill>'
    + '<a:latin typeface="Calibri"/><a:ea typeface="Microsoft YaHei"/></a:defRPr></a:pPr>'
    + '<a:endParaRPr lang="zh-CN"/></a:p></c:txPr>'
}

function gridlinesXml(on) {
  return on ? '<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="' + GRID_COLOR + '"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' : ''
}

/** 轴（catAx + valAx）。`on=false` 用 OOXML 的"隐藏轴"表达（delete=1 + tickLblPos=none），不是删元素。 */
function axesXml(ax1, ax2, on) {
  const axisLine = '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="' + AXIS_COLOR + '"/></a:solidFill></a:ln></c:spPr>'
  const ticks = on
    ? '<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>'
    : '<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="none"/>'
  return '<c:catAx><c:axId val="' + ax1 + '"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="' + (on ? 0 : 1) + '"/><c:axPos val="b"/>'
    + ticks + axisLine + txPrXml()
    + '<c:crossAx val="' + ax2 + '"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
    + '<c:valAx><c:axId val="' + ax2 + '"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="' + (on ? 0 : 1) + '"/><c:axPos val="l"/>'
    + gridlinesXml(on) + ticks + axisLine + txPrXml()
    + '<c:crossAx val="' + ax1 + '"/><c:crosses val="autoZero"/></c:valAx>'
}

function dLblsXml(kind, on) {
  if (!on) return ''
  const show = kind === 'pie'
    ? '<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="1"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/>'
    : '<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>'
  // CT_DLbls 子元素顺序（EG_DLblShared）：numFmt → spPr → txPr → dLblPos → show*。
  // 饼图用 outEnd：默认 bestFit 会把"甲 60%"压在彩色扇区里（实测配色浅时看不清）。
  const pos = kind === 'pie' ? '<c:dLblPos val="outEnd"/>' : ''
  return '<c:dLbls>' + txPrXml() + pos + show + '</c:dLbls>'
}

/**
 * 生成 `ppt/charts/chartN.xml`。
 * 不写 `<c:title>`（页面标题由 text 元素承担）+ `autoTitleDeleted=1`：显式声明"不要自动标题"，
 * 否则部分版本会自己补一个占位标题。
 * @param {{chart: object, chartNo?: number}} args
 * @returns {string}
 */
export function nativeChartXml({ chart, chartNo = 1 }) {
  const m = resolveChart(chart)
  const kind = m.type
  const colors = m.colors
  const colorOf = (i) => colors[i % colors.length]
  const ax1 = 110000000 + chartNo
  const ax2 = 120000000 + chartNo
  const legendPos = m.opts.legend === 'top' ? 't' : m.opts.legend === 'left' ? 'l' : m.opts.legend === 'right' ? 'r' : 'b'
  const legend = m.opts.legend
    ? '<c:legend><c:legendPos val="' + legendPos + '"/><c:layout/><c:overlay val="0"/></c:legend>'
    : ''

  let group
  if (kind === 'pie') {
    const si = 0
    const s = m.series[0] ?? { name: '值', values: [] }
    const dpts = s.values.map((_, i) => '<c:dPt><c:idx val="' + i + '"/><c:spPr>' + solidFill(colorOf(i)) + '</c:spPr></c:dPt>').join('')
    const ser = '<c:ser><c:idx val="0"/><c:order val="0"/>' + serTx(seriesCol(si), s.name)
      + dpts + catXml(m) + valXml(m, si) + '</c:ser>'
    group = '<c:pieChart><c:varyColors val="1"/>' + ser + dLblsXml('pie', m.opts.labels) + '<c:firstSliceAng val="0"/></c:pieChart>'
  } else if (kind === 'line') {
    const sers = m.series.map((s, si) => '<c:ser><c:idx val="' + si + '"/><c:order val="' + si + '"/>' + serTx(seriesCol(si), s.name)
      + '<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="' + HEX(colorOf(si)) + '"/></a:solidFill><a:round/></a:ln></c:spPr>'
      + '<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr>' + solidFill(colorOf(si)) + '<a:ln w="9525">' + solidFill(colorOf(si)) + '</a:ln></c:spPr></c:marker>'
      + catXml(m) + valXml(m, si) + '<c:smooth val="0"/></c:ser>').join('')
    group = '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' + sers + dLblsXml('line', m.opts.labels)
      + '<c:marker val="1"/><c:smooth val="0"/>'
      + '<c:axId val="' + ax1 + '"/><c:axId val="' + ax2 + '"/></c:lineChart>'
  } else {
    const sers = m.series.map((s, si) => '<c:ser><c:idx val="' + si + '"/><c:order val="' + si + '"/>' + serTx(seriesCol(si), s.name)
      + '<c:spPr>' + solidFill(colorOf(si)) + '</c:spPr><c:invertIfNegative val="0"/>'
      + catXml(m) + valXml(m, si) + '</c:ser>').join('')
    // gapWidth=100 + overlap=-10：与预览 SVG 的柱宽（slot/2 与 0.7slot 分组）基本对齐（"预览≠成品"是最误导的缺陷）
    group = '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>' + sers + dLblsXml('bar', m.opts.labels)
      + '<c:gapWidth val="100"/><c:overlap val="-10"/>'
      + '<c:axId val="' + ax1 + '"/><c:axId val="' + ax2 + '"/></c:barChart>'
  }

  const axes = kind === 'pie' ? '' : axesXml(ax1, ax2, m.opts.axes !== false)

  return XML_HEAD + '<c:chartSpace ' + C_NS + '>'
    + '<c:date1904 val="0"/>'
    + '<c:chart><c:autoTitleDeleted val="1"/>'
    + '<c:plotArea><c:layout/>' + group + axes + '</c:plotArea>'
    + legend + '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>'
    + '</c:chart>'
    + txPrXml()
    + '<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData>'
    + '</c:chartSpace>'
}

/** chartN.xml.rels：rId1 → 内嵌工作簿（type=.../package，与 python-pptx/PowerPoint 产物同构）。 */
export function nativeChartRels(chartNo) {
  const { embed } = chartPartNames(chartNo)
  return XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" '
    + 'Target="../embeddings/' + embed.split('/').pop() + '"/>'
    + '</Relationships>'
}

/**
 * slide 里的图表帧：`p:graphicFrame` + `a:graphicData uri=".../chart"` + `c:chart r:id`。
 * 注意（P1 事故同款）：graphicFrame 的 `<p:xfrm>` **直接含** `<a:off>/<a:ext>`，不能再嵌套 `<a:xfrm>`
 * （嵌套时 PowerPoint 静默丢弃整帧，预览却正常）。
 * @param {object} el 元素（用 bounds）
 * @param {number} id 形状 id
 * @param {string} rId slide rels 里的关系 id（由调用方按"媒体之后"分配）
 */
export function chartFrameXml(el, id, rId) {
  const b = el.bounds
  return '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + id + '" name="' + XM(el.id) + '"/>'
    + '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
    + '<p:xfrm><a:off x="' + Math.round(b.x * 12700) + '" y="' + Math.round(b.y * 12700) + '"/>'
    + '<a:ext cx="' + Math.round(b.w * 12700) + '" cy="' + Math.round(b.h * 12700) + '"/></p:xfrm>'
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="' + XM(rId) + '"/>'
    + '</a:graphicData></a:graphic></p:graphicFrame>'
}

// ── 内嵌工作簿反读（parity 的"数据必须与 deck 一致"）──────────────────────────
/** 从 xlsx 字节解出 `xl/worksheets/sheet1.xml` 的单元格网格（数值 → number，inlineStr/共享串 → string）。 */
export function sheetGridFromXlsx(bytes) {
  const entries = bytes instanceof Map ? bytes : zipRead(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
  const sheetName = [...entries.keys()].find((k) => /^xl\/worksheets\/sheet1\.xml$/.test(k))
  if (!sheetName) throw new Error('内嵌工作簿缺少 xl/worksheets/sheet1.xml')
  const xml = decodeXml(entries.get(sheetName))
  const shared = []
  const ssName = [...entries.keys()].find((k) => /^xl\/sharedStrings\.xml$/.test(k))
  if (ssName) {
    const ss = decodeXml(entries.get(ssName))
    for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1])
      shared.push(texts.join(''))
    }
  }
  const rows = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  for (const rm of xml.matchAll(rowRe)) {
    const cells = []
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]
      const inner = cm[2] ?? ''
      const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs)
      const ci = ref ? colIndex(ref[1]) : cells.length
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? ''
      let v
      if (t === 'inlineStr') {
        v = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')
      } else if (t === 's') {
        const si = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1)
        v = shared[si] ?? ''
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        if (raw === undefined) continue
        const num = Number(raw)
        v = Number.isFinite(num) && raw.trim() !== '' ? num : raw
      }
      while (cells.length < ci) cells.push(undefined)
      cells[ci] = typeof v === 'string' ? unescapeXml(v) : v
    }
    rows.push(cells)
  }
  return rows
}

function colIndex(letters) {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function unescapeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

function pkgGet(files, key) {
  return files instanceof Map ? files.get(key) : files[key]
}

function pkgKeys(files) {
  return files instanceof Map ? [...files.keys()] : Object.keys(files)
}

function pkgText(v) {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') return v
  return decodeXml(Buffer.isBuffer(v) ? v : Buffer.from(v))
}

/** 目标相对部件解析（`ppt/charts/../embeddings/x.xlsx` → `ppt/embeddings/x.xlsx`）。 */
export function resolvePart(fromPart, target) {
  const out = fromPart.split('/').slice(0, -1)
  for (const seg of String(target).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/**
 * 图表部件自证（parity 用，**从产物反读**，不读中间层）。
 * @param {Record<string,string|Buffer>|Map<string,Buffer>} files 包内部件表（export-pptx 的 files，或 zipRead 的 Map）
 * @param {Array<{id: string, chart: object, chartPart?: string}>} expected 期望的原生图表（每次声明一个 chart 元素一条）
 * @returns {{chartsExp:number, chartsOut:number, embedsOut:number, sheetsChecked:number, dataMismatch:string[], relsMissing:string[], ok:boolean}}
 */
export function auditNativeCharts(files, expected = []) {
  const keys = pkgKeys(files)
  const chartParts = keys.filter((k) => /^ppt\/charts\/chart\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]))
  const embeds = keys.filter((k) => /^ppt\/embeddings\/.+\.xlsx$/i.test(k))
  const dataMismatch = []
  const relsMissing = []
  let sheetsChecked = 0

  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]
    const chartPart = e.chartPart ?? chartParts[i]
    if (!chartPart || pkgGet(files, chartPart) === undefined) {
      relsMissing.push(`${e.id ?? `#${i}`}: 缺图表部件 ${chartPart ?? '(未声明 chartPart)'}`)
      continue
    }
    const xml = pkgText(pkgGet(files, chartPart))
    const relsPath = chartPart.replace(/\/([^/]+)$/, '/_rels/$1.rels')
    const relsXml = pkgText(pkgGet(files, relsPath))
    if (!relsXml) { relsMissing.push(`${e.id ?? `#${i}`}: 缺 ${relsPath}（图表→内嵌工作簿关系）`); continue }
    const extId = /<c:externalData[^>]*\br:id="([^"]+)"/.exec(xml)?.[1]
    if (!extId) { relsMissing.push(`${e.id ?? `#${i}`}: chart XML 没有 <c:externalData r:id>（PowerPoint"编辑数据"就断链）`); continue }
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${extId}"[^>]*>`).exec(relsXml)?.[0]
      ?? new RegExp(`<Relationship\\b[^>]*Id="${extId}"[^>]*/>`).exec(relsXml)?.[0]
    const target = rel ? /Target="([^"]+)"/.exec(rel)?.[1] : null
    if (!target) { relsMissing.push(`${e.id ?? `#${i}`}: ${relsPath} 里没有 Id=${extId} 的关系`); continue }
    const resolved = resolvePart(chartPart, target)
    const xlsx = pkgGet(files, resolved)
    if (xlsx === undefined) { relsMissing.push(`${e.id ?? `#${i}`}: 关系目标不存在 ${resolved}`); continue }
    let rows
    try {
      rows = sheetGridFromXlsx(xlsx)
    } catch (err) {
      dataMismatch.push(`${e.id ?? `#${i}`}: 内嵌工作簿无法解析（${err?.message ?? err}）`)
      continue
    }
    sheetsChecked++
    const want = expectedSheetGrid(e.chart)
    dataMismatch.push(...diffGrid(e.id ?? `#${i}`, want, rows))
  }

  const ok = expected.length === chartParts.length && relsMissing.length === 0 && dataMismatch.length === 0
  return { chartsExp: expected.length, chartsOut: chartParts.length, embedsOut: embeds.length, sheetsChecked, dataMismatch, relsMissing, ok }
}

/** 期望网格 vs 工作簿反读网格的逐格比对（数值带容差；文本严格相等）。 */
export function diffGrid(id, want, rows) {
  const out = []
  const at = (r, c) => (rows[r] ? rows[r][c] : undefined)
  if (rows.length !== want.rows.length + 1) {
    out.push(`${id}: 工作表行数不符（工作簿 ${rows.length} ≠ 期望 ${want.rows.length + 1}）`)
  }
  want.header.forEach((h, ci) => {
    const got = at(0, ci)
    if (got === undefined) out.push(`${id}: 工作表缺表头 ${colName(ci)}1（期望「${h}」）`)
    else if (String(got) !== String(h)) out.push(`${id}: 表头 ${colName(ci)}1 不符（工作簿「${got}」≠ deck「${h}」）`)
  })
  if (rows[0] && rows[0].length > want.header.length) out.push(`${id}: 工作表表头列数多出 ${rows[0].length - want.header.length} 列（数据与 deck 不一致）`)
  want.rows.forEach((r, ri) => {
    const got = at(ri + 1, 0)
    if (String(got) !== String(r[0])) out.push(`${id}: 分类 A${ri + 2} 不符（工作簿「${got}」≠ deck「${r[0]}」）`)
    for (let ci = 1; ci < r.length; ci++) {
      const g = at(ri + 1, ci)
      const w = Number(r[ci])
      if (typeof g !== 'number' || Math.abs(g - w) > 1e-9) {
        out.push(`${id}: 数值 ${colName(ci)}${ri + 2} 不符（工作簿「${g}」≠ deck「${w}」）`)
      }
    }
  })
  return out
}
