/**
 * 测试影响面映射（2026-09-27 新增，用户要求"轻量化测试"）——**改了什么 ⇒ 该跑哪些**。
 *
 * 背景与代价（实测，2026-09-27）：
 *   smoke 全量 311.8s（313 条 / 48 节）· e2e 146.3s · 隔离矩阵 61.7s · 原生图表 48.3s · 损失审计 48.2s
 *   · LF 4.6s · 手册事实审计 0.6s · lib 新鲜度 0.1s · 预设漂移 0.1s ⇒ 全部约 621.7s（10.4 分钟）
 * 所以按改动选面：**廉价跨切面守卫永远全跑**（它们抓的正是"改 A 文件、断言在 B 文件"），
 * 重活（真渲染/真装包/真跑 python）默认不进快测。
 *
 * 三条安全设计（缺一条就会从提效变埋雷）：
 *   ① fail-safe：改动文件没映射到任何东西 ⇒ 视为"影响面未知"，由调用方跑全量（不是跑零条）。
 *   ② 可解释：`--explain` 打印选中了哪些节/脚本、为什么、跳过了什么。
 *   ③ 可审计：`--audit` 保证每个 smoke 分节至少被一条规则覆盖，防"孤儿分节永远不跑"。
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 仓库根（本文件在 scripts/ 下）。 */
export const root = join(import.meta.dirname, '..')

/**
 * 分节分类规则：按 smoke.mjs 里的节标题自动打标签（不手工维护 48 条数据 ⇒ 新增节不会漏）。
 * 顺序敏感：先匹配到的标签先生效；一条规则可给多个标签。
 */
const TAG_RULES = [
  { re: /chart|图表|原生/i, tags: ['chart'] },
  { re: /python-pptx|pptxgenjs|兜底|引擎/i, tags: ['engine', 'fallback'] },
  { re: /导出|export|parity|连线|媒体|讲稿/i, tags: ['export'] },
  { re: /导入|import|手术|splice|patch|模板|template/i, tags: ['import', 'template'] },
  { re: /预览|preview|路由|webServer|shot|截图/i, tags: ['preview', 'render'] },
  { re: /真渲染|Office|渲染/i, tags: ['render'] },
  { re: /技能|手册|文档|事实|漂移/i, tags: ['docs', 'skill'] },
  { re: /预设|preset|隔离|作用域|bundle|安装|install|npm|发布/i, tags: ['preset', 'install'] },
  { re: /verify|门禁|断言|schema|速查/i, tags: ['verify'] },
  { re: /媒体|图片|image|roundRect/i, tags: ['media'] },
  { re: /文本|字号|字体|排版|美学|层叠|重叠/i, tags: ['layout'] },
  { re: /用户目录|DSH_HOME|隔离|测试隔离/i, tags: ['home', 'isolation'] },
  // 以下几条是 `--audit` 抓出来的"曾经选不中"的分节（2026-09-27）：标题措辞不在上面的词表里
  { re: /line bounds|safeArea|缩字|对比度|孤字|绝对路径/i, tags: ['layout', 'verify'] },
  { re: /prst|几何|custGeom|渐变/i, tags: ['export'] },
  { re: /静默降级|状态文件|质量档/i, tags: ['verify', 'engine'] },
  { re: /出界|分级/i, tags: ['verify', 'layout'] },
  { re: /surgicalMap|页映射/i, tags: ['import', 'template'] },
  { re: /内容自证|反推|成品内容/i, tags: ['export', 'verify'] },
]

/**
 * **重节**（默认不进快测）：真渲染 / 真装包 / 真起进程这类耗时大头。
 * 判据是"这一节会不会 spawn 重型外部进程或做真实安装"，不是"这一节重不重要"。
 */
export const HEAVY_SECTIONS = new Map([
  ['§17', '模板库 4 套回归（真实渲染/一致性）'],
  ['§22', 'Office 真渲染通道（spawn PowerPoint COM）'],
  ['§29', '预览路由双重防线（起 webServer）'],
  ['§40', 'profile bundle 安装路径（pnpm 真装）'],
  ['§41', '安装器 + 预设声明（pnpm 真装）'],
  ['§43', 'python-pptx 兜底真跑（spawn python）'],
])

