#!/usr/bin/env node
/**
 * 阶段 B 图编译核心自证：`node scripts/verify-diagram-ir.mjs`
 *
 * 守四件事（docs/12 §3/§5/§8）：
 *   ① IR 校验的反例必须报红（未知类型要**优雅降级**而不是崩）；
 *   ② 布局不变量：确定性 / 纯函数 / 节点不叠 / 落在画布内 / 连线真的锚在节点边上 / 容器严格包住成员；
 *   ③ 引擎产出**零冲突**：物化后过一遍真实门禁（verifyDeck）必须 0 错误、且**不需要任何 expectedOverlaps**；
 *   ④ 无 `diagram` 的页面零影响：元素列表与从前逐字节一致（物化只追加、不改既有）。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateDiagram, layoutDiagram, styleProfileFrom, DIAGRAM_TYPES } from '../lib/pptd/diagram-ir.js'
import { validatePage, resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { verifyDeck } from '../lib/verify.js'
import { contains, onSide, rectOf, intersects } from '../lib/pptd/relations.js'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; failures.push(name); console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const H = (t) => console.log(`\n=== ${t} ===`)

const STYLE = styleProfileFrom({ colors: { primary: '#2563EB', accent: '#F59E0B', text: '#1F2937', bg: '#F8FAFC' }, spacing: { base: 28 }, textStyles: { body: { fontSize: 14 } } })
const BOX = { x: 60, y: 60, w: 840, h: 300 }
const IR = () => ({
  type: 'flow', direction: 'LR', title: '数据链路',
  nodes: [{ id: 'n1', label: '采集' }, { id: 'n2', label: '清洗' }, { id: 'n3', label: '计算' }, { id: 'n4', label: '应用', emphasis: 'accent' }],
  edges: [{ from: 'n1', to: 'n2', label: '实时' }, { from: 'n2', to: 'n3' }, { from: 'n3', to: 'n4', style: 'dashed' }],
  groups: [{ id: 's1', label: '第一段', members: ['n1', 'n2'] }, { id: 's2', label: '第二段', members: ['n3', 'n4'] }],
})

// ── 1. IR 校验（反例必须报红） ────────────────────────────────────────────
H('1. validateDiagram：反例必须报红，未知类型要优雅降级')
{
  const err = (d) => validateDiagram(d, { file: 'p.yaml' }).join('｜')
  ok('合法 IR ⇒ 0 错误', validateDiagram(IR(), { file: 'p.yaml' }).length === 0)
  ok('未知 type ⇒ 报错并说明"优雅降级"', /尚未实现/.test(err({ type: 'nope', nodes: [{ id: 'a' }] })) && /优雅降级/.test(err({ type: 'nope', nodes: [{ id: 'a' }] })))
  ok('缺 nodes / nodes 为空 ⇒ 报错', /nodes/.test(err({ type: 'flow' })) && /nodes/.test(err({ type: 'flow', nodes: [] })))
  ok('节点 id 重复 / 缺 id ⇒ 报错', /duplicate/.test(err({ type: 'flow', nodes: [{ id: 'a' }, { id: 'a' }] })) && /required/.test(err({ type: 'flow', nodes: [{}] })))
  ok('边指向不存在的节点 ⇒ 报错（防呆）', /不是已声明的节点 id/.test(err({ type: 'flow', nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'ghost' }] })))
  ok('分组成员不存在 ⇒ 报错', /不是已声明的节点 id/.test(err({ type: 'flow', nodes: [{ id: 'a' }], groups: [{ id: 'g', members: ['ghost'] }] })))
  ok('direction / emphasis / style 非法值 ⇒ 各自报错', /LR\|TB/.test(err({ type: 'flow', direction: 'XX', nodes: [{ id: 'a' }] })) && /primary\|accent\|plain/.test(err({ type: 'flow', nodes: [{ id: 'a', emphasis: 'z' }] })) && /solid\|dashed/.test(err({ type: 'flow', nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'a', style: 'z' }] })))
  ok('bounds 形状错 ⇒ 报错', /\[x, y, w, h\]/.test(err({ type: 'flow', nodes: [{ id: 'a' }], bounds: [1, 2] })))
  ok('未知类型布局：不产元素 + 有 note（绝不产半成品图）', (() => { const o = layoutDiagram({ type: 'nope', nodes: [{ id: 'a' }] }, { bounds: BOX, style: STYLE }); return o.elements.length === 0 && o.notes.length === 1 })())
  ok('画布无效 ⇒ 不产元素 + 有 note', (() => { const o = layoutDiagram(IR(), { bounds: { x: 0, y: 0, w: 0, h: 0 }, style: STYLE }); return o.elements.length === 0 && o.notes.length === 1 })())
}

// ── 2. 布局不变量 ────────────────────────────────────────────────────────
H('2. 布局不变量：确定性 / 纯函数 / 不叠 / 落边 / 包住')
{
  const a = layoutDiagram(IR(), { bounds: BOX, style: STYLE, idPrefix: 'd1_' })
  const b = layoutDiagram(IR(), { bounds: BOX, style: STYLE, idPrefix: 'd1_' })
  ok('确定性：同输入两次输出深度相等', JSON.stringify(a) === JSON.stringify(b))
  const src = IR()
  const before = JSON.stringify(src)
  layoutDiagram(src, { bounds: BOX, style: STYLE })
  ok('纯函数：不改输入 IR', JSON.stringify(src) === before)

  const nodes = a.elements.filter((e) => e.elementType === 'shape' && !String(e.elementId).includes('_g_'))
  let overlap = null
  for (let i = 0; i < nodes.length && !overlap; i++) for (let j = i + 1; j < nodes.length; j++) if (intersects(rectOf(nodes[i]), rectOf(nodes[j]), 1)) overlap = `${nodes[i].elementId}×${nodes[j].elementId}`
  ok('节点之间互不重叠', overlap === null, overlap ?? `${nodes.length} 个节点`)
  ok('所有节点落在画布内', nodes.every((e) => { const r = rectOf(e); return r.x >= BOX.x - 0.5 && r.y >= BOX.y - 0.5 && r.right <= BOX.x + BOX.w + 0.5 && r.bottom <= BOX.y + BOX.h + 0.5 }))

  const byId = new Map(a.elements.map((e) => [e.elementId, e]))
  const edges = a.elements.filter((e) => e.elementType === 'line')
  ok('连线两端**真的**落在节点边上（attach 与 points 一致，箭头必然落边）',
    edges.length === 3 && edges.every((l) => onSide(l.attach.from.side, l.points[0], rectOf(byId.get(l.attach.from.ref))) && onSide(l.attach.to.side, l.points[l.points.length - 1], rectOf(byId.get(l.attach.to.ref)))),
    edges.map((l) => l.elementId).join(','))

  const containers = a.elements.filter((e) => String(e.elementId).includes('_g_'))
  ok('容器严格包住其声明成员（几何反验证会过）',
    containers.length === 2 && containers.every((c) => (c.contains ?? []).filter((m) => byId.get(m)?.elementType === 'shape').every((m) => contains(rectOf(c), rectOf(byId.get(m))))),
    containers.map((c) => `${c.elementId}:${(c.contains ?? []).length}`).join('｜'))
  ok('容器之间互不重叠（多组时 pad 自动收窄到节点间隙以内）', !intersects(rectOf(containers[0]), rectOf(containers[1]), 1))

  ok('结构关系自动产出：groups 的 id 与容器元素 id **不同名**（共用命名空间）',
    a.groups.length === 2 && a.groups.every((g) => !a.elements.some((e) => e.elementId === g.id)) && a.groups.every((g) => g.id.startsWith('d1_grp_')),
    a.groups.map((g) => g.id).join(','))
  ok('产出的每个元素都过 schema 校验（引擎不产非法元素）',
    validatePage({ pageType: 'content', elements: a.elements, groups: a.groups }, 'gen.yaml') === null)
  ok('每个族都有 maturity 标记，且只实现已声明的族', Object.entries(DIAGRAM_TYPES).every(([, m]) => ['beta', 'stable'].includes(m)), JSON.stringify(DIAGRAM_TYPES))
  ok('TB 方向也能产出自洽布局', (() => {
    const o = layoutDiagram({ ...IR(), direction: 'TB' }, { bounds: BOX, style: STYLE })
    const ns = o.elements.filter((e) => e.elementType === 'shape' && !e.elementId.includes('_g_'))
    return ns.length === 4 && new Set(ns.map((e) => Math.round(rectOf(e).x))).size === 1 && ns.every((e, i, arr) => i === 0 || rectOf(e).y > rectOf(arr[i - 1]).y)
  })())
}

// ── 3. 物化 + 真实门禁（零冲突，且不需要任何声明） ────────────────────────
H('3. 物化（resolveDeck）→ 真实门禁 0 错误 / 0 声明')
{
  const dir = join(tmpdir(), `pptd-ir-verify-${Date.now()}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'deck.yaml'), ['version: 1', 'title: ir', 'size: [960, 540]', 'theme:',
    '  colors: {primary: "#2563EB", accent: "#F59E0B", text: "#1F2937", bg: "#F8FAFC"}', '  textStyles:',
    '    body: {fontSize: 14, color: "$text"}', '  spacing: {base: 28}', '  safeArea: {top: 40, bottom: 40, left: 40, right: 40}',
    'pages:', '  - pages/01.yaml', ''].join('\n'))
  const irYaml = ['pageType: content', 'diagram:', `  type: ${IR().type}`, `  direction: ${IR().direction}`,
    '  nodes:', ...IR().nodes.map((n) => `    - {id: ${n.id}, label: ${n.label}${n.emphasis ? `, emphasis: ${n.emphasis}` : ''}}`),
    '  edges:', ...IR().edges.map((e) => `    - {from: ${e.from}, to: ${e.to}${e.label ? `, label: ${e.label}` : ''}${e.style ? `, style: ${e.style}` : ''}}`),
    '  groups:', ...IR().groups.map((g) => `    - {id: ${g.id}, label: ${g.label}, members: [${g.members.join(', ')}]}`), ''].join('\n')
  writeFileSync(join(dir, 'pages', '01.yaml'), irYaml)
  const ctx = await resolveDeck(dir)
  const page = ctx.pages[0].page
  ok('物化：IR 展开出的元素追加进页面（id 带 d1_ 前缀，便于用户接管）',
    (page.elements ?? []).length === 16 && page.elements.every((e) => e.elementId.startsWith('d1_')), `${(page.elements ?? []).length} 个元素`)
  ok('物化：结构关系与逻辑组一起产出（groups 2 条，成员是节点与标签）',
    (page.groups ?? []).length === 2 && page.groups[0].members.length >= 2, JSON.stringify(page.groups?.map((g) => g.id)))
  await renderDeck(ctx, { out: 'preview' })
  const layout = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'preview', 'layout.json'), 'utf8'))
  const v = verifyDeck(layout)
  const decl = (page.expectedOverlaps ?? []).length + (page.expectedOutOfSafeArea ?? []).length
  ok('**引擎产出零冲突**：真实门禁 0 错误（且页面**没有任何声明**——不靠声明掩盖几何问题）',
    v.errors.length === 0 && decl === 0, `错误 ${v.errors.length}｜声明 ${decl}｜${v.errors.slice(0, 3).map((e) => e.code).join(',')}`)
  ok('报告出现结构关系行（引擎产出的关系在门禁里可见）', /· 结构关系：组 2｜包含 \d+｜附着 6/.test(v.text), v.text.split('\n').find((l) => l.includes('结构关系'))?.trim())
  ok('引擎的 attach 断言：门禁报告**没有** attach-override（引擎产出的 points 与解析结果一致）', !v.warns.some((w) => w.code === 'attach-override'))
  rmSync(dir, { recursive: true, force: true })
}

// ── 4. 无 diagram 的页面零影响（纪律：不退化） ────────────────────────────
H('4. 无 diagram 的页面：物化不碰它（逐字节一致的机制保证）')
{
  const dir = join(tmpdir(), `pptd-ir-plain-${Date.now()}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'deck.yaml'), ['version: 1', 'title: plain', 'size: [960, 540]', 'theme:',
    '  colors: {primary: "#2563EB", text: "#1F2937"}', '  textStyles:', '    body: {fontSize: 16, color: "$text"}',
    'pages:', '  - pages/01.yaml', ''].join('\n'))
  const body = ['pageType: content', 'elements:', '  - elementId: t1', '    elementType: text', '    bounds: [40, 40, 400, 40]', '    content: {text: "手写页", style: "$body"}', ''].join('\n')
  writeFileSync(join(dir, 'pages', '01.yaml'), body)
  const ctx = await resolveDeck(dir)
  const page = ctx.pages[0].page
  ok('没有 diagram ⇒ 元素/组/notes 一个都不多（原样保留手写内容）',
    page.elements.length === 1 && page.elements[0].elementId === 't1' && page.groups === undefined && page.diagramNotes === undefined,
    `元素 ${page.elements.length}｜groups ${page.groups === undefined ? 'undefined' : page.groups.length}`)
  await renderDeck(ctx, { out: 'preview' })
  const v = verifyDeck(JSON.parse((await import('node:fs')).readFileSync(join(dir, 'preview', 'layout.json'), 'utf8')))
  ok('无 diagram 的页报告里**不出现**结构关系两段（门控未被引擎绕过）', !v.text.includes('· 结构关系：') && !v.text.includes('· 设计声明复核：'))
  rmSync(dir, { recursive: true, force: true })
}

// ── 5. 阶段 C 族库（第一批：tree / matrix / timeline）───────────────────────
H('5. 图族库：三族的不变量与真实门禁')
{
  const CASES = {
    tree: {
      type: 'tree', title: '组织结构',
      nodes: [{ id: 'ceo', label: '总经理' }, { id: 'a', label: '研发部' }, { id: 'b', label: '市场部' }, { id: 'a1', label: '平台组' }, { id: 'a2', label: '应用组' }, { id: 'b1', label: '品牌组' }],
      edges: [{ from: 'ceo', to: 'a' }, { from: 'ceo', to: 'b' }, { from: 'a', to: 'a1' }, { from: 'a', to: 'a2' }, { from: 'b', to: 'b1' }],
      groups: [{ id: 'g_rd', label: '研发体系', members: ['a', 'a1', 'a2'] }],
    },
    matrix: {
      type: 'matrix', title: '优先级矩阵', cols: 3, colLabels: ['高价值', '中价值', '低价值'], rowLabels: ['低成本', '中成本'],
      nodes: [{ id: 'c1', label: '自动化', emphasis: 'accent' }, { id: 'c2', label: '模板库' }, { id: 'c3', label: '皮肤' }, { id: 'c4', label: '审计' }, { id: 'c5', label: '导出' }, { id: 'c6', label: '动画' }],
    },
    timeline: { type: 'timeline', title: '里程碑', nodes: [{ id: 'm1', label: '立项' }, { id: 'm2', label: '地基', emphasis: 'accent' }, { id: 'm3', label: '引擎' }, { id: 'm4', label: '图族' }, { id: 'm5', label: '北极星' }] },
    // C2 批次：泳道 / 左右对比 / 闭环
    swimlane: {
      type: 'swimlane', title: '跨部门流程',
      groups: [{ id: 'l1', label: '业务', members: ['b1', 'b2'] }, { id: 'l2', label: '风控', members: ['r1'] }, { id: 'l3', label: '财务', members: ['f1', 'f2'] }],
      nodes: [{ id: 'b1', label: '提单' }, { id: 'b2', label: '复核' }, { id: 'r1', label: '评级' }, { id: 'f1', label: '放款' }, { id: 'f2', label: '归档' }],
      edges: [{ from: 'b1', to: 'b2' }, { from: 'b2', to: 'r1', label: '送审' }, { from: 'r1', to: 'f1' }, { from: 'f1', to: 'f2' }],
    },
    compare: {
      type: 'compare', title: '两种方案',
      nodes: [{ id: 'a1', label: '自研引擎' }, { id: 'a2', label: '数据可编辑' }, { id: 'a3', label: '无外部依赖' }, { id: 'b1', label: '现成工具' }, { id: 'b2', label: '上手快' }, { id: 'b3', label: '受模板限制' }],
      groups: [{ id: 'left', label: '方案 A：自研', members: ['a1', 'a2', 'a3'] }, { id: 'right', label: '方案 B：现成', members: ['b1', 'b2', 'b3'] }],
    },
    cycle: { type: 'cycle', title: '闭环反馈', nodes: [{ id: 'c1', label: '采集' }, { id: 'c2', label: '分析' }, { id: 'c3', label: '决策' }, { id: 'c4', label: '执行' }, { id: 'c5', label: '复盘' }] },
    funnel: { type: 'funnel', title: '转化漏斗', nodes: [{ id: 'v1', label: '曝光' }, { id: 'v2', label: '点击' }, { id: 'v3', label: '咨询' }, { id: 'v4', label: '成交', emphasis: 'accent' }] },
    state: { type: 'state', title: '订单状态机', nodes: [{ id: 's0', label: '待提交' }, { id: 's1', label: '待支付' }, { id: 's2', label: '已支付' }, { id: 's3', label: '已发货', emphasis: 'accent' }, { id: 's4', label: '已取消' }], edges: [{ from: 's0', to: 's1', label: '提交' }, { from: 's1', to: 's2', label: '付款' }, { from: 's2', to: 's3', label: '出库' }, { from: 's1', to: 's4', label: '超时' }, { from: 's3', to: 's1', label: '退货' }] },

    steps: { type: 'steps', title: '五步法', nodes: [{ id: 's1', label: '定目标' }, { id: 's2', label: '拆任务' }, { id: 's3', label: '排优先级' }, { id: 's4', label: '执行' }, { id: 's5', label: '复盘' }] },
    sequence: {
      type: 'sequence', title: '下单时序',
      nodes: [{ id: 'u', label: '用户' }, { id: 'api', label: '网关' }, { id: 'pay', label: '支付' }],
      edges: [{ from: 'u', to: 'api', label: '提交订单' }, { from: 'api', to: 'pay', label: '发起扣款' }, { from: 'pay', to: 'api', label: '扣款成功', style: 'dashed' }, { from: 'api', to: 'u', label: '返回结果' }],
    },  }
  const STYLE_C = { ...STYLE, measureLine: (t, fs) => String(t ?? '').length * fs, safeArea: { top: 40, bottom: 40, left: 40, right: 40 }, page: { width: 960, height: 540 } }
  const dir = join(tmpdir(), `pptd-fam-${Date.now()}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'pages'), { recursive: true })
  const refs = []
  const yamlOf = (d) => {
    const lines = ['pageType: content', 'diagram:', `  type: ${d.type}`]
    if (d.title) lines.push(`  title: ${d.title}`)
    if (d.cols) lines.push(`  cols: ${d.cols}`)
    if (d.colLabels) lines.push(`  colLabels: [${d.colLabels.join(', ')}]`)
    if (d.rowLabels) lines.push(`  rowLabels: [${d.rowLabels.join(', ')}]`)
    lines.push('  nodes:', ...d.nodes.map((n) => `    - {id: ${n.id}, label: ${n.label}${n.emphasis ? `, emphasis: ${n.emphasis}` : ''}}`))
    if (d.edges) lines.push('  edges:', ...d.edges.map((e) => `    - {from: ${e.from}, to: ${e.to}}`))
    if (d.groups) lines.push('  groups:', ...d.groups.map((g) => `    - {id: ${g.id}, label: ${g.label}, members: [${g.members.join(', ')}]}`))
    return `${lines.join('\n')}\n`
  }
  // 注意：IR 产出的 line **没有 bounds**（由 points 推导，schema 允许）⇒ rectOf 会返回全 0。
  // 断言里必须自己按 points 求 AABB，否则会把每条线都误判成"越界"（本轮踩到；真实门禁走的是正确路径）。
  const rectOfAny = (e) => {
    if (e.bounds) return rectOf(e)
    if (Array.isArray(e.points)) {
      const xs = e.points.map((p) => p[0])
      const ys = e.points.map((p) => p[1])
      const x = Math.min(...xs); const y = Math.min(...ys)
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, right: Math.max(...xs), bottom: Math.max(...ys) }
    }
    return rectOf(e)
  }
  for (const [name, d] of Object.entries(CASES)) {
    const a = layoutDiagram(d, { bounds: BOX, style: STYLE_C, idPrefix: 'd1_' })
    const b = layoutDiagram(d, { bounds: BOX, style: STYLE_C, idPrefix: 'd1_' })
    ok(`族 ${name}：确定性（同输入两次输出深度相等）`, JSON.stringify(a) === JSON.stringify(b), `${a.elements.length} 个元素`)
    ok(`族 ${name}：产出的每个元素都过 schema 校验`, validatePage({ pageType: 'content', elements: a.elements, groups: a.groups }, `${name}.yaml`) === null)
    const nodesC = a.elements.filter((e) => e.elementType !== 'line' && !String(e.elementId).includes('_g_'))
    ok(`族 ${name}：所有元素落在画布内（含装饰）`,
      a.elements.every((e) => { const r = rectOfAny(e); return r.x >= BOX.x - 1 && r.y >= BOX.y - 1 && r.x + r.w <= BOX.x + BOX.w + 1 && r.y + r.h <= BOX.y + BOX.h + 1 }),
      `最外层越界元素：${a.elements.filter((e) => { const r = rectOfAny(e); return r.x < BOX.x - 1 || r.y < BOX.y - 1 || r.x + r.w > BOX.x + BOX.w + 1 || r.y + r.h > BOX.y + BOX.h + 1 }).map((e) => e.elementId).join(',') || '无'}`)
    ok(`族 ${name}：带 attach 的连线端点都落在被引用元素边上`,
      a.elements.filter((e) => e.elementType === 'line' && e.attach).every((l) => onSide(l.attach.from.side, l.points[0], rectOf(a.elements.find((x) => x.elementId === l.attach.from.ref))) && onSide(l.attach.to.side, l.points[l.points.length - 1], rectOf(a.elements.find((x) => x.elementId === l.attach.to.ref)))))
    void nodesC
    // 真实门禁（每族一页）
    await writeFileSync(join(dir, 'pages', `f_${name}.yaml`), yamlOf(d))
    refs.push(`pages/f_${name}.yaml`)
  }
  writeFileSync(join(dir, 'deck.yaml'), ['version: 1', 'title: families', 'size: [960, 540]', 'theme:',
    '  colors: {primary: "#2563EB", accent: "#F59E0B", text: "#1F2937", bg: "#F8FAFC"}', '  textStyles:',
    '    body: {fontSize: 13, color: "$text"}', '  spacing: {base: 22}', '  safeArea: {top: 40, bottom: 40, left: 40, right: 40}',
    'pages:', ...refs.map((r) => `  - ${r}`), ''].join('\n'))
  const ctx = await resolveDeck(dir)
  await renderDeck(ctx, { out: 'preview' })
  const v = verifyDeck(JSON.parse((await import('node:fs')).readFileSync(join(dir, 'preview', 'layout.json'), 'utf8')))
  const declAll = ctx.pages.reduce((n, p) => n + (p.page.expectedOverlaps ?? []).length + (p.page.expectedOutOfSafeArea ?? []).length, 0)
  ok('**三族一起过真实门禁：0 错误，且三页合计零声明**（不靠声明掩盖几何问题）',
    v.errors.length === 0 && declAll === 0, `错误 ${v.errors.length}｜声明 ${declAll}｜${v.errors.slice(0, 4).map((e) => `${e.code}:${e.id}`).join(' | ')}`)
  ok('族清单与成熟度登记齐全（未实现类型仍走优雅降级）', ['tree', 'matrix', 'timeline', 'swimlane', 'compare', 'cycle'].every((k) => DIAGRAM_TYPES[k]) && Object.values(DIAGRAM_TYPES).every((m) => ['beta', 'stable'].includes(m)), JSON.stringify(DIAGRAM_TYPES))
  rmSync(dir, { recursive: true, force: true })
}

// ── 6. 阶段 D-①：参考稿样式档案 → 引擎（令牌通路）──────────────────────────
H('6. 样式档案：观测 → 归纳 → 喂回引擎（引擎无审美，只换令牌来源）')
{
  const { observeFromDeck, extractStyleProfile, profileToTheme } = await import('../lib/pptd/style-profile.js')
  const dir = join(tmpdir(), `pptd-profile-${Date.now()}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'deck.yaml'), ['version: 1', 'title: ref', 'size: [960, 540]', 'theme:',
    '  colors: {primary: "#0F766E", text: "#0B2B26", bg: "#F0FDFA"}', '  textStyles:', '    body: {fontSize: 15, color: "$text"}',
    'pages:', '  - pages/01.yaml', ''].join('\n'))
  writeFileSync(join(dir, 'pages', '01.yaml'), ['pageType: content', 'elements:',
    '  - elementId: k1', '    elementType: shape', '    kind: roundRect', '    bounds: [60, 60, 300, 200]', '    fill: "#0F766E"', '    line: {color: "#0B2B26", width: 2}',
    '  - elementId: k2', '    elementType: shape', '    kind: roundRect', '    bounds: [420, 60, 300, 200]', '    fill: "#14B8A6"', '    line: {color: "#0B2B26", width: 2}',
    '  - elementId: k3', '    elementType: shape', '    kind: roundRect', '    bounds: [60, 320, 300, 140]', '    fill: "#0F766E"', '    line: {color: "#0B2B26", width: 2}',
    ''].join('\n'))
  const refCtx = await resolveDeck(dir)
  const prof = extractStyleProfile(observeFromDeck(refCtx))
  ok('观测→归纳：调色板按**出现频次**排序（#0F766E 出现 2 次排第一），并归纳出底色/线宽',
    prof.palette[0] === '#0F766E' && prof.palette.includes('#14B8A6') && prof.bg === '#F0FDFA' && prof.lineWidth === 2,
    `palette=${prof.palette.join(',')}｜bg=${prof.bg}｜lineWidth=${prof.lineWidth}｜fontSize=${prof.fontSize}`)
  ok('归纳确定性：同输入两次提取深度相等', JSON.stringify(prof) === JSON.stringify(extractStyleProfile(observeFromDeck(refCtx))))
  ok('档案 → theme：调色板映射为 primary/accent/soft，墨色与底色随档案',
    (() => { const t = profileToTheme(prof); return t.colors.primary === '#0F766E' && t.colors.accent === '#14B8A6' && t.colors.bg === '#F0FDFA' })(),
    JSON.stringify(profileToTheme(prof).colors))

  // 把它当 `deck.styles.ref-a` 喂给一个 IR 页：取色/线宽必须来自档案，且**过门禁**
  const dir2 = join(tmpdir(), `pptd-profile-use-${Date.now()}`)
  rmSync(dir2, { recursive: true, force: true })
  mkdirSync(join(dir2, 'pages'), { recursive: true })
  writeFileSync(join(dir2, 'deck.yaml'), ['version: 1', 'title: use', 'size: [960, 540]', 'theme:',
    '  colors: {primary: "#2563EB", text: "#1F2937", bg: "#F8FAFC"}', '  textStyles:', '    body: {fontSize: 13, color: "$text"}',
    'styles:', '  ref-a:', `    palette: [${prof.palette.map((c) => `"${c}"`).join(', ')}]`,
    `    ink: "${prof.ink}"`, `    bg: "${prof.bg}"`, `    neutral: "${prof.neutral}"`,
    `    lineWidth: ${prof.lineWidth}`, `    fontSize: ${prof.fontSize}`, `    radius: ${prof.radius}`,
    'pages:', '  - pages/01.yaml', ''].join('\n'))
  writeFileSync(join(dir2, 'pages', '01.yaml'), ['pageType: content', 'diagram:', '  type: tree', '  style: ref-a', '  nodes:',
    '    - {id: r, label: 总目标}', '    - {id: a, label: 分支一, emphasis: accent}', '  edges:', '    - {from: r, to: a}', ''].join('\n'))
  const useCtx = await resolveDeck(dir2)
  const els2 = useCtx.pages[0].page.elements
  const fills2 = [...new Set(els2.filter((e) => e.elementType === 'shape').map((e) => e.fill))]
  const widths2 = [...new Set(els2.filter((e) => e.line?.width).map((e) => e.line.width))]
  await renderDeck(useCtx, { out: 'preview' })
  const layout2 = JSON.parse((await import('node:fs')).readFileSync(join(dir2, 'preview', 'layout.json'), 'utf8'))
  const v2 = verifyDeck(layout2)
  ok('档案驱动生成：节点取色来自档案调色板（primary/accent）、线宽来自档案',
    fills2.includes(prof.palette[0]) && fills2.includes(prof.palette[1]) && widths2.includes(prof.lineWidth),
    `取色=${JSON.stringify(fills2)}｜线宽=${JSON.stringify(widths2)}`)
  ok('**档案驱动页过真实门禁 0 错误**（档案色板已并入主题色板，不再触发 theme-conformance）',
    v2.errors.length === 0, v2.errors.map((e) => e.code).join(',') || '无')
  ok('themeConformance 判据：layout.theme.colors 里确实带上了档案色（原地写入，未替换对象）',
    Object.values(layout2.theme.colors).includes(prof.palette[0]), `layout.theme.colors=${JSON.stringify(layout2.theme.colors)}`)
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
}

// ── 7. 阶段 D-②：组合作为可复用块（copy 语义）────────────────────────────
H('7. 可复用块：deck.blocks + 页面 blocks[]（前缀 / 平移 / 引用重映射 / copy 语义）')
{
  const { materializeBlock } = await import('../lib/pptd/blocks.js')
  const block = {
    elements: [
      { elementId: 'card', elementType: 'shape', kind: 'roundRect', bounds: [0, 0, 200, 110], fill: '#2563EB', contains: ['lab', 'num'] },
      { elementId: 'lab', elementType: 'text', bounds: [10, 12, 180, 26], content: { text: '指标', fontSize: 14 } },
      { elementId: 'num', elementType: 'text', bounds: [10, 46, 180, 44], content: { text: '42%', fontSize: 28 } },
      { elementId: 'ln', elementType: 'line', points: [[0, 110], [200, 110]], attach: { from: { ref: 'card', side: 'bottom' }, to: { ref: 'lab', side: 'top' } }, arrow: true, badgeOf: 'card' },
    ],
    groups: [{ id: 'g_card', label: '卡片', members: ['card', 'lab', 'num'] }],
  }
  const a = materializeBlock(block, { at: [60, 80], prefix: 'bk1_' })
  const b = materializeBlock(block, { at: [320, 80], prefix: 'bk2_' })
  ok('物化：元素 id 全部加前缀，且**内部引用同步重映射**（contains / attach.ref / badgeOf / groups.members）',
    a.elements.every((e, i) => e.elementId === `bk1_${block.elements[i].elementId}`)
    && JSON.stringify(a.elements[0].contains) === JSON.stringify(['bk1_lab', 'bk1_num'])
    && a.elements[3].attach.from.ref === 'bk1_card' && a.elements[3].attach.to.ref === 'bk1_lab' && a.elements[3].badgeOf === 'bk1_card'
    && a.groups[0].id === 'bk1_g_card' && JSON.stringify(a.groups[0].members) === JSON.stringify(['bk1_card', 'bk1_lab', 'bk1_num']),
    `contains=${JSON.stringify(a.elements[0].contains)}｜attach=${a.elements[3].attach.from.ref}/${a.elements[3].attach.to.ref}`)
  ok('平移：同一块放在两处 ⇒ 坐标差 = at 差（bounds 数组与 line.points 都位移）',
    a.elements[0].bounds[0] === 60 && b.elements[0].bounds[0] === 320
    && a.elements[3].points[0][0] === 60 && b.elements[3].points[0][0] === 320,
    `card: ${a.elements[0].bounds[0]} vs ${b.elements[0].bounds[0]}｜line: ${a.elements[3].points[0][0]} vs ${b.elements[3].points[0][0]}`)
  a.elements[0].fill = '#FF0000' // copy 语义：改一份**不影响**另一份
  ok('copy 语义：两次展开互不共享对象（改一处不影响另一处）', b.elements[0].fill === '#2563EB' && block.elements[0].fill === '#2563EB')
  ok('块自带的分组也会展开并加前缀（组 id 与元素 id 共用命名空间，不撞名）',
    a.groups.length === 1 && a.groups[0].id === 'bk1_g_card' && !a.elements.some((e) => e.elementId === a.groups[0].id))

  // 真实门禁：6 份同款卡片
  const dir = join(tmpdir(), `pptd-blocks-${Date.now()}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'deck.yaml'), ['version: 1', 'title: blocks', 'size: [960, 540]', 'theme:',
    '  colors: {primary: "#2563EB", text: "#1F2937", bg: "#F8FAFC"}', '  textStyles:', '    body: {fontSize: 13, color: "$text"}',
    'blocks:', '  kpi:', '    elements:',
    '      - {elementId: card, elementType: shape, kind: roundRect, bounds: [0, 0, 200, 110], fill: "$primary", contains: [lab, num]}',
    '      - {elementId: lab, elementType: text, bounds: [10, 12, 180, 26], content: {text: "指标", fontSize: 14, color: "$bg", align: center}}',
    '      - {elementId: num, elementType: text, bounds: [10, 46, 180, 44], content: {text: "42%", fontSize: 28, color: "$bg", align: center}}',
    '    groups:', '      - {id: g, label: 卡片, members: [card, lab, num]}',
    'pages:', '  - pages/01.yaml', ''].join('\n'))
  writeFileSync(join(dir, 'pages', '01.yaml'), ['pageType: content', 'blocks:',
    ...[[60, 80], [320, 80], [580, 80], [60, 260], [320, 260], [580, 260]].map(([x, y]) => `  - {name: kpi, at: [${x}, ${y}]}`), ''].join('\n'))
  const ctx = await resolveDeck(dir)
  await renderDeck(ctx, { out: 'preview' })
  const v = verifyDeck(JSON.parse((await import('node:fs')).readFileSync(join(dir, 'preview', 'layout.json'), 'utf8')))
  ok('6 份同款卡片过真实门禁 **0 错误**（块内部结构声明随拷贝一起生效）', v.errors.length === 0, v.errors.slice(0, 3).map((e) => e.code).join(',') || '无')
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n==== verify-diagram-ir 结果：${pass} 通过 / ${fail} 失败 ====`)
if (fail) { console.log(`失败项：${failures.join('；')}`); process.exit(1) }
