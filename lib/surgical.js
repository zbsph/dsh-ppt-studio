/**
 * 手术模式（v0.10.0，候选 B）：以模板 .pptx 为底版做"结构精确贴模板"——
 * 单页 OOXML 文本/表格槽替换（只改 <a:t> 内容，rPr/几何/渐变/字体全部原样保留），
 * 其余页**内容逐字节不变**（解包 sha256 验证），最后重打包。
 *
 * 与双轨的关系：双轨 = 风格复刻 + 骨架继承（快、稳、像）；手术 = 结构精确贴模板（贴、重、准）。
 * 与 ppt_export 的关系：两种成品路径，互不影响——常规导出走 PPTD 渲染；贴模板保真走手术。
 *
 * 实现要点：xmljs 是只读解析器，手术替换必须**字符串切片**；扫描时把每个 <a:t> 的
 * 绝对位置（s/e）记下，替换 = 全局自后向前切片（只动 a:t 区间字节）——
 * rPr/xfrm/渐变/几何因此全部原样保留，这就是"贴模板"的保真根源。
 *
 * 边界（v1 诚实声明）：
 * - 只替换 spTree 顶层的文本 sp 与表格 graphicFrame；grpSp 组合内文本、图片、形状几何不动（装饰原子）。
 * - 无 xfrm 的槽（layout 占位符：页码/日期占位）不参与匹配，保留模板原文。
 * - 表格按 cell 序（row-major）替换 min(用户, 模板) 行；模板多余 cell 保留原文。
 * - 新增页（deck 页数 > 模板页数）v1 不注入：报告警告，请用常规导出；rels 增量/资源注入留 v1.1。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import { zipRead, zipWrite, decodeXml } from './zips.js'
import { parseXml, first, children, allText } from './xmljs.js'

const EMU = 12700
const px = (emu) => Math.round(Number(emu) / EMU)

/**
 * 扫描 slide XML：spTree 顶层（跳过 grpSp 区间）的文本 sp 槽与表格 frame 槽。
 * 槽的 spans 用**绝对 XML 位置**（s/e），便于直接切片。
 * @returns { slots, tables }  slots: [{kind:'sp', name, x,y,w,h, text, spans:[{s,e,text}]}]
 *                             tables: [{kind:'table', name, x,y,w,h, rows:[{cells:[{spans,text,skip}]}]}]
 */
export function scanSlideXml(xml) {
  const slots = []
  const tables = []
  const start = xml.indexOf('<p:spTree>')
  const end = xml.indexOf('</p:spTree>')
  if (start < 0 || end < 0) return { slots, tables }
  // grpSp 排除区间（组合 = 装饰原子）
  const excluded = []
  let i = start
  while (i < end) {
    const gs = xml.indexOf('<p:grpSp>', i)
    if (gs < 0 || gs > end) break
    const ge = xml.indexOf('</p:grpSp>', gs)
    if (ge < 0 || ge > end) break
    excluded.push([gs, ge + '</p:grpSp>'.length])
    i = ge + '</p:grpSp>'.length
  }
  const inside = (pos) => excluded.some(([a, b]) => pos >= a && pos < b)
  i = start
  while (i < end) {
    const sp = xml.indexOf('<p:sp>', i)
    const fr = xml.indexOf('<p:graphicFrame>', i)
    let pos
    let closeTag
    if (sp >= 0 && sp < end && (fr < 0 || fr > end || sp < fr)) { pos = sp; closeTag = '</p:sp>' }
    else if (fr >= 0 && fr < end) { pos = fr; closeTag = '</p:graphicFrame>' }
    else break
    if (inside(pos)) { i = pos + 1; continue }
    const ce = xml.indexOf(closeTag, pos)
    if (ce < 0 || ce > end) break
    const seg = xml.slice(pos, ce + closeTag.length)
    const spot = closeTag === '</p:sp>' ? parseSpSpot(seg, pos) : parseFrameSpot(seg, pos)
    if (spot) (closeTag === '</p:sp>' ? slots : tables).push(spot)
    i = ce + closeTag.length
  }
  return { slots, tables }
}

