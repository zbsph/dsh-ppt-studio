#!/usr/bin/env node
/**
 * verify-preset-scope.mjs —— **预设隔离矩阵**的真机自证（装配层改动的验收门禁，第一轮）。
 *
 * 它回答一个只有真宿主能回答的问题：把本插件的能力面注册到「PPT 工作室」预设的**作用域**里之后，
 *   ① 工具可见性、② 技能可见性、③ **系统提示段可见性** 是否都只对 ppt 预设的会话生效，
 *   其它预设（standard）与无预设的全局平面是否**完全看不到**。
 *
 * ── 为什么要"真机 + 隔离"─────────────────────────────────────────────────────────
 * spike（task-1）已经证明：绝对 `file://` 预设行能被挂载、预设不 broken、工具与技能都落预设层、
 * 会话内切预设也拿得到。**但提示段没验证过**——如果把 `system-prompt/assemble` 监听者搬到预设
 * 作用域，它的 waterfall 只按 scope 链投递（`scopeTarget`），是否真的"只对该预设的 agent 生效"
 * 必须实测，不能推断。本脚本用宿主自己的装配入口 `systemPrompt.assemble({agent, scope: agent})`
 * 取 `sections` 做**双向**判定：standard 里没有 `ppt-workflow`，ppt 里**有**。
 *
 * ── 怎么做到"不改仓库、不改产物"──────────────────────────────────────────────────
 * 本脚本只：① 复制**本仓库当前工作区**到 temp、`npm pack`、装进隔离 profile；② 生成一个**探针
 * 插件**（temp 里的独立 .mjs）与一份 **--patch overlay**（`- insert:` 一行，绝对 file:// 名），
 * 由宿主把探针挂到 profile 平面。
 *   · 探针负责建真会话（`agents.create` + `presets.mount`，与宿主
 *     `dsh-api-session-controller/lib/types/agent.js` 的 `composeAgent()` 同形，GUI 走同一条路）、
 *     写会话状态文件（让提示段判据可判）、枚举可见性、把结果写一个 JSON 文件；
 *   · 脚本负责拉起宿主、等结果、断言、杀进程、清理。
 *   ⇒ 仓库既有文件（src/lib/docs/smoke）**零改动**；也不依赖任何模型/凭据（不花 token）。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *   node scripts/verify-preset-scope.mjs                  # 一键：隔离安装 + 真宿主 + 断言
 *   node scripts/verify-preset-scope.mjs --keep           # 保留隔离目录（事后翻证据）
 *   node scripts/verify-preset-scope.mjs --strict         # "未落地"也算失败（改动落地后设为门禁用）
 *   node scripts/verify-preset-scope.mjs --negative       # 额外跑负面对照（故意写错的 file:// 行）
 *   node scripts/verify-preset-scope.mjs --work <dir>     # 指定隔离根目录
 *   node scripts/verify-preset-scope.mjs --dsh <bin.js>   # 指定宿主入口（缺省自动探测）
 *   node scripts/verify-preset-scope.mjs --timeout 240    # 等探针结果的秒数（缺省 180）
 *   node scripts/verify-preset-scope.mjs --expect-tools 22 --expect-skills 4
 *
 * 退出码：0 = 全部断言通过 **或** 判定为"隔离未生效（改动未落地）"（打印醒目标记，不算 FAIL）；
 *         1 = 至少一条断言失败（含"预设 broken"这种真失败）；
 *         2 = 仅 --strict 下的"未生效"。缺 pnpm / 缺 dsh / 缺 node 时打印 ⚠ 跳过并退出 0。
 *
 * ── 判定口径（每条断言各自写明"判据来源"）────────────────────────────────────────
 *  · 工具可见性：`ctx.get('tools').schemas(agent)` —— 即宿主 `systemPrompt.tools(context => wireSchemas(context.scope))`
 *    用的**同一个** `view(scope)`（dsh-tools/lib/index.js:2707 / :3023 / :2959-2985）；
 *    agent 本身即 scope key（dsh-agent-loop/lib/index.js:778 `createScope(loopCtx, this)`）。
 *  · 技能可见性：`ctx.get('skills').list({ scope: agent })`（dsh-skill 按 scope 链合并，:224-240）。
 *  · 提示段可见性：`ctx.get('systemPrompt').assemble({ agent, scope: agent })` 的 `sections`——
 *    `assembleContextFor(agent) = { agent, scope: agent }`（dsh-agent/lib/types/dispatch.js:92-94，
 *    宿主 agent-loop 在 :907 就是这么调的）；waterfall 的投递按 scope（dsh-system-prompt/lib/index.js:355
 *    `ctx.waterfall(scopeTarget(this, scope), 'system-prompt/assemble', …)`）。
 *  · 预设健康度：`ctx.get('agentPresets').list()` 行里有无 `broken` 字段
 *    （dsh-agent-preset-registry/lib/index.js:578-587；前端按 `broken === void 0` 过滤，dsh-client-ui-agent-preset/lib/client.js:1147）。
 *  · 全局残留：`ctx.get('tools').schemas(undefined)` = 无预设的全局视图。
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir, homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : dflt
}
const KEEP = flag('--keep')
const STRICT = flag('--strict')
const NEGATIVE = flag('--negative')
const TIMEOUT_MS = Number(opt('--timeout', '180')) * 1000
const EXPECT_TOOLS = Number(opt('--expect-tools', '22'))
const EXPECT_SKILLS = Number(opt('--expect-skills', '4'))
const PRESET = opt('--preset', 'ppt')
const OTHER = opt('--other', 'standard')
const WORK_ARG = opt('--work', '')

let pass = 0
let fail = 0
let pending = false
function check(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}
/** 只打印证据行，**不计入**通过/失败（用于"改动未落地"时的判定依据，避免把它误判成门禁失败）。 */
function evidence(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'}（证据）${label}${detail ? ` — ${detail}` : ''}`)
}
function info(label, detail = '') { console.log(`· ${label}${detail ? ` — ${detail}` : ''}`) }
function head(title) { console.log(`\n=== ${title} ===`) }

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', shell: process.platform === 'win32', ...opts })
  return r
}
function mergeOut(r) { return `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() }
function tail(s, n = 240) { return String(s).replace(/\s+/g, ' ').trim().slice(-n) }

// ── 前置：node / dsh / pnpm ────────────────────────────────────────────────────
console.log(`verify-preset-scope：仓库 ${root}`)
console.log(`  预设 ${PRESET}（期望 ppt_*=${EXPECT_TOOLS}、技能=${EXPECT_SKILLS}）｜对照预设 ${OTHER}`
  + `｜负面对照 ${NEGATIVE ? '开' : '关'}｜未落地判定 ${STRICT ? 'FAIL(--strict)' : 'PENDING(不算失败)'}`)

const dshBin = findDshBin()
if (dshBin === null) {
  console.log('⚠ 跳过：找不到宿主入口 `@deepseek-ai/dsh/lib/bin.js`（用 --dsh <path> 指定，或 npm i -g @deepseek-ai/dsh）')
  process.exit(0)
}
const pnpm = run('pnpm', ['--version'])
if (pnpm.status !== 0) {
  console.log('⚠ 跳过：PATH 上没有 pnpm（`dsh plugin` 是 pnpm 转发器）')
  process.exit(0)
}
info('宿主入口', dshBin)
info('pnpm', mergeOut(pnpm).split(/\r?\n/)[0])

// ── 隔离环境 ───────────────────────────────────────────────────────────────────
const work = WORK_ARG ? resolve(WORK_ARG) : mkdtempSync(join(tmpdir(), 'dsh-ppt-scope-verify-'))
const home = join(work, 'home')
const cwd = join(work, 'cwd')
const packDir = join(work, 'pack')
for (const d of [home, cwd, packDir]) mkdirSync(d, { recursive: true })
info('隔离根目录', work)
info('隔离 DSH_HOME', home)

let host = null
let exitCode = 0
try {
  // ── 0) 把**本仓库当前工作区**复制到 temp 并在副本里构建（src → lib）───────────────
  // 为什么必须先复制 + 构建：`lib/` 是**提交的构建产物**，而本轮改动在 `src/`。直接 pack 仓库里的
  // 旧 `lib/` 会把"改动未落地"误报成结论。复制到 temp 后跑 `scripts/build.mjs`（纯 src→lib 拷贝）
  // ⇒ 被测对象 = 你此刻的 src，且**仓库零写入**。
  const scratch = join(work, 'repo')
  mkdirSync(scratch, { recursive: true })
  cpSync(root, scratch, {
    recursive: true,
    filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src),
  })
  const build = run('node', [join(scratch, 'scripts', 'build.mjs')], { cwd: scratch })
  check('副本里构建成功（src → lib，测的是你此刻的 src）', build.status === 0, tail(mergeOut(build)))

  // ── 1) 打包（npm pack 只写 packDir，不写仓库）─────────────────────────────────
  const pack = run('npm', ['pack', '--pack-destination', packDir], { cwd: scratch })
  // 文件名只信 **stdout**（npm 把 notice 写 stderr、文件名写 stdout；合并输出后"最后一行"会是 notice）
  // 再兜一层：直接扫 packDir 里的 tgz。
  const fromStdout = (pack.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.endsWith('.tgz')).pop()
  const fromDir = readdirSync(packDir).filter((f) => f.endsWith('.tgz')).sort().pop()
  const tgzName = fromStdout ?? fromDir ?? ''
  const tgz = join(packDir, tgzName)
  check('npm pack 出当前工作区的 tgz', existsSync(tgz), tgzName || tail(mergeOut(pack)))

  // ── 2) 装进隔离 profile ───────────────────────────────────────────────────────
  const env = { ...process.env, DSH_HOME: home }
  const add = run('node', [dshBin, 'plugin', '--profile', 'web', 'add', tgz], { env, cwd: work })
  check('`dsh plugin --profile web add <tgz>` 退出码 0（隔离 profile）', add.status === 0, tail(mergeOut(add)))
  const installed = join(home, 'profiles', 'web', 'node_modules', 'dsh-ppt-studio')
  check('插件已物化到隔离 profile', existsSync(join(installed, 'lib', 'index.js')), installed)

  // ── 3) 探针（temp 里的独立模块）+ overlay patch（绝对 file:// 行）──────────────
  const probeFile = join(work, 'probe.mjs')
  writeFileSync(probeFile, probeSource(), 'utf8')
  const patchFile = join(work, 'probe.patch.yml')
  writeFileSync(patchFile, `# verify-preset-scope：把探针挂到 profile 平面（绝对 file:// 名，不经 baseUrl 解析）\n`
    + `- insert:\n    - id: ppt-scope-probe\n      name: '${pathToFileURL(probeFile).href}'\n`, 'utf8')
  const resultFile = join(work, 'result.json')
  const hostLog = join(work, 'host.log')

  // ── 4) 拉起宿主 ───────────────────────────────────────────────────────────────
  console.log('\n拉起隔离宿主（不打开浏览器，端口交给 OS）…')
  host = spawn(process.execPath, [dshBin, '--profile', 'web', '--patch', patchFile, '--no-open', '--port', '0'], {
    cwd, env: {
      ...env,
      PPT_SCOPE_VERIFY: '1',
      PPT_SCOPE_RESULT: resultFile,
      PPT_SCOPE_PRESET: PRESET,
      PPT_SCOPE_OTHER: OTHER,
      PPT_SCOPE_NEGATIVE: NEGATIVE ? '1' : '0',
      PPT_SCOPE_CWD: cwd,
      PPT_STUDIO_DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let hostOut = ''
  host.stdout.on('data', (b) => { hostOut += String(b) })
  host.stderr.on('data', (b) => { hostOut += String(b) })
  host.on('error', (e) => { hostOut += `\n[spawn error] ${String(e?.message ?? e)}\n` })

  const result = await waitForResult(resultFile, host, TIMEOUT_MS)
  writeFileSync(hostLog, hostOut, 'utf8')
  if (result !== null) {
    const url = (hostOut.match(/https?:\/\/127\.0\.0\.1:\d+\S*/) ?? ['(未见 URL)'])[0]
    info('宿主已就绪', url)
  }

  if (result === null) {
    check(`探针在 ${TIMEOUT_MS / 1000}s 内产出结果（${resultFile}）`, false,
      host === null || host.exitCode === null ? '宿主仍在跑但探针未落盘' : `宿主已退出 exit=${host.exitCode}`)
    console.log('  —— 宿主输出尾部 ——')
    for (const l of hostOut.split(/\r?\n/).slice(-12)) console.log(`  ${l}`)
  } else {
    exitCode = report(result)
  }
} finally {
  await killHost(host)
  if (KEEP) console.log(`\n（--keep）隔离目录保留在：${work}`)
  else rmSync(work, { recursive: true, force: true })
}

const verdict = fail > 0 ? 'FAIL' : (pending ? 'PENDING(隔离未生效—核心改动未落地)' : 'PASS')
console.log(`\n==== verify-preset-scope 结果：${verdict}：${pass} 通过 / ${fail} 失败 ====`)
process.exit(fail > 0 ? 1 : exitCode)

// ────────────────────────────────────────────────────────────────────────────────
/** 断言矩阵。返回进程退出码（0 通过 / PENDING；1 失败；STRICT 下 PENDING=2）。 */
function report(result) {
  const matrix = result.matrix ?? {}
  const presets = matrix.presets ?? []
  const ppt = matrix[PRESET] ?? {}
  const other = matrix[OTHER] ?? {}
  const switched = matrix.switched ?? {}
  const globalView = matrix.global ?? {}
  const rowOf = (id) => presets.find((p) => p.id === id)

  if (result.fatal) {
    check('探针跑完（无致命错误）', false, tail(result.fatal, 400))
    return 1
  }
  check('探针跑完（无致命错误）', true, `stages=${(result.stages ?? []).join(' → ')}`)

  // ── A. 预设健康度 ─────────────────────────────────────────────────────────────
  head('A. 预设健康度（agentPresets.list() 有无 broken 字段）')
  const pptRow = rowOf(PRESET)
  check(`presets 列表里存在 ${PRESET} 预设`, pptRow !== undefined,
    presets.map((p) => p.id).join(', '))
  const healthy = pptRow !== undefined && pptRow.broken === undefined
  check(`${PRESET} 预设无 broken 字段（= 选择器可见）`, healthy, pptRow?.broken ?? '(无 broken)')

  // ── "隔离是否生效"的判定（先判，再决定后面是断言还是 PENDING）────────────────────
  const isolatedTools = (ppt.pptTools ?? []).length === EXPECT_TOOLS && (other.pptTools ?? []).length === 0
  const isolatedSkills = (ppt.pptSkills ?? []).length === EXPECT_SKILLS && (other.pptSkills ?? []).length === 0
  const isolatedPrompt = ppt.hasWorkflowSection === true && other.hasWorkflowSection === false
  const isolated = isolatedTools && isolatedSkills && isolatedPrompt

  head('B. 隔离判定（三条同时成立才算"改动已落地"）')
  // 已落地 ⇒ 这三条是门禁断言（计入通过/失败）；未落地 ⇒ 它们只是"为什么判未落地"的证据行。
  const marks = isolated ? check : evidence
  marks(`工具隔离：${PRESET} ppt_*=${(ppt.pptTools ?? []).length}（期望 ${EXPECT_TOOLS}）且 ${OTHER} ppt_*=0`,
    isolatedTools, `${PRESET}=${(ppt.pptTools ?? []).length}｜${OTHER}=${(other.pptTools ?? []).length}`)
  marks(`技能隔离：${PRESET} 本插件技能=${(ppt.pptSkills ?? []).length}（期望 ${EXPECT_SKILLS}）且 ${OTHER}=0`,
    isolatedSkills, `${PRESET}=${(ppt.pptSkills ?? []).length}｜${OTHER}=${(other.pptSkills ?? []).length}`)
  marks(`提示段隔离：${PRESET} sections 含 ppt-workflow 且 ${OTHER} 不含`,
    isolatedPrompt, `${PRESET}=${ppt.hasWorkflowSection}｜${OTHER}=${other.hasWorkflowSection}`)

  if (!isolated) {
    if (!healthy) {
      // 预设不健康是**真失败**（不是"未落地"）：插件声明了一条注定挂不上的行。
      head('结论：FAIL —— 预设不健康（不是"未落地"）')
      check(`${PRESET} 预设必须健康`, false, String(pptRow?.broken ?? '(缺失)'))
      return 1
    }
    head('结论：隔离未生效（核心改动未落地，或走了全局回落）')
    console.log(`⚠ PENDING(隔离未生效—核心改动未落地)：${PRESET} 预设健康，但隔离矩阵未成立：`)
    info(`工具：${OTHER} 可见 ppt_*`, String((other.pptTools ?? []).length))
    info(`工具：${PRESET} 可见 ppt_*`, String((ppt.pptTools ?? []).length))
    info('技能', `${OTHER}=${(other.pptSkills ?? []).length}｜${PRESET}=${(ppt.pptSkills ?? []).length}`)
    info('提示段', `${OTHER}=${other.hasWorkflowSection}｜${PRESET}=${ppt.hasWorkflowSection}`)
    info('全局视图 ppt_*', String((globalView.pptTools ?? []).length))
    // 口径要说清是"哪一条没成立"，不要一律归因于"未落地"（避免用推断代替证据）
    if (isolatedPrompt && !isolatedTools) {
      info('归因提示', '提示段已隔离而工具未隔离 ⇒ 可能"部分落地"，或 --expect-tools 与插件实际工具数不符（先核对期望值）')
    } else if (!isolatedPrompt && isolatedTools && isolatedSkills) {
      info('归因提示', '工具/技能已隔离而提示段未隔离 ⇒ 提示段与语义路由可能仍注册在 profile 平面（本轮最需要补的就是这条）')
    } else {
      info('归因提示', '三条均未隔离 ⇒ 更像核心改动未落地；若确信已落地，请查宿主日志里的 [ppt-studio] 回落告警')
    }
    console.log('（这不是宿主问题：请确认 src/preset-delivery.js 的自定位行与 src/index.js 的 scope 分档已落地；'
      + '本脚本测的是 src（副本里现场 build），与仓库提交的 lib/ 是否同步无关）')
    pending = true
    return STRICT ? 2 : 0
  }

  // ── C. 非 PPT 预设：零影响（三条口径分开断言）────────────────────────────────────
  head(`C. 非 PPT 预设（${OTHER}）零影响`)
  check('工具：ppt_* = 0', (other.pptTools ?? []).length === 0, `可见工具 ${other.toolCount ?? '?'} 个：${(other.tools ?? []).join(',')}`)
  check(`技能：本插件 ${EXPECT_SKILLS} 本 = 0`, (other.pptSkills ?? []).length === 0,
    `可见技能 ${(other.skills ?? []).length} 个${(other.skills ?? []).length ? `：${(other.skills ?? []).join(',')}` : ''}`)
  check('提示段：sections 里没有 ppt-workflow', other.hasWorkflowSection === false,
    `sections = [${(other.sections ?? []).join(', ')}]`)

  // ── D. PPT 预设：全能力面（含提示段"有"这一向）────────────────────────────────
  head(`D. PPT 预设（${PRESET}）全能力面`)
  check(`工具：ppt_* = ${EXPECT_TOOLS}`, (ppt.pptTools ?? []).length === EXPECT_TOOLS, `ppt_* = [${(ppt.pptTools ?? []).join(',')}]`)
  check(`技能：= ${EXPECT_SKILLS}`, (ppt.pptSkills ?? []).length === EXPECT_SKILLS, `[${(ppt.pptSkills ?? []).join(',')}]`)
  check('提示段：sections 里有 ppt-workflow', ppt.hasWorkflowSection === true,
    `sections = [${(ppt.sections ?? []).join(', ')}]`)
  check('模型面目录交叉核对：assembly.tools 里 ppt_* 数 = tools.schemas 里 ppt_* 数',
    (ppt.assemblyPptTools ?? []).length === (ppt.pptTools ?? []).length,
    `assembly=${(ppt.assemblyPptTools ?? []).length}｜registry=${(ppt.pptTools ?? []).length}`)

  // ── E. 会话内切换 ─────────────────────────────────────────────────────────────
  head('E. 会话内切换（standard → ppt，同一 agent）')
  check('切换成功且 composedPreset 变成 ppt', switched.composedPreset === PRESET, String(switched.composedPreset ?? '(未取到)'))
  check(`切换后拿到 ppt_* = ${EXPECT_TOOLS}`, (switched.pptTools ?? []).length === EXPECT_TOOLS, `= ${(switched.pptTools ?? []).length}`)
  check(`切换后拿到技能 = ${EXPECT_SKILLS}`, (switched.pptSkills ?? []).length === EXPECT_SKILLS, `= ${(switched.pptSkills ?? []).length}`)
  check('切换后提示段也出现 ppt-workflow（提示段判据同样跟随 scope 链）', switched.hasWorkflowSection === true,
    `sections = [${(switched.sections ?? []).join(', ')}]`)

  // ── F. 零全局残留 ─────────────────────────────────────────────────────────────
  head('F. 零全局残留（无预设的全局视图）')
  check('全局视图 ppt_* = 0', (globalView.pptTools ?? []).length === 0,
    `全局工具 ${globalView.toolCount ?? '?'} 个，ppt_* = [${(globalView.pptTools ?? []).join(',')}]`)

  // ── G. 负面对照（可选）────────────────────────────────────────────────────────
  if (NEGATIVE) {
    head('G. 负面对照：故意写错的 file:// 行')
    const neg = matrix.negative ?? {}
    check('宿主报告 broken（诊断含 "never started"）', typeof neg.brokenRow === 'string' && /never started/.test(neg.brokenRow),
      tail(String(neg.brokenRow ?? '(未取到)'), 300))
    check('坏预设不影响好预设（ppt 仍健康）', neg.pptStillHealthy !== false, String(neg.pptStillHealthy))
  }

  // ── 判据来源（口径标注，避免"用推断代替"）──────────────────────────────────────
  head('判据来源（每个口径的 API 与宿主代码）')
  info('工具可见性', "ctx.get('tools').schemas(agent) ← systemPrompt.tools(ctx => wireSchemas(ctx.scope))，dsh-tools/lib/index.js:2707/:3023/:2959-2985")
  info('技能可见性', "ctx.get('skills').list({ scope: agent })，dsh-skill/lib/index.js:224-240（按 scope 链合并，:111-117）")
  info('提示段可见性', "ctx.get('systemPrompt').assemble({ agent, scope: agent }) 的 sections ← dsh-agent/lib/types/dispatch.js:92-94 + dsh-agent-loop/lib/index.js:907；waterfall 按 scope 投递 dsh-system-prompt/lib/index.js:355")
  info('预设健康度', 'ctx.get(\'agentPresets\').list() 的 broken 字段，dsh-agent-preset-registry/lib/index.js:578-587')
  info('全局残留', "ctx.get('tools').schemas(undefined)（无预设的全局视图）")
  info('跨平面注记', '工具/技能三条断言读的是"注册表层"（模型目录同一来源）；提示段读的是"装配入口返回的 sections"。三者都不是推断。')
  return 0
}

/** 轮询结果文件（探针原子写：先 .tmp 再 rename）。 */
async function waitForResult(file, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try { return JSON.parse(readFileSync(file, 'utf8')) } catch { /* 半成品，继续等 */ }
    }
    if (child !== null && child.exitCode !== null) {
      // 宿主退出前可能刚写完，再给一次机会
      await sleep(300)
      if (existsSync(file)) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { /* 忽略 */ } }
      return null
    }
    await sleep(400)
  }
  return null
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** 结束宿主（Windows 下要连子进程一起杀）。 */
async function killHost(child) {
  if (child === null || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') run('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    else child.kill('SIGKILL')
  } catch { /* 忽略 */ }
  await sleep(500)
}

