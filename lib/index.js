/**
 * dsh-ppt-studio —— PPT 工作室插件（host）。
 *
 * 装配模型（2026-09-26 **第四次修订：按预设隔离**）：
 *   `apply()` 按**作用域档**分两种：
 *     · **profile 档**（装它的那一层，`config.scope` 缺省/`auto`/`profile`）：
 *       全局管道（`/ppt-preview` 路由）+ 预设**声明**（想隔离时追加一行**自定位行**）；
 *       隔离生效时**不注册任何能力面**——本档只负责"让预设存在 + 判定健康 + 出问题时兜底"。
 *     · **preset 档**（由自定位行挂进「PPT 工作室」预设的那一份，`config.scope === 'preset'`）：
 *       22 个 `ppt_*` 工具 / `/ppt` 命令面 / `ppt_state` / 4 本内嵌技能 / 语义路由 / 工作流提示段，
 *       **全部注册在预设作用域** ⇒ 只对该预设的会话可见（用户要求：其他预设完全不受影响）。
 *   ⇒ 「PPT 工作室」预设第一次成为**真正的开关**（此前它只提供人格，工具全局可见）。
 *
 * 为什么这次能做成而 2026-09-18 那次失败（详细判据见 git 历史与 docs/03）：
 *   ① 当年想"插件自己在运行时按 agent 门控"：空白会话切预设时 agent 已存在，
 *      `agent/created` 监听者不会为它触发 ⇒ 工具永不出现。**现在不经过 agent 生命周期**：
 *      预设的常驻组合在**声明时**就挂载（`dsh-agent-preset-registry` 声明即挂载），
 *      切换预设时宿主把 agent 的 scope 父指针 `rebind` 到新预设代 ⇒ 可见性自动跟随。
 *   ② 当年"预设行挂载"被"行按 harness base 解析"封死（裸包名/相对名解析不到 ⇒ 预设 broken）。
 *      **绝对值 `file://` 行不受 baseUrl 影响**（Loader 对非 `.` 开头的名字原样 `import(name)`）
 *      ⇒ 用 `import.meta.url` 现算本包入口路径即可，且升级换代不会陈旧。
 *   两条都在 2026-09-26 用真实宿主 + 隔离 DSH_HOME 实测通过（工具/技能/提示段可见性矩阵、
 *   切换预设、负面对照）。
 *
 * 向后兼容与降级（`scope: 'auto'` 是缺省值）：
 *   · 预设声明失败、注册表不可见（headless/sdk/minimal 等无 `agentPresets` 的部署）、
 *     或"声明成功但预设档实例没装配" ⇒ **自动回落到全局能力面**（功能完整，只是没隔离），
 *     并把原因写进 `ppt_state` 的 `presetDelivery.isolation`。
 *   · `config.scope === 'profile'` = 传统档，一律全局（给明确不需要隔离的用户）。
 */
import { registerTools, defineTool } from './tools.js'
import { registerCommands } from './commands.js'
import { loadSession, saveSession } from './state.js'
import { isPptIntent, isPptOff, isQuickIntent, detectTaskType, workflowSection } from './router.js'
import { registerPreviewRoute, previewRoot } from './preview-server.js'
import { userTemplatesDir } from './templates.js'
import { dshHome, pptStudioDir } from './home.js'
import { detectCapabilities, probeOfficeSkills } from './capabilities.js'
import { registerManualSkill, manualSkillStatus } from './skill.js'
import { declareAgentPreset, presetDeliveryStatus, notePresetStatus } from './preset-delivery.js'
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
 * 为什么落到**文件**而不是只打日志：
 *   桌面端"装上了但工具不可见"这类事故，现象是"会话里一个工具都没有"——那时连诊断工具本身都没挂上，
 *   三者在 UI 上长得一模一样：
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

/** 作用域档：`profile` = 装它的那一层（默认档：声明预设 + 全局管道）；`preset` = 由自定位行挂进「PPT 工作室」的那一份。 */
const TIER_PROFILE = 'profile'
const TIER_PRESET = 'preset'

