/**
 * 部署能力探测（2026-09-26，第二轮）——把"这台机器上有哪些增强通道可用"收敛到**一处**。
 *
 * 为什么需要它：官方三个 office 技能（`office-docx/pptx/xlsx`）与它们假定的运行时（捆绑 Python +
 * LibreOffice kit）**只在桌面端具备**（`dsh-skill-office` 由 `dsh-desktop-host` 程序化挂载；
 * `web`/`headless`/`acp` 的出厂组合不挂，npm 版也没有 Python 分发）。于是插件必须**先探测再说话**：
 *   · python-pptx 兜底引擎选解释器（优先捆绑 Python，而不是指望用户 PATH 上恰好有）；
 *   · 兜底产物是否接官方 QA（`check_office.py` 结构自证 + LibreOffice 渲染抽检）；
 *   · `ppt_state.capabilities` 如实报告"有/没有"——绝不指引模型调用不存在的工具或技能。
 *
 * **三套根要分清**（2026-09-26 宿主实测结论，别混用）：
 *   ① 安装副本：`<dshHome>/dsh-runtimes/dsh-primary-runtime`（桌面端把 payload 复制到这里；
 *      `load_workspace_dependencies` 返回给模型的也是这一套）；
 *   ② carrier：`<install>/resources/runtime/primary-runtime`（桌面应用自带的原件）；
 *   ③ asar 解包：`<install>/resources/app.asar.unpacked/...`（原生件，如 LibreOffice kit）。
 *
 * 探测原则：**只做文件存在性检查**（廉价、无副作用、不 spawn）；解释器的可用性由调用方
 * 一次性验证（`pptxPy.js` 的 `findPython()`）。所有探测函数**每次调用求值**（能力可能在会话中途出现，
 * 例如宿主装好 runtime 之后），并返回 `null` 而不是抛错。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './home.js'

/** 官方三技能的名字（用于在技能注册表里探测"托管端是否提供"）。 */
export const OFFICE_SKILL_NAMES = ['office-docx', 'office-pptx', 'office-xlsx']

/** 是否 Windows（捆绑 Python/Kit 的路径形状只对 Windows 做过实测）。 */
function isWin() {
  return process.platform === 'win32'
}

/**
 * 从某个目录**逐级上溯**找桌面应用的 `resources` 目录（用 `app.asar` / `runtime/office-skills` 当锚点）。
 * 为什么不只看 `dirname(process.execPath)`：桌面端里本插件可能跑在**子进程 node** 中
 * （`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`），那时 execPath 在深层，
 * 必须一路上溯才能找到 `<install>/resources`。找不到返回 null（web/CLI 上就该是 null）。
 */
