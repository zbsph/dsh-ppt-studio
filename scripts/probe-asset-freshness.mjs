/**
 * 探针：同一 release 资产 URL 在中途被 --clobber 覆盖后，**这个 URL 到底还能不能拿到新字节**？
 * 背景：release-sync 的发布纪律是"同 tag 资产原地更新（--clobber，updated_at 变化即新包）"，
 * 而 `dsh plugin add <URL>` 装到的却是旧字节（挂载副本缺最新代码）。这里绕开 pnpm 直接 GET，
 * 判断是 **CDN 缓存** 还是 **pnpm 按 URL 复用**。
 */
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

const url = process.argv[2]
if (!url) { console.error('用法: node probe-asset-freshness.mjs <asset-url> [marker]'); process.exit(2) }
const marker = process.argv[3] ?? '⑤b'

const out = join(tmpdir(), `asset-probe-${Date.now()}.tgz`)
console.log('URL:', url)
const t0 = Date.now()
const res = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } })
console.log('HTTP', res.status, '→', res.url, `(${Date.now() - t0}ms)`)
const buf = Buffer.from(await res.arrayBuffer())
writeFileSync(out, buf)
console.log('下载字节数 =', buf.length, '｜ sha256 =', createHash('sha256').update(buf).digest('hex'))

// 解包找 marker（tar -xzf 到一个临时目录）
const dir = out + '-x'
execSync(`mkdir "${dir}" 2>nul & tar -xzf "${out}" -C "${dir}"`, { stdio: 'ignore', shell: 'cmd.exe' })
const target = join(dir, 'package', 'scripts', 'release-sync.mjs')
const hit = existsSync(target) ? readFileSync(target, 'utf8').includes(marker) : null
console.log(`包内 scripts/release-sync.mjs 含 "${marker}"：${hit === null ? '(文件缺失)' : hit}`)
console.log(`\n==== 判定：URL 现在提供的是${hit ? '**新字节**（CDN 未缓存旧版 → 问题出在 pnpm 按 URL 复用）' : '**旧字节**（URL 层面就是旧的 → GitHub 资产 CDN 缓存）'} ====`)
rmSync(dir, { recursive: true, force: true })
rmSync(out, { force: true })