/**
 * 挂载防重（2026-09-26 改为**按作用域**分档）。
 *
 * 为什么必须改：本包现在会**有意**在同一进程里挂两次——profile 档（声明预设、全局管道）
 * + 预设档（由自定位行挂进「PPT 工作室」，能力面注册在预设作用域）。旧的"首个生效"守卫会让
 * 第二个实例**整个不装配**（且是静默的：用户只会看到"预设里什么都没有"）。
 * 键的取法：profile 档固定一把；预设档按 **ctx 身份**取（`WeakMap` 发号）——这样预设被重挂
 * （新 generation）时新实例能装配，而同一 ctx 的重复 apply 仍被挡住。键随各自 ctx 释放而回收。
 */
const MOUNTS = { get current() { return mounts() } }

/** 每次调用重取（**不要**在模块顶层捕获）：既有的测试/诊断习惯是 `delete globalThis.__pptCoreReg` 重置，
 * 捕获常量会让那种重置失效（smoke 有 4 处这么用）。 */
function mounts() {
  const m = (globalThis.__pptCoreReg ??= { count: 0, keys: new Set(), ids: new WeakMap(), nextId: 1 })
  m.keys ??= new Set()
  m.ids ??= new WeakMap()
  m.nextId ??= 1
  return m
}

function scopeKeyOf(ctx) {
  if (ctx === null || typeof ctx !== 'object') return 'anon'
  const m = mounts()
  let id = m.ids.get(ctx)
  if (id === undefined) { id = m.nextId++; m.ids.set(ctx, id) }
  return id
}

function claimMount(ctx, tier) {
  const m = mounts()
  const key = tier === TIER_PRESET ? `preset#${scopeKeyOf(ctx)}` : 'profile'
  if (m.keys.has(key)) return { claimed: false, key }
  m.keys.add(key)
  m.count++
  // Cordis 语义：`ctx.effect(cb)` 立即执行 cb，用 cb 的**返回值**当 disposer ⇒ 这里必须"返回一个函数"。
  ctx.effect(() => () => { const cur = mounts(); cur.keys.delete(key); cur.count-- }, `ppt-studio: mount (${key})`)
  return { claimed: true, key }
}

/**
 * 隔离生效信号：**预设档实例真的装配了**才会置位（进程内）。
 * 为什么不用"审计注册表"判定健康：`dsh-agent-preset-registry` 的 docstring 明确警告
 * `diagnostic()/list()` **不得在宿主行自己的激活过程中调用**（它会 `await loader.await()` 等整棵树落定
 * ⇒ 与我们自己的激活互相等待 = 死锁风险）。而 `register()` 自身 `await record.ready`
 * ⇒ 它 resolve 时预设行**已经 import 并 apply 过**，所以"声明成功"几乎等价于"预设档实例已装配"；
 * 这里再用信号确认一次（400ms 宽限），拿不到就回落——宁可没隔离，也不能没能力。
 */
const SCOPE_SIGNAL_GRACE_MS = 400
/** 声明迟迟不落地（注册表在本部署里根本不存在 ⇒ `inject` 回调永不触发）时的兜底：到点直接回落。 */
const SCOPE_SETTLE_TIMEOUT_MS = 3000

/** 同 mounts()：每次重取，便于测试用 `delete globalThis.__pptScopeApplied` 重置。 */
function scopeSignal() {
  return (globalThis.__pptScopeApplied ??= { at: 0, presetId: '', pid: 0 })
}

function publishScopeApplied(config) {
  const s = scopeSignal()
  s.at = Date.now()
  s.presetId = String(config?.presetIds?.[0] ?? 'ppt')
  s.pid = process.pid
}

function awaitScopeSignal(timeoutMs, since) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = () => {
      if (scopeSignal().at >= since) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(tick, 25)
    }
    tick()
  })
}

