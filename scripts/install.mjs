#!/usr/bin/env node
/**
 * dsh-ppt-studio 一键安装器（随发布包提供——新用户"下载→可用"的最后一步）：
 *   1) 确认本包是 **profile bundle**；不是就**替你装**（`dsh plugin --profile <p> add <规格>`）
 *   2) 校验包在 profile 里可解析（包本体归 pnpm 管，本安装器**不建 junction**）
 *   3) 同步 agent preset（身份/人格/显示元数据）+ 清理历史遗留的插件行块
 * 装完：重启 dsh web → 新建会话时选「PPT 工作室」→ 直接提需求。
 *
 * **为什么只剩 profile bundle 一条路**（2026-09-18 实测事故）：预设里的插件行按裸包名从
 * `harnessBase`（安装好的 harness 目录）解析，**不是** profile；解析不到 ⇒ 预设被标 `broken`
 * ⇒ 前端选择器只列健康预设 ⇒ 用户**根本选不到**该预设，而 profile 里又没 bundle ⇒ 两边都没工具。
 * 详见 agent-presets/ppt/agent.cordis.yml 末尾的说明与 README §10。
 *
 * 用法：
 *   node scripts/install.mjs                    # 默认 DSH_HOME/~/.dsh + profile web
 *   node scripts/install.mjs --spec <URL|路径>   # 用指定安装规格装成 bundle（发布流程会传）
 *   node scripts/install.mjs --prefix <dir>     # 指定 DSH_HOME（测试/多实例）
 *   node scripts/install.mjs --profile <name>   # 指定 profile
 *   node scripts/install.mjs --no-preset        # 只保证 bundle，不装 preset
 */
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ── 参数 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const prefix = resolve(opt('--prefix', process.env.DSH_HOME || join(homedir(), '.dsh')))
const profile = opt('--profile', 'web')
const noPreset = args.includes('--no-preset')
// 技能镜像默认**关闭**（跨预设泄漏，见第 3 步注释）；要给非 PPT 会话留兜底才显式开启。
const mirrorSkills = args.includes('--mirror-skills')

const profileDir = join(prefix, 'profiles', profile)
const pkgDir = join(profileDir, 'node_modules', '@dsh-external', 'dsh-ppt-studio')
const presetDir = join(prefix, '.agent-presets', 'ppt')
const presetFile = join(presetDir, 'agent.cordis.yml')
const builtinPreset = join(root, 'agent-presets', 'ppt', 'agent.cordis.yml')

if (!existsSync(profileDir)) {
  console.error(`✗ profile 不存在：${profileDir}\n  请确认已安装 dsh web（或 --prefix/--profile 正确）`)
  process.exit(1)
}
if (!existsSync(join(root, 'lib', 'index.js'))) {
  console.error(`✗ 当前目录缺少 lib/（发布包应自带；源码模式请先 node scripts/build.mjs）`)
  process.exit(1)
}

const steps = []

