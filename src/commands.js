/**
 * /ppt 斜杠命令面（命令 > 语义；命令写入会话/项目状态）。
 * /ppt                                    → 状态查询
 * /ppt on|off                             → 强制进入/退出工作流
 * /ppt free|mid|strict                    → 强制协作模式
 * /ppt fidelity strict|auto|free [--dir D]     （--page 未实现 → 明确拒绝，见分支内注释）
 * /ppt review none|points|every
 * /ppt engine pptd|python-pptx|pptxgenjs
 * /ppt quality quick|standard|audit
 * /ppt pause-after outline|layout|pages|overall [--dir D]
 * /ppt help
 */
import { loadSession, saveSession, loadProject, saveProject } from './state.js'

export function registerCommands(ctx) {
  ctx.commands.register({
    name: 'ppt',
    description: 'PPT 工作流控制：进入/退出、快速模式、协作模式、引擎、质量、暂停点',
    input: { hint: '[on|off|quick|normal|free|mid|strict|fidelity <v>|review <v>|engine <v>|quality <v>|pause-after <v>|help]' },
    handler: (invocation) => handle(invocation),
  })
}

async function handle(invocation) {
  const sessionId = invocation.agent.session?.id ?? 'default'
  const input = invocation.rawInput.trim()
  const state = await loadSession(sessionId)
  const [cmdRaw, ...rest] = input.split(/\s+/)
  const cmd = (cmdRaw ?? '').toLowerCase()
  const args = rest.join(' ').trim()
  const dir = argValue(args, '--dir')

  try {
    if (cmd === '' || cmd === 'status') return textStatus(state, dir, await projectSummary(dir))
    if (cmd === 'help') {
      return ok('PPT 工作流命令：/ppt [on|off|free|mid|strict|fidelity <v>|review <v>|engine <v>|quality <v>|pause-after <v>|help]。语义检测自动进入；命令强制优先。')
    }
    if (cmd === 'on') { state.routing = 'on'; state.workflowActive = true; await save(); return ok('✓ PPT 工作流已强制进入（语义退出已屏蔽）') }
    if (cmd === 'off') {
      state.routing = 'off'; state.workflowActive = false
      await save()
      return ok('✓ PPT 工作流已退出（PPT 任务将按标准模式能力处理）')
    }
    if (cmd === 'free' || cmd === 'mid' || cmd === 'strict') {
      state.mode = cmd
      await save()
      return ok(`✓ 协作模式=${cmd}（下次任务生效；free 可跳过询问环节）`)
    }
    if (cmd === 'quick') {
      state.quick = true
      await save()
      return ok('✓ 快速模式已开启：低 token 快交付——跳过视觉定调/素材搜索/视觉审阅迭代；数字门禁照跑；回完整模式用 /ppt normal')
    }
    if (cmd === 'normal') {
      state.quick = false
      await save()
      return ok('✓ 已回到完整模式（视觉定调/素材/审阅迭代恢复）')
    }
    if (cmd === 'fidelity') {
      const v = (args.split(' ')[0] ?? '').toLowerCase()
      if (!['strict', 'auto', 'free'].includes(v)) return err('fidelity 取值 strict|auto|free')
      const pageN = argValue(args, '--page')
      if (pageN !== undefined && pageN !== '') {
        // 2026-09-26：`--page` 此前是**空操作却回执"已记录"**（算了 idx 不用、`for (…){ void p }` 空循环、
        // saveProject 无语义写入），而页级 fidelity 在 DSL/schema/项目 state 里**根本不存在**
        // （docs/01 §5 C5：「页级覆盖字段未做（待定）」）。按本文件既有的诚实先例处理：
        // engine 分支对未实现的 pptxgenjs 就是"明确拒绝，不装作成功"。这里一并不再改任何状态。
        return err(`页级 fidelity 未实现：--page ${pageN} 不会改变任何东西（页级字段在 DSL 与 state 里都不存在，见 docs/01 §5 C5）。
  · 现在只有**会话级**：/ppt fidelity ${v}
  · 若确实要"某几页 strict、其余 free"，请明确提出——那是新特性（需先定 DSL 字段与门禁语义），不在修复范围。`)
      }
      state.fidelity = v
      await save()
      return ok(`✓ 会话忠实度=${v}（记录/展示用：当前版本它不改变门禁与流程，只回显在工作流提示与状态行）`)
    }
    if (cmd === 'review') {
      const v = (args.split(' ')[0] ?? '').toLowerCase()
      if (!['none', 'points', 'every'].includes(v)) return err('review 取值 none|points|every')
      state.review = v
      await save()
      return ok(`✓ 审阅频率=${v}`)
    }
    if (cmd === 'engine') {
      const v = (args.split(' ')[0] ?? '').toLowerCase()
      // pptxgenjs **未实现**（v1.0 前按计划不动）。旧实现把它收下、回执"已记录（待接入）"并写进会话状态，
      // 而导出侧根本不认它 ⇒ 用户以为选了引擎，实际静默按 pptd 跑。未实现就明确拒绝，不装作成功。
      if (v === 'pptxgenjs') return err('pptxgenjs 第三引擎**未实现**（v1.0 前按计划不动，见 docs/04）——不会静默切到 pptd。可用：auto|pptd|python-pptx')
      if (!['auto', 'pptd', 'python-pptx'].includes(v)) return err('engine 取值 auto|pptd|python-pptx')
      state.engine = v
      await save()
      return ok(`✓ 引擎=${v}（auto = pptd 主引擎 + 硬失败时兜底 python-pptx；此设置会被 ppt_export 采纳）`)
    }
    if (cmd === 'quality') {
      const v = (args.split(' ')[0] ?? '').toLowerCase()
      if (!['quick', 'standard', 'audit'].includes(v)) return err('quality 取值 quick|standard|audit')
      state.quality = v
      await save()
      if (dir) { const proj = await loadProject(dir); proj.quality = v; await saveProject(dir, proj) }
      return ok(`✓ 质量模式=${v}`)
    }
    if (cmd === 'template') {
      const v = (args.split(' ')[0] ?? '').trim()
      if (!v) {
        const { listTemplates } = await import('./templates.js')
        const list = await listTemplates()
        if (!list.length) return err('模板库为空（templates/ 缺失）')
        state.template = undefined
        await save()
        return ok(`可用模板（${list.length} 套）：${list.map((t) => `${t.id}=${t.name}`).join('、')}\n用法：/ppt template <id>（记录本会话默认模板；用 ppt_templates 看完整清单与预览图）`)
      }
      const { templateWorkspace } = await import('./templates.js')
      try {
        const t = await templateWorkspace(v)
        state.template = v
        await save()
        return ok(`✓ 本会话默认模板=${t.meta.name ?? v}（${v}）——S0/S2 优先使用；新建工作区：ppt_new dir=<目录> template=${v}`)
      } catch (e) {
        return err(String(e?.message ?? e))
      }
    }
    if (cmd === 'pause-after') {
      const v = (args.split(' ')[0] ?? '').toLowerCase()
      if (!['outline', 'layout', 'pages', 'overall', 'none'].includes(v)) return err('pause-after 取值 outline|layout|pages|overall|none')
      if (v === 'none') state.pauseAfter = []
      else state.pauseAfter = [...new Set([...state.pauseAfter, v])]
      await save()
      if (dir) { const proj = await loadProject(dir); proj.pauseAfter = state.pauseAfter; await saveProject(dir, proj) }
      return ok(`✓ 暂停点=${state.pauseAfter.join('、') || '无'}`)
    }
    return err(`未知子命令 "${cmd}"；/ppt help 查看用法`)
  } catch (error) {
    return { kind: 'error', text: `ppt 命令失败：${error?.message ?? error}` }
  }

  async function save() { await saveSession(sessionId, state) }
}

