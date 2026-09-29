/**
 * 组级裁剪渲染（CLI）。
 *
 * 取景 / 裁剪语义**全部来自 `src/group-render.js`**；本文件只负责：参数解析 → 导出 pptx →
 * PowerPoint COM 出图 → 报告。**不要在这里重复取景逻辑**——重复会让"工具看到的小图"与
 * "CLI 出的小图"不一致，审阅结论就会自相矛盾（这正是拆模块的原因）。
 *
 * 用法：
 *   node scripts/render-group.mjs <deck目录> --group <组id> [--page N] [--pad 16] [--out 目录]
 *   node scripts/render-group.mjs <deck目录> --id <元素id>   上面的参数同样适用
 *   --page-render：额外再出「整页版（带上下文）」PNG
 */
import { basename, join } from 'node:path'
import { findPowerPoint, renderPptxToPng } from '../lib/msrender.js'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { isolateGroup } from '../lib/group-render.js'

const argv = process.argv.slice(2)
const dir = argv[0]
if (!dir) {
  console.error('用法：node scripts/render-group.mjs <deck目录> --group <组id> [--page N] [--pad 16] [--out 目录] [--page-render]')
  process.exit(2)
}
const flag = (name, def = undefined) => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return def
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
const pageNo = Number(flag('page', '1'))
const pad = Number(flag('pad', '16'))
const wantPage = argv.includes('--page-render')
const outDir = flag('out', join(dir, '.group-render'))
const groupId = flag('group')
const oneId = flag('id')

const ctx = await resolveDeck(dir)
const r = await isolateGroup(dir, { page: pageNo, group: groupId, id: oneId, pad, outDir })

console.log('==== 组级裁剪渲染 ====')
console.log(`来源：${r.sourceLabel}｜成员 ${r.memberCount} 个｜bbox = [${Math.round(r.bbox.x)}, ${Math.round(r.bbox.y)}, ${Math.round(r.bbox.w)}×${Math.round(r.bbox.h)}]（已外扩 pad=${pad}）`)
console.log(`**这是第 ${pageNo} 页的某个组合的局部图，不是整页**（整页缩略图会掩盖线落边/压字/留白这类小尺寸缺陷）`)
for (const n of r.notes) console.log(`  · 提示：${n}`)

const iso = await exportPptx(r.ctxIso, { out: join(r.work, 'isolated.pptx') })
await renderDeck(r.ctxIso, { out: 'preview' })
console.log(`隔离版：${r.sub.length} 个元素 → ${basename(iso.file)}｜parity.ok = ${iso.parity?.ok}｜预览 HTML：${join(r.work, 'preview', 'index.html')}`)

if (findPowerPoint()) {
  const shot = await renderPptxToPng(iso.file, join(r.work, 'shots'), {
    pages: [1],
    width: Math.max(640, Math.round(r.bbox.w * 2)),
    height: Math.max(360, Math.round(r.bbox.h * 2)),
  })
  console.log(`隔离版 PNG：${shot.files?.[0] ?? '(无)'}`)
} else {
  console.log('隔离版 PNG：本机没有 PowerPoint ⇒ 跳过（预览 HTML 仍可用；桌面端可用 PowerPoint COM 出图）')
}

if (wantPage) {
  const full = await exportPptx(ctx, { out: join(outDir, 'page.pptx') })
  if (findPowerPoint()) {
    const shot = await renderPptxToPng(full.file, join(outDir, 'page-shots'), { pages: [pageNo] })
    console.log(`整页版 PNG（在上下文）：${shot.files?.[0]}`)
  } else {
    await renderDeck(ctx, { out: join(outDir, 'page-preview') })
    console.log(`整页版：本机没有 PowerPoint ⇒ 已生成预览 HTML：${join(outDir, 'page-preview', 'index.html')}`)
  }
}
console.log(`产物目录：${outDir}`)
