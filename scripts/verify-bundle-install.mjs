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
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

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
  check('升级夹具：第二个 tgz 与首个**字节不同**（同版本号、内容不同——模拟"新版发布"）',
    existsSync(tgz2) && sha(tgz2) !== sha(tgz), `tgzA=${sha(tgz)}｜tgzB=${sha(tgz2)}`)

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

  // 7) **非 bundle（预设行 + junction）模式的 --local 自证**（2026-09-18 新增）
  //    用户诉求："只有选「PPT 工作室」预设时才有这些工具/skills，别的预设不受影响"——
  //    那对应的正是**预设行挂载**（会话级），而不是 profile bundle（profile 级、全会话可见）。
  //    本模式此前会让 `release-sync --local` **恒报 ❌**：⑤b 的非 bundle 分支不设 mountMatch（恒 null），
  //    而 ⑥ 的 LOCAL 判据要求 `mountMatch === true` —— 写 --local 时只考虑了 bundle 模式。这条把该模式钉住。
  const home2 = join(work, 'home2')
  mkdirSync(join(home2, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home2, 'profiles', 'web', 'package.json'), '{}', 'utf8')
  // 夹具必须像真实 profile 一样带 yaml：install.mjs 在非 bundle 模式要把 yaml 链到包自己的 node_modules
  // （ESM 按 realpath 解析，profile 级救不了 junction 抽取目录）。真实机器上 dsh 自己就依赖 yaml，
  // 缺它只是**夹具**不真——第一轮就是因此让 install.mjs 直接 exit 1（报错本身是清楚的）。
  const yamlFrom = join(home, 'profiles', 'web', 'node_modules', 'yaml')
  const yamlTo = join(home2, 'profiles', 'web', 'node_modules', 'yaml')
  // 断言数必须与环境无关（否则"跳过"与"通过"又混在一起）：无条件发一条，再按结果决定是否拷贝
  check('非 bundle 夹具：来源 profile 带 yaml（真实 profile 必有；缺了 install.mjs 会直接 exit 1）',
    existsSync(yamlFrom), yamlFrom)
  if (existsSync(yamlFrom)) {
    mkdirSync(dirname(yamlTo), { recursive: true })
    cpSync(yamlFrom, yamlTo, { recursive: true, dereference: true })
  }
  const env2 = { ...process.env, DSH_HOME: home2 }
  const syncRoot2 = join(work, 'sync-root2')
  const syncState2 = join(work, 'sync-state2.json')
  const rel2 = run('node', ['scripts/release-sync.mjs', '--local', '--root', syncRoot2, '--state', syncState2], { env: env2, cwd: root })
  const relOut2 = `${rel2.stdout ?? ''}\n${rel2.stderr ?? ''}`
  check('非 bundle：`release-sync --local` 在 preset+junction 模式下退出码 0（不因挂载模式不同而误报失败）',
    rel2.status === 0, rel2.status === 0 ? 'LOCAL ✓' : relOut2.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 240))
  const st2 = existsSync(syncState2) ? JSON.parse(readFileSync(syncState2, 'utf8')) : {}
  check('非 bundle：状态文件 mount=preset-junction + mountMatch + ok',
    st2.mount === 'preset-junction' && st2.mountMatch === true && st2.ok === true,
    JSON.stringify({ mount: st2.mount, mountMatch: st2.mountMatch, ok: st2.ok }))
  const link2 = join(home2, 'profiles', 'web', 'node_modules', NAME)
  const repoSha3 = sha(join(root, 'lib', 'index.js'))
  const linkSha3 = sha(join(link2, 'lib', 'index.js'))
  check('非 bundle：junction 存在，且**穿过它读到的 lib/index.js** == 仓库刚构建的',
    existsSync(link2) && repoSha3 === linkSha3, `repo=${repoSha3}｜through-junction=${linkSha3}`)
  const preset2 = join(home2, '.agent-presets', 'ppt', 'agent.cordis.yml')
  check('非 bundle：预设**保留**插件行（这正是"只有该预设才有这些工具"的挂载点）',
    existsSync(preset2) && /^-\s*id:\s*ppt-studio$/m.test(readFileSync(preset2, 'utf8')),
    existsSync(preset2) ? '含插件行 ✓' : '预设缺失')
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n==== profile bundle 安装自证：${pass} 通过 / ${fail} 失败 ====`)
process.exit(fail > 0 ? 1 : 0)
