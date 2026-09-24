#!/usr/bin/env node
/**
 * check-preset.mjs —— 预设自检（DSH 升级后必跑）
 *
 * 背景（2026-09-12 真实故障）：本预设是**随包 standard 预设的全量副本 + 本插件的人格**。
 * DSH 0.1.5-rc.2 把 `@deepseek-ai/dsh-persona` 的配置从单一 `text` 改成 `prefix`(required)+`suffix`，
 * 随包 standard 跟着改了，我们的副本没跟着改 → 一切到「PPT 工作室」就报
 *   failed to apply loader entry persona: invalid config: - $.prefix missing required value
 * 而单测/契约核对都发现不了——因为坏的是**预设行配置**，不是插件代码。
 *
 * 本脚本逐行比对"我们的预设"与"随包 standard 预设"：
 *   - 两边都有、但 config 不一致 → FAIL（就是本轮这类漂移）
 *   - 只存在于随包 standard 的行 → WARN（我们可能漏了新版新增行）
 *   - 只存在于我们的行 → INFO（预期：人格那一行是有意差异）
 *
 * ── 2026-09-24 适配 DSH 0.1.7-rc.1：**参照物的位置和格式都变了** ────────────────────
 *   0.1.6-：`@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml`
 *           —— 一份 Loader 方言的**条目数组**（`dsh-agent-presets` 目录发现时代的随包预设）。
 *   0.1.7+：`@deepseek-ai/dsh-web-app/presets/standard.patch.yml`
 *           —— 一份 **patch 列表**，里面 `- insert:` 一行 `@deepseek-ai/dsh-agent-preset`，
 *              预设的行藏在 `config.plugins` 里（`dsh-agent-presets` 复数包已被
 *              `dsh-agent-preset` + `dsh-agent-preset-registry` 取代，旧路径不存在了）。
 *   两种都认（老宿主上跑也不瞎），但**认到哪种会在输出里写明**。
 *
 * 找不到参照物时**不再静默跳过**：打印醒目 ⚠ 并给出"这条门禁本轮没生效"的结论；
 * 加 `--require` 时直接 FAIL（发布/干净安装门禁用它——静默跳过正是 2026-09-24 那次
 * "npm test 250/0 假绿"的成因：整套 DSH 相关检查都在跳过）。
 *
 * `--ref <文件>` 可**钉住参照物**（自动识别新旧格式）：本机装了 DSH 时无法制造"找不到参照"的
 * 场景，测试要靠它；CI 也可用它固定一份参照做回归。
 *
 * 用法：node scripts/check-preset.mjs [--preset <文件>] [--ref <文件>] [--verbose] [--require]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
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
const requireRef = args.includes('--require')
/** `--ref <文件>`：钉住参照物（自动识别新旧格式）。本机装了 DSH 时无法制造"找不到参照"的场景，测试靠它。 */
const refPin = opt('--ref', null) === null ? null : resolve(opt('--ref'))

/** 参照物的相对路径（相对 DSH 安装根）：新格式与旧格式各一条。 */
const REF_MODERN = join('node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
const REF_LEGACY = join('node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml')

/** DSH 安装根候选：DSH_CHECKOUT → npm 全局 → DSH_HOME/profiles/<profile>/。 */
function installRoots() {
  const roots = []
  if (process.env.DSH_CHECKOUT) roots.push(process.env.DSH_CHECKOUT)
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (globalRoot) roots.push(join(globalRoot, '@deepseek-ai', 'dsh'), globalRoot)
  } catch { /* npm 不可用则跳过 */ }
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  for (const profile of ['web', 'headless', 'tui']) roots.push(join(dshHome, 'profiles', profile))
  return roots
}

/** 定位随包 standard 预设：返回 {path, kind:'modern'|'legacy'} 或 null。 */
function findShippedStandard() {
  const roots = installRoots()
  for (const [rel, kind] of [[REF_MODERN, 'modern'], [REF_LEGACY, 'legacy']]) {
    for (const base of roots) {
      const p = join(base, rel)
      if (existsSync(p)) return { path: p, kind }
    }
  }
  return null
}

/** 按文档形状自动识别格式：条目数组 ⇒ legacy；patch 列表（含 insert）⇒ modern。 */
function detectKind(file) {
  const doc = YAML.parse(readFileSync(file, 'utf8'))
  if (Array.isArray(doc) && doc.every((r) => r && typeof r === 'object' && typeof r.id === 'string')) return 'legacy'
  return 'modern'
}

