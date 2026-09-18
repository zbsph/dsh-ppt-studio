/**
 * @dsh-external/dsh-ppt-studio —— PPT 工作室插件（host）。
 *
 * 装配模型（2026-09-18 改为**会话级**，路 A）：
 *   `apply()` 只做三件事——① 装配防重；② **全局管道**（/ppt-preview 路由、预设自交付、语义路由、
 *   提示段注入的"逐次门控"）；③ 挂 `agent/created` 钩子。**不再在 profile 层注册任何能力面**。
 *   工具（21 个 ppt_*）/ `/ppt` 命令面 / 4 本内嵌技能，都在 `agent/created` 时**按该 agent 的预设**
 *   挂到 `agent.ctx` 作用域——于是它们只对「PPT 工作室」预设的会话可见，别的预设（含官方 standard）
 *   完全看不到。机制由隔离探针实测：在 `agent.ctx` 注册的工具**该 agent 能调用**，且
 *   **不进入 profile 层目录**（而 profile 层正是今天"全会话可见"的那一层）。
 *
 * 为什么不在 profile 层按预设过滤：注册发生在插件 `apply`（进程/profile 级）时；要按预设隔离，
 *   注册就必须发生在**该 agent 的作用域**里——这正是本文件的 `agent/created` 钩子做的事。
 *
 * 失败开放（重要，零回归）：拿不到 `agentPresets` 服务、或该 agent 没有加入任何预设时，
 *   **照旧注册**——保持"环境不支持 roster 时插件仍然完整可用"。
 */
import { registerTools, defineTool } from './tools.js'
import { registerCommands } from './commands.js'
import { loadSession, saveSession } from './state.js'
import { isPptIntent, isPptOff, isQuickIntent, detectTaskType, workflowSection } from './router.js'
import { registerPreviewRoute } from './preview-server.js'
import { registerManualSkill, manualSkillStatus } from './skill.js'
import { ensureAgentPreset } from './preset-delivery.js'
import { existsSync, statSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = '@dsh-external/dsh-ppt-studio'
// skills 为可选依赖（ctx.get('skills')）：极简装配缺 dsh-skill 时插件仍完整可用
export const inject = ['tools', 'commands', 'systemPrompt']

/** 默认只在**这些预设 id** 上开放能力面（可用 patch 的 config.presetIds 覆盖）。 */
const DEFAULT_PRESET_IDS = ['ppt']

// 跨模块实例共享（junction/真实路径双加载下模块级变量不可靠——与 __pptCoreReg / ROUTE_REG 同款）
const agentReg = () => (globalThis.__pptAgentReg ??= new Set())
const oursCache = () => (globalThis.__pptOursCache ??= new Map())

function loggerOf(ctx) {
  try { return typeof ctx.logger === 'function' ? ctx.logger('ppt-studio') : ctx.logger } catch { return undefined }
}

/**
 * 按需诊断日志（**默认关闭**）：`PPT_STUDIO_DEBUG=1`，或存在 `<dshHome>/ppt-studio/debug.on` 时启用。
 *
 * 为什么需要它（2026-09-18 的真实排查困境）：本插件的"不生效"有三种完全不同的原因——
 *   ① 插件没被加载（装法/装配问题）；② 加载了，但门控判成"这个 agent 不属于本插件"；
 *   ③ 门控放行，但能力面挂到 agent 作用域时失败。
 * 三者在 UI 上**长得一模一样**（都看不到工具），而会话里一个工具都没有时**什么都问不了**
 * （连诊断工具本身都没挂上）——所以诊断必须写到**文件**，不依赖"模型肯不肯说"。
 * 每次判定一行；超过 256KB 时截断保留尾部。
 */
function diag(event, detail = '') {
  try {
    const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
    const dir = join(home, 'ppt-studio')
    const on = process.env.PPT_STUDIO_DEBUG === '1' || existsSync(join(dir, 'debug.on'))
    if (!on) return
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'debug.log')
    try { if (existsSync(file) && statSync(file).size > 256 * 1024) {
      const buf = readFileSync(file); writeFileSync(file, buf.subarray(buf.length - 128 * 1024))
    } } catch { /* 忽略 */ }
    appendFileSync(file, `${new Date().toISOString()}  ${event}  ${detail}\n`, 'utf8')
  } catch { /* 诊断永不抛 */ }
}

