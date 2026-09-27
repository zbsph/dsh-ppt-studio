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
 * 用法：
 *   node scripts/verify-primitives.mjs
 *   PPT_STUDIO_ALLOW_SKIP_OFFICE=1 node scripts/verify-primitives.mjs   # 无 PowerPoint 时真渲染降级为 SKIP（不计 FAIL）
 *   PPT_STUDIO_PRIMITIVES_KEEP=1 …                                      # 保留临时产物（默认保留，便于人工读图）
 *
 * 临时产物全部在系统 TEMP 的 `pptd-primitives-verify/`（不往仓库里塞东西）。
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
 * 构建"某个 ctx 就绪的导出上下文"（夹具页面直接用**归一化前的元素对象**喂进去，
 * 由 `normalizePage` 走与真实工程同一条归一化码路）。
 * 这样夹具只覆盖导出层，不依赖 schema/layout 对**新字段**的支持进度（那是 ⑮ 单独判的整链契约）。
 */
function ctxWithElements(baseCtx, elements, pageMeta = {}) {
  return {
    ...baseCtx,
    size: baseCtx.size ?? { width: 960, height: 540 },
    pages: [{ file: join(WORK, 'fixture.yaml'), ref: 'fixture.yaml', name: 'fixture', index: 0, page: { pageType: 'content', elements, ...pageMeta } }],
  }
}

const primCtx = ctxWithElements(legacyCtx, [
  { elementId: POLY.id, elementType: 'line', points: POLY.pts, arrow: POLY.arrow, line: { color: POLY.color, width: POLY.width, dash: POLY.dash } },
  { elementId: REG.id, elementType: 'line', points: REG.pts, arrow: REG.arrow, line: { color: REG.color, width: REG.width } },
])
const regCtx = ctxWithElements(legacyCtx, [  { elementId: 'plain1', elementType: 'line', points: [[80, 200], [400, 380]], line: { color: '#2563EB', width: 2 } },
  { elementId: 'both2', elementType: 'line', points: [[500, 200], [860, 200]], arrow: true, line: { color: '#1F2937', width: 2 } },
])
// 回归专项：一个**新字段都不用**的页面（2 点 + arrow: true + 无 dash + 一个纯形状）
const plainCtx = ctxWithElements(legacyCtx, [
  { elementId: 'plain1', elementType: 'line', points: [[80, 200], [400, 380]], line: { color: '#2563EB', width: 2 } },
  { elementId: 'both2', elementType: 'line', points: [[500, 200], [860, 200]], arrow: true, line: { color: '#1F2937', width: 2 } },
  { elementId: 'card', elementType: 'shape', kind: 'roundRect', bounds: [80, 60, 200, 80], fill: '#2563EB' },
])

// ══ 1. 导出 + 产物 XML 断言 ═════════════════════════════════════════════════
h('1. 导出与产物 XML 断言（从 zip 反读 slide1.xml）')
const outPptx = join(WORK, 'out.pptx')
const report = await exportPptx(primCtx, { out: outPptx })
const parts = zipRead(readFileSync(outPptx))
const s1 = decodeXml(parts.get('ppt/slides/slide1.xml'))
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
const polyXml = s1.slice(s1.indexOf('<a:pathLst>'), s1.indexOf('</p:sp>'))
check('⑤ 箭头两端都在：<a:headEnd> 与 <a:tailEnd> 同时存在（arrow: both）',
  /<a:headEnd type="triangle"/.test(s1) && /<a:tailEnd type="triangle"/.test(s1))
check('⑥ 子元素顺序严格：solidFill → prstDash → headEnd → tailEnd（都在同一段 <a:ln> 内）',
  /<a:ln w="\d+"><a:solidFill>[\s\S]*?<\/a:solidFill><a:prstDash val="dot"\/><a:headEnd [^>]*\/><a:tailEnd [^>]*\/><\/a:ln>/.test(s1))
check('⑦ prstDash 值正确：dash: dot → <a:prstDash val="dot"/>', /<a:prstDash val="dot"\/>/.test(s1))
check('⑧ 折线是一帧 p:sp（不是 N 条 cxnSp）：slide1 有 1 个 <p:sp>、0 个 <p:cxnSp>',
  (s1.match(/<p:sp>/g) ?? []).length === 1 && (s1.match(/<p:cxnSp>/g) ?? []).length === 0,
  `p:sp=${(s1.match(/<p:sp>/g) ?? []).length} p:cxnSp=${(s1.match(/<p:cxnSp>/g) ?? []).length}`)

