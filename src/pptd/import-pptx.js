/**
 * PPTX → PPTD 导入器（补完/修改/总结的基础）：内容保真、版式参考。
 * 抽取：文本（内容+字号/颜色/粗体）、形状（rect/ellipse/triangle）、
 * 图片（拷入 media/）、表格；chart 降级为文本占位（保留标题/说明）。
 * 输出 deck 项目目录（deck.yaml + pages/*.yaml + media/），几何保留供参考。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { zipRead, decodeXml } from '../zips.js'
import { parseXml, children, first, allText } from '../xmljs.js'

const EMU = 12700
const px = (emu) => Math.round(emu / EMU)

export async function importPptx(pptxPath, outDir) {
  const buf = await readFile(pptxPath)
  const files = zipRead(buf)
  const get = (p) => {
    const d = files.get(p)
    if (!d) throw new Error(`pptx part missing: ${p}`)
    return decodeXml(d)
  }

  // 尺寸
  const pres = first(parseXml(get('ppt/presentation.xml')), 'presentation')
  const sldSz = pres ? first(pres, 'sldSz') : undefined
  const width = sldSz ? px(Number(sldSz.attrs.cx ?? 12192000)) : 960
  const height = sldSz ? px(Number(sldSz.attrs.cy ?? 6858000)) : 540

  // slide 顺序
  const sldIdLst = pres ? first(pres, 'sldIdLst') : undefined
  const slideIds = (sldIdLst?.children ?? []).filter((c) => c.tag === 'sldId')
  const relsOf = (xmlText) => {
    if (!xmlText) return new Map()
    const tree = parseXml(xmlText)
    const root = tree.children.find((c) => c.tag === 'Relationships') ?? tree
    return new Map(root.children.filter((c) => c.tag === 'Relationship').map((r) => [r.attrs.Id, r.attrs.Target]))
  }
  const relMap = relsOf(get('ppt/_rels/presentation.xml.rels'))

  // 抽取每页
  const pages = []
  const mediaNames = new Set()
  const layoutRels = relsOf(files.get('ppt/slideLayouts/_rels/slideLayout1.xml.rels')?.toString('utf8'))
  const layoutXml = files.get('ppt/slideLayouts/slideLayout1.xml') ? parseXml(decodeXml(files.get('ppt/slideLayouts/slideLayout1.xml'))) : null
  const layoutBg = layoutXml ? bgOfSlide(layoutXml, layoutRels, mediaNames) : null
  for (let i = 0; i < slideIds.length; i++) {
    const rId = slideIds[i].attrs['r:id'] ?? slideIds[i].attrs.id
    const target = relMap.get(rId) ?? `slides/slide${i + 1}.xml`
    const part = target.startsWith('/') ? target.slice(1) : 'ppt/' + target.replace(/^\.\.\//, '')
    const slideXml = get(part)
    const relsXml = files.get(part.replace(/\/[^/]+$/, '/_rels/' + basename(part) + '.rels'))?.toString('utf8')
    const slideRels = relsOf(relsXml)
    const slide = first(parseXml(slideXml), 'sld')
    const spTree = first(first(slide, 'cSld'), 'spTree')
    const parsed = parseShapes(spTree, slideRels, mediaNames, { width, height })
    const slideBg = bgOfSlide(slide, slideRels, mediaNames)
    // 背景优先级：原生 slide bg > 满页图 > 布局 bg > 无
    const bg = slideBg ?? parsed.bg ?? layoutBg ?? null
    pages.push({ index: i, elements: parsed.elements, background: bg })
  }

  // 写项目
  await mkdir(outDir, { recursive: true })
  await mkdir(join(outDir, 'pages'), { recursive: true })
  await mkdir(join(outDir, 'media'), { recursive: true })
  const band = detectBands(pages, { width, height }) // D4：跨页页眉/页脚带探测（写入建议，不自动启用）
  const pageRefs = []
  for (const page of pages) {
    const name = `slide_${String(page.index + 1).padStart(2, '0')}`
    const ref = `pages/${name}.yaml`
    pageRefs.push(ref)
    const yaml = pageYaml(page, name)
    await writeFile(join(outDir, ref), yaml)
  }
  const deckYaml = yamlDeck({ title: basename(pptxPath).replace(/\.pptx$/i, ''), width, height, pageRefs, band })
  await writeFile(join(outDir, 'deck.yaml'), deckYaml)
  for (const name of mediaNames) {
    const data = files.get('ppt/media/' + name)
    if (data) await writeFile(join(outDir, 'media', name), data)
  }
  const bgCount = pages.filter((p) => p.background).length
  return {
    outDir, pages: pages.length, media: [...mediaNames], size: { width, height },
    warnings: ['chart 降级为文本占位；复杂形状近似映射', ...(bgCount ? [`已提取 ${bgCount} 页背景（含背景图/色/满页图）`] : []),
      ...(band ? [`检测到跨页页眉/页脚带（上 ${band.top}px / 下 ${band.bottom}px）：deck.yaml 已写入建议 safeArea（注释呈现，未启用；确认为模板后取消注释并微调）`] : [])],
  }
}

/**
 * D4：跨页重复元素带探测 → safeArea 建议（只写注释，不自动启用）。
 * 原理：页眉/页脚/logo 通常"跨页同位置重复"；统计元素矩形签名出现页数，
 * 重复率 ≥ max(2, 60% 页数) 且位于顶部 30% / 底部 30% 页高 → 形成带。
 */
