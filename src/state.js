/**
 * ppt-studio 状态：会话级（路由/档位）+ 项目级（state.json）。
 * 会话状态持久化到 `<dshHome>/ppt-studio/session-<id>.json`，供 resume 恢复。
 * **路径每次调用求值**（认 `DSH_HOME`）——见 src/home.js 顶部的口径统一说明；
 * 此处原为模块常量 `homedir()/.dsh`，会让隔离 DSH_HOME 的测试/便携部署把状态写进真实家目录。
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pptStudioDir } from './home.js'

/** 会话状态目录（调用时求值）。 */
export function sessionDir() { return pptStudioDir() }

export const DEFAULT_SESSION = () => ({
  routing: 'auto',            // auto | on | off（语义判断开关）
  mode: 'auto',               // auto | free | mid | strict（协作模式）
  fidelity: 'auto',           // auto | strict | free
  review: 'points',           // none | points | every
  quality: 'standard',        // quick | standard | audit
  engine: 'auto',             // auto(=pptd 主引擎) | pptd | python-pptx（pptxgenjs 未实现，命令面明确拒绝）
  quick: false,               // 快速生成模式（低 token 快交付；跳过视觉审阅/素材/定调）
  template: null,             // 模板 id（内置或用户自建；/ppt template <id> 或 ppt_templates 选择）
  pauseAfter: [],
  workflowActive: false,
  taskType: null,
  deckDir: null,
})

const sessionPath = (sessionId) => join(sessionDir(), `session-${sanitize(sessionId)}.json`)

export async function loadSession(sessionId) {
  return (await loadSessionDiag(sessionId)).state
}

/** 会话状态 + **诊断**（2026-09-18 新增）。区分"没有文件"（正常，新会话）与"文件存在却坏了"（异常）。
 *  两者原来都静默返回默认值，于是状态文件一旦损坏，`quality: 'audit'` 会**无声**变成 `standard`。 */
export async function loadSessionDiag(sessionId) {
  const p = sessionPath(sessionId)
  if (!existsSync(p)) return { state: DEFAULT_SESSION(), error: null }
  try {
    return { state: { ...DEFAULT_SESSION(), ...JSON.parse(await readFile(p, 'utf8')) }, error: null }
  } catch (e) {
    return { state: DEFAULT_SESSION(), error: `会话状态文件读取/解析失败（${p}）：${String(e?.message ?? e)}` }
  }
}

export async function saveSession(sessionId, state) {
  await mkdir(sessionDir(), { recursive: true })
  await writeFile(sessionPath(sessionId), JSON.stringify(state, null, 2))
}

const DEFAULT_PROJECT = () => ({
  taskType: null,          // from-scratch | augment | edit | summarize | unknown
  spec: {},
  stage: null,             // s0|s1|s2|s3|s4|s5|s6|done
  pages: {},               // page ref → status
  pauseAfter: [],
  reviews: [],
  engine: null,
  quality: 'standard',
})

export async function loadProject(deckDir) {
  return (await loadProjectDiag(deckDir)).state
}

/** 项目状态 + **诊断**（2026-09-18 新增）。**为什么要区分**：文件不存在 = 正常（新工程，用默认）；
 *  文件存在却读不了/解析失败 = 异常。原来两者都静默返回默认值 ⇒ `state.json` 一损坏，
 *  `quality: 'audit'` 会**无声**降成 `standard`——最严档（禁 autoDeclare + 强制视觉审阅 + 导出回读断言）
 *  被降级而用户毫不知情。这正是"严格性只升不降"与"诚实边界优于静默降级"两条原则要防的事。 */
export async function loadProjectDiag(deckDir) {
  const p = join(deckDir, 'state.json')
  if (!existsSync(p)) return { state: DEFAULT_PROJECT(), error: null }
  try {
    return { state: { ...DEFAULT_PROJECT(), ...JSON.parse(await readFile(p, 'utf8')) }, error: null }
  } catch (e) {
    return { state: DEFAULT_PROJECT(), error: `项目状态文件读取/解析失败（${p}）：${String(e?.message ?? e)}` }
  }
}

export async function saveProject(deckDir, state) {
  await mkdir(deckDir, { recursive: true })
  await writeFile(join(deckDir, 'state.json'), JSON.stringify(state, null, 2))
}

function sanitize(s) { return String(s).replace(/[^\w-]+/g, '_').slice(0, 64) }

export async function fileExists(p) { return existsSync(p) }
export { access }
