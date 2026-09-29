// 按用户 6 条反馈重修 01 / 04 / 06 / 08 / 09 / 10 六页
// 反馈：01 用直线（对齐两框）；04 折点离箭头太近；06/08 箭头没连成环且不明显；
//       09 竖线穿文字；10 主线文字没挨着箭头线
const fs = require('fs')
const R = 'D:/SharkCode/dsh-ppt-studio'
const sh = (id, kind, b, fill, contains, extra) => { const L = ['  - elementId: ' + id, '    elementType: shape', '    kind: ' + kind, '    bounds: [' + b.join(', ') + ']', "    fill: '" + fill + "'"]; if (extra) L.push('    ' + extra); if (contains && contains.length) L.push('    contains: [' + contains.join(', ') + ']'); return L }
const tx = (id, b, t, s, c, ex) => ['  - elementId: ' + id, '    elementType: text', '    bounds: [' + b.join(', ') + ']', "    content: { text: '" + t + "', fontSize: " + s + ", color: '" + c + "'" + (ex || '') + ' }']
const ln = (id, pts, c, w, dash, arrow) => ['  - elementId: ' + id, '    elementType: line', '    points: [' + pts.map((p) => '[' + p[0] + ', ' + p[1] + ']').join(', ') + ']', ...(dash ? ['    dash: dash'] : []), "    line: { color: '" + c + "', width: " + w + ' }', '    arrow: ' + (arrow ? 'true' : 'false')]
const HEAD = (t, s, opts) => { const L = ['pageType: content']; if (opts && opts.expected) L.push('expectedOverlaps:', ...opts.expected); L.push('elements:', ...tx('title', [60, 34, 760, 38], t, 25, '#2E1065', ', bold: true'), ...tx('sub', [60, 76, 820, 22], s, 12, '#64748B')); return L }
// 矩形边界裁剪：从中心沿 (ux,uy) 方向射到卡边（保证箭头端**贴边**）
const clip = (c, hw, hh, ux, uy) => { const t = Math.min(hw / Math.max(Math.abs(ux), 1e-6), hh / Math.max(Math.abs(uy), 1e-6)); return [Math.round(c[0] + ux * t), Math.round(c[1] + uy * t)] }
const arrowBetween = (id, A, B, hwA, hhA, hwB, hhB, color, w) => {
  const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.sqrt(dx * dx + dy * dy) || 1
  const ux = dx / L, uy = dy / L
  return ln(id, [clip(A, hwA, hhA, ux, uy), clip(B, hwB, hhB, -ux, -uy)], color, w, false, true)
}

// ═══ 01 层级树：装备组→网衣维护 改**直线**（把两框中心对齐到 x=480）═══
{
  const L = HEAD('养殖平台组织', '平台长统管三个组；养殖组与装备组下再设班组')
  L.push(...sh('root', 'roundRect', [380, 124, 200, 64], '#7C3AED', ['rootT', 'rootS']))
  L.push(...tx('rootT', [388, 132, 184, 24], '平台长', 16, '#FFFFFF', ', bold: true, align: center'))
  L.push(...tx('rootS', [388, 160, 184, 18], '养殖体系', 10, '#EDE9FE', ', align: center'))
  const groups = [['养殖组', 90], ['装备组', 395], ['质检组', 700]]
  groups.forEach(([n, x], i) => {
    L.push(...sh('g' + i, 'roundRect', [x, 258, 170, 52], '#EDE9FE', ['gt' + i], "line: { color: '#C4B5FD', width: 1 }"))
    L.push(...tx('gt' + i, [x + 8, 272, 154, 24], n, 14, '#2E1065', ', bold: true, align: center'))
    L.push(...ln('gl' + i, [[480, 188], [480, 220], [x + 85, 220], [x + 85, 258]], '#7C3AED', 1.5, false, true))
  })
  // 叶：投喂一班/投喂二班 挂养殖组；网衣维护 中心对齐 480 ⇒ 一条直线即可
  const leaves = [['投喂一班', 60, 175], ['投喂二班', 218, 175], ['网衣维护', 405, 480]]
  leaves.forEach(([n, x, px], i) => {
    L.push(...sh('lf' + i, 'roundRect', [x, 380, 150, 48], '#FFFFFF', ['lft' + i], "line: { color: '#C4B5FD', width: 1 }"))
    L.push(...tx('lft' + i, [x + 8, 393, 134, 22], n, 12, '#2E1065', ', align: center'))
    const pts = i === 2 ? [[480, 310], [480, 380]] : [[px, 310], [px, 344], [x + 75, 344], [x + 75, 380]]
    L.push(...ln('lfl' + i, pts, '#C4B5FD', 1.2, false, true))
  })
  fs.writeFileSync(R + '/examples/hand-drawn/pages/01.yaml', L.join('\n') + '\n')
  console.log('01 层级树 =', L.filter((x) => x.includes('elementId')).length)
}

