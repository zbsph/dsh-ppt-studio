/**
 * PPTD v1 中间层：结构校验 + 归一化（resolveDeck）。
 *
 * deck.yaml:
 *   version: 1
 *   title: str
 *   size: {width, height} | [w, h]   # 默认 960x540（16:9，1px = 1pt）
 *   theme:
 *     colors: {primary: '#2563EB', ...}
 *     textStyles: {title: {fontSize, color, fontFamily, bold, align, lineHeight}, ...}
 *     safeArea: {top, bottom, left, right}   # 背景模板的非内容区安全边距（verify 视其外为出界）
 *     minFontSize: 12                         # 导出 auto-fit 缩字下限（默认 12）
 *   pages: [pages/01_cover.yaml, ...]
 *
 * pages/<n>_<name>.yaml:
 *   pageType: cover|content|...
 *   background: '#hex' | '$themeRef' | {type: solid, color} | {type: image, src, fit?}  # fit: cover|contain|fill
 *   safeArea: {top, bottom, left, right}      # 可选，覆盖主题安全区
 *   expectedOverlaps: [{pair: [idA, idB]}, ...]   # 设计阶段声明的有意重叠（审阅与声明对照）
 *   expectedOutOfSafeArea: [idA, ...]         # 有意落在模板页眉页脚带/安全区外的元素（出界分级声明制）
 *   overlapMode: declared | lenient
 *   notes: str
 *   elements:
 *     - elementId: str              # 页内唯一
 *       elementType: text|shape|line|image|table|chart
 *       bounds: [x, y, w, h]        # px, 原点左上（line 可省略：由 points 的 AABB 自动推导）
 *       # text    → content: {text, style|fontSize|fontFamily|color|bold|align|lineHeight|wrap}
 *       # shape   → kind: rect|ellipse|triangle, fill, line:{color,width}, rotation
 *       # line    → points: [[x,y],...] | {x1,y1,x2,y2}, arrow: bool, line:{color,width}
 *       # image   → src(相对 deck 目录), fit: cover|contain|fill
 *       # table   → cols: [...], rows: [[...]], header: bool
 *       # chart   → chart: {type: bar|line|pie, data:{cols,rows}, series:[{name,x,y}] , colors:[...]}
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

const TEXT_STYLE_KEYS = ['fontSize', 'fontFamily', 'color', 'bold', 'italic', 'align', 'lineHeight', 'wrap', 'letterSpacing']
const ELEMENT_KEYS = {
  text: ['content'],
  shape: ['kind', 'fill', 'line'],
  line: ['points', 'arrow', 'line'],
  image: ['src', 'fit'],
  table: ['cols', 'rows', 'header'],
  chart: ['chart'],
}

/**
 * shape.kind 白名单（v0.9.1 候选 A：常见 prst 直通）。
 * 前 4 个为原始支持；其余为 OOXML prst 常见形状——kind 名 = OOXML prst 名（export 直通 / import 保留）。
 */
export const SHAPE_KINDS = [
  'rect', 'roundRect', 'ellipse', 'triangle', 'custGeom',       // 原始 + 自定义几何（v0.11 候选 C）
  'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow', // 箭头
  'pentagon', 'hexagon', 'chevron', 'parallelogram', 'diamond', 'octagon', 'star5', // 多边形/星
  'flowchartProcess', 'flowchartDecision', 'flowchartData', 'flowchartTerminator', // 流程图
]

/** custGeom 路径命令白名单（OOXML pathLst 全集子集）。 */
export const PATH_CMDS = new Set(['moveTo', 'lnTo', 'quadBezTo', 'cubicBezTo', 'arcTo', 'close'])

