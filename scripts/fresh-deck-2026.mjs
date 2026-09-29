/**
 * 从零重画 12+1 张图（S3）。
 *
 * 与既有 `render-families.mjs` 的**区别**（这是"验证意义"的关键）：
 *   · 领域全新：茶场"从采到销"运营体系（既有夹具是 PPT 插件/数据管道故事）；
 *   · 内容全新：标签、节点数、层级、边、里程碑全部新拟，**不引用任何既有夹具**；
 *   · 配色全新：绿茶色系（既有夹具是蓝橙 + 科技深色）；
 *   · 额外多一张**手写暖色系**架构图（不依赖任何图族，含平行四边形 + attach，验证 S1 真实轮廓接边）。
 *
 * 用法：node scripts/fresh-deck-2026.mjs [输出目录，缺省 examples/fresh-tea]
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

const out = process.argv[2] ?? 'examples/fresh-tea'
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'pages'), { recursive: true })

// ── 绿茶色系（新拟，与既有夹具的蓝橙/科技色无关）──
writeFileSync(join(out, 'deck.yaml'), YAML.stringify({
  version: 1,
  title: '谷雨茶场 · 从采到销（从零重画）',
  size: [960, 540],
  theme: {
    colors: { primary: '#15803D', accent: '#CA8A04', soft: '#DCFCE7', text: '#14532D', bg: '#F7FEE7' },
    textStyles: { body: { fontSize: 13, color: '$text' } },
    safeArea: { top: 40, bottom: 40, left: 40, right: 40 },
  },
  pages: Array.from({ length: 13 }, (_, i) => `pages/${String(i + 1).padStart(2, '0')}.yaml`),
}))

/** 12 个族页 + 1 张手写暖色图：全部新拟内容。 */
const PAGES = {
  // ① 层级树：茶场组织（4 层、8 节点，与既有"总经理/研发部"完全不同）
  '01': {
    pageType: 'content',
    diagram: {
      type: 'tree',
      title: '茶场组织架构',
      nodes: [
        { id: 'r', label: '场长' },
        { id: 'p', label: '种植部' },
        { id: 'm', label: '制茶部' },
        { id: 's', label: '销售部' },
        { id: 'p1', label: '梯田一组' },
        { id: 'p2', label: '梯田二组' },
        { id: 'm1', label: '杀青组' },
        { id: 's1', label: '门店渠道', emphasis: 'accent' },
      ],
      edges: [
        { from: 'r', to: 'p' }, { from: 'r', to: 'm' }, { from: 'r', to: 's' },
        { from: 'p', to: 'p1' }, { from: 'p', to: 'p2' }, { from: 'm', to: 'm1' }, { from: 's', to: 's1' },
      ],
      groups: [{ id: 'g_zhong', label: '种植体系', members: ['p', 'p1', 'p2'] }],
    },
  },
  // ② 矩阵：茶园风险优先级（2 行 × 4 列，含行/列标签）
  '02': {
    pageType: 'content',
    diagram: {
      type: 'matrix',
      title: '茶园风险优先级',
      cols: 4,
      colLabels: ['影响极小', '影响有限', '影响较大', '影响严重'],
      rowLabels: ['发生概率高', '发生概率低'],
      nodes: [
        { id: 'k1', label: '霜冻', emphasis: 'accent' },
        { id: 'k2', label: '虫害' },
        { id: 'k3', label: '干旱' },
        { id: 'k4', label: '暴雨' },
        { id: 'k5', label: '土壤板结' },
        { id: 'k6', label: '人工短缺' },
        { id: 'k7', label: '设备故障' },
        { id: 'k8', label: '价格波动' },
      ],
    },
  },
  // ③ 时间轴：春茶上市节点（6 个）
  '03': {
    pageType: 'content',
    diagram: {
      type: 'timeline',
      title: '春茶上市节点',
      nodes: [
        { id: 't1', label: '惊蛰·修剪' },
        { id: 't2', label: '春分·催芽' },
        { id: 't3', label: '清明·首采', emphasis: 'accent' },
        { id: 't4', label: '谷雨·量产' },
        { id: 't5', label: '立夏·复焙' },
        { id: 't6', label: '小满·入仓' },
      ],
    },
  },
  // ④ 泳道：跨部门流程（茶田 / 制茶 / 质检 / 仓储 四条道）
  '04': {
    pageType: 'content',
    diagram: {
      type: 'swimlane',
      title: '春茶跨岗流程',
      groups: [
        { id: 'l1', label: '茶田', members: ['a1', 'a2'] },
        { id: 'l2', label: '制茶', members: ['b1'] },
        { id: 'l3', label: '质检', members: ['c1'] },
        { id: 'l4', label: '仓储', members: ['d1', 'd2'] },
      ],
      nodes: [
        { id: 'a1', label: '采摘' },
        { id: 'a2', label: '摊青' },
        { id: 'b1', label: '杀青揉捻' },
        { id: 'c1', label: '评审定级' },
        { id: 'd1', label: '分装' },
        { id: 'd2', label: '入仓' },
      ],
      edges: [
        { from: 'a1', to: 'a2' },
        { from: 'a2', to: 'b1' },
        { from: 'b1', to: 'c1' },
        { from: 'c1', to: 'd1' },
        { from: 'd1', to: 'd2' },
      ],
    },
  },
  // ⑤ 左右对比：两种杀青工艺（各 4 条论据）
  '05': {
    pageType: 'content',
    diagram: {
      type: 'compare',
      title: '两种杀青工艺',
      nodes: [
        { id: 'a1', label: '手工铁锅' }, { id: 'a2', label: '香气层次足' }, { id: 'a3', label: '单锅 3 斤' }, { id: 'a4', label: '依赖师傅' },
        { id: 'b1', label: '滚筒机械' }, { id: 'b2', label: '批次一致' }, { id: 'b3', label: '时产 120 斤' }, { id: 'b4', label: '香气偏平' },
      ],
      groups: [
        { id: 'left', label: '工艺 A：手工', members: ['a1', 'a2', 'a3', 'a4'] },
        { id: 'right', label: '工艺 B：机械', members: ['b1', 'b2', 'b3', 'b4'] },
      ],
    },
  },
  // ⑥ 闭环：品质反馈环（5 环）
  '06': {
    pageType: 'content',
    diagram: {
      type: 'cycle',
      title: '品质反馈环',
      nodes: [
        { id: 'q1', label: '鲜叶抽检' },
        { id: 'q2', label: '杀青曲线' },
        { id: 'q3', label: '成品评审' },
        { id: 'q4', label: '客户回访' },
        { id: 'q5', label: '工艺修订', emphasis: 'accent' },
      ],
    },
  },
  // ⑦ 漏斗：客户转化（4 级）
  '07': {
    pageType: 'content',
    diagram: {
      type: 'funnel',
      title: '客户转化漏斗',
      nodes: [
        { id: 'f1', label: '内容触达 12000' },
        { id: 'f2', label: '门店到访 3600' },
        { id: 'f3', label: '现场品鉴 1400' },
        { id: 'f4', label: '复购会员 420', emphasis: 'accent' },
      ],
    },
  },
  // ⑧ 步骤环：制茶七步（节点数不同于既有的 5 步）
  '08': {
    pageType: 'content',
    diagram: {
      type: 'steps',
      title: '制茶七步',
      nodes: [
        { id: 's1', label: '采摘' }, { id: 's2', label: '摊青' }, { id: 's3', label: '杀青' }, { id: 's4', label: '揉捻' },
        { id: 's5', label: '解块' }, { id: 's6', label: '烘焙' }, { id: 's7', label: '复焙提香', emphasis: 'accent' },
      ],
    },
  },
  // ⑨ 时序：门店订货履约（4 角色、5 条消息，含一条回程虚线）
  '09': {
    pageType: 'content',
    diagram: {
      type: 'sequence',
      title: '门店订货履约',
      nodes: [
        { id: 'u', label: '门店' }, { id: 'o', label: '订单中心' }, { id: 'w', label: '茶仓' }, { id: 'g', label: '物流' },
      ],
      edges: [
        { from: 'u', to: 'o', label: '提交订货单' },
        { from: 'o', to: 'w', label: '分配库存' },
        { from: 'w', to: 'g', label: '拣货出仓' },
        { from: 'g', to: 'u', label: '送达签收' },
        { from: 'w', to: 'o', label: '缺货回告', style: 'dashed' },
      ],
    },
  },
  // ⑩ 状态机：茶样状态（6 状态、7 边，含两条回边）
  '10': {
    pageType: 'content',
    diagram: {
      type: 'state',
      title: '茶样状态机',
      nodes: [
        { id: 's0', label: '待摊青' }, { id: 's1', label: '待杀青' }, { id: 's2', label: '待揉捻' },
        { id: 's3', label: '待烘焙' }, { id: 's4', label: '已成样', emphasis: 'accent' }, { id: 's5', label: '已报废' },
      ],
      edges: [
        { from: 's0', to: 's1', label: '摊青毕' },
        { from: 's1', to: 's2', label: '杀青毕' },
        { from: 's2', to: 's3', label: '揉捻毕' },
        { from: 's3', to: 's4', label: '烘焙毕' },
        { from: 's4', to: 's3', label: '评审不合格' },
      ],
    },
  },
  // ⑪ 流程：冷库出库（竖排 5 步，含虚线分支）
  '11': {
    pageType: 'content',
    diagram: {
      type: 'flow',
      direction: 'LR',
      nodes: [
        { id: 'a', label: '接出库单' }, { id: 'b', label: '核验批次' }, { id: 'c', label: '扫码拣货', emphasis: 'accent' },
        { id: 'd', label: '复核称重' }, { id: 'e', label: '装车发运' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c', label: '相符' },
        { from: 'c', to: 'd' },
        { from: 'd', to: 'e' },
      ],
    },
  },
  // ⑫ 分层：智慧茶场四层（层内多模块）
  '12': {
    pageType: 'content',
    diagram: {
      type: 'layers',
      title: '智慧茶场四层',
      groups: [
        { id: 'l1', label: '感知层', members: ['a1', 'a2'] },
        { id: 'l2', label: '网络层', members: ['b1'] },
        { id: 'l3', label: '平台层', members: ['c1', 'c2'] },
        { id: 'l4', label: '应用层', members: ['d1'] },
      ],
      nodes: [
        { id: 'a1', label: '土壤墒情' }, { id: 'a2', label: '气象站' },
        { id: 'b1', label: 'LoRa 网关' },
        { id: 'c1', label: '数据湖' }, { id: 'c2', label: '工艺模型' },
        { id: 'd1', label: '采摘排期看板', emphasis: 'accent' },
      ],
      edges: [
        { from: 'a1', to: 'b1' }, { from: 'a2', to: 'b1' },
        { from: 'b1', to: 'c1' }, { from: 'c1', to: 'c2' }, { from: 'c2', to: 'd1' },
      ],
    },
  },
  // ⑬ 手写暖色系架构图（不依赖任何族；含平行四边形 + attach ⇒ 验证 S1 的斜边真实轮廓）
  //    主题：茶场物联网架构 ① 感知层 / ② 平台层 / ③ 应用层
  '13': {
    pageType: 'content',
    elements: [
      { elementId: 'title', elementType: 'text', bounds: [60, 40, 420, 40], content: { text: '茶场物联网架构', fontSize: 26, bold: true, color: '$text' } },
      { elementId: 'k1', elementType: 'text', bounds: [70, 100, 200, 24], content: { text: '① 感知层', fontSize: 15, color: '$primary' } },
      { elementId: 'k2', elementType: 'text', bounds: [400, 100, 200, 24], content: { text: '② 平台层', fontSize: 15, color: '$primary', align: 'center' } },
      { elementId: 'k3', elementType: 'text', bounds: [720, 100, 190, 24], content: { text: '③ 应用层', fontSize: 15, color: '$primary', align: 'center' } },
      // 平行四边形（暖色）：感知端 / 应用端 ⇒ 连线用 attach，引擎会接真实斜边
      { elementId: 'sens', elementType: 'shape', kind: 'parallelogram', bounds: [80, 190, 170, 130], fill: '$accent', contains: ['sens_lab'] },
      { elementId: 'sens_lab', elementType: 'text', bounds: [120, 240, 100, 30], content: { text: '土壤·气象采集', fontSize: 12, color: '$bg', align: 'center' } },
      { elementId: 'app', elementType: 'shape', kind: 'parallelogram', bounds: [700, 190, 170, 130], fill: '$primary', contains: ['app_lab'] },
      { elementId: 'app_lab', elementType: 'text', bounds: [740, 240, 100, 30], content: { text: '排期与预警', fontSize: 12, color: '$bg', align: 'center' } },
      // 平台底板（底板用 decoration，连线伸进去不算"插进图形"）
      { elementId: 'core', elementType: 'shape', kind: 'roundRect', bounds: [320, 150, 340, 240], fill: '$soft', role: 'decoration', roleReason: '平台底板' },
      { elementId: 'm1', elementType: 'shape', kind: 'rect', bounds: [345, 175, 290, 56], fill: '$primary', contains: ['m1_lab'] },
      { elementId: 'm1_lab', elementType: 'text', bounds: [355, 192, 270, 24], content: { text: 'LoRa 网关与边缘缓存', fontSize: 12, color: '$bg', align: 'center' } },
      { elementId: 'm2', elementType: 'shape', kind: 'rect', bounds: [345, 245, 290, 56], fill: '$primary', contains: ['m2_lab'] },
      { elementId: 'm2_lab', elementType: 'text', bounds: [355, 262, 270, 24], content: { text: '数据湖', fontSize: 12, color: '$bg', align: 'center' } },
      { elementId: 'm3', elementType: 'shape', kind: 'rect', bounds: [345, 315, 290, 56], fill: '$primary', contains: ['m3_lab'] },
      { elementId: 'm3_lab', elementType: 'text', bounds: [355, 332, 270, 24], content: { text: '工艺模型（杀青曲线）', fontSize: 12, color: '$bg', align: 'center' } },
      // 连线：入场（感知 → 三条支线）与出场（汇流 → 应用），两端都用 attach 锚到三角形之外的斜边
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
      // 底部虚线反馈回路（暖色、标签带底板）
      { elementId: 'fb', elementType: 'line', points: [[785, 320], [785, 460], [165, 460], [165, 320]], arrow: true, line: { color: '$text', width: 1.5, dash: 'dash' }, attach: { from: { ref: 'app', side: 'bottom' }, to: { ref: 'sens', side: 'bottom' } } },
      { elementId: 'fb_mask', elementType: 'shape', kind: 'rect', bounds: [415, 448, 110, 24], fill: '$bg', role: 'decoration', roleReason: '标签底板' },
      { elementId: 'fb_lab', elementType: 'text', bounds: [415, 451, 110, 20], content: { text: '阈值回写', fontSize: 13, color: '$text', align: 'center' } },
    ],
  },
}

const written = []
for (const [no, page] of Object.entries(PAGES)) {
  const f = join(out, 'pages', `${no}.yaml`)
  writeFileSync(f, YAML.stringify(page))
  written.push(f)
}
console.log(`✓ 从零手画 ${written.length} 页 → ${out}`)
console.log(`  ① 12 族页：${Object.keys(PAGES).slice(0, 12).join(', ')}`)
console.log(`  ② 手写暖色页：13（平行四边形 + attach + decoration 底板 + 虚线回路）`)
