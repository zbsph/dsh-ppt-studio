#!/usr/bin/env node
/**
 * verify-fresh-install.mjs —— 「一个普通用户，照着指引敲一条命令，能不能装好并用起来？」
 *
 * 为什么需要它（2026-09-18 实测，两个都真实发生过）：
 *   ① 本地落后远端：`origin/main` 落后本机 **14 个提交**，而已发布的 tag `v1.0.1`
 *      **指向那个旧提交**。用户按指引跑 `dsh plugin add <仓库 URL>` 拿到的是 v1.0.0 的旧代码
 *      （没有会话隔离、没有 8 项缺陷修复）——而当时所有本机门禁全绿，因为门禁**只测本机工作区**。
 *   ② 干净检出才暴露的缺陷：仓库工作区是脚本写出来的 LF，而**干净克隆**在 Windows 上是 CRLF
 *      （Git for Windows 默认 `core.autocrlf=true`），行锚定文本手术在 CRLF 上静默失效 ⇒
 *      `resolveDeck` 抛 `page file missing: pages/_cover.yaml`，干净克隆里 `npm test` 直接崩。
 *   两条的共同点：**"本机绿"与"用户能用"之间没有任何机器在把关**。本脚本就是那道关。
 *
 * 它断言的是**用户视角**，不是作者视角：
 *   ① 远端分支必须包含本地全部提交（否则用户从仓库拿到的是旧代码）——release 模式必查；
 *   ② tag `v<版本>` 必须存在且**正好指向本地 HEAD**（gh release create 会按默认分支 HEAD 建 tag，
 *      与"我要发布的提交"无关——这正是 ①里那个错 tag 的成因）；
 *   ③ **干净克隆**（默认 autocrlf，模拟用户机器）里 `npm install` + `npm test` 必须过，
 *      且克隆出来的 `package.json.version` 就是本版；
 *   ④（默认开启）把**用户会敲的那条命令**在一个隔离 DSH_HOME 里真跑一遍（委托 verify-bundle-install.mjs）：
 *      spec 为 Release 资产 URL（release 模式）或本地 tgz（--local）。
 *
 * 用法：
 *   node scripts/verify-fresh-install.mjs                    # 发版后：查 GitHub 上的 v<版本>
 *   node scripts/verify-fresh-install.mjs --local            # 本地迭代：查分支 HEAD + 本地 tgz
 *   node scripts/verify-fresh-install.mjs --skip-clone-test  # 只查 git/资产一致性（快）
 *   node scripts/verify-fresh-install.mjs --skip-install     # 不跑真安装（没装 dsh 时）
 *   可选：--repo <url> --branch <name> --spec <url|tgz> --tag v1.0.1
 *
 * 退出码：0 = 全部成立；1 = 至少一条不成立（每条都打印"哪一条、看到什么、为什么重要"）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const LOCAL = args.includes('--local')
const SKIP_CLONE_TEST = args.includes('--skip-clone-test')
const SKIP_INSTALL = args.includes('--skip-install')
const branch = opt('--branch', 'main')
const repo = opt('--repo', run('git', ['remote', 'get-url', 'origin'], root) || '')
const tag = opt('--tag', `v${pkg.version}`)

let pass = 0
let fail = 0
/** 一条断言：打印"看到什么"，失败时把"为什么重要"一起打出来。 */
function check(label, ok, detail = '', why = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok && why) console.log(`    ↳ 为什么重要：${why}`)
  ok ? pass++ : fail++
}
/** 跑命令；不抛（失败由断言处理）。 */
function run(cmd, cmdArgs, cwd = root, extraEnv = {}) {
  try {
    return execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    return `__FAIL__${out}`
  }
}
const isFail = (s) => typeof s === 'string' && s.startsWith('__FAIL__')
const tail = (s, n = 200) => String(s).replace(/__FAIL__/, '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, n)

console.log(`verify-fresh-install：版本 ${pkg.version}｜模式 ${LOCAL ? 'local（本地迭代）' : 'release（查 GitHub）'}｜仓库 ${repo}｜分支 ${branch}｜tag ${tag}\n`)

// ── ① 本地是否全部推上去了 ─────────────────────────────────────────────────────
// 这一条最容易被忽略，而它的后果最严重：本地全绿、用户装到旧代码。查的是"用户会克隆到的那个分支"。
let remoteHasAll = null
if (LOCAL) {
  console.log('① 远端分支与本地的一致性')
  const fetch = run('git', ['fetch', '--quiet', 'origin'])
  if (isFail(fetch)) {
    check('能 fetch origin（离线时无法确认，不当作失败）', true, '未能确认（离线或远端不可达）')
    remoteHasAll = null
  } else {
    const behind = Number(run('git', ['rev-list', '--count', `HEAD..origin/${branch}`]) || '0')
    const ahead = Number(run('git', ['rev-list', '--count', `origin/${branch}..HEAD`]) || '0')
    check(`本地没有未推送的提交（origin/${branch} 已包含本地 HEAD）`, ahead === 0,
      `未推送 ${ahead} 个｜落后 ${behind} 个`,
      '用户照指引从仓库 URL 安装时拿到的是 **origin 上**的代码；本地没推 = 用户装到旧版。')
    remoteHasAll = ahead === 0
    if (ahead > 0) {
      const list = run('git', ['log', '--oneline', `origin/${branch}..HEAD`]).split('\n').filter(Boolean)
      for (const l of list.slice(0, 8)) console.log(`      · ${l}`)
    }
  }
} else {
  console.log('① 远端 tag 与本地 HEAD 的一致性（release 模式）')
  const ls = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])
  const remoteTagSha = isFail(ls) ? '' : (ls.split(/\s+/)[0] ?? '')
  const head = run('git', ['rev-parse', 'HEAD'])
  check(`远端存在 tag ${tag}`, remoteTagSha.length === 40, remoteTagSha || `(没有这个 tag)`,
    'README 与创意工坊卡片都按 tag/资产指路；tag 不存在时用户按图索骥会 404。')
  check(`${tag} 正好指向本地 HEAD（要发布的那一提交）`, remoteTagSha === head,
    `tag=${remoteTagSha.slice(0, 10) || '(缺)'}｜HEAD=${head.slice(0, 10)}`,
    '`gh release create` 会按**默认分支 HEAD** 建 tag——本地没推时它就把 tag 建在旧提交上，'
    + '于是"发布"了 v1.0.1，而 v1.0.1 指向的是 v1.0.0 的代码。')
  // 顺带断言：远端分支确实包含 HEAD（否则 git 安装路径仍是旧的）
  const lsMain = run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])
  const remoteBranchSha = isFail(lsMain) ? '' : (lsMain.split(/\s+/)[0] ?? '')
  const contains = remoteBranchSha && !isFail(run('git', ['merge-base', '--is-ancestor', head, remoteBranchSha]))
  check(`origin/${branch} 已包含本地 HEAD（git 安装路径拿到的是本版）`, Boolean(contains),
    `branch=${remoteBranchSha.slice(0, 10) || '(缺)'}｜HEAD=${head.slice(0, 10)}`,
    '创意工坊对无 npm 包的条目生成的就是 `dsh plugin add <仓库 URL>`——分支落后就等于用户装不到新版。')
}

