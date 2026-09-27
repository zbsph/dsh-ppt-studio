#!/usr/bin/env node
/**
 * 结构关系自证（阶段 A 地基，2026-09-28）：`node scripts/verify-diagram-relations.mjs`
 *
 * 为什么单独一个脚本：`src/pptd/relations.js` 是本阶段最容易"看起来对、实际宽松"的地方
 * （判据一松就变成假绿）。所以这里把**每条关系的正例 + 反例**、组结构合法性、确定性、
 * "不改输入"、"豁免只来自有效关系"全部钉成断言，退出码 0/1，可随时复跑。
 *
 * 覆盖（对应 docs/08 §2/§3）：
 *   1 正例：合法结构 ⇒ 0 错误、关系全部 valid、豁免集合正确、统计数字正确
 *   2 反例：contains 不成立 / attach 未落边 / badge 面积比超限与不完全覆盖 / 声明两端是内容 / 声明已失效
 *   3 组结构：重复成员、成员不存在、一元素属两组、嵌套成环
 *   4 图专属检查：duplicate-element / text-over-text / line-through-box / arrow-not-on-edge（有 attach ⇒ 错误）
 *   5 三条硬纪律：确定性（两次深度相等）、不改输入、豁免不落盘（page 上没有新增字段）
 */
import { deriveRelations, checkDiagram, summaryLine, rectOf, contains, onSide, segmentCrossesRect } from '../lib/pptd/relations.js'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; failures.push(name); console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const H = (t) => console.log(`\n=== ${t} ===`)

/** 造一个合法页面：容器含两子元素 + 一条两端附着且带箭头的线 + 一个徽章 + 一条有意重叠声明。 */
function goodPage() {
  return {
    index: 0,
    groups: [
      { id: 'g_in', label: '输入层', members: ['in_box'] },
      { id: 'g_core', label: '内核', members: ['m1', 'g_loop'] },
      { id: 'g_loop', label: '反馈小块', members: ['e1'] },
    ],
    elements: [
      { id: 'zone', elementType: 'shape', bounds: { x: 40, y: 120, w: 880, h: 300 }, contains: ['in_box', 'chip'], role: 'background' },
      { id: 'in_box', elementType: 'shape', bounds: { x: 70, y: 200, w: 180, h: 90 } },
      { id: 'm1', elementType: 'shape', bounds: { x: 400, y: 200, w: 300, h: 60 } },
      { id: 'chip', elementType: 'shape', bounds: { x: 300, y: 124, w: 120, h: 34 }, badgeOf: 'zone', role: 'background', roleReason: '标题胶囊' },
      { id: 'e1', elementType: 'line', points: [[250, 245], [400, 230]], attach: { from: { ref: 'in_box', side: 'right' }, to: { ref: 'm1', side: 'left' } }, arrow: 'both' },
    ],
    expectedOverlaps: [{ pair: ['chip', 'zone'], reason: '标题胶囊压在容器顶边' }],
  }
}

// ── 1. 正例 ────────────────────────────────────────────────────────────────
H('1. 正例：合法结构')
{
  const page = goodPage()
  const r = deriveRelations(page)
  ok('无结构错误', r.errors.length === 0, r.errors.map((e) => e.detail).join('｜'))
  ok('无失效/不成立的关系', r.invalid.length === 0, JSON.stringify(r.invalid))
  ok('关系全部 valid（包含 2 + 附着 2 + 徽章 1 + 有意重叠 1 = 6）', r.relations.length === 6 && r.relations.every((x) => x.valid), `关系数=${r.relations.length}｜invalid=${JSON.stringify(r.invalid)}`)
  ok('统计数字正确（组 3 / 包含 2 / 附着 2 / 徽章 1 / 有意重叠 1）',
    r.stats.groups === 3 && r.stats.contains === 2 && r.stats.attach === 2 && r.stats.badge === 1 && r.stats.overlapDecl === 1,
    JSON.stringify(r.stats))
  ok('豁免集合 = {in_box × zone, chip × zone}（去重后 2 个）',
    r.exempt.length === 2 && r.exempt.includes('chip × zone') && r.exempt.includes('in_box × zone'), r.exempt.join(','))
  ok('组深度正确（g_loop 嵌在 g_core 内 ⇒ depth 1）', r.groups.find((g) => g.id === 'g_loop')?.depth === 1)
  ok('图专属检查在合法页上静默', (() => { const c = checkDiagram(page); return c.errors.length === 0 && c.warnings.length === 0 })(),
    JSON.stringify(checkDiagram(page)))
  ok('summaryLine 形态稳定', /^结构关系：组 3｜包含 2｜附着 2｜徽章 1｜有意重叠 1（自动豁免重叠 2 处，未落盘）$/.test(summaryLine(r)), summaryLine(r))
}

