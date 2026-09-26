/**
 * 图表 SVG 生成（HTML 预览用）：bar / line / pie。
 * 导出侧：原生可编辑图表（默认，见 nativeChart.js）或矢量拼绘（`render: 'vector'`，见 export-pptx.js 的 chartSp）。
 *
 * 第三轮（2026-09-27）**预览与成品对齐**：原生图表自带坐标轴/网格线/刻度标签/图例/数据标签，
 * SVG 也必须画这些——否则"预览 ≠ 成品"，模型与用户会被误导（ppt_shot/ppt_measure 的输入就是这份 SVG）。
 * 三层同源：`chartOptions()`（schema.js 给默认）→ `resolveChart()`（本文件，落地 auto 默认）→
 * 预览 SVG 与导出 chartN.xml 都读同一个 resolveChart 结果。
 */
import { chartOptions } from './schema.js'

/** 解析 chart 数据为 { categories: [...], values: [number], series: [{name, values}] } */
export function chartData(chart) {
  const d = chart.data ?? {}
  let cols = d.cols ?? []
  const rows = d.rows ?? []
  // 单列 pairs 兼容（P1 修复，v0.6.1）：cols 只声明类别列、每行 [类别, 值] 时，自动补默认数值列
  // （文档/模板历史格式）；宽表多列格式不受影响。
  if (cols.length === 1 && rows.length && rows.every((r) => Array.isArray(r) && r.length >= 2)) {
    cols = [cols[0], '值']
  }
  if (chart.type === 'pie') {
    const cat = cols[0]
    const val = cols[1]
    return {
      categories: rows.map((r) => String(r[0] ?? '')),
      series: [{ name: val, values: rows.map((r) => Number(r[1] ?? 0)) }],
    }
  }
  const seriesSpec = (chart.series?.length ? chart.series : [{ name: cols[1], x: cols[0], y: cols[1] }])
  const out = { categories: [], series: [] }
  const xKey = seriesSpec[0]?.x ?? cols[0]
  const xIdx = cols.indexOf(xKey)
  for (const r of rows) out.categories.push(String(r[xIdx] ?? ''))
  for (const s of seriesSpec) {
    const yIdx = cols.indexOf(s.y ?? cols[1])
    out.series.push({ name: s.name ?? cols[yIdx], values: rows.map((r) => Number(r[yIdx] ?? 0)) })
  }
  return out
}

/**
 * 解析成"预览/导出共用"的图表模型（**唯一真相**）：
 * 类别、系列（名 + 数值）、分类列名、配色、已落地的渲染选项（render/legend/labels/axes）。
 */
export function resolveChart(chart) {
  const data = chartData(chart)
  const cols = chart?.data?.cols ?? []
  const series = data.series.map((s, i) => ({ name: String(s.name ?? `系列${i + 1}`), values: s.values }))
  const opt = chartOptions(chart)
  const multi = series.length > 1
  const vector = opt.render === 'vector'
  // auto 语义（schema.js chartOptions 注释里有同一份说明）：多系列/饼图才有必要画图例；单系列图例是噪音。
  const legend = vector ? false : (opt.legend === 'auto' ? (chart?.type === 'pie' || multi ? 'bottom' : false) : opt.legend)
  // auto 语义：饼图的"百分比 + 分类名"是必要信息；柱/线逐点标数字会糊。
  const labels = vector ? false : (opt.labels === 'auto' ? (chart?.type === 'pie') : opt.labels)
  // 矢量拼绘（chartSp）不画坐标轴/网格线 ⇒ 预览也不画（否则"预览 ≠ 成品"）。schema 对 vector+axes 显式值直接报错。
  const axes = vector ? false : opt.axes
  return {
    type: chart?.type,
    categories: data.categories,
    series,
    catHeader: String(cols[0] ?? '类别'),
    colors: chartColors(chart),
    opts: { render: opt.render, legend, labels, axes },
  }
}

/**
 * 图表数据检查（P1 修复，v0.6.1）：把"静默失败"变显式。
 * 返回问题描述字符串或 null（正常）。
 */
export function chartIssue(chart) {
  try {
    const data = chartData(chart)
    const vals = data.series.flatMap((s) => s.values)
    if (!vals.length) return '图表没有数据行（rows 为空）'
    const allZero = vals.every((v) => !isFinite(v) || v === 0)
    if (allZero) {
      return '图表数据解析为全零或无效（请检查 cols/rows 映射；单列 pairs 格式已兼容，建议使用宽表 cols: [分类, 值] + rows: [[类, 值], ...]）'
    }
    return null
  } catch (e) {
    return `图表数据解析失败：${e?.message ?? e}`
  }
}

