#!/usr/bin/env node
/**
 * 常驻 prompt 成本探针（阶段 A 硬门槛之一："无图任务 prompt 增幅 ≤5%"）。
 *
 * 用法：
 *   node scripts/probe-prompt-cost.mjs            # 测量并**写入**基线 scripts/fixtures/prompt-cost-baseline.json
 *   node scripts/probe-prompt-cost.mjs --check     # 与基线对比；总成本增幅 > 5% ⇒ 退出码 1（阶段 B 引入 ppt_diagram 时用）
 *
 * 度量口径（**只看模型真正要读的部分**，不看执行结果文本）：
 *   ① 工具面：每个工具的 name + description + parameters schema（JSON 形态）——output 渲染器不进模型
 *   ② 技能目录：skills/<name>/SKILL.md 的 front-matter（name + description）——正文只在加载时进上下文
 *   ③ 工作流提示段：router.workflowSection(...)（仅在 workflowActive 时注入）
 *
 * token 估计采用 CJK 感知的保守口径：CJK 字符按 1 token/字，其余按 4 字节/token。
 * 这是**估算**，用途是"同一口径下的相对增幅"（正是 ≤5% 这条门槛要判的东西），不是绝对 token 数。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTools } from '../lib/tools.js'
import { workflowSection } from '../lib/router.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts', 'fixtures', 'prompt-cost-baseline.json')
const GROWTH_LIMIT = 1.05

/** CJK 感知的 token 估算（保守：CJK 每字 1 token）。 */
export function estTokens(s) {
  let cjk = 0
  for (const ch of s) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++
  const rest = s.length - cjk
  return Math.ceil(cjk + rest / 4)
}
const bytes = (s) => Buffer.byteLength(s, 'utf8')

// ① 工具面：用桩 ctx 捕获全部注册定义（registerTools 只用 effect/tools.register/get）
const captured = new Map()
const stub = {
  effect: (cb) => { cb(); return () => {} },
  tools: { register: (def) => captured.set(def.name, def) },
  get: () => undefined,
}
registerTools(stub)
// ppt_state 由 statusToolFor 单独注册（也是模型可见的常驻工具）⇒ 一并计入
try {
  const { statusToolFor } = await import('../lib/index.js')
  statusToolFor(stub, 'profile')
} catch (e) {
  console.log(`（提示：ppt_state 未能计入——${e.message}）`)
}
const tools = [...captured.values()].map((d) => {
  const text = JSON.stringify({ name: d.name, description: d.description ?? '', parameters: d.parameters ?? {} })
  return { name: d.name, chars: text.length, bytes: bytes(text), tokens: estTokens(text) }
}).sort((a, b) => b.tokens - a.tokens)

// ② 技能目录：front-matter 的 name + description
const skills = []
const skillsDir = join(ROOT, 'skills')
for (const name of readdirSync(skillsDir).sort()) {
  const f = join(skillsDir, name, 'SKILL.md')
  if (!existsSync(f)) continue
  const head = readFileSync(f, 'utf8').split(/^---\s*$/m)[1] ?? ''
  const desc = (head.match(/^description:\s*(.*)$/m)?.[1] ?? '').trim()
  const nm = (head.match(/^name:\s*(.*)$/m)?.[1] ?? name).trim()
  const text = `${nm}\n${desc}`
  skills.push({ name: nm, chars: text.length, bytes: bytes(text), tokens: estTokens(text) })
}
skills.sort((a, b) => b.tokens - a.tokens)

// ③ 工作流提示段（仅有 workflowActive 时注入；两种档都要测——quick 档另有字节不变守卫）
//    注意：workflowSection 返回 **{name, text}** 而不是字符串；cfg 需要 engine/mode/fidelity/quality/review/pauseAfter 等字段。
const WF_CFG = { mode: 'normal', engine: 'auto', fidelity: 'balanced', quality: 'standard', review: 'full', pauseAfter: [] }
function measureWorkflow(cfg) {
  try {
    const r = workflowSection('make', cfg)
    const text = typeof r === 'string' ? r : (r?.text ?? '')
    return text ? { tokens: estTokens(text), chars: text.length } : { tokens: 0, chars: 0 }
  } catch (e) {
    return { tokens: 0, chars: 0, error: e.message }
  }
}
const wfStd = measureWorkflow(WF_CFG)
const wfQuick = measureWorkflow({ ...WF_CFG, quick: true })
let wf = { tokens: wfStd.tokens, chars: wfStd.chars, quickTokens: wfQuick.tokens, quickChars: wfQuick.chars, note: wfStd.error ?? '' }

const sum = (list) => list.reduce((n, x) => n + x.tokens, 0)
const totals = {
  tools: sum(tools),
  skills: sum(skills),
  workflow: wf.tokens,
  all: sum(tools) + sum(skills) + wf.tokens,
}
const report = {
  measuredAt: new Date().toISOString().slice(0, 10),
  estimator: 'CJK=1 token/字；其余=4 字节/token',
  toolCount: tools.length,
  tools,
  skills,
  workflow: wf,
  totals,
}

const check = process.argv.includes('--check')
let fail = 0
console.log('==== 常驻 prompt 成本（模型要读的部分）====')
console.log(`工具面：${tools.length} 个工具 = ${totals.tools} tokens（前 5：${tools.slice(0, 5).map((t) => `${t.name} ${t.tokens}`).join('｜')}）`)
console.log(`技能目录：${skills.length} 个 = ${totals.skills} tokens（${skills.map((s) => `${s.name.replace('ppt-studio-', '')} ${s.tokens}`).join('｜')}）`)
console.log(`工作流段：${totals.workflow} tokens${wf.note ? `（${wf.note}）` : ''}`)
console.log(`合计（不含工作流段，即"无图任务"的常驻面）：${totals.tools + totals.skills} tokens；含工作流段 ${totals.all} tokens`)

if (check) {
  if (!existsSync(BASELINE)) { console.log(`\n✗ 基线不存在（${BASELINE}）——先不带 --check 跑一次生成基线`); process.exit(1) }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const baseResident = base.totals.tools + base.totals.skills
  const nowResident = totals.tools + totals.skills
  const growth = nowResident / baseResident
  const okAll = totals.all <= base.totals.all * GROWTH_LIMIT
  const okResident = nowResident <= baseResident * GROWTH_LIMIT
  console.log(`\n基线（${base.measuredAt}）：常驻 ${baseResident} / 含工作流 ${base.totals.all}`)
  console.log(`${okResident ? '✓' : '✗'} 常驻面增幅 ${((growth - 1) * 100).toFixed(2)}%（上限 +5%）`)
  console.log(`${okAll ? '✓' : '✗'} 含工作流段增幅 ${(((totals.all / base.totals.all) - 1) * 100).toFixed(2)}%（上限 +5%）`)
  if (!okResident || !okAll) fail = 1
} else {
  writeFileSync(BASELINE, JSON.stringify(report, null, 2) + '\n')
  console.log(`\n✓ 基线已写入 ${BASELINE.replace(ROOT + '\\', '')}`)
}
if (fail) { console.log('\n✗ 常驻 prompt 成本超出门槛'); process.exit(1) }