/** 改动文件 → 标签/脚本。glob 用简单前缀与目录规则（避免引入依赖）。 */
const PATH_RULES = [
  { match: (p) => p.startsWith('src/pptd/export-pptx') || p.startsWith('src/pptd/zips'), tags: ['export', 'chart', 'media', 'verify'], note: 'pptx 产物写出层' },
  { match: (p) => p.startsWith('src/pptd/schema') || p.startsWith('src/pptd/layout'), tags: ['verify', 'layout'], note: 'DSL 校验与排版' },
  { match: (p) => p.startsWith('src/pptd/svgCharts'), tags: ['chart', 'preview', 'render'], note: '图表模型/预览 SVG' },
  { match: (p) => p.startsWith('src/pptd/nativeChart'), tags: ['chart', 'export'], note: '原生图表部件' },
  { match: (p) => p.startsWith('src/pptd/import-pptx') || p.startsWith('src/pptd/loss-audit'), tags: ['import', 'template'], note: '导入与有损审计' },
  { match: (p) => p.startsWith('src/pptd/'), tags: ['export', 'verify'], note: 'pptd 其它模块' },
  { match: (p) => p.startsWith('src/tools'), tags: ['verify', 'engine', 'fallback', 'docs'], note: '工具注册/描述/输出' },
  { match: (p) => p.startsWith('src/router'), tags: ['docs', 'verify', 'engine'], note: '提示词与工作流段（含基线超集）' },
  { match: (p) => p.startsWith('src/index') || p.startsWith('src/preset-delivery'), tags: ['preset', 'isolation', 'install'], note: '装配层' },
  { match: (p) => p.startsWith('src/capabilities') || p.startsWith('src/office-qa'), tags: ['fallback', 'engine'], note: '能力探测/官方 QA' },
  { match: (p) => p.startsWith('src/pptxPy') || p.startsWith('src/msrender') || p.startsWith('src/verify'), tags: ['engine', 'fallback', 'verify'], note: '兜底引擎/渲染/门禁' },
  { match: (p) => p.startsWith('src/'), tags: ['verify'], note: 'src 其它' },
  { match: (p) => p.startsWith('skills/'), tags: ['docs', 'skill'], note: '内置技能（有 8000 字上限）' },
  { match: (p) => p.startsWith('docs/') || p === 'README.md', tags: ['docs'], note: '文档（含计数自证/手册事实审计）' },
  { match: (p) => p.startsWith('agent-presets/') || p.startsWith('cordis.patch') || p === 'package.json', tags: ['preset', 'install'], note: '预设/装配清单' },
  { match: (p) => p.startsWith('scripts/smoke') || p.startsWith('scripts/fixtures/'), tags: ['verify', 'docs'], note: '测试自身与基线' },
  { match: (p) => p.startsWith('scripts/'), tags: ['verify'], note: '验证脚本/工具链' },
  { match: (p) => p.startsWith('examples/'), tags: ['verify'], note: '样例工程' },
]

/** 从 smoke.mjs 源码扫出分节（`// ── N. 标题`），标题用于自动打标签。 */
export function sectionsFromSmoke(src = readFileSync(join(root, 'scripts', 'smoke.mjs'), 'utf8')) {
  const out = []
  for (const line of String(src).split(/\r?\n/)) {
    const m = line.match(/^\/\/ ── (\d+(?:\.\d+)?)\.\s*(.*)$/)
    if (m) out.push({ id: `§${m[1]}`, title: m[2].trim() })
  }
  return out
}

/** 给一节打标签。 */
export function tagsOf(section) {
  const tags = new Set()
  for (const r of TAG_RULES) if (r.re.test(section.title)) for (const t of r.tags) tags.add(t)
  if (HEAVY_SECTIONS.has(section.id)) tags.add('heavy')
  return [...tags]
}

/**
 * 核心：改动文件 → 影响面。
 * @returns {{files: string[], tags: Set<string>, sections: {id: string, title: string, tags: string[], heavy: boolean, why: string}[], scripts: string[], unmapped: string[], notes: string[]}}
 */
