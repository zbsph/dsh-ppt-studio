// 手画 05 左右对比 / 08 步骤环 + 跑管线 + 出 PNG（CJS，管线用动态 import）
const fs = require('fs')
const R = 'D:/SharkCode/dsh-ppt-studio'

const shapeL = (id, kind, b, fill, contains, extra) => {
  const L = [`  - elementId: ${id}`, '    elementType: shape', `    kind: ${kind}`, `    bounds: [${b.join(', ')}]`, `    fill: '${fill}'`]
  if (extra) L.push('    ' + extra)
  if (contains && contains.length) L.push(`    contains: [${contains.join(', ')}]`)
  return L
}
const textL = (id, b, text, size, color, extra) => [`  - elementId: ${id}`, '    elementType: text', `    bounds: [${b.join(', ')}]`, `    content: { text: '${text}', fontSize: ${size}, color: '${color}'${extra || ''} }`]
const lineL = (id, pts, color, w, dash, arrow) => [`  - elementId: ${id}`, '    elementType: line', `    points: [${pts.map((p) => `[${p[0]}, ${p[1]}]`).join(', ')}]`, ...(dash ? ['    dash: dash'] : []), `    line: { color: '${color}', width: ${w} }`, `    arrow: ${arrow ? 'true' : 'false'}`]
const HEAD = (t, s) => ['pageType: content', 'elements:', ...textL('title', [60, 34, 760, 38], t, 25, '#2E1065', ', bold: true'), ...textL('sub', [60, 76, 820, 22], s, 12, '#64748B')]

// ── 05 左右对比：网衣清洗两方案 ──
{
  const L = HEAD('网衣清洗两方案', '同为清洗网衣：人工潜水 vs 水下机器人，各有权衡')
  const panels = [
    { id: 'A', x: 80, fill: '#F5F3FF', head: '方案 A：潜水人工', tone: '#6D28D9', rows: ['潜水人工', '清洗彻底', '作业窗口 ≤2h', '人力紧张'] },
    { id: 'B', x: 500, fill: '#FFF1F2', head: '方案 B：水下机器人', tone: '#BE123C', rows: ['水下机器人', '可夜间作业', '覆盖率 92%', '购置成本高'] },
  ]
  const kidsAll = []
  panels.forEach((p) => {
    const hx = p.x + 20
    const rowIds = p.rows.map((_, k) => `p${p.id}r${k}`)
    kidsAll.push(...shapeL('p' + p.id, 'roundRect', [p.x, 150, 380, 300], p.fill, ['p' + p.id + 'h', ...rowIds], "line: { color: '#DDD6FE', width: 1.5 }"))
    kidsAll.push(...textL('p' + p.id + 'h', [hx, 168, 340, 28], p.head, 16, p.tone, ', bold: true, align: center'))
    p.rows.forEach((r, k) => {
      const y = 216 + k * 54
      kidsAll.push(...shapeL(`p${p.id}r${k}`, 'roundRect', [hx, y, 340, 44], '#FFFFFF', [`p${p.id}r${k}t`], "line: { color: '#E5E7EB', width: 1 }"))
      kidsAll.push(...textL(`p${p.id}r${k}t`, [hx + 10, y + 12, 320, 22], r, 13, '#1F2937', ', align: center'))
    })
  })
  L.push(...kidsAll)
  L.push(...textL('vs', [462, 292, 36, 22], '对比', 11, '#7C3AED', ', bold: true, align: center'))
  fs.writeFileSync(R + '/examples/hand-drawn/pages/05.yaml', L.join('\n') + '\n')
  console.log('05 左右对比元素 =', L.filter((x) => x.includes('elementId')).length)
}

