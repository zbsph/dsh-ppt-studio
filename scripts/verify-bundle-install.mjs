/**
 * profile bundle 安装自证（2026-09-14 新增）——回答"能不能用 `dsh plugin add` 装"这个问题的**真机证据**。
 *
 * 做法：**完全隔离**（DSH_HOME 指向临时目录，不碰用户的 profiles）→ 打包本仓库 → 在临时 profile 里跑
 * 真实的 `dsh plugin --profile web add <tgz>` → 断言三件事：
 *   ① profile 的 package.json 里出现本包依赖；
 *   ② `dsh.profile.bundles` **自动**把本包收进层栈（这正是 dsh.bundle.patch 声明的作用）；
 *   ③ `dsh --profile web --dump-config` 的组合树里能看到我们的插件行（id: ppt-studio）；
 *   ④ **升级路径**（2026-09-15 加）：同版本号、内容不同的第二个 tgz 再 add 一次 → 必须真换成新字节，
 *      且依赖规格改指新包、bundles 不丢、dump-config 仍见本行——"以后更新还顺不顺"的可复跑证据。
 *   ⑤ **--local 迭代模式**（2026-09-18 加）：同一个隔离 DSH_HOME 里跑 `release-sync --local` →
 *      断言全程无上传、状态文件 mode=local、profile 规格变成指向本地稳定构件的 `file:`，
 *      且**挂载副本的 lib/index.js 与仓库刚构建的逐字节相同**——"日常迭代不发版，但本机跑的就是最新"的证据。
 *
 * 依赖 `dsh` 与 pnpm 在 PATH 上；缺失则跳过（打印警告，退出码 0，避免把它变成脆弱门禁）。
 * 用法：
 *   node scripts/verify-bundle-install.mjs                 # 自己 npm pack（本地 tgz）
 *   node scripts/verify-bundle-install.mjs <tgz 路径>       # 用指定 tgz
 *   node scripts/verify-bundle-install.mjs <https://…tgz>   # **验"用户会敲的那条命令"**（GitHub 资产 URL）
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, appendFileSync, readdirSync, writeFileSync, lstatSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const NAME = pkg.name

let pass = 0
let fail = 0
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  ok ? pass++ : fail++
}
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts })

// 前置：dsh / pnpm 可用性
const dshV = run('dsh', ['--version'])
if (dshV.status !== 0) {
  console.log('⚠ 跳过：PATH 上没有 `dsh`（本脚本验证的是真实 launcher 行为，必须在装有 DSH 的机器上跑）')
  process.exit(0)
}
const pnpmV = run('pnpm', ['--version'])
if (pnpmV.status !== 0) {
  console.log('⚠ 跳过：PATH 上没有 `pnpm`（`dsh plugin` 是 pnpm 转发器）')
  process.exit(0)
}

const work = join(tmpdir(), `dsh-ppt-bundle-${Date.now()}`)
mkdirSync(work, { recursive: true })
const home = join(work, 'home')
mkdirSync(home, { recursive: true })

try {
  // 1) 安装规格：http(s) URL = 用户会敲的那条命令；路径 = 本地 tgz；都不给就自己打包
  let tgz = process.argv[2]
  const isUrl = typeof tgz === 'string' && /^https?:\/\//.test(tgz)
  if (isUrl) {
    check('使用远端 URL 规格（等价于用户实际执行的命令）', true, tgz)
  } else if (!tgz) {
    const pack = run('npm', ['pack', '--pack-destination', work], { cwd: root })
    const name = (pack.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop()
    tgz = join(work, name)
    check('打包成功（npm pack）', existsSync(tgz), name ?? '(无输出)')
  } else {
    check('使用传入的 tgz', existsSync(tgz), tgz)
  }

  // 2) 隔离 DSH_HOME 下真实安装
  const env = { ...process.env, DSH_HOME: home }
  const add = run('dsh', ['plugin', '--profile', 'web', 'add', tgz], { env, cwd: work })
  const out = `${add.stdout ?? ''}\n${add.stderr ?? ''}`
  check('`dsh plugin --profile web add <tgz>` 退出码 0', add.status === 0, out.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 200))
  check('**没有** "declares no dsh.bundle" 警告（证明 dsh.bundle.patch 被认到）', !/declares no dsh\.bundle/.test(out),
    /declares no dsh\.bundle/.test(out) ? '仍被判为普通依赖（dsh.bundle 声明没生效）' : '已按 bundle 处理')

  // 3) profile 清单：依赖 + bundles 自动入栈
  const profPkg = join(home, 'profiles', 'web', 'package.json')
  check('profile 目录已生成 package.json', existsSync(profPkg), profPkg)
  const prof = existsSync(profPkg) ? JSON.parse(readFileSync(profPkg, 'utf8')) : {}
  const bundles = prof.dsh?.profile?.bundles ?? []
  check('本包已在 profile 依赖里', Boolean(prof.dependencies?.[NAME]), JSON.stringify(prof.dependencies?.[NAME] ?? null))
  check('本包已**自动**进入 dsh.profile.bundles（层栈）', bundles.includes(NAME),
    bundles.length ? `bundles = ${bundles.join(', ')}` : '(bundles 为空)')
  check('包已物化到 profile 的 node_modules', existsSync(join(home, 'profiles', 'web', 'node_modules', NAME, 'cordis.patch.yml')),
    join('node_modules', NAME, 'cordis.patch.yml'))
  // 新鲜度：装到的必须是**当前仓库这一版**（防 pnpm/pnpm store 命中旧缓存，让"验证"变成假通过）
  const installedPkg = join(home, 'profiles', 'web', 'node_modules', NAME, 'package.json')
  const installedHasProbe = existsSync(join(home, 'profiles', 'web', 'node_modules', NAME, 'scripts', 'probe-effect-semantics.mjs'))
  const installedVer = existsSync(installedPkg) ? JSON.parse(readFileSync(installedPkg, 'utf8')).version : null
  check('装到的是当前版本（不是缓存里的旧包：新增的 probe 脚本在位）',
    installedVer === pkg.version && installedHasProbe,
    `安装版本=${installedVer ?? '(缺)'}｜仓库版本=${pkg.version}｜probe 脚本=${installedHasProbe}`)

  // 4) 组合树里能看到我们的行
  const dump = run('dsh', ['--profile', 'web', '--dump-config'], { env, cwd: work })
  const tree = `${dump.stdout ?? ''}\n${dump.stderr ?? ''}`
  check('`dsh --profile web --dump-config` 能跑通', dump.status === 0, `exit=${dump.status}`)
  check('组合树里出现 ppt-studio 插件行（bundle patch 生效）', /ppt-studio/.test(tree),
    (tree.match(/^.*ppt-studio.*$/m) ?? ['(未出现)'])[0].trim().slice(0, 120))

  // 5) **升级路径自证**（2026-09-15：用户问"后续更新还顺不顺"——这条把承诺变成可复跑证据）
  // 形状：同一版本号、内容不同的第二个 tgz（新规格 ⇒ 包管理器必然重新解析，与"资产名带构建戳"同一机制）。
  // 断言三件事：add 成功 / 装到的字节是第二份（真升级，不是缓存复用）/ 升级后装配不丢（依赖规格改指新包、
  // bundles 仍在、dump-config 仍见 ppt-studio 行）。只验"版本号变化"是不够的——历史事故正是"命令成功但字节是旧的"。
  const installedDir = join(home, 'profiles', 'web', 'node_modules', NAME)
  const pkg2 = join(work, 'pkg2')
  cpSync(installedDir, pkg2, { recursive: true, dereference: true })
  const marker = `// upgrade-probe-${Date.now()}`
  appendFileSync(join(pkg2, 'lib', 'index.js'), `\n${marker}\n`)
  // 关键细节（本夹具第一版就栽在这里）：第二个 tgz 必须落在**另一个目录**——否则 npm pack 会覆盖第一个、
  // 路径规格一模一样，pnpm 视为"同一个规格"直接复用 ⇒ 测出来的是"没升级"而不是"升级失败"。
  const up2Dir = join(work, 'up2')
  mkdirSync(up2Dir, { recursive: true })
  const pack2 = run('npm', ['pack', '--pack-destination', up2Dir], { cwd: pkg2 })
  const tgz2 = join(up2Dir, (pack2.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? 'none.tgz')
  const sha = (f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12) : '(缺)')
  // 基线的取法（2026-09-18 修）：`--spec <https URL>` 时第一个"tgz"是 URL，`sha(tgz)` 恒为 '(缺)'，
  // 于是 `sha(tgz2) !== sha(tgz)` **恒真**——断言显示 ✓ 却什么也没证明（"跳过与通过印同一个颜色"的变体）。
  // 修法：URL 规格下把**装到的副本**（未加 marker）原样打一份作为基线——它与该 URL 同源，
  // 已由上面那条"装到的是当前版本 + probe 脚本在位"独立证明。
  let baseSha = sha(tgz)
  if (isUrl) {
    const baseDir = join(work, 'base')
    cpSync(installedDir, baseDir, { recursive: true, dereference: true })
    const basePackDir = join(work, 'base-pack')
    mkdirSync(basePackDir, { recursive: true })
    const bp = run('npm', ['pack', '--pack-destination', basePackDir], { cwd: baseDir })
    const bpName = (bp.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? 'none.tgz'
    baseSha = sha(join(basePackDir, bpName))
  }
  check('升级夹具：第二个 tgz 与首个**字节不同**（同版本号、内容不同——模拟"新版发布"）',
    existsSync(tgz2) && baseSha !== '(缺)' && sha(tgz2) !== baseSha, `tgzA=${baseSha}｜tgzB=${sha(tgz2)}`)

  const up = run('dsh', ['plugin', '--profile', 'web', 'add', tgz2], { env, cwd: work })
  const upOut = `${up.stdout ?? ''}\n${up.stderr ?? ''}`
  check('升级：对新规格再跑一次 `dsh plugin --profile web add` 退出码 0', up.status === 0,
    upOut.trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 160))
  const upgradedSrc = existsSync(join(installedDir, 'lib', 'index.js')) ? readFileSync(join(installedDir, 'lib', 'index.js'), 'utf8') : ''
  check('升级：装到的字节真是新版（marker 在位）——不是"命令成功但内容还是旧的"',
    upgradedSrc.includes(marker), upgradedSrc.includes(marker) ? 'marker 命中' : '仍是旧字节（升级没生效）')
  const prof2 = existsSync(profPkg) ? JSON.parse(readFileSync(profPkg, 'utf8')) : {}
  const spec2 = String(prof2.dependencies?.[NAME] ?? '')
  const bundles2 = prof2.dsh?.profile?.bundles ?? []
  const dump2 = run('dsh', ['--profile', 'web', '--dump-config'], { env, cwd: work })
  check('升级后装配不丢：依赖规格已改指新 tgz + bundles 仍含本包 + dump-config 仍见 ppt-studio 行',
    spec2.includes('tgz') && bundles2.includes(NAME) && /ppt-studio/.test(`${dump2.stdout ?? ''}${dump2.stderr ?? ''}`),
    `spec=${spec2}｜bundles含=${bundles2.includes(NAME)}｜dump=${/ppt-studio/.test(`${dump2.stdout ?? ''}${dump2.stderr ?? ''}`)}`)

  // 6) **--local 迭代模式自证**（2026-09-18）：日常迭代不发 GitHub，但本机跑的必须就是刚构建的字节。
  //    形状：复用同一个隔离 DSH_HOME（此刻 profile 已是 bundle 模式）→ 跑 `release-sync --local`
  //    → 断言五件事：退出码 0 / 全程没有上传动作 / 状态文件 mode=local + mountMatch + ok
  //    / profile 规格变成指向**本地稳定构件**的 file: / **挂载副本的 lib/index.js 与仓库刚构建的逐字节相同**。
  //    最后一条才是"本机跑的就是最新"的判据——前四条都可能在"装的其实是旧字节"时仍然为真。
  const syncRoot = join(work, 'sync-root')
  const syncState = join(work, 'sync-state.json')
  const rel = run('node', ['scripts/release-sync.mjs', '--local', '--root', syncRoot, '--state', syncState], { env, cwd: root })
  const relOut = `${rel.stdout ?? ''}\n${rel.stderr ?? ''}`
  check('--local：`release-sync --local` 退出码 0', rel.status === 0, relOut.trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 240))
  check('--local：全程**没有**上传动作（本地迭代不发 GitHub）', !/release upload/.test(relOut),
    /release upload/.test(relOut) ? '出现了 release upload！' : '未上传 ✓')
  const st = existsSync(syncState) ? JSON.parse(readFileSync(syncState, 'utf8')) : {}
  check('--local：状态文件 mode=local + mount=bundle-local + mountMatch + ok',
    st.mode === 'local' && st.mount === 'bundle-local' && st.mountMatch === true && st.ok === true,
    JSON.stringify({ mode: st.mode, mount: st.mount, mountMatch: st.mountMatch, ok: st.ok }))
  const prof3 = existsSync(profPkg) ? JSON.parse(readFileSync(profPkg, 'utf8')) : {}
  const spec3 = String(prof3.dependencies?.[NAME] ?? '')
  check('--local：profile 依赖规格变成指向**本地稳定构件**的 file: 规格',
    spec3.startsWith('file:') && spec3.includes('_artifacts'), spec3)
  // 构件必须落在稳定目录：若还在 tmpdir，下次系统清理临时目录后该 profile 的 pnpm install 会直接失败。
  let artifactFiles = []
  try { artifactFiles = readdirSync(join(syncRoot, '_artifacts')).filter((f) => f.endsWith('.tgz')) } catch { /* 目录缺失即失败 */ }
  check('--local：本地构件落在稳定目录 `_artifacts/`（不是 tmpdir），且恰好保留当前那一个',
    artifactFiles.length === 1, `${join(syncRoot, '_artifacts')} → ${artifactFiles.join(', ') || '(空)'}`)
  const repoSha12 = sha(join(root, 'lib', 'index.js'))
  const mountSha12 = sha(join(installedDir, 'lib', 'index.js'))
  check('--local：**挂载副本 == 仓库刚构建的 lib/index.js**（这才是"本机跑的就是最新"的判据）',
    repoSha12 === mountSha12, `repo=${repoSha12}｜mount=${mountSha12}`)

  // 7) **预设可被选择器列出（不 broken）+ 安装器不再写插件行**（2026-09-18 事故后重写）
  //    事故形状：预设里的插件行按**裸包名**从 `harnessBase`（安装好的 harness 目录）解析，**不是** profile
  //    ⇒ 解析不到 ⇒ 该预设被标 `broken` ⇒ 前端选择器只渲染健康预设
  //    （`presetOptions() = presets.filter(p => p.broken === void 0)`）⇒ **用户根本选不到「PPT 工作室」**，
  //    而 profile 里又没有 bundle ⇒ 两边都没工具。本机会话统计：245 个会话里 `agentPreset=ppt` 的 **0 个**。
  //    这一条用 **DSH 自己的 discovery 代码**（discoverPresets）来判——它就等于"选择器会不会显示它"。
  const home2 = join(work, 'home2')
  const profB = join(home2, 'profiles', 'web')
  mkdirSync(join(profB, 'node_modules', ...NAME.split('/')), { recursive: true })
  // 夹具 = 已按 bundle 安装：依赖里有本包 + 包本体已被 pnpm 物化
  writeFileSync(join(profB, 'package.json'), JSON.stringify({ name: 'p', dependencies: { [NAME]: 'file:x' } }, null, 2), 'utf8')
  writeFileSync(join(profB, 'node_modules', ...NAME.split('/'), 'package.json'),
    JSON.stringify({ name: NAME, version: pkg.version }), 'utf8')
  const env2 = { ...process.env, DSH_HOME: home2 }
  const inst2 = run('node', [join(root, 'scripts', 'install.mjs'), '--prefix', home2], { env: env2 })
  check('安装器：bundle 模式下退出码 0（不再需要 junction/yaml 链接）', inst2.status === 0,
    `${String(inst2.stdout ?? '').trim().split(/\r?\n/).length} 行输出｜exit=${inst2.status}`)
  const preset2 = join(home2, '.agent-presets', 'ppt', 'agent.cordis.yml')
  const presetTxt = existsSync(preset2) ? readFileSync(preset2, 'utf8') : ''
  check('安装器：写出的预设**不含**本包插件行（含行 ⇒ 预设 broken ⇒ 选择器里看不到它）',
    existsSync(preset2) && !/^-\s*id:\s*ppt-studio$/m.test(presetTxt) && !/dsh-ppt-studio plugin row/.test(presetTxt),
    existsSync(preset2) ? '无插件行 ✓' : '预设缺失')
  const link2 = join(profB, 'node_modules', NAME)
  check('安装器：**不**把 pnpm 物化的包目录换成 junction（那条路径归 pnpm 管）',
    existsSync(link2) && lstatSync(link2).isSymbolicLink() === false, `isSymbolicLink=${lstatSync(link2).isSymbolicLink()}`)
  // 用 DSH 自己的 discovery 判"选择器会不会显示"：找不到 DSH 安装时按跳过计（断言总数恒定）
  const dsh = findDsh()
  if (dsh) {
    const { discoverPresets } = await import(pathToFileURL(dsh.lib).href)
    const found = await discoverPresets([{ path: join(home2, '.agent-presets'), trust: 'user' }], dsh.harnessBase)
    const ours = found.find((p) => p.id === 'ppt')
    check('预设健康：DSH 的 discoverPresets 不把「PPT 工作室」判为 broken（= 选择器会列出它）',
      Boolean(ours) && ours.broken === undefined,
      ours ? (ours.broken === undefined ? 'ok（选择器可见）' : `broken: ${String(ours.broken).slice(0, 90)}`) : '未发现该预设')
  } else {
    check('预设健康：DSH 的 discoverPresets 不把「PPT 工作室」判为 broken（= 选择器会列出它）', true, '⚠ 未找到 DSH 安装 → 跳过')
  }
  // 技能泄漏面：`<dshHome>/skills/` 是**文件系统技能根**，对所有会话可见（不限预设）。
  // 默认不镜像，且**清理历史镜像**（否则每次 sync 都会把它装回来）。
  const mirrorDir2 = join(home2, 'skills', 'ppt-studio-manual')
  check('会话隔离：默认**不**把内置技能镜像到 <dshHome>/skills（镜像 = 跨预设泄漏）',
    !existsSync(mirrorDir2), mirrorDir2)
  const mir = run('node', [join(root, 'scripts', 'install.mjs'), '--prefix', home2, '--mirror-skills'], { env: env2 })
  check('会话隔离：显式 `--mirror-skills` 才产生镜像（兜底通道按需，不默认泄漏）',
    mir.status === 0 && existsSync(mirrorDir2), `exit=${mir.status}｜镜像存在=${existsSync(mirrorDir2)}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

/**
 * 定位随包安装的 DSH：`@deepseek-ai/dsh-agent-presets/lib/index.js` 与它的 **harness base**。
 * harnessBase 必须是 **harness 包目录本身**（`<global>/@deepseek-ai/dsh/`）——预设里的裸包名正是从这里解析；
 * 用错基准（全局根 / profile / 预设目录）会对**别的**行误报 broken，让本检查变成假红或假绿。
 */
function findDsh() {
  const rel = join('@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'lib', 'index.js')
  const roots = []
  try {
    const r = run('npm', ['root', '-g'])
    if (r.status === 0 && r.stdout) roots.push(r.stdout.trim())
  } catch { /* npm 不可用 */ }
  for (const k of ['APPDATA', 'LOCALAPPDATA']) if (process.env[k]) roots.push(join(process.env[k], 'npm', 'node_modules'))
  roots.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'))
  roots.push('/usr/lib/node_modules', '/usr/local/lib/node_modules')
  for (const r of roots) {
    if (!r) continue
    const lib = join(r, rel)
    if (existsSync(lib)) return { lib, harnessBase: pathToFileURL(join(r, '@deepseek-ai', 'dsh') + '/').href }
  }
  return null
}

console.log(`\n==== profile bundle 安装自证：${pass} 通过 / ${fail} 失败 ====`)
process.exit(fail > 0 ? 1 : 0)
