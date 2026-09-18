/**
 * 内容审阅材料包（M3 重写，2026-09-18 用户决定）——
 *
 * 旧版（v0.13.0 M3，2026-09-04）做两件事：跨页数字对账（同数字/百分比入组）+
 * 证据核查表（页面 source → grounded / unmapped）。**2026-09-18 用户质疑后实测，该抽象层不成立**：
 *   ① 数字必须放回整句/整页语境才有含义——按"数字字符串相同"分组只能确认**本来就一致**的数，
 *      看不见**同指标不同值**。实测：故意在第 2 页写 毛利率 32%、第 3 页写 38% → 0 命中，
 *      反而报了无害的 12%；fx-pro 12 页出 6 组、0 组可行动（40 字以内 vs 40px 混义成一组、
 *      版本号 v1.0.0 被拆成 "1.0" 与 "0" 两组、提示文案里的数字入组）。
 *   ② page.source 是作者自己写的一行自由文本，机器只判"有没有填"——它既不是证据（没有任何环节
 *      去取/读/核对那份来源），也不进成品（全库唯一消费者就是这张表），grounded/unmapped 因此是
 *      伪状态；且它按"页"判，封面/章节页也标 unmapped。
 *
 * 现职责（**只做精确、零判断的事**）：把审阅者需要一次看全的材料端上桌——
 *   全页正文（阅读顺序，含表格/图表数据/讲稿/作者自述出处）+ 工作区实扫的外部素材清单 +
 *   审阅协议（判定四分类：一致/冲突/无来源支撑/无法核实）。
 * 判断交给人/模型（有独立子代理更佳，且**用户禁止子代理时严格自审**）。
 * **本文件不产生任何判定、状态、比例或阈值**，因此既不进门禁，也不可能与门禁机制冲突。
 */
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 内联正文上限（字符）：超过则内联前若干页 + 指明完整包路径（完整包永不截断）。 */
const INLINE_BODY_CAP = 24000
/** 素材扫描：可据以核对"有无依据"的文档类扩展名。 */
const DATA_EXT = /\.(pptx|docx|xlsx|xls|csv|pdf|md|txt|json|html?)$/i
/** 根目录里属于"本工具的产物"而非素材的文件（导出物不是依据）。 */
const ARTIFACT_EXT = /^(out|out-surgical|out-claude|.*-spliced|.*-single|.*-rendered)\.pptx$/i

const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** 单元格文本：markdown 表格里转义竖线、压掉换行（表格结构不能被我自己的渲染破坏）。 */
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

/**
 * 工作区实扫素材清单（客观事实，不含判断）。
 * 只回答一个问题：**审阅者手上到底有没有可核对的外部依据**——这决定了外部主张该判
 * "无来源支撑"还是"无法核实"（旧版把这两件事混成 unmapped 是错的）。
 */
export function scanMaterials(dir) {
  const out = []
  const push = (rel, role) => {
    const abs = join(dir, rel)
    if (!existsSync(abs)) return
    let st
    try { st = statSync(abs) } catch { return }
    if (!st.isFile()) return
    out.push({ path: rel, bytes: st.size, role })
  }
  const listDir = (rel) => {
    const abs = join(dir, rel)
    if (!existsSync(abs)) return []
    try { return readdirSync(abs).sort() } catch { return [] }
  }
  // 双轨真相层（ppt_import / 模板工作区自带）
  push('reference/source.pptx', '导入原稿（内容真相层）')
  push('source.pptx', '导入原稿副本')
  push('reference/template.pptx', '模板真相层')
  push('reference/audit.yaml', '模板风格审计缓存')
  for (const f of listDir(join('reference'))) {
    if (f === 'source.pptx' || f === 'template.pptx' || f === 'audit.yaml') continue
    push(join('reference', f), 'reference/ 其他文件')
  }
  for (const f of listDir(join('reference', 'previews'))) push(join('reference', 'previews', f), '原稿真渲染整页（需读图能力）')
  // 用户素材（约定目录名）
  for (const sub of ['materials', 'sources', '素材', 'docs']) {
    for (const f of listDir(sub)) push(join(sub, f), '用户素材')
  }
  // 工程根目录的文档类文件（素材常常直接扔在根上）
  for (const f of listDir('.')) {
    if (!DATA_EXT.test(f) || ARTIFACT_EXT.test(f)) continue
    push(f, '工程内文件')
  }
  // media/：图片素材，按目录聚合（不是数据依据，标注清楚免得审阅者误用）
  const mediaFiles = listDir('media')
  if (mediaFiles.length) {
    let total = 0
    for (const f of mediaFiles) { try { total += statSync(join(dir, 'media', f)).size } catch { /* 忽略单个文件错误 */ } }
    out.push({ path: 'media/', bytes: total, role: `页面图片素材 ×${mediaFiles.length}（媒体，非数据依据）` })
  }
  return out
}

