#!/usr/bin/env node
/**
 * dsh-ppt-studio 一键安装器（1.0.0 起随发布包提供——新用户"下载→可用"的最后一步）：
 *   1) 把包本目录链接进目标 profile 的 node_modules（@dsh-external/dsh-ppt-studio）
 *   2) 把 agent preset 复制到 <dshHome>/.agent-presets/ppt/（预设行挂载插件 = 唯一装配源）
 *   3) 保证 yaml 运行时依赖可解析（profile 内已有则直接可用；否则从候选链接）
 * 幂等：已安装则跳过；--force 强制重建。安装后：重启 dsh web → 切换"PPT 工作室"agent。
 *
 * 用法：
 *   node scripts/install.mjs                    # 默认 DSH_HOME/~/.dsh + profile web
 *   node scripts/install.mjs --prefix <dir>     # 指定 DSH_HOME（测试/多实例）
 *   node scripts/install.mjs --profile <name>   # 指定 profile
 *   node scripts/install.mjs --force            # 重建
 *   node scripts/install.mjs --no-preset        # 只链包，不装 preset（注入器通道用户）
 */
import { existsSync, symlinkSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
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
const force = args.includes('--force')
const noPreset = args.includes('--no-preset')
// 技能镜像默认**关闭**（跨预设泄漏，见第 4 步注释）；要给非 PPT 会话留兜底才显式开启。
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

// ── 0) 装配路径检测（2026-09-14）：两条路径**互斥**，装成 bundle 时不要再用预设行挂载 ──────
// 背景：`dsh plugin --profile <p> add <本包>` 会把本包装成 **profile bundle**（profile 的 package.json
// 依赖 + 自动进 dsh.profile.bundles），此时插件在该 profile 的所有会话都可用；预设行再挂一次
// 就是同进程双挂载（插件内有装配防重兜底，但纪律是二选一）。
// 所以：检测到 bundle 安装 → ① 不建 junction（那个路径归 pnpm 管，--force 也不能动）
//        ② 写预设时**删掉插件行块**（标记见 agent-presets/ppt/agent.cordis.yml）。
const profilePkgFile = join(profileDir, 'package.json')
let profilePkg = {}
// 去 BOM 再解析：Windows 上被 PowerShell/记事本编辑过的 JSON 可能带 UTF-8 BOM，JSON.parse 会直接抛
try { profilePkg = JSON.parse(readFileSync(profilePkgFile, 'utf8').replace(/^\uFEFF/, '')) } catch { /* 无/坏 → 视为非 bundle */ }
const bundleInstalled = Boolean(profilePkg.dependencies?.[pkg.name]) || (profilePkg.dsh?.profile?.bundles ?? []).includes(pkg.name)
const PRESET_ROW_RE = /^# >>> dsh-ppt-studio plugin row[\s\S]*?^# <<< dsh-ppt-studio plugin row\r?\n?/m

// ── 1) 包链接（junction/符号链接；Windows junction 不要求提权）────────────
if (bundleInstalled) {
  steps.push(`检测到本包已作为 profile bundle 安装（${profilePkg.dependencies?.[pkg.name] ?? 'dsh.profile.bundles'}）→ **跳过 junction**（该路径归 pnpm 管，避免破坏 pnpm 安装）`)
} else if (existsSync(pkgDir)) {
  if (!force) steps.push(`包已存在（幂等跳过）：${pkgDir}`)
  else {
    rmSync(pkgDir, { recursive: true, force: true })
    const bak = `${pkgDir}.bak-${Date.now()}`
    renameSync(pkgDir, bak)
    steps.push(`旧包已重命名备份：${bak}`)
  }
}
if (!bundleInstalled && !existsSync(pkgDir)) {
  mkdirSync(dirname(pkgDir), { recursive: true })
  symlinkSync(root, pkgDir, 'junction')
  steps.push(`包已链接：${pkgDir} → ${root}`)
}

// ── 2) yaml 运行时依赖（关键：ESM 按 realpath 解析——yaml 必须挂在**包自身** node_modules，
//        profile 级解析救不了 junction 抽取目录；此处幂等保证 <root>/node_modules/yaml 存在）──
// bundle 模式下包由 pnpm 管理（依赖已装好），**不要**往 pnpm 管理的目录里塞 junction。
const pkgYaml = join(root, 'node_modules', 'yaml')
if (bundleInstalled) {
  steps.push('yaml 依赖：bundle 模式由 pnpm 解析（不动包目录）')
} else if (!existsSync(join(pkgYaml, 'package.json'))) {
  let yamlSrc = null
  try {
    yamlSrc = dirname(createRequire(join(profileDir, 'package.json')).resolve('yaml/package.json'))
  } catch { /* 本级不可解析则走候选 */ }
  if (!yamlSrc) yamlSrc = [join(profileDir, 'node_modules', 'yaml')].find((p) => existsSync(join(p, 'package.json'))) ?? null
  if (!yamlSrc) {
    console.error('✗ yaml 依赖缺失：请先在 profile 目录运行 npm install yaml（或 npm i yaml --prefix ' + profileDir + '）')
    process.exit(1)
  }
  mkdirSync(dirname(pkgYaml), { recursive: true })
  symlinkSync(yamlSrc, pkgYaml, 'junction')
  steps.push(`yaml 已链接进包：${pkgYaml} → ${yamlSrc}`)
} else steps.push('yaml 依赖：包内已可解析 ✓')

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
    if (bundleInstalled) {
      const before = presetText.length
      presetText = presetText.replace(PRESET_ROW_RE, '')
      steps.push(presetText.length < before
        ? '预设已同步（包为准，**已按 bundle 安装删掉插件行块**——插件由 profile 提供，两条路径不并用）'
        : '⚠ 预设已同步，但未找到插件行标记块（agent-presets/ppt/agent.cordis.yml 的 >>> / <<< 标记被改动？）')
    } else {
      steps.push('预设已同步（包为准，含插件行——preset 行挂载插件）')
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
