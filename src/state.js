/**
 * ppt-studio 状态：会话级（路由/档位）+ 项目级（state.json）。
 * 会话状态持久化到 ~/.dsh/ppt-studio/session-<id>.json，供 resume 恢复。
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = join(homedir(), '.dsh', 'ppt-studio')
export const SESSION_DIR = ROOT

export const DEFAULT_SESSION = () => ({
  routing: 'auto',            // auto | on | off（语义判断开关）
  mode: 'auto',               // auto | free | mid | strict（协作模式）
  fidelity: 'auto',           // auto | strict | free
  review: 'points',           // none | points | every
  quality: 'standard',        // quick | standard | audit
  engine: 'auto',             // auto(=pptd 主引擎) | pptd | python-pptx | pptxgenjs
  quick: false,               // 快速生成模式（低 token 快交付；跳过视觉审阅/素材/定调）
  template: null,             // 内置模板 id（/ppt template <id> 或 ppt_templates 选择）
  pauseAfter: [],
  workflowActive: false,
  taskType: null,
  deckDir: null,
})

const sessionPath = (sessionId) => join(ROOT, `session-${sanitize(sessionId)}.json`)

export async function loadSession(sessionId) {
  const p = sessionPath(sessionId)
  if (!existsSync(p)) return DEFAULT_SESSION()
  try {
    return { ...DEFAULT_SESSION(), ...JSON.parse(await readFile(p, 'utf8')) }
  } catch {
    return DEFAULT_SESSION()
  }
}

export async function saveSession(sessionId, state) {
  await mkdir(ROOT, { recursive: true })
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
  const p = join(deckDir, 'state.json')
  if (!existsSync(p)) return DEFAULT_PROJECT()
  try {
    return { ...DEFAULT_PROJECT(), ...JSON.parse(await readFile(p, 'utf8')) }
  } catch {
    return DEFAULT_PROJECT()
  }
}

export async function saveProject(deckDir, state) {
  await mkdir(deckDir, { recursive: true })
  await writeFile(join(deckDir, 'state.json'), JSON.stringify(state, null, 2))
}

function sanitize(s) { return String(s).replace(/[^\w-]+/g, '_').slice(0, 64) }

export async function fileExists(p) { return existsSync(p) }
export { access }
