#!/usr/bin/env node
/**
 * release-sync.mjs —— 一条命令完成"构建 + 本机同步"，两种模式：
 *
 * **--local（日常迭代，推荐）**：不发 GitHub，本机跑的就是刚构建的字节。
 *   ① build → ② pack（带构建戳）→ ③ **跳过 GitHub 比对/上传** → ④ 同一 tgz 部署本机安装根 + 重跑 install.mjs
 *   → ⑤ 用**本地 tgz 的 `file:` 规格**把同一份字节装进 profile → ⑥ 终验 + 写 .sync-state.json
 *
 * **发版（默认）**：机器 == GitHub 字节级一致。
 *   ① build → ② pack → ③ sha256 比对/上传（--clobber，幂等）→ ④ 同一 tgz 部署本机安装根
 *   → ⑤ 按 **GitHub 资产 URL** 重装 profile → ⑥ 终验三方一致 + 写 .sync-state.json
 *
 * 为什么 --local 用 `file:` 规格，而不是切回 junction/preset 装法：
 *   junction 会**新增一条挂载路径**——"我现在改的是哪份代码"于是有两种答案，答错**不报错**（这才是真正的风险，
 *   不是"记不记得住"）。`file:` 仍然只有一条路径（profile bundle 行），只把"从哪取字节"从远端资产换成本地 tgz。
 *   仓库自带 `verify-bundle-install.mjs` 已自证这条机制：**同版本号、不同路径的 tgz ⇒ 装到的就是新字节**
 *   （pnpm 按规格解析，所以构建戳让规格必变 ⇒ 必然重取）。
 *
 * 关于"本地永不落后于 GitHub"（用户纪律）：**它不会自动成立**——有人在 GitHub 上直接改、或换机器提交，
 *   本地就落在后面，而"在最新版本上迭代"这个前提破了以后**没有任何症状**，直到发版时才发现分叉。
 *   所以 --local 每次都先 `git fetch` 比对 HEAD 与 origin/<branch>：behind>0 → 直接失败（`--allow-behind` 可绕过）；
 *   fetch 失败（离线）→ 明确标注"未能确认"并继续（本地迭代本来就可能无网，不能因此把它变成脆弱门禁）。
 *
 * 用法：
 *   node scripts/release-sync.mjs --local                        # 日常迭代（不发 GitHub）
 *   node scripts/release-sync.mjs                                # 发版
 *   node scripts/release-sync.mjs --local --allow-behind          # 明知落后仍要构建（自担）
 *   可选：[--tag v1.0.0] [--root D:\plugins] [--profile web] [--no-upload] [--state <路径>]
 *
 * 回退到 GitHub 版本：`dsh plugin --profile web add <Releases 页面的资产 URL>`（发版模式做的就是这件事）。
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, copyFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const GH = process.env.GH || 'C:\\Program Files\\GitHub CLI\\gh.exe'
const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const tag = opt('--tag', 'v' + pkg.version)
const deployRoot = resolve(opt('--root', 'D:\\plugins'))
const noUpload = args.includes('--no-upload')
const local = args.includes('--local')
const allowBehind = args.includes('--allow-behind')
// --state 只为可测性存在：让隔离环境里跑的 release-sync 不要把 .sync-state.json 写进真仓库。
const stateFile = resolve(opt('--state', join(root, '.sync-state.json')))

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const run = (cmdStr) => execSync(cmdStr, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// ── ⓪ 本地是否落后于远端（用户纪律："每次迭代都在最新版本上进行"）────────────────────
// 为什么必须机器查：这条纪律**不会自动成立**。有人在 GitHub 上直接改、或换机器提交，本地就落在后面；
// 而"在最新版本上迭代"这个前提一旦破了，**没有任何症状**，直到发版时才发现分叉。
// 离线（fetch 失败）不算失败——本地迭代本来就可能无网；但必须**明确标注"未能确认"**，不能假装查过了。
function gitFreshness() {
  try {
    const branch = run('git rev-parse --abbrev-ref HEAD').trim()
    if (!branch || branch === 'HEAD') return { ok: true, note: '游离 HEAD——跳过落后检查' }
    run('git fetch --quiet origin')
    const behind = Number(run(`git rev-list --count HEAD..origin/${branch}`).trim())
    const ahead = Number(run(`git rev-list --count origin/${branch}..HEAD`).trim())
    const dirty = run('git status --porcelain').trim().split('\n').filter(Boolean).length
    return { ok: behind === 0, behind, ahead, dirty, branch }
  } catch (e) {
    return { ok: true, uncertain: true, note: `无法比对远端（离线或 fetch 失败）——**未能确认**本地是否落后：${String(e?.message ?? e).slice(0, 120)}` }
  }
}

if (local) {
  const g = gitFreshness()
  if (g.note) {
    console.log(`⓪ git：${g.note}`)
  } else {
    console.log(`⓪ git：${g.branch} 落后 origin/${g.branch} ${g.behind} 个提交｜本地未发布 ${g.ahead} 个｜未提交改动 ${g.dirty} 个文件`)
    if (!g.ok && !allowBehind) {
      console.error(`✗ 本地落后 origin/${g.branch} **${g.behind} 个提交**——按"每次迭代都在最新版本上进行"的纪律，`
        + `先 \`git pull\` 再跑；确要在旧基线上迭代请显式加 --allow-behind（后果自担：发版时会出现分叉）`)
      process.exit(1)
    }
    if (!g.ok) console.log(`⚠ --allow-behind：明知落后 ${g.behind} 个提交仍继续——本轮基线**不是最新**`)
  }
}

// ① build
console.log('① build ...')
run('node scripts/build.mjs')
console.log('    done')

// ② pack（**每次构建带构建戳 + 构建时间**）
// 为什么必须换名：2026-09-15 实测——同 tag 同 URL 用 --clobber 覆盖内容后，
//   `dsh plugin add <同一 URL>` **不会重新下载**（pnpm 按 URL 规格复用旧副本，--force 也没绕过；
//   同时用独立探针 GET 该 URL 证明 URL 本身已提供新字节 → 是包管理器侧的复用）。
// 后果：用户重跑同一条命令"升级"会拿到旧版本。改法：文件名带本题 tgz 的 sha256 前 8 位 ⇒ URL 变化 ⇒ 必然重取。
// 为什么还要带**构建时间**：Release 页面会同时挂着历次构建的资产（有意不删——老 URL 得留给已装用户重装），
//   而 sha 前 8 位看不出新旧，用户"从页面复制那条 URL"时无从判断哪条是当前版本（实测踩到：页面上 4 条）。
//   加上日期时间后，肉眼/字典序取最新即当前版本；sha 段仍负责"内容变了 URL 必变"。
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const buildStamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
const packDir = join(tmpdir(), 'pptsync-' + Date.now())
mkdirSync(packDir, { recursive: true })
const tgzOutput = run(`npm pack --pack-destination "${packDir}"`).split('\n').pop()
const tgzPath = join(packDir, tgzOutput)
const tgzSha = sha(readFileSync(tgzPath))
const stampedName = tgzOutput.replace(/\.tgz$/, `-${buildStamp}-${tgzSha.slice(0, 8)}.tgz`)
const stampedPath = join(packDir, stampedName)
copyFileSync(tgzPath, stampedPath)
// --local 模式的**安装规格就是这个文件路径**，所以它必须落在**稳定目录**（不能留在 tmpdir）：
//   否则系统清理临时目录后，profile 里记的 `file:` 规格指向一个不存在的文件 → 该 profile 的 pnpm install 直接失败，
//   而且失败发生在**下一次**安装时（远离本次构建），极难归因。
const artifactDir = join(deployRoot, '_artifacts')
mkdirSync(artifactDir, { recursive: true })
const artifactPath = join(artifactDir, stampedName)
copyFileSync(tgzPath, artifactPath)
console.log(`② packed ${tgzOutput} (${Math.round(statSync(tgzPath).size / 1024 / 1024 * 10) / 10}MB)`)
console.log(`   资产名（构建时间 + 构建戳：取最新一条即当前版本，且内容变了规格必变）：${stampedName}\n   local sha256=${tgzSha}`)
console.log(`   本地构件（--local 的安装规格）：${artifactPath}`)

// ③④ 远程 digest 比对/上传（--local 整段跳过：本地迭代不发 GitHub）
const remoteDigest = () => {
  try {
    // REST 输出 JSON 后本地解析（cmd.exe 下 shell 无法用单引号 jq）
    const j = JSON.parse(run(`"${GH}" api repos/zbsph/dsh-ppt-studio/releases/tags/${tag}`))
    const a = (j.assets ?? []).find((x) => x.name === stampedName)
    return a?.digest ? a.digest.replace(/^sha256:/, '') : ''
  } catch { return '' }
}
let remote = ''
if (local) {
  console.log('③④ --local：**跳过 GitHub 比对/上传**（本地迭代模式；发版时跑不带 --local 的那条）')
} else {
  remote = remoteDigest()
  console.log(`③ remote asset digest=${remote || '（未读取到，尝试同步）'}`)
  if (remote !== tgzSha) {
    if (noUpload) {
      console.error(`✗ 本地与远程不一致且 --no-upload：本地 ${tgzSha} ≠ 远程 ${remote || '无'}——请先上传`)
      process.exit(1)
    }
    console.log(`④ 上传（${stampedName}）...`)
    run(`"${GH}" release upload ${tag} "${stampedPath}" --clobber`)
    for (let i = 0; i < 6; i++) {
      const until = new Date(Date.now() + 4000)
      while (new Date() < until) {} // 等 CDN 生效（无 sleep 依赖）
      remote = remoteDigest()
      if (remote === tgzSha) break
    }
    if (remote !== tgzSha) {
      console.error(`✗ 上传后 digest 未收敛：远程 ${remote} ≠ 本地 ${tgzSha}——稍后重试或人工核查`)
      process.exit(1)
    }
    console.log(`    uploaded ✓ remote=${remote}`)
  } else {
    console.log('④ 远程已一致（跳过上传）')
  }
}

// ⑤ 用同一 tgz 部署本机安装根（保持"下载 → 解压 → 安装"的产物完全同源）
console.log(`⑤ 本机部署（${deployRoot}\\package，源=同一 tgz）...`)
rmSync(join(deployRoot, 'package'), { recursive: true, force: true })
mkdirSync(deployRoot, { recursive: true })
run(`tar -xzf "${tgzPath}" -C "${deployRoot}"`)
console.log('    extracted')
const installOut = run(`node "${join(deployRoot, 'package', 'scripts', 'install.mjs')}"`)
console.log(installOut.split('\n').slice(0, 6).join('\n'))

// ⑤b bundle 模式：本机**挂载源**是 pnpm 的快照（`dsh plugin add <URL>`），不再是部署副本被 junction 指向。
//     所以发布后必须用**同一个 GitHub 资产 URL** 重新 add，才能让"本机跑的 == GitHub 上的"在这条路径上继续成立；
//     非 bundle 模式（preset/junction 装法）挂载源就是刚部署的副本，不需要这一步。
const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const profileName = opt('--profile', 'web')
const profilePkgFile = join(dshHome, 'profiles', profileName, 'package.json')
let bundleMode = false
try {
  const pp = JSON.parse(readFileSync(profilePkgFile, 'utf8').replace(/^\uFEFF/, ''))
  bundleMode = Boolean(pp.dependencies?.[pkg.name]) || (pp.dsh?.profile?.bundles ?? []).includes(pkg.name)
} catch { /* 无 profile → 非 bundle */ }
let assetUrl = null
let mountMatch = null
if (bundleMode) {
  const repoUrl = run('git remote get-url origin').trim().replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/')
  assetUrl = local ? null : `${repoUrl}/releases/download/${tag}/${stampedName}`
  // --local 的安装规格 = 稳定构件路径（`dsh plugin add <路径>` 会被 pnpm 记成 `file:...`）。
  const installSpec = local ? artifactPath : assetUrl
  const installedPkgDir = join(dshHome, 'profiles', profileName, 'node_modules', ...pkg.name.split('/'))
  // 构建戳文件名 ⇒ 规格每次都不同 ⇒ 包管理器必然重新解析（不必再赌 --force）；
  // 仍然**用内容比对自证**（部署副本 vs 挂载副本），不一致就改走 remove+add，最后报警并给手工命令。
  const fileSha = (p) => (existsSync(p) ? sha(readFileSync(p)) : null)
  const probeRels = [join('lib', 'index.js'), join('package.json'), 'cordis.patch.yml']
  const contentMatch = () => probeRels.every((rel) => {
    const a = fileSha(join(deployRoot, 'package', rel))
    const b = fileSha(join(installedPkgDir, rel))
    return a && b && a === b
  })
  console.log(local
    ? `⑤b bundle 模式：按**本地 tgz 的 file: 规格**重装 profile（挂载源 = 本地刚构建的字节，不经 GitHub）...\n    ${installSpec}`
    : `⑤b bundle 模式：按 GitHub 资产 URL 重新安装到 profile（挂载源 = pnpm 快照）...\n    ${installSpec}`)
  try {
    run(`dsh plugin --profile ${profileName} add "${installSpec}"`)
    if (!contentMatch()) {
      console.log('    内容与部署副本不一致 → remove + add 强制重取...')
      try { run(`dsh plugin --profile ${profileName} remove ${pkg.name}`) } catch { /* 可能本就不在 */ }
      run(`dsh plugin --profile ${profileName} add "${installSpec}"`)
    }
    mountMatch = contentMatch()
    console.log(mountMatch
      ? '    已重新 add ✓ 且**挂载副本与部署副本逐文件同源**（lib/index.js · package.json · cordis.patch.yml）'
      : '    ⚠ 挂载副本与部署副本仍不一致——手工执行：dsh plugin --profile ' + profileName + ' remove ' + pkg.name + ' && dsh plugin --profile ' + profileName + ' add "' + installSpec + '"')
  } catch (e) {
    mountMatch = false
    console.log(`    ⚠ 重新 add 失败（不影响部署副本与字节级校验）：${String(e.stdout ?? e.message ?? e).slice(0, 200)}`)
    console.log('      手动执行：dsh plugin --profile ' + profileName + ' add "' + installSpec + '"')
  }
} else {
  console.log('⑤b 非 bundle 模式（preset/junction 装法）：挂载源就是刚部署的副本，install.mjs 已同步，无需 add')
}

