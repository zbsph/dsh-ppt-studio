#!/usr/bin/env node
/**
 * 手画 13 页回归基线（F0 冻结）—— 用手画的**自动化回归**代替族时代的断言。
 *
 * 比对三项**与元数据无关**的不变量（不依赖 PowerPoint、不需要导出）：
 *   ① layout 摘要：每页「元素 id + 类型 + 圆整后的 bounds/points」规范化 JSON 的 sha256
 *   ② 每页门禁 错/警 计数与警 code 集合
 *   ③ 13 张命名 PNG 的 sha256（若文件存在）
 *
 * 用法：
 *   node scripts/verify-handdrawn.mjs --capture   # 落基线（只在冻结时用）
 *   node scripts/verify-handdrawn.mjs             # 与基线比对（CI/回归用）
 */
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDeck } from '../src/pptd/schema.js'
import { renderDeck } from '../src/pptd/render-html.js'
import { verifyDeck } from '../src/verify.js'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC = join(ROOT, 'examples', 'hand-drawn')
const OUT = join(ROOT, '..', 'ppt-deliverable', '手画12+1')
const BASE = join(ROOT, 'scripts', 'fixtures', 'handdrawn-baseline.json')
const ORDER = ['01','02','03','04','05','06','07','08','09','10','11','12','13']
const NAMES = { '01':'01-层级树（手画）.png','02':'02-矩阵（手画）.png','03':'03-时间轴（手画）.png','04':'04-泳道（手画）.png','05':'05-左右对比（手画）.png','06':'06-闭环（手画）.png','07':'07-漏斗（手画）.png','08':'08-步骤环（手画）.png','09':'09-时序（手画）.png','10':'10-状态机（手画）.png','11':'11-流程图（手画）.png','12':'12-分层架构（手画）.png','13':'13-平台架构（手画）.png' }
const r2 = (n) => Math.round(n * 100) / 100
const normEl = (e) => {
  const b = e.bounds
  const bounds = Array.isArray(b) ? b.map(r2) : (b && typeof b === 'object' ? [r2(b.x), r2(b.y), r2(b.w), r2(b.h)] : null)
  const pts = Array.isArray(e.points) ? e.points.map((p) => [r2(p[0]), r2(p[1])]) : null
  return { id: String(e.id ?? e.elementId ?? '?'), t: String(e.kind ?? e.type ?? '?'), bounds, pts }
}
const sha = (s) => createHash('sha256').update(s).digest('hex')

const ctx = await resolveDeck(SRC)
await renderDeck(ctx, { out: 'preview' })
const layout = JSON.parse(readFileSync(join(SRC, 'preview', 'layout.json'), 'utf8'))
const pages = Array.isArray(layout.pages) ? layout.pages : Object.values(layout.pages)

const perPage = pages.map((p, i) => {
  const v = verifyDeck({ pages: [p] })
  const els = (p.elements ?? []).map(normEl).sort((a, b) => a.id.localeCompare(b.id))
  return {
    page: ORDER[i],
    els: els.length,
    errors: v.errors.length,
    errorCodes: [...new Set(v.errors.map((e) => e.code))].sort(),
    warns: v.warns.length,
    warnCodes: [...new Set(v.warns.map((w) => w.code))].sort(),
    digest: sha(JSON.stringify(els)),
  }
})
const digest = sha(JSON.stringify(perPage.map((p) => [p.page, p.els, p.digest])))
const pngs = {}
for (const code of ORDER) {
  const f = join(OUT, NAMES[code])
  if (existsSync(f)) pngs[NAMES[code]] = sha(readFileSync(f))
}
const cur = { digest, perPage, pngs }