/** 语义路由：user/message → 激活/退出（auto 模式）。只写会话状态文件，不暴露任何能力面。 */
function registerRouting(ctx) {
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

  // 工作流提示词注入：**只在注册它的那一层生效**——隔离生效时这一层就是**预设作用域**，
  // 于是其他预设的会话连提示段都不会被注入（用户要求"其他预设完全不受影响"）。
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
}

/** 能力面：22 个 `ppt_*` 工具 / `/ppt` 命令面 / `ppt_state` / 4 本内嵌技能，注册进**本 ctx 所在的作用域**。 */
function registerFaces(ctx, tier) {
  const faces = []
  const step = (label, fn) => { try { fn() } catch (e) { faces.push(`${label}: ${String(e?.message ?? e)}`) } }
  step('tools', () => registerTools(ctx))
  step('commands', () => registerCommands(ctx))
  step('ppt_state', () => statusToolFor(ctx, tier))
  step('skills', () => registerManualSkill(ctx))
  if (faces.length) loggerOf(ctx)?.warn?.(`[ppt-studio] 部分能力面注册失败：${faces.join('；')}`)
  return faces
}

export function apply(ctx, config = {}) {
  const tier = config?.scope === TIER_PRESET ? TIER_PRESET : TIER_PROFILE
  // `scope` 缺省 = 'auto'：**想隔离**（追加自定位行 + 预设档实例），但不健康时自动回落全局。
  // 只有显式 `scope: 'profile'` 才是"一律全局"（传统档，给明确不需要隔离的用户）。
  const wantIsolation = config?.scope !== TIER_PROFILE
  diag('apply', `tier=${tier}｜scope=${String(config?.scope ?? 'auto')}｜baseUrl=${String(ctx?.baseUrl ?? '(无)').slice(0, 90)}`
    + `｜agentPresets=${(() => { try { return ctx.get('agentPresets') ? '可见' : '不可见' } catch { return '取用抛错' } })()}`
    + `｜presetIds=${JSON.stringify(config?.presetIds ?? ['ppt'])}｜pid=${process.pid}`)

  const claim = claimMount(ctx, tier)
  if (!claim.claimed) {
    try {
      loggerOf(ctx)?.warn?.(`[ppt-studio] 同一作用域重复装配已跳过（key=${claim.key}）——`
        + 'profile 档与预设档是两个不同作用域，各自只该装配一次。')
    } catch { /* 无 logger 时静默 */ }
    return
  }

  // ── 预设档：能力面 + 语义路由 + 提示段**全部注册在预设作用域** ──────────────────────
  // 这一份实例是"预设常驻组合"的成员，它的 ctx 就是预设层 ⇒ 只对该预设的会话可见。
  if (tier === TIER_PRESET) {
    publishScopeApplied(config)
    registerRouting(ctx)
    const faces = registerFaces(ctx)
    diag('faces', `【preset 档】tools/commands/ppt_state/skills 注册在**预设作用域**`
      + `（只对「${String(config?.presetIds?.[0] ?? 'ppt')}」预设的会话可见）｜失败=${faces.length ? faces.join('; ') : '无'}`)
    return
  }

  // ── profile 档：全局管道（HTTP 预览路由只此一处）+ 预设声明 ─────────────────────────
  // 2026-09-26 桌面端事故（宿主警告原文："1 entry did not activate ppt-studio (dsh-ppt-studio):
  // TypeError: ws.register(...).then is not a function"）：`registerPreviewRoute` 里一处"对同步返回值
  // 调 .then"的 TypeError 从 apply **同步抛出** ⇒ 整个插件条目激活失败，用户连 ppt_state 都调不到
  // （能看到的只有那一行宿主警告）。根因已在 preview-server.js 修掉；这里再兜一层，理由与 faces 一致：
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
  // 想隔离时**追加自定位行**：预设的常驻组合会再挂本包一次（预设档实例），能力面因此落进预设作用域；
  // 本档只留"声明 + 全局管道 + 健康判定 + 兜底"。失败只告警不抛。
  const isolationSince = Date.now()
  let isolationSettled = false
  let declarationSettled = false
  const engageFallback = (why) => {
    if (isolationSettled) return
    isolationSettled = true
    try {
      loggerOf(ctx)?.warn?.(`[ppt-studio] 预设隔离未生效（${why}）⇒ 自动回落到**全局能力面**：`
        + '功能完整，但其他预设的会话也会看到 ppt_* 工具与技能。诊断见 ppt_state 的 presetDelivery。')
      notePresetStatus({ isolation: 'profile-fallback', reason: `隔离未生效（${why}）⇒ 已回落全局能力面` })
    } catch { /* 忽略 */ }
    registerRouting(ctx)
    const faces = registerFaces(ctx, TIER_PROFILE)
    diag('fallback', `隔离未生效（${why}）→ 能力面注册在 profile 根｜失败=${faces.length ? faces.join('; ') : '无'}`)
    if (pipeline.length) loggerOf(ctx)?.warn?.(`[ppt-studio] 全局管道部分失败（已降级，能力面仍可用）：${pipeline.join('；')}`)
  }

  pipeStep('agentPreset', () => declareAgentPreset(ctx, config, {
    selfRow: wantIsolation,
    onSettled: (health) => {
      declarationSettled = true
      if (!wantIsolation) return
      void (async () => {
        // 声明失败 / 注册表不可见 ⇒ 立刻回落（不留"装上了却什么都没有"的窗口）。
        if (!health.ok) { engageFallback(health.reason); return }
        // 声明成功 ⇒ 预设已被挂载过一次；再用「预设档实例已装配」信号确认（400ms 宽限）。
        const seen = await awaitScopeSignal(SCOPE_SIGNAL_GRACE_MS, isolationSince)
        if (seen) {
          isolationSettled = true
          notePresetStatus({ isolation: 'preset', reason: `隔离生效：能力面注册在「PPT 工作室」预设作用域（其他预设零影响）｜pid=${scopeSignal().pid}` })
          diag('isolation', `隔离生效：预设档实例已装配（pid=${scopeSignal().pid}）→ profile 档不注册任何能力面`)
          return
        }
        engageFallback('声明成功但预设档实例未装配')
      })()
    },
  }))
  // **兜底超时**（2026-09-26 实测发现的真漏洞）：`ctx.inject(['agentPresets'], cb)` 在"该服务在本部署里
  // 根本不存在"时**回调永不触发**（不是"触发并给 undefined"）⇒ 声明既不成功也不失败 ⇒ 只按 `onSettled`
  // 判定的话，这些部署（极简/sdk/无注册表）会"装上了却**零能力面**"。所以再加一道时间兜底：
  // 超时仍未见声明落地 ⇒ 立刻回落全局能力面。代价：这类部署启动后最多晚 SCOPE_SETTLE_TIMEOUT_MS 才有工具。
  if (wantIsolation) {
    setTimeout(() => {
      if (declarationSettled || isolationSettled) return
      engageFallback(`agentPresets 注册表在 ${SCOPE_SETTLE_TIMEOUT_MS}ms 内不可见（inject 回调未触发）`)
    }, SCOPE_SETTLE_TIMEOUT_MS)
  }
  if (pipeline.length) loggerOf(ctx)?.warn?.(`[ppt-studio] 全局管道部分失败（已降级，能力面仍可用）：${pipeline.join('；')}`)
  diag('pipeline', `预览路由=${routeState}｜预设声明=${pipeline.some((l) => l.startsWith('agentPreset')) ? '失败' : 'OK'}`
    + `｜隔离=${wantIsolation ? '待判定（自定位行）' : '未启用（scope=profile）'}`
    + (pipeline.length ? `｜失败=${pipeline.join('; ')}` : ''))

  // ── 传统档（`scope: 'profile'`）：不隔离，能力面直接注册在装它的那一层 ────────────────
  if (!wantIsolation) {
    notePresetStatus({ isolation: 'profile' })
    registerRouting(ctx)
    const faces = registerFaces(ctx, TIER_PROFILE)
    diag('faces', `【profile 档·传统】tools/commands/ppt_state/skills 注册在 apply ctx（全局可见）｜失败=${faces.length ? faces.join('; ') : '无'}`)
  }
}