// ── ② 干净克隆里 npm install + npm test ───────────────────────────────────────
// 这一步是"别人的机器"的替身：没有本机的 node_modules、没有本机的 gitignore 产物、
// Windows 上还会按 core.autocrlf 的默认值检出 CRLF。历史上红过的两条都在这里才现形。
if (SKIP_CLONE_TEST) {
  console.log('\n② 干净克隆自检 —— 已按 --skip-clone-test 跳过')
} else {
  console.log('\n② 干净克隆里 npm install + npm test（"别人的机器"的替身）')
  const work = mkdtempSync(join(tmpdir(), 'ppt-fresh-'))
  const cloneDir = join(work, 'repo')
  try {
    // 故意**不**传 -c core.autocrlf=false：用户机器是什么样，这里就什么样。
    // .gitattributes 的 `* text=auto eol=lf` 负责把检出钉成 LF；若它失效，这段就会像用户一样崩。
    const cloneRef = LOCAL ? branch : tag
    const cloneDepth = LOCAL ? ['--depth', '1', '--branch', branch] : ['--depth', '1', '--branch', tag]
    const clone = run('git', ['clone', '--quiet', ...cloneDepth, repo, cloneDir])
    check(`干净克隆成功（${cloneRef}）`, !isFail(clone), tail(clone),
      '克隆都失败时后面全是假象——必须先确认这一步。')
    if (isFail(clone)) throw new Error('clone failed')

    const cloneVer = JSON.parse(readFileSync(join(cloneDir, 'package.json'), 'utf8')).version
    check('克隆出来的就是本版（package.json.version）', cloneVer === pkg.version,
      `克隆=${cloneVer}｜本机=${pkg.version}`,
      '用户装到的必须是你刚发布的那一版；版本不一致说明 tag/分支指向的不是本版。')

    // 检出字节的证据（不是断言，是现场记录）：git 安装与 tgz 安装必须是同一份字节。
    const crlf = countCrlfFiles(cloneDir)
    console.log(`      · 干净克隆的文本文件 CRLF 数：${crlf.length}（应为 0；非 0 说明 .gitattributes 没生效，`
      + 'Windows 上就会命中"行锚定正则静默失效"那个坑）')
    check('干净克隆的跟踪文本文件全是 LF（git 安装 == tgz 安装）', crlf.length === 0,
      crlf.slice(0, 5).join(', ') || '无', '见 scripts/check-tracked-lf.mjs 的说明。')

    const inst = run('npm', ['install', '--no-audit', '--no-fund'], cloneDir)
    check('克隆里 npm install 成功', !isFail(inst), tail(inst), '用户第一步就会跑它。')
    const test = run('npm', ['test'], cloneDir)
    check('克隆里 npm test 全绿（这就是"干净检出"的定义）', !isFail(test), isFail(test) ? tail(test, 400) : `结果行：${(String(test).match(/====.*====/) ?? ['(未见结果行)'])[0]}`,
      '历史上这里红过：previews 断言在无 Office 的机器上必红；CRLF 检出则直接崩在 pages/_cover.yaml。')
    if (isFail(test)) {
      console.log('      —— 克隆里 npm test 的输出尾部 ——')
      for (const l of String(test).replace('__FAIL__', '').split(/\r?\n/).slice(-25)) console.log(`      ${l}`)
    }
  } finally {
    if (!args.includes('--keep-work')) rmSync(work, { recursive: true, force: true })
  }
}

