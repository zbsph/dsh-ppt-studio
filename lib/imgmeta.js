/**
 * 图片元数据：从文件头读宽高/格式（无需视觉模型；任何环境可用）。
 * 支持 PNG / JPEG / GIF / WebP。
 */

export function imageInfo(file) {
  const head = file.subarray(0, 64)
  if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return { format: 'png', width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  }
  if (head.length >= 10 && head[0] === 0xff && head[1] === 0xd8) {
    return jpegSize(file)
  }
  if (head.length >= 10 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
    return { format: 'gif', width: head.readUInt16LE(6), height: head.readUInt16LE(8) }
  }
  if (head.length >= 30 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) {
    if (head.subarray(8, 12).toString() === 'WEBP') return webpSize(file)
  }
  return { format: 'unknown', width: 0, height: 0 }
}

function jpegSize(file) {
  let p = 2
  while (p + 9 < file.length) {
    if (file[p] !== 0xff) { p++; continue }
    const marker = file[p + 1]
    if (marker >= 0xc0 && marker <= 0xc3 || marker >= 0xc5 && marker <= 0xc7 || marker >= 0xc9 && marker <= 0xcb || marker >= 0xcd && marker <= 0xcf) {
      return { format: 'jpeg', width: file.readUInt16BE(p + 7), height: file.readUInt16BE(p + 5) }
    }
    const len = file.readUInt16BE(p + 2)
    p += 2 + len
  }
  return { format: 'jpeg', width: 0, height: 0 }
}

function webpSize(file) {
  const kind = file.subarray(12, 16).toString()
  if (kind === 'VP8 ') {
    return { format: 'webp', width: file.readUInt16LE(26) & 0x3fff, height: file.readUInt16LE(28) & 0x3fff }
  }
  if (kind === 'VP8L') {
    const b = file.subarray(20, 25)
    const bits = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24) | (b[4] << 32)
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (kind === 'VP8X') {
    return {
      format: 'webp',
      width: 1 + (file[24] | (file[25] << 8) | (file[26] << 16)),
      height: 1 + (file[27] | (file[28] << 8) | (file[29] << 16)),
    }
  }
  return { format: 'webp', width: 0, height: 0 }
}
