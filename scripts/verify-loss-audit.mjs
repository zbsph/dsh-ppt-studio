#!/usr/bin/env node
/**
 * verify-loss-audit —— 启发 B（审计半）自证：合成 OOXML 造正例/反例，断言
 * `src/pptd/loss-audit.js` 的类别计数、证据结构、报告文案与 `ppt_import` 落盘集成。
 *
 * 为什么用合成片段而不是真 PPT：判据是"XML 里有没有这些节点"，合成片段足以证明；
 * 真装 PowerPoint 反而让测试不可重复（官方 office 技能同理：结构自证 > 工具链依赖）。
 *
 * 覆盖：
 *   反例（防误报）：干净 deck 0 命中——**且刻意塞入真实世界的噪声源**：空 `<a:effectLst/>`、
 *                   主题 `effectStyleLst` 里的 3 个空 effectLst、可内嵌的 png。
 *   正例（防漏报）：p:timing / a:effectLst+outerShdw+glow / a:hlinkClick+hlinkHover /
 *                   p:transition / SmartArt（graphicData diagram + dgm 部件）/ EMF+MP4+OLE /
 *                   主题渐变 + p:bg 渐变；并验证**形状渐变不计**（有直通，属防误报）。
 *   集成：importPptx 落盘 loss-audit.json + 返回 lossLine；既有产物（deck.yaml/pages/import-styles.json）不受影响。
 *
 * 用法：node scripts/build.mjs && node scripts/verify-loss-audit.mjs   （退出码 0=PASS / 1=FAIL）
 * 注意：脚本从 **lib/** 导入（测的就是插件实际装载的产物；lib 与 src 一致性由 check-lib-freshness/smoke 守）。
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const libFile = (...p) => pathToFileURL(join(root, 'lib', ...p)).href
if (!existsSync(join(root, 'lib', 'pptd', 'loss-audit.js'))) {
  console.error('✗ 缺 lib/pptd/loss-audit.js —— 先跑 `node scripts/build.mjs`（本脚本测 lib 产物，与 smoke 同口径）')
  process.exit(1)
}
const { auditLoss, auditLossFromBuffer, lossAuditLine, LOSS_AUDIT_FILE } = await import(libFile('pptd', 'loss-audit.js'))
const { importPptx } = await import(libFile('pptd', 'import-pptx.js'))
const { zipWrite, zipRead } = await import(libFile('zips.js'))

// ── 断言器 ────────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

// ── 合成 OOXML 夹具 ───────────────────────────────────────────────────────
const XD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const GRAD = '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="1F2937"/></a:gs><a:gs pos="100000"><a:srgbClr val="2E4B9F"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
const EFFECT_2 = '<a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw><a:glow rad="63500"><a:srgbClr val="2E4B9F"><a:alpha val="60000"/></a:srgbClr></a:glow></a:effectLst>'
const EFFECT_GLOW = '<a:effectLst><a:glow rad="63500"><a:srgbClr val="2E4B9F"/></a:glow></a:effectLst>'
const EMPTY_EFFECT = '<a:effectLst/>'
const ANIM_TIMING = '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" fill="hold"><p:childTnLst><p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="2" dur="500"/><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
const TRANSITION = '<p:transition spd="slow"><p:fade/></p:transition>'

const txtSp = (id, text, { rPr = '', spPr = '' } = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="3000000" cy="800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${spPr}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1800">${rPr}</a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`

const rectSp = (id, spPr) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="3" name="${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1000000" y="2000000"/><a:ext cx="3000000" cy="1500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${spPr}</p:spPr></p:sp>`

const smartArtFrame = () =>
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="SmartArt 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1000000" y="3000000"/><a:ext cx="3000000" cy="1500000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId1" r:lo="rId2"/></a:graphicData></a:graphic></p:graphicFrame>'

const videoPic = () =>
  '<p:pic><p:nvPicPr><p:cNvPr id="10" name="视频 1"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rId7"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId8"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="4000000" y="3000000"/><a:ext cx="2000000" cy="1200000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'

const slideXml = ({ cSldHead = '', body = '', tail = '' }) =>
  `${XD}<p:sld ${NS}><p:cSld>${cSldHead}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld>${tail}</p:sld>`

/** 主题：刻意带 3 个空 `a:effectLst`（真实模板/我们自己的导出都有）+ 可控的渐变模板。
 *  `bgGrad` → bgFillStyleLst 第 1 项 = 渐变（可被 master 的 bgRef idx=1001 引用到 ⇒ visible）；
 *  `fillGrad` → fillStyleLst 第 1 项 = 渐变（本夹具无人 fillRef ⇒ visible:false 样式表模板）。 */
