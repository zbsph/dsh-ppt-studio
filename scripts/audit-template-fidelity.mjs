/**
 * 模板导入保真审计：源 pptx（XML 逐页）vs 导入模板工程（yaml）同口径对比。
 * 输出每套的逐页差异表 + 汇总保真率与主要失真类别，落盘 docs/fidelity-report.md。
 */
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { zipRead, decodeXml } from '../lib/zips.js'
import { parseXml, children, first, allText } from '../lib/xmljs.js'
import { resolveDeck } from '../lib/pptd/schema.js'
import { templateWorkspace } from '../lib/templates.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.argv[2] ?? 'C:/Users/11867/Desktop/ppt模板库'
const SRC_TO_TPL = {
  '实用毕业设计论文答辩PPT模板.pptx': '实用毕业设计论文答辩ppt模板',
  '极简实用部门工作总结PPT模板.pptx': '极简实用部门工作总结ppt模板',
  '深蓝质感论文答辩PPT模板.pptx': '深蓝质感论文答辩ppt模板',
  '简约商务.pptx': '简约商务',
}

const report = []
report.push('# 模板导入保真审计报告（v0.7.1 对照）\n')
report.push(`> 生成时间：${new Date().toISOString()}｜源：${SRC}｜导入版：templates/<id>/\n`)
report.push('## 说明\n- **源计数**：原始 pptx XML（pptx 内部结构，权威）逐页统计；**导入计数**：模板工程 yaml。\n- **保真率** = 导入元素数 / 源形状级元素数（sp/pic/cxnSp/grpSp 内子元素合并为"形状级元素"；grpSp 嵌套子元素计入源侧计数）。\n- 文本保真 = 导入文本字符数 / 源文本字符数（tl 文本 run 汇总；不含表格/图表内文本）。\n')

function slideStats(xmlText) {
  const root0 = parseXml(xmlText)
  const sld = first(root0, 'sld') ?? root0
  const F = (n, t) => (n ? first(n, t) : null)
  const cSld = F(sld, 'cSld')
  const spTree = cSld ? F(cSld, 'spTree') : null
  const st = { sp: 0, pic: 0, cxn: 0, grpChildren: 0, custGeom: 0, grad: 0, ph: 0, cropPic: 0, smartArt: 0, table: 0, chart: 0, textChars: 0, bgImage: false, bgSolid: false }
  const walk = (node, inGroup) => {
    for (const c of node?.children ?? []) {
      if (c.tag === 'sp') {
        st.sp++
        const spPr = F(c, 'spPr')
        if (F(spPr, 'custGeom')) st.custGeom++
        if (F(spPr, 'gradFill')) st.grad++
        const nv = F(c, 'nvSpPr') ?? c
        if (F(nv, 'ph')) st.ph++
        const tx = F(c, 'txBody')
        if (tx) st.textChars += allText(tx).replace(/\s/g, '').length
        if (inGroup) st.grpChildren++
      } else if (c.tag === 'pic') {
        st.pic++
        const blipFill = F(c, 'blipFill')
        if (F(blipFill, 'srcRect')) st.cropPic++
        if (inGroup) st.grpChildren++
      } else if (c.tag === 'cxnSp') {
        st.cxn++
        st.grpChildren += inGroup ? 1 : 0
      } else if (c.tag === 'grpSp') {
        walk(c, true)
      } else if (c.tag === 'graphicFrame') {
        const graphic = F(c, 'graphic')
        const gd = graphic ? F(graphic, 'graphicData') : null
        const uri = gd?.attrs?.uri ?? ''
        if (uri.includes('/table')) st.table++
        else if (uri.includes('diagram')) st.smartArt++
        else st.chart++
      }
    }
  }
  walk(spTree, false)
  const bgPr = F(F(cSld, 'bg'), 'bgPr')
  if (bgPr) {
    if (F(bgPr, 'blipFill')) st.bgImage = true
    if (F(bgPr, 'solidFill')) st.bgSolid = true
  }
  return st
}

async function importedStats(tplId) {
  const t = await templateWorkspace(tplId)
  const ctx = await resolveDeck(t.dir)
  const st = { sp: 0, pic: 0, cxn: 0, grad: 0, textChars: 0 }
  let pages = 0
  let bgCount = 0
  for (const p of ctx.pages) {
    pages++
    if (p.page.background) bgCount++
    for (const e of p.page.elements ?? []) {
      if (e.elementType === 'shape') st.sp++
      else if (e.elementType === 'image') st.pic++
      else if (e.elementType === 'line') st.cxn++
      else if (e.elementType === 'text') st.textChars += String(e.content?.text ?? '').replace(/\s/g, '').length
    }
  }
  return { pages, bgCount, ...st, media: t.media.length }
}

