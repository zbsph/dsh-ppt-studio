#!/usr/bin/env node
/**
 * `unknown-key` 检查：页面级/元素级**未知键** ⇒ 报 warning（**不阻断** ✓）。
 *
 * 为什么需要：写错/残留的键过去会被静默忽略 ⇒ 表面"出图了"，其实是空页或漏项。
 *
 * 白名单来源（**不手写猜测** ✓）：
 *   · 页面级：从 `src/pptd/schema.js` 的 `validatePage` 里**真正被访问的 `page.<键>`** 推导；
 *   · 元素级：`ELEMENT_KEYS`（类型专属）+ 通用键（`elementId/elementType/bounds/...`）+ `path`（custGeom 路径）。
 * 防漂移：默认模式扫**本仓自带示例**，一旦发现未知键就**判失败** ⇒ 白名单漏项会立刻在 `npm test` 暴露 ✓
 *         （宁可在 CI 里发现自己漏了键，也不能对用户误报）。
 *
 * 用法：
 *   node scripts/check-unknown-keys.mjs                  # 扫 examples/hand-drawn + examples/smoke（必须 0 命中）
 *   node scripts/check-unknown-keys.mjs --fixture <dir>   # 扫指定夹具（至少 1 命中才算红样本通过）
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

// ── 白名单（来源见文件头注释；改 schema 消费点时同步这里）──
const PAGE_KEYS = new Set([
  'version', 'pageType', 'title', 'elements', 'notes', 'groups', 'expectedOverlaps',
  'background', 'blocks', 'contrastExempt', 'expectedOutOfSafeArea', 'overlapMode',
  'rowBounds', 'safeArea', 'source',
])
const EL_COMMON = new Set([
  'elementId', 'elementType', 'bounds', 'role', 'roleReason', 'contains', 'badgeOf',
  'expectedOverlaps', 'rotation',
])
const EL_BY_TYPE = {
  text: ['content'],
  shape: ['kind', 'fill', 'line', 'path'],
  line: ['points', 'arrow', 'line', 'attach', 'dash'],
  image: ['src', 'fit'],
  table: ['cols', 'rows', 'header'],
  chart: ['chart'],
}
const elAllowed = (type) => new Set([...EL_COMMON, ...(EL_BY_TYPE[type] ?? [])])

// ── 收集待检 YAML ──
const collect = (dir) => {
  const out = []
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (/preview$|\.tmp/.test(p)) continue
      if (e.isDirectory()) rec(p)
      else if (/^pages?\/.*\.ya?ml$|pages\/.*\.ya?ml$/.test(p.replace(/\\/g, '/')) || /\.ya?ml$/.test(e.name)) out.push(p)
    }
  }
  rec(dir)
  return out.filter((p) => !/deck\.ya?ml$/.test(p)) // deck.yaml 是 deck 级（另有 schema 校验）
}

// ── 极简 YAML 顶层/元素键扫描（只认结构，不做完整解析）──
const scanPage = (file) => {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const found = []
  let inElements = false
  let curEl = null
  const flushEl = () => {
    if (!curEl) return
    const allowed = elAllowed(curEl.type)
    for (const k of Object.keys(curEl.keys)) if (!allowed.has(k)) found.push({ scope: '元素 ' + (curEl.id ?? '?'), key: k })
    curEl = null
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim() || /^\s*#/.test(line)) continue
    const top = line.match(/^([A-Za-z_][\w]*):/)
    if (top) {
      if (top[1] === 'elements') { inElements = true; continue }
      if (!PAGE_KEYS.has(top[1])) found.push({ scope: '页面', key: top[1] })
      continue
    }
    if (!inElements) continue
    const elStart = line.match(/^ {2}- elementId:\s*(\S+)/)
    if (elStart) { flushEl(); curEl = { id: elStart[1].replace(/['"]/g, ''), type: null, keys: {} }; continue }
    if (!curEl) continue
    const kv = line.match(/^ {4}([A-Za-z_][\w]*):\s*(.*)$/)
    if (!kv) continue
    const [, k, v] = kv
    if (k === 'elementType') curEl.type = v.trim().replace(/['"]/g, '')
    else curEl.keys[k] = true
  }
  flushEl()
  return found
}

// ── 主流程 ──
const args = process.argv.slice(2)
const fixtureIdx = args.indexOf('--fixture')
const targets = fixtureIdx >= 0 ? [join(ROOT, args[fixtureIdx + 1])] : [join(ROOT, 'examples', 'hand-drawn'), join(ROOT, 'examples', 'smoke')]
const hits = []
for (const t of targets) {
  if (!existsSync(t)) continue
  for (const f of collect(t)) for (const h of scanPage(f)) hits.push({ file: f.replace(ROOT + '/', ''), ...h })
}
if (fixtureIdx >= 0) {
  console.log('unknown-key 红样本：[fixture] 命中 ' + hits.length + ' 处' + (hits.length > 0 ? ' ✓' : ' ✗'))
  for (const h of hits) console.log('   [警告][unknown-key] ' + h.file + ' — ' + h.scope + ' 出现未知键 "' + h.key + '"')
  process.exit(hits.length > 0 ? 0 : 1)
}
console.log('unknown-key 零误报自证：扫 ' + targets.length + ' 个目录｜未知键 ' + hits.length + ' 处')
for (const h of hits.slice(0, 12)) console.log('   · ' + h.file + ' ' + h.scope + ' → ' + h.key)
if (hits.length) {
  console.log('✗ 本仓示例出现未知键 ⇒ 要么页面写错（应修页面），要么白名单漏了合法键（应补白名单）——两者都必须处理')
  process.exit(1)
}
console.log('✓ 本仓示例 0 未知键（白名单与真实用法一致）')
