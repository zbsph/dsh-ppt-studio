#!/usr/bin/env node
/**
 * 导出基元自证（阶段 A §6 / §8）：>2 点折线 · 箭头两端 · 虚线 · attach 接入点 · 字节不变回归。
 * **可复跑、退出码 0/1。**
 *
 * 为什么需要这个脚本：这一批改动全是"写盘形态"的改动（`a:custGeom` 开放路径 / `headEnd` / `prstDash`），
 * 它们的共同特点是——**预览看不出对错**：XML 写错时 PowerPoint 会静默忽略（箭头不出现）、静默降级，
 * 而"文件能打开、页数对、元素计数对"这三样全都还是绿的。所以这里的每一条判据都必须是**外部证据**：
 *
 *   ① 产物 XML 断言：从 zip 里**反读** slide1.xml，断 custGeom 开放路径（moveTo + lnTo、**无 a:close**）、
 *      headEnd+tailEnd 同时存在且**都在 `<a:ln>` 内部**、prstDash 值正确、`<a:path>` 的 lnTo 条数 = 点数−1；
 *   ② 真渲染：`lib/msrender.js` 的 PowerPoint COM 真渲染必须出图，并且**按像素确认折线真的画出来了**
 *      （两段横线 / 一段竖线 / 末端箭头 各自的命中像素数）——"能打开"不等于"画出来了"；
 *   ③ 负面对照：schema 层必须拒收 `arrow:'bogus'` / `dash:'bogus'` / 单点 points；导出层遇到漏网非法值
 *      必须**降级 + 进 report.warnings**，且产物里绝不出现坏 XML；
 *   ④ 字节不变硬门槛：一个**不使用任何新字段**的工程，其产物与基线 tag 的导出器逐部件逐字节一致
 *      （只跳过 docProps/core.xml 的时间戳）；
 *   ⑤ 确定性：同一 deck 连导两次，除 core.xml 外逐字节一致。
 *
 * 【两套夹具，为什么】`export-pptx.js` 里 `import { normalizePage } from './layout.js'` 是 **ESM 活绑定**，
 * 外部注入 `ctx.normalizePage` 完全不生效；而 `src/pptd/layout.js` 当时还没把 `arrow` 的字符串值与 `line.dash`
 * 透传到归一化元素 —— 于是"导出层对不对"与"整链通没通"必须**分开量**：
 *   · ①..⑭（隔离导出层）：把 `src/` 拷进 node_modules 临时目录，只把该副本的 `normalizePage` 换成
 *     "先调真实现、再把这两个字段按原值补回"的包装，用副本的 `exportPptx` 导出 ⇒ 断言的是**导出层实现**；
 *   · ⑮（整链契约）：走**真管线**（deck.yaml → schema → layout → export）⇒ 布局层透传到位才转绿。
 *   · ④/⑬b 的字节不变对照则用**基线 tag 的导出器**（同样取整棵 src/ 到临时目录后 import）。
 *
 * 用法：
 *   node scripts/verify-primitives.mjs
 *   PPT_STUDIO_ALLOW_SKIP_OFFICE=1 node scripts/verify-primitives.mjs   # 无 PowerPoint 时真渲染降级为 SKIP（不计 FAIL）
 *   PPT_STUDIO_PRIMITIVES_DRIFT=1 node scripts/verify-primitives.mjs    # 额外打印"真 layout 归一化 vs 夹具"字段差异
 *
 * 临时产物全部在系统 TEMP 的 `pptd-primitives-verify/`；两个源码副本放在仓库 `node_modules/` 下（用完即删，
 * node_modules 本就 gitignore ⇒ 不产生任何可提交文件）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const allowSkipOffice = process.env.PPT_STUDIO_ALLOW_SKIP_OFFICE === '1'
const WORK = join(tmpdir(), 'pptd-primitives-verify')

// ── 断言脚手架（PASS/FAIL 行 + 退出码，和 verify-*.mjs 家族一致）─────────────
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      └─ ${detail}` : ''}`)
}
const h = (t) => console.log(`\n=== ${t} ===`)
const info = (t) => console.log(`      · ${t}`)

const { resolveDeck, validatePage } = await import('../lib/pptd/schema.js')
const { exportPptx, polylineEndsFromXml } = await import('../lib/pptd/export-pptx.js')
const { normalizePage } = await import('../lib/pptd/layout.js')
const { zipRead, decodeXml } = await import('../lib/zips.js')
const { renderPptxToPng, findPowerPoint } = await import('../lib/msrender.js')

console.log('=== pptd 导出基元自证（阶段 A：折线 / 箭头两端 / 虚线 / 字节不变）===')
console.log(`仓库：${root}`)
console.log(`临时工作区：${WORK}`)
console.log(`PowerPoint：${findPowerPoint() ?? '（未探到）'}｜Office 渲染降级开关：${allowSkipOffice ? '开' : '关'}`)

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

// ══ 夹具 1：基元页（4 点折线 both+dot ／ 2 点直线 arrow:true 回归）════════════
// 坐标全部写常量（YAML 由常量生成）——避免"手写 YAML vs 断言常量"两侧漂移。
const POLY = { id: 'poly1', pts: [[80, 120], [320, 120], [320, 300], [560, 300]], color: '#1F2937', width: 3, arrow: 'both', dash: 'dot' }
const REG = { id: 'line2', pts: [[560, 420], [860, 420]], color: '#1F2937', width: 3, arrow: true }

const DECK = join(WORK, 'deck')
mkdirSync(join(DECK, 'pages'), { recursive: true })
writeFileSync(join(DECK, 'deck.yaml'), [
  'version: 1',
  'title: primitives-verify',
  'size: [960, 540]',
  'theme:',
  '  colors: {primary: "#2563EB", text: "#1F2937"}',
  '  textStyles:',
  '    body: {fontSize: 16, color: "$text"}',
  'pages:',
  '  - pages/01_primitives.yaml',
  '',
].join('\n'), 'utf8')
writeFileSync(join(DECK, 'pages', '01_primitives.yaml'), [
  'pageType: content',
  'elements:',
  `  - elementId: ${POLY.id}`,
  '    elementType: line',
  `    points: ${JSON.stringify(POLY.pts)}`,
  `    arrow: ${POLY.arrow}`,
  `    line: {color: "${POLY.color}", width: ${POLY.width}, dash: ${POLY.dash}}`,
  `  - elementId: ${REG.id}`,
  '    elementType: line',
  `    points: ${JSON.stringify(REG.pts)}`,
  `    arrow: ${REG.arrow}`,
  `    line: {color: "${REG.color}", width: ${REG.width}}`,
  '',
].join('\n'), 'utf8')

// 老工程夹具（**一个字段都不新**）：文本 / 表格 / 形状(含渐变) / 2 点线(arrow: true) / 图片 / 讲稿。
// 用它同时跑：字节不变（vs 基线 tag）+ 确定性 + 2 点线回归。
const legacy = join(WORK, 'legacy')
mkdirSync(join(legacy, 'pages'), { recursive: true })
mkdirSync(join(legacy, 'media'), { recursive: true })
writeFileSync(join(legacy, 'media', 'px.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
writeFileSync(join(legacy, 'deck.yaml'), [
  'version: 1', 'title: legacy-bytes', 'size: [960, 540]', 'theme:',
  '  colors: {primary: "#2563EB", text: "#1F2937", accent: "#F59E0B"}', '  textStyles:',
  '    body: {fontSize: 16, color: "$text"}', 'pages:', '  - pages/01.yaml', '',
].join('\n'), 'utf8')
writeFileSync(join(legacy, 'pages', '01.yaml'), [
  'pageType: content',
  'notes: 讲稿一行',
  'elements:',
  '  - elementId: t1', '    elementType: text', '    bounds: [40, 40, 400, 40]', '    content: {text: "标题 <a&b>", style: "$body"}',
  '  - elementId: tb', '    elementType: table', '    bounds: [40, 100, 300, 80]', '    cols: [指标, 值]', '    rows: [["甲", "1"], ["乙", "2"]]',
  '  - elementId: sh1', '    elementType: shape', '    bounds: [400, 100, 120, 80]', '    kind: roundRect', '    fill: "$primary"',
  '  - elementId: sh2', '    elementType: shape', '    bounds: [400, 200, 120, 80]', '    kind: ellipse', '    fill: {type: gradient, stops: [{pos: 0, color: "#2563EB"}, {pos: 100, color: "#F59E0B"}], angle: 45}',
  '  - elementId: ln1', '    elementType: line', '    points: [[560, 120], [700, 80]]', '    line: {color: "#1F2937", width: 2}', '    arrow: true',
  '  - elementId: im1', '    elementType: image', '    bounds: [560, 160, 120, 80]', '    src: media/px.png',
  '',
].join('\n'), 'utf8')

// 老工程上下文可解析（既有字段）——构建导出上下文与老夹具共用。
const legacyCtx = await resolveDeck(legacy)

/**
 * 夹具导出器（隔离导出层的唯一诚实做法）：
 * `src/pptd/export-pptx.js` 里是 `import { normalizePage } from './layout.js'` —— **ESM 具名导入是活绑定**，
 * 调用点直接引用导入进来的那个函数，`ctx.normalizePage` 之类的外部注入**完全不生效**（实测：注入了也没用）。
 * 所以在"layout.js 尚未透传新字段"的当下，要单独验证导出层，只能做一个**字面源码副本**：
 *   ① 把整棵 `src/` 拷进 node_modules 下的临时目录（相对 import 与裸包 `yaml` 都能解析；跑完即删）；
 *   ② 只改 `pptd/layout.js` 的 `normalizePage` 导出名 → `normalizePageReal`，并追加一个包装：
 *      调用真实现之前，把**布局层还没实现透传**的两个字段（`arrow` 原值、`line.dash`）按原值保住；
 *   ③ 用副本里的 `exportPptx` 导出同一份 deck（颜色解析等仍走真实 layout/schema 逻辑，不另写一套）。
 * 这样"产物 XML 断言"证明的是**导出层的实现**，而"整链是否接通"由 ⑮ 单独判（真管线）。二者不混淆。
 */
