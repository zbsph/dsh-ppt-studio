// 手画 02 矩阵 / 04 泳道 / 06 闭环（内容取自 examples/fresh-sea 原语义）
const fs = require('fs')
const R = 'D:/SharkCode/dsh-ppt-studio'
const P = (id, kind, b, fill, contains, extra) => {
  const L = [`  - elementId: ${id}`, '    elementType: shape', `    kind: ${kind}`, `    bounds: [${b.join(', ')}]`, `    fill: '${fill}'`]
  if (extra) L.push('    ' + extra)
  if (contains && contains.length) L.push(`    contains: [${contains.join(', ')}]`)
  return L
}
const T = (id, b, text, fs_, color, extra) => [`  - elementId: ${id}`, '    elementType: text', `    bounds: [${b.join(', ')}]`, `    content: { text: '${text}', fontSize: ${fs_}, color: '${color}'${extra || ''} }`]
const LN = (id, pts, color, w, dash, arrow) => [`  - elementId: ${id}`, '    elementType: line', `    points: [${pts.map((p) => `[${p[0]}, ${p[1]}]`).join(', ')}]`, ...(dash ? ['    dash: dash'] : []), `    line: { color: '${color}', width: ${w} }`, `    arrow: ${arrow ? 'true' : 'false'}`]
const HEAD = (t, s) => [
  'pageType: content', 'elements:',
  ...T('title', [60, 34, 760, 38], t, 25, '#2E1065', ', bold: true'),
  ...T('sub', [60, 76, 820, 22], s, 12, '#64748B'),
]

// ── 02 矩阵：风险处置优先级（2×2 象限 + 6 个风险）──
{
  const L = HEAD('风险处置优先级', '横轴＝发生概率，纵轴＝影响程度；右上角优先处置')
  L.push(...T('ylab', [66, 250, 24, 120], '影响', 13, '#7C3AED', ', bold: true'))
  L.push(...T('xlab', [470, 486, 200, 22], '发生概率 →', 13, '#7C3AED', ', bold: true'))
  const q = [
    ['高影响·低概率', 180, 140, '#EDE9FE'],
    ['高影响·高概率', 530, 140, '#FCE7F3'],
    ['低影响·低概率', 180, 310, '#EDE9FE'],
    ['低影响·高概率', 530, 310, '#FCE7F3'],
  ]
  // 象限容器必须登记"住在里面的风险卡"（否则门禁按"背景压内容"报错——实测 12 条）
  const qKids = [['qt0', 'r2', 'r3'], ['qt1', 'r0', 'r1'], ['qt2', 'r5'], ['qt3', 'r4']]
  q.forEach(([n, x, y, f], i) => {
    L.push(...P('q' + i, 'rect', [x, y, 350, 160], f, qKids[i], "line: { color: '#C4B5FD', width: 1 }"))
    L.push(...T('qt' + i, [x + 8, y + 8, 334, 18], n, 10, '#6D28D9', ', align: center'))
  })
  const risks = [
    ['台风预警', 530, 175], ['溶氧骤降', 700, 175],
    ['网衣破损', 180, 205], ['锚链磨损', 350, 205],
    ['附着物增多', 530, 375], ['低温胁迫', 180, 375],
  ]
  risks.forEach(([n, x, y], i) => {
    L.push(...P('r' + i, 'roundRect', [x, y, 150, 40], '#FFFFFF', ['rt' + i], "line: { color: '#C4B5FD', width: 1 }"))
    L.push(...T('rt' + i, [x + 4, y + 11, 142, 20], n, 12, '#2E1065', ', bold: true, align: center'))
  })
  fs.writeFileSync(R + '/examples/hand-drawn/pages/02.yaml', L.join('\n') + '\n')
  console.log('02 矩阵元素 =', L.filter((l) => l.includes('elementId')).length)
}

