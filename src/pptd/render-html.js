/**
 * PPTD → HTML 预览渲染器 + layout.json（渲染器同源快照）。
 * 产出 preview/<n>_<name>.html（单页）、preview/deck.html（整览）、preview/layout.json。
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizePage } from './layout.js'
import { chartSvg } from './svgCharts.js'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function slug(name, index) {
  const s = String(name).replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40) || 'page'
  return `${String(index + 1).padStart(2, '0')}_${s}`
}

/** 单个元素的 HTML + 快照记录。 */
function elementHtml(el, ctx, debug) {
  const { x, y, w, h } = el.bounds
  const pos = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px`
  // 相对路径修正：HTML 在 <outDir>/ 下，media 在 deck 根（src 约定相对 deck 根 → 加 ../）
  const mediaSrc = (src) => {
    if (/^(https?:|data:|file:)/.test(src)) return src
    return src.startsWith('./') ? '../' + src.slice(2) : '../' + src
  }
  const snap = (extra) => ({ id: el.id, kind: el.type, bounds: el.bounds, ...(el.role ? { role: el.role } : {}), ...extra })
  switch (el.type) {
    case 'text': {
      const s = el.style
      const style = [
        pos,
        `font-size:${s.fontSize}px;line-height:${s.lineHeight};color:${s.color ?? '#111'}`,
        s.fontFamily ? `font-family:${s.fontFamily}` : '',
        s.bold ? 'font-weight:bold' : '',
        s.italic ? 'font-style:italic' : '',
        s.align ? `text-align:${s.align}` : '',
        debug ? 'outline:1px dashed rgba(220,38,38,0.5)' : '',
        'overflow:visible;white-space:pre-wrap;word-break:break-word',
      ].filter(Boolean).join(';')
      return { html: `<div class="el" id="${esc(el.id)}" data-kind="text" style="${style}">${esc(el.content?.text ?? '')}</div>`, snap: snap({ style: s, metrics: el.metrics, text: el.content?.text ?? '' }) }
    }
    case 'shape': {
      let css = pos
      if (el.kind === 'ellipse') css += ';border-radius:50%'
      if (el.kind === 'roundRect') css += ';border-radius:8px'
      if (el.kind === 'triangle') css += ';clip-path:polygon(50% 0,0 100%,100% 100%)'
      if (el.fill) css += `;background:${el.fill}`
      if (el.line) css += `;border:${el.line.width}px solid ${el.line.color}`
      if (el.rotation) css += `;transform:rotate(${el.rotation}deg)`
      return { html: `<div class="el" id="${esc(el.id)}" data-kind="shape" data-shape="${el.kind}" style="${css}"></div>`, snap: snap({ shape: el.kind, fill: el.fill, rotation: el.rotation }) }
    }
    case 'line': {
      const [p1, p2] = el.points
      const [x1, y1] = p1
      const [x2, y2] = p2
      const svg = `<svg style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;pointer-events:none" viewBox="${x} ${y} ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${el.line.color}"/></marker></defs><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${el.line.color}" stroke-width="${el.line.width}"${el.arrow ? ` marker-end="url(#arr)"` : ''}/></svg>`
      return { html: svg, snap: snap({ points: el.points }) }
    }
    case 'image': {
      const fit = { cover: 'cover', contain: 'contain', fill: '100% 100%' }[el.fit] ?? 'cover'
      return { html: `<img class="el" id="${esc(el.id)}" data-kind="image" style="${pos};object-fit:${fit}" src="${esc(mediaSrc(el.src))}" />`, snap: snap({ src: el.src, fit: el.fit }) }
    }
    case 'table': {
      const rows = [el.header ? el.cols : null, ...el.rows].filter(Boolean)
      const html = `<table class="el" id="${esc(el.id)}" data-kind="table" style="${pos};border-collapse:collapse"><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td style="border:1px solid #cbd5e1;padding:4px 8px;font-size:12px">${esc(c ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      return { html, snap: snap({ cols: el.cols.length, rows: el.rows.length }) }
    }
    case 'chart': {
      const svg = chartSvg(el.chart, w, h)
      return { html: `<div class="el" id="${esc(el.id)}" data-kind="chart" style="${pos}">${svg}</div>`, snap: snap({ chartType: el.chart.type }) }
    }
    default:
      return { html: `<div class="el" id="${esc(el.id)}" data-kind="unknown" style="${pos};border:1px solid #f00">${el.type}</div>`, snap: snap({}) }
  }
}