// ═══ 04 泳道：拉大间距使折点距箭头/端点 ≥22px；跨道按纪律声明 lb 穿入 ═══
{
  const steps = [['投喂计划', 0], ['水质复核', 3], ['自动投喂', 1], ['水下巡检', 2], ['取样检测', 3], ['结果归档', 0]]
  const lanes = ['集控', '投喂', '潜水', '质检']
  const pairs = []
  for (let k = 0; k < steps.length - 1; k++) { const a = steps[k][1], b = steps[k + 1][1]; if (a !== b) pairs.push('  - { pair: [lb' + a + ', a' + k + '] }', '  - { pair: [lb' + b + ', a' + k + '] }') }
  const L = HEAD('日投喂与巡检', '四个角色分道作业：集控下单 → 投喂 → 潜水巡检 → 质检归档', { expected: pairs })
  const ly = 156, lh = 72, lstep = 84, lx = 60, lw = 96
  lanes.forEach((n, i) => {
    const y = ly + i * lstep
    const kids = steps.reduce((acc, [sn, lane], k) => (lane === i ? acc.concat(['s' + k, 'st' + k]) : acc), [])
    L.push(...sh('ln' + i, 'roundRect', [lx, y, lw, lh], i % 2 === 0 ? '#7C3AED' : '#A78BFA', ['lnt' + i]))
    L.push(...tx('lnt' + i, [lx + 4, y + 24, lw - 8, 24], n, 14, '#FFFFFF', ', bold: true, align: center'))
    L.push(...sh('lb' + i, 'rect', [lx + lw, y, 780, lh], i % 2 === 0 ? '#F5F3FF' : '#FFFFFF', kids, "line: { color: '#E9D5FF', width: 1 }"))
  })
  const sw = 96, sx0 = 172, step = 124   // 卡右沿到下一卡左沿留 28px ⇒ 折点可离端点 22px
  steps.forEach(([n, lane], i) => {
    const x = sx0 + i * step
    const y = ly + lane * lstep + 14
    L.push(...sh('s' + i, 'roundRect', [x, y, sw, 44], '#FFFFFF', ['st' + i], "line: { color: '#7C3AED', width: 1.2 }"))
    L.push(...tx('st' + i, [x + 3, y + 12, sw - 6, 22], n, 11, '#2E1065', ', bold: true, align: center'))
    if (i < steps.length - 1) {
      const nx = sx0 + (i + 1) * step
      const ny = ly + steps[i + 1][1] * lstep + 14
      const pts = lane === steps[i + 1][1]
        ? [[x + sw, y + 22], [nx, ny + 22]]
        : [[x + sw, y + 22], [x + sw + 22, y + 22], [x + sw + 22, ny + 22], [nx, ny + 22]]
      L.push(...ln('a' + i, pts, '#7C3AED', 1.5, false, true))
    }
  })
  fs.writeFileSync(R + '/examples/hand-drawn/pages/04.yaml', L.join('\n') + '\n')
  console.log('04 泳道 =', L.filter((x) => x.includes('elementId')).length, '｜声明', pairs.length)
}