function parseSpSpot(seg, base) {
  const name = /<p:cNvPr[^>]*name="([^"]*)"/.exec(seg)?.[1] ?? '(no name)'
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>/.exec(seg)
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/.exec(seg)
  const spans = spansOf(seg, base)
  if (!spans.length || !off || !ext) return null // 无文本/无位置（layout 页码占位等）：不手术
  const text = spans.map((s) => s.text).join('')
  // 非文本框（AutoShape/椭圆等）的纯序号文本（"1"/"2"/"3"）= 装饰槽，排除（deck 无对应内容）
  const isTextBox = /txBox="1"/.test(seg)
  if (!isTextBox && /^\d{1,3}$/.test(text)) return null
  return {
    kind: 'sp', name,
    x: px(off[1]), y: px(off[2]), w: Math.max(1, px(ext[1])), h: Math.max(1, px(ext[2])),
    spans, text,
  }
}

function parseFrameSpot(seg, base) {
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>/.exec(seg)
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/.exec(seg)
  if (!off || !ext) return null
  const name = /<p:cNvPr[^>]*name="([^"]*)"/.exec(seg)?.[1] ?? '(table)'
  const rows = []
  let i = 0
  while (i < seg.length) {
    const tr = seg.indexOf('<a:tr ', i)
    if (tr < 0) break
    const te = seg.indexOf('</a:tr>', tr)
    if (te < 0) break
    const rowSeg = seg.slice(tr, te)
    const cells = []
    let j = 0
    while (j < rowSeg.length) {
      const tc = rowSeg.indexOf('<a:tc>', j)
      if (tc < 0) break
      const tce = rowSeg.indexOf('</a:tc>', tc)
      if (tce < 0) break
      const cellSeg = rowSeg.slice(tc + '<a:tc>'.length, tce)
      const gridSpan = /gridSpan="(\d+)"/.exec(cellSeg)
      const spans = spansOf(cellSeg, base + tr + tc + '<a:tc>'.length)
      cells.push({
        spans,
        text: spans.map((s) => s.text).join(''),
        skip: !!gridSpan || !spans.length,
      })
      j = tce + '</a:tc>'.length
    }
    rows.push({ cells })
    i = te + '</a:tr>'.length
  }
  if (!rows.length) return null
  return { kind: 'table', name, x: px(off[1]), y: px(off[2]), w: Math.max(1, px(ext[1])), h: Math.max(1, px(ext[2])), rows }
}

/** 段内所有 <a:t>（含 <a:t/>）的绝对位置与文本（base = 段在 XML 全串的起点）。 */
function spansOf(seg, base) {
  const spans = []
  const re = /<a:t\s[^>]*>|<a:t\/>|<a:t>/g
  let m
  while ((m = re.exec(seg))) {
    const sPos = base + m.index
    const head = m[0]
    if (head.endsWith('/>')) {
      spans.push({ s: sPos, e: sPos + head.length, text: '' })
    } else {
      const close = seg.indexOf('</a:t>', m.index + head.length)
      if (close < 0) continue
      spans.push({ s: sPos, e: sPos + (close + '</a:t>'.length - m.index), text: seg.slice(m.index + head.length, close) })
    }
  }
  return spans
}

// ── 位置匹配（贪心唯一配对：中心距离升序）─────────────────────────────────

function center(b) {
  // bounds 兼容 {x,y,w,h} 与 [x,y,w,h]（resolveDeck 页面元素两种形态）
  const x = Array.isArray(b) ? b[0] : b.x
  const y = Array.isArray(b) ? b[1] : b.y
  const w = Array.isArray(b) ? b[2] : b.w
  const h = Array.isArray(b) ? b[3] : b.h
  return { cx: x + w / 2, cy: y + h / 2 }
}
function dist(a, b) { return Math.hypot(a.cx - b.cx, a.cy - b.cy) }

/** 槽（模板侧）↔ 用户侧元素（内容真相）的贪心唯一配对。 */
export function matchByDistance(slots, items) {
  const pairs = []
  const usedSlot = new Set()
  const usedItem = new Set()
  const all = []
  for (const s of slots) {
    const cs = center(s)
    if (!Number.isFinite(cs.cx) || !Number.isFinite(cs.cy)) continue
    for (const it of items) {
      const ci = center(it.bounds)
      if (!Number.isFinite(ci.cx) || !Number.isFinite(ci.cy)) continue
      all.push({ s, it, d: dist(cs, ci) })
    }
  }
  all.sort((a, b) => a.d - b.d)
  for (const { s, it, d } of all) {
    if (usedSlot.has(s) || usedItem.has(it)) continue
    usedSlot.add(s)
    usedItem.add(it)
    pairs.push({ slot: s, item: it, distance: Math.round(d) })
  }
  return pairs
}

// ── 替换（全局逆序切片；只动 a:t 区间）──────────────────────────────────

