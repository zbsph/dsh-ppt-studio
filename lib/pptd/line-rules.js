/**
 * 折线绘制规则检查（阶段 A1，泛用性优先）。
 *
 * 为什么单独成模块：这些规则族库内部已经遵守（`diagram-families.js` 的 R1/R2），
 * 但**手写页面**（不属于任何族的自由发挥）此前拿不到任何反馈 ⇒ 助手手绘时会重复踩坑
 * （箭头端拐弯、斜段方向不清）。这里对**所有**页面的折线统一给警告。
 *
 * 规则（docs/13 §5.8 的手写版）：
 *  · `arrow-end-short-run`：箭头端紧邻的那一段 < 18px。拐点贴箭头时，箭头三角"吃掉"整段 ⇒
 *    看起来像断的、也看不出指向（用户实测附图）。
 *  · `line-diagonal-segment`：折线出现斜段。连接线只用轴对齐段；**刻意斜**的图形
 *    （环形/放射/漏斗这类本身就是斜的）用 `role: 'decoration'` 或写 `roleReason` 显式声明豁免。
 *
 * 只产出 **warning**：不改任何判定 ⇒ 既有稿的产物、结论与门禁结果都不变（无图页逐字节不变）。
 */

export const ARROW_MIN_RUN = 18

const r1 = (n) => Math.round(n * 10) / 10

import { outlineAnchor } from './relations.js'
import { checkLineText } from './line-text-rule.js'