// ⑥ 终验
const localSha = sha(readFileSync(tgzPath))
const artifactSha = sha(readFileSync(artifactPath))
const deployOk = existsSync(join(deployRoot, 'package', 'lib', 'index.js'))
const prev = (() => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return {} } })()
let remoteFinal = null
let ok
let verdict
if (local) {
  // 本地模式的判据**不是**"== GitHub"，而是"**本机跑的 == 刚构建的字节**"：
  //   mountMatch 已在 ⑤b 用逐文件 sha256 自证（lib/index.js · package.json · cordis.patch.yml）。
  //   ——这一点必须写清楚：本地模式**故意**放弃"机器 == GitHub"这条不变量，换取不发版也能迭代；
  //   代价是发版前两者可以不同，所以发版模式（默认）仍然做三向校验，且状态文件用 mode 字段区分。
  ok = mountMatch === true && deployOk && artifactSha === localSha
  verdict = ok
    ? '✅ LOCAL ✓ 本机跑的 == 本地刚构建的字节（本轮未发 GitHub）'
    : '❌ LOCAL 失败'
} else {
  remoteFinal = remoteDigest()
  ok = localSha === remoteFinal && deployOk
  verdict = ok ? '✅ SYNC ✓ 机器 == GitHub（字节级）' : '❌ SYNC 失败'
}