/** fill：'#hex' 或 '$themeRef'（实色）| {color, alpha?} | {type: 'gradient', stops: [{pos, color, alpha?}], angle?}（v0.11 候选 C）。 */
function validateFill(fill, path, errors) {
  if (typeof fill === 'string') {
    if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(fill) && !fill.startsWith('$')) errors.push(`${path}: hex color、$themeRef 或渐变/alpha 对象（v0.11 支持线性渐变与透明度）`)
    return
  }
  if (typeof fill === 'number' || fill === null) {
    errors.push(`${path}: hex color、$themeRef 或 {color, alpha?} 渐变对象`)
    return
  }
  if (!fill || typeof fill !== 'object') { errors.push(`${path}: hex color 或渐变对象`); return }
  if (fill.type !== undefined && fill.type !== 'gradient') errors.push(`${path}.type: gradient（省略 = {color, alpha} 纯色形式）`)
  if (fill.color !== undefined && typeof fill.color !== 'string') errors.push(`${path}.color: hex color 或 $themeRef`)
  if (fill.alpha !== undefined && !(typeof fill.alpha === 'number' && fill.alpha >= 0 && fill.alpha <= 100)) errors.push(`${path}.alpha: number 0-100（透明度百分比，OOXML alpha val/1000）`)
  if (fill.type === 'gradient') {
    if (!Array.isArray(fill.stops) || fill.stops.length < 2) {
      errors.push(`${path}.stops: [{pos, color}] 至少 2 个（pos 0-100）`)
    } else {
      fill.stops.forEach((s, i) => {
        if (!s || typeof s.pos !== 'number' || s.pos < 0 || s.pos > 100) errors.push(`${path}.stops[${i}].pos: number 0-100`)
        if (typeof s.color !== 'string' || !/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(s.color)) errors.push(`${path}.stops[${i}].color: hex color`)
        if (s.alpha !== undefined && !(typeof s.alpha === 'number' && s.alpha >= 0 && s.alpha <= 100)) errors.push(`${path}.stops[${i}].alpha: number 0-100`)
      })
    }
    if (fill.angle !== undefined && !(typeof fill.angle === 'number' && Number.isFinite(fill.angle))) errors.push(`${path}.angle: number (degrees, OOXML lin@ang 顺时针)`)
  }
}

/** custGeom 路径校验（kind=custGeom 时）：path.commands 白名单 + 点数 + arcTo 字段。 */
function validatePath(el, path, errors) {
  if (el.kind !== 'custGeom') return
  const p = el.path
  if (!p || typeof p !== 'object') { errors.push(`${path}.path: required object（kind=custGeom：{w, h, commands}）`); return }
  if (p.w !== undefined && !(typeof p.w === 'number' && p.w > 0)) errors.push(`${path}.path.w: positive number（路径坐标空间宽）`)
  if (p.h !== undefined && !(typeof p.h === 'number' && p.h > 0)) errors.push(`${path}.path.h: positive number`)
  if (!Array.isArray(p.commands) || !p.commands.length) {
    errors.push(`${path}.path.commands: non-empty array（moveTo/lnTo/quadBezTo/cubicBezTo/arcTo/close）`)
    return
  }
  p.commands.forEach((c, i) => {
    const cp = `${path}.path.commands[${i}]`
    if (!c || typeof c.cmd !== 'string' || !PATH_CMDS.has(c.cmd)) { errors.push(`${cp}.cmd: ${[...PATH_CMDS].join('|')}`); return }
    const ptN = { moveTo: 1, lnTo: 1, quadBezTo: 2, cubicBezTo: 3 }[c.cmd]
    if (c.cmd === 'close') return
    if (c.cmd === 'arcTo') {
      for (const k of ['wR', 'hR', 'stAng', 'swAng']) {
        if (typeof c[k] !== 'number' || !Number.isFinite(c[k])) errors.push(`${cp}.${k}: number（OOXML 弧参数：角度单位 60000/度）`)
      }
      return
    }
    if (!Array.isArray(c.pts) || c.pts.length !== ptN || c.pts.some((pt) => !Array.isArray(pt) || pt.length !== 2 || pt.some((n) => typeof n !== 'number' && !Number.isFinite(n)))) {
      errors.push(`${cp}.pts: [[x,y]×${ptN}]（路径坐标空间整数）`)
    }
  })
}

export class PptError extends Error {
  constructor(messages) { super(messages.join('\n')); this.messages = messages }
}

