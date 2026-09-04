/**
 * 图表 SVG 生成（HTML 预览用）：bar / line / pie。
 * ppbx 导出用矢量拼绘（见 export-pptx.js），两处共用数据解析。
 */

/** 解析 chart 数据为 { categories: [...], values: [number], series: [{name, values}] } */
export function chartData(chart) {
  const d = chart.data ?? {}
  const cols = d.cols ?? []
  const rows = d.rows ?? []
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

const PALETTE = ['#2563EB', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#06B6D4', '#F97316', '#64748B']

export function chartColors(chart) {
  return (chart.colors?.length ? chart.colors : PALETTE).map((c) => c)
}

/** 生成 SVG 字符串；viewBox 由调用方传入（px 坐标）。
 * padding: 坐标轴留白 [t, r, b, l] 默认 [8, 12, 24, 12]。
 */
export function chartSvg(chart, w, h) {
  const data = chartData(chart)
  const colors = chartColors(chart)
  const pad = { t: 12, r: 12, b: data.categories.length ? 28 : 12, l: 36 }
  const iw = Math.max(1, w - pad.l - pad.r)
  const ih = Math.max(1, h - pad.t - pad.b)
  const maxV = Math.max(1e-9, ...data.series.flatMap((s) => s.values))
  const minV = Math.min(0, ...data.series.flatMap((s) => s.values))
  const span = Math.max(1e-9, maxV - minV)
  const y0 = pad.t + (maxV / span) * ih
  const y = (v) => pad.t + ((maxV - v) / span) * ih
  const parts = []
  // gridline + y 轴刻度
  for (let i = 0; i <= 4; i++) {
    const gy = pad.t + (ih * i) / 4
    parts.push(`<line x1="${pad.l}" y1="${gy}" x2="${w - pad.r}" y2="${gy}" stroke="#e2e8f0" stroke-width="1"/>`)
    const gv = maxV - (span * i) / 4
    parts.push(`<text x="${pad.l - 4}" y="${gy + 3}" font-size="9" fill="#64748b" text-anchor="end">${fmtNum(gv)}</text>`)
  }
  const n = data.categories.length
  const grouped = data.series.length > 1 && chart.type === 'bar'
  const slot = iw / Math.max(1, n)
  if (chart.type === 'bar') {
    const sGroup = grouped ? 0.72 : 1
    data.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const cx = pad.l + slot * i + slot / 2
        const bw = groupWidth(slot, data.series.length) * sGroup
        const off = grouped ? (si - (data.series.length - 1) / 2) * (bw + 1.5) : 0
        const bh = Math.max(1, Math.abs(y(v) - y0))
        const by = v >= 0 ? y(v) : y0
        parts.push(`<rect x="${cx + off - bw / 2}" y="${by}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${colors[si % colors.length]}"><title>${esc(data.categories[i])}: ${v}</title></rect>`)
      })
    })
  } else if (chart.type === 'line') {
    data.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => `${(pad.l + slot * i + slot / 2).toFixed(1)},${y(v).toFixed(1)}`)
      parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${colors[si % colors.length]}" stroke-width="2"/>`)
      pts.forEach((p, i) => parts.push(`<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="2.5" fill="${colors[si % colors.length]}"><title>${esc(data.categories[i])}: ${s.values[i]}</title></circle>`))
    })
  } else if (chart.type === 'pie') {
    const v = data.series[0].values
    const total = v.reduce((a, b) => a + Math.max(0, b), 0) || 1
    const r = Math.min(iw, ih) / 2 - 2
    const cx = w / 2
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
        parts.push(`<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${colors[i % colors.length]}"><title>${esc(data.categories[i])}: ${val}</title></path>`)
      }
      angle = a2
    })
  }
  data.categories.forEach((c, i) => {
    if (chart.type === 'pie') return
    const cx = pad.l + slot * i + slot / 2
    const label = c.length > 8 ? c.slice(0, 8) + '…' : c
    parts.push(`<text x="${cx.toFixed(1)}" y="${h - 8}" font-size="9" fill="#475569" text-anchor="middle">${esc(label)}</text>`)
  })
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="display:block">${parts.join('')}</svg>`
}

function groupWidth(slot, count) {
  const bw = count > 1 ? slot * 0.7 : slot * 0.62
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
