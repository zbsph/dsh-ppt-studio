/**
 * 模板库：PPT 工作室内置模板（templates/<id>/，随插件分发）。
 * 模板 = 版式母版包：template.yaml 元数据 + deck.yaml（完整 theme）+ pages/_*.yaml 母版页
 * + preview.png（脚本生成）。参考优先级（2026-09-18 用户政策）：用户给的模板/既有 ppt > （用户明确要求时的）内置模板 >
 * 按题材自己设计风格（默认路径，内置模板不作兜底）。
 */
import { readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { pptStudioDir } from './home.js'

export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates')

/**
 * 用户层模板目录：`<dshHome>/ppt-studio/templates`。
 *
 * 为什么必须有这一层（2026-09-18 用户提出"每人维护自己的模板库"时发现的坑）：
 *   原先 `registerTemplate` 把收纳的模板写进 `TEMPLATES_DIR`，而那是**插件包自己的目录**——
 *   插件装在 `profiles/web/node_modules/` 下，下次 `dsh plugin add <新资产>` 时 pnpm 会重新物化包，
 *   **用户自己攒的模板会被整目录覆盖掉**。用户层目录在 node_modules 之外，升级不碰。
 *
 * **每次调用求值**（故意不做成模块常量）：测试/CI 可以把 `DSH_HOME` 指到临时目录来验证这一层，
 * 而常量会在 import 时就定死、无法覆盖。2026-09-26 起该口径由 `src/home.js` 统一提供
 * （state/preview/diag 也都改成了调用时求值，不再各自实现）。
 */
export function userTemplatesDir() {
  return join(pptStudioDir(), 'templates')
}

/** 按 id 找模板目录：**用户层优先**（同名时用户覆盖随包），再找随包层。找不到返回 null。 */
export function templateDirOf(id) {
  for (const base of [userTemplatesDir(), TEMPLATES_DIR]) {
    const d = join(base, id)
    if (existsSync(join(d, 'deck.yaml'))) return d
  }
  return null
}

/**
 * 读"要动文本手术"的文件时统一归一：去 BOM + CRLF→LF。
 *
 * 为什么必须做（2026-09-18 实测，创意工坊 PR 审核反馈的根因之一）：
 *   本模块用 `/pages:\n[\s\S]*$/` 这类**行锚定正则**改写 deck.yaml。JS 的 `.` 不吃 `\r`，
 *   而 `$`（m 模式）只落在 `\n` 前——所以 CRLF 文本上这些正则**一条都不匹配**，
 *   `.replace()` 静默返回原文（不报错）。后果分两种，都很难查：
 *     - materializeTemplate：新工作区 deck.yaml 仍引用 `pages/_cover.yaml`，而该页**故意没被复制**
 *       （它是被"正式化"的首母版）→ resolveDeck 抛 `page file missing: pages/_cover.yaml`，
 *       整条自检在干净克隆里直接崩（Windows + Git for Windows 默认 core.autocrlf=true 就会这样）。
 *     - registerTemplate：收纳出来的模板 deck.yaml 的 pages 段没被替换 → 引用一堆不存在的页。
 *   为什么本机一直没暴露：仓库工作区是脚本写出来的 LF（`core.autocrlf=true` 只在**检出**时转换），
 *   而**干净克隆**是检出——于是"本机全绿、用户全崩"。
 *   防线是两条一起：`.gitattributes`（`* text=auto eol=lf`）保证 git 安装与 tgz 安装同字节；
 *   这里保证**用户手改过的 CRLF/BOM 文件**（Windows 记事本默认加 BOM）也不会静默失效。
 */
export function normalizeText(raw) {
  return String(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

/**
 * 把 deck.yaml 的 `pages:` 段（至文件末尾）整体换成给定页清单。
 * **不匹配就抛**：这条改写过去是静默的——CRLF（见 normalizeText）或缺少 pages: 段时
 * `.replace()` 原样返回，产物是一个"引用了不存在页"的 deck，错误推迟到 resolveDeck 才炸，
 * 且报的是"页文件缺失"（离真因隔了一层）。宁可当场报出真因。
 */
function rewritePagesSection(text, refs) {
  const re = /^pages:\n[\s\S]*$/m
  if (!re.test(text)) throw new Error('deck.yaml 缺少顶格 `pages:` 段——无法改写页清单（模板 deck.yaml 必须含 pages:）')
  return text.replace(re, `pages:\n${refs.map((r) => `  - ${r}`).join('\n')}\n`)
}

/**
 * 模板清单（轻量元数据，不读母版页主体）。
 * 合并两层并标注来源：`source: 'user'`（用户自建，可删）/ `'bundled'`（随插件分发，删了升级会回来）。
 * **用户层优先**：同名 id 覆盖随包同名模板，并在条目上标 `shadowsBundled`（工具会如实说明）。
 */
export async function listTemplates() {
  const out = []
  const seen = new Set()
  for (const [base, source] of [[userTemplatesDir(), 'user'], [TEMPLATES_DIR, 'bundled']]) {
    if (!existsSync(base)) continue
    for (const id of (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)) {
      if (seen.has(id)) continue
      const metaFile = join(base, id, 'template.yaml')
      if (!existsSync(metaFile)) continue
      try {
        const meta = YAML.parse(await readFile(metaFile, 'utf8')) ?? {}
        const dir = join(base, id)
        const shadowsBundled = source === 'user' && existsSync(join(TEMPLATES_DIR, id, 'template.yaml'))
        seen.add(id)
        out.push({
          id,
          source,
          dir,
          ...(shadowsBundled ? { shadowsBundled: true } : {}),
          name: meta.name ?? id,
          style: meta.style ?? '',
          scene: meta.scene ?? '',
          desc: meta.desc ?? '',
          words: meta.words ?? '',
          colors: meta.colors ?? [],
          preview: existsSync(join(dir, 'preview.png')) ? join(dir, 'preview.png') : null,
          pages: meta.pages ?? [],
        })
      } catch { /* 坏模板跳过 */ }
    }
  }
  return out
}

/** 模板详情（模板工作区复制用）：deck.yaml 全文 + 母版页 {ref, yaml} + 媒体清单。两层里按 id 找（用户层优先）。 */
export async function templateWorkspace(id) {
  const dir = templateDirOf(id)
  if (!dir) throw new Error(`模板不存在：${id}（可用 ppt_templates 查看列表）`)
  const deckFile = join(dir, 'deck.yaml')
  const deck = normalizeText(await readFile(deckFile, 'utf8'))
  const metaFile = join(dir, 'template.yaml')
  const meta = existsSync(metaFile) ? (YAML.parse(await readFile(metaFile, 'utf8')) ?? {}) : {}
  const pages = []
  for (const ref of meta.pages ?? []) {
    const p = join(dir, ref)
    if (existsSync(p)) pages.push({ ref, yaml: normalizeText(await readFile(p, 'utf8')) })
  }
  const mediaDir = join(dir, 'media')
  const media = existsSync(mediaDir) ? (await import('node:fs/promises').then((f) => f.readdir(mediaDir))).filter((n) => !n.startsWith('.')) : []
  return { id, dir, meta, deck, pages, media }
}

/**
 * 模板收纳（ppt_template_add）：把任意 deck 工程（通常是 ppt_import 产物）收纳为模板包。
 * - 模板主题：取工程 theme（colors/textStyles/safeArea/grid/minFontSize 原样保留）。
 * - 模板页面：工程全部页面复制为 pages/_NN_<name>.yaml（内容保留作版式参照）；media/ 一并复制。
 * - 缩略图：第一页 render + Edge 截图 → preview.png。
 * - 防呆：工程必须可 resolveDeck；id 冲突自动 -2/-3；**拒绝写进随包目录**（升级会覆盖 ⇒ 用户白攒）。
 * @param dir 源工程目录（含 deck.yaml）
 * @param opts {id, name, style, scene, desc, words, sourcePptx}
 * @param opts.targetDir 目标层目录（**缺省 = 用户层** `<dshHome>/ppt-studio/templates`；测试可覆盖）
 */
export async function registerTemplate(dir, opts = {}, { targetDir = userTemplatesDir() } = {}) {
  const { resolveDeck } = await import('./pptd/schema.js')
  const { renderDeck } = await import('./pptd/render-html.js')
  const { writeFile, readFile, copyFile, mkdir, rm } = await import('node:fs/promises')
  // 防呆：随包目录只读。写进去等于"用户攒的模板下次升级就没了"——直接拦下并告诉他去哪儿写。
  const absTarget = resolve(targetDir)
  const absBundled = resolve(TEMPLATES_DIR)
  if (absTarget === absBundled || absTarget.startsWith(absBundled + sep)) {
    throw new Error(`拒绝把模板写进随包目录（${targetDir}）：插件升级会覆盖它，用户模板会丢；请用用户层目录（缺省即是）：${userTemplatesDir()}`)
  }
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
  // 必须先 normalizeText：CRLF 上 `/pages:\n[\s\S]*$/` 静默不匹配（用户手改过的 deck.yaml 就是 CRLF）
  const deckTxt = rewritePagesSection(normalizeText(await readFile(join(dir, 'deck.yaml'), 'utf8')), refs)
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
      // yaml@2：doc.get() 返回 AST 节点（toJS 裸调用抛 "A document argument is required"）→ doc.toJS() 归一
      const data = doc.toJS() ?? {}
      const list = Array.isArray(data.expectedOutOfSafeArea) ? data.expectedOutOfSafeArea : []
      const all = [...list.map(String), ...add]
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
    // 结构化消费（2026-09-26）：旧实现 `line.match(/\[✗\] (\w+)/)` 用的是 `\w+`，而所有门禁码都带连字符
    // （out-of-page / text-overflow / theme-conformance…）⇒ 直方图里全是截断码（`out×3`、`text×2`），
    // 而这份报告是模型读的。改用 verifyDeck 新增的结构化 errors。
    const detail = {}
    for (const f of v3.errors) {
      const code = f.code ?? 'other'
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
    // 落在哪一层：user = 用户模板库（缺省，升级不丢）；custom = 调用方指定的目录（测试/工具用）
    layer: absTarget === resolve(userTemplatesDir()) ? 'user' : 'custom',
    sourcePptx: srcPptx ? join(tplDir, 'template.pptx') : null,
    previews: previewsDir ? join(tplDir, 'previews') : null,
  }
}

/**
 * 删除**用户自建**模板（ppt_template_remove）。
 * 随包模板（bundled）**拒绝删除**：它随插件分发、升级会重新出现，删了只会让人困惑（"删了又回来"）；
 * 要"不用它"就不选它即可。用户层模板随便删。
 */
export async function removeTemplate(id, { targetDir = userTemplatesDir() } = {}) {
  const userDir = join(targetDir, id)
  if (existsSync(join(userDir, 'template.yaml'))) {
    await rm(userDir, { recursive: true, force: true })
    return { id, removed: true, dir: userDir }
  }
  if (existsSync(join(TEMPLATES_DIR, id, 'template.yaml'))) {
    throw new Error(`「${id}」是随包模板（随插件分发，升级会重新出现），不能删。不想用它就别选它；同名覆盖请用别的 id 收纳你自己的版本`)
  }
  throw new Error(`模板库里没有「${id}」（可用 ppt_templates 看清单）`)
}

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
  const deck = normalizeText(t.deck)
    .replace(/^title:.*$/m, `title: ${JSON.stringify(name ?? tplMeta.name ?? '未命名')}`)
  const deckWithPages = rewritePagesSection(deck, [formal])
  await writeFile(join(dir, 'deck.yaml'), deckWithPages + refBlock)
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
