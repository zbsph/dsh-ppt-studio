const fs = require('fs')
const R = 'D:/SharkCode/dsh-ppt-studio'
// ① 总纲补铁律：每条边都必须有标签（本轮实测换来的）
const sk = R + '/skills/diagram-drawing/SKILL.md'
let g = fs.readFileSync(sk, 'utf8')
if (g.indexOf('每条边都必须有标签') < 0) {
  g = g.replace('7. **有意重叠要声明**', '7. **每条边都必须有标签**：图上任何转移/连线都要能读出"从哪到哪、什么条件"；缺标签 = **内容缺失**。门禁抓不到（实测主链 5 条标签全丢，门禁仍 0 错）——只能靠看图与旧版并排发现。\n8. **有意重叠要声明**')
  fs.writeFileSync(sk, g)
  console.log('OK 总纲 + 铁律8')
}
// ② state 子 skill 补标签规则
const st = R + '/skills/diagrams/state.md'
let d = fs.readFileSync(st, 'utf8')
if (d.indexOf('主链每条转移都要标签') < 0) {
  d = d.replace('## 竖向变体', '## 标签（最容易漏）\n**主链每条转移都要标签**，放在箭头**上方**（y = 卡顶 − 28），宽 80 居中于箭头中点；只标回边不标主链 ⇒ 内容就丢了（实测）。\n\n## 竖向变体')
  fs.writeFileSync(st, d)
  console.log('OK state.md + 标签规则')
}
// ③ 新写两个子 skill：layers / sequence
fs.writeFileSync(R + '/skills/diagrams/layers.md', `# 分层架构（layers）· 手画配方

## 骨架
左侧**层标签芯片**（窄条）+ 右侧**层内容带**（长条，软填充），自上而下 N 层；层间用竖直箭头表示"上行/下行"。
- 标题 (60,34)；层带 x=150，w=740，h=72，y=130 起，层距 88。
- 层芯片：x=70，w=70，h=72，fill 主色，白字 13pt（竖排或居中均可）。
- 层带：fill 暖白/浅紫（如 #EDE9FE），**必须把芯片与带内卡片写进 contains**。
- 带内卡片：白底 roundRect（h=44，y=层带+14），文字 12pt 深色；一个带放 1–2 张。
- 层间箭头：从上一带底边中点到下一带顶边，**端点正好落在带边**，宽 2，主色。

## 专属坑
1. **带内卡片压带边**：卡片要留 14px 内边距；带内卡片也各写自己的 contains。
2. **层间箭头穿过带**：箭头只在带与带之间的空隙里，不要跨带。
3. 层数 ≥5 时把 h 压到 62、层距压到 74，否则底部溢出安全区。

## 验收清单
- [ ] 每层"芯片 + 带 + 带内卡片"三层包含关系都声明；[ ] 层间箭头两端贴带边；
- [ ] 看图能一眼数清层数；[ ] 带内文字对比度 ≥3:1（浅底用深字）。
`, 'utf8')
fs.writeFileSync(R + '/skills/diagrams/sequence.md', `# 时序图（sequence）· 手画配方

## 骨架
顶部一排**参与者头卡**（等宽）+ 每人一条**虚线生命线**（垂直到页底）+ 自上而下的**消息箭头**（实线，标签在箭头上方）。
- 标题 (60,34)；头卡 w=170，h=48，y=110，x=70 起，间距 35（4 人占 70..890）。
- 生命线：从头卡底边中点到 y=470，\`dash: dash\`，颜色 #94A3B8，宽 1。
- 消息：y=200/245/290/335/380 逐条下移；从发送者生命线到接收者生命线，**端点正好落在生命线上**，end 箭头；
  标签放在箭头**上方 6px**、居中于两端之间，宽 = |x2−x1|，11pt。
- 自环消息（自己给自己）：向右折 30px 再回来（三折线），标签放右侧。

## 专属坑
1. **箭头压生命线**：箭头端点落在线上即可，不要越过。
2. **标签互相压**：相邻两条消息的 y 至少差 40；标签只占箭头正上方一行。
3. **消息方向看错**：箭头必须在**接收者**那一端（\`arrow: true\` + points 的终点是接收者）。

## 验收清单
- [ ] 每条消息能读出"谁→谁、什么消息"；[ ] 生命线不被文字压；[ ] 头和生命线同一条 x 中心。
`, 'utf8')
console.log('OK layers.md / sequence.md')