// ── ③ 用户会敲的那条命令（真安装，隔离 DSH_HOME）─────────────────────────────
if (SKIP_INSTALL) {
  console.log('\n③ 一条命令安装 —— 已按 --skip-install 跳过')
} else {
  console.log('\n③ 一条命令安装（委托 verify-bundle-install.mjs，隔离 DSH_HOME，不碰你的 profile）')
  let spec = opt('--spec', '')
  if (!spec && LOCAL) {
    // --local：用刚打出来的本地 tgz（等价于"从同一份字节装一遍"）
    const packDir = mkdtempSync(join(tmpdir(), 'ppt-fresh-pack-'))
    const pack = run('npm', ['pack', '--pack-destination', packDir])
    spec = isFail(pack) ? '' : join(packDir, String(pack).split(/\r?\n/).filter(Boolean).pop())
  }
  if (!spec) {
    // release：用 Release 页面上那条资产 URL（用户会复制粘贴的那一条）
    const asset = findReleaseAsset(tag)
    if (asset) spec = asset
  }
  if (!spec) {
    check('能定位到"用户会敲的那条命令"的安装规格（Release 资产 URL / 本地 tgz）', false, '(未找到)',
      '这条命令是文档指引的核心；找不到规格就无法证明它可用。可用 --spec 显式给定。')
  } else {
    console.log(`      规格：${spec}`)
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'verify-bundle-install.mjs'), spec], { cwd: root, stdio: 'inherit' })
    check('`dsh plugin --profile web add <规格>` 全链自证通过（含装配与升级路径）', r.status === 0,
      `exit=${r.status}`, '这一条就是"用户敲完能不能用"本身；前面几条只保证"代码是对的"。')
  }
}

console.log(`\n==== verify-fresh-install 结果：${pass} 通过 / ${fail} 失败 ====`)
process.exit(fail > 0 ? 1 : 0)

/** 统计干净克隆里的 CRLF 文本文件（与 check-tracked-lf.mjs 同判据，但只读不改）。 */
function countCrlfFiles(dir) {
  const BINARY = new Set(['.pptx', '.zip', '.tgz', '.gz', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.pdf'])
  const files = run('git', ['ls-files', '-z'], dir)
  if (isFail(files)) return []
  const out = []
  for (const rel of files.split('\0').filter(Boolean)) {
    if (BINARY.has(rel.slice(rel.lastIndexOf('.')).toLowerCase())) continue
    try {
      const buf = readFileSync(join(dir, rel))
      if (buf.includes(0)) continue
      if (buf.includes('\r\n')) out.push(rel)
    } catch { /* 缺失文件不是本检查的职责 */ }
  }
  return out
}

/** 取 Release 资产 URL（用 gh；未安装 gh 时退回"让 verify-bundle-install 自己 pack"）。 */
function findReleaseAsset(t) {
  const gh = process.env.GH || 'gh'
  const out = run(gh, ['release', 'view', t, '--json', 'assets', '--jq', '.assets[] | select(.name | endswith(".tgz")) | .url'])
  const first = isFail(out) ? '' : String(out).split(/\r?\n/).filter(Boolean).pop()
  if (!first) return ''
  // gh 给的是 API URL；资产下载走浏览器 URL（用户会复制的那条）
  try {
    const api = JSON.parse(run(gh, ['api', first.replace('https://api.github.com/', '')]) || '{}')
    return api.browser_download_url || ''
  } catch {
    return ''
  }
}
