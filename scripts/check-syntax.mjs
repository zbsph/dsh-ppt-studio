#!/usr/bin/env node
/**
 * 语法体检（廉价跨切面守卫）：`node scripts/check-syntax.mjs`
 *
 * 为什么单列一条：本会话在 `SCHEMA_REF`（模板字符串）里写**行内反引号**踩了四次——
 * 每次都是"文件直接解析失败 ⇒ 全链路崩"，但只看 exit code 容易漏读报错内容。
 * 这条守卫把"所有源文件至少能解析"变成 1–2 秒内可得的确定结论。
 *
 * 覆盖：`src/**\/*.js`、`lib/**\/*.js`、`scripts/*.mjs`（跳过 node_modules 与临时目录）。
 */
import { readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = join(import.meta.dirname, '..')

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (['.js', '.mjs'].includes(extname(name))) out.push(p)
  }
  return out
}

const files = [...walk(join(root, 'src')), ...walk(join(root, 'lib')), ...walk(join(root, 'scripts'))]
const bad = []
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    const msg = String(e.stderr ?? e.message ?? '').split('\n').filter((l) => l.trim()).slice(0, 3).join(' / ')
    bad.push(`${relative(root, f)}: ${msg.slice(0, 200)}`)
  }
}
if (bad.length) {
  console.log(`✗ 语法体检：${bad.length} 个文件解析失败`)
  for (const b of bad) console.log(`  · ${b}`)
  console.log('  提示：模板字符串里出现行内反引号是历史高频坑（SCHEMA_REF 等长文本块）。')
  process.exit(1)
}
console.log(`✓ 语法体检：${files.length} 个源文件全部通过 node --check`)
