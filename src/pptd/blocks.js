/**
 * 阶段 D-②：组合作为**可复用块**（跨页 / 跨稿复用的最小机制）。
 *
 * 语义（docs/07 §4/§9.4）：块 = 一组元素的**拷贝**（copy 语义，不做隐式联动——改一处不影响另一处）。
 * 复用发生在 `resolveDeck` 物化阶段：把块的元素复制一份、按 `at` 平移、给 id 加前缀，
 * 并**重映射块内部的引用**（`contains` / `attach.ref` / `badgeOf` / `groups.members`）。
 * 物化后就是普通元素 ⇒ 预览 / 导出 / 校验**零改动**（与 `diagram` 物化同源）。
 *
 * 块的坐标以**块自身坐标系**给出（通常从 0,0 起）；`at` 是放在页面上的左上角。
 */

/** 平移一个矩形（兼容 [x,y,w,h] 与 {x,y,w,h}）。 */
function shiftRect(b, dx, dy) {
  if (Array.isArray(b)) return [b[0] + dx, b[1] + dy, b[2], b[3]]
  if (b && typeof b === 'object') return { ...b, x: b.x + dx, y: b.y + dy }
  return b
}

/**
 * 物化一个块。
 * @param {{elements?: Array, groups?: Array}} block
 * @param {{at?: [number, number], prefix: string}} opts
 * @returns {{elements: Array, groups: Array, idMap: Map<string,string>}}
 */
export function materializeBlock(block, { at = [0, 0], prefix }) {
  const [dx, dy] = at
  const els = block?.elements ?? []
  const idMap = new Map()
  for (const el of els) if (el?.elementId) idMap.set(String(el.elementId), `${prefix}${el.elementId}`)
  const remap = (id) => idMap.get(String(id)) ?? String(id)
  const elements = els.map((el) => {
    const c = structuredClone(el)
    c.elementId = remap(el.elementId)
    if (c.bounds) c.bounds = shiftRect(c.bounds, dx, dy)
    if (Array.isArray(c.points)) c.points = c.points.map(([x, y]) => [x + dx, y + dy])
    if (Array.isArray(c.contains)) c.contains = c.contains.map(remap)
    if (c.badgeOf !== undefined) c.badgeOf = remap(c.badgeOf)
    if (c.attach) {
      const a = { ...c.attach }
      for (const k of ['from', 'to']) if (a[k]) a[k] = { ...a[k], ref: remap(a[k].ref) }
      c.attach = a
    }
    return c
  })
  // 块自带的分组：id 加前缀、成员重映射（组 id 与元素 id 共用命名空间，必须都带前缀）
  const groups = (block?.groups ?? []).map((g) => ({
    id: `${prefix}${g.id}`,
    ...(g.label !== undefined ? { label: g.label } : {}),
    members: (g.members ?? []).map(remap),
  }))
  return { elements, groups, idMap }
}
