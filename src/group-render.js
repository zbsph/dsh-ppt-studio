/**
 * 组级裁剪渲染的**可复用核心**（阶段 C2）。
 *
 * 为什么单独成模块：`scripts/render-group.mjs`（CLI）与 `ppt_render` 工具面需要**同一套取景规则**，
 * 否则"工具看到的小图和 CLI 出的小图不一样"——审阅结论就会自相矛盾。
 *
 * 取景规则（与 CLI 一致，可推理且**有界迭代**，避免"闭包把整页拉进来"）：
 *   ① 组成员 bbox + pad ⇒ frame；
 *   ② 取**完全落在 frame 内**的元素（组内连线、边标签、其它组内装饰）；
 *   ③ 若某元素的 `contains` 目标**全部已在取景内** ⇒ 它就是"这一组的容器" ⇒ 纳入它并把 frame 扩到容纳它；
 *      然后回到 ②（这样容器内部的组标题也能进来）。最多迭代 3 轮。
 *   外层大容器的 contains 含组外元素 ⇒ 永远不满足 ③（不会被误吞）。
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

const inside = (r, f) => r && r.x >= f.x && r.y >= f.y && r.x + r.w <= f.x + f.w && r.y + r.h <= f.y + f.h

/**
 * 把一个组渲染成"隔离小图"（自己的 deck 目录 + preview）。
 * @returns {{ dir: string, groupId: string, label?: string, members: string[], bbox: object, htmlFiles: string[] }}
 */
export async function renderGroupIsolated(dir, { page = 1, group, pad = 16, outDir } = {}) {
  const ctx = await resolveDeck(dir)
  const pg = ctx.pages[page - 1]
  if (!pg) throw new Error(`第 ${page} 页不存在（共 ${ctx.pages.length} 页）`)
  const groups = pg.page.groups ?? []
  const want = String(group ?? '')
  const g = groups.find((x) => x.id === want) ?? groups.find((x) => x.id.endsWith(`_${want}`) || x.id.endsWith(want))
  if (!g) {
    const avail = groups.map((x) => x.id).join(', ') || '（本页没有组合）'
    throw new Error(`找不到组 "${want}"；本页可用组 id：${avail}`)
  }
  const src = pg.page
  const els = src.elements ?? []
  const byId = new Map(els.map((e) => [e.elementId, e]))

  const memberIds = new Set(g.members ?? [])
  const base = [...memberIds].map((id) => byId.get(id)).filter(Boolean)
  const rs = base.map(rectOf).filter(Boolean)
  if (!rs.length) throw new Error(`组 "${g.id}" 的成员在元素表里找不到（成员：${[...memberIds].join(', ')}）`)
  let frame = {
    x: Math.min(...rs.map((r) => r.x)) - pad,
    y: Math.min(...rs.map((r) => r.y)) - pad,
    w: 0, h: 0,
  }
  frame.w = Math.max(...rs.map((r) => r.x + r.w)) + pad - frame.x
  frame.h = Math.max(...rs.map((r) => r.y + r.h)) + pad - frame.y

  const picked = new Set([...memberIds].filter((id) => byId.has(id)))
  for (let round = 0; round < 3; round++) {
    let grew = false
    for (const e of els) {
      if (picked.has(e.elementId)) continue
      const r = rectOf(e)
      if (!r) continue
      // ② 完全落在 frame 内 ⇒ 纳入（组内连线、边标签、装饰）
      if (inside(r, frame)) { picked.add(e.elementId); continue }
      // ③ 容器：contains 目标全在取景内 ⇒ 纳入并把 frame 扩到容纳它
      if (Array.isArray(e.contains) && e.contains.length && e.contains.every((c) => picked.has(c))) {
        picked.add(e.elementId)
        const nx = Math.min(frame.x, r.x - pad); const ny = Math.min(frame.y, r.y - pad)
        frame = { x: nx, y: ny, w: Math.max(frame.x + frame.w, r.x + r.w + pad) - nx, h: Math.max(frame.y + frame.h, r.y + r.h + pad) - ny }
        grew = true
      }
    }
    if (!grew) break
  }

  const isolatedDir = join(outDir ?? join(dir, '.group-render'), 'isolated')
  rmSync(isolatedDir, { recursive: true, force: true })
  mkdirSync(join(isolatedDir, 'pages'), { recursive: true })
  // 只带必要的主题字段（原样透传 theme，保证小图配色/字号与整页一致）
  writeFileSync(join(isolatedDir, 'deck.yaml'), YAML.stringify({
    version: 1,
    title: `组 ${g.id} 隔离图`,
    size: ctx.size ?? [960, 540],
    theme: src.theme ?? ctx.deck?.theme ?? undefined,
    pages: ['pages/01.yaml'],
  }))
  const outEls = els.filter((e) => picked.has(e.elementId))
  writeFileSync(join(isolatedDir, 'pages', '01.yaml'), YAML.stringify({ pageType: 'content', elements: outEls }))
  const ictx = await resolveDeck(isolatedDir)
  const r = await renderDeck(ictx, { out: 'preview' })
  return {
    dir: isolatedDir,
    groupId: g.id,
    label: g.label,
    members: [...picked],
    bbox: frame,
    htmlFiles: r.htmlFiles,
  }
}
