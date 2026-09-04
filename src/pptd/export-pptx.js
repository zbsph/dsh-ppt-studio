/**
 * PPTD → PPTX 导出器（主引擎）：生成最小可打开的 OOXML。
 * - 元素：text / shape(rect,ellipse,triangle) / line(箭头) / image / table
 *   / chart（矢量拼绘：bar=矩形、line=连接线+圆点、pie=饼形）
 * - 文本自动 fit：与 verify 同一度量与阈值（overflow > 1px 才缩），按比例缩字号，
 *   不低于 theme.minFontSize（默认 12pt，且不超过原字号）；到下限仍溢出记 floorHit。
 *   验证通过 ⇒ 导出不缩字（反馈 E2：双度量差已对齐）。
 * - 1px = 1pt；EMU = pt × 12700。
 */
import { writeFile, readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { zipWrite } from '../zips.js'
import { normalizePage } from './layout.js'
import { chartData, chartColors } from './svgCharts.js'

const EMU = 12700
const xm = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const emu = (v) => Math.round(v * EMU)
const hex = (c) => (c ?? '#000000').replace('#', '').toUpperCase().slice(0, 6).padEnd(6, '0')

let UID = 1
const nid = () => UID++

export async function exportPptx(ctx, { out = 'out.pptx', engine = 'pptd' } = {}) {
  const report = { autoFit: [], warnings: [] }
  const slides = []
  UID = 1000

  for (const page of ctx.pages) {
    const els = normalizePage(page, ctx)
    const shapes = []
    const media = []
    const mediaSeen = new Map()
    const addMedia = (srcPath) => {
      if (mediaSeen.has(srcPath)) return mediaSeen.get(srcPath)
      const rId = `rId${media.length + 2}`
      mediaSeen.set(srcPath, rId)
      media.push({ srcPath, rId })
      return rId
    }

    for (const el of els) {
      switch (el.type) {
        case 'text': shapes.push(textSp(el, report, ctx.minFontSize)); break
        case 'shape': shapes.push(shapeSp(el)); break
        case 'line': shapes.push(connectorSp(el)); break
        case 'image': {
          const rId = addMedia(el.src)
          shapes.push(picSp(el, rId))
          break
        }
        case 'table': shapes.push(tableFrame(el)); break
        case 'chart': shapes.push(...chartSp(el)); break
      }
    }

    // 页面背景（原生 p:bg：solid 或 image，背景图进入本页 media 列表）
    const bg = resolveBg(page.page.background, ctx)
    if (bg?.kind === 'image') {
      bg.rId = addMedia(bg.src)
      bg.xml = bg.xml.replace('BGPLACEHOLDER', bg.rId)
    }

    slides.push({
      page,
      shapes,
      media,
      spTree: `<p:spTree>${spTreeHeader()}${shapes.join('')}</p:spTree>`,
      bg,
    })
  }

  const files = {}
  files['[Content_Types].xml'] = contentTypes(slides)
  files['_rels/.rels'] = rootRels()
  files['docProps/core.xml'] = coreProps(ctx)
  files['docProps/app.xml'] = appProps(ctx)
  files['ppt/presentation.xml'] = presentationXml(ctx, slides)
  files['ppt/_rels/presentation.xml.rels'] = presentationRels(slides)
  files['ppt/slideMasters/slideMaster1.xml'] = slideMasterXml()
  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = slideMasterRels()
  files['ppt/slideLayouts/slideLayout1.xml'] = slideLayoutXml()
  files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = slideLayoutRels()
  files['ppt/theme/theme1.xml'] = themeXml()

  for (let i = 0; i < slides.length; i++) {
    const s = slides[i]
    const n = i + 1
    files[`ppt/slides/slide${n}.xml`] = slideXml(s)
    const srels = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>',
      ...s.media.map((m) => `<Relationship Id="${m.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${m.srcPath.split(/[\\/]/).pop()}"/>`),
      '</Relationships>',
    ].join('')
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = srels
    for (const m of s.media) {
      const bn = m.srcPath.split(/[\\/]/).pop()
      files[`ppt/media/${bn}`] = await readFile(join(ctx.dir, m.srcPath))
    }
  }

  // out：绝对路径原样使用；相对路径相对 deck 目录（反馈 E1 ★）
  const outPath = isAbsolute(out) ? out : join(ctx.dir, out)
  await writeFile(outPath, zipWrite(files))
  report.file = outPath
  report.slides = slides.length
  report.engine = engine
  return report
}

