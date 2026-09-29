#!/usr/bin/env node
/**
 * 风格合规检查自证：`node scripts/verify-style-compliance.mjs`（阶段 E / Y3）
 *
 * 两条硬要求：
 *   ① **负面对照**：每条检查都必须能被"故意做错"的用例抓到（不许空转 ✗）；
 *   ② **既有交付物 0 误报**：在 12 族夹具与当前批次的真实 layout 上跑，findings 必须为 0（不许噪声 ✗）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkStyleCompliance, contrastRatio, luminance } from '../lib/pptd/style-compliance.js'

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; failures.push(name); console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const codes = (els, opts) => checkStyleCompliance(els, opts).map((f) => f.code)

// ---------- ① 负面对照：每条检查都要能抓到"故意做错"的图 ----------
// 不声明 contains：内圈形状落在卡片里却没人声明 ⇒ 必须报 style-undeclared-containment
const undeclared = [
  { id: 'card', kind: 'shape', shape: 'roundRect', bounds: { x: 0, y: 0, w: 100, h: 50 }, fill: '#2563EB' },
  { id: 'badge', kind: 'shape', shape: 'ellipse', bounds: { x: 5, y: 15, w: 16, h: 16 }, fill: '#F59E0B' },
]
ok('负面对照①：卡内元素未声明 contains ⇒ 报 style-undeclared-containment', codes(undeclared).includes('style-undeclared-containment'), codes(undeclared).join(','))

// 声明了就**不该**再报（同一几何，只加 contains）
const declaredOk = [
  { id: 'card', kind: 'shape', shape: 'roundRect', bounds: { x: 0, y: 0, w: 100, h: 50 }, fill: '#2563EB', contains: ['badge'] },
  { id: 'badge', kind: 'shape', shape: 'ellipse', bounds: { x: 5, y: 15, w: 16, h: 16 }, fill: '#F59E0B' },
]
ok('对照①b：声明 contains 后不再报（同一几何，只差声明）', !codes(declaredOk).includes('style-undeclared-containment'), codes(declaredOk).join(',') || '无 findings')

// 徽标与标题互压：标题左沿 < 徽标右沿 ⇒ 必须报 style-badge-too-tight
const tight = [
  { id: 'card', kind: 'shape', shape: 'roundRect', bounds: { x: 0, y: 0, w: 140, h: 50 }, fill: '#2563EB', contains: ['badge', 'title'] },
  { id: 'badge', kind: 'shape', shape: 'ellipse', bounds: { x: 5, y: 17, w: 16, h: 16 }, fill: '#F59E0B', contains: ['seq'] },
  { id: 'seq', kind: 'text', bounds: { x: 5, y: 19, w: 16, h: 12 }, style: { color: '#FFFFFF' } },
  { id: 'title', kind: 'text', bounds: { x: 12, y: 15, w: 120, h: 20 }, style: { color: '#FFFFFF' } },
]
ok('负面对照②：徽标与标题互压 ⇒ 报 style-badge-too-tight', codes(tight).includes('style-badge-too-tight'), codes(tight).join(','))

// 让位之后不该报
const spaced = JSON.parse(JSON.stringify(tight))
spaced[3].bounds.x = 30
ok('对照②b：标题让出栏位后不再报', !codes(spaced).includes('style-badge-too-tight'), codes(spaced).join(',') || '无 findings')

// 文字溢出容器 ⇒ 必须报 style-text-overflow
const overflow = [
  { id: 'card', kind: 'shape', shape: 'roundRect', bounds: { x: 0, y: 0, w: 100, h: 40 }, fill: '#2563EB', contains: ['t'] },
  { id: 't', kind: 'text', bounds: { x: 4, y: 4, w: 140, h: 30 }, style: { color: '#FFFFFF' } },
]
ok('负面对照③：文字越出容器 ⇒ 报 style-text-overflow', codes(overflow).includes('style-text-overflow'), codes(overflow).join(','))

// 低对比度：白字白底 ⇒ 必须报 style-contrast-low
const lowContrast = [
  { id: 'card', kind: 'shape', shape: 'roundRect', bounds: { x: 0, y: 0, w: 100, h: 40 }, fill: '#FFFFFF', contains: ['t'] },
  { id: 't', kind: 'text', bounds: { x: 4, y: 4, w: 90, h: 30 }, style: { color: '#FFFFFF' } },
]
ok('负面对照④：白字白底 ⇒ 报 style-contrast-low', codes(lowContrast).includes('style-contrast-low'), codes(lowContrast).join(','))

// 装饰件与声明豁免必须被跳过
const decorated = [
  { id: 'panel', kind: 'shape', shape: 'roundRect', bounds: { x: 0, y: 0, w: 200, h: 100 }, fill: '#EEF2FF', role: 'decoration', roleReason: '底板' },
  { id: 'inner', kind: 'shape', shape: 'rect', bounds: { x: 10, y: 10, w: 50, h: 20 }, fill: '#2563EB' },
]
ok('对照⑤：装饰底板不参与"未声明包含"判定', codes(decorated).length === 0, codes(decorated).join(',') || '无 findings')

// 对比度工具本身
ok('对比度工具：黑白 ≈ 21、同色 = 1', Math.abs(contrastRatio('#000000', '#FFFFFF') - 21) < 0.01 && Math.abs(contrastRatio('#123456', '#123456') - 1) < 0.001,
  `${contrastRatio('#000000', '#FFFFFF').toFixed(2)} / ${contrastRatio('#123456', '#123456').toFixed(2)}`)
ok('对比度工具：非法颜色返回 null（不瞎报）', luminance('rgb(1,2,3)') === null && contrastRatio('#FFF', '#000') === null)

// 负面对照⑥：导轨穿过内容 ⇒ 必须报；同一根线声明成"泳道分隔线"⇒ 不该报（豁免语义）
const rail = [
  { id: 'rail', kind: 'line', role: 'decoration', roleReason: '进度导轨', points: [[0, 20], [200, 20]] },
  { id: 'box', kind: 'shape', shape: 'roundRect', bounds: { x: 60, y: 0, w: 60, h: 50 }, fill: '#2563EB' },
]
ok('负面对照⑥：导轨穿过内容 ⇒ 报 style-rail-over-content', codes(rail).includes('style-rail-over-content'), codes(rail).join(','))
const sep = JSON.parse(JSON.stringify(rail))
sep[0].roleReason = '泳道分隔线（结构线）'
ok('对照⑥b：泳道分隔线**不算导轨** ⇒ 不报（避免结构性装饰被误判）', !codes(sep).includes('style-rail-over-content'), codes(sep).join(',') || '无 findings')

// 负面对照⑦：连接符离目标太远 ⇒ 必须报；贴住时不该报
const far = [
  { id: 'ch', kind: 'shape', shape: 'chevron', bounds: { x: 0, y: 0, w: 18, h: 14 }, fill: '#B45309' },
  { id: 'dst', kind: 'shape', shape: 'roundRect', bounds: { x: 40, y: 0, w: 60, h: 40 }, fill: '#2563EB' },
]
ok('负面对照⑦：连接符离目标 22px ⇒ 报 style-connector-off-target', codes(far).includes('style-connector-off-target'), codes(far).join(','))
const near = JSON.parse(JSON.stringify(far))
near[0].bounds.x = 20
ok('对照⑦b：连接符贴住目标（差 2px）⇒ 不再报', !codes(near).includes('style-connector-off-target'), codes(near).join(',') || '无 findings')

// 负面对照⑧：**穿过预留区**（Z2 band-crossing）—— 线/文本压进禁区必须报；禁区外不该报
const bands = [{ id: 'frame.title', x: 0, y: 0, w: 200, h: 30, reason: '顶部标题带' }]
const crossLine = [
  { id: 'ln', kind: 'line', points: [[10, 15], [180, 15]] },                                  // 整条在禁区内
  { id: 'card', kind: 'shape', shape: 'roundRect', bounds: { x: 40, y: 100, w: 100, h: 40 }, fill: '#2563EB' },
]
ok('负面对照⑧：连线穿过预留区 ⇒ 报 band-crossing', codes(crossLine, { reservedBands: bands }).includes('band-crossing'), codes(crossLine, { reservedBands: bands }).join(','))
const crossText = [
  { id: 't', kind: 'text', bounds: { x: 20, y: 5, w: 80, h: 20 }, style: { color: '#111111' } }, // 文本压进禁区
]
ok('负面对照⑧b：文本压进预留区 ⇒ 同样报（不只连线）', codes(crossText, { reservedBands: bands }).includes('band-crossing'), codes(crossText, { reservedBands: bands }).join(','))
const clean = [
  { id: 'ln2', kind: 'line', points: [[10, 200], [180, 200]] },                               // 禁区之外
  { id: 't2', kind: 'text', bounds: { x: 20, y: 210, w: 80, h: 20 }, style: { color: '#111111' } },
]
ok('对照⑧c：禁区之外不该报（避免噪声）', !codes(clean, { reservedBands: bands }).includes('band-crossing'), codes(clean, { reservedBands: bands }).join(',') || '无 findings')
ok('对照⑧d：不传 reservedBands ⇒ 该判据完全不触发（向后兼容）', !codes(crossLine).includes('band-crossing'))

// ── Z5：渐变填充的对比度必须**按 stops 两端分别判、取最差**（不许用平均值蒙混）──
const gradLight = [
  { id: 'c1', kind: 'shape', shape: 'roundRect', bounds: { x: 0, y: 0, w: 200, h: 60 }, fill: { type: 'gradient', stops: [{ pos: 0, color: '#93C5FD' }, { pos: 100, color: '#1E3A8A' }] } },
  { id: 't1', kind: 'text', bounds: { x: 10, y: 20, w: 120, h: 20 }, style: { color: '#FFFFFF' }, fill: { type: 'gradient', stops: [{ pos: 0, color: '#93C5FD' }, { pos: 100, color: '#1E3A8A' }] } },
]
ok('负面对照⑨：白字压"浅蓝→深蓝"渐变 ⇒ **浅端**必须被抓（1.6:1）', codes(gradLight).includes('style-contrast-low'), codes(gradLight).join(','))
const gradDark = [
  { id: 'c2', kind: 'shape', shape: 'roundRect', bounds: { x: 0, y: 0, w: 200, h: 60 }, fill: { type: 'gradient', stops: [{ pos: 0, color: '#1E3A8A' }, { pos: 100, color: '#0F172A' }] } },
  { id: 't2', kind: 'text', bounds: { x: 10, y: 20, w: 120, h: 20 }, style: { color: '#FFFFFF' }, fill: { type: 'gradient', stops: [{ pos: 0, color: '#1E3A8A' }, { pos: 100, color: '#0F172A' }] } },
]
ok('对照⑨b：白字压"深蓝→更深蓝"渐变（两端都够暗）⇒ 不该报（修此前误报）', !codes(gradDark).includes('style-contrast-low'), codes(gradDark).join(',') || '无 findings')

// ---------- ② 既有交付物 0 误报 ----------
const targets = []
const latest = readdirSync(tmpdir()).filter((d) => d.startsWith('pptd-families-')).sort().pop()
if (latest) targets.push(['既有 12 族夹具', join(tmpdir(), latest)])
targets.push(['当前批次 fresh-sea', 'examples/fresh-sea'])
let scanned = 0
for (const [label, dir] of targets) {
  const f = join(dir, 'preview', 'layout.json')
  if (!existsSync(f)) { console.log(`… 跳过 ${label}（无 preview/layout.json）`); continue }
  const layout = JSON.parse(readFileSync(f, 'utf8'))
  const pages = Array.isArray(layout.pages) ? layout.pages : Object.values(layout.pages ?? {})
  let n = 0
  const sample = []
  for (const p of pages) {
    const fs2 = checkStyleCompliance(p.elements ?? [])
    n += fs2.length
    if (fs2.length && sample.length < 3) sample.push(`${fs2[0].code}@${fs2[0].id}`)
  }
  scanned += pages.length
  ok(`${label}：风格合规 **0 误报**`, n === 0, n === 0 ? `${pages.length} 页` : `${n} 条（如 ${sample.join(' , ')}）`)
}
ok('覆盖面（至少扫到 1 个面）', scanned > 0, `共扫 ${scanned} 页`)

console.log(`\n==== verify-style-compliance 结果：${pass} 通过 / ${fail} 失败 ====`)
if (fail) { console.log(`失败项：${failures.join('；')}`); process.exit(1) }
