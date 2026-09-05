/**
 * PPTX → PPTD 导入器（补完/修改/总结的基础）：内容保真、版式参考。
 * 抽取：文本（内容+字号/颜色/粗体）、形状（rect/ellipse/triangle）、
 * 图片（拷入 media/）、表格；chart 降级为文本占位（保留标题/说明）。
 * 输出 deck 项目目录（deck.yaml + pages/*.yaml + media/），几何保留供参考。
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { zipRead, decodeXml } from '../zips.js'
import { parseXml, children, first, allText } from '../xmljs.js'

const EMU = 12700
const px = (emu) => Math.round(emu / EMU)

/** v0.9.1 候选 A：常见 prst → shape.kind 直通（白名单 = schema SHAPE_KINDS；未见名→rect 兜底并记录 _styleRaw.prst）。 */
const PRST_MAP = new Set([
  'roundRect', 'ellipse', 'triangle',
  'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow',
  'pentagon', 'hexagon', 'chevron', 'parallelogram', 'diamond', 'octagon', 'star5',
  'flowchartProcess', 'flowchartDecision', 'flowchartData', 'flowchartTerminator',
])

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

  // 主题色（schemeClr → hex 映射，P0-1：导入保样式）
  const themeClr = {}
  const themeXml = files.get('ppt/theme/theme1.xml')
  if (themeXml) {
    const theme = parseXml(decodeXml(themeXml))
    const themeElements = first(theme, 'themeElements') ?? theme
    const clrScheme = first(themeElements, 'clrScheme')
    for (const c of clrScheme?.children ?? []) {
      const srgb = first(c, 'srgbClr')
      const sys = first(c, 'sysClr')
      const val = srgb?.attrs?.val ?? sys?.attrs?.lastClr ?? sys?.attrs?.val
      if (val) themeClr[c.tag] = '#' + String(val).toUpperCase()
    }
  }
  const colorOf = (node) => {
    // 支持两层结构：node 直接含 srgbClr/schemeClr，或经 solidFill 包裹（rPr/spPr 常见形态）
    const holder = first(node, 'solidFill') ?? node
    const srgb = first(holder, 'srgbClr')
    if (srgb?.attrs?.val) return '#' + String(srgb.attrs.val).toUpperCase()
    const scheme = first(holder, 'schemeClr')
    if (scheme?.attrs?.val) {
      const k = scheme.attrs.val
      return themeClr[k] ?? { lt1: '#FFFFFF', dk1: '#000000', lt2: '#F3F4F6', dk2: '#1F2937', tx1: '#000000', bg1: '#FFFFFF' }[k] ?? '#000000'
    }
    return undefined
  }

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
    const parsed = parseShapes(spTree, slideRels, mediaNames, { width, height }, { colorOf })
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
  const stats = collectStyleStats(pages) // P0-1：样式聚合（theme 建议）
  const pageRefs = []
  for (const page of pages) {
    const name = `slide_${String(page.index + 1).padStart(2, '0')}`
    const ref = `pages/${name}.yaml`
    pageRefs.push(ref)
    const yaml = pageYaml(page, name)
    await writeFile(join(outDir, ref), yaml)
  }
  const deckYaml = yamlDeck({ title: basename(pptxPath).replace(/\.pptx$/i, ''), width, height, pageRefs, band, stats })
  // 真相层 v0.9.0/0.9.1：保留原始 pptx → source.pptx（零失真源）+ Office 真渲染整页 → reference/previews/
  await copyFile(pptxPath, join(outDir, 'source.pptx')).catch(() => {})
  let refPreviews = null
  try {
    const { findPowerPoint, renderPptxToPng } = await import('../msrender.js')
    if (findPowerPoint()) {
      const r = await renderPptxToPng(pptxPath, join(outDir, 'reference', 'previews'), { timeoutMs: 300000 })
      if (r.pages) refPreviews = r.files.map((f) => 'reference/previews/' + basename(f))
    }
  } catch { /* 无 Office / 渲染失败：参考任务退化为骨架层 + source.pptx（可用 ppt_visual 补渲） */ }
  // 参考双轨注入：referenceSource 无条件（source 总在；previews 视 Office 可用性）
  const refBlock = `referenceSource:\n  name: ${JSON.stringify(basename(pptxPath))}\n  source: source.pptx\n${refPreviews?.length ? `  previews:\n${refPreviews.map((p) => `    - ${JSON.stringify(p)}`).join('\n')}\n` : ''}`
  await writeFile(join(outDir, 'deck.yaml'), deckYaml + refBlock)
  for (const name of mediaNames) {
    const data = files.get('ppt/media/' + name)
    if (data) await writeFile(join(outDir, 'media', name), data)
  }
  // A2 修复（反馈二）：页面引用 vs media 目录一致性自检——rels 指向包外/特殊格式的资源
  // 此前静默引用 media/placeholder.png（未提取）→ 导出时 ENOENT 硬失败且无指引；
  // 现在：缺失清单可行动提示 + 自动生成 1×1 白色占位图（导出立即可用，人工替换后自然清除）。
  const referenced = new Set()
  for (const page of pages) {
    if (page.background?.type === 'image' && typeof page.background.src === 'string') referenced.add(basename(page.background.src))
    for (const el of page.elements) if (el.elementType === 'image' && typeof el.src === 'string') referenced.add(basename(el.src))
  }
  const missingMedia = [...referenced].filter((bn) => !existsSync(join(outDir, 'media', bn)))
  if (missingMedia.length) {
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    for (const bn of missingMedia) await writeFile(join(outDir, 'media', bn), tinyPng)
  }
  // P0-1：原始样式清单（改版求一致场景直接复用；渐变 stops/阴影/字体引用保留原值）
  const stylesJson = {
    source: basename(pptxPath),
    size: { width, height },
    generatedBy: 'dsh-ppt-studio',
    note: '原始样式清单（改版求一致时直接复用；字段：fill/gradient/line/font/sz/color/bold/italic/align/shadow；页面元素按 page+id 定位）',
    elements: pages.flatMap((p) => p.elements.map((el) => ({ page: p.index + 1, id: el.elementId, ...(el._styleRaw ?? {}) }))),
  }
  await writeFile(join(outDir, 'import-styles.json'), JSON.stringify(stylesJson, null, 2))
  const bgCount = pages.filter((p) => p.background).length
  const styleCount = Object.keys(stats.colors).length
  return {
    outDir, pages: pages.length, media: [...mediaNames], size: { width, height },
    reference: refPreviews?.length ? { previews: refPreviews, source: 'source.pptx' } : null,
    warnings: ['chart 降级为文本占位；未映射 prst 形状近似为矩形（import-styles.json 有记录）',
      ...(missingMedia.length ? [`⚠ 原稿 ${missingMedia.length} 个媒体引用未提取（${missingMedia.join('、')}——rels 指向包外/特殊格式）：已在 media/ 生成 1×1 白色占位图，导出可用；建议人工替换或删除对应页面元素`] : []),
      ...(existsSync(join(outDir, 'source.pptx')) ? ['已保留原始 pptx ⊳ source.pptx（零失真真相层；参考双轨 v0.9.1）'] : []),
      ...(refPreviews?.length ? [`已生成整页真渲染 ⊳ reference/previews/（${refPreviews.length} 页，Office COM）——参考任务先看真身再动手`] : ['⚠ 未生成整页真渲染（无 Office 或渲染失败）：可用 ppt_visual 对 source.pptx 补渲；骨架层仍可用']),
      ...(styleCount ? [`已保留样式：${styleCount} 个颜色 / 字体与字号已映射（import-styles.json 含渐变/阴影原始值）`] : []),
      ...(bgCount ? [`已提取 ${bgCount} 页背景（含背景图/色/满页图）`] : []),
      ...(band ? [`检测到跨页页眉/页脚带（上 ${band.top}px / 下 ${band.bottom}px）：deck.yaml 已写入建议 safeArea（注释呈现，未启用；确认为模板后取消注释并微调）`] : [])],
  }
}

