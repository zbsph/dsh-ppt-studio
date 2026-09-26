/**
 * 导入损失审计（第二轮 启发 B 审计半，2026-09-26）：
 * `ppt_import` 时扫源 .pptx 的 OOXML，统计**我们的 DSL 中间层/导出无法保真**的特性，
 * 并给出**页码 / 元素级证据**。用途：任务若是"只改某几页 / 改一处文字"，
 * 用户与模型据此**优先就地手术**（ppt_splice：只替换目标页、其余页逐字节不变），
 * 而不是整册重渲把原稿的动画/阴影/超链接等丢掉。
 *
 * 官方 office 技能同款纪律："Rebuilding slides can discard unsupported animation,
 * SmartArt, or other extension content." —— 所以"重建有损"必须可见。
 *
 * ── 判据（写死在代码里，验证脚本逐条断言；改判据必须同步改 verify） ──────────────
 * | 类别        | 命中判据                                                                 |
 * |------------|--------------------------------------------------------------------------|
 * | animation  | slide/layout/master/notes 里 `<p:timing>` 且其下确有 ≥1 个动画效果节点  |
 * |            | （anim/animClr/animEffect/animMotion/animRot/animScale/animBg/set/cmd/  |
 * |            | audio/video）。**空 `<p:timing><p:tnLst/></p:timing>` 不计**（无效果）。|
 * | effect     | 元素级 `a:effectLst`/`a:effectDag` **且含 ≥1 个效果子节点**（outerShdw/  |
 * |            | innerShdw/prstShdw/glow/reflection/softEdge/blur/fillOverlay）计 1 处；|
 * |            | 不在 effectLst 内的裸效果节点各计 1 处。**空 `<a:effectLst/>` 不计**     |
 * |            | （PowerPoint/我们自己的导出都大量写空 effectLst 表"无效果"）；           |
 * |            | **主题 `a:effectStyleLst` 里的效果模板不计**（那是主题装饰，非页面元素）。 |
 * | hyperlink  | 元素级 `a:hlinkClick` / `a:hlinkHover` 各计 1 处                         |
 * | transition | slide/layout/master 里 `p:transition`（含 mc:AlternateContent 里的 morph）|
 * | smartart   | slide/layout/master 里 `graphicData@uri` 含 `/diagram` 各计 1 处；       |
 * |            | 无任何引用但包内有 `ppt/diagrams/*` 部件 → 合计 1 处（避免 4 部件放大）   |
 * | media      | `ppt/media/*` 扩展名 ∉ {png,jpeg,jpg,gif,webp}（导出仅内嵌这 5 种）各 1 处；|
 * |            | `ppt/embeddings/*`（OLE 对象）各 1 处；幻灯片内 `videoFile`/`audioFile`/ |
 * |            | `p14:media`（带 r:link|r:embed）、`graphicData@uri` 含 `/ole` 各 1 处      |
 * | gradient   | 非主题部件里 `<p:bg>` 祖先下的 `a:gradFill`（页面背景渐变被丢）各 1 处，`visible: true`；|
 * |            | 主题部件里所有 `a:gradFill` 各 1 处，其中**被 `p:bgRef@idx`/`a:fillRef@idx` 按序号    |
 * |            | 引用到**的 `visible: true`（bgRef 1001=N → bgFillStyleLst 第 N 项；fillRef N →       |
 * |            | fillStyleLst 第 N 项），未被引用的样式表模板 `visible: false`（不影响页面观感，       |
 * |            | 只在 `lossAuditLine` 里降级为 ℹ 提示，不谎报"会丢可见效果"）。                       |
 * |            | **形状渐变（spPr/gradFill）不计**——v0.9.1 起形状渐变直通 fill.gradient，  |
 * |            | 计它属于误报。                                                             |
 *
 * 报告 JSON 写进工程的 `loss-audit.json`（见 importPptx 里的选择理由），
 * 工具输出用 `lossAuditLine(report)` 给一行结论（干净源稿只给一行"未发现"，不制造噪声）。
 *
 * 纯函数：`auditLoss(parts)` 只吃 OOXML 部件表（Map / 普通对象 / [name, data] 数组），
 * 不碰文件系统；`auditLossFromBuffer(buf)` 只是加一层 zipRead。便于单测。
 */
import { parseXml } from '../xmljs.js'
import { zipRead, decodeXml } from '../zips.js'

/** 报告文件名（导入器写进工程目录）。 */
export const LOSS_AUDIT_FILE = 'loss-audit.json'

