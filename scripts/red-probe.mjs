#!/usr/bin/env node
/**
 * 红样本探针（G4 验收证据）
 * 红：故意造缺陷，断言门禁必须抓到。
 * 绿：断言引擎**真实契约** —— 2 点斜向直连线保持直线（cxnSp）；3 点折线的斜段被正交化。
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
// 红①：线穿文字
L.push('  - elementId: lab', '    elementType: text', '    bounds: [300, 240, 120, 24]',
  "    content: { text: '残饵画面', fontSize: 12, color: '#334155' }")
L.push('  - elementId: life', '    elementType: line', '    points: [[360, 180], [360, 330]]',
  "    line: { color: '#94A3B8', width: 1.2 }", '    arrow: false')
// 红②：箭头前直段 7px（L 形：守卫不修 ⇒ 门禁报）
L.push('  - elementId: short', '    elementType: line', '    points: [[100, 430], [200, 430], [200, 437]]',
  "    line: { color: '#7C3AED', width: 2 }", '    arrow: true')
// 红③：端点离目标 10px
L.push('  - elementId: tgtGap', '    elementType: shape', '    kind: roundRect', '    bounds: [570, 400, 120, 60]',
  "    fill: '#EDE9FE'")
L.push('  - elementId: gap', '    elementType: line', '    points: [[470, 430], [560, 430]]',
  "    line: { color: '#7C3AED', width: 2 }", '    arrow: true')
// 红④：箭头尖端插进图形
L.push('  - elementId: tgtIn', '    elementType: shape', '    kind: roundRect', '    bounds: [730, 380, 120, 60]',
  "    fill: '#EDE9FE'")
L.push('  - elementId: inside', '    elementType: line', '    points: [[660, 410], [760, 410]]',
  "    line: { color: '#E11D48', width: 2 }", '    arrow: true')
// 绿①：2 点斜向直连线 —— 契约要求保持直线（cxnSp）
L.push('  - elementId: diag2', '    elementType: line', '    points: [[100, 140], [220, 200]]',
  "    line: { color: '#64748B', width: 1.5 }", '    arrow: false')
// 绿②：3 点折线含斜段 —— 契约要求被正交化
L.push('  - elementId: poly', '    elementType: line', '    points: [[600, 120], [700, 180], [760, 180]]',
  "    line: { color: '#64748B', width: 1.5 }", '    arrow: false')
writeFileSync(join(dir, 'pages', 'red.yaml'), L.join('\n') + '\n')

const ctx = await resolveDeck(dir)
await renderDeck(ctx, { out: 'preview' })
const layout = JSON.parse(readFileSync(join(dir, 'preview', 'layout.json'), 'utf8'))
const pages = Array.isArray(layout.pages) ? layout.pages : Object.values(layout.pages)
const v = verifyDeck({ pages: [pages[0]] })
const codes = new Set([...v.errors, ...v.warns].map((m) => m.code))
const get = (id) => (pages[0].elements ?? []).find((e) => e.id === id)?.points ?? []
const axisOf = (pts) => pts.every((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1][0]) < 0.5 || Math.abs(p[1] - pts[i - 1][1]) < 0.5)
const diag2 = get('diag2')
const poly = get('poly')
const endOff = ['line-end-off-edge', 'arrow-end-gap'].some((c) => codes.has(c))
const rows = [
  ['line-cross-text', codes.has('line-cross-text'), '红①：线×文字穿越（G1 新增检查）'],
  ['arrow-end-short-run', codes.has('arrow-end-short-run'), '红②：箭头前直段仅 7px'],
  ['arrow-tip-inside-shape', codes.has('arrow-tip-inside-shape'), '红④：尖端插进图形'],
  ['line-end-off-edge/gap', endOff, '红③：端点离目标 10px'],
  ['2点斜连线保持直线', diag2.length === 2 && !axisOf(diag2), '绿①：cxnSp 契约 points=' + JSON.stringify(diag2)],
  ['3点折线斜段被正交化', poly.length >= 4 && axisOf(poly), '绿②：折线契约 points=' + JSON.stringify(poly)],
]
let bad = 0
console.log('红样本门禁：错' + v.errors.length + ' / 警' + v.warns.length + '｜codes = ' + [...codes].sort().join(', '))
for (const [name, ok, desc] of rows) { if (!ok) bad++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + name.padEnd(24) + ' ← ' + desc) }
console.log('==== 抓取断言：' + (bad === 0 ? '全部命中' : bad + ' 项未命中') + ' ====')
process.exit(bad === 0 ? 0 : 1)
