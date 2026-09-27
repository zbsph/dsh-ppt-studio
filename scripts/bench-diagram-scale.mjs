#!/usr/bin/env node
/**
 * 150 元素规模基线（阶段 A 硬门槛之一，docs/08 §8）：`node scripts/bench-diagram-scale.mjs`
 *
 * 为什么单独一个脚本而不是塞进 smoke：**计时断言在 CI 上必然抖动**（共享 runner、冷启动），
 * 把抖动带进门禁会让"红"失去意义。所以这里做"可复跑的量化基线"，把数字写进 docs/02，
 * 由人在批次边界核对；门槛不达标时退出码 1。
 *
 * 门槛（初值，docs/08 §8）：verify ≤ 3s｜预览 HTML ≤ 1.5MB｜单页总处理 ≤ 10s
 *
 * 夹具刻意**用满阶段 A 的新能力**：1 容器 + 40 盒（各自 contains 自己的标签）+ 68 文本 + 20 线
 * （8 条 attach、6 条 3 点折线、6 条双箭头）+ 1 徽章 + 5 组（含一层嵌套）+ 2 条有意重叠声明
 * + 1 处 role 覆盖（带 roleReason）——即"最坏情况"的形状：关系多、交叉检查多、报告段最长。
 */
import { performance } from 'node:perf_hooks'
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { analyzePage, verifyDeck } from '../lib/verify.js'
import { deriveRelations, checkDiagram } from '../lib/pptd/relations.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'

const WORK = join(tmpdir(), `pptd-bench-scale-${Date.now()}`)
rmSync(WORK, { recursive: true, force: true })
mkdirSync(join(WORK, 'pages'), { recursive: true })

// ── 造 150 个元素 ────────────────────────────────────────────────────────────
const COLORS = ['#2563EB', '#0EA5E9', '#F59E0B', '#10B981', '#EF4444', '#7C3AED']
const els = []
const groups = []
const boxIds = []
let n = 0
const push = (el) => { els.push(el); n++; return el.elementId }

// 1 个容器（覆盖下面所有"内容"：盒子/标签/线/注记都在它内部 ⇒ 都能被 contains（含传递闭包）结构豁免）
push({ elementId: 'zone', elementType: 'shape', kind: 'roundRect', bounds: [20, 20, 920, 500], fill: '#F8FAFC', role: 'background' })
// 40 个盒子 + 40 个标签（标签贴在盒子内部下缘，盒子声明 contains 自己的标签）
const lineIds = []
const noteIds = []
for (let j = 0; j < 4; j++) {
  const row = []
  for (let i = 0; i < 10; i++) {
    const x = 50 + i * 88
    const y = 45 + j * 105
    const id = `box_${j}_${i}`
    push({ elementId: id, elementType: 'shape', kind: 'roundRect', bounds: [x, y, 76, 56], fill: COLORS[(i + j) % COLORS.length], line: { color: '#1F2937', width: 1 } })
    push({ elementId: `lbl_${j}_${i}`, elementType: 'text', bounds: [x + 4, y + 30, 68, 22], content: { text: `节点${j}${i}`, style: 'body' }, role: 'content' })
    // 盒子包含自己的标签（结构关系 ⇒ 盒子×标签 的重叠被豁免，而不是逐对写 expectedOverlaps）
    // 注意：push 了两个元素之后，**盒子**的数组下标是 length-2（length-3 会指到上一个标签——写夹具时踩过）
    els[els.length - 2].contains = [`lbl_${j}_${i}`]
    row.push(id)
    boxIds.push(id)
  }
  groups.push({ id: `g_row${j}`, label: `第 ${j} 行`, members: row })
}
groups.push({ id: 'g_all', label: '整块', members: ['g_row0', 'g_row1', 'g_row2', 'g_row3'] })