// ═══ 06 闭环：环形箭头改为**按卡边精确裁剪**（真正首尾相接）+ 加粗 ═══
{
  const L = HEAD('水质调控闭环', '采集 → 预测 → 调整 → 复核 → 回写：形成自动调控闭环')
  const names = ['传感器采集', '趋势预测', '投喂调整', '效果复核', '阈值回写']
  const cx = 480, cy = 312, rx = 250, ry = 132, hw = 85, hh = 26
  const pos = names.map((n, i) => {
    const a = (-90 + i * 72) * Math.PI / 180
    const c = [Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a))]
    L.push(...sh('n' + i, 'roundRect', [c[0] - hw, c[1] - hh, hw * 2, hh * 2], i === 4 ? '#E11D48' : '#7C3AED', ['nt' + i]))
    L.push(...tx('nt' + i, [c[0] - hw + 4, c[1] - 12, hw * 2 - 8, 24], n, 13, '#FFFFFF', ', bold: true, align: center'))
    return c
  })
  pos.forEach((c, i) => { L.push(...arrowBetween('c' + i, c, pos[(i + 1) % pos.length], hw, hh, hw, hh, '#7C3AED', 2.5)) })
  fs.writeFileSync(R + '/examples/hand-drawn/pages/06.yaml', L.join('\n') + '\n')
  console.log('06 闭环 =', L.filter((x) => x.includes('elementId')).length)
}

// ═══ 08 步骤环：同上（编号卡 + 精确贴边相接）+ 加粗 ═══
{
  const L = HEAD('巡检七步', '出海申报 → 断电挂牌 → 网衣外观 → 锚链张力 → 溶氧复测 → 设备保养 → 数据回传')
  const names = ['出海申报', '断电挂牌', '网衣外观', '锚链张力', '溶氧复测', '设备保养', '数据回传']
  const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦']
  const cx = 480, cy = 320, rx = 270, ry = 138, hw = 85, hh = 24
  const pos = names.map((n, i) => {
    const a = (-90 + i * (360 / 7)) * Math.PI / 180
    const c = [Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a))]
    L.push(...sh('n' + i, 'roundRect', [c[0] - hw, c[1] - hh, hw * 2, hh * 2], i === 6 ? '#E11D48' : '#7C3AED', ['nt' + i]))
    L.push(...tx('nt' + i, [c[0] - hw + 4, c[1] - 11, hw * 2 - 8, 22], marks[i] + ' ' + n, 13, '#FFFFFF', ', bold: true, align: center'))
    return c
  })
  pos.forEach((c, i) => { L.push(...arrowBetween('c' + i, c, pos[(i + 1) % pos.length], hw, hh, hw, hh, '#7C3AED', 2.5)) })
  fs.writeFileSync(R + '/examples/hand-drawn/pages/08.yaml', L.join('\n') + '\n')
  console.log('08 步骤环 =', L.filter((x) => x.includes('elementId')).length)
}