/**
 * 汇总材料包数据（**纯函数、无副作用、无判定字段**）。
 * 返回 { dir, title, size, pages: [...], materials: [...] }。
 */
export function crosscheckDeck(ctx) {
  const dir = ctx.dir
  const pages = (ctx.pages ?? []).map((p, i) => {
    const page = p.page ?? {}
    const els = Array.isArray(page.elements) ? page.elements : []
    const texts = []
    const tables = []
    const charts = []
    const images = []
    for (const e of els) {
      const id = e.elementId ?? '(无 id)'
      const type = e.elementType ?? e.kind
      if (type === 'text') {
        const t = String(e.content?.text ?? e.text ?? '')
        if (t) texts.push({ id, text: t })
      } else if (type === 'table') {
        tables.push({
          id,
          cols: (e.cols ?? []).map(String),
          rows: (e.rows ?? []).map((r) => (Array.isArray(r) ? r : []).map(String)),
        })
      } else if (type === 'chart') {
        const c = e.chart ?? {}
        charts.push({
          id,
          type: String(c.type ?? '?'),
          cols: (c.data?.cols ?? []).map(String),
          rows: (c.data?.rows ?? []).map((r) => (Array.isArray(r) ? r : []).map(String)),
        })
      } else if (type === 'image') {
        images.push({ id, src: String(e.src ?? e.content?.src ?? ''), fit: String(e.fit ?? e.content?.fit ?? '') })
      }
    }
    return {
      index: i + 1,
      ref: p.ref ?? '',
      pageType: String(page.pageType ?? '(未写)'),
      title: page.title ? String(page.title) : null,
      notes: page.notes ? String(page.notes) : '',
      // 作者自述出处：**未经核实**，只当审阅线索（旧版据此判 grounded/unmapped 已废除）
      authorSource: page.source ? String(page.source) : null,
      texts,
      tables,
      charts,
      images,
    }
  })
  return {
    dir,
    title: String(ctx.deck?.title ?? ''),
    size: ctx.size ?? null,
    pages,
    materials: scanMaterials(dir),
  }
}

function renderMeta(d) {
  const wh = d.size ? `${d.size.width}×${d.size.height}px` : '(未知尺寸)'
  const lines = [
    '# 内容审阅材料包',
    '',
    `- 工程：**${d.title || '(无标题)'}**｜页面 ${wh}｜共 **${d.pages.length} 页**`,
    '- 生成：`ppt_crosscheck`（**只汇总材料，不做任何判定**——旧版"跨页数字分组 + grounded/unmapped 状态"已于 2026-09-18 废除：数字必须放回整句语境才有含义，来源标注是作者自述而非证据）',
    '- 用途：把判定所需材料一次看全。**判定在下文第三节的审阅协议里产生，由审阅者给出**。',
    '- 下一步：按协议执行内容审阅——**默认独立子代理**（全新上下文，只给本包与素材；用户明确禁止子代理时改自审并标注）。本工具不构成门禁。',
    '',
  ]
  return lines.join('\n')
}

function renderMaterials(d) {
  const lines = ['## 二、可核对的外部素材（工作区实扫，客观清单）', '']
  if (!d.materials.length) {
    lines.push('**未发现任何外部素材。**', '')
    lines.push('→ 由此决定判定口径：涉及外部事实/数字的主张本次**只能判「无法核实」**——不得判「一致」（没有依据可依），也不得判「无来源支撑」（那是猜，不是核实）。')
    return lines.join('\n')
  }
  lines.push('| 文件 | 大小 | 用途 |', '|---|---|---|')
  for (const m of d.materials) lines.push(`| \`${m.path}\` | ${fmtBytes(m.bytes)} | ${m.role} |`)
  lines.push('')
  const checkable = d.materials.filter((m) => /导入原稿|模板真相层|用户素材|工程内文件/.test(m.role))
  const visualOnly = d.materials.filter((m) => /真渲染整页|图片素材/.test(m.role))
  lines.push(checkable.length
    ? `可据以判定"有无依据"的素材：**${checkable.length} 项**（原稿/文档类）。审阅者应当实际打开它们比对，而不是凭印象。`
    : `**只有图片/预览类素材（${visualOnly.length} 项）**：图片里的数字需读图能力才能核对；读不到就判「无法核实」，不要猜。`)
  return lines.join('\n')
}

