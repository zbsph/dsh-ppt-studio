/**
 * 导入版模板逐页截图（保真对照用）：render 模板工程 → Edge 逐页 1920×1080 PNG。
 * 输出 fidelity/imp/<id>/NN.png；渲染临时目录 _imp-tmp 用后即删。
 * 用法：node scripts/shot-templates.mjs [id...]（缺省 = **模板库里现有的全部模板**）
 *   【2026-09-18】此前默认硬编码 4 套"导入版"模板 id；那 4 套已从随包发行物移除
 *   （46.2 MB → 0.13 MB，见 docs/03 的 1.0.4 记录），硬编码 id 会立刻失效 ⇒ 改为动态列举。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { rm, mkdir } from 'node:fs/promises'
import { resolveDeck } from '../lib/pptd/schema.js'
import { renderDeck } from '../lib/pptd/render-html.js'
import { TEMPLATES_DIR, templateWorkspace } from '../lib/templates.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(process.env.FIDELITY_OUT ?? join(process.env.USERPROFILE ?? '', '.dsh', 'ppt-studio', 'fidelity'), 'imp')
const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p))

const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (existsSync(TEMPLATES_DIR) ? readdirSync(TEMPLATES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [])
for (const id of ids) {
  const t = await templateWorkspace(id)
  const dir = t.dir
  const ctx = await resolveDeck(dir)
  const r = await renderDeck(ctx, { out: '_imp-tmp' })
  const outDir = join(OUT, id)
  await mkdir(outDir, { recursive: true })
  let ok = 0
  for (let i = 0; i < r.htmlFiles.length; i++) {
    const url = 'file:///' + join(dir, '_imp-tmp', r.htmlFiles[i]).replace(/\\/g, '/')
    const outPng = join(outDir, `${String(i + 1).padStart(2, '0')}.png`)
    await new Promise((resolve, reject) => {
      const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=2',
        `--window-size=${ctx.size.width},${ctx.size.height}`, `--screenshot=${outPng}`, url], { stdio: 'ignore', windowsHide: true })
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Edge ${code}`)))
      child.on('error', reject)
    })
    ok++
  }
  await rm(join(dir, '_imp-tmp'), { recursive: true, force: true })
  console.log(`${id}: ${ok} png → ${outDir}`)
}
console.log('DONE')
