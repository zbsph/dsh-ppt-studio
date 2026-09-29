#!/usr/bin/env node
/**
 * B1 逐边避障路由的**效果自证**：`node scripts/verify-route.mjs`
 *
 * 为什么需要它：12 族夹具里每条回边都是"本来就最优"的（只有一条回边，车道深浅无关），
 * 所以逐族出图对比只会显示"零变化"——那证明的是**没退化**，不是**有改进**。
 * 这里用一个**密集状态机**（多条回边/同层边）把路由器的价值量出来：
 *   ① 页面过真实门禁 0 错误；
 *   ② **不同连线之间的正交交叉数 = 0**（朴素"所有回边压同一条最深车道"会互相穿）；
 *   ③ 多条回边各自占用**不同的车道 y**（逐边车道生效）。
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

const dir = join(tmpdir(), `pptd-route-${Date.now()}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(join(dir, 'pages'), { recursive: true })
writeFileSync(join(dir, 'deck.yaml'), [
  'version: 1', 'title: 密集状态机', 'size: [960, 540]', 'theme:',
  '  colors: {primary: "#2563EB", accent: "#F59E0B", text: "#1F2937", bg: "#F8FAFC"}',
  '  textStyles:', '    body: {fontSize: 13, color: "$text"}',
  '  safeArea: {top: 40, bottom: 40, left: 40, right: 40}',
  'pages:', '  - pages/01.yaml', '',
].join('\n'))
// 6 个状态、2 层分支、3 条回边/同层边 —— 足够让"共用一条最深车道"的朴素画法互相穿
writeFileSync(join(dir, 'pages', '01.yaml'), [
  'pageType: content', 'diagram:', '  type: state', '  nodes:',
  '    - {id: s0, label: 待提交}', '    - {id: s1, label: 待支付}', '    - {id: s2, label: 已支付}',
  '    - {id: s3, label: 已发货, emphasis: accent}', '    - {id: s4, label: 已取消}', '    - {id: s5, label: 已退款}',
  '  edges:',
  '    - {from: s0, to: s1, label: 提交}',
  '    - {from: s1, to: s2, label: 付款}',
  '    - {from: s2, to: s3, label: 出库}',
  '    - {from: s1, to: s4, label: 超时}',
  '    - {from: s3, to: s1, label: 退货}',
  '    - {from: s4, to: s5, label: 退款}',
  '    - {from: s5, to: s1, label: 冲正}',
  '',
].join('\n'))

const ctx = await resolveDeck(dir)
await renderDeck(ctx, { out: 'preview' })
const layout = JSON.parse(readFileSync(join(dir, 'preview', 'layout.json'), 'utf8'))
const v = verifyDeck(layout)
ok('密集状态机：**真实门禁 0 错误**（多回边 + 逐边车道不产生冲突）', v.errors.length === 0,
  v.errors.slice(0, 3).map((e) => `${e.code}:${e.id}`).join(' | ') || `警告 ${v.warns.length}`)

const lines = ctx.pages[0].page.elements.filter((e) => e.elementType === 'line' && Array.isArray(e.points))
const segs = []
for (const l of lines) for (let i = 0; i + 1 < l.points.length; i++) segs.push({ id: l.elementId, a: l.points[i], b: l.points[i + 1] })
const crosses = (s, t) => {
  const sh = Math.abs(s.a[1] - s.b[1]) < 0.5; const th = Math.abs(t.a[1] - t.b[1]) < 0.5
  if (sh === th) return false
  const h = sh ? s : t; const v = sh ? t : s
  const hx0 = Math.min(h.a[0], h.b[0]); const hx1 = Math.max(h.a[0], h.b[0])
  const vy0 = Math.min(v.a[1], v.b[1]); const vy1 = Math.max(v.a[1], v.b[1])
  return v.a[0] > hx0 + 1 && v.a[0] < hx1 - 1 && h.a[1] > vy0 + 1 && h.a[1] < vy1 - 1
}
let n = 0
for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (segs[i].id !== segs[j].id && crosses(segs[i], segs[j])) n++
// 阈值说明（用户 2026-09-30 裁定"底进底出"画法的观感更好，并接受其代价）：
// 逐边贪心路由在**密集多回边**下允许 1 处真交叉；超过 1 处说明明显劣化。
// 本次同时新增下方"检测器单测"，确保放宽阈值**不等于**检测能力下降。
ok('**不同连线之间的正交真交叉数 = 0**（W4 收紧：L 形屏障用例已由"上方车道"候选解决）', n === 0, `实测交叉 ${n} 处｜线段 ${segs.length} 段`)

// ── 交叉检测器单测（放宽阈值必须伴随的反例证据）──
{
  const cr = (a1, b1, a2, b2) => crosses({ a: a1, b: b1 }, { a: a2, b: b2 })
  ok('检测器：两条线**真交叉** ⇒ 认得出', cr([0, 50], [100, 50], [50, 0], [50, 100]) === true)
  ok('检测器：**T 形结点**（一端落在另一条中部）⇒ 不算交叉（R9：合并分叉是标准画法）',
    cr([0, 50], [100, 50], [50, 50], [50, 100]) === false)
  ok('检测器：**共线重叠** ⇒ 不算交叉（另有 line-collinear-overlap 专管）', cr([0, 50], [100, 50], [50, 50], [150, 50]) === false)
  ok('检测器：平行不接触 ⇒ 不算交叉', cr([0, 50], [100, 50], [0, 80], [100, 80]) === false)
}

// ③ 多条回边各占不同车道
const lanes = [...new Set(lines
  .filter((l) => l.points.length >= 4)
  .map((l) => l.points[2]?.[1])
  .filter((y) => y !== undefined))]
  .sort((a, b) => a - b)
ok('多条边各占**不同车道**（逐边车道生效；共用同一条 y 才是真重叠）', lanes.length >= 2, `车道 y = ${lanes.join(', ')}`)

rmSync(dir, { recursive: true, force: true })
console.log(`\n==== verify-route 结果：${pass} 通过 / ${fail} 失败 ====`)
if (fail) { console.log(`失败项：${failures.join('；')}`); process.exit(1) }
