/**
 * 生成"工作流提示词基线"快照（用于「老用户不受影响」的可验证断言）。
 *
 * 为什么需要：用户反复强调"老用户更新后不能发现自己用不惯了"。所以每轮改动工作流段时，
 * 必须有机器断言证明：**新段 ⊇ 旧段**（逐行超集）——只允许新增行，不允许改写/删除旧行。
 * 本脚本在改动前跑一次，把当轮基线落到 scripts/fixtures/workflow-baseline.json。
 *
 * 用法：node scripts/dump-workflow-baseline.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workflowSection } from '../src/router.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const variants = []
for (const quick of [false, true]) {
  for (const taskType of ['from-scratch', 'augment', 'edit', 'summarize', 'unknown']) {
    const cfg = {
      quick,
      mode: 'auto',
      fidelity: 'auto',
      review: 'points',
      quality: 'standard',
      engine: 'auto',
      template: null,
      pauseAfter: [],
      workflowActive: true,
    }
    const sec = workflowSection(taskType, cfg)
    variants.push({ quick, taskType, name: sec.name, lines: sec.text.split('\n') })
  }
}
const out = join(root, 'scripts', 'fixtures', 'workflow-baseline.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ note: '工作流提示词基线：新段必须是逐行超集（只增不改不删）', variants }, null, 2) + '\n', 'utf8')
const total = variants.reduce((n, v) => n + v.lines.length, 0)
console.log(`baseline 写入 ${out}：${variants.length} 个变体 / ${total} 行`)