/** 探测宿主入口：$DSH_BIN → `npm root -g` → APPDATA/LOCALAPPDATA → homedir。 */
function findDshBin() {
  const rel = join('@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const candidates = []
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN)
  try {
    const r = run('npm', ['root', '-g'])
    if (r.status === 0) candidates.push(join(mergeOut(r), rel))
  } catch { /* npm 不可用 */ }
  for (const k of ['APPDATA', 'LOCALAPPDATA']) if (process.env[k]) candidates.push(join(process.env[k], 'npm', 'node_modules', rel))
  candidates.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', rel))
  candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
  for (const c of candidates) if (c && existsSync(c)) return c
  return null
}

// ────────────────────────────────────────────────────────────────────────────────
/**
 * 探针插件源码（写到 temp 的 probe.mjs，由 --patch overlay 以绝对 file:// 名挂载）。
 * 它**只读**宿主状态 + 建会话 + 枚举，不改仓库、不改插件。
 *
 * 写成**函数声明**而不是模块级 const：下面的顶层代码在模块求值到 `const` 之前就会调用它
 * （TDZ 会抛 "Cannot access 'PROBE_SOURCE' before initialization"——仓库自己的
 * scripts/verify-fresh-install.mjs 顶部注释记过同一个坑）。
 * @returns {string} 探针模块源码
 */