function spTreeHeader() {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
}

function xfrm(x, y, w, h, rot = 0) {
  const r = rot ? ` rot="${Math.round(rot * 60000)}"` : ''
  return '<a:xfrm' + r + '><a:off x="' + emu(x) + '" y="' + emu(y) + '"/><a:ext cx="' + emu(w) + '" cy="' + emu(h) + '"/></a:xfrm>'
}

function lineSpPr(line) {
  const w = Math.round((line?.width ?? 1) * EMU)
  return '<a:ln w="' + w + '"><a:solidFill><a:srgbClr val="' + hex(line?.color ?? '#000000') + '"/></a:solidFill></a:ln>'
}

// ── text ─────────────────────────────────────────────────────────────────
const FIT_TOL = 1 // 与 verify 的 TOL 一致：verify 通过 ⇒ 导出不缩字（反馈 E2 ★★）

function textSp(el, report, minFontSize) {
  const s = el.style
  const m = el.metrics
  const id = nid()
  const origSize = s.fontSize
  let fontSize = origSize
  const boxH = el.bounds.h
  // 缩字下限：主题 minFontSize（默认 12），且不超过原字号（反馈 E2：绝不静默低于 12pt）
  const floor = Math.min(origSize, typeof minFontSize === 'number' && minFontSize > 0 ? minFontSize : 12)
  if (s.wrap !== false && m.overflowY > FIT_TOL) {
    const fit = Math.max(1, Math.floor(fontSize * Math.min(0.95, (boxH / Math.max(1, m.textH)) * 0.95)))
    if (fit < fontSize) {
      const floorHit = fit < floor
      fontSize = floorHit ? floor : fit
      report.autoFit.push({ id: el.id, from: origSize, to: fontSize, floorHit })
    }
  }
  const rPr =
    '<a:rPr lang="zh-CN" sz="' + Math.round(fontSize * 100) + '"' + (s.bold ? ' b="1"' : '') + (s.italic ? ' i="1"' : '') +
    '><a:solidFill><a:srgbClr val="' + hex(s.color ?? '#000000') + '"/></a:solidFill>' +
    (s.fontFamily ? '<a:latin typeface="' + xm(s.fontFamily) + '"/><a:ea typeface="' + xm(s.fontFamily) + '"/>' : '') +
    '</a:rPr>'
  const body = String(el.content?.text ?? '').split(/\n/).map((line) => {
    return '<a:p><a:pPr algn="' + alignOf(s.align) + '" lvl="0"/><a:r>' + rPr + '<a:t>' + xm(line) + '</a:t></a:r></a:p>'
  }).join('')
  const bodyPr = s.wrap === false
    ? '<a:bodyPr wrap="none" lIns="0" rIns="0" tIns="0" bIns="0"/>'
    : '<a:bodyPr wrap="square" lIns="0" rIns="0" tIns="0" bIns="0"/>'
  const sp = '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + xm(el.id) + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
  return sp + '<p:spPr>' + xfrm(el.bounds.x, el.bounds.y, el.bounds.w, el.bounds.h) + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
    + '<p:txBody>' + bodyPr + '<a:lstStyle/>' + body + '</p:txBody></p:sp>'
}

function alignOf(a) { return a === 'right' ? 'r' : a === 'center' ? 'ctr' : 'l' }

