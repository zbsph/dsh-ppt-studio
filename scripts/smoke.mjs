/**
 * 冒烟测试：examples/smoke 全链路
 * check → render → verify → export(pptx) → zip 结构 → import roundtrip → re-check
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rm, mkdir } from 'node:fs/promises'
import zlib from 'node:zlib'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { importPptx } from '../lib/pptd/import-pptx.js'
import { verifyDeck } from '../lib/verify.js'
import { zipRead } from '../lib/zips.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const smokeDir = join(root, 'examples', 'smoke')

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
  'theme: {colors: {primary: "#2563EB"}}',
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
ok('v0.5：模板库 4 套齐全', tplList.length === 4, tplList.map((t) => t.id).join(','))
ok('v0.5：模板元信息完整（含预览图）', tplList.every((t) => t.name && t.style && t.scene && t.preview), tplList.map((t) => `${t.id}:${t.preview ? 'png' : 'MISSING'}`).join(' '))
let tplAllOk = true
const tplReport = []
for (const t of tplList) {
  // 母版页全部渲染 + verify 0 错误（模板一致性 strict 门禁一并验证）
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
ok('v0.5：4 套模板母版页全渲染 + verify 0 错误（含一致性门禁）', tplAllOk, tplReport.join('; '))
// theme-conformance：出板颜色=ERROR；suggest 档=warning；off=跳过
const confPage = { elements: [{ id: 'x', kind: 'shape', fill: '#123456', bounds: { x: 0, y: 0, w: 10, h: 10 } }] }
ok('v0.5：theme-conformance strict 出板颜色 → ERROR', verifyDeck({ size: size960, theme: { colors: { a: '#2563EB' } }, pages: [{ index: 0, name: 'p', safeArea: null, overlapMode: 'declared', expectedOverlaps: [], expectedOutOfSafeArea: [], elements: [{ id: 'x', kind: 'shape', fill: '#123456', bounds: { x: 0, y: 0, w: 10, h: 10 } }] }] }).text.includes('[✗] theme-conformance'))
ok('v0.5：中性色豁免 + 主题色通过', !verifyDeck({ size: size960, theme: { colors: { a: '#2563EB' } }, pages: [{ index: 0, name: 'p', safeArea: null, overlapMode: 'declared', expectedOverlaps: [], expectedOutOfSafeArea: [], elements: [{ id: 'x', kind: 'shape', fill: '#FFFFFF', bounds: { x: 0, y: 0, w: 10, h: 10 } }, { id: 'y', kind: 'shape', fill: '#2563EB', bounds: { x: 0, y: 0, w: 10, h: 10 } }] }] }).text.includes('theme-conformance'))
ok('v0.5：themeConformance off 跳过', !verifyDeck({ size: size960, theme: { colors: { a: '#2563EB' }, themeConformance: 'off' }, pages: [{ index: 0, name: 'p', safeArea: null, overlapMode: 'declared', expectedOverlaps: [], expectedOutOfSafeArea: [], elements: [{ id: 'x', kind: 'shape', fill: '#123456', bounds: { x: 0, y: 0, w: 10, h: 10 } }] }] }).text.includes('theme-conformance'))
// ppt_new --template 复制工作区
const tplWS = join(root, 'examples', 'tpl-work')
await rm(tplWS, { recursive: true, force: true })
const tplT = await tplMod.templateWorkspace('business-blue')
await mkdir(join(tplWS, 'pages'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(tplWS, 'deck.yaml'), tplT.deck.replace(/^title:.*$/m, 'title: "demo"'))
for (const p of tplT.pages) await (await import('node:fs/promises')).writeFile(join(tplWS, p.ref), p.yaml)
const ctxTW = await resolveDeck(tplWS)
ok('v0.5：模板工作区可校验（theme 完整）', ctxTW.theme.colors.primary === '#1E4E8C' && tplT.pages.length >= 6, `${tplT.pages.length} pages`)

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
await (await import('node:fs/promises')).rm(join(tplMod.TEMPLATES_DIR, regId), { recursive: true, force: true })

// ── 19. v0.6.0：对话内预览（ppt_preview）——预览根构建 + 同源相对 URL ────
const { buildPreview } = await import('../lib/preview-server.js')
const pv = await buildPreview(bandDeck)
ok('v0.6：预览构建（token/相对 URL/页数）', pv.token.length === 10 && pv.url.includes('/ppt-preview/') && pv.overviewUrl.endsWith('/pages/deck.html') && pv.pages === 3, pv.url)
const pvPages = await (await import('node:fs/promises')).readdir(join(pv.previewRoot, 'pages'))
ok('v0.6：预览根 pages 完整（3 页 + 整览）', pvPages.includes('deck.html') && pvPages.filter((f) => f.endsWith('.html')).length === 4)
const pvMedia = await buildPreview(mediaDeck)
ok('v0.6：预览根媒体拷贝（../media 引用可解析）', (await (await import('node:fs/promises')).readdir(join(pvMedia.previewRoot, 'media'))).includes('pic.png'))

console.log(`\n==== 结果：${pass} 通过 / ${fail} 失败 ====`)
process.exit(fail > 0 ? 1 : 0)
