/**
 * 线 × 文字检查的单元证据（先红后绿）
 *   ① 穿过文字 ⇒ 必须报 line-cross-text
 *   ② 不穿过  ⇒ 必须沉默
 *   ③ 声明刻意穿过(roleReason) ⇒ 必须沉默（豁免有效）
 * 用法：node scripts/check-line-text.mjs
 */
import { checkLineText } from '../src/pptd/line-text-rule.js'

const line = { elementType: 'line', elementId: 'life', points: [[100, 0], [100, 100]] }
const over = { elementType: 'text', elementId: 'lab', bounds: [80, 40, 60, 24] }
const clear = { elementType: 'text', elementId: 'lab2', bounds: [200, 40, 60, 24] }

const a = checkLineText([line, over])
const b = checkLineText([line, clear])
const c = checkLineText([{ ...line, roleReason: '刻意穿过示意' }, over])

const rows = [
  ['① 穿过文字 ⇒ 报错', a.length === 1 && a[0].code === 'line-cross-text', a.length ? a[0].message : '(未报)'],
  ['② 不穿过 ⇒ 沉默', b.length === 0, '命中 ' + b.length],
  ['③ 声明刻意穿过 ⇒ 沉默', c.length === 0, '命中 ' + c.length],
]
let bad = 0
console.log('线×文字检查单元证据：')
for (const [name, ok, detail] of rows) {
  if (!ok) bad++
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name.padEnd(22) + ' ' + detail)
}
console.log('==== ' + (bad === 0 ? '全部通过' : bad + ' 项未通过') + ' ====')
process.exit(bad === 0 ? 0 : 1)
