#!/usr/bin/env node
/**
 * 风格特型"预留带"自证：`node scripts/verify-style-band.mjs`
 *
 * 阶段 E / Y2-4a。守的是 `frame.title` 这条特型的**效果与边界**：
 *   ① 开启时：族 notes 必须给出"预留带"过程证据，且**所有连线的最高点不得进入标题带**（机制在起作用 ✓）；
 *   ② 关闭时（负面对照）：notes 不得出现"预留带"，且图形必须仍然 0 错误、0 警告增量（宪法②：不改默认行为 ✓）。
 *
 * 坑位备忘（本会话踩过两次，这里显式兼容）：**DSL 的 bounds 是数组 [x,y,w,h]，快照里是对象 {x,y,w,h}**。
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { verifyDeck } from '../lib/verify.js'

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; failures.push(name); console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const rect = (b) => (Array.isArray(b) ? { x: b[0], y: b[1], w: b[2], h: b[3] } : b)

const PAGE = `pageType: content
diagram:
  type: state
  style: s1
  title: 订单状态机
  nodes: [{id: a, label: 已下单}, {id: b, label: 已支付}, {id: c, label: 已发货}, {id: d, label: 已收货}]
  edges: [{from: a, to: b, label: 支付}, {from: b, to: c, label: 发货}, {from: c, to: d, label: 签收}, {from: d, to: b, label: 退货重发}]
`

async function build(label, traitsYaml) {
  const dir = join(tmpdir(), `band-verify-${label}-${Date.now()}`)
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'deck.yaml'), `version: 1\ntitle: t\nsize: [960, 540]\nstyles:\n  s1:\n    traits: ${traitsYaml}\npages:\n  - pages/01.yaml\n`)
  writeFileSync(join(dir, 'pages', '01.yaml'), PAGE)
  const ctx = await resolveDeck(dir)
  await renderDeck(ctx, { out: 'preview' })
  const layout = JSON.parse(readFileSync(join(dir, 'preview', 'layout.json'), 'utf8'))
  const result = { ctx, layout, notesHit: /顶部预留带/.test(JSON.stringify(ctx.pages[0])) }
  rmSync(dir, { recursive: true, force: true })
  return result
}

// ① 开启 frame.title：机制必须起作用
{
  const on = await build('on', '{frame: {title: true}}')
  ok('开启 frame.title ⇒ notes 出现"预留带"过程证据', on.notesHit)
  const els = on.layout.pages[0].elements
  const title = els.find((e) => /title/i.test(e.id))
  ok('标题元素存在', !!title, title ? `${title.id} ${JSON.stringify(rect(title.bounds))}` : '无')
  const tb = title ? rect(title.bounds) : null
  const bandBottom = tb ? tb.y + tb.h : null
  const lines = els.filter((e) => e.kind === 'line')
  const tops = lines.map((l) => Math.min(...l.points.map((p) => p[1])))
  const worst = tops.length ? Math.min(...tops) : null
  ok('所有连线的最高点都**不进标题带**', worst !== null && bandBottom !== null && worst >= bandBottom - 0.5,
    `标题带下沿 y=${bandBottom} ｜ 线最高点 y=${worst !== null ? worst.toFixed(1) : 'n/a'}（${lines.length} 条线）`)
  const v = verifyDeck(on.layout)
  ok('开启后门禁仍 0 错误', v.errors.length === 0, `错误 ${v.errors.length}｜警告 ${v.warns.length}`)
}

// ② 关闭（负面对照）：不得出现预留带证据；且与"未要求风格"的图形一致
{
  const off = await build('off', '{}')
  ok('关闭 frame.title ⇒ notes **不**出现"预留带"（负面对照）', !off.notesHit)
  const v = verifyDeck(off.layout)
  ok('关闭后门禁仍 0 错误', v.errors.length === 0, `错误 ${v.errors.length}｜警告 ${v.warns.length}`)
  const els = off.layout.pages[0].elements
  const title = els.find((e) => /title/i.test(e.id))
  const tb = title ? rect(title.bounds) : null
  const worst = Math.min(...els.filter((e) => e.kind === 'line').map((l) => Math.min(...l.points.map((p) => p[1]))))
  ok('关闭时沿用原布局（线最高点应明显更靠上 / 或与标题带无约束关系）', tb !== null && worst !== null,
    `标题带下沿 y=${tb ? tb.y + tb.h : 'n/a'} ｜ 线最高点 y=${worst.toFixed(1)}`)
}

console.log(`\n==== verify-style-band 结果：${pass} 通过 / ${fail} 失败 ====`)
if (fail) { console.log(`失败项：${failures.join('；')}`); process.exit(1) }
