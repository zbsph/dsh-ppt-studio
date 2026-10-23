#!/usr/bin/env node
/**
 * 发行字节守卫（两道）：
 *
 * ① **跟踪的文本文件必须是 LF**。
 *    为什么需要（2026-09-18，创意工坊 PR 审核把问题翻出来的那一类）：本插件有两条"一条命令安装"的路径，
 *    用户拿到的东西必须是**同一份字节**：
 *      · 创意工坊卡片那条 `dsh plugin add <仓库 URL>` → pnpm 走 **git 检出**已提交内容；
 *      · GitHub Release 的 `.tgz` 资产              → `npm pack` 打包**工作区**内容。
 *    tgz 永远是 LF（脚本写出来的），而 git 检出在 Windows 上会被 `core.autocrlf=true`（Git for Windows
 *    的系统级默认值）转成 CRLF。CRLF 会让 src/templates.js 里按 `\n` 做的行锚定文本手术**静默失效**。
 *    三道防线：`.gitattributes` 的 `eol=lf` / 本脚本（eol=lf 被误覆盖时当场红）/ src/templates.js 的 normalizeText（用户手改内容）。
 *
 * ② **跟踪的二进制文件必须仍是有效二进制**（2026-10-23 用户反馈的模板预览图损坏）。
 *    事故：一次"LF 规范化"chore（`8bfe154`）用文本工具批量重写了二进制——4 张 `templates/<id>/preview.png`
 *    与 `examples/warm-arch/shots/01.png` 的首字节从 `0x89` 变成 UTF-8 替换符 `EF BF BD`，
 *    文件大小还变大、`existsSync` 全绿、字节比较类测试也发现不了；只有真正解码/读图才暴露。
 *    因此对已知二进制扩展名校验**魔数**，PNG 额外校验 IHDR 宽高 > 0（抓"魔数对但内容被截断/重编码"）。
 *    修法：用 `git show <损坏前提交>:<路径> > <路径>` 恢复原字节，或用对应生成脚本重出；
 *    **不要**用 Set-Content / Out-File / 文本替换脚本去改二进制。`--fix` 只处理 LF，不碰二进制。
 *
 * 用法：node scripts/check-tracked-lf.mjs        # 有问题 exit 1
 *       node scripts/check-tracked-lf.mjs --fix  # 就地改写成 LF（仅文本）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIX = process.argv.includes('--fix')

/**
 * 二进制扩展名 → 最低校验。`magic` 为文件头字节；PNG 同时校验 IHDR 存在与宽高。
 * 覆盖 .gitattributes 里声明的全部二进制类型 + 仓库实际跟踪的类型。
 */
const BINARY_RULES = {
  '.png': { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], png: true },
  '.jpg': { magic: [0xff, 0xd8, 0xff] },
  '.jpeg': { magic: [0xff, 0xd8, 0xff] },
  '.gif': { magic: [0x47, 0x49, 0x46, 0x38] },
  '.webp': { magic: [0x52, 0x49, 0x46, 0x46], riff: 'WEBP' },
  '.ico': { magic: [0x00, 0x00, 0x01, 0x00] },
  '.pptx': { magic: [0x50, 0x4b], zip: true },
  '.xlsx': { magic: [0x50, 0x4b], zip: true },
  '.docx': { magic: [0x50, 0x4b], zip: true },
  '.zip': { magic: [0x50, 0x4b], zip: true },
  '.tgz': { magic: [0x1f, 0x8b] },
  '.gz': { magic: [0x1f, 0x8b] },
  '.woff': { magic: [0x77, 0x4f, 0x46, 0x46] },
  '.woff2': { magic: [0x77, 0x4f, 0x46, 0x32] },
  '.ttf': { magic: [0x00, 0x01, 0x00, 0x00] },
  '.otf': { magic: [0x4f, 0x54, 0x54, 0x4f] },
  '.pdf': { magic: [0x25, 0x50, 0x44, 0x46] },
  '.mp4': { magic: [0x66, 0x74, 0x79, 0x70], offset: 4 },
}
const BINARY = new Set(Object.keys(BINARY_RULES))

