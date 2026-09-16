/**
 * A3/A9 修复（反馈二 ★★）：保真交付——"在原件上只换一页、其余页逐字节不动"。
 *
 * `spliceIntoSource`：把 deck 的某一页（pptd 导出单页）替换进 source.pptx 的指定页，
 *   保留源母版/布局（横幅/页脚原样）、保留该页 notes 关系、媒体合并；其余条目逐字节不变（SHA256 自证）。
 * `sliceSource`：从（已 splice 或任意）source.pptx 修剪出"单页 + 完整母版/布局/主题"的独立文件
 *   （等价演示的"单页版"：sldIdLst 只留 1 条、其余幻灯/备注/关系/Override 删除）。
 *
 * 实现事实：元组手术用自研 zipRead/zipWrite（deflate 重写，Office 可读）+ 正则处理
 * presentation.xml / rels / [Content_Types].xml —— 与测试会话手工 PowerShell 手术的程序化等价物。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import crypto from 'node:crypto'
import { zipRead, zipWrite, decodeXml } from './zips.js'
import { resolveDeck } from './pptd/schema.js'
import { exportPptx } from './pptd/export-pptx.js'

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }

/** zip 条目逐条目 SHA256 摘要（返回 Map<name, hash>）。 */
export function zipDigests(buf) {
  const out = new Map()
  for (const [name, data] of zipRead(buf)) out.set(name, sha256(data))
  return out
}