export function resourcesFrom(startDir) {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, 'resources')
    if (existsSync(join(cand, 'app.asar')) || existsSync(join(cand, 'app.asar.unpacked')) || existsSync(join(cand, 'runtime', 'office-skills'))) {
      return cand
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 桌面应用的 `resources` 目录（`process.execPath` 起逐级上溯；非桌面部署返回 null）。 */
export function resourcesDir() {
  const exe = process.execPath || ''
  if (!exe) return null
  return resourcesFrom(dirname(exe))
}

/** 环境变量缝（SDK/容器部署用；桌面端不设这两个变量，走 carrier 推导）。 */
export function primaryRuntimeFromEnv() {
  return process.env.DSH_PRIMARY_RUNTIME || process.env.DSH_BUNDLED_PRIMARY_RUNTIME || null
}

/** primary-runtime 的候选根（按"模型看到的 → 应用自带的"排序）。 */
export function primaryRuntimeRoots() {
  const out = []
  const env = primaryRuntimeFromEnv()
  if (env) out.push({ root: env, source: 'env(DSH_PRIMARY_RUNTIME)' })
  out.push({ root: join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime'), source: 'installed(dsh-runtimes)' })
  const res = resourcesDir()
  if (res) out.push({ root: join(res, 'runtime', 'primary-runtime'), source: 'carrier(resources/runtime)' })
  return out
}

/** 捆绑 Python 的候选（按上表顺序；`python.exe` 是 Windows 布局，其他平台给出 posix 形状）。 */
export function pythonCandidates() {
  const exe = isWin() ? 'python.exe' : join('bin', 'python3')
  return primaryRuntimeRoots().map(({ root, source }) => ({
    path: join(root, 'dependencies', 'python', exe),
    node: join(root, 'dependencies', 'node', isWin() ? 'bin/node.exe' : 'bin/node'),
    pnpm: join(root, 'dependencies', 'pnpm', isWin() ? 'bin/pnpm.mjs' : 'bin/pnpm.cjs'),
    root,
    source,
  }))
}

/** 第一个真实存在的捆绑 Python（没有则 null）。 */
export function findBundledPython() {
  for (const cand of pythonCandidates()) if (existsSync(cand.path)) return cand
  return null
}

/** 捆绑 Node（桌面端给 LibreOffice kit 用；没有则 null）。 */
export function findBundledNode() {
  for (const cand of pythonCandidates()) if (existsSync(cand.node)) return cand.node
  return null
}

/** LibreOffice kit CLI（官方 office 技能渲染/转 PDF/重算公式用的那一个）；探测不到返回 null。 */
export function findLibreofficeCli() {
  const res = resourcesDir()
  const cands = []
  if (res) {
    // 桌面端实测落点：app.asar.unpacked 下的 asar 内依赖
    cands.push(join(res, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'))
    cands.push(join(res, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'))
  }
  if (res) cands.push(join(res, 'runtime', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'))
  return cands.find((p) => existsSync(p)) ?? null
}

/** 官方 office 技能的资产根与结构检查脚本（桌面端 `resources/runtime/office-skills`）。 */
export function findOfficeAssets() {
  const res = resourcesDir()
  if (!res) return null
  const skillsDir = join(res, 'runtime', 'office-skills')
  if (!existsSync(skillsDir)) return null
  const checker = join(skillsDir, 'scripts', 'check_office.py')
  return { skillsDir, checker: existsSync(checker) ? checker : null }
}

/**
 * 汇总探测结果（**纯文件检查**，不 spawn、不抛）。`ppt_state.capabilities` 用它；
 * 兜底引擎与 QA 通道用它决定"能不能走增强路径"。
 */
export function detectCapabilities() {
  const py = findBundledPython()
  const node = findBundledNode()
  const cli = findLibreofficeCli()
  const office = findOfficeAssets()
  return {
    platform: process.platform,
    bundledPython: py === null ? null : { path: py.path, source: py.source },
    bundledNode: node,
    libreofficeKit: cli === null ? null : { cli, node },
    officeSkillsAssets: office === null ? null : { skillsDir: office.skillsDir, checker: office.checker },
    primaryRuntime: primaryRuntimeRoots().map(({ root, source }) => ({ root, source, present: existsSync(root) })),
  }
}

/**
 * 技能注册表探测：托管的三个 office 技能在本会话里**是否真的可用**（模型侧能不能加载）。
 * 与 `detectCapabilities()` 分开，因为这一条要问服务、是异步的。
 */
export async function probeOfficeSkills(ctx) {
  let skills
  try { skills = ctx?.get?.('skills') } catch { skills = undefined }
  if (skills === undefined) return { available: false, found: [], reason: 'skills 服务缺失（极简装配）' }
  const found = []
  for (const name of OFFICE_SKILL_NAMES) {
    try {
      const one = await skills.get(name)
      if (one !== undefined && one !== null) found.push(name)
    } catch { /* 单个技能查询失败不影响其余 */ }
  }
  return {
    available: found.length === OFFICE_SKILL_NAMES.length,
    found,
    reason: found.length === OFFICE_SKILL_NAMES.length
      ? '托管端提供（桌面端/SDK 才有）'
      : '本部署未提供这三个技能（web/headless 出厂组合不挂 dsh-skill-office）',
  }
}
