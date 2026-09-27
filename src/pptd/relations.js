/**
 * 结构关系推导与几何反验证（阶段 A 地基，2026-09-28）。设计依据：docs/08 §2/§4。
 *
 * 为什么需要：复杂图靠"逐对声明"是不可能维护的（一页 5 容器 × 10 子元素 = 50 对）。
 * 但**声明本身不能当豁免**——否则引擎的一次 bug 会被固化成永久豁免。所以本模块的原则是：
 *
 *   **声明 + 通过几何反验证 = 豁免；验证不过 ⇒ 声明作废，按普通冲突处理。**
 *
 * 三条硬纪律（都会在自证脚本里被断言）：
 *   ① 推导结果**不落盘**：每次运行现算，不写回 deck.yaml（避免 bug 固化成数据）。
 *   ② **确定性**：所有输出按 id 字典序；不用随机、不用时间；同输入两次调用深度相等。
 *   ③ **不改输入**：纯函数，绝不原地修改 page。
 *
 * 关系类型与严格谓词见 docs/08 §2；容差默认值集中在 RELATION_DEFAULTS。
 */

/** attach 的边枚举（schema 与导出/验证共用同一份，避免两处枚举漂移）。 */
export const ATTACH_SIDES = ['top', 'right', 'bottom', 'left']

/** 容差默认值（docs/08 §2 表；真实稿校准后统一调整这里）。 */
export const RELATION_DEFAULTS = {
  pad: 0, // contains：子元素距父边的最小内缩
  tol: 1.5, // attach：端点与目标边的最大距离
  duplicateTol: 2, // duplicate-element：包围盒各边差的最大值
  badgeMaxRatio: 0.5, // badgeOf：chip 面积 / owner 面积上限
  overlapTol: 1, // 相交判定容差（与 verify 既有 1px 一致）
}

/** 元素包围盒 → {x, y, w, h, right, bottom}（兼容数组与对象两种写法）。 */
export function rectOf(el) {
  const b = el?.bounds
  let x = 0
  let y = 0
  let w = 0
  let h = 0
  if (Array.isArray(b)) { [x, y, w, h] = b }
  else if (b && typeof b === 'object') { ({ x = 0, y = 0, w = 0, h = 0 } = b) }
  return { x, y, w, h, right: x + w, bottom: y + h }
}

const area = (r) => Math.max(0, r.w) * Math.max(0, r.h)
// 豁免键格式必须与 verify.js 的 pairKey 一致（`A × B`，两侧带空格）——否则豁免注入声明集后匹配不上。
const key2 = (a, b) => [String(a), String(b)].sort().join(' × ')

/**
 * 本页是否**使用了阶段 A 的结构声明**（groups / contains / attach / badgeOf / >2 点折线）。
 * 用途：verify 只在"用了新特性"的页面上启用结构豁免与图专属检查 ⇒
 * **没有用新特性的页面行为与从前完全一致**（非回归门）。
 */
export function usesStructure(page) {
  if (Array.isArray(page?.groups) && page.groups.length > 0) return true
  for (const el of page?.elements ?? []) {
    if (el.contains !== undefined || el.badgeOf !== undefined || el.attach !== undefined) return true
    if (Array.isArray(el.points) && el.points.length > 2) return true
  }
  return false
}

/** 相交（容差 tol：小于 tol 的贴合不算相交）。 */
export function intersects(a, b, tol = RELATION_DEFAULTS.overlapTol) {
  const vo = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y)
  const ho = Math.min(a.right, b.right) - Math.max(a.x, b.x)
  return vo > tol && ho > tol
}

/** a 是否**严格包含** b（内缩 pad）。 */
export function contains(a, b, pad = RELATION_DEFAULTS.pad) {
  return b.x >= a.x + pad - 0.001 && b.y >= a.y + pad - 0.001
    && b.right <= a.right - pad + 0.001 && b.bottom <= a.bottom - pad + 0.001
}

