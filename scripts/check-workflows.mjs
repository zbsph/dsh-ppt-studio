#!/usr/bin/env node
/**
 * .github/workflows 语法守卫（无网络、秒级）。
 *
 * 为什么需要：2026-10-17 我在 dsh-next-probe.yml 里写了 `- name: Probe: xxx`（纯量里的 `: `），
 * GitHub 判定工作流文件无效 ⇒ 显示为"文件路径"的失败运行 + "No jobs were run" 邮件。
 * 这种错误**本地可查**，不该等到 push 之后由邮件告知。
 *
 * 校验：① YAML 可解析；② 顶层有 name / on / jobs；③ 每个 job 有 runs-on 与 steps；
 *       ④ 每个 step 有 uses 或 run；⑤ 所有 name 是字符串（含 `: ` 的纯量会被 YAML 解析器先抓住）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, '.github', 'workflows')
const fail = []
let files = []
try { files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)) } catch { fail.push(`找不到目录 ${DIR}`) }

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
for (const f of files) {
  const rel = `.github/workflows/${f}`
  let doc
  try { doc = YAML.parse(readFileSync(join(DIR, f), 'utf8')) } catch (e) { fail.push(`${rel}: YAML 解析失败 — ${e.message.split('\n')[0]}`); continue }
  if (!isPlainObject(doc)) { fail.push(`${rel}: 顶层不是映射`); continue }
  for (const k of ['name', 'on', 'jobs']) if (!(k in doc)) fail.push(`${rel}: 缺少顶层键 ${k}`)
  if (typeof doc.name !== 'string' || !doc.name.trim()) fail.push(`${rel}: name 必须是非空字符串`)
  if (!isPlainObject(doc.jobs) || Object.keys(doc.jobs).length === 0) fail.push(`${rel}: jobs 必须是非空映射`)
  for (const [jid, job] of Object.entries(doc.jobs ?? {})) {
    if (!isPlainObject(job)) { fail.push(`${rel}: jobs.${jid} 不是映射`); continue }
    if (!('runs-on' in job) && !('uses' in job)) fail.push(`${rel}: jobs.${jid} 缺少 runs-on / uses`)
    if ('uses' in job) continue
    if (!Array.isArray(job.steps) || job.steps.length === 0) fail.push(`${rel}: jobs.${jid} 缺少 steps`)
    for (const [i, st] of (job.steps ?? []).entries()) {
      if (!isPlainObject(st)) { fail.push(`${rel}: jobs.${jid}.steps[${i}] 不是映射`); continue }
      if (!('uses' in st) && !('run' in st)) fail.push(`${rel}: jobs.${jid}.steps[${i}] 既无 uses 也无 run`)
      if ('name' in st && typeof st.name !== 'string') fail.push(`${rel}: jobs.${jid}.steps[${i}].name 不是字符串`)
    }
  }
}

if (fail.length) {
  console.error('✗ 工作流语法检查：失败')
  for (const f of fail) console.error('  · ' + f)
  process.exit(1)
}
console.log(`✓ 工作流语法：${files.length} 个文件全部可解析且结构合规`)
