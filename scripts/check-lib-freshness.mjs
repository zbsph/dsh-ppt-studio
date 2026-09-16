#!/usr/bin/env node
/**
 * check-lib-freshness —— 守卫「提交的 lib/ 与 src/ 一致」。
 *
 * 为什么要这条守卫（2026-09-16）：
 *   `lib/` 从这一版起**提交进 git**，因为 `dsh plugin --profile web add <本仓库 git URL>`
 *   只能拿到 git 里已提交的内容，而 package.json 的 exports 指向 ./lib/index.js。
 *   lib/ 不提交时，git 安装出来的包缺入口文件、插件挂不上（实测：装到的包没有 lib/）。
 *   代价是"改了 src 忘了 build + commit lib"会静默发出旧代码——本脚本把这条钉死。
 *
 * 用法：node scripts/check-lib-freshness.mjs   （smoke 内也有一条同义断言）
 * 退出码：0 = 逐字节一致；1 = 有缺、有多、或内容不一致（打印前若干条差异）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 递归列出目录下所有文件的相对路径（POSIX 分隔符，便于比较）。 */
function walk(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) out.push(relative(dir, full).split('\\').join('/'))
    }
  }
  return out.sort()
}

const libDir = join(root, 'lib')
const srcDir = join(root, 'src')

let libFiles
let srcFiles
try {
  libFiles = walk(libDir)
} catch {
  console.error('check-lib-freshness: lib/ 不存在——先跑 `node scripts/build.mjs`（lib/ 必须提交，见 .gitignore 注释）')
  process.exit(1)
}
try {
  srcFiles = walk(srcDir)
} catch {
  console.error('check-lib-freshness: src/ 不存在')
  process.exit(1)
}

const libSet = new Set(libFiles)
const srcSet = new Set(srcFiles)
const missing = srcFiles.filter((f) => !libSet.has(f)) // src 有、lib 没有（漏 build）
const extra = libFiles.filter((f) => !srcSet.has(f))   // lib 有、src 没有（残留/陈旧）
const changed = srcFiles.filter((f) => libSet.has(f) && !readFileSync(join(srcDir, f)).equals(readFileSync(join(libDir, f))))

const detail = []
if (missing.length) detail.push(`lib 缺 ${missing.length} 个：${missing.slice(0, 5).join('、')}`)
if (extra.length) detail.push(`lib 多 ${extra.length} 个：${extra.slice(0, 5).join('、')}`)
if (changed.length) detail.push(`内容不一致 ${changed.length} 个：${changed.slice(0, 5).join('、')}`)

if (detail.length) {
  console.error(`check-lib-freshness: ✗ 提交的 lib/ 与 src/ 不一致——请跑 \`node scripts/build.mjs\` 并提交 lib/\n  ${detail.join('\n  ')}`)
  process.exit(1)
}

const bytes = libFiles.reduce((sum, f) => sum + statSync(join(libDir, f)).size, 0)
console.log(`check-lib-freshness: ✓ lib/ 与 src/ 逐字节一致（${libFiles.length} 个文件 / ${(bytes / 1024).toFixed(0)}KB）`)
