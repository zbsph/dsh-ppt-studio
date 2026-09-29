const fs = require('fs')
const R = 'D:/SharkCode/dsh-ppt-studio'
const mk = () => { const el = []; const push = (s) => el.push(s.split('\n').map((l) => '  ' + l).join('\n'))
  const text = (id, x, y, w, h, t, fs, color, extra) => push('- elementId: ' + id + '\n  elementType: text\n  bounds: [' + [x, y, w, h].join(', ') + ']\n  content: { text: \'' + t + '\', fontSize: ' + fs + ', color: \'' + color + '\'' + (extra || '') + ' }')
  const shape = (id, kind, x, y, w, h, fill, contains, extra) => push('- elementId: ' + id + '\n  elementType: shape\n  kind: ' + kind + '\n  bounds: [' + [x, y, w, h].join(', ') + ']\n  fill: \'' + fill + '\'' + (extra || '') + (contains && contains.length ? '\n  contains: [' + contains.join(', ') + ']' : ''))
  const line = (id, pts, color, w, dash, arrow) => push('- elementId: ' + id + '\n  elementType: line\n  points: [' + pts.map((p) => '[' + p[0] + ', ' + p[1] + ']').join(', ') + ']' + (dash ? '\n  dash: dash' : '') + '\n  line: { color: \'' + color + '\', width: ' + w + ' }\n  arrow: ' + (arrow === undefined ? 'false' : arrow))
  return { el, text, shape, line } }
const head = (t, sub) => { const m = mk(); m.text('title', 60, 34, 720, 38, t, 25, '#2E1065', ', bold: true'); m.text('sub', 60, 76, 780, 22, sub, 12, '#64748B'); return m }