async function projectSummary(dir) {
  if (!dir) return []
  const proj = await loadProject(dir)
  return [`项目(${dir}): 任务 ${proj.taskType ?? '—'}｜阶段 ${proj.stage ?? '—'}｜质量 ${proj.quality}`]
}

function textStatus(state, dir, extra) {
  const lines = [
    `PPT 工作流：${state.workflowActive ? '✓ 激活中' : '未激活'}（routing=${state.routing}，语义自动/命令强制）`,
    `快速模式=${state.quick ? 'on（跳过定调/素材/视觉审阅迭代）' : 'off'}｜协作模式=${state.mode}｜忠实度=${state.fidelity}｜审阅=${state.review}｜质量=${state.quality}｜引擎=${state.engine}（auto=pptd）`,
    `暂停点=${state.pauseAfter.length ? state.pauseAfter.join('、') : '无'}${state.template ? `｜模板=${state.template}` : ''}`,
    ...extra,
    '',
    '/ppt [on|off|quick|normal|free|mid|strict|fidelity <v>|review <v>|engine <v>|quality <v>|template <id>|pause-after <v>|help]',
  ]
  return ok(lines.join('\n'))
}

function argValue(input, name) {
  const m = input.match(new RegExp(`${name}\\s+(\"[^\"]+\"|'[^']+'|\\S+)`))
  return m ? m[1].replace(/^["']|["']$/g, '') : null
}

function ok(text) { return { kind: 'success', text } }
function err(text) { return { kind: 'error', text } }
