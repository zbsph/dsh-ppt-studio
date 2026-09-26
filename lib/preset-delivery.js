/**
 * 预设交付（2026-09-24 适配 DSH **0.1.7-rc.1**）：从"写预设目录"改为"向 agent-preset 注册表声明"。
 *
 * ── 为什么必须改（上游结构性变更，不是可选优化）────────────────────────────────
 * 0.1.6 及以前：宿主启动时**扫描** `<dshHome>/.agent-presets/<id>/agent.cordis.yml`，
 *   所以插件只要把文件写进去，预设就会出现在新建会话的选择器里（`dsh-agent-presets` 的 discover 路径）。
 * 0.1.7：那条发现路径**整个被删掉了**。上游换成两个包——
 *   `@deepseek-ai/dsh-agent-preset`（一条 YAML 声明）+ `@deepseek-ai/dsh-agent-preset-registry`
 *   （只有 `register/list/resolve/...`，**没有任何目录扫描**）；随包预设也改为
 *   `dsh-web-app/presets/*.patch.yml` 里 insert 一行 `@deepseek-ai/dsh-agent-preset`。
 *   社区插件自己对这条的表述（dsh-client-ui-preset-center README）：
 *     "Nothing scans that directory: the harness discovers no preset on disk."
 *   ⇒ 继续写目录 = 预设**永远不会出现**，而且失败是静默的（没有报错、没有日志）。
 *
 * ── 现在的做法 ────────────────────────────────────────────────────────────────
 * 插件激活时把包内 `agent-presets/ppt/` 那份组合**声明**给注册表：
 *     ctx.inject(['agentPresets'], child => child.agentPresets.register({id,name,description,order,plugins}))
 * `plugins` = `agent.cordis.yml` 的条目数组（Loader 方言），`name`/`description`/`order` = `preset.yml`。
 *
 * 三个必须守住的细节（都有源码依据）：
 *   ① **`!!js` 必须保真**：`disabled: !!js process.platform === 'win32'` 在 Loader 方言里是
 *      `{ __jsExpr: "<源码>" }`（`dsh-app-boot` 的 `JsExpr` = `tag:yaml.org,2002:js`，
 *      `construct: data => ({ __jsExpr: data })`；`cordis-plugin-loader` 用
 *      `evaluate(ctx, value.__jsExpr)` 求值）。自己读 YAML 时若把它降级成普通字符串，
 *      `Boolean(<非空字符串>) === true` ⇒ **Windows 上 tool-pwsh 行会被误停用**（没有 shell）。
 *      本模块用 `yaml` 包注册同名 tag，产出的就是 Loader 认的那个形状。
 *   ② **相对模块名要变成 file URL**：注册表 mount 时用
 *      `scope.ctx.extend({ baseUrl: <注册表所在 ctx 的 baseUrl> })`（= harness base，**不是**预设目录），
 *      所以 `name: ./foo.mjs` 会解析到 harness 里去。社区插件（dsh-liangshen）对同一问题的处理
 *      就是把相对名展开成 `file://` 绝对 URL。本模块照做（当前组合里没有相对名，属防御）。
 *   ③ **disposer 归声明者所有**：`register()` 返回注销函数。插件卸载（HMR/停用行）后若不注销，
 *      再次装配会撞 `Duplicate agent preset: ppt`（`register` 对重复 id 直接 throw）。
 *      所以整段挂在 `ctx.effect` 上，随插件同生共死。
 *
 * ── 安全边界 ────────────────────────────────────────────────────────────────
 *   · 可被 `config.autoPreset === false` 关闭（保留旧配置键，不破坏既有 profile patch）；
 *   · 注册表缺失（极简部署 / 低于 0.1.7 的宿主）只告警，**绝不抛**——预设没了也不能让插件挂不上；
 *   · 组合里出现解析不了的相对名时**拒绝声明**（宁可没有预设，也不声明一条注定 broken 的声明：
 *     broken 的预设会被 `presetOptions()` 过滤掉，等于白声明还多一条误导日志）。
 *
 * ── 2026-09-26 新增：**自定位行**（"只在「PPT 工作室」里可见"的载体）──────────────────
 * 用户要求"装上插件后**其他预设完全不受影响**"。做法是把本包**挂进自己的预设组合**：
 * 声明预设时在 `plugins` 末尾追加一行
 *     { id: 'ppt-studio-scope', name: 'file:///<本包绝对路径>/lib/index.js', config: { scope: 'preset' } }
 * —— 预设的常驻组合会真的 import 并 apply 这行（`dsh-agent-preset-registry` 声明即挂载），
 * 而注册进"预设作用域 ctx"的工具/技能/提示段**只对该预设的会话可见**（分层注册表按 scope 链合并）。
 * 三条必须守住的细节：
 *   ① **行名必须是绝对 `file://`**：预设行按**注册表所在 ctx 的 baseUrl** 解析（历史事故根因），
 *      裸包名/相对名在 profile 里解析不到；而 Loader 对**非 `.` 开头**的名字**原样 `import(name)`**
 *      ⇒ `file://` 不看 baseUrl。这是 2026-09-26 真宿主实测通过的路径。
 *   ② **路径现算，不写死**：用 `import.meta.url` 推出本包绝对路径 ⇒ 升级换代、换 profile 都不会陈旧。
 *   ③ **预设档实例必须 `autoPreset: false`**：否则它会再声明一次预设 ⇒ 注册表对重复 id 直接 throw。
 * 本行只在"想要隔离"时追加；不健康时由 index.js 自动回落到全局能力面（隔离失效但功能不丢）。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

/** 预设 id（选择器里的稳定标识；`agent-presets/ppt/` 目录名一致）。 */
export const PRESET_ID = 'ppt'

