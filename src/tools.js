/**
 * ppt-studio 模型工具面（首版）：
 * ppt_check / ppt_render / ppt_shot / ppt_verify / ppt_export / ppt_import
 * / ppt_status / ppt_media
 * 统一约定：deck 项目 = 目录（deck.yaml + pages/ + media/）；路径由模型显式传。
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import YAML from 'yaml'
import { resolveDeck, PptError } from './pptd/schema.js'
import { renderDeck } from './pptd/render-html.js'
import { exportPptx } from './pptd/export-pptx.js'
import { importPptx } from './pptd/import-pptx.js'
import { verifyDeck } from './verify.js'
import { SCHEMA_REF, scaffoldProject } from './scaffold.js'
import { applyAutoDeclare } from './autodeclare.js'
import { listTemplates, templateWorkspace, registerTemplate, materializeTemplate } from './templates.js'
import { surgicalPatch } from './surgical.js'
import { buildPreview } from './preview-server.js'
import { findPowerPoint, renderPptxToPng } from './msrender.js'
import { runPythonExport, findPython } from './pptxPy.js'
import { imageInfo } from './imgmeta.js'
import { loadProject, loadSession } from './state.js'

/**
 * 引擎解析（C1 决定，2026-09-04 用户拍板）：
 * - auto/缺省 = pptd（主引擎）优先；pptd 硬失败时**允许回退** python-pptx（报告醒目标注降级，绝不静默）。
 * - 显式 engine=pptd / python-pptx：尊重用户显式选择，不自动回退。
 */
export function resolveEngine(engine) {
  if (engine === 'python-pptx') return { engine: 'python-pptx', allowFallback: false }
  if (engine === 'pptd') return { engine: 'pptd', allowFallback: false }
  return { engine: 'pptd', allowFallback: true }
}

/** audit 质量档（C2 决定）：禁用 autoDeclare，防一键声明掩盖真实问题。 */
export function blockedByAudit(quality) {
  return quality === 'audit'
}

/**
 * 预览 URL origin（发布友好，v0.6.3）：完全来自当前 dsh 实例的监听地址（webServer 契约 host/port），
 * 无任何硬编码。边界：监听 0.0.0.0/::（局域网部署）时回退 127.0.0.1（同机访问默认）；远程用户
 * 若经外部地址访问 GUI，以同源相对路径（或未来 client 面板从 location 构造 origin）为准。
 */
export function previewOrigin(ws) {
  if (!ws || typeof ws.port !== 'number') return ''
  let host = typeof ws.host === 'string' && ws.host ? ws.host : '127.0.0.1'
  if (/^(0\.0\.0\.0|::|\[?\:\:\]?)$/.test(host)) host = '127.0.0.1'
  if (/^\[.*\]$/.test(host) && host.includes('::')) return `http://${host}:${ws.port}`
  return `http://${host}:${ws.port}`
}

/** 当前质量档：项目级 state.json 优先，其次会话级（任一为 audit 即 audit）。 */
async function qualityOf(ctx, dir) {
  try {
    const agent = ctx.get('agent')
    const sid = agent?.session?.id
    const session = sid ? await loadSession(sid) : null
    const proj = await loadProject(dir)
    const q = proj?.quality === 'audit' || session?.quality === 'audit' ? 'audit' : (proj?.quality ?? session?.quality ?? 'standard')
    return { quality: q }
  } catch {
    return { quality: 'standard' }
  }
}

/** 内联 defineTool 最小实现（零运行时依赖，生态惯例：插件自包含）。 */
export function defineTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: toJsonSchema(definition.parameters),
    output: definition.output,
    execute: definition.execute,
  }
}

function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    if (meta.enum) prop.enum = meta.enum
    if (meta.items) prop.items = meta.items
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

const dirSchema = { type: 'string', required: true, description: 'deck 项目目录（含 deck.yaml）' }

function markdownResult(text) {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}

async function loadCtx(dir) {
  return resolveDeck(dir)
}

