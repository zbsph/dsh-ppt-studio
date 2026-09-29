/**
 * 组级裁剪渲染的**可复用核心**（阶段 C2），CLI 与 `ppt_render` 工具面共用同一套语义。
 *
 * 语义（与既有 CLI 逐条等价——"纯消重、不改行为"，用元素清单 + 产物哈希比对验证）：
 *   ① 取景：组成员 bbox + pad ⇒ frame；再纳入"完全落在 frame 内"的元素；容器的 contains
 *      目标"要么已在取景内、要么确实落在容器内部"（组标题属后者）⇒ 纳入容器并把 frame 扩到容纳它。
 *      最多 3 轮；容器不得离取景框太远（slack = pad*2，防误吞隔壁组的容器）。
 *   ② 容器元素**排到数组最前**（z-order：容器画在节点下面）。
 *   ③ 坐标**整体平移**（bbox 原点 → (0,0)，两位小数）+ **页面尺寸 = 四舍五入后的 bbox**。
 *   ④ 剔除组外的 `contains` / `attach` 引用（并给出提示，不静默）；图片元素提示"不复制媒体"。
 *
 * 为什么单独成模块：工具面与 CLI 必须看到**同一份**局部图（否则审阅结论会自相矛盾）。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { resolveDeck } from './pptd/schema.js'
import { renderDeck } from './pptd/render-html.js'

/** 元素包围盒：bounds（数组或对象）优先，折线按其 points 求 AABB。 */
export function rectOf(e) {
  const b = e?.bounds
  if (Array.isArray(b)) return { x: b[0], y: b[1], w: b[2], h: b[3] }
  if (Array.isArray(e?.points) && e.points.length) {
    const xs = e.points.map((p) => p[0]); const ys = e.points.map((p) => p[1])
    const x = Math.min(...xs); const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  if (b && typeof b === 'object' && typeof b.x === 'number') return { x: b.x, y: b.y, w: b.w, h: b.h }
  return null
}

const within = (inner, outer) => inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5
  && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5

/**
 * 取景 + 造隔离工程（**不渲染**）。CLI 需要自己做导出/出图，所以把这两步分开。
 * @returns {{ work: string, ctxIso: object, ids: string[], sub: object[], bbox: object,
 *            label: string, sourceLabel: string, notes: string[], pageNo: number, pageName: string, memberCount: number }}
 */
export async function isolateGroup(dir, { page = 1, group, id: oneId, pad = 16, outDir } = {}) {
  const ctx = await resolveDeck(dir)
  const pg = ctx.pages[page - 1]
  if (!pg) throw new Error(`第 ${page} 页不存在（共 ${ctx.pages.length} 页）`)
  const src = pg.page
  const els = src.elements ?? []
  const byId = new Map(els.map((e) => [e.elementId, e]))

  // ── 目标范围：组（成员并集）或单个元素 ──
  const groups = src.groups ?? []
  let memberIds = []
  let label = ''
  let key = ''
  if (group) {
    const g = groups.find((x) => x.id === group) ?? groups.find((x) => x.id.endsWith(`_${group}`) || x.id.endsWith(group))
    if (!g) throw new Error(`第 ${page} 页没有组 "${group}"（现有：${groups.map((x) => x.id).join(', ') || '无'}）`)
    memberIds = g.members ?? []
    label = `组 ${g.id}${g.label ? `（${g.label}）` : ''}`
    key = g.id
  } else if (oneId) {
    if (!byId.has(oneId)) throw new Error(`第 ${page} 页没有元素 "${oneId}"`)
    memberIds = [oneId]
    label = `元素 ${oneId}`
    key = oneId
  } else {
    throw new Error('必须给 group <组id> 或 id <元素id>（组列表见 layout.json 或页面 YAML 的 groups 字段）')
  }

  const base = memberIds.map((mid) => byId.get(mid)).filter(Boolean)
  if (!base.length) throw new Error(`${label} 没有可渲染的元素`)
  const rs = base.map(rectOf).filter(Boolean)
  let frame = {
    x: Math.min(...rs.map((r) => r.x)) - pad,
    y: Math.min(...rs.map((r) => r.y)) - pad,
    w: 0, h: 0,
  }
  frame.w = Math.max(...rs.map((r) => r.x + r.w)) + pad - frame.x
  frame.h = Math.max(...rs.map((r) => r.y + r.h)) + pad - frame.y

  // ── 取景规则（② 完全落在框内；③ 容器：contains 至少一个已在框内、其余要么也在框内、
  //    要么确实落在该容器内部（组标题属后者）；容器不得离框太远；最多 3 轮）──
  const inside = new Set(memberIds.filter((mid) => byId.has(mid)))
  for (let round = 0; round < 3; round++) {
    let grew = false
    for (const e of els) {
      if (inside.has(e.elementId)) continue
      const r = rectOf(e)
      if (r && within(r, frame)) { inside.add(e.elementId); grew = true }
    }
    const slack = pad * 2
    const grown = { x: frame.x - slack, y: frame.y - slack, w: frame.w + slack * 2, h: frame.h + slack * 2 }
    for (const e of els) {
      if (inside.has(e.elementId)) continue
      const cs = Array.isArray(e.contains) ? e.contains : []
      if (!cs.length || !cs.some((m) => inside.has(m))) continue
      const self = rectOf(e)
      if (!self) continue
      if (!cs.every((m) => { const t = byId.get(m); return inside.has(m) || (t && within(rectOf(t), self)) })) continue
      if (!within(self, grown)) continue
      inside.add(e.elementId)
      for (const m of cs) if (!inside.has(m) && byId.has(m)) inside.add(m)
      grew = true
      const x0 = Math.min(frame.x, self.x)
      const y0 = Math.min(frame.y, self.y)
      frame = {
        x: x0, y: y0,
        w: Math.max(frame.x + frame.w, self.x + self.w) - x0,
        h: Math.max(frame.y + frame.h, self.y + self.h) - y0,
      }
    }
    if (!grew) break
  }

  const members = els.filter((e) => inside.has(e.elementId))
  const bbox = frame
  const shift = (v, d) => Math.round((v - d) * 100) / 100
  const notes = []

  // ── ② 容器排到最前（z-order）+ ③ 平移归零 + ④ 剔除组外引用 ──
  const containerEls = members.filter((e) => (e.contains ?? []).some((m) => inside.has(m)))
  const ordered = [...containerEls, ...members.filter((e) => !containerEls.includes(e))]
  const sub = ordered.map((e) => {
    const c = { ...e }
    if (Array.isArray(c.bounds)) c.bounds = [shift(c.bounds[0], bbox.x), shift(c.bounds[1], bbox.y), c.bounds[2], c.bounds[3]]
    else if (c.bounds && typeof c.bounds === 'object') c.bounds = { ...c.bounds, x: shift(c.bounds.x, bbox.x), y: shift(c.bounds.y, bbox.y) }
    if (Array.isArray(c.points)) c.points = c.points.map(([x, y]) => [shift(x, bbox.x), shift(y, bbox.y)])
    if (Array.isArray(c.contains)) {
      const kept = c.contains.filter((m) => inside.has(m))
      if (kept.length !== c.contains.length) notes.push(`元素 ${e.elementId} 的 contains 有 ${c.contains.length - kept.length} 项组外引用，已剔除（隔离版只含本组）`)
      if (kept.length) c.contains = kept; else delete c.contains
    }
    const at = c.attach
    if (at) {
      const outEnds = ['from', 'to'].filter((k) => at[k] && !inside.has(at[k].ref))
      if (outEnds.length) notes.push(`元素 ${e.elementId} 的 attach.${outEnds.join('/')} 指向组外，已丢弃该端声明（points 已按绝对坐标平移，形状不受影响）`)
      const kept = {}
      for (const k of ['from', 'to']) if (at[k] && inside.has(at[k].ref)) kept[k] = at[k]
      if (Object.keys(kept).length) c.attach = kept; else delete c.attach
    }
    if (c.elementType === 'image') notes.push(`元素 ${e.elementId} 是图片：隔离工程不复制媒体（会缺图）；要看图片请用 --page-render 出整页版`)
    return c
  })

  const work = join(outDir ?? join(dir, '.group-render'), 'isolated')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(join(work, 'pages'), { recursive: true })
  writeFileSync(join(work, 'deck.yaml'), YAML.stringify({
    version: 1,
    title: `group-${key}`,
    size: [Math.round(bbox.w), Math.round(bbox.h)],
    theme: ctx.deck?.theme ?? {},
    pages: ['pages/01.yaml'],
  }))
  const keptGroups = groups.filter((g) => g.id === key && (g.members ?? []).every((m) => inside.has(m)))
  writeFileSync(join(work, 'pages', '01.yaml'), YAML.stringify({
    pageType: src.pageType ?? 'content',
    ...(keptGroups.length ? { groups: keptGroups } : {}),
    elements: sub,
  }))

  const ctxIso = await resolveDeck(work)
  const ids = sub.map((e) => e.elementId)
  return {
    work, ctxIso, sub, ids,
    members: ids, // 别名：`ppt_render group=` 与 verify:handwritten 读的是 members（S2 重构时曾漏掉 ⇒ 回归）
    key, bbox, label, notes,
    sourceLabel: `第 ${page} 页（${pg.name}）的「${label}」`,
    pageNo: page, pageName: pg.name, memberCount: memberIds.length,
  }
}

/** 取景 + 渲染隔离 preview（工具面用；CLI 用 isolateGroup 自己导出/出图）。 */
export async function renderGroupIsolated(dir, opts = {}) {
  const r = await isolateGroup(dir, opts)
  const out = await renderDeck(r.ctxIso, { out: 'preview' })
  return { ...r, dir: r.work, groupId: r.key, htmlFiles: out.htmlFiles }
}