/** M3：theme token 引用完整性（静默回退是真缺陷——缺失 $ref 渲染将出字面 $xxx/默认样式）。 */
function themeRefCheck(page, theme, file) {
  const errors = []
  const colors = Object.keys(theme.colors ?? {})
  const textStyles = Object.keys(theme.textStyles ?? {})
  const checkRef = (v, where) => {
    if (typeof v !== 'string' || !v.startsWith('$')) return
    const name = v.slice(1)
    if (!colors.includes(name)) errors.push(`[${file}] ${where}：颜色引用 $${name} 不在 theme.colors（渲染/导出将出现字面 $${name}）——加入 theme 或改用实色`)
  }
  for (const [k, s] of Object.entries(theme.textStyles ?? {})) {
    if (typeof s?.color === 'string') checkRef(s.color, `theme.textStyles.${k}.color`)
  }
  for (const el of page.elements ?? []) {
    const w = `elements.${el.elementId}`
    if (el.content?.color !== undefined) checkRef(el.content.color, `${w}.content.color`)
    if (typeof el.content?.style === 'string' && el.content.style.startsWith('$')) {
      const name = el.content.style.slice(1)
      if (!textStyles.includes(name)) errors.push(`[${file}] ${w}.content.style：样式引用 $${name} 不在 theme.textStyles（静默回退默认样式）`)
    }
    if (typeof el.fill === 'string') checkRef(el.fill, `${w}.fill`)
    else if (el.fill && typeof el.fill === 'object') {
      if (typeof el.fill.color === 'string') checkRef(el.fill.color, `${w}.fill.color`)
      for (const s of el.fill.stops ?? []) if (typeof s.color === 'string') checkRef(s.color, `${w}.fill.stops`)
    }
    if (el.line?.color !== undefined) checkRef(el.line.color, `${w}.line.color`)
  }
  return errors
}

/** 结构校验：返回 PptError（含全部错误）或 null。 */
export function validateDeck(deck) {
  const errors = []
  if (!deck || typeof deck !== 'object') return fail('deck must be a YAML object')
  if (deck.version !== 1) errors.push(`deck.version must be 1 (got ${deck.version})`)
  if (deck.title !== undefined && typeof deck.title !== 'string') errors.push('deck.title must be a string')
  const size = normalizeSize(deck.size)
  if (!size) errors.push('deck.size must be {width,height} or [w,h] > 0')
  if (deck.theme) {
    if (deck.theme.colors) {
      for (const [k, v] of Object.entries(deck.theme.colors)) {
        if (typeof v !== 'string' || !/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(v)) errors.push(`theme.colors.${k}: expected hex color, got ${JSON.stringify(v)}`)
      }
    }
    if (deck.theme.textStyles) {
      for (const [k, v] of Object.entries(deck.theme.textStyles)) {
        if (!v || typeof v !== 'object') errors.push(`theme.textStyles.${k}: expected object`)
        else validateTextStyle(v, `theme.textStyles.${k}.`, errors)
      }
    }
    if (deck.theme.safeArea !== undefined && !validSafeArea(deck.theme.safeArea)) {
      errors.push('theme.safeArea: {top,bottom,left,right} numbers ≥ 0（背景模板非内容区安全边距；verify 视其外为出界）')
    }
    if (deck.theme.minFontSize !== undefined && !(typeof deck.theme.minFontSize === 'number' && deck.theme.minFontSize > 0)) {
      errors.push('theme.minFontSize: positive number（字号下限，导出 auto-fit 不会缩到它以下）')
    }
    if (deck.theme.themeConformance !== undefined && !['strict', 'suggest', 'off'].includes(deck.theme.themeConformance)) {
      errors.push('theme.themeConformance: strict（默认，颜色出板=门禁）| suggest（仅建议）| off')
    }
  }
  // 双轨真相层 v0.9.0：referenceTemplate（模板参考元数据，非渲染字段；materializeTemplate 注入）
  if (deck.referenceTemplate !== undefined) {
    const rt = deck.referenceTemplate
    if (!rt || typeof rt !== 'object' || Array.isArray(rt)) errors.push('deck.referenceTemplate: object (id/name/source/previews/audit；模板双轨参考元数据)')
    else {
      if (rt.id !== undefined && typeof rt.id !== 'string') errors.push('deck.referenceTemplate.id: string')
      if (rt.name !== undefined && typeof rt.name !== 'string') errors.push('deck.referenceTemplate.name: string')
      if (rt.source !== undefined && typeof rt.source !== 'string') errors.push('deck.referenceTemplate.source: string（reference/template.pptx 路径）')
      if (rt.previews !== undefined && (!Array.isArray(rt.previews) || rt.previews.some((p) => typeof p !== 'string'))) errors.push('deck.referenceTemplate.previews: [string]（Office 真渲染参考页路径）')
      if (rt.audit !== undefined && !(typeof rt.audit === 'string' || (rt.audit && typeof rt.audit === 'object'))) errors.push('deck.referenceTemplate.audit: string（audit.yaml 路径）或 styleAudit 内联对象')
    }
  }
  // 参考双轨 v0.9.1：referenceSource（用户文件参考元数据；importPptx 注入——参考任务与模板同通道）
  if (deck.referenceSource !== undefined) {
    const rs = deck.referenceSource
    if (!rs || typeof rs !== 'object' || Array.isArray(rs)) errors.push('deck.referenceSource: object (name/source/previews；用户源文件参考元数据)')
    else {
      if (rs.name !== undefined && typeof rs.name !== 'string') errors.push('deck.referenceSource.name: string')
      if (rs.source !== undefined && typeof rs.source !== 'string') errors.push('deck.referenceSource.source: string（source.pptx 路径）')
      if (rs.previews !== undefined && (!Array.isArray(rs.previews) || rs.previews.some((p) => typeof p !== 'string'))) errors.push('deck.referenceSource.previews: [string]（Office 真渲染参考页路径）')
    }
  }
  // 手术模式 v0.10.0：surgicalMap（可选页映射 {模板页号: deck 页号}，1-based；缺省序号对齐）
  if (deck.surgicalMap !== undefined) {
    const sm = deck.surgicalMap
    if (!sm || typeof sm !== 'object' || Array.isArray(sm)) {
      errors.push('deck.surgicalMap: object {模板页号(1-based): deck 页号(1-based)}（手术模式页映射；缺省=序号对齐）')
    } else {
      for (const [k, v] of Object.entries(sm)) {
        if (!/^\d+$/.test(k)) errors.push(`deck.surgicalMap.${k}: key 必须是模板页号（正整数）`)
        if (!Number.isInteger(v) || v < 1) errors.push(`deck.surgicalMap.${k}: 值必须是 deck 页号（正整数，1-based）`)
      }
    }
  }
  const pages = Array.isArray(deck.pages) ? deck.pages : []
  if (pages.length === 0) errors.push('deck.pages: at least one page required')
  return errors.length ? fail(errors) : null
}

