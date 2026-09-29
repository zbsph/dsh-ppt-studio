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

// ── 13 手写样例：深海养殖平台架构（三栏 + 软容器 + 底部回路）──
{
  const L = HEAD('深海养殖平台架构', '感知层采集 → 平台层建模与决策 → 决策层排程；投喂计划回写形成闭环')
  L.push(...tx('k1', [70, 118, 200, 22], '① 感知层', 14, '#E11D48', ', bold: true'))
  L.push(...tx('k2', [374, 118, 220, 22], '② 平台层', 14, '#7C3AED', ', bold: true, align: center'))
  L.push(...tx('k3', [690, 118, 200, 22], '③ 决策层', 14, '#E11D48', ', bold: true, align: right'))
  // 左：感知（平行四边形）
  L.push(...sh('left', 'parallelogram', [80, 216, 176, 118], '#E11D48', ['leftT', 'leftS']))
  L.push(...tx('leftT', [110, 252, 116, 24], '溶氧·水温', 13, '#FFFFFF', ', bold: true, align: center'))
  L.push(...tx('leftS', [110, 280, 116, 20], '水下相机', 11, '#FECDD3', ', align: center'))
  // 中：平台层软容器 + 3 张卡
  const cards = [['海缆与微波链路', 0], ['生长与环境模型', 1], ['投喂决策引擎', 2]]
  L.push(...sh('mid', 'roundRect', [336, 176, 292, 214], '#EDE9FE', cards.map((_, i) => ['m' + i, 'mt' + i]).flat()))
  cards.forEach(([n], i) => {
    const y = 196 + i * 66
    L.push(...sh('m' + i, 'roundRect', [356, y, 252, 52], '#7C3AED', ['mt' + i]))
    L.push(...tx('mt' + i, [362, y + 14, 240, 24], n, 13, '#FFFFFF', ', bold: true, align: center'))
  })
  // 右：决策（平行四边形）
  L.push(...sh('right', 'parallelogram', [688, 216, 176, 118], '#7C3AED', ['rightT', 'rightS']))
  L.push(...tx('rightT', [718, 252, 116, 24], '出栏排程', 13, '#FFFFFF', ', bold: true, align: center'))
  L.push(...tx('rightS', [718, 280, 116, 20], '看板下发', 11, '#DDD6FE', ', align: center'))
  // 连线：左→中（三条）、中→右（一条）
  // 平行四边形是斜边 prst：可见轮廓在腰高处比 bbox 内缩 x1/2 ≈ 15px（adj=25000, 高118 ⇒ x1≈29.5）
  // 端点必须按**轮廓**算，不能按 bbox —— 否则左右各留 ~15px 缝（用户实测反馈）
  const INSET = 15
  L.push(...ln('l0', [[256 - INSET, 275], [290, 275], [290, 222], [356, 222]], '#1F2937', 1.5, false, true))
  L.push(...ln('l1', [[256 - INSET, 275], [356, 275]], '#1F2937', 1.5, false, true))
  L.push(...ln('l2', [[256 - INSET, 275], [290, 275], [290, 328], [356, 328]], '#1F2937', 1.5, false, true))
  L.push(...ln('l3', [[628, 275], [688 + INSET, 275]], '#1F2937', 1.5, false, true))
  // 底部回路：决策层 → 感知层（投喂计划回写），标签放白底芯片上（模拟参考稿的遮罩）
  L.push(...ln('back2', [[776, 334], [776, 430], [168, 430], [168, 334]], '#94A3B8', 1.5, true, true))
  L.push(...sh('backChip', 'roundRect', [402, 418, 180, 26], '#FFFFFF', ['backChipT']))
  L.push(...tx('backChipT', [406, 422, 172, 20], '投喂计划回写', 11, '#475569', ', align: center'))
  // 门禁按 bbox 判形状；平行四边形的可见轮廓在 bbox 内缩 ⇒ 要真"接上"必须进入 bbox 15px。
  // 这不是缺陷而是 bbox×斜边轮廓的固有偏差，故按纪律**显式声明并写明理由**。
  L.splice(1, 0, '# 平行四边形的可见轮廓比 bbox 内缩 ~15px；箭头端点按轮廓算 ⇒ 必然进入 bbox，属几何固有偏差',
    'expectedOverlaps:', '  - { pair: [left, l0] }', '  - { pair: [left, l2] }', '  - { pair: [left, l1] }', '  - { pair: [right, l3] }')
  fs.writeFileSync(R + '/examples/hand-drawn/pages/13.yaml', L.join('\n') + '\n')
  console.log('13 手写样例元素 =', L.filter((x) => x.includes('elementId')).length)
}

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
  const r = await exportPptx(ctx, { out: out + '/手画12+1.pptx' })
  console.log('导出 parity.ok =', r.parity?.ok, '｜页数', ctx.pages.length)
  try {
    await renderPptxToPng(out + '/手画12+1.pptx', out, { pages: pages.map((_, i) => i + 1) })
    let ok = 0
    order.forEach((code, i) => { const f = out + '/' + String(i + 1).padStart(2, '0') + '.png'; if (fs.existsSync(f)) { fs.copyFileSync(f, out + '/' + NAME[code]); ok++ } })
    console.log('PNG 就位 =', ok + '/' + order.length)
  } catch (e) { console.log('渲染失败 ✗ ' + String(e.message).split('\n')[0].slice(0, 80)) }
})()
