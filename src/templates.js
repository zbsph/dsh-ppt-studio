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

/**
 * 外部模板收纳（ppt_template_add，v0.5.1，需求 2 的"模板随使用增长"通道）：
 * 把任意 deck 工程（通常是 ppt_import 产物）收纳为模板包 → templates/<id>/。
 * - 模板主题：取工程 theme（colors/textStyles/safeArea/grid/minFontSize 原样保留）。
 * - 模板页面：工程全部页面复制为 pages/_NN_<name>.yaml（内容保留作版式参照）；media/ 一并复制。
 * - 缩略图：第一页 render + Edge 截图 → preview.png。
 * - 防呆：工程必须可 resolveDeck；id 冲突自动 -2/-3。
 * @param dir 源工程目录（含 deck.yaml）
 * @param opts {id, name, style, scene, desc, words}
 * @param opts.targetDir 模板库目录（缺省插件 templates/；测试可覆盖）
 */
export async function registerTemplate(dir, opts = {}, { targetDir = TEMPLATES_DIR } = {}) {
  const { resolveDeck } = await import('./pptd/schema.js')
  const { renderDeck } = await import('./pptd/render-html.js')
  const { writeFile, readFile, copyFile, mkdir, rm } = await import('node:fs/promises')
  const ctx = await resolveDeck(dir) // 校验 + 归一化（读时快照）
  if (ctx.pages.length === 0) throw new Error('工程没有页面，无法收纳')
  const slug = (s) => String(s).toLowerCase().replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '') || 'template'
  let id = slug(opts.id ?? opts.name ?? ctx.deck.title ?? 'template')
  let n = 2
  while (existsSync(join(targetDir, id))) { id = `${id}-${n++}` }
  const tplDir = join(targetDir, id)
  const pagesDir = join(tplDir, 'pages')
  await mkdir(pagesDir, { recursive: true })
  // 母版页复制（保留内容作为版式参照）
  const refs = []
  for (const [i, p] of ctx.pages.entries()) {
    const base = `_${String(i + 1).padStart(2, '0')}_${p.name.replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 24) || 'page'}.yaml`
    const ref = `pages/${base}`
    await copyFile(join(dir, p.ref), join(tplDir, ref))
    refs.push(ref)
  }
  // media（页面图/背景图引用）
  if (existsSync(join(dir, 'media'))) {
    await cp(join(dir, 'media'), pagesDir === '' ? tplDir : join(tplDir, 'media'))
  }
  // 模板 deck.yaml：引用全部母版页（保留原 theme；pages 段整体替换，不动前导换行）
  const deckTxt = (await readFile(join(dir, 'deck.yaml'), 'utf8')).replace(/pages:\n[\s\S]*$/, `pages:\n${refs.map((r) => `  - ${r}`).join('\n')}\n`)
  await writeFile(join(tplDir, 'deck.yaml'), deckTxt)
  // template.yaml 元数据
  const meta = {
    id,
    name: opts.name ?? ctx.deck.title ?? id,
    style: opts.style ?? '外部导入模板',
    scene: opts.scene ?? '',
    desc: opts.desc ?? '由用户导入的 deck 工程收纳（主题/版式取自原工程；可编辑后复用）',
    words: opts.words ?? '',
    colors: Object.values(ctx.colors ?? {}).filter((c) => typeof c === 'string'),
    pages: refs,
  }
  await writeFile(join(tplDir, 'template.yaml'), YAML.stringify(meta))
  // 缩略图：第一页 render + Edge 截图
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p))
  let preview = null
  try {
    const r = await renderDeck(ctx, { out: join(tplDir, '_preview-tmp') })
    if (edge) {
      const { spawn } = await import('node:child_process')
      const url = 'file:///' + join(tplDir, '_preview-tmp', r.htmlFiles[0]).replace(/\\/g, '/')
      preview = join(tplDir, 'preview.png')
      await new Promise((resolve, reject) => {
        const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
          `--window-size=${ctx.size.width},${ctx.size.height}`, `--screenshot=${preview}`, url], { stdio: 'ignore', windowsHide: true })
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Edge 退出码 ${code}`)))
        child.on('error', reject)
      })
    }
  } catch { /* 无浏览器/渲染失败：template.yaml 仍生成，preview 留空 */ }
  await rm(join(tplDir, '_preview-tmp'), { recursive: true, force: true }).catch(() => {})
  return { id, dir: tplDir, preview, pages: refs.length, meta }
}

async function cp(src, dest) {
  const { cp } = await import('node:fs/promises')
  await cp(src, dest, { recursive: true }).catch(() => {})
}
