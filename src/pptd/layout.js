/**
 * 布局数学：文本度量估算 + 元素归一化（渲染器/导出器/验证器共用）。
 * 估算档精度（v0.3 保守档，反馈 D4/E2：混合文本按偏宽估算，宁可误报不可漏报）：
 * CJK 全角 1em / Latin 0.6em / 数字 0.6em / 空格 0.4em / 其他 0.65em，
 * 行高 = fontSize × lineHeight；wrap 采用词级贪心切行。
 * 渲染（浏览器）与导出（pptd）共用本度量 → verify 通过 ⇒ 导出不再缩字。
 */

const CJK_RE = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u31f0-\u31ff\u3200-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/

export function charWidth(ch, fontSize, bold = false) {
  const code = ch.codePointAt(0)
  // A6 修复（反馈二）：CJK 加粗实测 ≈1.03–1.07em（微软雅黑粗体；报告案例 12.8/12=1.066）——计入 1.06
  // 避免"估算通过但 PowerPoint 真实排版溢出"的系统差（宁可误报不可漏报，D4 原则）。
  const boldCJK = bold ? 1.06 : 1
  if (CJK_RE.test(ch)) return fontSize * boldCJK
  if (code === 0x20) return fontSize * 0.4
  if (code >= 0x30 && code <= 0x39) return fontSize * 0.6
  if (code >= 0x41 && code <= 0x5a || code >= 0x61 && code <= 0x7a) return fontSize * (bold ? 0.63 : 0.6)
  if (code >= 0x3000 && code <= 0x303f) return fontSize * boldCJK
  return fontSize * (bold ? 0.69 : 0.65)
}

export function textWidth(text, style) {
  const fs = style.fontSize ?? 18
  let w = 0
  for (const ch of String(text)) w += charWidth(ch, fs, !!style.bold)
  return w
}

const NO_HEAD_START = /^[，。、！？；：）》】〕…—～]"?$/u
const NO_LINE_END = /^[（《【〔“‘]/u

/** 词级贪心换行（CJK 字符级 + 标点禁则）；返回 [lineWidths]。 */
export function wrapLines(text, style, maxWidth) {
  const fs = style.fontSize ?? 18
  const lines = []
  const paragraphs = String(text).split(/\n/)
  for (const para of paragraphs) {
    if (para === '') { lines.push(0); continue }
    // 拆 token：CJK 逐字；拉丁/数字/空白 词级
    const tokens = []
    for (const m of para.matchAll(/[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u31f0-\u31ff\u3200-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]|[^\s\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u31f0-\u31ff\u3200-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]+/gu)) {
      tokens.push(m[0])
    }
    let cur = 0
    let lineText = ''
    for (const token of tokens) {
      const ww = textWidth(token, style)
      // 禁则：行首不落标点（挤入当前行）
      if (cur + ww > maxWidth && cur > 0) {
        const isNoHead = NO_HEAD_START.test(token)
        if (isNoHead) {
          cur += ww
          lineText += token
          continue
        }
        lines.push(cur)
        cur = ww
        lineText = token
        continue
      }
      cur += ww
      lineText += token
    }
    lines.push(cur)
  }
  return lines
}

/**
 * 文本渲染估算：返回 { widthPx, heightPx, lines, overflow }。
 * overflow = 估算高度超出容器时的放大系数（供验证器/渲染器参考）。
 */
export function measureText(text, style, boxW) {
  const fs = style.fontSize ?? 18
  const lh = fs * (style.lineHeight ?? 1.2)
  const wrap = style.wrap !== false
  const widthPx = textWidth(text, style)
  if (!wrap) return { widthPx, heightPx: lh, lines: 1, lineWidths: [widthPx], overflow: widthPx > boxW ? widthPx / boxW : 1 }
  if (boxW <= 0) return { widthPx, heightPx: lh, lines: String(text).split(/\n/).length, lineWidths: [widthPx], overflow: 1 }
  const ws = wrapLines(text, style, boxW)
  return {
    widthPx,
    heightPx: lh * ws.length,
    lines: ws.length,
    lineWidths: ws,
    overflow: ws.length > 0 && lh * ws.length > 0 ? (lh * ws.length) / Math.max(fs, 1) / (fs / 1) : 1,
  }
}

/** 元素的 text 估算摘要（渲染时用于溢出显示与文本高度回填）。 */
export function textMetricsOf(content, style, boxW, boxH) {
  const m = measureText(content?.text ?? '', style, boxW)
  return {
    textW: m.widthPx,
    textH: m.heightPx,
    lines: m.lines,
    lineWidths: m.lineWidths,
    // 溢出量：文本高超过了容器高（正数溢出 px）
    overflowY: Math.max(0, Math.round(m.heightPx - boxH)),
    overflowX: Math.max(0, Math.round(m.widthPx - boxW)),
  }
}