export function apply(ctx, config = {}) {
  diag('apply', `baseUrl=${String(ctx?.baseUrl ?? '(无)').slice(0, 90)}`
    + `｜agentPresets=${(() => { try { return ctx.get('agentPresets') ? '可见' : '不可见' } catch { return '取用抛错' } })()}`
    + `｜presetIds=${JSON.stringify(config?.presetIds ?? ['ppt'])}｜pid=${process.pid}`)
  // ── 装配防重（2026-09-14 新增 profile bundle 安装路径后必需）────────────────────────
  // 同一个包可能在**同一进程**里被挂两次：
  //   ① profile bundle 行（包的 cordis.patch.yml，`dsh plugin add` 装完即挂）；
  //   ② agent preset 插件行（install.mjs 写的 `~/.dsh/.agent-presets/ppt/agent.cordis.yml`）。
  // 首个挂载真正装配，后续只计数（注册仍归各自 ctx.effect 所有，owner ctx 卸载即释放）。
  const CORE = globalThis.__pptCoreReg ?? { count: 0 }
  globalThis.__pptCoreReg = CORE
  if (CORE.count > 0) {
    CORE.count++
    try {
      loggerOf(ctx)?.warn?.('[ppt-studio] 本包在同一进程被挂载了两次（profile bundle 行 + agent preset 行？）——'
        + '已按"首个生效"跳过本次装配。两者是替代关系，建议二选一：`dsh plugin --profile <p> remove <包>` 或移除预设里的插件行（见 README §0.7）。')
    } catch { /* 无 logger 时静默 */ }
    ctx.effect(() => () => { CORE.count-- }, 'ppt-studio: duplicate mount (ref)')
    return
  }
  CORE.count++
  // 注意 Cordis 语义：`ctx.effect(cb)` **立即执行 cb**，并用 cb 的**返回值**当 disposer。
  // 所以计数递减必须写成"返回一个函数"（写成 `() => { count-- }` 会当场递减，等于没防重——
  // 这个错误由 smoke 的行为断言当场抓到）。
  ctx.effect(() => () => { CORE.count-- }, 'ppt-studio: core mount (ref)')

  // ── 全局管道（与会话无关）──────────────────────────────────────────────────────
  registerPreviewRoute(ctx) // /ppt-preview/ 路由（无 webServer 环境自动跳过）
  ensureAgentPreset(ctx, config) // 自交付「PPT 工作室」预设：只在缺失时写、不覆盖、可关闭

  // 语义路由：user/message → 激活/退出（auto 模式）。只写会话状态文件，不暴露任何能力面。
  ctx.on('session/event', async (session, event) => {
    if (event.type !== 'user/message') return
    const data = event.data ?? {}
    if (data.source?.kind !== 'user' && data.source?.kind !== undefined) return
    const text = extractText(data)
    const attachments = data.attachments ?? []
    try {
      const state = await loadSession(session.id)
      if (state.routing === 'off') return
      if (state.routing === 'on') { state.workflowActive = true; await saveSession(session.id, state); return }
      // auto：语义判断
      if (!state.workflowActive && isPptIntent(text, attachments)) {
        state.workflowActive = true
        state.taskType = detectTaskType(text)
        if (isQuickIntent(text)) state.quick = true
        await saveSession(session.id, state)
      } else if (state.workflowActive && isPptOff(text) && !attachments.some((a) => /\.pptx?$/i.test(a.name ?? a.path ?? ''))) {
        state.workflowActive = false
        await saveSession(session.id, state)
      } else if (state.workflowActive && isQuickIntent(text, true)) {
        state.quick = true
        await saveSession(session.id, state)
      }
    } catch { /* 防缺失目录等异常 */ }
  })

  // 工作流提示词注入：**逐次按该 agent 的预设门控**（非本插件的会话绝不注入）
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (!agent?.session?.id) return assembled
    if (!(await agentIsOurs(ctx, agent, config))) return assembled
    const sessionId = agent.session.id
    let state
    try { state = await loadSession(sessionId) } catch { return assembled }
    if (!state.workflowActive) return assembled
    const sections = [...(assembled.sections ?? [])]
    const idx = sections.findIndex((s) => s?.name === 'ppt-workflow')
    if (idx >= 0) sections.splice(idx, 1)
    sections.push(workflowSection(state.taskType ?? 'unknown', state))
    return { ...assembled, sections }
  })

  // ── 路 A 的核心：逐 agent 按预设把能力面挂到**该 agent 的作用域** ──────────────────
  ctx.on('agent/created', ({ agent }) => {
    // 不 await：钩子是同步 emit；注册是幂等的，失败只告警
    diag('agent/created', `agent=${agent?.id ?? '(无)'}｜composedPreset=${(() => {
      try { return String(ctx.get('agentPresets')?.composedPreset?.(agent?.ctx)) } catch (e) { return '抛错:' + String(e?.message ?? e).slice(0, 40) }
    })()}`)
    void mountForAgent(ctx, agent, config).then((r) => {
      diag('mount', `agent=${agent?.id ?? '(无)'}｜mounted=${r?.mounted}｜reason=${String(r?.reason ?? '').slice(0, 120)}`)
    })
  })
}