/** 渲染整个 deck。debug=true 时给文本元素加描边。返回 { outDir, htmlFiles, layout }。 */
/** 页面背景解析：'#hex' | {type: solid, color} | {type: image, src, fit} → { css, record } */
function resolveBackground(bg, ctx) {
  if (typeof bg === 'string') return { css: bg, record: { type: 'solid', color: bg } }
  if (bg?.type === 'solid') {
    const c = ctx.resolveColor(bg.color ?? '#FFFFFF')
    return { css: c, record: { type: 'solid', color: c } }
  }
  if (bg?.type === 'image') {
    const src = bg.src
    const uri = /^(https?:|data:|file:)/.test(src) ? src : '../' + (src.startsWith('./') ? src.slice(2) : src)
    const fit = bg.fit === 'fill' ? '100% 100%' : bg.fit ?? 'cover'
    return { css: `url("${uri}") center / ${fit} no-repeat`, record: { type: 'image', src, fit: bg.fit ?? 'cover' } }
  }
  return { css: '#FFFFFF', record: { type: 'solid', color: '#FFFFFF' } }
}

export async function renderDeck(ctx, { out = 'preview', debug = false } = {}) {
  const outDir = join(ctx.dir, out)
  await mkdir(outDir, { recursive: true })
  const layout = {
    size: ctx.size,
    theme: {
      colors: ctx.colors ?? {},
      textStyles: ctx.textStyles ?? {},
      grid: ctx.deck.theme?.grid ?? { base: 8 },
      safeArea: ctx.deck.theme?.safeArea ?? null,
      minFontSize: ctx.minFontSize,
    },
    pages: [],
  }
  const pageFiles = []
  const bodyHtml = []
  let sharedStyle = null
  for (const page of ctx.pages) {
    const els = normalizePage(page, ctx)
    const bgRes = resolveBackground(page.page.background, ctx)
    const sa = ctx.safeAreaOf(page.page)
    const hasSa = sa.top > 0 || sa.bottom > 0 || sa.left > 0 || sa.right > 0
    const parts = []
    const snaps = []
    for (const el of els) {
      const r = elementHtml(el, ctx, debug)
      parts.push(r.html)
      snaps.push(r.snap)
    }
    // debug 模式：绘制安全区参考框（模板背景非内容区边界）
    if (debug && hasSa) {
      parts.push(`<div class="el sa-guide" style="position:absolute;left:${sa.left}px;top:${sa.top}px;width:${Math.max(0, ctx.size.width - sa.left - sa.right)}px;height:${Math.max(0, ctx.size.height - sa.top - sa.bottom)}px;border:2px dashed rgba(0,150,255,.75);pointer-events:none"></div>`)
    }
    const name = slug(page.name, page.index)
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box;margin:0}body{background:#64748b} .slide{position:relative;width:${ctx.size.width}px;height:${ctx.size.height}px;background:${bgRes.css};box-shadow:0 2px 12px rgba(0,0,0,.3);overflow:hidden}</style></head><body><div class="slide">${parts.join('')}</div></body></html>`
    await writeFile(join(outDir, `${name}.html`), html)
    pageFiles.push(`${name}.html`)
    if (!sharedStyle) sharedStyle = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? ''
    const slideOnly = html.replace(/<!doctype html>[\s\S]*?<head><meta charset="utf-8">/, '').replace(/<style>[\s\S]*?<\/style>/, '').replace(/<\/head>[\s\S]*?<body>/, '').replace(/<\/body><\/html>$/, '')
      .replace('<div class="slide">', `<div class="slide" style='background:${bgRes.css.replace(/'/g, '\\\'')}'>`)
    bodyHtml.push(`<section style="margin:0 auto 24px;width:${ctx.size.width}px;padding:4px 0"><div style="font:12px monospace;color:#e2e8f0;padding:2px 8px">${page.index + 1}. ${esc(page.name)}</div>${slideOnly}</section>`)
    layout.pages.push({
      index: page.index,
      file: page.ref,
      name: page.name,
      background: bgRes.record,
      safeArea: sa,
      expectedOverlaps: page.page.expectedOverlaps ?? [],
      overlapMode: page.page.overlapMode ?? 'declared',
      elements: snaps,
    })
  }
  const deckHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(ctx.deck.title ?? 'deck')}</title>${sharedStyle}<style>body{background:#334155;padding:16px}</style></head><body style="background:#334155">${bodyHtml.join('')}</body></html>`
  await writeFile(join(outDir, 'deck.html'), deckHtml)
  await writeFile(join(outDir, 'layout.json'), JSON.stringify(layout, null, 2))
  return { outDir, htmlFiles: pageFiles, layout }
}