export const TABLE_CELL_PT = 11 // 表格 cell 默认字号（pt）

/** 表格 cell 的**有效**字号：默认 11pt，但不得低于用户声明的下限 theme.minFontSize。
 *  为什么必须有这条下限（2026-09-18 修）：导出侧原本硬编码 11pt，而 audit 档的回读断言扫**全 slide XML**
 *  取全局最小 sz 与 minFontSize 比 —— 只要工程里有表且用户下限 ≥ 12，audit 就**永远 ✗**，
 *  而 DSL 里没有任何手段能改表格字号（"把用户逼到无法满足的门禁"）。
 *  算在这里（一次），由 normalizePage 挂到元素上，预览与成品共用 ⇒ 三层不可能再各写一个数。 */
export function tableCellFontPt(ctx) {
  const floor = typeof ctx?.minFontSize === 'number' && ctx.minFontSize > 0 ? ctx.minFontSize : 0
  return Math.max(TABLE_CELL_PT, floor)
}

export const TABLE_CELL_PAD_X = 7.2 // cell 左右内边距合计（pt；导出侧 marL/marR = 45720 EMU = 3.6pt ×2）
export const TABLE_CELL_PAD_Y = 3.6 // cell 上下内边距合计（pt；导出侧 marT/marB = 22860 EMU = 1.8pt ×2）

/** 元素包围盒：bounds 优先；line 缺省时由 points 的 AABB 推导（w/h ≥ 1px）。 */
function boundsOf(el) {
  if (el.bounds) {
    return { x: el.bounds[0], y: el.bounds[1], w: el.bounds[2], h: el.bounds[3] }
  }
  const pts = el.points ?? [[el.x1, el.y1], [el.x2, el.y2]]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) }
}

// 阶段 A-④：`attach`（把线段两端锚到元素边）在归一化阶段解析成坐标。
// 方向是 layout → relations（relations 不依赖 layout），无循环依赖。
import { resolveAttach } from './relations.js'
// G1：手画与族共用同一份路由后处理（正交化 + 箭头端最短直段），带 n<3 与折返两道守卫
import { routePolyline, isAxisAligned } from './route-geometry.js'

