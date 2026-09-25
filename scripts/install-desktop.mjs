#!/usr/bin/env node
/**
 * dsh-ppt-studio 桌面端安装器（DSH Electron 应用）
 *
 * ── 为什么需要单独一个安装器（2026-09-26 实测，两条都是硬事实）──────────────────────
 * ① **独立 CLI 拒绝桌面 profile**：`@deepseek-ai/dsh` 的 `lib/bin.js` 写死了
 *      if (profile.toLowerCase() === "desktop") program.error('profile "desktop" is managed exclusively by the Electron application')
 *    启动与 `plugin` 两条路都过这道守卫，且**没有环境变量旁路**
 *    ⇒ README 那条 `dsh plugin --profile desktop add <URL>` 在桌面端一定失败。
 * ② **桌面端自带的 pnpm 装不了 tarball URL**：应用内置 pnpm 11.7.0 + Electron 的 Node 24.18.1，
 *    而它的 profile 用 `nodeLinker: hoisted`。hoisted 下 `pnpm add <https…tgz>` 会失败：
 *      [ERR_PNPM_MISSING_TARBALL_INTEGRITY] … its lockfile entry has no "integrity" field
 *    隔离复现：同一份 pnpm/工作区，**去掉 nodeLinker** 就成功；**换 pnpm 11.21** 也成功。
 *    ⇒ 这是 pnpm 11.7 在 hoisted + tarball-URL 组合上的缺陷，不是本插件的代码问题；
 *      但它让"用发布资产 URL 装"这条**我们唯一公开的安装通道**在桌面端直接不可用。
 *
 * ── 本脚本怎么做 ────────────────────────────────────────────────────────────────
 *   1) 只用**应用自带的 pnpm/Node**（`resources/runtime/…`）——和应用的插件管理器同一套工具链，
 *      避免用系统 Node 重编 profile 里的原生模块（cpu-features / ssh2 等）；
 *   2) **默认把本包打成一个 tgz 放进 profile 内的 `.dsh-plugins/`，再以相对 `file:` 规格安装**。
 *      理由：`file:` 由 pnpm 本地算 integrity ⇒ 在 hoisted 下实测可用，且 tarball 落在 **profile 内部**，
 *      不会因为外部目录（解压目录 / `_artifacts`）被删而让桌面端下次 `pnpm install` 失败——
 *      那种悬空依赖会让**应用起不来**，是最糟的失败形状；
 *   3) 显式 `--spec <https…tgz>` 时先按原样试；撞上上面那个 integrity 错误就回退：
 *      有可用系统 pnpm 就用它再试一次（实测它写的锁文件带 `resolution.integrity`，
 *      之后桌面端自带 pnpm 跑 `install` 会 "Already up to date"）；否则下载进 `.dsh-plugins/` 转 `file:`；
 *   4) 全程**先备份** `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`，失败即还原
 *      （应用自己的插件管理器也是这个纪律：失败恢复这几个文件）；
 *   5) 收尾把包名补进 `dsh.profile.bundles`——桌面端启动只认这个列表，装完不补 = 装了不加载。
 *
 * 用法：
 *   node scripts/install-desktop.mjs                       # 默认 DSH_HOME/~/.dsh + profile desktop，规格=本包
 *   node scripts/install-desktop.mjs --spec <URL|tgz|目录>   # 指定安装规格
 *   node scripts/install-desktop.mjs --prefix <DSH_HOME>    # 指定 DSH_HOME（测试/多实例）
 *   node scripts/install-desktop.mjs --app-dir <目录>        # 指定桌面端安装目录（探测失败时）
 *   node scripts/install-desktop.mjs --dry-run              # 只探测并打印计划，不写任何东西
 *   node scripts/install-desktop.mjs --uninstall            # 卸载（摘依赖 + 摘 bundles 条目）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, platform } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const PROFILE = opt('--profile', 'desktop')
const prefix = resolve(opt('--prefix', process.env.DSH_HOME || join(homedir(), '.dsh')))
const profileDir = join(prefix, 'profiles', PROFILE)
const dryRun = args.includes('--dry-run')
const uninstall = args.includes('--uninstall')
const spec = opt('--spec', root)

const say = (s) => console.log(s)
const tail = (out, n = 6) => out.trim().split('\n').slice(-n).join('\n')
const die = (s) => { console.error(`✗ ${s}`); process.exit(1) }
/**
 * 安装期的失败出口：只要已经备份过，就先**还原 profile** 再退出
 * （应用自己的插件管理器也是这个纪律：pnpm 一失败就把 package.json / pnpm-lock.yaml 恢复原状）。
 */
let BACKUP_BOX = null
const dieInstall = (s) => {
  if (BACKUP_BOX !== null && existsSync(BACKUP_BOX)) {
    restoreProfile(profileDir, BACKUP_BOX)
    say('  （已还原 profile 文件）')
  }
  console.error(`✗ ${s}`)
  process.exit(1)
}