/** 取 Loader **方言**的条目数组：两种参照格式都归一到这里（`!!js` 只当数据，不比对求值）。 */
const rowsOf = (file, kind) => {
  const doc = YAML.parse(readFileSync(file, 'utf8'))
  if (kind === 'legacy') {
    if (!Array.isArray(doc)) throw new Error(`${file} 不是 loader 方言的条目数组`)
    return doc.filter((r) => r && typeof r === 'object' && typeof r.id === 'string')
  }
  // modern：patch 列表 → insert 项 → 声明行 → config.plugins
  const list = Array.isArray(doc) ? doc : [doc]
  for (const patch of list) {
    const inserts = Array.isArray(patch?.insert) ? patch.insert : []
    for (const row of inserts) {
      const rows = row?.config?.plugins
      if (Array.isArray(rows)) return rows.filter((r) => r && typeof r === 'object' && typeof r.id === 'string')
    }
  }
  throw new Error(`${file} 里没有找到 \`- insert:\` 的 preset 声明（config.plugins）——上游格式又变了？`)
}
const norm = (v) => JSON.stringify(v ?? null)

const ref = refPin !== null
  ? (existsSync(refPin) ? { path: refPin, kind: detectKind(refPin) } : null)
  : findShippedStandard()
if (ref === null && !existsSync(oursPath)) {
  console.error(`✗ 找不到本预设：${oursPath}`)
  process.exit(1)
}
if (ref === null) {
  console.log('⚠ 未找到随包 standard 预设 —— **预设漂移门禁本轮没有生效**')
  if (refPin !== null) console.log(`  你钉的参照物不存在：${refPin}`)
  else {
    console.log('  查过这些位置（相对 DSH 安装根）：')
    for (const base of installRoots()) {
      console.log(`    · ${join(base, REF_MODERN)}`)
      console.log(`    · ${join(base, REF_LEGACY)}`)
    }
    console.log('  修法：装好 DSH 再跑，或显式给 DSH_CHECKOUT=<DSH 安装根> / --ref <参照文件>。')
  }
  process.exit(requireRef ? 1 : 0)
}

const std = new Map(rowsOf(ref.path, ref.kind).map((r) => [r.id, r]))
const ours = new Map(rowsOf(oursPath, 'legacy').map((r) => [r.id, r]))

/**
 * **声明过的有意差异**：本预设故意与随包 standard 不同的行（其余仍必须逐行一致——那才是防无意漂移）。
 *
 * 为什么需要这个白名单（2026-09-18 用户提问："我们的预设和标准模式有啥区别？"）：
 * 本预设原来是 standard 的**逐行副本**，连 persona 都是通用编码人格
 * ⇒ 它在界面上只是"改了名字的 standard"，没有任何身份。而"人格"正是预设**唯一**还能可靠交付的东西
 * （工具/技能按预设隔离在这版 DSH 上做不到：切换预设时 agent 已存在 ⇒ `agent/created` 钩子不触发；
 * 技能注册表在父层读 ⇒ 子层注册看不见。见 docs/03 最新条目）。
 * 所以：只允许这一行有意不同，且必须在这里写明理由——新增第二处差异会被门禁拦下。
 */
const INTENTIONAL = new Map([
  ['persona', '「PPT 工作室」的人格：把开工状态定成"演示文稿工程"（先定纲再排版、每页一个论点、数字要口径、导出前过门禁）——预设唯一的身份差异'],
])

console.log(`本预设：${oursPath}`)
console.log(`参照：  ${ref.path}`)
console.log(`格式：  ${ref.kind === 'modern' ? '0.1.7+（dsh-web-app patch 的 config.plugins）' : '0.1.6-（dsh-agent-presets 条目数组）'}\n`)

let fail = 0
let warn = 0
let intentional = 0
for (const [id, r] of ours) {
  const s = std.get(id)
  if (s === undefined) {
    console.log(`  · [本预设新增] ${id}（${r.name ?? '—'}）`)
    continue
  }
  if (norm(r.config) !== norm(s.config)) {
    if (INTENTIONAL.has(id)) {
      intentional++
      console.log(`  ◆ [有意差异] ${id}（${r.name ?? '—'}）— ${INTENTIONAL.get(id)}`)
      if (verbose) {
        console.log(`      随包 standard: ${norm(s.config)}`)
        console.log(`      本预设:        ${norm(r.config)}`)
      }
      continue
    }
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

console.log(`\n==== 预设自检：漂移 ${fail} / 缺行 ${warn} / 有意差异 ${intentional}（参照格式 ${ref.kind}） ====`)
if (fail > 0) {
  console.log('修复方式：把漂移行的 config 改成随包 standard 的形状（预设是它的全量副本），再 npm pack 发版；')
  console.log('若这是**有意**差异，请加进本脚本顶部的 INTENTIONAL 白名单并写明理由（否则它会在下次升级时被当成漂移）。')
}
process.exit(fail > 0 ? 1 : 0)
