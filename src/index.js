/**
 * @dsh-external/dsh-ppt-studio —— PPT 工作室插件（host）。
 * 装配：/ppt 命令面 + ppt_* 工具 + 内置手册 skill（内嵌注册）+ 语义路由（session/event + system-prompt/assemble）。
 * 所有注册挂 ctx.effect / ctx.on（卸载即净）。
 */
import { registerTools, defineTool } from './tools.js'
import { registerCommands } from './commands.js'
import { loadSession, saveSession } from './state.js'
import { isPptIntent, isPptOff, isQuickIntent, detectTaskType, workflowSection } from './router.js'
import { registerPreviewRoute } from './preview-server.js'
import { registerManualSkill, manualSkillStatus, MANUAL_NAME } from './skill.js'

export const name = '@dsh-external/dsh-ppt-studio'
// skills 为可选依赖（ctx.get('skills')）：极简装配缺 dsh-skill 时插件仍完整可用
export const inject = ['tools', 'commands', 'systemPrompt']

export function apply(ctx, config = {}) {
  registerTools(ctx)
  registerCommands(ctx)
  statusToolFor(ctx)
  registerPreviewRoute(ctx) // 需求 A：对话内预览服务（/ppt-preview/ 路由；无 webServer 环境自动跳过）
  registerManualSkill(ctx) // 内置提问式手册：内嵌运行时 skill（无 skills 服务/手册缺失时静默跳过）

  const armed = new Map() // 快速内存缓存：session id -> state

  // 语义路由：user/message → 激活/退出（auto 模式）
  ctx.on('session/event', async (session, event) => {
    if (event.type !== 'user/message') return
    const data = event.data ?? {}
    if (data.source?.kind !== 'user' && data.source?.kind !== undefined) return
    const text = extractText(data)
    const attachments = data.attachments ?? []
    try {
      const state = await loadSession(session.id)
      if (state.routing === 'off') return
      if (state.routing === 'on') { state.workflowActive = true; state.deckDir = state.deckDir; await saveSession(session.id, state); return }
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

  // 工作流提示词注入（状态激活时）
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

  void defineTool // 工具注册在 tools.js（statusToolFor 使用）
  void armed
  void config
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
      // 交付通道自检：内嵌手册 skill 在技能注册表里是否可见（自包含诊断，不依赖外部工具）
      const delivery = manualSkillStatus()
      try {
        const skills = ctx.get('skills')
        if (skills === undefined) delivery.visible = 'skills 服务缺失'
        else {
          const one = await skills.get(MANUAL_NAME)
          delivery.visible = one === undefined ? 'MISSING' : `${String(one.provider)}/${String(one.source)}/len=${String(one.content).length}`
        }
      } catch (error) {
        delivery.visible = `查询失败：${error?.message ?? error}`
      }
      return JSON.stringify({ session: sid, state, manualSkill: delivery }, null, 2)
    },
  })), 'ppt-studio: ppt_state')
}