// ── shapes ────────────────────────────────────────────────────────────────
function shapeSp(el) {
  const id = nid()
  const prst = { rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle' }[el.kind] ?? 'rect'
  const avLst = el.kind === 'roundRect' ? '<a:avLst><a:gd name="adj" fmla="val 8000"/></a:avLst>' : '<a:avLst/>'
  const fill = el.fill ? '<a:solidFill><a:srgbClr val="' + hex(el.fill) + '"/></a:solidFill>' : '<a:noFill/>'
  const ln = el.line ? lineSpPr(el.line) : '<a:ln><a:noFill/></a:ln>'
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + xm(el.id) + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
    + '<p:spPr>' + xfrm(el.bounds.x, el.bounds.y, el.bounds.w, el.bounds.h, el.rotation ?? 0)
    + '<a:prstGeom prst="' + prst + '">' + avLst + '</a:prstGeom>' + fill + ln + '</p:spPr>'
    + '<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p/></p:txBody></p:sp>'
}

// ── line / connector ──────────────────────────────────────────────────────
function connectorSp(el) {
  const id = nid()
  const p1 = el.points[0]
  const p2 = el.points[1]
  const x1 = p1[0]
  const y1 = p1[1]
  const x2 = p2[0]
  const y2 = p2[1]
  const minX = Math.min(x1, x2)
  const minY = Math.min(y1, y2)
  const wdt = Math.max(1, Math.abs(x2 - x1))
  const hgt = Math.max(1, Math.abs(y2 - y1))
  const tail = el.arrow ? '<a:tailEnd type="triangle" w="med" len="med"/>' : ''
  return '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="' + id + '" name="' + xm(el.id) + '"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>'
    + '<p:spPr>' + xfrm(minX, minY, wdt, hgt) + '<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>'
    + lineSpPr(el.line) + tail + '</p:spPr></p:cxnSp>'
}

// ── image ─────────────────────────────────────────────────────────────────
function picSp(el, rId) {
  const id = nid()
  return '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="' + xm(el.id) + '"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
    + '<p:blipFill><a:blip r:embed="' + rId + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
    + '<p:spPr>' + xfrm(el.bounds.x, el.bounds.y, el.bounds.w, el.bounds.h) + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
}

// ── table ─────────────────────────────────────────────────────────────────
function tableFrame(el) {
  const id = nid()
  const rows = [el.header ? [...el.cols] : null, ...el.rows.map((r) => [...r])].filter(Boolean)
  const ncols = Math.max(1, ...rows.map((r) => r.length))
  const colW = Math.floor(emu(el.bounds.w) / ncols)
  const header = el.header
  const grid = '<a:tblGrid>' + Array.from({ length: ncols }, () => '<a:gridCol w="' + colW + '"/>').join('') + '</a:tblGrid>'
  const trs = rows.map((r, ri) => {
    const tds = Array.from({ length: ncols }, (_, ci) => {
      const cell = r[ci]
      const isH = header && ri === 0
      const fill = isH ? '<a:solidFill><a:srgbClr val="DDEBF7"/></a:solidFill>' : '<a:noFill/>'
      const rPr = '<a:rPr lang="zh-CN" sz="1100"' + (isH ? ' b="1"' : '') + '><a:solidFill><a:srgbClr val="1F2937"/></a:solidFill></a:rPr>'
      const tb = '<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>' + rPr + '<a:t>' + xm(cell ?? '') + '</a:t></a:r></a:p></a:txBody>'
      const mar = '<a:marL l="45720" r="45720" t="22860" b="22860" anchor="ctr"/>'
      return '<a:tc>' + tb + '<a:tcPr>' + fill
        + '<a:lnL><a:noFill/></a:lnL><a:lnR><a:noFill/></a:lnR><a:lnT><a:noFill/></a:lnT><a:lnB><a:noFill/></a:lnB>'
        + mar + '</a:tcPr></a:tc>'
    }).join('')
    return '<a:tr h="' + Math.floor(emu(el.bounds.h) / rows.length) + '">' + tds + '</a:tr>'
  }).join('')
  return '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + id + '" name="' + xm(el.id) + '"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
    + '<p:xfrm>' + xfrm(el.bounds.x, el.bounds.y, el.bounds.w, el.bounds.h) + '</p:xfrm>'
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'
    + '<a:tbl><a:tblPr firstRow="' + (header ? 1 : 0) + '" bandRow="0"/>' + grid + trs + '</a:tbl>'
    + '</a:graphicData></a:graphic></p:graphicFrame>'
}

// ── chart（矢量拼绘）───────────────────────────────────────────────────────
function chartSp(el) {
  const x = el.bounds.x
  const y = el.bounds.y
  const w = el.bounds.w
  const h = el.bounds.h
  const data = chartData(el.chart)
  const colors = chartColors(el.chart)
  const out = []
  const padT = 0.06 * h
  const padR = 0.04 * w
  const padB = el.chart.type === 'pie' ? 0.1 * h : 0.24 * h
  const padL = 0.12 * w
  const iw = w - padL - padR
  const ih = h - padT - padB
  const vals = data.series.flatMap((s) => s.values)
  const maxV = Math.max(1e-9, ...vals)
  const n = Math.max(1, data.categories.length)
  const slot = iw / n

  if (el.chart.type === 'bar') {
    data.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const bw = Math.max(2, (slot * 0.6) / data.series.length)
        const bx = x + padL + slot * i + slot / 2 - bw / 2 + (si - (data.series.length - 1) / 2) * bw
        const bh = Math.max(2, Math.abs(v / maxV) * ih)
        const by = y + padT + ih - bh
        out.push(shapeSp({ id: el.id + '-b' + i + '-' + si, kind: 'rect', bounds: { x: bx, y: by, w: bw, h: bh }, fill: colors[si % colors.length] }))
      })
    })
  } else if (el.chart.type === 'line') {
    data.series.forEach((s, si) => {
      for (let i = 1; i < s.values.length; i++) {
        const x1 = x + padL + slot * (i - 1) + slot / 2
        const y1 = y + padT + ih - (s.values[i - 1] / maxV) * ih
        const x2 = x + padL + slot * i + slot / 2
        const y2 = y + padT + ih - (s.values[i] / maxV) * ih
        out.push(connectorSp({ id: el.id + '-L' + i, points: [[x1, y1], [x2, y2]], line: { color: colors[si % colors.length], width: 2 } }))
      }
      s.values.forEach((v, i) => {
        out.push(shapeSp({ id: el.id + '-d' + i + '-' + si, kind: 'ellipse', bounds: { x: x + padL + slot * i + slot / 2 - 3, y: y + padT + ih - (v / maxV) * ih - 3, w: 6, h: 6 }, fill: colors[si % colors.length] }))
      })
    })
  } else if (el.chart.type === 'pie') {
    const v = data.series[0].values
    const total = v.reduce((a, b) => a + Math.max(0, b), 0) || 1
    const r = Math.min(iw, ih) / 2
    const cx = x + padL + iw / 2
    const cy = y + padT + ih / 2
    let ang = -90 * 60000
    v.forEach((val, i) => {
      if (val <= 0) return
      const frac = val / total
      const span = Math.round(frac * 360 * 60000)
      const gd1 = Math.abs(ang % (360 * 60000))
      const gd2 = Math.abs((ang + span) % (360 * 60000))
      const gid = nid()
      const oval = '<a:off x="' + Math.round(cx - r) + '" y="' + Math.round(cy - r) + '"/><a:ext cx="' + Math.round(r * 2) + '" cy="' + Math.round(r * 2) + '"/>'
      out.push('<p:sp><p:nvSpPr><p:cNvPr id="' + gid + '" name="' + xm(el.id) + '-p' + i + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        + '<p:spPr><a:xfrm>' + oval + '</a:xfrm>'
        + '<a:prstGeom prst="pie"><a:avLst><a:gd name="adj1" fmla="val ' + gd1 + '"/><a:gd name="adj2" fmla="val ' + gd2 + '"/></a:avLst></a:prstGeom>'
        + '<a:solidFill><a:srgbClr val="' + hex(colors[i % colors.length]) + '"/></a:solidFill><a:ln><a:noFill/></a:ln>'
        + '</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>')
      ang += span
    })
  }
  return out
}

