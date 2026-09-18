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
const gitRemote = run('git', ['remote', 'get-url', 'origin'], root)
const repo = opt('--repo', isFail(gitRemote) ? '(未配置 origin)' : gitRemote)
const tag = opt('--tag', `v${pkg.version}`)

let pass = 0
let fail = 0
/** 一条断言：打印"看到什么"，失败时把"为什么重要"一起打出来。 */
function check(label, ok, detail = '', why = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok && why) console.log(`    ↳ 为什么重要：${why}`)
  ok ? pass++ : fail++
}
/** shell 下需要引号的参数（含空白/管道/重定向等）。
 *  写成**函数声明**（不是 const 箭头函数）：下面的模块级代码要在定义之前调用 run()，
 *  箭头函数在 TDZ 里会抛 "Cannot access 'shellQuote' before initialization"（本脚本第一版就这样，
 *  表现为顶部那行"仓库 __FAIL__Cannot access…"）。 */
function shellQuote(s) {
  return /[\s"&|<>^]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s)
}
/** 跑命令；不抛（失败由断言处理）。 */
function run(cmd, cmdArgs, cwd = root, extraEnv = {}) {
  try {
    return execFileSync(cmd, cmdArgs.map(shellQuote), {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上 `npm` 是 npm.cmd：execFileSync 不解析 .cmd，不加 shell 会**直接失败**
      // （本脚本第一版就栽在这里：npm install / npm test 全报 ✗，而输出是空的，看起来像被测对象的问题）。
      // 仓库里 verify-bundle-install.mjs 的 run() 用的是同一个写法，保持一致。
      shell: process.platform === 'win32',
    }).trim()
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    // 连 stdout/stderr 都没有时（spawn 本身失败）把 message 带上，别让断言显示成"空失败"。
    return `__FAIL__${out || String(e?.message ?? e)}`
  }
}
function isFail(s) {
  return typeof s === 'string' && s.startsWith('__FAIL__')
}
function tail(s, n = 200) {
  return String(s).replace(/__FAIL__/, '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, n)
}

console.log(`verify-fresh-install：版本 ${pkg.version}｜模式 ${LOCAL ? 'local（本地迭代）' : 'release（查 GitHub）'}｜仓库 ${repo}｜分支 ${branch}｜tag ${tag}\n`)

// ── ① 本地是否全部推上去了 ─────────────────────────────────────────────────────
// 这一条最容易被忽略，而它的后果最严重：本地全绿、用户装到旧代码。查的是"用户会克隆到的那个分支"。
// 注意：**只有 release 模式把它当断言**——`--local` 是日常迭代，本地领先远端是常态（那正是它的目的），
// 所以那里只打印信息，不判失败。真正的本地判据是 ②（干净检出我的**当前工作**能不能过）。
if (LOCAL) {
  const fetch = run('git', ['fetch', '--quiet', 'origin'])
  if (isFail(fetch)) {
    console.log('① 远端信息：未能确认（离线或远端不可达）——不影响本地自检')
  } else {
    const behind = Number(run('git', ['rev-list', '--count', `HEAD..origin/${branch}`]) || '0')
    const ahead = Number(run('git', ['rev-list', '--count', `origin/${branch}..HEAD`]) || '0')
    console.log(`① 远端信息（仅信息，不判失败）：本地领先 origin/${branch} ${ahead} 个提交｜落后 ${behind} 个`
      + `${ahead > 0 ? '——发版前必须 push（发版模式会拒绝继续）' : ''}`)
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
  const contains = remoteBranchSha && run('git', ['merge-base', '--is-ancestor', head, remoteBranchSha]) !== '__FAIL__'
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
    // **克隆源按模式区分**：release 克隆 GitHub 上的 tag（= 用户真正会拿到的东西）；
    // `--local` 克隆**本地仓库路径**（= "我这台机器上这份工作，全新检出能不能过"）——
    // 本地迭代时本地领先远端是常态，从远端克隆反而验错了对象（这是本脚本第一版的真实缺陷）。
    const cloneSource = LOCAL ? root : repo
    const cloneDepth = ['--depth', '1', '--branch', LOCAL ? branch : tag]
    const clone = run('git', ['clone', '--quiet', ...cloneDepth, cloneSource, cloneDir])
    check(`干净克隆成功（${LOCAL ? `本地 HEAD @ ${branch}` : tag}）`, !isFail(clone), tail(clone),
      '克隆都失败时后面全是假象——必须先确认这一步。')
    if (isFail(clone)) throw new Error('clone failed')

    const cloneVer = JSON.parse(readFileSync(join(cloneDir, 'package.json'), 'utf8')).version
    check('克隆出来的就是本版（package.json.version）', cloneVer === pkg.version,
      `克隆=${cloneVer}｜本机=${pkg.version}`,
      '用户装到的必须是你刚发布的那一版；版本不一致说明 tag/分支指向的不是本版。')
    if (LOCAL) {
      const cloneHead = run('git', ['rev-parse', 'HEAD'], cloneDir)
      const localHead = run('git', ['rev-parse', 'HEAD'])
      check('本地模式的干净检出来自**当前 HEAD**（不是远端旧提交）', cloneHead === localHead,
        `克隆=${cloneHead.slice(0, 10)}｜本地=${localHead.slice(0, 10)}`,
        '--local 要答的问题是"我这份工作全新检出能不能过"，克隆到远端就是把旧代码当成新代码来验。')
    }

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

/** 取 Release 资产 URL（用户会在资产页复制粘贴的那一条）。 */
function findReleaseAsset(t) {
  const gh = process.env.GH || 'gh'
  // 用 REST + 本地解析，**不用 --jq**：cmd.exe 下 shell 无法用单引号 jq（release-sync.mjs 里同一条教训）。
  const remote = run('git', ['remote', 'get-url', 'origin']) || ''
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote.trim())
  if (!m) return ''
  const json = run(gh, ['api', `repos/${m[1]}/${m[2]}/releases/tags/${t}`])
  if (isFail(json)) return ''
  try {
    const assets = (JSON.parse(json).assets ?? []).filter((a) => String(a.name).endsWith('.tgz'))
    // 资产名 = 版本-构建时间-构建戳；历次构建都挂在同一 Release 上，按创建时间取最新即当前版本。
    assets.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    return assets.pop()?.browser_download_url ?? ''
  } catch {
    return ''
  }
}