/**
 * Loader 方言里的 `!!js` tag —— 与 `dsh-app-boot` 的 `JsExpr` 同定义（`construct` → `{__jsExpr}`）。
 * 用我们自己的 `yaml` 包注册（宿主那份在 harness base，profile 里 import 不到）。
 */
const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value) => ({ __jsExpr: value }),
}

/** 包内自带的预设目录（`lib/` 的上一级 = 包根）。 */
export function builtinPresetDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'agent-presets', PRESET_ID)
}

/** 包根（`lib/` 的上一级）。 */
export function packageRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/** **自定位行的 id**（预设档实例的身份标识，便于从日志/状态里认出来）。 */
export const SCOPE_ROW_ID = 'ppt-studio-scope'

/**
 * 本包的加载入口（用于自定位行）。优先 `lib/index.js`（`package.json` 的 main），
 * 其次读 `package.json.main`；都拿不到返回 null（调用方据此**不追加**该行——宁可不隔离，也不加一行注定 broken 的）。
 * 路径经 `realpathSync` 归一：pnpm 顶层软链与 `.pnpm/...` 真实路径在 Node 里解析成同一模块实例。
 */
export function pluginEntryFile() {
  const pkgRoot = packageRoot()
  const candidate = join(pkgRoot, 'lib', 'index.js')
  const fallbackMain = (() => {
    try {
      const main = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).main
      return typeof main === 'string' && main ? resolve(pkgRoot, main) : null
    } catch { return null }
  })()
  const entry = existsSync(candidate) ? candidate : (fallbackMain && existsSync(fallbackMain) ? fallbackMain : null)
  if (entry === null) return null
  try { return realpathSync(entry) } catch { return entry }
}

/**
 * 自定位预设行：让本包被**自己的预设**挂载一次，从而把能力面注册进**预设作用域**。
 * `config.scope: 'preset'` = 预设档实例；`autoPreset: false` = 它不再声明预设（重复 id 会 throw）。
 * @param {{presetIds?: string[]}} [extra] 额外透传的配置
 * @returns {object|null} 入口文件缺失时返回 null
 */
export function selfPresetRow(extra = {}) {
  const entry = pluginEntryFile()
  if (entry === null) return null
  return {
    id: SCOPE_ROW_ID,
    name: pathToFileURL(entry).href,
    config: { scope: 'preset', autoPreset: false, presetIds: extra?.presetIds ?? [PRESET_ID] },
  }
}

