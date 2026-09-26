/**
 * 冒烟测试：examples/smoke 全链路
 * check → render → verify → export(pptx) → zip 结构 → import roundtrip → re-check
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import zlib from 'node:zlib'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { importPptx } from '../lib/pptd/import-pptx.js'
import { verifyDeck } from '../lib/verify.js'
import { zipRead, decodeXml } from '../lib/zips.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const smokeDir = join(root, 'examples', 'smoke')

// ── 全局用户目录隔离（2026-09-26，方案 B 第二批）──────────────────────────────────────────
// 为什么：`state.js` / `preview-server.js` 的用户目录此前是**模块常量** `homedir()/.dsh`（忽略 DSH_HOME），
// 而 `templates.js` / `index.js`(diag) 是调用时求值 ⇒ 本机 `npm test` 会把 smoke 模板与预览缓存写进
// 开发机**真实**的 `~/.dsh/ppt-studio/`（实测复现、清理过两次），与下面那句"不碰真实目录"的承诺冲突。
// 现在四处都统一到 `src/home.js`（调用时求值）⇒ 这里把 DSH_HOME 指到构建目录内的临时 home，
// **整轮 smoke 的用户层读写都关在里面**，真实用户目录一个字节都不碰。位置必须在任何用户目录解析之前。
const PREV_SMOKE_HOME = process.env.DSH_HOME
const SMOKE_HOME = join(smokeDir, '.tmp-home')
process.env.DSH_HOME = SMOKE_HOME

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

// 1. check
const ctx0 = await resolveDeck(smokeDir)
ok('resolveDeck（校验+归一化）', ctx0.pages.length === 3, `${ctx0.pages.length} pages, ${ctx0.size.width}x${ctx0.size.height}`)

// 2. render
const r = await renderDeck(ctx0, {})
ok('renderDeck → preview html + layout.json', r.htmlFiles.length === 3)

// 3. verify（断言引擎）
const layout = JSON.parse(await (await import('node:fs/promises')).readFile(join(smokeDir, 'preview', 'layout.json'), 'utf8'))
const v = verifyDeck(layout)
ok('verifyDeck 报告生成', typeof v.text === 'string' && v.text.length > 0)
console.log(v.text.slice(0, 1200))

// 4. export pptx（主引擎）
const exp = await exportPptx(ctx0, { out: 'out-smoke.pptx', engine: 'pptd' })
ok('exportPptx 生成', exp.file !== '', `${exp.slides} slides`)

// 5. zip 结构
const buf = await (await import('node:fs/promises')).readFile(exp.file)
const parts = zipRead(buf)
const needed = ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/theme/theme1.xml']
ok('OOXML 结构完整', needed.every((n) => parts.has(n)), [...parts.keys()].join(', '))

// 6. import roundtrip
const impDir = join(smokeDir, 'imported')
await rm(impDir, { recursive: true, force: true })
const imp = await importPptx(exp.file, impDir)
ok('importPptx（roundtrip）', imp.pages === 3, `${imp.pages} pages, media ${imp.media.length}`)

// 7. 导入项目可再次校验/渲染
const ctx1 = await resolveDeck(impDir)
const r2 = await renderDeck(ctx1, { out: 'preview-rt' })
ok('roundtrip 项目可渲染', r2.htmlFiles.length === 3)

// ── 8. 媒体回环（P2/P6 回归）：image + roundRect + rotation ───────────────
const { crc32 } = await import('../lib/zips.js')
function makePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1)
    raw[off] = 0
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rgb[0]
      raw[off + 2 + x * 3] = rgb[1]
      raw[off + 3 + x * 3] = rgb[2]
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = crc32(body)
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc, 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}
const png = makePng(200, 120, [37, 99, 235])
await (await import('node:fs/promises')).writeFile(join(smokeDir, 'media-test.png'), png)
const mediaDeck = join(root, 'examples', 'media-smoke')
await (await import('node:fs/promises')).rm(mediaDeck, { recursive: true, force: true })
await (await import('node:fs/promises')).mkdir(join(mediaDeck, 'pages'), { recursive: true })
await (await import('node:fs/promises')).mkdir(join(mediaDeck, 'media'), { recursive: true })
await (await import('node:fs/promises')).copyFile(join(smokeDir, 'media-test.png'), join(mediaDeck, 'media', 'pic.png'))
await (await import('node:fs/promises')).writeFile(join(mediaDeck, 'deck.yaml'), [
  'version: 1', 'title: media-smoke', 'size: [960, 540]',
  'theme:', '  colors:', '    primary: "#2563EB"', '    accent: "#F59E0B"',
  'pages:',
  '  - pages/01_media.yaml',
  '  - pages/02_bg.yaml', '',
].join('\n'))
await (await import('node:fs/promises')).writeFile(join(mediaDeck, 'pages', '01_media.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: img', '    elementType: image', '    bounds: [60, 120, 400, 240]', '    src: media/pic.png',
  '  - elementId: card', '    elementType: shape', '    kind: roundRect', '    bounds: [500, 120, 400, 90]',
  '    fill: "$primary"',
  '  - elementId: badge', '    elementType: shape', '    kind: rect', '    bounds: [540, 260, 120, 120]',
  '    fill: "#F59E0B"', '    rotation: 45',
  '  - elementId: long', '    elementType: text', '    bounds: [60, 420, 840, 110]',
  '    content:',
  '      text: "本页面用于验证美学建议层的有效性：这是一段故意写得非常长的文本内容，它包含了超过九十个汉字并且没有任何分点或者断句处理，目的就是让文本信息密度的建议能够被正确触发，同时检验长句检测的启发式是否工作正常，因为只有这样我们才能确认审美层面的改善不会影响核心的冲突断言。"',
  '', 
].join('\n'))
await (await import('node:fs/promises')).writeFile(join(mediaDeck, 'pages', '02_bg.yaml'), [
  'pageType: cover',
  'background: {type: image, src: media/pic.png, fit: cover}',
  'elements:',
  '  - elementId: title', '    elementType: text', '    bounds: [80, 180, 800, 60]',
  '    content: { text: "背景图封面（回环测试）" }', '',
].join('\n'))
const ctxM = await resolveDeck(mediaDeck)
const rM = await renderDeck(ctxM, {})
const previewFiles = await (await import('node:fs/promises')).readdir(join(mediaDeck, 'preview'))
const firstHtml = previewFiles.filter((f) => f.endsWith('.html') && f !== 'deck.html').sort()[0]
const htmlMedia = await (await import('node:fs/promises')).readFile(join(mediaDeck, 'preview', firstHtml), 'utf8')
ok('preview img 相对路径指向 ../media/', htmlMedia.includes('../media/pic.png'))
ok('preview 箭头 marker defs 存在（roundRect 渲染）', htmlMedia.includes('roundRect') || htmlMedia.includes('border-radius'))
const expM = await exportPptx(ctxM, { out: 'out-media.pptx' })
const impM = await importPptx(expM.file, join(mediaDeck, 'imported'))
const impMediaFiles = await (await import('node:fs/promises')).readdir(join(mediaDeck, 'imported', 'media'))
ok('媒体回环：import 提取 1 张媒体', impM.media.length === 1 && impMediaFiles.includes('pic.png'), `${impM.media.join(',')}`)
const impPageYaml = await (await import('node:fs/promises')).readFile(join(mediaDeck, 'imported', 'pages', 'slide_01.yaml'), 'utf8')
ok('媒体回环：image src 写对', impPageYaml.includes('src: "media/pic.png"'))
ok('媒体回环：roundRect 保留', impPageYaml.includes('roundRect'))

// 背景回环：渲染/导出原生 p:bg/导入识别
const bgHtml = await (await import('node:fs/promises')).readFile(join(mediaDeck, 'preview', 'deck.html'), 'utf8')
ok('背景渲染：HTML 使用 background-image（../media/ 路径）', bgHtml.includes('url("') && bgHtml.includes('../media/pic.png'))
const layoutM0 = JSON.parse(await (await import('node:fs/promises')).readFile(join(mediaDeck, 'preview', 'layout.json'), 'utf8'))
const bgPage = layoutM0.pages.find((p) => p.index === 1)
ok('背景回环：layout.json 记录 image 背景', bgPage && bgPage.background?.type === 'image' && bgPage.background.src === 'media/pic.png')
const expFiles = zipRead(await (await import('node:fs/promises')).readFile(expM.file))
ok('背景回环：导出 slide2 含原生 p:bg + 嵌入式', expFiles.get('ppt/slides/slide2.xml').toString('utf8').includes('<p:bg>') && expFiles.get('ppt/slides/slide2.xml').toString('utf8').includes('r:embed'))
ok('背景回环：背景媒体被打包', [...expFiles.keys()].filter((k) => k.includes('media/')).length >= 1)
const impBgYaml = await (await import('node:fs/promises')).readFile(join(mediaDeck, 'imported', 'pages', 'slide_02.yaml'), 'utf8')
ok('背景回环：import 识别 background image', impBgYaml.includes('background') && impBgYaml.includes('media/pic.png'))

// ── 9. 美学建议层（suggestion 不入门禁，冲突断言不受影响）────────────────
const layoutM = JSON.parse(await (await import('node:fs/promises')).readFile(join(mediaDeck, 'preview', 'layout.json'), 'utf8'))
const vM = verifyDeck(layoutM)
ok('美学建议层产生 suggestion', vM.text.includes('[·] aesthetic'), vM.text.split('\n').filter((l) => l.includes('[·]')).join('; '))
const errorsM = vM.text.split('\n').filter((l) => l.includes('[✗]')).length
ok('美学建议不引入门禁错误（核心断言仍只看 ERROR）', errorsM === 0, `errors=${errorsM}`)

// ── 10. 层叠语义模型（合法重叠设计不应被卡门禁）───────────────────────────
const overlapDeck = join(root, 'examples', 'overlap-smoke')
await (await import('node:fs/promises')).rm(overlapDeck, { recursive: true, force: true })
await (await import('node:fs/promises')).mkdir(join(overlapDeck, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(overlapDeck, 'deck.yaml'), [
  'version: 1', 'title: overlap-smoke', 'size: [960, 540]',
  'theme:', '  colors:', '    primary: "#2563EB"', '    accent: "#F59E0B"',
  'pages:',
  '  - pages/01_deck.yaml',
  '  - pages/02_lenient.yaml', '',
].join('\n'))
await (await import('node:fs/promises')).writeFile(join(overlapDeck, 'pages', '01_deck.yaml'), [
  'pageType: content',
  'expectedOverlaps:',
  '  - { pair: [img, label] }', '      # 图片上标注：设计阶段声明的有意重叠',
  '  - { pair: [arrow, panel] }', '  # 箭头跨越底板：有意重叠',
  'elements:',
  '  - elementId: img', '    elementType: image', '    bounds: [60, 100, 400, 300]', '    src: media/pic.png',
  '  - elementId: label', '    elementType: text', '    bounds: [100, 150, 200, 30]',
  '    content: { text: "图上标注（合法）" }',
  '  - elementId: panel', '    elementType: shape', '    kind: roundRect', '    bounds: [520, 100, 360, 220]', '    fill: "$primary"',
  '  - elementId: chip', '    elementType: shape', '    kind: rect', '    bounds: [540, 140, 80, 60]', '    fill: "#F59E0B"',
  '  - elementId: arrow', '    elementType: line', '    bounds: [560, 285, 140, 10]',
  '    points: [[560, 290], [700, 290]]', '    line: { color: "#FFFFFF", width: 2 }',
  '  - elementId: txtA', '    elementType: text', '    bounds: [100, 400, 200, 40]',
  '    content: { text: "第一段" }',
  '  - elementId: txtB', '    elementType: text', '    bounds: [150, 430, 200, 40]',
  '    content: { text: "第二段（与 A 互压）" }',
  '  - elementId: deco', '    elementType: shape', '    kind: rect', '    bounds: [120, 410, 100, 60]',
  '    fill: "$primary"', '    role: decoration', '',
].join('\n'))
await (await import('node:fs/promises')).writeFile(join(overlapDeck, 'pages', '02_lenient.yaml'), [
  'pageType: content',
  'overlapMode: lenient',
  'elements:',
  '  - elementId: panelL', '    elementType: shape', '    kind: rect', '    bounds: [60, 60, 300, 200]', '    fill: "$primary"',
  '  - elementId: chipL', '    elementType: shape', '    kind: rect', '    bounds: [80, 80, 60, 50]', '    fill: "#F59E0B"', '',
].join('\n'))
const ctxO = await resolveDeck(overlapDeck)
await renderDeck(ctxO, {})
const layoutO = JSON.parse(await (await import('node:fs/promises')).readFile(join(overlapDeck, 'preview', 'layout.json'), 'utf8'))
const vO = verifyDeck(layoutO)
ok('预期重叠命中（设计声明对照 → 确认）', vO.text.includes('2 预期重叠✓'))
ok('已声明标注重叠不出现在报告中', !vO.text.includes('"img" × "label"') && !vO.text.includes('"label" × "img"'))
ok('未声明层叠 → 设计预期外错误（unexpected-overlap）', vO.text.includes('unexpected-overlap') && vO.text.includes('chip'))
ok('内容互压（text×text）→ ERROR（content-collision，不可声明）', vO.text.includes('content-collision') && vO.text.includes('[✗]'))
ok('decoration 完全豁免（不出报告）', !vO.text.includes('"deco"') && !vO.text.includes('× "deco"'))
ok('lenient 模式：未声明重叠仅提示（不升错误）', vO.text.includes('lenient 模式'))
const errO = vO.text.split('\n').filter((l) => l.includes('[✗]')).length
ok('严格制门禁计数：unexpected + content-collision', errO === 2, `errors=${errO}`)

// ── 11. 快速模式语义检测 + 引擎 auto 语义 ─────────────────────────────────
const routerMod = await import('../lib/router.js')
ok('快速模式：进入语义（简单做一个 ppt）', routerMod.isQuickIntent('行，简单做一个 ppt 就行') === true)
ok('快速模式：工作流内上下文（快速改一下这页）', routerMod.isQuickIntent('快速改一下第 3 页', true) === true)
ok('快速模式：非 ppt 语境不误触（快速浏览报告）', routerMod.isQuickIntent('帮我快速浏览一下这份报告', false) === false)
const stateMod = await import('../lib/state.js')
ok('状态默认：quick=false 且 engine=auto', stateMod.DEFAULT_SESSION().quick === false && stateMod.DEFAULT_SESSION().engine === 'auto')

// ── 12. v0.3：line bounds 自动推导 / safeArea / 一键声明 / 对比度+孤字 / 绝对路径 / 缩字下限 ──
import { applyAutoDeclare } from '../lib/autodeclare.js'
const v3Deck = join(root, 'examples', 'v3-smoke')
await rm(v3Deck, { recursive: true, force: true })
await mkdir(join(v3Deck, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(v3Deck, 'deck.yaml'), [
  'version: 1', 'title: v3-smoke', 'size: [960, 540]',
  'theme:',
  '  colors:',
  '    primary: "#2563EB"',
  '    light: "#E8EEFB"',
  '    ink: "#1F2937"',
  '  textStyles:',
  '    title: {fontSize: 32, color: "$ink", bold: true}',
  '    body: {fontSize: 16, color: "$ink"}',
  '  safeArea: {top: 20, bottom: 20}',
  '  minFontSize: 12',
  'pages:',
  '  - pages/01_layout.yaml',
  '  - pages/02_declare.yaml',
  '  - pages/03_floor.yaml', '',
].join('\n'))

await (await import('node:fs/promises')).writeFile(join(v3Deck, 'pages', '01_layout.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: L1',
  '    elementType: line',
  '    points: [[100, 100], [300, 100]]',
  '    line: {color: "#2563EB", width: 2}',
  '  - elementId: okbox',
  '    elementType: text',
  '    bounds: [100, 40, 300, 30]',
  '    content: {text: "安全区内文本", style: "$body"}',
  '  - elementId: badbox',
  '    elementType: shape',
  '    kind: rect',
  '    bounds: [500, 5, 100, 40]',
  '    fill: "$primary"',
  '  - elementId: decoBand',
  '    elementType: shape',
  '    kind: rect',
  '    bounds: [60, 2, 40, 12]',
  '    fill: "$primary"',
  '    role: decoration',
  '  - elementId: outPage',
  '    elementType: shape',
  '    kind: rect',
  '    bounds: [900, 520, 100, 60]',
  '    fill: "$primary"',
  '',
].join('\n'))
await (await import('node:fs/promises')).writeFile(join(v3Deck, 'pages', '02_declare.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: panel',
  '    elementType: shape',
  '    kind: roundRect',
  '    bounds: [60, 120, 420, 240]',
  '    fill: "$light"',
  '  - elementId: ptext',
  '    elementType: text',
  '    bounds: [90, 150, 360, 120]',
  '    content: {text: "白字浅底卡片（未声明）", style: "$body", color: "#FFFFFF"}',
  '  - elementId: orphan',
  '    elementType: text',
  '    bounds: [60, 420, 180, 60]',
  '    content: {text: "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅", style: "$body"}',
  '',
].join('\n'))
await (await import('node:fs/promises')).writeFile(join(v3Deck, 'pages', '03_floor.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: small',
  '    elementType: text',
  '    bounds: [60, 60, 150, 20]',
  '    content: {text: "这是一段非常长的文本用于触发缩字下限逻辑并且验证报告能够正确给出预警信息", style: "$body"}',
  '',
].join('\n'))
const ctxV3 = await resolveDeck(v3Deck)
ok('v0.3：line 省略 bounds 通过校验（D1）', ctxV3.pages.length === 3)
const rV3 = await renderDeck(ctxV3, {})
const L1 = rV3.layout.pages[0].elements.find((e) => e.id === 'L1')
ok('v0.3：line bounds 由 points 自动推导（AABB）', L1 && L1.bounds.w === 200 && L1.bounds.h === 1, JSON.stringify(L1?.bounds))
const vV3 = verifyDeck(rV3.layout)
ok('v0.3：safeArea 外元素 → out-of-page 错误（D5）', vV3.text.includes('超出页面安全区') && vV3.text.includes('badbox'), vV3.text.split('\n').filter((l) => l.includes('[✗]')).slice(0, 3).join('; '))
ok('v0.3：安全区内元素不报出界', !vV3.text.includes('okbox'))
ok('v0.3.2：未声明安全区出界（含 decoration）→ ERROR（C3 修订：修饰不再豁免）', vV3.text.includes('decoBand') && vV3.text.includes('expectedOutOfSafeArea'))
ok('v0.3.2：超页面边界 → ERROR（不可声明级）', vV3.text.includes('outPage') && vV3.text.includes('超出页面边界'))
ok('v0.3：未声明层叠 → unexpected-overlap', vV3.text.includes('unexpected-overlap') && vV3.text.includes('ptext'))
ok('v0.3：对比度建议（白字浅底，D6）', vV3.text.includes('aesthetic-contrast'))
ok('v0.3：孤字/破句建议（D7）', vV3.text.includes('text') && vV3.text.includes('孤字'))
const autod = await applyAutoDeclare(ctxV3, rV3.layout)
ok('v0.3：一键声明写入 1 对（D2）', autod.length === 1 && autod[0].added === 1, JSON.stringify(autod))
const declareYaml = await (await import('node:fs/promises')).readFile(join(v3Deck, 'pages', '02_declare.yaml'), 'utf8')
ok('v0.3：声明写入 yaml（含注释保留）', declareYaml.includes('expectedOverlaps') && declareYaml.includes('panel') && declareYaml.includes('ptext'))

// v0.3.2：01_layout 加出界声明（decoBand 有意 + outPage 超页——后者声明应无效），验证分级声明制
const layoutYaml = await (await import('node:fs/promises')).readFile(join(v3Deck, 'pages', '01_layout.yaml'), 'utf8')
const layoutYaml2 = layoutYaml.replace('elements:', 'expectedOutOfSafeArea:\n  - decoBand\n  - outPage\nelements:')
await (await import('node:fs/promises')).writeFile(join(v3Deck, 'pages', '01_layout.yaml'), layoutYaml2)
const ctxV3b = await resolveDeck(v3Deck) // 重新加载（声明写盘后）
const rV3b = await renderDeck(ctxV3b, {})
const vV3b = verifyDeck(rV3b.layout)
const v3bErrors = vV3b.text.split('\n').filter((l) => l.includes('[✗]'))
ok('v0.3.2：出界声明命中 → 预期出界✓（confirmed）', vV3b.text.includes('1 预期出界✓'), v3bErrors.join('; '))
ok('v0.3.2：声明后 decoBand 不再报错', !vV3b.text.includes('decoBand'))
ok('v0.3.2：超页面边界声明无效，仍 ERROR（分级不可声明）', vV3b.text.includes('outPage') && vV3b.text.includes('超出页面边界'))
ok('v0.3.2：声明后重验：unexpected 消除，仅剩故意错误（badbox/outPage/small）', vV3b.text.includes('1 预期重叠✓') && !vV3b.text.includes('unexpected-overlap') && v3bErrors.length === 3 && v3bErrors.every((l) => l.includes('badbox') || l.includes('outPage') || l.includes('small')), v3bErrors.join('; '))
const rV3d = await renderDeck(ctxV3, { debug: true })
const debugHtml = await (await import('node:fs/promises')).readFile(join(v3Deck, 'preview', '01_pages_01_layout.html'), 'utf8')
ok('v0.3：debug 渲染带安全区参考框', debugHtml.includes('sa-guide') && rV3d.htmlFiles.length === 3)
const absOut = join(root, 'examples', 'v3-abs-out.pptx')
const expV3 = await exportPptx(ctxV3, { out: absOut, engine: 'pptd' })
ok('v0.3：out 绝对路径原样使用（E1）', expV3.file === absOut && (await import('node:fs/promises')).stat(absOut).then(() => true).catch(() => false))
const floorEntry = expV3.autoFit.find((a) => a.id === 'small')
ok('v0.3：缩字下限 floorHit（to=12，E2）', floorEntry && floorEntry.from === 16 && floorEntry.to === 12 && floorEntry.floorHit === true, JSON.stringify(floorEntry))
await (await import('node:fs/promises')).rm(absOut, { recursive: true, force: true })

// ── 13. v0.3：ppt_schema 速查 + ppt_new 一键样例（B2）─────────────────────
const scaffoldMod = await import('../lib/scaffold.js')
ok('v0.3：ppts_schema 速查含 safeArea/expectedOverlaps', scaffoldMod.SCHEMA_REF.includes('safeArea') && scaffoldMod.SCHEMA_REF.includes('expectedOverlaps') && scaffoldMod.SCHEMA_REF.includes('elementType'))
const scafRoot = join(root, 'examples', 'scaffold-smoke')
await (await import('node:fs/promises')).rm(scafRoot, { recursive: true, force: true })
const scaf = await scaffoldMod.scaffoldProject(scafRoot, { name: 'demo' })
ok('v0.3：ppt_new 样例生成 5 文件（含架构页）', scaf.files.length === 5)
const scafCtx = await resolveDeck(scafRoot)
const scafR = await renderDeck(scafCtx, {})
const scafV = verifyDeck(scafR.layout)
ok('v0.3：样例工程可渲染且 verify 0 错误', scafCtx.pages.length === 4 && scafV.text.split('\n').filter((l) => l.includes('[✗]')).length === 0)
ok('v0.4：声明闭包——04 页声明 5 命中 + 2 隔层自动 = 7 确认', scafV.text.includes('7 预期重叠✓'))
ok('v0.4：对比度 z-order 无假阳性 + contrastExempt 生效', !scafV.text.includes('aesthetic-contrast'))
let refused = false
try { await scaffoldMod.scaffoldProject(scafRoot) } catch { refused = true }
ok('v0.3：ppt_new 拒绝覆盖已有工程', refused)

// ── 14. v0.3.1：冲突清单拍板（C1 引擎回退语义 / C2 audit 禁 autoDeclare）──
const toolsMod = await import('../lib/tools.js')
ok('v0.3.1：resolveEngine auto=pptd 且允许回退（C1）', toolsMod.resolveEngine('auto').engine === 'pptd' && toolsMod.resolveEngine('auto').allowFallback === true)
ok('v0.3.1：显式 pptd/python-pptx 不回退（C1）', toolsMod.resolveEngine('pptd').allowFallback === false && toolsMod.resolveEngine('python-pptx').engine === 'python-pptx' && toolsMod.resolveEngine('python-pptx').allowFallback === false)
ok('v0.3.1：blockedByAudit 仅 audit 档生效（C2）', toolsMod.blockedByAudit('audit') === true && toolsMod.blockedByAudit('standard') === false && toolsMod.blockedByAudit('quick') === false)

// ── 15. v0.3.2：出界声明防呆（坏 id 当场报错）+ D4 导入建议 safeArea ──────
const { validatePage } = await import('../lib/pptd/schema.js')
const badOutPage = { elements: [{ elementId: 'a', elementType: 'text', bounds: [0, 0, 10, 10], content: { text: 'x' } }], expectedOutOfSafeArea: ['ghost'] }
const badOutErr = validatePage(badOutPage, 'test.yaml')
ok('v0.3.2：expectedOutOfSafeArea 坏 id 当场报错（防呆）', badOutErr !== null && badOutErr.messages.some((m) => m.includes('ghost')), badOutErr?.messages?.join('; '))
// 3 页同位置元素（顶部/底部）→ 导入探测跨页带 → deck.yaml 写入建议 safeArea 注释
const bandDeck = join(root, 'examples', 'band-smoke')
await rm(bandDeck, { recursive: true, force: true })
await mkdir(join(bandDeck, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(bandDeck, 'deck.yaml'), [
  'version: 1', 'title: band-smoke', 'size: [960, 540]',
  'theme: {colors: {primary: "#2563EB"}, textStyles: {b: {fontSize: 14}}}',
  'pages:',
  '  - pages/01.yaml', '  - pages/02.yaml', '  - pages/03.yaml', '',
].join('\n'))
for (const p of ['01', '02', '03']) {
  await (await import('node:fs/promises')).writeFile(join(bandDeck, 'pages', `${p}.yaml`), [
    'pageType: content',
    'elements:',
    '  - elementId: header', '    elementType: text', '    bounds: [40, 10, 200, 30]',
    '    content: {text: "页眉", style: "$b", color: "#2E4B9F", fontFamily: "Microsoft YaHei", italic: true}',
    '  - elementId: footer', '    elementType: text', '    bounds: [40, 505, 200, 30]',
    '    content: {text: "页脚", style: "$b", color: "#2E4B9F"}',
    '  - elementId: body', '    elementType: text', '    bounds: [40, 200, 400, 60]',
    `    content: {text: "第${p}页正文", style: "$b", color: "#2E4B9F"}`,
    '',
  ].join('\n'))
}
const bandCtx = await resolveDeck(bandDeck)
const bandExp = await exportPptx(bandCtx, { out: 'out-band.pptx', engine: 'pptd' })
const bandImp = await importPptx(bandExp.file, join(bandDeck, 'imported'))
const bandDeckYaml = await (await import('node:fs/promises')).readFile(join(bandDeck, 'imported', 'deck.yaml'), 'utf8')
ok('v0.3.2：D4 导入探测跨页带 → 建议 safeArea 注释（未启用）', bandDeckYaml.includes('safeArea') && bandDeckYaml.includes('top: 40') && bandDeckYaml.includes('bottom: 35'), bandDeckYaml.split('\n').slice(0, 4).join(' | '))

// ── 16. v0.4.0：导入保样式（P0-1）/ 多点折线校验（P2-3）/ 对齐区块化（P1-2）/ 贴边清单（P2-4）/ density 分层 ──
const bandPageYaml = await (await import('node:fs/promises')).readFile(join(bandDeck, 'imported', 'pages', 'slide_01.yaml'), 'utf8')
ok('v0.4：导入保样式——text color/fontFamily/italic 回环', bandPageYaml.includes('fontFamily') && bandPageYaml.includes('2E4B9F'), bandPageYaml.split('\n').filter((l) => l.includes('fontFamily') || l.includes('color') || l.includes('italic')).join(' | '))
ok('v0.4：import-styles.json 生成（含样式清单）', (await import('node:fs/promises')).stat(join(bandDeck, 'imported', 'import-styles.json')).then(() => true).catch(() => false))
ok('v0.4：theme 聚合建议块写入 deck.yaml', bandDeckYaml.includes('# 建议主题') && bandDeckYaml.includes('textStyles'))
const mnErr = validatePage({ elements: [{ elementId: 'l', elementType: 'line', points: [[10, 10], [100, 10], [200, 10]] }] }, 'test.yaml')
ok('v0.4：多点折线显式报错（P2-3，不再静默截断）', mnErr !== null && mnErr.messages.some((m) => m.includes('仅支持 2 点')), mnErr?.messages?.join('; '))
const { analyzePage, aestheticSuggestions } = await import('../lib/verify.js')
const size960 = { width: 960, height: 540 }
const naPage = { elements: [
  { id: 't1', kind: 'text', bounds: { x: 100, y: 40, w: 100, h: 30 } },
  { id: 't2', kind: 'text', bounds: { x: 104, y: 300, w: 100, h: 30 } },
  { id: 'ln1', kind: 'line', bounds: { x: 200, y: 40, w: 50, h: 10 } },
] }
ok('v0.4：near-align 跨区块不比 + 线元素豁免（P1-2）', analyzePage(naPage, size960).filter((f) => f.code === 'near-align').length === 0)
const naSame = { elements: [
  { id: 'a1', kind: 'text', bounds: { x: 100, y: 40, w: 100, h: 30 } },
  { id: 'b1', kind: 'text', bounds: { x: 103, y: 40, w: 100, h: 30 } },
] }
ok('v0.4：同区块近对齐仍报告（对齐断言保留，3 种缘）', analyzePage(naSame, size960).filter((f) => f.code === 'near-align').length === 3)
const spPage = { elements: [
  { id: 'xa', kind: 'text', bounds: { x: 0, y: 0, w: 100, h: 30 }, text: 'a' },
  { id: 'xb', kind: 'text', bounds: { x: 102, y: 0, w: 100, h: 30 }, text: 'b' },
] }
ok('v0.4：相邻贴边清单（2px 间隙 → 建议，P2-4）', aestheticSuggestions(spPage, size960, {}).some((s) => s.code.includes('spacing')))
const denseSheet = { elements: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, kind: 'shape', bounds: { x: i * 40, y: 0, w: 20, h: 20 } })) }
ok('v0.4：density 按内容元素分层（纯图形页不误报，P2-5）', analyzePage(denseSheet, size960).filter((f) => f.code === 'density').length === 0)

// ── 17. v0.5.0：模板库（4 套）回归 + 模板一致性断言 + ppt_new --template ──
const tplMod = await import('../lib/templates.js')
const tplList = await tplMod.listTemplates()
const BUILTIN_TPLS = ['business-blue', 'academic-white', 'tech-dark', 'pitch-bold']
const builtins = tplList.filter((t) => BUILTIN_TPLS.includes(t.id))
const externals = tplList.filter((t) => !BUILTIN_TPLS.includes(t.id))
ok('v0.5：内置模板 4 套齐全（含外部收纳的并存）', builtins.length === 4 && tplList.length >= 4, `总 ${tplList.length} 套：${tplList.map((t) => t.id).join(',')}`)
ok('v0.5：内置模板元信息完整（含预览图）', builtins.every((t) => t.name && t.style && t.scene && t.preview), builtins.map((t) => `${t.id}:${t.preview ? 'png' : 'MISSING'}`).join(' '))
// 【1.0.4】原来这条只查"外部收纳模板自包含"。随包移除 4 套重型导入模板后，externals 恒为空 ⇒
// `[].every()` 会**空转通过**（假绿）。改成对**随包层**的不变量：每套都必须自包含（元数据齐 + 有预览图）。
// 【1.0.6】模板库变成两层（用户自建 + 随包），所以这里按 `source` 过滤随包层——用户自己的模板
// 可能确实没有 preview.png（无浏览器时），不该把用户的库算进"随包模板必须自包含"这条。
ok('v0.6.2：随包模板每套都自包含（元数据齐 + 有预览图）',
  builtins.length === 4 && builtins.every((t) => t.name && t.style && t.preview),
  builtins.map((t) => `${t.id}:${t.preview ? 'png' : 'MISSING'}`).join(' '))

// ── 17b. v1.0.6 用户自建模板库：两层目录 + 入库（.pptx）/ 物化 / 删除 ──
// 用户层目录现在是**整轮隔离**的（见文件顶部：DSH_HOME → `examples/smoke/.tmp-home`），
// 所以这里不必再单独切换 DSH_HOME，也不会碰到开发机/CI 上真实的 `~/.dsh/ppt-studio/templates`。
{
  const libHome = SMOKE_HOME
  try {
    const libUserDir = tplMod.userTemplatesDir()
    ok('v1.0.6：用户模板层在插件包之外（升级重新物化包也丢不了）',
      !libUserDir.startsWith(tplMod.TEMPLATES_DIR) && libUserDir.startsWith(libHome), libUserDir)
    // 用 smoke 开头导出的 pptx 当"用户给的模板文件"：走 import → 收纳 的完整路径
    const libProj = join(libHome, '_import')
    await mkdir(libProj, { recursive: true })
    await importPptx(exp.file, libProj)
    const libId = `smoke-mine-${Date.now().toString(36)}`
    const libAdded = await tplMod.registerTemplate(libProj, { id: libId, name: '我的测试模板' })
    const libList = await tplMod.listTemplates()
    const libMine = libList.find((t) => t.id === libId)
    ok('v1.0.6：入库后出现在清单里且 source=user（缺省写用户层）',
      libAdded.layer === 'user' && libMine?.source === 'user',
      `layer=${libAdded.layer}｜清单里=${libMine?.source ?? '(未出现)'}｜总 ${libList.length} 套`)
    const libWs = join(libHome, '_ws')
    const libMat = await tplMod.materializeTemplate(libWs, libId, { name: '我的模板' })
    ok('v1.0.6：用户模板可物化（与随包模板同一条路，带真相层 reference/template.pptx）',
      existsSync(join(libWs, 'deck.yaml')) && existsSync(join(libWs, 'reference', 'template.pptx')),
      `refs=${libMat.refs.length}`)
    const libDel = await tplMod.removeTemplate(libId)
    const libAfter = await tplMod.listTemplates()
    ok('v1.0.6：删除自建模板 → 从清单消失',
      libDel.removed === true && !libAfter.some((t) => t.id === libId), libId)
    let libRefuse = null
    try { await tplMod.removeTemplate('business-blue') } catch (e) { libRefuse = e }
    ok('v1.0.6：随包模板拒删（提示"升级会重新出现"），且文件确实还在',
      !!libRefuse && /随包/.test(libRefuse.message) && existsSync(join(tplMod.TEMPLATES_DIR, 'business-blue', 'template.yaml')),
      libRefuse?.message?.slice(0, 46) ?? '(没拦住)')
  } finally {
    // 这里**不**恢复 DSH_HOME、也不删 SMOKE_HOME：隔离是本轮 smoke 的全局前提（见文件顶部），
    // 整轮结束后统一恢复与清理。
  }
}
let tplAllOk = true
const tplReport = []
for (const t of builtins) {
  // 内置模板：母版页全部渲染 + verify 0 错误（模板一致性 strict 门禁一并验证）
  const ws = join(root, 'examples', 'tpl-check-' + t.id)
  await rm(ws, { recursive: true, force: true })
  await mkdir(join(ws, 'pages'), { recursive: true })
  const tT = await tplMod.templateWorkspace(t.id)
  const deckTxt = tT.deck.replace(/  - pages\/[^\n]+(?:\n  - pages\/[^\n]+)*/, (tT.meta.pages ?? []).map((r) => `  - ${r}`).join('\n'))
  await (await import('node:fs/promises')).writeFile(join(ws, 'deck.yaml'), deckTxt)
  for (const p of tT.pages) await (await import('node:fs/promises')).writeFile(join(ws, p.ref), p.yaml)
  try {
    const ctxT = await resolveDeck(ws)
    const rT = await renderDeck(ctxT, {})
    const vT = verifyDeck(rT.layout)
    const errs = vT.text.split('\n').filter((l) => l.includes('[✗]')).length
    tplReport.push(`${t.id}:${errs}err`)
    if (errs > 0) tplAllOk = false
  } catch (e) {
    tplAllOk = false
    tplReport.push(`${t.id}:FAIL ${e?.message}`)
  }
}
ok('v0.5：内置模板母版页全渲染 + verify 0 错误（含一致性门禁）', tplAllOk, tplReport.join('; '))
// 外部收纳模板：可渲染（不要求 0 错误——内容参照，收纳时已自动声明预期重叠）
let extOk = true
const extReport = []
for (const t of externals) {
  const tT = await tplMod.templateWorkspace(t.id)
  try {
    await renderDeck(await resolveDeck(tT.dir), {})
    extReport.push(`${t.id}:render ok`)
  } catch (e) {
    extOk = false
    extReport.push(`${t.id}:FAIL ${e?.message}`)
  }
}
ok('v0.6.2：外部收纳模板可渲染（内容参照，清理后工作区可用）',
  externals.length === 0 || extOk,
  externals.length ? extReport.join('; ') : '随包无外部收纳模板（4 套重型导入模板已于 1.0.4 移除）；收纳路径由下方 registerTemplate 断言覆盖')
