// 手画第 07 页：分级出栏漏斗（custGeom 真梯形逐段收窄）
// 用文件工具直接落盘，避免 shell here-string 的转义问题（教训记录：pitfalls 里的"转义地狱"）
const fs = require('fs')
const path = 'D:/SharkCode/dsh-ppt-studio/examples/hand-drawn/pages/07.yaml'

const rows = [
  ['存栏', '52000', 760],
  ['达捕捞规格', '31000', 560],
  ['抽检合格', '18400', 360],
  ['直供', '5600', 200],
]
const bandH = 70
const topY = 148
const bw = 800
const bx = 80

const out = []
const push = (lines) => out.push(...lines)

push([
  'pageType: content',
  'elements:',
  '  - elementId: title',
  '    elementType: text',
  '    bounds: [60, 34, 720, 38]',
  "    content: { text: '分级出栏漏斗', fontSize: 25, color: '#2E1065', bold: true }",
  '  - elementId: sub',
  '    elementType: text',
  '    bounds: [60, 76, 800, 22]',
  "    content: { text: '存栏 52000 → 达规格 31000 → 抽检合格 18400 → 直供 5600', fontSize: 12, color: '#64748B' }",
])

rows.forEach(([name, value, topW], i) => {
  const y = topY + i * bandH
  const botW = i + 1 < rows.length ? rows[i + 1][2] : Math.round(topW * 0.5)
  const labelW = Math.max(140, Math.min(topW, botW) - 60)
  const labelX = Math.round(480 - labelW / 2)
  const fill = i === rows.length - 1 ? '#E11D48' : '#7C3AED'
  push([
    `  - elementId: f${i}`,
    '    elementType: shape',
    '    kind: custGeom',
    `    bounds: [${bx}, ${y}, ${bw}, ${bandH}]`,
    `    fill: '${fill}'`,
    "    line: { color: '#FFFFFF', width: 1.5 }",
    `    contains: [ft${i}]`,
    '    path:',
    `      w: ${bw}`,
    `      h: ${bandH}`,
    '      commands:',
    `        - { cmd: moveTo, pts: [[${Math.round((bw - topW) / 2)}, 0]] }`,
    `        - { cmd: lnTo, pts: [[${Math.round((bw + topW) / 2)}, 0]] }`,
    `        - { cmd: lnTo, pts: [[${Math.round((bw + botW) / 2)}, ${bandH}]] }`,
    `        - { cmd: lnTo, pts: [[${Math.round((bw - botW) / 2)}, ${bandH}]] }`,
    '        - { cmd: close }',
    `  - elementId: ft${i}`,
    '    elementType: text',
    `    bounds: [${labelX}, ${y + 24}, ${labelW}, 26]`,
    `    content: { text: '${name} ${value}', fontSize: 15, color: '#FFFFFF', bold: true, align: center }`,
  ])
})

fs.writeFileSync(path, out.join('\n') + '\n')
const shapes = rows.length
const texts = out.filter((l) => l.includes('elementType: text')).length
console.log('已写入 07.yaml：custGeom 段 =', shapes, '｜文本元素 =', texts)
