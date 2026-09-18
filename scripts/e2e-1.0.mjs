#!/usr/bin/env node
/**
 * 1.0.0 自包含端到端验证（不需要任何外部资产——夹具即案例）：
 * ① 生成夹具 fx-pro(12页)/fx-mini(3页)/seed.pptx
 * ② fx-pro：render → verify（断言 0 错误 / 声明命中 / 建议级仅提示）
 * ③ crosscheck：审阅材料包（全页正文覆盖 + 不做判定；判定交审阅者）
 * ④ measure（浏览器实测兜底：无浏览器自动降级并注明）
 * ⑤ export → zip 结构（12 张 slide、无 chart 部件依赖）
 * ⑥ splice（seed 第 3 页 ← fx-pro 第 6 页）→ 仅 2 条目变化；slice → 单页
 * ⑦ Office COM（可用时）真渲染 spliced[3] / single[1]
 * ⑧ 自产 seed 再导入 → 元素 id 唯一（导入去重回环验证）
 */
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { genFixtures } from './fixtures.mjs'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { verifyDeck, measuredCrossCheck } from '../lib/verify.js'
import { crosscheckDeck } from '../lib/crosscheck.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { importPptx } from '../lib/pptd/import-pptx.js'
import { zipRead } from '../lib/zips.js'
import { spliceIntoSource, sliceSource, zipDigests } from '../lib/splice.js'
import { measureLayout } from '../lib/measurement.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? `  — ${extra}` : ''}`)
  cond ? pass++ : fail++
}

const { fx, seed, pages: seedPages } = await genFixtures()
const pro = join(fx, 'fx-pro')
const mini = join(fx, 'fx-mini')

// ② fx-pro 全链路
const ctx = await resolveDeck(pro)
const rnd = await renderDeck(ctx, {})
const v = verifyDeck(rnd.layout)
const errLines = v.text.split('\n').filter((l) => l.includes('[✗]'))
const confirmNotes = v.text.split('\n').filter((l) => l.includes('预期重叠') || l.includes('预期出界'))
ok('② fx-pro verify 门禁 0 错误（声明制夹具）', errLines.length === 0, errLines.slice(0, 6).join(' | ').slice(0, 220))
ok('② fx-pro 声明命中（预期重叠/预期出界确认出现）', confirmNotes.length > 0, `${confirmNotes.length} 条`)
const hasDecor = v.text.includes('decoration') || v.text.includes('装饰')
ok('② fx-pro 装饰豁免生效（09 页 deco 无重叠错误）', !errLines.some((l) => l.includes('deco')), '')
const v08 = v.text.split('第 8 页')[1]?.split('## 第')[0] ?? ''
ok('② fx-pro A8 场景无误报（08 页无 aesthetic-contrast——渐变深底白字不落背景）', !v08.includes('aesthetic-contrast'),
  v08.match(/aesthetic-contrast|aesthetic-theme/g)?.join(',') ?? '')

// ③ crosscheck = 内容审阅材料包（M3 重写 2026-09-18：数字必须放回整句语境，判定交审阅者）
const cc = crosscheckDeck(ctx)
const ccText = cc.pages.flatMap((p) => p.texts.map((t) => t.text)).join('\n')
ok('③ 材料包覆盖全 12 页正文（含跨页 45.6% 原句；表格/图表/讲稿/作者出处字段齐备）',
  cc.pages.length === seedPages && /45\.6%/.test(ccText)
  && cc.pages.every((p) => Array.isArray(p.texts) && Array.isArray(p.tables) && Array.isArray(p.charts)
    && Array.isArray(p.images) && typeof p.notes === 'string' && 'authorSource' in p),
  `${cc.pages.length} 页 / 正文 ${ccText.length} 字符 / 素材清单 ${cc.materials.length} 项`)
ok('③ 材料包不做判定（无 groups、无 status 状态机）——判定由审阅者按协议给出',
  cc.groups === undefined && cc.pages.every((p) => p.status === undefined),
  Object.keys(cc).join(', '))

// ④ measure（浏览器；降级则标注不判失败）
const m = await measureLayout(pro)
if (m.measured) {
  const x = measuredCrossCheck(rnd.layout, m.measured)
  const bad = x.filter((f) => ['error', 'warning'].includes(f.severity))
  ok('④ M2 实测（浏览器）→ 与估算零分歧', bad.length === 0, bad.slice(0, 3).map((f) => f.code).join(',') || `${m.pages} 页`)
} else {
  ok('④ M2 实测不可用（无浏览器/降级）——标注后继续', true, m.notes?.[0] ?? '')
}

