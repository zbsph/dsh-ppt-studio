#!/usr/bin/env node
/**
 * 打包与安装一致性（P3）。本机专用，不进 npm test（要 npm pack + 真实安装）。
 * ① npm pack 出 tarball ⇒ 断言必含发行所需目录/文件；
 * ② 装到干净临时目录 ⇒ require 入口可用；
 * ③ 扫描装出的树 ⇒ 不得含已移除方案痕迹；手画回归语料不入包。
 * 注：Windows 上 npm/tar 是垫片 ⇒ 一律 execSync（shell），不用 execFileSync('npm')（会 ENOENT）。
 */
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, statSync, mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const tmp = mkdtempSync(join(tmpdir(), 'pptd-pkg-'))
const MUST = ['package/package.json', 'package/README.md', 'package/cordis.patch.yml']
const MUSTDIR = ['package/lib', 'package/skills', 'package/agent-presets', 'package/docs', 'package/templates']
const TERM = /图族|diagram-families|diagram-ir|FAMILIES|d1_|diagram:|diagram\.style|layoutDiagram|validateDiagram|图编译/

console.log('… ① npm pack')
const out = execSync('npm pack --pack-destination "' + tmp + '"', { cwd: ROOT, encoding: 'utf8' }).trim()
const tgz = join(tmp, out.split('\n').pop().trim())
console.log('   ' + tgz.split(/[\\/]/).pop() + '（' + Math.round(statSync(tgz).size / 1024) + ' KB）')
const list = execSync('tar -tzf "' + tgz + '"', { encoding: 'utf8' }).replace(/\r/g, '').split('\n').filter(Boolean)
let bad = 0
for (const m of MUST) if (!list.includes(m)) { console.log('   ✗ 缺 ' + m); bad++ }
for (const d of MUSTDIR) if (!list.some((l) => l.startsWith(d + '/'))) { console.log('   ✗ 缺目录 ' + d); bad++ }
if (list.some((l) => l.startsWith('package/examples/hand-drawn'))) { console.log('   ✗ 手画回归语料竟被打包'); bad++ }
if (list.some((l) => l.startsWith('package/src/'))) { console.log('   ✗ src 被打包（应只发 lib）'); bad++ }
console.log('   包内文件 ' + list.length + ' 个｜必需项 ' + (bad ? '✗ ' + bad + ' 项不符' : '✓ 全部存在'))
if (bad) process.exit(1)

console.log('… ② 装到干净临时目录并 require 入口')
const inst = join(tmp, 'inst')
execSync('mkdir "' + inst + '"', { shell: 'cmd.exe' })
writeFileSync(join(inst, 'package.json'), '{"name":"pkgtest","private":true}\n')
execSync('npm install --no-save --silent "' + tgz + '"', { cwd: inst, stdio: 'inherit' })
const entry = join(inst, 'node_modules', 'dsh-ppt-studio', 'lib', 'index.js')
if (!existsSync(entry)) { console.log('   ✗ 入口不存在：' + entry); process.exit(1) }
const keys = execSync('node -e "const m=require(process.argv[1]);console.log(Object.keys(m).join(String.fromCharCode(32)))" "' + entry + '"', { encoding: 'utf8' }).trim()
const kn = keys ? keys.split(/\s+/).length : 0
console.log('   ✓ require 可用，导出 ' + kn + ' 项：' + (keys ? keys.split(/\s+/).slice(0, 10).join(' ') : '') + (kn > 10 ? ' …' : ''))

console.log('… ③ 装出的树里不得含已移除方案的痕迹')
const hits = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (/\.(png|jpg|pptx|tgz|zip)$/.test(e.name)) continue
    if (e.name === 'check-package.mjs' || e.name === 'check-removed-traces.mjs') continue // 本文件自带该词表(检查器自指), 不算痕迹
    if (e.isDirectory()) walk(p)
    else if (/\.(js|mjs|cjs|md|ya?ml|json|txt)$/.test(e.name)) {
      readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (TERM.test(l)) hits.push(p.replace(inst + '/', '') + ':' + (i + 1)) })
    }
  }
}
walk(join(inst, 'node_modules', 'dsh-ppt-studio'))
console.log('   命中 ' + hits.length + ' 处' + (hits.length ? '（' + hits.slice(0, 5).join(', ') + '）' : ' ✓'))
if (hits.length) process.exit(1)
console.log('==== 打包与安装一致性：通过 ====')