/**
 * 【已删除】`mountForAgent` / `agentIsOurs` / `computeOurs`（2026-09-18 第二次修订回滚）
 *
 * 它们实现了"只让「PPT 工作室」预设的会话看到工具/技能"，但在这版 DSH 上**无法可靠交付**：
 *   ① 空白会话**切换**预设时，`agent-presets.swap` 会 `recompose(agent.ctx, id)`，可那一刻该 agent
 *      已经存在——我们的 `agent/created` 监听者是这次组合才注册的，**不会**为它触发 ⇒ 工具永不出现
 *      （用户实测：只有一开始就是该预设才有工具）；
 *   ② 技能注册表是**分层**的，技能工具在**预设层**读，而我们只能注册到 `agent.ctx`（子层）或
 *      profile 根 ⇒ 父层读不到 ⇒ 技能永不出现。
 * 代码留在 git 历史里（提交 4ea7037 起）。
 *
 * 【2026-09-24 补注（0.1.7-rc.1）】当时"预设行挂载"这条路也被判封死：注册表 mount 预设时
 * 用 `scope.ctx.extend({ baseUrl: <注册表所在 ctx 的 baseUrl> })`（= harness base），裸包名
 * `dsh-ppt-studio` 在那里解析不到 ⇒ 预设会被判 broken。
 *
 * 【2026-09-26 最终结论（0.1.7-rc.2，源码 + 真宿主实测）】**上面两条都不是"隔离不可行"，而是
 * "实现姿势不对"**：
 *   · ① 只对"插件自己按 agent 动态门控"成立；走**预设行挂载**不经过 agent 生命周期，切换预设时
 *     宿主把 agent 的 scope 父指针 `rebind` 到新预设代，可见性自动跟随。
 *   · ② 只对**裸包名/相对名**成立；**绝对 `file://` 行**不看 baseUrl（Loader 对非 `.` 开头的名字
 *     原样 `import(name)`）⇒ 用 `import.meta.url` 现算本包入口即可，升级换代不陈旧。
 *   · 技能分层的方向是对的**但不是障碍**：读路径按"查看方 scope 的链"合并（含 agent 自己那层），
 *     所以注册进**预设作用域**正是技能能被该预设看到的**充要姿势**。
 * 于是本文件重新实现了隔离（preset 档 + 自定位行 + 健康自证 + 自动回落）；`mountForAgent` 那套
 * "自己按 agent 门控"的写法仍不恢复。
 */