const FIXTURE_DIR = join(root, 'node_modules', '.pptd-fixture-src')
{
  const { cpSync } = await import('node:fs')
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  cpSync(join(root, 'src'), FIXTURE_DIR, { recursive: true })
  const layoutPath = join(FIXTURE_DIR, 'pptd', 'layout.js')
  let layoutSrc = readFileSync(layoutPath, 'utf8')
  layoutSrc = layoutSrc.replace('export function normalizePage(page, ctx) {', 'export function normalizePageReal(page, ctx) {')
  layoutSrc += `
// ── 夹具包装（仅存在于 node_modules 下的临时副本；不是仓库源码）──
// 目的：把"布局层还没透传"的新字段按原值保住，从而单独验证**导出层**。
export function normalizePage(page, ctx) {
  const prev = (page.page?.elements ?? []).filter((e) => e.elementType === 'line')
  const els = normalizePageReal(page, ctx)
  for (const el of els) {
    if (el.type !== 'line') continue
    const raw = prev.find((r) => r.elementId === el.id)
    if (!raw) continue
    el.arrow = raw.arrow
    if (raw.line?.dash !== undefined) el.line = { ...el.line, dash: raw.line.dash }
  }
  return els
}
`
  writeFileSync(layoutPath, layoutSrc)
  // 换掉绝对路径依赖（schema.js / svgCharts.js 里的 ../zips.js）——复制成同目录裸名模块
  const shim = { 'schema.js': '../zips.js', 'svgCharts.js': '../zips.js' }
  for (const [file, spec] of Object.entries(shim)) {
    const p = join(FIXTURE_DIR, 'pptd', file)
    if (!existsSync(p)) continue
    writeFileSync(p, readFileSync(p, 'utf8').split(`'${spec}'`).join(`'./zips.js'`))
  }
  cpSync(join(FIXTURE_DIR, 'zips.js'), join(FIXTURE_DIR, 'pptd', 'zips.js'))
}
const fixtureMod = await import(pathToFileURL(join(FIXTURE_DIR, 'pptd', 'export-pptx.js')).href)

