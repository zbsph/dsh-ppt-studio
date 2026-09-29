// 重画 02 矩阵：三档处置列（可观察/当班处置/立即撤离）× 两行频次（高频/低频）
// 依据：旧版页图\02-矩阵.png —— 每个风险独占一格，处置档是列头；我此前用 2×2 象限丢了这一维度。
// 画布安全区 60..900 × 60..480，故列 x=160/410/660（w=230），行 y=190/330（h=120）。
const fs = require('fs')
const R = 'D:/SharkCode/dsh-ppt-studio'
const sh = (id, kind, b, fill, contains, extra) => { const L = [`  - elementId: ${id}`, '    elementType: shape', `    kind: ${kind}`, `    bounds: [${b.join(', ')}]`, `    fill: '${fill}'`]; if (extra) L.push('    ' + extra); if (contains && contains.length) L.push(`    contains: [${contains.join(', ')}]`); return L }
const tx = (id, b, t, s, c, ex) => [`  - elementId: ${id}`, '    elementType: text', `    bounds: [${b.join(', ')}]`, `    content: { text: '${t}', fontSize: ${s}, color: '${c}'${ex || ''} }`]

const cols = ['可观察', '当班处置', '立即撤离']
const rows = [['高频', 190], ['低频', 330]]
const cells = [
  [['溶氧骤降'], ['网衣破损'], ['台风预警']],
  [['附着物增多'], ['锚链磨损'], ['低温胁迫']],
]
const cx = (i) => 160 + i * 250
const cw = 230, chh = 120

const L = ['pageType: content', 'elements:']
L.push(...tx('title', [60, 34, 760, 38], '风险处置优先级', 25, '#2E1065', ', bold: true'))
L.push(...tx('sub', [60, 76, 820, 22], '按发生频次分行、按处置力度分列：可观察 / 当班处置 / 立即撤离', 12, '#64748B'))
cols.forEach((c, i) => L.push(...tx('colh' + i, [cx(i), 158, cw, 24], c, 14, '#7C3AED', ', bold: true, align: center')))
rows.forEach(([rn, y]) => L.push(...tx('rowh' + rn, [60, y + chh / 2 - 12, 90, 24], rn, 13, '#7C3AED', ', bold: true, align: center')))
cells.forEach((row, r) => row.forEach((names, c) => {
  const y = rows[r][1]
  const hot = names[0] === '溶氧骤降'
  L.push(...sh(`cell${r}${c}`, 'roundRect', [cx(c), y, cw, chh], hot ? '#E11D48' : '#7C3AED', [`cellT${r}${c}`]))
  L.push(...tx(`cellT${r}${c}`, [cx(c) + 8, y + chh / 2 - 14, cw - 16, 28], names[0], 15, '#FFFFFF', ', bold: true, align: center'))
}))
fs.writeFileSync(R + '/examples/hand-drawn/pages/02.yaml', L.join('\n') + '\n')
console.log('02 矩阵（三档×两频）元素 =', L.filter((x) => x.includes('elementId')).length)

const order = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13']
;(async () => {
  const { resolveDeck } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/pptd/schema.js')
  const { renderDeck } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/pptd/render-html.js')
  const { exportPptx } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/pptd/export-pptx.js')
  const { renderPptxToPng } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/msrender.js')
  const { verifyDeck } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/verify.js')
  const src = R + '/examples/hand-drawn'
  const out = 'D:/SharkCode/ppt-deliverable/手画12+1'
  const ctx = await resolveDeck(src)
  await renderDeck(ctx, { out: 'preview' })
  const layout = JSON.parse(fs.readFileSync(src + '/preview/layout.json', 'utf8'))
  const pages = Array.isArray(layout.pages) ? layout.pages : Object.values(layout.pages)
  const NAME = { '01': '01-层级树（手画）.png', '02': '02-矩阵（手画）.png', '03': '03-时间轴（手画）.png', '04': '04-泳道（手画）.png', '05': '05-左右对比（手画）.png', '06': '06-闭环（手画）.png', '07': '07-漏斗（手画）.png', '08': '08-步骤环（手画）.png', '09': '09-时序（手画）.png', '10': '10-状态机（手画）.png', '11': '11-流程图（手画）.png', '12': '12-分层架构（手画）.png', '13': '13-平台架构（手画）.png' }
  const r = await exportPptx(ctx, { out: out + '/手画12+1.pptx' })
  let bad = 0
  pages.forEach((p, i) => { const v = verifyDeck({ pages: [p] }); if (v.errors.length) { bad++; console.log('[' + order[i] + '] 错' + v.errors.length); for (const e of v.errors.slice(0, 3)) console.log('   [' + e.code + '] ' + String(e.message).replace(/\s+/g, ' ').slice(0, 92)) } })
  console.log('门禁：' + (pages.length - bad) + '/' + pages.length + ' 页 0 错｜导出 parity.ok =', r.parity?.ok)
  try {
    await renderPptxToPng(out + '/手画12+1.pptx', out, { pages: pages.map((_, i) => i + 1) })
    let ok = 0
    order.forEach((code, i) => { const f = out + '/' + String(i + 1).padStart(2, '0') + '.png'; if (fs.existsSync(f)) { fs.copyFileSync(f, out + '/' + NAME[code]); ok++ } })
    console.log('PNG 就位 =', ok + '/' + order.length)
  } catch (e) { console.log('渲染失败 ✗ ' + String(e.message).split('\n')[0].slice(0, 80)) }
})()