/**
 * 把能力面挂到某个 agent 的作用域（仅当该 agent 属于本插件的预设）。
 * 幂等：同一 agent 只挂一次（防 profile bundle 行 + preset 行双挂时的重复注册）。
 */
export async function mountForAgent(ctx, agent, config = {}) {
  const id = agent?.id ?? agent?.session?.id
  const actx = agent?.ctx
  if (!id || !actx) return { mounted: false, reason: 'agent 缺少 id 或 ctx' }
  const REG = agentReg()
  if (REG.has(id)) return { mounted: false, reason: '该 agent 已挂载（幂等跳过）' }
  if (!(await agentIsOurs(ctx, agent, config))) return { mounted: false, reason: '该 agent 不在本插件的预设上' }
  REG.add(id)
  // 注意：清理逻辑必须包在**返回的函数**里（写成 `() => REG.delete(id)` 会当场执行）
  try { actx.effect(() => () => { REG.delete(id) }, 'ppt-studio: agent reg (ref)') } catch { /* 无 effect 时降级 */ }
  const failed = []
  const step = (label, fn) => { try { fn() } catch (e) { failed.push(`${label}: ${String(e?.message ?? e)}`) } }
  step('tools', () => registerTools(actx))
  step('commands', () => registerCommands(actx))
  step('ppt_state', () => statusToolFor(actx))
  step('skills', () => registerManualSkill(actx))
  if (failed.length) loggerOf(ctx)?.warn?.(`[ppt-studio] agent ${id} 部分能力面挂载失败：${failed.join('；')}`)
  return { mounted: failed.length === 0, reason: failed.length ? failed.join('；') : 'ok' }
}

/** 该 agent 是否属于本插件（带缓存：预设不会在会话中途改变——"只有空白会话能切预设"）。 */
async function agentIsOurs(ctx, agent, config = {}) {
  const id = agent?.id ?? agent?.session?.id
  if (!id) return true
  const CACHE = oursCache()
  if (CACHE.has(id)) return CACHE.get(id)
  const v = await computeOurs(ctx, agent, config)
  CACHE.set(id, v)
  return v
}