// ── 0) 装配模式：**默认「全局」**（profile bundle，`dsh plugin add` 一句话那条路）；
//        想要"只在「PPT 工作室」预设里生效"的用户用 `--isolate`（预设行 + 预设目录内 junction）──
// 两种模式的差别只在"插件被装到哪一层"，**插件自身不门控**（它注册在拿到手的那个 ctx ⇒ 一层实现两用）：
//   · 全局（默认）：`dsh plugin add <包>` 装成 profile bundle ⇒ 插件在 **profile 层** ⇒ 该 profile 的
//     每个会话都能用（含官方 standard）；「PPT 工作室」预设只提供身份/人格。**一句话安装走这条**。
//   · 隔离（`--isolate`）：`<dshHome>/.agent-presets/ppt/plugin` junction → 本包，预设行写成**相对路径**
//     `./plugin/lib/index.js`；相对行按**组合文件自己的目录**解析（本机 liangshen/j-space 等预设正是这么
//     引用自己的 .mjs 的）⇒ 解析得到 ⇒ 预设健康、选择器可见；插件被挂进**预设组合** ⇒ 工具/技能落在
//     **预设层**（技能工具读的正是那一层）⇒ **只有「PPT 工作室」的会话**可用。
// 两条路**互斥**：同时存在时装配防重会让"先挂的"生效（profile 先），隔离永远拿不到预设层 ⇒
// `--isolate` 会先摘掉 profile bundle，全局模式会删掉预设行与预设内 junction。
// **为什么行不能用裸包名**（2026-09-18 实测事故）：裸包名一律从 `harnessBase`（安装好的 harness 目录）解析
// （源码注释："the mount records the host composition's base instead, which is inside the installed harness"），
// 装在 profile/预设里的本包**解析不到** ⇒ 预设被判 `broken` ⇒ 前端选择器只渲染健康预设
// （`presetOptions() = presets.filter(p => p.broken === void 0)`）⇒ 用户根本选不到该预设。
const ISOLATE = args.includes('--isolate')
const ROW_START = '# >>> dsh-ppt-studio plugin row'
const ROW_END = '# <<< dsh-ppt-studio plugin row'
const PRESET_ROW_BLOCK = [
  ROW_START + '（安装器按装配模式增删本块，勿手改标记）',
  '# 隔离模式：预设目录内的 junction + **相对路径**行（相对行按组合文件所在目录解析）。',
  '- id: ppt-studio',
  '  name: ./plugin/lib/index.js',
  ROW_END,
].join('\n')
const profilePkgFile = join(profileDir, 'package.json')
let profilePkg = {}
// 去 BOM 再解析：Windows 上被 PowerShell/记事本编辑过的 JSON 可能带 UTF-8 BOM，JSON.parse 会直接抛
try { profilePkg = JSON.parse(readFileSync(profilePkgFile, 'utf8').replace(/^\uFEFF/, '')) } catch { /* 无/坏 → 视为非 bundle */ }
let bundleInstalled = Boolean(profilePkg.dependencies?.[pkg.name]) || (profilePkg.dsh?.profile?.bundles ?? []).includes(pkg.name)
// 历史遗留的行块（老版本安装器写过）：任何模式下都先清掉，再按模式决定是否写回。
const PRESET_ROW_RE = new RegExp(`^${ROW_START}[\\s\\S]*?^${ROW_END}\\r?\\n?`, 'm')
// 兼容更老的无标记写法（裸包名两行）
const LEGACY_ROW_RE = /^- id: ppt-studio\n  name: '@dsh-external\/dsh-ppt-studio'\n?/m
const presetPluginDir = join(presetDir, 'plugin')

if (ISOLATE) {
  // ① 隔离模式下**不能**同时有 profile bundle（那会让插件在 profile 层也挂一次 ⇒ 全局可见 + 双挂载）
  if (bundleInstalled) {
    steps.push('检测到 profile bundle → 摘掉它（隔离模式要求插件只由预设行挂载）')
    const rm = spawnSync('dsh', ['plugin', '--profile', profile, 'remove', pkg.name], {
      stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, DSH_HOME: prefix },
    })
    if (rm.status !== 0) {
      console.error(`✗ 摘除 profile bundle 失败（dsh 退出码 ${rm.status}）。请手动执行：\n    dsh plugin --profile ${profile} remove ${pkg.name}`)
      process.exit(1)
    }
    try { profilePkg = JSON.parse(readFileSync(profilePkgFile, 'utf8').replace(/^\uFEFF/, '')) } catch { profilePkg = {} }
    bundleInstalled = Boolean(profilePkg.dependencies?.[pkg.name]) || (profilePkg.dsh?.profile?.bundles ?? []).includes(pkg.name)
    if (bundleInstalled) { console.error('✗ 摘除后 profile 里仍有本包——拒绝继续（会出现双挂载）'); process.exit(1) }
  }
  // ② 预设目录内的 junction → 本包（**相对行**靠它解析）
  mkdirSync(presetDir, { recursive: true })
  if (existsSync(presetPluginDir)) rmSync(presetPluginDir, { recursive: true, force: true }) // rmSync 不跟随重解析点
  symlinkSync(root, presetPluginDir, 'junction')
  steps.push(`已建预设内链接：.agent-presets\\ppt\\plugin → ${root}`)
  // ③ 包自身的 yaml 依赖：ESM 按 **realpath** 解析（junction 指向的是 root，profile 级救不了它）
  const pkgYaml = join(root, 'node_modules', 'yaml')
  if (!existsSync(join(pkgYaml, 'package.json'))) {
    const src = join(profileDir, 'node_modules', 'yaml')
    if (!existsSync(join(src, 'package.json'))) {
      console.error(`✗ 找不到 yaml 依赖（${src}）——请先在 profile 里装好依赖（dsh 自身通常已有）`)
      process.exit(1)
    }
    mkdirSync(dirname(pkgYaml), { recursive: true })
    symlinkSync(src, pkgYaml, 'junction')
    steps.push(`yaml 已链接进包：${pkgYaml} → ${src}`)
  }
  steps.push('装配模式：**隔离**（插件只在「PPT 工作室」预设内挂载）')
} else {
  // 全局模式：清掉隔离模式留下的预设内 junction（否则预设会引用一个不再需要的链接）
  if (existsSync(presetPluginDir)) {
    rmSync(presetPluginDir, { recursive: true, force: true })
    steps.push('已清理隔离模式遗留的预设内链接（.agent-presets\\ppt\\plugin）')
  }
  steps.push('装配模式：**全局**（profile bundle：该 profile 的所有会话都能用）')
}