function detectBands(pages, size, minPages = 3) {
  if (pages.length < minPages) return null
  const sigOf = (el) => {
    const b = el.bounds
    return `${el.elementType}:${el.kind ?? ''}:${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}`
  }
  const counts = new Map()
  for (const p of pages) {
    const seen = new Set()
    for (const el of p.elements) {
      const s = sigOf(el)
      if (seen.has(s)) continue
      seen.add(s)
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
  }
  const need = Math.max(2, Math.ceil(pages.length * 0.6))
  const tops = []
  const bottoms = []
  for (const p of pages) {
    for (const el of p.elements) {
      if ((counts.get(sigOf(el)) ?? 0) < need) continue
      const b = el.bounds
      if (b.y + b.h <= size.height * 0.3) tops.push(b.y + b.h)
      else if (b.y >= size.height * 0.7) bottoms.push(b.y)
    }
  }
  const hint = {}
  if (tops.length) hint.top = Math.max(...tops)
  if (bottoms.length) hint.bottom = size.height - Math.min(...bottoms)
  return Object.keys(hint).length ? hint : null
}

function parseShapes(spTree, slideRels, mediaNames, pageSize) {
  const out = []
  let bg = null
  for (const node of spTree?.children ?? []) {
    if (node.tag === 'sp') out.push(spToEl(node))
    else if (node.tag === 'pic') {
      const el = picToEl(node, slideRels, mediaNames)
      // 满页图 → 提升为页面背景（避免作为遮挡元素）
      if (el && isFullPagePic(el.bounds, pageSize)) bg = { type: 'image', src: el.src, fit: 'cover' }
      else out.push(el)
    }
    else if (node.tag === 'graphicFrame') {
      const graphicData = first(node, 'graphic') && first(first(node, 'graphic'), 'graphicData')
      if (!graphicData) continue
      const uri = graphicData.attrs.uri ?? ''
      if (uri.includes('/table')) {
        const tbl = first(graphicData, 'tbl')
        if (tbl) out.push(tableToEl(node, tbl))
      } else {
        out.push(chartToEl(node))
      }
    }
  }
  // elementId 去重（原稿常见重复名如 "_文本框"；重复名追加 -2/-3...）
  const seen = new Map()
  for (const el of out) {
    const base = el.elementId
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    if (n > 0) el.elementId = `${base}-${n + 1}`
  }
  return { elements: out, bg }
}

function xfrmOf(node) {
  const spPr = first(node, 'spPr')
  let x = spPr ? first(spPr, 'xfrm') : first(node, 'xfrm')
  if (x && !first(x, 'off')) x = first(x, 'xfrm') || x // 兼容嵌套 a:xfrm
  const off = x ? first(x, 'off') : undefined
  const ext = x ? first(x, 'ext') : undefined
  if (!off || !ext) return null
  return { x: px(Number(off.attrs.x ?? 0)), y: px(Number(off.attrs.y ?? 0)), w: Math.max(1, px(Number(ext.attrs.cx ?? 0))), h: Math.max(1, px(Number(ext.attrs.cy ?? 0))) }
}

function solidColor(node) {
  let fill = first(node, 'solidFill')
  if (!fill) {
    const ln = first(node, 'ln')
    if (ln) fill = first(ln, 'solidFill')
  }
  const s = fill ? first(fill, 'srgbClr') : undefined
  return s ? '#' + s.attrs.val : undefined
}

function spToEl(node) {
  const nv = first(node, 'nvSpPr') ?? node
  const cNvPr = first(nv, 'cNvPr')
  const id = cNvPr?.attrs?.name ?? cNvPr?.attrs?.id ?? 'sp'
  const bounds = xfrmOf(node)
  const tx = first(node, 'txBody')
  const spPr = first(node, 'spPr')
  const prstGeom = spPr ? first(spPr, 'prstGeom') : undefined
  const prst = prstGeom?.attrs?.prst
  const text = tx ? allText(tx).replace(/[\t ]+/g, ' ').trim().split(/\n\s*\n|(?<=。)\s*/) : []
  const textNonEmpty = text.join(' ').trim().length > 0
  const isText = textNonEmpty && (!prst || (prst === 'rect' && !!tx))
  if (isText) {
    // 文本元素
    const p0 = tx ? first(tx, 'p') : undefined
    const r = p0 ? first(p0, 'r') : undefined
    const rPr = r?.rPr
    const szAttr = rPr?.attrs?.sz ? Number(rPr.attrs.sz) / 100 : 18
    const color = rPr ? solidColor(rPr) : undefined
    return {
      elementId: sanitize(id), elementType: 'text',
      bounds: bounds ?? [0, 0, 200, 50],
      content: {
        text: text.join(' '),
        ...(szAttr !== 18 ? { fontSize: szAttr } : {}),
        ...(rPr?.attrs?.b === '1' ? { bold: true } : {}),
        ...(color ? { color } : {}),
      },
    }
  }
  const kind = prst === 'ellipse' ? 'ellipse' : prst === 'triangle' ? 'triangle' : prst === 'roundRect' ? 'roundRect' : 'rect'
  return {
    elementId: sanitize(id), elementType: 'shape', kind,
    bounds: bounds ?? [0, 0, 100, 100],
    ...(solidColor(node) ? { fill: solidColor(node) } : {}),
  }
}

function picToEl(node, slideRels, mediaNames) {
  const nv = first(node, 'nvPicPr') ?? node
  const cNvPr = first(nv, 'cNvPr')
  const id = cNvPr?.attrs?.name ?? cNvPr?.attrs?.id ?? 'pic'
  const blipFill = first(node, 'blipFill')
  const blip = blipFill ? first(blipFill, 'blip') : undefined
  const rId = blip?.attrs?.['r:embed'] ?? blip?.attrs?.embed
  let src = 'media/placeholder.png'
  if (rId && slideRels) {
    const t = slideRels.get(rId)
    if (t) {
      const bn = basename(t)
      mediaNames.add(bn)
      src = 'media/' + bn
    }
  }
  return { elementId: sanitize(id), elementType: 'image', bounds: xfrmOf(node) ?? [0, 0, 200, 150], src, fit: 'cover' }
}

function tableToEl(node, tbl) {
  const nv = first(node, 'nvGraphicFramePr') ?? node
  const cNvPr = first(nv, 'cNvPr')
  const id = cNvPr?.attrs?.name ?? cNvPr?.attrs?.id ?? 'table'
  const grid = first(tbl, 'tblGrid')
  const cols = (grid?.children ?? []).map((g, i) => `Col${i + 1}`)
  const rows = []
  for (const tr of children(tbl, 'tr')) {
    const row = []
    for (const tc of children(tr, 'tc')) {
      row.push(allText(tc).trim())
    }
    rows.push(row)
  }
  return { elementId: sanitize(id), elementType: 'table', bounds: xfrmOf(node) ?? [0, 0, 400, 200], cols, rows }
}

function chartToEl(node) {
  const nv = first(node, 'nvGraphicFramePr') ?? node
  const cNvPr = first(nv, 'cNvPr')
  const id = cNvPr?.attrs?.name ?? cNvPr?.attrs?.id ?? 'chart'
  return {
    elementId: sanitize(id), elementType: 'text',
    bounds: xfrmOf(node) ?? [0, 0, 400, 220],
    content: { text: `[chart: ${id}] 图表已降级为文本占位，请重新生成图表样式` },
  }
}

function sanitize(id) {
  return String(id).replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40) || 'el'
}

