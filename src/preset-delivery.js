/**
 * 预设自交付（2026-09-18，路 A 的配套）：让"一条命令 `dsh plugin add`"也能得到一个**会话级**的
 * 「PPT 工作室」预设——否则按预设门控就没有可门控的对象（装了包却没有可选的预设）。
 *
 * 为什么必须由插件自己做：`dsh plugin add` 只装包、不写预设（pnpm 10+ 默认拦截 postinstall），
 *   而"让包自己的 patch 给 roster 加一个指向包内的 root"经实测不可行（root 路径走
 *   `resolve(expandHomePath(p))`，相对路径按 CWD 解析 ⇒ 不可移植；且 patch 覆盖是**替换**语义，
 *   会抹掉上游那一行的 `default`）。
 *
 * 安全边界（务必遵守，改动前先读）：
 *   · **只在目标文件不存在时写**——绝不覆盖用户已改过的预设；
 *   · 交付的是**剥离插件行**的预设：此时插件已由 profile bundle 挂载，保留插件行会导致同进程双挂载；
 *   · 可被 `config.autoPreset === false` 关闭；
 *   · **任何失败只告警不抛**——绝不能因为"写预设"失败而让插件本身挂不上。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 与 install.mjs 同一套标记（两处必须一致：改一处就要改另一处）
const PRESET_ROW_RE = /^# >>> dsh-ppt-studio plugin row[\s\S]*?^# <<< dsh-ppt-studio plugin row\r?\n?/m

/** 目标预设目录：`<dshHome>/.agent-presets/ppt`（用户根；agent-presets 默认 includeUserRoot=true 会扫描它）。 */
export function presetHomeDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.agent-presets', 'ppt')
}

/** 包内自带的预设模板目录（`lib/` 的上一级 = 包根）。 */
function builtinPresetDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'agent-presets', 'ppt')
}

function loggerOf(ctx) {
  try { return typeof ctx.logger === 'function' ? ctx.logger('ppt-studio') : ctx.logger } catch { return undefined }
}

/**
 * 幂等地保证「PPT 工作室」预设存在。
 * @returns {{wrote: boolean, dir: string, reason: string}}（供 ppt_state / 测试观测）
 */
export function ensureAgentPreset(ctx, config = {}) {
  const dir = presetHomeDir()
  const out = { wrote: false, dir, reason: '' }
  try {
    if (config?.autoPreset === false) { out.reason = 'autoPreset=false（配置关闭）'; return out }
    const file = join(dir, 'agent.cordis.yml')
    if (existsSync(file)) { out.reason = '预设已存在——不覆盖（用户/安装器的那份优先）'; return out }
    const srcDir = builtinPresetDir()
    const src = join(srcDir, 'agent.cordis.yml')
    if (!existsSync(src)) { out.reason = `包内预设模板缺失：${src}`; loggerOf(ctx)?.warn?.(`[ppt-studio] ${out.reason}`); return out }
    // 剥掉插件行块：本路径只在插件**已被挂载**时触发，保留插件行会造成同进程双挂载
    const text = readFileSync(src, 'utf8').replace(PRESET_ROW_RE, '')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, text, 'utf8')
    const metaSrc = join(srcDir, 'preset.yml')
    if (existsSync(metaSrc)) writeFileSync(join(dir, 'preset.yml'), readFileSync(metaSrc, 'utf8'), 'utf8')
    out.wrote = true
    out.reason = '已写在用户预设根（插件行已剥离）——重启 dsh web 后选择器里会出现「PPT 工作室」'
    loggerOf(ctx)?.info?.(`[ppt-studio] 自交付预设：${file}（${out.reason}）`)
  } catch (e) {
    out.reason = `写入失败（不影响插件本身）：${String(e?.message ?? e)}`
    loggerOf(ctx)?.warn?.(`[ppt-studio] ${out.reason}`)
  }
  return out
}
