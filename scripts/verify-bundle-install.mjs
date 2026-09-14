/**
 * profile bundle 安装自证（2026-09-14 新增）——回答"能不能用 `dsh plugin add` 装"这个问题的**真机证据**。
 *
 * 做法：**完全隔离**（DSH_HOME 指向临时目录，不碰用户的 profiles）→ 打包本仓库 → 在临时 profile 里跑
 * 真实的 `dsh plugin --profile web add <tgz>` → 断言三件事：
 *   ① profile 的 package.json 里出现本包依赖；
 *   ② `dsh.profile.bundles` **自动**把本包收进层栈（这正是 dsh.bundle.patch 声明的作用）；
 *   ③ `dsh --profile web --dump-config` 的组合树里能看到我们的插件行（id: ppt-studio）。
 *
 * 依赖 `dsh` 与 pnpm 在 PATH 上；缺失则跳过（打印警告，退出码 0，避免把它变成脆弱门禁）。
 * 用法：
 *   node scripts/verify-bundle-install.mjs                 # 自己 npm pack（本地 tgz）
 *   node scripts/verify-bundle-install.mjs <tgz 路径>       # 用指定 tgz
 *   node scripts/verify-bundle-install.mjs <https://…tgz>   # **验"用户会敲的那条命令"**（GitHub 资产 URL）
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n==== profile bundle 安装自证：${pass} 通过 / ${fail} 失败 ====`)
process.exit(fail > 0 ? 1 : 0)
