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
// ── 本模块**自持**这三个纯量（F1 解耦：原先族与手画共用，现由手画侧提供、族反向 import）──
// 方向单向：diagram-families → route-geometry，不存在循环依赖。
/**
 * 箭头端的"直线段最短长度"。
 * 用户实测反馈：拐点离箭头太近时，箭头看起来像"断的"、也看不出指向（附图那根线就是在箭头处拐弯）。
 * 规则：带箭头的端点，其**紧邻的那一段**必须 ≥ ARROW_MIN_RUN 像素；不够就把相邻的**拐点**沿该段反向挪远。
 * 只挪拐点、不动端点（attach 语义不变），且挪动方向沿该段自身 ⇒ 拐点仍落在原来的走廊/间隙里。
 */
export const ARROW_MIN_RUN = 18
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
