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
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
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

// ── 0) 装配路径：**只支持 profile bundle**（2026-09-18 实测事故后收窄）──────────────────
// 曾经的"两条路径互斥"是错的：**预设行这条路在本 DSH 版本上不可能成立**，而且失败得极其隐蔽。
// 依据（都可复跑）：
//   ① `@deepseek-ai/dsh-agent-presets` 的 PresetTree.import 对**裸包名**一律从 `harnessBase` 解析——
//      源码注释原文："the mount records the host composition's base instead, which is inside the
//      installed harness"。**不是**预设目录，也**不是** profile ⇒ 装在 profile 里的本包永远解析不到；
//   ② 解析不到 ⇒ 该预设被标 `broken`；前端选择器只渲染健康预设：
//      `presetOptions() = presets.filter(p => p.broken === void 0)`（dsh-client-ui-agent-preset）
//      ⇒ 「PPT 工作室」**不出现在新建会话的预设列表里**（只在"管理"区可见）；
//   ③ 于是用户选不到该预设、profile 里又没有 bundle ⇒ **两边都没有任何工具**——
//      本机 2026-09-18 的现场：245 个会话里 `agentPreset` 为 `ppt` 的 **0 个**，用户以为"插件挂了"。
// 所以本安装器现在**只有一条路**：确认/建立 profile bundle；包本体交给 pnpm 管，不再建 junction。
// 预设依旧同步（身份/人格），但**永不写插件行**——它只会让预设变 broken。
const profilePkgFile = join(profileDir, 'package.json')
let profilePkg = {}
// 去 BOM 再解析：Windows 上被 PowerShell/记事本编辑过的 JSON 可能带 UTF-8 BOM，JSON.parse 会直接抛
try { profilePkg = JSON.parse(readFileSync(profilePkgFile, 'utf8').replace(/^\uFEFF/, '')) } catch { /* 无/坏 → 视为非 bundle */ }
let bundleInstalled = Boolean(profilePkg.dependencies?.[pkg.name]) || (profilePkg.dsh?.profile?.bundles ?? []).includes(pkg.name)
// 历史遗留的行块（老版本安装器写过）：**任何模式下都清掉**——否则老用户升级后预设依然是 broken。
const PRESET_ROW_RE = /^# >>> dsh-ppt-studio plugin row[\s\S]*?^# <<< dsh-ppt-studio plugin row\r?\n?/m
// 兼容更老的无标记写法（直接跟在文件末尾的两行）
const LEGACY_ROW_RE = /^- id: ppt-studio\n  name: '@dsh-external\/dsh-ppt-studio'\n?/m

if (!bundleInstalled) {
  // 先尝试把它装成 bundle——这就是"一条命令安装"那条路，也正是 README §10 指引用户做的事。
  // 规格优先级：--spec <值>（发布时由 release-sync 传资产/本地构件）> 包本目录（file: 规格）。
  const spec = opt('--spec', root)
  steps.push(`未检测到 profile bundle → 先装成 bundle：dsh plugin --profile ${profile} add ${spec}`)
  // **必须把 DSH_HOME 传给子进程**：`--prefix` 指的就是 DSH home，不传的话 `dsh plugin` 会去动
  // 用户**真实**的 ~/.dsh（测试隔离形同虚设，且会污染真环境）——这是隔离夹具的第二次教训。
  const r = spawnSync('dsh', ['plugin', '--profile', profile, 'add', spec], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DSH_HOME: prefix },
  })
  if (r.status !== 0) {
    console.error(`✗ 自动安装 profile bundle 失败（dsh 退出码 ${r.status}）。请手动执行：\n`
      + `    dsh plugin --profile ${profile} add ${spec}\n`
      + '  然后重跑本安装器。（预设行挂载在本 DSH 版本上不可用——见本文件顶部说明。）')
    process.exit(1)
  }
  try { profilePkg = JSON.parse(readFileSync(profilePkgFile, 'utf8').replace(/^\uFEFF/, '')) } catch { profilePkg = {} }
  bundleInstalled = Boolean(profilePkg.dependencies?.[pkg.name]) || (profilePkg.dsh?.profile?.bundles ?? []).includes(pkg.name)
  if (!bundleInstalled) {
    console.error(`✗ dsh 报告成功，但 profile 里仍没有本包（${profilePkgFile}）——拒绝继续（写不出可用装配）`)
    process.exit(1)
  }
  steps.push(`已装成 profile bundle（${profilePkg.dependencies?.[pkg.name] ?? 'dsh.profile.bundles'}）`)
} else {
  steps.push(`已确认 profile bundle（${profilePkg.dependencies?.[pkg.name] ?? 'dsh.profile.bundles'}）——包本体归 pnpm 管，不建 junction`)
}

// ── 1) 包本体是否真的在 profile 里（pnpm 物化）────────────────────────────────
// 只做**校验**，不做链接：bundle 模式下这条路径完全归 pnpm，手工建 junction 会破坏 pnpm 的安装。
if (!existsSync(join(pkgDir, 'package.json'))) {
  console.error(`✗ profile 里找不到本包：${join(pkgDir, 'package.json')}\n`
    + `  请重跑：dsh plugin --profile ${profile} add ${opt('--spec', root)}`)
  process.exit(1)
}
steps.push(`包已在 profile 中可解析：node_modules\\@dsh-external\\dsh-ppt-studio`)

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
    // 无论哪种模式：**永不写插件行**，并且**清掉历史遗留的行块**（老版本安装器写过）。
    // 为什么：行里的裸包名在 DSH 版本上从 harness 解析（不是 profile）⇒ 解析不到 ⇒ 预设被标 broken
    // ⇒ 选择器不显示该预设 ⇒ 用户选不到、两边都没工具。详见 agent-presets/ppt/agent.cordis.yml 的说明。
    const before = presetText.length
    presetText = presetText.replace(PRESET_ROW_RE, '').replace(LEGACY_ROW_RE, '')
    if (presetText.length < before) steps.push('预设已同步（包为准，**已清掉历史遗留的插件行块**）')
    else steps.push('预设已同步（包为准；本包**不含**插件行——装配只走 profile bundle）')
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