// ── package parts ─────────────────────────────────────────────────────────
function contentTypes(slides) {
  const overrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ...slides.map((_, i) => '<Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'),
  ]
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
    + '<Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>'
    + '<Default Extension="webp" ContentType="image/webp"/>'
    + overrides.join('') + '</Types>'
}

function rootRels() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>'
}

function coreProps(ctx) {
  const d = new Date().toISOString()
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + '<dc:title>' + xm(ctx.deck.title ?? 'deck') + '</dc:title><dc:creator>dsh-ppt-studio</dc:creator><cp:lastModifiedBy>dsh-ppt-studio</cp:lastModifiedBy>'
    + '<dcterms:created xmlns:dcterms="http://purl.org/dc/terms/" xsi:type="dcterms:W3CDTF" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' + d + '</dcterms:created>'
    + '<dcterms:modified xmlns:dcterms="http://purl.org/dc/terms/" xsi:type="dcterms:W3CDTF" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' + d + '</dcterms:modified>'
    + '</cp:coreProperties>'
}

function appProps(ctx) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + '<Application>dsh-ppt-studio</Application><Slides>' + ctx.pages.length + '</Slides></Properties>'
}

function presentationXml(ctx, slides) {
  const sldIdLst = slides.map((_, i) => '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 2) + '"/>').join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + '<p:sldIdLst>' + sldIdLst + '</p:sldIdLst>'
    + '<p:sldSz cx="' + emu(ctx.size.width) + '" cy="' + emu(ctx.size.height) + '"/><p:notesSz cx="6858000" cy="9144000"/>'
    + '<p:defaultTextStyle><a:lvl1pPr algn="l"><a:defRPr sz="1800"/></a:lvl1pPr><a:lvl2pPr><a:defRPr sz="1400"/></a:lvl2pPr><a:lvl3pPr><a:defRPr sz="1200"/></a:lvl3pPr><a:lvl4pPr><a:defRPr sz="1200"/></a:lvl4pPr><a:lvl5pPr><a:defRPr sz="1200"/></a:lvl5pPr></p:defaultTextStyle>'
    + '</p:presentation>'
}

function presentationRels(slides) {
  const r = slides.map((_, i) => '<Relationship Id="rId' + (i + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/>').join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    + r + '</Relationships>'
}

function slideMasterXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
    + '<p:cSld><p:spTree>' + spTreeHeader() + '</p:spTree></p:cSld>'
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + '<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"/></p:titleStyle><p:bodyStyle><a:lvl1pPr algn="l"/></p:bodyStyle><p:otherStyle><a:lvl1pPr algn="l"/></p:otherStyle></p:txStyles>'
    + '</p:sldMaster>'
}

function slideMasterRels() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>'
    + '</Relationships>'
}

function slideLayoutXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">'
    + '<p:cSld name="blank"><p:spTree>' + spTreeHeader() + '</p:spTree></p:cSld>'
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
}