export function escapeXml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** 归一化文本比较：导入/多 run 拼接的空白差异不算"改动"（视觉等价 → 保持模板字节）。 */
export const normText = (s) => String(s ?? '').replace(/\s+/g, '').trim()

/**
 * 单页手术。
 * @param xml 原 slide XML（decodeXml 后字符串）
 * @param textPairs matchByDistance(scan.slots, deckTextItems) 结果
 * @param tablePairs matchByDistance(scan.tables, deckTableItems) 结果
 * @returns { xml, fields, cleared, tableCells, warnings }
 */
export function patchSlideXml(xml, textPairs, tablePairs) {
  let fields = 0
  let cleared = 0
  let tableCells = 0
  const warnings = []
  const ops = [] // {s, e, replacement}（绝对位置）
  for (const { slot, item } of textPairs) {
    const newText = item.content?.text ?? ''
    if (normText(slot.text) === normText(newText)) continue // 未改（含导入规范化差异）→ 保持模板字节
    if (!newText) cleared++
    fields++
    const esc = escapeXml(newText)
    slot.spans.forEach((sp, k) => ops.push({ s: sp.s, e: sp.e, replacement: k === 0 ? `<a:t>${esc}</a:t>` : '<a:t></a:t>' }))
  }
  for (const { slot, item } of tablePairs) {
    const userRows = item.rows ?? []
    const tRows = slot.rows
    const n = Math.min(userRows.length, tRows.length)
    if (userRows.length > tRows.length) warnings.push(`表格 "${slot.name}" 收缩：用户 ${userRows.length} 行 > 模板 ${tRows.length} 行，多余行未注入（v1 限制）`)
    for (let r = 0; r < n; r++) {
      const userRow = userRows[r] ?? []
      for (let c = 0; c < userRow.length && c < tRows[r].cells.length; c++) {
        const cell = tRows[r].cells[c]
        if (cell.skip) continue // 合并 cell/空 cell：不碰
        const newText = String(userRow[c] ?? '')
        if (normText(cell.text) === normText(newText)) continue
        tableCells++
        const esc = escapeXml(newText)
        cell.spans.forEach((sp, k) => ops.push({ s: sp.s, e: sp.e, replacement: k === 0 ? `<a:t>${esc}</a:t>` : '<a:t></a:t>' }))
      }
    }
  }
  if (!ops.length) return { xml, fields: 0, cleared, tableCells, warnings }
  ops.sort((a, b) => b.s - a.s) // 逆序：位置不漂移
  let out = xml
  for (const op of ops) out = out.slice(0, op.s) + op.replacement + out.slice(op.e)
  return { xml: out, fields, cleared, tableCells, warnings }
}

