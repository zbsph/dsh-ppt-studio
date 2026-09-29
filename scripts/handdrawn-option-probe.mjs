#!/usr/bin/env node
/**
 * 手画能力探针：验证「图族时代的选项面」在纯手画下**等价可复现**（F2 判据：不许有"未验证"项）
 *
 * 图族时代只有两个选项（拆除前实测；对照见 docs/15-图族删除·能力差异与迁移表.md）：
 *   · `pyramid: true` ⇒ 反向（逐段**放宽**的金字塔，而不是收窄的漏斗）
 *   · `minRatio`      ⇒ 末段宽度相对首段的比例（末段宽 = 首段宽 × ratio）
 * 本探针用**显式 custGeom 元素**把两种变体画出来并过门禁（不需要族代码）。
 *
 * 用法：node scripts/handdrawn-option-probe.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDeck } from '../src/pptd/schema.js'
import { renderDeck } from '../src/pptd/render-html.js'
import { verifyDeck } from '../src/verify.js'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const dir = join(ROOT, 'examples', 'option-probe')
mkdirSync(join(dir, 'pages'), { recursive: true })
writeFileSync(join(dir, 'deck.yaml'), [
  'version: 1', 'title: 选项探针', 'size: [960, 540]', 'theme:', '  colors:',
  '    primary: "#7C3AED"', '    accent: "#E11D48"', '    soft: "#EDE9FE"',
  '    text: "#2E1065"', '    bg: "#FAF5FF"', 'pages:',
  '  - pages/pyramid.yaml', '  - pages/narrow.yaml', '',
].join('\n'))

// 画一条"逐段变宽/变窄"的 custGeom 梯形带（手画等价物）
function bands(rows, title, sub, label) {
  const bw = 800, bx = 80, bandH = 70, topY = 148
  const L = ['pageType: content', 'elements:']
  L.push('  - elementId: title', '    elementType: text', '    bounds: [60, 34, 760, 38]',
    `    content: { text: '${title}', fontSize: 25, color: '#2E1065', bold: true }`)
  L.push('  - elementId: sub', '    elementType: text', '    bounds: [60, 76, 820, 22]',
    `    content: { text: '${sub}', fontSize: 12, color: '#64748B' }`)
  rows.forEach(([name, topW], i) => {
    const y = topY + i * bandH
    const botW = i + 1 < rows.length ? rows[i + 1][1] : Math.round(topW * (label === 'pyramid' ? 1.5 : 0.5))
    const lw = Math.max(120, Math.min(topW, botW) - 60)
    L.push(`  - elementId: b${i}`, '    elementType: shape', '    kind: custGeom',
      `    bounds: [${bx}, ${y}, ${bw}, ${bandH}]`,
      `    fill: '${i === rows.length - 1 ? '#E11D48' : '#7C3AED'}'`,
      "    line: { color: '#FFFFFF', width: 1.5 }", `    contains: [bt${i}]`,
      '    path:', `      w: ${bw}`, `      h: ${bandH}`, '      commands:',
      `        - { cmd: moveTo, pts: [[${Math.round((bw - topW) / 2)}, 0]] }`,
      `        - { cmd: lnTo, pts: [[${Math.round((bw + topW) / 2)}, 0]] }`,
      `        - { cmd: lnTo, pts: [[${Math.round((bw + botW) / 2)}, ${bandH}]] }`,
      `        - { cmd: lnTo, pts: [[${Math.round((bw - botW) / 2)}, ${bandH}]] }`,
      '        - { cmd: close }')
    L.push(`  - elementId: bt${i}`, '    elementType: text',
      `    bounds: [${Math.round(480 - lw / 2)}, ${y + 24}, ${lw}, 26]`,
      `    content: { text: '${name}', fontSize: 15, color: '#FFFFFF', bold: true, align: center }`)
  })
  return L.join('\n') + '\n'
}

// 变体 A：pyramid（逐段放宽 = 金字塔，族里 pyramid: true 的等价物）
writeFileSync(join(dir, 'pages', 'pyramid.yaml'), bands(
  [['苗种', 240], ['育肥', 400], ['成鱼', 560], ['直供', 720]],
  '金字塔变体（pyramid 等价）', '逐段放宽：苗种 240 → 育肥 400 → 成鱼 560 → 直供 720', 'pyramid'))

// 变体 B：minRatio（末段宽 ≈ 首段宽 × 比例；这里用 0.25 的收窄漏斗）
writeFileSync(join(dir, 'pages', 'narrow.yaml'), bands(
  [['存栏', 760], ['达规格', 560], ['抽检', 360], ['直供', 190]],
  '窄口漏斗变体（minRatio 等价）', '末段宽 ≈ 首段 × 0.25：760 → 560 → 360 → 190', 'narrow'))

const ctx = await resolveDeck(dir)
await renderDeck(ctx, { out: 'preview' })
const layout = JSON.parse(readFileSync(join(dir, 'preview', 'layout.json'), 'utf8'))
const pages = Array.isArray(layout.pages) ? layout.pages : Object.values(layout.pages)
let bad = 0
pages.forEach((p, i) => {
  const v = verifyDeck({ pages: [p] })
  const kind = i === 0 ? 'pyramid' : 'minRatio'
  console.log('  ' + (v.errors.length ? '✗' : '✓') + ' ' + kind + '：元素 ' + p.elements.length + '｜门禁 错' + v.errors.length + '/警' + v.warns.length)
  v.errors.slice(0, 3).forEach((e) => console.log('      [错][' + e.code + '] ' + String(e.message).slice(0, 88)))
  if (v.errors.length) bad++
})
console.log('==== 选项等价探针：' + (bad === 0 ? '两个变体均 0 错（族的 pyramid / minRatio 在手画下等价可复现）' : bad + ' 页未通过') + ' ====')
process.exit(bad === 0 ? 0 : 1)