export function registerTools(ctx) {
  const reg = (tool) => ctx.effect(() => ctx.tools.register(defineTool(tool)), `ppt-studio: ${tool.name}`)

  reg({
    name: 'ppt_check',
    description: '校验 deck 项目结构（deck.yaml/pages schema），返回错误清单；错误需修复后才能渲染/导出。line 元素可省略 bounds（由 points 自动推导）',
    parameters: { dir: dirSchema },
    output: markdownResult(),
    async execute({ dir }) {
      try {
        const ctx0 = await loadCtx(dir)
        const counts = { pages: ctx0.pages.length, elements: ctx0.pages.reduce((n, p) => n + (p.page.elements?.length ?? 0), 0) }
        return `✓ PPTD 校验通过：${counts.pages} 页 / ${counts.elements} 元素（${join(dir, 'deck.yaml')}）`
      } catch (error) {
        return `✗ 校验失败：\n${errText(error)}`
      }
    },
  })

  reg({
    name: 'ppt_schema',
    description: 'PPTD DSL 语法速查（deck.yaml / 页面元素 / 主题 token / safeArea / 重叠声明 / 审阅约定）。不熟悉中间层语法时先调这个，避免盲写',
    parameters: {},
    output: markdownResult(),
    async execute() {
      return SCHEMA_REF
    },
  })

  reg({
    name: 'ppt_new',
    description: '一键生成可跑通全链路的样例 deck 工程（deck.yaml + 3 个页面，含主题 token / 色块衬底 / expectedOverlaps / safeArea 示例）。已存在 deck.yaml 时拒绝覆盖。可用 template=<id> 从内置模板库复制工作区（theme + 母版页）',
    parameters: {
      dir: { type: 'string', required: true, description: '新工程目录（必须为空或不存在 deck.yaml）' },
      name: { type: 'string', description: '工程标题，缺省 my-deck' },
      template: { type: 'string', description: '内置模板 id（如 business-blue / academic-white / tech-dark / pitch-bold；缺省=示例工程）' },
    },
    output: markdownResult(),
    async execute({ dir, name, template }) {
      try {
        if (template) {
          // v0.7.0：母版页 = 参考素材（不进门禁）；正式页 = 模板首母版副本（accept 门禁，先 autoDeclare）
          const { mkdir } = await import('node:fs/promises')
          await mkdir(dir, { recursive: true })
          const w = await materializeTemplate(dir, template, { name })
          const cleanup = w.cleanup ? `\n⚠ 模板自带清理说明：${w.cleanup}` : ''
          const refLine = w.reference?.files?.length
            ? `\n  - 参考层（双轨真相，创作前先看：read_image 看 reference/previews/*.png + 读 reference/audit.yaml——与参考用户给的 ppt 制作完全等价）：${w.reference.files.join('、')}\n`
            : ''
          return `✓ 已从模板「${w.meta.name ?? template}」生成工作区：${dir}\n`
            + `  - deck.yaml（模板 theme 已就位；themeConformance=strict 模板一致性门禁；顶部 referenceTemplate 记录参考层）\n`
            + `  - 正式页：${w.formal}（注册进门禁；先跑 ppt_verify autoDeclare=true 声明模板固有有意叠层，剩余错误为模板原文案残留 → 替换内容后自然干净）\n`
            + `  - 参考母版页（_ 前缀，不注册不进门禁）：${w.refs.length ? w.refs.join('、') : '（无）'}\n`
            + `  - 媒体：${w.mediaCount} 个（已复制）${refLine}${cleanup}\n`
            + `下一步：读参考层 → ppt_render → ppt_verify（autoDeclare=true）→ 替换正式页文案 → 逐页制作 → ppt_export`
        }
        const r = await scaffoldProject(dir, { name })
        return `✓ 已生成样例工程：${r.dir}\n${r.files.map((f) => `  - ${f}`).join('\n')}\n下一步：ppt_check → ppt_render → ppt_verify（应 0 错误）`
      } catch (error) {
        return `✗ 生成失败：${error?.message ?? String(error)}`
      }
    },
  })

  reg({
    name: 'ppt_preview',
    description: '生成 PPT 对话内预览（需求 A）：渲染 deck → 静态服务 → 返回在线预览链接（绝对地址，点击即查看本页 + 整览），不用打开本地文件。做完一版/几页后调用，附在交付信息里',
    parameters: {
      dir: { type: 'string', required: true, description: 'deck 项目目录（含 deck.yaml）' },
    },
    output: markdownResult(),
    async execute(args) {
      const dir = args.dir
      try {
        const p = await buildPreview(dir)
        // 绝对 URL：webServer 暴露 host/port（契约，动态适配任意部署）——不同用户的机器/端口各异，
        // 但都来自"当前 dsh 实例"的监听地址，无任何硬编码路径/端口。
        const ws = ctx.get('webServer')
        const origin = previewOrigin(ws)
        const href = (u) => origin + u
        const note = origin
          ? ''
          : '（预览服务未获得监听地址，改提供相对路径；在 GUI 同源访问）'
        return [
          `✓ 在线预览已生成（点击链接直接查看，无需打开本地文件）${note}：`,
          '',
          `本页预览：${href(p.url)}`,
          `整览（全部页面）：${href(p.overviewUrl)}`,
          '',
          `共 ${p.pages} 页；预览根：${p.previewRoot}`,
        ].join('\n')
      } catch (error) {
        return `✗ 预览失败：\n${errText(error)}`
      }
    },
  })

  reg({
    name: 'ppt_visual',
    description: 'Office 真渲染通道（v0.8.0）：用本机 PowerPoint COM 把 .pptx 逐页渲染成 PNG（1920×1080）——① 理解用户原稿（参考任务先看后做）② 成品视觉审核（导出后对 pptx 审核真实观感）。无 Office 时不可用（自动降级 HTML 预览+结构断言）。渲染后请逐页 read_image 查看；视觉理解写入设计摘要/交付说明',
    parameters: {
      pptx: { type: 'string', required: true, description: '源/成品 .pptx 绝对路径（用户原稿或 out.pptx）' },
      out: { type: 'string', description: '输出目录（相对当前目录或绝对；缺省 <pptx 同目录>/..-rendered）' },
    },
    output: markdownResult(),
    async execute(args) {
      try {
        if (!findPowerPoint()) {
          return '⚠ 本机无 Microsoft Office（PowerPoint COM 不可用）：Office 真渲染通道不可用。可继续使用 HTML 预览（ppt_preview）+ 结构断言；本步骤不影响其他工作流。'
        }
        const outDir = args.out ?? join(dirname(args.pptx), 'rendered')
        const r = await renderPptxToPng(args.pptx, outDir)
        if (!r.pages) throw new Error('渲染结果为空（请检查 pptx 是否可打开）')
        return [
          `✓ Office 真渲染完成（${r.pages} 页 → ${outDir}）：`,
          '',
          ...r.files.map((f) => `  - ${f}`),
          '',
          '下一步：逐页 read_image 查看（理解原稿/审核成品观感）。',
        ].join('\n')
      } catch (error) {
        return `✗ Office 真渲染失败：${error?.message ?? String(error)}\n（可降级：ppt_preview HTML 预览 + ppt_verify 结构断言）`
      }
    },
  })

  reg({
    name: 'ppt_templates',
    description: '内置模板库列表（id/名称/风格/适用场景/预览图路径）。从头任务的 S0/S2 展示给用户选择；选定后用 ppt_new dir=... template=<id> 或 /ppt template <id> 生成工作区',
    parameters: {},
    output: markdownResult(),
    async execute() {
      const list = await listTemplates()
      if (!list.length) return '（模板库为空：templates/ 目录缺失或未打包）'
      return `内置模板库（${list.length} 套 · 风格版权自研）：\n\n${list.map((t) => `## ${t.id} — ${t.name}\n风格：${t.style}\n适用：${t.scene}\n关键词：${t.words}\n色板：${t.colors.join('  ')}\n预览图：${t.preview ?? '（未生成）'}\n`).join('\n---\n')}\n使用：ppt_new dir=<新目录> template=<id>（复制模板工作区；模板一致性断言 themeConformance=strict 默认开启）`
    },
  })

  reg({
    name: 'ppt_template_styleaudit',
    description: '模板风格审计（双轨真相层 v0.9.0，设计时声明）：对已收纳模板写入/查看 styleAudit——视觉审计产物（配色/字体/版式规则/装饰清单/审阅页）。写法：先用 read_image 逐页/抽样看该模板整页参考（previews/*.png，Office 真渲染），把视觉理解写成 YAML 传 auditYaml；此后每次"按模板做"直接读审计缓存，不必重看。不传 auditYaml = 仅查看素材/审计现状',
    parameters: {
      id: { type: 'string', required: true, description: '模板 id（ppt_templates 可查）' },
      auditYaml: { type: 'string', description: '视觉审计 YAML（可选）：{palette:[hex],fonts:{title,body},layout:"…",decorations:[…],pagesReviewed:[…],notes:"…"}' },
    },
    output: markdownResult(),
    async execute({ id, auditYaml }) {
      try {
        const t = await templateWorkspace(id)
        if (!auditYaml) {
          const pvDir = join(t.dir, 'previews')
          const pvs = existsSync(pvDir) ? (await readdir(pvDir)).filter((f) => /\.png$/i.test(f)).sort() : []
          return [
            `模板「${t.meta.name ?? id}」参考素材：`,
            ...(existsSync(join(t.dir, 'template.pptx')) ? [`  - 真相层：${join(t.dir, 'template.pptx')}`] : ['  - 真相层：无（内置模板无原始 pptx——YAML 即真相）']),
            ...(pvs.length ? ['  - 整页参考（Office 真渲染）：', ...pvs.map((f) => `    ${join(pvDir, f)}`)] : ['  - 整页参考：无（无 Office 收纳/渲染失败——可用 ppt_visual 对源 pptx 补渲染）']),
            '',
            '当前 styleAudit：',
            t.meta.styleAudit ? YAML.stringify(t.meta.styleAudit) : '（无——尚未审计）',
            '',
            '写法：read_image 看整页参考 → 视觉理解写入 auditYaml（palette/fonts/layout/decorations/pagesReviewed/notes）。',
          ].join('\n')
        }
        const a = YAML.parse(auditYaml)
        if (!a || typeof a !== 'object' || Array.isArray(a)) return '✗ styleAudit 必须是 YAML 对象（palette/fonts/layout/decorations/…）'
        const metaFile = join(t.dir, 'template.yaml')
        const doc = YAML.parseDocument(await readFile(metaFile, 'utf8'))
        doc.set('styleAudit', doc.createNode(a))
        await writeFile(metaFile, String(doc))
        return `✓ styleAudit 已写入模板「${t.meta.name ?? id}」→ ${metaFile}\n  字段：${Object.keys(a).join(', ')}\n下次 materialize 会复制为工作区 reference/audit.yaml——"按模板做"时先读它 + 看 reference/previews（与参考用户 ppt 制作完全等价）`
      } catch (error) {
        return `✗ 风格审计失败：${error?.message ?? String(error)}`
      }
    },
  })

  reg({
    name: 'ppt_template_add',
    description: '外部模板收纳（模板随使用增长通道）：把任意 deck 工程（通常是 ppt_import 产物，用户自己/签购买的模板文件转出来的）注册为内置模板 → templates/<id>/（theme/全部页面/媒体原样转入 + 自动缩略图 + 双轨真相层：原始 pptx + Office 整页真渲染）。用户模板文件 > 导入模板 > 内置精磨，三级增长',
    parameters: {
      dir: { type: 'string', required: true, description: '源工程目录（含 deck.yaml；先 ppt_import 得到）' },
      id: { type: 'string', description: '模板 id（缺省按标题 slug 化；冲突自动加后缀）' },
      name: { type: 'string', description: '模板名称（缺省取工程标题）' },
      style: { type: 'string', description: '风格标签（如 企业蓝/学术白）' },
      scene: { type: 'string', description: '适用场景' },
      sourcePptx: { type: 'string', description: '原始 .pptx 绝对路径（可选；缺省自动取工程内 source.pptx，ppt_import 已保留）' },
    },
    output: markdownResult(),
    async execute(args) {
      try {
        const r = await registerTemplate(args.dir, { id: args.id, name: args.name, style: args.style, scene: args.scene, sourcePptx: args.sourcePptx })
        const track = [
          r.sourcePptx ? `真相层：${r.sourcePptx}（原始 pptx，零失真）` : null,
          r.previews ? `整页参考：${r.previews}（Office 真渲染 ${await countPng(r.previews)} 页）` : null,
          r.meta.cleanup ? `清理：${r.meta.cleanup}` : null,
        ].filter(Boolean)
        return `✓ 已收纳为模板「${r.meta.name}」（id=${r.id}，${r.pages} 张母版页）\n  - ${r.dir}\n  - 预览图：${r.preview ?? '（未生成：无浏览器或渲染失败，模板仍可用）'}\n${track.map((t) => `  - ${t}`).join('\n')}\n下一步（可选）：ppt_template_styleaudit id=${r.id}（先用 read_image 看整页参考 → 写风格审计，模板参考通道的"设计时声明"）`
      } catch (error) {
        return `✗ 收纳失败：${error?.message ?? String(error)}`
      }
    },
  })

  reg({
    name: 'ppt_render',
    description: '渲染 deck 项目 → preview/*.html 与 layout.json（数字审阅的数据源）。每页制作后运行',
    parameters: { dir: dirSchema, debug: { type: 'boolean', description: '文本框描边调试（默认 false）' } },
    output: markdownResult(),
    async execute({ dir, debug }) {
      try {
        const ctx0 = await loadCtx(dir)
        const r = await renderDeck(ctx0, { debug: !!debug })
        const chartNote = r.chartWarnings?.length
          ? `\n\n⚠ 图表数据检查（${r.chartWarnings.length} 处）：\n${r.chartWarnings.map((w) => `   - ${w}`).join('\n')}`
          : ''
        return `✓ 渲染完成：${r.htmlFiles.length} 页 HTML + layout.json → ${r.outDir}\n${r.htmlFiles.map((f) => `  - ${f}`).join('\n')}${chartNote}`
      } catch (error) {
        return `✗ 渲染失败：\n${errText(error)}`
      }
    },
  })

  reg({
    name: 'ppt_shot',
    description: '用本机 Edge headless 截图 preview/*.html → PNG（视觉审阅输入；无浏览器时返回降级提示）',
    parameters: { dir: dirSchema, index: { type: 'number', description: '仅截第 N 页（1 起）；缺省全部' }, outDir: { type: 'string', description: '输出目录，缺省 preview/shots' } },
    output: markdownResult(),
    async execute({ dir, index, outDir }) {
      const edge = findEdge()
      if (!edge) {
        return '⚠ 未检测到 Edge/Chrome：截图不可用。请在浏览器中打开 preview/*.html 人工查看，视觉评审降级为结构断言（ppt_verify）。'
      }
      try {
        const ctx0 = await loadCtx(dir)
        const files = await listPreviewFiles(dir)
        const shotsDir = join(dir, outDir ?? 'preview/shots')
        if (index !== undefined && index >= 1 && index <= files.html.length) {
          const target = files.html[index - 1]
          const out = join(shotsDir, `${String(index).padStart(2, '0')}.png`)
          await shotOne(edge, target, out, ctx0.size, 1)
          return `✓ 已截图：${out}`
        }
        if (index !== undefined) return `✗ 页索引越界（共 ${files.html.length} 页）`
        await mkdir(shotsDir, { recursive: true })
        const results = []
        for (let i = 0; i < files.html.length; i++) {
          const out = join(shotsDir, `${String(i + 1).padStart(2, '0')}.png`)
          await shotOne(edge, files.html[i], out, ctx0.size, 1)
          results.push(out)
        }
        return `✓ 已截图 ${results.length} 页：${shotsDir}\n${results.map((r) => `  - ${r}`).join('\n')}`
      } catch (error) {
        return `✗ 截图失败：\n${errText(error)}`
      }
    },
  })

  reg({
    name: 'ppt_verify',
    description: '数字审阅：基于 preview/layout.json（缺失时先渲染）断言 重叠/出界/文本溢出/对齐/密集区；[✗] 错误清零是页级门禁，[·] 为审美建议（非门禁）。出界分级：超页面边界=永远错误；超安全区=声明制（页面 expectedOutOfSafeArea 声明命中→✓预期出界）。含对比度/孤字等启发式建议',
    parameters: {
      dir: dirSchema,
      autoDeclare: { type: 'boolean', description: 'true = 把未声明的警告级重叠（色块衬底/图片标注/箭头跨越等，不含内容互压）一键写入页面 expectedOverlaps 后重验（对应"设计意图声明制"的批量声明，仍会报告剩余不可声明错误）' },
    },
    output: markdownResult(),
    async execute(args) {
      const dir = args.dir
      const autoDeclare = !!args.autoDeclare
      try {
        if (autoDeclare) {
          const { quality } = await qualityOf(ctx, dir)
          if (blockedByAudit(quality)) {
            return '✗ audit 质量档禁用 autoDeclare（防一键声明掩盖真实问题，C2 决定）：请切回 standard/quick 档，或逐对手工声明后重验。'
          }
          const ctx0 = await loadCtx(dir)
          const r0 = await renderDeck(ctx0, {})
          const added = await applyAutoDeclare(ctx0, r0.layout)
          // 声明已写入 → 重新加载项目（resolveDeck 是读时快照）并重验
          const ctx1 = await loadCtx(dir)
          const r = await renderDeck(ctx1, {})
          const v = verifyDeck(r.layout)
          const errors = v.text.split('\n').filter((l) => l.includes('[✗]')).length
          const addedNote = added.length
            ? `\n已写入声明：${added.map((a) => `第${a.page}页 +${a.added}对`).join('，')}`
            : '\n未发现可自动声明的警告级重叠（全部已声明/内容互压/豁免）。'
          return `# 审阅（autoDeclare 后）${addedNote}\n${v.text}\n\n---\n门禁：${errors === 0 ? '✓ 通过' : `✗ ${errors} 个错误（若均为 content-collision，请手工调整布局；声明制不支持内容互压豁免）`}`
        }
        let layout = null
        const layoutFile = join(dir, 'preview', 'layout.json')
        if (existsSync(layoutFile)) layout = JSON.parse(await readFile(layoutFile, 'utf8'))

        // pptx 产物快照（引擎无关）：若项目里有导出产物，用 XML 几何交叉校验
        const pptxSnapshotText = await snapshotPptxShapes(dir)
        const ctx0 = layout ? null : await loadCtx(dir)
        if (!layout && ctx0) {
          const r = await renderDeck(ctx0, {})
          layout = r.layout
        }
        const v = verifyDeck(layout)
        const errors = v.text.split('\n').filter((l) => l.includes('[✗]')).length
        const head = v.text
        return `# 数字审阅\n${head}\n\n---\n门禁：${errors === 0 ? '✓ 通过' : `✗ ${errors} 个错误（必须清零）`}\n${pptxSnapshotText}`
      } catch (error) {
        return `✗ 验证失败：\n${errText(error)}`
      }
    },
  })

  reg({
    name: 'ppt_export',
    description: '导出 .pptx。engine 缺省 auto（=pptd 自研主引擎，图表矢量拼绘；hard 失败时自动回退 python-pptx 并醒目标注降级）；python-pptx 仅显式指定（其图表降级为表格）。out 支持绝对路径（原样使用）或文件名（相对 deck 目录）。audit 质量档自动追加回读断言（页数/尺寸/最小字号）',
    parameters: {
      dir: dirSchema,
      engine: { type: 'string', enum: ['auto', 'pptd', 'python-pptx'], description: '缺省 auto（=pptd）；python-pptx 需 python 环境' },
      out: { type: 'string', description: '输出文件名（相对 deck 目录）或绝对路径，缺省 out.pptx' },
    },
    output: markdownResult(),
    async execute({ dir, engine, out }) {
      try {
        const ctx0 = await loadCtx(dir)
        const outName = out ?? 'out.pptx'
        const eff = resolveEngine(engine) // auto/缺省 = pptd（主引擎），pptd 硬失败时允许回退 python-pptx（C1 决定）
        const { quality } = await qualityOf(ctx, dir)
        const audit = blockedByAudit(quality)
        const withAudit = async (file, extra = '') => {
          let note = extra
          // v0.8.0：audit 档 + 本机有 Office → 导出后自动 Office 真渲染（成品视觉审核，可 read_image 复核）
          if (audit && findPowerPoint()) {
            try {
              const visDir = join(dir, 'preview', 'office-render')
              const r = await renderPptxToPng(file, visDir)
              note += `\nOffice 真渲染审核（audit 档自动）：${r.pages} 页 → ${visDir}\n请逐页 read_image 复核成品观感（无 Office 机器自动跳过此步）。`
            } catch (e) {
              note += `\nOffice 真渲染审核失败（已降级为 HTML 预览+结构断言）：${e?.message ?? e}`
            }
          }
          if (!audit) return note
          return `${note}\n${await auditExportCheck(ctx0, file, ctx0.minFontSize)}`
        }
        if (eff.engine === 'python-pptx' && !eff.allowFallback) {
          const py = findPython()
          if (!py.has) return `⚠ python-pptx 引擎不可用（未检测到 python + python-pptx 环境）：${py.cmd ? '请 pip install python-pptx' : '未找到 python 解释器'}。可改用默认 pptd 引擎。`
          const r = await runPythonExport(ctx0, outName)
          return `✓ 已导出（python-pptx 引擎）：${r.file}\n图表已降级为表格（引擎 A 才支持矢量拼绘图表）。${await withAudit(r.file)}`
        }
        try {
          const r = await exportPptx(ctx0, { out: outName, engine: 'pptd' })
          const fitLines = r.autoFit.map((a) => `   - ${a.id}: ${a.from}pt → ${a.to}pt${a.floorHit ? '（已到字号下限仍溢出：请扩大容器或精简文案后再交付）' : ''}`)
          const floorHits = r.autoFit.filter((a) => a.floorHit).length
          const fit = r.autoFit.length
            ? `\n\n⚠ auto-fit 缩放 ${r.autoFit.length} 处文本：\n${fitLines.join('\n')}`
            : ''
          const floorNote = floorHits ? `\n\n✗ ${floorHits} 处达到字号下限（theme.minFontSize）仍溢出——建议修复后再交付，避免放映时文字溢出容器。` : ''
          const chartNote = r.chartInfos?.length
            ? `\n\n⚠ 图表数据检查（${r.chartInfos.length} 处）：\n${r.chartInfos.map((w) => `   - ${w}`).join('\n')}`
            : ''
          return `✓ 已导出（pptd 引擎，${r.slides} 页）：${r.file}${fit}${floorNote}${chartNote}${await withAudit(r.file)}`
        } catch (error) {
          // 自动回退链（C1 决定）：auto 且 pptd 硬失败 → 有 python-pptx 则兜底并醒目标注降级（绝不静默）
          if (eff.allowFallback) {
            const py = findPython()
            if (py.has) {
              try {
                const r2 = await runPythonExport(ctx0, outName)
                return `⚠ pptd 引擎失败，已自动降级 python-pptx（图表降级为表格）：${error?.message ?? error}\n✓ 已导出（python-pptx 兜底）：${r2.file}\n建议排查 pptd 失败原因（见上）或改用质量更高的模式。${await withAudit(r2.file)}`
              } catch (e2) {
                return `✗ pptd 失败（${error?.message ?? error}）且 python-pptx 兜底也失败：${e2?.message ?? e2}`
              }
            }
            return `✗ pptd 导出失败：${error?.message ?? error}\n（auto 模式：python-pptx 环境不可用，无兜底可选；可 /ppt engine python-pptx 或安装 python-pptx 后重试）`
          }
          throw error
        }
      } catch (error) {
        return `✗ 导出失败：\n${errText(error)}`
      }
    },
  })

  reg({
    name: 'ppt_import',
    description: '导入已有 .pptx → deck 项目（内容保真、版式参考；补完/修改/总结任务的开端）',
    parameters: {
      pptx: { type: 'string', required: true, description: '源 .pptx 绝对路径' },
      outDir: { type: 'string', required: true, description: '输出项目目录（将写入 deck.yaml/pages/media）' },
    },
    output: markdownResult(),
    async execute({ pptx, outDir }) {
      try {
        const r = await importPptx(pptx, outDir)
        const refLine = r.reference?.previews?.length
          ? `\n参考层（参考双轨 v0.9.1——创作前先 read_image 看 reference/previews/*.png 真身再动手，与"按模板做"同一通道）：reference/source.pptx + ${r.reference.previews.length} 页真渲染`
          : `\n⚠ 无整页真渲染参考（无 Office/渲染失败）：可用 ppt_visual 对 source.pptx 补渲；骨架层仍可用`
        return `✓ 已导入：${r.outDir}（${r.pages} 页，${r.media.length} 个媒体；原始 pptx 已保留为 source.pptx —— 参考双轨真相层）${refLine}\n⚠ ${r.warnings.join('；')}`
      } catch (error) {
        return `✗ 导入失败：\n${errText(error)}`
      }
    },
  })

  reg({
    name: 'ppt_patch',
    description: '手术模式（v0.10.0，候选 B）：以模板 .pptx 为底版做"结构精确贴模板"——模板页的文本/表格槽被工作区内容替换（只改 <a:t>，rPr/几何/渐变/字体/图片全部原样保留），其余页内容逐字节不变（sha256 验证）。**适用**：按模板做的成品要"看起来就是模板原样"（双轨参考只解决风格，手术解决结构保真）。**限制（v1）**：只替换文本形状+表格；组合内文本/图片不动；deck 页数超过模板页数的多出页不注入（警告）；表格行数超出模板的警告。与 ppt_export 互不影响——常规导出仍走 PPTD 渲染',
    parameters: {
      template: { type: 'string', required: true, description: '模板 .pptx 绝对路径（优先用工作区 reference/template.pptx——双轨真相层）' },
      dir: { type: 'string', required: true, description: '工作区目录（含 deck.yaml；页面内容为内容真相）' },
      out: { type: 'string', description: '输出 .pptx（缺省 <dir>/out-surgical.pptx）' },
      map: { type: 'string', description: '页映射 JSON（可选）：{"1":3,"2":1} 模板页号(1-based)→deck 页号(1-based)；缺省=序号对齐' },
    },
    output: markdownResult(),
    async execute({ template, dir, out, map }) {
      try {
        let pageMap = {}
        if (map) {
          pageMap = JSON.parse(map)
          if (!pageMap || typeof pageMap !== 'object' || Array.isArray(pageMap)) return '✗ map 必须是 JSON 对象：{"模板页号": "deck 页号"}'
        }
        const outPath = out ?? join(dir, 'out-surgical.pptx')
        const r = await surgicalPatch({ template, deckDir: dir, out: outPath, map: pageMap })
        const lines = [
          `✓ 手术完成：${r.out}（模板 ${r.templateSlides} 页 / deck ${r.deckPages} 页）`,
          '',
          '页处理：',
          ...r.pages.map((p) => `  - 模板第 ${p.index} 页 [${p.action}]${p.fields ? ` 替换字段 ${p.fields}${p.cleared ? `（含清空 ${p.cleared}）` : ''}` : ''}${p.tableCells ? ` 表格 cell ${p.tableCells}` : ''}${p.note ? ` ${p.note}` : ''}`),
          `替换统计：文本字段 ${r.fields} / 表格 cell ${r.tableCells}`,
          `完整性验证（未手术条目解包内容 sha256 与模板一致性）：${r.verify.identical}/${r.verify.total} ✓${r.verify.mismatched ? ` ✗ 不一致：${r.verify.details.join(', ')}` : ''}`,
          ...(r.warnings.length ? ['', '⚠ 警告：', ...r.warnings.map((w) => `  - ${w}`)] : []),
          '',
          '下一步（可选）：ppt_visual 对成品 Office 真渲染审核（确认视觉 = 模板原样 + 内容已换）。',
        ]
        return lines.join('\n')
      } catch (error) {
        return `✗ 手术失败：\n${errText(error)}`
      }
    },
  })

  reg({
    name: 'ppt_status',
    description: '查看工作流状态（任务类型/阶段/暂停点/页状态/引擎/质量模式）',
    parameters: { dir: { type: 'string', description: 'deck 项目目录（可选）' } },
    output: markdownResult(),
    async execute({ dir }) {
      if (!dir) return '未指定项目目录（--dir）。'
      const proj = await loadProject(dir)
      const lines = [
        `任务类型: ${proj.taskType ?? 'unknown'}`,
        `阶段: ${proj.stage ?? '未开始'}`,
        `质量模式: ${proj.quality}`,
        `暂停点: ${proj.pauseAfter.length ? proj.pauseAfter.join(', ') : '无'}`,
        `页状态: ${Object.keys(proj.pages ?? {}).length ? JSON.stringify(proj.pages) : '无'}`,
      ]
      return lines.join('\n')
    },
  })

  reg({
    name: 'ppt_media',
    description: '读取图片物理规格（宽高/格式，程序化，无需视觉模型）；用于布局计算与素材 manifest',
    parameters: { files: { type: 'array', items: { type: 'string' }, required: true, description: '图片绝对路径列表' } },
    output: markdownResult(),
    async execute({ files }) {
      const out = []
      for (const f of files ?? []) {
        try {
          const data = await readFile(f)
          const info = imageInfo(data)
          out.push(`${f} → ${info.format} ${info.width}×${info.height}px`)
        } catch (error) {
          out.push(`${f} → 读取失败：${error?.message ?? error}`)
        }
      }
      return out.join('\n')
    },
  })
}

