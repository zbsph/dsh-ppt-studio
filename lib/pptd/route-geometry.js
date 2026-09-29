/**
 * 路由几何（G1：把族管线的两个后处理接到**显式 elements**（纯手画）通路）
 *
 * 背景：`orthogonalize`（斜段→直角折线）与 `arrowEndRuns`（箭头端紧邻段 ≥ ARROW_MIN_RUN）此前
 * 只被 `diagram-families.js` 内部调用 ⇒ 手画页面享受不到，只能靠"人肉记住 18px"（用户实测踩坑：
 * 图 04 折点离端点 7px、图 09 竖线穿字）。本模块把两者封装成**一个带守卫的入口**给手画用。
 *
 * 为什么不直接调用族的组合 `orthogonalize(arrowEndRuns(orthogonalize(pts), arrow))`：
 *   · **守卫 1（n < 3）**：`arrowEndRuns` 的 `fix(n-2, n-1)` 在 n=2 时退化为 `fix(0,1)` ——
 *     它会去**挪起点**，把短直线改短、包围盒跟着变。实测效果：既有 smoke 断言
 *     "连线·水平线 包围盒 cy=0" 由绿转红。直线没有"拐点"可挪 ⇒ 直接原样返回。
 *   · **守卫 2（折返）**：族里这套组合是为"路由产生的折角"设计的。用在简单 L 形上会造出**折返尖刺**：
 *     实测 [(200,300),(400,300),(400,307)]（末段仅 7px）→ [(200,300),(400,300),(400,289),(400,307)]
 *     （先上 11px 再下 18px）。折返 100% 是缺陷 ⇒ 一旦结果含折返就**保留原样**，
 *     把"箭头前直段过短"交给门禁检查去拦（而不是悄悄画出一根刺）。
 *
 * 例外（与族一致）：本身就是"环/放射"语义的图形（cycle 外环弦、放射线）**豁免正交化** ——
 * 这里由 `isAxisAligned()` 判定：折线中只要存在斜段，就视为有意为之，调用方跳过本模块。
 */
import { orthogonalize, arrowEndRuns } from './diagram-families.js'

// 原语原样再导出：族与手画**用同一份实现**（单一事实来源，不做复制粘贴）
export { orthogonalize, arrowEndRuns }

/** 箭头端"直线段最短长度"（与 diagram-families 内部常量同值；此处导出便于门禁复用） */
export const ARROW_MIN_RUN = 18

/** 折线是否全部轴对齐（斜段 ⇒ 属"环/放射"语义，应豁免正交化） */
export function isAxisAligned(pts) {
  const p = pts ?? []
  return p.every((q, i) => i === 0
    || Math.abs(q[0] - p[i - 1][0]) < 0.5 || Math.abs(q[1] - p[i - 1][1]) < 0.5)
}

/** 折返检测：相邻两段**共线且反向**（折返 100% 是缺陷，不许被后处理造出来） */
export function hasFoldback(pts) {
  const p = pts ?? []
  for (let i = 2; i < p.length; i++) {
    const ax = p[i - 1][0] - p[i - 2][0]
    const ay = p[i - 1][1] - p[i - 2][1]
    const bx = p[i][0] - p[i - 1][0]
    const by = p[i][1] - p[i - 1][1]
    const la = Math.hypot(ax, ay)
    const lb = Math.hypot(bx, by)
    if (!la || !lb) continue
    const collinear = Math.abs(ax * by - ay * bx) < 1e-6 * la * lb
    if (collinear && ax * bx + ay * by < 0) return true
  }
  return false
}

/**
 * 手画折线的路由后处理（带两道守卫）。
 * @param {Array<[number,number]>} pts 折线点列（绝对坐标）
 * @param {boolean|'end'|'both'} arrow 箭头配置（原样透传，'both' 表示两端）
 * @returns {Array<[number,number]>} 处理后的点列（守卫不通过时原样返回）
 */
export function routePolyline(pts, arrow) {
  const raw = (pts ?? []).map(([x, y]) => [x, y])
  // **契约（2026-09 实测确认，smoke 有 6 条专项断言守着）**：
  // 2 点直连线是**受支持的连接符** —— 引擎导出为 <p:cxnSp>（带 flipH/flipV），斜向也完全合法。
  // **不许正交化它**：否则 cxnSp 数归零、方向专项断言全崩（本轮实测）。
  // 因此只有**折线（≥3 点）**才过正交化 + 箭头端最短直段。
  if (raw.length < 3) return raw
  const fixed = orthogonalize(arrowEndRuns(orthogonalize(raw), arrow))
  // 折返守卫：族算法用在 L 形上会造"先上后下"尖刺 ⇒ 含折返就退回原样，
  // 交给门禁 arrow-end-short-run 报出（引擎不造缺陷、门禁负责报缺陷）。
  return hasFoldback(fixed) ? raw : fixed
}