const themeXml = ({ bgGrad = false, fillGrad = false } = {}) =>
  `${XD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="fixture"><a:themeElements><a:clrScheme name="c"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1></a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme><a:fmtScheme name="s"><a:fillStyleLst>${fillGrad ? GRAD : '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'}<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle>${EMPTY_EFFECT}</a:effectStyle><a:effectStyle>${EMPTY_EFFECT}</a:effectStyle><a:effectStyle>${EMPTY_EFFECT}</a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${bgGrad ? GRAD : '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

const presentationXml = (n) =>
  `${XD}<p:presentation ${NS}><p:sldIdLst>${Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`

const presentationRels = (n) =>
  `${XD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`

const contentTypes = (n, extraExts = []) =>
  `${XD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${extraExts.map((e) => `<Default Extension="${e}" ContentType="application/octet-stream"/>`).join('')}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${Array.from({ length: n }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`

const ROOT_RELS = `${XD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
const SLIDE_RELS = `${XD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`

/** 干净 deck：只有文本；噪声源齐备（空 effectLst / 主题 effectStyleLst / 可内嵌 png）。 */
function cleanPptx() {
  return {
    '[Content_Types].xml': contentTypes(2),
    '_rels/.rels': ROOT_RELS,
    'ppt/presentation.xml': presentationXml(2),
    'ppt/_rels/presentation.xml.rels': presentationRels(2),
    'ppt/slides/slide1.xml': slideXml({ cSldHead: '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>' + EMPTY_EFFECT + '</p:bgPr></p:bg>', body: txtSp('Title 1', '干净第一页') }),
    'ppt/slides/slide2.xml': slideXml({ body: txtSp('Title 2', '干净第二页') + rectSp('Box 2', '<a:solidFill><a:srgbClr val="EEEEEE"/></a:solidFill>' + EMPTY_EFFECT) }),
    'ppt/slides/_rels/slide1.xml.rels': SLIDE_RELS,
    'ppt/slides/_rels/slide2.xml.rels': SLIDE_RELS,
    'ppt/theme/theme1.xml': themeXml({ bgGrad: false, fillGrad: false }),
    'ppt/media/photo.png': Buffer.from('fake-png-bytes'),
  }
}

/** 主题样式表专用 deck：只有一个**没被任何 bgRef/fillRef 引用**的主题渐变（python-pptx 风格默认主题就是这个形态）。
 *  期望：total 1 / visibleTotal 0 / themeStyleOnly true → 报告降级为 ℹ，不谎报"会丢可见效果"。 */
function themeOnlyPptx() {
  const e = cleanPptx()
  e['ppt/theme/theme1.xml'] = themeXml({ bgGrad: true, fillGrad: true })
  return e
}

/**
 * 脏 deck（正例）：7 类全命中，并且埋了 4 个"不该计"的陷阱：
 * ① 主题空的 effectLst（×3）不计；② 形状渐变（spPr/gradFill）不计；③ 可内嵌 photo.png 不计；
 * ④ 主题 fillStyleLst 渐变无人 fillRef → 计 1 处但 visible:false（不进入"会丢可见效果"计数）。
 * 主题 bgFillStyleLst 第 1 项渐变被 slideMaster1 的 `<p:bgRef idx="1001"/>` 引用 ⇒ visible:true。
 * 期望计数：animation 2 / effect 3 / hyperlink 3 / transition 1 / smartart 1 / media 4 / gradient 3 = 17（visible 16）
 */
function dirtyPptx() {
  const slide1 = slideXml({
    body: txtSp('Title 1', '带链接', { rPr: '<a:hlinkClick r:id="rId9" action="ppaction://hlinksldjump"/>' })
      + rectSp('Card 1', EFFECT_2)                                   // effectLst(outerShdw+glow) → effect 1
      + rectSp('GradCard', GRAD)                                     // 形状渐变 → 不计（陷阱 ②）
      + smartArtFrame(),                                             // smartart 1
    tail: TRANSITION + ANIM_TIMING,                                  // transition 1 + animation 1
  })
  const slide2 = slideXml({
    cSldHead: '<p:bg><p:bgPr>' + GRAD + EMPTY_EFFECT + '<a:effectLst/></p:bgPr></p:bg>', // 背景渐变 1（空 effectLst 不计）
    body: txtSp('Title 2', '点击链接', { rPr: '<a:hlinkClick r:id="rId9"/>' })
      + txtSp('Title 3', '悬停链接', { rPr: '<a:hlinkHover r:id="rId9"/>' })
      + rectSp('Card 2', EFFECT_GLOW)                                // effectLst(glow) → effect 1
      + rectSp('ShadowCard', '<a:prstShdw prst="shdw1" dist="20000" dir="5400000"/>') // 裸效果节点 → effect 1
      + videoPic(),                                                  // 幻灯片内音视频引用 → media 1
    tail: ANIM_TIMING,                                               // animation 1
  })
  return {
    '[Content_Types].xml': contentTypes(2, ['emf', 'mp4', 'bin']),
    '_rels/.rels': ROOT_RELS,
    'ppt/presentation.xml': presentationXml(2),
    'ppt/_rels/presentation.xml.rels': presentationRels(2),
    'ppt/slides/slide1.xml': slide1,
    'ppt/slides/slide2.xml': slide2,
    'ppt/slides/_rels/slide1.xml.rels': SLIDE_RELS,
    'ppt/slides/_rels/slide2.xml.rels': SLIDE_RELS,
    'ppt/theme/theme1.xml': themeXml({ bgGrad: true, fillGrad: true }), // 主题渐变 2（1 被引用 + 1 样式表模板）
    // 母版：背景引用 bgFillStyleLst 第 1 项（= 上面的主题渐变）→ 该主题渐变 visible:true
    'ppt/slideMasters/slideMaster1.xml': `${XD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldMaster>`,
    // 备注母版的 fillRef idx=1 指向 fillStyleLst 第 1 项渐变——**不得**因此判 visible（备注页不参与放映观感）
    'ppt/notesMasters/notesMaster1.xml': `${XD}<p:notesMaster ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="1"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style></p:sp></p:spTree></p:cSld></p:notesMaster>`,
    'ppt/diagrams/data1.xml': `${XD}<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>`,
    'ppt/diagrams/layout1.xml': `${XD}<dgm:layoutDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>`,
    'ppt/media/vector.emf': Buffer.from('fake-emf'),
    'ppt/media/clip.mp4': Buffer.from('fake-mp4'),
    'ppt/media/photo.png': Buffer.from('fake-png-bytes'),            // 可内嵌 → 不计（陷阱 ③）
    'ppt/embeddings/oleObject1.bin': Buffer.from('fake-ole'),
  }
}

const EXPECT_DIRTY = { animation: 2, effect: 3, hyperlink: 3, transition: 1, smartart: 1, media: 4, gradient: 3 }
const EXPECT_DIRTY_VISIBLE = { animation: 2, effect: 3, hyperlink: 3, transition: 1, smartart: 1, media: 4, gradient: 2 }
const CATEGORY_IDS = ['animation', 'effect', 'hyperlink', 'transition', 'smartart', 'media', 'gradient']
const cat = (r, id) => r.categories.find((c) => c.id === id)

// ── 跑 ────────────────────────────────────────────────────────────────────
const work = await mkdtemp(join(tmpdir(), 'verify-loss-audit-'))
try {
  const cleanEntries = cleanPptx()
  const dirtyEntries = dirtyPptx()
  const cleanBuf = zipWrite(cleanEntries)
  const dirtyBuf = zipWrite(dirtyEntries)

  section('A. 反例：干净 deck（含真实噪声源）→ 0 命中（防误报）')
  const clean = auditLossFromBuffer(cleanBuf, { source: 'clean.pptx' })
  check('total === 0 且 clean === true', clean.total === 0 && clean.clean === true, JSON.stringify(clean.counts))
  check('7 个类别齐全、顺序固定、计数全 0', JSON.stringify(clean.categories.map((c) => c.id)) === JSON.stringify(CATEGORY_IDS) && CATEGORY_IDS.every((id) => cat(clean, id).count === 0))
  check('空 <a:effectLst/>（页面 + 主题 effectStyleLst×3）不计为阴影', cat(clean, 'effect').count === 0 && !clean.categories.some((c) => c.evidence.some((e) => /theme/.test(e.part))))
  check('干净源稿报告文案 = 一行"未发现"，且不出现手术建议', lossAuditLine(clean).includes('未发现') && !lossAuditLine(clean).includes('ppt_splice'), lossAuditLine(clean))

  section('B. 正例：含动画/阴影/超链接/切换/SmartArt/不可嵌入媒体/渐变 → 类别与计数正确')
  const dirty = auditLossFromBuffer(dirtyBuf, { source: 'dirty.pptx' })
  const totalExpected = Object.values(EXPECT_DIRTY).reduce((a, b) => a + b, 0)
  check(`total === ${totalExpected}；visibleTotal === ${totalExpected - 1}（1 处主题样式表渐变未被引用）`,
    dirty.total === totalExpected && dirty.visibleTotal === totalExpected - 1 && dirty.themeStyleOnly === false,
    `total=${dirty.total} visibleTotal=${dirty.visibleTotal}`)
  for (const [id, n] of Object.entries(EXPECT_DIRTY)) {
    check(`${id} === ${n}（visible ${EXPECT_DIRTY_VISIBLE[id]}）`, cat(dirty, id).count === n && cat(dirty, id).visible === EXPECT_DIRTY_VISIBLE[id], `实际 count=${cat(dirty, id).count} visible=${cat(dirty, id).visible}：${JSON.stringify(cat(dirty, id).evidence.map((e) => e.detail))}`)
  }
  check('动画证据带页码 1/2（页码级）', JSON.stringify(cat(dirty, 'animation').evidence.map((e) => e.page)) === '[1,2]', JSON.stringify(cat(dirty, 'animation').evidence))
  check('阴影证据 = 元素级：outerShdw+glow 容器 1 处 + glow 容器 1 处 + 裸 prstShdw 1 处', JSON.stringify(cat(dirty, 'effect').evidence.map((e) => e.element)) === '["Card 1","Card 2","ShadowCard"]', JSON.stringify(cat(dirty, 'effect').evidence.map((e) => [e.element, e.kinds])))
  check('theme 部件不出现在阴影证据里（主题 effectStyleLst 不计）', !cat(dirty, 'effect').evidence.some((e) => /theme/.test(e.part)))
  check('超链接分辨 click ×2 + hover ×1', JSON.stringify(cat(dirty, 'hyperlink').evidence.map((e) => e.subtype)) === '["click","click","hover"]', JSON.stringify(cat(dirty, 'hyperlink').evidence.map((e) => e.subtype)))
  check('页切换带类型（p:fade）', cat(dirty, 'transition').evidence[0]?.type === 'fade' && cat(dirty, 'transition').evidence[0]?.page === 1)
  check('SmartArt 记 1 处（2 个 dgm 部件不放大）且证据含 SmartArt 元素名', cat(dirty, 'smartart').evidence[0]?.element === 'SmartArt 1' && /2 个 SmartArt 图部件/.test(cat(dirty, 'smartart').evidence[0]?.detail ?? ''), JSON.stringify(cat(dirty, 'smartart').evidence))
  check('不可嵌入媒体 4 处：emf / mp4 / OLE 部件 / 幻灯片内 videoFile（photo.png 不计）', JSON.stringify(cat(dirty, 'media').evidence.map((e) => e.ext).sort()) === JSON.stringify(['bin', 'emf', 'mp4', 'video']), JSON.stringify(cat(dirty, 'media').evidence.map((e) => [e.ext, e.reason])))
  check('渐变 3 处：p:bg 背景 1（visible）+ 主题 2（bgRef 引用的 visible / fillStyleLst 无引用的不 visible）——形状渐变不计（包内 gradFill 实为 4）',
    JSON.stringify(cat(dirty, 'gradient').evidence.map((e) => [e.scope, e.visible])) === JSON.stringify([['background', true], ['theme', true], ['theme', false]])
    && (String(dirtyEntries['ppt/slides/slide1.xml']).match(/<a:gradFill/g) ?? []).length === 1
    && (String(dirtyEntries['ppt/slides/slide2.xml']).match(/<a:gradFill/g) ?? []).length === 1
    && (String(dirtyEntries['ppt/theme/theme1.xml']).match(/<a:gradFill/g) ?? []).length === 2
    && JSON.stringify(dirty.themeRefs) === JSON.stringify({ bgRef: [1001], fillRef: [] })
    && cat(dirty, 'gradient').evidence.every((e) => e.tag === 'gradFill' && e.count === 2),
    JSON.stringify(cat(dirty, 'gradient').evidence))
  check('备注母版里的 fillRef 不算"可见引用"（备注页不参与放映观感）', !cat(dirty, 'gradient').evidence.some((e) => e.holder === 'fillStyleLst' && e.visible === true), JSON.stringify(dirty.themeRefs))
  check('每类 count === evidence.length；hitSummary 与命中类别一致（含 visible）', dirty.categories.every((c) => c.count === c.evidence.length) && JSON.stringify(dirty.hitSummary.map((h) => h.id)) === JSON.stringify(CATEGORY_IDS.filter((id) => EXPECT_DIRTY[id] > 0)) && dirty.hitSummary.every((h) => h.count >= h.visible && h.visible >= 0))
  check('source 元数据写入报告', dirty.source === 'dirty.pptx' && clean.source === 'clean.pptx')
  const line = lossAuditLine(dirty)
  check('报告文案含分类计数 + 未引用渐变的限定语 + 就地手术建议', ['动画 2 处', '阴影/发光 3 处', '超链接 3 处', '主题/背景渐变 2 处', '另有 1 处主题样式表渐变未被引用', 'ppt_splice', LOSS_AUDIT_FILE].every((s) => line.includes(s)), line)
  check('JSON 可序列化且往返稳定（写盘格式）', JSON.stringify(JSON.parse(JSON.stringify(dirty))) === JSON.stringify(dirty))
  check('输入形态无关：Map / 普通对象 / [name,data] 数组计数一致',
    JSON.stringify(auditLoss(zipRead(dirtyBuf)).counts) === JSON.stringify(dirty.counts)
    && JSON.stringify(auditLoss(dirtyEntries).counts) === JSON.stringify(dirty.counts)
    && JSON.stringify(auditLoss(Object.entries(dirtyEntries)).counts) === JSON.stringify(dirty.counts))

  section('D. 主题样式表渐变专用 deck（python-pptx 默认主题形态）→ 不谎报"会丢可见效果"')
  const themeOnly = auditLossFromBuffer(zipWrite(themeOnlyPptx()))
  const themeLine = lossAuditLine(themeOnly)
  check('total 2 / visibleTotal 0 / themeStyleOnly true（bgFillStyleLst + fillStyleLst 均无人引用）',
    themeOnly.total === 2 && themeOnly.visibleTotal === 0 && themeOnly.themeStyleOnly === true && themeOnly.categories.every((c) => c.id !== 'gradient' || c.evidence.every((e) => e.visible === false)),
    `total=${themeOnly.total} visible=${themeOnly.visibleTotal}`)
  check('报告降级为 ℹ（不含"会丢这些"的断言，仍给 ppt_splice 指引）',
    themeLine.startsWith('ℹ') && themeLine.includes('未发现会丢的可见效果') && themeLine.includes('不影响观感') && themeLine.includes('ppt_splice'), themeLine)
  check('advice 同步降级（不写"整册重渲会丢上述 N 处可见特性"）', themeOnly.advice.includes('未发现会丢的可见效果'), themeOnly.advice)

  section('C. 集成：ppt_import 落盘 loss-audit.json + 一行结论（既有产物无回归）')
  const cleanFile = join(work, 'clean.pptx')
  const dirtyFile = join(work, 'dirty.pptx')
  await writeFile(cleanFile, cleanBuf)
  await writeFile(dirtyFile, dirtyBuf)
  const cleanOut = join(work, 'out-clean')
  const dirtyOut = join(work, 'out-dirty')
  const rClean = await importPptx(cleanFile, cleanOut)
  const rDirty = await importPptx(dirtyFile, dirtyOut)
  const cleanJson = JSON.parse(await readFile(join(cleanOut, LOSS_AUDIT_FILE), 'utf8'))
  const dirtyJson = JSON.parse(await readFile(join(dirtyOut, LOSS_AUDIT_FILE), 'utf8'))
  check(`干净源稿：${LOSS_AUDIT_FILE} 落盘且 clean=true；工具输出行含"未发现"`, cleanJson.clean === true && cleanJson.total === 0 && rClean.lossLine.includes('未发现'), rClean.lossLine)
  check('脏源稿：JSON 计数与纯函数一致；返回 lossLine 含分类计数 + ppt_splice', JSON.stringify(dirtyJson.counts) === JSON.stringify(EXPECT_DIRTY) && rDirty.lossLine === lossAuditLine(dirtyJson) && rDirty.lossLine.includes('ppt_splice'), rDirty.lossLine)
  check('既有产物无回归（deck.yaml / pages / import-styles.json 仍在）',
    existsSync(join(dirtyOut, 'deck.yaml')) && existsSync(join(dirtyOut, 'pages', 'slide_01.yaml')) && existsSync(join(dirtyOut, 'import-styles.json')))
  check('importPptx 返回结构仍含 pages/media/warnings（未破坏既有消费者）',
    rDirty.pages === 2 && Array.isArray(rDirty.media) && Array.isArray(rDirty.warnings) && typeof rDirty.lossAudit === 'object')
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass}/${pass + fail} 断言通过${fail ? `（${fail} 条失败）` : ''}`)
process.exit(fail === 0 ? 0 : 1)