// 20 条线：8 条 attach（行内相邻盒子右→左）、6 条 3 点折线（落在盒子行之间的水平间隙里）、6 条双箭头
for (let k = 0; k < 8; k++) {
  const j = k % 4
  const i = k % 9
  const x1 = 50 + i * 88 + 76
  const x2 = 50 + (i + 1) * 88
  const y = 45 + j * 105 + 28
  const id = `ln_a${k}`
  push({ elementId: id, elementType: 'line', points: [[x1, y], [x2, y]], arrow: 'end', attach: { from: { ref: `box_${j}_${i}`, side: 'right' }, to: { ref: `box_${j}_${i + 1}`, side: 'left' } }, line: { color: '#1F2937', width: 1 } })
  lineIds.push(id)
}
// 折线落在盒子左侧外沿（x=40..45，盒子从 x=50 起 ⇒ 不与盒子相交），高度取行间间隙（不与盒子重叠）
for (let k = 0; k < 6; k++) {
  const y = [128, 140, 233, 245, 338, 350][k]
  const id = `ln_p${k}`
  push({ elementId: id, elementType: 'line', points: [[40, y], [45, y], [45, y - 6]], arrow: 'both', line: { color: '#7C3AED', width: 1, dash: 'dash' } })
  lineIds.push(id)
}
for (let k = 0; k < 6; k++) {
  const x = 60 + k * 140
  const id = `ln_b${k}`
  // y=423：落在最后一行盒子（底 416）与注记带（430 起）之间的空隙、容器内 ⇒ 与两者都不相交
  push({ elementId: id, elementType: 'line', points: [[x, 423], [x + 60, 423]], arrow: 'both', line: { color: '#EF4444', width: 1 } })
  lineIds.push(id)
}
// 1 个徽章（压在容器顶边，声明归属）
push({ elementId: 'chip', elementType: 'shape', kind: 'roundRect', bounds: [60, 6, 120, 28], fill: '#1F2937', badgeOf: 'zone', roleReason: '标题胶囊压在容器顶边' })
// 注记补齐到 150：12 列 × 4 行网格（宽 70 < 间距 76 ⇒ 互不重叠；全在容器内 ⇒ 可被 contains 传递闭包豁免）
for (let r = 0; r < 4; r++) {
  for (let i = 0; i < 12; i++) {
    const id = `note_${r}_${i}`
    push({ elementId: id, elementType: 'text', bounds: [30 + i * 76, 430 + r * 22, 70, 22], content: { text: `注${r}${i}`, style: 'body' } })
    noteIds.push(id)
  }
}
// 容器包含**所有**内部内容（盒子、线、注记）——这才是"容器"的语义；标签由各自的盒子声明
els.find((e) => e.elementId === 'zone').contains = [...boxIds, ...lineIds, ...noteIds]

const pageYaml = ['pageType: content', 'groups:', ...groups.flatMap((g) => [`  - id: ${g.id}`, `    label: ${g.label}`, `    members: [${g.members.join(', ')}]`]),
  'expectedOverlaps:', '  - pair: [chip, zone]', '    reason: "徽章压在容器顶边（设计意图）"',
  'elements:', ...els.map((e) => {
    const lines = [`  - elementId: ${e.elementId}`, `    elementType: ${e.elementType}`]
    if (e.bounds) lines.push(`    bounds: [${e.bounds.join(', ')}]`)
    if (e.kind) lines.push(`    kind: ${e.kind}`)
    if (e.fill) lines.push(`    fill: "${e.fill}"`)
    if (e.line) lines.push(`    line: {color: "${e.line.color}", width: ${e.line.width}${e.line.dash ? `, dash: ${e.line.dash}` : ''}}`)
    if (e.points) lines.push(`    points: [${e.points.map((p) => `[${p.join(', ')}]`).join(', ')}]`)
    if (e.arrow) lines.push(`    arrow: ${typeof e.arrow === 'string' ? `'${e.arrow}'` : e.arrow}`)
    if (e.attach) lines.push(`    attach: {from: {ref: ${e.attach.from.ref}, side: ${e.attach.from.side}}, to: {ref: ${e.attach.to.ref}, side: ${e.attach.to.side}}}`)
    if (e.role) lines.push(`    role: ${e.role}`)
    if (e.roleReason) lines.push(`    roleReason: "${e.roleReason}"`)
    if (e.badgeOf) lines.push(`    badgeOf: ${e.badgeOf}`)
    if (e.contains) lines.push(`    contains: [${e.contains.join(', ')}]`)
    if (e.content) lines.push(`    content: {text: "${e.content.text}", style: ${e.content.style}}`)
    return lines.join('\n')
  }), ''].join('\n')
writeFileSync(join(WORK, 'deck.yaml'), ['version: 1', 'title: bench-150', 'size: [960, 540]', 'theme:',
  `  colors: {primary: "#2563EB", text: "#1F2937"${COLORS.map((c, i) => `, c${i}: "${c}"`).join('')}}`, '  textStyles:',
  '    body: {fontSize: 12, color: "$text"}', 'pages:', '  - pages/01.yaml', ''].join('\n'))