// ⑤ export 结构
const exp = await exportPptx(ctx, { out: join(fx, 'fx-pro.pptx'), engine: 'pptd' })
const z = zipRead(await readFile(exp.file))
const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
const chartParts = [...z.keys()].filter((k) => k.startsWith('ppt/charts/'))
ok('⑤ export = 12 张 slide + 无 chart 部件（矢量拼绘）', slides.length === seedPages && chartParts.length === 0, `${slides.length} slides`)
// 连线方向自证（2026-09-14 真实反馈：预览对、PowerPoint 里线镜像/× 掉一笔）
ok('⑤ export parity 自证：表/图/线方向全绿（线逐条从 OOXML 反推端点）',
  exp.parity?.ok === true && exp.parity.linesExp > 0 && exp.parity.linesExp === exp.parity.linesOut && exp.parity.linesWrong === 0,
  JSON.stringify(exp.parity))

// ⑥ splice / slice（自产 seed：12 页同源工程）
const spl = await spliceIntoSource({ deckDir: pro, source: seed, page: 6, sourcePage: 3, out: join(fx, 'spliced.pptx') })
const sd = zipDigests(await readFile(seed))
const od = zipDigests(await readFile(spl.out))
const delta = [...sd.keys()].filter((k) => sd.get(k) !== od.get(k))
ok('⑥ splice：仅目标页 2 条目变化（其余 SHA256 一致）', delta.length === 2 && spl.unchangedCount > 0,
  `delta=${JSON.stringify(delta)} unchanged=${spl.unchangedCount}`)
const slc = await sliceSource({ source: spl.out, page: 3, out: join(fx, 'single.pptx') })
const zs = zipRead(await readFile(slc.out))
const sSingle = [...zs.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
ok('⑥ slice：仅 1 张 slide + 母版布局保留', sSingle.length === 1 && slc.masters >= 1 && slc.layouts >= 1, `m=${slc.masters} l=${slc.layouts}`)

// ⑦ Office COM（可选）
const { findPowerPoint, renderPptxToPng } = await import('../lib/msrender.js')
if (findPowerPoint()) {
  // P5 回归：多页参数 pages=[1,3] 应产出两页 PNG（此前 "4,1" 被 PS 解析成 41）
  const r1 = await renderPptxToPng(spl.out, join(fx, 'ren-spliced'), { pages: [1, 3], timeoutMs: 150000 })
  const r2 = await renderPptxToPng(slc.out, join(fx, 'ren-single'), { pages: [1], timeoutMs: 150000 })
  ok('⑦ Office COM 真渲染：spliced pages=[1,3]（多页 P5 回归）+ single[1] 产出 PNG',
    r1.files.length === 2 && r2.files.length === 1,
    `spliced=${r1.files.map((f) => f.split(/[\\/]/).pop()).join(',')} single=${r2.files[0]?.split(/[\\/]/).pop()}`)
} else {
  ok('⑦ Office COM 不可用——标注后继续', true, '无 PowerPoint')
}

// ⑧ 自产 seed 再导入 → id 唯一 + 可渲染（导入去重回环）
const reDir = join(fx, 'reimport')
const ri = await importPptx(exp.file, reDir)
const fsp = await import('node:fs/promises')
const pageFiles = (await fsp.readdir(join(reDir, 'pages'))).filter((f) => f.endsWith('.yaml'))
let dup = null
for (const f of pageFiles) {
  const txt = await readFile(join(reDir, 'pages', f), 'utf8')
  const ids = (txt.match(/elementId: .+$/gm) ?? []).map((s) => s.replace(/^.*elementId: /, '').trim())
  const seen = new Set()
  for (const id of ids) { if (seen.has(id)) { dup = id; break } seen.add(id) }
  if (dup) break
}
ok('⑧ 自产 seed 回导：无重复 elementId（导入去重 P5 有效）', dup === null, dup ? `dup=${dup}` : `${pageFiles.length} pages`)
await rm(reDir, { recursive: true, force: true })

console.log(`\n==== E2E(1.0.0) 结果：${pass} 通过 / ${fail} 失败 ====`)
process.exit(fail > 0 ? 1 : 0)
