/**
 * 导入版模板逐页截图（保真对照用）：render 模板工程 → Edge 逐页 1920×1080 PNG。
 * 输出 fidelity/imp/<id>/NN.png；渲染临时目录 _imp-tmp 用后即删。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
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

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['实用毕业设计论文答辩ppt模板', '极简实用部门工作总结ppt模板', '深蓝质感论文答辩ppt模板', '简约商务']
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
