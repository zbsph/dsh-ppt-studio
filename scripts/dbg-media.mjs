import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyDeck } from '../lib/verify.js'

// 开发调试脚本（不在发布 files）；layout 路径经环境变量兜底，避免机器绑定
const layout = process.env.DBG_LAYOUT ?? 'D:/SharkCode/dsh-ppt-studio/examples/overlap-smoke/preview/layout.json'
const l = JSON.parse(await readFile(layout, 'utf8'))
console.log(JSON.stringify(l.pages[0].elements.map((e) => ({ id: e.id, kind: e.kind, role: e.role, b: e.bounds })), null, 1))
const v = verifyDeck(l)
console.log(v.text)