/** 最近一次声明的结果（供 ppt_state 与测试观测；进程内单例）。 */
const STATUS = { id: PRESET_ID, declared: false, via: '', reason: '尚未装配', rows: 0, selfRow: false, health: 'unknown', isolation: 'unknown' }
export function presetDeliveryStatus() {
  return { ...STATUS }
}
/** 覆盖/合并交付状态的附加字段（index.js 用它写入"隔离是否生效 / 是否已回落"）。 */
export function notePresetStatus(patch = {}) {
  for (const [k, v] of Object.entries(patch)) STATUS[k] = v
  return presetDeliveryStatus()
}

function loggerOf(ctx) {
  try { return typeof ctx.logger === 'function' ? ctx.logger('ppt-studio') : ctx.logger } catch { return undefined }
}

/** 读 Loader 方言的条目数组（`!!js` 保真）。 */
function readEntryList(file) {
  const doc = parse(readFileSync(file, 'utf8'), { customTags: [JS_TAG] })
  if (!Array.isArray(doc)) throw new Error(`${file} 不是 Loader 方言的条目数组`)
  return doc
}

/**
 * 把相对模块名（`./x.mjs` / `../x.mjs`）展开为 `file://` 绝对 URL，递归进 `config` 数组（group 行）。
 * 解析不到目标文件时抛错（调用方据此拒绝声明）。
 */
function absolutizeRows(rows, baseDir) {
  return rows.map((row) => {
    const out = { ...row }
    if (typeof out.name === 'string' && /^\.\.?\//.test(out.name)) {
      const target = resolve(baseDir, out.name)
      if (!existsSync(target)) throw new Error(`预设行 ${String(out.id)} 的相对模块名解析不到：${out.name}（在 ${baseDir} 下）`)
      out.name = pathToFileURL(target).href
    }
    if (Array.isArray(out.config)) out.config = absolutizeRows(out.config, baseDir)
    return out
  })
}

/**
 * 组装交给 `agentPresets.register()` 的声明。
 * @param {string} [dir] 预设目录（缺省 = 包内自带那份）
 * @param {{selfRow?: boolean, presetIds?: string[]}} [opts] `selfRow: true` 时在末尾追加**自定位行**
 *   （= 让本包在自己的预设里以"预设档"再挂一次，能力面因此只对该预设可见）
 * @returns {{id: string, name: string, description: string, order: number, plugins: object[], selfRow: boolean}}
 */
export function presetDeclaration(dir = builtinPresetDir(), opts = {}) {
  const composition = join(dir, 'agent.cordis.yml')
  if (!existsSync(composition)) throw new Error(`包内预设组合缺失：${composition}`)
  let meta = {}
  const metaFile = join(dir, 'preset.yml')
  if (existsSync(metaFile)) {
    try { meta = parse(readFileSync(metaFile, 'utf8')) ?? {} } catch { meta = {} }
  }
  const plugins = absolutizeRows(readEntryList(composition), dir)
  let selfRow = false
  if (opts?.selfRow === true) {
    const row = selfPresetRow({ presetIds: opts?.presetIds })
    if (row !== null) {
      // 幂等：组合里若已存在同名行（用户手工加过），不重复追加
      if (!plugins.some((r) => r?.id === SCOPE_ROW_ID)) { plugins.push(row); selfRow = true }
      else selfRow = true
    }
  }
  return {
    id: PRESET_ID,
    name: typeof meta.name === 'string' ? meta.name : 'PPT 工作室',
    description: typeof meta.description === 'string' ? meta.description : '',
    order: typeof meta.order === 'number' ? meta.order : 2,
    plugins,
    selfRow,
  }
}

function readRegistry(ctx) {
  try { return ctx.get('agentPresets') } catch { return undefined }
}

/**
 * 幂等地把「PPT 工作室」预设声明给 agent-preset 注册表。
 * @param {object} ctx 插件作用域 ctx（profile 档）
 * @param {object} [config] 插件配置（`autoPreset:false` 关闭；`scope:'preset'` 时追加自定位行）
 * @param {{selfRow?: boolean, onSettled?: (health: {ok: boolean, reason: string, rows?: number, selfRow?: boolean, presetId: string}) => void}} [hooks]
 *   `onSettled` 在声明落地（成功/失败/注册表不可见）后**恰好调用一次**，供调用方决定是否需要回落。
 * @returns {{id: string, declared: boolean, via: string, reason: string, rows: number, selfRow: boolean, health: string}} 当前（可能尚未完成的）状态
 */