/** 校验一个页面对象（YAML 已解析）。 */
export function validatePage(page, file) {
  const errors = []
  if (!page || typeof page !== 'object') return fail(`[${file}] page must be a YAML object`)
  if (page.version !== undefined && page.version !== 1) errors.push(`[${file}] page.version must be 1`)
  const elements = Array.isArray(page.elements) ? page.elements : []
  const ids = new Set()
  elements.forEach((el, i) => {
    const path = `[${file}] elements[${i}]`
    if (!el || typeof el !== 'object') { errors.push(`${path}: expected object`); return }
    if (typeof el.elementId !== 'string') errors.push(`${path}.elementId: required string`)
    else if (ids.has(el.elementId)) errors.push(`${path}.elementId: duplicate "${el.elementId}"`)
    else ids.add(el.elementId)
    const type = el.elementType
    if (!(type in ELEMENT_KEYS)) errors.push(`${path}.elementType: unknown "${type}" (${Object.keys(ELEMENT_KEYS).join('/')})`)
    // bounds：line 可省略（由 points 的 AABB 自动推导）；其余元素必须提供
    if (type === 'line') {
      if (el.bounds !== undefined && !validBounds(el.bounds)) errors.push(`${path}.bounds: [x,y,w,h] numbers, w/h > 0（line 可省略，由 points 自动推导）`)
    } else if (!validBounds(el.bounds)) {
      errors.push(`${path}.bounds: [x,y,w,h] numbers, w/h > 0（line 除外——line 省略 bounds 时由 points 推导）`)
    }
    if (el.role !== undefined && !['background', 'content', 'decoration'].includes(el.role)) {
      errors.push(`${path}.role: background|content|decoration（层叠语义：背景/内容/装饰；decoration 完全豁免重叠报告）`)
    }
    if (type === 'text') validateText(el, path, errors)
    if (type === 'shape') validateShape(el, path, errors)
    if (type === 'line') validateLine(el, path, errors)
    if (type === 'image') {
      if (typeof el.src !== 'string') errors.push(`${path}.src: required string`)
      if (el.fit !== undefined && !['cover', 'contain', 'fill'].includes(el.fit)) errors.push(`${path}.fit: cover|contain|fill`)
    }
    if (type === 'table') validateTable(el, path, errors)
    if (type === 'chart') validateChart(el, path, errors)
  })
  if (page.rowBounds !== undefined) errors.push(`[${file}] rowBounds: unsupported in v1`)
  if (page.expectedOverlaps !== undefined) {
    if (!Array.isArray(page.expectedOverlaps)) {
      errors.push(`[${file}] expectedOverlaps: array of {pair: [idA, idB]}（设计阶段声明的有意重叠，审阅与声明对照）`)
    } else {
      page.expectedOverlaps.forEach((po, i) => {
        if (!po || !Array.isArray(po.pair) || po.pair.length !== 2 || po.pair.some((x) => typeof x !== 'string')) {
          errors.push(`[${file}] expectedOverlaps[${i}]: {pair: [idA, idB]} with two element ids`)
        }
      })
    }
  }
  if (page.source !== undefined && typeof page.source !== 'string') {
    errors.push(`[${file}] source: string（数据来源标注；ppt_crosscheck 核查表用）`)
  }
  if (page.overlapMode !== undefined && !['declared', 'lenient'].includes(page.overlapMode)) {
    errors.push(`[${file}] overlapMode: declared（默认，未声明重叠即报错）| lenient（未声明仅提示）`)
  }
  if (page.safeArea !== undefined && !validSafeArea(page.safeArea)) {
    errors.push(`[${file}] safeArea: {top,bottom,left,right} numbers ≥ 0（页面级覆盖主题安全区）`)
  }
  if (page.expectedOutOfSafeArea !== undefined) {
    // 出界分级声明制（C3 修订，v0.3.2）：有意落在模板页眉页脚带/安全区外的元素，逐元素手工声明；
    // id 必须存在于本页（防呆：声明无效当场报错，避免"以为声明了却仍报错"）
    if (!Array.isArray(page.expectedOutOfSafeArea)) {
      errors.push(`[${file}] expectedOutOfSafeArea: array of element ids（有意落在安全区外的元素；仅对"超安全区"级生效，超页面边界永远不可声明）`)
    } else {
      page.expectedOutOfSafeArea.forEach((idX, i) => {
        if (typeof idX !== 'string') errors.push(`[${file}] expectedOutOfSafeArea[${i}]: element id string`)
        else if (!ids.has(idX)) errors.push(`[${file}] expectedOutOfSafeArea[${i}]: "${idX}" 不是本页元素 id（防呆：声明必须指向真实元素）`)
      })
    }
  }
  if (page.contrastExempt !== undefined) {
    // P1-1：对比度豁免声明（已确认承载层深色但算法仍误报时使用；id 必须存在）
    if (!Array.isArray(page.contrastExempt)) {
      errors.push(`[${file}] contrastExempt: array of element ids（已确认对比度正常的文本元素；id 必须存在）`)
    } else {
      page.contrastExempt.forEach((idX, i) => {
        if (typeof idX !== 'string') errors.push(`[${file}] contrastExempt[${i}]: element id string`)
        else if (!ids.has(idX)) errors.push(`[${file}] contrastExempt[${i}]: "${idX}" 不是本页元素 id（防呆：豁免必须指向真实元素）`)
      })
    }
  }
  validateBackground(page.background, file, errors)
  return errors.length ? fail(errors) : null
}