let overallRows = []
for (const [file, tplId] of Object.entries(SRC_TO_TPL)) {
  const pptx = join(SRC, file)
  let buf
  try { buf = await readFile(pptx) } catch { report.push(`\n## ${file}\n（源文件缺失，跳过）\n`); continue }
  const zip = zipRead(buf)
  const entries = [...zip.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  const per = []
  const sum = { sp: 0, pic: 0, cxn: 0, grpChildren: 0, custGeom: 0, grad: 0, ph: 0, cropPic: 0, smartArt: 0, table: 0, chart: 0, textChars: 0, bgImage: 0, bgSolid: 0 }
  for (const e of entries) {
    const st = slideStats(decodeXml(zip.get(e)))
    for (const k of Object.keys(sum)) sum[k] += st[k]
    per.push(st)
  }
  const imp = await importedStats(tplId)
  report.push(`\n## ${file} → 模板「${tplId}」（${per.length} 页源 vs ${imp.pages} 页导入）\n`)
  report.push('| 类别 | 源（XML） | 导入（yaml） | 备注 |')
  report.push('|---|---|---|---|')
  const elSrc = sum.sp + sum.pic + sum.cxn + sum.grpChildren
  const elImp = imp.sp + imp.pic + imp.cxn
  const rate = elSrc > 0 ? Math.round((elImp / elSrc) * 100) : 0
  report.push(`| 形状级元素 | ${elSrc} | ${elImp} | **保真率约 ${rate}%**（组合子元素并入源计数） |`)
  report.push(`| sp（含矩形/自选） | ${sum.sp} | ${imp.sp} | 自选形状（箭头/圆角等 prst）按 rect 近似 |`)
  report.push(`| pic（图片） | ${sum.pic} | ${imp.pic} | 裁剪图（crop ×${sum.cropPic}）拉伸处理 |`)
  report.push(`| cxnSp（连接线） | ${sum.cxn} | ${imp.cxn} | v0.7.1 起解析 |`)
  report.push(`| 组合 grpSp 子元素 | ${sum.grpChildren} | （并入上） | v0.7.1 起展开 |`)
  report.push(`| 自定义几何（custGeom） | ${sum.custGeom} | 0 | 自选图形按矩形近似 |`)
  report.push(`| 渐变填充（gradFill） | ${sum.grad} | 0 | 归一为主色（stops 在 import-styles.json） |`)
  report.push(`| 占位符（placeholder） | ${sum.ph} | 0 | 占位符元素并入形状近似 |`)
  report.push(`| SmartArt（diagram） | ${sum.smartArt} | 0 | 降级为文本占位 |`)
  report.push(`| 表格 / 图表 | ${sum.table} / ${sum.chart} | 保留近似 | chart→占位 |`)
  report.push(`| 页面背景（图片/纯色） | ${sum.bgImage} 图 / ${sum.bgSolid} 色 | ${imp.bgCount} | 背景提取（满页图≥95% 提升） |`)
  report.push(`| 文本字符数 | ${sum.textChars} | ${imp.textChars} | **文本保真率约 ${sum.textChars ? Math.round((imp.textChars / sum.textChars) * 100) : 0}%** |`)
  report.push(`| 媒体文件 | — | ${imp.media} | 组合内图片 v0.7.1 起提取 |`)
  overallRows.push({ file, rate, textRate: sum.textChars ? Math.round((imp.textChars / sum.textChars) * 100) : 0, elSrc, elImp })
  // 页级：每页源元素 vs 导入元素（只打印头尾 8 行避免报告过长 → 全量写）
  const implines = []
  for (let i = 0; i < per.length; i++) {
    const s = per[i]
    const srcN = s.sp + s.pic + s.cxn + s.grpChildren
    implines.push(`| 第${i + 1}页 | ${srcN} | ${s.pic}图/${s.custGeom}自/${s.grad}渐/${s.smartArt}智/${s.ph}占 | ${s.bgImage ? '背景图' : ''}${s.bgSolid ? '背景色' : ''} |`)
  }
  report.push('\n### 页级明细（源侧特征）\n')
  report.push('| 页 | 元素 | 特征 | 背景 |')
  report.push('|---|---|---|---|')
  report.push(...implines)
}

report.push('\n\n## 汇总\n')
for (const r of overallRows) {
  report.push(`- **${r.file}**：元素保真率 ${r.rate}%（${r.elImp}/${r.elSrc}）｜文本保真率 ${r.textRate}%`)
}
report.push('\n## 已知导致视觉失真的因素（按影响排序）\n')
report.push('1. **自选图形 prst → 矩形**（箭头/圆角/图标等 100+ 形状按 rect；custGeom 同理）——影响图标/箭头/装饰形状。')
report.push('2. **渐变填充归一为末 stop 主色**（gradFill → 单色；stops 记录在 import-styles.json）——影响按钮/胶囊/背景弧带。')
report.push('3. **特殊字体回退**（PPT 内置字体/手写体缺失 → 浏览器渲染 tofu □□□）——文本内容保留，视觉字形不同。')
report.push('4. **背景层不完整**：仅识别 slide 级 p:bg 与 ≥95% 满页图；蒙层/前景盖图/背景组图按元素近似。')
report.push('5. **SmartArt → 文本占位**；图表 → 文本占位（数据在 xml 中，可重建）。')
report.push('6. **文本块宽度 vs 字体度量差** → 断行位置与源不同（制作时可调框宽）。')
report.push('7. **裁剪图 srcRect 忽略**（按 fit 拉伸）。')

const outPath = join(root, 'docs', 'fidelity-report.md')
await writeFile(outPath, report.join('\n'))
console.log(`审计完成 → ${outPath}`)
for (const r of overallRows) console.log(`${r.file}: 元素 ${r.rate}% / 文本 ${r.textRate}%`)
