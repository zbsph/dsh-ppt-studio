#!/usr/bin/env node
/**
 * 发行字节守卫：所有**跟踪的文本文件必须是 LF**。
 *
 * 为什么需要这条（2026-09-18，创意工坊 PR 审核把问题翻出来的那一类）：
 * 本插件有两条"一条命令安装"的路径，用户拿到的东西必须是**同一份字节**：
 *   ① 创意工坊卡片那条 `dsh plugin add <仓库 URL>` → pnpm 走 **git 检出**已提交内容；
 *   ② GitHub Release 的 `.tgz` 资产              → `npm pack` 打包**工作区**内容。
 * ②永远是 LF（脚本写出来的），而①在 Windows 上会被 `core.autocrlf=true`
 * （**Git for Windows 的系统级默认值**，用户不需要配置任何东西）转成 CRLF。
 * CRLF 会让 src/templates.js 里按 `\n` 做的行锚定文本手术**静默失效**——
 * 物化出来的模板工作区 deck.yaml 引用一个故意没被复制的母版页，resolveDeck 抛
 * `page file missing: pages/_cover.yaml`，干净克隆里 `npm test` 直接崩。
 *
 * 三道防线各管一段，缺一不可：
 *   · `.gitattributes`（`* text=auto eol=lf`）——把检出字节钉成 LF（正常情况由它解决）；
 *   · 本脚本——`eol=lf` 被误覆盖（例如有人给某类文件写了 `-text`、或把文本文件当 binary 声明）时当场红；
 *   · src/templates.js 的 `normalizeText()`——用户**手改过**的 CRLF/BOM 文件也不失效（这道防线管的是用户内容，
 *     不是发行物，所以不能拿它替代前两道）。
 *
 * 判定看**内容里的 `\r\n`**，不看 git 属性：查的是"安装路径真正拿到的字节"。
 * 二进制按扩展名 + NUL 字节跳过（.pptx/.png/.woff…）。
 *
 * 用法：node scripts/check-tracked-lf.mjs      # 有问题 exit 1
 *       node scripts/check-tracked-lf.mjs --fix # 就地改写成 LF（作者/贡献者在 Windows 上被编辑器改坏时用）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIX = process.argv.includes('--fix')

/** 二进制扩展名（不参与换行检查）。 */
const BINARY = new Set([
  '.pptx', '.zip', '.tgz', '.gz', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.xlsx', '.docx', '.mp4', '.webp',
])

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
console.log(`✓ 发行字节：${checked} 个跟踪的文本文件全部是 LF（git 安装 == tgz 安装的前提）`)