/**
 * 判定规则（顺序即优先级）：
 *   ① 拿不到 `agentPresets` 服务 → **失败开放**（环境不支持 roster，保持今天的行为）；
 *   ② 该 agent 没有加入任何预设 → **失败开放**（同上）；
 *   ③ 预设 id ∈（config.presetIds ?? ['ppt']）∪（名册里"行中含本包"的预设 id）→ true；
 *   ④ 其余 → false（**这就是隔离**）。
 */
async function computeOurs(ctx, agent, config = {}) {
  let ap
  try { ap = ctx.get('agentPresets') } catch { return true }
  if (!ap || typeof ap.composedPreset !== 'function') return true
  let presetId = null
  try { presetId = ap.composedPreset(agent.ctx) ?? null } catch { return true }
  if (!presetId) return true
  const ids = new Set(Array.isArray(config?.presetIds) && config.presetIds.length ? config.presetIds : DEFAULT_PRESET_IDS)
  if (typeof config?.presetIds === 'string' && config.presetIds) ids.add(config.presetIds)
  try {
    const inv = await ap.compositionInventory()
    for (const c of inv ?? []) {
      const cid = c?.id ?? c?.preset ?? c?.agentPreset
      if (!cid) continue
      const rows = c?.rows ?? c?.entries ?? c?.composition ?? []
      const flat = Array.isArray(rows) ? rows : []
      // ① 行里点名本包（非 bundle 模式：预设带插件行）→ 该预设属于我们
      if (flat.some((r) => r?.name === name || r?.moduleName === name)) { ids.add(String(cid)); continue }
      // ② 显示名兜底（降低"预设被改名 → PPT 会话什么都拿不到"的风险）
      const label = `${c?.displayName ?? ''} ${c?.name ?? ''} ${c?.title ?? ''}`
      if (/PPT\s*工作室|ppt-studio/i.test(label)) ids.add(String(cid))
    }
  } catch { /* 名册读不到就只用配置的 id——够用（默认 'ppt' 就是本包预设的目录名） */ }
  return ids.has(String(presetId))
}

function extractText(data) {
  const c = data.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ')
  return ''
}

/** 调试工具（agent 可见）：当前工作流状态。 */
export function statusToolFor(ctx) {
  return ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ppt_state',
    description: '查看/更新 PPT 工作流会话状态（档位/激活）。debug/自优化用',
    parameters: {
      set: { type: 'string', description: '可选 key=value（如 mode=strict workflowActive=true）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args, exec) {
      // 会话 id 取自工具执行的 agent（DSH 的 execute(args, exec) 第二参数）；
      // 历史坑：ctx.get('agent') 恒为 undefined（DSH 只有 agents 服务），会误落到 'default' 会话文件。
      const agent = exec?.agent
      const sid = agent?.session?.id ?? agent?.id ?? 'default'
      const state = await loadSession(sid)
      if (args.set) {
        for (const kv of String(args.set).split(/\s+/)) {
          const [k, ...rest] = kv.split('=')
          const v = rest.join('=')
          if (k && v !== undefined) state[k] = v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : v
        }
        await saveSession(sid, state)
      }
      // 交付通道自检：内嵌技能在技能注册表里是否可见（自包含诊断，不依赖外部工具）
      const delivery = manualSkillStatus()
      try {
        const skills = ctx.get('skills')
        if (skills === undefined) delivery.visible = 'skills 服务缺失'
        else {
          const rows = []
          for (const s of delivery.skills) {
            const one = await skills.get(s.name)
            rows.push(`${s.name}=${one === undefined ? 'MISSING' : `${String(one.provider)}/${String(one.source)}/len=${String(one.content).length}`}`)
          }
          delivery.visible = rows.length ? rows.join(' · ') : 'MISSING'
        }
      } catch (error) {
        delivery.visible = `查询失败：${error?.message ?? error}`
      }
      return JSON.stringify({ session: sid, state, manualSkill: delivery }, null, 2)
    },
  })), 'ppt-studio: ppt_state')
}
