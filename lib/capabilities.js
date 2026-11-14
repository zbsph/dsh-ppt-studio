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
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { dshHome } from './home.js'

/** 官方三技能的名字（用于在技能注册表里探测"托管端是否提供"）。 */
export const OFFICE_SKILL_NAMES = ['office-docx', 'office-pptx', 'office-xlsx']

/** 是否 Windows（捆绑 Python/Kit 的路径形状只对 Windows 做过实测）。 */
function isWin() {
  return process.platform === 'win32'
}

/**
 * 从某个目录**逐级上溯**找桌面应用的 `resources` 目录（用 `app.asar` / `app.asar.unpacked` 当锚点）。
 * 为什么不只看 `dirname(process.execPath)`：桌面端里本插件可能跑在**子进程 node** 中
 * （`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`），那时 execPath 在深层，
 * 必须一路上溯才能找到 `<install>/resources`。找不到返回 null（web/CLI 上就该是 null）。
 *
 * 2026-11-14（DSH 0.2.2-rc.3）：旧锚点 `runtime/office-skills` 已被上游删除
 * （v0.2.2-alpha.3 office-skill-resources：office 资产改由 `@deepseek-ai/dsh-skill-office` 包提供），
 * 因此这里**只**用 `app.asar` / `app.asar.unpacked` 判桌面端；不再依赖已消失的目录。
 */
