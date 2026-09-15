#!/usr/bin/env node
/**
 * release-sync.mjs —— 一次命令完成"发布 + 本机同步"（机器 == GitHub 字节级一致）：
 *   ① build（src → lib）
 *   ② npm pack → tgz（临时）
 *   ③ 计算 tgz sha256 ↔ 读 GitHub Release 资产 digest
 *   ④ 不一致 → gh release upload --clobber → 轮询至一致（一致则跳过上传，幂等）
 *   ⑤ 用**同一个 tgz** 部署本机安装根（默认 D:\plugins\package）+ 重跑 install.mjs（幂等）
 *   ⑥ 终验：本机安装包的源 tgz sha256 == 远程资产 sha256 → 打印 SYNC ✓ 并写 .sync-state.json
 *
 * 用法：node scripts/release-sync.mjs [--tag v1.0.0] [--root D:\plugins] [--no-upload]
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
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

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const run = (cmdStr) => execSync(cmdStr, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// ① build
console.log('① build ...')
run('node scripts/build.mjs')
console.log('    done')

// ② pack
const packDir = join(tmpdir(), 'pptsync-' + Date.now())
mkdirSync(packDir, { recursive: true })
const tgzOutput = run(`npm pack --pack-destination "${packDir}"`).split('\n').pop()
const tgzPath = join(packDir, tgzOutput)
const tgzSha = sha(readFileSync(tgzPath))
console.log(`② packed ${tgzOutput} (${Math.round(statSync(tgzPath).size / 1024 / 1024 * 10) / 10}MB)\n   local sha256=${tgzSha}`)

// ③④ 远程 digest 比对/上传
const remoteDigest = () => {
  try {
    // REST 输出 JSON 后本地解析（cmd.exe 下 shell 无法用单引号 jq）
    const j = JSON.parse(run(`"${GH}" api repos/zbsph/dsh-ppt-studio/releases/tags/${tag}`))
    const a = (j.assets ?? []).find((x) => x.name.endsWith('.tgz'))
    return a?.digest ? a.digest.replace(/^sha256:/, '') : ''
  } catch { return '' }
}
let remote = remoteDigest()
console.log(`③ remote asset digest=${remote || '（未读取到，尝试同步）'}`)
if (remote !== tgzSha) {
  if (noUpload) {
    console.error(`✗ 本地与远程不一致且 --no-upload：本地 ${tgzSha} ≠ 远程 ${remote || '无'}——请先上传`)
    process.exit(1)
  }
  console.log('④ 上传（--clobber）...')
  run(`"${GH}" release upload ${tag} "${tgzPath}" --clobber`)
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
  assetUrl = `${repoUrl}/releases/download/${tag}/${tgzOutput}`
  const installedPkgDir = join(dshHome, 'profiles', profileName, 'node_modules', ...pkg.name.split('/'))
  // 同一 URL 覆盖内容时 pnpm 可能判定"已满足"而不重新下载 → 用 --force 强制重取；
  // 然后**用内容比对自证**（部署副本 vs 挂载副本），不一致就报警并给出手工命令。
  const fileSha = (p) => (existsSync(p) ? sha(readFileSync(p)) : null)
  const probeRels = [join('lib', 'index.js'), join('package.json'), 'cordis.patch.yml']
  const contentMatch = () => probeRels.every((rel) => {
    const a = fileSha(join(deployRoot, 'package', rel))
    const b = fileSha(join(installedPkgDir, rel))
    return a && b && a === b
  })
  console.log(`⑤b bundle 模式：按 GitHub 资产 URL 重新安装到 profile（挂载源 = pnpm 快照）...\n    ${assetUrl}`)
  try {
    run(`dsh plugin --profile ${profileName} add "${assetUrl}"`)
    if (!contentMatch()) {
      console.log('    内容与部署副本不一致（同 URL 覆盖内容时 pnpm 会走缓存）→ --force 重取...')
      run(`dsh plugin --profile ${profileName} add "${assetUrl}" --force`)
    }
    mountMatch = contentMatch()
    console.log(mountMatch
      ? '    已重新 add ✓ 且**挂载副本与部署副本逐文件同源**（lib/index.js · package.json · cordis.patch.yml）'
      : '    ⚠ 挂载副本与部署副本仍不一致——手工执行：dsh plugin --profile ' + profileName + ' remove ' + pkg.name + ' && dsh plugin --profile ' + profileName + ' add "' + assetUrl + '"')
  } catch (e) {
    mountMatch = false
    console.log(`    ⚠ 重新 add 失败（不影响上传与字节级校验）：${String(e.stdout ?? e.message ?? e).slice(0, 200)}`)
    console.log('      手动执行：dsh plugin --profile ' + profileName + ' add "' + assetUrl + '"')
  }
} else {
  console.log('⑤b 非 bundle 模式（preset/junction 装法）：挂载源就是刚部署的副本，install.mjs 已同步，无需 add')
}

// ⑥ 终验：本机源 tgz 与远程一致 + 安装完整性
const localSha = sha(readFileSync(tgzPath))
const remoteFinal = remoteDigest()
const ok = localSha === remoteFinal && existsSync(join(deployRoot, 'package', 'lib', 'index.js'))
const state = { version: pkg.version, tag, assetSha: localSha, remoteSha: remoteFinal, mount: bundleMode ? 'bundle' : 'preset-junction', mountMatch, assetUrl, at: new Date().toISOString(), ok }
writeFileSync(join(root, '.sync-state.json'), JSON.stringify(state, null, 2))
console.log(`\n${ok ? '✅ SYNC ✓ 机器 == GitHub（字节级）' : '❌ SYNC 失败'}：${localSha}\n${remoteFinal ? '   remote: ' + remoteFinal : '   remote: 无法确认'}`)
rmSync(packDir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