/** 页面背景校验：'#hex' | '$themeRef' | {type: solid, color} | {type: image, src, fit?} */
function validateBackground(bg, file, errors) {
  if (bg === undefined || bg === null) return
  if (typeof bg === 'string') {
    if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(bg) && !/^\$[A-Za-z0-9_]+$/.test(bg)) {
      errors.push(`[${file}] background: hex color string、$themeRef 或 {type: solid|image, ...}`)
    }
    return
  }
  if (typeof bg !== 'object') {
    errors.push(`[${file}] background: hex string 或 {type: solid, color} / {type: image, src}`)
    return
  }
  if (bg.type === 'solid') {
    if (typeof bg.color !== 'string' || !/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(bg.color) && !/^\$[A-Za-z0-9_]+$/.test(bg.color)) errors.push(`[${file}] background.color: hex color`)
  } else if (bg.type === 'image') {
    if (typeof bg.src !== 'string') errors.push(`[${file}] background.src: string (相对 deck 根或 URL)`)
    if (bg.fit !== undefined && !['cover', 'contain', 'fill'].includes(bg.fit)) errors.push(`[${file}] background.fit: cover|contain|fill`)
  } else {
    errors.push(`[${file}] background.type: solid|image`)
  }
}

function validateText(el, path, errors) {
  const c = el.content ?? {}
  if (typeof c.text !== 'string') errors.push(`${path}.content.text: required string`)
  validateTextStyle(c, `${path}.content.`, errors)
}

