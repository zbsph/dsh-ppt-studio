#!/usr/bin/env node
/**
 * 风格特型（traits）自证：`node scripts/verify-traits.mjs`
 *
 * 阶段 E / Y2。守的是**宪法③**：风格要新做法 ⇒ 必须进闭集并同时带合规检查；
 * **未知键 / 非法值一律报错，绝不静默忽略**（静默忽略会让"风格"悄悄把图改坏）。
 *
 * 另守：**默认 traits 必须严格等于现状**（Y2 的"默认逐像素不变"承诺由此起步）。
 */
import { validateTraits, DEFAULT_TRAITS, TRAIT_SPEC, DENSITY, traitSummary } from '../lib/pptd/style-traits.js'

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; failures.push(name); console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
/** 深比较（不依赖键序 —— 上一版用 JSON.stringify 比键序，误报过一次，别再犯） */
const deepEq = (a, b) => {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return false
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every((k) => deepEq(a[k], b[k]))
}

// ① 不传 / 传 null ⇒ 零错误，且**深等于**默认（键序无关）
for (const [label, raw] of [['不传', undefined], ['传 null', null]]) {
  const r = validateTraits(raw)
  ok(`${label} traits ⇒ 零错误且深等于默认`, r.errors.length === 0 && deepEq(r.traits, DEFAULT_TRAITS))
  ok(`${label} traits ⇒ honored 为空（没有"生效的特型"）`, r.honored.length === 0)
}

// ② 合法 traits ⇒ 生效；honored **逐项**列出（数量与内容都断言）
const b = validateTraits({ card: { shape: 'pill' }, badge: 'number', subtitle: true, frame: { title: true, rails: 'return' }, density: 'compact' })
ok('合法 traits ⇒ 零错误且生效', b.errors.length === 0 && b.traits.card.shape === 'pill' && b.traits.frame.rails === 'return' && b.traits.badge === 'number')
ok('honored 恰好 6 项且内容正确', b.honored.length === 6
  && ['card.shape="pill"', 'badge="number"', 'subtitle=true', 'frame.title=true', 'frame.rails="return"', 'density="compact"'].every((s) => b.honored.includes(s)),
  b.honored.join(' , '))
ok('未改动的特型不进 honored', !b.honored.some((s) => s.startsWith('edgeLabel') || s.startsWith('markers')))
ok('traitSummary 可读（过程证据）', /card=pill/.test(traitSummary(b.traits)) && /frame=title\/return/.test(traitSummary(b.traits)), traitSummary(b.traits))

// ③ 未知特型键 ⇒ 报错（宪法③）
const c = validateTraits({ handDrawn: true })
ok('未知特型键 ⇒ 报错且点名闭集', c.errors.length === 1 && /未知风格特型 "handDrawn"/.test(c.errors[0]) && /card/.test(c.errors[0]))
ok('未知特型不影响其余默认值', deepEq({ ...c.traits, card: DEFAULT_TRAITS.card, edge: DEFAULT_TRAITS.edge, frame: DEFAULT_TRAITS.frame }, DEFAULT_TRAITS))

// ④ 非法取值 ⇒ 报错（标量 / 子键 / 子对象类型三路都查）
const d = validateTraits({ card: { shape: 'blob' }, edge: { glyph: 'squiggle', nope: 1 }, density: 'huge', frame: 3 })
ok('非法取值 ⇒ 逐条报错（含子键非法与子键不存在）', d.errors.length === 5, `${d.errors.length} 条：` + d.errors.map((x) => x.slice(0, 26)).join(' | '))
ok('非法时保留默认，不写入脏值', d.traits.card.shape === DEFAULT_TRAITS.card.shape && d.traits.density === DEFAULT_TRAITS.density && d.traits.edge.glyph === DEFAULT_TRAITS.edge.glyph)
const e2 = validateTraits('pill')
ok('traits 不是对象 ⇒ 报错', e2.errors.length === 1 && /必须是对象/.test(e2.errors[0]))

// ⑤ 闭集自检：TRAIT_SPEC 与 DEFAULT_TRAITS 必须键对键一致（防"加了闭集忘了默认"这类漂移）
const specKeys = Object.keys(TRAIT_SPEC).sort().join(',')
const defKeys = Object.keys(DEFAULT_TRAITS).sort().join(',')
ok('闭集与默认值键集合一致', specKeys === defKeys, specKeys === defKeys ? specKeys : `闭集=${specKeys} 默认=${defKeys}`)
const subOk = Object.entries(TRAIT_SPEC).every(([k, spec]) => {
  if (!Array.isArray(spec)) return true
  return spec.includes(DEFAULT_TRAITS[k])
})
ok('每个标量特型的默认值都在允许集合内', subOk)

// ⑥ 密度：只允许常量（不得影响路由）
ok('density 只有三档且都是常量对象', Object.keys(DENSITY).sort().join(',') === 'compact,loose,normal' && Object.values(DENSITY).every((v) => typeof v.rowGap === 'number' && typeof v.laneStep === 'number'))

console.log(`\n==== verify-traits 结果：${pass} 通过 / ${fail} 失败 ====`)
if (fail) { console.log(`失败项：${failures.join('；')}`); process.exit(1) }