function slideLayoutRels() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>'
    + '</Relationships>'
}

function slideXml(s) {
  const bg = s.bg ? ['<p:bg>', s.bg.xml, '</p:bg>'].join('') : ''
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
    + '<p:cSld>' + bg + s.spTree + '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
}

/** 页面背景 → 导出结构：{ kind:'solid', xml } | { kind:'image', src, rId, xml } | null */
function resolveBg(bg, ctx) {
  if (!bg) return null
  if (typeof bg === 'string') {
    return { kind: 'solid', xml: '<p:bgPr><a:solidFill><a:srgbClr val="' + hex(ctx.resolveColor(bg)) + '"/></a:solidFill><a:effectLst/></p:bgPr>' }
  }
  if (bg.type === 'solid') {
    return { kind: 'solid', xml: '<p:bgPr><a:solidFill><a:srgbClr val="' + hex(ctx.resolveColor(bg.color ?? '#FFFFFF')) + '"/></a:solidFill><a:effectLst/></p:bgPr>' }
  }
  if (bg.type === 'image') {
    return {
      kind: 'image',
      src: bg.src,
      rId: null, // 由调用方 addMedia 后回填
      xml: '<p:bgPr><a:blipFill><a:blip r:embed="BGPLACEHOLDER"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr>',
    }
  }
  return null
}

function themeXml() {
  const clr = [
    ['dk1', '000000'], ['lt1', 'FFFFFF'], ['dk2', '1F2937'], ['lt2', 'F3F4F6'],
    ['accent1', '2563EB'], ['accent2', 'F59E0B'], ['accent3', '10B981'], ['accent4', 'EF4444'],
    ['accent5', '8B5CF6'], ['accent6', '06B6D4'], ['hlink', '2563EB'], ['folHlink', '7C3AED'],
  ].map(([n, v]) => '<a:' + n + '><a:srgbClr val="' + v + '"/></a:' + n + '>').join('')
  const fill = '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
  const ln = '<a:lnStyleLst>'
    + '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
    + '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
    + '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
    + '</a:lnStyleLst>'
  const eff = '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  const bg = '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Studio">'
    + '<a:themeElements><a:clrScheme name="Studio">' + clr + '</a:clrScheme>'
    + '<a:fontScheme name="Studio"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont>'
    + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
    + '<a:fmtScheme name="Studio">' + fill + ln + eff + bg + '</a:fmtScheme>'
    + '</a:themeElements></a:theme>'
}
