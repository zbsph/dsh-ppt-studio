/**
 * A3/A9 修复（反馈二 ★★）：保真交付——"在原件上只换一页、其余页逐字节不动"。
 *
 * `spliceIntoSource`：把 deck 的某一页（pptd 导出单页）替换进 source.pptx 的指定页，
 *   保留源母版/布局（横幅/页脚原样）、保留该页 notes 关系；其余条目逐字节不变（SHA256 自证）。
 *   2026-10-23 修复（用户反馈 P0-1）：按导出页的 **rels 全量**搬运部件（图片/图表/内嵌工作簿/外链），
 *   不再只搬图片——含原生图表的页替换后曾因 OPC 关系不闭包导致 PowerPoint 报 0x80070570"文件损坏"。
 * `sliceSource`：从（已 splice 或任意）source.pptx 修剪出"单页 + 完整母版/布局/主题"的独立文件
 *   （等价演示的"单页版"：sldIdLst 只留 1 条、其余幻灯/备注/关系/Override 删除）。
 *
 * 实现事实：元组手术用自研 zipRead/zipWrite（deflate 重写，Office 可读）+ 正则处理
 * presentation.xml / rels / [Content_Types].xml —— 与测试会话手工 PowerShell 手术的程序化等价物。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
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

/** 从 PART 路径推导它的 rels 部件路径（ppt/charts/chart1.xml → ppt/charts/_rels/chart1.xml.rels）。 */
function relsKeyOf(part) {
  const i = part.lastIndexOf('/')
  return part.slice(0, i + 1) + '_rels/' + part.slice(i + 1) + '.rels'
}

/** 把 rels 里的相对 Target 解析成包内部件路径（基于引用方所在目录）。 */
function resolvePartTarget(basePart, target) {
  const baseDir = basePart.slice(0, basePart.lastIndexOf('/'))
  const out = []
  for (const seg of (baseDir + '/' + target).split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/** 解析 .rels XML → [{ id, type, target, external }]（属性顺序无关）。 */
function parseRels(xml) {
  const out = []
  for (const m of String(xml).matchAll(/<Relationship\b([^>]*?)\/>/g)) {
    const a = m[1]
    const id = /Id="([^"]+)"/.exec(a)?.[1]
    const type = /Type="([^"]+)"/.exec(a)?.[1]
    const target = /Target="([^"]+)"/.exec(a)?.[1]
    const external = /TargetMode="External"/.test(a)
    if (id && type && target) out.push({ id, type, target, external })
  }
  return out
}

/** 两部件之间的相对 Target（用于写回 rels）。 */
function relativeTarget(fromPart, toPart) {
  const from = fromPart.split('/').slice(0, -1)
  const to = toPart.split('/')
  let i = 0
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++
  return [...Array(from.length - i).fill('..'), ...to.slice(i)].join('/')
}

/** 把 slide XML 里某个旧 rId 的全部引用改成新 rId（r:id / r:embed / r:link）。 */
function rewriteRid(xml, oldId, newId) {
  return String(xml)
    .replaceAll(`r:id="${oldId}"`, `r:id="${newId}"`)
    .replaceAll(`r:embed="${oldId}"`, `r:embed="${newId}"`)
    .replaceAll(`r:link="${oldId}"`, `r:link="${newId}"`)
}

