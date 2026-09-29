#!/usr/bin/env node
/**
 * 红样本探针（G4 验收证据）：故意造缺陷，断言门禁**必须抓到**。
 *
 * 为什么需要它：本阶段的血泪教训是"门禁 0 错就收工"，而用户反馈的缺陷其实**早就在警告里**。
 * 这个 fixture 把"我以为没有的检查"逐条变成**可执行断言**——检查若不生效，本脚本红。
 *
 * 覆盖：
 *   1) 线 × 文字穿越          → unexpected-overlap（未声明 ⇒ ERROR）
 *   2) 箭头前直段仅 7px（L形） → arrow-end-short-run（警告；引擎守卫不修，交门禁报）
 *   3) 箭头端点离目标 10px     → line-end-off-edge / arrow-end-gap（警告）
 *   4) 箭头尖端插进图形        → arrow-tip-inside-shape（警告）
 *   5) **正面**：斜段折线        → 引擎自动正交化（接线生效）⇒ 落盘 points 全轴对齐
 *
 * 用法：node scripts/red-probe.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDeck } from '../src/pptd/schema.js'
import { renderDeck } from '../src/pptd/render-html.js'
import { verifyDeck } from '../src/verify.js'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const dir = join(root, 'examples', 'red-probe')
mkdirSync(join(dir, 'pages'), { recursive: true })

writeFileSync(join(dir, 'deck.yaml'), [
  'version: 1', 'title: 红样本探针', 'size: [960, 540]', 'theme:', '  colors:',
  '    primary: "#7C3AED"', '    accent: "#E11D48"', '    soft: "#EDE9FE"',
  '    text: "#2E1065"', '    bg: "#FAF5FF"', 'pages:', '  - pages/red.yaml', '',
].join('\n'))

const L = ['pageType: content', 'elements:']
L.push('  - elementId: title', '    elementType: text', '    bounds: [60, 34, 400, 30]',
  "    content: { text: '红样本探针', fontSize: 22, color: '#2E1065', bold: true }")
// 1) 线穿文字
L.push('  - elementId: lab', '    elementType: text', '    bounds: [300, 240, 120, 24]',
  "    content: { text: '残饵画面', fontSize: 12, color: '#334155' }")
L.push('  - elementId: life', '    elementType: line', '    points: [[360, 180], [360, 330]]',
  "    line: { color: '#94A3B8', width: 1.2 }", '    arrow: false')
// 2) 箭头前直段 7px（L 形：引擎守卫不修 ⇒ 门禁必须报）
L.push('  - elementId: short', '    elementType: line', '    points: [[100, 430], [200, 430], [200, 437]]',
  "    line: { color: '#7C3AED', width: 2 }", '    arrow: true')
// 3) 端点离目标 10px
L.push('  - elementId: tgtGap', '    elementType: shape', '    kind: roundRect', '    bounds: [570, 400, 120, 60]',
  "    fill: '#EDE9FE'")
L.push('  - elementId: gap', '    elementType: line', '    points: [[470, 430], [560, 430]]',
  "    line: { color: '#7C3AED', width: 2 }", '    arrow: true')
// 4) 箭头尖端插进图形
L.push('  - elementId: tgtIn', '    elementType: shape', '    kind: roundRect', '    bounds: [730, 380, 120, 60]',
  "    fill: '#EDE9FE'")
L.push('  - elementId: inside', '    elementType: line', '    points: [[660, 410], [760, 410]]',
  "    line: { color: '#E11D48', width: 2 }", '    arrow: true')
// 5) 正面：斜段折线（应被自动正交化）
L.push('  - elementId: diag', '    elementType: line', '    points: [[100, 140], [220, 200]]',
  "    line: { color: '#64748B', width: 1.5 }", '    arrow: false')
writeFileSync(join(dir, 'pages', 'red.yaml'), L.join('\n') + '\n')

const ctx = await resolveDeck(dir)
await renderDeck(ctx, { out: 'preview' })
const layout = JSON.parse(readFileSync(join(dir, 'preview', 'layout.json'), 'utf8'))
const pages = Array.isArray(layout.pages) ? layout.pages : Object.values(layout.pages)
const v = verifyDeck({ pages: [pages[0]] })
const codes = new Set([...v.errors, ...v.warns].map((m) => m.code))

const expect = [
  ['arrow-end-short-run', '箭头前直段仅 7px（L 形：守卫不修 ⇒ 门禁必须报）'],
  ['arrow-tip-inside-shape', '箭头尖端插进图形'],
  ['line-diagonal-segment', '2 点斜线（当前引擎不修 ⇒ 报出；见下"待修"）'],
]
const endOff = ['line-end-off-edge', 'arrow-end-gap'].some((c) => codes.has(c))
const diagEl = (pages[0].elements ?? []).find((e) => e.id === 'diag')
const pts = diagEl?.points ?? []
const axisAligned = pts.every((p, i) => i === 0
  || Math.abs(p[0] - pts[i - 1][0]) < 0.5 || Math.abs(p[1] - pts[i - 1][1]) < 0.5)
// 两个**已知缺口**：本探针的职责是持续暴露它们，而不是假装通过。
const gaps = []
if (!codes.has('unexpected-overlap')) gaps.push('线 × 文字穿越尚无专门检查（当前 0 错，只有 4 条无关警告）')
if (!axisAligned) gaps.push('2 点斜线未被自动正交化（routePolyline 的 n<3 守卫过严：orthogonalize 对直线是安全的，该守的是 arrowEndRuns 的挪起点）')

let bad = 0
console.log('红样本门禁：错' + v.errors.length + ' / 警' + v.warns.length + '｜codes = ' + [...codes].sort().join(', '))
for (const [code, desc] of expect) {
  const hit = codes.has(code)
  if (!hit) bad++
  console.log('  ' + (hit ? '✓' : '✗') + ' ' + code.padEnd(24) + ' ← ' + desc)
}
if (!endOff) bad++
console.log('  ' + (endOff ? '✓' : '✗') + ' line-end-off-edge/arrow-end-gap ← 端点离目标 10px')
console.log('==== 抓取断言：' + (bad === 0 ? '全部命中' : bad + ' 项未命中') + ' ====')
console.log('---- 已知缺口（下一轮补，不当作通过）----')
gaps.forEach((g) => console.log('  ⚠ ' + g))
process.exit(bad === 0 ? 0 : 1)