// ── 2. 反例：每条关系都要能被证伪 ────────────────────────────────────────────
H('2. 反例（宽松判据会在这里漏掉）')
{
  // contains 不成立：容器缩小到装不下子元素
  const p1 = goodPage()
  p1.elements[0].bounds = { x: 40, y: 120, w: 200, h: 120 }
  const r1 = deriveRelations(p1)
  ok('contains 不成立 ⇒ 进 invalid 且产生点名错误',
    r1.invalid.some((x) => x.type === 'contains') && r1.errors.some((e) => e.code === 'relation-invalid' && /contains/.test(e.detail)),
    r1.errors.map((e) => e.detail).join('｜'))
  ok('contains 不成立 ⇒ 该对被移出豁免集合', !r1.exempt.includes('in_box×zone'), r1.exempt.join(','))

  // attach 未落边：终点偏离 6px
  const p2 = goodPage()
  p2.elements[4].points = [[250, 245], [406, 230]]
  const r2 = deriveRelations(p2)
  ok('attach 未落边 ⇒ 点名错误', r2.errors.some((e) => /attach 声明不成立/.test(e.detail)), r2.errors.map((e) => e.detail).join('｜'))
  ok('attach 未落边 ⇒ 不影响其它关系（contains/badge 仍 valid）', r2.relations.filter((x) => x.type === 'contains').every((x) => x.valid))

  // badge 面积比超限
  const p3 = goodPage()
  p3.elements[3].bounds = { x: 300, y: 124, w: 700, h: 280 } // 面积接近容器 ⇒ 更像遮罩
  const r3 = deriveRelations(p3)
  ok('badge 面积比超限 ⇒ 不成立并说明"更像遮罩"', r3.invalid.some((x) => x.type === 'badge' && /遮罩/.test(x.why)), JSON.stringify(r3.invalid))

  // badge 完全覆盖（chip 比 owner 还大 ⇒ 应作为"遮罩"被拒）
  // 注意语义：这一对被 badgeOf 拒了，但**同时**有一条显式 expectedOverlaps 声明 ⇒ 它仍应在豁免集里
  //（"声明"与"结构关系"相互独立：显式声明能豁免重叠，但不能把一条不成立的 badge 声明变成合法）
  const p4 = goodPage()
  p4.elements[3].bounds = { x: 30, y: 110, w: 920, h: 320 }
  const r4 = deriveRelations(p4)
  const badgeRel = r4.relations.find((x) => x.type === 'badge')
  ok('badge 完全覆盖 ⇒ 该结构关系不成立（按遮罩处理）',
    r4.invalid.some((x) => x.type === 'badge') && badgeRel?.valid === false,
    JSON.stringify({ invalid: r4.invalid.map((x) => x.type), badgeValid: badgeRel?.valid }))
  ok('但它仍被**显式声明**豁免（声明与结构关系相互独立）',
    r4.exempt.includes('chip × zone'), r4.exempt.join(','))

  // 声明两端都是内容元素 ⇒ 永不可声明
  const p5 = goodPage()
  p5.elements.push({ id: 't1', elementType: 'text', bounds: { x: 500, y: 500, w: 200, h: 40 }, content: { text: '甲' } })
  p5.elements.push({ id: 't2', elementType: 'text', bounds: { x: 560, y: 505, w: 200, h: 40 }, content: { text: '乙' } })
  p5.expectedOverlaps.push({ pair: ['t1', 't2'], reason: '故意压字' })
  const r5 = deriveRelations(p5)
  ok('内容 × 内容 的声明被拒（不可声明）', r5.errors.some((e) => e.code === 'declared-content-collision'), r5.errors.map((e) => e.code).join(','))

  // 声明已失效（两端不再相交）⇒ 只算 ℹ，不算错误
  const p6 = goodPage()
  p6.elements[3].bounds = { x: 300, y: 600, w: 120, h: 34 } // chip 移出 zone 之外
  const r6 = deriveRelations(p6)
  ok('失效声明进 invalid 但**不**产生错误（ℹ 级）',
    r6.invalid.some((x) => x.type === 'overlapDecl') && !r6.errors.some((e) => /overlapDecl 声明不成立/.test(e.detail)),
    JSON.stringify({ invalid: r6.invalid.map((x) => x.type), errors: r6.errors.map((e) => e.code) }))
}

