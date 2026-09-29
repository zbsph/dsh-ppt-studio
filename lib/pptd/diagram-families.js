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

/**
 * 箭头端的"直线段最短长度"。
 * 用户实测反馈：拐点离箭头太近时，箭头看起来像"断的"、也看不出指向（附图那根线就是在箭头处拐弯）。
 * 规则：带箭头的端点，其**紧邻的那一段**必须 ≥ ARROW_MIN_RUN 像素；不够就把相邻的**拐点**沿该段反向挪远。
 * 只挪拐点、不动端点（attach 语义不变），且挪动方向沿该段自身 ⇒ 拐点仍落在原来的走廊/间隙里。
 */
const ARROW_MIN_RUN = 18
import { DEFAULT_TRAITS, DENSITY, traitSummary } from './style-traits.js'

export function arrowEndRuns(pts, arrow) {
  const p = (pts ?? []).map(([x, y]) => [x, y])
  if (p.length < 2) return p
  // 让 p[i]→p[j] 这一段至少有 MIN 长（挪 i，不动 j）
  const fix = (i, j) => {
    const d = Math.hypot(p[j][0] - p[i][0], p[j][1] - p[i][1])
    if (d === 0 || d >= ARROW_MIN_RUN) return
    const ux = (p[j][0] - p[i][0]) / d
    const uy = (p[j][1] - p[i][1]) / d
    let nx = p[j][0] - ux * ARROW_MIN_RUN
    let ny = p[j][1] - uy * ARROW_MIN_RUN
    // **夹紧（X1-b）**：挪动后的拐点不得越过相邻点 p[i-1] —— 越过就形成"折返尖刺"
    //（用户实测图 10 顶端多出一根线：91.1 → 73.1 → 118.1 的折返就是这里挪出来的）。
    // 宁可这一段略短于 18px，也不许出现折返（折返 100% 是缺陷，短直段只是观感弱一点）。
    if (i - 1 >= 0) {
      const px = p[i - 1][0]
      const py = p[i - 1][1]
      const sameX = Math.abs(px - p[i][0]) < 0.5 && Math.abs(p[i][0] - p[j][0]) < 0.5
      const sameY = Math.abs(py - p[i][1]) < 0.5 && Math.abs(p[i][1] - p[j][1]) < 0.5
      if (sameX) ny = uy > 0 ? Math.min(ny, py) : Math.max(ny, py)
      else if (sameY) nx = ux > 0 ? Math.min(nx, px) : Math.max(nx, px)
    }
    p[i] = [nx, ny]
  }
  const n = p.length
  if (arrow === true || arrow === 'end' || arrow === 'both') fix(n - 2, n - 1) // 箭头在末端
  if (arrow === 'both') fix(1, 0) // 两端箭头：起点那一段
  return p
}

/**
 * 斜段 → 直角折线：把每一段非轴对齐的线拆成"先横后竖"两段（插入一个拐点）。
 *
 * **这是设计定死的规则**（用户提出、2026-09-28 敲定）：引擎产出的折线**永远轴对齐**。
 *   · 正交路由是这套图的"工程感"来源，也让"竖/横段 AABB 宽或高为 0"这条重叠判定前提成立；
 *   · 斜段会让**箭头方向不确定**（截图里那种"看不出指向"的线就是斜段+拐弯叠加）；
 *   · **唯一例外**：本身就是"环/放射"语义的图形（`cycle` 的外环弦、`funnel` 的梯形斜边），
 *     前者用 `orthogonal: false` 显式声明豁免，后者画的是 custGeom 形状而不是箭头折线。
 * 用途：兜住 `arrowEndRuns` 之类的后处理——它们只挪拐点，可能把**前一段**拉斜（用户实测发现的回归）。
 */
export function orthogonalize(pts) {
  if (!pts || pts.length < 2) return pts
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = out[out.length - 1]
    const [x1, y1] = pts[i]
    if (Math.abs(x1 - x0) < 0.5 || Math.abs(y1 - y0) < 0.5) { out.push([x1, y1]); continue }
    out.push([x1, y0], [x1, y1]) // 先横后竖
  }
  return out
}

