/**
 * ppt-studio 模型工具面（首版）：
 * ppt_check / ppt_render / ppt_shot / ppt_verify / ppt_export / ppt_import
 * / ppt_status / ppt_media
 * 统一约定：deck 项目 = 目录（deck.yaml + pages/ + media/）；路径由模型显式传。
 */
import { existsSync } from 'node:fs'
import { readFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { resolveDeck, PptError } from './pptd/schema.js'
import { renderDeck } from './pptd/render-html.js'
import { exportPptx } from './pptd/export-pptx.js'
import { importPptx } from './pptd/import-pptx.js'
import { verifyDeck } from './verify.js'
import { SCHEMA_REF, scaffoldProject } from './scaffold.js'
import { applyAutoDeclare } from './autodeclare.js'
import { runPythonExport, findPython } from './pptxPy.js'
import { imageInfo } from './imgmeta.js'
import { loadProject } from './state.js'

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
    description: '一键生成可跑通全链路的样例 deck 工程（deck.yaml + 3 个页面，含主题 token / 色块衬底 / expectedOverlaps / safeArea 示例）。已存在 deck.yaml 时拒绝覆盖',
    parameters: {
      dir: { type: 'string', required: true, description: '新工程目录（必须为空或不存在 deck.yaml）' },
      name: { type: 'string', description: '工程标题，缺省 my-deck' },
    },
    output: markdownResult(),
    async execute({ dir, name }) {
      try {
        const r = await scaffoldProject(dir, { name })
        return `✓ 已生成样例工程：${r.dir}\n${r.files.map((f) => `  - ${f}`).join('\n')}\n下一步：ppt_check → ppt_render → ppt_verify（应 0 错误）`
      } catch (error) {
        return `✗ 生成失败：${error?.message ?? String(error)}`
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
        return `✓ 渲染完成：${r.htmlFiles.length} 页 HTML + layout.json → ${r.outDir}\n${r.htmlFiles.map((f) => `  - ${f}`).join('\n')}`
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
    description: '数字审阅：基于 preview/layout.json（缺失时先渲染）断言 重叠/出界(含 safeArea)/文本溢出/对齐/密集区；[✗] 错误清零是页级门禁，[·] 为审美建议（非门禁）。含对比度/孤字等启发式建议',
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
    description: '导出 .pptx。engine 缺省 auto（=pptd 自研主引擎，图表矢量拼绘）；python-pptx 仅显式指定（其图表降级为表格，是兜底路线）。pptd 失败时报告原因，可用 /ppt engine python-pptx 切换重试。out 支持绝对路径（原样使用）或文件名（相对 deck 目录）',
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
        const effEngine = engine === 'python-pptx' ? 'python-pptx' : 'pptd' // auto/缺省 = pptd（主引擎）
        if (effEngine === 'python-pptx') {
          const py = findPython()
          if (!py.has) return `⚠ python-pptx 引擎不可用（未检测到 python + python-pptx 环境）：${py.cmd ? '请 pip install python-pptx' : '未找到 python 解释器'}。可改用默认 pptd 引擎。`
          const r = await runPythonExport(ctx0, outName)
          return `✓ 已导出（python-pptx 引擎）：${r.file}\n图表已降级为表格（引擎 A 才支持矢量拼绘图表）。`
        }
        const r = await exportPptx(ctx0, { out: outName, engine: 'pptd' })
        const fitLines = r.autoFit.map((a) => `   - ${a.id}: ${a.from}pt → ${a.to}pt${a.floorHit ? '（已到字号下限仍溢出：请扩大容器或精简文案后再交付）' : ''}`)
        const floorHits = r.autoFit.filter((a) => a.floorHit).length
        const fit = r.autoFit.length
          ? `\n\n⚠ auto-fit 缩放 ${r.autoFit.length} 处文本：\n${fitLines.join('\n')}`
          : ''
        const floorNote = floorHits ? `\n\n✗ ${floorHits} 处达到字号下限（theme.minFontSize）仍溢出——建议修复后再交付，避免放映时文字溢出容器。` : ''
        return `✓ 已导出（pptd 引擎，${r.slides} 页）：${r.file}${fit}${floorNote}`
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
        return `✓ 已导入：${r.outDir}（${r.pages} 页，${r.media.length} 个媒体）\n⚠ ${r.warnings.join('；')}`
      } catch (error) {
        return `✗ 导入失败：\n${errText(error)}`
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

function errText(error) {
  if (error instanceof PptError) return error.messages.map((m) => `  - ${m}`).join('\n')
  return `  - ${error?.message ?? String(error)}`
}