// ── 应用目录与内置工具链 ──────────────────────────────────────────────────────
/** 桌面端默认安装位置（探测失败时用 --app-dir 指定）。 */
function defaultAppDirs() {
  const out = []
  if (process.env.DSH_DESKTOP_APP_DIR) out.push(process.env.DSH_DESKTOP_APP_DIR)
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    out.push(join(local, 'Programs', 'DeepSeek Harness'), join(local, 'DeepSeek Harness'))
  } else if (platform() === 'darwin') {
    out.push('/Applications/DeepSeek Harness.app/Contents/Resources')
  } else {
    out.push('/opt/DeepSeek Harness/resources', join(homedir(), '.local/share/DeepSeek Harness/resources'))
  }
  return out
}

/** 定位 resources 目录（含 runtime/pnpm/bin/pnpm.mjs 才算）。 */
function findAppDir() {
  const explicit = opt('--app-dir', null)
  const candidates = explicit ? [resolve(explicit)] : defaultAppDirs()
  for (const c of candidates) for (const r of [join(c, 'resources'), c]) {
    if (existsSync(join(r, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'))) return r
  }
  return null
}

/** 内置工具链：Node 垫片、pnpm 入口、Electron 可执行文件（垫片靠它当 Node 用）。 */
function appToolchain(resourcesDir) {
  const isWin = platform() === 'win32'
  const nodeShim = join(resourcesDir, 'runtime', 'bin', isWin ? 'node.cmd' : 'node')
  const pnpmEntry = join(resourcesDir, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  const appRoot = dirname(resourcesDir)
  const exeCandidates = isWin
    ? [join(appRoot, 'DeepSeek Harness.exe')]
    : [join(dirname(appRoot), 'MacOS', 'DeepSeek Harness'), join(appRoot, 'DeepSeek Harness')]
  return { nodeShim, pnpmEntry, exe: exeCandidates.find((p) => existsSync(p)) ?? null }
}

// ── profile 读写 ─────────────────────────────────────────────────────────────
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const writeJson = (file, obj) => writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')

/** workspace 设置里的 nodeLinker（缺省 = pnpm 的 isolated）。 */
function nodeLinkerOf(dir) {
  const f = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(f)) return 'isolated'
  const m = /^nodeLinker:\s*(\S+)\s*$/m.exec(readFileSync(f, 'utf8'))
  return m ? m[1] : 'isolated'
}

const BACKUP_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
function backupProfile(dir) {
  const box = join(dir, `.dsh-install-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(box, { recursive: true })
  for (const f of BACKUP_FILES) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(box, f))
  return box
}
function restoreProfile(dir, box) {
  for (const f of BACKUP_FILES) if (existsSync(join(box, f))) copyFileSync(join(box, f), join(dir, f))
}

// ── 两套 pnpm ───────────────────────────────────────────────────────────────
// 必须自己引号化：Node 的 `shell: true` **不引号化命令本身**，而桌面端的路径含空格
// （`…\Programs\DeepSeek Harness\resources\runtime\bin\node.cmd`）——实测会退化成
// `'C:\Users\11867\AppData\Local\Programs\DeepSeek' is not recognized`。
const SHQ = (s) => {
  const str = String(s)
  if (!/[\s"']/.test(str)) return str
  return platform() === 'win32' ? `"${str.replace(/"/g, '""')}"` : `'${str.replace(/'/g, `'\\''`)}'`
}
const run = (cmd, cmdArgs, opts = {}) => spawnSync([cmd, ...cmdArgs].map(SHQ).join(' '), { encoding: 'utf8', shell: true, ...opts })

function runAppPnpm(tc, dir, pnpmArgs) {
  const env = { ...process.env }
  if (tc.exe !== null) env.DSH_DESKTOP_NODE_EXECUTABLE = tc.exe
  const r = run(tc.nodeShim, [tc.pnpmEntry, ...pnpmArgs], { cwd: dir, env })
  return { code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

/** 系统 pnpm（桌面端单机用户不一定有）。 */
function systemPnpm() {
  const v = run('pnpm', ['--version'])
  if (v.status !== 0) return null
  return {
    version: String(v.stdout ?? '').trim(),
    run: (dir, pnpmArgs) => {
      const r = run('pnpm', pnpmArgs, { cwd: dir })
      return { code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
    },
  }
}

const INTEGRITY_BUG = /ERR_PNPM_MISSING_TARBALL_INTEGRITY/

/** 在 profile 内的 `.dsh-plugins/` 放一份 tgz，返回相对规格（相对 profile，不依赖任何外部路径）。 */
function stageTarball(tc, dir, fromDir) {
  const box = join(dir, '.dsh-plugins')
  mkdirSync(box, { recursive: true })
  const before = new Set(readdirSync(box))
  // 注意 cwd：`pnpm pack` 打的是**当前目录**这个包，所以要 cd 到源目录，而不是 profile
  const r = runAppPnpm(tc, fromDir, ['pack', '--pack-destination', box])
  if (r.code !== 0) { say(tail(r.out)); dieInstall(`打包失败：${fromDir}`) }
  const fresh = readdirSync(box).filter((f) => f.endsWith('.tgz') && !before.has(f))
  const tgz = fresh.sort().pop() ?? readdirSync(box).filter((f) => f.endsWith('.tgz')).sort().pop()
  if (!tgz) dieInstall('打包后没找到 tgz')
  // 只留当前这一个：历史 tgz 会让 profile 里堆垃圾，也会让"装的是哪一版"说不清
  for (const f of readdirSync(box)) if (f.endsWith('.tgz') && f !== tgz) rmSync(join(box, f), { force: true })
  return { spec: `file:./.dsh-plugins/${tgz}`, tgz }
}

/**
 * 把规格装进 profile。
 * @returns {string} 实际用到的策略（供输出与测试）
 */
function installSpec(tc, dir, theSpec) {
  const isUrl = /^https?:\/\//i.test(theSpec)
  const isDir = existsSync(theSpec) && statSync(theSpec).isDirectory()

  if (isUrl) {
    const first = runAppPnpm(tc, dir, ['add', theSpec])
    if (first.code === 0) return `应用自带 pnpm（URL 规格）`
    if (!INTEGRITY_BUG.test(first.out)) { say(tail(first.out)); dieInstall(`应用自带 pnpm 安装失败（规格 ${theSpec}）`) }
    say('  ⚠ 撞上桌面端自带 pnpm 的已知缺陷（hoisted + tarball URL 缺 integrity），回退…')
    const sys = systemPnpm()
    if (sys !== null) {
      const second = sys.run(dir, ['add', theSpec])
      if (second.code === 0) return `系统 pnpm ${sys.version}（绕开自带 pnpm 的 hoisted+URL 缺陷）`
      say(tail(second.out))
    }
    const cache = join(dir, '.dsh-plugins')
    mkdirSync(cache, { recursive: true })
    const local = join(cache, basename(new URL(theSpec).pathname) || 'plugin.tgz')
    const dl = run(process.execPath, ['--input-type=module', '-e',
      `const {writeFileSync}=await import('node:fs');const r=await fetch(${JSON.stringify(theSpec)});if(!r.ok)throw new Error(String(r.status));writeFileSync(${JSON.stringify(local)},Buffer.from(await r.arrayBuffer()))`])
    if (dl.status !== 0 || !existsSync(local)) { say(tail(String(dl.stderr ?? ''))); dieInstall('下载 tgz 失败（无法走 file: 兜底）') }
    const third = runAppPnpm(tc, dir, ['add', `file:./.dsh-plugins/${basename(local)}`])
    if (third.code !== 0) { say(tail(third.out)); dieInstall('file: 规格兜底也失败') }
    return '应用自带 pnpm + profile 内 file: 兜底'
  }

  // 目录 → 用应用自带 pnpm 打成 tgz 放进 profile；已是 tgz → 直接放进 profile
  let staged
  if (isDir) staged = stageTarball(tc, dir, theSpec)
  else if (/\.tgz$/i.test(theSpec) && existsSync(theSpec)) {
    const box = join(dir, '.dsh-plugins')
    mkdirSync(box, { recursive: true })
    const target = join(box, basename(theSpec))
    copyFileSync(theSpec, target)
    staged = { spec: `file:./.dsh-plugins/${basename(theSpec)}`, tgz: basename(theSpec) }
  } else {
    // 其它形态（git/registry 等）交给 pnpm 自己判断
    const r = runAppPnpm(tc, dir, ['add', theSpec])
    if (r.code !== 0) { say(tail(r.out)); dieInstall(`应用自带 pnpm 安装失败（规格 ${theSpec}）`) }
    return '应用自带 pnpm（原样规格）'
  }
  const r = runAppPnpm(tc, dir, ['add', staged.spec])
  if (r.code !== 0) { say(tail(r.out)); dieInstall(`安装失败（规格 ${staged.spec}）`) }
  return `应用自带 pnpm + profile 内 ${staged.spec}`
}

/** 把包名补进（或从）dsh.profile.bundles——桌面端启动只认这个列表。 */
function reconcileBundles(dir, name, remove = false) {
  const file = join(dir, 'package.json')
  const manifest = readJson(file)
  const list = manifest.dsh?.profile?.bundles ?? []
  const next = remove ? list.filter((n) => n !== name) : (list.includes(name) ? list : [...list, name])
  if (JSON.stringify(next) === JSON.stringify(list)) return false
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  manifest.dsh.profile.bundles = next
  writeJson(file, manifest)
  return true
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
if (!existsSync(profileDir)) {
  die(`桌面 profile 不存在：${profileDir}\n  桌面端至少要启动过一次；或用 --prefix 指定 DSH_HOME`)
}
const appResources = findAppDir()
if (appResources === null) die(`没找到桌面端安装目录（找过：${defaultAppDirs().join(' / ')}）\n  用 --app-dir <应用目录> 指定`)
const tc = appToolchain(appResources)
if (!existsSync(tc.nodeShim) || !existsSync(tc.pnpmEntry)) die(`内置工具链不完整：${appResources}`)

const profilePkgFile = join(profileDir, 'package.json')
const profileName = readJson(profilePkgFile).name ?? '(未知)'
say(`桌面端：${appResources}`)
say(`profile：${profileDir}（${profileName}）`)
say(`内置工具链：${tc.nodeShim}${tc.exe === null ? '（未定位到可执行文件，沿用环境变量）' : ''}`)
say(`nodeLinker：${nodeLinkerOf(profileDir)}`)
if (profileName !== `dsh-profile-${PROFILE}`) say(`  ⚠ profile 名不是 dsh-profile-${PROFILE}——确认这是桌面端的 profile`)

if (uninstall) {
  if (dryRun) { say(`\n（dry-run）将执行：应用自带 pnpm remove ${pkg.name}；并从 dsh.profile.bundles 摘掉它`); process.exit(0) }
  BACKUP_BOX = backupProfile(profileDir)
  const r = runAppPnpm(tc, profileDir, ['remove', pkg.name])
  if (r.code !== 0) { say(tail(r.out)); dieInstall('卸载失败，已还原 profile 文件') }
  reconcileBundles(profileDir, pkg.name, true)
  rmSync(join(profileDir, '.dsh-plugins'), { recursive: true, force: true })
  rmSync(BACKUP_BOX, { recursive: true, force: true })
  say(`\n✅ 已卸载 ${pkg.name}。重启桌面端后生效。`)
  process.exit(0)
}

const isUrl = /^https?:\/\//i.test(spec)
const isDir = existsSync(spec) && statSync(spec).isDirectory()
say(`安装规格：${spec}${spec === resolve(root) ? '（本包目录 → 会先打成 tgz 放进 profile）' : ''}`)
if (dryRun) {
  const plan = isUrl
    ? `应用自带 pnpm 直接装 URL；仅在撞上 hoisted+URL 缺陷时回退${systemPnpm() === null ? '（本机没有系统 pnpm ⇒ 会走 profile 内 file: 兜底）' : ''}`
    : isDir ? '应用自带 pnpm 打包本目录 → 装 profile 内 file: 规格'
      : `应用自带 pnpm 装 ${spec}`
  say(`\n（dry-run）计划：${plan}`)
  say(`（dry-run）随后把 ${pkg.name} 补进 dsh.profile.bundles，并核验 dsh.bundle.patch 在位`)
  process.exit(0)
}

BACKUP_BOX = backupProfile(profileDir)
say(`已备份 profile 文件 → ${BACKUP_BOX}`)
const strategy = installSpec(tc, profileDir, spec)
say(`  ✓ 安装完成（${strategy}）`)

// 校验装到的包 + 补 bundles
const name = pkg.name
const installedDir = join(profileDir, 'node_modules', ...name.split('/'))
if (!existsSync(join(installedDir, 'package.json'))) dieInstall(`装完仍找不到 ${installedDir}——已还原 profile 文件`)
const installed = readJson(join(installedDir, 'package.json'))
const patchRel = installed.dsh?.bundle?.patch
if (typeof patchRel !== 'string' || !existsSync(join(installedDir, patchRel.replace(/^\.\//, '')))) {
  dieInstall('装到的包没有可用的 dsh.bundle.patch——不是 bundle，装了也不会加载（已还原 profile 文件）')
}
const added = reconcileBundles(profileDir, name)
say(`  ✓ ${name}@${installed.version} 已就位；dsh.bundle.patch=${patchRel}${added ? '；已补进 dsh.profile.bundles' : '（bundles 里已有）'}`)
if (installed.dsh?.engines?.dsh) say(`  · 声明 dsh.engines.dsh = ${installed.dsh.engines.dsh}（桌面端 0.1.7-rc.2 满足）`)
rmSync(BACKUP_BOX, { recursive: true, force: true })

say(`
✅ 装好了。**必须重启桌面端**（bundle 层在启动时组合，不热更）。
重启后：新建会话的预设选择器里能看到「PPT 工作室」；
        在会话里调一次 ppt_state，presetDelivery 字段会写明预设声明状态。`)