/** P0-1：样式聚合统计（theme 建议）：颜色频次 / 字号频次 / 字体频次。 */
function collectStyleStats(pages) {
  const colors = {}
  const fonts = {}
  const sizes = {}
  for (const p of pages) {
    for (const el of p.elements) {
      const raw = el._styleRaw ?? {}
      for (const c of [raw.fill, raw.color, raw.line?.color].filter(Boolean)) colors[c] = (colors[c] ?? 0) + 1
      if (raw.font) fonts[raw.font] = (fonts[raw.font] ?? 0) + 1
      if (raw.sz) sizes[raw.sz] = (sizes[raw.sz] ?? 0) + 1
    }
  }
  return { colors, fonts, sizes }
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
  if (!Object.keys(hint).length) return null
  return hint
}

/**
 * 保真解析（v0.7.1 升级）：递归遍历 spTree——
 * - grpSp 组合：子元素按 group xfrm（off/ext/chOff/chExt）坐标换算展开（嵌套组递归）；
 * - cxnSp 连接线：解析为 line 元素（flipH/flipV 决定方向，tailEnd → arrow）；
 * - sp/pic/graphicFrame：原有解析（经坐标变换链落到页面系）。
 */
function parseShapes(spTree, slideRels, mediaNames, pageSize, styleCtx) {
  const out = []
  let bg = null
  const st = { ...styleCtx, slideRels, mediaNames, pageSize, out, bgRef: (b) => { bg = b } }
  const identity = (x, y, w, h) => ({ x, y, w, h })
  for (const node of spTree?.children ?? []) walkNode(node, st, identity)
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

/** 递归子节点（toPage: 局部坐标 → 页面坐标的换算函数链）。 */
function walkNode(node, st, toPage) {
  if (node.tag === 'grpSp') {
    const g = groupXfrmOf(node)
    const kx = g.ext.w / Math.max(1e-6, g.chExt.w)
    const ky = g.ext.h / Math.max(1e-6, g.chExt.h)
    const childOfPage = (x, y, w, h) => toPage(g.off.x + (x - g.chOff.x) * kx, g.off.y + (y - g.chOff.y) * ky, w * kx, h * ky)
    for (const child of node.children ?? []) walkNode(child, st, childOfPage)
    return
  }
  const push = (el) => {
    if (!el) return
    // v0.11 候选 C：形状内文本（_shapeText = 附加 text 元素，与形状同 bounds，居中）
    if (el._shapeText) {
      const extra = el._shapeText
      delete el._shapeText
      const b = toPage(Number(extra.bounds.x), Number(extra.bounds.y), Number(extra.bounds.w), Number(extra.bounds.h))
      extra.bounds = safeBounds(b)
      st.out.push(extra)
    }
    if (el.bounds) {
      const b = toPage(Number(el.bounds.x), Number(el.bounds.y), Number(el.bounds.w), Number(el.bounds.h))
      el.bounds = safeBounds(b)
    }
    st.out.push(el)
  }
  if (node.tag === 'sp') push(spToEl(node, st))
  else if (node.tag === 'cxnSp') push(cxnToEl(node, st))
  else if (node.tag === 'pic') {
    const el = picToEl(node, st.slideRels, st.mediaNames)
    if (el && isFullPagePic(el.bounds, st.pageSize)) st.bgRef({ type: 'image', src: el.src, fit: 'cover' })
    else push(el)
  } else if (node.tag === 'graphicFrame') {
    const graphicData = first(node, 'graphic') && first(first(node, 'graphic'), 'graphicData')
    if (!graphicData) return
    const uri = graphicData.attrs.uri ?? ''
    if (uri.includes('/table')) {
      const tbl = first(graphicData, 'tbl')
      if (tbl) push(tableToEl(node, tbl))
    } else {
      push(chartToEl(node))
    }
  }
}

/** 组合 xfrm：off/ext（父系位置）+ chOff/chExt（子坐标系）。 */
function groupXfrmOf(node) {
  const spPr = first(node, 'spPr')
  const x = spPr ? first(spPr, 'xfrm') : undefined
  const off = x ? first(x, 'off') : undefined
  const ext = x ? first(x, 'ext') : undefined
  const chOff = x ? first(x, 'chOff') : undefined
  const chExt = x ? first(x, 'chExt') : undefined
  if (!off || !ext) return { off: { x: 0, y: 0 }, ext: { w: 100, h: 100 }, chOff: { x: 0, y: 0 }, chExt: { w: 100, h: 100 } }
  return {
    off: { x: Number(off.attrs.x ?? 0), y: Number(off.attrs.y ?? 0) },
    ext: { w: Math.max(1, Number(ext.attrs.cx ?? 0)), h: Math.max(1, Number(ext.attrs.cy ?? 0)) },
    chOff: { x: Number(chOff?.attrs?.x ?? 0), y: Number(chOff?.attrs?.y ?? 0) },
    chExt: { w: Math.max(1, Number(chExt?.attrs?.cx ?? 0)), h: Math.max(1, Number(chExt?.attrs?.cy ?? 0)) },
  }
}

/** 连接线（cxnSp）→ line 元素；flipH/flipV 决定端点；tailEnd → 箭头。 */
function cxnToEl(node, st) {
  const nv = first(node, 'nvCxnSpPr') ?? node
  const cNvPr = first(nv, 'cNvPr')
  const id = cNvPr?.attrs?.name ?? cNvPr?.attrs?.id ?? 'conn'
  const b = xfrmOf(node) ?? { x: 0, y: 0, w: 100, h: 10 }
  const spPr = first(node, 'spPr')
  const xf = spPr ? first(spPr, 'xfrm') : undefined
  const flipH = xf?.attrs?.flipH === '1'
  const flipV = xf?.attrs?.flipV === '1'
  const x1 = flipH ? b.x + b.w : b.x
  const x2 = flipH ? b.x : b.x + b.w
  const y1 = flipV ? b.y + b.h : b.y
  const y2 = flipV ? b.y : b.y + b.h
  const ln = lineOf(node, st.colorOf)
  const lnNode = spPr ? first(spPr, 'ln') : undefined
  const arrow = !!(lnNode && first(lnNode, 'tailEnd'))
  return {
    elementId: sanitize(id), elementType: 'line', bounds: safeBounds(b),
    points: [[x1, y1], [x2, y2]],
    ...(ln && Object.keys(ln).length ? { line: ln } : {}),
    ...(arrow ? { arrow: true } : {}),
    _styleRaw: { line: ln },
  }
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

/** 防御性 bounds（占位符/异常几何兜底为默认占位，避免 undefined/NaN 进入校验）。输入数组/对象均可，输出对象 {x,y,w,h}（内部契约）。 */
function safeBounds(b) {
  const obj = Array.isArray(b) ? { x: b[0], y: b[1], w: b[2], h: b[3] } : (b && typeof b === 'object' ? b : null)
  const x = Number(obj?.x)
  const y = Number(obj?.y)
  const w = Number(obj?.w)
  const h = Number(obj?.h)
  if ([x, y, w, h].every((n) => Number.isFinite(n)) && w > 0 && h > 0) return { x, y, w, h }
  return { x: 0, y: 0, w: 200, h: 50 }
}

function solidColor(node) {
  let fill = first(node, 'solidFill')
  if (!fill) {
    const ln = first(node, 'ln')
    if (ln) fill = first(ln, 'solidFill')
  }
  const s = fill ? first(fill, 'srgbClr') : undefined
  return s ? '#' + String(s.attrs.val).toUpperCase() : undefined
}

/** P0-1：填充样式：solidFill（srgb/scheme + alpha，v0.11 候选 C）或 gradFill（v0.9.1 双 stop + 逐 stop alpha）。 */
function fillOf(node, colorOf) {
  const spPr = first(node, 'spPr')
  const solid = spPr ? first(spPr, 'solidFill') : undefined
  if (solid) {
    const sc = first(solid, 'srgbClr') ?? first(solid, 'schemeClr')
    const alpha = alphaOf(sc)
    const color = colorOf(solid)
    return color ? (alpha !== undefined ? { color, alpha } : { color }) : {}
  }
  const grad = spPr ? first(spPr, 'gradFill') : undefined
  if (grad) {
    const gsLst = first(grad, 'gsLst') ?? grad
    const stops = []
    for (const gs of children(gsLst, 'gs')) {
      const c = colorOf(gs)
      const pos = gs.attrs?.pos !== undefined ? Number(gs.attrs.pos) / 1000 : undefined // OOXML pos 0-100000（0-100%）
      if (c) stops.push({ ...(pos !== undefined && Number.isFinite(pos) ? { pos } : {}), color: c, ...(alphaOf(gs) !== undefined ? { alpha: alphaOf(gs) } : {}) })
    }
    if (stops.length) {
      const lin = first(grad, 'lin')
      const angle = lin?.attrs?.ang !== undefined ? Math.round(Number(lin.attrs.ang) / 60000) % 360 : undefined
      const kind = grad.children?.some?.((c) => c.tag === 'path') ? 'path' : grad.children?.some?.((c) => c.tag === 'radialGradient') ? 'radial' : undefined
      const normalized = stops.map((s, i) => ({ pos: s.pos ?? (i / (stops.length - 1)) * 100, color: s.color, ...(s.alpha !== undefined ? { alpha: s.alpha } : {}) }))
      // 兼容：color = 末 stop（实色端）；gradient = 完整对象（闭环渲染/导出用）
      return { color: stops[stops.length - 1].color, gradient: { type: kind ?? 'linear', stops: normalized, ...(angle !== undefined ? { angle } : {}) } }
    }
  }
  return {}
}

/** 颜色节点（srgbClr/schemeClr）的 alpha（0-100，OOXML val/1000）。 */
function alphaOf(colorNode) {
  const a = colorNode ? first(colorNode, 'alpha') : undefined
  return a?.attrs?.val !== undefined ? Number(a.attrs.val) / 1000 : undefined
}

/** custGeom pathLst → PPTD path（{w, h, commands}，路径坐标为抽象单位——原样保留，不除以 EMU）。 */
function custPathOf(custGeom) {
  const pathLst = first(custGeom, 'pathLst')
  const path = pathLst ? first(pathLst, 'path') : undefined
  if (!path) return null
  const w = path.attrs?.w !== undefined && Number.isFinite(Number(path.attrs.w)) ? Number(path.attrs.w) : undefined
  const h = path.attrs?.h !== undefined && Number.isFinite(Number(path.attrs.h)) ? Number(path.attrs.h) : undefined
  const commands = []
  for (const c of path.children ?? []) {
    const pts = (c.tag === 'moveTo' || c.tag === 'lnTo' || c.tag === 'quadBezTo' || c.tag === 'cubicBezTo')
      ? children(c, 'pt').map((pt) => [Number(pt.attrs?.x ?? 0), Number(pt.attrs?.y ?? 0)])
      : []
    if (c.tag === 'moveTo' || c.tag === 'lnTo' || c.tag === 'quadBezTo' || c.tag === 'cubicBezTo') {
      if (pts.length === ({ moveTo: 1, lnTo: 1, quadBezTo: 2, cubicBezTo: 3 })[c.tag]) commands.push({ cmd: c.tag, pts })
    } else if (c.tag === 'arcTo') {
      commands.push({ cmd: 'arcTo', wR: Number(c.attrs?.wR ?? 0), hR: Number(c.attrs?.hR ?? 0), stAng: Number(c.attrs?.stAng ?? 0), swAng: Number(c.attrs?.swAng ?? 0) })
    } else if (c.tag === 'close') {
      commands.push({ cmd: 'close' })
    }
  }
  if (!commands.length) return null
  return { ...(w !== undefined ? { w } : {}), ...(h !== undefined ? { h } : {}), commands }
}

/** 文本内容提取（isText 与形状内文本共用）：rPr 样式 → {content, raw}。 */
function textContentOf(tx, text, colorOf) {
  const p0 = tx ? first(tx, 'p') : undefined
  const pPr = p0 ? first(p0, 'pPr') : undefined
  const r = p0 ? first(p0, 'r') : undefined
  const rPr = r ? first(r, 'rPr') : undefined
  const szAttr = rPr?.attrs?.sz ? Number(rPr.attrs.sz) / 100 : 18
  const color = rPr ? colorOf(rPr) : undefined
  const font = rPr?.children?.find((c) => c.tag === 'latin' || c.tag === 'ea')?.attrs?.typeface
  const align = pPr?.attrs?.algn ? { left: 'left', ctr: 'center', r: 'right' }[pPr.attrs.algn] : undefined
  const lnSpc = pPr ? first(pPr, 'lnSpc') : undefined
  const spcPct = lnSpc ? first(lnSpc, 'spcPct') : undefined
  const lineHeight = spcPct?.attrs?.val ? Math.round(Number(spcPct.attrs.val) / 100000 * 100) / 100 : undefined
  const bold = rPr?.attrs?.b === '1'
  const italic = rPr?.attrs?.i === '1'
  return {
    content: {
      text,
      ...(szAttr !== 18 ? { fontSize: szAttr } : {}),
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
      ...(color ? { color } : {}),
      ...(font ? { fontFamily: font } : {}),
      ...(align ? { align } : {}),
      ...(lineHeight && Math.abs(lineHeight - 1.2) > 0.05 ? { lineHeight } : {}),
    },
    raw: { sz: szAttr, font, color, bold, italic, align, lineHeight },
  }
}

/** P0-1：描边样式 a:ln → {color, width(px)}。 */
function lineOf(node, colorOf) {
  const spPr = first(node, 'spPr')
  const ln = spPr ? first(spPr, 'ln') : undefined
  if (!ln) return undefined
  const w = Number(ln.attrs?.w ?? 0)
  const c = colorOf(ln)
  return {
    ...(c ? { color: c } : {}),
    ...(w > 0 ? { width: Math.max(1, Math.round(w / EMU)) } : {}),
  }
}

function spToEl(node, styleCtx) {
  const { colorOf } = styleCtx
  const nv = first(node, 'nvSpPr') ?? node
  const cNvPr = first(nv, 'cNvPr')
  const id = cNvPr?.attrs?.name ?? cNvPr?.attrs?.id ?? 'sp'
  const bounds = xfrmOf(node)
  const tx = first(node, 'txBody')
  const spPr = first(node, 'spPr')
  const prstGeom = spPr ? first(spPr, 'prstGeom') : undefined
  const prst = prstGeom?.attrs?.prst
  const custGeom = spPr ? first(spPr, 'custGeom') : undefined
  const text = tx ? allText(tx).replace(/[\t ]+/g, ' ').trim().split(/\n\s*\n|(?<=。)\s*/) : []
  const textNonEmpty = text.join(' ').trim().length > 0
  // v0.11：custGeom 形状即使带文本也是形状（文本走 _shapeText 提取）——避免"弧形内文字"把形状整个变文本
  const isText = textNonEmpty && !custGeom && (!prst || (prst === 'rect' && !!tx))
  // P0-1：原始样式（import-styles.json 用）
  const raw = {}
  const fill = fillOf(node, colorOf)
  if (fill.color) raw.fill = fill.color
  if (fill.gradient) raw.gradient = fill.gradient
  const ln = lineOf(node, colorOf)
  if (ln) raw.line = ln
  const spPrFx = spPr ? first(spPr, 'effectLst') || first(spPr, 'effectDag') : undefined
  if (spPrFx) raw.shadow = true
  if (isText) {
    // 文本元素（P0-1：字体/斜体/对齐/行高一并提取）
    const tc = textContentOf(tx, text.join(' '), colorOf)
    Object.assign(raw, tc.raw)
    return { elementId: sanitize(id), elementType: 'text', bounds: safeBounds(bounds ?? {x: 0, y: 0, w: 200, h: 50}), content: tc.content, _styleRaw: raw }
  }
  // v0.11 候选 C：kind 判定——custGeom 优先，然后 prst 白名单，然后 rect
  let kind = 'rect'
  let path = null
  if (custGeom) {
    path = custPathOf(custGeom)
    if (path) kind = 'custGeom'
  }
  if (kind === 'rect' && PRST_MAP.has(prst)) kind = prst
  const out = {
    elementId: sanitize(id), elementType: 'shape', kind,
    bounds: safeBounds(bounds ?? {x: 0, y: 0, w: 100, h: 100}),
  }
  if (path) out.path = path
  if (fill.gradient) {
    // v0.9.1：渐变闭环——fill 直通对象（render/export 双端支持）；color 兜底 = 末 stop（旧兼容）
    out.fill = { type: 'gradient', stops: fill.gradient.stops, ...(fill.gradient.angle !== undefined ? { angle: fill.gradient.angle } : {}) }
    out._styleRaw = { ...raw, gradient: fill.gradient, prst: prst !== kind ? prst : undefined }
  } else if (fill.color) {
    out.fill = fill.alpha !== undefined ? { color: fill.color, alpha: fill.alpha } : fill.color
    if (prst && prst !== 'rect' && !PRST_MAP.has(prst)) raw.prst = prst // 未映射 prst 记录（兜底 rect）
    if (Object.keys(raw).length) out._styleRaw = raw
  } else {
    if (prst && prst !== 'rect' && !PRST_MAP.has(prst)) raw.prst = prst
    if (Object.keys(raw).length) out._styleRaw = raw
  }
  if (ln) out.line = ln
  // v0.11 候选 C：非文本框形状内文本（椭圆/自定义几何/序号等）→ 提取为独立文本元素（形状居中释放原文本）
  if (textNonEmpty && kind !== 'rect' && tx) {
    const tc = textContentOf(tx, text.join(' '), colorOf)
    const b = safeBounds(bounds ?? {x: 0, y: 0, w: 100, h: 100})
    const extra = {
      elementId: sanitize(`${id}_txt`), elementType: 'text',
      bounds: { x: b.x, y: b.y, w: b.w, h: b.h },
      content: { ...tc.content, align: tc.content.align ?? 'center' },
      _styleRaw: { ...tc.raw, shapeText: true },
    }
    out._shapeText = extra // 主流程合并（去重）
  }
  return out
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
  return { elementId: sanitize(id), elementType: 'image', bounds: safeBounds(xfrmOf(node) ?? {x: 0, y: 0, w: 200, h: 150}), src, fit: 'cover' }
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
  return { elementId: sanitize(id), elementType: 'table', bounds: safeBounds(xfrmOf(node) ?? {x: 0, y: 0, w: 400, h: 200}), cols, rows }
}

function chartToEl(node) {
  const nv = first(node, 'nvGraphicFramePr') ?? node
  const cNvPr = first(nv, 'cNvPr')
  const id = cNvPr?.attrs?.name ?? cNvPr?.attrs?.id ?? 'chart'
  return {
    elementId: sanitize(id), elementType: 'text',
    bounds: safeBounds(xfrmOf(node) ?? {x: 0, y: 0, w: 400, h: 220}),
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

function yamlDeck({ title, width, height, pageRefs, band, stats }) {
  const pages = pageRefs.map((r) => `  - ${r}`).join('\n')
  const bandNote = band
    ? `# 检测到跨页页眉/页脚带（模板特征）：建议安全区如下（注释呈现，未启用；确认为模板后取消注释并微调）\n# safeArea: {${['top', 'bottom'].filter((k) => band[k] !== undefined).map((k) => `${k}: ${band[k]}`).join(', ')}}\n`
    : ''
  // P0-1：样式聚合 → theme 建议块（聚合自原稿；页面本身已带内联样式，此块供"改版求一致"直接复用）
  const themeNote = stats ? themePresetOf(stats) : null
  return `# 由 dsh-ppt-studio 从 pptx 导入（内容保真，版式可从新）
${bandNote}${themeNote ? themeNote + '\n' : ''}version: 1
title: ${JSON.stringify(title)}
size: [${width}, ${height}]
pages:
${pages}
`
}

/** P0-1：样式聚合 → theme 建议（colors 高频 top7 + 全量扩展色板 + textStyles）。 */
/** A7 修复（反馈二 ★）：全量色板并入（含低频但原稿真实使用的颜色）——否则审阅
 *  theme-conformance 把原稿色全报"不在主题色板"，作者被迫手工补色。 */
function themePresetOf(stats) {
  const colorRank = Object.entries(stats.colors).sort((a, b) => b[1] - a[1])
  if (!colorRank.length) return null
  const ink = colorRank[0][0]
  const prim = colorRank.slice(0, 7).map(([c], i) => `    c${i + 1}: "${c}"${i === 0 ? '   # 最高频（建议作 ink/主色）' : ''}`).join('\n')
  const ext = colorRank.slice(7).map(([c], i) => `    c${i + 8}: "${c}"   # 原稿色板扩展（低频但审阅不再误报）`).join('\n')
  const colors = prim + (ext ? '\n' + ext : '')
  const szRank = Object.entries(stats.sizes).sort((a, b) => b[1] - a[1])
  const fontRank = Object.entries(stats.fonts).sort((a, b) => b[1] - a[1])[0]?.[0]
  const maxSz = szRank.length ? Math.max(...szRank.map(([s]) => Number(s)), 12) : 18
  const minSz = szRank.length ? Math.min(...szRank.map(([s]) => Number(s)), 12) : 12
  const bodySz = szRank[0]?.[0] ?? 14
  return [
    `# 建议主题（P0-1 聚合自原稿样式，可调；页面字段已内联，无需引用也可渲染）`,
    '# 色板为原稿全量（c1-c7 高频 + c8 起扩展低频色；theme-conformance 以全集为基准，不再误报原稿色）',
    'theme:',
    '  colors:',
    colors,
    '  textStyles:',
    `    title: {fontSize: ${maxSz}, color: "${ink}", bold: true}${fontRank ? `   # 字体 ${fontRank}` : ''}`,
    `    body: {fontSize: ${bodySz}, color: "${ink}"}`,
    `    label: {fontSize: ${minSz}, color: "${ink}"}`,
  ].join('\n')
}

function pageYaml(page, name) {
  const els = page.elements.map((el, i) => {
    const b = el.bounds
    const raw = el._styleRaw ?? {}
    const lines = []
    lines.push(`  - elementId: ${JSON.stringify(el.elementId ?? `el${i + 1}`)}`)
    lines.push(`    elementType: ${el.elementType}`)
    lines.push(`    bounds: [${b.x}, ${b.y}, ${b.w}, ${b.h}]`)
    if (el.kind) lines.push(`    kind: ${el.kind}`)
    if (el.elementType === 'line') {
      const pts = el.points ?? [[el.x1, el.y1], [el.x2, el.y2]]
      lines.push(`    points: ${JSON.stringify(pts)}`)
      if (el.arrow) lines.push(`    arrow: true`)
      // line 颜色/宽度由下方通用 el.line 行输出
    }
    if (el.fit) lines.push(`    fit: ${el.fit}`)
    if (el.src) lines.push(`    src: ${JSON.stringify(el.src)}`)
    // P0-1：样式保留；v0.9.1 渐变闭环（fill 对象直通，不再单一归主色）；v0.11 alpha 直通
    if (el.fill && typeof el.fill === 'object' && el.fill.type === 'gradient') {
      lines.push('    fill:')
      lines.push('      type: gradient')
      lines.push('      stops:')
      for (const s of el.fill.stops) lines.push(`        - {pos: ${s.pos}, color: "${s.color}"${s.alpha !== undefined ? `, alpha: ${s.alpha}` : ''}}`)
      if (el.fill.angle !== undefined) lines.push(`      angle: ${el.fill.angle}   # OOXML lin@ang 顺时针`)
    } else if (el.fill) {
      lines.push(`    fill: ${JSON.stringify(el.fill)}`)
    }
    // v0.11 候选 C：custGeom 路径（commands 多行）
    if (el.path) {
      lines.push('    path:')
      if (el.path.w !== undefined) lines.push(`      w: ${el.path.w}`)
      if (el.path.h !== undefined) lines.push(`      h: ${el.path.h}`)
      lines.push('      commands:')
      for (const c of el.path.commands) {
        if (c.cmd === 'close') lines.push('        - {cmd: close}')
        else if (c.cmd === 'arcTo') lines.push(`        - {cmd: arcTo, wR: ${c.wR}, hR: ${c.hR}, stAng: ${c.stAng}, swAng: ${c.swAng}}`)
        else lines.push(`        - {cmd: ${c.cmd}, pts: ${JSON.stringify(c.pts)}}`)
      }
    }
    if (raw.gradient && typeof raw.gradient === 'object') {
      const stopsTxt = (raw.gradient.stops ?? []).map((s) => s.color).join('→')
      lines.push(`    # import: 渐变 ${stopsTxt}（${raw.gradient.type ?? 'linear'}${raw.gradient.angle !== undefined ? `, angle ${raw.gradient.angle}°` : ''}）直通 fill.gradient`)
    }
    if (el.line) lines.push(`    line: {color: ${JSON.stringify(el.line.color ?? '#000000')}${el.line.width ? `, width: ${el.line.width}` : ''}}`)
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
      if (el.content.italic) lines.push(`      italic: true`)
      if (el.content.fontFamily) lines.push(`      fontFamily: ${JSON.stringify(el.content.fontFamily)}`)
      if (el.content.align) lines.push(`      align: ${el.content.align}`)
      if (el.content.lineHeight) lines.push(`      lineHeight: ${el.content.lineHeight}`)
    }
    return lines.join('\n')
  }).join('\n')
  return `# 导入自原 pptx（几何仅供参考，可由 layout 编辑器重排；样式已保留；v0.9.1 prst 形状/渐变直通）
pageType: content
${page.background ? `background: ${JSON.stringify(page.background)}\n` : ''}elements:
${els}
`
}