/** 从 deck 导出第 page 张（1 基）幻灯的 XML + 媒体包。 */
export async function deckSlideBundle(deckDir, page) {
  const ctx = await resolveDeck(deckDir)
  if (page < 1 || page > ctx.pages.length) throw new Error(`deck 页号越界：${page}（共 ${ctx.pages.length} 页）`)
  const tmp = join(tmpdir(), `dsh-ppt-splice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(tmp, { recursive: true })
  try {
    const r = await exportPptx(ctx, { out: join(tmp, 'deck.pptx'), engine: 'pptd' })
    const z = zipRead(await readFile(r.file))
    const slideXml = z.get(`ppt/slides/slide${page}.xml`)
    const slideRels = z.get(`ppt/slides/_rels/slide${page}.xml.rels`)
    if (!slideXml) throw new Error(`导出产物缺少第 ${page} 张 slide XML（导出异常）`)
    const relText = decodeXml(slideRels ?? '')
    const media = []
    for (const m of relText.matchAll(/Id="(rId\d+)"[^>]*Type="[^"]*\/image"[^>]*Target="\.\.\/media\/([^"]+)"/g)) {
      const name = decodeURIComponent(m[2])
      let data = z.get('ppt/media/' + name)
      if (!data) {
        const dfile = join(deckDir, 'media', name)
        if (existsSync(dfile)) data = await readFile(dfile)
      }
      media.push({ rId: m[1], name, data: data ?? TINY_PNG })
    }
    return { slideXml: decodeXml(slideXml), media, count: ctx.pages.length }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** 定位 source.pptx 第 page 页（1 基）的 slide 键（含 'ppt/' 前缀）。 */
export function locateSourceSlide(z, page) {
  const pres = decodeXml(z.get('ppt/presentation.xml'))
  const relsText = decodeXml(z.get('ppt/_rels/presentation.xml.rels'))
  const rIds = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => m[1])
  if (page < 1 || page > rIds.length) throw new Error(`source 页号越界：${page}（共 ${rIds.length} 页）`)
  const rid = rIds[page - 1]
  const rel = new Map()
  for (const m of relsText.matchAll(/<Relationship\s+Id="([^"]+)"\s+Type="([^"]+)"\s+Target="([^"]+)"/g)) rel.set(m[1], { type: m[2], target: m[3] })
  const r = rel.get(rid)
  const target = (r?.target ?? '').replace(/^(\.\.\/)+/, '').replace(/^ppt\//, '')
  if (!r || !/^slides\/slide\d+\.xml$/.test(target)) throw new Error(`source 第 ${page} 页关系解析失败（${rid} → ${r?.target ?? '?'}）`)
  const slideName = target.split('/').pop()
  const slideRelsKey = `ppt/slides/_rels/${slideName}.rels`
  const slideRels = z.has(slideRelsKey) ? decodeXml(z.get(slideRelsKey)) : null
  return { slide: target, slideKey: 'ppt/' + target, slideRelsKey, slideRels, rid, rIds }
}

function maxRelId(relsXml) {
  let max = 0
  for (const m of relsXml.matchAll(/rId(\d+)/g)) max = Math.max(max, Number(m[1]))
  return max
}

/**
 * 把 deck 第 deckPage 页替换进 source.pptx 的第 sourcePage 页。
 * @returns { out, sourcePages, deckPages, replaced, unchangedCount, changed, mediaAdded, mediaReused, notesKept }
 */
export async function spliceIntoSource({ deckDir, source, page, sourcePage = page, out }) {
  const zbuf = await readFile(source)
  const z = zipRead(zbuf)
  const src = locateSourceSlide(z, sourcePage)
  const bundle = await deckSlideBundle(deckDir, page)

  // 新 XML：媒体 rId 改号（与源幻灯 rels 现有 id 无冲突）
  if (!src.slideRels) throw new Error(`源幻灯 ${src.slideKey} 无关系文件（异常结构）——无法安全替换，请人工处理`)
  const base = maxRelId(src.slideRels)
  let rewritten = bundle.slideXml
  const mediaRels = []
  const mediaNames = []
  bundle.media.forEach((m, i) => {
    const newId = `rId${base + 1 + i}`
    rewritten = rewritten.replaceAll(`r:embed="${m.rId}"`, `r:embed="${newId}"`).replaceAll(`r:link="${m.rId}"`, `r:link="${newId}"`)
    mediaNames.push(m.name)
    mediaRels.push(`    <Relationship Id="${newId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${m.name}"/>`)
  })
  // 源幻灯 rels 原样保留（布局/备注等）；媒体关系追加尾部
  const newRels = src.slideRels.replace(/<\/Relationships>\s*$/, mediaRels.join('\n') + '\n</Relationships>')

  // 媒体：同名已存在 → 复用源条目（零改动）；否则新增（数据来自导出包/deck media/占位图）
  const partsToAdd = []
  let mediaReused = 0
  const seenCts = new Set((decodeXml(z.get('[Content_Types].xml') ?? '') ?? '').match(/<Default\s+[^>]*Extension="([^"]+)"/g)?.map((s) => s.match(/Extension="([^"]+)"/)[1].toLowerCase()) ?? [])
  let newCt = z.has('[Content_Types].xml') ? decodeXml(z.get('[Content_Types].xml')) : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  let ctChanged = false
  for (const name of mediaNames) {
    const key = 'ppt/media/' + name
    if (z.has(key)) { mediaReused++; continue }
    const hit = bundle.media.find((m) => m.name === name)
    partsToAdd.push([key, hit?.data ?? TINY_PNG])
    const ext = (name.split('.').pop() ?? '').toLowerCase()
    if (ext && !seenCts.has(ext)) {
      const ct = ext === 'png' ? 'image/png' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'emf' ? 'image/x-emf' : 'application/octet-stream'
      newCt = newCt.replace(/<\/Types>\s*$/, `<Default Extension="${ext}" ContentType="${ct}"/>\n</Types>`)
      seenCts.add(ext)
      ctChanged = true
    }
  }

  // entries 重建：保持源顺序，替换目标 slide/rels，追加新增媒体，必要时更新 Content_Types
  const relsKey = src.slideRelsKey
  const entries = {}
  for (const [name, data] of z) {
    if (name === src.slideKey) { entries[name] = Buffer.from(rewritten, 'utf8'); continue }
    if (name === relsKey) { entries[name] = Buffer.from(newRels, 'utf8'); continue }
    if (ctChanged && name === '[Content_Types].xml') { entries[name] = Buffer.from(newCt, 'utf8'); continue }
    entries[name] = data
  }
  for (const [key, data] of partsToAdd) entries[key] = data

  const outPath = out ?? source.replace(/\.pptx$/i, '-spliced.pptx')
  await writeFile(outPath, zipWrite(entries))

  // 自证：源条目（除 slide/rels/ContentTypes）与输出逐字节一致
  const srcDig = zipDigests(zbuf)
  const outDig = zipDigests(await readFile(outPath))
  const excluded = new Set([src.slideKey, relsKey, '[Content_Types].xml'])
  const changedKeys = [...srcDig.keys()].filter((k) => !excluded.has(k) && srcDig.get(k) !== (outDig.get(k) ?? ''))
  const unchangedCount = [...srcDig.keys()].filter((k) => !excluded.has(k) && srcDig.get(k) === outDig.get(k)).length
  const notesKept = /notesSlide/.test(src.slideRels ?? '')
  return {
    out: outPath, sourcePages: src.rIds.length, deckPages: bundle.count,
    replaced: { slide: src.slideKey, sourcePage, deckPage: page },
    unchangedCount,
    changed: [...changedKeys, ...(ctChanged ? ['[Content_Types].xml' + '（媒体类型新增）'] : []), ...partsToAdd.map(([k]) => k + '（新增）')],
    mediaAdded: partsToAdd.length,
    mediaReused,
    notesKept,
  }
}

/**
 * 单页化：source.pptx（可先 splice）→ "单页 + 完整母版/布局/主题"独立文件。
 * 等价测试会话手工手术：sldIdLst 只留 1 条、其余幻灯/备注/关系/Override 删除、布局母版全保留。
 */
export async function sliceSource({ source, page, out }) {
  const zbuf = await readFile(source)
  const z = zipRead(zbuf)
  const src = locateSourceSlide(z, page)
  const slideKey = src.slideKey
  const slideName = src.slide.split('/').pop()
  const relsKey = `ppt/slides/_rels/${slideName}.rels`
  let notesKey = null
  if (z.has(relsKey)) {
    const rels = decodeXml(z.get(relsKey))
    const m = rels.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)
    if (m) notesKey = 'ppt/notesSlides/' + m[1]
  }
  // presentation.xml：sldIdLst 只留目标页（完整捕获标签含 />，否则替换产物缺闭合 → 文档损坏）
  let pres = decodeXml(z.get('ppt/presentation.xml'))
  const sldIds = [...pres.matchAll(/<p:sldId\b[^>]*?r:id="([^"]+)"\s*\/?>/g)]
  pres = pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, () => {
    const pick = sldIds.find((m) => m[1] === src.rid)
    return `<p:sldIdLst>${pick?.[0] ?? ''}</p:sldIdLst>`
  })
  // presentation.xml.rels：删除非目标页的 slide 关系（layout/master/theme 等保留）
  let presRels = decodeXml(z.get('ppt/_rels/presentation.xml.rels'))
  presRels = presRels.replace(/<Relationship\s+Id="(rId\d+)"\s+Type="[^"]*\/slide"\s+Target="[^"]+"\s*\/>/g, (m0, rid) => (rid === src.rid ? m0 : ''))
  // [Content_Types].xml：删除其他幻灯/备注 Override（保留目标页与其余类型）
  const slideNo = slideName.match(/slide(\d+)\.xml$/)?.[1] ?? ''
  const notesNo = notesKey?.match(/notesSlide(\d+)\.xml$/)?.[1] ?? ''
  let ct = decodeXml(z.get('[Content_Types].xml'))
  ct = ct.replace(/<Override\s+PartName="\/ppt\/slides\/slide\d+\.xml"\s+ContentType="[^"]*"\s*\/>/g, (m0) => m0.includes(`slide${slideNo}.xml`) ? m0 : '')
  ct = ct.replace(/<Override\s+PartName="\/ppt\/notesSlides\/notesSlide\d+\.xml"\s+ContentType="[^"]*"\s*\/>/g, (m0) => (notesNo && m0.includes(`notesSlide${notesNo}.xml`)) ? m0 : '')

  const entries = {}
  for (const [name, data] of z) {
    if (name === 'ppt/presentation.xml') { entries[name] = Buffer.from(pres, 'utf8'); continue }
    if (name === 'ppt/_rels/presentation.xml.rels') { entries[name] = Buffer.from(presRels, 'utf8'); continue }
    if (name === '[Content_Types].xml') { entries[name] = Buffer.from(ct, 'utf8'); continue }
    if (name.startsWith('ppt/slides/')) {
      if (name === slideKey || name === relsKey) entries[name] = data
      continue
    }
    if (name.startsWith('ppt/notesSlides/')) {
      if (notesKey && name === notesKey) entries[name] = data
      continue
    }
    entries[name] = data
  }
  const outPath = out ?? source.replace(/\.pptx$/i, '-single.pptx')
  await writeFile(outPath, zipWrite(entries))
  return {
    out: outPath, page,
    layouts: [...z.keys()].filter((k) => k.startsWith('ppt/slideLayouts/')).length,
    masters: [...z.keys()].filter((k) => k.startsWith('ppt/slideMasters/')).length,
    entries: Object.keys(entries).length,
  }
}