/** 点是否落在 rect 的某条边上（容差 tol）——用于 attach 判定。 */
export function onSide(side, point, r, tol = RELATION_DEFAULTS.tol) {
  const [x, y] = point
  if (side === 'left') return Math.abs(x - r.x) <= tol && y >= r.y - tol && y <= r.bottom + tol
  if (side === 'right') return Math.abs(x - r.right) <= tol && y >= r.y - tol && y <= r.bottom + tol
  if (side === 'top') return Math.abs(y - r.y) <= tol && x >= r.x - tol && x <= r.right + tol
  if (side === 'bottom') return Math.abs(y - r.bottom) <= tol && x >= r.x - tol && x <= r.right + tol
  return false
}

/** 线段是否穿过 rect 的**内部**（内缩 tol；贴边不算穿过）——用于 line-through-box。 */
export function segmentCrossesRect(p1, p2, r, tol = RELATION_DEFAULTS.tol) {
  const inner = { x: r.x + tol, y: r.y + tol, right: r.right - tol, bottom: r.bottom - tol }
  if (inner.right <= inner.x || inner.bottom <= inner.y) return false
  // 端点落在内部 ⇒ 穿过
  const inside = (p) => p[0] > inner.x && p[0] < inner.right && p[1] > inner.y && p[1] < inner.bottom
  if (inside(p1) || inside(p2)) return true
  // Liang–Barsky 裁剪：线段与内矩形是否有交集
  let t0 = 0
  let t1 = 1
  const dx = p2[0] - p1[0]
  const dy = p2[1] - p1[1]
  const clip = (p, q) => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t }
    else { if (t < t0) return false; if (t < t1) t1 = t }
    return true
  }
  if (!clip(-dx, p1[0] - inner.x)) return false
  if (!clip(dx, inner.right - p1[0])) return false
  if (!clip(-dy, p1[1] - inner.y)) return false
  if (!clip(dy, inner.bottom - p1[1])) return false
  return t0 <= t1
}

/** 归一化后的元素表：id → el（并给出 rect）。 */
function indexElements(page) {
  const map = new Map()
  for (const el of page.elements ?? []) map.set(String(el.id ?? el.elementId), el)
  return map
}

/**
 * 校验 `groups` 的结构合法性：成员存在、无重复、嵌套无环、一个元素只属一个直接组。
 * @returns {{flat: Array, errors: Array<{code: string, detail: string}>, parentOf: Map<string, string>}}
 */
function normalizeGroups(page) {
  const els = indexElements(page)
  const groups = page.groups ?? []
  const byId = new Map()
  const errors = []
  const seenGroupId = new Set()
  for (const g of groups) {
    const id = String(g?.id ?? '')
    if (!id) { errors.push({ code: 'group-no-id', detail: 'groups[] 存在缺少 id 的组' }); continue }
    if (seenGroupId.has(id)) { errors.push({ code: 'group-duplicate-id', detail: `组 id 重复："${id}"` }); continue }
    if (els.has(id)) { errors.push({ code: 'group-id-collides-element', detail: `组 id "${id}" 与元素 id 同名（同一命名空间）` }); continue }
    seenGroupId.add(id)
    const members = [...new Set((g.members ?? []).map(String))]
    if (members.length !== (g.members ?? []).length) errors.push({ code: 'group-duplicate-member', detail: `组 "${id}" 的 members 含重复项` })
    byId.set(id, { id, label: g.label === undefined ? undefined : String(g.label), members })
  }
  // 成员存在性
  for (const g of byId.values()) {
    for (const m of g.members) {
      if (!els.has(m) && !byId.has(m)) errors.push({ code: 'group-member-missing', detail: `组 "${g.id}" 的成员 "${m}" 不存在` })
    }
  }
  // 唯一直接归属（元素/子组只能有一个直接父组）
  const parentOf = new Map()
  for (const g of byId.values()) {
    for (const m of g.members) {
      if (parentOf.has(m)) errors.push({ code: 'group-member-multi-parent', detail: `"${m}" 同时属于组 "${parentOf.get(m)}" 与 "${g.id}"（只允许一个直接父组）` })
      else parentOf.set(m, g.id)
    }
  }
  // 环检测（DFS）
  const state = new Map()
  const cycle = []
  const walk = (id, stack) => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') { cycle.push([...stack, id].join(' → ')); return }
    state.set(id, 'visiting')
    for (const m of byId.get(id)?.members ?? []) if (byId.has(m)) walk(m, [...stack, id])
    state.set(id, 'done')
  }
  for (const id of [...byId.keys()].sort()) walk(id, [])
  for (const c of cycle) errors.push({ code: 'group-cycle', detail: `组嵌套成环：${c}` })

  // 展开为扁平表（含 depth）
  const depthOf = (id, guard = 0) => {
    if (guard > 64) return 99
    const p = parentOf.get(id)
    return p === undefined ? 0 : 1 + depthOf(p, guard + 1)
  }
  const flat = [...byId.keys()].sort().map((id) => ({ ...byId.get(id), depth: depthOf(id) }))
  return { flat, errors, parentOf }
}

