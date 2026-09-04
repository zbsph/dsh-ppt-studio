/**
 * 极简 ZIP（OOXML）读写：store/deflate 双向，基于 Node 内置 zlib。
 * 写入用 deflate（PowerPoint 可读）；读取同时支持 store 与 deflate。
 */

import zlib from 'node:zlib'

// ── CRC32 ────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u16(v) { return Buffer.from([v & 0xff, (v >>> 8) & 0xff]) }
function u32(v) { return Buffer.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]) }

/**
 * 写入 ZIP：entries = { name: Buffer|string }
 */
export function zipWrite(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const comp = zlib.deflateRawSync(data)
    const crc = crc32(data)
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(0), u16(0),
      u32(crc), u32(comp.length), u32(data.length), u16(nameBuf.length), u16(0),
      nameBuf, comp,
    ])
    locals.push(local)
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(0), u16(0),
      u32(crc), u32(comp.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBuf,
    ]))
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(Object.keys(entries).length), u16(Object.keys(entries).length),
    u32(central.length), u32(offset), u16(0),
  ])
  return Buffer.concat([...locals, central, eocd])
}

/** 读取 ZIP（支持 store/deflate；仅处理我们关心的条目）。返回 Map<name, Buffer> */
export function zipRead(buf) {
  const out = new Map()
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('not a zip file (no EOCD)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16) // central dir offset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const compMethod = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    const lnameLen = buf.readUInt16LE(localOff + 26)
    const lextraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lnameLen + lextraLen
    const data = buf.subarray(dataStart, dataStart + compSize)
    out.set(name, compMethod === 0 ? data : zlib.inflateRawSync(data))
  }
  return out
}

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

/** OOXML part 解码：兼容 UTF-16（WPS 常见）与 UTF-8 带/不带 BOM。 */
export function decodeXml(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8').slice(1)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const s = buf.toString('utf16le').slice(1).split('')
    const swapped = []
    for (let i = 0; i + 1 < s.length; i += 2) {
      swapped.push(s[i + 1])
      swapped.push(s[i])
    }
    return swapped.join('')
  }
  return buf.toString('utf8')
}

/** OOXML 命名空间常量（用于 pptx 生成/解析） */
export const NS = {
  o: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
}