function validateTextStyle(s, path, errors) {
  for (const k of TEXT_STYLE_KEYS) {
    const v = s[k]
    if (v === undefined) continue
    if (k === 'fontSize' && !(typeof v === 'number' && v > 0)) errors.push(`${path}${k}: positive number`)
    if (k === 'fontFamily' && typeof v !== 'string') errors.push(`${path}${k}: string`)
    if (k === 'color' && typeof v !== 'string') errors.push(`${path}${k}: color string ($ref or hex)`)
    if (k === 'bold' && typeof v !== 'boolean') errors.push(`${path}${k}: boolean`)
    if (k === 'italic' && typeof v !== 'boolean') errors.push(`${path}${k}: boolean`)
    if (k === 'align' && !['left', 'center', 'right'].includes(v)) errors.push(`${path}${k}: left|center|right`)
    if (k === 'lineHeight' && !(typeof v === 'number' && v > 0)) errors.push(`${path}${k}: positive number`)
    if (k === 'wrap' && typeof v !== 'boolean') errors.push(`${path}${k}: boolean`)
  }
}

function validateShape(el, path, errors) {
  if (!SHAPE_KINDS.includes(el.kind)) errors.push(`${path}.kind: ${SHAPE_KINDS.slice(0, 4).join('|')} 或常见 prst（${SHAPE_KINDS.slice(4).join('|')}）`)
  if (el.fill !== undefined) validateFill(el.fill, `${path}.fill`, errors)
  if (el.kind === 'custGeom') validatePath(el, path, errors)
  if (el.rotation !== undefined && !(typeof el.rotation === 'number' && Number.isFinite(el.rotation))) errors.push(`${path}.rotation: number (degrees)`)
  if (el.line) {
    if (typeof el.line.color !== 'string') errors.push(`${path}.line.color: string`)
    if (el.line.width !== undefined && !(typeof el.line.width === 'number' && el.line.width > 0)) errors.push(`${path}.line.width: positive number`)
  }
}

function validateLine(el, path, errors) {
  const pts = Array.isArray(el.points) ? el.points : null
  const has = el.points ? pts.length === 2 && pts.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number')) : (typeof el.x1 === 'number' && typeof el.y1 === 'number' && typeof el.x2 === 'number' && typeof el.y2 === 'number')
  // P2-3：line 仅支持 2 点（多点折线静默截断是真缺陷 → 显式报错引导拆分）
  if (el.points && Array.isArray(el.points) && el.points.length !== 2) {
    errors.push(`${path}.points: 仅支持 2 点 [[x1,y1],[x2,y2]]（多点折线不支持，请拆分为多条 line）`)
  } else if (!has) {
    errors.push(`${path}.points: [[x1,y1],[x2,y2]] exactly 2 points, or x1,y1,x2,y2 numbers`)
  }
  if (el.arrow !== undefined && typeof el.arrow !== 'boolean') errors.push(`${path}.arrow: boolean`)
}

function validateTable(el, path, errors) {
  if (!Array.isArray(el.cols) || el.cols.length === 0) errors.push(`${path}.cols: non-empty array`)
  if (!Array.isArray(el.rows)) errors.push(`${path}.rows: array`)
  else el.rows.forEach((r, i) => { if (!Array.isArray(r)) errors.push(`${path}.rows[${i}]: array`) })
}

function validateChart(el, path, errors) {
  const c = el.chart
  if (!c || typeof c !== 'object') { errors.push(`${path}.chart: required object`); return }
  if (!['bar', 'line', 'pie'].includes(c.type)) errors.push(`${path}.chart.type: bar|line|pie`)
  const d = c.data
  if (!d || !Array.isArray(d.cols) || d.cols.length === 0) errors.push(`${path}.chart.data.cols: non-empty array`)
  if (!d || !Array.isArray(d.rows)) errors.push(`${path}.chart.data.rows: array`)
  if (c.series && !Array.isArray(c.series)) errors.push(`${path}.chart.series: array`)
}

function validBounds(b) {
  return Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n)) && b[2] > 0 && b[3] > 0
}