// ── zip 层：模板条目保留（内容哈希验证）─────────────────────────────────

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 模板展示顺序：presentation.xml sldIdLst → rels → ppt/slides/slideN.xml。 */
export function slideOrderOf(zip) {
  const pres = zip.get('ppt/presentation.xml')
  if (!pres) return []
  const doc = parseXml(decodeXml(pres))
  const sldIdLst = first(first(doc, 'presentation'), 'sldIdLst')
  const relsXml = zip.get('ppt/_rels/presentation.xml.rels')
  const relMap = new Map()
  if (relsXml) {
    const rd = parseXml(decodeXml(relsXml))
    for (const rel of first(rd, 'Relationships')?.children ?? []) {
      if (rel.tag === 'Relationship' && rel.attrs?.Id && rel.attrs?.Target) {
        relMap.set(rel.attrs.Id, rel.attrs.Target.startsWith('/') ? rel.attrs.Target.slice(1) : 'ppt/' + rel.attrs.Target.replace(/^\.\.\//g, ''))
      }
    }
  }
  const out = []
  for (const sld of sldIdLst?.children ?? []) {
    if (sld.tag !== 'sldId') continue
    const target = relMap.get(sld.attrs['r:id'] ?? sld.attrs.id)
    if (target && (zip.has(target) || zip.has(target.replace(/^ppt\//, '')))) {
      const key = target.startsWith('ppt/') ? target : 'ppt/' + target.replace(/^ppt\//, '')
      out.push(key.startsWith('ppt/') ? key : 'ppt/' + key)
    }
  }
  // 兜底：rels 未命中时（懒模板）按文件名序
  if (!out.length) {
    const keys = [...zip.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    return keys
  }
  return out
}

/**
 * 手术主流程：模板真身 ← 用户内容（deck 页文本/表格）→ 成品 pptx。
 * @param {template} 模板 pptx 绝对路径；@param deckDir 工作区（deck.yaml）；@param out 输出路径
 * @param map 可选 {1: 2}（模板页号(1-based) → deck 页号(1-based)；缺省序号对齐）
 * @returns { entries, patchedSlides, report }
 */
export async function surgicalPatch({ template, deckDir, out, map = {} }) {
  const { resolveDeck } = await import('./pptd/schema.js')
  const tplBuf = await readFile(template)
  const tplZip = zipRead(tplBuf)
  const ctx = await resolveDeck(deckDir)
  const order = slideOrderOf(tplZip)
  const entries = new Map([...tplZip]) // 保序（central dir 顺序）
  const pages = []
  const patched = new Set()
  let fields = 0
  let tableCells = 0
  const warnings = []
  const extraDeckPages = []
  for (let ti = 0; ti < order.length; ti++) {
    const xmlPath = order[ti]
    const di = map[ti + 1] !== undefined ? Number(map[ti + 1]) - 1 : (ti < ctx.pages.length ? ti : -1)
    const deckPage = di >= 0 ? ctx.pages[di] : undefined
    if (!deckPage) {
      pages.push({ index: ti + 1, slide: xmlPath, action: 'kept', note: '无对应 deck 页（模板原样）' })
      continue
    }
    const xml = decodeXml(tplZip.get(xmlPath))
    const scan = scanSlideXml(xml)
    // deck 页内的文本/表格元素（bounds px、content）
    const textItems = []
    const tableItems = []
    for (const el of deckPage.page.elements ?? []) {
      if (!el.bounds) continue
      // 页码/编号占位元素：导入兜底 bounds（0,0）会抢左上角槽——排除（模板页码由 layout 渲染，槽侧也无位置）
      if (el.elementType === 'text' && /灯片编号|slideNumber|页码/i.test(String(el.elementId ?? ''))) continue
      if (el.elementType === 'text') textItems.push({ id: el.elementId, bounds: el.bounds, content: el.content ?? {} })
      if (el.elementType === 'table') tableItems.push({ id: el.elementId, bounds: el.bounds, rows: el.rows ?? [], cols: el.cols ?? [] })
    }
    const textPairs = matchByDistance(scan.slots, textItems)
    const tablePairs = matchByDistance(scan.tables, tableItems)
    const res = patchSlideXml(xml, textPairs, tablePairs)
    if (res.fields || res.tableCells) {
      patched.add(xmlPath)
      entries.set(xmlPath, Buffer.from(res.xml, 'utf8'))
      fields += res.fields
      tableCells += res.tableCells
      warnings.push(...res.warnings)
      pages.push({ index: ti + 1, slide: xmlPath, action: 'patched', fields: res.fields, cleared: res.cleared, tableCells: res.tableCells })
    } else {
      pages.push({ index: ti + 1, slide: xmlPath, action: 'kept', note: '内容与模板一致（无字段变更）' })
    }
  }
  // deck 页数 > 模板页数：v1 不注入（诚实报告）
  for (let di = ctx.pages.length - 1; di >= order.length; di--) extraDeckPages.push(di + 1)
  if (extraDeckPages.length) {
    warnings.push(`deck 有 ${extraDeckPages.length} 页（第 ${extraDeckPages.join('、')} 页）超过模板页数——v1 手术只处理模板已有页；新增页请用常规 ppt_export（成品为两段混合）`)
  }
  // 重打包（条目保序）
  const outBuf = zipWrite(Object.fromEntries(entries))
  // 验证：未手术条目内容 sha256 与模板一致
  const ver = verifySurgical(outBuf, tplZip, patched)
  await writeFile(out, outBuf)
  return {
    out,
    pages,
    patched: patched.size,
    fields,
    tableCells,
    warnings,
    verify: ver,
    deckPages: ctx.pages.length,
    templateSlides: order.length,
  }
}

/** 手术成品验证：除被手术页外，输出条目解包内容与模板逐字节一致（sha256）。 */
export function verifySurgical(outBuf, tplZip, patchedKeys) {
  let total = 0
  let identical = 0
  let mismatched = 0
  const details = []
  const outZip = zipRead(outBuf)
  for (const [name, content] of tplZip) {
    if (patchedKeys.has(name)) continue
    total++
    const outContent = outZip.get(name)
    if (outContent && sha256(outContent) === sha256(content)) identical++
    else { mismatched++; details.push(name) }
  }
  return { total, identical, mismatched, details }
}
