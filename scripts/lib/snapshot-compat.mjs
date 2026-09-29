/**
 * 快照兼容小工具（阶段 E / Y2-4b 补齐）
 *
 * 本仓库有**两套元素形态**，写法不同、字段名不同，混用会出"看起来对、其实读错字段"的错：
 *
 * | 字段 | DSL（作者手写 / 族输出） | 快照（preview/layout.json、门禁输入） |
 * |---|---|---|
 * | 元素 id | `elementId` | `id` |
 * | 形状预设 | **`kind`**（`roundRect`…） | **`shape`**（`kind` 恒为 `'shape'`） |
 * | 边界 | **数组** `[x, y, w, h]` | **对象** `{x, y, w, h}` |
 * | 线 | `elementType:'line'`, `points` | `kind:'line'`, `points` |
 *
 * 本会话里同类误读**踩了三次**（`bounds` 当数组读对象、`kind` 当预设读快照、再犯一次）⇒ 统一从这里取，
 * 自测脚本不要再各写各的。
 */

/** 边界：数组或对象一律归一成 `{x,y,w,h}`；拿不到返回 null */
export function rectOf(b) {
  if (!b) return null
  if (Array.isArray(b)) return { x: b[0], y: b[1], w: b[2], h: b[3] }
  if (typeof b === 'object') return { x: b.x, y: b.y, w: b.w, h: b.h }
  return null
}

/** 形状预设名：快照读 `shape`，DSL 读 `kind`；`kind === 'shape'` 是快照的**类型标记**，不是预设 */
export function shapeKindOf(el) {
  const s = el?.shape
  if (typeof s === 'string' && s) return s
  const k = el?.kind
  if (typeof k === 'string' && k && k !== 'shape') return k
  return 'roundRect'
}

/** 元素 id：DSL 用 elementId，快照用 id */
export const idOf = (el) => el?.elementId ?? el?.id ?? null

/** 是否是形状 / 线（两套形态都认） */
export const isShape = (el) => el?.elementType === 'shape' || el?.kind === 'shape'
export const isLine = (el) => el?.elementType === 'line' || el?.kind === 'line'
export const isText = (el) => el?.elementType === 'text' || el?.kind === 'text'

/** 线端点（两套形态都是 points）；拿不到返回 [] */
export const pointsOf = (el) => (Array.isArray(el?.points) ? el.points : [])

/** 文本内容：**多形态容错**（快照实测为 style+metrics 形态；不同来源可能是 text / content.text / runs / lines）
 * —— 与其猜字段名（本会话已踩 6 次假设类错误），不如一次把所有已知形态都认掉。 */
export function textOf(el) {
  if (!el) return ''
  if (typeof el.text === 'string') return el.text
  if (typeof el.content?.text === 'string') return el.content.text
  if (Array.isArray(el.runs)) return el.runs.map((r) => r?.text ?? '').join('')
  if (Array.isArray(el.lines)) return el.lines.map((l) => (typeof l === 'string' ? l : l?.text ?? '')).join('\n')
  if (typeof el.value === 'string') return el.value
  return ''
}

/** 线的最高点（用于"是否进入预留带"这类判断）；无点返回 null */
export function topMostY(el) {
  const pts = pointsOf(el)
  if (!pts.length) return null
  return Math.min(...pts.map((p) => p[1]))
}
