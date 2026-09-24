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
 */
import { existsSync, readFileSync } from 'node:fs'
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

/** 最近一次声明的结果（供 ppt_state 与测试观测；进程内单例）。 */
const STATUS = { id: PRESET_ID, declared: false, via: '', reason: '尚未装配', rows: 0 }
export function presetDeliveryStatus() {
  return { ...STATUS }
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
 * @returns {{id: string, name: string, description: string, order: number, plugins: object[]}}
 */
export function presetDeclaration(dir = builtinPresetDir()) {
  const composition = join(dir, 'agent.cordis.yml')
  if (!existsSync(composition)) throw new Error(`包内预设组合缺失：${composition}`)
  let meta = {}
  const metaFile = join(dir, 'preset.yml')
  if (existsSync(metaFile)) {
    try { meta = parse(readFileSync(metaFile, 'utf8')) ?? {} } catch { meta = {} }
  }
  const plugins = absolutizeRows(readEntryList(composition), dir)
  return {
    id: PRESET_ID,
    name: typeof meta.name === 'string' ? meta.name : 'PPT 工作室',
    description: typeof meta.description === 'string' ? meta.description : '',
    order: typeof meta.order === 'number' ? meta.order : 2,
    plugins,
  }
}

function readRegistry(ctx) {
  try { return ctx.get('agentPresets') } catch { return undefined }
}

/**
 * 幂等地把「PPT 工作室」预设声明给 agent-preset 注册表。
 * @returns {{id: string, declared: boolean, via: string, reason: string, rows: number}} 当前（可能尚未完成的）状态
 */
export function declareAgentPreset(ctx, config = {}) {
  if (config?.autoPreset === false) {
    STATUS.declared = false
    STATUS.via = ''
    STATUS.reason = 'autoPreset=false（配置关闭）'
    return presetDeliveryStatus()
  }

  let declaration
  try {
    declaration = presetDeclaration()
  } catch (e) {
    STATUS.declared = false
    STATUS.via = ''
    STATUS.reason = `预设组合不可用（未声明）：${String(e?.message ?? e)}`
    loggerOf(ctx)?.warn?.(`[ppt-studio] ${STATUS.reason}`)
    return presetDeliveryStatus()
  }
  STATUS.rows = declaration.plugins.length
  STATUS.reason = '等待 agentPresets 注册表…'

  const warn = (message) => { try { loggerOf(ctx)?.warn?.(`[ppt-studio] ${message}`) } catch { /* 无 logger 时静默 */ } }
  let release
  let closed = false
  let queue = Promise.resolve()

  const declare = (registry) => {
    queue = queue.then(async () => {
      if (closed || release !== undefined) return
      if (registry === undefined) {
        STATUS.reason = 'agentPresets 服务不可见（本部署未装配预设注册表？）——预设未声明'
        warn(STATUS.reason)
        return
      }
      try {
        release = await registry.register(declaration)
        STATUS.declared = true
        STATUS.via = 'agentPresets.register'
        STATUS.reason = `已声明（${declaration.plugins.length} 行）——新建会话的预设选择器里可选「${declaration.name}」`
        try { loggerOf(ctx)?.info?.(`[ppt-studio] ${STATUS.reason}`) } catch { /* 忽略 */ }
      } catch (e) {
        STATUS.declared = false
        STATUS.via = ''
        STATUS.reason = `声明失败（不影响插件本身）：${String(e?.message ?? e)}`
        warn(STATUS.reason)
      }
    }).catch((e) => { warn(`预设声明队列异常：${String(e?.message ?? e)}`) })
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