// ④ 手画第 12 页：智慧网箱四层
const layers = [
  ['感知层', ['溶氧探头', '水下相机']],
  ['通信层', ['海缆与微波']],
  ['平台层', ['生长模型', '投喂决策']],
  ['应用层', ['出栏排程看板']],
]
const el = []
const push = (s) => el.push(s.split('\n').map((l) => '  ' + l).join('\n'))
const text = (id, x, y, w, h, t, fs, color, extra) => push('- elementId: ' + id + '\n  elementType: text\n  bounds: [' + [x, y, w, h].join(', ') + ']\n  content: { text: \'' + t + '\', fontSize: ' + fs + ', color: \'' + color + '\'' + (extra || '') + ' }')
text('title', 60, 34, 700, 38, '智慧网箱四层', 25, '#2E1065', ', bold: true')
text('sub', 60, 76, 760, 22, '感知 → 通信 → 平台 → 应用：数据自下而上，指令自上而下', 12, '#64748B')
const bandY = 132, bandH = 72, step = 88, bandX = 150, bandW = 740
layers.forEach(([name, comps], i) => {
  const y = bandY + i * step
  push('- elementId: chip' + i + '\n  elementType: shape\n  kind: roundRect\n  bounds: [' + [70, y, 70, bandH].join(', ') + ']\n  fill: \'#7C3AED\'\n  contains: [chipT' + i + ']')
  text('chipT' + i, 74, y + 26, 62, 22, name, 13, '#FFFFFF', ', bold: true, align: center')
  push('- elementId: band' + i + '\n  elementType: shape\n  kind: roundRect\n  bounds: [' + [bandX, y, bandW, bandH].join(', ') + ']\n  fill: \'#EDE9FE\'\n  contains: [' + comps.map((_, j) => 'b' + i + '_' + j).join(', ') + ']')
  const cw = comps.length === 1 ? 460 : (bandW - 60) / 2
  comps.forEach((c, j) => {
    const cx = bandX + 20 + j * (cw + 20)
    push('- elementId: b' + i + '_' + j + '\n  elementType: shape\n  kind: roundRect\n  bounds: [' + [cx, y + 14, cw, 44].join(', ') + ']\n  fill: \'#FFFFFF\'\n  line: { color: \'#C4B5FD\', width: 1 }\n  contains: [bt' + i + '_' + j + ']')
    text('bt' + i + '_' + j, cx + 10, y + 26, cw - 20, 22, c, 12, '#2E1065', ', align: center')
  })
  if (i < layers.length - 1) {
    const cx = bandX + bandW / 2
    push('- elementId: ar' + i + '\n  elementType: line\n  points: [[' + cx + ', ' + (y + bandH) + '], [' + cx + ', ' + (y + step) + ']]\n  line: { color: \'#7C3AED\', width: 2 }\n  arrow: true')
  }
})
const dir = 'examples/hand-drawn'
fs.writeFileSync(dir + '/pages/12.yaml', ['pageType: content', 'elements:'].concat(el).join('\n') + '\n')
fs.writeFileSync(dir + '/deck.yaml', ['version: 1', 'title: 手画版 12+1', 'size: [960, 540]', 'theme:', '  colors:', '    primary: "#7C3AED"', '    accent: "#E11D48"', '    soft: "#EDE9FE"', '    text: "#2E1065"', '    bg: "#FAF5FF"', 'pages:', '  - pages/10.yaml', '  - pages/12.yaml', ''].join('\n'))
console.log('第 12 页元素数 =', el.length)
