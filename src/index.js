/**
 * dsh-ppt-studio —— PPT 工作室插件（host）。
 *
 * 装配模型（2026-09-18 **第二次修订：回滚为"装上即可用"**）：
 *   `apply()` 做四件事——① 装配防重；② **全局管道**（/ppt-preview 路由、预设自交付、语义路由）；
 *   ③ 工作流提示段注入（`system-prompt/assemble`）；④ **在本 ctx 注册全部能力面**：
 *   21 个 `ppt_*` 工具 / `/ppt` 命令面 / `ppt_state` / 4 本内嵌技能。
 *   ⇒ **装上插件，所有会话都能用**（= 1.0.0 的行为）。
 *
 * 为什么放弃了"只让「PPT 工作室」预设看到"（两件事，都有实测与源码依据）：
 *   ① **切换预设拿不到**：空白会话切预设时 `agent-presets.swap` 确实会 `recompose(agent.ctx, id)`，
 *      但那一刻该 agent **已经存在**，而我们的 `agent/created` 监听者是在这次组合里才注册的
 *      ⇒ 它永远不会为这个已有 agent 触发 ⇒ "先建会话再切到该预设"永远看不到工具
 *      （用户实测：只有一开始就建在该预设上才有工具）。
 *   ② **技能在父层读不到**：技能注册表分层，技能工具在**预设层**读；我们只能注册到 `agent.ctx`（子层）
 *      或 profile 根 ⇒ 预设层读不到 ⇒ 技能永不出现。而"用预设行挂载"这条路同样封死
 *      （行里的裸包名按 **harness base** 解析，不是 profile ⇒ 预设被判 `broken` ⇒ 选择器不显示它）。
 *   ⇒ 在这版 DSH 上，"按预设隔离"无法可靠交付。宁可**功能完整、行为可预期**，也不要"看起来隔离、
 *      实际一半会话没能力面"。隔离代码留在 git 历史（`4ea7037` 起的提交）里，等 DSH 提供稳定的
 *      "预设已组合/已切换"信号再恢复。
 *
 * 「PPT 工作室」预设仍然存在并自交付：它负责**身份/人格**（名字、简介、standard 能力面副本）。
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

export const name = 'dsh-ppt-studio'
// skills 为可选依赖（ctx.get('skills')）：极简装配缺 dsh-skill 时插件仍完整可用
export const inject = ['tools', 'commands', 'systemPrompt']

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

  // 工作流提示词注入（**不按预设门控**——见下"回滚"说明）
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (!agent?.session?.id) return assembled
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

  // ── 能力面：注册在**本 ctx**（= 装它的那一层）——2026-09-18 第二轮回滚 ──────────────────
  // 背景（用户实测 + DSH 源码实锤，两件事一起推翻了"按预设隔离"这条路）：
  //   ① **切换预设拿不到能力面**：空白会话切预设（`agent-presets.swap`）确实会
  //      `recompose(agent.ctx, id)` 重新组合，但那一刻**该 agent 已经存在**——我们的
  //      `agent/created` 监听者是在这次组合中才注册的，**永远不会**为这个已有 agent 触发。
  //      于是"先建会话再切过去"= 工具永远不出现（用户原话：只有一开始就是该预设才有工具）。
  //   ② **技能在预设层读不到**：注册表是**分层**的（`dsh-skill` 的 preset 层），而技能工具
  //      （`tool-skill`）在**预设层**读；我们注册进 `agent.ctx`（子层）⇒ 父层读不到 ⇒ 技能永远不出现。
  //      在 profile bundle 装法下我们的 ctx 就是 profile 根，**够不到预设层**，
  //      而预设行又无法解析本包（行按 harness base 解析，见 preset 模板末尾说明）⇒ 这条路封死。
  // 结论：本 DSH 版本上"只让某个预设看到工具/技能"**无法可靠交付**。按用户指示回滚到
  // 「装上插件 → 所有会话都能用」这一久经验证的行为（= 1.0.0 的行为），并把预设保留为**身份/人格**。
  const faces = []
  const step = (label, fn) => { try { fn() } catch (e) { faces.push(`${label}: ${String(e?.message ?? e)}`) } }
  step('tools', () => registerTools(ctx))
  step('commands', () => registerCommands(ctx))
  step('ppt_state', () => statusToolFor(ctx))
  step('skills', () => registerManualSkill(ctx))
  if (faces.length) loggerOf(ctx)?.warn?.(`[ppt-studio] 部分能力面注册失败：${faces.join('；')}`)
  diag('faces', `tools/commands/ppt_state/skills 已注册在 apply ctx（回滚为全局可见）｜失败=${faces.length ? faces.join(';') : '无'}`)
}

/**
 * 【已删除】`mountForAgent` / `agentIsOurs` / `computeOurs`（2026-09-18 第二次修订回滚）
 *
 * 它们实现了"只让「PPT 工作室」预设的会话看到工具/技能"，但在这版 DSH 上**无法可靠交付**：
 *   ① 空白会话**切换**预设时，`agent-presets.swap` 会 `recompose(agent.ctx, id)`，可那一刻该 agent
 *      已经存在——我们的 `agent/created` 监听者是这次组合才注册的，**不会**为它触发 ⇒ 工具永不出现
 *      （用户实测：只有一开始就是该预设才有工具）；
 *   ② 技能注册表是**分层**的，技能工具在**预设层**读，而我们只能注册到 `agent.ctx`（子层）或
 *      profile 根 ⇒ 父层读不到 ⇒ 技能永不出现；而"预设行挂载"这条路又被
 *      "行按 harness base 解析"封死（见 agent-presets/ppt/agent.cordis.yml 末尾说明）。
 * 代码留在 git 历史里（提交 4ea7037 起）。若将来 DSH 提供稳定的"预设已切换/已组合"信号，
 * 可以按同样的形状恢复隔离。
 */

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