async function listPreviewFiles(dir) {
  const files = await readdir(join(dir, 'preview'))
  const html = files.filter((f) => f.endsWith('.html') && f !== 'deck.html').sort().map((f) => join(dir, 'preview', f))
  return { html }
}

async function shotOne(edge, htmlPath, outPng, size, scale) {
  await mkdir(dirname(outPng), { recursive: true })
  const url = pathToFileURL(htmlPath).href
  const profileDir = join(tmpdir(), `dsh-ppt-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await new Promise((resolve, reject) => {
    const child = spawn(edge, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--force-device-scale-factor=' + scale,
      `--user-data-dir=${profileDir}`, '--disk-cache-size=1', '--disable-application-cache',
      `--window-size=${size.width},${size.height}`,
      `--screenshot=${outPng}`,
      url,
    ], { stdio: 'ignore', windowsHide: true })
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Edge 退出码 ${code}`)))
    child.on('error', reject)
    setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Edge 截图超时')) }, 60000)
  })
  return profileDir
}

function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/** 数字审阅补充：从已导出的 pptx XML 读取精确几何（引擎无关快照的“产物档”）。 */
async function snapshotPptxShapes(dir) {
  const out = join(dir, 'out.pptx')
  if (!existsSync(out)) return ''
  try {
    const { zipRead } = await import('./zips.js')
    const { parseXml, first, allText } = await import('./xmljs.js')
    const buf = await readFile(out)
    const files = zipRead(buf)
    let n = 0
    for (let i = 1; files.has(`ppt/slides/slide${i}.xml`); i++) {
      const slide = parseXml(files.get(`ppt/slides/slide${i}.xml`).toString('utf8'))
      const spTree = first(first(slide, 'cSld'), 'spTree')
      n += (spTree?.children ?? []).filter((c) => ['sp', 'pic', 'graphicFrame', 'cxnSp'].includes(c.tag)).length
    }
    return `产物快照（pptx XML）：${n} 个顶层形状（参与导出几何与中间层一致性）`
  } catch {
    return ''
  }
}