const PALETTE = ['#2563EB', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#06B6D4', '#F97316', '#64748B']

export function chartColors(chart) {
  return (chart.colors?.length ? chart.colors : PALETTE).map((c) => c)
}

const GRID = '#e2e8f0'
const AXIS = '#cbd5e1'
const TICK_TEXT = '#64748b'

/**
 * 生成 SVG 字符串；viewBox 由调用方传入（px 坐标）。
 * 与成品对齐的内容：坐标轴（轴线+刻度）、网格线、刻度标签、分类标签、图例、数据标签。
 */
export function chartSvg(chart, w, h) {
  const m = resolveChart(chart)
  const colors = m.colors
  const colorOf = (i) => colors[i % colors.length]
  const n = m.categories.length
  const vals = m.series.flatMap((s) => s.values)
  const maxV = Math.max(1e-9, ...vals)
  const minV = Math.min(0, ...vals)
  const span = Math.max(1e-9, maxV - minV)
  const showAxes = m.type !== 'pie' && m.opts.axes !== false

  // ── 图例（与原生图表的 c:legend 同位置）──
  const legendItems = m.type === 'pie'
    ? m.categories.map((c, i) => ({ label: c, color: colorOf(i) }))
    : m.series.map((s, i) => ({ label: s.name, color: colorOf(i) }))
  const legend = m.opts.legend ? layoutLegend(legendItems, w, h, m.opts.legend) : null

  const pad = { t: 12, r: 12, b: showAxes && n ? 28 : 12, l: showAxes ? 36 : 12 }
  if (legend?.pos === 'top') pad.t += legend.h
  if (legend?.pos === 'bottom') pad.b += legend.h
  if (legend?.pos === 'left') pad.l += legend.w
  if (legend?.pos === 'right') pad.r += legend.w
  if (m.opts.labels && m.type !== 'pie') pad.t += 12 // 数据标签要地方
  const iw = Math.max(1, w - pad.l - pad.r)
  const ih = Math.max(1, h - pad.t - pad.b)
  const slot = iw / Math.max(1, n)
  const y0 = pad.t + (maxV / span) * ih
  const y = (v) => pad.t + ((maxV - v) / span) * ih
  const parts = []

  // 网格线 + 值轴刻度标签 + 刻度线
  if (showAxes) {
    for (let i = 0; i <= 4; i++) {
      const gy = pad.t + (ih * i) / 4
      parts.push(`<line x1="${pad.l}" y1="${gy.toFixed(1)}" x2="${(w - pad.r).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`)
      parts.push(`<line x1="${pad.l - 3}" y1="${gy.toFixed(1)}" x2="${pad.l}" y2="${gy.toFixed(1)}" stroke="${AXIS}" stroke-width="1"/>`)
      const gv = maxV - (span * i) / 4
      parts.push(`<text x="${pad.l - 5}" y="${(gy + 3).toFixed(1)}" font-size="9" fill="${TICK_TEXT}" text-anchor="end">${fmtNum(gv)}</text>`)
    }
    // 坐标轴轴线（原生图表有，预览以前没有 ⇒ 补齐）
    parts.push(`<line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${(pad.t + ih).toFixed(1)}" stroke="${AXIS}" stroke-width="1"/>`)
    parts.push(`<line x1="${pad.l}" y1="${(pad.t + ih).toFixed(1)}" x2="${(w - pad.r).toFixed(1)}" y2="${(pad.t + ih).toFixed(1)}" stroke="${AXIS}" stroke-width="1"/>`)
  }

  if (m.type === 'bar') {
    const grouped = m.series.length > 1
    m.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const cx = pad.l + slot * i + slot / 2
        const bw = groupWidth(slot, m.series.length)
        const off = grouped ? (si - (m.series.length - 1) / 2) * (bw + 1.5) : 0
        const bh = Math.max(1, Math.abs(y(v) - y0))
        const by = v >= 0 ? y(v) : y0
        parts.push(`<rect x="${(cx + off - bw / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${colorOf(si)}"><title>${esc(s.name)} · ${esc(m.categories[i])}: ${v}</title></rect>`)
        if (m.opts.labels) parts.push(labelText(cx + off, by - 4, fmtNum(v)))
      })
    })
  } else if (m.type === 'line') {
    m.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => `${(pad.l + slot * i + slot / 2).toFixed(1)},${y(v).toFixed(1)}`)
      parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${colorOf(si)}" stroke-width="2"/>`)
      pts.forEach((p, i) => {
        const [px, py] = p.split(',')
        parts.push(`<circle cx="${px}" cy="${py}" r="2.5" fill="${colorOf(si)}"><title>${esc(s.name)} · ${esc(m.categories[i])}: ${s.values[i]}</title></circle>`)
        if (m.opts.labels) parts.push(labelText(Number(px), Number(py) - 6, fmtNum(s.values[i])))
      })
    })
  } else if (m.type === 'pie') {
    const v = m.series[0]?.values ?? []
    const total = v.reduce((a, b) => a + Math.max(0, b), 0) || 1
    const r = Math.min(iw, ih) / 2 - (m.opts.labels ? 6 : 2)
    const cx = pad.l + iw / 2
    const cy = pad.t + ih / 2
    let angle = -Math.PI / 2
    v.forEach((val, i) => {
      const frac = Math.max(0, val) / total
      const a2 = angle + frac * Math.PI * 2
      const large = frac > 0.5 ? 1 : 0
      const x1 = cx + r * Math.cos(angle)
      const y1 = cy + r * Math.sin(angle)
      const x2 = cx + r * Math.cos(a2)
      const y2 = cy + r * Math.sin(a2)
      if (frac > 0.0005) {
        parts.push(`<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${colorOf(i)}"><title>${esc(m.categories[i])}: ${val}</title></path>`)
      }
      if (m.opts.labels && frac > 0.0005) {
        const mid = angle + frac * Math.PI
        const lx = cx + (r + 10) * Math.cos(mid)
        const ly = cy + (r + 10) * Math.sin(mid)
        parts.push(labelText(lx, ly + 3, `${m.categories[i]} ${Math.round(frac * 100)}%`, mid > Math.PI / 2 || mid < -Math.PI / 2 ? 'end' : 'start'))
      }
      angle = a2
    })
  }

  m.categories.forEach((c, i) => {
    if (m.type === 'pie') return
    if (!showAxes) return
    const cx = pad.l + slot * i + slot / 2
    const label = c.length > 8 ? c.slice(0, 8) + '…' : c
    parts.push(`<text x="${cx.toFixed(1)}" y="${(pad.t + ih + 12).toFixed(1)}" font-size="9" fill="#475569" text-anchor="middle">${esc(label)}</text>`)
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${(pad.t + ih).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(pad.t + ih + 3).toFixed(1)}" stroke="${AXIS}" stroke-width="1"/>`)
  })

  if (legend) parts.push(...renderLegend(legend, w, h, pad, legendItems))

  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="display:block">${parts.join('')}</svg>`
}

function labelText(x, y, text, anchor = 'middle') {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="9" fill="#334155" text-anchor="${anchor}">${esc(text)}</text>`
}