/** 部件 → 包内必需的 ContentType（Override 级）或 null（走 Default 扩展名规则）。 */
function contentTypeOf(part) {
  if (/^ppt\/charts\/[^/]+\.xml$/i.test(part)) return 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
  if (/^ppt\/embeddings\/[^/]+\.xlsx$/i.test(part)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  return null
}

/**
 * 从 deck 导出第 page 张（1 基）幻灯的 XML + **全部关系部件**（P0-1 修复）。
 *
 * 旧实现只收集 `Type=".../image"` 的关系，于是含图表的页被替换后 slide XML 仍引用 rId3/rId4，
 * 但包里既没有 chart 部件也没有关系 → OPC 结构不闭包，PowerPoint 报 0x80070570"文件损坏"，
 * 而工具仍返回成功。现在按 rels 全量收集（排除 slideLayout / notesSlide：这两类由源稿自己持有），
 * 图表部件再递归收集它自己的 rels（chart → 内嵌 xlsx）。
 */
export async function deckSlideBundle(deckDir, page) {
  const ctx = await resolveDeck(deckDir)
  if (page < 1 || page > ctx.pages.length) throw new Error(`deck 页号越界：${page}（共 ${ctx.pages.length} 页）`)
  const tmp = join(tmpdir(), `dsh-ppt-splice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(tmp, { recursive: true })
  try {
    const r = await exportPptx(ctx, { out: join(tmp, 'deck.pptx'), engine: 'pptd' })
    const z = zipRead(await readFile(r.file))
    const slidePart = `ppt/slides/slide${page}.xml`
    const slideXml = z.get(slidePart)
    if (!slideXml) throw new Error(`导出产物缺少第 ${page} 张 slide XML（导出异常）`)
    const relsXml = decodeXml(z.get(relsKeyOf(slidePart)) ?? '')
    const parts = []
    const missing = []
    for (const rel of parseRels(relsXml)) {
      if (/\/(slideLayout|notesSlide)$/.test(rel.type)) continue
      if (rel.external) {
        parts.push({ kind: 'external', id: rel.id, type: rel.type, target: rel.target })
        continue
      }
      const part = resolvePartTarget(slidePart, rel.target)
      const data = z.get(part)
      if (!data) { missing.push(part); continue }
      const node = { kind: 'part', id: rel.id, type: rel.type, part, data: Buffer.from(data), nested: [] }
      const np = relsKeyOf(part)
      if (z.has(np)) {
        node.relsXml = decodeXml(z.get(np))
        for (const nr of parseRels(node.relsXml)) {
          if (nr.external) { node.nested.push({ kind: 'external', id: nr.id, type: nr.type, target: nr.target }); continue }
          const npart = resolvePartTarget(part, nr.target)
          const ndata = z.get(npart)
          if (!ndata) { missing.push(npart); continue }
          node.nested.push({ kind: 'part', id: nr.id, type: nr.type, part: npart, data: Buffer.from(ndata) })
        }
      }
      parts.push(node)
    }
    return { slideXml: decodeXml(slideXml), parts, missing, count: ctx.pages.length }
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
 * P0-1 闭包自证（2026-10-23 用户反馈）：slide XML 的每个 `r:*` 引用都能在 rels 里找到，
 * 且每个**非外部**关系的 Target 都能在包内解析到真实部件。
 * 为什么不能省：这类损坏**只**在真 PowerPoint 打开时暴露（工具此前返回成功），
 * 而"能写出文件"不等于"OPC 关系闭包"——见问题单 P0-1（含图表页 → 0x80070570）。
 */
function closureOfSlide(slideKey, slideXml, relsXml, keys) {
  const keySet = new Set(keys)
  const rels = new Map()
  for (const m of String(relsXml).matchAll(/<Relationship\b([^>]*?)\/>/g)) {
    const a = m[1]
    const id = /Id="([^"]+)"/.exec(a)?.[1]
    if (!id) continue
    rels.set(id, { target: /Target="([^"]+)"/.exec(a)?.[1], external: /TargetMode="External"/.test(a) })
  }
  const refs = [...new Set([...String(slideXml).matchAll(/r:(?:id|embed|link)="([^"]+)"/g)].map((m) => m[1]))]
  const danglingRefs = refs.filter((id) => !rels.has(id))
  const danglingTargets = []
  for (const [id, r] of rels) {
    if (r.external || !r.target) continue
    let p = resolvePartTarget(slideKey, r.target)
    if (!keySet.has(p)) {
      try {
        const dec = resolvePartTarget(slideKey, decodeURIComponent(r.target))
        if (keySet.has(dec)) p = dec
      } catch { /* percent-decode 失败按原样判 */ }
    }
    if (!keySet.has(p)) danglingTargets.push(`${id}→${r.target}`)
  }
  return { refs: refs.length, danglingRefs, danglingTargets, ok: danglingRefs.length === 0 && danglingTargets.length === 0 }
}

/**
 * 把 deck 第 deckPage 页替换进 source.pptx 的第 sourcePage 页。
 * @returns { out, sourcePages, deckPages, replaced, unchangedCount, changed, mediaAdded, partsAdded, mediaReused, notesKept, relsClosed }
 */
export async function spliceIntoSource({ deckDir, source, page, sourcePage = page, out }) {
  const zbuf = await readFile(source)
  const z = zipRead(zbuf)
  const src = locateSourceSlide(z, sourcePage)
  const bundle = await deckSlideBundle(deckDir, page)
  // P0-1 闭包前提：导出页引用的每个部件都必须在导出包里真实存在。缺一个就会写出
  // "slide XML 引用 rId、包里没有部件"的坏文件（PowerPoint 0x80070570）——宁可失败，不出坏产物。
  if (bundle.missing?.length) {
    throw new Error(`导出页有 ${bundle.missing.length} 个关系部件在导出包里缺失（${bundle.missing.slice(0, 5).join('、')}）——拒绝生成 OPC 关系不闭包的文件`)
  }

  // 关系改号：把导出页的**全部**关系搬过来。
  // 旧实现只搬 `Type=.../image`，含图表的页替换后 slide XML 仍引用 rId3/rId4，
  // 而包里没有 chart 部件也没有对应关系 ⇒ OPC 不闭包 ⇒ PowerPoint 报 0x80070570（P0-1）。
  if (!src.slideRels) throw new Error(`源幻灯 ${src.slideKey} 无关系文件（异常结构）——无法安全替换，请人工处理`)
  const base = maxRelId(src.slideRels)
  let rewritten = bundle.slideXml
  const addedRels = []
  const mediaNames = []
  const isImage = (p) => p.kind === 'part' && /\/image$/.test(p.type)
  const imageParts = bundle.parts.filter(isImage)
  const otherParts = bundle.parts.filter((p) => !isImage(p))
  imageParts.forEach((m, i) => {
    const newId = `rId${base + 1 + i}`
    rewritten = rewriteRid(rewritten, m.id, newId)
    const name = m.part.split('/').pop()
    mediaNames.push(name)
    addedRels.push(`    <Relationship Id="${newId}" Type="${m.type}" Target="../media/${name}"/>`)
  })

  // 媒体：同名已存在 → 复用源条目（零改动）；否则新增（数据来自导出包/deck media/占位图）
  const partsToAdd = []
  let mediaReused = 0
  const seenCts = new Set((decodeXml(z.get('[Content_Types].xml') ?? '') ?? '').match(/<Default\s+[^>]*Extension="([^"]+)"/g)?.map((s) => s.match(/Extension="([^"]+)"/)[1].toLowerCase()) ?? [])
  let newCt = z.has('[Content_Types].xml') ? decodeXml(z.get('[Content_Types].xml')) : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  let ctChanged = false
  for (const name of mediaNames) {
    const key = 'ppt/media/' + name
    if (z.has(key)) { mediaReused++; continue }
    const hit = imageParts.find((m) => m.part.split('/').pop() === name)
    partsToAdd.push([key, hit?.data ?? TINY_PNG])
    const ext = (name.split('.').pop() ?? '').toLowerCase()
    if (ext && !seenCts.has(ext)) {
      const ct = ext === 'png' ? 'image/png' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'emf' ? 'image/x-emf' : 'application/octet-stream'
      newCt = newCt.replace(/<\/Types>\s*$/, `<Default Extension="${ext}" ContentType="${ct}"/>\n</Types>`)
      seenCts.add(ext)
      ctChanged = true
    }
  }

  // P0-1：其余部件（图表 / 内嵌工作簿 / 其它外链）连同它们的二级 rels 一起搬进源包，
  // 并按源包已有名字避让重命名（chart1.xml 在源包里可能已存在）。
  const used = new Set(z.keys())
  const alloc = (preferred) => {
    const i = preferred.lastIndexOf('.')
    const stem = i > 0 ? preferred.slice(0, i) : preferred
    const ext = i > 0 ? preferred.slice(i) : ''
    let name = preferred
    let n = 2
    // 同时避让"部件名"与"它自己的 .rels 部件名"（源包里可能残留同名 rels）
    while (used.has(name) || used.has(relsKeyOf(name))) name = `${stem}-splice${n++}${ext}`
    used.add(name)
    used.add(relsKeyOf(name))
    return name
  }
  const addOverride = (part, ct) => {
    const pn = '/' + part
    if (String(newCt).includes(`PartName="${pn}"`)) return
    newCt = newCt.replace(/<\/Types>\s*$/, `<Override PartName="${pn}" ContentType="${ct}"/>\n</Types>`)
    ctChanged = true
  }
  let extraRid = base + imageParts.length
  for (const node of otherParts) {
    extraRid++
    const id = `rId${extraRid}`
    if (node.kind === 'external') {
      addedRels.push(`    <Relationship Id="${id}" Type="${node.type}" Target="${node.target}" TargetMode="External"/>`)
      rewritten = rewriteRid(rewritten, node.id, id)
      continue
    }
    const part = alloc(node.part)
    partsToAdd.push([part, node.data])
    const ct = contentTypeOf(part)
    if (ct) addOverride(part, ct)
    if (node.relsXml) {
      const nested = []
      for (const child of node.nested) {
        if (child.kind === 'external') {
          nested.push(`<Relationship Id="${child.id}" Type="${child.type}" Target="${child.target}" TargetMode="External"/>`)
          continue
        }
        const cpart = alloc(child.part)
        partsToAdd.push([cpart, child.data])
        const cct = contentTypeOf(cpart)
        if (cct) addOverride(cpart, cct)
        nested.push(`<Relationship Id="${child.id}" Type="${child.type}" Target="${relativeTarget(part, cpart)}"/>`)
      }
      partsToAdd.push([relsKeyOf(part), '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + nested.join('') + '</Relationships>'])
    }
    addedRels.push(`    <Relationship Id="${id}" Type="${node.type}" Target="${relativeTarget(src.slideKey, part)}"/>`)
    rewritten = rewriteRid(rewritten, node.id, id)
  }
  // 源幻灯 rels 原样保留（布局/备注等）；新增关系追加尾部
  const newRels = src.slideRels.replace(/<\/Relationships>\s*$/, addedRels.join('\n') + '\n</Relationships>')

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

  // P0-1 自证：先验 OPC 闭包再落盘——不闭包就拒绝写坏文件（含图表页曾因只搬图片而 0x80070570）。
  const closure = closureOfSlide(src.slideKey, rewritten, newRels, Object.keys(entries))
  if (!closure.ok) {
    throw new Error(`替换后 OPC 关系不闭包（悬空引用 ${closure.danglingRefs.length} / 悬空部件 ${closure.danglingTargets.length}）：${[...closure.danglingRefs, ...closure.danglingTargets].slice(0, 5).join('、')}——拒绝写出损坏文件`)
  }

  // 输出路径：绝对路径原样；相对路径相对 **deck 工作区目录**（与 ppt_export 的 out 语义同构，
  // 2026-10-23 用户反馈 P1 修复：旧实现把相对路径丢给 writeFile ⇒ 落到宿主进程 cwd（可能是 harness/profile 目录））。
  const outPath = out ? (isAbsolute(out) ? out : join(deckDir, out)) : source.replace(/\.pptx$/i, '-spliced.pptx')
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
    changed: [...changedKeys, ...(ctChanged ? ['[Content_Types].xml' + '（类型声明更新）'] : []), ...partsToAdd.map(([k]) => k + '（新增）')],
    mediaAdded: partsToAdd.filter(([k]) => k.startsWith('ppt/media/')).length,
    partsAdded: partsToAdd.length,
    mediaReused,
    notesKept,
    relsClosed: closure.ok,
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
  // 输出路径：绝对路径原样；相对路径相对**源 .pptx 所在目录**（用户视角"我的原稿旁边"）。
  const outPath = out ? (isAbsolute(out) ? out : join(dirname(source), out)) : source.replace(/\.pptx$/i, '-single.pptx')
  await writeFile(outPath, zipWrite(entries))
  return {
    out: outPath, page,
    layouts: [...z.keys()].filter((k) => k.startsWith('ppt/slideLayouts/')).length,
    masters: [...z.keys()].filter((k) => k.startsWith('ppt/slideMasters/')).length,
    entries: Object.keys(entries).length,
  }
}
