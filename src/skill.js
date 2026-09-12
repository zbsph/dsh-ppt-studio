/**
 * 内置提问式手册 skill（ppt-studio-manual）——DSH 0.1.5 起的"插件内嵌 skill"通道：
 *   ctx.skills.register(...)（@deepseek-ai/dsh-skill 的运行时注册）
 *
 * 为什么走内嵌而不是只写文件：
 *  - 注册落在**调用 ctx 所在层**；本插件由 agent preset 的常驻装配挂载 → 落该 preset 层，
 *    只有 PPT 工作室会话看得见（不污染全局技能目录）；
 *  - 手册内容随包（lib/../skills/...），与插件同生共死——升级即新、卸载即净，无副本可过期；
 *  - 0.1.5 之前没有这条通道，只能把 SKILL.md 拷进 <dshHome>/skills/（非 PPT 会话也可见）。
 *
 * 兼容策略：两条腿都保留。install.mjs 仍把同一份 SKILL.md 镜像到 <dshHome>/skills/ppt-studio-manual/
 * （非 PPT 会话也能问到手册）；同一份字节、同一次安装同步，且同名跨层由注册表"就近层优先"裁决——
 * PPT 会话内永远命中包内嵌这一份。`skills` 服务缺失（极简装配）时内嵌注册静默跳过，只剩文件镜像。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

/** 手册所在目录（包根/skills/ppt-studio-manual）。 */
export const MANUAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'ppt-studio-manual')
export const MANUAL_FILE = join(MANUAL_DIR, 'SKILL.md')
/** skill 名（kebab-case；注册表按名去重）。 */
export const MANUAL_NAME = 'ppt-studio-manual'

/**
 * 解析 SKILL.md：YAML frontmatter（name/description/whenToUse/disable-model-invocation/user-invocable/metadata）
 * + body 作为 content。语义与 @deepseek-ai/dsh-skill-filesystem 的 parseSkillFile 对齐
 * （content = 去 frontmatter 后 trim 的正文），保证"文件通道"与"内嵌通道"交付同一份手册。
 * @returns {{name: string, description: string, whenToUse?: string, invocation?: {modelInvocable: boolean, userInvocable: boolean}, metadata?: object, content: string} | null}
 */
export function parseManual(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return null
  const firstEnd = text.indexOf('\n')
  if (firstEnd < 0) return null
  const close = text.indexOf('\n---', firstEnd)
  if (close < 0) return null
  const bodyStart = text.indexOf('\n', close + 1)
  let data
  try {
    data = YAML.parse(text.slice(firstEnd + 1, close + 1))
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const name = typeof data.name === 'string' ? data.name : ''
  const description = typeof data.description === 'string' ? data.description : ''
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || description.length === 0) return null
  const invocation = invocationOf(data)
  return {
    name,
    description,
    ...(typeof data.whenToUse === 'string' && data.whenToUse.length > 0 ? { whenToUse: data.whenToUse } : {}),
    ...(invocation !== undefined ? { invocation } : {}),
    ...(data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata) ? { metadata: data.metadata } : {}),
    content: (bodyStart < 0 ? '' : text.slice(bodyStart)).trim(),
  }
}

/** frontmatter 调用策略：仅显式给出时才产出（缺省由注册表补 {modelInvocable:true, userInvocable:true}）。 */
function invocationOf(data) {
  const model = data['disable-model-invocation']
  const user = data['user-invocable']
  if (model === undefined && user === undefined) return undefined
  if ((model !== undefined && typeof model !== 'boolean') || (user !== undefined && typeof user !== 'boolean')) return undefined
  return { modelInvocable: model !== true, userInvocable: user !== false }
}

/**
 * 本包内嵌手册的注册结果（纯标量自检快照，不持有活对象）。
 * 由 `ppt_state` 输出——安装后若想确认"手册到底有没有挂上"，问一次 ppt_state 即可。
 */
const STATUS = { registered: false, reason: '未尝试', name: MANUAL_NAME, contentLen: 0 }

/** 注册结果快照（副本；调用方只读）。 */
export function manualSkillStatus() {
  return { ...STATUS }
}

/**
 * 把手册注册为内嵌运行时 skill（挂本插件 fiber：停用/热重载/卸载即自动注销，无残留）。
 * @returns disposer | null（skills 服务缺失或手册缺失/坏 frontmatter 时为 null——不阻断插件装配）
 */
export function registerManualSkill(ctx) {
  const skills = ctx.get('skills')
  if (skills === undefined) {
    STATUS.registered = false
    STATUS.reason = 'skills 服务缺失（本部署未装配 @deepseek-ai/dsh-skill）'
    return null
  }
  if (!existsSync(MANUAL_FILE)) {
    STATUS.registered = false
    STATUS.reason = `手册文件缺失（${MANUAL_FILE}）`
    ctx.logger?.warn?.(`ppt-studio: ${STATUS.reason}——内嵌 skill 未注册`)
    return null
  }
  let parsed = null
  try {
    parsed = parseManual(readFileSync(MANUAL_FILE, 'utf8'))
  } catch (error) {
    STATUS.registered = false
    STATUS.reason = `手册读取失败：${error?.message ?? error}`
    ctx.logger?.warn?.(`ppt-studio: ${STATUS.reason}`)
    return null
  }
  if (parsed === null) {
    STATUS.registered = false
    STATUS.reason = '手册 frontmatter 非法（需 name（kebab-case）/description）'
    ctx.logger?.warn?.(`ppt-studio: ${STATUS.reason}——内嵌 skill 未注册`)
    return null
  }
  const disposer = ctx.effect(() => skills.register({
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    ...(parsed.invocation !== undefined ? { invocation: parsed.invocation } : {}),
    metadata: { ...(parsed.metadata ?? {}), plugin: '@dsh-external/dsh-ppt-studio', delivery: 'embedded' },
    // 资源基址：手册里的相对引用（references/ 等）可据此定位；同时标明来源是包目录
    resourceBase: { kind: 'directory', path: MANUAL_DIR },
    source: 'runtime',
    content: parsed.content,
  }), 'ppt-studio: embedded skill (ppt-studio-manual)')
  STATUS.registered = true
  STATUS.reason = 'ok'
  STATUS.contentLen = parsed.content.length
  return disposer
}
