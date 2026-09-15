/**
 * 探针：同一 release 资产 URL 在中途被 --clobber 覆盖后，**这个 URL 到底还能不能拿到新字节**？
 * 背景：release-sync 的发布纪律是"同 tag 资产原地更新（--clobber，updated_at 变化即新包）"，
 * 而 `dsh plugin add <URL>` 装到的却是旧字节（挂载副本缺最新代码）。这里绕开 pnpm 直接 GET，
 * 判断是 **CDN 缓存** 还是 **pnpm 按 URL 复用**。
 *
 * 判定口径（2026-09-15 修）：**sha256 说了算**。原来只有"marker 在不在包里"一条，而 marker 是按
 * `scripts/release-sync.mjs` 这一个文件查的——传一个不在该文件里的 marker 会打印"URL 提供旧字节"这种
 * **假阴性判决**（本机实测踩到：sha 明明等于新资产）。所以：
 *   - 传 `<url> <marker> <期望 sha256>` → 判决完全按 sha 比对（权威）；
 *   - 只传 marker 时，未命中会显式提示"marker 可能选错了文件"，不再直接断言"旧字节"。
 * 用法：
 *   node scripts/probe-asset-freshness.mjs <asset-url>                      # 默认 marker '⑤b'
 *   node scripts/probe-asset-freshness.mjs <asset-url> 构建戳               # 指定 marker（须在 release-sync.mjs 里）
 *   node scripts/probe-asset-freshness.mjs <asset-url> 构建戳 <期望sha256>  # **权威判决**：sha 比对
 */
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

const url = process.argv[2]
if (!url) { console.error('用法: node probe-asset-freshness.mjs <asset-url> [marker] [期望sha256]'); process.exit(2) }
const marker = process.argv[3] ?? '⑤b'
const expectSha = (process.argv[4] ?? '').trim().toLowerCase().replace(/^sha256:/, '')
const shaDecided = /^[0-9a-f]{64}$/.test(expectSha)
const MARKER_FILE = 'scripts/release-sync.mjs'

const out = join(tmpdir(), `asset-probe-${Date.now()}.tgz`)
console.log('URL:', url)
const t0 = Date.now()
const res = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } })
console.log('HTTP', res.status, '→', res.url, `(${Date.now() - t0}ms)`)
const buf = Buffer.from(await res.arrayBuffer())
writeFileSync(out, buf)
const gotSha = createHash('sha256').update(buf).digest('hex')
console.log('下载字节数 =', buf.length, '｜ sha256 =', gotSha)

// 解包找 marker（tar -xzf 到一个临时目录）
const dir = out + '-x'
execSync(`mkdir "${dir}" 2>nul & tar -xzf "${out}" -C "${dir}"`, { stdio: 'ignore', shell: 'cmd.exe' })
const target = join(dir, 'package', ...MARKER_FILE.split('/'))
const hit = existsSync(target) ? readFileSync(target, 'utf8').includes(marker) : null
console.log(`包内 ${MARKER_FILE} 含 "${marker}"：${hit === null ? '(文件缺失)' : hit}`)
rmSync(dir, { recursive: true, force: true })
rmSync(out, { force: true })

if (shaDecided) {
  const same = gotSha === expectSha
  console.log(`sha256 比对：期望 ${expectSha}\n          实际 ${gotSha} → ${same ? '一致' : '不一致'}`)
  console.log(`\n==== 判定（按 sha256，权威）：URL 现在提供的是${same ? '**新字节**' : '**旧字节**'}${same ? '（CDN 未缓存旧版 → 若包管理器仍装到旧版，问题在 pnpm 按 URL 复用）' : '（URL 层面就是旧的 → GitHub 资产 CDN 缓存）'} ====`)
} else {
  console.log(hit
    ? `\n==== 判定（按 marker，仅供线索）：URL 现在提供的是**新字节**（marker 命中 ${MARKER_FILE}）====`
    : `\n==== 判定：**未按 sha 判定**——marker 未命中 ${MARKER_FILE}，这**不等于**"URL 是旧字节"（marker 可能选错文件）。\n     要权威判定请传第 3 个参数：<期望 sha256>（可从 .sync-state.json 的 remoteSha 取）====`)
}
