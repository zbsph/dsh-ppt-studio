/**
 * 手册事实审计（evidence report）——「我改对了没有」的可复跑证据。
 *
 * 与 smoke 的分工：
 *   - smoke §37/§38（13 条）= **回归闸门**：谁改坏了当场红、必须修。
 *   - 本脚本 = **证据报告**：把每一条"手册 vs 源码"的事实逐条验一遍，打印 ✓/✗ + 源码锚点，
 *     供人工复核与交接（`npm run audit:facts`）。不进门禁，失败退出码非 0 便于 CI/人工使用。
 *
 * 覆盖三类：
 *   ① 结构性事实（名字/集合/形状/阈值）——可机器判定；
 *   ② 运行时语义（某个写法到底会不会报错）——用真实引擎跑小夹具；
 *   ③ 文档自证（各处引用计数、纪律文档里的条数）——防"文档说自己有 13 条其实只有 9 条"。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { listBundledSkills } from '../lib/skill.js'
import { SCHEMA_REF } from '../lib/scaffold.js'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { exportPptx } from '../lib/pptd/export-pptx.js'
import { verifyDeck } from '../lib/verify.js'
import { chartSvg } from '../lib/pptd/svgCharts.js'
import { zipRead, decodeXml } from '../lib/zips.js'
import { readFileSync as rfs } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const src = {
  verify: read(join('src', 'verify.js')),
  schema: read(join('src', 'pptd', 'schema.js')),
  svgCharts: read(join('src', 'pptd', 'svgCharts.js')),
  exportPptx: read(join('src', 'pptd', 'export-pptx.js')),
  renderHtml: read(join('src', 'pptd', 'render-html.js')),
  tools: read(join('src', 'tools.js')),
  index: read(join('src', 'index.js')),
  commands: read(join('src', 'commands.js')),
  router: read(join('src', 'router.js')),
  crosscheck: read(join('src', 'crosscheck.js')),
  scaffold: read(join('src', 'scaffold.js')),
}
const skills = listBundledSkills().map((b) => ({ name: b.parsed.name, text: b.parsed.content, desc: b.parsed.description, when: b.parsed.whenToUse ?? '' }))
const bySkill = Object.fromEntries(skills.map((s) => [s.name, s.text]))
const all = skills.map((s) => s.text).join('\n')
const manual = bySkill['ppt-studio-manual'] ?? ''

let pass = 0
let fail = 0
const rows = []
const check = (claim, ok, evidence) => {
  rows.push(`${ok ? '✓' : '✗'} ${claim}\n      ↳ ${evidence}`)
  ok ? pass++ : fail++
}

// ── ① 结构性事实 ────────────────────────────────────────────────────────────
const registered = new Set()
for (const f of ['tools.js', 'index.js']) for (const m of read(join('src', f)).matchAll(/name: '(ppt_[a-z_]+)'/g)) registered.add(m[1])
const mentioned = new Set([...all.matchAll(/\b(ppt_[a-z_]+)\b/g)].map((m) => m[1]))
const ghosts = [...mentioned].filter((t) => !registered.has(t))
check('手册提到的 ppt_* 全部是已注册工具', ghosts.length === 0, ghosts.length ? `不存在：${ghosts.join('、')}` : `${mentioned.size} 个名字命中注册表（共 ${registered.size} 个工具）`)

const vLines = src.verify.split(/\r?\n/)
const codes = new Map()
vLines.forEach((line, i) => {
  if (/\b(?:let|const|var)\s+code\s*=/.test(line)) return
  for (const m of line.matchAll(/code\s*[:=]\s*'([a-z-]+)'/g)) {
    const w = vLines.slice(Math.max(0, i - 3), i + 1).join('\n')
    codes.set(m[1], /'error'/.test(w) ? 'error' : 'warn|suggest')
  }
})
const errCodes = [...codes].filter(([, s]) => s === 'error').map(([c]) => c).sort()
const noDoc = errCodes.filter((c) => !manual.includes(c))
check('verify 的每个门禁错误码都写进了使用手册 §4', noDoc.length === 0, noDoc.length ? `缺：${noDoc.join('、')}` : `错误码 ${errCodes.join('/')}`)
const gateLine = manual.split('\n').find((l) => l.includes('ERROR 必须清零')) ?? ''
const gateNames = [...gateLine.matchAll(/`([a-z][a-z-]*)`/g)].map((m) => m[1])
const ghostGate = gateNames.filter((t) => !errCodes.includes(t))
check('手册门禁清单里的 code 名都是真实错误码（防写出源码里没有的名字）', ghostGate.length === 0 && gateNames.length > 0, ghostGate.length ? `幽灵 code：${ghostGate.join('、')}` : `清单 = ${gateNames.join('/')}`)

for (const c of ['density', 'hotspot', 'near-align']) {
  const line = vLines.find((l) => l.includes(`code: '${c}'`)) ?? ''
  check(`${c} 在源码里是 warning（手册不得归到 [·] 建议）`, /severity: 'warning'/.test(line), `verify.js: ${line.trim().slice(0, 90)}`)
}
const conformanceMode = src.verify.match(/severity: mode === 'strict' \? 'error' : 'warning',\s*\n?\s*code: 'theme-conformance'/)
check('theme-conformance：strict=error / suggest=warning / off=跳过（手册如此描述）', !!conformanceMode, 'verify.js themeConformance(): severity 随 mode 切换；无 colors 自动跳过')

const lineValidator = src.schema.match(/仅支持 2 点 \[\[x1,y1\],\[x2,y2\]\]/)
check('line 只支持两点（手册已写明，拆成多条 line）', !!lineValidator, `schema.js validateLine: ${(lineValidator?.[0] ?? '未找到').slice(0, 60)}`)

const tableKeys = src.schema.match(/table: \['cols', 'rows', 'header'\]/)
check('table 只有 cols/rows/header（手册"没有逐列对齐字段"成立）', !!tableKeys, `schema.js ELEMENT_KEYS: ${tableKeys?.[0] ?? '未找到'}`)

const chartKeys = src.schema.match(/chart: \['chart'\]/)
const chartNoLabels = !/legend|dataLabels|labels\s*:/.test(src.schema.match(/function validateChart[\s\S]*?\n\}/)?.[0] ?? '')
check('chart 没有分类名/数值/图例字段（手册"标签要自己补"成立）', !!chartKeys && chartNoLabels, `schema.js ELEMENT_KEYS.chart=${chartKeys?.[0] ?? '?'}；validateChart 只校验 type/data.cols/data.rows/series`)

const trunc = Number((src.svgCharts.match(/c\.length\s*>\s*(\d+)/) ?? [])[1])
const claimedTrunc = [...all.matchAll(/超过\s*(\d+)\s*字截断/g)].map((m) => Number(m[1]))
check('预览图表分类名截断阈值 = 手册所写', trunc > 0 && claimedTrunc.every((n) => n === trunc), `svgCharts.js: c.length > ${trunc}；手册声称 ${claimedTrunc.join(',') || '未写'}`)

const realCmds = new Set([...src.commands.matchAll(/cmd === '([a-z-]+)'/g)].map((m) => m[1]))
const mentionedCmds = new Set([...all.matchAll(/\/ppt\s+([a-z-]+)/g)].map((m) => m[1]))
const ghostCmds = [...mentionedCmds].filter((c) => !realCmds.has(c))
check('/ppt 子命令真实存在', ghostCmds.length === 0, ghostCmds.length ? `不存在：${ghostCmds.join('、')}` : `手册用到 ${[...mentionedCmds].join('/')}；命令面共 ${realCmds.size} 个`)

const floorM = src.exportPptx.match(/Math\.max\((\d+),\s*Math\.round\(origSize \*\s*([\d.]+)\)\)/)
const floorPt = Number(floorM?.[1])
const floorPct = Math.round(Number(floorM?.[2]) * 100)
check('缩字下限常量 = 手册所写 max(6pt, 60%)', new RegExp(`max\\(${floorPt}pt, ${floorPct}% 原字号\\)`).test(manual), `export-pptx.js: Math.max(${floorPt}, Math.round(origSize * ${floorM?.[2]}))`)

check('缺省页面尺寸 960×540 / 1px=1pt（手册所写）', /size \?\? \{ width: 960, height: 540 \}/.test(src.verify) && /960x540/.test(src.schema), 'verify.js verifyDeck(): size ?? {width:960,height:540}；schema.js 顶部注释')

// ── ② 运行时语义（真引擎小夹具）─────────────────────────────────────────────
const tmp = join(root, 'examples', 'smoke', '.tmp-audit-facts')
await rm(tmp, { recursive: true, force: true })
await mkdir(join(tmp, 'pages'), { recursive: true })
const deckYaml = (pages) => ['version: 1', 'title: "审计夹具"', 'size: [960, 540]', 'theme:',
  '  colors: {ink: "#111111", brand: "#2563EB"}',
  '  textStyles:', '    body: {fontSize: 14, color: "$ink"}', 'pages:', ...pages.map((p) => `  - pages/${p}.yaml`), ''].join('\n')
const page = (els, pageExtra = []) => ['pageType: content', ...pageExtra, 'elements:', ...els, ''].join('\n')
const box = 'bounds: [40, 40, 300, 80]'

// 夹具 A：文字压图表（含/不含 role 与声明）
const chartEl = (role, extra = []) => ['  - elementId: chart', '    elementType: chart', `    ${box}`, ...(role ? [`    role: ${role}`] : []),
  '    chart:', '      type: bar', '      data:', '        cols: [分类, 值]', '        rows: [[A, 1], [B, 2]]', ...extra]
const labelEl = ['  - elementId: label', '    elementType: text', '    bounds: [60, 60, 200, 40]', '    content: {text: "压在图上的标签", style: "$body"}']
// 不压图表的第二个元素：单元素页不会产生美学建议（els.length < 2 直接 return），且压图会造出 content-collision
const sideEl = ['  - elementId: side', '    elementType: text', '    bounds: [60, 320, 600, 40]', '    content: {text: "图旁的说明", style: "$body"}']
const writeDeck = async (dir, els, pageExtra = []) => {
  await mkdir(join(dir, 'pages'), { recursive: true })
  await writeFile(join(dir, 'deck.yaml'), deckYaml(['01']), 'utf8')
  await writeFile(join(dir, 'pages', '01.yaml'), page(els, pageExtra), 'utf8')
}
const verifyDir = async (dir) => {
  const ctx = await resolveDeck(dir)
  const r = await renderDeck(ctx, {})
  const v = verifyDeck(r.layout)
  return { ctx, r, v, errors: v.text.split('\n').filter((l) => l.includes('[✗]')).length }
}

const dirA = join(tmp, 'a-plain')
await writeDeck(dirA, [...labelEl, ...chartEl(null)])
const ra = await verifyDir(dirA)
check('运行时：无 role 的 chart 被 text 压住 → content-collision（内容互压）', /content-collision/.test(ra.v.text), `errors=${ra.errors}；${(ra.v.text.match(/content-collision[^\n]*/) ?? [''])[0].slice(0, 100)}`)

const dirB = join(tmp, 'b-declared-plain')
await writeDeck(dirB, [...labelEl, ...chartEl(null)], ['expectedOverlaps:', '  - pair: [chart, label]'])
const rb = await verifyDir(dirB)
check('运行时：无 role 时"声明也不管用"（仍报 content-collision）——手册"不可声明豁免"成立', /content-collision/.test(rb.v.text) && rb.errors > 0, `errors=${rb.errors}`)

const dirC = join(tmp, 'c-background')
await writeDeck(dirC, [...labelEl, ...chartEl('background')], ['expectedOverlaps:', '  - pair: [chart, label]'])
const rc = await verifyDir(dirC)
check('运行时：chart role:background + 声明 → 0 错误（"图当衬底"路径成立）', rc.errors === 0 && /预期重叠/.test(rc.v.text), `errors=${rc.errors}；${(rc.v.text.match(/预期重叠[^\n]*/) ?? [''])[0].slice(0, 60)}`)

const dirD = join(tmp, 'd-decoration')
await writeDeck(dirD, [...labelEl, ...chartEl('decoration')])
const rd = await verifyDir(dirD)
check('运行时：chart role:decoration → 不再报重叠（"纯装饰"路径成立，无需声明）', rd.errors === 0 && !/content-collision/.test(rd.v.text), `errors=${rd.errors}`)

const dirE = join(tmp, 'e-dec-outside')
await mkdir(join(dirE, 'pages'), { recursive: true })
await writeFile(join(dirE, 'deck.yaml'), ['version: 1', 'title: "出界夹具"', 'size: [960, 540]', 'theme:', '  colors: {ink: "#111111"}', '  safeArea: {top: 20, bottom: 20, left: 0, right: 0}', 'pages:', '  - pages/01.yaml', ''].join('\n'), 'utf8')
await writeFile(join(dirE, 'pages', '01.yaml'), page(['  - elementId: deco', '    elementType: shape', '    kind: rect', '    role: decoration', '    bounds: [40, 4, 120, 12]', '    fill: "#111111"']), 'utf8')
const re = await verifyDir(dirE)
check('运行时：decoration 不豁免出界（仍报 out-of-safe-area）——手册与 C3 口径一致', /out-of-safe-area/.test(re.v.text), `errors=${re.errors}；${(re.v.text.match(/out-of-safe-area[^\n]*/) ?? [''])[0].slice(0, 90)}`)

const dirF = join(tmp, 'f-bad-chart')
await writeDeck(dirF, ['  - elementId: c', '    elementType: chart', `    ${box}`, '    chart:', '      type: bad', '      data: [{label: A, value: 1}]'])
let badChart = null
try { await resolveDeck(dirF) } catch (e) { badChart = e }
check('运行时：chart 写成 data:[{label,value}] / type:bad → schema 直接拒绝', !!badChart && /chart\.type|data\.cols/.test(badChart.messages?.join(';') ?? ''), (badChart?.messages ?? []).join('; ').slice(0, 140) || '竟然通过了')

const dirG = join(tmp, 'g-3pts-line')
await writeDeck(dirG, ['  - elementId: poly', '    elementType: line', '    points: [[10, 10], [50, 30], [90, 10]]'])
let badLine = null
try { await resolveDeck(dirG) } catch (e) { badLine = e }
check('运行时：三点折线被拒（手册"每条只有两点"成立）', !!badLine && /2 点/.test(badLine.messages?.join(';') ?? ''), (badLine?.messages ?? []).join('; ').slice(0, 120) || '竟然通过了')

const dirH = join(tmp, 'h-notes')
await mkdir(join(dirH, 'pages'), { recursive: true })
await writeFile(join(dirH, 'deck.yaml'), deckYaml(['01']), 'utf8')
await writeFile(join(dirH, 'pages', '01.yaml'), ['pageType: content', 'notes: "这段讲稿应被写进 pptx 备注页"', 'elements:', ...labelEl, ''].join('\n'), 'utf8')
const rh = await verifyDir(dirH)
const expH = await exportPptx(rh.ctx, { out: 'out-notes.pptx', engine: 'pptd' })
const zipH = zipRead(await readFile(expH.file))
const hasNotesPart = [...zipH.keys()].some((k) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k))
check('运行时：页面 notes 真的写进 pptx（备注页部件存在）', hasNotesPart, hasNotesPart ? '包内有 notesSlide 部件' : '包内没有 notesSlide')
const notesParityOk = expH.parity?.notesExp === 1 && expH.parity?.notesOut === 1 && expH.parity?.ok === true
check('运行时：导出 parity 自证备注（notesExp/notesOut 且 ok）', notesParityOk, `parity = ${JSON.stringify(expH.parity ?? {})}`)
const notesRelsH = decodeXml(zipH.get('ppt/notesSlides/_rels/notesSlide1.xml.rels') ?? Buffer.from(''))
check('运行时：notesSlide 自带 rels（→ notesMaster + 回指幻灯）——缺它真 PowerPoint 报"文件损坏"',
  /notesMaster/.test(notesRelsH) && /Type="[^"]*\/slide"/.test(notesRelsH),
  `rels: ${notesRelsH.slice(0, 120) || '(缺失)'}`)
check('运行时：presentation.xml 不含 notesMasterIdLst（实测该元素会让 PowerPoint 拒开）',
  !/notesMasterIdLst/.test(decodeXml(zipH.get('ppt/presentation.xml'))), 'presentation.xml 中无 notesMasterIdLst')
const xmljsMod = await import('../lib/xmljs.js')
check('实体解码：&lt;/&amp;/数字实体能解回字符（导入侧此前不解码）',
  xmljsMod.parseXml('<a:t>R&amp;D &lt;x&gt; &#65;</a:t>').children[0].text === 'R&D <x> A',
  `解码结果=${JSON.stringify(xmljsMod.parseXml('<a:t>R&amp;D &lt;x&gt; &#65;</a:t>').children[0].text)}`)

const dirI = join(tmp, 'i-chartref')
await writeDeck(dirI, ['  - elementId: c', '    elementType: chart', `    ${box}`, '    chart:', '      type: bar', '      colors: ["$brand"]', '      data:', '        cols: [分类, 值]', '        rows: [[A, 1], [B, 2]]', ...sideEl])
const ri = await verifyDir(dirI)
// 必须走真实渲染产物：normalizePage() 会在 layout.js 里 resolveColor，直接调 chartSvg(原始 yaml) 会绕过它。
// （layout.json 快照只记 chartType、不记 colors，所以三层里可查的是"预览 HTML"与"导出 XML"两层。）
const htmlI = readFileSync(join(ri.r.outDir, ri.r.htmlFiles[0]), 'utf8')
const expI = await exportPptx(ri.ctx, { out: 'out-ref.pptx', engine: 'pptd' })
const xmlI = zipRead(await readFile(expI.file)).get('ppt/slides/slide1.xml').toString('utf8')
check('运行时：chart colors 用 $themeRef（$brand）在预览与成品两层都被解析为 hex',
  !htmlI.includes('$brand') && !/val="\$brand"/.test(xmlI),
  `预览 HTML ${htmlI.includes('$brand') ? '出现字面 $brand ✗' : '已解析 ✓'}；导出 XML ${/val="\$brand"/.test(xmlI) ? '仍是 $brand ✗' : '已解析 ✓'}`)

const themeChartColors = /aesthetic-theme[^\n]*颜色/.test(ri.v.text)
check('运行时：chart 显式用主题内颜色（$ref=$brand）→ 不出配色建议（不打扰）', !themeChartColors, themeChartColors ? (ri.v.text.match(/[^\n]*aesthetic-theme[^\n]*/) ?? [''])[0].slice(0, 110) : '无配色建议（$brand ∈ theme.colors）')

const dirI2 = join(tmp, 'i2-chart-offtheme')
await writeDeck(dirI2, ['  - elementId: c', '    elementType: chart', `    ${box}`, '    chart:', '      type: bar', '      colors: ["#FF00FF"]', '      data:', '        cols: [分类, 值]', '        rows: [[A, 1], [B, 2]]', ...sideEl])
const ri2 = await verifyDir(dirI2)
const offThemeSuggested = /aesthetic-theme[^\n]*#FF00FF/.test(ri2.v.text)
check('运行时：chart 显式写主题外颜色 → [·] 建议且**不新增错误**（图表配色刻意保持建议级）',
  offThemeSuggested && ri2.errors === 0,
  `建议${offThemeSuggested ? '命中' : '未命中'}；errors=${ri2.errors}`)

// ── ③ 文档自证 ──────────────────────────────────────────────────────────────
const smokeSrc = read(join('scripts', 'smoke.mjs'))
const guardNames = [...smokeSrc.matchAll(/ok\('(手册 vs 源码|SCHEMA_REF 自洽|文档计数自证)[^']*'/g)].map((m) => m[0])
const docClaim = Number((read(join('docs', '05-迭代流程.md')).match(/已落成 \*\*(\d+) 条机器断言\*\*/) ?? [])[1])
check('docs/05 §0c 声称的断言条数 = smoke 里实际新增的手册事实断言条数', docClaim === guardNames.length, `docs 声称 ${docClaim} 条；smoke 实际 ${guardNames.length} 条`)

const refLines = SCHEMA_REF.split('\n')
const refBad = refLines.find((l) => /decoration/.test(l) && /豁免/.test(l) && /出界/.test(l) && !/不豁免出界/.test(l))
check('SCHEMA_REF 自洽：不声称 decoration 豁免出界', refBad === undefined && refLines.some((l) => /不豁免出界/.test(l)), refBad ? `仍写着：${refBad.trim().slice(0, 70)}` : '两处口径一致：只豁免重叠、不豁免出界')

const crossPageClaims = /跨页一致性没有断言|这些没有工具断言|工具基本不管/.test(bySkill['ppt-studio-craft'] ?? '')
check('craft 已写明"跨页一致性没有工具断言"（源码确实无跨页/字体家族检查）', crossPageClaims && !/fontFamily/.test(src.verify), `verify.js 中 fontFamily 出现 ${(src.verify.match(/fontFamily/g) ?? []).length} 次`)

const tableOverflowClaim = /(不检查表格\/图表的溢出|表格放不下没有工具替你判)/.test(bySkill['ppt-studio-data'] ?? '')
const overflowTextOnly = /if \(el\.kind === 'text'\) \{/.test(src.verify) && !/code: '(table|chart|image)-overflow'/.test(src.verify)
check('data 已写明"表格/图表没有溢出断言"（源码确实只对 text 判溢出）', tableOverflowClaim && overflowTextOnly, `verify.js: 溢出断言位于 el.kind === 'text' 分支内`)

const unmappedEveryPage = /status: p\.page\.source \? 'grounded' : 'unmapped'/.test(src.crosscheck)
const unmappedHonest = /unmapped 只对数据页有要求|按"页"判/.test(bySkill['ppt-studio-data'] ?? '')
check('data 对 crosscheck 的口径与源码一致（每页都判、建议级）', unmappedEveryPage && unmappedHonest, `crosscheck.js: ${(src.crosscheck.match(/status: p\.page\.source[^\n]*/) ?? [''])[0].trim().slice(0, 80)}`)

const chartIssueScope = /allZero/.test(src.svgCharts) && !/fabricat/.test(src.svgCharts)
const chartIssueHonest = /没有任何工具会拦/.test(bySkill['ppt-studio-data'] ?? '')
check('data 对 chartIssue 的能力描述准确（只拦空数据/全零）', chartIssueScope && chartIssueHonest, 'svgCharts.js chartIssue(): rows 为空 / 全零或非有限值 → 其余不拦')

const notesHonest = /备注页/.test(bySkill['ppt-studio-copy'] ?? '') && /(导出|写进|随导出)/.test(bySkill['ppt-studio-copy'] ?? '')
check('copy §7 与导出器一致：讲稿会写进 pptx 备注页（双向断言，手册说反了会红）',
  notesHonest && /notesSlides\//.test(src.exportPptx), `export-pptx.js 备注部件 ${(src.exportPptx.match(/notesSlides\//g) ?? []).length} 处；手册${notesHonest ? '说会导出' : '未说会导出'}`)

const presetDrift = existsSync(join(root, 'agent-presets', 'ppt', 'agent.cordis.yml'))
check('预设副本仍在（check-preset.mjs 负责逐行比对）', presetDrift, 'agent-presets/ppt/agent.cordis.yml 存在，`npm run test:preset` 比对随包 standard')

// 触发纪律（2026-09-15 用户反馈）：答疑手册曾被"开工时"加载——因为它的 description/whenToUse
// 把"如何开始 / 模型不确定某一 DSL 写法"写成了触发条件（对正在做 PPT 的人是恒真条件）。
// 事实判定：答疑触发面只认"用户提问"，制作三本不把读者引向答疑手册，工作流提示段显式分行。
const manParsed = skills.find((s) => s.name === 'ppt-studio-manual') ?? { desc: '', when: '' }
const qaDesc = /用户问|提问/.test(manParsed.desc)
const qaWhen = /提问|用户问/.test(manParsed.when)
const negated = /不要加载/.test(manParsed.desc) && /不要加载/.test(manParsed.when)
const selfTrigger = /模型不确定/.test(manParsed.desc + manParsed.when) || /不确定某一/.test(manParsed.desc + manParsed.when)
check('答疑手册触发纪律：只由"用户提问"触发（description/whenToUse 双处声明 + "制作中不要加载"否定句）',
  qaDesc && qaWhen && negated && !selfTrigger,
  `提问触发=${qaDesc}/${qaWhen}｜否定句=${negated}｜恒真自触发措辞残留=${selfTrigger}`)

const crossPtr = ['ppt-studio-craft', 'ppt-studio-data', 'ppt-studio-copy'].filter((n) => (bySkill[n] ?? '').includes('ppt-studio-manual'))
const wfSplit = /答疑手册/.test(src.router) && /不要加载/.test(src.router)
check('答疑手册分层落地：工作流提示段显式分行（答疑手册 vs 制作手册），制作三本正文零指向答疑手册',
  wfSplit && crossPtr.length === 0, `工作流含分行=${wfSplit}；三本指向=${crossPtr.join('、') || '无'}`)

await rm(tmp, { recursive: true, force: true })

console.log(rows.join('\n'))
console.log(`\n==== 手册事实审计：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 条，逐条附源码锚点）====`)
process.exit(fail > 0 ? 1 : 0)
