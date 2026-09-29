// 13 页：按 SCHEMA_REF 第7条改用 attach（引擎接到**真实斜边**），撤掉手算 15px 内缩 + expectedOverlaps
// 同时自验：打印本页门禁 错/警 明细。不导出 pptx、不渲染（避免 PowerPoint 占用）。
const fs = require('fs')
const R = 'D:/SharkCode/dsh-ppt-studio'
const sh = (id, kind, b, fill, contains, extra) => { const L = ['  - elementId: ' + id, '    elementType: shape', '    kind: ' + kind, '    bounds: [' + b.join(', ') + ']', "    fill: '" + fill + "'"]; if (extra) L.push('    ' + extra); if (contains && contains.length) L.push('    contains: [' + contains.join(', ') + ']'); return L }
const tx = (id, b, t, s, c, ex) => ['  - elementId: ' + id, '    elementType: text', '    bounds: [' + b.join(', ') + ']', "    content: { text: '" + t + "', fontSize: " + s + ", color: '" + c + "'" + (ex || '') + ' }']
const lnA = (id, pts, c, w, dash, arrow, attach) => ['  - elementId: ' + id, '    elementType: line', '    points: [' + pts.map((p) => '[' + p[0] + ', ' + p[1] + ']').join(', ') + ']', ...(dash ? ['    dash: dash'] : []), "    line: { color: '" + c + "', width: " + w + ' }', '    arrow: ' + (arrow ? 'true' : 'false'), '    attach:', '      from: { ref: ' + attach[0] + ', side: ' + attach[1] + ' }', '      to: { ref: ' + attach[2] + ', side: ' + attach[3] + ' }']

const L = ['pageType: content', 'elements:']
L.push(...tx('title', [60, 34, 760, 38], '深海养殖平台架构', 25, '#2E1065', ', bold: true'))
L.push(...tx('sub', [60, 76, 820, 22], '感知层采集 → 平台层建模与决策 → 决策层排程；投喂计划回写形成闭环', 12, '#64748B'))
L.push(...tx('k1', [70, 118, 200, 22], '① 感知层', 14, '#E11D48', ', bold: true'))
L.push(...tx('k2', [374, 118, 220, 22], '② 平台层', 14, '#7C3AED', ', bold: true, align: center'))
L.push(...tx('k3', [690, 118, 200, 22], '③ 决策层', 14, '#E11D48', ', bold: true, align: right'))
// 左：感知（平行四边形）
L.push(...sh('left', 'parallelogram', [80, 216, 176, 118], '#E11D48', ['leftT', 'leftS']))
L.push(...tx('leftT', [110, 252, 116, 24], '溶氧·水温', 13, '#FFFFFF', ', bold: true, align: center'))
L.push(...tx('leftS', [110, 280, 116, 20], '水下相机', 11, '#FECDD3', ', align: center'))
// 中：平台层软容器 + 3 卡
const cards = ['海缆与微波链路', '生长与环境模型', '投喂决策引擎']
L.push(...sh('mid', 'roundRect', [336, 176, 292, 214], '#EDE9FE', cards.map((_, i) => ['m' + i, 'mt' + i]).flat()))
cards.forEach((n, i) => {
  const y = 196 + i * 66
  L.push(...sh('m' + i, 'roundRect', [356, y, 252, 52], '#7C3AED', ['mt' + i]))
  L.push(...tx('mt' + i, [362, y + 14, 240, 24], n, 13, '#FFFFFF', ', bold: true, align: center'))
})
// 右：决策（平行四边形）
L.push(...sh('right', 'parallelogram', [688, 216, 176, 118], '#7C3AED', ['rightT', 'rightS']))
L.push(...tx('rightT', [718, 252, 116, 24], '出栏排程', 13, '#FFFFFF', ', bold: true, align: center'))
L.push(...tx('rightS', [718, 280, 116, 20], '看板下发', 11, '#DDD6FE', ', align: center'))
// 左→中三条（肘线；两端由 attach 锚到**真实边**，中间拐点仍由 points 决定）
L.push(...lnA('l0', [[256, 275], [290, 275], [290, 222], [356, 222]], '#1F2937', 1.5, false, true, ['left', 'right', 'm0', 'left']))
L.push(...lnA('l1', [[256, 275], [356, 275]], '#1F2937', 1.5, false, true, ['left', 'right', 'm1', 'left']))
L.push(...lnA('l2', [[256, 275], [290, 275], [290, 328], [356, 328]], '#1F2937', 1.5, false, true, ['left', 'right', 'm2', 'left']))
// 中→右
L.push(...lnA('l3', [[628, 275], [688, 275]], '#1F2937', 1.5, false, true, ['m1', 'right', 'right', 'left']))
// 底部回路：决策层底边 → 感知层底边（两端 attach 到真实边）
L.push(...lnA('back2', [[776, 334], [776, 430], [168, 430], [168, 334]], '#94A3B8', 1.5, true, true, ['right', 'bottom', 'left', 'bottom']))
L.push(...sh('backChip', 'roundRect', [402, 418, 180, 26], '#FFFFFF', ['backChipT']))
L.push(...tx('backChipT', [406, 422, 172, 20], '投喂计划回写', 11, '#475569', ', align: center'))

fs.writeFileSync(R + '/examples/hand-drawn/pages/13.yaml', L.join('\n') + '\n')
console.log('13.yaml 已重写：元素 =', L.filter((x) => x.includes('elementId')).length, '｜attach 线 = 5｜expectedOverlaps 已移除（不再需要）')

;(async () => {
  const { resolveDeck } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/pptd/schema.js')
  const { renderDeck } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/pptd/render-html.js')
  const { verifyDeck } = await import('file:///D:/SharkCode/dsh-ppt-studio/lib/verify.js')
  const src = R + '/examples/hand-drawn'
  const ctx = await resolveDeck(src)
  await renderDeck(ctx, { out: 'preview' })
  const layout = JSON.parse(fs.readFileSync(src + '/preview/layout.json', 'utf8'))
  const pages = Array.isArray(layout.pages) ? layout.pages : Object.values(layout.pages)
  const p13 = pages[12]
  const v = verifyDeck({ pages: [p13] })
  console.log('13 页门禁：错' + v.errors.length + ' / 警' + v.warns.length)
  for (const e of v.errors.slice(0, 4)) console.log('   [错][' + e.code + '] ' + String(e.message).replace(/\s+/g, ' ').slice(0, 100))
  for (const w of v.warns.slice(0, 6)) console.log('   [警][' + w.code + '] ' + String(w.message).replace(/\s+/g, ' ').slice(0, 100))
  // attach 是否真的接管了端点：看 layout 里的 attachNotes / 实际 points
  const el = (p13.elements ?? []).find((e) => e.id === 'l1')
  console.log('l1 解析后 points =', JSON.stringify(el?.points), '｜attachNotes =', (el?.attachNotes ?? []).length)
})()
