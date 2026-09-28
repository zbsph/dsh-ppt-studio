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
  for (const el of els ?? []) {
    // 两条路径的字段名不同：**DSL 原文**用 elementType，**preview 快照**用 kind（实测踩过：
    // 只判 elementType 时快照路径一条都不报）。几何用 points（快照里也保留）。
    const isLine = el?.elementType === 'line' || el?.kind === 'line'
    if (!isLine) continue
    const pts = el.points
    if (!Array.isArray(pts) || pts.length < 2) continue
    const id = el.elementId ?? el.id ?? '?'
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
  return out
}