const MAX_EVIDENCE = 50 // 每类证据上限（超出记 evidenceTruncated；计数仍是全量）

/** 类别定义（顺序 = 报告里的顺序，也是 lossAuditLine 里的顺序）。 */
const CATEGORY_DEFS = [
  { id: 'animation', label: '动画', loss: 'DSL 中间层没有动画通道：整册重渲后动画全丢' },
  { id: 'effect', label: '阴影/发光', loss: 'DSL 没有 effectLst 通道（import-styles.json 只留 rawShadow 标志）：整册重渲后阴影/发光消失' },
  { id: 'hyperlink', label: '超链接', loss: 'DSL 没有链接通道：整册重渲后链接退化为纯文本' },
  { id: 'transition', label: '页切换', loss: 'DSL 没有 transition 通道：整册重渲后切换效果丢' },
  { id: 'smartart', label: 'SmartArt', loss: 'SmartArt 图形框架被当作图表降级为文本占位' },
  { id: 'media', label: '不可嵌入媒体', loss: '导出仅内嵌 png/jpeg/jpg/gif/webp：EMF/WMF 等矢量图、音视频、OLE 嵌入对象不会被带入成品' },
  { id: 'gradient', label: '主题/背景渐变', loss: '主题渐变与页面背景渐变被归一为纯色（形状渐变有直通，不计）' },
]

/** 动画效果节点（timing 下有 ≥1 个才算"有动画"）。 */
const ANIM_NODES = new Set(['anim', 'animClr', 'animEffect', 'animMotion', 'animRot', 'animScale', 'animBg', 'set', 'cmd', 'audio', 'video'])
/** 效果容器（元素级）。 */
const EFFECT_LIST_TAGS = new Set(['effectLst', 'effectDag'])
/** 效果节点（容器内子节点 / 裸节点）。 */
const EFFECT_TAGS = new Set(['outerShdw', 'innerShdw', 'prstShdw', 'glow', 'reflection', 'softEdge', 'blur', 'fillOverlay'])
/** 导出内容类型表里支持内嵌的图片扩展名（export-pptx.js 的 Default Extension 集合）。 */
const EMBEDDABLE_EXT = new Set(['png', 'jpeg', 'jpg', 'gif', 'webp'])
/** 音视频扩展名（我们完全不支持）。 */
const AV_EXT = new Set(['mp4', 'm4v', 'mov', 'avi', 'wmv', 'mpg', 'mpeg', 'mkv', 'webm', 'mp3', 'wav', 'm4a', 'wma', 'mid', 'midi', 'aiff', 'aac', 'ogg'])
/** 矢量/位图扩展名里我们不能内嵌的（EMF/WMF 是官方点名的两类）。 */
const VECTOR_EXT = new Set(['emf', 'wmf', 'svg', 'tif', 'tiff', 'bmp', 'ico', 'eps'])
/** 会被遍历（元素级判据）的部件类型。 */
const WALK_KINDS = new Set(['slide', 'layout', 'master', 'notes', 'notesMaster'])

const lower = (s) => String(s).toLowerCase()
const extOf = (name) => {
  const b = name.slice(name.lastIndexOf('/') + 1)
  const i = b.lastIndexOf('.')
  return i < 0 ? '' : lower(b.slice(i + 1))
}