export function resourcesFrom(startDir) {
  // 显式覆盖缝（测试/非常规布局）：`PPT_STUDIO_RESOURCES_DIR=<install>/resources`。
  // 只用它来**定位**资源，不改变任何判定语义；指向不合法时忽略并继续正常上溯。
  const override = process.env.PPT_STUDIO_RESOURCES_DIR
  if (typeof override === 'string' && override.trim() !== '') {
    const cand = join(override)
    if (existsSync(join(cand, 'app.asar')) || existsSync(join(cand, 'app.asar.unpacked'))) return cand
  }
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, 'resources')
    if (existsSync(join(cand, 'app.asar')) || existsSync(join(cand, 'app.asar.unpacked'))) {
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

/**
 * LibreOffice kit CLI（官方 office 技能渲染/转 PDF/重算公式用的那一个）；探测不到返回 null。
 *
 * 2026-11-14（DSH 0.2.2-rc.3）：kit 仍是独立包 `@deepseek-ai/libreoffice-kit`（本机实测 0.2.3），
 * CLI 契约不变：`render --input <file> --output-dir <fresh-dir> [--pages …] [--dpi 144]`。
 * 候选位置：
 *   ① 桌面端 asar 解包（`resources/app.asar.unpacked/…`）；
 *   ② 运行中 DSH 包根的 node_modules（web/npm 安装——0.2.2 起 web 也带 office 工具）；
 *   ③ 桌面端安装副本 `<dshHome>/dsh-runtimes/dsh-primary-runtime/node_modules/…`；
 *   ④ 旧布局 `resources/runtime/node_modules/…`（保留兼容）。
 */
export function findLibreofficeCli() {
  const rel = ['node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js']
  const cands = []
  const res = resourcesDir()
  if (res) {
    // 桌面端实测落点：app.asar.unpacked 下的 asar 内依赖
    cands.push(join(res, 'app.asar.unpacked', 'dsh', ...rel))
    cands.push(join(res, 'app.asar.unpacked', ...rel))
  }
  for (const root of dshPackageRoots()) cands.push(join(root, ...rel))
  cands.push(join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', ...rel))
  if (res) cands.push(join(res, 'runtime', ...rel))
  return cands.find((p) => existsSync(p)) ?? null
}

/**
 * 运行中 DSH 的**包根**（`@deepseek-ai/dsh` 目录）候选——用于找 npm 安装里的 office 生态包。
 *
 * 为什么需要：0.2.2 起 web（npm 全局安装）也挂 office 工具（`dsh-tool-office` + `dsh-office-kit` +
 * `libreoffice-kit`），但它们位于 **DSH 安装目录**的 node_modules 下，不在 profile 的 node_modules 里，
 * 也不在桌面端 `resources` 下。三个来源按可靠性排序：
 *   ① `DSH_INSTALL_DIR` 环境变量（SDK/容器布局会设）；
 *   ② 进程参数里的 `<...>/@deepseek-ai/dsh/lib/{bin,cli}.js`（`dsh web` 由 npm shim 用它启动）；
 *   ③ 桌面端 `resources/app.asar.unpacked/dsh`（asar 解包出来的运行时包根）。
 * 纯文件判断，不 spawn；任何来源都拿不到时返回空数组。
 */
export function dshPackageRoots() {
  const out = []
  const push = (p) => { if (typeof p === 'string' && p.trim() !== '' && !out.includes(p)) out.push(p) }
  const env = process.env.DSH_INSTALL_DIR
  if (typeof env === 'string' && env.trim() !== '') push(env)
  for (const arg of process.argv ?? []) {
    const m = /^(.*)[/\\]@deepseek-ai[/\\]dsh[/\\]lib[/\\](?:bin|cli)\.js$/.exec(String(arg))
    if (m) push(m[1])
  }
  const res = resourcesDir()
  if (res) push(join(res, 'app.asar.unpacked', 'dsh'))
  return out
}

/**
 * 官方 office 资产的新位置（DSH 0.2.2-rc.3 起）。
 *
 * 背景：v0.2.2-alpha.3（office-skill-resources / office-operation-tools 指南）删除了
 * `runtime/office-skills` 资源目录与 `scripts/check_office.py`；office 技能改由
 * `@deepseek-ai/dsh-skill-office` 的包内 `assets/` 提供，结构/视觉校验改由
 * `office_render` / `office_convert` / `office_recalculate` 工具承担。
 * 因此这里能定位到的只是**技能资产根**（`assets/office*`），不含旧 checker；
 * `runOfficeStructureCheck` 会如实报告"资产在、但没有 scripts/check_office.py"。
 */
export function findOfficeAssets() {
  const cands = []
  const res = resourcesDir()
  if (res) {
    cands.push(join(res, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'assets'))
    cands.push(join(res, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'assets'))
    // 旧布局（0.2.1-rc.2 及以前；保留兼容，不因升级丢失老部署）
    cands.push(join(res, 'runtime', 'office-skills'))
  }
  for (const root of dshPackageRoots()) {
    cands.push(join(root, 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'assets'))
    cands.push(join(root, 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'office-skills'))
  }
  for (const cand of cands) {
    if (!existsSync(cand)) continue
    // 新布局：assets/{office,office-docx,office-pptx,office-xlsx}（无 scripts/check_office.py）；
    // 旧布局：runtime/office-skills/scripts/check_office.py。
    for (const checker of [join(cand, 'scripts', 'check_office.py'), join(cand, 'office-pptx', 'scripts', 'check_office.py')]) {
      if (existsSync(checker)) return { skillsDir: cand, checker }
    }
    return { skillsDir: cand, checker: null }
  }
  return null
}

/**
 * 任意可用的 Python（**只为跑官方 `check_office.py`**：它只用标准库，任何 python3 都行）。
 * 顺序：捆绑 Python > PATH 上的 `python` / `py` / `python3`。探不到返回 null。
 * 与 `pptxPy.findPython()` 的区别：那个要求 `import pptx`，这个不要求。
 */
export function findAnyPython() {
  const bundled = findBundledPython()
  if (bundled !== null) return { path: bundled.path, source: `bundled:${bundled.source}` }
  for (const cmd of ['python', 'py', 'python3']) {
    try {
      const r = spawnSync(cmd, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 15000 })
      if (r.status === 0 && String(r.stdout).includes('1')) return { path: cmd, source: 'path' }
    } catch { /* try next */ }
  }
  return null
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