/** 折线/直线（可带 attach 与标签）。points 为绝对坐标数组。 */
export function makeEdge(style, idOf, { id, points, from, to, arrow = true, dashed = false, label, labelBox, orthogonal = true }) {
  const els = []
  const el = {
    elementId: idOf(id), elementType: 'line',
    // 顺序要紧：先正交化 → 再保证箭头端直段（它只挪拐点，可能拉斜前一段）→ 再正交化一次收口。
    // 最后一段的长度不受第二次正交化影响（它只拆前一段），所以"≥18px 直段"仍然成立。
    points: (orthogonal ? orthogonalize(arrowEndRuns(orthogonalize(points), arrow)) : arrowEndRuns(points, arrow)).map(([x, y]) => [R(x), R(y)]),
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

// ── 族 ④：swimlane（泳道图）──────────────────────────────────────────────
/**
 * 结构：`groups` = 泳道（顺序即自上而下），`nodes` 通过所属 group 归道；未归道的节点自成一列。
 * 关键设计：泳道带用 **`role: decoration`**（完全豁免重叠报告）而不是"容器 contains"——
 * 跨道连线的折线 AABB 有高度，若把泳道做成容器就会被判"意外重叠"；而跨道穿越泳道带**本来就是泳道图的语义**。
 * 车道分隔线是轴对齐直线（AABB 高/宽为 0），本身也不会触发重叠判定。
 * 跨道连线走**列间隙的竖直走廊**（不穿节点盒），因此 `line-through-box` 也不会触发。
 */
function layoutSwimlane({ d, box, style, id, notes }) {
  const elements = []
  const nodes = d.nodes ?? []
  const lanes = (Array.isArray(d.groups) ? d.groups : []).map((g) => ({ id: g.id, label: g.label, members: (g.members ?? []).filter((m) => nodes.some((n) => n.id === m)) }))
  if (lanes.length === 0) { notes.push('swimlane：没有泳道（请用 groups 声明每条泳道的成员）⇒ 不产元素'); return { elements, groups: [], skipContainers: true } }
  const laneCount = lanes.length
  const laneH = box.h / laneCount
  const headW = 0 // 泳道标题放在带上沿内侧，不占列宽
  const cols = Math.max(...lanes.map((l) => l.members.length), 1)
  const gx = style.gap
  const colW = (box.w - headW - gx * (cols - 1)) / cols
  const nodeW = Math.max(56, Math.min(colW * 0.8, 200))
  const nodeH = Math.max(28, Math.min(laneH * 0.5, 56))
  const pos = new Map()
  lanes.forEach((lane, li) => {
    const laneY = box.y + li * laneH
    // 泳道带（装饰层：跨道线穿过它是设计意图，不该报冲突）
    elements.push({
      elementId: id(`lane_${lane.id}`), elementType: 'shape', kind: 'rect',
      bounds: [R(box.x), R(laneY), R(box.w), R(laneH)],
      fill: style.neutral, line: { color: style.ink, width: style.lineWidth },
      role: 'decoration', roleReason: '泳道带（装饰层；跨道连线穿过属设计意图）',
    })
    if (lane.label) {
      elements.push(makeText(style, id, { id: `laneT_${lane.id}`, x: box.x + 8, y: laneY + 4, w: Math.min(200, box.w - 16), text: String(lane.label) }))
    }
    // 车道分隔线（第 0 条画在带顶也可，这里只画内部边界）
    if (li > 0) {
      // 泳道分隔线是**结构线**（不是数据流）⇒ 声明为 decoration：跨道连线穿过泳道边界是标准画法（BPMN 同），
      // 声明后 line-crossing 等判据会跳过它（否则每次跨道连线都会被记成"交叉"）。
      const seps = makeEdge(style, id, { id: `sep_${lane.id}`, points: [[box.x, laneY], [box.x + box.w, laneY]], arrow: false })
      for (const sp of seps) { sp.role = 'decoration'; sp.roleReason = '泳道分隔线（结构线，非数据流）' }
      elements.push(...seps)
    }
    // 带内节点：列位置全局对齐（跨道连线才好走列间隙）
    lane.members.forEach((mid, ci) => {
      const n = nodes.find((x) => x.id === mid)
      const cx0 = box.x + headW + ci * (colW + gx) + (colW - nodeW) / 2
      const cy0 = laneY + (laneH - nodeH) / 2 + (lane.label ? 6 : 0)
      pos.set(mid, { x: cx0, y: cy0, w: nodeW, h: nodeH })
      elements.push(...makeNode(style, id, { id: mid, x: cx0, y: cy0, w: nodeW, h: nodeH, label: n?.label, emphasis: n?.emphasis }))
    })
  })
  const laneOf = new Map()
  lanes.forEach((l, li) => l.members.forEach((m) => laneOf.set(m, li)))
  // 连线：同道直连；跨道走列间隙竖直走廊（3 段折线）
  let ei = 0
  for (const e of d.edges ?? []) {
    const A = pos.get(e.from)
    const B = pos.get(e.to)
    if (!A || !B) continue
    const sameLane = laneOf.get(e.from) === laneOf.get(e.to)
    const yA = A.y + A.h / 2
    const yB = B.y + B.h / 2
    if (sameLane && Math.abs(yA - yB) < 1) {
      const forward = B.x >= A.x
      elements.push(...makeEdge(style, id, {
        id: `e${ei++}`, points: [[forward ? A.x + A.w : A.x, yA], [forward ? B.x : B.x + B.w, yB]],
        from: { ref: id(e.from), side: forward ? 'right' : 'left' }, to: { ref: id(e.to), side: forward ? 'left' : 'right' },
        dashed: e.style === 'dashed', label: e.label,
        labelBox: e.label ? { x: (A.x + A.w + B.x) / 2 - 40, y: yA - 18, w: 80 } : null,
      }))
    } else {
      // 跨道：**经典泳道路由** —— 源节点底/顶 → 两条车道之间的间隙横移 → 目标节点顶/底。
      // （第一版用"源右侧竖直走廊"，横向那一段会直接穿过整行节点盒，被判意外重叠 200×28px。）
      const liA = laneOf.get(e.from)
      const liB = laneOf.get(e.to)
      const down = liB > liA
      const sx = A.x + A.w / 2
      const tx = B.x + B.w / 2
      const y0 = down ? A.y + A.h : A.y
      const y1 = down ? B.y : B.y + B.h
      // 拐点放在**源车道内部**的空白里，而不是正压在水道分隔线上：
      // 分隔线是可见边框，重合会让人读成"线粘在一起"（用户实测反馈）。
      const sep = down ? box.y + (liA + 1) * laneH : box.y + liA * laneH
      const yMid = down ? sep - 12 : sep + 12
      elements.push(...makeEdge(style, id, {
        id: `e${ei++}`,
        points: [[sx, y0], [sx, yMid], [tx, yMid], [tx, y1]],
        from: { ref: id(e.from), side: down ? 'bottom' : 'top' }, to: { ref: id(e.to), side: down ? 'top' : 'bottom' },
        dashed: e.style === 'dashed', label: e.label,
        labelBox: e.label ? { x: (sx + tx) / 2 - 40, y: yMid - 18, w: 80 } : null,
      }))
    }
  }
  return { elements, groups: lanes.map((l) => ({ id: id(`grp_${l.id}`), ...(l.label ? { label: l.label } : {}), members: l.members.map(id) })), skipContainers: true, pos }
}

// ── 族 ⑤：compare（左右对比）────────────────────────────────────────────
/**
 * 结构：`groups[0]`/`groups[1]` = 两侧条目（多于两组的后续忽略并记 note）；未给 groups 时按 nodes 顺序对半切。
 * 几何：双列容器 + 中缝分隔线（轴对齐，AABB 宽为 0，不会触发重叠判定）。
 */
function layoutCompare({ d, box, style, id, notes }) {
  const elements = []
  const nodes = d.nodes ?? []
  let sides = (Array.isArray(d.groups) ? d.groups : []).map((g) => ({ id: g.id, label: g.label, members: (g.members ?? []).filter((m) => nodes.some((n) => n.id === m)) }))
  if (sides.length === 0) {
    const half = Math.ceil(nodes.length / 2)
    sides = [{ id: 'left', label: d.leftLabel ?? '方案 A', members: nodes.slice(0, half).map((n) => n.id) }, { id: 'right', label: d.rightLabel ?? '方案 B', members: nodes.slice(half).map((n) => n.id) }]
  }
  if (sides.length > 2) { notes.push(`compare：给了 ${sides.length} 组，只取前两组（其余忽略）`); sides = sides.slice(0, 2) }
  if (sides.length < 2) { notes.push('compare：需要两组（左右各一）⇒ 不产元素'); return { elements, groups: [] } }
  const titleH = 20
  const gap = style.gap * 1.6
  const colW = (box.w - gap) / 2
  const headH = 26 // 侧标题带（标题与容器上边框之间要留出可视间隙——用户反馈"文字压线框"）
  const bodyY = box.y + titleH + headH
  const bodyH = box.h - titleH - headH
  if (bodyH < 40) { notes.push('compare：扣除标题后高度不足 ⇒ 不产元素（请放大 bounds）'); return { elements, groups: [] } }
  const groups = []
  const pos = new Map()
  const containers = []
  sides.forEach((s, si) => {
    const x = box.x + si * (colW + gap)
    const items = s.members.length || 1
    const ih = (bodyH - style.gap * 0.6 * (items - 1)) / items
    s.members.forEach((mid, i) => {
      const n = nodes.find((x2) => x2.id === mid)
      const cell = { x, y: bodyY + i * (ih + style.gap * 0.6), w: colW, h: ih }
      pos.set(mid, cell)
      elements.push(...makeNode(style, id, { id: mid, ...cell, label: n?.label, emphasis: n?.emphasis }))
    })
    // 容器严格**落在画布内**（第一版向外扩 8px ⇒ out-of-safe-area 报错）
    const cb = { x, y: box.y + titleH, w: colW, h: box.h - titleH }
    const container = makeContainer(style, id, { gid: s.id, box: cb, members: s.members.map(id).concat(s.members.map((m) => id(`t_${m}`))), existing: containers, notes })
    if (container) {
      if (s.label) {
        const lid = id(`gl_${s.id}`)
        elements.unshift(makeText(style, id, { id: `gl_${s.id}`, x: cb.x + 10, y: cb.y + 8, w: Math.max(24, cb.w - 20), text: String(s.label), sizeFactor: 0.95 }))
        container.contains.push(lid)
      }
      containers.push(cb)
      elements.unshift(container)
    }
    groups.push({ id: id(`grp_${s.id}`), ...(s.label ? { label: s.label } : {}), members: s.members.map(id) })
  })
  if (d.title) elements.unshift(makeText(style, id, { id: 'cmp_title', x: box.x, y: box.y, w: box.w, text: String(d.title), sizeFactor: 1.05 }))
  // 本族自己产出容器 ⇒ 必须 skipContainers，否则派发器会按 d.groups 再造一遍（同 id 重复 + 外扩越界）
  return { elements, groups, pos, skipContainers: true }
}

// ── 族 ⑥：cycle（闭环反馈）─────────────────────────────────────────────
/**
 * 结构：`nodes` 顺序成环（`edges` 可显式指定）；无 `edges` 时按顺序相邻 + 收尾闭合。
 * 几何：环形排布；连线**走环外侧的折线**（节点外沿 → 角平分方向外扩 → 下一节点外沿），
 * 因此相邻连线互不相交（不像"弦"那样在环内交叉成蜘蛛网），箭头端仍精确落在节点边上（按射线求交后写 attach）。
 */
function layoutCycle({ d, box, style, id, notes }) {
  const elements = []
  const nodes = d.nodes ?? []
  const n = nodes.length
  if (n < 2) { notes.push('cycle：至少需要 2 个节点 ⇒ 不产元素'); return { elements, groups: [] } }
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const nodeH = 34
  const nodeW = Math.max(56, Math.min(150, (2 * Math.PI * Math.min(box.w, box.h) / 6) / n))
  const R = Math.min(box.w / 2 - nodeW / 2, box.h / 2 - nodeH / 2) - 22
  if (R < 30) { notes.push(`cycle：画布太小放不下 ${n} 个节点的环（R=${Math.round(R)}px）⇒ 不产元素`); return { elements, groups: [] } }
  const pt = (a, r) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  const rectOfCenter = (x, y) => ({ x: x - nodeW / 2, y: y - nodeH / 2, w: nodeW, h: nodeH })
  const pos = new Map()
  const angleOf = new Map()
  nodes.forEach((nd, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n
    const [x, y] = pt(a, R)
    pos.set(nd.id, rectOfCenter(x, y))
    angleOf.set(nd.id, a)
    elements.push(...makeNode(style, id, { id: nd.id, ...rectOfCenter(x, y), label: nd.label, emphasis: nd.emphasis }))
  })
  /** 从节点中心沿射线求与矩形边界的交点，并给出所在的边。 */
  const edgeHit = (rect, a) => {
    const ccx = rect.x + rect.w / 2
    const ccy = rect.y + rect.h / 2
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    const tx = dx === 0 ? Infinity : (dx > 0 ? (rect.x + rect.w - ccx) / dx : (rect.x - ccx) / dx)
    const ty = dy === 0 ? Infinity : (dy > 0 ? (rect.y + rect.h - ccy) / dy : (rect.y - ccy) / dy)
    const t = Math.min(Math.abs(tx), Math.abs(ty))
    const hx = ccx + dx * t
    const hy = ccy + dy * t
    let side = 'right'
    if (Math.abs(hx - rect.x) < 0.6) side = 'left'
    else if (Math.abs(hx - (rect.x + rect.w)) < 0.6) side = 'right'
    else if (Math.abs(hy - rect.y) < 0.6) side = 'top'
    else side = 'bottom'
    return { pt: [hx, hy], side }
  }
  const list = Array.isArray(d.edges) && d.edges.length ? d.edges : nodes.map((nd, i) => ({ from: nd.id, to: nodes[(i + 1) % n].id }))
  let ei = 0
  for (const e of list) {
    const A = pos.get(e.from)
    const B = pos.get(e.to)
    const aA = angleOf.get(e.from)
    const aB = angleOf.get(e.to)
    if (!A || !B || aA === undefined || aB === undefined) continue
    // 角平分方向（处理跨 0 的环绕）：取两角之间较短的一侧
    let d0 = aB - aA
    while (d0 > Math.PI) d0 -= 2 * Math.PI
    while (d0 < -Math.PI) d0 += 2 * Math.PI
    const aMid = aA + d0 / 2
    const outR = R + 20
    const outer = pt(aMid, outR)
    // 端点必须用**真实方向**（节点中心 → 拐点）与矩形边界求交。
    // 第一版用"角平分方向"近似 ⇒ 端点落到错误的那条边上 ⇒ 线段斜穿节点盒（门禁报 5 条意外重叠）。
    const dirFrom = (rect) => Math.atan2(outer[1] - (rect.y + rect.h / 2), outer[0] - (rect.x + rect.w / 2))
    const h1 = edgeHit(A, dirFrom(A))
    const h2 = edgeHit(B, dirFrom(B))
    elements.push(...makeEdge(style, id, {
      id: `e${ei++}`,
      points: [h1.pt, outer, h2.pt],
      from: { ref: id(e.from), side: h1.side }, to: { ref: id(e.to), side: h2.side },
      dashed: e.style === 'dashed', label: e.label,
      orthogonal: false, // cycle 的**外环弦**是"环/放射"语义，按设计豁免正交化（其余族一律正交）
      labelBox: e.label ? { x: outer[0] - 40, y: outer[1] - 8, w: 80 } : null,
    }))
  }
  if (d.title) elements.unshift(makeText(style, id, { id: 'cyc_title', x: box.x, y: box.y, w: box.w, text: String(d.title), sizeFactor: 1.05 }))
  return { elements, groups: [], pos }
}

// ── 族 ⑦：funnel（漏斗 / 金字塔）───────────────────────────────────────
/**
 * 结构：`nodes` 自上而下；宽度从 100% 线性收到 `minRatio`（默认 0.42）；`pyramid: true` 则反向（下宽上窄）。
 * 几何：每段是一个 **custGeom 梯形**，上下边宽首尾相接 ⇒ 段与段严丝合缝、相邻段边界相接（oy=0，不触发重叠判定）。
 * 标签放段内居中；段太矮（< 24px）时省略标签并记 note（不硬塞）。
 */
function layoutFunnel({ d, box, style, id, notes }) {
  const elements = []
  const nodes = d.nodes ?? []
  const n = nodes.length
  if (n === 0) return { elements, groups: [] }
  const minRatio = Math.max(0.15, Math.min(Number(d.minRatio ?? 0.42), 1))
  const titleH = d.title ? 22 : 0 // 标题必须占画布内一条（否则压在首段上）
  const bodyH = box.h - titleH
  const bandH = bodyH / n
  const widths = nodes.map((_, i) => {
    const t = n === 1 ? 0 : i / (n - 1)
    const w = box.w * (1 - t * (1 - minRatio))
    return d.pyramid ? box.w * (minRatio + (1 - minRatio) * t) : w
  })
  const pos = new Map()
  nodes.forEach((nd, i) => {
    const wTop = widths[i]
    const wBot = i + 1 < n ? widths[i + 1] : (d.pyramid ? widths[i] * (1 + (1 - minRatio) * 0.5) : widths[i] * minRatio)
    const y = box.y + titleH + i * bandH
    const x = box.x + (box.w - Math.max(wTop, wBot)) / 2
    const bw = Math.max(wTop, wBot)
    const labelId = id(`t_${nd.id}`)
    const el = {
      elementId: id(nd.id), elementType: 'shape', kind: 'custGeom',
      bounds: [R(x), R(y), R(bw), R(bandH)],
      fill: nd.emphasis === 'accent' ? (style.palette[1] ?? style.palette[0]) : style.palette[0],
      line: { color: style.ink, width: style.lineWidth },
      // 段内标签必须进 contains（否则"背景×内容"被判意外重叠——本轮实测 4 条）
      ...(bandH >= 24 && nd.label ? { contains: [labelId] } : {}),
      path: {
        w: Math.round(bw), h: Math.round(bandH),
        commands: [
          { cmd: 'moveTo', pts: [[Math.round((bw - wTop) / 2), 0]] },
          { cmd: 'lnTo', pts: [[Math.round((bw + wTop) / 2), 0]] },
          { cmd: 'lnTo', pts: [[Math.round((bw + wBot) / 2), Math.round(bandH)]] },
          { cmd: 'lnTo', pts: [[Math.round((bw - wBot) / 2), Math.round(bandH)]] },
          { cmd: 'close' },
        ],
      },
    }
    elements.push(el)
    pos.set(nd.id, { x, y, w: bw, h: bandH })
    if (bandH >= 24 && nd.label) {
      const fs = Math.max(10, Math.min(style.fontSize, Math.round(bandH * 0.5)))
      elements.push({
        elementId: labelId, elementType: 'text',
        bounds: [R(x), R(y + (bandH - fs * 1.3) / 2), R(bw), R(fs * 1.3)],
        content: { text: nd.label, fontSize: fs, color: '#FFFFFF', align: 'center', wrap: false },
      })
    } else if (nd.label) {
      notes.push(`funnel：段 "${nd.id}" 太矮（${Math.round(bandH)}px）⇒ 已省略标签（不硬塞压字）`)
    }
  })
  if (d.title) elements.unshift(makeText(style, id, { id: 'fn_title', x: box.x, y: box.y, w: box.w, text: String(d.title), sizeFactor: 1.05 }))
  return { elements, groups: [], pos }
}

// ── 族 ⑧：steps（步骤环）──────────────────────────────────────────────
/**
 * 结构：`nodes` 顺序 = 步骤顺序（≤10）。几何：圆环上均匀分布的**编号圆点 + 环外标签**；
 * 顺序由编号表达，不画连线（避免与闭环族视觉重复）。
 */
function layoutSteps({ d, box, style, id, notes }) {
  const elements = []
  const nodes = d.nodes ?? []
  const n = nodes.length
  if (n < 2) { notes.push('steps：至少需要 2 个步骤 ⇒ 不产元素'); return { elements, groups: [] } }
  if (n > 10) notes.push(`steps：${n} 个步骤偏多（环上标签会挤），建议 ≤10 或拆页`)
  const badge = Math.max(22, Math.min(40, box.h / (n * 1.6)))
  const Rr = Math.min(box.w / 2, box.h / 2) - 60
  if (Rr < 40) { notes.push('steps：画布太小放不下环（请放大 bounds）⇒ 不产元素'); return { elements, groups: [] } }
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const pos = new Map()
  const taken = [] // 已占位矩形（圆点 + 已放标签）：标签放不下就省略，绝不压字（content-collision 永不可声明）
  nodes.forEach((nd, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n
    const bx = cx + Rr * Math.cos(a) - badge / 2
    const by = cy + Rr * Math.sin(a) - badge / 2
    const numId = id(`n_${nd.id}`)
    elements.push({
      elementId: id(nd.id), elementType: 'shape', kind: 'ellipse',
      bounds: [R(bx), R(by), R(badge), R(badge)],
      fill: nd.emphasis === 'accent' ? (style.palette[1] ?? style.palette[0]) : style.palette[0],
      line: { color: style.ink, width: style.lineWidth },
      contains: [numId], // 编号文字必须声明在圆点内（否则"背景×内容"被判意外重叠）
    })
    const fs = Math.max(10, Math.round(badge * 0.45))
    elements.push({
      elementId: numId, elementType: 'text',
      bounds: [R(bx), R(by + badge / 2 - fs * 0.65), R(badge), R(fs * 1.3)],
      content: { text: String(i + 1), fontSize: fs, color: '#FFFFFF', align: 'center', wrap: false },
    })
    taken.push({ x: bx, y: by, w: badge, h: badge })
    pos.set(nd.id, { x: bx, y: by, w: badge, h: badge })
  })
  // 引导环：**一个 decoration 环形元素**（重叠判定对它天然豁免，语义也对："这是一圈步骤"）。
  // 几何按用户反馈定稿：**环穿过各编号圆心**（环直径 = 2×编号圆心半径），**只把线加粗**——
  //   · 第一版（穿过圆心、细线）用户觉得不错；
  //   · 第二版把环移到编号圈外面（"套一个大圈"）用户明确说不好看 ⇒ 回退到这个几何。
  // 编号 z-order 在环之后（盖住环的穿过点），点与点之间therefore能看见弧线。
  const ringR = Rr
  const ringW = Math.max(3, style.lineWidth + 2)
  elements.unshift({
    elementId: id('ring'), elementType: 'shape', kind: 'ellipse',
    bounds: [R(cx - ringR), R(cy - ringR), R(ringR * 2), R(ringR * 2)],
    fill: style.neutral, line: { color: style.ink, width: ringW },
    role: 'decoration', roleReason: '步骤环的引导环（装饰层：只表达"这是一圈步骤"，不参与内容重叠判定）',
  })
  // 第二轮：标签放在**统一固定半径**上（用户反馈"有的贼远有的很近"），且整体在环外一层 ⇒ 不会再被省略。
  nodes.forEach((nd, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n
    for (let k = 0; k < 1; k++) {
      // 标签框**紧贴文字**（宽度 = 实测文字宽 + 8），并让**框的内缘**离圆点边固定 12px。
      // 教训（用户两轮实测）：① 框不能以半径上的点为中心——90px 宽会向内探到圆点上（2/5 在水平方向最严重）⇒ 被省；
      // ② 框也别做太宽——文字在宽框里居中，视觉位置又被推到外面 ⇒ "离圆圈太远"。
      // 现在"距离"由常量 gap 决定：内缘 = 圆点边 + 12px，且框随文字收窄 ⇒ 远近一致、不再靠事后目检。
      // 注意：本文件没有模块级 measure()（那只是 wrapLabel 的参数）——用确定性字宽估算：
      // CJK 按等宽、拉丁按 0.55 倍。估偏大一点无害（框更宽松），估偏小会被压字检查抓出来。
      const txt = String(nd.label ?? '')
      const cjkN = (txt.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length
      const tw = Math.min(150, Math.max(24, Math.round(cjkN * style.fontSize + (txt.length - cjkN) * style.fontSize * 0.55) + 8))
      const th = 18
      const halfExtent = Math.abs(Math.cos(a)) * (tw / 2) + Math.abs(Math.sin(a)) * (th / 2)
      const innerR = Rr + badge / 2 + 12
      const cand = {
        x: Math.max(box.x, Math.min(cx + (innerR + halfExtent) * Math.cos(a) - tw / 2, box.x + box.w - tw)),
        y: Math.max(box.y, Math.min(cy + (innerR + halfExtent) * Math.sin(a) - th / 2, box.y + box.h - th)),
        w: tw, h: th,
      }
      const clash = taken.some((r) => cand.x < r.x + r.w && r.x < cand.x + cand.w && cand.y < r.y + r.h && r.y < cand.y + cand.h)
      if (clash) { notes.push(`steps：步骤 "${nd.id}" 的标签与其它文字冲突 ⇒ 已省略（压字是内容互压，永不可声明）`); return }
      elements.push(makeText(style, id, { id: `t_${nd.id}`, x: cand.x, y: cand.y, w: cand.w, text: nd.label ?? '', align: 'center' }))
      taken.push(cand)
      return
    }
    notes.push(`steps：步骤 "${nd.id}" 的标签与其它文字冲突 ⇒ 已省略（压字是内容互压，永不可声明）`)
  })
  if (d.title) elements.unshift(makeText(style, id, { id: 'st_title', x: cx - box.w / 2 + 8, y: cy - 14, w: 200, text: String(d.title), sizeFactor: 1.05 }))
  return { elements, groups: [], pos }
}

// ── 族 ⑨：sequence（时序图）───────────────────────────────────────────
/**
 * 结构：`nodes` = 参与者（顺序 = 横向顺序）；`edges` = 消息（声明顺序 = 自上而下的时间顺序）。
 * 几何：顶部参与者盒 → **生命线**（用 2px 宽的窄矩形而不是 line：这样消息端点能落"在盒子的边上"、
 * 也满足 attach 的四边语义，同时避免"箭头脱靶"警告）；消息为水平箭头 + 上方标签；标签落在生命线之间。
 */
function layoutSequence({ d, box, style, id, notes }) {
  const elements = []
  const nodes = d.nodes ?? []
  const msgs = d.edges ?? []
  const n = nodes.length
  if (n === 0) return { elements, groups: [] }
  const headH = 34
  const titleH = d.title ? 20 : 0 // 标题占画布内一条（放画布外会掉出安全区）
  const laneGap = style.gap
  const laneW = (box.w - laneGap * (n - 1)) / n
  const headW = Math.max(56, Math.min(laneW, 180))
  const lifelineW = 2
  const pos = new Map()
  const laneX = new Map()
  nodes.forEach((nd, i) => {
    const lx = box.x + i * (laneW + laneGap) + (laneW - headW) / 2
    elements.push(...makeNode(style, id, { id: nd.id, x: lx, y: box.y + titleH, w: headW, h: headH, label: nd.label, emphasis: nd.emphasis }))
    const cx = lx + headW / 2
    laneX.set(nd.id, cx)
    const top = box.y + titleH + headH
    const h = Math.max(20, box.h - titleH - headH - 8)
    elements.push({
      elementId: id(`ll_${nd.id}`), elementType: 'shape', kind: 'rect',
      bounds: [R(cx - lifelineW / 2), R(top), R(lifelineW), R(h)],
      fill: style.ink, line: { color: style.ink, width: 0.5 }, role: 'decoration', roleReason: '时序图生命线（装饰层）',
    })
    pos.set(nd.id, { x: lx, y: box.y, w: headW, h: headH })
  })
  const top0 = box.y + titleH + headH + 22
  const usable = Math.max(20, box.h - titleH - headH - 40)
  const step = msgs.length ? usable / (msgs.length + 1) : 0
  let mi = 0
  for (const m of msgs) {
    const xa = laneX.get(m.from)
    const xb = laneX.get(m.to)
    if (xa === undefined || xb === undefined) { notes.push(`sequence：消息 ${m.from}→${m.to} 的参与者不存在 ⇒ 已跳过`); continue }
    const y = top0 + step * (mi + 1) - step / 2
    const forward = xb >= xa
    const sA = forward ? 'right' : 'left'
    const sB = forward ? 'left' : 'right'
    const lifelineH = Math.max(20, box.h - headH - 8)
    // 端点落在生命线窄盒的左右边上（生命线是 2px 宽的 shape ⇒ attach 四边语义成立）
    const ptA = [forward ? xa + lifelineW / 2 : xa - lifelineW / 2, y]
    const ptB = [forward ? xb - lifelineW / 2 : xb + lifelineW / 2, y]
    elements.push(...makeEdge(style, id, {
      id: `m${mi}`, points: [ptA, ptB],
      from: { ref: id(`ll_${m.from}`), side: sA }, to: { ref: id(`ll_${m.to}`), side: sB },
      dashed: m.style === 'dashed', arrow: true, label: m.label,
      labelBox: m.label ? { x: (ptA[0] + ptB[0]) / 2 - 50, y: y - 18, w: 100 } : null,
    }))
    void lifelineH
    mi++
  }
  if (msgs.length === 0) notes.push('sequence：没有消息（edges 为空）⇒ 只画了参与者与生命线')
  if (d.title) elements.unshift(makeText(style, id, { id: 'sq_title', x: box.x, y: box.y, w: box.w, text: String(d.title), sizeFactor: 1.05 }))
  return { elements, groups: [], pos }
}

// ── 族 ⑩：state（状态机）──────────────────────────────────────────────
/**
 * 结构：`nodes` = 状态；`edges` = 转移（`label` = 触发条件）。
 * 分层：从"无入边的状态"出发做**最长路径分层**（有环时按 BFS 迭代上限收敛）；
 * 几何：层→列、层内→纵向堆叠；**所有转移统一走节点下方的"转移总线"**（每条一条独立 y 偏移的横线）——
 *   于是**回边不做特例**（环天然支持），且总线是轴对齐横线（AABB 高 0）⇒ 相互不判重叠；
 *   两端竖段从节点**底边**下行/上行，端点精确落在底边上（attach 合法）。
 */
function layoutState({ d, box, style, id, notes }) {
  // 阶段 E / Y2-3：读风格特型（不传 style.traits 时等于现状 ⇒ 默认逐像素不变）
  const T = style.traits ?? DEFAULT_TRAITS
  const D = DENSITY[T.density] ?? DENSITY.normal
  let badgeSeq = 0 // badge:number 的序号（按插入顺序，即分层顺序）
  // ── 顶部预留带（特型 frame.title）──────────────────────────────────────
  // 族**不负责画标题**（标题元素由外层产出），但必须把"标题带"当作禁区：
  // 节点整体下移、上方绕行车道的起点被挡在带下 ⇒"标题与回边车道/标签打架"由**机制**避免
  //（此前只能靠"这一页不写标题"绕过 —— 那是回避，不是解决）。
  // 注意：trait 关闭时 bandBottom = box.y、bandH = 0 ⇒ 与既有输出**逐像素一致**。
  const bandH = T.frame.title ? 34 : 0
  const bandBottom = box.y + bandH
  if (Array.isArray(notes) && JSON.stringify(T) !== JSON.stringify(DEFAULT_TRAITS)) {
    notes.push('state：风格特型生效 —— ' + traitSummary(T))
    if (T.frame.title) notes.push('state：顶部预留带 ' + bandH + 'px 已设为路由禁区（frame.title）')
  }
  const elements = []
  const nodes = d.nodes ?? []
  const edges = d.edges ?? []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outs = new Map()
  const ins = new Map()
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    if (!outs.has(e.from)) outs.set(e.from, [])
    outs.get(e.from).push(e.to)
    if (!ins.has(e.to)) ins.set(e.to, [])
    ins.get(e.to).push(e.from)
  }
  const roots = nodes.filter((n) => !ins.has(n.id)).map((n) => n.id)
  // 用 **BFS 最短分层**而不是"最长路径"：状态机几乎总有环/回边，最长路径会被环无限推高
  //（第一版加迭代上限后仍涨到 7 层 ⇒ 列宽被压到最小、节点互相重叠、标签越界）。
  // BFS 首次到达即最短层：有界、确定、且回边天然落在"低层 → 高层"的常识语义上。
  const layer = new Map()
  const seeds = roots.length ? roots : nodes.map((n) => n.id)
  for (const seed of seeds) {
    if (layer.has(seed)) continue
    layer.set(seed, 0)
    const q = [seed]
    while (q.length) {
      const cur = q.shift()
      for (const nx of outs.get(cur) ?? []) {
        if (layer.has(nx)) continue
        layer.set(nx, layer.get(cur) + 1)
        q.push(nx)
      }
    }
  }
  for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, 0)
  const maxLayer = Math.max(0, ...[...layer.values()])
  const byLayer = new Map()
  for (const n of nodes) {
    const l = layer.get(n.id)
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l).push(n.id)
  }
  // 列间距按"是否有边标签"预留：**要能放下一个标签**（实测 96px 时，入口横段只有 ~57px 长，
  // 标签放不下 ⇒ 回退到"竖管中段"⇒ 标签落在两条横线中间，用户读作"离线太远、太高"）。
  // 密度特型：只改间距常量（宪法②之"常量"通道）；normal 时乘数为 1 ⇒ 与既有输出逐像素一致
  const gap = (edges.some((e) => e.label) ? Math.max(style.gap, 150) : style.gap) * D.laneStep
  const colW = (box.w - gap * maxLayer) / (maxLayer + 1)
  const nodeW = Math.max(56, Math.min(colW * 0.8, 180))
  const rowMax = Math.max(...[...byLayer.values()].map((v) => v.length), 1)
  const areaH = (box.h - bandH) * 0.62 // 节点区只占 62%（并让出顶部预留带），下方 38% 留给"转移总线"
  const nodeH = Math.max(26, Math.min(areaH / rowMax - 8, 54))
  const pos = new Map()
  for (const [l, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    const colH = ids.length * (nodeH + gap * 0.5) - gap * 0.5
    const y0 = bandBottom + Math.max(0, (areaH - colH) / 2)
    ids.forEach((nid, i) => {
      const r = { x: box.x + l * (colW + gap) + (colW - nodeW) / 2, y: y0 + i * (nodeH + gap * 0.5), w: nodeW, h: nodeH }
      pos.set(nid, r)
      const nd = byId.get(nid)
      const nodeEls = makeNode(style, id, { id: nid, ...r, label: nd?.label, emphasis: nd?.emphasis })
      // ── 风格特型：只动"绘制"与"文本槽位"，**不动卡片位置与端口**（宪法①）──────────
      // ① 卡片形态：直接改 kind（不改几何；kind 由引擎按真实轮廓处理锚点）
      if (T.card.shape !== 'roundRect') for (const el of nodeEls) if (el.elementType === 'shape') el.kind = T.card.shape
      // ② 状态名槽位：inside（卡内，默认）| below（卡下）——卡内文字移出后必须**摘掉 contains**，
      //    并把颜色从白改成正文墨色（卡片外的白字不可见），高度按字号算。
      if (T.label === 'below' && nodeEls[1] && nodeEls[1].elementType === 'text') {
        const txt = nodeEls[1]
        const fs2 = txt.content.fontSize
        txt.bounds = [r.x, r.y + r.h + 4, r.w, Math.max(12, fs2 * 1.45)]
        txt.content = { ...txt.content, color: style.ink, align: 'center' }
        nodeEls[0].contains = []
      }
      // ③ 序号圆徽（badge:number）：卡内左侧预留栏（圆 + 数字），并让标题文本让出栏位。
      //    只改"绘制 + 文本槽位"，卡片位置与端口一律不动（宪法①）。
      if (T.badge === 'number') {
        badgeSeq += 1
        const dia = Math.min(15, Math.max(10, r.h * 0.34))
        const bx = r.x + 5
        const by = r.y + (r.h - dia) / 2
        nodeEls.push({
          elementId: id(`bd_${nid}`), elementType: 'shape', kind: 'ellipse',
          bounds: [bx, by, dia, dia], fill: style.palette[1] ?? style.palette[0], line: { color: style.ink, width: style.lineWidth },
        })
        nodeEls.push({
          elementId: id(`bt_${nid}`), elementType: 'text',
          bounds: [bx, by + dia * 0.12, dia, dia * 0.8],
          content: { text: String(badgeSeq), fontSize: Math.max(8, dia * 0.58), color: '#FFFFFF', align: 'center' },
        })
        // 卡内标题左让栏位（卡下标签不受影响）
        if (T.label !== 'below' && nodeEls[1] && Array.isArray(nodeEls[1].bounds)) {
          const tb = nodeEls[1].bounds
          const shift = dia + 9
          nodeEls[1].bounds = [tb[0] + shift, tb[1], Math.max(20, tb[2] - shift), tb[3]]
        }
      }
      elements.push(...nodeEls)
    })
  }
  // ── 边标签：**两遍放置**（第一遍只放线，第二遍统一放标签）────────────────
  // 用户实测的教训链：
  //  ① 只给直连路径加避让 ⇒ 总线标签撞上直连标签（content-collision）；
  //  ② 候选只给"离首选 ≤30px" ⇒ 没位置就省略 ⇒ 丢信息（付款/超时被吞）；
  //  ③ 候选推得远（+104px）⇒ 标签脱离自己那条边（超时跑到总线附近）；
  //  ④ 用整条折线的 AABB 当禁区太粗 ⇒ 合法位置被误判；
  //  ⑤ **逐边"边放线边放标签"有顺序依赖**：后放的线还不在 elements 里 ⇒ "离自己最近"看不见它，
  //     实测出现「超时」坐到「退货」总线上、两条标签互换 ⇒ 标签必须**等所有线放完**再放（两遍）。
  const ov = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  const thin = (p, q, t = 4) => ({
    x: Math.min(p[0], q[0]) - t, y: Math.min(p[1], q[1]) - t,
    w: Math.abs(q[0] - p[0]) + 2 * t, h: Math.abs(q[1] - p[1]) + 2 * t,
  })
  const hitPts = (c, pts) => {
    for (let i = 0; i + 1 < pts.length; i++) if (ov(c, thin(pts[i], pts[i + 1]))) return true
    return false
  }
  const boxOfEl = (el) => {
    const b = el.bounds
    if (Array.isArray(b)) return { x: b[0], y: b[1], w: b[2], h: b[3] }
    if (b && typeof b === 'object') return b
    return null
  }
  const segDist = (c, p, q) => {
    const dx = Math.max(p[0], q[0]) < c.x ? c.x - Math.max(p[0], q[0]) : (Math.min(p[0], q[0]) > c.x + c.w ? Math.min(p[0], q[0]) - (c.x + c.w) : 0)
    const dy = Math.max(p[1], q[1]) < c.y ? c.y - Math.max(p[1], q[1]) : (Math.min(p[1], q[1]) > c.y + c.h ? Math.min(p[1], q[1]) - (c.y + c.h) : 0)
    return Math.max(dx, dy)
  }
  const ptsDist = (c, pts) => Math.min(...pts.slice(0, -1).map((p, i) => segDist(c, p, pts[i + 1])))
  /** 沿线滑动找标签位：从**箭头端往回**扫；夹在画布内；不压线不压字；且**离自己的线最近**；全不行返回 null。 */
  const placeEdgeLabel = (ownPts, w = 84, h = 18, preferSeg = -1) => {
    const seeds = []
    // 段顺序：默认从**箭头端往回**扫；若指定 preferSeg（走总线的回边 = 那条长横线 = 视觉主体），
    // 先贴那一段。用户实测：退货标签挂在入口附近，离最下面那条长线近百像素。
    const order = []
    if (preferSeg >= 0 && preferSeg < ownPts.length - 1) order.push(preferSeg)
    for (let i = ownPts.length - 2; i >= 0; i--) if (i !== preferSeg) order.push(i)
    for (const i of order) {
      const p = ownPts[i]; const q = ownPts[i + 1]
      const mx = (p[0] + q[0]) / 2; const my = (p[1] + q[1]) / 2
      if (Math.abs(q[1] - p[1]) < 1) {
        // 横段：**贴着线**放（上下各 6px 视觉间隙）。
        // 教训：原来取 w=100、间隙 26px ⇒ 100px 宽放不进 96px 的列间距 ⇒ 横段候选全被否
        // ⇒ 回退到"竖管中段"候选，标签落到两条横线**中间**，用户读作"离线太远/太高"。
        seeds.push({ x: Math.round(mx - w / 2), y: Math.round(my - h - 6), w, h })
        seeds.push({ x: Math.round(mx - w / 2), y: Math.round(my + 6), w, h })
      } else {
        seeds.push({ x: Math.round(mx + 8), y: Math.round(my - h / 2), w, h })
        seeds.push({ x: Math.round(mx - w - 8), y: Math.round(my - h / 2), w, h })
      }
    }
    const tries = []
    for (const s of seeds) {
      tries.push({ ...s, base: true })
      for (const t of [{ ...s, y: s.y - 26 }, { ...s, y: s.y + 26 }, { ...s, x: s.x + 30 }, { ...s, x: s.x - 30 }]) tries.push({ ...t, base: false })
    }
    const accepted = []
    for (let i = 0; i < tries.length; i++) {
      const c = tries[i]
      const cc = {
        ...c,
        x: Math.min(Math.max(c.x, box.x), Math.max(box.x, box.x + box.w - c.w)),
        y: Math.min(Math.max(c.y, box.y), Math.max(box.y, box.y + box.h - c.h)),
      }
      if (hitPts(cc, ownPts)) continue
      if (elements.some((el) => {
        if (Array.isArray(el.points) && el.points.length) return hitPts(cc, el.points)
        const b = boxOfEl(el)
        return b ? ov(cc, b) : false
      })) continue
      const dOwn = ptsDist(cc, ownPts)
      const others = elements.filter((el) => Array.isArray(el.points) && el.points.length).map((el) => ptsDist(cc, el.points))
      const clearance = others.length ? Math.min(...others) : 1e9
      if (others.length && dOwn > clearance) continue
      accepted.push({ c: cc, i, clearance, base: tries[i].base === true })
    }
    if (!accepted.length) return null
    // **哪一侧更空就放哪一侧**：只在**同一条线段的"线上方/线下方"基础候选**之间比较——
    // 教训：把"再上移 26px"这类变体也纳入比较 ⇒ 它们天然离别的线更远 ⇒ 四个标签整体上漂 26px（又变成"太高"）。
    const bases = accepted.filter((a) => a.base)
    const pool = bases.length ? bases : accepted
    let pick = pool[0]
    for (const a of pool) if (a.clearance > pick.clearance + 10) pick = a
    return pick.c
  }
  const edgeRoutes = [] // 第一遍只放线并把路由记下来；标签统一在**第二遍**放
  const maxBottom = Math.max(...[...pos.values()].map((r) => r.y + r.h))
  // ── B1/B2：**逐边走廊 + 占用惩罚**（替代"同层共用一根竖管 + 全局总线"）─────────────
  // 病因（用户实测）：所有回边共用同一个 `bus` y、同一层的边共用同一个走廊 x ⇒ 线与线重合、
  // T 型分叉、相互交叉。现在每条边自己选走廊坐标与车道，**优先选没人用过的**（占用 ×100 惩罚），
  // 理想位置两侧按 6px/20px 试探 —— 这是"走廊占用惩罚"的可用版（不做跳线小圆弧，按 D3 决定）。
  const laneBase = maxBottom + 16
  const labeled = edges.some((e) => e.label)
  const busStep = labeled ? 20 : 8 // 有标签时留出标签高度，避免边标签互相压字（content-collision 不可声明）
  const usedLane = new Map()
  const routedSegs = [] // 已定路由的线段（供 B1 的"交叉数"打分）
  const pickLane = () => {
    for (let k = 0; k < 8; k++) {
      const y = laneBase + k * busStep
      if (!usedLane.get(y)) { usedLane.set(y, 1); return y }
    }
    return laneBase + 8 * busStep
  }
  let ei = 0
  for (const e of edges) {
    const A = pos.get(e.from)
    const B = pos.get(e.to)
    if (!A || !B) { notes.push(`state：转移 ${e.from}→${e.to} 的端点状态不存在 ⇒ 已跳过`); continue }
    if (laneBase + busStep * 8 + 6 > box.y + box.h) { notes.push(`state：转移车道放不下（画布高度不足）⇒ 转移 ${e.from}→${e.to} 已省略；建议放大 bounds 或减少状态`); continue }
    const ax = A.x + A.w / 2
    const bx = B.x + B.w / 2
    void ax; void bx
    // 路由：**列间走廊 + 侧边进出**（第一版"从底边直接下行"会被同列下方节点挡住 ⇒ 竖段穿盒 81×54px）
    const g4 = gap / 4
    const sideOf = (r, l) => (l < maxLayer ? 'right' : 'left') // 有右邻列就走右侧走廊，否则走左侧
    const corOf = (r, l) => (sideOf(r, l) === 'right' ? r.x + r.w + g4 : r.x - g4)
    const lA = layer.get(e.from) ?? 0
    const lB = layer.get(e.to) ?? 0
    const same = lA === lB
    // **同列相邻层直连**：短、少拐、不占用总线 ⇒ 总线只服务"回边 / 同层边 / 带标签的跨层边"。
    // 用户反馈"线条杂乱、大量重叠"——第一版把**所有**转移都塞进总线，视觉代价我当初没算够。
    // 带标签的跨层边仍走总线：标签需要一条横条的落点，走直连会压到邻居列。
    // 相邻层**一律直连**（含带标签的边）：布局已为标签预留列间距 ⇒ 不再需要"绕总线换空间"。
    // 第一版把带标签的相邻层边也塞进总线，于是出现细长空回环（用户实测附图 2）。
    if (lB === lA + 1) {
      const midX = A.x + A.w + Math.max(6, gap / 2) // 相邻层直连：共用理想走廊（判据是"不共线重叠"，不是"不共用"）
      const lcy = Math.round((A.y + A.h / 2 + B.y + B.h / 2) / 2)
      // 首选：竖管右侧、**线之上 28px**（天然不压自己的线）；再交给避让挑不撞的备选
      const _pts = [[R(A.x + A.w), R(A.y + A.h / 2)], [R(midX), R(A.y + A.h / 2)], [R(midX), R(B.y + B.h / 2)], [R(B.x), R(B.y + B.h / 2)]]
      for (let i = 0; i + 1 < _pts.length; i++) routedSegs.push([_pts[i], _pts[i + 1]]) // 登记给后续回边做交叉打分
      edgeRoutes.push({ e, pts: _pts })
      elements.push(...makeEdge(style, id, {
        id: `e${ei++}`,
        points: _pts,
        from: { ref: id(e.from), side: 'right' }, to: { ref: id(e.to), side: 'left' },
        dashed: e.style === 'dashed',
      }))
      continue
    }
    // 同层边（如"取消/退款"这类同一列上的转移）：两端都走**同一侧**外侧走廊，
    // 走廊在节点列的左右空白里，构造上必然自由（第一版走"目标左侧"时会切回列内，撞到上方节点）。
    const sideB = same ? sideOf(A, lA) : (lB > 0 ? 'left' : 'right')
    const corB = sideB === 'left' ? B.x - g4 : B.x + B.w + g4
    const ptB = sideB === 'left' ? [B.x, B.y + B.h / 2] : [B.x + B.w, B.y + B.h / 2]
    const ptA = sideOf(A, lA) === 'right' ? [A.x + A.w, A.y + A.h / 2] : [A.x, A.y + A.h / 2]
    // **同层共用竖管**（树状干线）：这是标准画法——只要两条边**不共线重叠**（一条往上、一条往下，
    // 只在出口共用一个点），读者就不会误读方向。第一版"逐边走廊偏移"是**过度纠正**（用户裁定）。
    // 真正的缺陷是"共线重叠"与"线压在盒子边框上"，那两条已由 line-rules 的机械检查兜住。
    const riserA = corOf(A, lA)
    // ── B1：逐边避障最短正交路由 ──────────────────────────────────────────
    // 候选 = 若干"盒子外走廊"上的折线（由浅到深的车道 + 上方回绕）；先剔除**穿过节点盒**的候选，
    // 再按 (与他线的交叉数, 总长度, 拐点数) 择优。判据是**优化绕行与交叉**，**不是**拆共用干线
    //（共用竖管是标准树状画法，用户已裁定；见 line-rules 的"共用端点扇出豁免"）。
    const mkSide = (y) => [ptA, [riserA, A.y + A.h / 2], [riserA, y], [corB, y], [corB, B.y + B.h / 2], ptB]
    // 用户给的参考画法：从**源框底边靠右**出 → 走下方 → **目标框底边中点竖直向上**进（箭头朝上）。
    // 侧向走法的进出点落在左右边中点，容易与主干/入场边共点而读不出方向 ⇒ 上下走法作为另一类候选。
    const mkTB = (y) => {
      const below = y >= Math.max(A.y + A.h, B.y + B.h) + g4 - 0.01
      const ax = A.x + A.w * 0.75
      const bx = B.x + B.w * 0.5
      const aEdge = below ? A.y + A.h : A.y
      const bEdge = below ? B.y + B.h : B.y
      const aStub = below ? aEdge + g4 : aEdge - g4
      const bStub = below ? bEdge + g4 : bEdge - g4
      return [[ax, aEdge], [ax, aStub], [ax, y], [bx, y], [bx, bStub], [bx, bEdge]]
    }
    // **外侧走廊候选**：回边若要纵穿整排/多排，竖段落在所有节点之右（或之左）就不会穿过其他边的横向车道
    //（实测：密集状态机里"退货"的竖段从上层右侧下行，穿过了"退款"的横线 ⇒ 真交叉）。
    const mkTBOuter = (y, side) => {
      const below = y >= Math.max(A.y + A.h, B.y + B.h) + g4 - 0.01
      const all = [...pos.values()]
      const maxRight = Math.max(...all.map((r) => r.x + r.w))
      const minLeft = Math.min(...all.map((r) => r.x))
      const axIn = side === 'right' ? A.x + A.w * 0.75 : A.x + A.w * 0.25
      const aEdge = below ? A.y + A.h : A.y
      const aOut = below ? aEdge + g4 : aEdge - g4
      const axOut = side === 'right' ? maxRight + g4 + 8 : minLeft - g4 - 8
      const bx = B.x + B.w * 0.5
      const bEdge = below ? B.y + B.h : B.y
      const bStub = below ? bEdge + g4 : bEdge - g4
      return [[axIn, aEdge], [axIn, aOut], [axOut, aOut], [axOut, y], [bx, y], [bx, bStub], [bx, bEdge]]
    }
    const segHitsNode = (p, q) => {
      const x0 = Math.min(p[0], q[0]); const x1 = Math.max(p[0], q[0])
      const y0 = Math.min(p[1], q[1]); const y1 = Math.max(p[1], q[1])
      for (const r of pos.values()) if (x1 > r.x + 1 && r.x + r.w > x0 + 1 && y1 > r.y + 1 && r.y + r.h > y0 + 1) return true
      return false
    }
    const segCrosses = (p, q, a, b) => { // 正交段的"真交叉"（内部相交，端点相接不算）
      const ph = Math.abs(p[1] - q[1]) < 0.5
      const sh = Math.abs(a[1] - b[1]) < 0.5
      if (ph === sh) return false
      const h = ph ? [p, q] : [a, b]
      const v = ph ? [a, b] : [p, q]
      const hx0 = Math.min(h[0][0], h[1][0]); const hx1 = Math.max(h[0][0], h[1][0])
      const vy0 = Math.min(v[0][1], v[1][1]); const vy1 = Math.max(v[0][1], v[1][1])
      return v[0][0] > hx0 + 1 && v[0][0] < hx1 - 1 && h[0][1] > vy0 + 1 && h[0][1] < vy1 - 1
    }
    // R9 罚项：本线路端点与**已定路由的端点**重合、且相邻段与之共线反向 ⇒ 读者会把两条边读成一条直线贯穿节点
    //（用户实测的真缺陷：返工边从"已成样"左边出发，而"烘焙毕"的箭头正落在同一点）。
    // 用户裁定：中点进出、合并后分叉、共线不重叠都是标准画法 ⇒ 只有"同点 + 共线反向"才罚。
    const dirAt = (a, b) => { const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d] }
    const samePointPenalty = (pts) => {
      const head = pts[0]
      const tail = pts[pts.length - 1]
      const hd = dirAt(head, pts[1])
      const td = dirAt(pts[pts.length - 2], tail)
      const opp = (x, y) => Math.abs(x[0] + y[0]) < 0.01 && Math.abs(x[1] + y[1]) < 0.01
      let pen = 0
      for (const e of edgeRoutes) {
        const o = e.pts
        if (Math.hypot(head[0] - o[o.length - 1][0], head[1] - o[o.length - 1][1]) < 2 && opp(hd, dirAt(o[o.length - 2], o[o.length - 1]))) pen++
        if (Math.hypot(tail[0] - o[0][0], tail[1] - o[0][1]) < 2 && opp(td, dirAt(o[0], o[1]))) pen++
      }
      return pen
    }
    const scoreRoute = (pts) => {
      let cross = 0; let len = 0
      for (let i = 0; i + 1 < pts.length; i++) {
        len += Math.abs(pts[i + 1][0] - pts[i][0]) + Math.abs(pts[i + 1][1] - pts[i][1])
        for (const s of routedSegs) if (segCrosses(pts[i], pts[i + 1], s[0], s[1])) cross++
      }
      return cross * 1000 + samePointPenalty(pts) * 500 + Math.round(len) + (pts.length - 2) * 10
    }
    // 参考画法要求"返回段离框底足够远"（竖线长度 ≳ 框高一半）⇒ 车道从框底再下移一档起步。
    const deepBase = Math.max(A.y + A.h, B.y + B.h) + Math.max(36, Math.min(A.h, B.h) * 0.35)
    // **上方车道**：当长回边的"竖段+横段"在下方构成 L 形屏障（实测密集状态机：退货的竖段 + 它的横段
    // 把下排的 s4 与 s5 隔开），从下方绕必定穿过；从**图形上方**绕才不交叉。
    const minTopY = Math.min(...[...pos.values()].map((r) => r.y))
    const lane1 = pickLane()
    const raw = [
      // **深车道优先**（用户参考画法：返回段必须与框体视觉分离，竖线要够长）——
      // 平局时保留先入者，所以把 deepBase 放最前；lane1（贴框底）只作最后兜底。
      mkTB(deepBase), mkSide(deepBase),
      mkTB(deepBase + busStep), mkSide(deepBase + busStep),
      mkTB(deepBase + 2 * busStep), mkSide(deepBase + 2 * busStep),
      mkTB(deepBase + 3 * busStep), mkSide(deepBase + 3 * busStep),
      // 上方车道：只作兜底（放在最后，不影响已有"平局先入"的画法）
      // 上方车道**只用 mkTB 变体**：mkSide 的形状是为"下车道"设计的，套到上方车道会先后退再折返（生成尖刺，实测）
      mkTB(T.frame.title ? Math.max(minTopY - 18, bandBottom + 6) : minTopY - 18),
      mkTB(T.frame.title ? Math.max(minTopY - 38, bandBottom + 8) : minTopY - 38),
      mkTB(lane1), mkSide(lane1),
    ]
    // 打分必须针对**后处理后的几何**（makeEdge = 轴对齐 → 箭头端直段 → 轴对齐，后处理会挪拐点）。
    // 后处理（与 makeEdge 同管线）之后**去除"折返尖刺"**：连续三点共线且中间点折返（越过车道又折回）
    // ⇒ 删掉中间点。用户实测图 10 上"多戳出来一根线"就是这个尖刺（91.1→53.6→73.1）。
    const post = (pts) => {
      const o = orthogonalize(arrowEndRuns(orthogonalize(pts), true))
      const res = []
      for (const q of o) {
        if (res.length >= 2) {
          const a1 = res[res.length - 2]; const b1 = res[res.length - 1]
          const sameX = Math.abs(a1[0] - b1[0]) < 0.5 && Math.abs(b1[0] - q[0]) < 0.5
          const sameY = Math.abs(a1[1] - b1[1]) < 0.5 && Math.abs(b1[1] - q[1]) < 0.5
          if ((sameX && (b1[1] - a1[1]) * (q[1] - b1[1]) < 0) || (sameY && (b1[0] - a1[0]) * (q[0] - b1[0]) < 0)) { res.pop(); continue }
        }
        res.push(q)
      }
      // 少于 3 点的路线会让下游 busPts[2] 取不到（实测崩在 layoutState:1141）⇒ 返回原路线。
      return res.length >= 3 ? res : o
    }
    const baseCands = raw.map(post)
    // 先看基础候选能否做到"不撞盒且不交叉"：能则**完全不动**（保住已认可的观感）；
    // 不能（密集多回边）才把外侧走廊候选纳入进来一起择优。
    const baseHits = (pts) => pts.reduce((n, q, i) => (i + 1 < pts.length && segHitsNode(q, pts[i + 1]) ? n + 1 : n), 0)
    const baseCross = (pts) => {
      let c = 0
      for (let i = 0; i + 1 < pts.length; i++) for (const sg of routedSegs) if (segCrosses(pts[i], pts[i + 1], sg[0], sg[1])) c++
      return c
    }
    const baseOk = baseCands.some((pts) => baseHits(pts) === 0 && baseCross(pts) === 0)
    const outer = baseOk ? [] : [
      mkTBOuter(deepBase, 'right'), mkTBOuter(deepBase + busStep, 'right'),
      mkTBOuter(deepBase, 'left'), mkTBOuter(deepBase + busStep, 'left'),
    ].map(post)
    const cands = [...baseCands, ...outer]
    // 候选全"脏"（所有车道都会穿过某个盒子）时，**取撞盒最少的那条**，而不是直接拿第一条
    // ——从零重画的状态机（多条同层回边）实测过：盲目取第一条会把线画到节点上（56×27px 重叠）。
    const hitsOf = (pts) => pts.reduce((n, p, i) => (i + 1 < pts.length && segHitsNode(p, pts[i + 1]) ? n + 1 : n), 0)
    const crossOf = (pts) => {
      let c = 0
      for (let i = 0; i + 1 < pts.length; i++) for (const sg of routedSegs) if (segCrosses(pts[i], pts[i + 1], sg[0], sg[1])) c++
      return c
    }
    const perfect = cands.filter((pts) => hitsOf(pts) === 0 && crossOf(pts) === 0)
    const clean = cands.filter((pts) => hitsOf(pts) === 0)
    const pool = perfect.length ? perfect : (clean.length ? clean : cands.slice().sort((a, b) => hitsOf(a) - hitsOf(b)))
    let busPts = pool[0]; let bestScore = scoreRoute(busPts)
    for (const c of pool) { const sc = scoreRoute(c); if (sc < bestScore) { bestScore = sc; busPts = c } }
    const tbRoute = Math.abs(busPts[0][0] - (A.x + A.w * 0.75)) < 0.5
      && (Math.abs(busPts[0][1] - A.y) < 0.5 || Math.abs(busPts[0][1] - (A.y + A.h)) < 0.5)
    usedLane.set(Math.round(busPts[Math.min(2, busPts.length - 1)][1]), 1) // 索引保护：短路线也不崩
    for (let i = 0; i + 1 < busPts.length; i++) routedSegs.push([busPts[i], busPts[i + 1]])
    edgeRoutes.push({ e, pts: busPts, preferSeg: 2 }) // 2 = 车道那段（长横线）：回边的视觉主体
    elements.push(...makeEdge(style, id, {
      id: `e${ei++}`,
      points: busPts,
      from: { ref: id(e.from), side: tbRoute ? (busPts[0][1] > A.y + A.h / 2 ? 'bottom' : 'top') : sideOf(A, lA) },
      to: { ref: id(e.to), side: tbRoute ? (busPts[0][1] > A.y + A.h / 2 ? 'bottom' : 'top') : sideB },
      dashed: e.style === 'dashed',
    }))
  }

  // ── 第二遍：**所有线都就位之后**再放边标签 ───────────────────────────────
  // 这样"离自己的线最近"这条判据才真正有约束力（第一遍时后放的线还看不见，实测导致标签互换）。
  for (const { e, pts, preferSeg } of edgeRoutes) {
    if (!e.label) continue
    // **框紧贴文字**（用户建议，steps 族已这么做、边标签漏了）：固定 84/100px 宽的框是"离线太远"的根源——
    // 两个字只需要 ~30px，而宽框在列间距里放不下 ⇒ 被否 ⇒ 回退到"竖管中段"（落在两条横线中间，显得太高）。
    const txt = String(e.label)
    const cjkN = (txt.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length
    const tw = Math.min(140, Math.max(24, Math.round(cjkN * style.fontSize + (txt.length - cjkN) * style.fontSize * 0.55) + 10))
    const tbox = placeEdgeLabel(pts, tw, 18, preferSeg ?? -1)
    if (!tbox) {
      notes.push(`state：边 "${e.from} → ${e.to}" 的标签沿线都放不下（压线/压字/离自己的线更远）⇒ 已省略标签`)
      continue
    }
    elements.push(makeText(style, id, { id: `lbl_${e.from}_${e.to}`, x: tbox.x, y: tbox.y, w: tbox.w, text: txt, align: 'center' }))
  }
  if (d.title) elements.unshift(makeText(style, id, { id: 'stt_title', x: box.x, y: box.y, w: box.w, text: String(d.title), sizeFactor: 1.05 }))
  return { elements, groups: [], pos }
}

export const FAMILIES = {
  tree: { maturity: 'stable', layout: layoutTree, summary: '层级树/组织图（正交折线、按叶子序排布）' },
  matrix: { maturity: 'stable', layout: layoutMatrix, summary: '矩阵/象限（行列网格 + 表头）' },
  timeline: { maturity: 'stable', layout: layoutTimeline, summary: '时间轴/里程碑（水平轴 + 上下交替标签）' },
  swimlane: { maturity: 'stable', layout: layoutSwimlane, summary: '泳道图（装饰层泳道带 + 跨道走车道间隙）' },
  compare: { maturity: 'stable', layout: layoutCompare, summary: '左右对比（双列容器 + 中缝）' },
  cycle: { maturity: 'stable', layout: layoutCycle, summary: '闭环反馈（环形排布 + 环外侧折线连线）' },
  funnel: { maturity: 'stable', layout: layoutFunnel, summary: '漏斗/金字塔（custGeom 梯形逐段收窄）' },
  steps: { maturity: 'stable', layout: layoutSteps, summary: '步骤环（环上编号圆点 + 环外标签）' },
  sequence: { maturity: 'stable', layout: layoutSequence, summary: '时序图（生命线 + 水平消息箭头）' },
  state: { maturity: 'stable', layout: layoutState, summary: '状态机（最长路径分层 + 转移总线，回边天然支持）' },
}