/** 估算文本宽度（CJK 按 1em，其余 0.55em）——只用于图例排布，不需要精确。 */
function textW(s, size) {
  let w = 0
  for (const ch of String(s)) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? size : size * 0.55
  return w
}

/** 图例占位计算：bottom/top 横排（超宽自动换行），left/right 竖排。 */
function layoutLegend(items, w, h, pos) {
  const SIZE = 9
  const swatch = 8
  const gap = 6
  const rowH = 14
  if (pos === 'left' || pos === 'right') {
    const maxItem = Math.max(20, ...items.map((it) => textW(it.label, SIZE))) + swatch + gap + 6
    return { pos, w: Math.min(Math.round(w * 0.32), Math.ceil(maxItem)), h: rowH, rows: 1 }
  }
  const avail = Math.max(20, w - 16)
  const items2 = items.map((it) => textW(it.label, SIZE) + swatch + gap + 8)
  let rows = 1
  let acc = 0
  for (const iw2 of items2) {
    if (acc > 0 && acc + iw2 > avail) { rows++; acc = iw2 } else acc += iw2
  }
  return { pos, w: 0, h: rows * rowH + 2, rows }
}

function renderLegend(legend, w, h, pad, items) {
  const out = []
  const SIZE = 9
  const swatch = 8
  const gap = 6
  const rowH = 14
  const widths = items.map((it) => textW(it.label, SIZE) + swatch + gap + 8)
  if (legend.pos === 'left' || legend.pos === 'right') {
    const totalH = items.length * rowH
    let y = Math.max(pad.t, (h - totalH) / 2)
    const x = legend.pos === 'left' ? 6 : w - legend.w + 6
    for (let i = 0; i < items.length; i++) {
      out.push(`<rect x="${x}" y="${(y + 3).toFixed(1)}" width="${swatch}" height="${swatch}" fill="${items[i].color}" rx="1"/>`)
      out.push(`<text x="${x + swatch + gap}" y="${(y + 10).toFixed(1)}" font-size="${SIZE}" fill="${TICK_TEXT}">${esc(items[i].label)}</text>`)
      y += rowH
    }
    return out
  }
  const top = legend.pos === 'top'
  const avail = Math.max(20, w - 16)
  let row = 0
  let acc = 0
  const baseY = top ? 4 : h - legend.h + 2
  for (let i = 0; i < items.length; i++) {
    if (acc > 0 && acc + widths[i] > avail) { row++; acc = 0 }
    const x = 8 + acc
    const y = baseY + row * rowH
    out.push(`<rect x="${x}" y="${(y + 3).toFixed(1)}" width="${swatch}" height="${swatch}" fill="${items[i].color}" rx="1"/>`)
    out.push(`<text x="${x + swatch + gap}" y="${(y + 10).toFixed(1)}" font-size="${SIZE}" fill="${TICK_TEXT}">${esc(items[i].label)}</text>`)
    acc += widths[i]
  }
  return out
}

function groupWidth(slot, count) {
  // 与原生图表 gapWidth=100（柱宽 = 1/2 槽）/ gapWidth=100+聚类（≈0.7/n 槽）对齐
  const bw = count > 1 ? slot * 0.7 : slot * 0.5
  return Math.max(2, bw / Math.max(1, count))
}

function fmtNum(v) {
  if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + 'w'
  if (Math.abs(v) >= 100) return Math.round(v).toString()
  return (Math.round(v * 10) / 10).toString()
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
