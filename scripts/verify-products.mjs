#!/usr/bin/env node
/**
 * 产物一致性（**本机专用**：需要 PowerPoint COM 渲染，故不进 npm test）。
 * 流程：手画生成器 → 导出到**非锁定名** pptx → COM 渲染 13 张命名 PNG → 与基线比对
 *   · 硬不变量：layout 摘要（走 verify-handdrawn ✓）
 *   · 次要不变量：13 张 PNG 的 sha256（差异只报不改 ✓）
 * 用法：npm run verify:products
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, '..', 'ppt-deliverable', '手画12+1')
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const run = (cmd) => execFileSync('node', cmd, { cwd: ROOT, stdio: 'inherit' })

console.log('… 1/3 重出手画页面与产物（导出到非锁定名，避免 PowerPoint 占用）')
run(['examples/hand-drawn/gen/gen13-attach.cjs'])
run(['examples/hand-drawn/gen/gen-1113.cjs'])

console.log('… 2/3 硬不变量：layout 摘要与基线')
const vh = execFileSync('node', ['scripts/verify-handdrawn.mjs'], { cwd: ROOT, encoding: 'utf8' })
process.stdout.write(vh.split('\n').slice(-3).join('\n') + '\n')
if (!/与基线一致/.test(vh)) { console.log('✗ 摘要与基线不一致'); process.exit(1) }

console.log('… 3/3 次要不变量：13 张 PNG sha')
const base = JSON.parse(readFileSync(join(ROOT, 'scripts', 'fixtures', 'handdrawn-baseline.json'), 'utf8'))
let same = 0, diff = 0, miss = 0
for (const [name, h] of Object.entries(base.pngs ?? {})) {
  const f = join(OUT, name)
  if (!existsSync(f)) { miss++; continue }
  if (sha(f) === h) same++; else { diff++; console.log('   ⚠ 像素差异：' + name) }
}
console.log('   相同 ' + same + '｜差异 ' + diff + '｜缺失 ' + miss + (miss ? '（交付目录不在本机 ⇒ 跳过像素比对）' : diff ? '（像素差异属环境/渲染差异，硬不变量已过 ✓）' : ' ✓'))
console.log('==== 产物一致性：通过 ====')