// ── 01 层级树：平台长 → 三组 → 叶节点 ──
{
  const m = head('养殖平台组织', '平台长统管三个组；养殖组与装备组下再设班组')
  m.shape('root', 'roundRect', 380, 124, 200, 64, '#7C3AED', ['rootT', 'rootS'])
  m.text('rootT', 388, 132, 184, 24, '平台长', 16, '#FFFFFF', ', bold: true, align: center')
  m.text('rootS', 388, 160, 184, 18, '养殖体系', 10, '#EDE9FE', ', align: center')
  const g = [['养殖组', 90], ['装备组', 395], ['质检组', 700]]
  g.forEach(([n, x], i) => {
    m.shape('g' + i, 'roundRect', x, 258, 170, 52, '#EDE9FE', ['gt' + i], '\n  line: { color: \'#C4B5FD\', width: 1 }')
    m.text('gt' + i, x + 8, 272, 154, 24, n, 14, '#2E1065', ', bold: true, align: center')
    m.line('gl' + i, [[480, 188], [480, 220], [x + 85, 220], [x + 85, 258]], '#7C3AED', 1.5, false, true)
  })
  const leaves = [['投喂一班', 60, 0], ['投喂二班', 218, 0], ['网衣维护', 376, 1]]
  leaves.forEach(([n, x, p], i) => {
    m.shape('lf' + i, 'roundRect', x, 380, 150, 48, '#FFFFFF', ['lft' + i], '\n  line: { color: \'#C4B5FD\', width: 1 }')
    m.text('lft' + i, x + 8, 393, 134, 22, n, 12, '#2E1065', ', align: center')
    const px = p === 0 ? 175 : 480
    m.line('lfl' + i, [[px, 310], [px, 344], [x + 75, 344], [x + 75, 380]], '#C4B5FD', 1.2, false, true)
  })
  fs.writeFileSync(R + '/examples/hand-drawn/pages/01.yaml', ['pageType: content', 'elements:'].concat(m.el).join('\n') + '\n')
  console.log('01 层级树元素 =', m.el.length)
}
// ── 03 时间轴：6 个里程碑，标签上下交替 ──
{
  const m = head('投苗到出栏', '六个里程碑：检疫 → 投苗 → 分箱 → 育肥 → 抽检 → 出栏')
  const ms = [['苗种检疫', '入箱前检测'], ['分级投苗', '按规格入箱'], ['中期分箱', '降低密度'], ['强化育肥', '配方调整'], ['起网抽检', '规格确认'], ['成鱼出栏', '冷链交付']]
  const y = 300, x0 = 90, step = 156
  m.line('axis', [[70, y], [890, y]], '#C4B5FD', 3)
  ms.forEach(([n, d], i) => {
    const x = x0 + i * step
    m.shape('d' + i, 'ellipse', x - 9, y - 9, 18, 18, i === 2 ? '#E11D48' : '#7C3AED', [])
    const up = i % 2 === 0
    const ly = up ? y - 96 : y + 34
    m.text('mt' + i, x - 70, ly, 140, 22, n, 14, '#2E1065', ', bold: true, align: center')
    m.text('md' + i, x - 70, ly + 24, 140, 20, d, 11, '#64748B', ', align: center')
    m.line('ml' + i, [[x, up ? y - 9 : y + 9], [x, up ? ly + 48 : ly]], '#C4B5FD', 1)
  })
  fs.writeFileSync(R + '/examples/hand-drawn/pages/03.yaml', ['pageType: content', 'elements:'].concat(m.el).join('\n') + '\n')
  console.log('03 时间轴元素 =', m.el.length)
}
// ── 07 漏斗：宽度递减（720/540/360/220），文字在条内 ──
{
  const m = head('分级出栏漏斗', '存栏 52000 → 达规格 31000 → 抽检合格 18400 → 直供 5600')
  const rows = [['存栏', '52000', 760], ['达捕捞规格', '31000', 560], ['抽检合格', '18400', 360], ['直供', '5600', 200]]
  const bandH = 70, topY = 148, bw = 800, bx = 480 - bw / 2
  rows.forEach(([nm, vv, wt], i) => {
    const y = topY + i * bandH
    const wb = i + 1 < rows.length ? rows[i + 1][2] : Math.round(wt * 0.5)
    const lw = Math.max(140, Math.min(wt, wb) - 60)
    const L = []
    L.push('- elementId: f' + i)
    L.push('  elementType: shape')
    L.push('  kind: custGeom')
    L.push('  bounds: [' + [bx, y, bw, bandH].join(', ') + ']')
    L.push("  fill: '" + (i === rows.length - 1 ? '#E11D48' : '#7C3AED') + "'")
    L.push("  line: { color: '#FFFFFF', width: 1.5 }")
    L.push('  contains: [ft' + i + ']')
    L.push('  path:')
    L.push('    w: ' + bw)
    L.push('    h: ' + bandH)
    L.push('    commands:')
    L.push('      - { cmd: moveTo, pts: [[' + Math.round((bw - wt) / 2) + ', 0]] }')
    L.push('      - { cmd: lnTo, pts: [[' + Math.round((bw + wt) / 2) + ', 0]] }')
    L.push('      - { cmd: lnTo, pts: [[' + Math.round((bw + wb) / 2) + ', ' + bandH + ']] }')
    L.push('      - { cmd: lnTo, pts: [[' + Math.round((bw - wb) / 2) + ', ' + bandH + ']] }')
    L.push('      - { cmd: close }')
    push(L.join('\n'))
    text('ft' + i, Math.round(480 - lw / 2), y + 24, lw, 26, nm + ' ' + vv, 15, '#FFFFFF', ', bold: true, align: center')
  })
  fs.writeFileSync(R + '/examples/hand-drawn/pages/07.yaml', ['pageType: content', 'elements:'].concat(m.el).join('\n') + '\n')
  console.log('07 漏斗元素 =', m.el.length)
}
fs.writeFileSync(R + '/examples/hand-drawn/deck.yaml', ['version: 1', 'title: 手画版 12+1', 'size: [960, 540]', 'theme:', '  colors:', '    primary: "#7C3AED"', '    accent: "#E11D48"', '    soft: "#EDE9FE"', '    text: "#2E1065"', '    bg: "#FAF5FF"', 'pages:', '  - pages/01.yaml', '  - pages/03.yaml', '  - pages/07.yaml', '  - pages/09.yaml', '  - pages/10.yaml', '  - pages/12.yaml', ''].join('\n'))
console.log('deck 已更新为 6 页')