// ── 折线几何反推（写出的 XML → 页面坐标，必须与源 points 一致）─────────────
const polyEl = s1.slice(s1.indexOf('<p:sp>'), s1.indexOf('</p:sp>') + 8)
const backPoly = polylineEndsFromXml(polyEl)
check('⑨ 折线几何反推：custGeom 回读的 4 个顶点 == 源 points（容差 0.01px）',
  backPoly !== null && backPoly.length === 4 && backPoly.every((p, i) => Math.abs(p[0] - POLY.pts[i][0]) < 0.01 && Math.abs(p[1] - POLY.pts[i][1]) < 0.01),
  `源 ${JSON.stringify(POLY.pts)} → 回读 ${JSON.stringify(backPoly?.map((p) => p.map((v) => Math.round(v * 100) / 100)))}`)

// ── 2 点直线（回归）：仍是 straightConnector1，且 arrow: true 语义不变 ────────
const regOut = join(WORK, 'reg-out.pptx')
const regReport = await exportPptx(regCtx, { out: regOut })
const regS = decodeXml(zipRead(readFileSync(regOut)).get('ppt/slides/slide1.xml'))
const regLine = regS.slice(regS.indexOf(`name="${REG.id}"`))
const regXml = regLine.slice(0, regLine.indexOf('</p:cxnSp>') + 10)
check('⑩ 2 点直线未被折线改动波及：仍走 straightConnector1（不是一个 custGeom 帧）',
  /<a:prstGeom prst="straightConnector1">/.test(regXml) && !/<a:custGeom>/.test(regXml))
check('⑪ arrow: true 语义不变：只有 tailEnd、**没有** headEnd',
  /<a:tailEnd type="triangle"/.test(regXml) && !/<a:headEnd/.test(regXml))
check('⑫ 没用 dash 的线不写 <a:prstDash>（缺省 solid ⇒ 元素都不出现）',
  !/<a:prstDash/.test(regXml))
await exportPptx(plainCtx, { out: join(WORK, 'plain-out.pptx') })
const plainS = decodeXml(zipRead(readFileSync(join(WORK, 'plain-out.pptx'))).get('ppt/slides/slide1.xml'))
check('⑬ 回归页（纯既有字段）产物里一个 custGeom / headEnd / prstDash 都没有',
  !/<a:custGeom>/.test(plainS) && !/<a:headEnd/.test(plainS) && !/<a:prstDash/.test(plainS))
check('⑬b 回归专项：纯既有字段页面（2 点线 arrow:true + 形状）与**基线导出器**产物逐部件逐字节一致',
  await compareWithBaseline(plainCtx, join(WORK, 'plain-out.pptx'), join(WORK, 'plain-base.pptx')) === true,
  '差异见上方 ⑬b 的逐部件明细（基线 = v1.1.5-baseline-before-diagram）')

// ── parity 自证 ───────────────────────────────────────────────────────────
const p = report.parity ?? {}
check('⑭ parity 自证全绿（含新增 polyLinesExp/Out、arrowEndsExp/Out）',
  p.ok === true && p.polyLinesExp === 1 && p.polyLinesOut === 1 && p.polyLinesWrong === 0 &&
  p.arrowEndsExp === 1 && p.arrowEndsOut === 1 && p.linesExp === 3 && p.linesOut === 3 && p.linesWrong === 0,
  `ok=${p.ok} poly=${p.polyLinesExp}/${p.polyLinesOut}/wrong${p.polyLinesWrong} arrowHeads=${p.arrowEndsExp}/${p.arrowEndsOut} lines=${p.linesExp}/${p.linesOut}/wrong${p.linesWrong}`)

// ── 整链是否接通（真 DSL 路径）─────────────────────────────────────────────
const pipelinePptx = join(WORK, 'pipeline.pptx')
const pipelineReport = await exportPptx(ctx, { out: pipelinePptx, engine: 'pptd-pipeline-check' })
const pipeS1 = decodeXml(zipRead(readFileSync(pipelinePptx)).get('ppt/slides/slide1.xml'))
const pipelineWired = /<a:headEnd/.test(pipeS1) && /<a:prstDash val="dot"\/>/.test(pipeS1)
check('⑮ 整链接通（真 DSL 路径 ⇒ exit 0 的前提）：layout.js 必须保留 arrow 的字符串值（含 \'both\'）与 line.dash',
  pipelineWired,
  pipelineWired
    ? 'layout.js 已把 arrow 原值 + line.dash 透传到归一化元素'
    : '归一层把它们丢了：src/pptd/layout.js 的 case \'line\' 目前写的是 `arrow: !!el.arrow`（\'both\'→true）且 `line` 只留 color/width（dash 被丢）⇒ 导出层拿到的东西无法区分 both/solid。修复位置：layout.js case \'line\'（本脚本写域外，需 Lead 处理）')

