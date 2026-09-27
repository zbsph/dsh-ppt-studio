#!/usr/bin/env node
/**
 * 组级裁剪渲染（阶段 B，docs/12 §7）：只把**一个组合**渲染出来看，而不是缩略整页。
 *
 * 为什么需要：整页缩略图会掩盖小尺寸缺陷（docs/07 R21）——线是否落边、标签是否压字、
 * 容器留白是否够，在 1280px 的整页图里根本看不出来。
 *
 * 做法（**不做图像裁剪**，避免引入图像库与像素误差）：
 *   ① 取该组元素的并集包围盒 bbox；
 *   ② 造一个"临时工程"：幻灯片尺寸 = bbox 尺寸，组内元素整体平移 -bbox 左上角 ⇒ 渲染结果**天然就是该组**；
 *   ③ 同时给出隔离版（只有该组）与整页版（在上下文），便于对照。
 *
 * 用法：
 *   node scripts/render-group.mjs <deckDir> --page 1 --group <组id>        # 隔离版（默认）
 *   node scripts/render-group.mjs <deckDir> --page 1 --id <元素id>          # 以某个元素为范围
 *   node scripts/render-group.mjs <deckDir> --page 1 --group <组id> --page-render   # 额外出整页版
 *   --pad <px>（默认 16）｜--out <dir>（默认 <deck>/.group-render）
 *
 * 输出：PNG（PowerPoint COM 可用时）+ 临时工程的预览 HTML（永远生成，作为无 Office 时的兜底）。
 * 注意：这是**审阅材料**，不改变 ppt_verify 的门禁判定。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, isAbsolute, basename } from 'node:path'
import YAML from 'yaml'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { findPowerPoint, renderPptxToPng } from '../lib/msrender.js'

const argv = process.argv.slice(2)
const dir = argv[0]
if (!dir || dir.startsWith('--')) {
  console.error('用法：node scripts/render-group.mjs <deckDir> --page <n> (--group <组id> | --id <元素id>) [--pad 16] [--page-render] [--out <dir>]')
  process.exit(2)
}
const flag = (name, def = undefined) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]) : def }
const pageNo = Number(flag('page', '1'))
const pad = Number(flag('pad', '16'))
const wantPage = argv.includes('--page-render')
const outDir = flag('out', join(dir, '.group-render'))

const ctx = await resolveDeck(dir)
const page = ctx.pages[pageNo - 1]
if (!page) throw new Error(`第 ${pageNo} 页不存在（共 ${ctx.pages.length} 页）`)
const src = page.page
const els = src.elements ?? []
const byId = new Map(els.map((e) => [e.elementId, e]))

// ── 目标范围：组（成员并集）或单个元素 ──
const groupId = flag('group')
const oneId = flag('id')
let memberIds = []
let label = ''
if (groupId) {
  const g = (src.groups ?? []).find((x) => x.id === groupId)
  if (!g) throw new Error(`第 ${pageNo} 页没有组 "${groupId}"（现有：${(src.groups ?? []).map((x) => x.id).join(', ') || '无'}）`)
  memberIds = g.members ?? []
  label = `组 ${groupId}${g.label ? `（${g.label}）` : ''}`
} else if (oneId) {
  if (!byId.has(oneId)) throw new Error(`第 ${pageNo} 页没有元素 "${oneId}"`)
  memberIds = [oneId]
  label = `元素 ${oneId}`
} else {
  throw new Error('必须给 --group <组id> 或 --id <元素id>（组列表可从 ppt_render 的 layout.json 或页面 YAML 的 groups 字段查看）')
}

const rectOf = (e) => {
  const b = e.bounds
  if (Array.isArray(b)) return { x: b[0], y: b[1], w: b[2], h: b[3] }
  if (b && typeof b === 'object') return { x: b.x, y: b.y, w: b.w, h: b.h }
  // line 无 bounds：由 points 推 AABB
  if (Array.isArray(e.points)) {
    const xs = e.points.map((p) => p[0]); const ys = e.points.map((p) => p[1])
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) || 1, h: Math.max(...ys) - Math.min(...ys) || 1 }
  }
  return { x: 0, y: 0, w: 1, h: 1 }
}
// 取景规则（可推理 + 有界迭代，避免"闭包把整页拉进来"）：
//   ① 组成员 bbox + pad ⇒ frame；
//   ② 取**完全落在 frame 内**的元素（组内连线、边标签、其它组内装饰）；
//   ③ 若某元素的 `contains` 目标**全部已在取景内** ⇒ 它就是"这一组的容器" ⇒ 纳入它，并把 frame 扩到容纳它；
//      然后回到 ②（这样容器内部的组标题也能进来）。最多迭代 3 轮。
//   外层大容器的 contains 含组外元素 ⇒ 永远不满足 ③（不会被误吞）。
const baseMembers = memberIds.map((id) => byId.get(id)).filter(Boolean)
if (baseMembers.length === 0) throw new Error(`${label} 没有可渲染的元素`)
const baseBoxes = baseMembers.map(rectOf)
const within = (inner, outer) => inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5
  && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5
let frame = {
  x: Math.min(...baseBoxes.map((r) => r.x)) - pad,
  y: Math.min(...baseBoxes.map((r) => r.y)) - pad,
  w: Math.max(...baseBoxes.map((r) => r.x + r.w)) - Math.min(...baseBoxes.map((r) => r.x)) + pad * 2,
  h: Math.max(...baseBoxes.map((r) => r.y + r.h)) - Math.min(...baseBoxes.map((r) => r.y)) + pad * 2,
}
const inside = new Set(memberIds)
for (let round = 0; round < 3; round++) {
  let grew = false
  for (const e of els) {
    if (inside.has(e.elementId)) continue
    if (within(rectOf(e), frame)) { inside.add(e.elementId); grew = true }
  }
  // ③ 容器判据：至少含一个已在取景内的成员；contains 目标**要么已在取景内、要么确实落在该容器内部**
  //    （组标题属于后者）；且容器本身不能离当前取景框太远（防误吞隔壁组的容器）。
  const slack = pad * 2
  const grownFrame = { x: frame.x - slack, y: frame.y - slack, w: frame.w + slack * 2, h: frame.h + slack * 2 }
  for (const e of els) {
    if (inside.has(e.elementId)) continue
    const cs = Array.isArray(e.contains) ? e.contains : []
    if (!cs.length || !cs.some((m) => inside.has(m))) continue
    const self = rectOf(e)
    if (!cs.every((m) => { const t = byId.get(m); return inside.has(m) || (t && within(rectOf(t), self)) })) continue
    if (!within(self, grownFrame)) continue
    inside.add(e.elementId)
    for (const m of cs) if (inside.has(m) === false && byId.has(m)) inside.add(m)
    grew = true
    const x0 = Math.min(frame.x, self.x)
    const y0 = Math.min(frame.y, self.y)
    frame = { x: x0, y: y0, w: Math.max(frame.x + frame.w, self.x + self.w) - x0, h: Math.max(frame.y + frame.h, self.y + self.h) - y0 }
  }
  if (!grew) break
}
const members = els.filter((e) => inside.has(e.elementId))
const boxes = members.map(rectOf)
const bbox = frame
void boxes // bbox = frame（取景框已按需扩张，含 pad）
const shift = (v, d) => Math.round((v - d) * 100) / 100

// ── 造临时工程：幻灯片尺寸 = 组包围盒；组内元素整体平移 ──
const work = join(outDir, 'isolated')
rmSync(work, { recursive: true, force: true })
mkdirSync(join(work, 'pages'), { recursive: true })
// 容器要画在节点**下面**（z-order = 数组序）：把本组容器排到最前
const containerEls = members.filter((e) => (e.contains ?? []).some((m) => inside.has(m)))
const orderedEls = [...containerEls, ...members.filter((e) => !containerEls.includes(e))]
const sub = orderedEls.map((e) => {
  const c = { ...e }
  if (Array.isArray(c.bounds)) c.bounds = [shift(c.bounds[0], bbox.x), shift(c.bounds[1], bbox.y), c.bounds[2], c.bounds[3]]
  else if (c.bounds && typeof c.bounds === 'object') c.bounds = { ...c.bounds, x: shift(c.bounds.x, bbox.x), y: shift(c.bounds.y, bbox.y) }
  if (Array.isArray(c.points)) c.points = c.points.map(([x, y]) => [shift(x, bbox.x), shift(y, bbox.y)])
  if (Array.isArray(c.contains)) {
    const kept = c.contains.filter((m) => inside.has(m))
    if (kept.length !== c.contains.length) console.log(`  · 提示：元素 ${e.elementId} 的 contains 有 ${c.contains.length - kept.length} 项组外引用，已剔除（隔离版只含本组）`)
    if (kept.length) c.contains = kept; else delete c.contains
  }
  const at = c.attach
  if (at) {
    const ok = ['from', 'to'].filter((k) => at[k] && !inside.has(at[k].ref))
    if (ok.length) { console.log(`  · 提示：元素 ${e.elementId} 的 attach.${ok.join('/')} 指向组外，已丢弃该端声明（points 已按绝对坐标平移，形状不受影响）`) }
    const kept = {}
    for (const k of ['from', 'to']) if (at[k] && inside.has(at[k].ref)) kept[k] = at[k]
    if (Object.keys(kept).length) c.attach = kept; else delete c.attach
  }
  // 媒体：隔离工程不复制外部媒体（组里有图片时会丢图，明确提示而不是静默）
  if (c.elementType === 'image') { console.log(`  · 提示：元素 ${e.elementId} 是图片，隔离版不复制媒体文件（会缺图）；要看图片请用 --page-render 出整页版`) ; }
  return c
})
const deckObj = { version: 1, title: `group-${groupId ?? oneId}`, size: [Math.round(bbox.w), Math.round(bbox.h)], theme: ctx.deck?.theme ?? {}, pages: ['pages/01.yaml'] }
writeFileSync(join(work, 'deck.yaml'), YAML.stringify(deckObj))
const groups = (src.groups ?? []).filter((g) => g.id === groupId && (g.members ?? []).every((m) => inside.has(m)))
writeFileSync(join(work, 'pages', '01.yaml'), YAML.stringify({ pageType: src.pageType ?? 'content', ...(groups.length ? { groups } : {}), elements: sub }))

console.log(`==== 组级裁剪渲染 ====`)
console.log(`来源：第 ${pageNo} 页（${page.name}）的「${label}」｜成员 ${memberIds.length} 个｜bbox = [${Math.round(bbox.x)}, ${Math.round(bbox.y)}, ${Math.round(bbox.w)}×${Math.round(bbox.h)}]（已外扩 pad=${pad}）`)
console.log(`**这是第 ${pageNo} 页的某个组合的局部图，不是整页**（整页缩略图会掩盖线落边/压字/留白这类小尺寸缺陷）`)

const ctxIso = await resolveDeck(work)
await renderDeck(ctxIso, { out: 'preview' })
const iso = await exportPptx(ctxIso, { out: join(work, 'isolated.pptx') })
console.log(`隔离版：${sub.length} 个元素 → ${basename(iso.file)}｜parity.ok = ${iso.parity?.ok}｜预览 HTML：${join(work, 'preview', 'index.html')}`)

let png = null
if (findPowerPoint()) {
  const shot = await renderPptxToPng(iso.file, join(work, 'shots'), { pages: [1], width: Math.max(640, Math.round(bbox.w * 2)), height: Math.max(360, Math.round(bbox.h * 2)) })
  png = shot.files?.[0] ?? null
  console.log(`隔离版 PNG：${png}`)
} else {
  console.log('隔离版 PNG：本机没有 PowerPoint ⇒ 跳过（预览 HTML 仍可用；桌面端可用 PowerPoint COM 出图）')
}

if (wantPage) {
  const full = await exportPptx(ctx, { out: join(outDir, 'page.pptx') })
  if (findPowerPoint()) {
    const shot = await renderPptxToPng(full.file, join(outDir, 'page-shots'), { pages: [pageNo] })
    console.log(`整页版 PNG（在上下文）：${shot.files?.[0]}`)
  } else {
    await renderDeck(ctx, { out: join(outDir, 'page-preview') })
    console.log(`整页版：本机没有 PowerPoint ⇒ 已生成预览 HTML：${join(outDir, 'page-preview', 'index.html')}`)
  }
}
console.log(`产物目录：${outDir}`)
