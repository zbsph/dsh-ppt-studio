/**
 * 线 × 文字碰撞检查（G1 补齐的真缺口）
 *
 * 背景：`line-rules.js` 已有 line×line（line-crossing / line-collinear-overlap）、
 * line×边框（line-on-box-edge）、箭头相关规则，但**没有 line×text** ——
 * 红样本实测：竖线穿过文字标签时门禁 0 错、且只报 4 条无关警告。
 * 这是用户实际反馈过的问题（图 09 生命线穿过"残饵画面"标签）。
 *
 * 判定：线段落在**文字矩形内部**的长度 ≥ 2px 即命中（仅相切不算）。
 * 级别：警告（由调用方决定 severity，与 line-crossing 一致）。
 * 豁免：与 line-rules 其余规则一致 —— `role: decoration` 或 `roleReason` 声明"刻意穿过"。
 */
const r1 = (n) => Math.round(n * 10) / 10

/** 把 bounds 统一成 {x,y,w,h}（DSL 用数组，快照用对象） */
function rectOf(el) {
  const b = el?.bounds
  if (Array.isArray(b)) return { x: b[0], y: b[1], w: b[2], h: b[3] }
  if (b && typeof b === 'object') return { x: b.x, y: b.y, w: b.w, h: b.h }
  return null
}

/**
 * 线段 p→q 落在矩形内部的长度（Liang-Barsky 裁剪）。0 表示未穿过内部。
 */
export function segmentInsideRect(p, q, r) {
  const dx = q[0] - p[0]
  const dy = q[1] - p[1]
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const hw = r.w / 2
  const hh = r.h / 2
  const ax = p[0] - cx
  const ay = p[1] - cy
  let t0 = 0
  let t1 = 1
  const clip = (pv, qv) => {
    if (Math.abs(pv) < 1e-9) return qv >= 0
    const t = qv / pv
    if (pv < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  if (!clip(-dx, ax + hw)) return 0
  if (!clip(dx, hw - ax)) return 0
  if (!clip(-dy, ay + hh)) return 0
  if (!clip(dy, hh - ay)) return 0
  return Math.hypot(dx, dy) * (t1 - t0)
}

/**
 * @param {Array} els 同一页的元素（DSL 或快照形态均可）
 * @returns {Array<{code:string,id:string,message:string}>} 警告级条目
 */
export function checkLineText(els) {
  const out = []
  const list = els ?? []
  const texts = list.filter((e) => (e?.elementType === 'text' || e?.kind === 'text') && rectOf(e))
  const lines = list.filter((e) => (e?.elementType === 'line' || e?.kind === 'line') && Array.isArray(e?.points) && e.points.length >= 2)
  if (!texts.length || !lines.length) return out
  for (const l of lines) {
    if (l.role === 'decoration' || l.roleReason) continue // 声明"刻意穿过"⇒ 不提示
    const lid = l.elementId ?? l.id ?? '?'
    const seen = new Set()
    for (const t of texts) {
      const tid = t.elementId ?? t.id ?? '?'
      if (seen.has(tid)) continue
      const r = rectOf(t)
      let hit = 0
      for (let i = 0; i + 1 < l.points.length; i++) {
        const len = segmentInsideRect(l.points[i], l.points[i + 1], r)
        if (len > hit) hit = len
      }
      if (hit >= 2) {
        seen.add(tid)
        out.push({
          code: 'line-cross-text',
          id: lid,
          message: `${lid} 穿过文字 "${tid}" 约 ${r1(hit)}px（压字）——把标签挪开，或给标签加**白底芯片**遮罩；若刻意穿过，给该线加 roleReason 声明`,
        })
      }
    }
  }
  return out
}
