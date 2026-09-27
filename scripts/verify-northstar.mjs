#!/usr/bin/env node
/**
 * 阶段 D-③ 北极星端到端自证：`node scripts/verify-northstar.mjs`
 *
 * 场景（docs/07 §2 北极星的**可验证内核**）：拿到一份"参考稿"（风格已经有了），
 * 要在**同一风格**下再加/换一页复杂图。链路：
 *   参考稿 deck → 观测 → 样式档案 → `diagram.style` → IR 布局 → 物化 → 导出
 * 并守住两条硬性质：
 *   ① **其它页逐字节不变**（只多/换了一页，别的页产物不能被扰动）；
 *   ② 新页过真实门禁 0 错误，且取色/线宽确实来自参考稿档案。
 *
 * 注意：夹具是**合成的**（用本插件自己的导出器造参考稿）——仓库不引入任何真实稿素材。
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDeck } from '../lib/pptd/schema.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { verifyDeck } from '../lib/verify.js'
import { zipRead } from '../lib/zips.js'
import { observeFromDeck, extractStyleProfile, profileToTheme } from '../lib/pptd/style-profile.js'

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; failures.push(name); console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const root = join(tmpdir(), `pptd-northstar-${Date.now()}`)
rmSync(root, { recursive: true, force: true })
const refDir = join(root, 'ref')
const newDir = join(root, 'new')
for (const d of [refDir, newDir]) mkdirSync(join(d, 'pages'), { recursive: true })

const THEME = ['theme:', '  colors: {primary: "#0F766E", accent: "#F97316", text: "#0B2B26", bg: "#F0FDFA"}',
  '  textStyles:', '    body: {fontSize: 15, color: "$text"}', '  line: {width: 2}', '  spacing: {base: 26}',
  '  safeArea: {top: 40, bottom: 40, left: 40, right: 40}']
// 参考稿第 1 页：一组"有风格"的色块（供观测）
const refP1 = ['pageType: content', 'expectedOverlaps:',
  '  - {pair: [c3, t1], reason: "标题文字压在色块上（设计意图）"}', 'elements:',
  '  - {elementId: c1, elementType: shape, kind: roundRect, bounds: [60, 80, 400, 160], fill: "$primary"}',
  '  - {elementId: c2, elementType: shape, kind: roundRect, bounds: [500, 80, 400, 160], fill: "#14B8A6"}',
  '  - {elementId: c3, elementType: shape, kind: roundRect, bounds: [60, 280, 840, 120], fill: "$primary", line: {color: "#0B2B26", width: 2}}',
  '  - {elementId: t1, elementType: text, bounds: [80, 340, 800, 30], content: {text: "参考稿", fontSize: 20, color: "$bg"}}',
  ''].join('\n')
// 两版第 2 页：参考稿版（占位）vs 新版本（IR 复杂图）
const refP2 = ['pageType: content', 'elements:', '  - {elementId: ph, elementType: shape, kind: rect, bounds: [60, 80, 840, 400], fill: "$bg"}', ''].join('\n')

const newP2 = ['pageType: content', 'diagram:', '  type: tree', '  style: ref', '  nodes:',
  '    - {id: r, label: 总目标}', '    - {id: a, label: 采集, emphasis: accent}', '    - {id: b, label: 分析}', '    - {id: c, label: 应用, emphasis: accent}',
  '  edges:', '    - {from: r, to: a}', '    - {from: r, to: b}', '    - {from: b, to: c}', ''].join('\n')

const writeDeck = (dir, page2, withProfile) => {
  writeFileSync(join(dir, 'deck.yaml'), ['version: 1', 'title: northstar', 'size: [960, 540]', ...THEME,
    ...(withProfile ? withProfile : []), 'pages:', '  - pages/01.yaml', '  - pages/02.yaml', ''].join('\n'))
  writeFileSync(join(dir, 'pages', '01.yaml'), refP1)
  writeFileSync(join(dir, 'pages', '02.yaml'), page2)
}

// ── ① 参考稿：观测 → 档案 ────────────────────────────────────────────────
writeDeck(refDir, refP2)
const refCtx = await resolveDeck(refDir)
const profile = extractStyleProfile(observeFromDeck(refCtx))
ok('参考稿 → 样式档案：归纳出调色板/底色/线宽（调色板按出现频次排序）',
  profile.palette[0] === '#0F766E' && profile.bg === '#F0FDFA' && profile.lineWidth === 2,
  `palette=${profile.palette.join(',')}｜bg=${profile.bg}｜lineWidth=${profile.lineWidth}`)

// ── ② 新版本：同一本册，第 2 页换成"用参考稿档案画的复杂图" ────────────────
const profileYaml = ['styles:', '  ref:', `    palette: [${profile.palette.map((c) => `"${c}"`).join(', ')}]`,
  `    ink: "${profile.ink}"`, `    bg: "${profile.bg}"`, `    neutral: "${profile.neutral}"`,
  `    lineWidth: ${profile.lineWidth}`, `    fontSize: ${profile.fontSize}`, `    radius: ${profile.radius}`]
writeDeck(newDir, newP2, profileYaml)
const newCtx = await resolveDeck(newDir)
const page2 = newCtx.pages[1].page
const fills2 = [...new Set(page2.elements.filter((e) => e.elementType === 'shape').map((e) => e.fill))]
ok('新页物化：IR 按参考稿档案取色（primary + accent 都在）',
  fills2.includes(profile.palette[0]) && fills2.includes(profile.palette[1]), JSON.stringify(fills2))

await renderDeck(newCtx, { out: 'preview' })
const layout = JSON.parse(readFileSync(join(newDir, 'preview', 'layout.json'), 'utf8'))
const v = verifyDeck(layout)
ok('新页过真实门禁 **0 错误**（档案色板已并入主题色板）', v.errors.length === 0,
  v.errors.length ? v.errors.map((e) => `${e.code}: ${e.message}`).join(' ｜ ') : `警告 ${v.warns.length} 条（审美类）`)

// ── ③ 导出两版，逐部件比较：第 1 页必须逐字节不变 ─────────────────────────
const a = await exportPptx(refCtx, { out: join(root, 'ref.pptx') })
const b = await exportPptx(newCtx, { out: join(root, 'new.pptx') })
const za = zipRead(readFileSync(a.file))
const zb = zipRead(readFileSync(b.file))
const cmp = (name) => {
  const x = za.get(name)
  const y = zb.get(name)
  if (!x || !y) return null
  return x.equals(y)
}
const p1Same = ['ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels', 'ppt/slideLayouts/slideLayout1.xml'].map(cmp)
ok('**其它页逐字节不变**：第 1 页 slide XML / rels / 布局部件在两版之间完全一致',
  p1Same.every((x) => x === true), `比对结果=${JSON.stringify(p1Same)}`)
ok('目标页确实变了（不是"啥都没变"的假绿）', cmp('ppt/slides/slide2.xml') === false)
ok('两版 parity 都自证通过（图/线/文本/媒体逐条对上）', a.parity?.ok === true && b.parity?.ok === true,
  `ref.ok=${a.parity?.ok}｜new.ok=${b.parity?.ok}｜new.attached=${b.parity?.attachedLinesOut}/${b.parity?.attachedLinesExp}`)

// ── ④ 确定性：同一 deck 连续导出两次除时间戳外一致 ────────────────────────
const b2 = await exportPptx(newCtx, { out: join(root, 'new2.pptx') })
const zb2 = zipRead(readFileSync(b2.file))
const names = [...zb.keys()].filter((n) => !/core\.xml$/.test(n))
const diff = names.filter((n) => !zb.get(n).equals(zb2.get(n)))
ok('确定性：同一 deck 两次导出的全部部件逐字节一致（仅 core.xml 时间戳除外）', diff.length === 0, `不一致=${diff.slice(0, 3).join(',') || '无'}`)

// ── ⑤ 无损可控：把 IR 页"摊平"成等价手写元素，两版产物必须逐部件一致 ──────
// 这是"改善显著"的**机械量化**：IR 只让作者少写坐标，不是换一套渲染。
// 摊平后产物一致 ⇒ IR 是手写能力的**无损超级集**（想接管随时可以摊平）。
const flatDir = join(root, 'flat')
mkdirSync(join(flatDir, 'pages'), { recursive: true })
const YAML = (await import('yaml')).default
writeFileSync(join(flatDir, 'deck.yaml'), readFileSync(join(newDir, 'deck.yaml'), 'utf8'))
writeFileSync(join(flatDir, 'pages', '01.yaml'), refP1)
writeFileSync(join(flatDir, 'pages', '02.yaml'), YAML.stringify({ pageType: 'content', elements: page2.elements }))
const flatCtx = await resolveDeck(flatDir)
const c = await exportPptx(flatCtx, { out: join(root, 'flat.pptx') })
const zc = zipRead(readFileSync(c.file))
const flatNames = [...zb.keys()].filter((n) => !/core\.xml$/.test(n))
const flatDiff = flatNames.filter((n) => !zb.get(n).equals(zc.get(n)))
ok('**IR 是手写能力的无损超级集**：把 IR 页摊平成等价手写元素后，产物与 IR 版**逐部件一致**（作者只是少写了坐标）',
  flatDiff.length === 0, flatDiff.slice(0, 3).join(',') || `比对 ${flatNames.length} 个部件全一致`)

rmSync(root, { recursive: true, force: true })
console.log(`\n==== verify-northstar 结果：${pass} 通过 / ${fail} 失败 ====`)
if (fail) { console.log(`失败项：${failures.join('；')}`); process.exit(1) }