export function explain(files, { includeHeavy = false } = {}) {
  const norm = files.map((f) => relative(root, f).split(sep).join('/')).filter((f) => f !== '' && !f.startsWith('..'))
  const tags = new Set()
  const scripts = new Set()
  const notes = []
  const unmapped = []
  for (const f of norm) {
    const hit = PATH_RULES.find((r) => r.match(f))
    if (hit === undefined) { unmapped.push(f); continue }
    for (const t of hit.tags) tags.add(t)
    // 文件类型 → 也要跑的独立验证脚本（重脚本只在 includeHeavy 时进快测）
    if (f.startsWith('src/') || f.startsWith('agent-presets/') || f.startsWith('cordis.patch')) scripts.add('check:lib')
    if (f.startsWith('docs/') || f.startsWith('skills/') || f === 'README.md') scripts.add('audit:facts')
    if (f.startsWith('scripts/smoke') || f.startsWith('scripts/fixtures/')) scripts.add('test:preset')
  }
  const all = sectionsFromSmoke()
  const sections = all
    .map((s) => ({ ...s, tags: tagsOf(s), heavy: HEAVY_SECTIONS.has(s.id), why: tagsOf(s).filter((t) => tags.has(t)).join(',') }))
    .filter((s) => s.why !== '' && (includeHeavy || !s.heavy))
  if (norm.length === 0) notes.push('没有改动文件（或不在仓库内）⇒ 影响面未知，调用方应跑全量')
  if (unmapped.length) notes.push(`未映射文件 ${unmapped.length} 个 ⇒ fail-safe：调用方应跑全量（${unmapped.slice(0, 3).join('、')}${unmapped.length > 3 ? '…' : ''}）`)
  return { files: norm, tags, sections, scripts: [...scripts], unmapped, notes }
}

/** 覆盖率审计：每个 smoke 分节都得有标签（否则它永远选不中）。 */
export function audit() {
  const sections = sectionsFromSmoke()
  const untagged = sections.filter((s) => tagsOf(s).filter((t) => t !== 'heavy').length === 0)
  const heavy = sections.filter((s) => HEAVY_SECTIONS.has(s.id))
  const heavyMissing = [...HEAVY_SECTIONS.keys()].filter((id) => !sections.some((s) => s.id === id))
  return { total: sections.length, untagged, heavy, heavyMissing }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.includes('--audit')) {
    const a = audit()
    console.log(`分节总数 = ${a.total}｜重节 = ${a.heavy.length}（${a.heavy.map((s) => s.id).join(' ')}）`)
    if (a.heavyMissing.length) console.log(`⚠ HEAVY_SECTIONS 里已不存在的节：${a.heavyMissing.join(' ')}`)
    if (a.untagged.length) { console.log('⚠ 无标签（永远选不中）的分节：'); a.untagged.forEach((s) => console.log(`   ${s.id} ${s.title}`)) }
    else console.log('✓ 每个分节都有标签（可被影响面选中）')
    process.exit(a.untagged.length || a.heavyMissing.length ? 1 : 0)
  }
  const files = args.filter((a) => !a.startsWith('--'))
  const ex = explain(files, { includeHeavy: args.includes('--with-heavy') })
  console.log(`改动 ${ex.files.length} 个文件｜标签 = ${[...ex.tags].join(',') || '(无)'}`)
  console.log(`选中分节 ${ex.sections.length} 个：${ex.sections.map((s) => `${s.id}[${s.why}]`).join(' ')}`)
  const skippedHeavy = sectionsFromSmoke().filter((s) => HEAVY_SECTIONS.has(s.id)).map((s) => s.id)
  if (!args.includes('--with-heavy')) console.log(`默认跳过重节：${skippedHeavy.join(' ')}`)
  for (const n of ex.notes) console.log(`ℹ ${n}`)
  if (!args.includes('--quiet')) console.log(`建议顺带跑的脚本：${ex.scripts.join(' ') || '(无)'}`)
  process.exit(ex.unmapped.length ? 2 : 0)
}
