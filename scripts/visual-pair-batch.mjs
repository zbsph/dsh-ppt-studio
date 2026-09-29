#!/usr/bin/env node
/**
 * 并排对照工具（批量版，等价于被回滚删除的 visual-pair.mjs）—— S4 交付用
 *
 * 用法：
 *   node scripts/visual-pair-batch.mjs --old <旧图目录> --new <新图目录> --out <输出目录> [--width 1400]
 *
 * 配对规则：按文件名开头的两位页号（01..13）配对。
 * 输出：<输出目录>/对比-NN.png —— 上=旧（红字），下=新（绿字），同宽同缩放。
 *
 * 纪律（写进工具，而非只在口头）：
 *   · 先图后数：结论前必须先看渲染图；坐标与门禁数字只作辅助。
 *   · 改了引擎必须重出产物：对照图里的"新"必须来自重出后的 PNG。
 *   · 对照图要能一眼判对：同内容、同缩放、上下并排、标注来源。
 */
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const argv = process.argv.slice(2)
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const oldDir = arg('old')
const newDir = arg('new')
const outDir = arg('out')
const width = Number(arg('width', '1400'))
if (!oldDir || !newDir || !outDir) {
  console.log('用法：node scripts/visual-pair-batch.mjs --old <旧图目录> --new <新图目录> --out <输出目录>')
  process.exit(2)
}
const py = process.env.PPTD_PYTHON ?? 'C:\\Users\\11867\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'
if (!existsSync(py)) { console.log('✗ 找不到 python：' + py); process.exit(1) }

const index = (dir) => {
  const m = new Map()
  for (const f of readdirSync(dir)) {
    const mm = /^(\d{2})/.exec(f)
    if (mm && /\.png$/i.test(f) && !m.has(mm[1])) m.set(mm[1], join(dir, f))
  }
  return m
}
const A = index(oldDir)
const B = index(newDir)
const pairs = [...A.keys()].filter((k) => B.has(k)).sort()
if (!pairs.length) { console.log('✗ 没有可配对的页'); process.exit(1) }
mkdirSync(outDir, { recursive: true })
const listFile = join(tmpdir(), 'visual-pair-list.txt')
writeFileSync(listFile, pairs.map((k) => `${k}\t${A.get(k)}\t${B.get(k)}`).join('\n'), 'utf8')

const pySrc = [
  'import sys',
  'from PIL import Image, ImageDraw',
  "rows = [l.rstrip().split(chr(9)) for l in open(sys.argv[1], encoding='utf-8') if l.strip()]",
  'out_dir = sys.argv[2]',
  'W = int(sys.argv[3])',
  'for code, oldf, newf in rows:',
  '    a = Image.open(oldf).convert("RGB")',
  '    b = Image.open(newf).convert("RGB")',
  '    a = a.resize((W, max(1, int(a.height * W / a.width))))',
  '    b = b.resize((W, max(1, int(b.height * W / b.width))))',
  '    bar = 26',
  '    im = Image.new("RGB", (W, a.height + b.height + bar * 2), "white")',
  '    d = ImageDraw.Draw(im)',
  '    d.text((8, 7), "OLD  " + oldf.replace(chr(92), "/").split("/")[-1], fill=(180, 0, 0))',
  '    im.paste(a, (0, bar))',
  '    d.text((8, bar + a.height + 7), "NEW  " + newf.replace(chr(92), "/").split("/")[-1], fill=(0, 110, 0))',
  '    im.paste(b, (0, bar * 2 + a.height))',
  '    im.save(out_dir + "/对比-" + code + ".png")',
  '    print("对比-" + code + ".png")',
].join('\n')
const pyFile = join(tmpdir(), 'visual-pair-batch.py')
writeFileSync(pyFile, pySrc, 'utf8')
const r = spawnSync(py, [pyFile, listFile, resolve(outDir), String(width)], { encoding: 'utf8' })
process.stdout.write(r.stdout ?? '')
if (r.stderr) process.stderr.write(r.stderr)
console.log(`共 ${pairs.length} 张对照图 → ${outDir}`)
process.exit(r.status ?? 1)
