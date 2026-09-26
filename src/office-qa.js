/**
 * 官方 QA 通道（2026-09-26，第二轮 ②）——**第三方自证**，能力探测驱动。
 *
 * 为什么需要：我们自己的 parity/audit 都是"自己写、自己查"。官方 office 技能带来两件外部工具：
 *   ① `check_office.py`：ZIP/XML/rels **完整性** + 文本抽取 + `--contains/--count` 断言（只读、不渲染）；
 *   ② LibreOffice kit CLI：**不依赖 Office/COM** 的渲染与转 PDF（`render`/`convert`/`recalculate`）。
 * 但它们在**桌面端/SDK** 才有（web/headless 出厂组合不挂 `dsh-skill-office`，npm 版也没有 Python 分发）
 * ⇒ 所以这里一律"**先探测、探不到就说清原因**"，绝不假装跑过。三个函数都返回
 * `{ available, ok, reason, … }`，调用方据此决定是打一行自证、还是打一行"本部署不可用"。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { findAnyPython, findBundledNode, findLibreofficeCli, findOfficeAssets } from './capabilities.js'

/**
 * 官方结构检查：`<bundledPython> <check_office.py> <file> [--contains T]… [--count N]`。
 * `check_office.py` 把 JSON 报告写到 stdout：`{format, verdict:'pass'|'fail', checks, summary}`，
 * 退出码 0=通过 / 1=失败 / 2=参数错误。
 * @returns {{available: boolean, ok?: boolean, verdict?: string, summary?: unknown, checks?: unknown, reason: string, raw?: string}}
 */
export function runOfficeStructureCheck(file, { contains = [], count = 0, timeoutMs = 60000 } = {}) {
  const assets = findOfficeAssets()
  if (assets === null) return { available: false, reason: '本部署没有官方 office 资产（桌面端/SDK 才有：resources/runtime/office-skills）' }
  if (assets.checker === null) return { available: false, reason: `office 资产在（${assets.skillsDir}）但没有 scripts/check_office.py` }
  const py = findAnyPython()
  if (py === null) return { available: false, reason: '没有任何可用的 Python（check_office.py 需要它；捆绑 Python 与 PATH 都没探到）' }
  if (!existsSync(file)) return { available: true, ok: false, reason: `待检文件不存在：${file}` }
  const args = [assets.checker, file]
  for (const t of contains) args.push('--contains', String(t))
  if (count > 0) args.push('--count', String(count))
  const r = spawnSync(py.path, args, { encoding: 'utf8', timeout: timeoutMs })
  if (r.error !== undefined) return { available: true, ok: false, reason: `执行失败：${r.error?.message ?? r.error}` }
  let report = null
  try { report = JSON.parse(String(r.stdout ?? '')) } catch { /* 解析失败走下面的兜底 */ }
  const ok = r.status === 0 && report?.verdict === 'pass'
  const failed = report?.checks?.filter?.((c) => c?.status === 'fail')?.map?.((c) => `${c.id}: ${c.detail}`) ?? []
  return {
    available: true,
    ok,
    verdict: report?.verdict ?? (r.status === 0 ? 'pass' : 'fail'),
    summary: report?.summary ?? null,
    checks: report?.checks ?? null,
    reason: ok
      ? 'pass'
      : (r.status === 2 ? '命令行参数错误' : `verdict=${report?.verdict ?? 'unknown'}（exit ${r.status ?? '?'}）${failed.length ? `｜失败项：${failed.slice(0, 3).join('；')}` : ''}`),
    raw: String(r.stderr || r.stdout || '').slice(0, 400),
  }
}

/**
 * LibreOffice kit 渲染（**无 Office 也能出 PNG**）：`<bundledNode> <cli> render --input F --output-dir D [--pages …] --dpi N`。
 * 注意：LibreOffice 的排版/字体与 PowerPoint 是两套引擎，**不能**当"逐像素等于 PowerPoint"的判据，
 * 只能作为"没有 Office 时的替代真渲染"（交付说明里要如实标注用的是哪一个引擎）。
 */
export function runLibreOfficeRender(file, outDir, { pages = '', dpi = 144, timeoutMs = 300000 } = {}) {
  const cli = findLibreofficeCli()
  if (cli === null) return { available: false, reason: '本部署没有 LibreOffice kit（桌面端才有：app.asar.unpacked 下的 @deepseek-ai/libreoffice-kit）' }
  const node = findBundledNode()
  if (node === null) return { available: false, reason: '没有捆绑 Node（kit CLI 需要它作为第一参数）' }
  if (!existsSync(file)) return { available: true, ok: false, reason: `待渲染文件不存在：${file}` }
  // kit 的硬契约（官方技能原文 "Outputs must be new directories/files"）：**输出目录必须不存在**，
  // 预建目录会让它直接 `EEXIST: file already exists, mkdir …` 失败（2026-09-26 实测踩到）。
  // 所以这里先清掉旧目录，再让 kit 自己创建。
  try { rmSync(outDir, { recursive: true, force: true }) } catch { /* 由下面的 spawn 失败兜住 */ }
  const args = [cli, 'render', '--input', file, '--output-dir', outDir]
  if (pages) args.push('--pages', String(pages))
  args.push('--dpi', String(dpi))
  const r = spawnSync(node, args, { encoding: 'utf8', timeout: timeoutMs })
  let files = []
  try { files = readdirSync(outDir).filter((f) => /\.png$/i.test(f)).sort().map((f) => join(outDir, f)) } catch { files = [] }
  // manifest.json 是 kit 的**权威页码映射**（`images[].index` 是本次输出的序号、`.page` 才是原页号；
  // 文件名是 `page-0001.png` 这种**序号**名 ⇒ 只看文件名会把"第 2 页"当成"第 1 页"）。顺带带回缺字诊断。
  let images = []
  let missingFonts = []
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    images = Array.isArray(manifest?.images) ? manifest.images : []
    missingFonts = Array.isArray(manifest?.missingFonts) ? manifest.missingFonts : []
  } catch { /* 没有 manifest 就只报文件列表 */ }
  const ok = r.error === undefined && r.status === 0 && files.length > 0
  return {
    available: true,
    ok,
    files,
    images,
    missingFonts,
    reason: ok ? `ok（${files.length} 张${missingFonts.length ? `，缺字 ${missingFonts.length} 项` : ''}）` : (r.error !== undefined ? `执行失败：${r.error?.message ?? r.error}` : `exit ${r.status ?? '?'}${String(r.stderr ?? '').trim() ? `：${String(r.stderr).trim().slice(0, 300)}` : ''}`),
    raw: String(r.stdout || r.stderr || '').slice(0, 400),
  }
}

/** 一句话描述"本部署能不能做第三方自证"（用于导出报告里的一行说明，避免每处都拼字符串）。 */
export function officeQaStatus() {
  const assets = findOfficeAssets()
  const py = findAnyPython()
  const cli = findLibreofficeCli()
  const parts = []
  if (assets?.checker && py !== null) parts.push('check_office.py')
  if (cli && findBundledNode() !== null) parts.push('LibreOffice kit')
  if (parts.length === 0) {
    const why = []
    if (assets === null) why.push('无官方 office 资产')
    else if (assets.checker === null) why.push('有资产但缺 scripts/check_office.py')
    if (py === null) why.push('无 Python')
    if (cli === null) why.push('无 LibreOffice kit')
    return { available: false, detail: `无（${why.join('、')}）` }
  }
  return { available: true, detail: parts.join(' + ') }
}
