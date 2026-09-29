#!/usr/bin/env node
/**
 * 每族真渲染验收（阶段 C 的 DoD 最后一条）：`node scripts/render-families.mjs`
 *
 * 做法：按 **`FAMILIES` 注册表**（不手抄族名，避免漂移）为每个族造一页合成夹具 → 一本多页 deck →
 * 导出 → PowerPoint COM **逐页出 PNG**（每页 = 一个族的真渲染证据）+ 每页真实门禁结论。
 * 输出：PNG 绝对路径清单（供人读图）+ 每页 0 错误确认；有任一页门禁不为 0 则退出码 1。
 *
 * 用法：`node scripts/render-families.mjs [--out <dir>] [--no-render]`（`--no-render` 只跑门禁，不出图）
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { verifyDeck } from '../lib/verify.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { FAMILIES } from '../lib/pptd/diagram-families.js'
import { findPowerPoint, renderPptxToPng } from '../lib/msrender.js'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]) : d }
const noRender = argv.includes('--no-render')
const outDir = flag('out', join(tmpdir(), `pptd-families-${Date.now()}`))

/** 每个族的合成夹具（最小但覆盖该族特征）。 */
const FIXTURE = {
  flow: { type: 'flow', direction: 'LR', nodes: [{ id: 'a', label: '采集' }, { id: 'b', label: '清洗', emphasis: 'accent' }, { id: 'c', label: '入库' }], edges: [{ from: 'a', to: 'b', label: '实时' }, { from: 'b', to: 'c', style: 'dashed' }] },
  layers: { type: 'layers', groups: [{ id: 'l1', label: '输入层', members: ['a1', 'a2'] }, { id: 'l2', label: '处理层', members: ['b1'] }, { id: 'l3', label: '输出层', members: ['c1'] }], nodes: [{ id: 'a1', label: '源A' }, { id: 'a2', label: '源B' }, { id: 'b1', label: '清洗' }, { id: 'c1', label: '看板', emphasis: 'accent' }], edges: [{ from: 'a1', to: 'b1' }, { from: 'b1', to: 'c1' }] },
  tree: { type: 'tree', title: '组织结构', nodes: [{ id: 'r', label: '总经理' }, { id: 'a', label: '研发部' }, { id: 'b', label: '市场部' }, { id: 'a1', label: '平台组' }, { id: 'a2', label: '应用组' }], edges: [{ from: 'r', to: 'a' }, { from: 'r', to: 'b' }, { from: 'a', to: 'a1' }, { from: 'a', to: 'a2' }], groups: [{ id: 'g_rd', label: '研发体系', members: ['a', 'a1', 'a2'] }] },
  matrix: { type: 'matrix', title: '优先级矩阵', cols: 3, colLabels: ['高价值', '中价值', '低价值'], rowLabels: ['低成本', '中成本'], nodes: [{ id: 'c1', label: '自动化', emphasis: 'accent' }, { id: 'c2', label: '模板库' }, { id: 'c3', label: '皮肤' }, { id: 'c4', label: '审计' }, { id: 'c5', label: '导出' }, { id: 'c6', label: '动画' }] },
  timeline: { type: 'timeline', title: '里程碑', nodes: [{ id: 'm1', label: '立项' }, { id: 'm2', label: '地基', emphasis: 'accent' }, { id: 'm3', label: '引擎' }, { id: 'm4', label: '图族' }, { id: 'm5', label: '北极星' }] },
  swimlane: { type: 'swimlane', title: '跨部门流程', groups: [{ id: 'l1', label: '业务', members: ['b1', 'b2'] }, { id: 'l2', label: '风控', members: ['r1'] }, { id: 'l3', label: '财务', members: ['f1', 'f2'] }], nodes: [{ id: 'b1', label: '提单' }, { id: 'b2', label: '复核' }, { id: 'r1', label: '评级' }, { id: 'f1', label: '放款' }, { id: 'f2', label: '归档' }], edges: [{ from: 'b1', to: 'b2' }, { from: 'b2', to: 'r1', label: '送审' }, { from: 'r1', to: 'f1' }, { from: 'f1', to: 'f2' }] },
  compare: { type: 'compare', title: '两种方案', nodes: [{ id: 'a1', label: '自研引擎' }, { id: 'a2', label: '数据可编辑' }, { id: 'a3', label: '无外部依赖' }, { id: 'b1', label: '现成工具' }, { id: 'b2', label: '上手快' }, { id: 'b3', label: '受模板限制' }], groups: [{ id: 'left', label: '方案 A：自研', members: ['a1', 'a2', 'a3'] }, { id: 'right', label: '方案 B：现成', members: ['b1', 'b2', 'b3'] }] },
  cycle: { type: 'cycle', title: '闭环反馈', nodes: [{ id: 'c1', label: '采集' }, { id: 'c2', label: '分析' }, { id: 'c3', label: '决策' }, { id: 'c4', label: '执行' }, { id: 'c5', label: '复盘' }] },
  funnel: { type: 'funnel', title: '转化漏斗', nodes: [{ id: 'v1', label: '曝光 100%' }, { id: 'v2', label: '点击 42%' }, { id: 'v3', label: '咨询 18%' }, { id: 'v4', label: '成交 6%', emphasis: 'accent' }] },
  steps: { type: 'steps', title: '五步法', nodes: [{ id: 's1', label: '定目标' }, { id: 's2', label: '拆任务' }, { id: 's3', label: '排优先级' }, { id: 's4', label: '执行' }, { id: 's5', label: '复盘' }] },
  sequence: { type: 'sequence', title: '下单时序', nodes: [{ id: 'u', label: '用户' }, { id: 'api', label: '网关' }, { id: 'pay', label: '支付' }], edges: [{ from: 'u', to: 'api', label: '提交订单' }, { from: 'api', to: 'pay', label: '发起扣款' }, { from: 'pay', to: 'api', label: '扣款成功', style: 'dashed' }, { from: 'api', to: 'u', label: '返回结果' }] },
  state: { type: 'state', title: '订单状态机', nodes: [{ id: 's0', label: '待提交' }, { id: 's1', label: '待支付' }, { id: 's2', label: '已支付' }, { id: 's3', label: '已发货', emphasis: 'accent' }, { id: 's4', label: '已取消' }], edges: [{ from: 's0', to: 's1', label: '提交' }, { from: 's1', to: 's2', label: '付款' }, { from: 's2', to: 's3', label: '出库' }, { from: 's1', to: 's4', label: '超时' }, { from: 's3', to: 's1', label: '退货' }] },
}

