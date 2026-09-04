/** M2 性能基准：100 页 deck 渲染+实测耗时（D5：先量化再决策）→ docs/02 §6 记录 */
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
const { resolveDeck } = await import('../src/pptd/schema.js')
const { renderDeck } = await import('../src/pptd/render-html.js')
const { measureLayout } = await import('../src/measurement.js')

const d = join(homedir(), '.dsh', 'ppt-studio', 'bench-100')
await rm(d, { recursive: true, force: true })
await mkdir(join(d, 'pages'), { recursive: true })
const N = 100
const refs = []
for (let i = 1; i <= N; i++) {
  const name = `p${String(i).padStart(3, '0')}.yaml`
  refs.push(`  - pages/${name}`)
  await writeFile(join(d, 'pages', name), [
    'pageType: content',
    'elements:',
    `  - elementId: t${i}`, '    elementType: text', '    bounds: [60, 60, 700, 60]',
    `    content: {text: "第 ${i} 页：用于性能基准的长文本段落，包含多个中文句子与数字 12345、百分比 45.5%、年份 2026 等常见内容形态，验证真实任务的渲染与测量开销。", fontSize: 22, color: "#1E4E8C"}`,
    `  - elementId: s${i}`, '    elementType: shape', '    kind: roundRect', '    bounds: [60, 160, 300, 120]', '    fill: "#EAF1F8"',
    '', ''].join('\n'))
}
await writeFile(join(d, 'deck.yaml'), `version: 1
title: bench-100
size: [960, 540]
theme: {colors: {primary: "#1E4E8C", accent: "#EAF1F8"}}
pages:
${refs.join('\n')}
`)
const t0 = Date.now()
const ctx = await resolveDeck(d)
const tRender = Date.now()
const r = await renderDeck(ctx, {})
const tMeasure0 = Date.now()
const m = await measureLayout(d)
const tEnd = Date.now()
console.log(JSON.stringify({
  pages: N,
  renderMs: tMeasure0 - tRender,
  measureMs: tEnd - tMeasure0,
  totalMs: tEnd - t0,
  perPageMs: Math.round((tEnd - t0) / N * 10) / 10,
  measuredPages: m.pages,
  notes: m.notes,
}, null, 2))
await rm(d, { recursive: true, force: true })