/** 从 <p:cSld><p:bg> 解析背景（背景色/背景图；图经 rels 提取到 media）。node：sld/sldLayout 根或 #root。 */
function bgOfSlide(node, rels, mediaNames) {
  const sld = first(node, 'sld') ?? first(node, 'sldLayout') ?? node
  const bg = first(first(sld, 'cSld'), 'bg')
  if (!bg) return null
  const bgPr = first(bg, 'bgPr')
  if (!bgPr) return null
  const solidFill = first(bgPr, 'solidFill')
  if (solidFill) {
    const c = first(solidFill, 'srgbClr')
    if (c) return { type: 'solid', color: '#' + c.attrs.val }
    const scheme = first(solidFill, 'schemeClr')
    if (scheme) return { type: 'solid', color: '#' + ({ lt1: 'FFFFFF', dk1: '000000', tx1: '000000', bg1: 'FFFFFF' }[scheme.attrs.val] ?? 'FFFFFF') }
  }
  const blipFill = first(bgPr, 'blipFill')
  const blip = blipFill ? first(blipFill, 'blip') : undefined
  const rId = blip?.attrs?.['r:embed'] ?? blip?.attrs?.embed
  if (rId && rels) {
    const t = rels.get(rId)
    if (t) {
      const bn = basename(t)
      mediaNames.add(bn)
      return { type: 'image', src: 'media/' + bn, fit: 'cover' }
    }
  }
  return null
}

