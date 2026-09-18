/**
 * 内置 skill 包（提问式手册 + 制作能力手册）——DSH 0.1.5 起的"插件内嵌 skill"通道：
 *   ctx.skills.register(...)（@deepseek-ai/dsh-skill 的运行时注册）
 *
 * 为什么走内嵌而不是只写文件：
 *  - 注册落在**调用 ctx 所在层**；本插件由 agent preset 的常驻装配挂载 → 落该 preset 层，
 *    只有 PPT 工作室会话看得见（不污染全局技能目录）；
 *  - 内容随包（lib/../skills/<name>/SKILL.md），与插件同生共死——升级即新、卸载即净，无副本可过期；
 *  - 与用户自装同名技能**不冲突**：注册表跨层重名由"就近层优先"裁决，PPT 会话内命中包内嵌这一份，
 *    用户那份在其它会话照旧可见。
 *
 * 设计约束（2026-09-14，用户明确）：
 *  - 内嵌技能是**纯增益**：不改变任何铁律与门禁语义；技能缺失 / skills 服务缺位时插件完整可用；
 *  - 每个技能必须自包含且短（描述 ≤500 字且只写触发，正文几千字符量级）——正文是按需加载的成本。
 *
 * 兼容策略：install.mjs 仍把同一份 SKILL.md 镜像到 <dshHome>/skills/<name>/（非 PPT 会话也能问到手册）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

/** 随包技能根目录（包根/skills）。 */
export const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
/** 提问式手册（历史名，保持导出兼容）。 */
export const MANUAL_NAME = 'ppt-studio-manual'
export const MANUAL_DIR = join(SKILLS_DIR, MANUAL_NAME)
export const MANUAL_FILE = join(MANUAL_DIR, 'SKILL.md')

/**
 * 解析 SKILL.md：YAML frontmatter（name/description/whenToUse/disable-model-invocation/user-invocable/metadata）
 * + body 作为 content。语义与 @deepseek-ai/dsh-skill-filesystem 的 parseSkillFile 对齐
 * （content = 去 frontmatter 后 trim 的正文），保证"文件通道"与"内嵌通道"交付同一份内容。
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
 * 扫描随包技能目录，返回全部可注册技能（跳过无 SKILL.md / frontmatter 非法的目录——不阻断装配）。
 * @returns {{dir: string, file: string, parsed: object}[]}
 */
export function listBundledSkills(dir = SKILLS_DIR) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillDir = join(dir, entry.name)
    const file = join(skillDir, 'SKILL.md')
    if (!existsSync(file)) continue
    let parsed = null
    try {
      parsed = parseManual(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (parsed === null) continue
    out.push({ dir: skillDir, file, parsed })
  }
  return out.sort((a, b) => a.parsed.name.localeCompare(b.parsed.name))
}

/**
 * 本包内嵌技能的注册结果（纯标量自检快照，不持有活对象）。
 * 由 `ppt_state` 输出——安装后若想确认"技能到底有没有挂上"，问一次 ppt_state 即可。
 */
const STATUS = {
  registered: false,
  reason: '未尝试',
  name: MANUAL_NAME,          // 兼容字段：指向提问式手册
  contentLen: 0,              // 兼容字段：手册正文长度
  skills: [],                 // [{name, contentLen, registered}]
}

/** 注册结果快照（副本；调用方只读）。 */
export function manualSkillStatus() {
  return { ...STATUS, skills: STATUS.skills.map((s) => ({ ...s })) }
}

/** 把单个技能注册进当前 ctx（挂本插件 fiber：停用/卸载即自动注销）。 */
function registerOne(ctx, skills, item) {
  const { parsed } = item
  return ctx.effect(() => skills.register({
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    ...(parsed.invocation !== undefined ? { invocation: parsed.invocation } : {}),
    metadata: { ...(parsed.metadata ?? {}), plugin: 'dsh-ppt-studio', delivery: 'embedded' },
    // 资源基址：技能里的相对引用（references/ 等）可据此定位；同时标明来源是包目录
    resourceBase: { kind: 'directory', path: item.dir },
    source: 'runtime',
    content: parsed.content,
  }), `ppt-studio: embedded skill (${parsed.name})`)
}

/**
 * 注册全部随包内嵌技能。
 * @returns {{name: string, contentLen: number}[]} 实际注册成功的技能（skills 服务缺失时为空数组）
 */
export function registerManualSkill(ctx) {
  const skills = ctx.get('skills')
  if (skills === undefined) {
    STATUS.registered = false
    STATUS.reason = 'skills 服务缺失（本部署未装配 @deepseek-ai/dsh-skill）'
    STATUS.skills = []
    return []
  }
  const found = listBundledSkills()
  if (found.length === 0) {
    STATUS.registered = false
    STATUS.reason = `未找到随包技能（${SKILLS_DIR}）`
    ctx.logger?.warn?.(`ppt-studio: ${STATUS.reason}——内嵌 skill 未注册`)
    STATUS.skills = []
    return []
  }
  const registered = []
  for (const item of found) {
    try {
      registerOne(ctx, skills, item)
      registered.push({ name: item.parsed.name, contentLen: item.parsed.content.length, registered: true })
    } catch (error) {
      ctx.logger?.warn?.(`ppt-studio: 内嵌 skill ${item.parsed.name} 注册失败：${error?.message ?? error}`)
      registered.push({ name: item.parsed.name, contentLen: item.parsed.content.length, registered: false })
    }
  }
  const manual = registered.find((s) => s.name === MANUAL_NAME)
  STATUS.registered = registered.every((s) => s.registered)
  STATUS.reason = STATUS.registered ? 'ok' : '部分技能注册失败'
  STATUS.name = MANUAL_NAME
  STATUS.contentLen = manual?.contentLen ?? 0
  STATUS.skills = registered
  return registered.map((s) => ({ name: s.name, contentLen: s.contentLen }))
}

/** 随包技能名清单（ppt_state 自检用）。 */
export function bundledSkillNames() {
  return listBundledSkills().map((s) => s.parsed.name)
}