/** 夹具上下文：原始元素直接挂到 `page.elements`（导出器读的就是这里）。 */
function ctxWithElements(baseCtx, elements, pageMeta = {}) {
  return {
    ...baseCtx,
    size: baseCtx.size ?? { width: 960, height: 540 },
    pages: [{ file: join(WORK, 'fixture.yaml'), ref: 'fixture.yaml', name: 'fixture', index: 0, page: { pageType: 'content', elements, ...pageMeta } }],
  }
}

const exportFixture = (baseCtx, rawElements, out, pageMeta) =>
  fixtureMod.exportPptx(ctxWithElements(baseCtx, rawElements, pageMeta), { out })

/** 多页夹具：rows = [[elements, pageMeta?], …] ⇒ 第 1 页/第 2 页…（用于"折线页 + 回归页"分别真渲染）。 */
const exportFixturePages = (baseCtx, rows, out) =>
  fixtureMod.exportPptx({
    ...baseCtx,
    size: baseCtx.size ?? { width: 960, height: 540 },
    pages: rows.map(([elements, pageMeta], i) => ({
      file: join(WORK, `fixture${i + 1}.yaml`), ref: `fixture${i + 1}.yaml`, name: `fixture${i + 1}`, index: i,
      page: { pageType: 'content', elements, ...(pageMeta ?? {}) },
    })),
  }, { out })

/**
 * 隔离导出层的夹具构造（**为什么要这么做**）：
 * `export-pptx.js` 里写的是 `import { normalizePage } from './layout.js'` —— ESM 的具名导入是**活绑定**，
 * 不看 `ctx.normalizePage`（我试过：注入 `ctx.normalizePage` 完全无效，产物里 'both'/dash 依旧丢失）。
 * 所以在"layout.js 还没透传新字段"的当下，要单独验证导出层只有一条路：
 * 自己产出**与真实 (layout.js) 归一化结果同构**的归一化元素，再把新字段按原值补上，直接喂给导出器。
 * 颜色解析等仍走 `resolveColor`（契约不另写一套）；`arrow`/`dash` 是布局层**尚未实现**的透传（⑮ 判定的缺口）。
 * @param raw 原始元素（归一化前，含 arrow 原值 / line.dash）
 */
function normRaw(baseCtx, raw) {
  return {
    id: raw.elementId,
    type: raw.elementType,
    bounds: (() => {
      if (Array.isArray(raw.bounds)) return { x: raw.bounds[0], y: raw.bounds[1], w: raw.bounds[2], h: raw.bounds[3] }
      const pts = raw.points ?? []
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) }
    })(),
    ...(raw.role ? { role: raw.role } : {}),
    ...(raw.elementType === 'line'
      ? {
          points: (raw.points ?? [[raw.x1, raw.y1], [raw.x2, raw.y2]]).map((p) => [...p]),
          arrow: raw.arrow, // ← layout.js 现在写的是 `!!el.arrow`（'both' 会被压成 true）
          line: { color: baseCtx.resolveColor(raw.line?.color ?? '#000'), width: raw.line?.width ?? 1, ...(raw.line?.dash !== undefined ? { dash: raw.line.dash } : {}) }, // ← dash 现在被丢
        }
      : {}),
    ...(raw.elementType === 'shape'
      ? {
          kind: raw.kind ?? 'rect',
          fill: raw.fill !== undefined ? baseCtx.resolveColor(raw.fill) : undefined,
          ...(raw.path ? { path: raw.path } : {}),
          rotation: raw.rotation ?? 0,
        }
      : {}),
  }
}

// 夹具漂移体检：真 `layout.js` 的归一化产物 vs 夹具构造的归一化产物。
// 差异必须**只有**那两个待接线的字段（arrow 原值 / line.dash）——多一处就说明夹具构造漂移了。
if (process.env.PPT_STUDIO_PRIMITIVES_DRIFT === '1') {
  const { normalizePage } = await import('../lib/pptd/layout.js')
  const stdPage = ctxWithElements(legacyCtx, PRIM_ELEMENTS)
  const std = normalizePage(stdPage.pages[0], stdPage)
  const iso = PRIM_ELEMENTS.map((e) => normRaw(legacyCtx, e))
  console.log('\n=== 夹具漂移体检（PPT_STUDIO_PRIMITIVES_DRIFT=1）===')
  for (let i = 0; i < std.length; i++) {
    const keys = new Set([...Object.keys(std[i]), ...Object.keys(iso[i])])
    for (const k of keys) {
      const a = JSON.stringify(std[i][k])
      const b = JSON.stringify(iso[i][k])
      if (a !== b) console.log(`  差异 ${std[i].id}.${k}: layout=${a} ↔ 夹具=${b}`)
    }
  }
  console.log('=== 漂移体检结束 ===\n')
}

const PRIM_ELEMENTS = [
  { elementId: POLY.id, elementType: 'line', points: POLY.pts, arrow: POLY.arrow, line: { color: POLY.color, width: POLY.width, dash: POLY.dash } },
  { elementId: REG.id, elementType: 'line', points: REG.pts, arrow: REG.arrow, line: { color: REG.color, width: REG.width } },
]
const REG_ELEMENTS = [
  { elementId: 'plain1', elementType: 'line', points: [[80, 200], [400, 380]], line: { color: '#2563EB', width: 2 } },
  { elementId: 'both2', elementType: 'line', points: [[500, 200], [860, 200]], arrow: true, line: { color: '#1F2937', width: 2 } },
]
// 回归专项：一个**新字段都不用**的页面（2 点 + arrow: true + 无 dash + 一个纯形状）
const PLAIN_ELEMENTS = [
  ...REG_ELEMENTS,
  { elementId: 'card', elementType: 'shape', kind: 'roundRect', bounds: [80, 60, 200, 80], fill: '#2563EB' },
]