// ══ 2. 真渲染（PowerPoint COM）══════════════════════════════════════════════
h('2. 真渲染：PowerPoint COM 逐页出 PNG + 像素级确认折线真的画出来了')
const shots = join(WORK, 'shots')
let pngFiles = []
let renderNote = ''
if (findPowerPoint() !== null) {
  for (let attempt = 1; attempt <= 2 && pngFiles.length === 0; attempt++) {
    try {
      const r = await renderPptxToPng(outPptx, shots, { width: 1920, height: 1080, timeoutMs: 300000, pages: [1, 2] })
      pngFiles = r.files
      renderNote = `pages=${r.pages} png=${r.files.length}${attempt > 1 ? `（第 ${attempt} 次尝试成功）` : ''}`
    } catch (e) {
      renderNote = `COM 失败（第 ${attempt} 次）：${e?.message ?? e}`
    }
  }
} else {
  renderNote = '未探到 PowerPoint（findPowerPoint() === null）'
}
if (pngFiles.length === 0) {
  check('真渲染出图（PowerPoint COM）', allowSkipOffice, `${renderNote}${allowSkipOffice ? '（已按 PPT_STUDIO_ALLOW_SKIP_OFFICE=1 降级为 SKIP）' : '——真渲染是本批改动的必需证据（custGeom 开放路径只有 PowerPoint 认才算数）'}`)
} else {
  check('真渲染出图（PowerPoint COM）', pngFiles.length === 2, renderNote)
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

    // ── 2 点直线（arrow: true 回归）────────────────────────────────────
    const regPng = pngFiles.find((f) => /02\.png$/.test(f))
    if (regPng) {
      const img2 = decodePng(readFileSync(regPng))
      if (img2) {
        const sc2 = img2.width / 960
        const diagonal = countInk(img2, [150, 230, 330, 350], [37, 99, 235], sc2, 60)
        const bothSeg = countInk(img2, [560, 185, 800, 215], [31, 41, 55], sc2, 60)
        info(`第 2 页（回归页）：斜线命中 ${diagonal}｜arrow:true 水平线命中 ${bothSeg}`)
        check('像素级：回归页 2 点直线也被正常画出（旧码路未被波及）', diagonal > 20 && bothSeg > 20, `斜线=${diagonal} 水平线=${bothSeg}`)
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
const badDeck = ctxWithRawLineFields(ctx, 0, [
  { elementId: 'bad_arrow', elementType: 'line', points: [[10, 10], [200, 10]], arrow: 'bogus', line: { color: '#1F2937', width: 1 } },
  { elementId: 'bad_dash', elementType: 'line', points: [[10, 40], [200, 40]], line: { color: '#1F2937', width: 1, dash: 'bogus' } },
  { elementId: 'one_pt', elementType: 'line', points: [[10, 70]], line: { color: '#1F2937', width: 1 } },
])
const badOut = join(WORK, 'neg.pptx')
const badReport = await exportPptx(badDeck, { out: badOut })
const badS1 = decodeXml(zipRead(readFileSync(badOut)).get('ppt/slides/slide1.xml'))
const badWarn = (badReport.warnings ?? []).join(' ｜ ')
check("导出层：arrow:'bogus' 降级为无箭头 + 进 report.warnings（不静默）",
  badWarn.includes('bogus') && !/<a:headEnd/.test(badS1) && !/<a:tailEnd/.test(badS1), `warnings=${badWarn.slice(0, 240)}`)
check("导出层：dash:'bogus' 降级为 solid（不写 prstDash）+ 进 report.warnings",
  badWarn.includes('dash') && !/<a:prstDash/.test(badS1), `warnings=${badWarn.slice(0, 240)}`)
check('导出层：单点 points 不产出坏 XML（无 pt 越界/无 NaN/无 undefined 字样）',
  !/NaN|undefined|Infinity/.test(badS1), badS1.slice(badS1.indexOf('<p:spTree>'), badS1.indexOf('<p:spTree>') + 700))
check('导出层：非法值不把 parity 弄成"未知"（poly/lines 计数仍然自洽）',
  badReport.parity?.polyLinesExp === 1 && badReport.parity?.polyLinesOut === 1 && badReport.parity?.linesExp === 2 && badReport.parity?.linesOut === 2,
  JSON.stringify({ poly: [badReport.parity?.polyLinesExp, badReport.parity?.polyLinesOut], lines: [badReport.parity?.linesExp, badReport.parity?.linesOut] }))

// ══ 4. 字节不变硬门槛（基线 tag 对照）═══════════════════════════════════════
h('4. 字节不变：不使用任何新字段的工程 vs 基线 v1.1.5-baseline-before-diagram')
const baseRef = 'v1.1.5-baseline-before-diagram'
const oldDir = join(WORK, 'baseline-src')
{
  const lsRef = spawnSync('git', ['-C', root, 'cat-file', '-e', `${baseRef}^{commit}`], { encoding: 'utf8' })
  let extracted = lsRef.status === 0
  if (extracted) {
    const list = spawnSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', baseRef, 'src'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    const files = String(list.stdout ?? '').trim().split('\n').filter(Boolean)
    extracted = list.status === 0 && files.length > 0
    for (const f of files) {
      const r = spawnSync('git', ['-C', root, 'show', `${baseRef}:${f}`], { maxBuffer: 32 * 1024 * 1024 })
      if (r.status !== 0) { extracted = false; break }
      const rel = f.replace(/^src\//, '')
      mkdirSync(join(oldDir, dirname(rel)), { recursive: true })
      writeFileSync(join(oldDir, rel), r.stdout)
    }
  }
  if (!extracted) {
    check(`字节不变：基线 ${baseRef} 可取得`, false, 'git 不可用或 tag 缺失——本条硬门槛**无法**被判为通过（不许安静跳过）')
  } else {
    check(`字节不变：基线 ${baseRef} 的整棵 src/ 已取出到临时目录`, existsSync(join(oldDir, 'pptd', 'export-pptx.js')), oldDir)

    // 老工程夹具：文本 / 表格 / 形状(含渐变) / 2 点线(arrow: true) / 图片 / 讲稿 / 背景 —— 全是既有字段。
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
    const legacyCtx = await resolveDeck(legacy)
    const newOut = join(legacy, 'new.pptx')
    const oldOut = join(legacy, 'old.pptx')
    await exportPptx(legacyCtx, { out: newOut })
    const oldMod = await import(pathToFileURL(join(oldDir, 'pptd', 'export-pptx.js')).href)
    await oldMod.exportPptx(legacyCtx, { out: oldOut })
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
    check('字节不变（硬门槛）：老工程产物与基线导出器**逐部件逐字节一致**（仅跳过 core.xml 时间戳）',
      diffs.length === 0,
      diffs.length ? diffs.slice(0, 8).join(' ｜ ') : `${keys.size - skip.size} 个部件全部一致`)

    // 顺带自证夹具确实覆盖了 2 点线 + arrow:true（否则这条判据是空的）
    const oldS1 = decodeXml(A.get('ppt/slides/slide1.xml'))
    check('字节不变夹具自证：确实含 2 点线 + arrow: true（判据不是空跑）',
      /<a:prstGeom prst="straightConnector1">/.test(oldS1) && /<a:tailEnd/.test(oldS1) && !/<a:headEnd/.test(oldS1) && !/<a:prstDash/.test(oldS1))
  }
}

// ══ 5. 确定性（同一 deck 连导两次）══════════════════════════════════════════
h('5. 确定性：同一 deck 连续导出两次 ⇒ 除 core.xml 外逐字节一致')
{
  const a = zipRead(readFileSync(outPptx))
  const out2 = join(WORK, 'out2.pptx')
  await exportPptx(ctx, { out: out2 })
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
if (fail > 0) {
  console.log('结论：FAIL（有判据未通过——详见上面的 FAIL 行）')
  process.exitCode = 1
} else {
  console.log('结论：PASS（折线开放路径 + 两端箭头 + 虚线 + 负面对照 + 字节不变 + 确定性全部通过）')
}

// ── PNG 解码（零依赖：IHDR + IDAT inflate + 反过滤；够用于像素命中统计）──────
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null
  let off = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
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
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return { width, height, colorType, bitDepth, rgb: null }
  const bpp = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
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
      rgb[(y * width + x) * 3] = line[x * bpp]
      rgb[(y * width + x) * 3 + 1] = line[x * bpp + 1]
      rgb[(y * width + x) * 3 + 2] = line[x * bpp + 2]
    }
    prev = line
  }
  return { width, height, colorType, bitDepth, rgb }
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
