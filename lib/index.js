/**
 * dsh-ppt-studio —— PPT 工作室插件（host）。
 *
 * 装配模型（2026-09-24 **第三次修订：适配 DSH 0.1.7-rc.1**）：
 *   `apply()` 做四件事——① 装配防重；② **全局管道**（/ppt-preview 路由、预设**声明**、语义路由）；
 *   ③ 工作流提示段注入（`system-prompt/assemble`）；④ **在本 ctx 注册全部能力面**：
 *   22 个 `ppt_*` 工具 / `/ppt` 命令面 / `ppt_state` / 4 本内嵌技能。
 *   ⇒ **装上插件，所有会话都能用**（= 1.0.0 的行为）。
 *
 * 0.1.7 的那一处真适配是**预设交付**：宿主不再扫描 `<dshHome>/.agent-presets/`（上游原文
 * "the harness discovers no preset on disk"），预设改为向 `agentPresets` 注册表**声明**。
 * 详见 src/preset-delivery.js 顶部（含 `!!js` 保真与相对名解析这两条源码级细节）。
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
import { registerPreviewRoute, previewRoot } from './preview-server.js'
import { userTemplatesDir } from './templates.js'
import { dshHome, pptStudioDir } from './home.js'
import { registerManualSkill, manualSkillStatus } from './skill.js'
import { declareAgentPreset, presetDeliveryStatus } from './preset-delivery.js'
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
    // 用户目录口径统一（2026-09-26）：不再在此各自实现 `DSH_HOME || USERPROFILE/HOME`，见 src/home.js。
    const dir = pptStudioDir()
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
  //   ② 预设内的插件行（`--isolate` 模式把本包挂进「PPT 工作室」预设的组合里）。
  // 首个挂载真正装配，后续只计数（注册仍归各自 ctx.effect 所有，owner ctx 卸载即释放）。
  // 第二条在本版本上更重要：预设声明会随第二次装配**重复注册**，而注册表对重复 id 直接
  // throw（`Duplicate agent preset`）——防重同时挡住了这个双挂载事故。
  const CORE = globalThis.__pptCoreReg ?? { count: 0 }
  globalThis.__pptCoreReg = CORE
  if (CORE.count > 0) {
    CORE.count++
    try {
      loggerOf(ctx)?.warn?.('[ppt-studio] 本包在同一进程被挂载了两次（profile bundle 行 + 预设内的插件行？）——'
        + '已按"首个生效"跳过本次装配。两者是替代关系，建议二选一：`dsh plugin --profile <p> remove <包>` 或改用 `--isolate` 安装（见 README §0.7）。')
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
  // 2026-09-26 桌面端事故（宿主警告原文："1 entry did not activate ppt-studio (dsh-ppt-studio):
  // TypeError: ws.register(...).then is not a function"）：`registerPreviewRoute` 里一处"对同步返回值
  // 调 .then"的 TypeError 从 apply **同步抛出** ⇒ 整个插件条目激活失败，用户连 ppt_state 都调不到
  // （能看到的只有那一行宿主警告）。根因已在 preview-server.js 修掉；这里再兜一层，理由与下方 faces 一致：
  // 全局管道是**附加能力**，坏掉只该降级（预览链接/预设声明失效），绝不该让整个能力面消失。
  const pipeline = []
  const pipeStep = (label, fn) => {
    try { return fn() } catch (e) { pipeline.push(`${label}: ${String(e?.message ?? e)}`); return undefined }
  }
  // 诊断要把"跳过了"和"注册了"分开记：`registerPreviewRoute` 在拿不到 webServer 时返回 null
  // （极简装配、或组合顺序排在 webServer 之前都会这样）——这与"注册失败"是两回事。
  let routeState = 'pending(inject)'
  pipeStep('previewRoute', () => {
    // webServer 可能比本插件**晚激活**：2026-09-26 真宿主实测（隔离 DSH_HOME + `dsh --profile web`，
    // 插件自己的落盘诊断原文 `预览路由=skipped(no webServer)`）——直接 `ctx.get('webServer')` 在那种
    // 组合顺序下拿不到服务，路由会被**静默跳过**，用户点预览链接必然 404。
    // 与 agentPresets 同一姿势：用 `inject` 等它出现再注册，服务消失时子 ctx 一并释放。
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (child) => {
        const disposer = registerPreviewRoute(child)
        routeState = disposer ? 'active' : 'skipped(子 ctx 无 webServer)'
        diag('previewRoute', `inject 就绪 → ${routeState}`)
        return disposer ?? undefined
      })
    } else {
      routeState = registerPreviewRoute(ctx) ? 'active' : 'skipped(宿主无 inject)'
    }
  })
  // 声明「PPT 工作室」预设（0.1.7 起：注册表声明，不再写预设目录——目录已无发现路径）。
  // 失败只告警不抛；状态经 ppt_state 的 presetDelivery 暴露，避免"预设没出现"只能翻日志。
  pipeStep('agentPreset', () => declareAgentPreset(ctx, config))
  if (pipeline.length) loggerOf(ctx)?.warn?.(`[ppt-studio] 全局管道部分失败（已降级，能力面仍可用）：${pipeline.join('；')}`)
  diag('pipeline', `预览路由=${routeState}｜预设声明=${pipeline.some((l) => l.startsWith('agentPreset')) ? '失败' : 'OK'}`
    + (pipeline.length ? `｜失败=${pipeline.join('; ')}` : ''))

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
 * 代码留在 git 历史里（提交 4ea7037 起）。
 *
 * 【2026-09-24 补注（0.1.7-rc.1）】当时封死"预设行挂载"的那条判据**依然成立**：注册表 mount 预设时
 * 用 `scope.ctx.extend({ baseUrl: <注册表所在 ctx 的 baseUrl> })`（= harness base），裸包名
 * `dsh-ppt-studio` 在那里解析不到 ⇒ 预设会被判 broken。所以现在的 `--isolate` 走的是
 * 另一条路：**不挂 profile bundle**，把插件行写进预设声明的 `plugins` 里，并给插件行
 * `autoPreset:false`（预设已由该声明本身提供，插件不能再声明一次）。本注释里的
 * `mountForAgent` 是"插件自己在运行时按 agent 门控"那套，与上面这条不同，仍然不恢复。
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
      // 路径自检（2026-09-26，方案 B 第二批）：用户目录口径统一后，把解析结果一并暴露——
      // 排查"会话状态/模板/预览各落在哪"不用再猜；也避免再次出现 state/preview 忽略 DSH_HOME 那类分裂。
      const paths = {
        dshHome: dshHome(),
        pptStudio: pptStudioDir(),
        sessionState: pptStudioDir(),
        templates: userTemplatesDir(),
        preview: previewRoot(),
      }
      return JSON.stringify({ session: sid, state, manualSkill: delivery, presetDelivery: presetDeliveryStatus(), paths }, null, 2)
    },
  })), 'ppt-studio: ppt_state')
}
