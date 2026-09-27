/**
 * 快测档（`npm run test:fast`，2026-09-27 新增）——**每条改动**默认跑这一档。
 *
 * 设计（用户 2026-09-27 拍板）：
 *   ① 廉价跨切面守卫**永远全跑**——它们抓的正是"改 A 文件、断言在 B 文件里"这类子集化最容易漏的错
 *      （真实案例：改技能正文撞 ≤8000 字上限；改 schema 的 chart 字段撞"手册 vs 源码事实审计"）。
 *   ② 影响面由 `scripts/test-map.mjs` 从 `git diff` 推出，`--explain` 可解释每一步选择。
 *   ③ **fail-safe**：改动文件没映射到任何规则 ⇒ 视为影响面未知 ⇒ 自动升级为全量 smoke。
 *   ④ 重活（真渲染/真装包/真跑 python）默认不进快测，`--with-heavy` 才带。
 *
 * 用法：
 *   node scripts/test-fast.mjs                 # 按 git diff 自动判定
 *   node scripts/test-fast.mjs --files=a.js,b.js
 *   node scripts/test-fast.mjs --full          # 强制全量（等价 npm test）
 *   node scripts/test-fast.mjs --with-heavy    # 带上重节（仍按影响面选面）
 *   node scripts/test-fast.mjs --explain       # 只解释不执行
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { explain, root, sectionsFromSmoke } from './test-map.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (name) => { const a = argv.find((x) => x.startsWith(`${name}=`)); return a ? a.slice(name.length + 1) : null }

function sh(cmd, extraEnv = {}) {
  const t0 = Date.now()
  const r = spawnSync(cmd, { shell: true, cwd: root, encoding: 'utf8', env: { ...process.env, ...extraEnv } })
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { code: r.status ?? 1, sec, out }
}

function changedFiles() {
  const explicit = valOf('--files')
  if (explicit) return explicit.split(',').map((s) => s.trim()).filter(Boolean)
  // CI（干净检出、无本地改动）通道：由 workflow 把 PR 的改动清单写进文件，路径放这个环境变量里。
  // 没有它、且干净检出 ⇒ 文件数为 0 ⇒ 调用方 fail-safe 跑全量（不假装"没有影响面"）。
  const fromEnv = process.env.TEST_FAST_FILES
  if (fromEnv) {
    try {
      const text = existsSync(fromEnv) ? readFileSync(fromEnv, 'utf8') : fromEnv
      return [...new Set(text.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean))]
    } catch { /* 落到 git 通道 */ }
  }
  const r = spawnSync('git', ['-C', root, 'status', '--porcelain=v1'], { encoding: 'utf8' })
  const files = []
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const p = line.slice(3).trim()
    // 改名 `old -> new` 取新路径
    files.push(p.includes('->') ? p.split('->')[1].trim() : p)
  }
  // 已提交但尚未发版的改动也要算（与上一个 tag 比）
  const tag = spawnSync('git', ['-C', root, 'describe', '--tags', '--abbrev=0'], { encoding: 'utf8' })
  if ((tag.status ?? 1) === 0) {
    const since = spawnSync('git', ['-C', root, 'diff', '--name-only', `${String(tag.stdout).trim()}..HEAD`], { encoding: 'utf8' })
    for (const f of String(since.stdout ?? '').split(/\r?\n/)) if (f.trim()) files.push(f.trim())
  }
  return [...new Set(files)]
}

const files = changedFiles()
const ex = explain(files, { includeHeavy: has('--with-heavy') })
const guarded = ex.unmapped.length > 0 || files.length === 0
const docsOnly = !guarded && ex.files.every((f) => f.startsWith('docs/') || f.startsWith('skills/') || f === 'README.md')

console.log('==== 快测档（test:fast）====')
console.log(`改动文件 ${files.length} 个｜标签 = ${[...ex.tags].join(',') || '(无)'}｜选中分节 ${ex.sections.length}/${sectionsFromSmoke().length}`)
if (files.length) console.log(`  选中：${ex.sections.slice(0, 14).map((s) => s.id).join(' ')}${ex.sections.length > 14 ? ` …(+${ex.sections.length - 14})` : ''}`)
for (const n of ex.notes) console.log(`  ℹ ${n}`)
if (has('--explain')) { console.log('（--explain：只解释，不执行）'); process.exit(0) }

const results = []
const run = (name, cmd, env) => {
  const r = sh(cmd, env)
  results.push({ name, ...r })
  console.log(`${r.code === 0 ? '✓' : '✗'} ${name}（${r.sec}s）`)
  if (r.code !== 0) console.log(r.out.split(/\r?\n/).filter((l) => /✗|Error|错误/.test(l)).slice(0, 6).join('\n'))
}

// ① 廉价跨切面守卫：永远跑（这几条全部加起来的代价约 6s，是快测的固定底座）
run('build（src → lib）', 'node scripts/build.mjs')
run('语法体检（src/lib/scripts 全覆盖）', 'node scripts/check-syntax.mjs')
run('LF 守卫', 'node scripts/check-tracked-lf.mjs')
run('lib 新鲜度', 'node scripts/check-lib-freshness.mjs')
run('预设门禁', 'node scripts/check-preset.mjs')
run('手册事实审计', 'node scripts/audit-manual-facts.mjs')

// ② 主体：按影响面决定
if (has('--full') || guarded) {
  const why = has('--full') ? '显式 --full' : (files.length === 0 ? '没有改动文件' : '有未映射文件 ⇒ fail-safe')
  console.log(`▶ 跑**全量 smoke**（${why}）——注意：这一档约 5.2 分钟`)
  run('smoke 全量', 'node scripts/smoke.mjs')
} else if (docsOnly) {
  console.log('▶ 只改了文档/技能 ⇒ **不跑 smoke**（运行时零改动）。若你改了 smoke 自身或断言数量，请用 --full。')
} else {
  console.log('▶ 运行时可改：本档默认**不跑 smoke 全量**（重节与深回归留到批次边界/发版）。')
  console.log(`  受影响分节（供你判断是否需要 --full）：${ex.sections.map((s) => s.id).join(' ') || '(无)'}`)
  if (has('--with-heavy')) console.log('  （--with-heavy：真正需要真渲染/真装包那类重节时，用 `npm test` 或 `npm run test:release`）')
}

const total = results.reduce((a, r) => a + Number(r.sec), 0).toFixed(1)
const failed = results.filter((r) => r.code !== 0)
console.log(`==== 快测结果：${results.length - failed.length}/${results.length} 通过｜用时 ${total}s ====`)
if (failed.length) { console.log(`✗ 失败：${failed.map((f) => f.name).join('、')}`); process.exit(1) }
console.log('提示：批次边界与发版前请跑 `npm test`（全量）；发版用 `npm run test:release`。')
