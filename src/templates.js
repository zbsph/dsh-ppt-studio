/**
 * 模板库：PPT 工作室内置模板（templates/<id>/，随插件分发）。
 * 模板 = 版式母版包：template.yaml 元数据 + deck.yaml（完整 theme）+ pages/_*.yaml 母版页
 * + preview.png（脚本生成）。用户流：用户模板文件 > 模板库选择 > 从零定调。
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates')

/** 模板清单（轻量元数据，不读母版页主体）。 */
export async function listTemplates() {
  const out = []
  if (!existsSync(TEMPLATES_DIR)) return out
  for (const id of (await readdir(TEMPLATES_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const metaFile = join(TEMPLATES_DIR, id, 'template.yaml')
    if (!existsSync(metaFile)) continue
    try {
      const meta = YAML.parse(await readFile(metaFile, 'utf8')) ?? {}
      out.push({
        id,
        name: meta.name ?? id,
        style: meta.style ?? '',
        scene: meta.scene ?? '',
        desc: meta.desc ?? '',
        words: meta.words ?? '',
        colors: meta.colors ?? [],
        preview: existsSync(join(TEMPLATES_DIR, id, 'preview.png')) ? join(TEMPLATES_DIR, id, 'preview.png') : null,
        pages: meta.pages ?? [],
      })
    } catch { /* 坏模板跳过 */ }
  }
  return out
}

/** 模板详情（模板工作区复制用）：deck.yaml 全文 + 母版页 {ref, yaml}。 */
export async function templateWorkspace(id) {
  const dir = join(TEMPLATES_DIR, id)
  const deckFile = join(dir, 'deck.yaml')
  if (!existsSync(deckFile)) throw new Error(`模板不存在：${id}（可用 ppt_templates 查看列表）`)
  const deck = await readFile(deckFile, 'utf8')
  const metaFile = join(dir, 'template.yaml')
  const meta = existsSync(metaFile) ? (YAML.parse(await readFile(metaFile, 'utf8')) ?? {}) : {}
  const pages = []
  for (const ref of meta.pages ?? []) {
    const p = join(dir, ref)
    if (existsSync(p)) pages.push({ ref, yaml: await readFile(p, 'utf8') })
  }
  return { id, dir, meta, deck, pages }
}
