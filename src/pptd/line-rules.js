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

export function checkLineRules(els) {
  const out = []
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
    .map((e) => ({ id: e.elementId ?? e.id ?? '?', b: rectOf(e.bounds) }))
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

  return out
}