/**
 * 推导全部结构关系并**逐条几何反验证**。
 * @returns {{
 *   groups: Array, relations: Array, exempt: string[], invalid: Array,
 *   stats: {groups: number, contains: number, attach: number, badge: number, overlapDecl: number, exempt: number},
 *   errors: Array<{code: string, detail: string}>
 * }}
 */
export function deriveRelations(page, opts = {}) {
  const t = { ...RELATION_DEFAULTS, ...(opts.tolerance ?? {}) }
  const els = indexElements(page)
  const g = normalizeGroups(page)
  const errors = [...g.errors]
  const relations = []
  const invalid = []
  const exempt = new Set()

  // 1) contains：父盒必须严格包含每个子盒
  for (const id of [...els.keys()].sort()) {
    const el = els.get(id)
    const kids = [...new Set((el.contains ?? []).map(String))].sort()
    if (kids.length === 0) continue
    const parent = rectOf(el)
    for (const cid of kids) {
      const child = els.get(cid)
      if (!child) { invalid.push({ type: 'contains', from: id, to: cid, why: `子元素 "${cid}" 不存在` }); continue }
      const ok = contains(parent, rectOf(child), t.pad)
      relations.push({ type: 'contains', from: id, to: cid, valid: ok, evidence: { pad: t.pad, parent, child: rectOf(child) }, reason: el.roleReason })
      if (ok) exempt.add(key2(id, cid))
      else invalid.push({ type: 'contains', from: id, to: cid, why: `父盒未真正包含子元素（pad=${t.pad}）` })
    }
  }

  // 2) attach：端点必须落在目标元素的**对应边**上
  for (const id of [...els.keys()].sort()) {
    const el = els.get(id)
    const a = el.attach
    if (!a) continue
    const pts = Array.isArray(el.points) ? el.points : []
    const sides = [['from', pts[0]], ['to', pts[pts.length - 1]]]
    for (const [end, pt] of sides) {
      const spec = a[end]
      if (!spec) continue
      const ref = els.get(String(spec.ref))
      if (!ref) { invalid.push({ type: 'attach', from: id, to: String(spec.ref), why: `${end} 端引用的元素不存在` }); continue }
      if (!Array.isArray(pt)) { invalid.push({ type: 'attach', from: id, to: String(spec.ref), why: `${end} 端缺少坐标（points 至少 2 点）` }); continue }
      const ok = onSide(String(spec.side), pt, rectOf(ref), t.tol)
      relations.push({ type: 'attach', from: id, to: String(spec.ref), end, valid: ok, evidence: { side: spec.side, point: pt, tol: t.tol } })
      if (!ok) invalid.push({ type: 'attach', from: id, to: String(spec.ref), why: `${end} 端点未落在 ${spec.ref} 的 ${spec.side} 边（tol=${t.tol}）` })
    }
  }

  // 3) badgeOf：确实相交 + 面积比 ≤ 上限 + 不完全覆盖
  for (const id of [...els.keys()].sort()) {
    const el = els.get(id)
    const ownerId = el.badgeOf === undefined ? null : String(el.badgeOf)
    if (ownerId === null) continue
    const owner = els.get(ownerId)
    if (!owner) { invalid.push({ type: 'badge', from: id, to: ownerId, why: '被归属的元素不存在' }); continue }
    const chipR = rectOf(el)
    const ownerR = rectOf(owner)
    const hit = intersects(chipR, ownerR, t.tol)
    const ratio = area(ownerR) > 0 ? area(chipR) / area(ownerR) : 1
    const ownerCornerOutside = [[ownerR.x, ownerR.y], [ownerR.right, ownerR.y], [ownerR.x, ownerR.bottom], [ownerR.right, ownerR.bottom]]
      .some(([x, y]) => x < chipR.x || x > chipR.right || y < chipR.y || y > chipR.bottom)
    // 注：面积比上限通常已经覆盖"完全覆盖"的情形（chip ⊇ owner ⇒ 面积比 ≥ 1），这一条作为**额外防线**保留。
    const ok = hit && ratio <= t.badgeMaxRatio && ownerCornerOutside
    relations.push({ type: 'badge', from: id, to: ownerId, valid: ok, evidence: { hit, areaRatio: Number(ratio.toFixed(3)), ownerCornerOutside, cap: t.badgeMaxRatio } })
    if (ok) exempt.add(key2(id, ownerId))
    else invalid.push({
      type: 'badge',
      from: id,
      to: ownerId,
      why: !hit ? '徽章与被归属元素并不相交' : (ratio > t.badgeMaxRatio ? `面积比 ${ratio.toFixed(2)} 超过上限 ${t.badgeMaxRatio}（这更像遮罩）` : '完全覆盖了被归属元素（这更像遮罩）'),
    })
  }

  // 4) expectedOverlaps（含跨组用法）：两端存在、不得同为 content、必须确实相交
  const declared = Array.isArray(page.expectedOverlaps) ? page.expectedOverlaps : []
  for (const [i, d] of declared.entries()) {
    const pair = Array.isArray(d?.pair) ? d.pair.map(String) : []
    if (pair.length !== 2) { errors.push({ code: 'declared-bad-shape', detail: `expectedOverlaps[${i}] 必须是 {pair: [idA, idB]}${d?.reason ? '' : '（建议补 reason）'}` }); continue }
    const [aId, bId] = pair
    const A = els.get(aId)
    const B = els.get(bId)
    if (!A || !B) { errors.push({ code: 'declared-missing-endpoint', detail: `expectedOverlaps[${i}] 端点不存在：${!A ? aId : bId}` }); continue }
    const contentOf = (el) => ['text', 'table', 'chart'].includes(el.elementType) || el.role === 'content'
    if (contentOf(A) && contentOf(B)) { errors.push({ code: 'declared-content-collision', detail: `expectedOverlaps[${i}]（${aId} × ${bId}）两端都是内容元素——内容互压**不可声明**` }); continue }
    const hit = intersects(rectOf(A), rectOf(B), t.tol)
    relations.push({ type: 'overlapDecl', from: aId, to: bId, valid: hit, evidence: { intersects: hit }, reason: d?.reason })
    if (hit) exempt.add(key2(aId, bId))
    else invalid.push({ type: 'overlapDecl', from: aId, to: bId, why: '声明已失效：两端当前并不相交（建议移除该声明）' })
  }

  // 声明不成立 ⇒ **点名错误**（按普通冲突处理）；只有"声明已失效（不再相交）"降级为 ℹ
  for (const iv of invalid) {
    if (iv.type === 'overlapDecl') continue
    errors.push({ code: 'relation-invalid', detail: `${iv.type} 声明不成立：${iv.from} × ${iv.to} —— ${iv.why}` })
  }

  // 1b) 包含关系的**传递闭包**：A ⊇ B ⊇ C ⇒ A × C 也应豁免。
  // 理由（用户的真实工作方式）：组合是**嵌套**的——"第二层组合把第一层当成一个整体"，
  // 外层容器不该被迫枚举所有深后代（否则声明清单随嵌套层数爆炸，正是我们一开始想避免的）。
  // 只沿**有效**的 contains 边传播；语义与 verify 既有的声明闭包（declaredClosure）一致。
  const childrenOf = new Map()
  for (const r of relations) {
    if (r.type !== 'contains' || !r.valid) continue
    if (!childrenOf.has(r.from)) childrenOf.set(r.from, [])
    childrenOf.get(r.from).push(r.to)
  }
  let closurePairs = 0
  for (const parent of [...childrenOf.keys()].sort()) {
    const seen = new Set()
    const stack = [...childrenOf.get(parent)].sort()
    while (stack.length) {
      const id = stack.pop()
      if (seen.has(id)) continue
      seen.add(id)
      const k = key2(parent, id)
      if (!exempt.has(k)) { exempt.add(k); closurePairs++ }
      for (const grand of (childrenOf.get(id) ?? []).sort()) if (!seen.has(grand)) stack.push(grand)
    }
  }

  // 确定性：全部按 id 排序
  relations.sort((x, y) => `${x.type}|${x.from}|${x.to}|${x.end ?? ''}`.localeCompare(`${y.type}|${y.from}|${y.to}|${y.end ?? ''}`))
  const stats = {
    groups: g.flat.length,
    contains: relations.filter((r) => r.type === 'contains').length,
    attach: relations.filter((r) => r.type === 'attach').length,
    badge: relations.filter((r) => r.type === 'badge').length,
    overlapDecl: relations.filter((r) => r.type === 'overlapDecl').length,
    exempt: exempt.size,
    closurePairs,
  }
  return { groups: g.flat, relations, exempt: [...exempt].sort(), invalid, stats, errors }
}