function probeSource() {
  return String.raw`
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.env.PPT_SCOPE_RESULT
const LOG = String(OUT) + '.log'
const PRESET = process.env.PPT_SCOPE_PRESET || 'ppt'
const OTHER = process.env.PPT_SCOPE_OTHER || 'standard'
const NEG = process.env.PPT_SCOPE_NEGATIVE === '1'
const CWD = process.env.PPT_SCOPE_CWD || process.cwd()
const HOME = process.env.DSH_HOME

const RESULT = { startedAt: new Date().toISOString(), stages: [], errors: [], matrix: {} }
const log = (m) => { try { appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\n') } catch {} }
const flush = () => {
  try { writeFileSync(OUT + '.tmp', JSON.stringify(RESULT, null, 2)); renameSync(OUT + '.tmp', OUT) } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(ctx, name, ms = 60000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { const s = ctx.get(name); if (s !== undefined) return s } catch { /* 继续等 */ }
    await sleep(300)
  }
  return undefined
}

export const name = 'ppt-scope-probe'

export function apply(ctx) {
  if (process.env.PPT_SCOPE_VERIFY !== '1') return
  main(ctx).catch((e) => { RESULT.fatal = String(e?.stack ?? e); flush(); log('FATAL ' + e) })
}

async function main(ctx) {
  const systemPrompt = await waitFor(ctx, 'systemPrompt')
  const tools = await waitFor(ctx, 'tools')
  const agents = await waitFor(ctx, 'agents')
  const presets = await waitFor(ctx, 'agentPresets')
  const skills = ctx.get('skills')
  if (!systemPrompt || !tools || !agents || !presets) {
    RESULT.fatal = '必需服务缺失：' + JSON.stringify({ systemPrompt: !!systemPrompt, tools: !!tools, agents: !!agents, presets: !!presets })
    flush(); return
  }
  RESULT.stages.push('services')
  log('服务就绪')

  // 等到本插件把预设声明落定（list() 会跑注册表的 diagnostic，broken 判据就在这里）
  let list = []
  for (let i = 0; i < 100; i++) {
    list = await presets.list().catch((e) => [{ id: '(list 抛错)', broken: String(e?.message ?? e) }])
    if (list.some((p) => p.id === PRESET)) break
    await sleep(300)
  }
  RESULT.matrix.presets = list.map((p) => ({ id: p.id, name: p.name, order: p.order, broken: p.broken }))
  RESULT.stages.push('preset-declared')
  log('presets=' + JSON.stringify(list.map((p) => p.id + (p.broken ? ':broken' : ''))))

  const presetBroken = (list.find((p) => p.id === PRESET) || {}).broken
  if (presetBroken !== undefined) {
    // 预设不健康：仍然把健康度证据写出来，让脚本判 FAIL（不继续建会话）
    RESULT.stages.push('preset-broken')
    flush(); return
  }

  let agentOptions
  try {
    const sel = ctx.get('agentDefaultModel')?.currentSelection()
    if (sel?.provider && sel?.model) agentOptions = { provider: sel.provider, model: sel.model }
  } catch { /* 缺默认模型不影响建会话 */ }

  async function makeAgent(presetId, sessionId) {
    // 先写会话状态（提示段判据需要 workflowActive=true）：字段照 lib/state.js 的 DEFAULT_SESSION
    mkdirSync(join(HOME, 'ppt-studio'), { recursive: true })
    writeFileSync(join(HOME, 'ppt-studio', 'session-' + String(sessionId).replace(/[^\w-]+/g, '_') + '.json'),
      JSON.stringify({
        routing: 'on', mode: 'auto', fidelity: 'auto', review: 'points', quality: 'standard',
        engine: 'auto', quick: false, template: null, pauseAfter: [],
        workflowActive: true, taskType: 'from-scratch', deckDir: null,
      }, null, 2), 'utf8')
    const resolved = await presets.resolve(presetId)
    if (resolved.broken !== undefined) throw new Error('预设 ' + presetId + ' 不健康：' + resolved.broken)
    const handle = await agents.create({
      sessionId,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      meta: { cwd: CWD, agentPreset: resolved.id },
      setup: async (agentCtx) => { await presets.mount(agentCtx, resolved.id) },
    })
    return handle.agent
  }

  async function measure(agent) {
    const out = { sessionId: agent.id, composedPreset: null, tools: [], toolCount: 0, pptTools: [],
      skills: [], pptSkills: [], sections: [], hasWorkflowSection: false, assemblyPptTools: [], errors: [] }
    try { out.composedPreset = presets.composedPreset(agent.ctx) ?? null } catch (e) { out.errors.push('composedPreset: ' + e.message) }
    try {
      const names = tools.schemas(agent).map((s) => s.name).sort()
      out.tools = names; out.toolCount = names.length; out.pptTools = names.filter((n) => n.startsWith('ppt_'))
    } catch (e) { out.errors.push('schemas: ' + String(e?.message ?? e)) }
    try {
      if (skills === undefined) out.errors.push('skills 服务缺失')
      else {
        const rows = await skills.list({ scope: agent })
        out.skills = rows.map((s) => s.name).sort()
        out.pptSkills = out.skills.filter((n) => n.startsWith('ppt-studio-'))
      }
    } catch (e) { out.errors.push('skills.list: ' + String(e?.message ?? e)) }
    try {
      // 与宿主 agent-loop 同一入口：assembleContextFor(agent) = { agent, scope: agent }
      const assembly = await systemPrompt.assemble({ agent, scope: agent })
      out.sections = (assembly.sections ?? []).map((s) => s.name)
      out.hasWorkflowSection = out.sections.includes('ppt-workflow')
      out.assemblyPptTools = (assembly.tools ?? []).map((t) => t.name).filter((n) => n.startsWith('ppt_')).sort()
    } catch (e) { out.errors.push('assemble: ' + String(e?.message ?? e)) }
    return out
  }

  // 对照预设（standard）
  try {
    const a = await makeAgent(OTHER, 'scope-verify-' + OTHER)
    RESULT.matrix[OTHER] = await measure(a)
    RESULT.stages.push('agent:' + OTHER)
    log(OTHER + ' tools=' + RESULT.matrix[OTHER].toolCount + ' ppt=' + RESULT.matrix[OTHER].pptTools.length
      + ' skills=' + RESULT.matrix[OTHER].pptSkills.length + ' workflowSection=' + RESULT.matrix[OTHER].hasWorkflowSection)
  } catch (e) { RESULT.errors.push(OTHER + ': ' + String(e?.message ?? e)); log('ERR ' + OTHER + ' ' + e) }

  // ppt 预设
  let pptAgent
  try {
    pptAgent = await makeAgent(PRESET, 'scope-verify-' + PRESET)
    RESULT.matrix[PRESET] = await measure(pptAgent)
    RESULT.stages.push('agent:' + PRESET)
    log(PRESET + ' tools=' + RESULT.matrix[PRESET].toolCount + ' ppt=' + RESULT.matrix[PRESET].pptTools.length
      + ' skills=' + RESULT.matrix[PRESET].pptSkills.length + ' workflowSection=' + RESULT.matrix[PRESET].hasWorkflowSection)
  } catch (e) { RESULT.errors.push(PRESET + ': ' + String(e?.message ?? e)); log('ERR ' + PRESET + ' ' + e) }

  // 会话内切换：在对照预设的 agent 上调注册表自己的 select（= agent-presets.swap 的源头函数）
  try {
    if (RESULT.matrix[OTHER] !== undefined) {
      const again = await makeAgentAfterSwitch(presets, agents, agentOptions)
      RESULT.matrix.switched = again
      RESULT.stages.push('switched')
      log('switched composedPreset=' + again.composedPreset + ' ppt=' + again.pptTools.length
        + ' skills=' + again.pptSkills.length + ' workflowSection=' + again.hasWorkflowSection)
    }
  } catch (e) { RESULT.errors.push('switch: ' + String(e?.message ?? e)); log('ERR switch ' + e) }

  async function makeAgentAfterSwitch(presets2, agents2, agentOptions2) {
    // 重新走一遍"先 standard 再切"的完整路径，避免复用已被测过的 agent 造成歧义
    const sid = 'scope-verify-switch'
    mkdirSync(join(HOME, 'ppt-studio'), { recursive: true })
    writeFileSync(join(HOME, 'ppt-studio', 'session-' + sid + '.json'),
      JSON.stringify({
        routing: 'on', mode: 'auto', fidelity: 'auto', review: 'points', quality: 'standard',
        engine: 'auto', quick: false, template: null, pauseAfter: [],
        workflowActive: true, taskType: 'from-scratch', deckDir: null,
      }, null, 2), 'utf8')
    const first = await presets2.resolve(OTHER)
    const handle = await agents2.create({
      sessionId: sid,
      ...(agentOptions2 === undefined ? {} : { agentOptions: agentOptions2 }),
      meta: { cwd: CWD, agentPreset: first.id },
      setup: async (agentCtx) => { await presets2.mount(agentCtx, first.id) },
    })
    const agent = handle.agent
    await presets2.select(agent, PRESET)
    await sleep(500)
    return measure(agent)
  }

  // 全局视图（无预设）
  try {
    const names = tools.schemas(undefined).map((s) => s.name).sort()
    RESULT.matrix.global = { toolCount: names.length, pptTools: names.filter((n) => n.startsWith('ppt_')) }
    RESULT.stages.push('global-view')
    log('global tools=' + names.length + ' ppt=' + RESULT.matrix.global.pptTools.length)
  } catch (e) { RESULT.errors.push('global: ' + String(e?.message ?? e)) }

  // 负面对照：自己注册一条故意写错的 file:// 行，看宿主的失败形状
  if (NEG) {
    try {
      const bogus = new URL('nope-missing.js', import.meta.url).href
      const unregister = await presets.register({
        id: 'scope-verify-broken', name: 'scope verify broken (预期 broken)',
        plugins: [{ id: 'bogus-row', name: bogus }],
      })
      const after = await presets.list()
      const row = after.find((p) => p.id === 'scope-verify-broken') || {}
      RESULT.matrix.negative = {
        bogusName: bogus,
        brokenRow: row.broken,
        pptStillHealthy: (after.find((p) => p.id === PRESET) || {}).broken === undefined,
      }
      RESULT.stages.push('negative')
      log('negative broken=' + JSON.stringify(row.broken))
      await unregister()
    } catch (e) { RESULT.errors.push('negative: ' + String(e?.message ?? e)) }
  }

  RESULT.finishedAt = new Date().toISOString()
  flush()
  log('DONE')
}
`
}
