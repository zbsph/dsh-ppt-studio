#!/usr/bin/env node
/**
 * 生成器检查网：`examples/hand-drawn/gen/*.cjs` 全部过 `node --check`。
 *
 * 为什么需要：生成器**不在** `npm test` 网内 ⇒ 一个语法/TDZ 级错误（实测：参数化时写成
 * `… || PPTX` 自引用 ⇒ 缺省路径必崩）能躲过所有测试，直到某次真跑才炸。
 * 这里只做静态检查（快、无副作用）；缺省路径的**运行时**检查由 `verify:handdrawn` 等覆盖。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const DIR = join(ROOT, 'examples', 'hand-drawn', 'gen')
const files = readdirSync(DIR).filter((f) => f.endsWith('.cjs')).sort()
let bad = 0
for (const f of files) {
  try { execFileSync('node', ['--check', join(DIR, f)], { stdio: 'pipe' }) }
  catch (e) { bad++; console.log('  ✗ 语法错误：' + f + '\n' + String(e.stderr ?? '').split('\n').slice(0, 4).join('\n')) }
}
console.log('生成器检查网：' + files.length + ' 个脚本｜语法错 ' + bad + ' 个' + (bad === 0 ? ' ✓' : ''))
process.exit(bad === 0 ? 0 : 1)
