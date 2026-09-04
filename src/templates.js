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

/** 模板详情（模板工作区复制用）：deck.yaml 全文 + 母版页 {ref, yaml} + 媒体清单。 */
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
  const mediaDir = join(dir, 'media')
  const media = existsSync(mediaDir) ? (await import('node:fs/promises').then((f) => f.readdir(mediaDir))).filter((n) => !n.startsWith('.')) : []
  return { id, dir, meta, deck, pages, media }
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
  // 收纳后自动声明清理（外部模板 = 参考资产：视觉叠层/页脚出血是有意的原始设计 → 批量声明；
  // 剩余错误按类型统计记入 meta.cleanup，供使用者预知）
  let cleanup = { declared: 0, outSafe: 0, remainingErrors: 0, detail: {} }
  try {
    const { renderDeck } = await import('./pptd/render-html.js')
    const { verifyDeck, collectDeclarable } = await import('./verify.js')
    const { applyAutoDeclare } = await import('./autodeclare.js')
    const YAML = await import('yaml').then((m) => m.default)
    // ① 出界声明：模板页超出安全区的元素（页脚带/出血/占位）批量写入 expectedOutOfSafeArea（有意设计）
    const ctxA = await resolveDeck(tplDir)
    const rA = await renderDeck(ctxA, { out: '_cleanup-tmp' })
    let outSafe = 0
    for (const pageL of rA.layout.pages) {
      const sa = pageL.safeArea ?? null
      if (!sa) continue
      const outer = pageL.elements.filter((e) => {
        const b = e.bounds
        return b.x < sa.left - 1 || b.y < sa.top - 1 || b.x + b.w > ctxA.size.width - sa.right + 1 || b.y + b.h > ctxA.size.height - sa.bottom + 1
      })
      if (!outer.length) continue
      const file = ctxA.pages[pageL.index].file
      const text = await readFile(file, 'utf8')
      const doc = YAML.parseDocument(text)
      const add = outer.map((e) => e.id)
      const all = [...(doc.get('expectedOutOfSafeArea') ?? []).map(String), ...add]
      doc.setIn(['expectedOutOfSafeArea'], doc.createNode([...new Set(all)]))
      await writeFile(file, String(doc))
      outSafe += add.length
    }
    // ② 重叠声明 + 分类统计
    const ctx2 = await resolveDeck(tplDir)
    const r2 = await renderDeck(ctx2, { out: '_cleanup-tmp' })
    cleanup.declared = (await applyAutoDeclare(ctx2, r2.layout)).reduce((n, a) => n + a.added, 0)
    const ctx3 = await resolveDeck(tplDir)
    const r3 = await renderDeck(ctx3, { out: '_cleanup-tmp' })
    const v3 = verifyDeck(r3.layout)
    const detail = {}
    for (const line of v3.text.split('\n').filter((l) => l.includes('[✗]'))) {
      const code = (line.match(/\[✗\] (\w+)/) ?? [])[1] ?? 'other'
      detail[code] = (detail[code] ?? 0) + 1
    }
    cleanup = { declared: cleanup.declared, outSafe, remainingErrors: Object.values(detail).reduce((a, b) => a + b, 0), detail }
  } catch { /* 清理失败不阻塞收纳（模板仍可用） */
  } finally {
    await rm(join(tplDir, '_cleanup-tmp'), { recursive: true, force: true }).catch(() => {})
  }
  const cleanupNote = [
    cleanup.outSafe ? `已声明 ${cleanup.outSafe} 个出界元素为模板有意设计` : '',
    cleanup.declared ? `已声明 ${cleanup.declared} 对预期重叠` : '',
    cleanup.remainingErrors ? `剩余 ${cleanup.remainingErrors} 条（${Object.entries(cleanup.detail).map(([k, v]) => `${k}×${v}`).join('、')}——模板固有内容问题，复制工作区后按 verify 修复）` : '',
  ].filter(Boolean).join('；') || '模板已洁净'
  // 双轨真相层 v0.9.0：保留原始 pptx → template.pptx，Office 真渲染整页 → previews/NN.png
  //（骨架层 deck.yaml 机器可验证；真相层零失真供视觉参考——"按模板做" = "参考用户给的 ppt 制作"）
  let srcPptx = null
  for (const p of [opts.sourcePptx, join(dir, 'source.pptx')]) {
    if (p && existsSync(p)) {
      srcPptx = join(tplDir, 'template.pptx')
      await copyFile(p, srcPptx)
      break
    }
  }
  let previewsDir = null
  if (srcPptx) {
    try {
      const { findPowerPoint, renderPptxToPng } = await import('./msrender.js')
      if (findPowerPoint()) {
        previewsDir = join(tplDir, 'previews')
        const r = await renderPptxToPng(srcPptx, previewsDir, { timeoutMs: 300000 })
        if (!r.pages) throw new Error('渲染结果为空')
      }
    } catch { /* 无 Office / 渲染失败：真相层缺参考页不阻塞收纳（骨架层仍可用） */
      if (previewsDir) await rm(previewsDir, { recursive: true, force: true }).catch(() => {})
      previewsDir = null
    }
  }
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
    cleanup: cleanupNote,
    ...(srcPptx ? { sourcePptx: 'template.pptx' } : {}),
    ...(previewsDir ? { previews: 'previews' } : {}),
  }
  await writeFile(join(tplDir, 'template.yaml'), YAML.stringify(meta))
  // 缩略图：从**模板目录**自身渲染（ctx.dir=tplDir，out 相对名）+ Edge 截图 → preview.png
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p))
  let preview = null
  try {
    const ctxT = await resolveDeck(tplDir)
    const r = await renderDeck(ctxT, { out: '_preview-tmp' })
    if (edge) {
      const { spawn } = await import('node:child_process')
      const url = 'file:///' + join(tplDir, '_preview-tmp', r.htmlFiles[0]).replace(/\\/g, '/')
      preview = join(tplDir, 'preview.png')
      await new Promise((resolve, reject) => {
        const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
          `--window-size=${ctxT.size.width},${ctxT.size.height}`, `--screenshot=${preview}`, url], { stdio: 'ignore', windowsHide: true })
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Edge 退出码 ${code}`)))
        child.on('error', reject)
      })
    }
  } catch (e) { /* 无浏览器/渲染失败：template.yaml 仍生成，preview 留空 */ }
  await rm(join(tplDir, '_preview-tmp'), { recursive: true, force: true }).catch(() => {})
  return {
    id,
    dir: tplDir,
    preview,
    pages: refs.length,
    meta,
    sourcePptx: srcPptx ? join(tplDir, 'template.pptx') : null,
    previews: previewsDir ? join(tplDir, 'previews') : null,
  }
}

/** 模板渲染预览根（无 webServer 依赖）：用于展示与测试。 */

/**
 * 从模板物化工作区（v0.7.0：参考素材与正式页分离）：
 * - 母版页 pages/_*.yaml：参考素材，**不注册进 deck.pages**（不进 render/verify 门禁）；
 * - 正式页 pages/01_opening.yaml：模板第一母版的正式化副本，**注册进门禁**（先 autoDeclare 声明模板固有叠层，
 *   剩余为模板原文案残留，替换后自然干净）；
 * - media/ 跟随复制（外部模板含图片）。
 * @returns { dir, formal, refs, mediaCount, cleanup }
 */
export async function materializeTemplate(dir, id, { name } = {}) {
  const { writeFile, mkdir, copyFile, access } = await import('node:fs/promises')
  try {
    await access(join(dir, 'deck.yaml'))
    throw new Error(`目标目录已存在 deck.yaml（${join(dir, 'deck.yaml')}），拒绝覆盖；请换一个空目录`)
  } catch (e) {
    if ((e?.message ?? '').includes('拒绝覆盖')) throw e
    // access 失败（目录不存在）：放行
  }
  const t = await templateWorkspace(id)
  await mkdir(join(dir, 'pages'), { recursive: true })
  await mkdir(join(dir, 'media'), { recursive: true })
  const first = t.pages[0]
  const formal = 'pages/01_opening.yaml'
  const firstYaml = first ? first.yaml.replace(/^pageType:.*$/m, 'pageType: content') : 'pageType: content\nelements: []\n'
  await writeFile(join(dir, formal), firstYaml)
  // 双轨真相层 v0.9.0：referenceTemplate 注入（创作前"看模板真身"；与参考用户 ppt 制作等价）
  const tplMeta = t.meta ?? {}
  let refBlock = ''
  const refDirSrc = t.dir
  const hasTruth = existsSync(join(refDirSrc, 'template.pptx')) || existsSync(join(refDirSrc, 'previews')) || tplMeta.styleAudit
  if (hasTruth) {
    const lines = ['referenceTemplate:', `  id: ${JSON.stringify(id)}`, `  name: ${JSON.stringify(name ?? tplMeta.name ?? id)}`]
    if (existsSync(join(refDirSrc, 'template.pptx'))) lines.push('  source: reference/template.pptx')
    if (existsSync(join(refDirSrc, 'previews'))) {
      const pvs = (await readdir(join(refDirSrc, 'previews'))).filter((f) => /\.png$/i.test(f)).sort()
      if (pvs.length) lines.push('  previews:', ...pvs.map((f) => `    - reference/previews/${f}`))
    }
    if (tplMeta.styleAudit) lines.push('  audit: reference/audit.yaml')
    if (lines.length > 3) refBlock = '\n' + lines.join('\n') + '\n'
  }
  const deck = t.deck
    .replace(/^title:.*$/m, `title: ${JSON.stringify(name ?? tplMeta.name ?? '未命名')}`)
    .replace(/pages:\n[\s\S]*$/, `pages:\n  - ${formal}\n`)
  await writeFile(join(dir, 'deck.yaml'), deck + refBlock)
  const refs = []
  for (const p of t.pages) {
    if (p.ref === first.ref) continue // 首母版已正式化
    await writeFile(join(dir, p.ref), p.yaml)
    refs.push(p.ref)
  }
  let mediaCount = 0
  for (const m of t.media) {
    await copyFile(join(t.dir, 'media', m), join(dir, 'media', m))
    mediaCount++
  }
  // 真相层参考拷贝：reference/{template.pptx,previews/,audit.yaml}（工作区自包含，模板更新不影响已物化工作区）
  let reference = null
  if (hasTruth) {
    const refDir = join(dir, 'reference')
    await mkdir(refDir, { recursive: true })
    const copied = []
    if (existsSync(join(t.dir, 'template.pptx'))) {
      await copyFile(join(t.dir, 'template.pptx'), join(refDir, 'template.pptx'))
      copied.push('template.pptx')
    }
    if (existsSync(join(t.dir, 'previews'))) {
      await cp(join(t.dir, 'previews'), join(refDir, 'previews'))
      copied.push('previews/')
    }
    if (tplMeta.styleAudit) {
      await writeFile(join(refDir, 'audit.yaml'), YAML.stringify({ ...tplMeta.styleAudit, templateId: id, templateName: tplMeta.name ?? id }))
      copied.push('audit.yaml')
    }
    reference = { dir: refDir, files: copied }
  }
  return { dir, formal, refs, mediaCount, cleanup: tplMeta.cleanup ?? null, meta: tplMeta, firstRef: first?.ref, reference }
}

async function cp(src, dest) {
  const { cp } = await import('node:fs/promises')
  await cp(src, dest, { recursive: true }).catch(() => {})
}