function validSafeArea(sa) {
  if (!sa || typeof sa !== 'object') return false
  return ['top', 'bottom', 'left', 'right'].every(
    (k) => sa[k] === undefined || (typeof sa[k] === 'number' && Number.isFinite(sa[k]) && sa[k] >= 0),
  )
}

function normalizeSize(size) {
  if (Array.isArray(size)) return size.length === 2 && size.every((n) => typeof n === 'number' && n > 0) ? { width: size[0], height: size[1] } : null
  if (size && typeof size === 'object' && size.width > 0 && size.height > 0) return { width: size.width, height: size.height }
  return null
}

function fail(messages) { return new PptError(Array.isArray(messages) ? messages : [messages]) }

/**
 * 读取并归一化一个 deck 项目：
 * 返回 { dir, deck, size, theme, colorOf, resolveColor, pages: [{ file, page, name, index }] }
 * 抛 PptError。
 */
export async function resolveDeck(dir) {
  const deckFile = join(dir, 'deck.yaml')
  if (!existsSync(deckFile)) throw fail(`deck.yaml not found under ${dir}`)
  const deck = YAML.parse(await readFile(deckFile, 'utf8')) ?? {}
  const err = validateDeck(deck)
  if (err) throw err
  const size = normalizeSize(deck.size) ?? { width: 960, height: 540 }
  const theme = deck.theme ?? {}
  const colors = theme.colors ?? {}
  const textStyles = theme.textStyles ?? {}
  const pages = []
  for (const ref of deck.pages) {
    const file = join(dir, ref)
    if (!existsSync(file)) throw fail(`page file missing: ${ref}`)
    const page = YAML.parse(await readFile(file, 'utf8')) ?? {}
    const perr = validatePage(page, ref)
    if (perr) throw perr
    const terr = themeRefCheck(page, theme, ref)
    if (terr.length) throw fail(terr)
    pages.push({ file: join(dir, ref), ref, page, name: (page.title ?? ref.replace(/\.yaml$/, '')).toString(), index: pages.length })
  }
  const resolveColor = (v) => {
    if (typeof v !== 'string') {
      // v0.9.1：渐变对象（stops 内 $ref 一并解析）；v0.11：{color, alpha} 形式 color 的 $ref 解析
      if (v && typeof v === 'object' && v.type === 'gradient' && Array.isArray(v.stops)) {
        return { ...v, stops: v.stops.map((s) => ({ ...s, color: typeof s.color === 'string' && s.color.startsWith('$') ? (colors[s.color.slice(1)] ?? s.color) : s.color })) }
      }
      if (v && typeof v === 'object' && typeof v.color === 'string' && v.color.startsWith('$')) {
        return { ...v, color: colors[v.color.slice(1)] ?? v.color }
      }
      return v
    }
    if (v.startsWith('$')) return colors[v.slice(1)] ?? v
    return v
  }
  const minFontSize = typeof theme.minFontSize === 'number' && theme.minFontSize > 0 ? theme.minFontSize : 12
  const safeAreaOf = (page) => {
    const t = theme.safeArea ?? {}
    const p = page.safeArea ?? {}
    const num = (v) => (typeof v === 'number' && v >= 0 ? v : 0)
    return {
      top: num(p.top ?? t.top),
      bottom: num(p.bottom ?? t.bottom),
      left: num(p.left ?? t.left),
      right: num(p.right ?? t.right),
    }
  }
  const resolveTextStyle = (obj) => {
    const merged = {}
    for (const k of TEXT_STYLE_KEYS) if (obj[k] !== undefined) merged[k] = obj[k]
    if (merged.fontSize === undefined) merged.fontSize = 18
    if (merged.lineHeight === undefined) merged.lineHeight = 1.2
    if (merged.wrap === undefined) merged.wrap = true
    if (merged.color !== undefined) merged.color = resolveColor(merged.color)
    return merged
  }
  const styleOf = (content) => {
    const ref = typeof content.style === 'string' && content.style.startsWith('$') ? textStyles[content.style.slice(1)] : {}
    const own = {}
    for (const k of TEXT_STYLE_KEYS) if (content[k] !== undefined) own[k] = content[k]
    return resolveTextStyle({ ...ref, ...own })
  }
  return {
    dir,
    deck,
    size,
    theme,
    colors,
    textStyles,
    minFontSize,
    safeAreaOf,
    resolveColor,
    resolveTextStyle,
    styleOf,
    pages,
  }
}
