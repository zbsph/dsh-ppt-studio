#!/usr/bin/env node
/**
 * 并排对照图工具（Z3：让"看图"便宜到必然发生）
 *
 * 用法：
 *   node scripts/visual-pair.mjs --before a.png --after b.png --out o.png \
 *        [--region x,y,w,h]        同一区域（两张图都按它裁，保证同缩放）
 *        [--mark x,y,w,h]          红框标出冲突点（相对裁剪后的坐标）
 *        [--label-before "改前"] [--label-after "改后"]
 *
 * 纪律（本文件同时是规则的载体，见下）：
 *   **先图后数** —— 任何"修好了/做好了"的结论，先读图；数值只作辅助。
 *   **改了引擎必须重出受影响产物并替换到位**，否则视为未完成（图表同源：图必须是"重出后"的产物）。
 *   对照图必须"能一眼判对"：同区域、同缩放、并排、标出冲突点。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const before = arg('before')
const after = arg('after')
const out = arg('out')
if (!before || !after || !out) {
  console.log('用法：node scripts/visual-pair.mjs --before a.png --after b.png --out o.png [--region x,y,w,h] [--mark x,y,w,h]')
  process.exit(2)
}
const region = arg('region')
const mark = arg('mark')
const labelB = arg('label-before', 'BEFORE')
const labelA = arg('label-after', 'AFTER')
const py = process.env.PPTD_PYTHON ?? 'C:\\Users\\11867\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'
if (!existsSync(py)) { console.log(`✗ 找不到 python：${py}（可用 PPTD_PYTHON 指定）`); process.exit(1) }

const script = `
import sys
from PIL import Image, ImageDraw
before, after, out = sys.argv[1], sys.argv[2], sys.argv[3]
region = sys.argv[4]
mark = sys.argv[5]
labelB, labelA = sys.argv[6], sys.argv[7]
b = Image.open(before).convert("RGB")
a = Image.open(after).convert("RGB")
box = tuple(int(v) for v in region.split(",")) if region else None
if box: b = b.crop(box); a = a.crop(box)
W = 1400
b = b.resize((W, max(1, int(b.height * W / b.width))))
a = a.resize((W, max(1, int(a.height * W / a.width))))
bar = 30
out_img = Image.new("RGB", (W, b.height + a.height + bar * 2), "white")
d = ImageDraw.Draw(out_img)
d.text((8, 8), labelB, fill=(180, 0, 0))
out_img.paste(b, (0, bar))
d.text((8, bar + b.height + 6), labelA, fill=(0, 110, 0))
out_img.paste(a, (0, bar * 2 + b.height))
if mark:
    mx, my, mw, mh = (int(v) for v in mark.split(","))
    scale = W / (box[2] if box else Image.open(before).width)
    box2 = (int(mx * scale), bar + int(my * scale), int((mx + mw) * scale), bar + int((my + mh) * scale))
    d.rectangle(box2, outline=(220, 0, 0), width=4)
out_img.save(out)
print(f"saved {out} {out_img.size}")
`
mkdirSync(dirname(resolve(out)), { recursive: true })
const tmp = join(tmpdir(), `visual-pair-${Date.now()}.py`)
writeFileSync(tmp, script)
const r = spawnSync(py, [tmp, resolve(before), resolve(after), resolve(out), region ?? '', mark ?? '', labelB, labelA], { encoding: 'utf8' })
if (r.stdout) process.stdout.write(r.stdout)
if (r.stderr) process.stderr.write(r.stderr)
process.exit(r.status ?? 1)