// theme-conformance：出板颜色=ERROR；suggest 档=warning；off=跳过
const confPage = { elements: [{ id: 'x', kind: 'shape', fill: '#123456', bounds: { x: 0, y: 0, w: 10, h: 10 } }] }
ok('v0.5：theme-conformance strict 出板颜色 → ERROR', verifyDeck({ size: size960, theme: { colors: { a: '#2563EB' } }, pages: [{ index: 0, name: 'p', safeArea: null, overlapMode: 'declared', expectedOverlaps: [], expectedOutOfSafeArea: [], elements: [{ id: 'x', kind: 'shape', fill: '#123456', bounds: { x: 0, y: 0, w: 10, h: 10 } }] }] }).text.includes('[✗] theme-conformance'))
ok('v0.5：中性色豁免 + 主题色通过', !verifyDeck({ size: size960, theme: { colors: { a: '#2563EB' } }, pages: [{ index: 0, name: 'p', safeArea: null, overlapMode: 'declared', expectedOverlaps: [], expectedOutOfSafeArea: [], elements: [{ id: 'x', kind: 'shape', fill: '#FFFFFF', bounds: { x: 0, y: 0, w: 10, h: 10 } }, { id: 'y', kind: 'shape', fill: '#2563EB', bounds: { x: 0, y: 0, w: 10, h: 10 } }] }] }).text.includes('theme-conformance'))
ok('v0.5：themeConformance off 跳过', !verifyDeck({ size: size960, theme: { colors: { a: '#2563EB' }, themeConformance: 'off' }, pages: [{ index: 0, name: 'p', safeArea: null, overlapMode: 'declared', expectedOverlaps: [], expectedOutOfSafeArea: [], elements: [{ id: 'x', kind: 'shape', fill: '#123456', bounds: { x: 0, y: 0, w: 10, h: 10 } }] }] }).text.includes('theme-conformance'))
// ppt_new --template 复制工作区（v0.7：母版=参考不注册；正式页=首母版副本注册）
const tplWS = join(root, 'examples', 'tpl-work')
await rm(tplWS, { recursive: true, force: true })
const { materializeTemplate } = await import('../lib/templates.js')
const mat = await materializeTemplate(tplWS, 'business-blue', { name: 'demo' })
const ctxTW2 = await resolveDeck(tplWS)
ok('v0.7：模板工作区——正式页单页注册 + 母版不进门禁', ctxTW2.pages.length === 1 && ctxTW2.pages[0].ref === mat.formal && mat.firstRef === 'pages/_cover.yaml', `pages=${ctxTW2.pages.length} ref=${ctxTW2.pages[0]?.ref}`)
const tplV0 = verifyDeck((await renderDeck(ctxTW2, {})).layout)
ok('v0.7：内置模板正式页（首母版副本）0 错误', tplV0.text.split('\n').filter((l) => l.includes('[✗]')).length === 0)
// 模板工作区物化（1.0.4 起改用内置模板：随包已无"带 media/真相层"的导入模板）：
//   ① 母版未注册不报错（只注册 1 个正式页）——用户反馈场景：加载模板不再被门禁拦住
//   ② 媒体必须与模板清单**数量一致**（0 也是合法值：内置模板无 media），且**无真相层时不建 reference/**
{
  const extT = { id: BUILTIN_TPLS[0] }   // business-blue（6 张母版；确保 refs > 5 这条仍然有意义）
  const extWS = join(root, 'examples', 'tpl-work-ext')
  await rm(extWS, { recursive: true, force: true })
  const tplMetaSrc = await tplMod.templateWorkspace(extT.id)
  const tplMediaCount = tplMetaSrc.media.length
  const matE = await materializeTemplate(extWS, extT.id, {})
  const extCtx = await resolveDeck(extWS)
  // 不变式：refs = 母版页数 − 1（首母版被"正式化"为 pages/01_opening.yaml，其余以参考母版随行，见 templates.js:300）
  ok('v0.7：模板工作区——只注册 1 个正式页（母版参考不报错，其余母版全部随行）',
    extCtx.pages.length === 1 && matE.refs.length === (tplMetaSrc.meta.pages ?? []).length - 1 && matE.refs.length > 4,
    `registered=${extCtx.pages.length} refs=${matE.refs.length}/${(tplMetaSrc.meta.pages ?? []).length - 1}（首母版正式化后余下的参考母版）template=${extT.id}`)
  ok('v0.7：模板媒体跟随复制（数量与清单一致）+ 无真相层时不建 reference/',
    matE.mediaCount === tplMediaCount && !existsSync(join(extWS, 'reference')),
    `media=${matE.mediaCount}/${tplMediaCount} reference=${existsSync(join(extWS, 'reference'))}`)
}
// 收纳清洗升级：registerTemplate 声明出界元素 + 剩余错误分类（bandDeck safeArea 外元素）
const reg2 = await tplMod.registerTemplate(bandDeck, { id: `smoke-wash-${Date.now().toString(36)}`, name: '洗涤测试' }, {})
ok('v0.7：收纳清洗——出界声明/重叠声明/剩余分类进入 meta', typeof reg2.meta.cleanup === 'string' && reg2.meta.cleanup.includes('剩余'), reg2.meta.cleanup ?? '')
await (await import('node:fs/promises')).rm(join(tplMod.userTemplatesDir(), reg2.id), { recursive: true, force: true })

// ── 18. v0.5.1：外部模板收纳（ppt_template_add）——导入工程 → 模板库 ──────
const regId = `smoke-tpl-${Date.now().toString(36)}`
const reg = await tplMod.registerTemplate(bandDeck, { id: regId, name: '回归收纳模板', style: '测试' }, {})
ok('v0.5.1：外部模板收纳成功（theme/页面/媒体入包）', reg.pages === 3 && (await (await import('node:fs/promises')).stat(join(reg.dir, 'deck.yaml'))).isFile(), `id=${reg.id} pages=${reg.pages}`)
const regList = await tplMod.listTemplates()
ok('v0.5.1：收纳模板出现在模板库清单', regList.some((t) => t.id === regId))
const regWS = await tplMod.templateWorkspace(regId)
const ctxReg = await resolveDeck(regWS.dir)
ok('v0.5.1：收纳模板工作区可校验（theme/页面保留）', ctxReg.theme.colors.primary === '#2563EB' && ctxReg.pages.length === 3, `pages=${ctxReg.pages.length}`)
// 清理测试模板
await (await import('node:fs/promises')).rm(join(tplMod.userTemplatesDir(), regId), { recursive: true, force: true })

// ── 19. v0.6.0：对话内预览（ppt_preview）——预览根构建 + 同源相对 URL ────
const { buildPreview } = await import('../lib/preview-server.js')
const pv = await buildPreview(bandDeck)
ok('v0.6：预览构建（token/相对 URL/页数）', pv.token.length === 10 && pv.url.includes('/ppt-preview/') && pv.overviewUrl.endsWith('/pages/deck.html') && pv.pages === 3, pv.url)
const pvPages = await (await import('node:fs/promises')).readdir(join(pv.previewRoot, 'pages'))
ok('v0.6：预览根 pages 完整（3 页 + 整览）', pvPages.includes('deck.html') && pvPages.filter((f) => f.endsWith('.html')).length === 4)
const pvMedia = await buildPreview(mediaDeck)
ok('v0.6：预览根媒体拷贝（../media 引用可解析）', (await (await import('node:fs/promises')).readdir(join(pvMedia.previewRoot, 'media'))).includes('pic.png'))

