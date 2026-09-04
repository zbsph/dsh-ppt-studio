import { zipRead } from '../lib/zips.js'
import { parseXml } from '../lib/xmljs.js'
import { readFile } from 'node:fs/promises'

const buf = await readFile('examples/smoke/out-smoke.pptx')
const files = zipRead(buf)
const xml = files.get('ppt/presentation.xml').toString('utf8')
console.log('xml head:', xml.slice(0, 200))
console.log('xml len:', xml.length)
const pres = parseXml(xml)
const p = pres.children[0]
console.log('root child:', p.tag, 'children:', p.children.length, 'text len:', p.text.length)
if (p.children[0]) console.log('first child:', p.children[0].tag, JSON.stringify(p.children[0].attrs).slice(0, 120))