/** 归一化一个页面：元素 → 统一对象（含解析样式与文本度量）。 */
export function normalizePage(page, ctx) {
  const { resolveColor, styleOf } = ctx
  const elements = []
  // attach 解析要用**原始 DSL 元素**的几何查 ref（此时还没归一化）
  const srcById = new Map((page.page.elements ?? []).map((e) => [e.elementId, e]))
  for (const el of page.page.elements ?? []) {
    const b = boundsOf(el)
    const base = {
      id: el.elementId,
      type: el.elementType,
      bounds: b,
      ...(el.role ? { role: el.role } : {}),
      // 阶段 A（docs/08 §1）：结构声明字段必须**透传**——归一化是白名单式构造，
      // 漏在这里会让"结构关系"在导出/校验层凭空消失（几何反验证在 src/pptd/relations.js）。
      ...(el.contains ? { contains: el.contains } : {}),
      ...(el.badgeOf ? { badgeOf: el.badgeOf } : {}),
      ...(el.roleReason ? { roleReason: el.roleReason } : {}),
    }
    switch (el.elementType) {
      case 'text': {
        const style = styleOf(el.content ?? {})
        const m = textMetricsOf(el.content ?? {}, style, b.w, b.h)
        elements.push({ ...base, type: 'text', content: el.content, style, metrics: m })
        break
      }
      case 'shape': {
        const fill = el.fill !== undefined ? resolveColor(el.fill) : undefined
        const line = el.line ? {
          color: resolveColor(el.line.color ?? '#000'),
          width: el.line.width ?? 1,
        } : undefined
        // v0.11 候选 C：custGeom path 随归一化透传（render/export 消费）
        elements.push({ ...base, type: 'shape', kind: el.kind ?? 'rect', fill, line, ...(el.path ? { path: el.path } : {}), rotation: el.rotation ?? 0 })
        break
      }
      case 'line': {
        // 阶段 A-④：`attach` **优先于**手写 points —— 解析成坐标，被改写的端点进 attachNotes（另行提示，不静默覆盖）。
        // 导出侧只认 points（保持纯写盘层）；几何仍由 relations 的反验证兜底。
        const resolved = el.attach ? resolveAttach(el, srcById) : null
        const raw = resolved?.points ?? (el.points ? el.points.map((p) => p) : [[el.x1, el.y1], [el.x2, el.y2]])
        // ── G1（2026-09）：把只服务图族的两个后处理接到**显式 elements**（纯手画）通路 ──
        //   复用 route-geometry.js 的同一实现（族与手画不再双标），守卫详情见该模块注释。
        //   例外与族一致：斜段图形（环/放射语义）豁免正交化；亦可显式写 orthogonal: false。
        const exempt = el.orthogonal === false || el.line?.orthogonal === false || !isAxisAligned(raw)
        const pts = exempt ? raw : routePolyline(raw, el.arrow ?? false)
        const line = { color: resolveColor(el.line?.color ?? '#000'), width: el.line?.width ?? 1, ...(el.line?.dash ? { dash: el.line.dash } : {}) }
        // 阶段 A：`arrow` 必须**原样**透传。原先写作 `!!el.arrow` 会把 `'both'` 压成 `true`
        // ⇒ 两端箭头/虚线折线走到导出层时已经不认得（本轮实测：headEnd 计数 0）。
        elements.push({
          ...base, type: 'line', points: pts, arrow: el.arrow ?? false, line,
          ...(el.attach ? { attach: el.attach } : {}),
          ...(resolved?.notes?.length ? { attachNotes: resolved.notes } : {}),
        })
        break
      }
      case 'image':
        elements.push({ ...base, type: 'image', src: el.src, fit: el.fit ?? 'cover' })
        break
      case 'table': {
        // 【2026-09-18】表格内容进快照并给出**溢出估算**：此前快照只有 cols/rows 的**长度**，
        // verify 的溢出判定只认 kind==='text' ⇒ 表格内文字溢出**既无门禁也无警告**——
        // 而表格是 role:content 的内容元素，"内容溢出"恰恰是硬底线要管的（该严的地方没严）。
        // 度量与正文同源（同一 wrapLines / 同一字号）⇒ "估算保守、宁可误报"这一性质对表格同样成立。
        const fontPt = tableCellFontPt(ctx)
        const rowsAll = [el.header !== false ? el.cols : null, ...(el.rows ?? [])].filter(Boolean)
        const ncols = Math.max(1, ...rowsAll.map((r) => r.length))
        const style = { fontSize: fontPt, lineHeight: 1.2 }
        const usable = Math.max(1, b.w / ncols - TABLE_CELL_PAD_X)
        let need = 0
        let totalLines = 0
        for (const r of rowsAll) {
          let rl = 1
          for (let ci = 0; ci < ncols; ci++) {
            const t = String(r[ci] ?? '')
            if (!t) continue
            rl = Math.max(rl, wrapLines(t, style, usable).length)
          }
          totalLines += rl
          need += rl * fontPt * 1.2 + TABLE_CELL_PAD_Y
        }
        elements.push({ ...base, type: 'table', cols: el.cols, rows: el.rows ?? [], header: el.header !== false, fontPt,
          metrics: { overflowY: Math.round((need - b.h) * 10) / 10, lines: totalLines, textH: Math.round(need) } })
        break
      }
      case 'chart': {
        const chart = { ...el.chart }
        if (Array.isArray(chart.colors)) chart.colors = chart.colors.map((c) => resolveColor(c))
        elements.push({ ...base, type: 'chart', chart })
        break
      }
      default:
        elements.push(base)
    }
  }
  // ── 兜底规整：去除折线"折返尖刺"（X1 最终修复）──────────────────────────
  // 用户实测（图 10 顶端多出一根线）：锚点解析/后处理之后，点序里会出现"共线且折返"的多余点
  //（如 91.1 → 73.1 → 118.1），画出来就是一根戳出去的线。
  // 放在 **normalizePage 末尾** 是因为：预览、导出、门禁**都**走本函数 ⇒ 这是唯一
  // "改完不会被任何后续步骤覆盖"的位置（此前我改在它的上游，被解析/后处理覆盖 ⇒ 修不掉）。
  for (const e of elements) {
    if (e.type !== 'line' || !Array.isArray(e.points) || e.points.length < 3) continue
    const res = []
    for (const q of e.points) {
      // 反复回退，直到"最后两点 + 当前点"不再折返；**当前点始终保留**
      //（第一版写成 pop 后 continue，把当前点一起丢了 ⇒ 3 点被规整成 1 点 ⇒ 渲染报 "p2 is not iterable"，实测踩过）
      while (res.length >= 2) {
        const a1 = res[res.length - 2]
        const b1 = res[res.length - 1]
        const sameX = Math.abs(a1[0] - b1[0]) < 0.5 && Math.abs(b1[0] - q[0]) < 0.5
        const sameY = Math.abs(a1[1] - b1[1]) < 0.5 && Math.abs(b1[1] - q[1]) < 0.5
        const reversal = (sameX && (b1[1] - a1[1]) * (q[1] - b1[1]) < 0) || (sameY && (b1[0] - a1[0]) * (q[0] - b1[0]) < 0)
        if (reversal) res.pop()
        else break
      }
      res.push(q)
    }
    if (res.length >= 2) e.points = res
  }
  return elements
}
