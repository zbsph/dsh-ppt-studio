#!/usr/bin/env node
/**
 * prepack 清理：把**打包白名单目录内的生成物**删掉，保证 `npm pack` 的 tgz 可复现。
 *
 * 为什么需要（2026-10-23 1.2.6 实测）：`files` 白名单包含 `templates/`，而模板物化会在
 * `templates/<id>/preview/` 下生成 HTML/layout.json；npm 对 files 白名单内的目录**不应用**
 * `.gitignore` 排除规则 ⇒ 跑过测试后打包会多出 16 个生成文件（1.2.5 的 tgz 253 文件 → 1.2.6
 * 变成 268），同一 tag 两次打包字节不同、发布物取决于"打包前跑没跑测试"。
 *
 * 本脚本只删**已知生成物**（与 .gitignore 同一份清单里属于打包根的那些），且**绝不删 git 跟踪的文件**
 * （2026-10-23 教训：examples/smoke/preview 等目录里既有历史跟踪的示例产物、也有生成物；
 * 第一版直接 rm -rf 把跟踪文件也删了，靠 git restore 救回）。由 package.json 的 `prepack` 自动执行。
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const removed = []
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

// git 跟踪清单（相对 root，统一 / 分隔）——用于"只删未跟踪生成物"的硬保护
let tracked = new Set()
try {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
  tracked = new Set(out.split('\0').filter(Boolean))
} catch { /* 非 git 环境：退化为按名单删（此时通常是发布机，风险可接受） */ }
const rel = (p) => p.slice(root.length + 1).replace(/\\/g, '/')
const hasTrackedUnder = (dirRel) => {
  for (const f of tracked) if (f === dirRel || f.startsWith(dirRel + '/')) return true
  return false
}
const rmrf = (p) => {
  const r = rel(p)
  if (tracked.has(r)) return // 单文件：跟踪就不动
  if (hasTrackedUnder(r)) return // 目录里含跟踪文件：不动（宁可漏清，不可误删）
  try { rmSync(p, { recursive: true, force: true }); removed.push(r) } catch { /* 忽略 */ }
}

// templates/<id>/ 下的生成物；以及 smoke 造的临时模板（整个目录）
const TEMPLATES = join(root, 'templates')
for (const name of readdirSync(TEMPLATES)) {
  const dir = join(TEMPLATES, name)
  if (/^smoke-/.test(name)) { rmrf(dir); continue }
  if (!isDir(dir)) continue
  for (const sub of readdirSync(dir)) {
    if (['preview', 'previews', '_cleanup-tmp'].includes(sub) && isDir(join(dir, sub))) rmrf(join(dir, sub))
  }
}

// examples/smoke：只保留手写源 yaml/媒体；删生成物（跟踪的示例产物由上面的保护跳过）
const SMOKE = join(root, 'examples', 'smoke')
if (isDir(SMOKE)) {
  for (const name of readdirSync(SMOKE)) {
    if (['preview', 'preview-rt', 'imported', '.tmp-home'].includes(name)) rmrf(join(SMOKE, name))
    else if (/^\.tmp-/.test(name)) rmrf(join(SMOKE, name))
    else if (/^out-.*\.pptx$/.test(name) || name === 'media-test.png') rmrf(join(SMOKE, name))
  }
}

// examples/fx：删 *.pptx / ren-* / reimport / */preview / .tmp-*
const FX = join(root, 'examples', 'fx')
if (isDir(FX)) {
  for (const name of readdirSync(FX)) {
    const p = join(FX, name)
    if (/\.pptx$/i.test(name) || /^ren-/.test(name) || name === 'reimport' || /^\.tmp-/.test(name)) { rmrf(p); continue }
    if (!isDir(p)) continue
    for (const sub of readdirSync(p)) if (sub === 'preview' && isDir(join(p, sub))) rmrf(join(p, sub))
  }
}

console.log(`prepack: 已清理 ${removed.length} 个打包目录内生成物${removed.length ? '（如 ' + removed.slice(0, 3).join('、') + '）' : ''}`)
