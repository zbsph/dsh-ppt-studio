#!/usr/bin/env node
/**
 * lib ⟷ src 一致性守卫。
 * 为什么必须有：`package.json` 的 files 白名单**只发 lib**（main = ./lib/index.js），且没有 prepack 钩子
 * ⇒ 一旦 lib 与 src 不同步（漏 build / 半途改 src），**装出来的包就是错的**。
 * 判据：文件集合相同 + 逐字节相同。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const walk = (base) => {
  const out = []
  const rec = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) rec(join(dir, e.name), r)
      else out.push(r)
    }
  }
  rec(join(ROOT, base), '')
  return out.sort()
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const a = walk('src'), b = walk('lib')
const onlySrc = a.filter((f) => !b.includes(f))
const onlyLib = b.filter((f) => !a.includes(f))
const differ = a.filter((f) => b.includes(f) && sha(join(ROOT, 'src', f)) !== sha(join(ROOT, 'lib', f)))
console.log('lib ⟷ src：src ' + a.length + ' 个 / lib ' + b.length + ' 个｜仅 src ' + onlySrc.length + '｜仅 lib ' + onlyLib.length + '｜字节不同 ' + differ.length)
for (const f of [...onlySrc.map((x) => '仅 src: ' + x), ...onlyLib.map((x) => '仅 lib: ' + x), ...differ.map((x) => '字节不同: ' + x)].slice(0, 12)) console.log('   · ' + f)
if (onlySrc.length || onlyLib.length || differ.length) { console.log('✗ lib 与 src 不一致 ⇒ 先跑 node scripts/build.mjs 并提交（files 只发 lib，装出来会是错的）'); process.exit(1) }
console.log('✓ lib 与 src 完全一致（files 只发 lib ⇒ 这一步守住"装出来等于仓库"）')
