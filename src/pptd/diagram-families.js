/**
 * 阶段 C 图族库（第一批）：tree（层级树）/ matrix（矩阵·象限）/ timeline（时间轴·里程碑）。
 *
 * 每个族 = `{ maturity, layout({d, box, style, id, measure, notes}) → {elements, groups} }`。
 * 族只做**该族的几何策略**；一切取色/字号/线宽/间距来自 `style`（引擎与族都**没有审美**）。
 *
 * 共用不变量（由 `scripts/verify-diagram-ir.mjs` 逐族断言）：
 *   · 只产既有元素类型（shape/text/line）；· 节点互不重叠且落在画布内；· 连线端点锚在节点边上；
 *   · 容器严格包住成员、且容器之间不重叠（重叠就退化为"只保留逻辑组"并记 note，不硬画）；
 *   · 确定性（同输入两次输出深度相等）；· 空间不够时**省略装饰性内容并记 note**，不硬塞。
 */

/** 简易换行（词级贪心；CJK 按字）。各族共用，避免"长标签溢出节点"。 */
export function wrapLabel(text, maxW, fontSize, measure) {
  const s = String(text ?? '')
  if (!s) return ['']
  const cjk = /[\u3000-\u9fff]/.test(s)
  const words = cjk ? [...s] : s.split(/\s+/)
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur}${cjk ? '' : ' '}${w}` : w
    if (measure(next, fontSize) > maxW && cur) { lines.push(cur); cur = w } else cur = next
  }
  if (cur) lines.push(cur)
  return lines
}

const R = (n) => Math.round(n * 100) / 100

/** 节点（圆角矩形 + 居中标签）。返回 [shape, text]。 */
export function makeNode(style, idOf, { id, x, y, w, h, label = '', emphasis = 'primary', fontSize }) {
  const fill = emphasis === 'plain' ? style.neutral : (emphasis === 'accent' ? (style.palette[1] ?? style.palette[0]) : style.palette[0])
  const fs = fontSize ?? style.fontSize
  const shape = {
    elementId: idOf(id), elementType: 'shape', kind: 'roundRect',
    bounds: [R(x), R(y), R(w), R(h)], fill, line: { color: style.ink, width: style.lineWidth },
  }
  const lines = wrapLabel(label, w - 12, fs, style.measureLine)
  const th = Math.max(1, lines.length) * fs * 1.3
  const txt = {
    elementId: idOf(`t_${id}`), elementType: 'text',
    bounds: [R(x + 6), R(y + Math.max(3, (h - th) / 2)), R(w - 12), R(Math.min(th + 2, h - 4))],
    content: { text: lines.join('\n'), fontSize: fs, color: emphasis === 'plain' ? style.ink : '#FFFFFF', align: 'center', wrap: false },
  }
  shape.contains = [txt.elementId]
  return [shape, txt]
}

/** 折线/直线（可带 attach 与标签）。points 为绝对坐标数组。 */
export function makeEdge(style, idOf, { id, points, from, to, arrow = true, dashed = false, label, labelBox }) {
  const els = []
  const el = {
    elementId: idOf(id), elementType: 'line',
    points: points.map(([x, y]) => [R(x), R(y)]),
    arrow,
    line: { color: style.ink, width: style.lineWidth, ...(dashed ? { dash: 'dash' } : {}) },
  }
  if (from && to) el.attach = { from, to }
  els.push(el)
  if (label && labelBox) {
    const fs = Math.max(10, Math.round(style.fontSize * 0.85))
    const tw = Math.min(style.measureLine(label, fs), Math.max(24, labelBox.w))
    els.push({
      elementId: idOf(`el_${id}`), elementType: 'text',
      bounds: [R(labelBox.x + (labelBox.w - tw) / 2), R(labelBox.y), R(tw), 16],
      content: { text: label, fontSize: fs, color: style.ink, align: 'center', wrap: false },
    })
  }
  return els
}

/** 纯文本（标题/轴标签/组标题）。 */
export function makeText(style, idOf, { id, x, y, w, text, sizeFactor = 0.85, align = 'left', color }) {
  const fs = Math.max(10, Math.round(style.fontSize * sizeFactor))
  return {
    elementId: idOf(id), elementType: 'text', bounds: [R(x), R(y), R(Math.max(12, w)), 16],
    content: { text, fontSize: fs, color: color ?? style.ink, align, wrap: false },
  }
}

/** 分组容器（紧贴成员 + pad；与其他容器重叠时**不硬画**，只保留逻辑组）。 */
export function makeContainer(style, idOf, { gid, box, members, existing, notes, fill }) {
  for (const c of existing) {
    if (box.x < c.x + c.w && c.x < box.x + box.w && box.y < c.y + c.h && c.y < box.y + box.h) {
      notes.push(`分组 "${gid}" 的容器与已有容器重叠 ⇒ 只保留逻辑组（不硬画，避免"意外重叠"）`)
      return null
    }
  }
  return {
    elementId: idOf(`g_${gid}`), elementType: 'shape', kind: 'roundRect',
    bounds: [R(box.x), R(box.y), R(box.w), R(box.h)],
    fill: fill ?? style.neutral, line: { color: style.ink, width: style.lineWidth },
    role: 'background', contains: [...new Set(members)],
  }
}

/** 容器包住一组矩形（含 pad）。 */
export function boxOf(rects, pad) {
  const x0 = Math.min(...rects.map((r) => r.x)) - pad
  const y0 = Math.min(...rects.map((r) => r.y)) - pad
  const x1 = Math.max(...rects.map((r) => r.x + r.w)) + pad
  const y1 = Math.max(...rects.map((r) => r.y + r.h)) + pad
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// ── 族 ①：tree（层级树 / 组织图）─────────────────────────────────────────
/**
 * 结构：用 `edges` 表示父子（from=父，to=子）；无入边的节点是根（多根也支持）。
 * 几何：按**叶子序**分配横向槽位（经典 tidy tree 的简化版），内部节点取子节点中点；正交折线连接（父底 → 子顶）。
 */
function layoutTree({ d, box, style, id, notes }) {
  const elements = []
  const nodes = d.nodes ?? []
  const edges = d.edges ?? []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const children = new Map()
  const hasParent = new Set()
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue
    if (!children.has(e.from)) children.set(e.from, [])
    children.get(e.from).push(e.to)
    hasParent.add(e.to)
  }
  const roots = nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id)
  if (roots.length === 0) { notes.push('tree：没有根节点（edges 形成环？）⇒ 不产元素'); return { elements, groups: [] } }

  // 深度 + 叶子序
  const depth = new Map()
  const leafIdx = new Map()
  let leaf = 0
  let maxDepth = 0
  const walk = (nid, dep) => {
    if (depth.has(nid)) return
    depth.set(nid, dep)
    maxDepth = Math.max(maxDepth, dep)
    const kids = (children.get(nid) ?? []).filter((k) => !depth.has(k))
    if (kids.length === 0) { leafIdx.set(nid, leaf++) } else for (const k of kids) walk(k, dep + 1)
  }
  for (const r of roots) walk(r, 0)
  const leaves = Math.max(leaf, 1)
  const levelH = box.h / (maxDepth + 1)
  const slotW = box.w / leaves
  const nodeH = Math.max(30, Math.min(48, levelH * 0.56))
  const nodeW = Math.max(56, Math.min(slotW * 0.76, 200))
  const pos = new Map()
  const place = (nid) => {
    if (pos.has(nid)) return pos.get(nid)
    const kids = (children.get(nid) ?? []).filter((k) => depth.get(k) === (depth.get(nid) ?? 0) + 1)
    let cx
    if (kids.length === 0) cx = box.x + (leafIdx.get(nid) ?? 0) * slotW + slotW / 2
    else cx = kids.map((k) => place(k)).reduce((a, r) => a + r.x + r.w / 2, 0) / kids.length
    const r = { x: cx - nodeW / 2, y: box.y + (depth.get(nid) ?? 0) * levelH + (levelH - nodeH) / 2, w: nodeW, h: nodeH }
    pos.set(nid, r)
    return r
  }
  for (const r of roots) place(r)

  let i = 0
  for (const n of nodes) {
    const r = pos.get(n.id)
    if (!r) { notes.push(`tree：节点 "${n.id}" 不在任何根可达的子树里（环或孤立）⇒ 已跳过`); continue }
    elements.push(...makeNode(style, id, { id: n.id, x: r.x, y: r.y, w: r.w, h: r.h, label: n.label, emphasis: n.emphasis }))
  }
  for (const e of edges) {
    const A = pos.get(e.from)
    const B = pos.get(e.to)
    if (!A || !B) continue
    const px = A.x + A.w / 2
    const cx = B.x + B.w / 2
    const y0 = A.y + A.h
    const y1 = B.y
    const midY = (y0 + y1) / 2
    elements.push(...makeEdge(style, id, {
      id: `e${i++}`,
      points: [[px, y0], [px, midY], [cx, midY], [cx, y1]],
      from: { ref: id(e.from), side: 'bottom' },
      to: { ref: id(e.to), side: 'top' },
      dashed: e.style === 'dashed',
      label: e.label,
      labelBox: e.label ? { x: (px + cx) / 2 - 40, y: midY - 18, w: 80 } : null,
    }))
  }
  return { elements, groups: [], pos }
}

// ── 族 ②：matrix（矩阵 / 象限）──────────────────────────────────────────
/**
 * 结构：`nodes` 按行优先填入 rows×cols 网格；`rowLabels`/`colLabels` 可选（真实矩阵图的表头）。
 * 轴标签放在网格外侧；空间不够时省略表头并记 note。
 */
function layoutMatrix({ d, box, style, id, notes }) {
  const elements = []
  const nodes = d.nodes ?? []
  const cols = Math.max(1, Math.min(Number(d.cols ?? 3), nodes.length || 1))
  const rows = Math.max(1, Math.min(Number(d.rows ?? Math.ceil(nodes.length / cols)), nodes.length || 1))
  const rowLabels = Array.isArray(d.rowLabels) ? d.rowLabels : []
  const colLabels = Array.isArray(d.colLabels) ? d.colLabels : []
  // 标题必须占**画布内**的一条（放在 box.y - 24 会掉到安全区外 ⇒ out-of-safe-area 报错，本轮实测）
  const titleH = d.title ? 22 : 0
  const headW = rowLabels.length ? Math.max(40, Math.min(90, box.w * 0.14)) : 0
  const headH = colLabels.length ? 22 : 0
  const grid = { x: box.x + headW, y: box.y + titleH + headH, w: box.w - headW, h: box.h - titleH - headH }
  if (grid.w < 60 || grid.h < 40) { notes.push('matrix：扣除表头后网格过小 ⇒ 不产元素（请放大 bounds 或去掉表头）'); return { elements, groups: [] } }
  const gx = style.gap * 0.6
  const cw = (grid.w - gx * (cols - 1)) / cols
  const ch = (grid.h - gx * (rows - 1)) / rows
  if (cw < 40 || ch < 26) notes.push(`matrix：网格 ${rows}×${cols} 偏挤（格 ${Math.round(cw)}×${Math.round(ch)}），建议减少行列或放大画布`)
  const pos = new Map()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const n = nodes[r * cols + c]
      if (!n) continue
      const cell = { x: grid.x + c * (cw + gx), y: grid.y + r * (ch + gx), w: cw, h: ch }
      pos.set(n.id, cell)
      elements.push(...makeNode(style, id, { id: n.id, ...cell, label: n.label, emphasis: n.emphasis }))
    }
  }
  if (colLabels.length) {
    const cols2 = Math.min(cols, colLabels.length)
    for (let c = 0; c < cols2; c++) elements.push(makeText(style, id, { id: `cl${c}`, x: grid.x + c * (cw + gx), y: box.y + titleH, w: cw, text: String(colLabels[c]), align: 'center' }))
    if (colLabels.length !== cols) notes.push('matrix：colLabels 数量与列数不一致 ⇒ 只取前若干项（其余忽略）')
  }
  if (rowLabels.length) {
    const rows2 = Math.min(rows, rowLabels.length)
    for (let r = 0; r < rows2; r++) elements.push(makeText(style, id, { id: `rl${r}`, x: box.x, y: grid.y + r * (ch + gx) + Math.max(0, ch / 2 - 8), w: Math.max(24, headW - 8), text: String(rowLabels[r]), align: 'right' }))
    if (rowLabels.length !== rows) notes.push('matrix：rowLabels 数量与行数不一致 ⇒ 只取前若干项（其余忽略）')
  }
  if (d.title) elements.unshift(makeText(style, id, { id: 'mx_title', x: box.x, y: box.y, w: box.w, text: String(d.title), sizeFactor: 1.1, align: 'left' }))
  return { elements, groups: [], pos }
}

// ── 族 ③：timeline（时间轴 / 里程碑）─────────────────────────────────────
/**
 * 结构：`nodes` = 里程碑（按顺序沿轴均匀排布），可选 `edges` 忽略（时间轴不画连线）。
 * 几何：一条水平轴线；里程碑为轴上的小圆点；标签上下交替，用短竖线连到轴（避免压字）。
 */
function layoutTimeline({ d, box, style, id, notes }) {
  const elements = []
  const nodes = d.nodes ?? []
  const axisY = box.y + box.h / 2
  const n = nodes.length
  if (n === 0) return { elements, groups: [] }
  const slot = box.w / n
  const dot = Math.max(10, Math.min(18, slot * 0.16))
  const labelW = Math.max(48, Math.min(slot * 0.86, 190))
  const labelAbove = (style.fontSize * 1.3) * 2 + 8
  const aboveY = axisY - dot / 2 - 12 - 16
  const belowY = axisY + dot / 2 + 12
  // 轴线：两端各留半格，避免与"下方标签"同宽误判（轴线 AABB 高度为 0，本来也不会被判重叠）
  elements.push(...makeEdge(style, id, { id: 'axis', points: [[box.x, axisY], [box.x + box.w, axisY]], arrow: false, dashed: false }))
  const pos = new Map()
  for (let i = 0; i < n; i++) {
    const nd = nodes[i]
    const cx = box.x + slot * i + slot / 2
    const up = i % 2 === 0
    const y = up ? aboveY : belowY
    // 分组取景用：圆点 + 标签的整体范围
    pos.set(nd.id, { x: cx - labelW / 2, y: Math.min(y, axisY - dot / 2), w: labelW, h: Math.max(y + 18, axisY + dot / 2) - Math.min(y, axisY - dot / 2) })
    // 里程碑圆点
    const s = {
      elementId: id(`dot_${nd.id}`), elementType: 'shape', kind: 'ellipse',
      bounds: [R(cx - dot / 2), R(axisY - dot / 2), R(dot), R(dot)],
      fill: nd.emphasis === 'accent' ? (style.palette[1] ?? style.palette[0]) : style.palette[0],
      line: { color: style.ink, width: style.lineWidth }, role: 'decoration',
    }
    // 引出短竖线（圆点 → 标签）
    const stubTo = up ? y + 16 : y
    elements.push(s)
    elements.push(...makeEdge(style, id, { id: `stub_${nd.id}`, points: [[cx, up ? axisY - dot / 2 : axisY + dot / 2], [cx, stubTo]], arrow: false }))
    // 标签（含日期/说明两行：用 \n 时由 wrapLabel 控制；这里单块文本）
    const els = makeNode(style, id, { id: `lb_${nd.id}`, x: cx - labelW / 2, y, w: labelW, h: 18, label: nd.label, emphasis: 'plain', fontSize: Math.max(10, Math.round(style.fontSize * 0.9)) })
    // 标签块只用其中的文本框（时间轴不需要卡片底）
    elements.push(els[1])
    if (els[1].content.text.split('\n').length > 1) notes.push(`timeline：里程碑 "${nd.id}" 的标签换行了（槽宽 ${Math.round(labelW)}px），必要时缩短文案`)
  }
  if (d.title) elements.unshift(makeText(style, id, { id: 'tl_title', x: box.x, y: box.y, w: box.w, text: String(d.title), sizeFactor: 1.1 }))
  void labelAbove
  return { elements, groups: [], pos }
}

export const FAMILIES = {
  tree: { maturity: 'beta', layout: layoutTree, summary: '层级树/组织图（正交折线、按叶子序排布）' },
  matrix: { maturity: 'beta', layout: layoutMatrix, summary: '矩阵/象限（行列网格 + 表头）' },
  timeline: { maturity: 'beta', layout: layoutTimeline, summary: '时间轴/里程碑（水平轴 + 上下交替标签）' },
}
