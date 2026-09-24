#!/usr/bin/env node
/**
 * dsh-ppt-studio 一键安装器（随发布包提供——新用户"下载→可用"的最后一步）：
 *   1) 确认本包是 **profile bundle**；不是就**替你装**（`dsh plugin --profile <p> add <规格>`）
 *   2) 校验包在 profile 里可解析（包本体归 pnpm 管，本安装器**不建 junction**）
 *   3) 校验"预设**声明**"所需的包内资产在位，并清理历史遗留产物
 * 装完：重启 dsh web → 新建会话时选「PPT 工作室」→ 直接提需求。
 *
 * ── 2026-09-24 适配 DSH 0.1.7-rc.1：**安装器不再写预设目录** ──────────────────────
 * 0.1.6 及以前，预设靠"往 `<dshHome>/.agent-presets/ppt/` 写文件"交付（宿主启动时扫描该目录）。
 * 0.1.7 把那条发现路径**整个删掉了**，预设改为向 `agentPresets` 注册表**声明**——本插件的
 * `lib/preset-delivery.js` 在激活时自己声明。所以安装器现在的职责变成：
 *   · 保证**装配**（profile bundle）——这条没变；
 *   · 校验**声明所需的包内资产**（`agent-presets/ppt/*` + `lib/preset-delivery.js`）真的装到了；
 *   · **清理**旧版本留下的 `.agent-presets/ppt/`（在 0.1.7 上它是惰性垃圾，留着只会让人以为
 *     "预设是靠这个目录生效的"）。
 *
 * ── `--isolate` 在 0.1.7 上**被拒绝**（不是被遗忘）────────────────────────────────
 * 隔离模式原本靠"预设目录里的 junction + **相对路径**插件行"实现：相对行按**组合文件所在目录**解析
 * （本机 liangshen/j-space 等预设正是用 `name: ./xxx.mjs` 引用自己的文件）。
 * 这条路在 0.1.7 上断了两处：
 *   ① 预设目录**不再被扫描**（同上）——没有"组合文件所在目录"这回事了；
 *   ② 预设的行现在由注册表在**注册表自己 ctx 的 baseUrl** 下 mount（源码：
 *      `mountPreset(scope.ctx.extend({ baseUrl: record.context.baseUrl }), …)`，而 `register()` 里
 *      `context = this.ctx` = 注册表所在层 ⇒ 那是 **dsh-web-app 的包目录**，不是 profile、更不是预设目录）
 *      ⇒ 裸包名 `dsh-ppt-studio` 在那里解析不到 ⇒ 预设被判 `broken` ⇒ 选择器过滤掉它。
 * 所以 `--isolate` 现在会**明确失败并说明原因**，而不是写出一个永远不会被读到的预设（那正是
 * 1.0.6 及以前在 0.1.7 上的静默故障形状）。要做隔离需要把插件行放进"预设声明"里、并给插件行一个
 * **绝对 file:// 名字**（install 期算出来）——那是一块独立工作，不与默认路径共享代码，见 README §10。
 *
 * 用法：
 *   node scripts/install.mjs                    # 默认 DSH_HOME/~/.dsh + profile web
 *   node scripts/install.mjs --spec <URL|路径>   # 用指定安装规格装成 bundle（发布流程会传）
 *   node scripts/install.mjs --prefix <dir>     # 指定 DSH_HOME（测试/多实例）
 *   node scripts/install.mjs --profile <name>   # 指定 profile
 *   node scripts/install.mjs --no-preset        # 只保证 bundle，不校验预设资产
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
// 包在 profile 里的落点：**按 pkg.name 拼**（2026-09-18 改无 scope 名 `dsh-ppt-studio` 后，
// 硬编码 '@dsh-external/dsh-ppt-studio' 会指向一个不存在的目录）。split('/') 同时兼容 scoped 名。
const pkgDir = join(profileDir, 'node_modules', ...pkg.name.split('/'))
// 旧名（scoped）时代的 junction 落点——只在提示/兼容检查里用到，装新名后它是历史遗留物
const legacyPkgDir = join(profileDir, 'node_modules', '@dsh-external', 'dsh-ppt-studio')
// 0.1.6 的预设交付目录：0.1.7 上惰性，安装器负责清理
const legacyPresetDir = join(prefix, '.agent-presets', 'ppt')

if (args.includes('--isolate')) {
  console.error(`✗ --isolate 在 DSH 0.1.7 上不再可用（本安装器拒绝写出一个永远不会被读到的预设）

  原因（两处，都有源码依据）：
    · 宿主不再扫描 \`<dshHome>/.agent-presets/\`——上游原文 "the harness discovers no preset on disk"，
      预设改为向 agentPresets 注册表声明；旧写法写完等于没写，且**静默**。
    · 预设的行现在由注册表在它自己 ctx 的 baseUrl 下 mount（= dsh-web-app 包目录，不是 profile、
      不是预设目录）⇒ 预设里的裸包名 \`dsh-ppt-studio\` 解析不到 ⇒ 预设被判 broken ⇒ 选择器看不到它。

  可选做法：
    · 默认（全局）安装：直接跑本脚本不带 --isolate —— 「PPT 工作室」预设会由插件自己声明，
      该 profile 的**所有会话**都能用 ppt_* 工具（这也是当前发布的装配形状）。
    · 真要"只在「PPT 工作室」里生效"：需要把插件行放进**预设声明**里、并用安装期算出的绝对
      \`file://\` 名字（见 README §10「隔离安装」）。这条路尚未实现——宁可明确拒绝，也不静默失败。`)
  process.exit(1)
}

if (!existsSync(profileDir)) {
  console.error(`✗ profile 不存在：${profileDir}\n  请确认已安装 dsh web（或 --prefix/--profile 正确）`)
  process.exit(1)
}
if (!existsSync(join(root, 'lib', 'index.js'))) {
  console.error(`✗ 当前目录缺少 lib/（发布包应自带；源码模式请先 node scripts/build.mjs）`)
  process.exit(1)
}

const steps = []
steps.push(`装配模式：**全局**（profile bundle：该 profile 的所有会话都能用）`)

// ── 1) 包本体可达性 + bundle 装配 ─────────────────────────────────────────────
const profilePkgFile = join(profileDir, 'package.json')
let profilePkg = {}
// 去 BOM 再解析：Windows 上被 PowerShell/记事本编辑过的 JSON 可能带 UTF-8 BOM，JSON.parse 会直接抛
try { profilePkg = JSON.parse(readFileSync(profilePkgFile, 'utf8').replace(/^\uFEFF/, '')) } catch { /* 无/坏 → 视为非 bundle */ }
let bundleInstalled = Boolean(profilePkg.dependencies?.[pkg.name]) || (profilePkg.dsh?.profile?.bundles ?? []).includes(pkg.name)