/** 部件类型（决定用哪套判据）。 */
function partKind(name) {
  if (/^ppt\/slides\/slide\d+\.xml$/i.test(name)) return 'slide'
  if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(name)) return 'layout'
  if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(name)) return 'master'
  if (/^ppt\/notesSlides\//i.test(name)) return 'notes'
  if (/^ppt\/notesMasters\//i.test(name)) return 'notesMaster'
  if (/^ppt\/theme\//i.test(name)) return 'theme'
  if (/^ppt\/diagrams\//i.test(name)) return 'diagram'
  if (/^ppt\/media\//i.test(name)) return 'media'
  if (/^ppt\/embeddings\//i.test(name)) return 'embedding'
  return 'other'
}

/** slide 页号（1 基）；非 slides/ 部件返回 null（页面证据靠 part 名兜底）。 */
function pageOf(name) {
  const m = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name)
  return m ? Number(m[1]) : null
}

/** 部件表归一：Map / 普通对象 / [name, data] 数组 / [{name,data}] 数组都接受。 */
function normalizeParts(parts) {
  const out = []
  const push = (k, v) => { if (typeof k === 'string' && k) out.push([k, v ?? '']) }
  if (parts instanceof Map) for (const [k, v] of parts) push(k, v)
  else if (Array.isArray(parts)) {
    for (const it of parts) {
      if (Array.isArray(it)) push(it[0], it[1])
      else if (it && typeof it === 'object') push(it.name ?? it.path ?? it.file ?? it.part, it.data ?? it.xml ?? it.text ?? it.content)
    }
  } else if (parts && typeof parts === 'object') for (const [k, v] of Object.entries(parts)) push(k, v)
  return out
}

/** gradFill 的 stops（计数 + 颜色，证据用）。 */
function stopsOf(gradFill) {
  const gsLst = gradFill.children.find((c) => c.tag === 'gsLst')
  const gs = gsLst ? gsLst.children.filter((c) => c.tag === 'gs') : []
  const colors = gs.map((g) => {
    const srgb = g.children.find((c) => c.tag === 'srgbClr')
    if (srgb?.attrs?.val) return '#' + lower(srgb.attrs.val)
    const scheme = g.children.find((c) => c.tag === 'schemeClr')
    return scheme?.attrs?.val ? `scheme:${scheme.attrs.val}` : '?'
  })
  return { count: gs.length, colors }
}

/** 递归数某几个 tag 的节点数（timing 下动画效果计数用）。 */
function countTags(node, tags) {
  let n = 0
  const walk = (x) => {
    if (tags.has(x.tag)) n++
    for (const c of x.children ?? []) walk(c)
  }
  for (const c of node.children ?? []) walk(c)
  return n
}

/** 形状容器（元素名的宿主）。 */
const SHAPE_TAGS = new Set(['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp', 'contentPart', 'oleObj'])

/** 在形状容器子树里找 cNvPr 的名字（`sp > nvSpPr > cNvPr`，深度 ≤2，不跨子形状）。 */
function cnvPrName(node, depth = 0) {
  if (!node || depth > 2) return null
  for (const c of node.children ?? []) {
    if (c.tag === 'cNvPr') return c.attrs?.name ?? c.attrs?.id ?? null
    const nested = cnvPrName(c, depth + 1)
    if (nested) return nested
  }
  return null
}

/**
 * 审计入口（纯函数）。
 * @param {Map<string,Buffer|string>|object|Array} parts OOXML 部件表
 * @param {{source?:string}} [opts] source = 源文件名（写进报告元数据）
 * @returns 报告对象（写 loss-audit.json，也直接给工具输出用）
 */
export function auditLoss(parts, opts = {}) {
  const map = normalizeParts(parts)
  const hits = new Map(CATEGORY_DEFS.map((d) => [d.id, []]))
  const add = (id, ev) => { hits.get(id).push(ev) }
  const diagramParts = []
  const themeRefs = { bgRef: [], fillRef: [] } // p:bgRef / a:fillRef 的 idx（判断主题渐变是否被引用）
  let slides = 0
  let shapeGradients = 0 // 形状渐变（有直通，不计；只在 note 里说明）

  const walk = (name, kind, text) => {
    const page = pageOf(name)
    if (kind === 'slide') slides++
    const tree = parseXml(text)
    const anc = []
    // 元素名 = 最近的形状容器（sp/pic/graphicFrame/…）里的 cNvPr@name。
    // 注意 cNvPr 与效果/文本是**兄弟分支**（spPr/ txBody 侧），不是祖先，所以按容器反查。
    const elName = () => {
      for (let i = anc.length - 1; i >= 0; i--) {
        if (SHAPE_TAGS.has(anc[i].tag)) return cnvPrName(anc[i])
      }
      return null
    }
    const inTheme = kind === 'theme'
    const visit = (node, inEffect) => {
      const tag = node.tag
      const childInEffect = inEffect || EFFECT_LIST_TAGS.has(tag)
      // ── 效果（阴影/发光）── 空 effectLst 与主题效果模板不计
      if (EFFECT_LIST_TAGS.has(tag)) {
        const kinds = {}
        for (const c of node.children) if (EFFECT_TAGS.has(c.tag)) kinds[c.tag] = (kinds[c.tag] ?? 0) + 1
        const kk = Object.keys(kinds)
        if (kk.length && !inTheme) {
          add('effect', { page, part: name, element: elName(), tag, kinds, detail: `效果容器：${kk.map((k) => `${k}×${kinds[k]}`).join('+')}` })
        }
      } else if (!inEffect && !inTheme && EFFECT_TAGS.has(tag)) {
        add('effect', { page, part: name, element: elName(), tag, kinds: { [tag]: 1 }, detail: `裸效果节点 ${tag}（不在 effectLst 内）` })
      }
      if (!inTheme) {
        // ── 动画 ──
        if (tag === 'timing') {
          const n = countTags(node, ANIM_NODES)
          if (n > 0) add('animation', { page, part: name, element: null, tag, anims: n, detail: `时间轴含 ${n} 个动画效果节点` })
        }
        // ── 超链接 ──
        if (tag === 'hlinkClick' || tag === 'hlinkHover') {
          const rid = node.attrs['r:id'] ?? node.attrs.id ?? null
          add('hyperlink', { page, part: name, element: elName(), tag, subtype: tag === 'hlinkClick' ? 'click' : 'hover', rId: rid, detail: `${tag === 'hlinkClick' ? '点击' : '悬停'}超链接${rid ? `（${rid}）` : ''}` })
        }
        // ── 页切换 ──
        if (tag === 'transition' && kind !== 'notes' && kind !== 'notesMaster') {
          const child = node.children?.find((c) => c.tag !== 'sldClickOn')?.tag
          const type = node.attrs?.type ?? child ?? null
          add('transition', { page, part: name, element: null, tag, type, detail: `页切换${type ? `（${type}）` : ''}` })
        }
        // ── SmartArt ──
        if (tag === 'graphicData' && /\/diagram/.test(node.attrs?.uri ?? '')) {
          add('smartart', { page, part: name, element: elName(), tag, uri: node.attrs.uri, detail: `图形框架引用 SmartArt（${String(node.attrs.uri).replace(/^.*\//, '')}）` })
        }
        // ── 幻灯片内的 OLE / 音视频引用 ──
        if (tag === 'graphicData' && /\/ole/i.test(node.attrs?.uri ?? '')) {
          add('media', { page, part: name, element: elName(), tag, ext: 'ole-ref', reason: 'OLE 嵌入对象（幻灯片内引用）', detail: `幻灯片内 OLE 嵌入对象（${String(node.attrs.uri).replace(/^.*\//, '')}）` })
        }
        if ((tag === 'videoFile' || tag === 'audioFile' || tag === 'media') && (node.attrs?.['r:link'] || node.attrs?.['r:embed'])) {
          const ext = tag === 'media' ? 'media' : tag === 'videoFile' ? 'video' : 'audio'
          add('media', { page, part: name, element: elName(), tag, ext, reason: tag === 'media' ? '内嵌/外链媒体（p14:media）' : '内嵌/外链音视频', detail: `${tag}（${node.attrs['r:link'] ? 'link' : 'embed'}: ${node.attrs['r:link'] ?? node.attrs['r:embed']}）` })
        }
      }
      // ── 渐变 ──
      if (tag === 'gradFill') {
        const st = stopsOf(node)
        if (inTheme) {
          const holderNode = [...anc].reverse().find((n) => /fillStyleLst$/i.test(n.tag))
          const index = holderNode ? holderNode.children.indexOf(node) + 1 : null
          add('gradient', { page, part: name, element: null, tag, scope: 'theme', holder: holderNode?.tag ?? null, index, ...st, detail: `主题渐变（${holderNode?.tag ?? 'theme'}${index ? ` 第 ${index} 项` : ''}，${st.count} 个 stop：${st.colors.join('→')}）→ 归一为纯色` })
        } else if (WALK_KINDS.has(kind) && anc.some((n) => n.tag === 'bg')) {
          add('gradient', { page, part: name, element: null, tag, scope: 'background', visible: true, ...st, detail: `页面背景渐变（${st.count} 个 stop：${st.colors.join('→')}）→ 归一为纯色` })
        } else {
          shapeGradients++
        }
      }
      // ── 主题引用（判"主题渐变是否真的用在**可见页面**上"）──
      // 只看幻灯片/版式/母版：备注页（notes/notesMaster）不参与放映观感，引用它不算"可见损失"
      // （真实 python-pptx 稿就有 "notesSlide 里 fillRef=3 指向主题渐变" 的情形）。
      if ((tag === 'bgRef' || tag === 'fillRef') && (kind === 'slide' || kind === 'layout' || kind === 'master')) {
        const idx = Number(node.attrs?.idx)
        if (Number.isFinite(idx) && idx > 0) {
          const k = tag === 'bgRef' ? 'bgRef' : 'fillRef'
          if (!themeRefs[k].includes(idx)) themeRefs[k].push(idx)
        }
      }
      anc.push(node)
      for (const c of node.children) visit(c, childInEffect)
      anc.pop()
    }
    visit(tree, false)
  }

  for (const [name, data] of map) {
    const kind = partKind(name)
    if (kind === 'media') {
      const ext = extOf(name)
      if (!EMBEDDABLE_EXT.has(ext)) {
        const reason = AV_EXT.has(ext) ? '音视频（导出不内嵌）' : VECTOR_EXT.has(ext) ? '矢量/位图格式（导出仅内嵌 png/jpeg/jpg/gif/webp）' : '扩展名不在导出支持列表（导出仅内嵌 png/jpeg/jpg/gif/webp）'
        add('media', { page: null, part: name, element: name.slice(name.lastIndexOf('/') + 1), tag: 'media-part', ext, reason, detail: `媒体部件 .${ext}：${reason}` })
      }
      continue
    }
    if (kind === 'embedding') {
      add('media', { page: null, part: name, element: name.slice(name.lastIndexOf('/') + 1), tag: 'embedding-part', ext: extOf(name), reason: 'OLE 嵌入对象（DSL 无通道）', detail: `嵌入对象部件（.${extOf(name)}）：导出不会带入成品` })
      continue
    }
    if (kind === 'diagram') {
      diagramParts.push(name)
      continue // 有引用时按引用计数；无引用时下方兜底合计 1 处
    }
    if (kind !== 'theme' && !WALK_KINDS.has(kind)) continue
    if (!/\.xml$/i.test(name)) continue
    let text
    try {
      text = typeof data === 'string' ? data : decodeXml(data)
    } catch {
      continue
    }
    walk(name, kind, text)
  }

  // SmartArt 兜底：没有任何图形框架引用但包里有图部件（合计 1 处，不按 4 个部件放大）
  if (!hits.get('smartart').length && diagramParts.length) {
    add('smartart', { page: null, part: diagramParts[0], element: null, tag: 'diagram-part', parts: diagramParts.length, detail: `包内有 ${diagramParts.length} 个 SmartArt 图部件但未发现图形框架引用（合计 1 处）` })
  } else if (diagramParts.length) {
    for (const ev of hits.get('smartart')) ev.detail += `；包内另有 ${diagramParts.length} 个 SmartArt 图部件`
  }

  // 主题渐变的"是否真的用在页面上"：bgRef idx=1001+N → bgFillStyleLst 第 N+1 项；fillRef idx=N → fillStyleLst 第 N 项。
  // （refs 在全量遍历后才齐——主题部件常排在 master 之前，所以必须在此后处理。）
  for (const ev of hits.get('gradient')) {
    if (ev.scope === 'background') continue
    if (!ev.holder || !ev.index) { ev.visible = false; ev.detail += '；未被引用（样式表模板）'; continue }
    ev.visible = /^bg/i.test(ev.holder) ? themeRefs.bgRef.includes(1000 + ev.index) : themeRefs.fillRef.includes(ev.index)
    if (!ev.visible) ev.detail += '；未被引用（样式表模板）'
  }
  const visibleOf = (ev) => ev.filter((e) => e.visible !== false).length

  // 证据排序（确定性：页 → 部件 → 元素 → tag），并按上限截断
  const categories = CATEGORY_DEFS.map((d) => {
    const ev = hits.get(d.id)
    ev.sort((a, b) => (a.page ?? 1e9) - (b.page ?? 1e9) || String(a.part).localeCompare(String(b.part)) || String(a.element ?? '').localeCompare(String(b.element ?? '')) || String(a.tag).localeCompare(String(b.tag)) || String(a.holder ?? '').localeCompare(String(b.holder ?? '')) || (a.index ?? 0) - (b.index ?? 0) || String(a.ext ?? '').localeCompare(String(b.ext ?? '')))
    const out = { id: d.id, label: d.label, count: ev.length, visible: visibleOf(ev), loss: d.loss, evidence: ev.slice(0, MAX_EVIDENCE) }
    if (ev.length > MAX_EVIDENCE) out.evidenceTruncated = true
    return out
  })
  const counts = Object.fromEntries(categories.map((c) => [c.id, c.count]))
  const total = categories.reduce((s, c) => s + c.count, 0)
  const visibleTotal = categories.reduce((s, c) => s + c.visible, 0)

  return {
    generatedBy: 'dsh-ppt-studio',
    version: 1,
    source: opts.source ?? null,
    kind: 'pptx-rebuild-loss-audit',
    clean: total === 0,
    total,
    visibleTotal,
    // 主题样式表渐变未被引用：整册重渲只丢主题标识，不丢可见效果（lossAuditLine 降级为 ℹ）
    themeStyleOnly: visibleTotal === 0 && total > 0,
    counts,
    scannedParts: map.length,
    slides,
    categories,
    ...(themeRefs.bgRef.length || themeRefs.fillRef.length ? { themeRefs: { bgRef: themeRefs.bgRef, fillRef: themeRefs.fillRef } } : {}),
    note: '判据：动画=非空 p:timing；阴影/发光=含效果子节点的 a:effectLst/a:effectDag 或裸效果节点（空 effectLst 与主题 effectStyleLst 不计）；超链接=a:hlinkClick/a:hlinkHover；切换=p:transition；SmartArt=graphicData@uri 含 /diagram（无引用时包内部件合计 1 处）；不可嵌入媒体=ppt/media 扩展名 ∉ {png,jpeg,jpg,gif,webp}、ppt/embeddings、幻灯片内 OLE/音视频引用；渐变=p:bg 下 a:gradFill（可见）+ 主题 a:gradFill（被 bgRef idx=1001+N / fillRef idx=N 引用者 visible:true，未被引用者 visible:false=样式表模板）；形状渐变直通不计。证据字段：page（1 基，非幻灯片为 null）/part/element/tag/visible。',
    advice: total === 0
      ? '未发现 DSL 无法保真的特性：整册重渲不额外丢东西（图表降级/未映射形状另有 warnings）。'
      : visibleTotal === 0
        ? `未发现会丢的可见效果；仅主题样式表含 ${total} 处渐变且未被任何 bgRef/fillRef 引用（不影响页面观感，整册重渲只丢主题标识）。若只需改某几页，仍优先 ppt_splice。`
        : `整册重渲会丢上述 ${visibleTotal} 处可见特性；若只需改某几页 / 改一处文字，优先 ppt_splice（只把工作区目标页替换进原稿，其余页逐字节不变）——动画/阴影/超链接等留在原稿里。`,
    ...(shapeGradients ? { note_shapeGradientsPreserved: `包内另有 ${shapeGradients} 处形状渐变：v0.9.1 起直通 fill.gradient，不计入损失。` } : {}),
    hitSummary: categories.filter((c) => c.count > 0).map((c) => ({ id: c.id, label: c.label, count: c.count, visible: c.visible })),
  }
}

/** zipRead 一层：从 .pptx 二进制审计（测试/工具用）。 */
export function auditLossFromBuffer(buf, opts = {}) {
  return auditLoss(zipRead(buf), opts)
}

/**
 * 工具输出结论行（ppt_import 用）：干净源稿只给一行"未发现"，不制造噪声；
 * 只有"未被引用的主题样式表渐变"时不谎报"会丢可见效果"（降级为 ℹ）。
 */
export function lossAuditLine(report) {
  if (!report || typeof report !== 'object') return ''
  if (report.clean) return '✓ 损失审计：未发现 DSL 无法保真的特性（动画 / 阴影发光 / 超链接 / 切换 / SmartArt / 不可嵌入媒体 / 主题渐变均为 0）——整册重渲不额外丢东西'
  const hit = report.hitSummary ?? []
  const visible = hit.filter((c) => (c.visible ?? c.count) > 0)
  const hiddenCount = hit.reduce((s, c) => s + (c.count - (c.visible ?? c.count)), 0)
  if (!visible.length) {
    return `ℹ 损失审计：未发现会丢的可见效果；源稿主题含 ${report.total} 处渐变样式模板（未被任何 bgRef/fillRef 引用，不影响观感）——整册重渲只丢主题标识，若只需改某几页仍优先 ppt_splice；证据见 ${LOSS_AUDIT_FILE}`
  }
  const parts = visible.map((c) => `${c.label} ${c.visible ?? c.count} 处`).join(' / ')
  return `⚠ 源稿含不可保真特性：${parts}${hiddenCount ? `（另有 ${hiddenCount} 处主题样式表渐变未被引用，不影响观感）` : ''} —— 整册重渲会丢这些；若只需改某几页 / 改一处文字，优先 ppt_splice（只替换目标页，其余页逐字节不变）；页码/元素级证据见 ${LOSS_AUDIT_FILE}`
}
