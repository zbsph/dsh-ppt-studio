#!/usr/bin/env node
/**
 * 1.0.0 发布前预检（preflight）：
 * 在 smoke（139 断言）之外补"鲁棒性/边界/重复调用/性能"簇——坏输入不崩溃、防呆到位、
 * 幂等成立、百页仍快、媒体/几何元组经 splice 链路不坏。
 * 独立于 smoke 运行：`node scripts/preflight-1.0.mjs`（全绿方可用于发布）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolveDeck, PptError } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { verifyDeck } from '../lib/verify.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { zipRead, decodeXml } from '../lib/zips.js'
import { spliceIntoSource, sliceSource } from '../lib/splice.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? `  — ${extra}` : ''}`)
  cond ? pass++ : fail++
}
const fixture = async (name, deckYaml, pages) => {
  const dir = join(tmpdir(), `ppt-preflight-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(join(dir, 'pages'), { recursive: true })
  await writeFile(join(dir, 'deck.yaml'), deckYaml)
  for (const [ref, text] of Object.entries(pages)) await writeFile(join(dir, ref), text)
  return dir
}
const rmFixture = (dir) => rm(dir, { recursive: true, force: true }).catch(() => {})

// ── A. 坏输入不崩溃 ─────────────────────────────────────────────
{
  // A1 无 deck.yaml
  let e1 = null
  try { await resolveDeck(join(tmpdir(), 'no-such-deck-xx')) } catch (e) { e1 = e }
  ok('A1 缺 deck.yaml → 明确报错（非崩溃）', e1 !== null && /deck\.yaml not found/.test(String(e1)),
    String(e1).slice(0, 40))
  // A2 空 pages（1.0.0 拦截：0 页会产出打不开的 pptx）
  const d2 = await fixture('empty', ['version: 1', 'title: empty', 'size: [960, 540]', 'pages: []', ''].join('\n'), {})
  let e2 = null
  try { await resolveDeck(d2) } catch (e) { e2 = e }
  ok('A2 空 pages → 拦截（防静默产 0 页 pptx）', e2 !== null && /at least 1 page/.test(String(e2)),
    e2 ? 'blocked' : 'NOT BLOCKED (bug)')
  await rmFixture(d2)
  // A3 YAML 语法错误 → B2 指引
  const d3 = await fixture('badyaml', ['version: 1', 'title: x', 'size: [960, 540]', 'pages:', '  - pages/01.yaml', ''].join('\n'),
    { 'pages/01.yaml': ['pageType: content', 'elements: [', ''].join('\n') })
  let e3 = null
  try { await resolveDeck(d3) } catch (e) { e3 = e }
  ok('A3 页面 YAML 语法错误 → 提示（非 JSON 狗血堆栈）', e3 !== null && /YAML 解析失败/.test(String(e3)),
    String(e3).slice(0, 60))
  await rmFixture(d3)
  // A4 expectedOverlaps 指向不存在 id → 防呆（1.0.0 新增）
  const d4 = await fixture('ghostid', ['version: 1', 'title: x', 'size: [960, 540]', 'pages:', '  - pages/01.yaml', ''].join('\n'),
    { 'pages/01.yaml': ['pageType: content', 'elements:', '  - elementId: a', '    elementType: text', '    bounds: [10, 20, 100, 30]', '    content: {text: "hi"}', 'expectedOverlaps:', '  - {pair: [a, ghost]}', ''].join('\n') })
  let e4 = null
  try { await resolveDeck(d4) } catch (e) { e4 = e }
  ok('A4 expectedOverlaps id 防呆（ghost 元素 → 报错）', e4 !== null && /ghost.*不是本页元素 id/.test(String(e4)),
    e4 ? 'blocked' : 'NOT BLOCKED (bug)')
  await rmFixture(d4)
  // A5 极长文本（2000 字）不崩溃
  const longText = '标'.repeat(2000)
  const d5 = await fixture('long', ['version: 1', 'title: x', 'size: [960, 540]', 'pages:', '  - pages/01.yaml', ''].join('\n'),
    { 'pages/01.yaml': [`pageType: content`, 'elements:', '  - elementId: t', '    elementType: text', '    bounds: [10, 20, 200, 60]', `    content: {text: ${JSON.stringify(longText)}, fontSize: 14}`, ''].join('\n') })
  let e5 = null
  let v5 = null
  try {
    const c = await resolveDeck(d5)
    const r = await renderDeck(c, {})
    v5 = verifyDeck(r.layout)
  } catch (e) { e5 = e }
  ok('A5 2000 字文本 → 渲染/校验不崩溃（估算保守报溢出）', e5 === null && v5 !== null && v5.text.includes('text-overflow'),
    e5 ? String(e5).slice(0, 60) : '')
  await rmFixture(d5)
  // A6 零元素页面 → 审阅无断言错误
  const d6 = await fixture('noel', ['version: 1', 'title: x', 'size: [960, 540]', 'pages:', '  - pages/01.yaml', ''].join('\n'),
    { 'pages/01.yaml': ['pageType: content', '', ''].join('\n') })
  let e6 = null
  try {
    const c = await resolveDeck(d6)
    const r = await renderDeck(c, {})
    const t = verifyDeck(r.layout).text
    if (/✗/.test(t)) e6 = new Error('unexpected errors in empty page')
  } catch (e) { e6 = e }
  ok('A6 空页面 → 渲染/校验正常（无断言崩溃）', e6 === null, '')
  await rmFixture(d6)
}

// ── B. 边界形态 ─────────────────────────────────────────────────
{
  // B1 单页 deck 全链路（render → verify → export → zip 有 1 张 slide）
  const d1 = await fixture('single', ['version: 1', 'title: single', 'size: [960, 540]',
    'theme: {colors: {ink: "#3E4E63"}, textStyles: {body: {fontSize: 14, color: "$ink"}}}',
    'pages:', '  - pages/01.yaml', ''].join('\n'),
    { 'pages/01.yaml': ['pageType: content', 'elements:', '  - elementId: t', '    elementType: text', '    bounds: [10, 20, 300, 40]', '    content: {text: "单页文档", style: "$body"}', ''].join('\n') })
  let b1 = null
  try {
    const c = await resolveDeck(d1)
    await renderDeck(c, {})
    const r = await exportPptx(c, { out: join(d1, 'out.pptx'), engine: 'pptd' })
    const z = zipRead(await readFile(r.file))
    const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    if (slides.length !== 1) b1 = new Error(`slides=${slides.length}`)
  } catch (e) { b1 = e }
  ok('B1 单页 deck → export 恰 1 张 slide', b1 === null, b1 ? String(b1) : '')
  await rmFixture(d1)
  // B2 wrap=false 水平溢出门禁
  const d2 = await fixture('wrap', ['version: 1', 'title: x', 'size: [960, 540]', 'pages:', '  - pages/01.yaml', ''].join('\n'),
    { 'pages/01.yaml': ['pageType: content', 'elements:', '  - elementId: t', '    elementType: text', '    bounds: [10, 20, 100, 30]', '    content: {text: "这是一段非常长的文本用来触发水平溢出判断", fontSize: 14, wrap: false}', ''].join('\n') })
  let b2 = null
  try {
    const c = await resolveDeck(d2)
    const r = await renderDeck(c, {})
    if (!verifyDeck(r.layout).text.includes('水平溢出')) b2 = new Error('no horizontal overflow error')
  } catch (e) { b2 = e }
  ok('B2 wrap=false 水平溢出 → 门禁 error', b2 === null, b2 ? String(b2) : '')
  await rmFixture(d2)
}

// ── C. 幂等 / 重复调用 ──────────────────────────────────────────
{
  // C1 同一导出路径写两次（覆盖）→ 成功且 zip 可读
  const d1 = await fixture('idem', ['version: 1', 'title: idem', 'size: [960, 540]', 'pages:', '  - pages/01.yaml', ''].join('\n'),
    { 'pages/01.yaml': ['pageType: content', 'elements:', '  - elementId: t', '    elementType: text', '    bounds: [10, 20, 200, 40]', '    content: {text: "幂等"}', ''].join('\n') })
  let c1 = null
  try {
    const c = await resolveDeck(d1)
    await exportPptx(c, { out: join(d1, 'x.pptx'), engine: 'pptd' })
    const r = await exportPptx(c, { out: join(d1, 'x.pptx'), engine: 'pptd' })
    const z = zipRead(await readFile(r.file))
    if (!z.has('ppt/presentation.xml')) c1 = new Error('rewritten zip unreadable')
  } catch (e) { c1 = e }
  ok('C1 同路径导出两次（覆盖）→ 产物可读', c1 === null, c1 ? String(c1) : '')
  await rmFixture(d1)
}

// ── D. 性能上限（100 页渲染 < 10s）───────────────────────────────
{
  const pagesRefs = []
  const pages = {}
  for (let i = 1; i <= 100; i++) {
    pagesRefs.push(`  - pages/${String(i).padStart(2, '0')}.yaml`)
    pages[`pages/${String(i).padStart(2, '0')}.yaml`] = [
      'pageType: content', 'elements:',
      '  - elementId: t', '    elementType: text', '    bounds: [60, 60, 400, 40]',
      `    content: {text: "第 ${i} 页 / 性能基线样本 0123456789"}`, ''].join('\n')
  }
  const d = await fixture('perf', ['version: 1', 'title: perf', 'size: [960, 540]', 'pages:', ...pagesRefs, ''].join('\n'), pages)
  let d1 = null
  let ms = 0
  try {
    const c = await resolveDeck(d)
    const t0 = Date.now()
    const r = await renderDeck(c, {})
    ms = Date.now() - t0
    if (r.htmlFiles.length !== 100) d1 = new Error(`html=${r.htmlFiles.length}`)
  } catch (e) { d1 = e }
  ok('D1 100 页渲染 < 10s（性能上限）', d1 === null && ms < 10000, `${ms}ms`)
  await rmFixture(d)
}

// ── E. 媒体元组经 splice 链路不坏（image 页 → splice 进 seed）─────
{
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const d = await fixture('media', ['version: 1', 'title: media', 'size: [960, 540]',
    'theme: {colors: {ink: "#3E4E63"}, textStyles: {body: {fontSize: 14, color: "$ink"}}}',
    'pages:', '  - pages/01.yaml', '  - pages/02.yaml', ''].join('\n'),
    {
      'pages/01.yaml': ['pageType: content', 'elements:', '  - elementId: img', '    elementType: image', '    bounds: [10, 20, 120, 90]', '    src: "media/dot.png"', '    fit: cover', ''].join('\n'),
      'pages/02.yaml': ['pageType: content', 'elements:', '  - elementId: t', '    elementType: text', '    bounds: [10, 20, 200, 40]', '    content: {text: "第二页"}', ''].join('\n'),
    })
  await mkdir(join(d, 'media'), { recursive: true })
  await writeFile(join(d, 'media', 'dot.png'), tinyPng)
  let e1 = null
  let spl = null
  try {
    const c = await resolveDeck(d)
    const seed = await exportPptx(c, { out: join(d, 'seed.pptx'), engine: 'pptd' })
    spl = await spliceIntoSource({ deckDir: d, source: seed.file, page: 1, sourcePage: 1, out: join(d, 'spliced.pptx') })
    const z = zipRead(await readFile(spl.out))
    if (!z.has('ppt/media/dot.png')) e1 = new Error('media not merged')
    if (![...z.keys()].some((k) => k.includes('_rels/slide1.xml.rels'))) e1 = e1 ?? new Error('rels missing')
    const rels = decodeXml(z.get('ppt/slides/_rels/slide1.xml.rels'))
    if (!rels.includes('ppt/media/dot.png') && !rels.includes('../media/dot.png')) e1 = e1 ?? new Error('media rel not referenced')
  } catch (e) { e1 = e }
  ok('E1 含图片页 splice → 媒体合并 + rels 引用 + 产物可读', e1 === null && spl !== null,
    e1 ? String(e1).slice(0, 120) : `${spl?.mediaAdded} added`)
  await rmFixture(d)
}

// ── F. 鲁棒性统计输出 ───────────────────────────────────────────
console.log(`\n==== 预检结果：${pass} 通过 / ${fail} 失败 ====`)
process.exit(fail > 0 ? 1 : 0)
