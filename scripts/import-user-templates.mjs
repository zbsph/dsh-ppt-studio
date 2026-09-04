/**
 * 批量收纳用户模板（一次性/可复用）：<目录>/*.pptx → ppt_import → registerTemplate → 清临时。
 * 全部内容（页面/媒体/预览图）复制到模板库 templates/<id>/，完成后源目录可安全删除。
 * 用法：node scripts/import-user-templates.mjs [目录]（缺省桌面 ppt模板库）
 */
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rm, mkdir, readdir } from 'node:fs/promises'
import { importPptx } from '../lib/pptd/import-pptx.js'
import { registerTemplate, listTemplates, TEMPLATES_DIR } from '../lib/templates.js'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { verifyDeck } from '../lib/verify.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = process.argv[2] ?? 'C:/Users/11867/Desktop/ppt模板库'
const work = join(root, 'examples', 'tpl-import-work')

const files = (await readdir(src)).filter((f) => /\.pptx$/i.test(f))
if (!files.length) { console.log('无 .pptx'); process.exit(0) }

const results = []
for (const f of files) {
  const pptx = join(src, f)
  const ws = join(work, f.replace(/\.pptx$/i, ''))
  console.log(`\n===== ${f} =====`)
  try {
    await rm(ws, { recursive: true, force: true })
    await mkdir(ws, { recursive: true })
    const imp = await importPptx(pptx, ws)
    console.log(`import: ${imp.pages} 页 / ${imp.media.length} 媒体 / ${imp.warnings.join('；')}`)
    const name = basename(f, '.pptx')
    const style = /论文|答辩/.test(name) ? '学术答辩' : /总结|汇报/.test(name) ? '工作总结' : /商务/.test(name) ? '商务' : '用户模板'
    const scene = /论文|答辩/.test(name) ? '毕业论文/项目答辩' : /总结|汇报/.test(name) ? '部门汇报/年终总结' : '商务演示'
    const reg = await registerTemplate(ws, { id: slug(name), name, style, scene })
    // 自验：模板工作区可校验 + 渲染（不强制 0 错误——外部导入模板为内容参照，可 autoDeclare 清理）
    const ctx = await resolveDeck(reg.dir)
    const r = await renderDeck(ctx, {})
    const v = verifyDeck(r.layout)
    const errs = v.text.split('\n').filter((l) => l.includes('[✗]')).length
    results.push({ id: reg.id, name, pages: reg.pages, media: imp.media.length, preview: reg.preview ? '✓' : '—', errs })
    console.log(`register: ${reg.id} → ${reg.dir}（${reg.pages} 页母版；verify 概要错误 ${errs} 条 [外部模板为内容参照，可 autoDeclare 清理]）`)
  } catch (e) {
    results.push({ id: '-', name: f, error: e?.message })
    console.log(`FAIL: ${e?.message}`)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}
await rm(work, { recursive: true, force: true })

console.log('\n===== 汇总 =====')
for (const r of results) console.log(`- ${r.id ?? 'FAIL'}｜${r.name}｜${r.pages ?? r.error ?? ''} ${r.preview ?? ''} ${r.errs !== undefined ? '｜verify错误 ' + r.errs : ''}`)
const final = await listTemplates()
console.log(`\n模板库现有 ${final.length} 套：${final.map((t) => t.id).join(', ')}`)
console.log(`模板库目录：${TEMPLATES_DIR}（源目录 ${src} 现可删除）`)

function slug(s) {
  return String(s).toLowerCase().replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '') || 'template'
}
