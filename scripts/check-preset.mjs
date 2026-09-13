#!/usr/bin/env node
/**
 * check-preset.mjs —— 预设自检（DSH 升级后必跑）
 *
 * 背景（2026-09-12 真实故障）：本预设是**随包 standard 预设的全量副本 + 插件行**。
 * DSH 0.1.5-rc.2 把 `@deepseek-ai/dsh-persona` 的配置从单一 `text` 改成 `prefix`(required)+`suffix`，
 * 随包 standard 跟着改了，我们的副本没跟着改 → 一切到「PPT 工作室」就报
 *   failed to apply loader entry persona: invalid config: - $.prefix missing required value
 * 而单测/契约核对都发现不了——因为坏的是**预设行配置**，不是插件代码。
 *
 * 本脚本逐行比对"我们的预设"与"随包 standard 预设"：
 *   - 两边都有、但 config 不一致 → FAIL（就是本轮这类漂移）
 *   - 只存在于随包 standard 的行 → WARN（我们可能漏了新版新增行）
 *   - 只存在于我们的行 → INFO（插件行/注释，预期）
 * 找不到 DSH 安装时跳过（不阻断，仅提示）。
 *
 * 用法：node scripts/check-preset.mjs [--preset <文件>] [--verbose]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import YAML from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const oursPath = opt('--preset', join(root, 'agent-presets', 'ppt', 'agent.cordis.yml'))
const verbose = args.includes('--verbose')

/** 候选路径：DSH_CHECKOUT → npm 全局 → DSH_HOME/profiles/<profile>/node_modules。 */
function findShippedStandard() {
  const rel = join('node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml')
  const candidates = []
  if (process.env.DSH_CHECKOUT) candidates.push(join(process.env.DSH_CHECKOUT, rel))
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (globalRoot) candidates.push(join(globalRoot, '@deepseek-ai', 'dsh', rel))
  } catch { /* npm 不可用则跳过 */ }
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  for (const profile of ['web', 'headless', 'tui']) {
    candidates.push(join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'))
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

const rowsOf = (file) => {
  const doc = YAML.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(doc)) throw new Error(`${file} 不是 loader 方言的条目数组`)
  return doc.filter((r) => r && typeof r === 'object' && typeof r.id === 'string')
}
const norm = (v) => JSON.stringify(v ?? null)

const stdPath = findShippedStandard()
if (stdPath === null) {
  console.log('⚠ 未找到随包 standard 预设（没装 DSH / 未设 DSH_CHECKOUT）——跳过预设比对')
  process.exit(0)
}
if (!existsSync(oursPath)) {
  console.error(`✗ 找不到本预设：${oursPath}`)
  process.exit(1)
}

const std = new Map(rowsOf(stdPath).map((r) => [r.id, r]))
const ours = new Map(rowsOf(oursPath).map((r) => [r.id, r]))

console.log(`本预设：${oursPath}`)
console.log(`参照：  ${stdPath}\n`)

let fail = 0
let warn = 0
for (const [id, r] of ours) {
  const s = std.get(id)
  if (s === undefined) {
    console.log(`  · [本预设新增] ${id}（${r.name ?? '—'}）`)
    continue
  }
  if (norm(r.config) !== norm(s.config)) {
    fail++
    console.log(`  ✗ [配置漂移] ${id}（${r.name ?? '—'}）`)
    console.log(`      随包 standard: ${norm(s.config)}`)
    console.log(`      本预设:        ${norm(r.config)}`)
  } else if (verbose) {
    console.log(`  ✓ ${id}`)
  }
}
for (const [id, s] of std) {
  if (!ours.has(id)) {
    warn++
    console.log(`  ⚠ [随包含有、本预设缺少] ${id}（${s.name ?? '—'}）——新版新增行？确认是否要补`)
  }
}

console.log(`\n==== 预设自检：漂移 ${fail} / 缺行 ${warn} ====`)
if (fail > 0) {
  console.log('修复方式：把漂移行的 config 改成随包 standard 的形状（预设是它的全量副本），再 npm pack 发版。')
}
process.exit(fail > 0 ? 1 : 0)
