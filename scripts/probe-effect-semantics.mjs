/**
 * Cordis `ctx.effect` 语义探针（docs/01 决策 12 / docs/02 §2.12 的证据）
 *
 * 结论（本脚本可复跑自证）：`ctx.effect(cb)` **立即执行 cb**，并把 **cb 的返回值**当作 disposer；
 * 它**不是**"把 cb 当清理函数"。
 *
 * 为什么值得留一个脚本：本仓库曾有两处按相反理解写代码——
 *   ① `preview-server` 的路由 refcount 把清理体写在 cb 体内 ⇒ 注册当刻就 `count--` 并置 `cancelled=true`，
 *      文档承诺的"首个注册者真注册、最后卸载者真卸载"从未成立（路由注册后立即被取消）；
 *   ② 新增的装配防重第一版同样写法 ⇒ 防重完全失效（smoke §40 行为断言当场抓到）。
 * 而 smoke 里的**假 ctx** 当时也写反了契约，于是真 bug 在测试里看起来是对的——**测试替身错了，测试就在替 bug 背书**。
 * 所以：契约可疑时跑这个探针，别靠读注释。
 *
 * 用法：`node scripts/probe-effect-semantics.mjs`（找不到 cordis 时跳过，退出码 0）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const candidates = []
try {
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
  candidates.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'))
} catch { /* npm 不可用 */ }
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
candidates.push(join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'))

const found = candidates.find((p) => existsSync(p))
if (!found) {
  console.log('⚠ 跳过：找不到 @deepseek-ai/cordis（本探针需要一个可 import 的真库）')
  console.log('  候选路径：\n   - ' + candidates.join('\n   - '))
  process.exit(0)
}

const { Context } = await import(pathToFileURL(found).href)
const ctx = new Context()
const log = []

const disposer = ctx.effect(() => {
  log.push('cb-body')
  return () => log.push('returned-cleanup')
}, 'probe')

const immediate = log.includes('cb-body')
console.log(`cordis = ${found}`)
console.log(`调用 effect 后立即观察到的回调执行：${immediate ? '已执行（真语义：cb 立即跑）' : '未执行'}`)
console.log(`effect 返回值类型：${typeof disposer}`)

let cleanupRan = false
if (typeof disposer === 'function') {
  const r = disposer()
  if (r && typeof r.then === 'function') await r
  await new Promise((res) => setTimeout(res, 10))
  cleanupRan = log.includes('returned-cleanup')
}
console.log(`dispose 后"cb 返回的函数"被执行：${cleanupRan ? '是（返回值 = disposer）' : '否'}`)

const okAll = immediate && typeof disposer === 'function' && cleanupRan
console.log(`\n==== 语义探针：${okAll ? '符合预期（cb 立即执行 + 返回值为 disposer）' : '与预期不符——若 Cordis 升级改了语义，须复核 index.js 防重与 preview-server refcount'} ====`)
process.exit(okAll ? 0 : 1)
