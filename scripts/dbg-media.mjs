import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyDeck } from '../lib/verify.js'

const l = JSON.parse(await readFile('D:/SharkCode/dsh-ppt-studio/examples/overlap-smoke/preview/layout.json', 'utf8'))
console.log(JSON.stringify(l.pages[0].elements.map((e) => ({ id: e.id, kind: e.kind, role: e.role, b: e.bounds })), null, 1))
const v = verifyDeck(l)
console.log(v.text)