// ── 04 泳道：日投喂与巡检（4 泳道 + 6 步流程）──
{
  const L = HEAD('日投喂与巡检', '四个角色分道作业：集控下单 → 投喂 → 潜水巡检 → 质检归档')
  const steps = [['投喂计划', 0], ['水质复核', 3], ['自动投喂', 1], ['水下巡检', 2], ['取样检测', 3], ['结果归档', 0]]
  const lanes = ['集控', '投喂', '潜水', '质检']
  const ly = 156, lh = 72, lstep = 84, lx = 60, lw = 96
  lanes.forEach((n, i) => {
    const y = ly + i * lstep
    // 泳道带必须登记"住在本道里的任务卡"（否则门禁按"背景压内容"报错——实测 17 条）
    const kids = steps.reduce((acc, [sn, lane], k) => (lane === i ? acc.concat(['s' + k, 'st' + k]) : acc), [])
    L.push(...P('ln' + i, 'roundRect', [lx, y, lw, lh], i % 2 === 0 ? '#7C3AED' : '#A78BFA', ['lnt' + i]))
    L.push(...T('lnt' + i, [lx + 4, y + 24, lw - 8, 24], n, 14, '#FFFFFF', ', bold: true, align: center'))
    L.push(...P('lb' + i, 'rect', [lx + lw, y, 780, lh], i % 2 === 0 ? '#F5F3FF' : '#FFFFFF', kids, "line: { color: '#E9D5FF', width: 1 }"))
  })
  const sw = 110, sx0 = 176
  steps.forEach(([n, lane], i) => {
    const x = sx0 + i * 124
    const y = ly + lane * lstep + 14
    L.push(...P('s' + i, 'roundRect', [x, y, sw, 44], '#FFFFFF', ['st' + i], "line: { color: '#7C3AED', width: 1.2 }"))
    L.push(...T('st' + i, [x + 4, y + 12, sw - 8, 22], n, 11, '#2E1065', ', bold: true, align: center'))
    if (i < steps.length - 1) {
      const nx = sx0 + (i + 1) * 124
      const nlane = steps[i + 1][1]
      const ny = ly + nlane * lstep + 14
      const pts = lane === nlane ? [[x + sw, y + 22], [nx, ny + 22]] : [[x + sw, y + 22], [x + sw + 7, y + 22], [x + sw + 7, ny + 22], [nx, ny + 22]]
      L.push(...LN('a' + i, pts, '#7C3AED', 1.5, false, true))
    }
  })
  // 跨道连线必然穿泳道带（泳道图的设计本质）⇒ 按纪律**显式声明**为有意穿入并写明理由，绝不改门禁
  const pairs = []
  for (let k = 0; k < steps.length - 1; k++) {
    const l1 = steps[k][1]
    const l2 = steps[k + 1][1]
    if (l1 !== l2) pairs.push(`  - { pair: [lb${l1}, a${k}] }`, `  - { pair: [lb${l2}, a${k}] }`, `  - { pair: [ln${l1}, a${k}] }`, `  - { pair: [ln${l2}, a${k}] }`)
  }
  if (pairs.length) L.splice(1, 0, '# 跨道连线穿泳道带属设计意图（泳道图本质），非缺陷', 'expectedOverlaps:', ...pairs)
  fs.writeFileSync(R + '/examples/hand-drawn/pages/04.yaml', L.join('\n') + '\n')
  console.log('04 泳道元素 =', L.filter((l) => l.includes('elementId')).length, '｜有意穿入声明 =', pairs.length)
}

// ── 06 闭环：水质调控闭环（5 步环形 + 中心标题）──
{
  const L = HEAD('水质调控闭环', '采集 → 预测 → 调整 → 复核 → 回写：形成自动调控闭环')
  const nodes = ['传感器采集', '趋势预测', '投喂调整', '效果复核', '阈值回写']
  const cx = 480, cy = 312, rx = 250, ry = 132
  const pos = []
  nodes.forEach((n, i) => {
    const a = (-90 + i * 72) * Math.PI / 180
    const x = Math.round(cx + rx * Math.cos(a) - 85)
    const y = Math.round(cy + ry * Math.sin(a) - 26)
    pos.push({ x, y })
    L.push(...P('n' + i, 'roundRect', [x, y, 170, 52], i === 2 ? '#E11D48' : '#7C3AED', ['nt' + i]))
    L.push(...T('nt' + i, [x + 4, y + 15, 162, 24], n, 13, '#FFFFFF', ', bold: true, align: center'))
  })
  // 连线必须从**卡边**出发、落到下一张卡边（此前从卡心出发 ⇒ 门禁报 n0×c0 等 8 条）
  // 且不再画环心文字（否则线会压字）
  pos.forEach((p, i) => {
    const q = pos[(i + 1) % pos.length]
    const pC = { x: p.x + 85, y: p.y + 26 }
    const qC = { x: q.x + 85, y: q.y + 26 }
    const dx = qC.x - pC.x
    const dy = qC.y - pC.y
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const ux = dx / len
    const uy = dy / len
    const off = 96
    const s = [Math.round(pC.x + ux * off), Math.round(pC.y + uy * off)]
    const e = [Math.round(qC.x - ux * off), Math.round(qC.y - uy * off)]
    L.push(...LN('c' + i, [s, e], '#C4B5FD', 1.5, false, true))
  })
  fs.writeFileSync(R + '/examples/hand-drawn/pages/06.yaml', L.join('\n') + '\n')
  console.log('06 闭环元素 =', L.filter((l) => l.includes('elementId')).length)
}

fs.writeFileSync(R + '/examples/hand-drawn/deck.yaml', ['version: 1', 'title: 手画版 12+1', 'size: [960, 540]', 'theme:', '  colors:', '    primary: "#7C3AED"', '    accent: "#E11D48"', '    soft: "#EDE9FE"', '    text: "#2E1065"', '    bg: "#FAF5FF"', 'pages:'].concat(['01', '02', '03', '04', '06', '07', '09', '10', '12'].map((n) => '  - pages/' + n + '.yaml')).join('\n') + '\n')
console.log('deck 已更新为 9 页')
