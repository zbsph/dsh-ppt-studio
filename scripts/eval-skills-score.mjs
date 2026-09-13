#!/usr/bin/env node
/**
 * eval-skills-score.mjs —— 内置技能效果对照的**打分器**（纯本地，不调用模型）
 *
 * 用途：把两个 arm 各自产出的 deck 目录按同一口径度量，输出对照表。配合 docs/06 §7 的手工流程使用：
 *   ① 用**前一版**包跑一次（无新技能）→ 产物 deckA
 *   ② 用**当前**包跑一次（含新技能）→ 产物 deckB（两臂输入必须是同一份 brief）
 *   ③ node scripts/eval-skills-score.mjs --a <deckA 目录> --b <deckB 目录>
 * 门禁指标由本仓库的同一个 lib 事后复算，避免"自己评自己"。
 *
 * 指标：页数 / 元素数 / 文本字数 / 图表与表格数 / [✗]错误 / [⚠]警告 / [·]建议 /
 *       AI 味信号命中（按 ppt-studio-copy §4-5 的信号表扫描页面文本）/ 标注 source 的页数。
 *
 * 用法：node scripts/eval-skills-score.mjs --a <dir> --b <dir> [--label-a X] [--label-b Y] [--out RESULT.md]
 */
import { writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { verifyDeck } from '../lib/verify.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

/** AI 味信号（与 ppt-studio-copy §4/§5 对齐；成组才算 tell，这里只做粗计数）。 */
const AI_SIGNALS = [
  ['里程碑/仪式感', /里程碑|标志着|见证了|是.{0,6}的体现|新篇章/],
  ['宣传腔', /充满活力|令人瞩目|业界领先|坐落于|蓬勃发展|未来可期|迈上新台阶/],
  ['模糊归因', /行业报告显示|专家认为|普遍认为|相关研究表明/],
  ['否定式排比', /不仅.{0,18}(?:更|而且|还)|不是.{0,14}而是/],
  ['填充连接词', /此外|与此同时|值得注意的是|深入探讨|格局/],
  ['破折号揭示', /——/],
  ['通用积极结尾', /坚定信心|再创佳绩|持续向好|奠定了坚实基础/],
  ['系动词回避', /作为.{0,10}(?:的)?(?:重要|关键|核心)|拥有.{0,8}能力/],
]

/** 允许直接给 deck 目录，或给一个"里面第一个含 deck.yaml 的子目录"的父目录。 */
function deckOf(dir) {
  if (existsSync(join(dir, 'deck.yaml'))) return dir
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(dir, e.name, 'deck.yaml'))) return join(dir, e.name)
    }
  } catch { /* 目录不存在 */ }
  return null
}

async function score(label, dir) {
  const out = { label, deck: null }
  const deckDir = deckOf(resolve(dir))
  if (deckDir === null) return { ...out, error: `未在 ${dir} 下找到 deck.yaml` }
  out.deck = deckDir
  const ctx = await resolveDeck(deckDir)
  const r = await renderDeck(ctx, {})
  const v = verifyDeck(r.layout)
  const lines = v.text.split('\n')
  out.gates = {
    errors: lines.filter((l) => l.includes('[✗]')).length,
    warnings: lines.filter((l) => l.includes('[⚠]')).length,
    suggestions: lines.filter((l) => l.includes('[·]')).length,
  }
  const texts = []
  let elements = 0
  let charts = 0
  let tables = 0
  for (const p of ctx.pages) {
    for (const el of p.page.elements ?? []) {
      elements++
      if (el.elementType === 'chart') charts++
      if (el.elementType === 'table') tables++
      if (el.elementType === 'text') texts.push(String(el.content?.text ?? ''))
    }
  }
  const all = texts.join('\n')
  out.scale = { pages: ctx.pages.length, elements, charts, tables, textChars: all.length }
  out.aiSignals = AI_SIGNALS
    .map(([name, re]) => [name, (all.match(new RegExp(re.source, 'g')) ?? []).length])
    .filter(([, n]) => n > 0)
  out.aiTotal = out.aiSignals.reduce((n, [, c]) => n + c, 0)
  out.dataQuality = {
    pagesWithSource: ctx.pages.filter((p) => typeof p.page.source === 'string' && p.page.source.trim().length > 0).length,
    unitKindsPresent: ['%', '小时', '分钟', '园区', '人'].filter((u) => all.includes(u)).length,
    hasChart: charts > 0,
    hasTable: tables > 0,
    valueMentions: (all.match(/\d+/g) ?? []).length,
  }
  return out
}

const dirA = opt('--a')
const dirB = opt('--b')
if (dirA === undefined || dirB === undefined) {
  console.error('用法：node scripts/eval-skills-score.mjs --a <deckA 目录> --b <deckB 目录> [--label-a X] [--label-b Y] [--out RESULT.md]')
  process.exit(2)
}
const A = await score(opt('--label-a', 'A'), dirA)
const Bd = await score(opt('--label-b', 'B'), dirB)

const md = []
md.push('# 内置技能效果对照（同一 brief、同一模型、同一装配下的两个 arm）', '')
md.push('| 指标 | A | B |', '|---|---|---|')
const row = (k, f) => md.push(`| ${k} | ${f(A)} | ${f(Bd)} |`)
row('页数', (x) => x.scale?.pages ?? '—')
row('元素数', (x) => x.scale?.elements ?? '—')
row('文本总字数', (x) => x.scale?.textChars ?? '—')
row('图表数 / 表格数', (x) => `${x.scale?.charts ?? '—'} / ${x.scale?.tables ?? '—'}`)
row('门禁错误 [✗]', (x) => x.gates?.errors ?? '—')
row('门禁警告 [⚠]', (x) => x.gates?.warnings ?? '—')
row('审美建议 [·]', (x) => x.gates?.suggestions ?? '—')
row('AI 味信号命中', (x) => x.aiTotal ?? '—')
row('标注 source 的页数', (x) => x.dataQuality?.pagesWithSource ?? '—')
row('出现的单位种类', (x) => x.dataQuality?.unitKindsPresent ?? '—')
md.push('', '## 明细', '')
for (const x of [A, Bd]) md.push(`### ${x.label}${x.deck ? `（${x.deck}）` : ''}`, '', '```json', JSON.stringify(x, null, 2), '```', '')
const text = md.join('\n')
console.log(text)
const outFile = opt('--out')
if (outFile !== undefined) {
  writeFileSync(outFile, text + '\n', 'utf8')
  console.log(`\n（已写入 ${outFile}）`)
}
if (A.error !== undefined || Bd.error !== undefined) process.exit(1)
void statSync
void root