/**
 * 图专属机械检查（docs/08 §3）——不依赖任何声明也会查。
 * @returns {{errors: Array, warnings: Array}}
 */
export function checkDiagram(page, opts = {}) {
  const t = { ...RELATION_DEFAULTS, ...(opts.tolerance ?? {}) }
  const errors = []
  const warnings = []
  const els = [...(page.elements ?? [])].map((el) => ({ el, id: String(el.id ?? el.elementId), r: rectOf(el) }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const byId = new Map(els.map((e) => [e.id, e]))

  // ① duplicate-element：同 kind + 包围盒几乎相同
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const A = els[i]
      const B = els[j]
      if (A.el.elementType !== B.el.elementType) continue
      const near = Math.abs(A.r.x - B.r.x) < t.duplicateTol && Math.abs(A.r.y - B.r.y) < t.duplicateTol
        && Math.abs(A.r.w - B.r.w) < t.duplicateTol && Math.abs(A.r.h - B.r.h) < t.duplicateTol
      if (near) errors.push({ code: 'duplicate-element', detail: `"${A.id}" 与 "${B.id}" 几乎重合（Δ<${t.duplicateTol}px，同类型 ${A.el.elementType}）` })
    }
  }

  // ② text-over-text：两个文本元素相交（内容互压，永不可声明）
  const texts = els.filter((e) => e.el.elementType === 'text')
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (intersects(texts[i].r, texts[j].r, t.overlapTol)) {
        errors.push({ code: 'text-over-text', detail: `文本 "${texts[i].id}" 与 "${texts[j].id}" 相互遮挡（内容互压不可声明，请调整布局）` })
      }
    }
  }

  // ③ line-through-box：线穿过**非端点盒子**的内部
  //    只看"盒子"：shape/image/table，排除 decoration；排除**容器**（自己声明了 contains 的元素——
  //    线在容器内部是正常的）。注意：**不能**把"容器的子元素"也排除掉，否则箭头/穿盒检查会漏掉真正的节点盒。
  const boxes = els.filter((e) => ['shape', 'image', 'table'].includes(e.el.elementType)
    && e.el.role !== 'decoration' && !(Array.isArray(e.el.contains) && e.el.contains.length > 0))
  for (const line of els.filter((e) => e.el.elementType === 'line')) {
    const pts = Array.isArray(line.el.points) ? line.el.points : []
    if (pts.length < 2) continue
    const attachRefs = new Set()
    for (const end of ['from', 'to']) {
      const ref = line.el.attach?.[end]?.ref
      if (ref !== undefined) attachRefs.add(String(ref))
    }
    for (const box of boxes) {
      if (box.id === line.id || attachRefs.has(box.id)) continue
      for (let k = 0; k + 1 < pts.length; k++) {
        if (segmentCrossesRect(pts[k], pts[k + 1], box.r, t.tol)) {
          errors.push({ code: 'line-through-box', detail: `线 "${line.id}" 穿过 "${box.id}" 内部` })
          break
        }
      }
    }
  }

  // ④ arrow-not-on-edge：带箭头但端点没接触任何元素边界（无 attach 时仅告警）
  for (const line of els.filter((e) => e.el.elementType === 'line')) {
    if (!line.el.arrow) continue
    const pts = Array.isArray(line.el.points) ? line.el.points : []
    if (pts.length < 2) continue
    const tips = []
    if (line.el.arrow === 'both') tips.push(pts[0], pts[pts.length - 1])
    else tips.push(pts[pts.length - 1])
    for (const tip of tips) {
      const touches = boxes.some((b) => onSide('left', tip, b.r, t.tol) || onSide('right', tip, b.r, t.tol)
        || onSide('top', tip, b.r, t.tol) || onSide('bottom', tip, b.r, t.tol))
      if (!touches) {
        const hasAttach = line.el.attach !== undefined
        const detail = `线 "${line.id}" 的箭头端未落在任何元素边界（tol=${t.tol}）`
        if (hasAttach) errors.push({ code: 'arrow-not-on-edge', detail: `${detail}——已声明 attach，属声明不成立` })
        else warnings.push({ code: 'arrow-not-on-edge', detail: `${detail}，可能脱靶` })
      }
    }
  }

  return { errors, warnings }
}

