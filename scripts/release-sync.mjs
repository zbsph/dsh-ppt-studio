#!/usr/bin/env node
/**
 * release-sync.mjs —— 一条命令完成"构建 + 本机同步"，两种模式：
 *
 * **--local（日常迭代，推荐）**：不发 GitHub，本机跑的就是刚构建的字节。
 *   ① build → ② pack（带构建戳）→ ③ **跳过 GitHub 比对/上传** → ④ 同一 tgz 部署本机安装根 + 重跑 install.mjs
 *   → ⑤ 用**本地 tgz 的 `file:` 规格**把同一份字节装进 profile → ⑥ 终验 + 写 .sync-state.json
 *
 * **发版（默认）**：机器 == GitHub 字节级一致。
 *   ⓪b **git 前置**（2026-09-18 加）：本地必须全部推上去了，且 tag 必须**正好指向 HEAD**——
 *      否则用户从仓库 URL 装到的是旧代码（v1.0.1 就是这么发的：`gh release create` 按默认分支 HEAD
 *      把 tag 建在了旧提交上，而资产 sha 校验全绿）。
 *   ① build → ② pack → ③ sha256 比对/上传（--clobber，幂等）→ ④ 同一 tgz 部署本机安装根
 *   → ⑤ 按 **GitHub 资产 URL** 重装 profile → ⑥ 终验三方一致 + 写 .sync-state.json
 *   → ⑦ **发版终验**：`verify-fresh-install`（干净克隆 + 一条命令安装，"用户能不能用"的机器判据；
 *      `--skip-fresh` 可跳过，但状态文件里会留 `freshInstall: null`，不伪装成验过）。
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
 *   node scripts/release-sync.mjs --skip-fresh                    # 发版但跳过"用户视角"终验（留痕：freshInstall=null）
 *   可选：[--tag v1.0.0] [--root D:\plugins] [--profile web] [--no-upload] [--state <路径>]
 *
 * 回退到 GitHub 版本：`dsh plugin --profile web add <Releases 页面的资产 URL>`（发版模式做的就是这件事）。
 */
import { execSync, spawnSync } from 'node:child_process'
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
// 发版终验可以显式跳过（离线、CI 里只想要资产一致性时）——但**跳过必须留痕**：
// 状态文件里 freshInstall=null 而不是 true，免得"没验"被读成"验过了"。
const skipFresh = args.includes('--skip-fresh')
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