function extractText(data) {
  const c = data.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ')
  return ''
}

/** 调试工具（agent 可见）：当前工作流状态。 */
export function statusToolFor(ctx, tier = TIER_PROFILE) {
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
      // 装配自检（2026-09-26，第四次修订）：本次实例处在哪个作用域、隔离是否生效、预设是否健康——
      // "其他预设看到不该看的东西 / 预设里什么都没有"这两类事故都靠这几个字段定位。
      const assembly = { tier, isolation: presetDeliveryStatus().isolation }
      // 能力自检（2026-09-26，第二轮）：捆绑 Python / LibreOffice kit / 官方 office 技能 / primary-runtime
      // 各在不在——兜底与 QA 通道**先探测再说话**（web/headless 没有这些，绝不指引模型调用不存在的东西）。
      const capabilities = detectCapabilities()
      let officeSkills
      try { officeSkills = await probeOfficeSkills(ctx) } catch (e) { officeSkills = { available: false, found: [], reason: String(e?.message ?? e) } }
      return JSON.stringify({
        session: sid, state, manualSkill: delivery, presetDelivery: presetDeliveryStatus(), assembly,
        capabilities: { ...capabilities, officeSkills }, paths,
      }, null, 2)
    },
  })), 'ppt-studio: ppt_state')
}
