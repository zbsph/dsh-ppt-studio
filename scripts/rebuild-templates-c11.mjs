/**
 * v0.11.0 模板骨架层重建：4 套外部模板重导（custGeom/alpha/形状文本保真升级），
 * 保留 styleAudit + 双轨字段（template.pptx/previews/），幂等。
 * 流程：备份 template.yaml（styleAudit）→ rm 模板目录 → importPptx(桌面源) → registerTemplate →
 *       迁移脚本补双轨资产 → 合并 styleAudit。
 */
import { readFile, writeFile, mkdir, rm, readdir, copyFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import YAML from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TPL_DIR = join(ROOT, 'templates')
const DESK = 'C:\\Users\\11867\\Desktop\\ppt模板库'
const ORIG = join(homedir(), '.dsh', 'ppt-studio', 'fidelity', 'orig')

const MODELS = [
  { file: '实用毕业设计论文答辩PPT模板.pptx', id: '实用毕业设计论文答辩ppt模板', name: '实用毕业设计论文答辩PPT模板', style: '学术答辩', scene: '毕业设计论文答辩' },
  { file: '极简实用部门工作总结PPT模板.pptx', id: '极简实用部门工作总结ppt模板', name: '极简实用部门工作总结PPT模板', style: '工作总结', scene: '部门工作总结' },
  { file: '深蓝质感论文答辩PPT模板.pptx', id: '深蓝质感论文答辩ppt模板', name: '深蓝质感论文答辩PPT模板', style: '学术答辩', scene: '论文答辩' },
  { file: '简约商务.pptx', id: '简约商务', name: '简约商务', style: '商务', scene: '商务汇报' },
]

const { importPptx } = await import('../src/pptd/import-pptx.js')
const { registerTemplate } = await import('../src/templates.js')

for (const m of MODELS) {
  const tplDir = join(TPL_DIR, m.id)
  if (!existsSync(tplDir)) { console.log(`SKIP（模板目录不存在）：${m.id}`); continue }
  // ① 备份 styleAudit
  const metaFile = join(tplDir, 'template.yaml')
  const oldMeta = existsSync(metaFile) ? (YAML.parse(await readFile(metaFile, 'utf8')) ?? {}) : {}
  // ② rm 模板目录（重建）
  await rm(tplDir, { recursive: true, force: true })
  // ③ 重导 + 收纳
  const tmp = join(homedir(), '.dsh', 'ppt-studio', 'rebuild-tmp', m.id)
  await rm(tmp, { recursive: true, force: true })
  const src = join(DESK, m.file)
  const imp = await importPptx(src, tmp)
  const reg = await registerTemplate(tmp, { id: m.id, name: m.name, style: m.style, scene: m.scene }, {})
  console.log(`+ 重建 ${m.id}：${imp.pages} 页（reg id=${reg.id} 冲突=${reg.id !== m.id ? reg.id : '无'}）`)
  // ④ 双轨资产（template.pptx + previews/ 从桌面/已渲染 PNG 补）
  const tplNew = join(TPL_DIR, reg.id)
  if (!existsSync(join(tplNew, 'template.pptx')) && existsSync(src)) await copyFile(src, join(tplNew, 'template.pptx'))
  if (!existsSync(join(tplNew, 'previews')) && existsSync(join(ORIG, m.file.replace(/\.pptx$/i, '')))) {
    await mkdir(join(tplNew, 'previews'), { recursive: true })
    for (const f of (await readdir(join(ORIG, m.file.replace(/\.pptx$/i, '')))).filter((x) => /\.png$/i.test(x))) {
      await copyFile(join(ORIG, m.file.replace(/\.pptx$/i, ''), f), join(tplNew, 'previews', f))
    }
  }
  // ⑤ 合并 styleAudit + 双轨字段
  const metaNew = YAML.parse(await readFile(join(tplNew, 'template.yaml'), 'utf8')) ?? {}
  const merged = {
    ...metaNew,
    ...(existsSync(join(tplNew, 'template.pptx')) ? { sourcePptx: 'template.pptx' } : {}),
    ...(existsSync(join(tplNew, 'previews')) ? { previews: 'previews' } : {}),
    ...(oldMeta.styleAudit ? { styleAudit: oldMeta.styleAudit } : {}),
  }
  await writeFile(join(tplNew, 'template.yaml'), YAML.stringify(merged))
  console.log(`  meta：双轨字段 ✓ / styleAudit ${oldMeta.styleAudit ? '保留 ✓' : '（无）'}`)
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
}
console.log('\n完成')