if (!bundleInstalled) {
  // 确认/建立 profile bundle（包本体交给 pnpm；规格优先级 --spec > 包本目录）
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
// 改名（@dsh-external/dsh-ppt-studio → dsh-ppt-studio）之后的双重挂载风险：旧包若仍在 profile 里，
// 两行 patch 会各挂一次。插件有装配防重（不会崩），但纪律是二选一 ⇒ 主动提示清掉。
if (existsSync(join(legacyPkgDir, 'package.json'))) {
  steps.push(`⚠ 检测到旧包名残留：${legacyPkgDir}\n    建议执行：dsh plugin --profile ${profile} remove @dsh-external/dsh-ppt-studio（避免新旧双挂载）`)
}

// ── 2) 清理历史遗留：0.1.6 的预设目录 ────────────────────────────────────────
// 在 0.1.7 上它是惰性垃圾（没有任何发现路径扫它）。留着会让"改了预设为什么没生效"变成
// 一个假线索，也会与注册表里的那条声明**看起来像两处真相**。里面的文件全是安装器从包里拷的
// （agent.cordis.yml / preset.yml）与安装器自己建的 junction（plugin）⇒ 清理是安全的；已存在的
// `plugin` junction 也一并删掉（升级到 0.1.7 时它可能还指着旧路径）。
if (existsSync(legacyPresetDir)) {
  const entries = readdirSync(legacyPresetDir)
  rmSync(legacyPresetDir, { recursive: true, force: true })
  steps.push(`已清理 0.1.6 遗留的预设目录（0.1.7 不再扫描它）：${legacyPresetDir}（原含 ${entries.join('、') || '空'}）`)
}

// ── 3) 预设**声明**资产校验（2026-09-24）──────────────────────────────────────
// 预设不再由安装器"写"出来，而是插件激活时向 agentPresets 注册表声明。安装器能验的是：
// **声明要用的包内资产确实装到了 profile 里**（否则插件会告警"预设组合不可用"而静默没有预设）。
if (!noPreset) {
  const installedPreset = join(pkgDir, 'agent-presets', 'ppt', 'agent.cordis.yml')
  const installedMeta = join(pkgDir, 'agent-presets', 'ppt', 'preset.yml')
  const installedDelivery = join(pkgDir, 'lib', 'preset-delivery.js')
  if (!existsSync(installedPreset) || !existsSync(installedMeta)) {
    console.error(`✗ 装到 profile 的包缺少预设组合（发布包应自带 \`agent-presets/ppt/\`）：\n    ${installedPreset}`)
    process.exit(1)
  }
  if (!existsSync(installedDelivery)) {
    console.error(`✗ 装到 profile 的包缺少 lib/preset-delivery.js——那是"声明预设"的实现，缺了就没有预设：\n    ${installedDelivery}`)
    process.exit(1)
  }
  // 组合里**不得**含本包插件行：插件已由 profile bundle 挂载，预设里再来一行 = 同进程双挂载。
  const presetText = readFileSync(installedPreset, 'utf8')
  if (/^-\s*id:\s*ppt-studio\s*$/m.test(presetText)) {
    console.error('✗ 随包预设含本包插件行——同进程会被挂两次（profile bundle + 预设）。发布包不该带这一行。')
    process.exit(1)
  }
  steps.push('预设资产已就位：agent-presets/ppt/{agent.cordis.yml,preset.yml} + lib/preset-delivery.js ✓（预设由插件声明，不由安装器写）')
  steps.push('重启 dsh web 后：「PPT 工作室」由插件向 agentPresets 注册表声明，选择器里可选；状态可用 `ppt_state` 查 presetDelivery')
}

// ── 4) 内置 skill 文件镜像（**默认关闭**，见下）──────────────────────────────────
// 技能包的**主通道**是插件内嵌注册（lib/skill.js → ctx.skills.register，落装它的那一层，随插件同生共死）。
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
        ? `内置技能：**已移除 ${removed} 本历史镜像**——技能只在装插件的层可见（插件内嵌注册）；要给别的会话留兜底请加 --mirror-skills`
        : '内置技能：未镜像（默认）——技能随插件注册，随插件同生共死')
    }
  }
}

console.log(`dsh-ppt-studio v${pkg.version} 安装/校验完成（${prefix} / profile=${profile}）\n- ` + steps.join('\n- ') + '\n\n下一步：重启 dsh web → 新建会话选「PPT 工作室」→ 直接提需求。')