/** 满页图（≥95% 页面）识别为页面背景，从 elements 移除。 */
function isFullPagePic(bounds, size) {
  return bounds && bounds.w >= size.width * 0.95 && bounds.h >= size.height * 0.95
}

function yamlDeck({ title, width, height, pageRefs, band }) {
  const pages = pageRefs.map((r) => `  - ${r}`).join('\n')
  const bandNote = band
    ? `# 检测到跨页页眉/页脚带（模板特征）：建议安全区如下（注释呈现，未启用；确认为模板后取消注释并微调）\n# safeArea: {top: ${band.top}, bottom: ${band.bottom}}\n`
    : ''
  return `# 由 dsh-ppt-studio 从 pptx 导入（内容保真，版式可从新）
${bandNote}version: 1
title: ${JSON.stringify(title)}
size: [${width}, ${height}]
pages:
${pages}
`
}

function pageYaml(page, name) {
  const els = page.elements.map((el, i) => {
    const b = el.bounds
    const lines = []
    lines.push(`  - elementId: ${JSON.stringify(el.elementId ?? `el${i + 1}`)}`)
    lines.push(`    elementType: ${el.elementType}`)
    lines.push(`    bounds: [${b.x}, ${b.y}, ${b.w}, ${b.h}]`)
    if (el.kind) lines.push(`    kind: ${el.kind}`)
    if (el.get) { }
    if (el.fit) lines.push(`    fit: ${el.fit}`)
    if (el.src) lines.push(`    src: ${JSON.stringify(el.src)}`)
    if (el.fill) lines.push(`    fill: ${JSON.stringify(el.fill)}`)
    if (el.cols) {
      lines.push(`    cols: [${el.cols.map((c) => JSON.stringify(c)).join(', ')}]`)
      lines.push(`    rows: ${JSON.stringify(el.rows)}`)
    }
    if (el.header !== undefined) lines.push(`    header: ${el.header}`)
    if (el.chart) lines.push(`    chart: ${JSON.stringify(el.chart).replace(/^\{(.*)\}$/, '$1')}`)
    if (el.content) {
      lines.push('    content:')
      lines.push(`      text: ${JSON.stringify(el.content.text)}`)
      if (el.content.fontSize) lines.push(`      fontSize: ${el.content.fontSize}`)
      if (el.content.color) lines.push(`      color: ${JSON.stringify(el.content.color)}`)
      if (el.content.bold) lines.push(`      bold: true`)
    }
    return lines.join('\n')
  }).join('\n')
  return `# 导入自原 pptx（几何仅供参考，可由 layout 编辑器重排）
pageType: content
${page.background ? `background: ${JSON.stringify(page.background)}\n` : ''}elements:
${els}
`
}
