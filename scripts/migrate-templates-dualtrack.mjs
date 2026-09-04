/**
 * v0.9.0 双轨迁移（幂等）：为外部模板补齐真相层——
 * ① 原始 pptx → templates/<id>/template.pptx（用户桌面模板库）
 * ② 已渲染 COM 整页 PNG（~/.dsh/ppt-studio/fidelity/orig/<模板名>/NN.png）→ templates/<id>/previews/
 * ③ template.yaml 补 sourcePptx/previews 元数据
 * 用法：node scripts/migrate-templates-dualtrack.mjs
 */
import { readFile, writeFile, copyFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import YAML from 'yaml'

const TPL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates')
const DESK = 'C:\\Users\\11867\\Desktop\\ppt模板库'
const ORIG = join(homedir(), '.dsh', 'ppt-studio', 'fidelity', 'orig')

// 源文件名（桌面/orig 目录名，中文+大小写差异）→ 模板 id
const MAP = {
  '实用毕业设计论文答辩PPT模板': '实用毕业设计论文答辩ppt模板',
  '极简实用部门工作总结PPT模板': '极简实用部门工作总结ppt模板',
  '深蓝质感论文答辩PPT模板': '深蓝质感论文答辩ppt模板',
  '简约商务': '简约商务',
}

let done = 0
for (const [srcName, tplId] of Object.entries(MAP)) {
  const tplDir = join(TPL_DIR, tplId)
  if (!existsSync(tplDir)) { console.log(`SKIP（模板目录不存在）：${tplId}`); continue }
  // ① 原始 pptx
  const pptxSrc = join(DESK, srcName + '.pptx')
  const pptxDst = join(tplDir, 'template.pptx')
  if (existsSync(pptxSrc) && !existsSync(pptxDst)) {
    await copyFile(pptxSrc, pptxDst)
    console.log(`+ template.pptx ← ${basename(pptxSrc)}`)
  } else if (!existsSync(pptxSrc)) {
    console.log(`! 源 pptx 缺失（跳过真相层）：${pptxSrc}`)
  } else {
    console.log(`= template.pptx 已存在（保持）`)
  }
  // ② 整页 PNG
  const pvSrc = join(ORIG, srcName)
  const pvDst = join(tplDir, 'previews')
  if (existsSync(pvSrc) && !existsSync(pvDst)) {
    await mkdir(pvDst, { recursive: true })
    const files = (await readdir(pvSrc)).filter((f) => /\.png$/i.test(f)).sort()
    for (const f of files) await copyFile(join(pvSrc, f), join(pvDst, f))
    console.log(`+ previews/ ← ${files.length} 页（${srcName}）`)
  } else if (!existsSync(pvSrc)) {
    console.log(`! 已渲染 PNG 缺失：${pvSrc}`)
  } else {
    console.log(`= previews/ 已存在（保持）`)
  }
  // ③ 元数据
  const metaFile = join(tplDir, 'template.yaml')
  if (existsSync(metaFile)) {
    const doc = YAML.parseDocument(await readFile(metaFile, 'utf8'))
    let changed = false
    if (existsSync(pptxDst) && !doc.get('sourcePptx')) { doc.set('sourcePptx', 'template.pptx'); changed = true }
    if (existsSync(pvDst) && !doc.get('previews')) { doc.set('previews', 'previews'); changed = true }
    if (changed) { await writeFile(metaFile, String(doc)); console.log(`~ template.yaml 元数据补充`) }
    else console.log(`= template.yaml 已含双轨字段`)
  }
  done++
}
console.log(`\n完成：处理 ${done} 个模板`)
