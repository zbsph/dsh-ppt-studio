/**
 * 模板库维护脚本：对每套模板的封面页渲染 + 截图 → templates/<id>/preview.png。
 * 规则：模板封面 = deck.yaml 的第一页引用（templates 的模板 deck 引 _cover 为主页）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdir, rm, mkdir, access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TPL_DIR = join(root, 'templates')
const tmp = join(root, 'examples', 'tpl-preview-work')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p))

for (const tpl of (await readdir(TPL_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)) {
  const ws = join(tmp, tpl)
  await rm(ws, { recursive: true, force: true })
  await mkdir(join(ws, 'pages'), { recursive: true })
  const { copyFile } = await import('node:fs/promises')
  await copyFile(join(TPL_DIR, tpl, 'deck.yaml'), join(ws, 'deck.yaml'))
  try {
    // 临时引用全部母版页（模板 deck.yaml 只引用 1-2 页）
    const { templateWorkspace } = await import('../lib/templates.js')
    const tT = await templateWorkspace(tpl)
    const refs = tT.meta.pages ?? []
    const deckTxt = tT.deck.replace(/  - pages\/[^\n]+(?:\n  - pages\/[^\n]+)*/, refs.map((r) => `  - ${r}`).join('\n'))
    await (await import('node:fs/promises')).writeFile(join(ws, 'deck.yaml'), deckTxt)
    for (const p of tT.pages) await copyFile(join(TPL_DIR, tpl, p.ref), join(ws, p.ref))
    const ctx = await resolveDeck(ws)
    const r = await renderDeck(ctx, {})
    // 缩略图 = 第一页（封面）
    const firstHtml = r.htmlFiles[0]
    const outPng = join(TPL_DIR, tpl, 'preview.png')
    if (!edge) { ok(`模板 ${tpl}：无浏览器，跳过截图`, true, '仅渲染检查'); continue }
    const url = 'file:///' + join(ws, 'preview', firstHtml).replace(/\\/g, '/')
    await new Promise((resolve, reject) => {
      const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--window-size=${ctx.size.width},${ctx.size.height}`, `--screenshot=${outPng}`, url], { stdio: 'ignore', windowsHide: true })
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Edge 退出码 ${code}`)))
      child.on('error', reject)
    })
    ok(`模板 ${tpl}：渲染 + 预览图生成`, existsSync(outPng))
  } catch (e) {
    ok(`模板 ${tpl}：渲染/截图`, false, e?.message)
  }
}

await rm(tmp, { recursive: true, force: true })
console.log(`\n==== 模板构建：${pass} 通过 / ${fail} 失败 ====`)
process.exit(fail > 0 ? 1 : 0)
