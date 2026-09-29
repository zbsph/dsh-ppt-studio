#!/usr/bin/env node
/**
 * 风格特型"生效态"自证：`node scripts/verify-traits-effect.mjs`
 *
 * 阶段 E / Y2-4b。此前我写探针**崩了两次**（假设了 id 命名与 layout 结构 ✗），所以这个文件立两条规矩：
 *   ① **不假设 id 命名**：按"角色"找元素 —— 卡片=非椭圆的形状、徽标=椭圆、状态名=内容等于节点标签的文本、
 *      序号=内容是全数字的文本；
 *   ② **找不到就抛错并打印实际清单**（不再让 `undefined.x` 崩 ✗）。
 *
 * 断言覆盖四条特型的"生效态 + 负面对照"：
 *   card.shape（预设名）· label:below（文本移到卡下、contains 清空）· badge:number（圆徽 + 序号 + 标题让位、门禁 0 错误）
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { verifyDeck } from '../lib/verify.js'
import { rectOf, shapeKindOf, isShape, isText, textOf } from './lib/snapshot-compat.mjs'

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; failures.push(name); console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const PAGE = `pageType: content
diagram:
  type: state
  style: s1
  nodes: [{id: a, label: 已下单}, {id: b, label: 已支付}, {id: c, label: 已发货}]
  edges: [{from: a, to: b, label: 支付}, {from: b, to: c, label: 发货}]
`

/** 建临时 deck → resolve → render → 返回 { layout, els, verify }；结构不对就抛错并打印实际键 */
async function probe(traitsYaml) {
  const dir = join(tmpdir(), `trait-effect-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'deck.yaml'), `version: 1\ntitle: probe\nsize: [960, 540]\nstyles:\n  s1:\n    traits: ${traitsYaml}\npages:\n  - pages/01.yaml\n`)
  writeFileSync(join(dir, 'pages', '01.yaml'), PAGE)
  const ctx = await resolveDeck(dir)
  await renderDeck(ctx, { out: 'preview' })
  const layout = JSON.parse(readFileSync(join(dir, 'preview', 'layout.json'), 'utf8'))
  rmSync(dir, { recursive: true, force: true })
  const page = Array.isArray(layout.pages) ? layout.pages[0] : layout.pages?.['0']
  if (!page || !Array.isArray(page.elements)) {
    throw new Error(`探针失败：layout 结构不符合预期。layout 顶层键 = ${Object.keys(layout).join(',')}；pages 键 = ${layout.pages ? Object.keys(layout.pages).join(',') : '(无)'}`)
  }
  return { layout, els: page.elements, verify: verifyDeck(layout) }
}

/** 按角色找：找不到就抛错并把实际清单打出来（替代 undefined.x 崩溃） */
function mustFind(list, pred, what, describe = (e) => e.id ?? e.elementId) {
  const hit = list.find(pred)
  if (!hit) throw new Error(`探针失败：找不到「${what}」。实际清单：\n  ` + list.map((e) => `${describe(e)}`).join('\n  '))
  return hit
}
const shapesOf = (els) => els.filter(isShape)
const textsOf = (els) => els.filter(isText)
const cardsOf = (els) => shapesOf(els).filter((e) => shapeKindOf(e) === 'rect' || shapeKindOf(e) === 'roundRect' || shapeKindOf(e) === 'pill')
const badgesOf = (els) => shapesOf(els).filter((e) => shapeKindOf(e) === 'ellipse')
const labelTextOf = (els, text) => mustFind(textsOf(els), (e) => textOf(e).includes(text), `状态名「${text}」的文本`, (e) => `"${textOf(e).replace(/\n/g, '/')}"`)
const seqTextOf = (els) => textsOf(els).find((e) => /^\d+$/.test(textOf(e).trim()))

// ① 默认：卡 roundRect、状态名在卡内、无徽标、门禁 0 错误
{
  const a = await probe('{}')
  const card = cardsOf(a.els)[0]
  const lab = labelTextOf(a.els, '已下单')
  const c = rectOf(card.bounds)
  const l = rectOf(lab.bounds)
  ok('默认：卡片预设为 roundRect', shapeKindOf(card) === 'roundRect', shapeKindOf(card))
  ok('默认：状态名**在卡内**（垂直居中区间内）', l.y >= c.y && l.y + l.h <= c.y + c.h + 0.5, `卡 y=${c.y}..${(c.y + c.h).toFixed(1)}｜文本 y=${l.y.toFixed(1)}..${(l.y + l.h).toFixed(1)}`)
  ok('默认：无徽标、无序号', badgesOf(a.els).length === 0 && !seqTextOf(a.els))
  ok('默认：门禁 0 错误', a.verify.errors.length === 0, `错误 ${a.verify.errors.length}｜警告 ${a.verify.warns.length}`)
}

// ② card.shape: pill
{
  const b = await probe('{card: {shape: pill}}')
  ok('card.shape=pill ⇒ 卡片预设为 pill（几何未动）', cardsOf(b.els).every((e) => shapeKindOf(e) === 'pill'), cardsOf(b.els).map(shapeKindOf).join(','))
  ok('card.shape 只改绘制 ⇒ 门禁仍 0 错误', b.verify.errors.length === 0)
}

// ③ label: below
{
  const c = await probe('{label: below}')
  const card = cardsOf(c.els)[0]
  const lab = labelTextOf(c.els, '已下单')
  const cb = rectOf(card.bounds)
  const lb = rectOf(lab.bounds)
  ok('label=below ⇒ 状态名移到**卡下**', lb.y >= cb.y + cb.h, `卡底 y=${(cb.y + cb.h).toFixed(1)}｜文本顶 y=${lb.y.toFixed(1)}`)
  ok('label=below ⇒ 卡不再声明 contains（文本已出卡）', Array.isArray(card.contains) && card.contains.length === 0, JSON.stringify(card.contains))
  ok('label=below ⇒ 门禁 0 错误（文本外置后不与卡片互压）', c.verify.errors.length === 0, `错误 ${c.verify.errors.length}｜警告 ${c.verify.warns.length}`)
}

// ④ badge: number
{
  const d = await probe('{badge: number}')
  const badges = badgesOf(d.els)
  const seq = seqTextOf(d.els)
  const card = cardsOf(d.els)[0]
  const lab = labelTextOf(d.els, '已下单')
  const cb = rectOf(card.bounds)
  const bb = badges[0] ? rectOf(badges[0].bounds) : null
  const lb = rectOf(lab.bounds)
  ok('badge=number ⇒ 每张卡一个圆徽', badges.length === cardsOf(d.els).length, `${badges.length} 个圆徽 / ${cardsOf(d.els).length} 张卡`)
  ok('badge ⇒ 圆徽落在**卡内左侧预留栏**', !!bb && bb.x >= cb.x && bb.x + bb.w <= cb.x + cb.w * 0.5 && bb.y >= cb.y, bb ? JSON.stringify(bb) : '无')
  ok('badge ⇒ 序号文本为数字且从 1 起', !!seq && textOf(seq).trim() === '1', seq ? textOf(seq) : '无')
  ok('badge ⇒ 卡内标题**让出栏位**（左移 ≥ 圆徽直径）', !!bb && lb.x >= cb.x + bb.w, `卡 x=${cb.x}｜圆徽右沿=${bb ? (bb.x + bb.w).toFixed(1) : '?'}｜标题左沿=${lb.x.toFixed(1)}`)
  ok('badge ⇒ 门禁 0 错误（徽标与标题不互压）', d.verify.errors.length === 0, `错误 ${d.verify.errors.length}｜警告 ${d.verify.warns.length}`)
}

// ⑤ 负面对照：默认时标题 x 与"有徽标时"的 x 必须不同（证明让位真的发生了，而不是两边都没动）
{
  const a = await probe('{}')
  const d = await probe('{badge: number}')
  const xa = rectOf(labelTextOf(a.els, '已下单').bounds).x
  const xd = rectOf(labelTextOf(d.els, '已下单').bounds).x
  ok('负面对照：默认标题 x ≠ 带徽标标题 x（让位确实发生）', Math.abs(xd - xa) >= 8, `默认 x=${xa}｜带徽标 x=${xd}`)
}

console.log(`\n==== verify-traits-effect 结果：${pass} 通过 / ${fail} 失败 ====`)
if (fail) { console.log(`失败项：${failures.join('；')}`); process.exit(1) }
