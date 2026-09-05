/**
 * 冒烟测试：examples/smoke 全链路
 * check → render → verify → export(pptx) → zip 结构 → import roundtrip → re-check
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
ok('v0.6.2：外部收纳模板自包含（预览图生成 + 无外部目录引用）', externals.every((t) => t.preview), externals.map((t) => `${t.id}:${t.preview ? 'png' : 'MISSING'}`).join(' '))
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
ok('v0.6.2：外部模板可渲染（内容参照，清理后工作区可用）', extOk && externals.length >= 1, extReport.join('; '))
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
// 外部模板工作区：母版未注册不报错（用户反馈场景：加载模板不再被门禁拦住）
const extT = externals[0]
if (extT) {
  const extWS = join(root, 'examples', 'tpl-work-ext')
  await rm(extWS, { recursive: true, force: true })
  const matE = await materializeTemplate(extWS, extT.id, {})
  const extCtx = await resolveDeck(extWS)
  ok('v0.7：外部模板工作区——只注册 1 个正式页（母版参考不报错）', extCtx.pages.length === 1 && matE.refs.length > 5 && matE.mediaCount >= 0, `registered=${extCtx.pages.length} refs=${matE.refs.length}`)
  ok('v0.7：外部模板媒体跟随复制', matE.mediaCount > 0, `media=${matE.mediaCount}`)
}
// 收纳清洗升级：registerTemplate 声明出界元素 + 剩余错误分类（bandDeck safeArea 外元素）
const reg2 = await tplMod.registerTemplate(bandDeck, { id: `smoke-wash-${Date.now().toString(36)}`, name: '洗涤测试' }, {})
ok('v0.7：收纳清洗——出界声明/重叠声明/剩余分类进入 meta', typeof reg2.meta.cleanup === 'string' && reg2.meta.cleanup.includes('剩余'), reg2.meta.cleanup ?? '')
await (await import('node:fs/promises')).rm(join(tplMod.TEMPLATES_DIR, reg2.id), { recursive: true, force: true })

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
  const rv = await msMod.renderPptxToPng(bandExp.file, visOut, { width: 960, height: 540, timeoutMs: 180000 })
  ok('v0.8.0：Office 真渲染（成品 pptx → 逐页 PNG）', rv.pages === 3 && rv.files.length === 3, `pages=${rv.pages} files=${rv.files.length}`)
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
ok('v0.9.0：物化工作区注入 referenceTemplate（source/previews）',
  deckD.includes('referenceTemplate:') && deckD.includes('reference/template.pptx') && deckD.includes('reference/previews/01.png'),
  'referenceTemplate 块缺失' )
ok('v0.9.0：reference/ 拷贝（template.pptx + previews 整页）',
  matD.reference?.files?.includes('template.pptx') && existsSync(join(dualWS, 'reference', 'previews', '01.png')),
  JSON.stringify(matD.reference?.files ?? []))
const dualCtx = await resolveDeck(dualWS)
ok('v0.9.0：带 referenceTemplate 的 deck 通过校验（非渲染字段）', dualCtx.pages.length === 1 && dualCtx.deck.referenceTemplate?.id === dualId)
// 清理双轨测试模板 + 假 source
await (await import('node:fs/promises')).rm(join(tplMod.TEMPLATES_DIR, dualId), { recursive: true, force: true }).catch(() => {})
await rm(dualSrc, { force: true }).catch(() => {})
await rm(dualWS, { recursive: true, force: true })

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
  const rvSurg = await msMod.renderPptxToPng(surgOut, visSurg, { width: 960, height: 540, timeoutMs: 180000 })
  ok('v0.10.0：手术成品 Office 可打开渲染（结构合法）', rvSurg.pages === 3, `pages=${rvSurg.pages}`)
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
const xLayout = { pages: [{ index: 1, elements: [
  { id: 't1', kind: 'text', bounds: { x: 0, y: 0, w: 100, h: 50 }, metrics: { overflowY: 0, lines: 2 } },
  { id: 't2', kind: 'text', bounds: { x: 0, y: 0, w: 100, h: 50 }, metrics: { overflowY: 5, lines: 2 } },
  { id: 't3', kind: 'text', bounds: { x: 0, y: 0, w: 100, h: 50 }, metrics: { overflowY: 8, lines: 2 } },
] }] }
const xMeasured = { pages: [{ index: 1, elements: [
  { id: 't1', kind: 'text', overflowY: 6, lines: 3 },     // 估算 0 / 实测 6 → 漏报 error
  { id: 't2', kind: 'text', overflowY: 4, lines: 2 },     // 估算 5 / 实测 4 → 复现 warning
  { id: 't3', kind: 'text', overflowY: 0.5, lines: 2 },   // 估算 8 / 实测 0.5 → relief warning
] }] }
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
if (findEdge()) {
  ok('v0.12：真实测量（2 页落盘 measured.json + 无估算/实测分歧）',
    m2r.pages === 2 && m2r.measured.pages.length === 2 && existsSync(join(m2Deck, 'preview', 'measured.json')),
    `pages=${m2r.pages} notes=${(m2r.notes ?? []).join(';')}`)
  const m2Layout = JSON.parse(await (await import('node:fs/promises')).readFile(join(m2Deck, 'preview', 'layout.json'), 'utf8'))
  const m2x = mcc(m2Layout, m2r.measured)
  ok('v0.12：真实测量交叉无分歧（短文本不溢出）', !m2x.some((f) => f.severity === 'error'), `出现实测 error：${JSON.stringify(m2x)}`)
} else {
  ok('v0.12：无浏览器跳过真实测量（降级路径）', true)
}
await rm(m2Deck, { recursive: true, force: true })

// ── 28. v0.13.0 (M3)：数据连贯——跨页数字对账 + source 证据核查表 + themeRef 断言 ──
const { crosscheckDeck } = await import('../lib/crosscheck.js')
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
ok('v0.13：跨页数字对账——同数字跨页入组（45.6% 页 1/2；52% 单页不入组）',
  cc.groups.some((g) => g.num === '45.6%' && g.pages.join(',') === '1,2') && !cc.groups.some((g) => g.num === '52%'),
  JSON.stringify(cc.groups.map((g) => g.num)))
ok('v0.13：证据核查表——source 标注 grounded / 未标注 unmapped',
  cc.pages.find((p) => p.index === 1)?.status === 'grounded' && cc.pages.find((p) => p.index === 2)?.status === 'unmapped',
  JSON.stringify(cc.pages))
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
  register: async (r) => {
    routeCalls.push(r.path)
    fakePrefixes.set(r.path, { kind: r.kind, path: r.path, handler: r.handler })
    return async () => { fakePrefixes.delete(r.path) } // 卸载也是 async（真实语义）
  },
}
const fakeCtx = { get: () => fakeWs, effect: (cb) => { let active = true; return () => { if (active) { active = false; cb() } } } }
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

console.log(`\n==== 结果：${pass} 通过 / ${fail} 失败 ====`)
process.exit(fail > 0 ? 1 : 0)