// 注意：`flow`/`layers` 是 diagram-ir.js 里的**遗留分支**（不在 FAMILIES 注册表里），
// 但同样是"实现对用户可见的族" ⇒ 必须一并纳入真渲染验收，否则它们没有出图证据（本轮踩过这个计数错误）。
const names = [...Object.keys(FAMILIES), 'flow', 'layers']
const missing = names.filter((n) => !FIXTURE[n])
if (missing.length) { console.error(`✗ 缺夹具的族：${missing.join(',')}（请补 FIXTURE，否则该族没有真渲染验收）`); process.exit(1) }

rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'pages'), { recursive: true })
writeFileSync(join(outDir, 'deck.yaml'), ['version: 1', 'title: family-render', 'size: [960, 540]', 'theme:',
  '  colors: {primary: "#2563EB", accent: "#B45309", soft: "#0EA5E9", text: "#1F2937", bg: "#F8FAFC"}',
  '  textStyles:', '    body: {fontSize: 13, color: "$text"}', '  spacing: {base: 22}',
  '  safeArea: {top: 40, bottom: 40, left: 40, right: 40}',
  'pages:', ...names.map((n) => `  - pages/${n}.yaml`), ''].join('\n'))
names.forEach((n, i) => {
  const d = FIXTURE[n]
  const lines = ['pageType: content', 'diagram:', `  type: ${d.type}`]
  for (const k of ['direction', 'title', 'cols', 'minRatio', 'pyramid']) if (d[k] !== undefined) lines.push(`  ${k}: ${JSON.stringify(d[k])}`)
  for (const k of ['colLabels', 'rowLabels']) if (d[k]) lines.push(`  ${k}: [${d[k].join(', ')}]`)
  lines.push('  nodes:', ...d.nodes.map((x) => `    - {id: ${x.id}, label: ${x.label}${x.emphasis ? `, emphasis: ${x.emphasis}` : ''}}`))
  if (d.edges) lines.push('  edges:', ...d.edges.map((e) => `    - {from: ${e.from}, to: ${e.to}${e.label ? `, label: ${e.label}` : ''}${e.style ? `, style: ${e.style}` : ''}}`))
  if (d.groups) lines.push('  groups:', ...d.groups.map((g) => `    - {id: ${g.id}${g.label ? `, label: ${g.label}` : ''}, members: [${g.members.join(', ')}]}`))
  writeFileSync(join(outDir, 'pages', `${n}.yaml`), `${lines.join('\n')}\n`)
})

const ctx = await resolveDeck(outDir)
await renderDeck(ctx, { out: 'preview' })
const layout = JSON.parse(readFileSync(join(outDir, 'preview', 'layout.json'), 'utf8'))
let bad = 0
console.log('==== 每族真渲染验收（12 族） ====')
names.forEach((n, i) => {
  const one = { ...layout, pages: [layout.pages[i]] }
  const v = verifyDeck(one)
  const decl = (ctx.pages[i].page.expectedOverlaps ?? []).length
  const notes = ctx.pages[i].page.diagramNotes ?? []
  const okPage = v.errors.length === 0
  if (!okPage) bad++
  console.log(`${okPage ? '✓' : '✗'} 第 ${i + 1} 页 ${n}：元素 ${ctx.pages[i].page.elements.length}｜错误 ${v.errors.length}｜警告 ${v.warns.length}｜声明 ${decl}${notes.length ? `｜notes ${notes.length}` : ''}${okPage ? '' : `｜${v.errors.map((e) => `${e.code}:${e.message}`).join(' | ')}`}`)
})

const r = await exportPptx(ctx, { out: join(outDir, 'families.pptx') })
console.log(`\n导出 parity.ok = ${r.parity?.ok}｜attached ${r.parity?.attachedLinesOut}/${r.parity?.attachedLinesExp}｜poly ${r.parity?.polyLinesOut}/${r.parity?.polyLinesExp}`)
if (!noRender) {
  if (!findPowerPoint()) {
    console.log('本机没有 PowerPoint ⇒ 跳过 COM 出图（预览 HTML 仍可用）')
  } else {
    const shot = await renderPptxToPng(r.file, join(outDir, 'shots'), { pages: names.map((_, i) => i + 1) })
    console.log(`\nPNG（每页 = 一个族，读图验收用）：`)
    shot.files.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}. ${names[i].padEnd(9)} ${f}`))
  }
}
console.log(`\n产物目录：${outDir}`)
if (bad) { console.log(`\n✗ ${bad} 个族的页面门禁未清零（先修门禁，再谈真渲染验收）`); process.exit(1) }
console.log('\n✓ 12 族页面全部 0 错误')