// 清理旧的本地构件：构建戳让每个构建都产一个新文件（每个约 30MB），不清理会一直堆。
// **只在已确认"挂载源就是本次构件"时才清理**（local && mountMatch），并且永远保留本次构件——
// 它正是 profile 当前 `file:` 规格指向的文件，删掉它下次 pnpm install 会直接失败。
let pruned = 0
if (local && mountMatch === true) {
  try {
    for (const f of readdirSync(artifactDir)) {
      if (!f.endsWith('.tgz')) continue
      const p = join(artifactDir, f)
      if (p === artifactPath) continue
      try { rmSync(p, { force: true }); pruned++ } catch { /* 被占用就算了，不值得让同步失败 */ }
    }
  } catch { /* 目录读不了就算了 */ }
}

const state = {
  version: pkg.version,
  tag,
  mode: local ? 'local' : 'release',
  assetSha: localSha,
  // 本地模式保留**上一次发版时**的 remoteSha（信息用途：本机比 GitHub 新多少），
  // 绝不把"未上传"伪装成"已同步"——这正是本地模式唯一新增的风险，必须让它可读。
  remoteSha: local ? (prev.remoteSha ?? null) : remoteFinal,
  lastReleaseAt: local ? (prev.lastReleaseAt ?? prev.at ?? null) : new Date().toISOString(),
  mount: bundleMode ? (local ? 'bundle-local' : 'bundle') : 'preset-junction',
  mountMatch,
  assetUrl,
  localTgz: local ? artifactPath : (prev.localTgz ?? null),
  at: new Date().toISOString(),
  ok,
}
writeFileSync(stateFile, JSON.stringify(state, null, 2))
console.log(`\n${verdict}：${localSha}`)
if (local) {
  console.log(`   安装规格：file:${artifactPath}`)
  console.log(`   GitHub 侧：**本轮未上传**（remoteSha ${state.remoteSha ? '= ' + state.remoteSha + '（上一次发版的值）' : '未知'}）`)
  if (pruned) console.log(`   已清理 ${pruned} 个旧本地构件`)
  console.log('   生效：**重启 dsh web**（profile bundle 挂载不热更）')
} else {
  console.log(remoteFinal ? '   remote: ' + remoteFinal : '   remote: 无法确认')
}
console.log(`   .sync-state.json → ${stateFile}`)
rmSync(packDir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