// ── ⓪b 发版模式的前置：**本地全部推上去了吗？tag 指向的是这一提交吗？**────────────────
// 为什么必须在这里拦（2026-09-18 实测事故）：发布 v1.0.1 时本地有 14 个提交没推，`gh release create`
// 于是**按默认分支 HEAD** 把 tag 建在旧提交上——"发布成功"，而 GitHub 上是 v1.0.0 的代码：
// 用户照创意工坊卡片跑 `dsh plugin add <仓库 URL>` 拿到的是旧版（没有会话隔离、没有 8 项修复）。
// 更糟的是 ①②③④⑤⑥ 全都照常通过——它们只比对**资产** sha，一步都没看 git。
// 旧的 `gitFreshness()` 只在 --local 分支里跑，发版分支完全没有 git 检查，所以这个洞一直存在。
if (!local) {
  const branch = run('git rev-parse --abbrev-ref HEAD').trim()
  let ahead = null
  let behind = null
  try {
    run('git fetch --quiet origin')
    ahead = Number(run(`git rev-list --count origin/${branch}..HEAD`).trim())
    behind = Number(run(`git rev-list --count HEAD..origin/${branch}`).trim())
  } catch {
    console.log('⓪b git：无法比对远端（离线或 fetch 失败）——**未能确认**本地是否落后/未推送')
  }
  if (ahead !== null) {
    console.log(`⓪b git：${branch} 未推送 ${ahead} 个提交｜落后 ${behind} 个`)
    if (ahead > 0) {
      console.error(`✗ 本地有 **${ahead} 个提交没推**——用户从仓库 URL 安装拿到的是 origin 上的旧代码，`
        + `而资产是本地的字节：两条安装路径从此分叉，且**没有任何症状**。请先 \`git push origin ${branch}\`：`)
      for (const l of run(`git log --oneline origin/${branch}..HEAD`).split('\n').filter(Boolean).slice(0, 10)) {
        console.error(`    · ${l}`)
      }
      process.exit(1)
    }
    if (behind > 0) {
      console.error(`✗ 本地落后 origin/${branch} ${behind} 个提交——发版等于把别人的提交顶掉。先 \`git pull\`。`)
      process.exit(1)
    }
  }
  // tag 必须**正好指向 HEAD**：`gh release create` 不指定 --target 时会按默认分支 HEAD 建 tag，
  // 与"我要发布的提交"无关。这条把"发布目标 == 发布内容"钉死。
  const head = run('git rev-parse HEAD').trim()
  const lsTag = run(`git ls-remote --tags origin refs/tags/${tag}`).trim()
  const remoteTagSha = lsTag ? lsTag.split(/\s+/)[0] : ''
  if (!remoteTagSha) {
    console.error(`✗ 远端还没有 tag ${tag}——` + '`gh release create` 不指定 --target 会**按默认分支 HEAD** 建 tag，'
      + `本地没推时它就把 tag 建在旧提交上。请显式指定目标提交：\n`
      + `    gh release create ${tag} --target ${head} --title "..." --notes-file ...\n`
      + `  然后重跑本命令（本命令负责上传/校验资产）。`)
    process.exit(1)
  }
  if (remoteTagSha !== head) {
    console.error(`✗ tag ${tag} 指向 ${remoteTagSha.slice(0, 10)}，而本地 HEAD 是 ${head.slice(0, 10)}——`
      + `"发布目标"与"发布内容"不是同一个提交（这正是 v1.0.1 那次的事故形状）。修正：\n`
      + `    git push --force origin refs/tags/${tag}     # 或删掉重建：gh release delete ${tag} 后按上面那条重建`)
    process.exit(1)
  }
  console.log(`⓪b git：tag ${tag} == HEAD（${head.slice(0, 10)}）✓ 分支已推 ✓`)
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
  // 非 bundle 模式（**预设行 + junction**）：挂载源 = install.mjs 建的那条 junction → 部署副本。
  // 判据同样是"逐文件 sha256"，只是要比的是**穿过 junction 读到的字节**。
  // 【2026-09-18 修】此前这一支不设 mountMatch（恒为 null），而 ⑥ 的 LOCAL 判据要求 `mountMatch === true`
  // ⇒ 在本模式下 `--local` **恒定报 ❌**。写 `--local` 时只考虑了 bundle 模式，这是本模式的实际缺陷。
  // 【同日再修】`--isolate` 模式的 link 在**预设目录**里（`.agent-presets/ppt/plugin`），不在 profile；
  // 两处都看，先预设后 profile——否则隔离用户的 `npm run sync -- --local` 会被误报"未找到挂载链接"。
  const fileSha2 = (p) => (existsSync(p) ? sha(readFileSync(p)) : null)
  const probeRels2 = [join('lib', 'index.js'), join('package.json'), 'cordis.patch.yml']
  const candidates = [
    { dir: join(dshHome, '.agent-presets', 'ppt', 'plugin'), label: '预设内 junction（--isolate 模式）' },
    { dir: join(dshHome, 'profiles', profileName, 'node_modules', ...pkg.name.split('/')), label: 'profile junction（旧装法）' },
  ]
  const hit = candidates.find((c) => existsSync(c.dir))
  if (hit) {
    mountMatch = probeRels2.every((rel) => {
      const a = fileSha2(join(deployRoot, 'package', rel))
      const b = fileSha2(join(hit.dir, rel))
      return a && b && a === b
    })
    console.log(`⑤b 非 bundle 模式：挂载源 = 刚部署的副本（${hit.label}）\n    **穿过 junction** 逐文件 sha256 自证：${mountMatch ? '与部署副本同源 ✓' : '与部署副本不一致 ⚠'}（lib/index.js · package.json · cordis.patch.yml）`)
    if (!mountMatch) console.log(`    ⚠ 不一致 → 重跑安装器重建链接：node "${join(deployRoot, 'package', 'scripts', 'install.mjs')}" --isolate`)
  } else {
    mountMatch = false
    console.log(`⑤b 非 bundle 模式：**未找到挂载链接**（预设内 ${join(dshHome, '.agent-presets', 'ppt', 'plugin')} / profile ${join(dshHome, 'profiles', profileName, 'node_modules', ...pkg.name.split('/'))} 都不存在）——请先跑 node "${join(deployRoot, 'package', 'scripts', 'install.mjs')}" --isolate`)
  }
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
  //   mountMatch 已在 ⑤b 用逐文件 sha256 自证——两种挂载模式都要证（bundle=pnpm 快照；
  //   非 bundle=穿过 junction 读部署副本）。两种模式下它都必须为 true，否则这里报 ❌。
  //   ——本地模式**故意**放弃"机器 == GitHub"这条不变量，换取不发版也能迭代；
  //   代价是发版前两者可以不同，所以发版模式（默认）仍做三向校验，状态文件用 mode 区分。
  ok = mountMatch === true && deployOk && artifactSha === localSha
  verdict = ok
    ? `✅ LOCAL ✓ 本机跑的 == 本地刚构建的字节（${bundleMode ? 'bundle' : 'preset-junction'} 挂载，本轮未发 GitHub）`
    : `❌ LOCAL 失败（挂载模式 ${bundleMode ? 'bundle' : 'preset-junction'}：mountMatch=${mountMatch}｜部署副本=${deployOk}｜构件一致=${artifactSha === localSha}）`
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

// ⑦ 发版终验：**用户视角**的"一条命令装好并用起来"（2026-09-18 新增）
// 为什么放在最后而不是最前：前面 ①~⑥ 证明的是"我构建的字节与上传的资产一致"，这一条证明的是
// **用户能不能照指引装好并用起来**——两件事事实上不同（v1.0.1 那次：资产 sha 完全一致，而 GitHub 上的
// 仓库/tag 指的是旧代码；干净克隆里 npm test 还会因 CRLF 检出直接崩）。
// 为什么失败只报 ❌ 不回滚：资产已经上传了，静默"回滚"会让 Release 页面与本地状态更难对齐；
// 正确做法是把判据写进状态文件并**让退出码为 1**，让"没验过"和"验过且通过"永远可区分。
let freshInstall = null
if (local) {
  console.log('\n⑦ 本地模式：跳过发版终验（用户视角的安装自证只在发版时跑）')
} else if (skipFresh) {
  console.log('\n⑦ ⚠ 已按 --skip-fresh 跳过发版终验——"用户能不能一条命令装好"**本轮未证明**（状态文件里 freshInstall=null）')
} else if (!ok) {
  console.log('\n⑦ 资产一致性未通过，跳过发版终验（先修上面的 ❌）')
} else {
  console.log('\n⑦ 发版终验：干净克隆 + 一条命令安装（verify-fresh-install）...\n')
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'verify-fresh-install.mjs')], { cwd: root, stdio: 'inherit' })
  freshInstall = r.status === 0
  if (!freshInstall) {
    console.log('\n✗ 发版终验失败：资产已上传且字节一致，但"用户照指引能不能装好并用起来"**没被证明**——')
    console.log('   逐条看上面每个 ✗（每条都写明"看到什么 / 为什么重要"）。修完重跑本命令即可。')
  }
}
const okFinal = ok && freshInstall !== false

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
  // 三态：true=验过且通过｜false=验过且失败｜null=没验（--local / --skip-fresh）
  freshInstall,
  at: new Date().toISOString(),
  ok: okFinal,
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
  console.log(freshInstall === true
    ? '   用户视角终验：✅ 干净克隆 npm test 全绿 + 一条命令安装自证通过（freshInstall=true）'
    : freshInstall === false
      ? '   用户视角终验：❌ **未通过**（freshInstall=false）——见上面 ⑦'
      : '   用户视角终验：⚠ **本轮未跑**（freshInstall=null）——"能不能装好"未证明')
}
console.log(`   .sync-state.json → ${stateFile}`)
rmSync(packDir, { recursive: true, force: true })
process.exit(okFinal ? 0 : 1)
