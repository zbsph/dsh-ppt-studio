#!/usr/bin/env node
/**
 * tar-extract.mjs —— 纯 Node 解压 `.tar.gz`（发版链专用，替代系统 `tar`）。
 *
 * 为什么需要它（2026-10-23 CI 实测根因）：
 *   `npm pack` 会为**非 ASCII 文件名**（本仓库 `docs/` 下大量中文名）写 PAX 扩展头（`x` 条目）。
 *   GitHub Windows runner 自带的 bsdtar 在部分版本/系统代码页下把这些 PAX 头报成
 *   `tar.exe: Archive entry has empty or unreadable filename ... skipping`（每个中文名文件一条），
 *   最终 `tar: Error exit delayed from previous errors` 退出 1 —— 于是 `release-sync --local`
 *   在 CI 上假红（本机同样的包、同样的 tar 却通过；10-17 的旧 CI 也通过——环境敏感性极高）。
 *   同时系统 tar 在 GNU / bsdtar、`C:\…` 盘符路径、编码、PAX 支持上差异很大。
 *
 * 本模块只依赖 `node:zlib`：
 *   - 读 512 字节 ustar 头；支持 PAX（`x`/`g`，`path`/`linkpath`/`size`）与 GNU 长名（`L`/`K`）；
 *   - 文件名一律按 **UTF-8** 解码（Node 字符串天然是 UTF-8，不经过系统代码页）；
 *   - 拒绝绝对路径 / `..` 逃逸；
 *   - 输出与系统 tar 相同的树（普通文件 / 目录 / 符号链接；其余类型记入 skipped，不静默丢）。
 *
 * 用法：
 *   import { extractTgz } from './tar-extract.mjs'
 *   node scripts/tar-extract.mjs <a.tgz> <目标目录>
 */
import { readFileSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const BLOCK = 512

const cstr = (buf, start, end) => {
  const slice = buf.subarray(start, end)
  const nul = slice.indexOf(0)
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8')
}

const octal = (buf, start, end) => {
  const s = buf.subarray(start, end).toString('ascii').replace(/\0/g, ' ').trim()
  if (!s) return 0
  const n = parseInt(s, 8)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** PAX 记录：`<len> <key>=<value>\n`（len 含自身）；值按 UTF-8。 */
function parsePaxRecords(data) {
  const out = []
  let i = 0
  while (i < data.length) {
    const space = data.indexOf(0x20, i)
    if (space < 0) break
    const len = Number(data.subarray(i, space).toString('ascii'))
    if (!Number.isFinite(len) || len <= 0) break
    const end = i + len
    if (end > data.length) break
    const rec = data.subarray(space + 1, end).toString('utf8').replace(/\n$/, '')
    const eq = rec.indexOf('=')
    if (eq > 0) out.push([rec.slice(0, eq), rec.slice(eq + 1)])
    i = end
  }
  return out
}

/**
 * @param {string} tgzPath  .tar.gz 路径
 * @param {string} destDir  解压目标目录（不存在则创建）
 * @returns {{files:number, dirs:number, symlinks:number, skipped:string[]}}
 */
export function extractTgz(tgzPath, destDir) {
  const buf = gunzipSync(readFileSync(tgzPath))
  const root = resolve(destDir)
  mkdirSync(root, { recursive: true })
  const stats = { files: 0, dirs: 0, symlinks: 0, skipped: [] }

  const safePath = (rel, what) => {
    if (!rel) throw new Error(`tar 条目缺少路径（${what}）`)
    if (isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) throw new Error(`tar 条目是绝对路径（拒绝）：${rel}`)
    const parts = rel.split('/').filter((p) => p !== '' && p !== '.')
    if (parts.some((p) => p === '..')) throw new Error(`tar 条目含 ".."（拒绝路径逃逸）：${rel}`)
    const abs = join(root, ...parts)
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`tar 条目越出目标目录（拒绝）：${rel}`)
    return abs
  }

  let off = 0
  let pendingPax = null // 作用**下一条**普通条目
  let paxGlobal = {}
  let gnuName = null
  let gnuLink = null
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK)
    if (header.every((b) => b === 0)) { off += BLOCK; continue } // 结束块 / 填充块
    const type = String.fromCharCode(header[156]) || '0'
    const headerSize = octal(header, 124, 136)

    if (type === 'x' || type === 'X' || type === 'g') {
      const data = buf.subarray(off + BLOCK, off + BLOCK + headerSize)
      for (const [k, v] of parsePaxRecords(data)) {
        if (type === 'g') { paxGlobal[k] = v } else { pendingPax = pendingPax ?? {}; pendingPax[k] = v }
      }
      off += BLOCK + Math.ceil(headerSize / BLOCK) * BLOCK
      continue
    }
    if (type === 'L') { // GNU longname
      const data = buf.subarray(off + BLOCK, off + BLOCK + headerSize)
      gnuName = data.toString('utf8').replace(/\0+$/, '')
      off += BLOCK + Math.ceil(headerSize / BLOCK) * BLOCK
      continue
    }
    if (type === 'K') { // GNU long linkname
      const data = buf.subarray(off + BLOCK, off + BLOCK + headerSize)
      gnuLink = data.toString('utf8').replace(/\0+$/, '')
      off += BLOCK + Math.ceil(headerSize / BLOCK) * BLOCK
      continue
    }

    const pax = { ...paxGlobal, ...(pendingPax ?? {}) }
    pendingPax = null
    let name = gnuName ?? cstr(header, 0, 100)
    const prefix = cstr(header, 345, 500)
    if (!gnuName && prefix) name = `${prefix}/${name}`
    gnuName = null
    if (pax.path) name = pax.path
    let linkname = gnuLink ?? cstr(header, 157, 257)
    gnuLink = null
    if (pax.linkpath) linkname = pax.linkpath
    const size = pax.size !== undefined ? Number(pax.size) : headerSize
    if (!Number.isFinite(size) || size < 0) throw new Error(`tar 条目 size 非法：${name}`)
    const dataStart = off + BLOCK
    const data = buf.subarray(dataStart, dataStart + size)
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK

    const mode = octal(header, 100, 108)
    if (type === '5') {
      mkdirSync(safePath(name, '目录'), { recursive: true })
      stats.dirs++
    } else if (type === '0' || type === '\0') {
      const abs = safePath(name, '文件')
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, data)
      if (mode) { try { chmodSync(abs, mode & 0o777) } catch { /* Windows 上 chmod 基本无效 */ } }
      stats.files++
    } else if (type === '2') {
      const abs = safePath(name, '符号链接')
      mkdirSync(dirname(abs), { recursive: true })
      symlinkSync(linkname, abs)
      stats.symlinks++
    } else {
      // '1' 硬链接 / '3'-'6' 设备与 FIFO 等：npm 包里不会出现；记录而不静默丢。
      stats.skipped.push(`${type}:${name}`)
    }
    off = next
  }
  return stats
}

// ── CLI（人工排查用；CI 走 release-sync 里的 import）──
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [tgz, dest] = process.argv.slice(2)
  if (!tgz || !dest) {
    console.error('用法：node scripts/tar-extract.mjs <a.tgz> <目标目录>')
    process.exit(2)
  }
  const r = extractTgz(tgz, dest)
  console.log(`解包完成：${r.files} 文件 / ${r.dirs} 目录 / ${r.symlinks} 符号链接${r.skipped.length ? ` / 跳过 ${r.skipped.length}（${r.skipped.slice(0, 3).join(', ')}）` : ''}`)
}
