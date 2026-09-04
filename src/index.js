/**
 * @dsh-external/dsh-ppt-studio —— PPT 工作室插件（host）。
 * 装配：/ppt 命令面 + ppt_* 工具 + 语义路由（session/event + system-prompt/assemble）。
 * 所有注册挂 ctx.effect / ctx.on（卸载即净）。
 */
import { registerTools, defineTool } from './tools.js'
import { registerCommands } from './commands.js'
import { loadSession, saveSession } from './state.js'
import { isPptIntent, isPptOff, isQuickIntent, detectTaskType, workflowSection } from './router.js'
import { registerPreviewRoute } from './preview-server.js'

export const name = '@dsh-external/dsh-ppt-studio'
export const inject = ['tools', 'commands', 'systemPrompt']

export function apply(ctx, config = {}) {
  registerTools(ctx)
  registerCommands(ctx)
  statusToolFor(ctx)
  registerPreviewRoute(ctx) // 需求 A：对话内预览服务（/ppt-preview/ 路由；无 webServer 环境自动跳过）

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
    async execute(args) {
      const agent = ctx.get('agent')
      const sid = agent?.session?.id ?? 'default'
      const state = await loadSession(sid)
      if (args.set) {
        for (const kv of String(args.set).split(/\s+/)) {
          const [k, ...rest] = kv.split('=')
          const v = rest.join('=')
          if (k && v !== undefined) state[k] = v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : v
        }
        await saveSession(sid, state)
      }
      return JSON.stringify(state, null, 2)
    },
  })), 'ppt-studio: ppt_state')
}