writeFileSync(join(WORK, 'pages', '01.yaml'), pageYaml)

// ── 计时 ────────────────────────────────────────────────────────────────────
const t = async (fn) => { const t0 = performance.now(); const v = await fn(); return { ms: performance.now() - t0, v } }
const out = {}
const size = { width: 960, height: 540 }

const A = await t(() => resolveDeck(WORK)); out.resolveDeck = A.ms
const ctx = A.v
// 注意：renderDeck 的 `out` 是**相对 deck 目录**的相对路径（与 exportPptx 的绝对路径语义不同）
const B = await t(() => renderDeck(ctx, { out: 'preview' })); out.renderDeck = B.ms
const previewDir = join(WORK, 'preview')
const layoutPath = join(previewDir, 'layout.json')
const layout = JSON.parse(readFileSync(layoutPath, 'utf8'))
const page = layout.pages[0]
const C = await t(() => analyzePage(page, size)); out.analyzePage = C.ms
const D = await t(() => deriveRelations(page)); out.deriveRelations = D.ms
const E = await t(() => checkDiagram(page)); out.checkDiagram = E.ms
const F = await t(() => verifyDeck(layout)); out.verifyDeck = F.ms
const G = await t(() => exportPptx(ctx, { out: join(WORK, 'out.pptx') })); out.exportPptx = G.ms
const htmlBytes = readdirSync(previewDir).filter((f) => f.endsWith('.html'))
  .reduce((a, f) => a + statSync(join(previewDir, f)).size, 0)
out.previewHtmlBytes = htmlBytes
out.totalMs = out.resolveDeck + out.renderDeck + out.analyzePage + out.verifyDeck + out.exportPptx

const TH = { verify: 3000, html: 1.5 * 1024 * 1024, total: 10000 }
const checks = [
  ['元素数 = 150（夹具自证）', layout.pages[0].elements.length === 150, `elements=${layout.pages[0].elements.length}`],
  ['关系推导无错误（夹具自证：结构声明全部成立）', D.v.errors.length === 0, D.v.errors.length ? `${D.v.errors.length} 条，前 3 条：${D.v.invalid.slice(0, 3).map((x) => `${x.type}:${x.from}→${x.to}:${x.why}`).join('｜')}` : '无'],
  ['结构关系被真的用到（组/包含/附着/徽章）', D.v.stats.groups === 5 && D.v.stats.contains >= 40 && D.v.stats.attach === 16 && D.v.stats.badge === 1, JSON.stringify(D.v.stats)],
  [`verify 用时 ≤ ${TH.verify}ms`, out.verifyDeck <= TH.verify, `${out.verifyDeck.toFixed(1)}ms`],
  [`预览 HTML ≤ ${(TH.html / 1024 / 1024).toFixed(1)}MB`, htmlBytes <= TH.html, `${(htmlBytes / 1024).toFixed(0)}KB`],
  [`单页总处理 ≤ ${TH.total}ms`, out.totalMs <= TH.total, `${out.totalMs.toFixed(1)}ms`],
]
let fail = 0
console.log('==== 150 元素规模基线（阶段 A 硬门槛）====')
for (const [name, ok, detail] of checks) { if (!ok) fail++; console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`) }
console.log('\n耗时明细（ms）: ' + JSON.stringify(Object.fromEntries(Object.entries(out).filter(([k]) => k.endsWith('Ms') || k === 'htmlBytes').map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10) / 10 : v]))))
console.log('报告规模（行数）:', F.v.text.split('\n').length, '｜错误/警告:', F.v.errors.length, '/', F.v.warns.length)
// 错误码直方图（基线必须能解释每一个错误：干净夹具应当趋近 0，否则说明夹具自身有真冲突）
const hist = (list) => [...list.reduce((m, f) => m.set(f.code, (m.get(f.code) ?? 0) + 1), new Map())]
  .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c}×${n}`).join('｜')
console.log('错误码前 6:', hist(F.v.errors) || '无')
console.log('警告码前 6:', hist(F.v.warns) || '无')
rmSync(WORK, { recursive: true, force: true })
if (fail) { console.log(`\n✗ ${fail} 项未达门槛——按 docs/08 §8 需先优化再进入下一阶段`); process.exit(1) }
console.log('\n✓ 全部达标')
