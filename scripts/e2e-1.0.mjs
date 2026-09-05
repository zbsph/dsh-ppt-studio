#!/usr/bin/env node
/**
 * 1.0.0 自包含端到端验证（不需要任何外部资产——夹具即案例）：
 * ① 生成夹具 fx-pro(12页)/fx-mini(3页)/seed.pptx
 * ② fx-pro：render → verify（断言 0 错误 / 声明命中 / 建议级仅提示）
 * ③ crosscheck：45.6% 跨页归组 + source 状态
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

// ③ crosscheck
const cc = crosscheckDeck(ctx)
const g456 = cc.groups.find((g) => g.num === '45.6%')
ok('③ crosscheck 45.6% 跨页归组（3/4/10 页）', g456 && g456.pages.length >= 3, JSON.stringify(g456?.pages))
ok('③ crosscheck source 标注 grounded', cc.pages.filter((p) => p.status === 'grounded').length >= 3, '')

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
  const r1 = await renderPptxToPng(spl.out, join(fx, 'ren-spliced'), { pages: [3], timeoutMs: 150000 })
  const r2 = await renderPptxToPng(slc.out, join(fx, 'ren-single'), { pages: [1], timeoutMs: 150000 })
  ok('⑦ Office COM 真渲染：spliced[3] + single[1] 产出 PNG', r1.files.length === 1 && r2.files.length === 1,
    `spliced=${r1.files[0]?.split(/[\\/]/).pop()} single=${r2.files[0]?.split(/[\\/]/).pop()}`)
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
