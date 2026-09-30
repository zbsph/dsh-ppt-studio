#!/usr/bin/env node
/**
 * 可见文本痕迹守卫：仓库里不得残留"已移除的开发期方案"的任何字样（含根目录、templates、agent-presets 等）。
 *
 * 为什么固化成脚本：这条判据此前用的是临时脚本，且一度只扫 6 个目录、还出现过"检查器扫到自己"的假阳性。
 * 允许清单（**唯一**允许出现这些字样之处，且都在代码里作为**禁词表**本身）：
 *   · scripts/check-removed-traces.mjs（本文件）
 *   · scripts/check-package.mjs（打包检查的词表）
 * 用法：node scripts/check-removed-traces.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const TERM = /图族|diagram-families|diagram-ir|FAMILIES|d1_|diagram:|diagram\.style|layoutDiagram|validateDiagram|图编译/
const ALLOW = new Set(['scripts/check-removed-traces.mjs', 'scripts/check-package.mjs'])
const SKIPDIR = /(^|\/)(\.git|node_modules|preview|\.tmp[^/]*)$/
const EXT = /\.(js|mjs|cjs|md|ya?ml|json|txt|yml)$/

const hits = []
const walk = (rel) => {
  for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name
    if (SKIPDIR.test(r)) continue
    if (e.isDirectory()) { walk(r); continue }
    if (!EXT.test(e.name)) continue
    if (ALLOW.has(r)) continue
    const p = join(ROOT, r)
    let t = ''
    try { t = readFileSync(p, 'utf8') } catch { continue }
    t.split('\n').forEach((l, i) => { if (TERM.test(l)) hits.push(r + ':' + (i + 1) + ' ' + l.trim().slice(0, 80)) })
  }
}
walk('')
console.log('可见文本痕迹扫描：命中 ' + hits.length + ' 处' + (hits.length ? '' : ' ✓'))
for (const h of hits.slice(0, 12)) console.log('   · ' + h)
process.exit(hits.length ? 1 : 0)