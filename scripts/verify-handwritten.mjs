#!/usr/bin/env node
/**
 * 手写路径自证（阶段 A3，泛用性优先）：`node scripts/verify-handwritten.mjs`
 *
 * 为什么要有这个脚本：族库再全，也总有"不属于任何族"的图；那时助手的唯一手段是**手写 elements**。
 * 本脚本用**合成夹具**证明手写路径是一等公民，而且手写也有机械反馈：
 *   ① 一张合法的"手写复杂图"（分组底板 decoration + 容器 contains + >2 点折线 + attach + 标签 + 虚线反馈回路）
 *      ⇒ **0 错误**，且折线规则**不误报**，导出 parity 自证通过；
 *   ② 斜段连接线 ⇒ 报 `line-diagonal-segment`（提示怎么改）；
 *   ③ 箭头端直段过短 ⇒ 报 `arrow-end-short-run`；
 *   ④ 刻意的斜线（环形/放射）用 `role: decoration` 声明 ⇒ **豁免、不再提示**。
 * 全部断言 0 失败则退出 0。
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { verifyDeck } from '../lib/verify.js'
import { checkLineRules } from '../lib/pptd/line-rules.js'

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; failures.push(name); console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const dir = join(tmpdir(), `pptd-handwritten-${Date.now()}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(join(dir, 'pages'), { recursive: true })
writeFileSync(join(dir, 'deck.yaml'), [
  'version: 1', 'title: 手写自由发挥', 'size: [960, 540]', 'theme:',
  // 暖色系（顺便验证"指定色系"这条泛用性诉求）
  '  colors: {primary: "#B45309", accent: "#EA580C", soft: "#FED7AA", text: "#431407", bg: "#FFFBEB"}',
  '  textStyles:', '    body: {fontSize: 14, color: "$text"}', '  line: {width: 2}',
  '  safeArea: {top: 40, bottom: 40, left: 40, right: 40}',
  'pages:', '  - pages/01.yaml', '  - pages/02.yaml', '  - pages/03.yaml', '  - pages/04.yaml', '',
].join('\n'))

// ① 合法的手写复杂图（完全不依赖任何族）
writeFileSync(join(dir, 'pages', '01.yaml'), [
  'pageType: content', 'elements:',
  '  - {elementId: band, elementType: shape, kind: roundRect, bounds: [60, 90, 840, 150], fill: "$soft", role: decoration, roleReason: 分组底板}',
  '  - {elementId: a, elementType: shape, kind: roundRect, bounds: [90, 120, 180, 90], fill: "$primary", contains: [a_lab]}',
  '  - {elementId: a_lab, elementType: text, bounds: [100, 150, 160, 30], content: {text: "采集", fontSize: 16, color: "$bg", align: center}}',
  '  - {elementId: b, elementType: shape, kind: roundRect, bounds: [390, 120, 180, 90], fill: "$primary", contains: [b_lab]}',
  '  - {elementId: b_lab, elementType: text, bounds: [400, 150, 160, 30], content: {text: "仿真", fontSize: 16, color: "$bg", align: center}}',
  '  - {elementId: c, elementType: shape, kind: roundRect, bounds: [690, 120, 180, 90], fill: "$accent", contains: [c_lab]}',
  '  - {elementId: c_lab, elementType: text, bounds: [700, 150, 160, 30], content: {text: "输出", fontSize: 16, color: "$bg", align: center}}',
  '  - elementId: e1', '    elementType: line',
  '    points: [[270, 165], [330, 165], [330, 165], [390, 165]]', '    arrow: true',
  '    attach: {from: {ref: a, side: right}, to: {ref: b, side: left}}',
  '  - elementId: e2', '    elementType: line',
  '    points: [[570, 165], [630, 165], [630, 165], [690, 165]]', '    arrow: true',
  '    attach: {from: {ref: b, side: right}, to: {ref: c, side: left}}',
  '  - elementId: fb', '    elementType: line',
  '    points: [[240, 210], [240, 300], [750, 300], [750, 210]]', '    arrow: true', '    line: {color: "$text", width: 1, dash: dash}',
  '    attach: {from: {ref: a, side: bottom}, to: {ref: c, side: bottom}}',
  '  - {elementId: fb_lab, elementType: text, bounds: [455, 305, 90, 20], content: {text: "迭代反馈", fontSize: 13, color: "$text", align: center}}',
  '',
].join('\n'))

// ② 坏折线：斜段 + 箭头端过短
writeFileSync(join(dir, 'pages', '02.yaml'), [
  'pageType: content', 'elements:',
  '  - {elementId: box, elementType: shape, kind: rect, bounds: [80, 120, 200, 90], fill: "$soft"}',
  '  - elementId: bad_diag', '    elementType: line', '    points: [[600, 120], [800, 260]]', '    arrow: true',
  '  - elementId: bad_short', '    elementType: line', '    points: [[300, 300], [515, 300], [520, 300]]', '    arrow: true',
  '',
].join('\n'))

// ③ 刻意斜线（环形语义）用 decoration 声明 ⇒ 应豁免
writeFileSync(join(dir, 'pages', '03.yaml'), [
  'pageType: content', 'elements:',
  '  - elementId: ring_a', '    elementType: line', '    points: [[200, 200], [400, 350]]', '    arrow: false',
  '    role: decoration', '    roleReason: 环形引导线的斜弦（设计意图）',
  '',
].join('\n'))

// ④ 新判据的正例与反例（用户裁定的区分：共线重叠/压框 = 缺陷；共用端点的扇出 = 标准画法）
writeFileSync(join(dir, 'pages', '04.yaml'), [
  'pageType: content', 'elements:',
  // 正例①：互不相关的两条线走成共线重叠 ⇒ 必须报 line-collinear-overlap
  '  - elementId: ov1', '    elementType: line', '    points: [[300, 380], [600, 380]]', '    arrow: false',
  '  - elementId: ov2', '    elementType: line', '    points: [[400, 380], [700, 380]]', '    arrow: false',
  // 正例②：线**压在盒子边框上** ⇒ 必须报 line-on-box-edge
  '  - {elementId: edgebox, elementType: shape, kind: rect, bounds: [200, 150, 300, 120], fill: "$soft"}',
  '  - elementId: onedge', '    elementType: line', '    points: [[200, 150], [500, 150]]', '    arrow: false',
  // 反例：从**同一锚点**出发、共线且部分重合的一对线（扇出/树状干线）⇒ 不得报共线重叠
  '  - elementId: fan_long', '    elementType: line', '    points: [[700, 430], [800, 430]]', '    arrow: false',
  '  - elementId: fan_short', '    elementType: line', '    points: [[700, 430], [750, 430]]', '    arrow: false',
  '',
].join('\n'))

const ctx = await resolveDeck(dir)
await renderDeck(ctx, { out: 'preview' })
const layout = JSON.parse(readFileSync(join(dir, 'preview', 'layout.json'), 'utf8'))
const vOf = (i) => verifyDeck({ ...layout, pages: [layout.pages[i]] })

const v1 = vOf(0)
ok('手写复杂图（非任何族）：**0 错误**（容器 contains + decoration 底板 + >2 点折线 + attach + 标签）',
  v1.errors.length === 0, v1.errors.slice(0, 3).map((e) => `${e.code}:${e.id}`).join(' | ') || '无')
ok('手写复杂图：折线规则**不误报**（箭头端直段够长、全轴对齐）',
  !v1.warns.some((w) => w.code === 'line-diagonal-segment' || w.code === 'arrow-end-short-run'),
  v1.warns.map((w) => w.code).join(',') || '无相关警告')

const v2 = vOf(1)
ok('斜段连接线 ⇒ 报 `line-diagonal-segment`（带可操作的修法）',
  v2.warns.some((w) => w.code === 'line-diagonal-segment' && /role: decoration/.test(w.message)),
  v2.warns.map((w) => w.code).join(',') || '无')
ok('箭头端直段过短（20px 内的拐点）⇒ 报 `arrow-end-short-run`',
  v2.warns.some((w) => w.code === 'arrow-end-short-run'), v2.warns.map((w) => w.code).join(',') || '无')

const v3 = vOf(2)
ok('刻意斜线用 `role: decoration` 声明 ⇒ **豁免**（不再提示，但仍是 warning 级、不阻断）',
  !v3.warns.some((w) => w.code === 'line-diagonal-segment'), v3.warns.map((w) => w.code).join(',') || '无相关警告')

const v4 = vOf(3)
ok('互不相关的两条线**共线重叠** ⇒ 报 `line-collinear-overlap`（真缺陷判据）',
  v4.warns.some((w) => w.code === 'line-collinear-overlap' && /ov1/.test(w.message) && /ov2/.test(w.message)),
  v4.warns.map((w) => w.code).join(',') || '无')
ok('线**压在盒子边框上** ⇒ 报 `line-on-box-edge`（图 4 那类缺陷的机械判据）',
  v4.warns.some((w) => w.code === 'line-on-box-edge'), v4.warns.map((w) => w.code).join(',') || '无')
ok('**共用端点**的扇出（标准树状干线）⇒ 不得报共线重叠（用户裁定：这样画更清晰）',
  !v4.warns.some((w) => w.code === 'line-collinear-overlap' && /fan/.test(w.message)),
  v4.warns.filter((w) => w.code === 'line-collinear-overlap').map((w) => w.message.slice(0, 46)).join(' ｜ ') || '无')

// ⑤ 手写路径能出成品：导出 parity 自证
const r = await exportPptx(ctx, { out: join(dir, 'hand.pptx') })
ok('手写路径能正常出成品（导出 parity.ok=true，含虚线折线与附着线）',
  r.parity?.ok === true, `attached ${r.parity?.attachedLinesOut}/${r.parity?.attachedLinesExp}｜poly ${r.parity?.polyLinesOut}/${r.parity?.polyLinesExp}`)

// ⑤ 单元级：规则函数本身（DSL 原文与 preview 快照两种字段名都要认）
ok('规则函数：DSL 原文（elementType）与 preview 快照（kind）两条路径都认得出折线',
  checkLineRules([{ elementId: 'x', elementType: 'line', points: [[0, 0], [100, 0], [105, 0]], arrow: true }]).some((w) => w.code === 'arrow-end-short-run')
  && checkLineRules([{ id: 'y', kind: 'line', points: [[0, 0], [100, 0], [105, 0]], arrow: true }]).some((w) => w.code === 'arrow-end-short-run'))

rmSync(dir, { recursive: true, force: true })
console.log(`\n==== verify-handwritten 结果：${pass} 通过 / ${fail} 失败 ====`)
if (fail) { console.log(`失败项：${failures.join('；')}`); process.exit(1) }