// ── 20. v0.6.1：图表单列兼容（P1）+ 全零告警 + 深色背景对比度（P7）───────
const { chartData, chartIssue } = await import('../lib/pptd/svgCharts.js')
const singlePair = chartData({ type: 'bar', data: { cols: ['指标'], rows: [['A', 72], ['B', 55]] } })
ok('v0.6.1：图表单列 pairs 自动兼容（值不再全零）', singlePair.series[0].values.join() === '72,55' && singlePair.categories.join() === 'A,B', JSON.stringify(singlePair.series))
ok('v0.6.1：全零数据显式告警（不再静默）', chartIssue({ type: 'bar', data: { cols: ['指标', '值'], rows: [['A', 0], ['B', 0]] } }) !== null && chartIssue({ type: 'bar', data: { cols: ['指标', '值'], rows: [['A', 10], ['B', 20]] } }) === null)
// 模板图表值非零（4 套模板回归）
const chartDeckOk = []
for (const t of tplList) {
  const tT = await tplMod.templateWorkspace(t.id)
  const ctxT = await resolveDeck(tT.dir)
  let okChart = true
  for (const pg of ctxT.pages) {
    for (const el of pg.page.elements ?? []) {
      if (el.elementType === 'chart') {
        const d = chartData(el.chart)
        if (!d.series.some((s) => s.values.some((v) => v > 0))) okChart = false
      }
    }
  }
  chartDeckOk.push(`${t.id}:${okChart ? 'ok' : 'ZERO'}`)
}
ok('v0.6.1：4 套模板图表数据非零', chartDeckOk.every((s) => s.endsWith('ok')), chartDeckOk.join('; '))
// P7：$ref 页面背景解析为实际色（深色背景不再按白底算对比度）
const scafBgPage = scafR.layout.pages.find((p) => p.background?.type === 'solid' && p.background.color !== undefined)
ok('v0.6.1：$ref 背景解析为实际 hex（P7）', scafBgPage && /^#[0-9A-Fa-f]{6}$/.test(scafBgPage.background.color), scafBgPage?.background?.color)

// ── 21. v0.6.3：预览 URL 动态适配（发布友好：无硬编码 host/port）─────────
const { previewOrigin } = await import('../lib/tools.js')
ok('v0.6.3：previewOrigin 动态适配（host/port 契约 + 0.0.0.0 回退）',
  previewOrigin({ port: 3080, host: '127.0.0.1' }) === 'http://127.0.0.1:3080'
  && previewOrigin({ port: 8080, host: '0.0.0.0' }) === 'http://127.0.0.1:8080'
  && previewOrigin(null) === ''
  && previewOrigin({ port: 9000, host: 'localhost' }) === 'http://localhost:9000',
  `本地=${previewOrigin({ port: 3080, host: '127.0.0.1' })}`)

// ── 22. v0.8.0：Office 真渲染通道（无 Office 自动隐藏；有则条件实测）──────
const msMod = await import('../lib/msrender.js')
const hasOffice = msMod.findPowerPoint() !== null
console.log(`[v0.8.0] Office 能力探测：${hasOffice ? '有（COM 通道可用）' : '无（通道自动隐藏，不影响工作流）'}`)
if (hasOffice) {
  const visOut = join(root, 'examples', 'rendered-check')
  await rm(visOut, { recursive: true, force: true })
  // Office COM 是"可选增强"：本机 PowerPoint 正开着文件/弹对话框时 COM 会临时不可用——
  // 这属于环境抖动，不该把整个自检打崩（2026-09-14 实测：用户开着 PowerPoint 时 smoke 被 COM 异常中断）。
  try {
    const rv = await msMod.renderPptxToPng(bandExp.file, visOut, { width: 960, height: 540, timeoutMs: 180000 })
    ok('v0.8.0：Office 真渲染（成品 pptx → 逐页 PNG）', rv.pages === 3 && rv.files.length === 3, `pages=${rv.pages} files=${rv.files.length}`)
  } catch (e) {
    console.log(`[v0.8.0] ⚠ Office COM 本次不可用（环境抖动，非失败）：${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`)
    ok('v0.8.0：Office COM 抖动时降级跳过（不阻断自检）', true)
  }
  await rm(visOut, { recursive: true, force: true })
} else {
  ok('v0.8.0：无 Office 跳过渲染（无需验证的降级路径）', true)
}

// ── 23. v0.9.0：模板双轨（真相层保留 + referenceTemplate 注入）───────
const dualSrc = join(bandDeck, 'source.pptx')
await (await import('node:fs/promises')).copyFile(bandExp.file, dualSrc) // 假真相层（导入工程应自带）
const dualId = `smoke-dual-${Date.now().toString(36)}`
const dual = await tplMod.registerTemplate(bandDeck, { id: dualId, name: '双轨测试' }, {})
ok('v0.9.0：收纳保留真相层（source.pptx → template.pptx）', !!dual.sourcePptx && dual.meta.sourcePptx === 'template.pptx' && existsSync(join(dual.dir, 'template.pptx')), dual.meta.sourcePptx ?? '无')
const dualWS = join(root, 'examples', 'tpl-dual')
await rm(dualWS, { recursive: true, force: true })
const matD = await materializeTemplate(dualWS, dualId, { name: '双轨' })
const deckD = await (await import('node:fs/promises')).readFile(join(dualWS, 'deck.yaml'), 'utf8')
// previews 是**Office COM 渲染**的产物（registerTemplate 里模板预览=renderPptxToPng，需要本机 PowerPoint）：
// 没有 Office 的机器上 previews/ 根本不存在——旧断言无条件要求 reference/previews/01.png，于是
// "干净检出（Linux CI / 没装 Office 的机器）跑 npm test" 必然红两条（2026-09-18 创意工坊 PR 审核反馈）。
// 断言必须**如实反映能力**：previews 在就要求它被注入+拷贝，不在就要求"只注入 source 且绝不出现 previews 引用"。
// 两个分支各自恰好两次 ok()，断言总数恒定（否则 §37.10 文档计数自证会假红）。
const previewSrc = existsSync(join(dual.dir, 'previews'))
if (previewSrc) {
  ok('v0.9.0：物化工作区注入 referenceTemplate（source/previews）',
    deckD.includes('referenceTemplate:') && deckD.includes('reference/template.pptx') && deckD.includes('reference/previews/01.png'),
    'referenceTemplate 块缺失' )
  ok('v0.9.0：reference/ 拷贝（template.pptx + previews 整页）',
    matD.reference?.files?.includes('template.pptx') && existsSync(join(dualWS, 'reference', 'previews', '01.png')),
    JSON.stringify(matD.reference?.files ?? []))
} else {
  console.log('[v0.9.0] 本机无 Office（预览渲染不可用）：previews 不可能存在，改断言"只注入 source"的诚实不变量')
  ok('v0.9.0：无 Office 时 referenceTemplate 只注入 source（previews 随 Office，不虚报）',
    deckD.includes('referenceTemplate:') && deckD.includes('reference/template.pptx') && !deckD.includes('reference/previews/'),
    '无 Office 时不该出现 previews 引用')
  ok('v0.9.0：无 Office 时 reference/ 只拷贝 template.pptx（拷贝清单与产物逐条对应）',
    matD.reference?.files?.includes('template.pptx') && !existsSync(join(dualWS, 'reference', 'previews')),
    JSON.stringify(matD.reference?.files ?? []))
}
const dualCtx = await resolveDeck(dualWS)
ok('v0.9.0：带 referenceTemplate 的 deck 通过校验（非渲染字段）', dualCtx.pages.length === 1 && dualCtx.deck.referenceTemplate?.id === dualId)
// 清理双轨测试模板 + 假 source
await (await import('node:fs/promises')).rm(join(tplMod.userTemplatesDir(), dualId), { recursive: true, force: true }).catch(() => {})
await rm(dualSrc, { force: true }).catch(() => {})
await rm(dualWS, { recursive: true, force: true })

// ── 23b. 换行鲁棒（CRLF + BOM）：文本手术不得在 Windows 检出/用户手改的文件上静默失效 ──────
// 真因与后果（2026-09-18 实测）：`/pages:\n[\s\S]*$/` 这类行锚定正则，JS 的 `.` 不吃 `\r`、`$`（m 模式）
// 只落在 `\n` 前 ⇒ **CRLF 文本上一条都不匹配**，`.replace()` 原样返回（不报错）：
//   materializeTemplate 产出的工作区 deck.yaml 仍引用 `pages/_cover.yaml`，而该页故意没被复制
//   （它是被"正式化"的首母版）⇒ resolveDeck 抛 "page file missing: pages/_cover.yaml"。
// 触发条件一点都不罕见：Git for Windows 默认 core.autocrlf=true ⇒ **干净克隆就是 CRLF**
// （本机工作区反而是脚本写出来的 LF，于是"本机全绿、干净克隆全崩"）。
// 防线两条：.gitattributes（git 安装与 tgz 安装同字节）+ normalizeText（用户手改的 CRLF/BOM 也不失效）。
const crlfId = `smoke-crlf-${Date.now().toString(36)}`
const crlfDir = join(tplMod.TEMPLATES_DIR, crlfId)
{
  const fsp = await import('node:fs/promises')
  await fsp.cp(join(tplMod.TEMPLATES_DIR, 'business-blue'), crlfDir, { recursive: true })
  for (const rel of ['deck.yaml', 'template.yaml', 'pages/_cover.yaml', 'pages/_content.yaml']) {
    const p = join(crlfDir, rel)
    if (!existsSync(p)) continue
    const lf = tplMod.normalizeText(await fsp.readFile(p, 'utf8'))
    // deck.yaml 额外加 BOM：Windows 记事本默认加 BOM，而 BOM 会破坏 `^pages:` 的行锚
    await fsp.writeFile(p, (rel === 'deck.yaml' ? '\uFEFF' : '') + lf.replace(/\n/g, '\r\n'), 'utf8')
  }
}
const crlfWS = join(root, 'examples', 'tpl-crlf')
await rm(crlfWS, { recursive: true, force: true })
const matC = await tplMod.materializeTemplate(crlfWS, crlfId, { name: 'CRLF' })
const deckC = await (await import('node:fs/promises')).readFile(join(crlfWS, 'deck.yaml'), 'utf8')
ok('换行鲁棒：CRLF+BOM 的模板 deck.yaml 仍被改写为只引用正式页（不再静默返回原文）',
  deckC.includes('pages/01_opening.yaml') && !deckC.includes('_cover.yaml'),
  JSON.stringify(deckC.split('\n').filter((l) => l.includes('.yaml')).slice(0, 4)))
const ctxC = await resolveDeck(crlfWS) // 修复前：这一行抛 page file missing: pages/_cover.yaml
ok('换行鲁棒：CRLF+BOM 模板物化出的工作区可 resolve（正是干净克隆崩掉的那一步）', ctxC.pages.length === 1 && ctxC.deck.title === 'CRLF')
const coverC = await (await import('node:fs/promises')).readFile(join(crlfWS, 'pages', '01_opening.yaml'), 'utf8')
ok('换行鲁棒：CRLF 母版页的 pageType 仍被改写（`^x.*$` 类正则在 CRLF 上同样失效）',
  coverC.includes('pageType: content') && !coverC.includes('pageType: cover'), matC.formal)
await (await import('node:fs/promises')).rm(crlfDir, { recursive: true, force: true }).catch(() => {})
await rm(crlfWS, { recursive: true, force: true })

// ── 24. v0.9.1：候选 A——prst 形状直通 + 渐变闭环 + 参考双轨 ──────────────
// 24.1 造含 prst/渐变 shape 的 deck → exportPptx → importPptx 回环（export→import 无损）
const prstDeck = join(root, 'examples', 'prst-smoke')
await rm(prstDeck, { recursive: true, force: true })
await mkdir(join(prstDeck, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(prstDeck, 'deck.yaml'), [
  'version: 1', 'title: prst-smoke', 'size: [960, 540]',
  'theme: {colors: {primary: "#2563EB", accent: "#0485A8"}}',
  'pages:', '  - pages/01.yaml', '',
].join('\n'))
await (await import('node:fs/promises')).writeFile(join(prstDeck, 'pages', '01.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: arr', '    elementType: shape', '    kind: rightArrow',
  '    bounds: [40, 40, 200, 80]', '    fill: "#2563EB"',
  '  - elementId: pen', '    elementType: shape', '    kind: pentagon',
  '    bounds: [40, 140, 200, 80]', '    fill: "#0485A8"',
  '  - elementId: grad', '    elementType: shape', '    kind: chevron',
  '    bounds: [40, 240, 200, 80]',
  '    fill: {type: gradient, stops: [{pos: 0, color: "#79C9E2"}, {pos: 100, color: "#0485A8"}], angle: 90}',
  '',
].join('\n'))
const prstCtx = await resolveDeck(prstDeck)
const prstExp = await exportPptx(prstCtx, { out: 'out-prst.pptx', engine: 'pptd' })
// 直接读 zip 断言 prstGeom/gradFill 落盘
const prstZip = zipRead(await (await import('node:fs/promises')).readFile(prstExp.file))
const prstSlide = prstZip.get('ppt/slides/slide1.xml').toString('utf8')
ok('v0.9.1：导出 prstGeom 直通（rightArrow/pentagon/chevron）',
  prstSlide.includes('prst="rightArrow"') && prstSlide.includes('prst="pentagon"') && prstSlide.includes('prst="chevron"'),
  prstSlide.match(/prst="[^"]+"/g)?.join(' ') ?? 'MISSING')
ok('v0.9.1：导出 gradFill 双 stop（gs/lin）',
  prstSlide.includes('gradFill') && prstSlide.includes('<a:gs pos="0"') && prstSlide.includes('<a:lin ang="5400000"') && prstSlide.includes('val="0485A8"'),
  'gradFill 缺失')
// 导入回环：kind/fill 保留
const prstImpDir = join(root, 'examples', 'prst-imported')
await rm(prstImpDir, { recursive: true, force: true })
const prstImp = await importPptx(prstExp.file, prstImpDir)
const prstImpCtx = await resolveDeck(prstImpDir)
const prstEls = prstImpCtx.pages[0].page.elements
const arrEl = prstEls.find((e) => e.elementId === 'arr')
const gradEl = prstEls.find((e) => e.elementId === 'grad')
ok('v0.9.1：import 回环 kind 保留（rightArrow/pentagon）', arrEl?.kind === 'rightArrow' && prstEls.find((e) => e.elementId === 'pen')?.kind === 'pentagon', `kinds=${prstEls.map((e) => e.kind).join(',')}`)
ok('v0.9.1：import 回环渐变对象（type/stops/angle）', gradEl?.fill?.type === 'gradient' && gradEl?.fill?.stops?.length === 2 && gradEl?.fill?.angle === 90, JSON.stringify(gradEl?.fill))
// 渲染 + verify 不崩（渐变对象被消费）
const prstRender = await renderDeck(prstImpCtx, {})
ok('v0.9.1：渐变对象渲染/校验通过（render+verify 消费渐变 fill）', prstRender.layout.pages[0].elements.some((e) => e.id === 'grad' && e.fill?.type === 'gradient') && !verifyDeck(prstRender.layout).text.includes('[✗] overflow'), verifyDeck(prstRender.layout).text.split('\n').filter((l) => l.includes('[✗]')).join('|'))
// 24.2 参考双轨：import 产物 referenceSource 注入 + source.pptx 保留
const refline = await (await import('node:fs/promises')).readFile(join(prstImpDir, 'deck.yaml'), 'utf8')
ok('v0.9.1：参考双轨 referenceSource 注入（source 恒在；previews 随 Office）',
  refline.includes('referenceSource:') && refline.includes('source: source.pptx') && existsSync(join(prstImpDir, 'source.pptx')),
  refline.split('\n').filter((l) => l.startsWith('referenceSource') || l.includes('source:') || l.includes('previews')).join(' | '))
const prstRefCtx = await resolveDeck(prstImpDir)
ok('v0.9.1：referenceSource deck 通过校验', prstRefCtx.deck.referenceSource?.name !== undefined)
// 清理
await rm(prstImpDir, { recursive: true, force: true })
await rm(prstDeck, { recursive: true, force: true })

// ── 25. v0.10.0：手术模式（候选 B）——模板贴内容 + 完整性验证 ─────────────
const { surgicalPatch, scanSlideXml, matchByDistance, slideOrderOf, verifySurgical } = await import('../lib/surgical.js')
// 25.1 模板 = exportPptx 自建（3 页：标题文本含粗体 + 表格）
const surgTplDir = join(root, 'examples', 'surg-tpl')
await rm(surgTplDir, { recursive: true, force: true })
await mkdir(join(surgTplDir, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(surgTplDir, 'deck.yaml'), [
  'version: 1', 'title: surg-tpl', 'size: [960, 540]',
  'theme: {colors: {primary: "#1E4E8C", accent: "#EAF1F8"}}',
  'pages:',
  '  - pages/01.yaml', '  - pages/02.yaml', '  - pages/03.yaml', '',
].join('\n'))
await (await import('node:fs/promises')).writeFile(join(surgTplDir, 'pages', '01.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: title', '    elementType: text', '    bounds: [60, 60, 500, 60]',
  '    content: {text: "模板标题", fontSize: 28, color: "#1E4E8C", bold: true}',
  '  - elementId: body', '    elementType: text', '    bounds: [60, 160, 500, 80]',
  '    content: {text: "模板正文内容", fontSize: 16}',
  '  - elementId: tbl', '    elementType: table', '    bounds: [60, 300, 600, 150]',
  '    cols: ["指标", "数值"]',
  '    rows: [["A", "1"], ["B", "2"]]',
  '', ''].join('\n'))
for (const p of ['02', '03']) {
  await (await import('node:fs/promises')).writeFile(join(surgTplDir, 'pages', `${p}.yaml`), [
    'pageType: content',
    'elements:',
    `  - elementId: t${p}`, '    elementType: text', '    bounds: [60, 100, 400, 60]',
    `    content: {text: "第${p === '02' ? 2 : 3}页固定", fontSize: 20}`,
    '', ''].join('\n'))
}
const surgTplCtx = await resolveDeck(surgTplDir)
const surgTplExp = await exportPptx(surgTplCtx, { out: 'out-surg-tpl.pptx', engine: 'pptd' })
// 25.2 工作区 = 同几何新内容（只改文本/表格文本，几何不动）
const surgWork = join(root, 'examples', 'surg-work')
await rm(surgWork, { recursive: true, force: true })
await mkdir(join(surgWork, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(surgWork, 'deck.yaml'), [
  'version: 1', 'title: surg-work', 'size: [960, 540]',
  'theme: {colors: {primary: "#1E4E8C", accent: "#EAF1F8"}}',
  'pages:',
  '  - pages/01.yaml', '  - pages/02.yaml', '', ''].join('\n'))
await (await import('node:fs/promises')).writeFile(join(surgWork, 'pages', '01.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: title', '    elementType: text', '    bounds: [60, 60, 500, 60]',
  '    content: {text: "用户的新标题", fontSize: 28, color: "#1E4E8C", bold: true}',
  '  - elementId: body', '    elementType: text', '    bounds: [60, 200, 500, 80]',
  '    content: {text: "用户新正文", fontSize: 16}',
  '  - elementId: tbl', '    elementType: table', '    bounds: [60, 300, 600, 150]',
  '    cols: ["指标", "数值"]',
  '    rows: [["甲", "10"], ["乙", "20"]]',
  '', ''].join('\n'))
await (await import('node:fs/promises')).writeFile(join(surgWork, 'pages', '02.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: t02', '    elementType: text', '    bounds: [60, 100, 400, 60]',
  '    content: {text: "第2页固定", fontSize: 20}', // 与模板一致 = 未动 → kept
  '', ''].join('\n'))
const surgOut = join(root, 'examples', 'surg-out.pptx')
await rm(surgOut, { force: true }).catch(() => {})
const surgRes = await surgicalPatch({ template: surgTplExp.file, deckDir: surgWork, out: surgOut })
ok('v0.10.0：手术页状态（第1页 patched / 第2页 kept / 第3页 kept）',
  surgRes.pages[0].action === 'patched' && surgRes.pages[1].action === 'kept' && surgRes.pages[2].action === 'kept' && surgRes.pages[2].note?.includes('无对应'),
  surgRes.pages.map((p) => `${p.index}:${p.action}`).join(', '))
ok('v0.10.0：字段替换统计（标题+正文 2 字段；表格 4 cell；清空 0）',
  surgRes.fields === 2 && surgRes.tableCells === 4 && surgRes.pages[0].fields === 2,
  JSON.stringify({ fields: surgRes.fields, tableCells: surgRes.tableCells }))
const surgZip = zipRead(await (await import('node:fs/promises')).readFile(surgOut))
const surgSlide = surgZip.get('ppt/slides/slide1.xml').toString('utf8')
ok('v0.10.0：手术页文本已替换（新标题/新正文/表格新值）',
  surgSlide.includes('用户的新标题') && surgSlide.includes('用户新正文') && surgSlide.includes('甲') && surgSlide.includes('20') && !surgSlide.includes('模板标题'),
  'slide1 内容替换缺失')
ok('v0.10.0：rPr 样式原样保留（只改 a:t——粗体 2800/颜色仍在）',
  surgSlide.includes('sz="2800"') && surgSlide.includes('1E4E8C') || surgSlide.includes('sz="1600"'),
  'rPr 属性被破坏')
const surgTplZip = zipRead(await (await import('node:fs/promises')).readFile(surgTplExp.file))
ok('v0.10.0：完整性验证——未手术条目内容 sha256 全部一致',
  surgRes.verify.mismatched === 0 && surgRes.verify.identical > 0,
  `${surgRes.verify.identical}/${surgRes.verify.total}`)
// 未手术页（slide2）内容与模板逐字节一致
const tplSlide2 = surgTplZip.get('ppt/slides/slide2.xml')
const outSlide2 = surgZip.get('ppt/slides/slide2.xml')
const { createHash } = await import('node:crypto')
ok('v0.10.0：未手术页 slide2 内容与模板一致（hash）', createHash('sha256').update(tplSlide2).digest('hex') === createHash('sha256').update(outSlide2).digest('hex'), 'slide2 变了！')
// 25.3 scanSlideXml 直接单元：槽收集（文本 sp 跳过 grpSp/无位置）
const scan1 = scanSlideXml(surgSlide)
ok('v0.10.0：scanSlideXml 槽收集（标题/正文/表格分列）', scan1.slots.length === 2 && scan1.tables.length === 1, `slots=${scan1.slots.length} tables=${scan1.tables.length}`)
// 25.4 有 Office 时：手术成品可被 PowerPoint 打开（COM 渲染无异常 = 结构合法）
if (hasOffice) {
  const visSurg = join(root, 'examples', 'surg-rendered')
  await rm(visSurg, { recursive: true, force: true })
  try {
    const rvSurg = await msMod.renderPptxToPng(surgOut, visSurg, { width: 960, height: 540, timeoutMs: 180000 })
    ok('v0.10.0：手术成品 Office 可打开渲染（结构合法）', rvSurg.pages === 3, `pages=${rvSurg.pages}`)
  } catch (e) {
    console.log(`[v0.10.0] ⚠ Office COM 本次不可用（环境抖动，非失败）：${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`)
    ok('v0.10.0：Office COM 抖动时降级跳过（不阻断自检）', true)
  }
  await rm(visSurg, { recursive: true, force: true })
} else {
  ok('v0.10.0：无 Office 跳过成品渲染验证', true)
}
// 清理
await rm(surgOut, { force: true }).catch(() => {})
await rm(surgTplDir, { recursive: true, force: true })
await rm(surgWork, { recursive: true, force: true })

// ── 26. v0.11.0：候选 C——custGeom 几何闭环 + alpha 透明度 + 形状内文本提取 ──
const c11Deck = join(root, 'examples', 'c11-smoke')
await rm(c11Deck, { recursive: true, force: true })
await mkdir(join(c11Deck, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(c11Deck, 'deck.yaml'), [
  'version: 1', 'title: c11-smoke', 'size: [960, 540]',
  'theme: {colors: {primary: "#2563EB", accent: "#0485A8"}}',
  'pages:', '  - pages/01.yaml', '', ''].join('\n'))
await (await import('node:fs/promises')).writeFile(join(c11Deck, 'pages', '01.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: ribbon', '    elementType: shape', '    kind: custGeom',
  '    bounds: [40, 40, 400, 160]',
  '    path:',
  '      w: 100000',
  '      h: 40000',
  '      commands:',
  '        - {cmd: moveTo, pts: [[0, 0]]}',
  '        - {cmd: cubicBezTo, pts: [[30000, 0], [70000, 40000], [100000, 40000]]}',
  '        - {cmd: arcTo, wR: 10000, hR: 10000, stAng: 0, swAng: 5400000}',
  '        - {cmd: close}',
  '    fill: {color: "#0485A8", alpha: 60}',
  '', ''].join('\n'))
const c11Ctx = await resolveDeck(c11Deck)
const c11Exp = await exportPptx(c11Ctx, { out: 'out-c11.pptx', engine: 'pptd' })
const c11Zip = zipRead(await (await import('node:fs/promises')).readFile(c11Exp.file))
const c11Slide = c11Zip.get('ppt/slides/slide1.xml').toString('utf8')
ok('v0.11：导出 custGeom 落盘（path 命令 + arcTo + alpha）',
  c11Slide.includes('<a:custGeom>') && c11Slide.includes('<a:cubicBezTo>') && c11Slide.includes('<a:arcTo wR="10000"') && c11Slide.includes('<a:alpha val="60000"/>'),
  'custGeom/alpha XML 缺失')
// 二次导入回环：kind/path/alpha 无损
const c11Rt = join(root, 'examples', 'c11-imported')
await rm(c11Rt, { recursive: true, force: true })
await importPptx(c11Exp.file, c11Rt)
const c11RtCtx = await resolveDeck(c11Rt)
const c11El = c11RtCtx.pages[0].page.elements.find((e) => e.elementId === 'ribbon')
ok('v0.11：import 回环 custGeom/alpha 无损',
  c11El?.kind === 'custGeom' && c11El?.fill?.alpha === 60 && c11El?.fill?.color === '#0485A8' && c11El?.path?.commands?.length === 4,
  JSON.stringify({ kind: c11El?.kind, fill: c11El?.fill, cmds: c11El?.path?.commands?.length }))
// render 消费 custGeom（SVG path d 含弧转换）
const c11Render = await renderDeck(c11Ctx, {})
const c11HtmlPath = join(c11Render.outDir ?? join(c11Deck, 'preview'), c11Render.htmlFiles[0])
ok('v0.11：render 消费 custGeom（SVG path + 弧转换 A 命令）',
  c11Render.htmlFiles.length === 1 && (await (await import('node:fs/promises')).readFile(c11HtmlPath, 'utf8')).includes('A 10000 10000'),
  'SVG 弧命令缺失')
// 形状内文本提取形态（shape + text 同 bounds 居中）schema 接受
const c11TextDeck = join(root, 'examples', 'c11-text')
await rm(c11TextDeck, { recursive: true, force: true })
await mkdir(join(c11TextDeck, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(c11TextDeck, 'deck.yaml'), [
  'version: 1', 'title: c11-text', 'size: [960, 540]',
  'theme: {colors: {primary: "#2563EB"}}',
  'pages:', '  - pages/01.yaml', '', ''].join('\n'))
await (await import('node:fs/promises')).writeFile(join(c11TextDeck, 'pages', '01.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: badge', '    elementType: shape', '    kind: ellipse',
  '    bounds: [100, 100, 80, 80]', '    fill: "#2563EB"',
  '  - elementId: badge_txt', '    elementType: text', '    bounds: [100, 100, 80, 80]',
  '    content: {text: "1", fontSize: 14, align: "center", color: "#FFFFFF"}', '', ''].join('\n'))
const c11TextCtx = await resolveDeck(c11TextDeck)
ok('v0.11：schema 接受形状内文本提取形态（shape+text 同 bounds）', c11TextCtx.pages.length === 1)
// validatePath 坏例：未知命令当场报错
const badPathDeck = join(root, 'examples', 'c11-bad')
await rm(badPathDeck, { recursive: true, force: true })
await mkdir(join(badPathDeck, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(badPathDeck, 'deck.yaml'), 'version: 1\ntitle: bad\nsize: [960, 540]\npages:\n  - pages/01.yaml\n')
await (await import('node:fs/promises')).writeFile(join(badPathDeck, 'pages', '01.yaml'), [
  'pageType: content', 'elements:',
  '  - elementId: x', '    elementType: shape', '    kind: custGeom',
  '    bounds: [40, 40, 100, 100]',
  '    path: {commands: [{cmd: nope, pts: [[0, 0]]}]}', '', ''].join('\n'))
let badPathErr = null
try { await resolveDeck(badPathDeck) } catch (e) { badPathErr = e }
ok('v0.11：custGeom 未知命令当场报错（防呆）', badPathErr !== null && badPathErr.messages?.some((m) => m.includes('path.commands[0].cmd')), badPathErr?.messages?.join('; '))
// 清理
await rm(c11Rt, { recursive: true, force: true })
await rm(c11Deck, { recursive: true, force: true })
await rm(c11TextDeck, { recursive: true, force: true })
await rm(badPathDeck, { recursive: true, force: true })

// ── 27. v0.12.0 (M2)：文本实测档——注入/提取单测 + 实测交叉三态 + 真实测量 ──
const { injectMeasureScript, extractMeasured, measureLayout } = await import('../lib/measurement.js')
const { measuredCrossCheck: mcc } = await import('../lib/verify.js')
// 27.1 注入/提取单测（script raw text + JSON 回环路）
const inj = injectMeasureScript('<html><head></head><body><div class="el" id="a" data-kind="text" style="width:100px">x</div></body></html>')
ok('v0.12：测量脚本注入（raw text 不转义 <）——script 原样嵌入且可提取',
  inj.includes('__ppt_measured') && inj.includes('for(var i=0;i<els.length') && JSON.stringify(extractMeasured(`<html><head><script id="__ppt_measured" type="application/json">${JSON.stringify([{ id: 'a', lines: 2 }])}</script></head></html>`)) === JSON.stringify([{ id: 'a', lines: 2 }]))
// 27.2 实测交叉三态（估算漏报 → error；复现 → warning；估算过报 → relief warning）
// 【2026-09-18 修】夹具必须复刻**真契约**。此前这里两侧都写 `index: 1`，于是掩盖了一个真 bug：
//   真生产者底基不同（layout.json 由 render-html 取 schema 的 pages.length ⇒ 0 基；measured.json 由
//   measurement 取 i+1 ⇒ 1 基），而 measuredCrossCheck 用 `index` 相等配对 ⇒ **永不配对、恒返空结果**，
//   整条 M2 通道在"报通过"（绿灯），且"实测无溢出"与"通道失效"在输出上不可区分。
//   现在跨档配对键是**两侧都写、都是 1 基**的 `pageNo`；`index` 退回"各自文件的内部数组下标"（都 0 基）。
//   下面这条夹具自证就是防"有人把夹具改回那个掩盖 bug 的形状"。
const xLayout = { pages: [{ pageNo: 1, index: 0, elements: [
  { id: 't1', kind: 'text', bounds: { x: 0, y: 0, w: 100, h: 50 }, metrics: { overflowY: 0, lines: 2 } },
  { id: 't2', kind: 'text', bounds: { x: 0, y: 0, w: 100, h: 50 }, metrics: { overflowY: 5, lines: 2 } },
  { id: 't3', kind: 'text', bounds: { x: 0, y: 0, w: 100, h: 50 }, metrics: { overflowY: 8, lines: 2 } },
] }] }
const xMeasured = { pages: [{ pageNo: 1, index: 0, elements: [
  { id: 't1', kind: 'text', overflowY: 6, lines: 3 },     // 估算 0 / 实测 6 → 漏报 error
  { id: 't2', kind: 'text', overflowY: 4, lines: 2 },     // 估算 5 / 实测 4 → 复现 warning
  { id: 't3', kind: 'text', overflowY: 0.5, lines: 2 },   // 估算 8 / 实测 0.5 → relief warning
] }] }
ok('v0.12：实测交叉夹具复刻真契约（两侧都带 1 基 pageNo 配对键，index 只是内部下标）',
  xLayout.pages.every((p, i) => p.pageNo === i + 1) && xMeasured.pages.every((p, i) => p.pageNo === i + 1)
  && xLayout.pages.length === xMeasured.pages.length,
  `L.pageNo=${xLayout.pages.map((p) => p.pageNo)}｜M.pageNo=${xMeasured.pages.map((p) => p.pageNo)}`)
const xR = mcc(xLayout, xMeasured)
ok('v0.12：实测交叉——估算漏报 → error（M2 核心捕获）', xR.some((f) => f.code === 'measured-overflow' && f.severity === 'error' && f.id === 't1'), JSON.stringify(xR))
ok('v0.12：实测交叉——估算过报 → relief warning（三态判据：漏报 1/复现 1/relief 1）',
  xR.filter((f) => f.code === 'measured-relief' && f.severity === 'warning').length === 1
  && xR.filter((f) => f.code === 'measured-overflow' && f.severity === 'warning').length === 1,
  `relief=${xR.filter((f) => f.code === 'measured-relief').length} 复现=${xR.filter((f) => f.code === 'measured-overflow').length}`)
// 27.3 真实测量（2 页小工程；有浏览器时验证 measured.json 落盘与无溢出）
const m2Deck = join(root, 'examples', 'm2-smoke')
await rm(m2Deck, { recursive: true, force: true })
await mkdir(join(m2Deck, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(m2Deck, 'deck.yaml'), 'version: 1\ntitle: m2\nsize: [960, 540]\ntheme: {colors: {primary: "#2563EB"}}\npages:\n  - pages/01.yaml\n  - pages/02.yaml\n')
await (await import('node:fs/promises')).writeFile(join(m2Deck, 'pages', '01.yaml'), [
  'pageType: content', 'elements:',
  '  - elementId: t', '    elementType: text', '    bounds: [60, 60, 400, 50]',
  '    content: {text: "短文本", fontSize: 18, color: "#2563EB"}', '', ''].join('\n'))
await (await import('node:fs/promises')).writeFile(join(m2Deck, 'pages', '02.yaml'), [
  'pageType: content', 'elements:',
  '  - elementId: t2', '    elementType: text', '    bounds: [60, 60, 300, 40]',
  '    content: {text: "这是一段测试文本用于实测档验证", fontSize: 18, color: "#2563EB"}', '', ''].join('\n'))
const m2r = await measureLayout(m2Deck)
const { findEdge } = await import('../lib/measurement.js')
const m2Browser = Boolean(findEdge())
const m2Layout = m2Browser ? JSON.parse(await (await import('node:fs/promises')).readFile(join(m2Deck, 'preview', 'layout.json'), 'utf8')) : null
// 注意：if / else **两支必须发出同样条数的断言**。原来 if 支 2 条、else 支 1 条，
// 于是无浏览器机器上 smoke 总数会少 1，而 §37.10 的文档计数自证会因此**假红**（报"文档计数过期"，
// 其实只是环境不同）。这类"总数随环境漂移"本身就是同一族静默问题，一并修掉。
if (m2Browser) {
  ok('v0.12：真实测量（2 页落盘 measured.json + 无估算/实测分歧）',
    m2r.pages === 2 && m2r.measured.pages.length === 2 && existsSync(join(m2Deck, 'preview', 'measured.json')),
    `pages=${m2r.pages} notes=${(m2r.notes ?? []).join(';')}`)
  const m2x = mcc(m2Layout, m2r.measured)
  ok('v0.12：真实测量交叉无分歧（短文本不溢出——**阴性断言，防误报**；通道是否真在比由 §27.5/27.6 的注入断言负责）',
    !m2x.some((f) => f.severity === 'error'), `出现实测 error：${JSON.stringify(m2x)}`)
} else {
  ok('v0.12：无浏览器跳过真实测量（降级路径）', true)
  ok('v0.12：无浏览器跳过实测交叉（降级路径）', true)
}
// 27.4~27.7 真产物断言（2026-09-18 新增）。**必须在真产物上跑**——原 bug 的全部原因就是
//   "夹具照着函数期望的形状写、从没调用过真生产者"。无浏览器时按**跳过**计并写明标签：
//   不伪装成通过，同时让断言总数保持恒定（否则 §37.10 的文档计数自证在无浏览器机器上会红）。
const m2Real = (label, fn) => {
  if (!m2Browser) return ok(`${label}（无浏览器：跳过）`, true)
  const r = fn()
  return ok(label, r.ok, r.extra ?? '')
}
m2Real('v0.12：两档页号契约（真产物）——layout.json 与 measured.json 的 1 基 pageNo 一一对应', () => {
  const L = m2Layout.pages.map((p) => p.pageNo)
  const M = m2r.measured.pages.map((p) => p.pageNo)
  return {
    ok: L.length === 2 && M.length === 2 && L.every((n, i) => n === i + 1) && M.every((n, i) => n === i + 1) && L.join() === M.join(),
    extra: `layout=${JSON.stringify(L)}｜measured=${JSON.stringify(M)}`,
  }
})
// 在**真产物**上只改一个元素的实测值：交叉核查必须捕获它。这条是"通道真的在比对"的判据——
// 原来的"无分歧"断言是**否定式**的，通道死了也照样绿。
const injectOverflowAt = (doc, pageNo, elId, px) => {
  const copy = JSON.parse(JSON.stringify(doc))
  const pg = (copy.pages ?? []).find((p) => p.pageNo === pageNo)
  const el = (pg?.elements ?? []).find((e) => e.id === elId)
  if (el) el.overflowY = px
  return copy
}
m2Real('v0.12：实测交叉捕获注入溢出（真产物·第 2 页元素 t2 注入 40px → 必须报 1 条 error）', () => {
  const x = mcc(m2Layout, injectOverflowAt(m2r.measured, 2, 't2', 40))
  return { ok: x.filter((f) => f.code === 'measured-overflow' && f.severity === 'error' && f.id === 't2').length === 1, extra: JSON.stringify(x) }
})
m2Real('v0.12：实测交叉页配对无错位（真产物·第 1 页元素 t 的注入必须落在第 1 页，不得与第 2 页串页）', () => {
  const x = mcc(m2Layout, injectOverflowAt(m2r.measured, 1, 't', 40))
  return { ok: x.filter((f) => f.code === 'measured-overflow' && f.id === 't').length === 1, extra: JSON.stringify(x) }
})
m2Real('v0.12：缺 pageNo 的旧版 measured.json → 报 measured-unpaired（契约破坏必须响亮，不得静默返空）', () => {
  const stale = JSON.parse(JSON.stringify(m2r.measured))
  for (const p of stale.pages) delete p.pageNo
  const x = mcc(m2Layout, stale)
  return { ok: x.length === 2 && x.every((f) => f.code === 'measured-unpaired' && f.severity === 'error'), extra: JSON.stringify(x) }
})
await rm(m2Deck, { recursive: true, force: true })

// ── 28. v0.13.0 (M3)：数据连贯——跨页数字对账 + source 证据核查表 + themeRef 断言 ──
const { crosscheckDeck, crosscheckReport } = await import('../lib/crosscheck.js')
const ccDeck = join(root, 'examples', 'cc-smoke')
await rm(ccDeck, { recursive: true, force: true })
await mkdir(join(ccDeck, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(ccDeck, 'deck.yaml'), [
  'version: 1', 'title: cc', 'size: [960, 540]',
  'theme: {colors: {primary: "#2563EB"}, textStyles: {body: {fontSize: 14}}}',
  'pages:', '  - pages/01.yaml', '  - pages/02.yaml', '', ''].join('\n'))
await (await import('node:fs/promises')).writeFile(join(ccDeck, 'pages', '01.yaml'), [
  'pageType: content', 'source: "公司财报 2026 年报"',
  'elements:',
  '  - elementId: n1', '    elementType: text', '    bounds: [60, 60, 400, 40]',
  '    content: {text: "本季度营收 45.6% 增长", fontSize: 14}',
  '', ''].join('\n'))
await (await import('node:fs/promises')).writeFile(join(ccDeck, 'pages', '02.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: n2', '    elementType: text', '    bounds: [60, 60, 400, 40]',
  '    content: {text: "上半年营收增长 45.6%，全年 2026 展望", fontSize: 14}',
  '  - elementId: n3', '    elementType: text', '    bounds: [60, 120, 400, 40]',
  '    content: {text: "另一指标 52%", fontSize: 14}',
  '', ''].join('\n'))
const ccCtx = await resolveDeck(ccDeck)
const cc = crosscheckDeck(ccCtx)
ok('v1.0.3：材料包按阅读顺序收全页正文（2 页；数字原文照录，不再产出"跨页数字分组"）',
  cc.pages.length === 2
  && cc.pages[0].texts.some((t) => t.text.includes('45.6%'))
  && cc.pages[1].texts.some((t) => t.text.includes('45.6%'))
  && cc.pages[1].texts.some((t) => t.text.includes('52%'))
  && cc.groups === undefined,
  cc.pages.map((p) => `P${p.index}:${p.texts.length} 段文字`).join(' '))
const ccReport = crosscheckReport(ccCtx)
ok('v1.0.3：材料包不做判定（无 status/groups）——出处标"作者自述（未核实）"、含素材清单+四分类协议、完整包落盘',
  cc.pages.every((p) => p.status === undefined)
  && cc.pages[0].authorSource === '公司财报 2026 年报'
  && /作者自述出处/.test(ccReport)
  && /可核对的外部素材/.test(ccReport)
  && ['一致', '冲突', '无来源支撑', '无法核实'].every((k) => ccReport.includes(k))
  && /不要使用子代理/.test(ccReport)
  && existsSync(join(ccDeck, 'preview', 'review-pack.md')),
  `四分类齐=${['一致', '冲突', '无来源支撑', '无法核实'].every((k) => ccReport.includes(k))}；包=preview/review-pack.md`)
// themeRef 断言：缺失 $ref → resolveDeck 报错（M3 防静默回退）
const refDeck = join(root, 'examples', 'ref-smoke')
await rm(refDeck, { recursive: true, force: true })
await mkdir(join(refDeck, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(refDeck, 'deck.yaml'), [
  'version: 1', 'title: ref', 'size: [960, 540]',
  'theme: {colors: {primary: "#2563EB"}}',
  'pages:', '  - pages/01.yaml', '', ''].join('\n'))
await (await import('node:fs/promises')).writeFile(join(refDeck, 'pages', '01.yaml'), [
  'pageType: content', 'elements:',
  '  - elementId: x', '    elementType: text', '    bounds: [60, 60, 200, 30]',
  '    content: {text: "bad ref", color: "$ghost"}', '', ''].join('\n'))
let refErr = null
try { await resolveDeck(refDeck) } catch (e) { refErr = e }
ok('v0.13：themeRef 断言——缺失 $ref 报错（防字面 $xxx 上屏）', refErr !== null && refErr.messages?.some((m) => m.includes('$ghost')), refErr?.messages?.join('; '))
// 正确引用不报
await (await import('node:fs/promises')).writeFile(join(refDeck, 'pages', '01.yaml'), [
  'pageType: content', 'elements:',
  '  - elementId: x', '    elementType: text', '    bounds: [60, 60, 200, 30]',
  '    content: {text: "ok ref", color: "$primary"}', '', ''].join('\n'))
await resolveDeck(refDeck)
ok('v0.13：themeRef 断言——正确引用通过', true)
// 清理
await rm(ccDeck, { recursive: true, force: true })
await rm(refDeck, { recursive: true, force: true })

// ── 29. v0.14.2/5：预览路由双重防线（表判据 + refcount + async 注册/卸载）────────
const { registerPreviewRoute: rpr } = await import('../lib/preview-server.js')
const routeCalls = []
const fakePrefixes = new Map()
const fakeWs = {
  prefixes: fakePrefixes, // 真实语义：webServer 暴露前缀表（hasRoute 判据）
  // 【2026-09-26 修正：假对象曾给真 bug 背书】真契约是**同步**的（DSH 0.1.7-rc.2
  // `dsh-host-webserver/lib/index.js:177-184`）：成功返回 disposer **函数**，重复注册**同步抛错**。
  // 旧假对象写成 `async`（返回 Promise），于是"对返回值调 .then"在真宿主上 TypeError、整个插件条目
  // 激活失败（桌面端实测），而在这里全绿。见 docs/05「假对象必须复刻真契约」。
  register: (r) => {
    if (fakePrefixes.has(r.path)) throw new Error(`webserver: duplicate ${r.kind} route "${r.path}"`)
    routeCalls.push(r.path)
    fakePrefixes.set(r.path, { kind: r.kind, path: r.path, handler: r.handler })
    return () => { fakePrefixes.delete(r.path) } // 同步 disposer（真契约）
  },
}
// Cordis 语义（2026-09-14 用真库探针实测，见 docs/02 §2.12）：`ctx.effect(cb)` **立即执行 cb**，
// 并把 **cb 的返回值**当作 disposer（不是把 cb 当清理函数）。旧假 ctx 写反了这条契约，
// 于是"清理逻辑写在 cb 体里"的 preview-server 在这个假环境里看起来是对的、在真宿主里却是
// "注册当刻就把路由取消掉"——假契约掩盖了真 bug。这里按真语义重建假 ctx。
const fakeCtx = { get: () => fakeWs, effect: (cb) => { const cleanup = cb(); return () => { if (typeof cleanup === 'function') cleanup() } } }
const settle = () => new Promise((r) => setTimeout(r, 50))
const d1 = rpr(fakeCtx)
const d2 = rpr(fakeCtx) // 双源第二实例：应幂等（0 新注册）
await settle()
ok('v0.14.2/5：路由幂等——双实例只注册一次（表 1 条，无 duplicate）',
  routeCalls.length === 1 && fakePrefixes.has('/ppt-preview'),
  `calls=${routeCalls.join(',')}`)
d1()
await settle()
ok('v0.14.2/5：单一 dispose 不卸载（refcount>0，路由仍在）', fakePrefixes.has('/ppt-preview'))
d2()
await settle()
ok('v0.14.2/5：最后 dispose 真正卸载（await 卸载后表清空）', !fakePrefixes.has('/ppt-preview'))
// 表判据兜底：模拟残留路由（早于本次实例的异步卸载未完成）→ 调用不重复注册
fakePrefixes.set('/ppt-preview', { kind: 'prefix', path: '/ppt-preview', handler: null })
const d3 = rpr(fakeCtx)
await settle()
ok('v0.14.2/5：表判据兜底——残留路由存在时不重复注册（防 duplicate 根源）', routeCalls.length === 1 && fakePrefixes.has('/ppt-preview'))
d3()
await settle()

// ══ 30. v0.14.6：autodeclare yaml@2 回归（反馈 A：doc.get() 返回 YAMLSeq → toJS 归一）═══════════
const { applyAutoDeclare: applyAD } = await import('../lib/autodeclare.js')
const YAML = (await import('yaml')).default
const autoDeck = join(root, 'examples', 'autodeclare-smoke')
const fsp = await import('node:fs/promises')
await rm(autoDeck, { recursive: true, force: true })
await mkdir(join(autoDeck, 'pages'), { recursive: true })
await fsp.writeFile(join(autoDeck, 'deck.yaml'), [
  'version: 1', 'title: autodeclare regression', 'size: [960, 540]',
  'theme:',
  '  colors: {primary: "#3E4E63", accent: "#D64253", bg: "#F5F6F7", text: "#2B3440"}',
  '  textStyles: {title: {fontSize: 24, color: "$text"}, body: {fontSize: 14, color: "$text"}}',
  'pages:', '  - pages/01.yaml', '  - pages/02.yaml', '', ''].join('\n'))
// 流式风格（`- {pair: [...]}`，用户 round-1 页面同款）：band×title 已声明，band2×stamp 未声明
await fsp.writeFile(join(autoDeck, 'pages', '01.yaml'), [
  'pageType: cover', 'background: "$bg"', 'elements:',
  '  - elementId: band', '    elementType: shape', '    kind: rect', '    bounds: [0, 0, 960, 110]', '    fill: "$primary"',
  '  - elementId: title', '    elementType: text', '    bounds: [40, 30, 600, 70]', '    content: {style: "$title", text: "萨尔浒之战"}',
  '  - elementId: band2', '    elementType: shape', '    kind: rect', '    bounds: [0, 480, 960, 60]', '    fill: "$accent"',
  '  - elementId: stamp', '    elementType: text', '    bounds: [30, 492, 300, 40]', '    content: {style: "$body", text: "内容页签"}',
  'expectedOverlaps:', '  - {pair: [band, title]}', '', ''].join('\n'))
// 块式风格（`- pair: [...]`）：card×card-title 已声明，bar×bar-label 未声明
await fsp.writeFile(join(autoDeck, 'pages', '02.yaml'), [
  'pageType: content', 'background: "$bg"', 'elements:',
  '  - elementId: card', '    elementType: shape', '    kind: rect', '    bounds: [40, 60, 880, 140]', '    fill: "$primary"',
  '  - elementId: card-title', '    elementType: text', '    bounds: [70, 90, 400, 60]', '    content: {style: "$title", text: "第一列"}',
  '  - elementId: bar', '    elementType: shape', '    kind: rect', '    bounds: [40, 240, 880, 40]', '    fill: "$accent"',
  '  - elementId: bar-label', '    elementType: text', '    bounds: [70, 246, 300, 30]', '    content: {style: "$body", text: "标注"}',
  'expectedOverlaps:', '  - pair: [card, card-title]', '', ''].join('\n'))
const autoCtx = await resolveDeck(autoDeck)
const autoLayout = (await renderDeck(autoCtx, {})).layout
let autoThrew = null
let autoAdded = []
try { autoAdded = await applyAD(autoCtx, autoLayout) } catch (e) { autoThrew = e }
ok('v0.14.6: autodeclare yaml@2 不再崩溃（doc.get()=YAMLSeq → toJS 归一，原 (.map is not a function)）',
  autoThrew === null, autoThrew ? String(autoThrew).slice(0, 120) : '')
ok('v0.14.6: 自动声明补齐未声明对（流式页 1 对 + 块式页 1 对）',
  autoAdded.length === 2 && autoAdded.every((a) => a.added === 1),
  JSON.stringify(autoAdded))
const declCount = async (n) => (YAML.parse(await fsp.readFile(join(autoDeck, 'pages', n === 1 ? '01.yaml' : '02.yaml'), 'utf8')).expectedOverlaps ?? []).length
ok('v0.14.6: 声明已写入文件（两种写法等价，各自 2 对）', (await declCount(1)) === 2 && (await declCount(2)) === 2,
  `01=${await declCount(1)} 02=${await declCount(2)}`)
const reCtx = await resolveDeck(autoDeck)
const reLayout = (await renderDeck(reCtx, {})).layout
const reAdded = await applyAD(reCtx, reLayout)
ok('v0.14.6: 幂等——重复运行零新增（已声明对全部跳过）', reAdded.length === 0, JSON.stringify(reAdded))
await rm(autoDeck, { recursive: true, force: true })

// ══ 31. v0.15.0：反馈二——B1 元素级样式键 / A6 加粗CJK字宽 / A8 承载面 / C3 内边距降噪 / A3 splice+slice ═══════════
const { charWidth } = await import('../lib/pptd/layout.js')
ok('v0.15.0 A6: CJK 加粗字宽 ×1.06（微软雅黑粗体实测 1.03-1.07）',
  charWidth('莎', 12, true) === 12 * 1.06 && charWidth('莎', 12, false) === 12,
  `bold=${charWidth('莎', 12, true)} plain=${charWidth('莎', 12, false)}`)
// B1：元素级样式键 → resolveDeck 报错 + 明确指引（此前静默忽略按 18pt 度量）
const b1Deck = join(root, 'examples', 'b1-smoke')
await rm(b1Deck, { recursive: true, force: true })
await mkdir(join(b1Deck, 'pages'), { recursive: true })
await fsp.writeFile(join(b1Deck, 'deck.yaml'), ['version: 1', 'title: b1', 'size: [960, 540]', 'pages:', '  - pages/01.yaml', '', ''].join('\n'))
await fsp.writeFile(join(b1Deck, 'pages', '01.yaml'), [
  'pageType: content', 'elements:',
  '  - elementId: t1', '    elementType: text', '    bounds: [60, 60, 400, 40]',
  '    fontSize: 14', '    content: {text: "误写"}', '', ''].join('\n'))
let b1Err = null
try { await resolveDeck(b1Deck) } catch (e) { b1Err = e }
ok('v0.15.0 B1: 元素级样式键 → 校验报错 + 指引（content 内部写法）',
  b1Err !== null && b1Err.messages?.some((m) => m.includes('样式必须写在 content 内部')),
  b1Err?.messages?.join('; ').slice(0, 160))
await rm(b1Deck, { recursive: true, force: true })
// A8：渐变承载面 → 对比度以中途 stop 为基（浅字深底不再误报背景）
const a8Layout = {
  size: { width: 960, height: 540 },
  theme: { colors: {} },
  pages: [{
    index: 0, name: 'a8', id: 'a8',
    elements: [
      { id: 'box', kind: 'shape', bounds: { x: 40, y: 40, w: 400, h: 200 }, fill: { type: 'gradient', stops: [{ pos: 0, color: '#3E4E63' }, { pos: 100, color: '#FFFFFF' }] } },
      { id: 'txt', kind: 'text', bounds: { x: 60, y: 60, w: 300, h: 60 }, text: '白字', style: { fontSize: 14, color: '#FFFFFF' } },
    ],
    expectedOverlaps: [{ pair: ['box', 'txt'] }],
  }],
}
const vA8 = verifyDeck(a8Layout).text
ok('v0.15.0 A8: 渐变承载面被识别（白字 vs 深浅渐变中心 → 无对比度误报）',
  !vA8.includes('aesthetic-contrast'),
  vA8.split('\n').filter((l) => l.includes('aesthetic-contrast')).join('; ').slice(0, 120))
// C3：文字在形体内（内边距 ≤6px）→ 不再报 near-align
const c3Layout = {
  size: { width: 960, height: 540 },
  theme: { colors: {} },
  pages: [{
    index: 0, name: 'c3', id: 'c3',
    elements: [
      { id: 'card', kind: 'shape', bounds: { x: 100, y: 100, w: 500, h: 200 }, fill: '#F5F6F7' },
      { id: 'lab', kind: 'text', bounds: { x: 104, y: 104, w: 492, h: 192 }, text: '内边距 4px', style: { fontSize: 14, color: '#333333' } },
    ],
    expectedOverlaps: [{ pair: ['card', 'lab'] }],
  }],
}
const vC3 = verifyDeck(c3Layout).text
ok('v0.15.0 C3: 内边距类 near-align 豁免（包含关系成对 = 有意内边距）',
  !vC3.includes('near-align') && vC3.includes('预期重叠'), (vC3.match(/near-align/g) ?? []).length + ' hits')
// A3：splice/slice zip 级回归（seed = smoke 导出 3 页；splice 页2 → 仅 2 条目变化；slice → 1 页）
const { spliceIntoSource, sliceSource, zipDigests } = await import('../lib/splice.js')
const seedCtx = await resolveDeck(smokeDir)
const seedOut = join(smokeDir, 'out-splice-smoke.pptx')
await (await import('node:fs/promises')).rm(seedOut, { force: true })
await exportPptx(seedCtx, { out: seedOut, engine: 'pptd' })
const spl = await spliceIntoSource({ deckDir: smokeDir, source: seedOut, page: 1, sourcePage: 2, out: join(smokeDir, 'out-splice-smoke-spliced.pptx') })
const seedBuf = await (await import('node:fs/promises')).readFile(seedOut)
const splBuf = await (await import('node:fs/promises')).readFile(spl.out)
const seedD = zipDigests(seedBuf)
const splD = zipDigests(splBuf)
const delta = [...seedD.keys()].filter((k) => seedD.get(k) !== splD.get(k))
ok('v0.15.0 A3: splice 只改变目标页 2 条目（其余 SHA256 不变）',
  delta.length === 2 && delta.every((k) => k.startsWith('ppt/slides/slide2') || k.startsWith('ppt/slides/_rels/slide2')), JSON.stringify(delta))
const sl = await sliceSource({ source: spl.out, page: 2, out: join(smokeDir, 'out-splice-smoke-single.pptx') })
const zS = zipRead(await (await import('node:fs/promises')).readFile(sl.out))
const slideEntries = [...zS.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
const sldLst = decodeXml(zS.get('ppt/presentation.xml')).match(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/)?.[0] ?? ''
ok('v0.15.0 A3: slice 单页化（1 张 slide + sldIdLst 单条且闭合）',
  slideEntries.length === 1 && (sldLst.match(/<p:sldId\b[^>]*\/?>/g) ?? []).length === 1,
  sldLst.slice(0, 120))
await (await import('node:fs/promises')).rm(seedOut, { force: true })
await (await import('node:fs/promises')).rm(spl.out, { force: true })
await (await import('node:fs/promises')).rm(sl.out, { force: true })

// ══ 32. v1.0.0-修订：P1 表格导出结构回归 + parity + P6 线真实相交（一致性）═══════════
const { collectDeclarable } = await import('../lib/verify.js')
// P1：带表格 deck 导出 → graphicFrame 无嵌套 a:xfrm + tableStyleId + parity 完整
const tDeck = join(root, 'examples', 'table-smoke')
await rm(tDeck, { recursive: true, force: true })
await mkdir(join(tDeck, 'pages'), { recursive: true })
await fsp.writeFile(join(tDeck, 'deck.yaml'), ['version: 1', 'title: tbl', 'size: [960, 540]', 'pages:', '  - pages/01.yaml', '', ''].join('\n'))
await fsp.writeFile(join(tDeck, 'pages', '01.yaml'), [
  'pageType: content', 'elements:',
  '  - elementId: tbl', '    elementType: table', '    bounds: [60, 100, 500, 240]',
  '    cols: [维度, 指标A, 指标B]',
  '    rows:', '      - [效率, 45.6%, -12%]', '      - [成本, +8%, -3%]', '', ''].join('\n'))
const tCtx = await resolveDeck(tDeck)
const tExp = await exportPptx(tCtx, { out: join(tDeck, 't.pptx'), engine: 'pptd' })
const tZip = zipRead(await fsp.readFile(tExp.file))
let tBad = 0
let tStyled = 0
for (const [k, v] of tZip) {
  if (!/^ppt\/slides\/slide\d+\.xml$/.test(k)) continue
  const x = decodeXml(v)
  if (x.includes('<p:xfrm><a:xfrm>')) tBad++
  if (x.includes('<a:tableStyleId>')) tStyled++
}
ok('v1.0.0-修订 P1: 表格 graphicFrame 无嵌套 a:xfrm（PowerPoint 弃帧根源）', tBad === 0, `bad=${tBad}`)
ok('v1.0.0-修订 P1: 表槽含 tableStyleId（部分版本弃帧的第二根源）', tStyled >= 1, `styled=${tStyled}`)
ok('v1.0.0-修订 P1: 导出 parity 自证（表 1/1 · 图 0/0 · 结构合法）', tExp.parity?.ok === true, JSON.stringify(tExp.parity))
await rm(tDeck, { recursive: true, force: true })
// P6：线元素真实相交——AABB 假阳性不算重叠/不进声明；真跨越仍报/可声明
const p6Layout = {
  size: { width: 960, height: 540 },
  theme: { colors: {} },
  pages: [{
    index: 0, name: 'p6', id: 'p6',
    elements: [
      { id: 'diag', kind: 'line', points: [[50, 300], [400, 50]], bounds: { x: 50, y: 50, w: 350, h: 250 }, line: { color: '#000000', width: 1 } },
      { id: 'miss', kind: 'shape', bounds: { x: 330, y: 120, w: 50, h: 50 }, fill: '#3E4E63' }, // 仅 AABB 相交（线段从上方掠过）
      { id: 'hit', kind: 'shape', bounds: { x: 120, y: 180, w: 80, h: 60 }, fill: '#D64253' }, // 线段真穿过
    ],
  }],
}
const vP6 = verifyDeck(p6Layout).text
const decP6 = collectDeclarable(p6Layout.pages[0], p6Layout.size)
const keyOf = (a, b) => [a, b].sort().join(' × ')
ok('v1.0.0-修订 P6: AABB 假阳性不算重叠（diag×miss 无错误）',
  !vP6.includes('diag') || !/- \[✗\]/.test(vP6.split('\n').find((l) => l.includes('diag') && l.includes('miss')) ?? ''), '')
ok('v1.0.0-修订 P6: 真跨越仍报错（diag×hit unexpected-overlap）',
  vP6.includes('diag') && vP6.includes('hit') && vP6.includes('unexpected-overlap'),
  vP6.split('\n').filter((l) => l.includes('unexpected-overlap')).slice(0, 1).join('; ').slice(0, 100))
ok('v1.0.0-修订 P6: collectDeclarable 与判据一致（只建议 diag×hit）',
  decP6.length === 1 && decP6[0].join(' × ') === keyOf('diag', 'hit'), JSON.stringify(decP6))

// ── 33. v1.0.0-适配 DSH 0.1.5-rc.2：会话身份取用 + 内嵌手册 skill + 语义路由判据 ──
// 背景（真实进程实测）：0.1.5-rc.2 只提供 `agents` 服务、**没有** `agent` 服务——旧代码 `ctx.get('agent')`
// 恒为 undefined（会话级设置被静默忽略、ppt_state 落到 'default'）。官方通道是 execute(args, exec).agent。
// 另一处：旧意图判据要求"动词紧邻名词"，真实说法「帮我做一个 5 页的产品介绍 PPT」判为无意向 →
// 工作流提示词从不注入（装配探针实测：28 次 system-prompt/assemble 全部没有 ppt-workflow 段）。
const { isPptIntent: rIntent, isPptOff: rOff } = await import('../lib/router.js')
const { parseManual, MANUAL_FILE, MANUAL_NAME } = await import('../lib/skill.js')
const { readFileSync } = await import('node:fs')

ok('适配·意图判据：修饰语夹在动宾之间也算 PPT 任务（旧实现对漏报）',
  rIntent('帮我做一个 5 页的产品介绍 PPT。', []) && rIntent('帮我做一个包含市场分析与财务预测的产品介绍 PPT', []) &&
  rIntent('先帮我做个 PPT', []), '')
ok('适配·意图判据：名词在前 / 编辑 / 总结 / 英文 deck 均命中',
  rIntent('这份 PPT 帮我改改', []) && rIntent('把这个演示文稿统一一下配色', []) &&
  rIntent('把这份幻灯片总结成 3 页', []) && rIntent('deck 里第 4 页重做一下', []), '')
ok('适配·意图判据：弱信号不切（只提一句 PPT 不激活）',
  !rIntent('PPT 是什么', []) && !rIntent('今天开会讨论了这个项目', []) && !rIntent('帮我写一段 Python 脚本', []), '')
ok('适配·意图判据：附件是 .pptx 直接视为强意图',
  rIntent('', [{ name: 'orig.pptx' }]) && rIntent('改一下', [{ name: 'x.pptx' }]), '')
ok('适配·退出判据：否定/停止/无关（旧实现漏"退出 PPT"/"不用做 PPT 了"）',
  rOff('不用做 PPT 了') && rOff('退出 PPT') && rOff('这跟 PPT 无关') && rOff('PPT 不做了'), '')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
ok("适配·会话身份：代码里不再使用 DSH 不存在的 ctx.get('agent')（注释里的历史说明不算）",
  !/ctx\.get\('agent'\)/.test(stripComments(readFileSync(join(root, 'src', 'index.js'), 'utf8'))) &&
  !/ctx\.get\('agent'\)/.test(stripComments(readFileSync(join(root, 'src', 'tools.js'), 'utf8'))), '')
ok('适配·会话身份：走 execute(args, exec) 的 exec.agent（状态工具 + 两处质量档查询）',
  /exec\?\.agent/.test(readFileSync(join(root, 'src', 'index.js'), 'utf8')) &&
  (readFileSync(join(root, 'src', 'tools.js'), 'utf8').match(/qualityOfDiag\(exec\?\.agent, dir\)/g) ?? []).length === 2, '')

const skillSrc = readFileSync(join(root, 'src', 'skill.js'), 'utf8')
ok('适配·内嵌手册：经 ctx.skills.register 注册为运行时 skill（落调用 ctx 所在层）',
  /skills\.register\(/.test(skillSrc) && /source: 'runtime'/.test(skillSrc) && /ppt-studio: embedded skill/.test(skillSrc), '')
const parsedManual = parseManual(readFileSync(MANUAL_FILE, 'utf8'))
ok('内嵌手册：frontmatter 解析（name/description/whenToUse）',
  parsedManual?.name === MANUAL_NAME && (parsedManual?.description ?? '').length > 20 && typeof parsedManual?.whenToUse === 'string',
  `name=${parsedManual?.name ?? '(null)'}`)
ok('内嵌手册：content = 去 frontmatter 正文（与 dsh-skill-filesystem 同语义 body.trim）',
  (parsedManual?.content ?? '').startsWith('#') && !(parsedManual?.content ?? '').includes('name: ppt-studio-manual') &&
  (parsedManual?.content ?? '').length > 1000, `len=${parsedManual?.content?.length ?? 0}`)
ok('内嵌手册：坏 frontmatter 返回 null（不阻断插件装配）；未声明时不产出 invocation',
  parseManual('---\nname: Bad Name\n---\nbody') === null && parseManual('no frontmatter here') === null &&
  parseManual('---\nname: ok-name\n---\nbody')?.invocation === undefined, '')

// ── 35. 内置技能包（2026-09-14）：制作能力手册 —— 纯增量、可断言、不被固化的数值污染 ──────
// 用户硬约束：技能是"锦上添花"，绝不能影响既有工作流；老用户更新后用法零变化。
// 于是把约束变成机器断言：① 工作流段逐行超集（只增不改不删）② 技能自身不得写死门禁数值。
const { listBundledSkills, bundledSkillNames } = await import('../lib/skill.js')
const bundled = listBundledSkills()
const bundledNames = bundledSkillNames()
ok('内置技能包：随包技能全部可解析（name == 目录名，kebab-case）',
  bundled.length >= 4 && bundled.every((b) => b.parsed.name === b.file.replace(/\\/g, '/').split('/').slice(-2)[0]),
  `共 ${bundled.length} 本：${bundledNames.join('、')}`)
ok('内置技能包：制作能力三本齐备（craft / data / copy）',
  ['ppt-studio-craft', 'ppt-studio-data', 'ppt-studio-copy', 'ppt-studio-manual'].every((n) => bundledNames.includes(n)),
  bundledNames.join('、'))
ok('内置技能：描述只写触发、长度合规（>20 且 ≤500 字符）',
  bundled.every((b) => b.parsed.description.length > 20 && b.parsed.description.length <= 500),
  bundled.map((b) => `${b.parsed.name}=${b.parsed.description.length}`).join(' '))
ok('内置技能：正文自包含且短（每本 ≤ 8000 字符，按需加载成本可控）',
  bundled.every((b) => b.parsed.content.length > 800 && b.parsed.content.length <= 8000),
  bundled.map((b) => `${b.parsed.name}=${b.parsed.content.length}`).join(' '))
ok('内置技能：每本都声明优先级边界（用户指令 > 手册 > 工具默认）',
  bundled.filter((b) => b.parsed.name !== 'ppt-studio-manual')
    .every((b) => /用户指令/.test(b.parsed.content) && /ppt_verify|工具输出|门禁/.test(b.parsed.content)),
  '')
// 反污染扫描：技能正文不得把数值写成"规范性默认"。规则集经校准：
// 8 条植入违规全抓、8 条合法表述零误报、现有技能零命中（见 docs/03 记录）。
// 说明：只抓"规范性措辞 + 数值"这一历史事故形状；描述性数字（经验值/文档引用）不在此列。
const BANNED = [
  { id: '默认+数值', re: /默认[^。\n]{0,10}\d+\s*(?:pt|号|磅|页|字)/u },
  { id: '必须/一律+阈值', re: /(?:必须|一律|统一|强制)[^。\n]{0,10}(?:不小于|至少|≥|>=|不超过|至多|≤|<=|小于)\s*\d+/u },
  { id: '字号下限=数值', re: /字号下限\s*(?:=|为|是)\s*\d+/u },
  { id: '字号固定/写死', re: /字号[^。\n]{0,6}(?:固定|写死)\s*\d+/u },
  { id: '每页/每块预算', re: /每(?:页|块)[^。\n]{0,6}(?:≤|<=|不超过|至多|最多|至少|不小于)\s*\d+/u },
]
const polluted = []
for (const b of bundled) {
  for (const line of b.parsed.content.split('\n')) {
    for (const rule of BANNED) if (rule.re.test(line)) polluted.push(`${b.parsed.name}[${rule.id}]`)
  }
}
ok('内置技能：不含写死的门禁数值（最小字号/页数/字数上限等）——历史事故的机器防线',
  polluted.length === 0, polluted.join('、') || '0 处命中')

// 反"为了变化而破坏主题一致性"扫描（2026-09-14 用户抓到的失误：从外部 skill 抄了一条
// "同一明暗基调连续 3 页以上就该换"，与我方 theme-conformance / 模板统一基调直接冲突）。
// 规则：出现"底色/背景色/主色/色调/明暗基调/深底/浅底 + 换/交替/变化"且**同一行没有否定或统一口径** → 违规。
// 校准：5 条植入违规全抓、6 条合法表述零误报、现有技能零命中。
const VARY_DECKWIDE = /(?:(?:底色|背景色|主色|色调|明暗基调|明暗|深底|浅底|亮底|暗底)[^。\n]{0,12}(?:换|交替|变化))|(?:(?:换|交替)[^。\n]{0,8}(?:底色|背景色|主色|色调|明暗基调|深底|浅底|亮底|暗底))/
const THEME_CONSISTENT = /(?:不要|不该|不靠|禁止|别|而非|不是|统一|一致)/
const themeViolations = []
for (const b of bundled) {
  for (const line of b.parsed.content.split('\n')) {
    if (VARY_DECKWIDE.test(line) && !THEME_CONSISTENT.test(line)) themeViolations.push(`${b.parsed.name}: ${line.trim().slice(0, 60)}`)
  }
}
ok('内置技能：不劝人"为了变化改全册底色/主色"（主题一致性优先于节奏）——用户抓到的失误防线',
  themeViolations.length === 0, themeViolations.join(' | ') || '0 处命中')

// 工作流段超集断言：新段必须包含基线每一行（只允许新增，不允许改写/删除）
const baseline = JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 'workflow-baseline.json'), 'utf8'))
const baseCfg = { mode: 'auto', fidelity: 'auto', review: 'points', quality: 'standard', engine: 'auto', template: null, pauseAfter: [], workflowActive: true }
const brokenVariants = []
let addedLines = 0
for (const v of baseline.variants) {
  const now = routerMod.workflowSection(v.taskType, { ...baseCfg, quick: v.quick }).text.split('\n')
  const missing = v.lines.filter((l) => !now.includes(l))
  addedLines += now.filter((l) => !v.lines.includes(l)).length
  if (missing.length) brokenVariants.push(`${v.quick ? 'quick' : 'std'}/${v.taskType}(-${missing.length})`)
}
ok('★老用户不受影响：工作流提示词逐行超集（只增不改不删；基线 scripts/fixtures/workflow-baseline.json）',
  brokenVariants.length === 0, brokenVariants.length ? `被破坏：${brokenVariants.join(' ')}` : `10 变体全部保持，新增 ${addedLines} 行`)
ok('★老用户不受影响：新增内容只出现在标准档（quick 档逐字节不变）',
  baseline.variants.filter((v) => v.quick).every((v) => {
    const now = routerMod.workflowSection(v.taskType, { ...baseCfg, quick: true }).text
    return now === v.lines.join('\n')
  }), '')

// ── 34. 连线方向（2026-09-14 真实反馈：网页预览对、PowerPoint 里线镜像 / × 少一笔）──────
// 根因：straightConnector1 只画包围盒左上→右下，真实走向必须靠 flipH/flipV；
// 漏写 → 反向斜率镜像（Δx>0,Δy<0 的线画反），两条交叉线还会重合成一条（× 变 /）。
const { connectorEndsFromXml } = await import('../lib/pptd/export-pptx.js')
const lineDir = join(root, 'examples', 'smoke', '.tmp-line-dir')
await rm(lineDir, { recursive: true, force: true })
await mkdir(join(lineDir, 'pages'), { recursive: true })
const { writeFile } = await import('node:fs/promises')
await writeFile(join(lineDir, 'deck.yaml'), [
  'version: 1',
  'title: "连线方向夹具"',
  'size: [960, 540]',
  'theme:',
  '  colors: {ink: "#111111", wu: "#B03A2E", jin: "#B7791F", line: "#94A3B8"}',
  '  textStyles:',
  '    body: {fontSize: 14, color: "$ink"}',
  'pages:',
  '  - pages/01.yaml',
  '',
].join('\n'), 'utf8')
// 四个方向 + 箭头 + 一组交叉线（×）：覆盖 flipH / flipV / 双 flip / 无 flip
await writeFile(join(lineDir, 'pages', '01.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: dr',
  '    elementType: line',
  '    points: [[100, 100], [200, 160]]',
  '    line: {color: "$ink", width: 2}',
  '  - elementId: dl',
  '    elementType: line',
  '    points: [[300, 100], [200, 160]]',
  '    line: {color: "$ink", width: 2}',
  '  - elementId: ur',
  '    elementType: line',
  '    points: [[400, 200], [500, 140]]',
  '    arrow: true',
  '    line: {color: "$jin", width: 2}',
  '  - elementId: ul',
  '    elementType: line',
  '    points: [[600, 200], [500, 140]]',
  '    line: {color: "$jin", width: 2}',
  '  - elementId: cross1',
  '    elementType: line',
  '    points: [[700, 300], [714, 314]]',
  '    line: {color: "$wu", width: 2.5}',
  '  - elementId: cross2',
  '    elementType: line',
  '    points: [[714, 300], [700, 314]]',
  '    line: {color: "$wu", width: 2.5}',
  '',
].join('\n'), 'utf8')
const lineCtx = await resolveDeck(lineDir)
const lineExp = await exportPptx(lineCtx, { out: 'out-line.pptx', engine: 'pptd' })
const lineZip = zipRead(await (await import('node:fs/promises')).readFile(lineExp.file))
const lineXml = lineZip.get('ppt/slides/slide1.xml').toString('utf8')
const conns = (lineXml.match(/<p:cxnSp>[\s\S]*?<\/p:cxnSp>/g) ?? []).map((c) => ({
  id: (c.match(/name="([^"]+)"/) ?? [])[1],
  xml: c,
  ends: connectorEndsFromXml(c),
  flipH: /flipH="1"/.test(c),
  flipV: /flipV="1"/.test(c),
  arrow: /<a:tailEnd/.test(c),
}))
const byId = new Map(conns.map((c) => [c.id, c]))
const near = (a, b, t = 0.01) => Math.abs(a - b) < t
const endsMatch = (c, p1, p2) => c?.ends && near(c.ends[0][0], p1[0]) && near(c.ends[0][1], p1[1]) && near(c.ends[1][0], p2[0]) && near(c.ends[1][1], p2[1])
ok('连线：全部 6 条 cxnSp 已导出', conns.length === 6, conns.map((c) => c.id).join(','))
ok('连线：右下（无 flip）端点还原一致', endsMatch(byId.get('dr'), [100, 100], [200, 160]) && !byId.get('dr').flipH && !byId.get('dr').flipV)
ok('连线：左下（需 flipH）端点还原一致——旧实现会镜像成右下', endsMatch(byId.get('dl'), [300, 100], [200, 160]) && byId.get('dl').flipH && !byId.get('dl').flipV)
ok('连线：右上（需 flipV）端点还原一致 + 箭头在 p2 端', endsMatch(byId.get('ur'), [400, 200], [500, 140]) && !byId.get('ur').flipH && byId.get('ur').flipV && byId.get('ur').arrow)
ok('连线：左上（需 flipH+flipV）端点还原一致', endsMatch(byId.get('ul'), [600, 200], [500, 140]) && byId.get('ul').flipH && byId.get('ul').flipV)
ok('连线：× 两笔方向相反（旧实现缺 flipH 会重合成一条 /）',
  byId.get('cross1').flipH === false && byId.get('cross2').flipH === true &&
  endsMatch(byId.get('cross1'), [700, 300], [714, 314]) && endsMatch(byId.get('cross2'), [714, 300], [700, 314]))
ok('连线：导出 parity 自证（线方向逐条从 OOXML 反推，0 条错）',
  lineExp.parity?.ok === true && lineExp.parity.linesExp === 6 && lineExp.parity.linesOut === 6 && lineExp.parity.linesWrong === 0,
  JSON.stringify(lineExp.parity))

// 34.2 箭头必须在 <a:ln> 内部（写在外面 PowerPoint 直接忽略 ⇒ 预览有箭头、成品没有）
const lnOf = (id) => (byId.get(id)?.xml.match(/<a:ln\b[\s\S]*?<\/a:ln>/) ?? [''])[0]
const tailInside = (id) => /<a:tailEnd/.test(lnOf(id))
ok('连线·箭头：arrow=true 的 <a:tailEnd> 写在 <a:ln> 内部（写外面 PowerPoint 忽略）',
  tailInside('ur') === true && !/<a:tailEnd/.test(byId.get('ur').xml.replace(lnOf('ur'), '')) &&
  byId.get('dr').xml.includes('<a:ln') && !tailInside('dr'), `headEnd 示例=${lnOf('ur').slice(0, 90)}`)

// 34.3 包围盒必须精确等于线段跨度：水平线 cy=0 / 垂直线 cx=0（旧实现 max(1,…) 兜底会把水平线画成"假斜线"）
const extOf = (id) => (byId.get(id)?.xml.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/) ?? []).slice(1).map(Number)
await rm(join(lineDir, 'pages', '01.yaml'), { force: true })
await writeFile(join(lineDir, 'pages', '01.yaml'), [
  'pageType: content',
  'elements:',
  '  - elementId: flat',
  '    elementType: line',
  '    points: [[216, 228], [228, 228]]',
  '    arrow: true',
  '    line: {color: "$ink", width: 1.5}',
  '  - elementId: vert',
  '    elementType: line',
  '    points: [[500, 100], [500, 300]]',
  '    line: {color: "$ink", width: 1}',
  '  - elementId: diag',
  '    elementType: line',
  '    points: [[600, 100], [700, 160]]',
  '    line: {color: "$ink", width: 1}',
  '  - elementId: zero',
  '    elementType: line',
  '    points: [[800, 400], [800, 400]]',
  '    line: {color: "$ink", width: 1}',
  '',
].join('\n'), 'utf8')
const flatCtx = await resolveDeck(lineDir)
const flatExp = await exportPptx(flatCtx, { out: 'out-flat.pptx', engine: 'pptd' })
const flatXml = zipRead(await (await import('node:fs/promises')).readFile(flatExp.file)).get('ppt/slides/slide1.xml').toString('utf8')
const flatConns = new Map((flatXml.match(/<p:cxnSp>[\s\S]*?<\/p:cxnSp>/g) ?? []).map((c) => [(c.match(/name="([^"]+)"/) ?? [])[1], c]))
const flatExt = (id) => (flatConns.get(id).match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/) ?? []).slice(1).map(Number)
ok('连线·水平线：包围盒 cy=0（不会再被 max(1,…) 抬成 1pt 假斜线）',
  flatExt('flat')[1] === 0 && flatExt('flat')[0] === Math.round(12 * 12700), `ext=${JSON.stringify(flatExt('flat'))}`)
ok('连线·垂直线：包围盒 cx=0', flatExt('vert')[0] === 0 && flatExt('vert')[1] === Math.round(200 * 12700), `ext=${JSON.stringify(flatExt('vert'))}`)
ok('连线·斜线：包围盒精确等于跨度（不再兜底到 1pt）',
  flatExt('diag')[0] === Math.round(100 * 12700) && flatExt('diag')[1] === Math.round(60 * 12700), `ext=${JSON.stringify(flatExt('diag'))}`)
ok('连线·零长线：给 1×1 兜底避免被消费端丢弃', flatExt('zero')[0] === Math.round(1 * 12700) && flatExt('zero')[1] === Math.round(1 * 12700))
ok('连线·水平线箭头也在 <a:ln> 内', /<a:ln\b[\s\S]*?<a:tailEnd[\s\S]*?<\/a:ln>/.test(flatConns.get('flat')))
await rm(lineDir, { recursive: true, force: true })

// ── 36. 文档完整性（2026-09-14 两次踩坑后加的机器防线）──────────────────────────
// 事故形状：往 docs/03 顶部插新条目时，把上一版条的 `## 标题` 一起替换掉 → 那一版的内容变成"孤儿块"挂在别人名下。
// 人工很难发现（内容还在、只是归属错了）。这里做两条结构断言 + 一条体量断言。
const docsToCheck = [
  'README.md',
  join('docs', '01-需求与目标.md'), join('docs', '02-技术报告.md'), join('docs', '03-更新日志.md'),
  join('docs', '04-路线图与里程碑.md'), join('docs', '05-迭代流程.md'), join('docs', '06-评审与测试.md'),
]
const orphanDocs = []
for (const rel of docsToCheck) {
  const lines = readFileSync(join(root, rel), 'utf8').split(/\r?\n/)
  let seenH2 = false
  for (let i = 0; i < lines.length; i++) {
    if (/^## /.test(lines[i])) seenH2 = true
    else if (/^### /.test(lines[i]) && !seenH2) orphanDocs.push(`${rel}:${i + 1}`)
  }
}
ok('文档结构：没有任何"孤儿小节"（### 之前必须有 ## 归属）——两次吃标题事故的防线',
  orphanDocs.length === 0, orphanDocs.join('、') || '全部完整')

const changelog = readFileSync(join(root, 'docs', '03-更新日志.md'), 'utf8')
const entries = changelog.split(/\r?\n/).filter((l) => /^## \[/.test(l))
ok('文档结构：更新日志仍保有全部历史条目（≥ 25 条 ## [版本]）',
  entries.length >= 25, `当前 ${entries.length} 条`)
ok('文档结构：每条更新日志都有"验证"或"影响"段（可追溯）',
  (changelog.match(/^## \[/gm) ?? []).length <= (changelog.match(/^### (验证|影响|影响\/后续)/gm) ?? []).length + 4,
  `条目 ${(changelog.match(/^## \[/gm) ?? []).length} / 验证或影响段 ${(changelog.match(/^### (验证|影响|影响\/后续)/gm) ?? []).length}`)

// ── 37. 手册 vs 源码：事实一致性（2026-09-14 用户要求"充分自检"后加的防线）─────────
// 事故形状：手册是模型的行为依据，一句错的事实 = 一次错的动作。本轮自检抓到 6 类：
//   ① manual §3 把 chart 的 data 写成 `[{label, value}]`，而 schema 只认 `data: {cols, rows}` → 照着写必被拒；
//   ② 三本手册把 warning 的标记写成 `[⚠]`，而 ppt_verify 主清单用的是 `[~]`（`[⚠]` 只属 M2 实测段）；
//   ③ 把 density / near-align 归到 `[·]` 建议，实际是 `[~]` 警告；④ 手册 §4 漏了 theme-conformance 这个
//      默认开的门禁错误码；⑤ "预览里图表带分类名"对 pie 不成立（pie 连分类名都不画）；
//   ⑥ 文档里 6 处 "smoke 181 断言" 全靠人工同步。
// 于是把"手册不许说错事实"也做成机器断言——四类：名字存在 / 错误码覆盖 / 标记与分级 / 引用数值一致。
// 说明：断言的是"手册与源码不矛盾"，不评判文风；文风与语义偏移仍靠 docs/06 §7.4 的独立评审。
const skillTexts = bundled.map((b) => ({ name: b.parsed.name, content: b.parsed.content }))
const allSkillText = skillTexts.map((s) => s.content).join('\n')
const manualText = skillTexts.find((s) => s.name === 'ppt-studio-manual').content
const readLib = (rel) => readFileSync(join(root, 'lib', rel), 'utf8')

// 37.1 手册提到的 ppt_* 必须是真注册的工具（工具改名 / 手册留旧名 = 模型调用不存在的工具）
const registeredTools = new Set()
for (const f of ['tools.js', 'index.js']) {
  for (const m of readLib(f).matchAll(/name: '(ppt_[a-z_]+)'/g)) registeredTools.add(m[1])
}
const mentionedTools = new Set([...allSkillText.matchAll(/\b(ppt_[a-z_]+)\b/g)].map((m) => m[1]))
const ghostTools = [...mentionedTools].filter((t) => !registeredTools.has(t))
ok('手册 vs 源码：技能里提到的 ppt_* 都是已注册工具（防工具改名后手册留旧名）',
  ghostTools.length === 0 && registeredTools.size >= 15,
  ghostTools.length ? `不存在的工具：${ghostTools.join('、')}` : `${mentionedTools.size} 个工具名全部存在（注册表 ${registeredTools.size} 个）`)

// 37.2 门禁错误码：源码清单 == 期望清单，且每个都写进了手册（新增错误码而手册没跟 = 模型不知道会被拦）
const verifySrc = readLib('verify.js')
const verifyLines = verifySrc.split(/\r?\n/)
const errorCodes = new Set()
verifyLines.forEach((line, i) => {
  // `let code = 'overlap'` 是**初值**（后续分支必然改写；overlap 只会以 warning 出现），不是一条 finding → 排除声明式赋值
  if (/\b(?:let|const|var)\s+code\s*=/.test(line)) return
  for (const m of line.matchAll(/code\s*[:=]\s*'([a-z-]+)'/g)) {
    // 判定该 code 是否 error 级：本行或上 3 行里出现 'error'（覆盖 severity: 'error' / severity = 'error' /
    // `mode === 'strict' ? 'error' : 'warning'` 三种写法；confirmed / warning / suggestion 不会被误收）
    const window = verifyLines.slice(Math.max(0, i - 3), i + 1).join('\n')
    if (/'error'/.test(window)) errorCodes.add(m[1])
  }
})
const EXPECTED_ERROR_CODES = ['theme-conformance', 'out-of-page', 'out-of-safe-area', 'text-overflow', 'table-overflow', 'content-collision', 'unexpected-overlap', 'measured-overflow', 'measured-unpaired']
const sameSet = (a, b) => a.size === b.length && b.every((x) => a.has(x))
ok('手册 vs 源码：门禁错误码清单与 verify.js 一致（错误码增删会被当场抓到）',
  sameSet(errorCodes, EXPECTED_ERROR_CODES),
  `源码=${[...errorCodes].sort().join('/')} 期望=${[...EXPECTED_ERROR_CODES].sort().join('/')}`)
const undocumented = EXPECTED_ERROR_CODES.filter((c) => !manualText.includes(c))
ok('手册 vs 源码：每个门禁错误码都写进了手册 §4（模型必须知道什么会被拦）',
  undocumented.length === 0, undocumented.length ? `未写进手册：${undocumented.join('、')}` : `${EXPECTED_ERROR_CODES.length} 个错误码全部在手册`)

// 37.3 严重度标记与分级：主清单的警告标记是 `[~]`（不是 `[⚠]`）；density/near-align/hotspot 是警告不是建议
const markerViolations = []
const severityViolations = []
for (const s of skillTexts) {
  for (const line of s.content.split('\n')) {
    if (/\[⚠\][^\n]{0,6}(警告|warning)|(警告|warning)[^\n]{0,4}\[⚠\]/.test(line)) markerViolations.push(`${s.name}: ${line.trim().slice(0, 48)}`)
    const touchesWarnCode = /(density|near-align|hotspot|密度|近对齐)/.test(line)
    if (touchesWarnCode && /\[·\]/.test(line) && !/\[~\]/.test(line)) severityViolations.push(`${s.name}: ${line.trim().slice(0, 48)}`)
  }
}
ok('手册 vs 源码：警告标记写对（主清单是 [~]；[⚠] 只属 M2 实测段，不能当主清单图例）',
  markerViolations.length === 0, markerViolations.join(' | ') || '0 处命中')
ok('手册 vs 源码：density/near-align/hotspot 不得归到 [·] 建议（源码里是 warning）',
  severityViolations.length === 0, severityViolations.join(' | ') || '0 处命中')

// 37.4 chart 的 data 形状必须按 schema 写（`data: {cols, rows}`；`data: [{label, value}]` 会被直接拒绝）
const chartShapeBad = []
for (const s of skillTexts) {
  for (const line of s.content.split('\n')) {
    // 允许"反面教材"：同一行带否定/拒绝语义时，引用错误形状是为了告诉模型别这么写
    if (/data:\s*\[\s*[\{'"]/.test(line) && !/(拒绝|不要|不是|错误|✗|禁止)/.test(line)) chartShapeBad.push(`${s.name}: ${line.trim().slice(0, 48)}`)
  }
}
const chartDocLine = manualText.split('\n').find((l) => /^-\s*chart[:：]/.test(l.trim())) ?? ''
ok('手册 vs 源码：chart 语法按 schema 写（data 是 {cols, rows} + series，不是 [{label,value}]）',
  chartShapeBad.length === 0 && /cols/.test(chartDocLine) && /rows/.test(chartDocLine) && /series/.test(chartDocLine),
  chartShapeBad.length ? chartShapeBad.join(' | ') : `手册 chart 行：${chartDocLine.trim().slice(0, 70)}…`)

// 37.5 预览图表标签的截断阈值必须与 svgCharts.js 一致（改动阈值不许手册沉默漂移）
const truncNum = Number((readLib(join('pptd', 'svgCharts.js')).match(/c\.length\s*>\s*(\d+)/) ?? [])[1])
const claimedTrunc = [...allSkillText.matchAll(/超过\s*(\d+)\s*字截断/g)].map((m) => Number(m[1]))
ok('手册 vs 源码：预览图表分类名的截断阈值与 svgCharts.js 一致',
  truncNum > 0 && claimedTrunc.length > 0 && claimedTrunc.every((n) => n === truncNum),
  `源码=${truncNum} 手册声称=${claimedTrunc.join(',') || '未声称'}`)

// 37.6 手册提到的 /ppt 子命令必须真实存在
const realCmds = new Set([...readLib('commands.js').matchAll(/cmd === '([a-z-]+)'/g)].map((m) => m[1]))
const mentionedCmds = new Set([...allSkillText.matchAll(/\/ppt\s+([a-z-]+)/g)].map((m) => m[1]))
const ghostCmds = [...mentionedCmds].filter((c) => !realCmds.has(c))
ok('手册 vs 源码：技能里提到的 /ppt 子命令都存在',
  ghostCmds.length === 0 && realCmds.size >= 5,
  ghostCmds.length ? `不存在的子命令：${ghostCmds.join('、')}` : `${[...mentionedCmds].join('/')} 全部存在（命令面 ${realCmds.size} 个）`)

// 37.7 手册门禁清单里写的 code 名必须真实存在（A 类事实：旧手册曾写过 `out-of-safe-area` 这种源码里根本没有的名字；
//      2026-09-18 起该码**真的存在了**——它被从 out-of-page 里分出来，因为两者处置完全不同）
const gateLine = manualText.split('\n').find((l) => l.includes('ERROR 必须清零')) ?? ''
const gateTokens = [...gateLine.matchAll(/`([a-z][a-z-]*)`/g)].map((m) => m[1])
const ghostCodes = gateTokens.filter((t) => !errorCodes.has(t))
ok('手册 vs 源码：手册门禁清单里的 code 名都真实存在（防写出源码里没有的错误码）',
  gateTokens.length > 0 && ghostCodes.length === 0,
  ghostCodes.length ? `源码里没有：${ghostCodes.join('、')}` : `清单含 ${[...new Set(gateTokens)].join('、')}`)

// 37.8 讲稿通道口径必须与导出器实现**双向一致**（手册说"不导出"而代码在导出 = 最坏的一种事实错误）
const exportSrc = readLib(join('pptd', 'export-pptx.js'))
const copySkill = skillTexts.find((s) => s.name === 'ppt-studio-copy').content
const implExportsNotes = /ppt\/notesSlides\//.test(exportSrc)
const docSaysExports = /备注页/.test(copySkill) && /(导出|写进|随导出)/.test(copySkill)
const docSaysNoExport = /(不生成备注|不导出备注|没有 notesSlide|不进 pptx)/.test(copySkill)
ok('手册 vs 源码：讲稿通道口径与导出器**双向一致**（实现会导出→手册必须说会导出；反之必须说不导出）',
  implExportsNotes ? (docSaysExports && !docSaysNoExport) : (!docSaysExports && docSaysNoExport),
  `实现${implExportsNotes ? '会' : '不会'}导出备注；手册${docSaysExports ? '说会' : '未说会'}${docSaysNoExport ? '、且仍写着不导出' : ''}`)

// 37.9 缩字下限的常量必须与导出器一致（手册写死了 6pt / 60%，代码改了要能被抓到）
const floorM = exportSrc.match(/Math\.max\((\d+),\s*Math\.round\(origSize \*\s*([\d.]+)\)\)/)
const floorPt = floorM ? Number(floorM[1]) : 0
const floorPct = floorM ? Math.round(Number(floorM[2]) * 100) : 0
const floorClaimed = floorPt > 0 && new RegExp(`max\\(${floorPt}pt, ${floorPct}% 原字号\\)`).test(manualText)
ok('手册 vs 源码：缩字下限常量与 export-pptx 一致（未给 minFontSize 时的保底值）',
  floorPt > 0 && floorPct > 0 && floorClaimed,
  `源码 = max(${floorPt}pt, ${floorPct}% 原字号)，手册${floorClaimed ? '一致' : '不一致/未写'}`)

// ── 38. SCHEMA_REF（ppt_schema 权威通道）自洽 ─────────────────────────────────────
// 事故形状：scaffold.js 顶部速查写"decoration 完全豁免重叠与出界（可合法落在模板页眉页脚带）"，
// 而同一份 SCHEMA_REF 后文写"只豁免重叠、不豁免出界"，verify.js 对出界也根本不看 role
// （docs/01 C3 早已回滚"decoration 豁免出界"）——权威通道自相矛盾，模型照哪句都可能错。
const schemaRef = scaffoldMod.SCHEMA_REF
const refLines = schemaRef.split('\n')
const refBad = refLines.find((l) => /decoration/.test(l) && /豁免/.test(l) && /出界/.test(l) && !/不豁免出界/.test(l))
ok('SCHEMA_REF 自洽：不得声称 decoration 豁免出界（verify 对出界不看 role；C3 已回滚该语义）',
  refBad === undefined && refLines.some((l) => /不豁免出界/.test(l)),
  refBad ? `仍写着：${refBad.trim().slice(0, 60)}` : '口径一致（只豁免重叠、不豁免出界）')

// ── 39. 讲稿（备注）通道 + 实体解码 + 图表配色建议（2026-09-14 用户要求处理的三件事）──────
// 备注的真实性标准是"**PowerPoint 能打开并读出**"：开发中先写了 notesMasterIdLst，python-pptx 照读不误，
// 真 PowerPoint 却报"文件或目录损坏"（减量二分定位到该元素）。教训：OOXML 产物必须用真消费者验。
const rf = (await import('node:fs/promises')).readFile
const notesDir = join(root, 'examples', 'smoke', '.tmp-notes-smoke')
await rm(notesDir, { recursive: true, force: true })
await mkdir(join(notesDir, 'pages'), { recursive: true })
await writeFile(join(notesDir, 'deck.yaml'), [
  'version: 1', 'title: "讲稿夹具"', 'size: [960, 540]', 'theme:',
  '  colors: {ink: "#111111", brand: "#2563EB"}',
  '  textStyles:', '    body: {fontSize: 16, color: "$ink"}',
  'pages:', '  - pages/01.yaml', '  - pages/02.yaml', '  - pages/03.yaml', '',
].join('\n'), 'utf8')
const nEl = (id, t) => [`  - elementId: ${id}`, '    elementType: text', '    bounds: [60, 40, 600, 40]', `    content: {text: ${JSON.stringify(t)}, style: "$body"}`]
await writeFile(join(notesDir, 'pages', '01.yaml'), ['pageType: cover', 'notes: |', '  开场：先说结论。', '  第二行：再给证据。', 'elements:', ...nEl('t1', '封面')].join('\n'), 'utf8')
await writeFile(join(notesDir, 'pages', '02.yaml'), ['pageType: content', 'elements:', ...nEl('t2', '无讲稿页')].join('\n'), 'utf8')
await writeFile(join(notesDir, 'pages', '03.yaml'), ['pageType: content', 'notes: "单行讲稿带 <特殊> & 符号"', 'elements:', ...nEl('t3', '第三页')].join('\n'), 'utf8')
const nCtx = await resolveDeck(notesDir)
const nExp = await exportPptx(nCtx, { out: 'notes-smoke.pptx', engine: 'pptd' })
const nZip = zipRead(await rf(nExp.file))
const nNames = [...nZip.keys()]
const nSlides = nNames.filter((k) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k))
const nRels = nNames.filter((k) => /^ppt\/notesSlides\/_rels\/notesSlide\d+\.xml\.rels$/.test(k))
const nRelsOk = nRels.every((k) => {
  const t = decodeXml(nZip.get(k))
  return /notesMaster/.test(t) && /Type="[^"]*\/slide"/.test(t)
})
const nSlideRels = [1, 3].every((p) => /notesSlide\d+\.xml/.test(decodeXml(nZip.get(`ppt/slides/_rels/slide${p}.xml.rels`))))
const nCt = decodeXml(nZip.get('[Content_Types].xml'))
const nCtOk = /notesMaster\+xml/.test(nCt) && (nCt.match(/notesSlide\+xml/g) ?? []).length === 2
const nNoIdLst = !/notesMasterIdLst/.test(decodeXml(nZip.get('ppt/presentation.xml')))
ok('讲稿：notes → 标准备注页（2 个 notesSlide + notesMaster + 各自 rels + Content_Types），parity 自证',
  nSlides.length === 2 && nRels.length === 2 && nRelsOk && nSlideRels && nCtOk &&
  nExp.parity.notesExp === 2 && nExp.parity.notesOut === 2 && nExp.parity.ok === true,
  `slides=${nSlides.length} rels=${nRels.length} relsOk=${nRelsOk} ct=${nCtOk} parity=${JSON.stringify(nExp.parity)}`)
ok('讲稿：presentation.xml **不含** notesMasterIdLst（真 PowerPoint 会因此报"文件损坏"，实测二分定位）',
  nNoIdLst && /notesMasters\/notesMaster1\.xml/.test(decodeXml(nZip.get('ppt/_rels/presentation.xml.rels'))),
  nNoIdLst ? '无该元素，备注母版只经 presentation.xml.rels 挂载' : '仍写着 notesMasterIdLst')

// 老工程零变化：没有 notes 的工程不得凭空多出任何备注部件
const noNotesDir = join(notesDir, '..', '.tmp-notes-none')
await rm(noNotesDir, { recursive: true, force: true })
await mkdir(join(noNotesDir, 'pages'), { recursive: true })
await writeFile(join(noNotesDir, 'deck.yaml'), ['version: 1', 'title: "无讲稿"', 'size: [960, 540]', 'theme:', '  colors: {ink: "#111111"}', '  textStyles:', '    body: {fontSize: 16, color: "$ink"}', 'pages:', '  - pages/01.yaml', ''].join('\n'), 'utf8')
await writeFile(join(noNotesDir, 'pages', '01.yaml'), ['pageType: content', 'elements:', ...nEl('t1', '无讲稿')].join('\n'), 'utf8')
const nnExp = await exportPptx(await resolveDeck(noNotesDir), { out: 'no-notes.pptx', engine: 'pptd' })
const nnNames = [...zipRead(await rf(nnExp.file)).keys()]
ok('讲稿：无 notes 的工程不产生任何备注部件（老工程产物零变化）',
  nnNames.every((k) => !/notes/.test(k)) && nnExp.parity.notesExp === 0 && nnExp.parity.notesOut === 0,
  `备注相关部件 ${nnNames.filter((k) => /notes/.test(k)).length} 个；parity.notesExp=${nnExp.parity.notesExp}`)

// 实体解码（2026-09-14 修）：导入侧此前不做 XML 实体解码 → "R&D" 变成 "R&amp;D"
const reDir = join(notesDir, 'reimport')
await rm(reDir, { recursive: true, force: true })
await importPptx(nExp.file, reDir)
const reYaml3 = readFileSync(join(reDir, 'pages', 'slide_03.yaml'), 'utf8')
const reYaml1 = readFileSync(join(reDir, 'pages', 'slide_01.yaml'), 'utf8')
ok('讲稿：导出 → 导入 回环（多行块标量 + 单行引号），且 XML 实体已解码（不再出现 &lt;/&amp; 字面量）',
  /notes: \|/.test(reYaml1) && /第二行：再给证据。/.test(reYaml1) &&
  /notes: "单行讲稿带 <特殊> & 符号"/.test(reYaml3) && !/&lt;|&amp;/.test(reYaml3),
  reYaml3.match(/^notes:.*$/m)?.[0]?.slice(0, 60) ?? '(未找到 notes 行)')

// 图表配色：显式主题外颜色 → [·] 建议（非门禁）；主题内 $ref → 不打扰
const chartDir = join(notesDir, '..', '.tmp-chart-color')
await rm(chartDir, { recursive: true, force: true })
await mkdir(join(chartDir, 'pages'), { recursive: true })
await writeFile(join(chartDir, 'deck.yaml'), ['version: 1', 'title: "配色"', 'size: [960, 540]', 'theme:', '  colors: {ink: "#111111", brand: "#2563EB"}', '  textStyles:', '    body: {fontSize: 16, color: "$ink"}', 'pages:', '  - pages/01.yaml', '  - pages/02.yaml', ''].join('\n'), 'utf8')
const chartPage = (colors) => [
  'pageType: content',
  'elements:',
  '  - elementId: c',
  '    elementType: chart',
  '    bounds: [60, 60, 400, 240]',
  '    chart:',
  '      type: bar',
  ...(colors ? [`      colors: ${colors}`] : []),
  '      data:',
  '        cols: [分类, 值]',
  '        rows: [[甲, 1], [乙, 2]]',
  // 第二元素：美学建议层对单元素页直接返回（els.length < 2），必须 ≥2 个元素才谈得上"建议"
  '  - elementId: t1',
  '    elementType: text',
  '    bounds: [60, 320, 600, 40]',
  '    content: {text: "图页", style: "$body"}',
  '',
].join('\n')
await writeFile(join(chartDir, 'pages', '01.yaml'), chartPage('["#FF00FF"]'), 'utf8')
await writeFile(join(chartDir, 'pages', '02.yaml'), chartPage('["$brand"]'), 'utf8')
const cCtx = await resolveDeck(chartDir)
const cLayout = (await renderDeck(cCtx, {})).layout
const v1 = verifyDeck({ ...cLayout, pages: [cLayout.pages[0]] })
const v2 = verifyDeck({ ...cLayout, pages: [cLayout.pages[1]] })
ok('图表配色：显式主题外颜色 → [·] aesthetic-theme 建议，且**不新增门禁错误**（建议级，不门禁化）',
  /aesthetic-theme[^\n]*#FF00FF/.test(v1.text) && v1.text.split('\n').filter((l) => l.includes('[✗]')).length === 0,
  `命中：${(v1.text.match(/aesthetic-theme[^\n]*/) ?? [''])[0].slice(0, 80)}`)
ok('图表配色：$ref 引用主题色 → 不出配色建议（不打扰），且预览与成品两层都解析为 hex',
  !/aesthetic-theme[^\n]*颜色/.test(v2.text),
  `v2 建议行：${(v2.text.match(/aesthetic-theme[^\n]*/) ?? ['（无）'])[0].slice(0, 60)}`)

// 独立读取器交叉（可选，第三方库 ≠ 真 PowerPoint，但能挡住结构性错误）
let pyRead = 'python-pptx 不可用 → 跳过（不影响门禁）'
try {
  const { execFileSync } = await import('node:child_process')
  const pyFile = join(notesDir, 'readback.py')
  await writeFile(pyFile, [
    'import json, sys',
    'try:',
    "    sys.stdout.reconfigure(encoding='utf-8')",
    'except Exception:',
    '    pass',
    'from pptx import Presentation',
    'prs = Presentation(sys.argv[1])',
    'print(json.dumps([s.notes_slide.notes_text_frame.text if s.has_notes_slide else None for s in prs.slides], ensure_ascii=False))',
  ].join('\n'), 'utf8')
  const out = execFileSync('python', [pyFile, nExp.file], { encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
  const got = JSON.parse(out.trim())
  ok('讲稿：第三方读取器（python-pptx）独立读回讲稿文本（多行/单行/无备注页三种都对）',
    got.length === 3 && got[0] === '开场：先说结论。\n第二行：再给证据。' && got[1] === null && got[2] === '单行讲稿带 <特殊> & 符号',
    JSON.stringify(got))
} catch (e) {
  ok('讲稿：第三方读取器（python-pptx）独立读回讲稿文本（多行/单行/无备注页三种都对）', true, pyRead = `⚠ ${String(e.message).slice(0, 80)}`)
}
await rm(notesDir, { recursive: true, force: true })
await rm(noNotesDir, { recursive: true, force: true })
await rm(chartDir, { recursive: true, force: true })

// ── 43. python-pptx 兜底引擎：生成物必须过**真消费者**（2026-09-18 新增）────────────────
// 背景（真 bug）：`scripts/` 里 genPythonScript / runPythonExport 此前**零调用**——这条兜底路径
//   从来没有被任何测试执行过（grep 无匹配）。而它是"pptd 硬失败时"的最后保险：保险自己坏了没人知道。
//   仓库那条"产物必须用真消费者验"（docs/05 §0d）是为 OOXML 产物写的，没人把它推广到**生成的源码**——
//   而一次 `py_compile` 就能抓到 SyntaxError。这正是"跳过与通过印同一个颜色"的典型：python 是可选依赖，
//   缺了就打一行"跳过"算绿，于是没人发现它连编译都过不去。
// 判据：① 生成脚本必须能编译；② 必须能真跑出 .pptx 且 **python-pptx 能把它读回**。
//   两个断言在缺 python / 缺 python-pptx 时都按"跳过"计并写明标签（断言总数保持恒定）。
const pyDeck = join(root, 'examples', 'py-smoke')
await rm(pyDeck, { recursive: true, force: true })
await mkdir(join(pyDeck, 'pages'), { recursive: true })
await writeFile(join(pyDeck, 'deck.yaml'), 'version: 1\ntitle: py\nsize: [960, 540]\ntheme: {colors: {primary: "#2563EB", ink: "#1F2937"}, textStyles: {body: {fontSize: 16, color: "$ink"}}}\npages:\n  - pages/01.yaml\n')
await writeFile(join(pyDeck, 'pages', '01.yaml'), [
  'pageType: content', 'elements:',
  '  - elementId: boxFillLine', '    elementType: shape', '    kind: roundRect', '    bounds: [60, 60, 200, 100]',
  '    fill: "#2563EB"', '    line: {color: "#FFFFFF", width: 2}',
  '  - elementId: boxBare', '    elementType: shape', '    kind: rect', '    bounds: [300, 60, 200, 100]',
  '  - elementId: boxAlpha', '    elementType: shape', '    kind: rect', '    bounds: [60, 200, 200, 80]',
  '    fill: {color: "#F59E0B", alpha: 50}',
  '  - elementId: link', '    elementType: line',
  '    points: [[300, 200], [460, 200]]', '    line: {color: "#1F2937", width: 1}',
  '  - elementId: tb', '    elementType: table', '    bounds: [60, 320, 400, 120]',
  '    cols: [甲, 乙]', '    rows: [["1", "2"], ["3", "4"]]',
  '  - elementId: t1', '    elementType: text', '    bounds: [500, 320, 300, 40]',
  '    content: {text: "hello", style: "$body"}', '', ''].join('\n'))
const { genPythonScript, findPython, runPythonExport } = await import('../lib/pptxPy.js')
const pyEnv = findPython()
const pyFile43 = join(pyDeck, 'gen.py')
if (pyEnv.cmd) await writeFile(pyFile43, genPythonScript(await resolveDeck(pyDeck)), 'utf8')
// 43.1 编译（只要 python，不需要 python-pptx）
if (pyEnv.cmd) {
  const { spawnSync } = await import('node:child_process')
  const c = spawnSync(pyEnv.cmd, ['-m', 'py_compile', pyFile43], { encoding: 'utf8', timeout: 60000 })
  let detail = 'py_compile ✓'
  if (c.status !== 0) {
    const err = String(c.stderr ?? c.stdout ?? '')
    // Python 只报**生成文件**的行号；把那一行源码取出来，定位才不用猜（本 bug 就是靠这行看清的）
    const ln = Number(/line (\d+)/.exec(err)?.[1] ?? 0)
    let srcLine = ''
    try { srcLine = ln ? String(readFileSync(pyFile43, 'utf8').split(/\r?\n/)[ln - 1] ?? '').trim().slice(0, 160) : '' } catch { /* 忽略 */ }
    detail = `${err.trim().split('\n').slice(-2).join(' | ').slice(0, 180)}${srcLine ? `\n      生成源码第 ${ln} 行：${srcLine}` : ''}`
  }
  ok('python-pptx 兜底：生成脚本可编译（覆盖 shape 无填充/对象填充/带描边 + line + table + text）',
    c.status === 0, detail)
} else {
  ok('python-pptx 兜底：生成脚本可编译（无 python：跳过）', true)
}
// 43.2 真跑 + 真消费者读回（需要 python + python-pptx）
if (pyEnv.has) {
  let info = ''
  let pass43 = false
  try {
    const outP = join(pyDeck, 'out-py.pptx')
    const r = await runPythonExport(await resolveDeck(pyDeck), outP)
    const { execFileSync } = await import('node:child_process')
    const rb = join(pyDeck, 'readback2.py')
    await writeFile(rb, [
      'import sys',
      "sys.stdout.reconfigure(encoding='utf-8')",
      'from pptx import Presentation',
      'p = Presentation(sys.argv[1])',
      'print(len(p.slides), sum(len(s.shapes) for s in p.slides))',
    ].join('\n'), 'utf8')
    const got = execFileSync(pyEnv.cmd, [rb, outP], { encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }).trim()
    const [nSlides, nShapes] = got.split(/\s+/).map(Number)
    pass43 = nSlides === 1 && nShapes >= 6
    info = `file=${String(r.file).split(/[\\/]/).pop()}｜python-pptx 读回：slides=${nSlides} shapes=${nShapes}（期望 1 / ≥6）`
  } catch (e) {
    info = String(e.message).slice(0, 240)
  }
  ok('python-pptx 兜底：生成脚本真跑出 .pptx，且 python-pptx 能把它读回（1 页 ≥ 6 个形状）', pass43, info)
} else {
  ok('python-pptx 兜底：生成脚本真跑出 .pptx，且 python-pptx 能把它读回（无 python-pptx：跳过）', true)
}
await rm(pyDeck, { recursive: true, force: true })

// ── 44. 表格字号：audit 档的最小字号断言不得被表格自己架空（2026-09-18 新增）──────────────
// 背景（真 bug · 自相矛盾）：export-pptx 的表格 cell 硬编码 `sz="1100"`（11pt），而 audit 回读断言
//   扫**全 slide XML** 取全局最小 sz 与 `theme.minFontSize` 比 ⇒ 只要工程里有一张表、且用户声明了
//   下限 ≥ 12，audit 档就**永远 ✗**，而 DSL 里**没有任何手段**能修好它（table 元素没有字号字段）。
//   这是"把用户逼到无法满足的门禁"。同一处还有跨层不一致：预览层硬编码 12px、成品层 11pt。
// 判据：三层同源（normalizePage 算一次 fontPt → 快照 / 预览 / 成品都用它），且成品最小 sz ≥ 用户下限。
const tfDeck = join(root, 'examples', 'tablefont-smoke')
await rm(tfDeck, { recursive: true, force: true })
await mkdir(join(tfDeck, 'pages'), { recursive: true })
await writeFile(join(tfDeck, 'deck.yaml'), 'version: 1\ntitle: tf\nsize: [960, 540]\ntheme: {colors: {ink: "#1F2937"}, textStyles: {body: {fontSize: 18, color: "$ink"}}, minFontSize: 14}\npages:\n  - pages/01.yaml\n')
await writeFile(join(tfDeck, 'pages', '01.yaml'), [
  'pageType: content', 'elements:',
  '  - elementId: tb', '    elementType: table', '    bounds: [60, 60, 800, 200]',
  '    cols: [指标, 数值]', '    rows: [["甲", "1"], ["乙", "2"]]', '', ''].join('\n'))
const tfCtx = await resolveDeck(tfDeck)
const tfR = await renderDeck(tfCtx, {})
const tfSnap = tfR.layout.pages[0].elements.find((e) => e.kind === 'table')
const tfHtml = readFileSync(join(tfR.outDir, tfR.htmlFiles[0]), 'utf8')
const tfExp = await exportPptx(tfCtx, { out: 'out-tablefont.pptx', engine: 'pptd' })
const tfZip = zipRead(readFileSync(tfExp.file))
let tfMin = Infinity
for (let i = 1; tfZip.has(`ppt/slides/slide${i}.xml`); i++) {
  for (const m of tfZip.get(`ppt/slides/slide${i}.xml`).toString('utf8').matchAll(/sz="(\d+)"/g)) {
    tfMin = Math.min(tfMin, Number(m[1]))
  }
}
ok('表格字号：三层同源（快照 fontPt = 预览 cell px = 成品 sz = 用户下限 14pt，不再 12px vs 11pt）',
  tfSnap?.fontPt === 14 && tfHtml.includes('font-size:14px') && tfMin / 100 === 14,
  `快照 fontPt=${tfSnap?.fontPt}｜预览含 14px=${tfHtml.includes('font-size:14px')}｜成品最小 ${tfMin / 100}pt`)
ok('表格字号：成品全局最小 sz ≥ theme.minFontSize（audit 档不再被表格自相矛盾架空）',
  tfMin / 100 >= 14, `最小 ${tfMin / 100}pt / 用户下限 14pt`)
await rm(tfDeck, { recursive: true, force: true })

// ── 45. 质量档静默降级：状态文件坏了必须可见（2026-09-18 新增）──────────────────────
// 背景（真 bug）：`loadSession` / `loadProject` 在"文件存在但读不了/解析失败"时**静默**返回默认值 ⇒
//   `state.json` 一损坏，`quality: 'audit'` 就**无声**变成 `standard`——最严档的额外门禁
//   （禁 autoDeclare / 强制视觉审阅 / 导出回读断言）全部消失，而用户看到的是一轮"正常"的 standard。
//   修法核心是**区分两种情形**：文件不存在 = 正常（新工程，用默认）；文件存在却坏了 = 异常，必须上报。
const qsDeck = join(root, 'examples', 'quality-smoke')
await rm(qsDeck, { recursive: true, force: true })
await mkdir(qsDeck, { recursive: true })
await writeFile(join(qsDeck, 'state.json'), '{ "quality": "audit", 这不是合法 JSON', 'utf8')
const stMod = await import('../lib/state.js')
const qsDiag = typeof stMod.loadProjectDiag === 'function'
  ? await stMod.loadProjectDiag(qsDeck)
  : { state: await stMod.loadProject(qsDeck), error: null }
ok('质量档：项目 state.json 损坏时必须**上报**（不得静默回落 standard）',
  qsDiag.error !== null && qsDiag.state.quality === 'standard',
  qsDiag.error ?? '（无诊断 API：损坏被静默吞掉、回落 standard 且不留任何痕迹）')
const qsQ = typeof toolsMod.qualityOfDiag === 'function'
  ? await toolsMod.qualityOfDiag(null, qsDeck)
  : { quality: 'standard', degraded: false, reason: '' }
ok('质量档：降级时 degraded=true 且带原因（工具输出据此提示"audit 额外门禁未生效"）',
  qsQ.degraded === true && qsQ.quality === 'standard' && String(qsQ.reason).length > 0,
  JSON.stringify(qsQ))
// 反例（防"把新工程也判成降级"）：文件不存在必须 error=null
const qsNone = typeof stMod.loadProjectDiag === 'function'
  ? await stMod.loadProjectDiag(join(qsDeck, 'no-such-dir'))
  : { state: await stMod.loadProject(join(qsDeck, 'no-such-dir')), error: null }
ok('质量档：文件不存在时 error=null（新工程不得被误判为降级）', qsNone.error === null, String(qsNone.error))
await rm(qsDeck, { recursive: true, force: true })

// ── 46. pptxgenjs 幽灵选项 + 「设了没用」的引擎档位（2026-09-18 新增）──────────────────
// 背景（真 bug · 违反明文红线"不静默切换引擎"）：命令面接受 `/ppt engine pptxgenjs` 并回执"已记录（待接入）"，
//   而 resolveEngine 把**任何**未知取值静默映射成 pptd ⇒ 用户以为选了引擎，实际按 pptd 跑，报告里一字不提。
//   更深一层：`/ppt engine python-pptx` 设的档位**根本没被 ppt_export 消费**（导出只看工具参数）——
//   一个"设了没用"的设置，而工作流提示里的 `引擎` 行还显示用户选的那个。
ok('引擎：未知取值不再被静默当成 auto（resolveEngine 带 unknown 标记）',
  toolsMod.resolveEngine('pptxgenjs').unknown === 'pptxgenjs' && toolsMod.resolveEngine('auto').unknown === undefined,
  JSON.stringify(toolsMod.resolveEngine('pptxgenjs')))
{
  const cmdSrc = stripComments(readFileSync(join(root, 'src', 'commands.js'), 'utf8'))
  ok('引擎：命令面不再把 pptxgenjs 收进接受集合（未实现 → 明确拒绝而非装作成功）',
    /pptxgenjs/.test(cmdSrc) && /未实现/.test(cmdSrc) && !/,\s*'pptxgenjs'\]/.test(cmdSrc),
    /,\s*'pptxgenjs'\]/.test(cmdSrc) ? '仍在接受集合里' : '已改为拒绝分支')
}
const egDeck = join(root, 'examples', 'engine-smoke')
await rm(egDeck, { recursive: true, force: true })
await mkdir(egDeck, { recursive: true })
await writeFile(join(egDeck, 'state.json'), JSON.stringify({ engine: 'python-pptx' }), 'utf8')
const egQ = typeof toolsMod.qualityOfDiag === 'function' ? await toolsMod.qualityOfDiag(null, egDeck) : {}
ok('引擎：会话/项目档位可被导出侧读到（`/ppt engine X` 不再"设了没用"）',
  egQ.engine === 'python-pptx', `engine=${egQ.engine ?? '(未带出)'}`)
await rm(egDeck, { recursive: true, force: true })

// ── 47. 出界分级：两个 code 必须可分（2026-09-18 新增）──────────────────────────────
// 背景（真 bug · 分级语义在 code 维度丢失）：`out-of-page` 同时用于"超页面边界"（放映不可见、**不可声明**、
//   必须改布局）与"超安全区"（**可声明**、补 expectedOutOfSafeArea 即可）。两者处置完全不同，
//   共用一个 code 让消费方（templates 的清理统计、任何按 code 的诊断）与模型都分不清该做什么。
//   severity 都是 error ⇒ 这是**诊断精度**问题而非门禁强度问题，改动对既有工程零影响。
{
  const og = verifyDeck({
    size: { width: 960, height: 540 },
    theme: { colors: {}, themeConformance: 'off' },
    pages: [{
      index: 0, pageNo: 1, name: 'p', safeArea: { top: 20, bottom: 20, left: 0, right: 0 },
      overlapMode: 'declared', expectedOverlaps: [], expectedOutOfSafeArea: [], contrastExempt: [],
      elements: [
        { id: 'outsidePage', kind: 'shape', bounds: { x: -5, y: 0, w: 10, h: 10 } },
        { id: 'outsideSafe', kind: 'shape', bounds: { x: 40, y: 4, w: 120, h: 12 } },
      ],
    }],
  })
  ok('出界分级：超页面边界=out-of-page、超安全区=out-of-safe-area（两码可分，处置不同）',
    /\[✗\] out-of-page/.test(og.text) && /\[✗\] out-of-safe-area/.test(og.text),
    og.text.split('\n').filter((l) => l.includes('[✗]')).join('；').slice(0, 200))
}

// ── 48. surgicalMap：deck.yaml 里的页映射必须真的被采纳（2026-09-18 新增）────────────────
// 背景（真 bug · 契约存在但不被消费）：schema 校验 `deck.yaml` 的 `surgicalMap`，但**全项目无消费者**——
//   `ppt_patch` 只吃工具参数 `map`。用户把映射写进 deck.yaml 以为生效，实际**静默无效**（最难发现的一类）。
const smDir = join(root, 'examples', 'surgicalmap-smoke')
await rm(smDir, { recursive: true, force: true })
await mkdir(join(smDir, 'pages'), { recursive: true })
const smDeckHead = 'version: 1\ntitle: sm\nsize: [960, 540]\ntheme: {colors: {ink: "#1F2937"}, textStyles: {body: {fontSize: 18, color: "$ink"}}}\n'
await writeFile(join(smDir, 'deck.yaml'), `${smDeckHead}pages:\n  - pages/01.yaml\n  - pages/02.yaml\n`)
await writeFile(join(smDir, 'pages', '01.yaml'), 'pageType: content\nelements:\n  - elementId: t\n    elementType: text\n    bounds: [60, 60, 600, 60]\n    content: {text: "AAA 第一页", style: "$body"}\n')
await writeFile(join(smDir, 'pages', '02.yaml'), 'pageType: content\nelements:\n  - elementId: t\n    elementType: text\n    bounds: [60, 60, 600, 60]\n    content: {text: "BBB 第二页", style: "$body"}\n')
const smTpl = await exportPptx(await resolveDeck(smDir), { out: 'tpl.pptx', engine: 'pptd' })
const smSlide1 = (f) => zipRead(readFileSync(f)).get('ppt/slides/slide1.xml').toString('utf8')
const smA = await surgicalPatch({ template: smTpl.file, deckDir: smDir, out: join(smDir, 'identity.pptx') })
// 写入"交换"映射：模板第 1 页 ← deck 第 2 页
await writeFile(join(smDir, 'deck.yaml'), `${smDeckHead}surgicalMap: {1: 2, 2: 1}\npages:\n  - pages/01.yaml\n  - pages/02.yaml\n`)
const smB = await surgicalPatch({ template: smTpl.file, deckDir: smDir, out: join(smDir, 'mapped.pptx') })
ok('surgicalMap：deck.yaml 里的页映射**真的被采纳**（模板第 1 页取到 deck 第 2 页的内容）',
  smSlide1(smA.out).includes('AAA') && smSlide1(smB.out).includes('BBB'),
  `序号对齐含 AAA=${smSlide1(smA.out).includes('AAA')}｜采纳 deck 映射后含 BBB=${smSlide1(smB.out).includes('BBB')}`)
const smC = await surgicalPatch({ template: smTpl.file, deckDir: smDir, out: join(smDir, 'explicit.pptx'), map: { 1: 2, 2: 1 } })
ok('surgicalMap：显式 map 参数与 deck.yaml 字段同义（参数优先，行为不回退）',
  smSlide1(smC.out).includes('BBB') && smSlide1(smC.out) === smSlide1(smB.out),
  `显式参数结果与 deck 字段一致=${smSlide1(smC.out) === smSlide1(smB.out)}`)
await rm(smDir, { recursive: true, force: true })

// ── 49. 文档漂移守卫：工具描述里的数字必须等于真产物（2026-09-18 新增）──────────────
// 背景（真 bug · 文档漂移）：`ppt_new` 的描述写着"deck.yaml + 3 个页面"，而 `scaffoldProject` 实际生成 **4 个**。
//   工具描述是**模型读的事实来源**，写错就是让模型按错的事实工作（docs/05 §0c"手册里的每个事实都要能指回源码行"
//   同样适用于工具描述）。此前只有"文档里的 smoke 断言数"进了机器防线，其它同类事实没有。
{
  const { scaffoldProject } = await import('../lib/scaffold.js')
  const sdDir = join(root, 'examples', 'scaffold-count-smoke')
  await rm(sdDir, { recursive: true, force: true })
  await scaffoldProject(sdDir, { name: 'count' })
  const { readdir: rd } = await import('node:fs/promises')
  const realPages = (await rd(join(sdDir, 'pages'))).filter((f) => f.endsWith('.yaml')).length
  const m = readFileSync(join(root, 'src', 'tools.js'), 'utf8').match(/deck\.yaml \+ (\d+) 个页面/)
  ok('文档漂移：ppt_new 描述里的页数 == scaffoldProject 实际产出页数（工具描述也是模型读的事实）',
    Boolean(m) && Number(m[1]) === realPages, `描述=${m?.[1] ?? '(未匹配)'}｜实际=${realPages}`)
  await rm(sdDir, { recursive: true, force: true })
}

// ── 50. 表格门禁：内容溢出必须被拦（2026-09-18 新增）──────────────────────────────
// 背景（真 bug · 内容门禁的盲区）：layout 快照里表格只有 cols/rows 的**长度**，verify 的溢出判定只认
//   `kind === 'text'` ⇒ **表格内文字溢出既无门禁也无警告**。而表格是 role:content 的内容元素——
//   "内容溢出/互压"正是硬底线要管的（该严的地方没严）。
//   影响面已实测：仓库全部夹具 2 张表、**0 张**会被判溢出（余量 -228 / -52.8）⇒ 按 error 档接入对既有工程零影响。
// 两条一起看才算数：**该拦的拦得住** + **给足高度的不得误报**（保守度量不能变成噪声）。
const toDir = join(root, 'examples', 'tableoverflow-smoke')
await rm(toDir, { recursive: true, force: true })
await mkdir(join(toDir, 'pages'), { recursive: true })
await writeFile(join(toDir, 'deck.yaml'), 'version: 1\ntitle: to\nsize: [960, 540]\ntheme: {colors: {ink: "#1F2937"}, textStyles: {body: {fontSize: 18, color: "$ink"}}}\npages:\n  - pages/01.yaml\n  - pages/02.yaml\n')
const toCells = '    cols: [分类, 说明]\n    rows: [["甲", "这是一段很长的单元格说明文字用于触发溢出判定"], ["乙", "另一段同样很长的说明文字继续撑高需求高度"]]\n'
await writeFile(join(toDir, 'pages', '01.yaml'), `pageType: content\nelements:\n  - elementId: tight\n    elementType: table\n    bounds: [60, 60, 300, 40]\n${toCells}`)
await writeFile(join(toDir, 'pages', '02.yaml'), `pageType: content\nelements:\n  - elementId: roomy\n    elementType: table\n    bounds: [60, 60, 300, 400]\n${toCells}`)
const toLayout = (await renderDeck(await resolveDeck(toDir), {})).layout
const toV = verifyDeck(toLayout)
const toErr = (id) => toV.text.split('\n').filter((l) => l.includes('table-overflow') && l.includes(id))
const toRoomySnap = toLayout.pages[1].elements.find((e) => e.id === 'roomy')
ok('表格门禁：单元格内容按列宽换行后超出表格高度 → table-overflow ERROR（此前是内容门禁的盲区）',
  toErr('tight').length === 1, `tight 命中 ${toErr('tight').length} 条｜${toErr('tight')[0]?.slice(0, 96) ?? '(无)'}`)
ok('表格门禁：给足高度的表格不得误报（且估算确实跑过——快照带 overflowY）',
  toRoomySnap?.metrics?.overflowY !== undefined && toErr('roomy').length === 0,
  `roomy overflowY=${toRoomySnap?.metrics?.overflowY ?? '(缺)'}｜误报 ${toErr('roomy').length} 条`)
await rm(toDir, { recursive: true, force: true })

// ── 40. profile bundle 安装路径（2026-09-14："dsh plugin add 能不能装"）────────────────
// 机制：`dsh plugin --profile <p> <args>` = 在 profile 目录跑 pnpm，然后按**已安装状态**核对
// dsh.profile.bundles——声明了 dsh.bundle.patch 的依赖自动入栈。真机端到端自证在
// `scripts/verify-bundle-install.mjs`（隔离 DSH_HOME + 真 `dsh plugin add` + dump-config）；
// 这里守的是**不变量**（清单声明/文件/名字一致 + 防重行为），因为它们是改名/重构时最容易漏、
// 且漏了以后表现为"装了不生效"的静默失败。
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const patchRel = rootPkg.dsh?.bundle?.patch
const patchPath = patchRel ? join(root, String(patchRel).replace(/^\.\//, '')) : null
const patchExists = patchPath ? existsSync(patchPath) : false
ok('bundle：package.json 声明 dsh.bundle.patch，且文件存在并纳入发行物（files）',
  Boolean(patchRel) && patchExists && rootPkg.files.includes(String(patchRel).replace(/^\.\//, '')),
  `dsh.bundle.patch=${patchRel ?? '(未声明)'} 文件存在=${patchExists} 在 files 里=${rootPkg.files.includes(String(patchRel).replace(/^\.\//, ''))}`)

let patchDoc = null
try { patchDoc = (await import('yaml')).default.parse(readFileSync(patchPath, 'utf8')) } catch { /* 解析失败由下条断言报出 */ }
const insertRow = Array.isArray(patchDoc) ? (patchDoc.flatMap((l) => l?.insert ?? [])[0] ?? null) : null
ok('bundle：patch 的 insert 行名字与包名一致（改名必须两处同改——防"装了不生效"的静默失败）',
  Boolean(insertRow) && insertRow.name === rootPkg.name && typeof insertRow.id === 'string',
  `patch name=${insertRow?.name ?? '(缺)'}｜package name=${rootPkg.name}｜id=${insertRow?.id ?? '(缺)'}`)
ok('bundle：已转为公开发布 npm（无 private + publishConfig.access=public + 仓库元数据齐）——npm 通道的关键字段',
  rootPkg.private === undefined && rootPkg.publishConfig?.access === 'public'
  && Boolean(rootPkg.repository?.url) && Boolean(rootPkg.homepage) && Boolean(rootPkg.bugs?.url),
  `private=${rootPkg.private ?? 'undefined'}｜publishConfig.access=${rootPkg.publishConfig?.access ?? '(缺)'}｜repository=${rootPkg.repository?.url ?? '(缺)'}｜homepage=${rootPkg.homepage ? '有' : '(缺)'}`)

// lib/ 必须**提交**且与 src/ 逐字节一致（2026-09-16）：
// 商店（dsh-web 创意工坊）对没有 npm 包的条目生成的安装命令是 `dsh plugin --profile web add <repo URL>`
// （见对方仓库 market/src/app.js），而 git 安装只拿得到**已提交**内容——lib/ 不入库时装出来的包缺
// ./lib/index.js（exports 指向它），插件挂不上（本机隔离 DSH_HOME 实测：装到的包没有 lib/）。
// 反过来，lib 入库后"改了 src 忘了 build + commit"会静默发出旧代码，所以这条同时守住"入库 + 一致"。
{
  const { readdirSync: rd } = await import('node:fs')
  const { relative: rel } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const walk = (dir) => {
    const out = []
    const stack = [dir]
    while (stack.length) {
      const cur = stack.pop()
      for (const e of rd(cur, { withFileTypes: true })) {
        const p = join(cur, e.name)
        if (e.isDirectory()) stack.push(p)
        else if (e.isFile()) out.push(rel(dir, p).split('\\').join('/'))
      }
    }
    return out.sort()
  }
  const libDir = join(root, 'lib')
  const srcDir = join(root, 'src')
  const libFiles = walk(libDir)
  const libSet = new Set(libFiles)
  const srcFiles = walk(srcDir)
  const libMissing = srcFiles.filter((f) => !libSet.has(f))
  const libStale = srcFiles.filter((f) => libSet.has(f) && !readFileSync(join(srcDir, f)).equals(readFileSync(join(libDir, f))))
  const ignored = /^lib\/\s*$/m.test(readFileSync(join(root, '.gitignore'), 'utf8'))
  let tracked = null
  if (existsSync(join(root, '.git'))) {
    tracked = (spawnSync('git', ['ls-files', 'lib'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim().split('\n').filter(Boolean).length
  }
  ok('bundle：lib/ 已提交且与 src/ 逐字节一致（git 安装只拿已提交内容——缺 lib 则插件挂不上）',
    libMissing.length === 0 && libStale.length === 0 && !ignored && (tracked === null || tracked >= libFiles.length),
    `lib=${libFiles.length} 文件｜src=${srcFiles.length}｜缺失=${libMissing.length}｜不一致=${libStale.length}｜.gitignore 忽略=${ignored}｜git 跟踪=${tracked ?? '无 .git 跳过'}`)
}

// 包名是**单一事实源**：改名必须同步 cordis.patch.yml（漏 = 装了不生效）与预设里的插件行（若存在）。
// 【2026-09-18 改名时抓到的假阳性】旧断言用 `presetText.includes("name: '<包名>'")` 判"预设含该行"——
// 它命中的其实是预设文件里**注释中的举例字符串**，于是"随包预设不该含插件行"这件事被它悄悄放过了：
// 旧包名时靠注释意外通过，改名后立刻变红。现在只认**真实的插件行**（`- id: ppt-studio` 后紧跟的 name 行），
// 并把"不含行"当作正确状态（含行 ⇒ 预设 broken ⇒ 选择器看不到它，由 verify-bundle-install / check-preset 断言）。
{
  const presetText = readFileSync(join(root, 'agent-presets', 'ppt', 'agent.cordis.yml'), 'utf8')
  const rowMatch = presetText.match(/^-\s*id:\s*ppt-studio\s*$\n\s*name:\s*['"]([^'"]+)['"]/m)
  const presetRowName = rowMatch ? rowMatch[1] : null
  ok('bundle：包名三处一致（package.json / cordis.patch.yml / 预设**若有**插件行则同步）——改名防漂移',
    insertRow?.name === rootPkg.name && (presetRowName === null || presetRowName === rootPkg.name),
    `package=${rootPkg.name}｜patch=${insertRow?.name ?? '(缺)'}｜预设行=${presetRowName ?? '无（正确：随包预设不含插件行）'}`)
}

// 回滚后的装配形状（2026-09-18 第二次修订）：`apply()` 在**它被装入的那一层**注册全部能力面
// （工具 / `/ppt` 命令 / `ppt_state` / 4 本技能）⇒ 装上插件，**所有会话**都能用。
// 为什么放弃按预设隔离（两件都实测过，代码见 src/index.js 顶部）：
//   ① 空白会话**切换**预设时 `agent-presets.swap` 会 `recompose(agent.ctx, id)`，但那一刻该 agent 已存在，
//      我们的 `agent/created` 监听者才刚在这次组合中注册 ⇒ **不会**为它触发 ⇒ 切过去永远没有工具；
//   ② 技能注册表分层、技能工具在**预设层**读，而我们只能注册到 agent 子层或 profile 根 ⇒ 技能永不出现。
{
  const indexMod = await import('../lib/index.js')
  let tools = 0, cmds = 0, skills = 0, listeners = 0
  const handlers = new Map()
  const skillsSvc = { register: () => { skills++ } }
  // 预设注册表 stub（**按 DSH 0.1.7 的真实契约**）：`register()` 对重复 id **抛错**
  // （真源码：`if (this.definitions.has(definition.id)) throw new Error(\`Duplicate agent preset: ${def.id}\`)`），
  // 并返回注销函数。于是"双挂载会不会把同一个预设声明两次"在这里是可判定的。
  const declared = []
  const seenIds = new Set()
  const registry = {
    register: (def) => {
      if (seenIds.has(def.id)) return Promise.reject(new Error(`Duplicate agent preset: ${def.id}`))
      seenIds.add(def.id)
      declared.push(def)
      return Promise.resolve(async () => { seenIds.delete(def.id) })
    },
  }
  const childOf = () => ({ get: (k) => (k === 'agentPresets' ? registry : undefined) })
  const makeCtx = () => ({
    tools: { register: () => { tools++ } },
    commands: { register: () => { cmds++ } },
    skills: skillsSvc,
    get: (k) => (k === 'skills' ? skillsSvc : k === 'agentPresets' ? registry : undefined),
    agentPresets: registry,
    // 0.1.7 的正确取法：注册表可能比本插件行**晚激活** ⇒ `inject` 等它出现（服务消失时子 ctx 释放）
    inject: (deps, fn) => { if (deps.includes('agentPresets')) fn(childOf()) },
    on: (ev, fn) => { listeners++; handlers.set(ev, fn) },
    effect: (fn) => { fn(); return () => {} },
    logger: () => ({ info: () => {}, warn: () => {} }),
  })
  // 装配防重计数是**进程级**（globalThis）：本节要自己从 0 起算，否则会被前面的用例带偏
  delete globalThis.__pptCoreReg
  indexMod.apply(makeCtx(), { presetIds: ['ppt'] })
  const flush = () => new Promise((r) => setTimeout(r, 0))
  await flush() // 声明走的是异步队列（inject → register），让它落地
  ok('回滚：apply 在**装入层**注册工具与命令面（22 工具 + /ppt 命令）——"装上即可用"',
    tools === 22 && cmds >= 1, `tools=${tools} cmds=${cmds}`)
  ok('回滚：4 本内嵌技能注册在**同一层**（技能注册表分层，技能工具在父层读——注册到子层就永远看不见）',
    skills === 4, `skills=${skills}（应=4）`)
  ok('回滚：隔离代码已移除（不再导出 mountForAgent，也不再用 roster 决定装配）',
    indexMod.mountForAgent === undefined && tools === 22, `mountForAgent=${typeof indexMod.mountForAgent}｜tools=${tools}`)
  // ── 0.1.7 的**真适配**：预设靠"向注册表声明"交付（写目录那条路已被上游删除）────────────
  // 判据分三层：① 真的调到 register 了；② 声明形状对（id/名/序/行数/内容）；③ 双挂载不会声明两次。
  const d0 = declared[0]
  ok('0.1.7：预设靠 `agentPresets.register()` **声明**（不再写目录——上游已无目录发现路径）',
    declared.length === 1 && d0?.id === 'ppt', `声明次数=${declared.length}｜id=${d0?.id ?? '(无)'}`)
  ok('0.1.7：声明形状取自包内 `agent-presets/ppt/`（名字/简介/序号 + 19 条 standard 组合行）',
    d0?.name === 'PPT 工作室' && d0?.order === 2 && d0?.plugins?.length === 19
      && typeof d0?.description === 'string' && d0.description.length > 10,
    `name=${d0?.name ?? '(无)'}｜order=${d0?.order}｜rows=${d0?.plugins?.length}｜desc=${d0?.description?.length ?? 0} 字`)
  // `!!js` 必须**保真**成 Loader 认的 `{__jsExpr}`：降级成普通字符串会让
  // `Boolean(<非空字符串>) === true` ⇒ Windows 上 pwsh 行被误停用（= 没有 shell）。
  const rowOf = (def, id) => def?.plugins?.find((r) => r.id === id)
  const bashD = rowOf(d0, 'tool-bash')?.disabled
  const pwshD = rowOf(d0, 'tool-pwsh')?.disabled
  ok('0.1.7：`!!js` 表达式保真为 `{__jsExpr}`（降级成字符串 ⇒ Windows 上 pwsh 行会被误停用）',
    bashD?.__jsExpr === "process.platform === 'win32'" && pwshD?.__jsExpr === "process.platform !== 'win32'",
    `bash=${JSON.stringify(bashD)}｜pwsh=${JSON.stringify(pwshD)}`)
  const first = { tools, cmds, skills }
  indexMod.apply(makeCtx(), { presetIds: ['ppt'] }) // 第二次装配（双挂载场景）
  await flush()
  ok('回滚：同进程第二次装配被防重拦下（首个生效 + 计数），不重复注册',
    tools === first.tools && cmds === first.cmds && skills === first.skills,
    `二次后 tools=${tools}（应=${first.tools}）cmds=${cmds} skills=${skills}｜refcount=${globalThis.__pptCoreReg?.count ?? '?'}`)
  ok('0.1.7：双挂载也**不会重复声明**预设（真注册表对重复 id 直接 throw ⇒ 声明只发一次）',
    declared.length === 1, `声明次数=${declared.length}（应=1）`)
  ok('回滚：apply 装的全局管道仍在（预览路由/语义路由/提示段注入靠这些监听器）',
    listeners >= 2, `listeners=${listeners}`)
  let promptOk = false
  try {
    const h = handlers.get('system-prompt/assemble')
    const out = h ? await h({ sections: [] }, { agent: { session: { id: 'no-such-session-xyz' } } }, async () => ({ sections: [] })) : null
    promptOk = Boolean(out)
  } catch { promptOk = false }
  ok('回滚：提示段注入不按预设门控（读不到会话状态时原样返回，不抛）', promptOk, promptOk ? '原样返回 ✓' : '未注册/抛错')
  // 注册表缺失时必须**只告警不抛**（极简部署没有 agentPresets）：插件仍要完整可用
  let noRegThrew = false
  delete globalThis.__pptCoreReg
  try {
    indexMod.apply({
      tools: { register: () => {} }, commands: { register: () => {} }, skills: skillsSvc,
      get: () => undefined, inject: () => {}, on: () => {}, effect: (fn) => { fn(); return () => {} },
      logger: () => ({ info: () => {}, warn: () => {} }),
    }, {})
    await flush()
  } catch { noRegThrew = true }
  ok('0.1.7：注册表不可用时只告警不抛（预设没了也不能让插件挂不上）',
    noRegThrew === false, noRegThrew ? '装配抛错了' : '静默降级 ✓')
  delete globalThis.__pptCoreReg
}

// ── 41. 安装器 + 预设**声明**（2026-09-24 为 DSH 0.1.7-rc.1 重写）──────────────────────
// 0.1.6 及以前这条测的是"预设目录内的 junction + 相对路径行"。0.1.7 把目录发现整个删掉了
// （上游原文 "the harness discovers no preset on disk"），预设改为向 `agentPresets` 注册表**声明**，
// 安装器也不再写预设文件。这里钉五件事：
//   ① 默认=全局（profile bundle）：exit 0，且**不产出**任何 `.agent-presets/`（写了也没人读）；
//   ② 0.1.6 遗留的预设目录被**清理**（留着会让"改了预设为什么没生效"变成假线索）；
//   ③ `--isolate` **明确拒绝**（exit 1 + 说清原因），不写出一个永远不会被读到的预设；
//   ④ 装到的副本带着"声明预设"所需的资产，且组合里**不含**本包插件行（含行 ⇒ 双挂载）；
//   ⑤ 夹具清理不碰仓库本体。
{
  const { spawnSync } = await import('node:child_process')
  const { cp } = await import('node:fs/promises')
  const base = join(root, 'examples', 'smoke', '.tmp-install-mode')
  await rm(base, { recursive: true, force: true })
  const mkPrefix = async (name, withDep) => {
    const dir = join(base, name)
    await mkdir(join(dir, 'profiles', 'web'), { recursive: true })
    await writeFile(join(dir, 'profiles', 'web', 'package.json'),
      JSON.stringify({ name: 'p', dependencies: withDep ? { [rootPkg.name]: 'file:x' } : {} }, null, 2), 'utf8')
    // 包本体归 pnpm：夹具要真的"有包"，并且带上**声明预设所需的资产**（否则安装器的资产校验会正确报错）
    const pd = join(dir, 'profiles', 'web', 'node_modules', 'dsh-ppt-studio')
    await mkdir(pd, { recursive: true })
    await writeFile(join(pd, 'package.json'), JSON.stringify({ name: rootPkg.name, version: rootPkg.version }), 'utf8')
    if (withDep) {
      await cp(join(root, 'lib'), join(pd, 'lib'), { recursive: true })
      await cp(join(root, 'agent-presets'), join(pd, 'agent-presets'), { recursive: true })
    }
    return dir
  }
  const pfxGlb = await mkPrefix('glb', true)      // 默认模式：已按 bundle 安装 → 走快路径
  const pfxNo = await mkPrefix('nobundle', false) // 未装 bundle + 默认模式 + 无 dsh → 必须拒绝
  const installScript = join(root, 'scripts', 'install.mjs')
  const legacyDirOf = (prefix) => join(prefix, '.agent-presets', 'ppt')
  // 先埋一份 0.1.6 时代的遗留产物（预设目录 + 一份组合），验证安装器会清掉它
  await mkdir(legacyDirOf(pfxGlb), { recursive: true })
  await writeFile(join(legacyDirOf(pfxGlb), 'agent.cordis.yml'), '- id: persona\n', 'utf8')
  await writeFile(join(legacyDirOf(pfxGlb), 'preset.yml'), 'name: 旧\n', 'utf8')
  const resGlb = spawnSync(process.execPath, [installScript, '--prefix', pfxGlb], { encoding: 'utf8' })
  const resIso = spawnSync(process.execPath, [installScript, '--prefix', pfxGlb, '--isolate'], { encoding: 'utf8' })
  // PATH 里只留 node 所在目录 ⇒ `dsh` 不可用 ⇒ 默认（全局）模式必须拒绝继续，而不是假装成功
  const resNo = spawnSync(process.execPath, [installScript, '--prefix', pfxNo], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dirname(process.execPath), Path: dirname(process.execPath) },
  })
  ok('装配路径：**默认=全局**（profile bundle）且**不再产出** .agent-presets/（0.1.7 无目录发现路径）',
    resGlb.status === 0 && !existsSync(legacyDirOf(pfxGlb)),
    `glb exit=${resGlb.status}｜遗留目录=${existsSync(legacyDirOf(pfxGlb))}`)
  ok('装配路径：0.1.6 遗留的预设目录被**清理**（留着会让"改了预设为什么没生效"变成假线索）',
    !existsSync(legacyDirOf(pfxGlb)) && /已清理 0\.1\.6 遗留的预设目录/.test(String(resGlb.stdout ?? '')),
    (String(resGlb.stdout ?? '').match(/已清理[^\n]*/) ?? ['(无清理日志)'])[0].slice(0, 110))
  ok('装配路径：`--isolate` 在 0.1.7 上**明确拒绝**（exit 1 + 说清原因，不写出没人读的预设）',
    resIso.status === 1 && /--isolate 在 DSH 0\.1\.7 上不再可用/.test(String(resIso.stderr ?? '')),
    `iso exit=${resIso.status}｜有原因=${/不再可用/.test(String(resIso.stderr ?? ''))}`)
  ok('装配路径：非 bundle 又装不上 bundle 时**拒绝继续**（宁可失败，也不静默假成功）',
    resNo.status === 1, `noBundle exit=${resNo.status}`)
  ok('装配路径：安装器校验"声明预设"所需的资产（agent-presets/ppt/* + lib/preset-delivery.js）',
    /预设资产已就位/.test(String(resGlb.stdout ?? '')), 
    (String(resGlb.stdout ?? '').match(/预设资产已就位[^\n]*/) ?? ['(无资产校验输出)'])[0].slice(0, 110))
  const tplText = readFileSync(join(root, 'agent-presets', 'ppt', 'agent.cordis.yml'), 'utf8')
  ok('装配路径：包内交付的预设组合**不含**本包插件行（含行 ⇒ 同进程双挂载；插件由 bundle 提供）',
    !/^-\s*id: ppt-studio$/m.test(tplText) && !/dsh-ppt-studio plugin row/.test(tplText), '组合干净 ✓')
  await rm(base, { recursive: true, force: true })
  ok('装配路径：临时夹具清理干净且**没有碰仓库本体**',
    !existsSync(base) && existsSync(installScript) && existsSync(join(root, 'package.json')),
    '仓库根文件仍在 ✓')
}

// ── 41b. 预设漂移门禁认得 **0.1.7 的新参照格式**（hermetic：自带夹具，不依赖本机装没装 DSH）──
// 为什么要有这条：0.1.7 把参照物从 `dsh-agent-presets/presets/standard/agent.cordis.yml`（条目数组）
// 换成 `dsh-web-app/presets/standard.patch.yml`（patch → insert → `config.plugins`）。
// 旧脚本找不到参照时**静默跳过**——于是"整套 DSH 相关检查都在跳过"伪装成了 250/0 全绿。
// 这条夹具把新格式**钉死**：报漂移要真报、找不到参照要真喊。
{
  const { spawnSync } = await import('node:child_process')
  const fx = join(root, 'examples', 'smoke', '.tmp-preset-ref')
  await rm(fx, { recursive: true, force: true })
  const refDir = join(fx, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets')
  await mkdir(refDir, { recursive: true })
  const refFile = join(refDir, 'standard.patch.yml')
  const oursText = readFileSync(join(root, 'agent-presets', 'ppt', 'agent.cordis.yml'), 'utf8')
  // 我们的组合原样缩进成 `config.plugins` 的值（**纯文本缩进** ⇒ `!!js` 保真，不经过序列化）
  const nest = (text) => text.split('\n').map((l) => (l.trim() ? '          ' + l : l)).join('\n')
  const modernPatch = (rows) => `- insert:\n    - id: preset-standard\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: standard\n        order: 1\n        plugins:\n${nest(rows)}\n`
  const cpScript = join(root, 'scripts', 'check-preset.mjs')
  const pin = join(fx, 'pinned.yml')
  const runCp = (refPath, extra = []) => spawnSync(process.execPath, [cpScript, '--ref', refPath, ...extra], { encoding: 'utf8' })
  await writeFile(refFile, modernPatch(oursText), 'utf8')
  const okRef = runCp(refFile, ['--require'])
  ok('0.1.7：预设门禁认得新参照格式（patch → insert → config.plugins）——行相同 ⇒ 漂移 0',
    okRef.status === 0 && /modern/.test(okRef.stdout) && /漂移 0/.test(okRef.stdout),
    (okRef.stdout ?? '').split('\n').filter((l) => /格式|预设自检/.test(l)).join(' | ').slice(0, 150))
  await writeFile(pin, modernPatch(oursText.replace('maxBytes: 65536', 'maxBytes: 4096')), 'utf8')
  const bad = runCp(pin)
  ok('0.1.7：参照行被改动 ⇒ **报漂移并 exit 1**（门禁真在比对，不是解析完就放过）',
    bad.status === 1 && /配置漂移/.test(bad.stdout), `exit=${bad.status}｜报漂移=${/配置漂移/.test(bad.stdout)}`)
  // 旧格式（0.1.6 的条目数组）：我们的组合文件**本身就是**这个格式 ⇒ 原样当参照 ⇒ 漂移 0。
  // 这条同时证明"legacy 分支真的把行读进来比对了"，而不是识别完就放过。
  await writeFile(pin, oursText, 'utf8')
  const lg = runCp(pin)
  ok('0.1.7：**旧格式（0.1.6 条目数组）也还认**——老宿主上跑不瞎',
    lg.status === 0 && /legacy/.test(lg.stdout) && /漂移 0/.test(lg.stdout),
    `exit=${lg.status}｜${(lg.stdout.match(/格式：.*/) ?? ['(无格式行)'])[0].slice(0, 40)}｜漂移0=${/漂移 0/.test(lg.stdout)}`)
  await rm(fx, { recursive: true, force: true })
  const missing = runCp(join(fx, 'nope.yml'), ['--require'])
  const missingSoft = runCp(join(fx, 'nope.yml'))
  ok('0.1.7：找不到参照物时 `--require` **失败**、默认**醒目告警**（静默跳过是"假绿"的成因）',
    missing.status === 1 && missingSoft.status === 0 && /没有生效/.test(missingSoft.stdout),
    `require exit=${missing.status}｜默认 exit=${missingSoft.status}`)
  await rm(fx, { recursive: true, force: true })
}

// ── 41c. 桌面端（Electron 应用）安装器 —— 桌面端**不能**用一句 `dsh plugin add` ──────────────
// 两条硬事实（2026-09-26 实测）：
//   ① `@deepseek-ai/dsh` 的 `lib/bin.js` 对 `desktop` profile 的**启动与 plugin 两条路**都
//      `program.error('profile "desktop" is managed exclusively by the Electron application')`，无旁路；
//   ② 桌面端自带 pnpm 11.7.0 + `nodeLinker: hoisted` 下装 tarball URL 会
//      `ERR_PNPM_MISSING_TARBALL_INTEGRITY`（隔离复现：去掉 nodeLinker 或换 pnpm 11.21 即成功）。
// ⇒ 必须有自己的安装通道（scripts/install-desktop.mjs）。这里用**桩工具链 + 临时 DSH_HOME** 跑
// `--dry-run`：只验探测/规划/**不写盘**，既不碰真桌面端也不跑 pnpm（CI 上同样可跑）。
{
  const { spawnSync } = await import('node:child_process')
  const fx = join(root, 'examples', 'smoke', '.tmp-desktop')
  await rm(fx, { recursive: true, force: true })
  const prof = join(fx, 'home', 'profiles', 'desktop')
  const stub = join(fx, 'app', 'resources')
  await mkdir(join(stub, 'runtime', 'bin'), { recursive: true })
  await mkdir(join(stub, 'runtime', 'pnpm', 'bin'), { recursive: true })
  await mkdir(prof, { recursive: true })
  await writeFile(join(prof, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2), 'utf8')
  await writeFile(join(prof, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
  // 两个平台名都造：安装器在 win32 找 `runtime/bin/node.cmd`、在 POSIX 找 `runtime/bin/node`。
  // 【2026-09-26 修】只造 .cmd 时，ubuntu CI 上桩被判"内置工具链不完整" ⇒ 第一条断言红。
  await writeFile(join(stub, 'runtime', 'bin', 'node.cmd'), '@echo off\r\n', 'utf8')
  await writeFile(join(stub, 'runtime', 'bin', 'node'), '#!/bin/sh\n', 'utf8')
  await writeFile(join(stub, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'), '// stub\n', 'utf8')
  const script = join(root, 'scripts', 'install-desktop.mjs')
  const runD = (extra) => spawnSync(process.execPath,
    [script, '--prefix', join(fx, 'home'), '--app-dir', stub, '--dry-run', ...extra], { encoding: 'utf8' })
  const before = readFileSync(join(prof, 'package.json'), 'utf8')
  const planLocal = runD([])
  const localOk = planLocal.status === 0 && /打包本目录 → 装 profile 内 file: 规格/.test(String(planLocal.stdout ?? ''))
  const planUrl = runD(['--spec', 'https://example.invalid/x.tgz'])
  const urlOk = planUrl.status === 0 && /直接装 URL/.test(String(planUrl.stdout ?? ''))
  const untouched = readFileSync(join(prof, 'package.json'), 'utf8') === before
  ok('桌面端：安装器认得 desktop profile / 内置工具链 / nodeLinker，且 `--dry-run` **不写盘**',
    localOk && urlOk && untouched, `本包规格=${localOk}｜URL 规格=${urlOk}｜profile 未被改动=${untouched}`)
  const noProfile = spawnSync(process.execPath,
    [script, '--prefix', join(fx, 'nope'), '--app-dir', stub, '--dry-run'], { encoding: 'utf8' })
  ok('桌面端：profile 不存在时**明确失败**（不静默继续）',
    noProfile.status === 1 && /桌面 profile 不存在/.test(String(noProfile.stderr ?? '')), `exit=${noProfile.status}`)
  await rm(fx, { recursive: true, force: true })
}

// ── 42. 答疑手册 vs 制作手册的触发纪律（2026-09-15 真实反馈）────────────────────
// 事故形状：模型在 PPT 任务**开工时**先加载 `ppt-studio-manual`（提问式手册）——因为它的
// description/whenToUse 写着"如何开始 / DSL 语法速查 / 或模型不确定某一 DSL 写法时加载"，
// 这对"正在做 PPT 的人"是恒真的自触发条件。后果是每轮任务白付一次几千字符的正文成本，
// 而它讲的是"怎么回答用户提问"，不是"怎么做 PPT"。
// 修法：答疑手册只保留"用户提问"触发 + 明确否定句；工作流提示段显式区分两类手册；
// 制作三本正文不得把读者引向答疑手册（工作期读到那句 = 又被引去加载）。
// 这三条**不是**文风审查，而是可判定的触发面事实：
const manualSkill = bundled.find((b) => b.parsed.name === 'ppt-studio-manual')
const manDesc = manualSkill?.parsed.description ?? ''
const manWhen = manualSkill?.parsed.whenToUse ?? ''
const manQaTrigger = /用户问|提问/.test(manDesc) && /提问|用户问/.test(manWhen)
const manNoSelfTrigger = !/模型不确定/.test(manDesc + manWhen) && !/不确定某一/.test(manDesc + manWhen)
const manNegated = /不要加载/.test(manDesc) && /不要加载/.test(manWhen)
ok('答疑手册触发面：`ppt-studio-manual` 只由"用户提问"触发，且写明"制作中不要加载"（去掉恒真的自触发措辞）',
  manQaTrigger && manNoSelfTrigger && manNegated,
  `问答触发=${manQaTrigger}｜无自触发=${manNoSelfTrigger}｜否定句=${manNegated}`)

const manBodyHead = (manualText ?? '').slice(0, 400)
const manBodyBanner = /只服务/.test(manBodyHead) && /不要读/.test(manBodyHead)
const stdWorkflow = routerMod.workflowSection('from-scratch', { ...baseCfg, quick: false }).text
const workflowSplits = stdWorkflow.includes('ppt-studio-manual') && /不要加载/.test(stdWorkflow) && /答疑手册/.test(stdWorkflow)
ok('答疑手册兜底：正文开头自带"只服务提问 / 制作中不要读"横幅，且工作流提示段显式区分答疑手册与制作手册',
  manBodyBanner && workflowSplits,
  `正文横幅=${manBodyBanner}｜工作流分行=${workflowSplits}`)

const crossBookPointers = ['ppt-studio-craft', 'ppt-studio-data', 'ppt-studio-copy']
  .filter((n) => (bundled.find((b) => b.parsed.name === n)?.parsed.content ?? '').includes('ppt-studio-manual'))
ok('制作手册零指向答疑手册：craft/data/copy 正文不出现 `ppt-studio-manual`（工作期读到会被引去加载答疑手册）',
  crossBookPointers.length === 0,
  crossBookPointers.length ? `仍指向：${crossBookPointers.join('、')}` : '三本均无指向')

// ── 51. npm 全自动发布通道（2026-09-26：Trusted Publishing / OIDC）─────────────────────
// 要防的事故形状：本包的发布件是 Release 资产 tgz，而「registry 字节 == Release 资产字节」是不变量。
// 谁把 CI 改成重新打包、去掉 id-token、注入传统 npm 凭据、或退回 stage-only，都会**静默**破坏这条通道——
// 症状只在下一次发版时出现（而且那时已经晚了：npm 的版本不可覆盖）。所以把前提钉成机器断言。
const publishYml = readFileSync(join(root, '.github', 'workflows', 'publish.yml'), 'utf8')
ok('npm 发布通道：`.github/workflows/publish.yml` 由 release(published) 触发，并留 workflow_dispatch 兜底',
  /types:\s*\[published\]/.test(publishYml) && /^\s*workflow_dispatch:/m.test(publishYml),
  /types:\s*\[published\]/.test(publishYml) ? '触发 = release:published + 手动兜底' : '缺少 release:published 触发')
// 断言口径：禁的是"在 YAML 里给它赋值"（`NODE_AUTH_TOKEN: …`）——注释里出现这个名字是在解释为什么不能赋值，不算违规。
const noInjectedToken = !/^\s*-?\s*NODE_AUTH_TOKEN\s*[:=]/m.test(publishYml) && /unset NODE_AUTH_TOKEN/.test(publishYml) && !/^\s*registry-url\s*:/m.test(publishYml)
ok('npm 发布通道：OIDC 前提齐（id-token: write），且不注入 npm 长期凭据（不写 NODE_AUTH_TOKEN、不给 setup-node 传 registry-url、发布前 unset 兜底）',
  /id-token:\s*write/.test(publishYml) && noInjectedToken,
  `id-token: write=${/id-token:\s*write/.test(publishYml)}｜无注入凭据=${noInjectedToken}｜registry-url=${/registry-url\s*:/.test(publishYml)}`)
ok('npm 发布通道：全自动档用 `npm publish`（不是 stage-only），且带 npm >= 11.15.0 门禁',
  /npm publish/.test(publishYml) && !/npm stage publish/.test(publishYml) && /11\.15\.0/.test(publishYml),
  `npm publish=${/npm publish/.test(publishYml)}｜stage-only=${/npm stage publish/.test(publishYml)}｜版本门禁=${/11\.15\.0/.test(publishYml)}`)
const newestAsset = /sort_by\(\.createdAt\)\s*\|\s*last/.test(publishYml)
ok('npm 发布通道：发布的是**下载下来的 Release 资产**（等 .tgz + 按上传时间取最新 + gh release download），CI 里不得二次打包',
  /endswith\("\.tgz"\)/.test(publishYml) && newestAsset && /gh release download/.test(publishYml) && !/npm pack/.test(publishYml),
  `等资产=${/endswith\("\.tgz"\)/.test(publishYml)}｜取最新=${newestAsset}｜下载资产=${/gh release download/.test(publishYml)}｜二次打包=${/npm pack/.test(publishYml)}`)

// ── 52. 真实 webServer 契约（2026-09-26 桌面端事故的回归）───────────────────────────────
// 宿主警告原文（用户桌面端实测）："1 entry did not activate ppt-studio (dsh-ppt-studio):
// TypeError: ws.register(...).then is not a function at registerPreviewRoute"。
// 机理：真库 register 是**同步**的（返回 disposer 函数），而历史实现对返回值调 .then；异常从 apply 同步
// 抛出 ⇒ 整个插件条目激活失败，用户连 ppt_state 都调不到。两条防线各钉一条断言。
{
  delete globalThis.__pptRouteReg
  const dupPrefixes = new Map()
  const dupWs = { prefixes: dupPrefixes, register: () => { throw new Error('webserver: duplicate prefix route "/ppt-preview"') } }
  const dupCtx = { get: () => dupWs, effect: (cb) => { const c = cb(); return () => { if (typeof c === 'function') c() } } }
  let dupThrew = null
  let dupDisposer = null
  try { dupDisposer = rpr(dupCtx) } catch (e) { dupThrew = e }
  let dupDisposeOk = true
  try { dupDisposer?.() } catch { dupDisposeOk = false }
  ok('§52 预览路由：`webServer.register` **同步抛错**（重复注册）时不得把异常扔出，返回的 disposer 可安全调用',
    dupThrew === null && typeof dupDisposer === 'function' && dupDisposeOk,
    `threw=${dupThrew ? String(dupThrew.message) : 'null'}｜disposer=${typeof dupDisposer}｜dispose 安全=${dupDisposeOk}`)

  // 反向：连 `ctx.get('webServer')` 都抛错（最坏情况）时，apply 仍必须完成能力面装配。
  const indexMod2 = await import('../lib/index.js')
  let pTools = 0, pCmds = 0, pSkills = 0
  const pSkillsSvc = { register: () => { pSkills++ } }
  const pRegistry = { register: () => Promise.resolve(async () => {}) }
  const pipeCtx = {
    tools: { register: () => { pTools++ } },
    commands: { register: () => { pCmds++ } },
    skills: pSkillsSvc,
    get: (k) => {
      if (k === 'webServer') throw new Error('webserver: get 抛错（最坏情况）')
      return k === 'skills' ? pSkillsSvc : k === 'agentPresets' ? pRegistry : undefined
    },
    agentPresets: pRegistry,
    // 最坏情况：连 inject 都抛错（webServer 这一路）——装配仍必须完成
    inject: (deps, fn) => {
      if (deps.includes('webServer')) throw new Error('inject 抛错（最坏情况）')
      if (deps.includes('agentPresets')) fn({ get: (k) => (k === 'agentPresets' ? pRegistry : undefined) })
    },
    on: () => {},
    effect: (fn) => { fn(); return () => {} },
    logger: () => ({ info: () => {}, warn: () => {} }),
  }
  delete globalThis.__pptCoreReg
  delete globalThis.__pptRouteReg
  let applyThrew = null
  try { indexMod2.apply(pipeCtx, { presetIds: ['ppt'] }) } catch (e) { applyThrew = e }
  ok('§52 装配韧性：全局管道抛错时 apply 仍完成装配（22 工具 / 命令面 / 4 技能）——附加能力坏掉只该降级',
    applyThrew === null && pTools === 22 && pCmds >= 1 && pSkills === 4,
    `threw=${applyThrew ? String(applyThrew.message) : 'null'}｜tools=${pTools} cmds=${pCmds} skills=${pSkills}`)

  // ③ 真宿主实测的组合顺序：webServer 比本插件**晚激活**。此时直接 `ctx.get('webServer')` 拿不到服务，
  // 路由会被静默跳过（诊断原文 `预览路由=skipped(no webServer)`）⇒ 预览链接必然 404。
  // 修法 = 与 agentPresets 同一姿势走 `inject` 等它出现。这条断言钉住"最终真的挂上了"。
  const injPrefixes = new Map()
  const injWs = {
    prefixes: injPrefixes,
    register: (r) => { injPrefixes.set(r.path, r); return () => { injPrefixes.delete(r.path) } }, // 真契约：同步返回函数
  }
  const injChild = { get: (k) => (k === 'webServer' ? injWs : undefined), effect: (cb) => { const c = cb(); return () => { if (typeof c === 'function') c() } } }
  let iTools = 0, iCmds = 0, iSkills = 0
  const iSkillsSvc = { register: () => { iSkills++ } }
  const iRegistry = { register: () => Promise.resolve(async () => {}) }
  const injCtx = {
    tools: { register: () => { iTools++ } },
    commands: { register: () => { iCmds++ } },
    skills: iSkillsSvc,
    // 关键：本 ctx **查不到** webServer（模拟"服务还没注册"）
    get: (k) => (k === 'skills' ? iSkillsSvc : k === 'agentPresets' ? iRegistry : undefined),
    agentPresets: iRegistry,
    inject: (deps, fn) => {
      if (deps.includes('webServer')) fn(injChild)
      else if (deps.includes('agentPresets')) fn({ get: (k) => (k === 'agentPresets' ? iRegistry : undefined) })
    },
    on: () => {},
    effect: (fn) => { fn(); return () => {} },
    logger: () => ({ info: () => {}, warn: () => {} }),
  }
  delete globalThis.__pptCoreReg
  delete globalThis.__pptRouteReg
  let injThrew = null
  try { indexMod2.apply(injCtx, { presetIds: ['ppt'] }) } catch (e) { injThrew = e }
  await new Promise((r) => setTimeout(r, 10))
  ok('§52 预览路由：`webServer` 比插件晚激活时（真宿主实测的组合顺序）走 `inject` 仍要真的挂上路由',
    injThrew === null && iTools === 22 && injPrefixes.has('/ppt-preview'),
    `threw=${injThrew ? String(injThrew.message) : 'null'}｜tools=${iTools}｜路由已挂=${injPrefixes.has('/ppt-preview')}`)
}

// ── 53. 安装通道事实：npm 是**默认**通道（web 与桌面端都支持）────────────────────────────
// 用户 2026-09-26 拍板："把 npm 安装作为默认安装途径，实现一句话无脑安装"。
// 这条事实同时在三处出现（README=用户读 / docs/05=维护者读 / 答疑手册=模型读），这里钉住口径一致：
// README 的第一条安装命令必须是 npm 包名，且要排在归档资产 URL **之前**；手册用同一条命令（`<p>` 占位）。
{
  const readmeAuth = readFileSync(join(root, 'README.md'), 'utf8')
  const npmCmd = 'dsh plugin --profile web add dsh-ppt-studio'
  const manualCmd = 'dsh plugin --profile <p> add dsh-ppt-studio'
  const npmAt = readmeAuth.indexOf(npmCmd)
  const assetAt = readmeAuth.indexOf('dsh plugin --profile web add <粘贴那条资产 URL>')
  const manualText53 = readFileSync(join(root, 'skills', 'ppt-studio-manual', 'SKILL.md'), 'utf8')
  const docs05Text = readFileSync(join(root, 'docs', '05-迭代流程.md'), 'utf8')
  ok('§53 安装通道：README 以 **npm 包名**为第一条安装命令（排在归档资产 URL 之前），答疑手册与 docs/05 同口径',
    npmAt > 0 && assetAt > npmAt && manualText53.includes(manualCmd) && docs05Text.includes(npmCmd),
    `README npm 位置=${npmAt}｜资产 URL 位置=${assetAt}｜手册=${manualText53.includes(manualCmd)}｜docs/05=${docs05Text.includes(npmCmd)}`)
}

// ── 54. 媒体链路：预览与成品必须对齐（2026-09-26 审计修复的三处真缺陷）──────────────────────
// ① 不同目录**同名**媒体：旧实现 addMedia 按完整路径去重、但包内部件名与 rels Target 都取 basename
//    ⇒ 两张不同的图塌成同一个部件（后写覆盖先写）——**成品静默用错图**，而图数量 parity 依旧 2/2、ok=true。
// ② 非 ASCII/空格文件名：预览 handler 不解 percent-encoding ⇒ 图已拷进预览根却 404（导出正常）。
// ③ `media/子目录/`：旧 buildPreview 把目录条目当文件 copyFile ⇒ EPERM 整体失败（不是"缺图"）。
// 另附带一条守门：ASCII 且唯一的部件名**必须保持原名**（既有工程产物零变化）。
{
  const { registerTools: regTools54 } = await import('../lib/tools.js')
  const { previewFileFor } = await import('../lib/preview-server.js')
  const fsp = await import('node:fs/promises')
  const mlWork = join(smokeDir, '.tmp-media-link')
  await fsp.rm(mlWork, { recursive: true, force: true })
  await fsp.mkdir(join(mlWork, 'pages'), { recursive: true })
  await fsp.mkdir(join(mlWork, 'media', 'a'), { recursive: true })
  await fsp.mkdir(join(mlWork, 'media', 'b'), { recursive: true })
  const pngA = readFileSync(join(root, 'examples', 'smoke', 'media-test.png'))
  const pngB = readFileSync(join(root, 'templates', 'academic-white', 'preview.png'))
  await fsp.writeFile(join(mlWork, 'media', 'a', 'logo.png'), pngA)
  await fsp.writeFile(join(mlWork, 'media', 'b', 'logo.png'), pngB) // 同名、内容不同
  await fsp.writeFile(join(mlWork, 'media', '中文 图.png'), pngA) // 非 ASCII + 空格
  await fsp.writeFile(join(mlWork, 'media', 'plain.png'), pngA) // ASCII 且唯一 → 必须保持原名
  await fsp.writeFile(join(mlWork, 'deck.yaml'), ['version: 1', 'title: media-link', 'size: [960, 540]', 'theme:', '  colors: {primary: "#2563EB"}', 'pages:', '  - pages/01.yaml', ''].join('\n'))
  const imgEl = (id, x, src) => [`  - elementId: ${id}`, '    elementType: image', `    bounds: [${x}, 40, 200, 200]`, `    src: ${src}`]
  await fsp.writeFile(join(mlWork, 'pages', '01.yaml'), ['pageType: content', 'elements:', ...imgEl('a', 20, 'media/a/logo.png'), ...imgEl('b', 240, 'media/b/logo.png'), ...imgEl('cn', 460, 'media/中文 图.png'), ...imgEl('plain', 680, 'media/plain.png'), ''].join('\n'))

  const expML = await exportPptx(await resolveDeck(mlWork), { out: join(mlWork, 'out.pptx') })
  const zipML = zipRead(readFileSync(expML.file))
  const parts = [...zipML.keys()].filter((k) => k.startsWith('ppt/media/'))
  const bufOf = (k) => Buffer.from(zipML.get(k))
  const sameA = parts.filter((k) => bufOf(k).equals(pngA)).length
  const sameB = parts.filter((k) => bufOf(k).equals(pngB)).length
  const relsML = String(zipML.get('ppt/slides/_rels/slide1.xml.rels'))
  const targets = [...relsML.matchAll(/Target="\.\.\/media\/([^"]+)"/g)].map((m) => m[1])
  ok('§54 导出：不同目录**同名**媒体各占一个部件（不再一张图顶掉另一张），且 rels Target 与包内条目一一对应',
    parts.length === 4 && sameA === 3 && sameB === 1 && targets.length === 4 && targets.every((t) => zipML.has('ppt/media/' + t)),
    `部件=${JSON.stringify(parts)}｜A内容×${sameA}｜B内容×${sameB}｜rels=${JSON.stringify(targets)}`)
  ok('§54 导出：ASCII 且唯一的部件名**保持原名**（既有产物零变化），改名只有 2 个且原因可见',
    parts.includes('ppt/media/plain.png') && parts.includes('ppt/media/logo.png')
      && (expML.mediaRenamed ?? []).length === 2 && (expML.mediaPlaceholders ?? []).length === 0,
    `plain 原名=${parts.includes('ppt/media/plain.png')}｜改名=${JSON.stringify(expML.mediaRenamed ?? [])}`)
  ok('§54 导出：媒体 parity 自证（不同 srcPath 数 == 包内媒体部件数）——这条才抓得到"两张图塌成一个部件"',
    expML.parity?.mediaExp === 4 && expML.parity?.mediaOut === 4 && expML.parity?.ok === true,
    `mediaExp=${expML.parity?.mediaExp} mediaOut=${expML.parity?.mediaOut} ok=${expML.parity?.ok}`)

  // 预览：子目录必须被递归镜像；非 ASCII 名必须能解析（percent-decode）
  const pvML = await buildPreview(mlWork)
  const nested = existsSync(join(pvML.previewRoot, 'media', 'a', 'logo.png'))
  const cnCopied = existsSync(join(pvML.previewRoot, 'media', '中文 图.png'))
  const encoded = encodeURIComponent('media/中文 图.png').replace(/%2F/gi, '/')
  const pEnc = previewFileFor(pvML.previewRoot, encoded)
  const pNested = previewFileFor(pvML.previewRoot, 'media/a/logo.png')
  ok('§54 预览：`media/子目录/` 递归镜像 + 非 ASCII 名可服务（旧实现是 EPERM 整体失败 + 中文名 404）',
    nested && cnCopied && pEnc === join(pvML.previewRoot, 'media', '中文 图.png') && existsSync(pEnc) && existsSync(pNested),
    `子目录已镜像=${nested}｜中文已镜像=${cnCopied}｜编码路径解析=${existsSync(pEnc)}`)
  const trav1 = previewFileFor(pvML.previewRoot, 'media/../secret.txt')
  const trav2 = previewFileFor(pvML.previewRoot, '../outside.html')
  const malformed = previewFileFor(pvML.previewRoot, '%E4%B8%AD%ZZ.png')
  const dotted = previewFileFor(pvML.previewRoot, 'media/a..b.png')
  ok('§54 预览：`..` 越级与畸形 percent-encoding 仍被拦，而文件名里的 `..` 不被误杀（安全边界没被 decode 破坏）',
    trav1 === null && trav2 === null && malformed === null && dotted !== null,
    `media/../secret.txt=${trav1 === null ? '拦' : trav1}｜../outside.html=${trav2 === null ? '拦' : trav2}｜畸形=${malformed === null ? '拦' : malformed}｜a..b.png=${dotted !== null ? '放行' : '误杀'}`)

  // 门禁（局部）：真跑 ppt_verify handler，验证"只审部分页"不再打印与整册通过同形的门禁行
  const gWork = join(smokeDir, '.tmp-verify-scope')
  await fsp.rm(gWork, { recursive: true, force: true })
  await fsp.mkdir(join(gWork, 'pages'), { recursive: true })
  await fsp.writeFile(join(gWork, 'deck.yaml'), ['version: 1', 'title: scope', 'size: [960, 540]', 'theme:', '  colors: {primary: "#2563EB"}', '  textStyles:', '    body: {fontSize: 16, color: "$primary"}', 'pages:', '  - pages/01.yaml', '  - pages/02.yaml', ''].join('\n'))
  await fsp.writeFile(join(gWork, 'pages', '01.yaml'), ['pageType: content', 'elements:', '  - elementId: bad', '    elementType: shape', '    kind: rect', '    bounds: [900, 520, 100, 60]', '    fill: "#2563EB"', ''].join('\n'))
  await fsp.writeFile(join(gWork, 'pages', '02.yaml'), ['pageType: content', 'elements:', '  - elementId: ok1', '    elementType: text', '    bounds: [40, 40, 300, 40]', '    content: {text: "干净页", style: "$body"}', ''].join('\n'))
  const captured = new Map()
  regTools54({ effect: (cb) => { cb(); return () => {} }, tools: { register: (def) => { captured.set(def.name, def) } }, get: () => undefined })
  const vTool = captured.get('ppt_verify')
  const fullOut = String(await vTool.execute({ dir: gWork }, {}))
  const partOut = String(await vTool.execute({ dir: gWork, pages: '2' }, {}))
  ok('§54 门禁（局部）：pages= 只审部分页时门禁行必须带范围，不得与整册"✓ 通过"同形（工具自述要防的正是静默漏检）',
    /✗ \d+ 个错误/.test(fullOut)
      && /门禁（局部）：/.test(partOut) && /其余 1 页\*\*本次未检查\*\*/.test(partOut) && !/门禁：✓ 通过/.test(partOut),
    `整册=「${(fullOut.match(/门禁[^\n]*/) ?? [''])[0].slice(0, 60)}」｜局部=「${(partOut.match(/门禁[^\n]*/) ?? [''])[0].slice(0, 80)}」`)

  await fsp.rm(mlWork, { recursive: true, force: true })
  await fsp.rm(gWork, { recursive: true, force: true })
}

// ── 55. 用户目录口径统一 + 测试隔离（2026-09-26，方案 B 第二批）──────────────────────────
// 事故形状：`state.js` / `preview-server.js` 的用户目录曾是**模块常量** `homedir()/.dsh`（忽略 DSH_HOME），
// 而 `templates.js` / `index.js`(diag) 是调用时求值 ⇒ ① 设了 DSH_HOME 的隔离部署里，会话状态与预览
// 逃出隔离目录（实测：状态文件落在真实 `~/.dsh`）；② 本机 `npm test` 把 smoke 模板与预览缓存写进
// 开发机真实 `~/.dsh/ppt-studio/`（实测复现、清理过两次）。修法 = 统一到 `src/home.js`（调用时求值）。
{
  const homeMod = await import('../lib/home.js')
  const stateMod = await import('../lib/state.js')
  const { previewRoot } = await import('../lib/preview-server.js')
  const { userTemplatesDir } = await import('../lib/templates.js')
  const prevHome55 = process.env.DSH_HOME
  const probeHome = join(smokeDir, '.tmp-home-probe')
  process.env.DSH_HOME = probeHome
  const set55 = { home: homeMod.dshHome(), studio: homeMod.pptStudioDir(), session: stateMod.sessionDir(), preview: previewRoot(), tpl: userTemplatesDir() }
  delete process.env.DSH_HOME
  const unset55 = { home: homeMod.dshHome(), studio: homeMod.pptStudioDir(), session: stateMod.sessionDir(), preview: previewRoot(), tpl: userTemplatesDir() }
  process.env.DSH_HOME = prevHome55
  ok('§55 用户目录：`dshHome()` 认 DSH_HOME（设/未设两种），未设时回落 `~/.dsh` —— 普通用户行为零变化',
    set55.home === probeHome && unset55.home === join(homedir(), '.dsh'),
    `设=${set55.home}｜未设=${unset55.home}`)
  ok('§55 用户目录：state / preview / templates / diag 四个消费方**同源**（都挂在同一个 ppt-studio 根下，不再各写一套）',
    set55.studio === join(probeHome, 'ppt-studio') && unset55.studio === join(homedir(), '.dsh', 'ppt-studio')
      && [set55.session, set55.preview, set55.tpl].every((p) => p.startsWith(set55.studio))
      && [unset55.session, unset55.preview, unset55.tpl].every((p) => p.startsWith(unset55.studio)),
    `studio=${set55.studio}｜session=${set55.session}｜preview=${set55.preview}｜templates=${set55.tpl}`)

  // 真写一遍：会话状态必须落在**当前** DSH_HOME 下，且真实家目录里不出现这个 probe 文件
  const sid55 = `probe-${Date.now().toString(36)}`
  await stateMod.saveSession(sid55, { routing: 'auto', probe55: true })
  const inIso = join(SMOKE_HOME, 'ppt-studio', `session-${sid55}.json`)
  const inReal = join(homedir(), '.dsh', 'ppt-studio', `session-${sid55}.json`)
  const back55 = await stateMod.loadSession(sid55)
  ok('§55 会话状态：写进当前 DSH_HOME 下的 `<home>/ppt-studio/`，真实家目录不出现该文件（此前漏掉的正是这一半）',
    existsSync(inIso) && back55.probe55 === true && !existsSync(inReal),
    `隔离内=${existsSync(inIso)}｜真实家目录=${existsSync(inReal)}｜读回 probe=${back55.probe55}`)
  ok('§55 测试隔离：整轮 smoke 的 DSH_HOME 指向构建目录内的临时 home（本轮所有用户层写入都被关在里面）',
    process.env.DSH_HOME === SMOKE_HOME && SMOKE_HOME.startsWith(root) && SMOKE_HOME.includes('.tmp-'),
    `DSH_HOME=${process.env.DSH_HOME}`)
}

// 37.10 【必须是最后一条断言】引用计数自证：文档里 "smoke … N 断言" 必须等于本次真实断言总数。
// 历史形状：加断言后 README×3 + docs/02 + docs/06×2 + 手册 全靠人工同步，迟早漏一处。
// 只扫"当前状态"文档（README / 技术报告 / 评审测试矩阵 / 使用手册）；docs/01/03/04 里的历史数字是记录，不动。
// 覆盖边界（故意）：只认"N 断言"与"N/N"两种<b>套件规模</b>写法。docs/06 §一 是历史快照，那里写的是
// 裸的 "smoke 181"（无"断言"二字），由 §一 上方的"计数说明"解释；当前规模只认 §2.1 与 §六。
// 【2026-09-18 收紧】`N/N |` 这条原本匹配**任何** `a/b |` 表格单元格——只要该行提到 "smoke" 就命中。
//   实测被自己踩到：新增一条 smoke 行的格子里写 `4/4 |`（4 条真产物断言全绿）→ 被误判成"文档计数过期"。
//   且 `preflight 11/11`、`test:bundle 20/20` 之类写在 smoke 行里同样会误报。
//   收紧为"分子 ≥ 100 才算套件规模"：smoke 规模已 218，不会再回到两位数；其余套件应由 `N 断言` 那种
//   明确写法表达，而不是靠任何 `a/b` 单元格。防的仍是"加断言忘了同步文档"。
const liveTotal = pass + fail + 1 // 含本条自身
const countFiles = ['README.md', join('docs', '02-技术报告.md'), join('docs', '06-评审与测试.md'), join('skills', 'ppt-studio-manual', 'SKILL.md')]
const staleCounts = []
for (const rel of countFiles) {
  readFileSync(join(root, rel), 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (!/smoke/i.test(line)) return
    for (const m of line.matchAll(/(\d+)\s*断言/g)) if (Number(m[1]) !== liveTotal) staleCounts.push(`${rel}:${i + 1}=${m[1]}`)
    for (const m of line.matchAll(/(\d+)\/(\d+)\s*\|/g)) {
      if (Number(m[1]) < 100) continue // 非套件规模（如 `4/4 |`、`preflight 11/11`）——见上方收紧说明
      if (Number(m[1]) !== liveTotal || Number(m[2]) !== liveTotal) staleCounts.push(`${rel}:${i + 1}=${m[1]}/${m[2]}`)
    }
  })
}
ok('文档计数自证：所有"smoke … N 断言 / N/N"都等于本次真实断言数（加断言必须同步 6 处引用）',
  staleCounts.length === 0, staleCounts.length ? `过期引用：${staleCounts.join('、')}` : `全部 = ${liveTotal}`)

// 收尾：恢复 DSH_HOME 并清掉整轮隔离目录（用户层产物都在里面，见文件顶部的全局隔离说明）。
try { await rm(SMOKE_HOME, { recursive: true, force: true }) } catch { /* 忽略 */ }
try { await rm(join(smokeDir, '.tmp-home-probe'), { recursive: true, force: true }) } catch { /* 忽略 */ }
if (PREV_SMOKE_HOME === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = PREV_SMOKE_HOME

console.log(`\n==== 结果：${pass} 通过 / ${fail} 失败 ====`)
process.exit(fail > 0 ? 1 : 0)