// ═══ 09 时序：消息标签加**白底芯片**（遮罩生命线）+ 避开生命线 x ═══
{
  const L = HEAD('投喂指令时序', '岸基下发计划 → 平台转发 → 投喂机执行 → 水下相机回传 → 当班汇总')
  const actors = ['岸基中心', '平台终端', '投喂机', '水下相机']
  const xs = [155, 360, 565, 770]
  const heads = [['岸基中心', 0], ['平台终端', 1], ['投喂机', 2], ['水下相机', 3]]
  heads.forEach(([n, i]) => {
    L.push(...sh('h' + i, 'roundRect', [xs[i] - 85, 110, 170, 48], '#7C3AED', ['ht' + i]))
    L.push(...tx('ht' + i, [xs[i] - 81, 122, 162, 24], n, 14, '#FFFFFF', ', bold: true, align: center'))
  })
  const msgLastY = 210 + 4 * 45
  xs.forEach((x, i) => L.push(...ln('life' + i, [[x, 158], [x, msgLastY + 24]], '#94A3B8', 1.2, true, false)))
  const msgs = [['下发计划', 0, 1], ['启动投喂', 1, 2], ['投喂完成', 2, 1], ['残饵画面', 3, 1], ['当班汇总', 1, 0]]
  msgs.forEach(([n, a, b], k) => {
    const y = 210 + k * 45
    const x1 = xs[a], x2 = xs[b]
    L.push(...ln('m' + k, [[x1, y], [x2, y]], '#E11D48', 2, false, true))
    // 芯片：中线起，若压到任一生命线就左右平移 70px（仍留在本段内）
    const mid = Math.round((x1 + x2) / 2)
    const lo = Math.min(x1, x2) + 60, hi = Math.max(x1, x2) - 60
    const bad = (x) => xs.some((lx) => Math.abs(lx - x) < 45)
    let cx2 = mid
    if (bad(cx2)) cx2 = (mid + 70 <= hi && !bad(mid + 70)) ? mid + 70 : (mid - 70 >= lo && !bad(mid - 70) ? mid - 70 : mid)
    const w = n.length * 13 + 20
    L.push(...sh('mc' + k, 'roundRect', [Math.round(cx2 - w / 2), y - 30, w, 24], '#FFFFFF', ['mt' + k], "line: { color: '#FBCFE8', width: 1 }"))
    L.push(...tx('mt' + k, [Math.round(cx2 - w / 2) + 4, y - 26, w - 8, 18], n, 11, '#9F1239', ', align: center'))
  })
  fs.writeFileSync(R + '/examples/hand-drawn/pages/09.yaml', L.join('\n') + '\n')
  console.log('09 时序 =', L.filter((x) => x.includes('elementId')).length)
}

// ═══ 10 状态机：主线转移标签**贴到箭头线上方**（原 70px 太远）═══
{
  const L = HEAD('网箱状态机', '空箱 → 已投苗 → 育肥中 → 待出栏 → 已清空；规格不足则返工回育肥中')
  const states = [['空箱', '待投放'], ['已投苗', '计 8 万尾'], ['育肥中', '日投喂 3 次'], ['待出栏', '规格达标'], ['已清空', '待清整']]
  const w = 112, h = 84, gap = 70, y = 240, x0 = 60   // gap 70 才能让转移标签落在两卡之间的间隙里
  const centers = states.map((_, i) => x0 + i * (w + gap) + w / 2)
  states.forEach(([n, sub], i) => {
    const x = x0 + i * (w + gap)
    const hot = n === '待出栏'
    L.push(...sh('st' + i, 'roundRect', [x, y, w, h], hot ? '#E11D48' : '#7C3AED', ['stt' + i, 'sts' + i]))
    L.push(...tx('stt' + i, [x + 6, y + 18, w - 12, 26], n, 16, '#FFFFFF', ', bold: true, align: center'))
    L.push(...tx('sts' + i, [x + 6, y + 48, w - 12, 20], sub, 10, hot ? '#FECDD3' : '#DDD6FE', ', align: center'))
  })
  const labels = ['投苗', '转育肥', '达规格', '出栏完毕']
  for (let i = 0; i < 4; i++) {
    const ax = x0 + i * (w + gap) + w, bx = ax + gap
    L.push(...ln('a' + i, [[ax, y + h / 2], [bx, y + h / 2]], '#7C3AED', 2, false, true))
    const lw = labels[i].length * 14 + 12
    L.push(...tx('at' + i, [Math.round(ax + (gap - lw) / 2), y + h / 2 - 24, lw, 20], labels[i], 11, '#475569', ', align: center')) // 贴线上方 4px
  }
  // 返工回边：已清空 → 育肥中
  const fromX = centers[4], toX = centers[2], laneY = 400
  L.push(...ln('back', [[fromX, y + h], [fromX, laneY], [toX, laneY], [toX, y + h]], '#E11D48', 2, true, true))
  L.push(...tx('backT', [Math.round((fromX + toX) / 2) - 50, laneY - 26, 100, 20], '规格不足', 11, '#9F1239', ', align: center'))
  fs.writeFileSync(R + '/examples/hand-drawn/pages/10.yaml', L.join('\n') + '\n')
  console.log('10 状态机 =', L.filter((x) => x.includes('elementId')).length)
}