// ── 3. 组结构合法性 ────────────────────────────────────────────────────────
H('3. groups 结构校验')
{
  const cases = [
    ['成员重复', (p) => { p.groups[0].members = ['in_box', 'in_box'] }, 'group-duplicate-member'],
    ['成员不存在', (p) => { p.groups[0].members = ['nope'] }, 'group-member-missing'],
    ['一元素属两个直接组', (p) => { p.groups[1].members.push('in_box') }, 'group-member-multi-parent'],
    ['嵌套成环', (p) => { p.groups.push({ id: 'g_cycle', members: ['g_core'] }); p.groups[1].members.push('g_cycle') }, 'group-cycle'],
    ['组 id 与元素同名', (p) => { p.groups.push({ id: 'zone', members: ['in_box'] }) }, 'group-id-collides-element'],
  ]
  for (const [name, mutate, code] of cases) {
    const p = goodPage()
    mutate(p)
    const r = deriveRelations(p)
    ok(`组校验：${name} ⇒ ${code}`, r.errors.some((e) => e.code === code), r.errors.map((e) => e.code).join(','))
  }
}

// ── 4. 图专属检查 ─────────────────────────────────────────────────────────
H('4. 图专属机械检查')
{
  const dup = goodPage()
  dup.elements.push({ id: 'in_box_copy', elementType: 'shape', bounds: { x: 71, y: 200, w: 180, h: 90 } })
  ok('duplicate-element：几乎重合的两元素被点名', checkDiagram(dup).errors.some((e) => e.code === 'duplicate-element'))

  const tot = goodPage()
  tot.elements.push({ id: 't1', elementType: 'text', bounds: { x: 600, y: 500, w: 200, h: 40 }, content: { text: '甲' } })
  tot.elements.push({ id: 't2', elementType: 'text', bounds: { x: 620, y: 505, w: 200, h: 40 }, content: { text: '乙' } })
  ok('text-over-text：文本互压报错（不可声明）', checkDiagram(tot).errors.some((e) => e.code === 'text-over-text'))

  const cross = goodPage()
  cross.elements.push({ id: 'box_mid', elementType: 'shape', bounds: { x: 280, y: 235, w: 60, h: 40 } })
  ok('line-through-box：线穿过非端点盒子报错', checkDiagram(cross).errors.some((e) => e.code === 'line-through-box'), JSON.stringify(checkDiagram(cross).errors))

  const containerOk = goodPage()
  ok('容器不算"被穿过的盒子"（线在容器内部正常）',
    !checkDiagram(containerOk).errors.some((e) => e.code === 'line-through-box' && /zone/.test(e.detail)))

  const arrowOff = goodPage()
  arrowOff.elements[4].points = [[250, 245], [380, 230]] // 箭头端悬空
  delete arrowOff.elements[4].attach
  const cOff = checkDiagram(arrowOff)
  ok('arrow-not-on-edge：无 attach ⇒ 警告级', cOff.warnings.some((e) => e.code === 'arrow-not-on-edge') && !cOff.errors.some((e) => e.code === 'arrow-not-on-edge'))

  const arrowOff2 = goodPage()
  arrowOff2.elements[4].points = [[250, 245], [380, 230]]
  const cOff2 = checkDiagram(arrowOff2)
  ok('arrow-not-on-edge：带 attach ⇒ 升级为错误', cOff2.errors.some((e) => e.code === 'arrow-not-on-edge'))
}

