#!/usr/bin/env node
/**
 * 折线形态自证（X3）：`node scripts/verify-shape.mjs`
 *
 * 为什么单独成脚本：`verify:route` 的断言针对"密集夹具的交叉"，而这里要守的是**形态底线**
 * （折返尖刺、端点悬在图形内部）——跨**所有**交付面跑，任何一批新内容都能被它兜住。
 *
 * 三条断言：
 *   ① **无折返尖刺**：连续三点共线且中间点折返（用户实测图 10 顶端那根多余线就是这个）；
 *   ② **无端点悬空于图形内部**：端点落在某个图形**内部**（离轮廓 >2px）⇒ 看起来"戳进盒子"；
 *   ③ 检查覆盖 12 族夹具 + 两个从零批次（缺目录时跳过并说明，不假装通过）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; failures.push(name); console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const spikesOf = (pts) => {
  let n = 0
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1]; const b = pts[i]; const c = pts[i + 1]
    const sameX = Math.abs(a[0] - b[0]) < 0.5 && Math.abs(b[0] - c[0]) < 0.5
    const sameY = Math.abs(a[1] - b[1]) < 0.5 && Math.abs(b[1] - c[1]) < 0.5
    if ((sameX && (b[1] - a[1]) * (c[1] - b[1]) < 0) || (sameY && (b[0] - a[0]) * (c[0] - b[0]) < 0)) n++
  }
  return n
}
const rectOf = (b) => Array.isArray(b) ? { x: b[0], y: b[1], w: b[2], h: b[3] } : b
/** 端点是否"悬在某个图形内部"（离轮廓 >2px） */
const insideAny = (pt, boxes) => {
  for (const b of boxes) {
    if (b.role === 'decoration') continue
    if (pt[0] > b.r.x + 2 && pt[0] < b.r.x + b.r.w - 2 && pt[1] > b.r.y + 2 && pt[1] < b.r.y + b.r.h - 2) return b.id
  }
  return null
}

/** 待检面：directory → 名称（缺目录则跳过） */
const latest = readdirSync(tmpdir()).filter((d) => d.startsWith('pptd-families-')).sort().pop()
const targets = [
  ['既有 12 族夹具', latest ? join(tmpdir(), latest) : null],
  ['从零批次 fresh-tea', 'examples/fresh-tea'],
  ['从零批次 fresh-wind', 'examples/fresh-wind'],
]

for (const [label, dir] of targets) {
  if (!dir || !existsSync(join(dir, 'preview', 'layout.json'))) {
    console.log(`… 跳过 ${label}（尚无 preview/layout.json；先跑对应渲染）`)
    continue
  }
  const layout = JSON.parse(readFileSync(join(dir, 'preview', 'layout.json'), 'utf8'))
  let spike = 0
  let floating = 0
  const spikeAt = []
  const floatAt = []
  layout.pages.forEach((page, pi) => {
    // 只把**内容图形**当"盒子"：分组容器（声明了 contains 的板）与 role:decoration 都是结构件，
    // 连线端点落在里面是正常画法（第一版没排除容器 ⇒ 误报 5~7 处，实测修正）。
    const boxes = (page.elements ?? [])
      .filter((e) => e.kind === 'shape' && e.bounds && e.role !== 'decoration' && !(e.contains ?? []).length)
      .map((e) => ({ id: e.id, r: rectOf(e.bounds), role: e.role }))
    for (const e of (page.elements ?? [])) {
      if (e.kind !== 'line' || !Array.isArray(e.points)) continue
      const sp = spikesOf(e.points)
      if (sp) { spike += sp; spikeAt.push(`p${pi + 1}:${e.id}`) }
      if (e.role === 'decoration' || e.roleReason) continue
      for (const pt of [e.points[0], e.points[e.points.length - 1]]) {
        const hit = insideAny(pt, boxes)
        if (hit) { floating++; floatAt.push(`p${pi + 1}:${e.id}→${hit}`) }
      }
    }
  })
  ok(`${label}：**无折返尖刺**`, spike === 0, spike ? `${spike} 处（${spikeAt.slice(0, 4).join(', ')}）` : `${layout.pages.length} 页`)
  ok(`${label}：**无端点悬在图形内部**`, floating === 0, floating ? `${floating} 处（${floatAt.slice(0, 4).join(', ')}）` : '全部端点贴边或落在图形外')
}

console.log(`\n==== verify-shape 结果：${pass} 通过 / ${fail} 失败 ====`)
if (fail) { console.log(`失败项：${failures.join('；')}`); process.exit(1) }