// ── 1) 包本体可达性 ─────────────────────────────────────────────────────────
if (ISOLATE) {
  if (!existsSync(join(presetPluginDir, 'lib', 'index.js'))) {
    console.error(`✗ 预设内链接不可用：${join(presetPluginDir, 'lib', 'index.js')}`)
    process.exit(1)
  }
  steps.push('包可解析：.agent-presets\\ppt\\plugin\\lib\\index.js ✓')
} else {
  if (!bundleInstalled) {
    // 全局模式：确认/建立 profile bundle（包本体交给 pnpm；规格优先级 --spec > 包本目录）
    const spec = opt('--spec', root)
    steps.push(`未检测到 profile bundle → 先装成 bundle：dsh plugin --profile ${profile} add ${spec}`)
    // **必须把 DSH_HOME 传给子进程**：`--prefix` 指的就是 DSH home，不传会让 dsh 去动真实 ~/.dsh
    const r = spawnSync('dsh', ['plugin', '--profile', profile, 'add', spec], {
      stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, DSH_HOME: prefix },
    })
    if (r.status !== 0) {
      console.error(`✗ 安装 profile bundle 失败（dsh 退出码 ${r.status}）。请手动执行：\n    dsh plugin --profile ${profile} add ${spec}`)
      process.exit(1)
    }
    try { profilePkg = JSON.parse(readFileSync(profilePkgFile, 'utf8').replace(/^\uFEFF/, '')) } catch { profilePkg = {} }
    bundleInstalled = Boolean(profilePkg.dependencies?.[pkg.name]) || (profilePkg.dsh?.profile?.bundles ?? []).includes(pkg.name)
    if (!bundleInstalled) { console.error(`✗ dsh 报告成功，但 profile 里仍没有本包（${profilePkgFile}）`); process.exit(1) }
    steps.push(`已装成 profile bundle（${profilePkg.dependencies?.[pkg.name] ?? 'dsh.profile.bundles'}）`)
  } else {
    steps.push(`已确认 profile bundle（${profilePkg.dependencies?.[pkg.name] ?? 'dsh.profile.bundles'}）——包本体归 pnpm 管`)
  }
  if (!existsSync(join(pkgDir, 'package.json'))) {
    console.error(`✗ profile 里找不到本包：${join(pkgDir, 'package.json')}\n  请重跑：dsh plugin --profile ${profile} add ${opt('--spec', root)}`)
    process.exit(1)
  }
}

