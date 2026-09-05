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
import { existsSync, symlinkSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
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

// ── 1) 包链接（junction/符号链接；Windows junction 不要求提权）────────────
if (existsSync(pkgDir)) {
  if (!force) steps.push(`包已存在（幂等跳过）：${pkgDir}`)
  else {
    rmSync(pkgDir, { recursive: true, force: true })
    const bak = `${pkgDir}.bak-${Date.now()}`
    renameSync(pkgDir, bak)
    steps.push(`旧包已重命名备份：${bak}`)
  }
}
if (!existsSync(pkgDir)) {
  mkdirSync(dirname(pkgDir), { recursive: true })
  symlinkSync(root, pkgDir, 'junction')
  steps.push(`包已链接：${pkgDir} → ${root}`)
}

// ── 2) yaml 运行时依赖（关键：ESM 按 realpath 解析——yaml 必须挂在**包自身** node_modules，
//        profile 级解析救不了 junction 抽取目录；此处幂等保证 <root>/node_modules/yaml 存在）──
const pkgYaml = join(root, 'node_modules', 'yaml')
if (!existsSync(join(pkgYaml, 'package.json'))) {
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

// ── 3) agent preset（唯一装配源：preset 行挂载插件；含 preset.yml 显示元数据）──
// 同步纪律（2026-09-06 用户点出）：预设与元数据是"托管文件"、以包为准**总是刷新**——
// 跳过策略曾导致升级后本机保留旧版（skill 12pt 过期语义事件）。
if (!noPreset) {
  if (!existsSync(builtinPreset)) {
    console.error('✗ 本包缺少预设模板 agent-presets/ppt/agent.cordis.yml——发布包应自带')
    process.exit(1)
  }
  {
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(presetFile, readFileSync(builtinPreset, 'utf8'), 'utf8')
    steps.push(`预设已同步（包为准）：${presetFile}`)
  }
  // 显示元数据（拣选器显示名/简介）：preset.yml（name/description/order；缺省则只有目录名）
  const metaSrc = join(root, 'agent-presets', 'ppt', 'preset.yml')
  const metaDst = join(presetDir, 'preset.yml')
  if (existsSync(metaSrc)) {
    writeFileSync(metaDst, readFileSync(metaSrc, 'utf8'), 'utf8')
    steps.push(`预设元数据已同步（「PPT 工作室」+ 简介）：${metaDst}`)
  }
}

// ── 4) 内置手册 skill（README 承诺"安装后提问即用"——随包同步刷新，以包为准）──────
const skillSrcDir = join(root, 'skills', 'ppt-studio-manual')
const skillDstDir = join(prefix, 'skills', 'ppt-studio-manual')
if (!noPreset && existsSync(skillSrcDir)) {
  mkdirSync(skillDstDir, { recursive: true })
  writeFileSync(join(skillDstDir, 'SKILL.md'), readFileSync(join(skillSrcDir, 'SKILL.md'), 'utf8'), 'utf8')
  steps.push(`手册 skill 已同步（包为准）：${join(skillDstDir, 'SKILL.md')}`)
} else if (!noPreset) {
  console.warn('⚠ 包内缺少 skills/ppt-studio-manual（此包打包不完整）——提问式手册不可用')
}

console.log(`dsh-ppt-studio v${pkg.version} 安装/校验完成（${prefix} / profile=${profile}）\n- ` + steps.join('\n- ') + '\n\n下一步：重启 dsh web → 会话切换「PPT 工作室」→ 直接提需求。')
