#!/usr/bin/env node
/**
 * eval-skills-blind.mjs —— 把两个 arm 的产物**匿名化 + 随机化**，生成盲评材料（配合 docs/06 §7.6 协议）。
 *
 * 为什么需要：内置技能是"软收益"，自评容易有偏；照 docs/06 的方法做**结构化盲评**时，
 * 必须让评审员只看到产物、看不到来源（否则会从目录名/命名习惯猜到哪份是"新版"）。
 *
 * 产出（<out> 下）：
 *   <out>/盲评-1/deck/{deck.yaml,pages/*.yaml}   源描述（可读文本）
 *   <out>/盲评-1/render/NN.png                   Office 真渲染整页（有 Office 时；无则跳过并提示）
 *   <out>/盲评-2/…                               另一份
 *   <out>/mapping.json                           真实映射（**只留档，不给评审员**）
 *
 * 用法：node scripts/eval-skills-blind.mjs <deckA 目录> <deckB 目录> [--out <目录>]
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDeck } from '../lib/pptd/schema.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { renderPptxToPng, findPowerPoint } from '../lib/msrender.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
if (positional.length < 2) {
  console.error('用法：node scripts/eval-skills-blind.mjs <deckA 目录> <deckB 目录> [--out <目录>]')
  process.exit(2)
}
const [dirA, dirB] = positional
const outRoot = resolve(opt('--out', join(root, 'examples', 'blind-review')))

/** 找到目录下的 deck（本身是 deck 目录，或第一层子目录里含 deck.yaml）。 */
function deckOf(dir) {
  const base = resolve(dir)
  if (existsSync(join(base, 'deck.yaml'))) return base
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(base, e.name, 'deck.yaml'))) return join(base, e.name)
  }
  throw new Error(`找不到 deck.yaml：${dir}`)
}

rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })

// 随机分配：真 = 第一份放「盲评-1」
const aFirst = Math.random() < 0.5
const order = aFirst ? [['A', dirA], ['B', dirB]] : [['B', dirB], ['A', dirA]]
const hasOffice = findPowerPoint() !== null

const mapping = {}
for (let i = 0; i < order.length; i++) {
  const [arm, dir] = order[i]
  const label = `盲评-${i + 1}`
  mapping[label] = { arm, source: resolve(dir) }
  const deckDir = deckOf(dir)
  const target = join(outRoot, label)
  mkdirSync(join(target, 'deck', 'pages'), { recursive: true })
  copyFileSync(join(deckDir, 'deck.yaml'), join(target, 'deck', 'deck.yaml'))
  for (const f of readdirSync(join(deckDir, 'pages'))) {
    if (f.endsWith('.yaml')) copyFileSync(join(deckDir, 'pages', f), join(target, 'deck', 'pages', f))
  }
  // 取 pptx：优先复用已有 out.pptx，否则现导一份（不污染原目录的 deck.yaml）
  let pptx = join(deckDir, 'out.pptx')
  if (!existsSync(pptx)) {
    const ctx = await resolveDeck(deckDir)
    const r = await exportPptx(ctx, { out: join(target, 'blind-export.pptx'), engine: 'pptd' })
    pptx = r.file
    const out = ctx.pages.length === 1 ? 1 : r.slides
    void out
  }
  if (hasOffice) {
    try {
      const r = await renderPptxToPng(pptx, join(target, 'render'), { noWatermark: true })
      console.log(`${label}: ${arm} → Office 真渲染 ${r.pages} 页`)
    } catch (error) {
      console.log(`${label}: ${arm} → Office 渲染失败（${String(error?.message ?? error).split('\n')[0].slice(0, 80)}）——评审退化为只看文本`)
    }
  } else {
    console.log(`${label}: ${arm} → 本机无 Office，跳过真渲染（评审只看文本，需在结论中标注）`)
  }
  console.log(`   源 deck：${deckDir}`)
}
writeFileSync(join(outRoot, 'mapping.json'), JSON.stringify({ aFirst, hasOffice, mapping }, null, 2) + '\n', 'utf8')
console.log('\n真实映射（只留档，勿给评审员）：', JSON.stringify(mapping))
console.log('盲评材料：', outRoot)