// ── 3) agent preset（预设 = 会话人格与显示元数据；**插件行按装配路径二选一**）──
// 同步纪律（2026-09-06 用户点出）：预设与元数据是"托管文件"、以包为准**总是刷新**——
// 跳过策略曾导致升级后本机保留旧版（skill 12pt 过期语义事件）。
// 2026-09-14 补充：bundle 模式下**必须删掉插件行块**，否则「dsh plugin 装 + 预设行再挂」= 同进程双挂载
//（插件内有装配防重兜底，但纪律是二选一）；这也是"只手工删一行会被下次同步装回来"的解。
if (!noPreset) {
  if (!existsSync(builtinPreset)) {
    console.error('✗ 本包缺少预设模板 agent-presets/ppt/agent.cordis.yml——发布包应自带')
    process.exit(1)
  }
  {
    mkdirSync(presetDir, { recursive: true })
    let presetText = readFileSync(builtinPreset, 'utf8')
    // 先清掉历史遗留（含老版本的无标记写法），再按装配模式决定是否写回**相对路径行**：
    //   · 隔离模式：写回 `./plugin/lib/index.js`（靠预设目录内的 junction 解析；相对行按组合文件目录解析，
    //     本机 liangshen/j-space 等预设就是这么引用自己的 .mjs 的）；
    //   · 全局模式：不写行（插件由 profile bundle 提供，写了会造成同进程双挂载）。
    presetText = presetText.replace(PRESET_ROW_RE, '').replace(LEGACY_ROW_RE, '')
    if (ISOLATE) {
      presetText = `${presetText.replace(/\s*$/, '')}\n\n${PRESET_ROW_BLOCK}\n`
      steps.push('预设已同步（隔离模式：写入**相对路径**插件行 ./plugin/lib/index.js）')
    } else {
      steps.push('预设已同步（全局模式：**不含**插件行——插件由 profile bundle 提供）')
    }
    writeFileSync(presetFile, presetText, 'utf8')
  }
  // 显示元数据（拣选器显示名/简介）：preset.yml（name/description/order；缺省则只有目录名）
  const metaSrc = join(root, 'agent-presets', 'ppt', 'preset.yml')
  const metaDst = join(presetDir, 'preset.yml')
  if (existsSync(metaSrc)) {
    writeFileSync(metaDst, readFileSync(metaSrc, 'utf8'), 'utf8')
    steps.push(`预设元数据已同步（「PPT 工作室」+ 简介）：${metaDst}`)
  }
}

// ── 4) 内置 skill 文件镜像（**默认关闭**，见下）──────────────────────────────────
// 技能包的**主通道**是插件内嵌注册（lib/skill.js → ctx.skills.register，落 preset 层，随插件同生共死）。
// 把 skills/*/SKILL.md 镜像到 <dshHome>/skills/ **会让该 profile 的所有会话（含官方标准预设）在技能目录里
// 看到它们**——那是"跨预设泄漏"，与"只有选「PPT 工作室」时才有这些技能"直接冲突（2026-09-18 用户报告）。
// 因此改为 **opt-in**：要给非 PPT 会话留"提问即用"的兜底，显式加 `--mirror-skills`。
// 未开启时会**清理历史镜像**——否则早期安装留下的副本会继续泄漏，且此后每次 release-sync 都把它装回来，
// 表现为"改了没生效"的静默问题。
const skillsRoot = join(root, 'skills')
if (!noPreset) {
  if (!existsSync(skillsRoot)) {
    console.warn('⚠ 包内缺少 skills/（此包打包不完整）——内置技能不可用')
  } else {
    const dirs = readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    if (mirrorSkills) {
      const names = []
      for (const name of dirs) {
        const src = join(skillsRoot, name, 'SKILL.md')
        if (!existsSync(src)) continue
        const dstDir = join(prefix, 'skills', name)
        mkdirSync(dstDir, { recursive: true })
        writeFileSync(join(dstDir, 'SKILL.md'), readFileSync(src, 'utf8'), 'utf8')
        names.push(name)
      }
      steps.push(names.length
        ? `内置技能镜像已同步（--mirror-skills 显式开启，共 ${names.length} 本）：${names.join('、')}`
        : '⚠ 包内 skills/ 下没有可用技能')
    } else {
      // 清理历史镜像（fs.rmSync 不跟随重解析点；这些本来就是普通目录）
      let removed = 0
      for (const name of dirs) {
        const dstDir = join(prefix, 'skills', name)
        if (existsSync(dstDir)) { rmSync(dstDir, { recursive: true, force: true }); removed++ }
      }
      steps.push(removed
        ? `内置技能：**已移除 ${removed} 本历史镜像**——技能只在「PPT 工作室」预设内可见（插件内嵌注册）；要给别的会话留兜底请加 --mirror-skills`
        : '内置技能：未镜像（默认）——只在「PPT 工作室」预设内可见（插件内嵌注册，随插件同生共死）')
    }
  }
}

console.log(`dsh-ppt-studio v${pkg.version} 安装/校验完成（${prefix} / profile=${profile}）\n- ` + steps.join('\n- ') + '\n\n下一步：重启 dsh web → 会话切换「PPT 工作室」→ 直接提需求。')
