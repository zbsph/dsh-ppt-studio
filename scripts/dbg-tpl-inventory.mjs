// 模板保真度盘点（临时诊断脚本）
import { resolveDeck } from '../lib/pptd/schema.js'
import { templateWorkspace, TEMPLATES_DIR } from '../lib/templates.js'
import { readdir } from 'node:fs/promises'
for (const id of (await readdir(TEMPLATES_DIR)).filter((n) => !n.startsWith('.'))) {
  try {
    const t = await templateWorkspace(id)
    const ctx = await resolveDeck(t.dir)
    const stats = { els: 0, lines: 0, texts: 0, shapes: 0, imgs: 0 }
    for (const p of ctx.pages) {
      for (const e of p.page.elements ?? []) {
        stats.els++
        if (e.elementType === 'line') stats.lines++
        else if (e.elementType === 'text') stats.texts++
        else if (e.elementType === 'shape') stats.shapes++
        else if (e.elementType === 'image') stats.imgs++
      }
    }
    console.log(`${id}: ${ctx.pages.length}页 ${stats.els}元素 (线${stats.lines}/文${stats.texts}/形${stats.shapes}/图${stats.imgs}) media=${t.media.length}`)
  } catch (e) {
    console.log(`${id}: FAIL ${e.message}`)
  }
}