/**
 * audit 档导出回读断言（D2 决定，v0.3.2）：页数 / 尺寸 / 最小字号 ≥ minFontSize。
 * 产物档（XML 权威坐标）与中间层一致性校验；audit 档自动追加到导出报告。
 */
async function auditExportCheck(ctx, file, minFontSize) {
  try {
    const { zipRead } = await import('./zips.js')
    const buf = await readFile(file)
    const parts = zipRead(buf)
    let slideCount = 0
    let minSz = Infinity
    for (let i = 1; parts.has(`ppt/slides/slide${i}.xml`); i++) {
      slideCount++
      const xml = parts.get(`ppt/slides/slide${i}.xml`).toString('utf8')
      for (const m of xml.matchAll(/sz="(\d+)"/g)) {
        const v = Number(m[1])
        if (v < minSz) minSz = v
      }
    }
    const pres = parts.get('ppt/presentation.xml')?.toString('utf8') ?? ''
    const cx = Number(pres.match(/cx="(\d+)"/)?.[1] ?? 0)
    const cy = Number(pres.match(/cy="(\d+)"/)?.[1] ?? 0)
    const sizeOk = cx === ctx.size.width * 12700 && cy === ctx.size.height * 12700
    const fontOk = minSz / 100 >= minFontSize
    const lines = [
      `audit 回读断言（产物 OOXML）：页数 ${slideCount}/${ctx.pages.length} ${slideCount === ctx.pages.length ? '✓' : '✗'}；尺寸 ${(cx / 12700).toFixed(0)}×${(cy / 12700).toFixed(0)}pt（期望 ${ctx.size.width}×${ctx.size.height}）${sizeOk ? '✓' : '✗'}；最小字号 ${minSz / 100}pt（下限 ${minFontSize}pt）${fontOk ? '✓' : '✗'}`,
    ]
    return lines.join('\n')
  } catch (e) {
    return `audit 回读断言失败（无法校验产物）：${e?.message ?? e}`
  }
}

function errText(error) {
  if (error instanceof PptError) return error.messages.map((m) => `  - ${m}`).join('\n')
  return `  - ${error?.message ?? String(error)}`
}

/** 统计目录内 PNG 数（模板整页参考计数）。 */
async function countPng(dir) {
  try {
    return (await readdir(dir)).filter((f) => /\.png$/i.test(f)).length
  } catch {
    return 0
  }
}