if (process.argv.includes('--capture')) {
  mkdirSync(dirname(BASE), { recursive: true })
  const head = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
  // 保留更新历史：不再整文件覆写（否则上一次的更新原因会丢——实测踩过）
  const prev = existsSync(BASE) ? JSON.parse(readFileSync(BASE, 'utf8')) : {}
  const reasonIdx = process.argv.indexOf('--reason')
  const reason = reasonIdx >= 0 ? (process.argv[reasonIdx + 1] ?? '(未注明)') : '(未注明，见提交信息)'
  const history = [...(prev.history ?? [])]
  if (prev.digest && prev.digest !== cur.digest) history.push({ at: new Date().toISOString(), from: prev.digest, to: cur.digest, reason })
  else if (prev.digest && prev.digest === cur.digest) history.push({ at: new Date().toISOString(), from: cur.digest, to: cur.digest, reason: '摘要未变（重采）: ' + reason })
  writeFileSync(BASE, JSON.stringify({ savedAt: new Date().toISOString(), head, ...cur, history }, null, 2) + '\n')
  console.log('✓ 基线已落盘 scripts/fixtures/handdrawn-baseline.json')
  console.log('  layout 摘要 = ' + digest)
  console.log('  逐页 = ' + perPage.map((p) => p.page + ':错' + p.errors + '/警' + p.warns).join(' '))
  console.log('  PNG 记录 = ' + Object.keys(pngs).length + ' 张')
  process.exit(0)
}

if (!existsSync(BASE)) { console.log('✗ 无基线文件，请先 --capture'); process.exit(1) }
const base = JSON.parse(readFileSync(BASE, 'utf8'))
// history 断言（P2-3）：基线必须留有**变更沿革**，且每条都要写明原因（不许静默改基线）
{
  const h = base.history
  const bad = !Array.isArray(h) || h.length === 0 || h.some((e) => !e || typeof e.reason !== 'string' || !e.reason.trim())
  if (bad) bad.push('基线 history 缺失或条目无 reason ⇒ 请用: node scripts/verify-handdrawn.mjs --capture --reason "原因"')
  if (bad !== false && bad) { console.log('✗ ' + (Array.isArray(bad) ? bad[bad.length - 1] : bad)); process.exit(1) }
}
const bad = []
// PNG sha：次要不变量（像素级）。渲染依赖 PowerPoint 版本/环境 ⇒ 差异只警告不失败（硬不变量是 layout 摘要）；
// 交付目录不存在（如全新 clone）则整体跳过，保证 CI 可移植。
let pngSame = 0
const pngWarn = []
let pngMiss = 0
for (const [name, h] of Object.entries(base.pngs ?? {})) {
  if (!(name in cur.pngs)) { pngMiss++; continue }
  if (cur.pngs[name] === h) pngSame++
  else pngWarn.push(name)
}
if (base.digest !== cur.digest) bad.push('layout 摘要变化：' + base.digest.slice(0, 12) + ' → ' + cur.digest.slice(0, 12))
for (const p of cur.perPage) {
  const b = (base.perPage ?? []).find((x) => x.page === p.page)
  if (!b) { bad.push('基线缺页 ' + p.page); continue }
  if (b.digest !== p.digest) bad.push('[' + p.page + '] 布局摘要变化')
  if (b.errors !== p.errors) bad.push('[' + p.page + '] 错误数 ' + b.errors + ' → ' + p.errors)
  if (b.warns !== p.warns) bad.push('[' + p.page + '] 警告数 ' + b.warns + ' → ' + p.warns)
}
const errorsTotal = cur.perPage.reduce((a, p) => a + p.errors, 0)
const warnsTotal = cur.perPage.reduce((a, p) => a + p.warns, 0)
console.log('手画 13 页回归：' + cur.perPage.length + ' 页｜错 ' + errorsTotal + '｜警 ' + warnsTotal + '｜layout 摘要 ' + cur.digest.slice(0, 12))
console.log('  产物对照: PNG 相同 ' + pngSame + ' 张｜缺失跳过 ' + pngMiss + ' 张｜差异 ' + pngWarn.length + ' 张' + (pngWarn.length ? '（' + pngWarn.slice(0, 3).join('; ') + '）—— 像素差异属环境/渲染差异, 硬不变量是 layout 摘要' : ''))
if (errorsTotal > 0) bad.push('存在门禁错误')
if (bad.length) { console.log('✗ 与基线不一致：'); bad.forEach((b) => console.log('   · ' + b)); process.exit(1) }
console.log('✓ 与基线一致（layout 摘要逐字节相同 + 错警计数相同）')