/** 二进制校验：返回 null（OK）或一句人类可读的失败原因。 */
function binaryProblem(buf, rule) {
  const at = rule.offset ?? 0
  if (buf.length < at + rule.magic.length) return '文件过短，连文件头都不完整'
  for (let i = 0; i < rule.magic.length; i++) {
    if (buf[at + i] !== rule.magic[i]) {
      const got = [...buf.subarray(0, Math.min(8, buf.length))].map((x) => x.toString(16).padStart(2, '0')).join(' ')
      return `文件头被破坏（期望 ${rule.magic.map((x) => x.toString(16).padStart(2, '0')).join(' ')} 开头，实际 ${got}）`
    }
  }
  if (rule.zip && !(buf[0] === 0x50 && buf[1] === 0x4b)) return '不是 ZIP/OOXML 容器'
  if (rule.riff && buf.subarray(8, 12).toString('latin1') !== rule.riff) return `RIFF 容器但不是 ${rule.riff}`
  if (rule.png) {
    if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return 'PNG 缺少 IHDR 块'
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    if (!(w > 0 && h > 0)) return `PNG IHDR 宽高非法（${w}×${h}）`
  }
  return null
}

let files
try {
  files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
} catch (e) {
  console.log(`⚠ 跳过：拿不到 git 跟踪清单（${String(e?.message ?? e).split('\n')[0].slice(0, 100)}）`)
  process.exit(0)
}

const offenders = []
let checked = 0
for (const rel of files) {
  if (BINARY.has(extname(rel).toLowerCase())) continue
  let buf
  try {
    buf = readFileSync(join(root, rel))
  } catch {
    continue // 工作区缺失（稀疏检出等）：不是本检查的职责
  }
  if (buf.includes(0)) continue // NUL ⇒ 二进制
  checked++
  // 只看 CRLF：单独出现的 \r（老 Mac 风格）在本仓库不存在，不必处理
  if (buf.includes('\r\n')) offenders.push(rel)
}

const badBinaries = []
let binChecked = 0
for (const rel of files) {
  const rule = BINARY_RULES[extname(rel).toLowerCase()]
  if (!rule) continue
  let buf
  try {
    buf = readFileSync(join(root, rel))
  } catch {
    continue
  }
  binChecked++
  const why = binaryProblem(buf, rule)
  if (why) badBinaries.push(`${rel}：${why}`)
}

if (offenders.length) {
  if (FIX) {
    for (const rel of offenders) {
      const p = join(root, rel)
      writeFileSync(p, readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
    }
    console.log(`✓ 已把 ${offenders.length} 个文件改写成 LF（工作区字节现在与提交内容一致）`)
    process.exit(0)
  }
  console.error(`✗ 有 ${offenders.length} 个跟踪的文本文件是 CRLF（应为 LF）：`)
  for (const f of offenders.slice(0, 30)) console.error(`    ${f}`)
  if (offenders.length > 30) console.error(`    …还有 ${offenders.length - 30} 个`)
  console.error('  为什么必须修：CRLF 检出会让行锚定文本手术静默失效 ⇒ git 安装（创意工坊那条命令）')
  console.error('  与 tgz 安装不是同一份字节。修法：node scripts/check-tracked-lf.mjs --fix')
  console.error('  （脏的只是工作区字节——提交内容一直要求 LF；改完 git status 应仍为干净。）')
  process.exit(1)
}

if (badBinaries.length) {
  console.error(`✗ 有 ${badBinaries.length} 个跟踪的二进制文件已损坏（疑似被文本工具/编码转换重写）：`)
  for (const f of badBinaries.slice(0, 30)) console.error(`    ${f}`)
  if (badBinaries.length > 30) console.error(`    …还有 ${badBinaries.length - 30} 个`)
  console.error('  为什么必须修：文件大小、existsSync 都可能正常，只有真读图/真打开才暴露；')
  console.error('  且这类坏文件会随 npm 包 / git 安装原样发给用户（模板预览图事故 2026-10-23）。')
  console.error('  修法：git show <损坏前提交>:<路径> > <路径> 恢复原字节，或用对应生成脚本重出；')
  console.error('  禁止用 Set-Content / Out-File / 文本替换脚本改二进制。')
  process.exit(1)
}

console.log(`✓ 发行字节：${checked} 个跟踪的文本文件全部是 LF；${binChecked} 个跟踪的二进制文件文件头/结构有效`)