/**
 * `attach` → 坐标解析（阶段 A-④ 集成的核心，docs/08 §1.1）。
 *
 * 语义：**`attach` 优先于手写 `points`**——被改写的端点必须**另行提示**（不能安静地覆盖作者的写法）。
 * 为什么需要它：作者写"从 A 的右边连到 B 的左边"时不该手算像素；元素一动，手算坐标就错。
 * 解析后导出侧只认 `points`（导出器保持纯写盘层），几何仍由 relations 的反验证兜底。
 *
 * 锚点算法：把"另一端"投影到目标边的线段上并夹到线段范围内（最短连线，视觉上最自然）。
 * 纯函数、确定性、不改输入。
 *
 * @param {object} el 线元素（原始 DSL 或归一化元素均可）
 * @param {Map|object} pageOrMap 页面（或 id→元素 的 Map），用于查 ref 的几何
 * @returns {{points: Array<[number,number]>|null, notes: string[], overridden: number}}
 */
export function resolveAttach(el, pageOrMap, opts = {}) {
  const t = { ...RELATION_DEFAULTS, ...(opts.tolerance ?? {}) }
  const src = Array.isArray(el?.points) ? el.points : null
  const copy = src ? src.map((p) => [Number(p[0]), Number(p[1])]) : null
  const a = el?.attach
  if (!a) return { points: copy, notes: [], overridden: 0 }
  const els = pageOrMap instanceof Map ? pageOrMap : indexElements(pageOrMap ?? {})
  const notes = []
  let overridden = 0

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  /** 目标边上、离 `toward` 最近的锚点（兜底：轴对齐夹紧）。 */
  const clampOnSide = (rect, side, toward) => {
    const [tx, ty] = toward
    if (side === 'left') return [rect.x, clamp(ty, rect.y, rect.bottom)]
    if (side === 'right') return [rect.right, clamp(ty, rect.y, rect.bottom)]
    if (side === 'top') return [clamp(tx, rect.x, rect.right), rect.y]
    if (side === 'bottom') return [clamp(tx, rect.x, rect.right), rect.bottom]
    return [tx, ty]
  }
  /**
   * 自然锚点：从**另一端**指向目标矩形中心，与该边的交点（保持线的自然方向）。
   * 交点落在边线段外 ⇒ 返回 null，交回兜底夹紧（等价于落在最近的角）。
   */
  const hitSide = (from, toward, rect, side) => {
    const [x1, y1] = from
    const [x2, y2] = toward
    const dx = x2 - x1
    const dy = y2 - y1
    const vertical = side === 'left' || side === 'right'
    const target = side === 'left' ? rect.x : side === 'right' ? rect.right : side === 'top' ? rect.y : rect.bottom
    const denom = vertical ? dx : dy
    if (Math.abs(denom) < 1e-9) return null
    const t = (target - (vertical ? x1 : y1)) / denom
    const hx = x1 + t * dx
    const hy = y1 + t * dy
    if (vertical) return (hy >= rect.y - t.tol && hy <= rect.bottom + t.tol) ? [target, clamp(hy, rect.y, rect.bottom)] : null
    return (hx >= rect.x - t.tol && hx <= rect.right + t.tol) ? [clamp(hx, rect.x, rect.right), target] : null
  }
  /**
   * 解析一个端点的锚点：
   * **作者已经写在目标边上（容差内）⇒ 原样保留**（不做无谓改写、不产生噪音提示）；
   * 否则才按"另一端 → 目标中心"的自然连线求边交点，交点不在边线段上时退化为最近角。
   */
  const anchorFor = (rect, side, toward, keep) => {
    if (Array.isArray(keep) && onSide(side, keep, rect, t.tol)) return [keep[0], keep[1]]
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    return hitSide(toward, [cx, cy], rect, side) ?? clampOnSide(rect, side, toward)
  }

  // 没有手写 points 时，用两端锚点造一条（attach 足以定义一条线）
  const out = copy && copy.length >= 2 ? copy : [[0, 0], [0, 0]]
  const last = out.length - 1
  // 先算 to（用它作为 from 的朝向参考），再算 from —— 两侧同时给出时才互相参考
  const refFrom = els.get(String(a.from?.ref ?? ''))
  const refTo = els.get(String(a.to?.ref ?? ''))
  const anchorOf = (spec, ref, toward, keep) => {
    if (!spec || !ref) return null
    const side = String(spec.side)
    if (!ATTACH_SIDES.includes(side)) return null
    return anchorFor(rectOf(ref), side, toward, keep)
  }
  const towardTo = copy && copy.length >= 2 ? copy[0] : [out[0][0], out[0][1]]
  const towardFrom = copy && copy.length >= 2 ? copy[last] : [out[last][0], out[last][1]]
  const toAnchor = anchorOf(a.to, refTo, towardTo, copy ? copy[last] : null)
  const fromAnchor = anchorOf(a.from, refFrom, toAnchor ?? towardFrom, copy ? copy[0] : null)

  const apply = (idx, anchor, end) => {
    if (!anchor) return
    const before = [out[idx][0], out[idx][1]]
    const d = Math.hypot(before[0] - anchor[0], before[1] - anchor[1])
    out[idx] = [anchor[0], anchor[1]]
    // 手写坐标与解析结果不一致（> 容差）⇒ 记为"被改写"并提示（静默覆盖是不可接受的）
    if (copy && d > t.tol) {
      overridden++
      notes.push(`${end} 端手写坐标 [${Math.round(before[0])}, ${Math.round(before[1])}] 与 attach 解析结果 [${Math.round(anchor[0])}, ${Math.round(anchor[1])}] 不一致（相差 ${d.toFixed(1)}px）⇒ 按 attach 覆盖`)
    }
  }
  apply(0, fromAnchor, 'from')
  apply(last, toAnchor, 'to')
  // 退化保护：解析后两端重合 ⇒ 无向线，明确报出来（不静默产出零长度线）
  if (out.length === 2 && out[0][0] === out[1][0] && out[0][1] === out[1][1]) notes.push('解析后两端点重合（零长度线）——请检查 attach 的 ref/side')
  return { points: out, notes, overridden }
}

/** 报告用一行摘要（A-③ 集成进 ppt_verify 时会用）。 */
export function summaryLine(rel) {
  const s = rel.stats
  const parts = [`组 ${s.groups}`, `包含 ${s.contains}`, `附着 ${s.attach}`, `徽章 ${s.badge}`, `有意重叠 ${s.overlapDecl}`]
  return `结构关系：${parts.join('｜')}（自动豁免重叠 ${s.exempt} 处，未落盘）`
}

/** 未做几何反验证的 byId 查询（供 verify 集成使用）。 */
export function elementMap(page) {
  return indexElements(page)
}