// ── 5. 三条硬纪律 ─────────────────────────────────────────────────────────
H('5. 硬纪律：确定性 / 不改输入 / 豁免不落盘')
{
  const page = goodPage()
  const before = JSON.stringify(page)
  const a = JSON.stringify(deriveRelations(page))
  const b = JSON.stringify(deriveRelations(goodPage()))
  ok('确定性：同输入两次推导结果深度相等', a === b)
  ok('不改输入：page 未被原地修改', JSON.stringify(page) === before)
  ok('豁免不落盘：page 上没有被写入 exempt/relations 等字段',
    !('exempt' in page) && !('relations' in page) && !('_relations' in page))

  // 关系顺序稳定（按 type|from|to 排序）
  const r = deriveRelations(goodPage())
  const keys = r.relations.map((x) => `${x.type}|${x.from}|${x.to}`)
  ok('关系顺序稳定（字典序）', keys.join(',') === [...keys].sort().join(','), keys.join(','))
}

// ── 6. 底层几何谓词（直接单测，防"上层看着对、谓词实际宽松"） ────────────────
H('6. 几何谓词单测')
{
  const P = { x: 0, y: 0, w: 100, h: 50, right: 100, bottom: 50 }
  ok('contains：完全包含为真', contains(P, { x: 10, y: 10, w: 20, h: 20, right: 30, bottom: 30 }))
  ok('contains：溢出 1px 为假', !contains(P, { x: 10, y: 10, w: 95, h: 20, right: 105, bottom: 30 }))
  ok('onSide：right 命中（含容差）', onSide('right', [100.5, 25], P) && !onSide('right', [103, 25], P))
  ok('onSide：纵向超界不算命中', !onSide('right', [100, 80], P))
  ok('segmentCrossesRect：穿过内部为真', segmentCrossesRect([-10, 25], [110, 25], P))
  ok('segmentCrossesRect：只贴边不算穿过', !segmentCrossesRect([0, 0], [0, 50], P))
  ok('rectOf 兼容数组与对象两种 bounds', rectOf({ bounds: [1, 2, 3, 4] }).right === 4 && rectOf({ bounds: { x: 1, y: 2, w: 3, h: 4 } }).bottom === 6)
}

