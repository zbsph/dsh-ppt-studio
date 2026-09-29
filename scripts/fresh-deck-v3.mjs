/**
 * 从零重画 12+1 · 第三批（X4）：全新领域 + 全新配色 + 全新内容，不复用任何既有 deck/夹具/结果。
 *   领域：深海网箱养殖（投苗/投喂/巡检/起网/出栏）；
 *   配色：**紫·珊瑚系**（primary #7C3AED / accent #E11D48 / soft #EDE9FE / text #2E1065 / bg #FAF5FF）；
 *   第 13 页为**手写暖色**架构图（保留用户要的暖色调测试图）。
 * 用法：node scripts/fresh-deck-v3.mjs [输出目录，缺省 examples/archive/fresh-sea-family（族时代工具，F4 后将被删除）]
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

const out = process.argv[2] ?? 'examples/archive/fresh-sea-family'
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'pages'), { recursive: true })

writeFileSync(join(out, 'deck.yaml'), YAML.stringify({
  version: 1,
  title: '南礁深海网箱 · 投喂与巡检（第三批 · 从零重画）',
  size: [960, 540],
  theme: {
    colors: { primary: '#7C3AED', accent: '#E11D48', soft: '#EDE9FE', text: '#2E1065', bg: '#FAF5FF' },
    textStyles: { body: { fontSize: 13, color: '$text' } },
    safeArea: { top: 40, bottom: 40, left: 40, right: 40 },
  },
  pages: Array.from({ length: 13 }, (_, i) => `pages/${String(i + 1).padStart(2, '0')}.yaml`),
}))

const P = {
  '01': { pageType: 'content', diagram: { type: 'tree', title: '养殖平台组织',
    nodes: [{ id: 'r', label: '平台长' }, { id: 'o', label: '养殖组' }, { id: 'm', label: '装备组' }, { id: 'q', label: '质检组' },
      { id: 'o1', label: '投喂一班' }, { id: 'o2', label: '投喂二班' }, { id: 'm1', label: '网衣维护', emphasis: 'accent' }],
    edges: [{ from: 'r', to: 'o' }, { from: 'r', to: 'm' }, { from: 'r', to: 'q' }, { from: 'o', to: 'o1' }, { from: 'o', to: 'o2' }, { from: 'm', to: 'm1' }],
    groups: [{ id: 'g_yz', label: '养殖体系', members: ['o', 'o1', 'o2'] }] } },
  '02': { pageType: 'content', diagram: { type: 'matrix', title: '风险处置优先级', cols: 3,
    colLabels: ['可观察', '当班处置', '立即撤离'], rowLabels: ['高频', '低频'],
    nodes: [{ id: 'k1', label: '溶氧骤降', emphasis: 'accent' }, { id: 'k2', label: '网衣破损' }, { id: 'k3', label: '台风预警' },
      { id: 'k4', label: '附着物增多' }, { id: 'k5', label: '锚链磨损' }, { id: 'k6', label: '低温胁迫' }] } },
  '03': { pageType: 'content', diagram: { type: 'timeline', title: '投苗到出栏',
    nodes: [{ id: 't1', label: '苗种检疫' }, { id: 't2', label: '分级投苗' }, { id: 't3', label: '中期分箱', emphasis: 'accent' },
      { id: 't4', label: '强化育肥' }, { id: 't5', label: '起网抽检' }, { id: 't6', label: '成鱼出栏' }] } },
  '04': { pageType: 'content', diagram: { type: 'swimlane', title: '日投喂与巡检',
    groups: [{ id: 'l1', label: '集控', members: ['a1', 'a2'] }, { id: 'l2', label: '投喂', members: ['b1'] },
      { id: 'l3', label: '潜水', members: ['c1'] }, { id: 'l4', label: '质检', members: ['d1', 'd2'] }],
    nodes: [{ id: 'a1', label: '投喂计划' }, { id: 'a2', label: '水质复核' }, { id: 'b1', label: '自动投喂' },
      { id: 'c1', label: '水下巡检' }, { id: 'd1', label: '取样检测' }, { id: 'd2', label: '结果归档', emphasis: 'accent' }],
    edges: [{ from: 'a1', to: 'a2', label: '复核' }, { from: 'a2', to: 'b1' }, { from: 'b1', to: 'c1' }, { from: 'c1', to: 'd1' }, { from: 'd1', to: 'd2' }] } },
  '05': { pageType: 'content', diagram: { type: 'compare', title: '网衣清洗两方案',
    nodes: [{ id: 'a1', label: '潜水人工' }, { id: 'a2', label: '清洗彻底' }, { id: 'a3', label: '窗口 ≤2h' }, { id: 'a4', label: '人力紧张' },
      { id: 'b1', label: '水下机器人' }, { id: 'b2', label: '可夜间作业' }, { id: 'b3', label: '覆盖率 92%' }, { id: 'b4', label: '购置成本高' }],
    groups: [{ id: 'left', label: '方案 A：人工', members: ['a1', 'a2', 'a3', 'a4'] },
      { id: 'right', label: '方案 B：机器人', members: ['b1', 'b2', 'b3', 'b4'] }] } },
  '06': { pageType: 'content', diagram: { type: 'cycle', title: '水质调控闭环',
    nodes: [{ id: 'q1', label: '传感器采集' }, { id: 'q2', label: '趋势预测' }, { id: 'q3', label: '投喂调整' },
      { id: 'q4', label: '效果复核' }, { id: 'q5', label: '阈值回写', emphasis: 'accent' }] } },
  '07': { pageType: 'content', diagram: { type: 'funnel', title: '分级出栏漏斗',
    nodes: [{ id: 'f1', label: '存栏 52000' }, { id: 'f2', label: '达捕捞规格 31000' }, { id: 'f3', label: '抽检合格 18400' }, { id: 'f4', label: '直供 5600', emphasis: 'accent' }] } },
  '08': { pageType: 'content', diagram: { type: 'steps', title: '巡检七步',
    nodes: [{ id: 's1', label: '出海申报' }, { id: 's2', label: '断电挂牌' }, { id: 's3', label: '网衣外观' }, { id: 's4', label: '锚链张力' },
      { id: 's5', label: '溶氧复测' }, { id: 's6', label: '设备保养' }, { id: 's7', label: '数据回传', emphasis: 'accent' }] } },
  '09': { pageType: 'content', diagram: { type: 'sequence', title: '投喂指令时序',
    nodes: [{ id: 'u', label: '岸基中心' }, { id: 'p', label: '平台终端' }, { id: 'f', label: '投喂机' }, { id: 's', label: '水下相机' }],
    edges: [{ from: 'u', to: 'p', label: '下发计划' }, { from: 'p', to: 'f', label: '启动投喂' }, { from: 'f', to: 'p', label: '投喂完成' },
      { from: 's', to: 'p', label: '残饵画面' }, { from: 'p', to: 'u', label: '当班汇总', style: 'dashed' }] } },
  '10': { pageType: 'content', diagram: { type: 'state',
    nodes: [{ id: 's0', label: '空箱' }, { id: 's1', label: '已投苗' }, { id: 's2', label: '育肥中' }, { id: 's3', label: '待出栏', emphasis: 'accent' }, { id: 's4', label: '已清空' }],
    edges: [{ from: 's0', to: 's1', label: '投苗' }, { from: 's1', to: 's2', label: '转育肥' }, { from: 's2', to: 's3', label: '达规格' },
      { from: 's3', to: 's4', label: '出栏完毕' }, { from: 's2', to: 's1', label: '规格不足' }] } },
  '11': { pageType: 'content', diagram: { type: 'flow', direction: 'LR',
    nodes: [{ id: 'a', label: '出栏申报' }, { id: 'b', label: '起网准备' }, { id: 'c', label: '起网', emphasis: 'accent' }, { id: 'd', label: '冰鲜装箱' }, { id: 'e', label: '驳船转运' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }, { from: 'd', to: 'e' }] } },
  '12': { pageType: 'content', diagram: { type: 'layers', title: '智慧网箱四层',
    groups: [{ id: 'l1', label: '感知层', members: ['a1', 'a2'] }, { id: 'l2', label: '通信层', members: ['b1'] },
      { id: 'l3', label: '平台层', members: ['c1', 'c2'] }, { id: 'l4', label: '应用层', members: ['d1'] }],
    nodes: [{ id: 'a1', label: '溶氧探头' }, { id: 'a2', label: '水下相机' }, { id: 'b1', label: '海缆与微波' },
      { id: 'c1', label: '生长模型' }, { id: 'c2', label: '投喂决策' }, { id: 'd1', label: '出栏排程看板', emphasis: 'accent' }],
    edges: [{ from: 'a1', to: 'b1' }, { from: 'a2', to: 'b1' }, { from: 'b1', to: 'c1' }, { from: 'c1', to: 'c2' }, { from: 'c2', to: 'd1' }] } },
  // ⑬ 手写暖色（不依赖任何族）：① 感知层 / ② 平台层 / ③ 决策层
  '13': { pageType: 'content', elements: [
    { elementId: 'title', elementType: 'text', bounds: [60, 40, 460, 40], content: { text: '深海养殖平台架构', fontSize: 26, bold: true, color: '$text' } },
    { elementId: 'k1', elementType: 'text', bounds: [70, 100, 220, 24], content: { text: '① 感知层', fontSize: 15, color: '$accent' } },
    { elementId: 'k2', elementType: 'text', bounds: [400, 100, 220, 24], content: { text: '② 平台层', fontSize: 15, color: '$accent', align: 'center' } },
    { elementId: 'k3', elementType: 'text', bounds: [720, 100, 190, 24], content: { text: '③ 决策层', fontSize: 15, color: '$accent', align: 'center' } },
    { elementId: 'sens', elementType: 'shape', kind: 'parallelogram', bounds: [80, 190, 170, 130], fill: '$accent', contains: ['sens_lab'] },
    { elementId: 'sens_lab', elementType: 'text', bounds: [120, 240, 100, 30], content: { text: '溶氧·水温', fontSize: 12, color: '$bg', align: 'center' } },
    { elementId: 'app', elementType: 'shape', kind: 'parallelogram', bounds: [700, 190, 170, 130], fill: '$primary', contains: ['app_lab'] },
    { elementId: 'app_lab', elementType: 'text', bounds: [740, 240, 100, 30], content: { text: '出栏排程', fontSize: 12, color: '$bg', align: 'center' } },
    { elementId: 'core', elementType: 'shape', kind: 'roundRect', bounds: [320, 150, 340, 240], fill: '$soft', role: 'decoration', roleReason: '平台底板' },
    { elementId: 'm1', elementType: 'shape', kind: 'rect', bounds: [345, 175, 290, 56], fill: '$primary', contains: ['m1_lab'] },
    { elementId: 'm1_lab', elementType: 'text', bounds: [355, 192, 270, 24], content: { text: '海缆与微波链路', fontSize: 12, color: '$bg', align: 'center' } },
    { elementId: 'm2', elementType: 'shape', kind: 'rect', bounds: [345, 245, 290, 56], fill: '$primary', contains: ['m2_lab'] },
    { elementId: 'm2_lab', elementType: 'text', bounds: [355, 262, 270, 24], content: { text: '生长与水环境模型', fontSize: 12, color: '$bg', align: 'center' } },
    { elementId: 'm3', elementType: 'shape', kind: 'rect', bounds: [345, 315, 290, 56], fill: '$primary', contains: ['m3_lab'] },
    { elementId: 'm3_lab', elementType: 'text', bounds: [355, 332, 270, 24], content: { text: '投喂决策引擎', fontSize: 12, color: '$bg', align: 'center' } },
    { elementId: 'in_trunk', elementType: 'line', points: [[250, 255], [285, 255]], arrow: false, attach: { from: { ref: 'sens', side: 'right' } } },
    { elementId: 'in_v', elementType: 'line', points: [[285, 203], [285, 343]], arrow: false },
    { elementId: 'br1', elementType: 'line', points: [[285, 203], [345, 203]], arrow: true },
    { elementId: 'br2', elementType: 'line', points: [[285, 273], [345, 273]], arrow: true },
    { elementId: 'br3', elementType: 'line', points: [[285, 343], [345, 343]], arrow: true },
    { elementId: 'st1', elementType: 'line', points: [[635, 203], [670, 203]], arrow: false },
    { elementId: 'st2', elementType: 'line', points: [[635, 273], [670, 273]], arrow: false },
    { elementId: 'st3', elementType: 'line', points: [[635, 343], [670, 343]], arrow: false },
    { elementId: 'out_v', elementType: 'line', points: [[670, 203], [670, 343]], arrow: false },
    { elementId: 'out_arrow', elementType: 'line', points: [[670, 273], [700, 273]], arrow: true, attach: { to: { ref: 'app', side: 'left' } } },
    { elementId: 'fb', elementType: 'line', points: [[785, 320], [785, 465], [165, 465], [165, 320]], arrow: true, line: { color: '$text', width: 1.5, dash: 'dash' }, attach: { from: { ref: 'app', side: 'bottom' }, to: { ref: 'sens', side: 'bottom' } } },
    { elementId: 'fb_mask', elementType: 'shape', kind: 'rect', bounds: [415, 453, 130, 24], fill: '$bg', role: 'decoration', roleReason: '标签底板' },
    { elementId: 'fb_lab', elementType: 'text', bounds: [415, 456, 130, 20], content: { text: '投喂计划回写', fontSize: 13, color: '$text', align: 'center' } },
  ] },
}

let n = 0
for (const [no, page] of Object.entries(P)) { writeFileSync(join(out, 'pages', `${no}.yaml`), YAML.stringify(page)); n++ }
console.log(`OK 从零手画 ${n} 页 → ${out}`)