export function declareAgentPreset(ctx, config = {}, hooks = {}) {
  if (config?.autoPreset === false) {
    STATUS.declared = false
    STATUS.via = ''
    STATUS.health = 'off'
    STATUS.reason = 'autoPreset=false（配置关闭）'
    return presetDeliveryStatus()
  }

  const wantIsolation = hooks?.selfRow === true || config?.scope === 'preset'
  let declaration
  try {
    declaration = presetDeclaration(builtinPresetDir(), { selfRow: wantIsolation, presetIds: config?.presetIds })
  } catch (e) {
    STATUS.declared = false
    STATUS.via = ''
    STATUS.health = 'unavailable'
    STATUS.reason = `预设组合不可用（未声明）：${String(e?.message ?? e)}`
    loggerOf(ctx)?.warn?.(`[ppt-studio] ${STATUS.reason}`)
    return presetDeliveryStatus()
  }
  STATUS.rows = declaration.plugins.length
  STATUS.selfRow = declaration.selfRow === true
  STATUS.health = 'pending'
  STATUS.reason = '等待 agentPresets 注册表…'

  const warn = (message) => { try { loggerOf(ctx)?.warn?.(`[ppt-studio] ${message}`) } catch { /* 无 logger 时静默 */ } }
  let release
  let closed = false
  let settled = false
  let queue = Promise.resolve()
  const settle = (health) => {
    if (settled) return
    settled = true
    try { hooks?.onSettled?.(health) } catch (e) { warn(`onSettled 回调异常：${String(e?.message ?? e)}`) }
  }

  const declare = (registry) => {
    queue = queue.then(async () => {
      if (closed || release !== undefined) return
      if (registry === undefined) {
        STATUS.reason = 'agentPresets 服务不可见（本部署未装配预设注册表？）——预设未声明'
        STATUS.health = 'no-registry'
        warn(STATUS.reason)
        settle({ ok: false, reason: STATUS.reason, rows: STATUS.rows, selfRow: STATUS.selfRow, presetId: PRESET_ID })
        return
      }
      try {
        release = await registry.register(declaration)
        STATUS.declared = true
        STATUS.via = 'agentPresets.register'
        STATUS.health = 'declared'
        STATUS.reason = `已声明（${declaration.plugins.length} 行${declaration.selfRow ? '，含自定位行' : ''}）——新建会话的预设选择器里可选「${declaration.name}」`
        try { loggerOf(ctx)?.info?.(`[ppt-studio] ${STATUS.reason}`) } catch { /* 忽略 */ }
        settle({ ok: true, reason: STATUS.reason, rows: STATUS.rows, selfRow: STATUS.selfRow, presetId: PRESET_ID })
      } catch (e) {
        STATUS.declared = false
        STATUS.via = ''
        STATUS.health = 'failed'
        STATUS.reason = `声明失败（不影响插件本身）：${String(e?.message ?? e)}`
        warn(STATUS.reason)
        settle({ ok: false, reason: STATUS.reason, rows: STATUS.rows, selfRow: STATUS.selfRow, presetId: PRESET_ID })
      }
    }).catch((e) => {
      warn(`预设声明队列异常：${String(e?.message ?? e)}`)
      settle({ ok: false, reason: `预设声明队列异常：${String(e?.message ?? e)}`, presetId: PRESET_ID })
    })
  }

  ctx.effect(() => {
    if (typeof ctx.inject === 'function') {
      // 注册表可能比本插件行晚激活：`inject` 等它出现再声明，服务消失时子 ctx 一并释放。
      ctx.inject(['agentPresets'], (child) => { declare(readRegistry(child)) })
    } else {
      declare(readRegistry(ctx))
    }
    return () => {
      closed = true
      const dispose = release
      release = undefined
      STATUS.declared = false
      STATUS.reason = '插件卸载——预设已注销'
      return dispose === undefined ? queue : Promise.resolve(dispose()).catch(() => {})
    }
  }, 'ppt-studio: agent preset declaration')

  return presetDeliveryStatus()
}