function renderPageSection(p) {
  const lines = [`### 第 ${p.index} 页 · \`${p.ref}\``, '']
  const head = [`类型 \`${p.pageType}\``]
  if (p.title) head.push(`标题 \`${p.title}\``)
  lines.push(`- ${head.join('｜')}`)
  if (p.authorSource) lines.push(`- 作者自述出处（**未核实**，仅线索）：\`${p.authorSource}\``)
  if (!p.texts.length && !p.tables.length && !p.charts.length && !p.images.length) {
    lines.push('- （本页无文字/表格/图表/图片元素）')
  }
  for (const t of p.texts) {
    if (t.text.includes('\n')) {
      lines.push(`- 文本 \`${t.id}\`：`)
      for (const l of t.text.split('\n')) lines.push(`  > ${l}`)
    } else {
      lines.push(`- 文本 \`${t.id}\`：${t.text}`)
    }
  }
  for (const t of p.tables) {
    lines.push(`- 表格 \`${t.id}\`（${t.cols.length} 列 × ${t.rows.length} 行）：`)
    lines.push(`  | ${t.cols.map(cell).join(' | ')} |`)
    lines.push(`  |${' --- |'.repeat(Math.max(1, t.cols.length))}`)
    for (const r of t.rows) lines.push(`  | ${r.map(cell).join(' | ')} |`)
  }
  for (const c of p.charts) {
    lines.push(`- 图表 \`${c.id}\`：${c.type}｜列 \`${c.cols.join('、')}\``)
    for (const r of c.rows) lines.push(`  - ${r.map(cell).join('｜')}`)
  }
  for (const im of p.images) lines.push(`- 图片 \`${im.id}\`：\`${im.src}\`${im.fit ? `（fit ${im.fit}）` : ''}`)
  if (p.notes) {
    lines.push('- 讲稿（notes，会导出为备注页）：')
    for (const l of p.notes.split('\n')) lines.push(`  > ${l}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 审阅协议：**工具本身不判定**，判定标准与方法在这里写给审阅者（人 或 模型/子代理）。
 * 注意：本节内不出现反引号，避免与模板字符串转义纠缠（纯文本，读起来等价）。
 */
const PROTOCOL = [
  '## 四、审阅协议（给审阅者：判定在这里产生，本工具不判定）',
  '',
  '### 目标（三件事）',
  '1. **内容前后一致**：同一事实、指标、名称、时间范围、口径在不同页之间不得互相矛盾。',
  '2. **数据不冲突**：同一指标在同一口径/同一期间下，不得在不同页出现不同值。',
  '3. **无编造/曲解**：具体数字与事实须能在上面素材中找到依据；结论不得强于所引数据（不得把相关性说成因果、不得丢掉限定条件、不得断章取义、不得把目标写成已完成）。',
  '',
  '### 审阅方式（按优先级，且必须服从用户指令）',
  '1. **用户明确要求"不要使用子代理"（或同义要求）→ 自审**：在同一上下文里逐条核对，报告开头必须写「自审（同上下文，可信度较低）」。**此时不得改用子代理。**',
  '2. 用户未禁止、且当前会话有独立子代理能力（如 subagent 工具）→ **优先用独立子代理审阅**：全新上下文、只给本材料包（preview/review-pack.md）与素材文件、**不给**作者的推理过程或结论；报告标注「独立子代理审阅」。',
  '3. 两者都没有 → 自审，并同样标注。',
  '无论哪种方式：**审阅必须真的发生**——不得跳过，也不得只回一句"已核查、无问题"。',
  '',
  '### 判定四分类（每条只能取其一，且必须给页码 + 原句）',
  '- **一致**：与素材或其他页一致。',
  '- **冲突**：同一指标/事实在不同页出现不同值或相反表述——必须同时列出两处原文。',
  '- **无来源支撑**：**仅当**上面确实列有可核对素材、且在其中找不到依据时使用（疑似编造或曲解）。',
  '- **无法核实**：未提供素材，或素材未覆盖该主张——**不得因为"没有素材"就判「一致」，也不得判「无来源支撑」**。',
  '',
  '### 必须逐条回答（避免空转式结论）',
  '1. 列出正文中全部具体数字/百分比与页码，逐条给判定（并说明单位与口径是否写清）。',
  '2. 指出同一指标在多页出现的位置，判定值/单位/时间范围是否一致。',
  '3. 列出无法在素材中找到依据的具体主张（有素材时）。',
  '4. 列出结论强于数据的表述（如"显著领先/第一/翻倍"而没有支撑数据）。',
  '5. 声明本次未覆盖的范围（素材缺失、图片无法读、正文被截断等）——**不得把未覆盖说成已通过**。',
  '',
  '### 输出格式与纪律',
  '- markdown 表：`主张/数字 | 页码 | 判定 | 依据（原句或素材出处）`，其后给「必须修改项」与「建议项」。',
  '- 审阅者**不得修改任何文件**；发现问题只报告，不改写引文来凑判定。',
  '- 边界：本协议只管**语义一致性**；版式/溢出/重叠/出界由 `ppt_verify` 等门禁负责，不要混。',
  '- 什么时候跑：有具体数字/事实主张的稿子，交付前跑一次；纯装饰稿可跳过（省成本）。',
  '',
].join('\n')

/**
 * 工具输出（markdown）：完整包落盘 `preview/review-pack.md`，内联部分超上限时明确声明未内联的页
 * （**绝不静默截断**——审阅者必须知道自己没看到什么）。
 */
export function crosscheckReport(ctx) {
  const d = crosscheckDeck(ctx)
  const meta = renderMeta(d)
  const materials = renderMaterials(d)
  const bodyHead = `## 三、正文（阅读顺序，共 ${d.pages.length} 页）\n`
  const secs = d.pages.map(renderPageSection)
  const fullBody = bodyHead + '\n' + secs.join('\n')
  const pack = `${meta}\n${materials}\n\n${fullBody.trimEnd()}\n\n${PROTOCOL}`

  let saved = null
  let saveErr = null
  try {
    mkdirSync(join(d.dir, 'preview'), { recursive: true })
    writeFileSync(join(d.dir, 'preview', 'review-pack.md'), pack, 'utf8')
    saved = 'preview/review-pack.md'
  } catch (e) { saveErr = String(e?.message ?? e) }

  let inlineBody = fullBody
  let trunc = null
  if (saved && fullBody.length > INLINE_BODY_CAP) {
    let acc = ''
    let kept = 0
    for (const s of secs) {
      if (acc.length + s.length > INLINE_BODY_CAP) break
      acc += s
      kept += 1
    }
    const omitted = d.pages.slice(kept).map((p) => p.index)
    trunc = [
      `> ⚠ 正文 ${fullBody.length} 字符 > 内联上限 ${INLINE_BODY_CAP}：**以下只内联前 ${kept} 页**（第 ${omitted.join('、')} 页未内联）。`,
      `> 审阅者**必须**读完整包 \`${saved}\`（含全部 ${d.pages.length} 页）；未读全不得判"全册一致"，并须在第 5 条里声明未覆盖页。`,
      '',
    ].join('\n')
    inlineBody = bodyHead + '\n' + trunc + '\n' + acc
  }
  if (!saved) {
    inlineBody = `${fullBody}\n> ⚠ 材料包未能落盘（${saveErr ?? '未知原因'}）——以上为完整内联，请直接据本文审阅。\n`
  }

  const pointer = saved
    ? `- 完整包已落盘：\`${join(d.dir, 'preview', 'review-pack.md')}\`（同一内容；子代理审阅请让它直接读该文件）`
    : ''
  const head = [meta.trimEnd(), pointer].filter(Boolean).join('\n')
  // 分隔线前必须留空行：正文最后一行是列表项，紧贴 `---` 会被 markdown 当成 setext 标题下划线
  return `${head}\n\n---\n\n${materials}\n\n---\n\n${inlineBody.trimEnd()}\n\n---\n\n${PROTOCOL}`
}