// ── 7. schema 层：结构字段校验（A-①） ─────────────────────────────────────
H('7. schema：结构字段的类型与引用校验（validatePage）')
{
  const { validatePage } = await import('../lib/pptd/schema.js')
  const msg = (p) => { try { const e = validatePage(p, 'x.yaml'); return e ? (e.messages ?? []).join('｜') : '' } catch (err) { return String(err?.message ?? err) } }
  const shape = (id, extra = {}) => ({ elementId: id, elementType: 'shape', kind: 'rect', bounds: [0, 0, 40, 20], ...extra })
  const line = (extra = {}) => ({ elementId: 'l', elementType: 'line', points: [[0, 0], [40, 20]], ...extra })

  ok('合法：attach + arrow both + dash + groups 全通过',
    msg({ elements: [shape('a'), line({ attach: { from: { ref: 'a', side: 'right' } }, arrow: 'both', line: { dash: 'dash' } })], groups: [{ id: 'g', label: '组合', members: ['a', 'l'] }] }) === '')
  ok('attach.side 非法 ⇒ 报错', /attach\.from\.side/.test(msg({ elements: [shape('a'), line({ attach: { from: { ref: 'a', side: 'up' } } })] })))
  // 顺序无关（延后校验）：引用**写了但被引用元素在后文**⇒ 合法；引用真不存在 ⇒ 报错
  const laterRef = { elements: [line({ attach: { to: { ref: 'later', side: 'left' } } }), shape('later')] }
  const missingRef = { elements: [line({ attach: { to: { ref: 'ghost', side: 'left' } } })] }
  ok('attach.ref 顺序无关：引用后文元素合法、引用不存在元素报错',
    msg(laterRef) === '' && /不是本页元素 id/.test(msg(missingRef)),
    `后文引用=${msg(laterRef) || '通过'}｜不存在=${msg(missingRef) || '竟然通过'}`)
  ok('attach 放在非 line 元素上 ⇒ 报错', /只对 elementType: line 有效/.test(msg({ elements: [shape('a', { attach: { from: { ref: 'a', side: 'top' } } })] })))
  ok("arrow 非法值报错、'both' 合法", /arrow/.test(msg({ elements: [line({ arrow: 'front' })] })) && !/arrow/.test(msg({ elements: [line({ arrow: 'both' })] })))
  ok('line.dash 非法值 ⇒ 报错', /line\.dash/.test(msg({ elements: [line({ line: { dash: 'wavy' } })] })))
  ok('contains 指向不存在 / 指向自己 ⇒ 各自报错',
    /不是本页元素 id/.test(msg({ elements: [shape('a', { contains: ['nope'] })] })) && /不能包含自己/.test(msg({ elements: [shape('a', { contains: ['a'] })] })))
  ok('badgeOf 指向不存在 ⇒ 报错', /不是本页元素 id/.test(msg({ elements: [shape('a', { badgeOf: 'ghost' })] })))
  ok('roleReason 空串 ⇒ 报错', /roleReason/.test(msg({ elements: [{ elementId: 't', elementType: 'text', bounds: [0, 0, 80, 20], content: { text: 'x' }, role: 'background', roleReason: '   ' }] })))

  ok('groups：成员不存在 ⇒ 报错', /既不是元素也不是组 id/.test(msg({ elements: [shape('a')], groups: [{ id: 'g', members: ['ghost'] }] })))
  ok('groups：嵌套成环 ⇒ 报错', /嵌套成环/.test(msg({ elements: [shape('a')], groups: [{ id: 'g1', members: ['g2'] }, { id: 'g2', members: ['g1'] }] })))
  ok('groups：一个元素属两个直接组 ⇒ 报错', /只允许一个直接父组/.test(msg({ elements: [shape('a')], groups: [{ id: 'g1', members: ['a'] }, { id: 'g2', members: ['a'] }] })))
  ok('groups：id 与元素同名 / 重复组 id ⇒ 报错', /共用同一命名空间/.test(msg({ elements: [shape('a')], groups: [{ id: 'a', members: ['a'] }] })) && /duplicate/.test(msg({ elements: [shape('a')], groups: [{ id: 'g', members: ['a'] }, { id: 'g', members: ['a'] }] })))

  ok('expectedOverlaps.reason 类型错 ⇒ 报错；**缺失不报错**（docs/08：缺失仅警告）',
    /reason/.test(msg({ elements: [shape('a'), shape('b')], expectedOverlaps: [{ pair: ['a', 'b'], reason: 123 }] }))
    && !/reason/.test(msg({ elements: [shape('a'), shape('b')], expectedOverlaps: [{ pair: ['a', 'b'] }] })))

  // 非回归：既有的"只写 2 点 + 无结构字段"的 deck 行为完全不变
  ok('非回归：无新字段的页面校验结果与从前一致（无错误）', msg({ elements: [shape('a'), line({ arrow: true })] }) === '')
}

