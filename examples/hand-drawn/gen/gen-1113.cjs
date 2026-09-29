// 导出名可配置：node gen-1113.cjs <文件名> 或环境变量 PPTX_NAME（缺省用非锁定名，避免 PowerPoint 占用）
const PPTX = process.argv[2] || process.env.PPTX_NAME || '手画12+1-build.pptx'

// 手画 11 流程图 / 13 手写样例（架构图）+ 管线
const fs = require('fs')
const R = 'D:/SharkCode/dsh-ppt-studio'
const sh = (id, kind, b, fill, contains, extra) => { const L = [`  - elementId: ${id}`, '    elementType: shape', `    kind: ${kind}`, `    bounds: [${b.join(', ')}]`, `    fill: '${fill}'`]; if (extra) L.push('    ' + extra); if (contains && contains.length) L.push(`    contains: [${contains.join(', ')}]`); return L }
const tx = (id, b, t, s, c, ex) => [`  - elementId: ${id}`, '    elementType: text', `    bounds: [${b.join(', ')}]`, `    content: { text: '${t}', fontSize: ${s}, color: '${c}'${ex || ''} }`]
const ln = (id, pts, c, w, dash, arrow) => [`  - elementId: ${id}`, '    elementType: line', `    points: [${pts.map((p) => `[${p[0]}, ${p[1]}]`).join(', ')}]`, ...(dash ? ['    dash: dash'] : []), `    line: { color: '${c}', width: ${w} }`, `    arrow: ${arrow ? 'true' : 'false'}`]
const HEAD = (t, s) => ['pageType: content', 'elements:', ...tx('title', [60, 34, 760, 38], t, 25, '#2E1065', ', bold: true'), ...tx('sub', [60, 76, 820, 22], s, 12, '#64748B')]

// ── 11 流程图：出栏流程 5 步 + 不合格回边 ──
{
  const L = HEAD('出栏流程', '申报 → 准备 → 起网 → 装箱 → 转运；抽检不合格则回到起网准备')
  const steps = [['出栏申报', '#7C3AED'], ['起网准备', '#7C3AED'], ['起网', '#7C3AED'], ['冰鲜装箱', '#7C3AED'], ['驳船转运', '#E11D48']]
  const w = 150, h = 64, y = 208, gap = 22
  steps.forEach(([n, f], i) => {
    const x = 60 + i * (w + gap)
    L.push(...sh('s' + i, i === 0 || i === steps.length - 1 ? 'roundRect' : 'rect', [x, y, w, h], f, ['st' + i]))
    L.push(...tx('st' + i, [x + 6, y + 20, w - 12, 26], n, 14, '#FFFFFF', ', bold: true, align: center'))
    if (i < steps.length - 1) L.push(...ln('a' + i, [[x + w, y + h / 2], [x + w + gap, y + h / 2]], '#E11D48', 2, false, true))
  })
  // 回边：冰鲜装箱(3) 下方 → 起网准备(1)
  const fx = 60 + 3 * (w + gap) + w / 2
  const tx2 = 60 + 1 * (w + gap) + w / 2
  L.push(...ln('back', [[fx, y + h], [fx, 360], [tx2, 360], [tx2, y + h]], '#94A3B8', 1.5, true, true))
  L.push(...tx('backLab', [Math.round((fx + tx2) / 2) - 50, 332, 100, 20], '抽检不合格', 11, '#475569', ', align: center'))
  fs.writeFileSync(R + '/examples/hand-drawn/pages/11.yaml', L.join('\n') + '\n')
  console.log('11 流程图元素 =', L.filter((x) => x.includes('elementId')).length)
}

// [已移除] 13 页由 gen13-attach.cjs 独占 —— 双写会把 attach 版覆盖回旧坐标（本轮实测）

const order = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13']
fs.writeFileSync(R + '/examples/hand-drawn/deck.yaml', ['version: 1', 'title: 手画版 12+1', 'size: [960, 540]', 'theme:', '  colors:', '    primary: "#7C3AED"', '    accent: "#E11D48"', '    soft: "#EDE9FE"', '    text: "#2E1065"', '    bg: "#FAF5FF"', 'pages:'].concat(order.map((n) => '  - pages/' + n + '.yaml')).join('\n') + '\n')
console.log('deck 已更新为', order.length, '页')
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
  pages.forEach((p, i) => {
    const v = verifyDeck({ pages: [p] })
    console.log('[' + order[i] + '] 元素 ' + p.elements.length + '｜门禁 错' + v.errors.length + '/警' + v.warns.length)
    for (const e of v.errors.slice(0, 4)) console.log('   [' + e.code + '] ' + String(e.message).replace(/\s+/g, ' ').slice(0, 96))
  })
  const NAME = { '01': '01-层级树（手画）.png', '02': '02-矩阵（手画）.png', '03': '03-时间轴（手画）.png', '04': '04-泳道（手画）.png', '05': '05-左右对比（手画）.png', '06': '06-闭环（手画）.png', '07': '07-漏斗（手画）.png', '08': '08-步骤环（手画）.png', '09': '09-时序（手画）.png', '10': '10-状态机（手画）.png', '11': '11-流程图（手画）.png', '12': '12-分层架构（手画）.png', '13': '13-平台架构（手画）.png' }
  const r = await exportPptx(ctx, { out: out + '/' + PPTX })
  console.log('导出 parity.ok =', r.parity?.ok, '｜页数', ctx.pages.length)
  try {
    await renderPptxToPng(out + '/' + PPTX, out, { pages: pages.map((_, i) => i + 1) })
    let ok = 0
    order.forEach((code, i) => { const f = out + '/' + String(i + 1).padStart(2, '0') + '.png'; if (fs.existsSync(f)) { fs.copyFileSync(f, out + '/' + NAME[code]); ok++ } })
    console.log('PNG 就位 =', ok + '/' + order.length)
  } catch (e) { console.log('渲染失败 ✗ ' + String(e.message).split('\n')[0].slice(0, 80)) }
})()