// ── 08 步骤环：巡检七步（7 张卡环形 + 沿环箭头）──
{
  const L = HEAD('巡检七步', '出海申报 → 断电挂牌 → 网衣外观 → 锚链张力 → 溶氧复测 → 设备保养 → 数据回传')
  const names = ['出海申报', '断电挂牌', '网衣外观', '锚链张力', '溶氧复测', '设备保养', '数据回传']
  const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦']
  const cx = 480, cy = 320, rx = 270, ry = 138
  const pos = []
  names.forEach((n, i) => {
    const a = (-90 + i * (360 / 7)) * Math.PI / 180
    const x = Math.round(cx + rx * Math.cos(a) - 85)
    const y = Math.round(cy + ry * Math.sin(a) - 24)
    pos.push({ x, y })
    L.push(...shapeL('n' + i, 'roundRect', [x, y, 170, 48], i === 6 ? '#E11D48' : '#7C3AED', ['nt' + i]))
    L.push(...textL('nt' + i, [x + 6, y + 13, 158, 22], marks[i] + ' ' + n, 13, '#FFFFFF', ', bold: true, align: center'))
  })
  pos.forEach((p, i) => {
    const q = pos[(i + 1) % pos.length]
    const pC = { x: p.x + 85, y: p.y + 24 }
    const qC = { x: q.x + 85, y: q.y + 24 }
    const dx = qC.x - pC.x, dy = qC.y - pC.y
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const ux = dx / len, uy = dy / len
    const off = 94
    L.push(...lineL('c' + i, [[Math.round(pC.x + ux * off), Math.round(pC.y + uy * off)], [Math.round(qC.x - ux * off), Math.round(qC.y - uy * off)]], '#C4B5FD', 1.5, false, true))
  })
  fs.writeFileSync(R + '/examples/hand-drawn/pages/08.yaml', L.join('\n') + '\n')
  console.log('08 步骤环元素 =', L.filter((x) => x.includes('elementId')).length)
}

const order = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '12']
fs.writeFileSync(R + '/examples/hand-drawn/deck.yaml', ['version: 1', 'title: 手画版 12+1', 'size: [960, 540]', 'theme:', '  colors:', '    primary: "#7C3AED"', '    accent: "#E11D48"', '    soft: "#EDE9FE"', '    text: "#2E1065"', '    bg: "#FAF5FF"', 'pages:'].concat(order.map((n) => '  - pages/' + n + '.yaml')).join('\n') + '\n')
console.log('deck 已更新为', order.length, '页')

// ── 管线：解析 → 门禁 → 导出 → 真渲染 → 按页序命名 ──
;(async () => {
  const { resolveDeck } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/pptd/schema.js')
  const { renderDeck } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/pptd/render-html.js')
  const { exportPptx } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/pptd/export-pptx.js')
  const { renderPptxToPng } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/msrender.js')
  const { verifyDeck } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/verify.js')
  const src = R + '/examples/hand-drawn'
  const out = 'D:/SharkCode/ppt-deliverable/手画12+1'
  fs.mkdirSync(out, { recursive: true })
  const ctx = await resolveDeck(src)
  await renderDeck(ctx, { out: 'preview' })
  const layout = JSON.parse(fs.readFileSync(src + '/preview/layout.json', 'utf8'))
  const pages = Array.isArray(layout.pages) ? layout.pages : Object.values(layout.pages)
  const NAME = { '01': '01-层级树（手画）.png', '02': '02-矩阵（手画）.png', '03': '03-时间轴（手画）.png', '04': '04-泳道（手画）.png', '05': '05-左右对比（手画）.png', '06': '06-闭环（手画）.png', '07': '07-漏斗（手画）.png', '08': '08-步骤环（手画）.png', '09': '09-时序（手画）.png', '10': '10-状态机（手画）.png', '12': '12-分层架构（手画）.png' }
  pages.forEach((p, i) => {
    const v = verifyDeck({ pages: [p] })
    console.log('[' + order[i] + '] 元素 ' + p.elements.length + '｜门禁 错' + v.errors.length + '/警' + v.warns.length)
    for (const e of v.errors.slice(0, 4)) console.log('   [' + e.code + '] ' + String(e.message).replace(/\s+/g, ' ').slice(0, 96))
  })
  const r = await exportPptx(ctx, { out: out + '/手画12+1.pptx' })
  console.log('导出 parity.ok =', r.parity?.ok, '｜页数', ctx.pages.length)
  try {
    await renderPptxToPng(out + '/手画12+1.pptx', out, { pages: pages.map((_, i) => i + 1) })
    let ok = 0
    order.forEach((code, i) => {
      const f = out + '/' + String(i + 1).padStart(2, '0') + '.png'
      if (fs.existsSync(f)) { fs.copyFileSync(f, out + '/' + NAME[code]); ok++ }
    })
    console.log('PNG 就位 =', ok + '/' + order.length)
  } catch (e) { console.log('渲染失败 ✗ ' + String(e.message).split('\n')[0].slice(0, 80)) }
})()