// ── 8. verify 集成（A-③）：结构豁免真的进声明集；报告段出现；且**门控**保证普通页不受影响 ──
H('8. verify 集成：结构豁免 / 报告形态 / 门控（非回归）')
{
  const { analyzePage, verifyDeck } = await import('../lib/verify.js')
  const size = { width: 960, height: 540 }
  const B = (x, y, w, h) => ({ x, y, w, h })
  const container = (extra = {}) => ({ id: 'zone', type: 'shape', kind: 'roundRect', bounds: B(40, 120, 880, 300), ...extra })
  const textInside = { id: 't1', type: 'text', kind: 'text', bounds: B(100, 200, 200, 40), content: { text: '标签' } }
  const wrap = (page) => ({ index: 0, name: 'p', safeArea: null, overlapMode: 'declared', elements: [], expectedOverlaps: [], ...page })

  // 无结构声明：容器(background) 压住文本(content) ⇒ declared 模式下未声明重叠 = 错误
  const plain = wrap({ elements: [container(), textInside] })
  const plainF = analyzePage(plain, size)
  ok('门控对照：**没有**结构声明的页，容器压文本仍是 unexpected-overlap 错误',
    plainF.some((f) => f.code === 'unexpected-overlap' && f.severity === 'error'),
    plainF.map((f) => `${f.severity}:${f.code}`).join(','))

  // 有 contains 且几何成立：同一对重叠被**结构关系豁免**（转为 confirmed 预期重叠，不再是错误）
  const struct = wrap({ elements: [container({ contains: ['t1'] }), textInside] })
  const structF = analyzePage(struct, size)
  ok('结构豁免生效：contains 成立 ⇒ 该对不再报 unexpected-overlap，而是 confirmed 预期重叠',
    !structF.some((f) => f.code === 'unexpected-overlap') && structF.some((f) => f.code === 'expected-overlap' && f.severity === 'confirmed'),
    structF.map((f) => `${f.severity}:${f.code}`).join(','))

  // contains 声明不成立（容器装不下子元素）⇒ 点名错误，且不再豁免
  const bad = wrap({ elements: [container({ contains: ['t1'], bounds: B(40, 120, 80, 40) }), textInside] })
  const badF = analyzePage(bad, size)
  ok('声明不成立 ⇒ 出现 relation-invalid 错误（豁免被撤回）',
    badF.some((f) => f.code === 'relation-invalid' && f.severity === 'error'),
    badF.map((f) => `${f.severity}:${f.code}`).join(','))

  // 已失效的预期重叠声明 ⇒ 可见警告（声明复核）
  // 注意：本路径**受门控**——只有"用了结构声明"的页才启用阶段 A 的检查与复核段（保证普通页行为不变）。
  // 因此夹具里必须同时有结构声明（下面的 contains）才能观察到 declared-stale。
  const stale = wrap({
    elements: [
      container({ contains: ['inside'] }),
      { ...textInside, id: 'inside', bounds: B(100, 200, 200, 40) },
      { ...textInside, id: 'far', bounds: B(900, 500, 40, 20) },
    ],
    expectedOverlaps: [{ pair: ['zone', 'far'], reason: '曾经的意图' }],
  })
  const staleF = analyzePage(stale, size)
  ok('失效声明 ⇒ warning declared-stale（不复用错误级，也不静默）',
    staleF.some((f) => f.code === 'declared-stale' && f.severity === 'warning'),
    staleF.map((f) => `${f.severity}:${f.code}`).join(','))

  // 报告形态：用了结构 ⇒ 结构关系行 + 声明复核段；没用 ⇒ 两段都不出现（门控）
  const structText = verifyDeck({ size, theme: null, pages: [struct] }).text
  const plainText = verifyDeck({ size, theme: null, pages: [plain] }).text
  ok('报告：用了结构的页有「结构关系」行', /· 结构关系：组 \d+｜包含 \d+｜附着 \d+｜徽章 \d+｜有意重叠 \d+（自动豁免重叠 \d+ 处，未落盘）/.test(structText), structText.split('\n').filter((l) => l.includes('结构关系')).join('｜'))
  ok('报告：声明复核段固定存在（豁免必须可见）', structText.includes('· 设计声明复核：'), structText.split('\n').filter((l) => l.includes('声明复核')).join('｜'))
  ok('门控（非回归）：没用新字段的页**不出现**这两段，报告与从前一致',
    !plainText.includes('· 结构关系：') && !plainText.includes('· 设计声明复核：'))
  ok('门控（非回归）：普通页 findings 里没有本次新增的任何 code',
    !plainF.some((f) => ['relation-invalid', 'declared-stale', 'duplicate-element', 'line-through-box', 'arrow-not-on-edge', 'group-cycle'].includes(f.code)),
    plainF.map((f) => f.code).join(','))
}

console.log(`\n==== verify-diagram-relations 结果：${pass} 通过 / ${fail} 失败 ====`)
if (fail) { console.log(`失败项：${failures.join('；')}`); process.exit(1) }
