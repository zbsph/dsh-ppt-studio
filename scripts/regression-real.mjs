/**
 * 真实资产回归（L1 层，非 smoke 的合成样例）：
 *  1. 19 页产能 deck（若存在）：resolveDeck → render → verify（0 错误）→ export（0 autoFit）→ zip 结构
 *  2. WPS UTF-16 fixture：import → 页数/媒体正确
 * 资产缺失时打印 skip（本机路径可配置）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { verifyDeck } from '../lib/verify.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { importPptx } from '../lib/pptd/import-pptx.js'
import { zipRead } from '../lib/zips.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REAL_DECK = process.env.PPT_REAL_DECK ?? 'D:/SharkCode/fighter_capacity/deck'
const WPS_PPTX = process.env.PPT_WPS_FIXTURE ?? join(root, 'fixtures', 'Anomaly_Detection_Figures.pptx')

let pass = 0
let fail = 0
let skip = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}
const skipNote = (name, path) => {
  console.log(`⏭ ${name}（资产缺失，跳过：${path}）`)
  skip++
}

// 1. 真实 deck（产能项目 19 页）
if (existsSync(join(REAL_DECK, 'deck.yaml'))) {
  try {
    const ctx = await resolveDeck(REAL_DECK)
    const r = await renderDeck(ctx, {})
    const v = verifyDeck(r.layout)
    const errors = v.text.split('\n').filter((l) => l.includes('[✗]')).length
    ok('真实 deck：resolveDeck + render', ctx.pages.length >= 19, `${ctx.pages.length} pages`)
    ok('真实 deck：verify 0 错误（门禁）', errors === 0, `errors=${errors}`)
    const exp = await exportPptx(ctx, { out: 'out-real-regression.pptx', engine: 'pptd' })
    ok('真实 deck：导出 0 缩字（E2 承诺）', exp.autoFit.length === 0, `autoFit=${JSON.stringify(exp.autoFit)}`)
    const parts = zipRead(await readFile(exp.file))
    ok('真实 deck：OOXML 结构完整', parts.has('[Content_Types].xml') && parts.has('ppt/presentation.xml'))
    // 表格导出回读断言（1.0.1：表格空白事故 → graphicFrame 嵌套 a:xfrm 非法结构 / 缺 tableStyleId）
    const tables = ctx.pages.flatMap((p) => (p.page.elements ?? []).filter((e) => e.elementType === 'table').map((e) => e.elementId))
    if (tables.length) {
      const slidesXml = []
      for (let i = 1; i <= ctx.pages.length; i++) slidesXml.push(parts.get(`ppt/slides/slide${i}.xml`)?.toString('utf8') ?? '')
      const badFrame = slidesXml.filter((x) => /<p:xfrm><a:xfrm>/.test(x))
      ok('真实 deck：表格 graphicFrame 无嵌套 a:xfrm', badFrame.length === 0, `违规帧=${badFrame.length}`)
      const styled = slidesXml.filter((x) => x.includes('<a:tableStyleId>'))
      ok('真实 deck：表槽含 tableStyleId', styled.length >= tables.length, `tables=${tables.length} styled=${styled.length}`)
    }
  } catch (e) {
    ok('真实 deck：全链回归', false, e?.message)
  } finally {
    const { rm } = await import('node:fs/promises')
    await rm(join(REAL_DECK, 'out-real-regression.pptx'), { force: true })
  }
} else {
  skipNote('真实 deck 回归', REAL_DECK)
}

// 2. WPS UTF-16 fixture
if (existsSync(WPS_PPTX)) {
  try {
    const outDir = join(root, 'examples', 'import-realtest-regression')
    const imp = await importPptx(WPS_PPTX, outDir)
    ok('WPS fixture：导入页数/媒体', imp.pages === 2 && imp.media.length === 2, `${imp.pages} pages, ${imp.media.length} media`)
    const ctxW = await resolveDeck(outDir)
    const rW = await renderDeck(ctxW, { out: 'preview-regression' })
    ok('WPS fixture：导入项目可渲染', rW.htmlFiles.length === 2)
  } catch (e) {
    ok('WPS fixture：导入回归', false, e?.message)
  }
} else {
  skipNote('WPS fixture 回归', WPS_PPTX)
}

console.log(`\n==== 真实回归：${pass} 通过 / ${fail} 失败 / ${skip} 跳过 ====`)
process.exit(fail > 0 ? 1 : 0)