export function checkLineRules(els) {
  const out = []
  out.push(...checkLineText(els)) // G1?????????????? role/roleReason ???
  const lines = [] // 供第二阶段的"线×线/线×边框"两两比较
  for (const el of els ?? []) {
    // 两条路径的字段名不同：**DSL 原文**用 elementType，**preview 快照**用 kind（实测踩过：
    // 只判 elementType 时快照路径一条都不报）。几何用 points（快照里也保留）。
    const isLine = el?.elementType === 'line' || el?.kind === 'line'
    if (!isLine) continue
    const pts = el.points
    if (!Array.isArray(pts) || pts.length < 2) continue
    const id = el.elementId ?? el.id ?? '?'
    lines.push({ id, pts, deliberate: el.role === 'decoration' || Boolean(el.roleReason) })
    const deliberate = el.role === 'decoration' || Boolean(el.roleReason) // 显式声明"斜线是设计意图"

    // ① 斜段（只报第一条，避免刷屏）
    if (!deliberate) {
      for (let i = 0; i + 1 < pts.length; i++) {
        const dx = Math.abs(pts[i + 1][0] - pts[i][0])
        const dy = Math.abs(pts[i + 1][1] - pts[i][1])
        if (dx > 0.5 && dy > 0.5) {
          out.push({
            code: 'line-diagonal-segment',
            message: `${id}: 折线第 ${i + 1} 段是斜段（Δx=${r1(dx)} Δy=${r1(dy)}）—— 连接线请只用轴对齐段（横/竖），斜段会让箭头方向不确定；若这是刻意的环形/放射/漏斗等图形，给该元素加 role: decoration 或写 roleReason 即视为设计意图、不再提示`,
          })
          break
        }
      }
    }

    // ② 箭头端直段（双箭头则两端都查）
    const segLen = (i) => Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
    const ends = []
    if (el.arrow === true || el.arrow === 'end' || el.arrow === 'both') ends.push({ i: pts.length - 2, where: '终点' })
    if (el.arrow === 'both') ends.push({ i: 0, where: '起点' })
    for (const { i, where } of ends) {
      const d = segLen(i)
      if (d < ARROW_MIN_RUN) {
        out.push({
          code: 'arrow-end-short-run',
          message: `${id}: 箭头${where}紧邻的直线段只有 ${r1(d)}px（建议 ≥ ${ARROW_MIN_RUN}px）—— 拐点贴着箭头时箭头像"断的"、看不出指向；把拐点往外挪，或用 attach: {ref, side} 让引擎把端点锚到元素边上`,
        })
      }
    }
  }
  // ── ③ 共线重叠：用户裁定的"真缺陷"判据 ──────────────────────────────────
  // 两条线走在**同一条直线上且部分重合**（只共用一个点不算——树状干线是标准画法，读者能分清方向）。
  const segsOf = (l) => l.pts.slice(0, -1).map((p, i) => ({ p, q: l.pts[i + 1] }))
  const overlap1D = (a1, a2, b1, b2) => Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2))
  for (let a = 0; a < lines.length; a++) {
    for (let b = a + 1; b < lines.length; b++) {
      const la = lines[a]; const lb = lines[b]
      if (la.deliberate && lb.deliberate) continue
      // **共用端点的"扇出/汇入"豁免**（用户裁定）：两条边从同一个锚点出发（或汇入同一个锚点）、
      // 随后分开 ⇒ 这是标准树状干线画法，读者能分清方向；只有"互不相关的两条线走成一条"才是缺陷。
      const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1
      const endsA = [la.pts[0], la.pts[la.pts.length - 1]]
      const endsB = [lb.pts[0], lb.pts[lb.pts.length - 1]]
      if (endsA.some((x) => endsB.some((y) => near(x, y)))) continue
      let hit = false
      for (const sa of segsOf(la)) {
        for (const sb of segsOf(lb)) {
          const ah = Math.abs(sa.p[1] - sa.q[1]) < 0.5; const bh = Math.abs(sb.p[1] - sb.q[1]) < 0.5
          if (ah && bh && Math.abs(sa.p[1] - sb.p[1]) < 0.5 && overlap1D(sa.p[0], sa.q[0], sb.p[0], sb.q[0]) > 2) hit = true
          const av = Math.abs(sa.p[0] - sa.q[0]) < 0.5; const bv = Math.abs(sb.p[0] - sb.q[0]) < 0.5
          if (av && bv && Math.abs(sa.p[0] - sb.p[0]) < 0.5 && overlap1D(sa.p[1], sa.q[1], sb.p[1], sb.q[1]) > 2) hit = true
        }
      }
      if (hit) out.push({ code: 'line-collinear-overlap', message: `${la.id} 与 ${lb.id} 存在**共线重叠**的线段（两条线走在同一条直线上且部分重合）⇒ 读者分不清哪条是哪条；请错开走廊，或改成"共用一个点后分开"的**树状干线**（只共点、不共线，是标准画法）` })
    }
  }

  // ── ④ 线压在盒子边框上（图 4 那类缺陷的机械判据）────────────────────────
  // 盒子：**两种字段形状都要认**——DSL 原文 bounds=[x,y,w,h]，preview/layout 快照 bounds={x,y,w,h}
  //（实测踩过：只认数组时，压框判据在快照路径上一律不触发）。
  const rectOf = (b) => Array.isArray(b) ? { x: b[0], y: b[1], w: b[2], h: b[3] }
    : (b && typeof b === 'object' && typeof b.x === 'number' ? { x: b.x, y: b.y, w: b.w, h: b.h } : null)
  const boxes = (els ?? []).filter((e) => e && rectOf(e.bounds)
    && (e.elementType === 'shape' || e.elementType === 'image' || e.elementType === 'table' || (e.kind && e.kind !== 'line')))
    .map((e) => ({ id: e.elementId ?? e.id ?? '?', b: rectOf(e.bounds), el: e }))
  for (const l of lines) {
    if (l.deliberate) continue
    let hitId = null
    for (const s of segsOf(l)) {
      for (const { id: bid, b } of boxes) {
        const edges = [[b.x, b.y, b.x + b.w, b.y], [b.x, b.y + b.h, b.x + b.w, b.y + b.h], [b.x, b.y, b.x, b.y + b.h], [b.x + b.w, b.y, b.x + b.w, b.y + b.h]]
        for (const [x1, y1, x2, y2] of edges) {
          const eh = Math.abs(y1 - y2) < 0.5; const sh = Math.abs(s.p[1] - s.q[1]) < 0.5
          if (eh && sh && Math.abs(s.p[1] - y1) <= 1.5 && overlap1D(s.p[0], s.q[0], x1, x2) > 8) hitId = bid
          const ev = Math.abs(x1 - x2) < 0.5; const sv = Math.abs(s.p[0] - s.q[0]) < 0.5
          if (ev && sv && Math.abs(s.p[0] - x1) <= 1.5 && overlap1D(s.p[1], s.q[1], y1, y2) > 8) hitId = bid
        }
      }
    }
    if (hitId) out.push({ code: 'line-on-box-edge', message: `${l.id} 有一段**压在 "${hitId}" 的边框上**（线与框重合 ⇒ 分不清线与边界）—— 把这段挪开 ≥8px，或让该盒子这条边不可见` })
  }

  // ── ⑤ 箭头端与目标图形的接合（R3：**只警告** + 可声明豁免）──────────────
  // 用户明确要求：① "箭头插进图形里"与② "端点离目标边还差一截"都可能是**意料之内的设计**
  //   ⇒ 必须是 warning（绝不 error），且该元素加 `roleReason`（或 `role: decoration`）即视为刻意如此、不再提示。
  // 带 attach 的线跳过（引擎已保证接在真实轮廓上）；斜边图形用 outlineAnchor 算真实轮廓。
  const GAP_MIN = 2 // 贴得比这更近算"接上了"，不算缺口
  const GAP_MAX = 10 // 超过这距离就不是"想接没接上"，而是另一回事
  // 只看**内容图形**：`role: decoration`（背景板/容器/分区底色）不算"图形"——
  // 连线进入背景板是正常画法（暖色架构图的支线就是伸进内核底板的，实测假阳性）。
  const shapeBoxes = (els ?? []).filter((e) => e && rectOf(e.bounds) && e.role !== 'decoration'
    && (e.elementType === 'shape' || e.kind === 'shape'))
  for (const el of (els ?? [])) {
    if (!el || el.attach || el.role === 'decoration' || el.roleReason) continue
    const isLine = el.elementType === 'line' || el.kind === 'line'
    const pts = isLine && Array.isArray(el.points) ? el.points : null
    if (!pts || pts.length < 2) continue
    const arrow = el.arrow === true || el.arrow === 'end' || el.arrow === 'both' || el.arrowEnd === true
    if (!arrow) continue
    const id = el.elementId ?? el.id ?? '?'
    const tip = pts[pts.length - 1]
    const prev = pts[pts.length - 2]
    const dx = tip[0] - prev[0]
    const dy = tip[1] - prev[1]
    for (const sb of shapeBoxes) {
      const b = rectOf(sb.bounds)
      if (tip[0] < b.x - GAP_MAX - 2 || tip[0] > b.x + b.w + GAP_MAX + 2
        || tip[1] < b.y - GAP_MAX - 2 || tip[1] > b.y + b.h + GAP_MAX + 2) continue
      const sid = sb.elementId ?? sb.id ?? '?'
      const L = (yy) => (outlineAnchor(sb, 'left', [0, yy]) ?? [b.x, yy])[0]
      const R = (yy) => (outlineAnchor(sb, 'right', [0, yy]) ?? [b.x + b.w, yy])[0]
      if (tip[1] > b.y + 1 && tip[1] < b.y + b.h - 1 && tip[0] > L(tip[1]) + 1 && tip[0] < R(tip[1]) - 1) {
        out.push({ code: 'arrow-tip-inside-shape', message: `${id} 的箭头端点落在 "${sid}" **内部**（插进图形里）—— 接在图形边缘更清楚；若确实要插进去（强调/贯穿），给这条线加 \`roleReason\` 声明即可不再提示` })
        continue
      }
      const cx = b.x + b.w / 2
      const cy = b.y + b.h / 2
      if ((cx - tip[0]) * dx + (cy - tip[1]) * dy <= 0) continue // 不是朝这个图形去的 ⇒ 不管
      // 缺口要按**真实轮廓**算：斜边图形在端点所在 y 上的边界是 L(y)/R(y)，
      // 用包围盒算会在"端点落在包围盒内、但在斜边外"时恒得 0（实测踩过）。
      const cyC = Math.min(Math.max(tip[1], b.y), b.y + b.h)
      const hGap = Math.max(L(cyC) - tip[0], tip[0] - R(cyC), 0)
      const inBand = tip[1] >= b.y - 0.5 && tip[1] <= b.y + b.h + 0.5
      const vGap = inBand ? 0 : Math.min(Math.abs(tip[1] - b.y), Math.abs(tip[1] - (b.y + b.h)))
      const gap = Math.hypot(hGap, vGap)
      if (gap >= GAP_MIN && gap <= GAP_MAX) {
        out.push({ code: 'arrow-end-gap', message: `${id} 的箭头端点离 "${sid}" 还有约 ${gap.toFixed(0)}px（看起来**没接上**）—— 用 \`attach: {ref: ${sid}, side: …}\` 让引擎贴边；若刻意留空，加 \`roleReason\` 声明` })
        break
      }
    }
  }

  // ── ⑥ 线×线"真交叉"（+ 型：两条都穿过对方）────────────────────────────
  // 用户要求（2026-09-30）：门禁不是判死刑，而是**把问题定位到可修的程度**，让助手定向返工、
  // 迭代到终态绿。所以这里必须给出**可执行信息**：哪两条线、在哪交叉、怎么改。
  // 与 R9 一致：T 形结点、共线重叠、共用端点都**不算**交叉（那些是标准画法；共线重叠另有判据）。
  // 刻意交叉（示意汇流/流程交叉点）加 roleReason 声明即静默。
  {
    const segs = []
    for (const l of lines) for (let i = 0; i + 1 < l.pts.length; i++) segs.push({ id: l.id, a: l.pts[i], b: l.pts[i + 1] })
    const seen = new Set()
    // **尊重声明**：任一条被声明为结构性（role: decoration 或 roleReason）就不参与交叉判定
    // ——其他判据都有这一步，这里第一版漏了（实测：泳道分隔线被跨道连线穿过后误报）。
    const deliberateIds = new Set(lines.filter((l) => l.deliberate).map((l) => l.id))
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const s = segs[i]; const t = segs[j]
        if (s.id === t.id) continue
        if (deliberateIds.has(s.id) || deliberateIds.has(t.id)) continue
        const key = s.id < t.id ? `${s.id}|${t.id}` : `${t.id}|${s.id}`
        if (seen.has(key)) continue
        const sh = Math.abs(s.a[1] - s.b[1]) < 0.5
        const th = Math.abs(t.a[1] - t.b[1]) < 0.5
        if (sh === th) continue
        const h = sh ? s : t; const v = sh ? t : s
        const hx0 = Math.min(h.a[0], h.b[0]); const hx1 = Math.max(h.a[0], h.b[0])
        const vy0 = Math.min(v.a[1], v.b[1]); const vy1 = Math.max(v.a[1], v.b[1])
        if (!(v.a[0] > hx0 + 1 && v.a[0] < hx1 - 1 && h.a[1] > vy0 + 1 && h.a[1] < vy1 - 1)) continue
        seen.add(key)
        out.push({ code: 'line-crossing', message: `${s.id} 与 ${t.id} 在 (${Math.round(v.a[0])}, ${Math.round(h.a[1])}) **交叉**（+ 型：两条都穿过对方）—— 给其中一条换车道/换进出边（或调换路由顺序）后重跑本门禁；若刻意交叉示意汇流，给该线加 roleReason 声明即静默` })
      }
    }
  }

  // ── ⑦ 折线折返尖刺（line-spike）────────────────────────────────────────
  // 连续三点共线且中间点折返（越过又折回）⇒ 画出来是一根"戳出去"的多余线。
  // 用户实测图 10 顶端那根线就是这个（已在 normalizePage 末尾兜底修掉）⇒ 本条是**回归护栏**：
  // 以后任何路径再引入折返，门禁会直接点名"哪条线、哪个点"。
  for (const l of lines) {
    if (l.deliberate) continue
    const p2 = l.pts
    let bad = 0
    for (let i = 1; i + 1 < p2.length; i++) {
      const a1 = p2[i - 1]
      const b1 = p2[i]
      const c1 = p2[i + 1]
      const sameX = Math.abs(a1[0] - b1[0]) < 0.5 && Math.abs(b1[0] - c1[0]) < 0.5
      const sameY = Math.abs(a1[1] - b1[1]) < 0.5 && Math.abs(b1[1] - c1[1]) < 0.5
      if ((sameX && (b1[1] - a1[1]) * (c1[1] - b1[1]) < 0) || (sameY && (b1[0] - a1[0]) * (c1[0] - b1[0]) < 0)) { bad = i + 1; break }
    }
    if (bad) out.push({ code: 'line-spike', message: `${l.id} 在第 ${bad} 个点处**折返**（共线又折回 ⇒ 会画出一根戳出去的多余线）—— 删掉该多余点即可；若确为刻意的往返重叠，给该线加 roleReason 声明` })
  }

  // ── ⑧ 无箭头连线的端点"差一点没接上"（line-end-off-edge）────────────────
  // 与 `arrow-end-gap` 分工：**带箭头**的由那条管；这里只管**不带箭头**的折线端点——
  // 它在离某个图形轮廓 2–12px 处停住、且方向朝着该图形 ⇒ 观感上"没接上"（用户实测过同类）。
  // 只警告、可声明；带 attach 的线跳过（引擎已保证贴边）。
  for (const el of (els ?? [])) {
    if (!el || el.attach || el.role === 'decoration' || el.roleReason) continue
    const isLine = el.elementType === 'line' || el.kind === 'line'
    const pts2 = isLine && Array.isArray(el.points) ? el.points : null
    if (!pts2 || pts2.length < 2) continue
    const arrow = el.arrow === true || el.arrow === 'end' || el.arrow === 'both' || el.arrowEnd === true
    if (arrow) continue
    const id = el.elementId ?? el.id ?? '?'
    for (const [tip, prev] of [[pts2[pts2.length - 1], pts2[pts2.length - 2]], [pts2[0], pts2[1]]]) {
      const dx = tip[0] - prev[0]
      const dy = tip[1] - prev[1]
      for (const sb of boxes) {
        if (sb.id === id) continue
        const b = sb.b
        const cx = b.x + b.w / 2
        const cy = b.y + b.h / 2
        if ((cx - tip[0]) * dx + (cy - tip[1]) * dy <= 0) continue
        const cyC = Math.min(Math.max(tip[1], b.y), b.y + b.h)
        const lx = (outlineAnchor(sb.el, 'left', [0, cyC]) ?? [b.x, cyC])[0]
        const rx = (outlineAnchor(sb.el, 'right', [0, cyC]) ?? [b.x + b.w, cyC])[0]
        const hGap = Math.max(lx - tip[0], tip[0] - rx, 0)
        const inBand = tip[1] >= b.y - 0.5 && tip[1] <= b.y + b.h + 0.5
        const vGap = inBand ? 0 : Math.min(Math.abs(tip[1] - b.y), Math.abs(tip[1] - (b.y + b.h)))
        const gap = Math.hypot(hGap, vGap)
        if (gap >= 2 && gap <= 12) {
          out.push({ code: 'line-end-off-edge', message: `${id} 的端点离 "${sb.id}" 还有约 ${gap.toFixed(0)}px（**没接上**）—— 用 attach 让它贴边，或给它加箭头改成 arrow-end-gap 那条判据；若刻意留空，加 roleReason 声明` })
          break
        }
      }
    }
  }

  return out
}