// ── 基线导出器（回滚锚点 tag；只读取，绝不改动它）────────────────────────────
// 取整棵 baseline `src/` 到**仓库内 node_modules 下的临时目录**：① 它的相对 import（./layout.js 等）才能解析；
// ② `yaml` 这类裸包说明符要靠 node_modules 逐级上溯才找得到（放到系统 TEMP 下会 ERR_MODULE_NOT_FOUND）。
// node_modules 是 gitignore 的 ⇒ 不产生任何可提交文件；跑完即删。
const BASE_REF = 'v1.1.5-baseline-before-diagram'
const baseDir = join(root, 'node_modules', '.pptd-baseline-src')
rmSync(baseDir, { recursive: true, force: true })
const baseProbe = spawnSync('git', ['-C', root, 'cat-file', '-e', `${BASE_REF}^{commit}`], { encoding: 'utf8' })
let baseReady = baseProbe.status === 0
let baseNote = baseReady ? `基线 = ${BASE_REF}` : `git 取不到 ${BASE_REF}（无 git / 无该 tag）`
if (baseReady) {
  const list = spawnSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', BASE_REF, 'src'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const files = String(list.stdout ?? '').trim().split('\n').filter(Boolean)
  baseReady = list.status === 0 && files.length > 0
  for (const f of files) {
    const r = spawnSync('git', ['-C', root, 'show', `${BASE_REF}:${f}`], { maxBuffer: 32 * 1024 * 1024 })
    if (r.status !== 0) { baseReady = false; break }
    const rel = f.replace(/^src\//, '')
    mkdirSync(join(baseDir, dirname(rel)), { recursive: true })
    writeFileSync(join(baseDir, rel), r.stdout)
  }
  if (!baseReady) baseNote = `基线 ${BASE_REF} 的 src/ 取出失败`
}
const baselineMod = baseReady ? await import(pathToFileURL(join(baseDir, 'pptd', 'export-pptx.js')).href) : null

/**
 * 同一 deck 分别用**基线导出器**与**当前导出器**导出，逐部件比对（只跳过 core.xml 时间戳）。
 * @returns {boolean|null} true=逐字节一致；false=有差异（明细已打印）；null=基线不可用
 */
async function compareWithBaseline(useCtx, newOut, oldOut, label = '') {
  if (!baseReady || !baselineMod) return null
  await exportPptx(useCtx, { out: newOut })
  await baselineMod.exportPptx(useCtx, { out: oldOut })
  const A = zipRead(readFileSync(oldOut))
  const B = zipRead(readFileSync(newOut))
  const skip = new Set(['docProps/core.xml']) // 时间戳必然不同
  const keys = new Set([...A.keys(), ...B.keys()])
  const diffs = []
  for (const k of keys) {
    if (skip.has(k)) continue
    const x = A.get(k)
    const y = B.get(k)
    if (!x || !y) { diffs.push(`${k}: 只在${x ? '旧' : '新'}包里`); continue }
    if (!x.equals(y)) diffs.push(`${k}: 内容不同（旧 ${x.length}B / 新 ${y.length}B）`)
  }
  if (diffs.length) console.log(`      └─ ${label}差异 ${diffs.length} 处：${diffs.slice(0, 8).join(' ｜ ')}`)
  else console.log(`      └─ ${label}${keys.size - skip.size} 个部件逐字节一致`)
  return diffs.length === 0
}

// ══ 1. 导出 + 产物 XML 断言 ═════════════════════════════════════════════════
h('1. 导出与产物 XML 断言（从 zip 反读 slide1.xml）')
const outPptx = join(WORK, 'out.pptx')
// 两页：第 1 页 = 折线（both + dot）+ 同页 2 点直线（arrow: true）；第 2 页 = 纯既有字段回归页。
// 真渲染只渲第 1 页（折线证据），回归页单独出一张图 —— 一页里塞太多会让像素判据互相污染。
const report = await exportFixturePages(legacyCtx, [[PRIM_ELEMENTS], [PLAIN_ELEMENTS]], outPptx)
const parts = zipRead(readFileSync(outPptx))
const s1 = decodeXml(parts.get('ppt/slides/slide1.xml'))
const s2 = decodeXml(parts.get('ppt/slides/slide2.xml'))
info(`parity = ${JSON.stringify(report.parity)}`)

// ── 4 点折线：custGeom 开放路径 ──────────────────────────────────────────
check('① >2 点折线导出为 a:custGeom 开放路径（moveTo + 3×lnTo，同一节内）',
  /<a:custGeom>/.test(s1) && /<a:moveTo><a:pt /.test(s1) && (s1.match(/<a:lnTo>/g) ?? []).length === 3,
  (s1.match(/<a:path\b[^>]*>[\s\S]*?<\/a:path>/) ?? ['（无 a:path）'])[0])
check('② 开放路径**不 close**（有 a:close 会把折线连成封闭多边形 + 多一条"回程"边）',
  !/<a:close\/>/.test(s1))
check('③ 折线无填充（a:noFill 在 custGeom 之后、a:ln 之前；子元素顺序 geom → fill → ln）',
  /<\/a:custGeom><a:noFill\/><a:ln\b/.test(s1))
check('④ a:path/@fill="none"（路径自身不带填充）', /<a:path w="100000" h="100000" fill="none">/.test(s1))
check('⑤ 箭头两端都在：<a:headEnd> 与 <a:tailEnd> 同时存在（arrow: both）',
  /<a:headEnd type="triangle"/.test(s1) && /<a:tailEnd type="triangle"/.test(s1))
check('⑥ 子元素顺序严格：solidFill → prstDash → headEnd → tailEnd（都在同一段 <a:ln> 内）',
  /<a:ln w="\d+"><a:solidFill>[\s\S]*?<\/a:solidFill><a:prstDash val="dot"\/><a:headEnd [^>]*\/><a:tailEnd [^>]*\/><\/a:ln>/.test(s1))
/**
 * 从 slide XML 切出某个元素的完整片段（含它的开标签）。分元素断言的共用工具：
 * 一页里有多条线时，"整页统计"会互相污染（实测踩过：折线段被切到了隔壁 cxnSp 的收尾）。
 */
function elementSeg(xml, id) {
  const nameAt = xml.indexOf(`name="${id}"`)
  if (nameAt < 0) return ''
  const spStart = xml.lastIndexOf('<p:sp>', nameAt)
  const cxnStart = xml.lastIndexOf('<p:cxnSp>', nameAt)
  if (spStart < 0 && cxnStart < 0) return ''
  const isSp = spStart > cxnStart
  const start = isSp ? spStart : cxnStart
  const end = xml.indexOf(isSp ? '</p:sp>' : '</p:cxnSp>', nameAt)
  return xml.slice(start, end < 0 ? xml.length : end + (isSp ? 8 : 11))
}

check('⑦ prstDash 值正确：dash: dot → <a:prstDash val="dot"/>', /<a:prstDash val="dot"\/>/.test(s1))
// 注意：本页有 **2 个 line 元素**（折线 + 回归直线）⇒ 断言必须分元素段做，否则会被隔壁元素污染。
const polySeg = elementSeg(s1, POLY.id)
const regSeg = elementSeg(s1, REG.id)
check('⑧ 折线是一帧 p:sp（不是 N 条 cxnSp）——整页 p:sp=1 / p:cxnSp=1，且折线段是 p:sp 且含 custGeom',
  (s1.match(/<p:sp>/g) ?? []).length === 1 && (s1.match(/<p:cxnSp>/g) ?? []).length === 1 &&
  polySeg.startsWith('<p:sp>') && polySeg.includes('<a:custGeom>'),
  `p:sp=${(s1.match(/<p:sp>/g) ?? []).length} p:cxnSp=${(s1.match(/<p:cxnSp>/g) ?? []).length}｜折线段=${polySeg.slice(0, 80)}…`)

// ── 折线几何反推（写出的 XML → 页面坐标，必须与源 points 一致）─────────────
const backPoly = polylineEndsFromXml(polySeg)
check('⑨ 折线几何反推：custGeom 回读的 4 个顶点 == 源 points（容差 0.01px）',
  backPoly !== null && backPoly.length === 4 && backPoly.every((p, i) => Math.abs(p[0] - POLY.pts[i][0]) < 0.01 && Math.abs(p[1] - POLY.pts[i][1]) < 0.01),
  `源 ${JSON.stringify(POLY.pts)} → 回读 ${JSON.stringify(backPoly?.map((p) => p.map((v) => Math.round(v * 100) / 100)))}`)

// ── 2 点直线（回归）：仍是 straightConnector1，且 arrow: true 语义不变 ────────
check('⑩ 同页 2 点直线未被折线改动波及：该元素段内是 straightConnector1，**没有** custGeom',
  /<a:prstGeom prst="straightConnector1">/.test(regSeg) && !/<a:custGeom>/.test(regSeg),
  regSeg.slice(0, 300))
check('⑪ arrow: true 语义不变：该元素段内只有 tailEnd、**没有** headEnd',
  /<a:tailEnd type="triangle"/.test(regSeg) && !/<a:headEnd/.test(regSeg),
  `tailEnd=${/<a:tailEnd/.test(regSeg)} headEnd=${/<a:headEnd/.test(regSeg)}`)
check('⑫ 没用 dash 的线不写 <a:prstDash>（缺省 solid ⇒ 元素都不出现）',
  !/<a:prstDash/.test(regSeg))
// 回归专项夹具（**独立文件名**：legacyCtx 自带的页面是"老工程 deck"，复用同一路径会把两者互相覆盖——
// 本轮实测踩过：plain-out.pptx 先被回归夹具写、又被老工程 deck 覆写，导致像素判据量的是另一张图）。
const PLAIN_FIXTURE_OUT = join(WORK, 'plainfixture-out.pptx')
await exportFixture(legacyCtx, PLAIN_ELEMENTS, PLAIN_FIXTURE_OUT)
const plainS = decodeXml(zipRead(readFileSync(PLAIN_FIXTURE_OUT)).get('ppt/slides/slide1.xml'))
check('⑬ 回归页（纯既有字段）产物里一个 custGeom / headEnd / prstDash 都没有',
  !/<a:custGeom>/.test(plainS) && !/<a:headEnd/.test(plainS) && !/<a:prstDash/.test(plainS),
  `元素=${(plainS.match(/name="[^"]*"/g) ?? []).join(' ')}`)
check('⑬b 回归专项：纯既有字段页面（2 点线 arrow:true + 形状）与**基线导出器**产物逐部件逐字节一致',
  await compareWithBaseline(legacyCtx, PLAIN_FIXTURE_OUT, join(WORK, 'plainfixture-base.pptx')) === true,
  '差异见上方 ⑬b 的逐部件明细（基线 = v1.1.5-baseline-before-diagram）')
// 同页第二页（out.pptx 的 slide2）也是纯既有字段 ⇒ 同样断"没有新形态"
check('⑬c 同一夹具的第 2 页（纯既有字段）产物里同样没有 custGeom / headEnd / prstDash',
  !/<a:custGeom>/.test(s2) && !/<a:headEnd/.test(s2) && !/<a:prstDash/.test(s2),
  `元素=${(s2.match(/name="[^"]*"/g) ?? []).join(' ')}`)

// ── parity 自证 ───────────────────────────────────────────────────────────
// 两页合计：折线 1（页1）+ 2 点直线 3（页1 一条、页2 两条）⇒ poly 1/1、lines 3/3、'both' 头端 1/1。
const p = report.parity ?? {}
check('⑭ parity 自证全绿（含新增 polyLinesExp/Out、arrowEndsExp/Out）',
  p.ok === true && p.polyLinesExp === 1 && p.polyLinesOut === 1 && p.polyLinesWrong === 0 &&
  p.arrowEndsExp === 1 && p.arrowEndsOut === 1 && p.linesExp === 3 && p.linesOut === 3 && p.linesWrong === 0,
  `ok=${p.ok} poly=${p.polyLinesExp}/${p.polyLinesOut}/wrong${p.polyLinesWrong} arrowHeads=${p.arrowEndsExp}/${p.arrowEndsOut} lines=${p.linesExp}/${p.linesOut}/wrong${p.linesWrong}`)

// ── 整链是否接通（真 DSL 路径：resolveDeck → validatePage → normalizePage → export）────────
// 这是**独立**于上面各条的一条判据：上面的产物断言证明"导出层的实现是对的"，
// 这一条证明"新字段真的能从 deck.yaml 一路走到产物里"（schema 放行 + 归一层原样透传）。
{
  let dslCtx = null
  let dslErr = null
  try { dslCtx = await resolveDeck(DECK) } catch (e) { dslErr = e }
  let wired = false
  let detail = ''
  if (!dslCtx) {
    const msgs = (dslErr?.errors ?? [dslErr?.message ?? String(dslErr)]).join(' ｜ ')
    detail = `deck.yaml 未被 schema 接受 ⇒ schema 侧尚未放行新字段（本脚本写域外，Lead 负责）：${msgs}`
  } else {
    const el = normalizePage(dslCtx.pages[0], dslCtx).find((e) => e.id === POLY.id)
    const polyOk = Array.isArray(el?.points) && el.points.length === 4
    const arrowOk = el?.arrow === 'both'
    const dashOk = el?.line?.dash === 'dot'
    wired = polyOk && arrowOk && dashOk
    const pOut = join(WORK, 'pipeline.pptx')
    await exportPptx(dslCtx, { out: pOut })
    const ps = decodeXml(zipRead(readFileSync(pOut)).get('ppt/slides/slide1.xml'))
    wired = wired && /<a:headEnd/.test(ps) && /<a:prstDash val="dot"\/>/.test(ps) && (ps.match(/<a:lnTo>/g) ?? []).length === 3
    detail = `归一化后：points=${JSON.stringify(el?.points)} arrow=${JSON.stringify(el?.arrow)} line=${JSON.stringify(el?.line)} ⇒ 产物 headEnd=${/<a:headEnd/.test(ps)} prstDash=${/<a:prstDash val="dot"\/>/.test(ps)}`
    if (!wired) {
      detail += '\n      └─ 缺口：src/pptd/layout.js 的 case \'line\' 现在是 `arrow: !!el.arrow`（\'both\' 被压成 true）'
        + '且 `line` 只留 {color,width}（dash 被丢）⇒ 导出层无法区分 both/solid。'
        + 'schema 侧放行后，归一层还需把 arrow 原值（含字符串）与 line.dash 一起透传。'
    }
  }
  check('⑮ 整链接通（真 DSL 路径 ⇒ 本脚本 exit 0 的前提）：deck.yaml → schema → normalizePage → 产物 全链把新字段带到位',
    wired, detail)
}

// 未接通时的响亮提示：不要让"16 条 PASS 但因为整链没通"看起来像全绿
check('⑯ 打样接口说明：本脚本的①..⑭条走的是"夹具直喂归一化元素"（隔离导出层），⑮才是整链契约',
  true, '若 ⑮ FAIL，请先让 schema/layout 放行新字段，再重跑本脚本——那时 ⑮ 与 ①..⑭ 会同时全绿')

// ══ 2. 真渲染（PowerPoint COM）══════════════════════════════════════════════
h('2. 真渲染：PowerPoint COM 逐页出 PNG + 像素级确认折线真的画出来了')
const shots = join(WORK, 'shots')
let pngFiles = []
let renderNote = ''
// COM 偶发 `Presentations.Open : Failed`：实测是**上一条渲染残留的 POWERPNT 实例**在作怪
// （同一份 XML 在 3 轮 ×7 变体里出图 21/21，失败只在实例未回收时出现）⇒ 渲染前先清残留。
const killPowerPoint = () => {
  try { spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Process POWERPNT -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue'], { windowsHide: true, timeout: 30000 }) } catch { /* 忽略 */ }
}
if (findPowerPoint() !== null) {
  for (let attempt = 1; attempt <= 3 && pngFiles.length === 0; attempt++) {
    if (attempt > 1) killPowerPoint()
    try {
      const r = await renderPptxToPng(outPptx, shots, { width: 1920, height: 1080, timeoutMs: 300000, pages: [1, 2] })
      pngFiles = r.files
      renderNote = `pages=${r.pages} png=${r.files.length}${attempt > 1 ? `（第 ${attempt} 次尝试成功；前次为 COM 残留实例）` : ''}`
    } catch (e) {
      renderNote = `COM 失败（第 ${attempt} 次）：${String(e?.message ?? e).split('\n')[0]}`
    }
  }
} else {
  renderNote = '未探到 PowerPoint（findPowerPoint() === null）'
}
if (pngFiles.length === 0) {
  check('真渲染出图（PowerPoint COM）', allowSkipOffice, `${renderNote}${allowSkipOffice ? '（已按 PPT_STUDIO_ALLOW_SKIP_OFFICE=1 降级为 SKIP）' : '——真渲染是本批改动的必需证据（custGeom 开放路径只有 PowerPoint 认才算数）'}`)
} else {
  check('真渲染出图（PowerPoint COM）：两页都出图（页1=折线 both+dot，页2=纯既有字段回归）', pngFiles.length === 2, renderNote)
  for (const f of pngFiles) console.log(`      PNG（绝对路径，Lead 读图核对）：${f}`)

  // ── 像素级确认：折线真的画出来了（不是"文件能打开"）──────────────────────
  // PNG 自己解（零依赖）：IHDR 取尺寸、IDAT inflate、反过滤。
  const png1 = pngFiles.find((f) => /01\.png$/.test(f)) ?? pngFiles[0]
  const img = decodePng(readFileSync(png1))
  check('真渲染 PNG 可解码（IHDR/IDAT 自洽）', !!img && img.width > 800, img ? `${img.width}×${img.height} colorType=${img.colorType}` : '解码失败')
  if (img) {
    const scale = img.width / 960 // COM 1920/960 = 2×（按实际宽度换算，不写死）
    const dark = (r) => countInk(img, r, [31, 41, 55], scale, 60) // #1F2937 ± 60
    // 折线三段：两条横线 + 一条竖线 + 两个折点 + 两端箭头区域
    const segTop = dark([120, 100, 480, 140])
    const segBottom = dark([340, 280, 540, 320])
    const segVert = dark([300, 150, 340, 270])
    const headEnd = dark([62, 104, 100, 136])
    const tailEnd = dark([520, 284, 560, 316])
    const empty = dark([700, 60, 900, 200])
    info(`深色命中像素：上横段 ${segTop}｜下横段 ${segBottom}｜竖段 ${segVert}｜起点箭头区 ${headEnd}｜终点箭头区 ${tailEnd}｜空白对照区 ${empty}`)
    check('像素级：折线三段都被 PowerPoint 真的画出来了（上横 / 竖 / 下横）',
      segTop > 40 && segBottom > 40 && segVert > 40,
      `上=${segTop} 竖=${segVert} 下=${segBottom}（空白对照=${empty}）`)
    check('像素级：空白对照区无同色像素（说明上面的命中不是"整页涂色"）', empty < 20, `empty=${empty}`)

    // ── 第 1 页：同页 2 点直线 + arrow: true（回归）也画出来了 ────────────
    const bothSeg = dark([600, 400, 840, 440]) // line2 = (560,420)→(860,420)
    const bothArrow = dark([820, 404, 872, 436]) // 末端三角头
    info(`页 1 回归线命中：arrow:true 水平线中段 ${bothSeg}｜末端箭头区 ${bothArrow}`)
    check('像素级：页 1 的 2 点直线（arrow: true）被正常画出（旧码路未被波及）', bothSeg > 20, `中段=${bothSeg} 箭头区=${bothArrow}`)

    // ── 第 2 页：纯既有字段回归页（斜线 + 圆角矩形）───────────────────────
    const png2 = pngFiles.find((f) => /02\.png$/.test(f))
    if (png2) {
      const img2 = decodePng(readFileSync(png2))
      if (img2) {
        const sc2 = img2.width / 960
        // plain1 = (80,200)→(400,380)：只取斜线扫过的对角窄带（避开同页其它元素）
        const diagBlue = countInk(img2, [150, 240, 290, 330], [37, 99, 235], sc2, 90)
        const diagAny = countInk(img2, [150, 240, 290, 330], [31, 41, 55], sc2, 60)
        const card = countInk(img2, [100, 70, 260, 130], [37, 99, 235], sc2, 90)
        info(`页 2（回归页）：斜线命中 蓝=${diagBlue} 深=${diagAny}｜圆角矩形卡命中=${card}`)
        check('像素级：页 2 的纯既有字段元素（斜线 + 圆角矩形）被正常画出',
          diagBlue + diagAny > 20 && card > 200,
          `斜线合计=${diagBlue + diagAny} 卡片=${card}`)
      }
    }
  }
}

// ══ 3. 负面对照（schema 层拒收 + 导出层不静默）══════════════════════════════
h('3. 负面对照：非法值必须被拒（schema）或降级并告警（export）——绝不许静默产坏 XML')
const badCases = [
  { name: "arrow: 'bogus'", el: { elementId: 'b1', elementType: 'line', points: [[10, 10], [100, 10]], arrow: 'bogus' } },
  { name: "line.dash: 'bogus'", el: { elementId: 'b2', elementType: 'line', points: [[10, 10], [100, 10]], line: { color: '#000', width: 1, dash: 'bogus' } } },
  { name: '单点 points: [[10,10]]', el: { elementId: 'b3', elementType: 'line', points: [[10, 10]] } },
]
for (const c of badCases) {
  let schemaErr = null
  try { schemaErr = validatePage({ pageType: 'content', elements: [c.el] }, 'neg.yaml') } catch (e) { schemaErr = e }
  const rejected = !!(schemaErr && (schemaErr.errors?.length || String(schemaErr).length))
  const msgs = schemaErr?.errors ?? (schemaErr ? [String(schemaErr)] : [])
  check(`schema 拒收 ${c.name}`, rejected, rejected ? msgs.join(' ｜ ').slice(0, 200) : 'schema 未拒收（非法值会被静默接受）')
}

// 导出层：把非法值直接喂给导出器 ⇒ 必须降级 + 进 warnings，且产物里没有坏 XML
const BAD_ELEMENTS = [
  { elementId: 'bad_arrow', elementType: 'line', points: [[10, 10], [200, 10]], arrow: 'bogus', line: { color: '#1F2937', width: 1 } },
  { elementId: 'bad_dash', elementType: 'line', points: [[10, 40], [200, 40]], line: { color: '#1F2937', width: 1, dash: 'bogus' } },
  { elementId: 'one_pt', elementType: 'line', points: [[10, 70]], line: { color: '#1F2937', width: 1 } },
]
const badOut = join(WORK, 'neg.pptx')
const badReport = await exportFixture(legacyCtx, BAD_ELEMENTS, badOut)
const badS1 = decodeXml(zipRead(readFileSync(badOut)).get('ppt/slides/slide1.xml'))
const badWarn = (badReport.warnings ?? []).join(' ｜ ')
check("导出层：arrow:'bogus' 降级为无箭头 + 进 report.warnings（不静默）",
  badWarn.includes('bogus') && !/<a:headEnd/.test(badS1) && !/<a:tailEnd/.test(badS1), `warnings=${badWarn.slice(0, 240)}`)
check("导出层：dash:'bogus' 降级为 solid（不写 prstDash）+ 进 report.warnings",
  badWarn.includes('dash') && !/<a:prstDash/.test(badS1), `warnings=${badWarn.slice(0, 240)}`)
check('导出层：单点 points 被显式拒绝（进 warnings）且不产出坏 XML（无 NaN/undefined/越界）',
  badWarn.includes('不足 2 点') && !/NaN|undefined|Infinity/.test(badS1),
  `warnings=${badWarn.slice(0, 260)}\n      产物片段=${badS1.slice(badS1.indexOf('<p:spTree>'), badS1.indexOf('<p:spTree>') + 400)}`)
check('导出层：非法/退化夹具的 parity 仍然自洽（3 条线里 1 条被显式拒收 ⇒ lines 2/2，且无 poly）',
  badReport.parity?.polyLinesExp === 0 && badReport.parity?.polyLinesOut === 0 && badReport.parity?.linesExp === 2 && badReport.parity?.linesOut === 2 && badReport.parity?.linesWrong === 0,
  JSON.stringify({ poly: [badReport.parity?.polyLinesExp, badReport.parity?.polyLinesOut], lines: [badReport.parity?.linesExp, badReport.parity?.linesOut], wrong: badReport.parity?.linesWrong }))

// ══ 4. 字节不变硬门槛（基线 tag 对照）═══════════════════════════════════════
h('4. 字节不变：不使用任何新字段的工程 vs 基线 v1.1.5-baseline-before-diagram')
check(`基线可取得：${baseNote}`, baseReady, baseReady ? baseDir : 'git 不可用或 tag 缺失——本条硬门槛**无法**被判为通过（不许安静跳过）')
if (baseReady) {
  const newOut = join(WORK, 'legacy-new.pptx')
  const oldOut = join(WORK, 'legacy-old.pptx')
  const same = await compareWithBaseline(legacyCtx, newOut, oldOut, `老工程（文本/表格/形状/渐变/2 点线+arrow/图片/讲稿）：`)
  check('字节不变（硬门槛）：老工程产物与基线导出器**逐部件逐字节一致**（仅跳过 core.xml 时间戳）',
    same === true,
    same === true ? '全部部件一致（媒体/讲稿 rId 编号也未被动摇）' : '存在差异——见上一条明细')
  const oldS1 = decodeXml(zipRead(readFileSync(oldOut)).get('ppt/slides/slide1.xml'))
  check('字节不变夹具自证：确实含 2 点线 + arrow: true（判据不是空跑）',
    /<a:prstGeom prst="straightConnector1">/.test(oldS1) && /<a:tailEnd/.test(oldS1) && !/<a:headEnd/.test(oldS1) && !/<a:prstDash/.test(oldS1))
}

// ══ 5. 确定性（同一 deck 连导两次）══════════════════════════════════════════
h('5. 确定性：同一 deck 连续导出两次 ⇒ 除 core.xml 外逐字节一致')
{
  const a = zipRead(readFileSync(outPptx))
  const out2 = join(WORK, 'out2.pptx')
  await exportFixturePages(legacyCtx, [[PRIM_ELEMENTS], [PLAIN_ELEMENTS]], out2) // 与第一次**同一个夹具**（两页）
  const b = zipRead(readFileSync(out2))
  const keys = new Set([...a.keys(), ...b.keys()])
  const diffs = []
  for (const k of keys) {
    if (k === 'docProps/core.xml') continue
    const x = a.get(k)
    const y = b.get(k)
    if (!x || !y || !x.equals(y)) diffs.push(k)
  }
  check('确定性：两次导出的全部部件逐字节一致（含 UID 编号、路径单位取整）', diffs.length === 0, diffs.slice(0, 6).join('、') || '全部一致')
}

// ══ 汇总 ═══════════════════════════════════════════════════════════════════
h('汇总')
console.log(`PASS ${pass} / FAIL ${fail}`)
console.log(`临时产物：${WORK}（out.pptx / shots/*.png 可人工复核）`)
rmSync(baseDir, { recursive: true, force: true }) // node_modules 下的基线临时树（用完即删）
if (fail > 0) {
  console.log('结论：FAIL（有判据未通过——详见上面的 FAIL 行）')
  process.exitCode = 1
} else {
  console.log('结论：PASS（折线开放路径 + 两端箭头 + 虚线 + 负面对照 + 字节不变 + 确定性全部通过）')
}

// ── PNG 解码（零依赖：IHDR/PLTE + IDAT inflate + 反过滤；够用于像素命中统计）──────
// PowerPoint 的幻灯片导出常见 colorType=3（调色板）⇒ 必须支持 PLTE/tRNS，
// 否则"渲染成功但读不了像素"，像素级判据会被迫放弃（那就不是证据了）。
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null
  let off = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let palette = null
  let alpha = null
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') alpha = Buffer.from(data)
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!([1, 2, 4, 8].includes(bitDepth)) || ![0, 2, 3, 4, 6].includes(colorType)) return { width, height, colorType, bitDepth, rgb: null }
  // PowerPoint 的调色板导出实测是 **bitDepth=4 / colorType=3**（12 色）⇒ 必须支持 1/2/4 位解包。
  const bitsPerPixel = colorType === 3 || colorType === 0 ? bitDepth : colorType === 4 ? 16 : colorType === 6 ? 32 : 24
  const bpp = Math.max(1, bitsPerPixel >> 3) // 反过滤用（字节/像素）；<8 位时按 1 字节算
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const rgb = Buffer.alloc(width * height * 3)
  let prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride))
    p += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      if (filter === 1) line[i] = (line[i] + a) & 0xff
      else if (filter === 2) line[i] = (line[i] + b) & 0xff
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3
      if (colorType === 3 || colorType === 0) {
        // 取第 x 个样本（1/2/4 位时按位解包；灰度 8 位时就是字节）
        const sample = bitsPerPixel === 8 ? line[x] : (line[(x * bitsPerPixel) >> 3] >> (8 - bitsPerPixel - ((x * bitsPerPixel) & 7))) & ((1 << bitsPerPixel) - 1)
        if (colorType === 3) {
          const pi = sample * 3
          rgb[o] = palette?.[pi] ?? 0
          rgb[o + 1] = palette?.[pi + 1] ?? 0
          rgb[o + 2] = palette?.[pi + 2] ?? 0
        } else {
          // 灰度：按位深归一化到 0..255（只有黑白时 1 位 ⇒ 0/255）
          const v = bitsPerPixel === 8 ? sample : Math.round((sample / ((1 << bitsPerPixel) - 1)) * 255)
          rgb[o] = v
          rgb[o + 1] = v
          rgb[o + 2] = v
        }
      } else if (colorType === 4) {
        const v = line[x * 2]
        rgb[o] = v
        rgb[o + 1] = v
        rgb[o + 2] = v
      } else {
        rgb[o] = line[x * bpp]
        rgb[o + 1] = line[x * bpp + 1]
        rgb[o + 2] = line[x * bpp + 2]
      }
    }
    prev = line
  }
  return { width, height, colorType, bitDepth, palette, alpha, rgb }
}

/**
 * 命中统计：在**页面坐标**矩形 [x1,y1,x2,y2] 内数"接近目标色"的像素。
 * 为什么要按页坐标 + scale：COM 渲染宽度可能不是 1920（写死 2× 会在换分辨率时假绿/假红）。
 */
function countInk(img, [x1, y1, x2, y2], target, scale, tol) {
  if (!img?.rgb) return -1
  const px = (v) => Math.max(0, Math.min(img.width - 1, Math.round(v * scale)))
  const py = (v) => Math.max(0, Math.min(img.height - 1, Math.round(v * scale)))
  let n = 0
  for (let y = py(y1); y <= py(y2); y++) {
    for (let x = px(x1); x <= px(x2); x++) {
      const i = (y * img.width + x) * 3
      if (Math.abs(img.rgb[i] - target[0]) <= tol && Math.abs(img.rgb[i + 1] - target[1]) <= tol && Math.abs(img.rgb[i + 2] - target[2]) <= tol) n++
    }
  }
  return n
}
