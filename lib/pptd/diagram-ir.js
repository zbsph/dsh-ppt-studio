import { validateTraits } from './style-traits.js'

/**
 * 图编译核心（阶段 B）：IR 校验 → 样式档案 → 布局 → 物化产出（元素 + 结构关系）。
 * 设计契约见 docs/12；本模块只做"结构 ⇒ 几何"，**没有任何审美决策**（取色/尺寸全部来自样式令牌）。
 *
 * 三条硬契约（自证脚本逐条断言）：
 *   ① 纯函数：不改输入；同输入两次输出深度相等（确定性）；
 *   ② 只产出既有元素类型（shape/text/line），不新增类型；
 *   ③ 不支持的 type/字段 ⇒ 优雅降级（elements: [] + notes），绝不产半成品图。
 *
 * 关键几何约定（避免引擎自己产出冲突）：
 *   **容器（分组）边界切在节点边沿**，并把"跨组连线"分配给左侧/上方那一组 ⇒
 *   连线被该组的 contains **严格包住**（端点正好落在边界上，contains 用 >=/<= 判），
 *   容器之间只在节点边沿相接（ho=0，不算相交）⇒ 既不需要 expectedOverlaps，也不会报冲突。
 */
import { ATTACH_SIDES } from './relations.js'
// 阶段 C：图族库（每族只做几何策略；校验/样式/物化仍由本模块统一负责）
import { FAMILIES, boxOf, makeContainer, makeText, makeEdge } from './diagram-families.js'

/** 已实现图族与成熟度（阶段 C 分批扩充；未列出的 type 一律优雅降级）。 */
export const DIAGRAM_TYPES = {
  // maturity 升级判据（docs/13 §2）：**连续两轮真渲染无问题**才升 stable。
  // 2026-09-28：flow + 10 个族库族两轮均 0 错误 ⇒ stable。
  // 2026-09-29：layers 也升 stable —— 第 2 轮（修完 5 层缺陷后）与 A/B 系列改动后的复跑均 0 错误 0 警告，满足 DoD。
  flow: 'stable',
  layers: 'stable',
  ...Object.fromEntries(Object.entries(FAMILIES).map(([k, v]) => [k, v.maturity])),
}

const DEFAULT_PALETTE = ['#2563EB', '#0EA5E9', '#F59E0B', '#10B981', '#7C3AED', '#64748B']

/** 结构校验：错误信息带 file 前缀（与 schema 一致，便于模型定位）。 */
export function validateDiagram(d, { file = '' } = {}) {
  const errors = []
  const at = (m) => `${file ? `[${file}] ` : ''}diagram.${m}`
  if (d === undefined || d === null) return errors
  if (typeof d !== 'object' || Array.isArray(d)) return [`${at('')}: 必须是对象（{type, nodes, edges, …}）`]
  if (typeof d.type !== 'string' || !d.type) errors.push(`${at('type')}: 必填字符串（已支持：${Object.keys(DIAGRAM_TYPES).join('|')}）`)
  else if (!(d.type in DIAGRAM_TYPES)) errors.push(`${at('type')}: "${d.type}" 尚未实现（已支持：${Object.keys(DIAGRAM_TYPES).join('|')}）；未实现类型会**优雅降级**为不产元素`)
  if (d.direction !== undefined && !['LR', 'TB'].includes(d.direction)) errors.push(`${at('direction')}: LR|TB`)
  if (d.bounds !== undefined && !(Array.isArray(d.bounds) && d.bounds.length === 4 && d.bounds.every((n) => typeof n === 'number'))) {
    errors.push(`${at('bounds')}: [x, y, w, h] numbers（可选；缺省用页面安全区内接区）`)
  }
  if (!Array.isArray(d.nodes) || d.nodes.length === 0) {
    errors.push(`${at('nodes')}: 非空数组（每项 {id, label, emphasis?}）`)
  } else {
    const ids = new Set()
    d.nodes.forEach((n, i) => {
      const p = at(`nodes[${i}]`)
      if (!n || typeof n !== 'object') { errors.push(`${p}: expected object`); return }
      if (typeof n.id !== 'string' || !n.id) errors.push(`${p}.id: required non-empty string`)
      else if (ids.has(n.id)) errors.push(`${p}.id: duplicate "${n.id}"`)
      else ids.add(n.id)
      if (n.label !== undefined && typeof n.label !== 'string') errors.push(`${p}.label: string`)
      if (n.emphasis !== undefined && !['primary', 'accent', 'plain'].includes(n.emphasis)) errors.push(`${p}.emphasis: primary|accent|plain`)
    })
    if (Array.isArray(d.edges)) {
      d.edges.forEach((e, i) => {
        const p = at(`edges[${i}]`)
        if (!e || typeof e !== 'object') { errors.push(`${p}: expected object`); return }
        for (const end of ['from', 'to']) {
          if (typeof e[end] !== 'string' || !e[end]) errors.push(`${p}.${end}: required node id`)
          else if (!ids.has(e[end])) errors.push(`${p}.${end}: "${e[end]}" 不是已声明的节点 id（防呆：连线必须指向真实节点）`)
        }
        if (e.label !== undefined && typeof e.label !== 'string') errors.push(`${p}.label: string`)
        if (e.style !== undefined && !['solid', 'dashed'].includes(e.style)) errors.push(`${p}.style: solid|dashed`)
      })
    }
    if (d.groups !== undefined) {
      if (!Array.isArray(d.groups)) errors.push(`${at('groups')}: 数组（每项 {id, label?, members: [节点 id]}）`)
      else {
        const gids = new Set()
        d.groups.forEach((g, i) => {
          const p = at(`groups[${i}]`)
          if (!g || typeof g !== 'object') { errors.push(`${p}: expected object`); return }
          if (typeof g.id !== 'string' || !g.id) errors.push(`${p}.id: required non-empty string`)
          else if (gids.has(g.id)) errors.push(`${p}.id: duplicate "${g.id}"`)
          else gids.add(g.id)
          if (!Array.isArray(g.members) || g.members.length === 0) errors.push(`${p}.members: 非空节点 id 数组`)
          else g.members.forEach((m) => { if (!ids.has(m)) errors.push(`${p}.members: "${m}" 不是已声明的节点 id`) })
        })
      }
    }
  }
  return errors
}

/** 样式档案：从主题令牌派生引擎要用的一切（引擎自身不硬编码颜色/尺寸）。 */
export function styleProfileFrom(theme = {}) {
  const colors = theme?.colors ?? {}
  const ordered = ['primary', 'accent', 'soft', 'ink'].map((k) => colors[k]).filter(Boolean)
  const rest = Object.values(colors).filter((v) => typeof v === 'string' && !ordered.includes(v))
  const palette = [...ordered, ...rest, ...DEFAULT_PALETTE].filter((v, i, a) => typeof v === 'string' && a.indexOf(v) === i)
  return {
    palette,
    ink: colors.text ?? colors.ink ?? '#1F2937',
    // 中性浅底（容器/plain 节点）：**必须是中性色**——主题一致性门禁只认"主题色板 或 中性灰"，
    // 主色混白（如 #F2F6FE，Δ=4/8/12）会被判"不在主题色板"而报错（本轮实测踩到）。
    neutral: colors.bg ?? colors.surface ?? '#F1F5F9',
    // #RRGGBB 混白（容器底色/浅色带）——纯函数，便于断言
    tint: (hex, ratio = 0.92) => {
      const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? ''))
      if (!m) return '#F1F5F9'
      const v = parseInt(m[1], 16)
      const mix = (c) => Math.round(c + (255 - c) * ratio)
      return `#${[mix((v >> 16) & 0xff), mix((v >> 8) & 0xff), mix(v & 0xff)].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`
    },
    gap: Number(theme?.spacing?.base) > 0 ? Number(theme.spacing.base) : 24,
    lineWidth: Number(theme?.line?.width) > 0 ? Number(theme.line.width) : 1,
    radius: Number.isFinite(theme?.radius) ? theme.radius : 8,
    fontSize: Number(theme?.textStyles?.body?.fontSize) > 0 ? Number(theme.textStyles.body.fontSize) : 14,
    pad: 10, // 容器与成员的最小内缩（contains 需严格包含）
  }
}

const round = (n) => Math.round(n * 100) / 100

/**
 * 布局：IR → { elements, groups, notes, stats }（元素 + 结构关系一起产出）。
 * @param {object} d diagram 块
 * @param {{bounds?: {x,y,w,h}, style?: object, measure?: (text, fontSize) => number}} opts
 */
export function layoutDiagram(d, opts = {}) {
  const notes = []
  const elements = []
  const groups = []
  const type = d?.type
  if (!(type in DIAGRAM_TYPES)) return { elements, groups, notes: [`图类型 "${type ?? '(缺)'}" 未实现 ⇒ 优雅降级：不产出任何元素（请手写，或改用 ${Object.keys(DIAGRAM_TYPES).join('/')}）`], stats: { nodes: 0, edges: 0, groups: 0 } }

  const style = opts.style ?? styleProfileFrom({})
  // 阶段 E / Y2：风格特型（traits）走**闭集校验** —— 未知键/非法值一律构建失败，绝不静默忽略（宪法③：
  // 新做法必须先加入闭集并同时提交它的合规检查）。默认 traits 等于现状 ⇒ 不传风格时行为不变。
  const traitsRes = validateTraits(style.traits)
  if (traitsRes.errors.length) {
    throw new Error('图风格特型非法（宪法③）—— 未知特型/非法值不得静默忽略：\n  - ' + traitsRes.errors.join('\n  - '))
  }
  style.traits = traitsRes.traits
  style.traitHonored = traitsRes.honored
  const prefix = opts.idPrefix ?? 'd1_'
  const id = (x) => `${prefix}${x}`
  const nodes = d.nodes ?? []
  const edges = d.edges ?? []
  const irGroups = Array.isArray(d.groups) ? d.groups : []
  const dir = d.direction ?? (type === 'layers' ? 'TB' : 'LR')
  const measure = opts.measure ?? ((t, fs) => String(t ?? '').length * fs) // 保守：无度量函数时按全角估

  // ── 画布：接受 [x,y,w,h] 数组或 {x,y,w,h} 对象；缺省用页面安全区内接区 ──
  const raw = opts.bounds ?? d.bounds ?? null
  if (!raw) {
    const sa = style.safeArea ?? { top: 60, bottom: 60, left: 60, right: 60 }
    const w = style.page?.width ?? 960
    const h = style.page?.height ?? 540
    opts._bounds = { x: sa.left ?? 60, y: sa.top ?? 60, w: w - (sa.left ?? 60) - (sa.right ?? 60), h: h - (sa.top ?? 60) - (sa.bottom ?? 60) }
  }
  const box = Array.isArray(raw)
    ? { x: raw[0], y: raw[1], w: raw[2], h: raw[3] }
    : (raw && typeof raw === 'object' ? { x: raw.x, y: raw.y, w: raw.w, h: raw.h } : opts._bounds)
  if (!box || !(box.w > 0) || !(box.h > 0)) {
    return { elements, groups, notes: ['画布区无效（bounds 或安全区为空）⇒ 优雅降级：不产出元素'], stats: { nodes: 0, edges: 0, groups: 0 } }
  }

  // ── 阶段 C：族库分派 ──
  // 族只负责"该族的几何策略"；样式令牌、IR 校验、物化、分组逻辑组与容器仍由本模块统一负责
  // （这样"引擎没有审美""结构关系自动产出"这些不变量不需要在每个族里重复实现）。
  const family = FAMILIES[type]
  if (family) {
    const prof = { ...style, measureLine: (t, fs) => measure(t, fs) }
    const out = family.layout({ d, box, style: prof, id, notes })
    // ── Z1：预留区清单**透传**到布局结果（供页面快照与门禁 band-crossing 使用）──
    // 族只声明"哪块地方被占了"；下游负责把它带到快照并交给检查，避免各层各写一份。
    const reservedBands = Array.isArray(out?.reservedBands) ? out.reservedBands : []
    const els = [...(out.elements ?? [])]
    const gs = []
    const existing = []
    // 有些族（泳道图）用 `role: decoration` 的带 + 逻辑组表达分组，**不要**容器（skipContainers）
    if (out.skipContainers) {
      for (const g of out.groups ?? []) gs.push(g)
      return {
      reservedBands,
        elements: els, groups: gs, notes,
        stats: { family: type, maturity: family.maturity, nodes: nodes.length, edges: edges.length, elements: els.length, groups: gs.length, containers: 0 },
      }
    }
    for (const g of irGroups) {
      const rects = (g.members ?? []).map((m) => out.pos?.get(m)).filter(Boolean)
      if (!rects.length) { notes.push(`分组 "${g.id}" 在 ${type} 族里没有可用成员 ⇒ 只保留逻辑组`); gs.push({ id: id(`grp_${g.id}`), ...(g.label ? { label: g.label } : {}), members: [] }); continue }
      const cb0 = boxOf(rects, Math.max(4, Math.min(style.pad, 8)))
      const cb = g.label ? { x: cb0.x, y: cb0.y - 16, w: cb0.w, h: cb0.h + 16 } : cb0
      const members = [...new Set([...(g.members ?? []).map(id), ...(g.members ?? []).map((m) => id(`t_${m}`))])]
      // 组内连线也要进 contains：折线（如树的肘形连线）AABB 有高度，会与容器判为"意外重叠"
      //（轴对齐的直线 AABB 高度为 0 不受影响；这里按"两端都在组内"判定，几何上必然被容器严格包住）
      const memberEls = new Set((g.members ?? []).map((m) => id(m)))
      for (const el of out.elements ?? []) {
        if (el.elementType !== 'line') continue
        const f = el.attach?.from?.ref
        const t = el.attach?.to?.ref
        if (f && t && memberEls.has(f) && memberEls.has(t)) members.push(el.elementId)
      }
      const container = makeContainer(prof, id, { gid: g.id, box: cb, members, existing, notes })
      if (!container) { gs.push({ id: id(`grp_${g.id}`), ...(g.label ? { label: g.label } : {}), members }); continue }
      if (g.label) {
        const lid = id(`gl_${g.id}`)
        els.unshift(makeText(prof, id, { id: `gl_${g.id}`, x: cb.x + 6, y: cb.y + 3, w: Math.max(24, cb.w - 12), text: String(g.label) }))
        container.contains.push(lid)
      }
      existing.push(cb)
      els.unshift(container)
      gs.push({ id: id(`grp_${g.id}`), ...(g.label ? { label: g.label } : {}), members })
    }
    return {
      reservedBands,
      elements: els,
      groups: gs,
      notes,
      stats: { family: type, maturity: family.maturity, nodes: nodes.length, edges: edges.length, elements: els.length, groups: gs.length, containers: existing.length },
    }
  }

  // ── 分组 → 带（band）：flow 用 IR groups 的顺序切段；layers 每个 group 一条带 ──
  const groupOf = new Map()
  irGroups.forEach((g, gi) => { for (const m of g.members ?? []) if (!groupOf.has(m)) groupOf.set(m, gi) })
  const bands = [] // [{gi|null, ids: []}] 保持 IR 顺序（未分组的节点各自成带，保证几何不叠）
  nodes.forEach((n) => {
    const gi = groupOf.has(n.id) ? groupOf.get(n.id) : null
    const last = bands[bands.length - 1]
    if (gi !== null && last && last.gi === gi) last.ids.push(n.id)
    else if (gi === null) bands.push({ gi: null, ids: [n.id] })
    else bands.push({ gi, ids: [n.id] })
  })

  // ── 节点尺寸与位置 ──
  const perBand = type === 'layers' ? Math.max(...bands.map((x) => x.ids.length), 1) : Math.max(nodes.length, 1)
  const along = dir === 'LR' ? box.w : box.h
  const across = dir === 'LR' ? box.h : box.w
  const nBands = type === 'layers' ? Math.max(bands.length, 1) : 1
  const gapAlong = style.gap
  const bandAlong = type === 'layers' ? Math.max(60, (along - gapAlong * (nBands - 1)) / nBands) : along
  const nodeW = Math.max(56, Math.min(type === 'layers' ? bandAlong : (along - gapAlong * (perBand - 1)) / perBand * 0.86, 260))
  const nodeH = Math.max(36, Math.min(type === 'layers' ? (across - gapAlong * (perBand - 1)) / Math.max(perBand, 1) * 0.7 : across * 0.42, 120))

  const pos = new Map()
  const bandBox = new Map() // 带 → 覆盖其成员（含跨组连线）的矩形
  bands.forEach((band, bi) => {
    const members = band.ids
    if (type === 'layers') {
      // 带沿 across 方向排一行
      const bandX = box.x + bi * (bandAlong + gapAlong)
      const rows = members.length
      const step = (box.h - gapAlong * (rows - 1)) / Math.max(rows, 1)
      members.forEach((nid, i) => {
        const y = box.y + i * (step + gapAlong)
        pos.set(nid, { x: bandX + (bandAlong - nodeW) / 2, y, w: nodeW, h: Math.min(nodeH, step) })
      })
    } else {
      // flow：全在一行/一列；band 只影响容器的切分
      members.forEach((nid) => {
        const i = nodes.findIndex((n) => n.id === nid)
        const x = dir === 'LR'
          ? box.x + i * ((along - gapAlong * (perBand - 1)) / perBand + gapAlong) + ((along - gapAlong * (perBand - 1)) / perBand - nodeW) / 2
          : box.x + (box.w - nodeW) / 2
        const y = dir === 'LR'
          ? box.y + (box.h - nodeH) / 2
          : box.y + i * ((along - gapAlong * (perBand - 1)) / perBand + gapAlong) + ((along - gapAlong * (perBand - 1)) / perBand - nodeH) / 2
        pos.set(nid, { x: round(x), y: round(y), w: nodeW, h: nodeH })
      })
    }
  })

  const nodeIds = new Set(nodes.map((n) => n.id))
  // 容器内缩：多组时不能让两侧 pad 之和超过节点间隙（否则容器互相重叠）；边标签的净空也用它
  const padEff = irGroups.length > 1 ? Math.max(2, Math.min(style.pad, gapAlong / 2 - 1)) : style.pad
  const edgesOf = (nid) => edges.filter((e) => e.from === nid || e.to === nid)

  // ── 连线：端点锚到节点边（attach 自动产出，箭头必然落边）──
  const edgeEls = []
  const edgeLabelGroup = new Map() // 组内边标签 → 组序号（容器 contains 需要它）
  edges.forEach((e, i) => {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) return
    const A = pos.get(e.from)
    const B = pos.get(e.to)
    if (!A || !B) return
    let from
    let to
    // 走横还是走竖：**按几何判定**，不按 `dir` 字段。
    // 反例（layers 族实测 7 条）：带是**横向排列**的，但 type=layers 的默认 dir 是 TB，
    // 代码按"下→上"路由 ⇒ 拐点落回节点内部、折线 AABB 覆盖整节点。
    const horizontal = Math.abs((B.x + B.w / 2) - (A.x + A.w / 2)) >= Math.abs((B.y + B.h / 2) - (A.y + A.h / 2))
    if (horizontal) {
      const forward = B.x >= A.x
      from = { ref: id(e.from), side: forward ? 'right' : 'left', pt: [forward ? A.x + A.w : A.x, A.y + A.h / 2] }
      to = { ref: id(e.to), side: forward ? 'left' : 'right', pt: [forward ? B.x : B.x + B.w, B.y + B.h / 2] }
    } else {
      const forward = B.y >= A.y
      from = { ref: id(e.from), side: forward ? 'bottom' : 'top', pt: [A.x + A.w / 2, forward ? A.y + A.h : A.y] }
      to = { ref: id(e.to), side: forward ? 'top' : 'bottom', pt: [B.x + B.w / 2, forward ? B.y : B.y + B.h] }
    }
    // A2：改走 makeEdge ⇒ 遗留族也接入 R1（折线永远轴对齐）+ R2（箭头端 ≥18px 直段）。
    // 此前这两族自己拼元素、绕过了这两条保护（用户强调"别让任何一条路径漏保护"）。
    const pts = (() => {
      if (horizontal) {
        if (Math.abs(from.pt[1] - to.pt[1]) < 1) return [[from.pt[0], from.pt[1]], [to.pt[0], to.pt[1]]]
        const sepX = round((from.pt[0] + to.pt[0]) / 2)
        return [[from.pt[0], from.pt[1]], [sepX, from.pt[1]], [sepX, to.pt[1]], [to.pt[0], to.pt[1]]]
      }
      if (Math.abs(from.pt[0] - to.pt[0]) < 1) return [[from.pt[0], from.pt[1]], [to.pt[0], to.pt[1]]]
      const sepY = round((from.pt[1] + to.pt[1]) / 2)
      return [[from.pt[0], from.pt[1]], [from.pt[0], sepY], [to.pt[0], sepY], [to.pt[0], to.pt[1]]]
    })()
    const [el] = makeEdge(style, id, {
      id: `e${i}`,
      points: pts,
      arrow: true,
      dashed: e.style === 'dashed',
      from: { ref: id(e.from), side: from.side },
      to: { ref: id(e.to), side: to.side },
    })
    edgeEls.push(el)
    elements.push(el)
    // 边标签：放在两个节点之间的空隙里、沿连线错开半格（水平/垂直线上方），不与任何盒子相交
    if (e.label) {
      const fs = Math.max(10, Math.round(style.fontSize * 0.85))
      const tw = Math.min(measure(e.label, fs), Math.max(32, (dir === 'LR' ? Math.abs(to.pt[0] - from.pt[0]) : Math.abs(to.pt[1] - from.pt[1])) - 8))
      const lx = dir === 'LR' ? (from.pt[0] + to.pt[0]) / 2 - tw / 2 : from.pt[0] - tw / 2
      const ly = dir === 'LR' ? from.pt[1] - 18 : (from.pt[1] + to.pt[1]) / 2 - 9
      // 放得下才放：留给标签的净空 = 节点间隙 − 两侧容器 pad − 余量（避免标签压到容器上变成"意外重叠"）
      const free = (dir === 'LR' ? Math.abs(to.pt[0] - from.pt[0]) : Math.abs(to.pt[1] - from.pt[1])) - 2 * (irGroups.length > 1 ? padEff : 0) - 6
      const fits = dir === 'LR' ? free > tw : free > 18
      if (fits) {
        const idl = id(`el${i}`)
        elements.push({ elementId: idl, elementType: 'text', bounds: [round(lx), round(ly), Math.round(tw), 16], content: { text: e.label, fontSize: fs, color: style.ink, align: 'center' } })
        el._labelId = idl
        // 组内连线的标签落在该组容器**内部** ⇒ 必须进容器的 contains（否则"背景×内容"重叠会被判意外）
        const gA = groupOf.get(e.from)
        const gB = groupOf.get(e.to)
        if (gA !== undefined && gA === gB) edgeLabelGroup.set(idl, gA)
      } else {
        notes.push(`连线 ${e.from}→${e.to} 的标签"${e.label}"放不下（间隙不足）⇒ 已省略（不硬塞，避免压字）`)
      }
    }
  })

  // ── 节点与标签 ──
  const nodeEls = []
  nodes.forEach((n, i) => {
    const r = pos.get(n.id)
    if (!r) return
    const emph = n.emphasis ?? 'primary'
    const fill = emph === 'plain' ? style.neutral : (emph === 'accent' ? style.palette[1] ?? style.palette[0] : style.palette[0])
    const shape = { elementId: id(n.id), elementType: 'shape', kind: 'roundRect', bounds: [round(r.x), round(r.y), round(r.w), round(r.h)], fill, line: { color: style.ink, width: style.lineWidth } }
    const fs = style.fontSize
    const lines = wrap(n.label ?? '', r.w - 12, fs, measure)
    const th = lines.length * fs * 1.3
    const txt = { elementId: id(`t_${n.id}`), elementType: 'text', bounds: [round(r.x + 6), round(r.y + Math.max(4, (r.h - th) / 2)), round(r.w - 12), round(Math.min(th + 2, r.h - 4))], content: { text: lines.join('\n'), fontSize: fs, color: emph === 'plain' ? style.ink : '#FFFFFF', align: 'center', wrap: false } }
    shape.contains = [txt.elementId]
    nodeEls.push(shape, txt)
    elements.push(shape, txt)
    if (th + 8 > r.h) notes.push(`节点 "${n.id}" 的标签放不下（${lines.length} 行）⇒ 已按容器裁行，建议缩短文案或放大画布`)
  })

  // ── 分组容器 ──
  // 关键认识（本轮跑出来的）：flow/layers 的连线**都是轴对齐的**，其 AABB 高度/宽度为 0
  // ⇒ 永远不会触发重叠判定（相交要求两个方向都 > TOL）。所以容器**不需要**为了"包住跨组连线"而外扩——
  // 第一版外扩到对方节点边沿，结果两个容器各多出 pad ⇒ 互相重叠 20px（10 个错误）。
  // 现在的做法：容器**紧贴成员 + pad**（彼此不相交），跨组连线不进 contains（它本来也不会被判相交）。
  const containerOf = new Map()
  irGroups.forEach((g) => {
    const members = (g.members ?? []).filter((m) => pos.has(m))
    if (members.length === 0) { notes.push(`分组 "${g.id}" 没有可用成员 ⇒ 只保留逻辑组，不产出容器`); return }
    const rs = members.map((m) => pos.get(m))
    const x0 = Math.min(...rs.map((r) => r.x))
    const y0 = Math.min(...rs.map((r) => r.y))
    const x1 = Math.max(...rs.map((r) => r.x + r.w))
    const y1 = Math.max(...rs.map((r) => r.y + r.h))
    // 组标题占顶部一条（16px）；不给它留位置就会压到节点上 ⇒ 变成"意外重叠"（本轮实测）
    const topPad = g.label ? Math.max(padEff, 20) : padEff
    // 容器必须**夹在画布内**：外扩 pad 可能把容器顶到安全区之外（layers 族实测 [30,20,…] ⇒ out-of-safe-area ×16）。
    // 成员本来就严格在画布内，"向左上收、向右下收"之后 contains 依然成立。
    const cx0 = Math.max(box.x, x0 - padEff)
    const cy0 = Math.max(box.y, y0 - topPad)
    const cx1 = Math.min(box.x + box.w, x1 + padEff)
    const cy1 = Math.min(box.y + box.h, y1 + padEff)
    const cb = {
      x: round(cx0),
      y: round(cy0),
      w: round(cx1 - cx0),
      h: round(cy1 - cy0),
    }
    const cid = id(`g_${g.id}`)
    const gid = id(`grp_${g.id}`) // 组 id 与容器元素 id **必须不同名**（共用命名空间，schema 会拦）
    const myIdx = irGroups.indexOf(g)
    const inner = [
      ...members.map(id), ...members.map((m) => id(`t_${m}`)),
      ...[...edgeLabelGroup.entries()].filter(([, gi]) => gi === myIdx).map(([lid]) => lid),
    ]
    // 带用 **`role: decoration`**（完全豁免重叠）而不是"靠 contains 豁免"：
    // 跨带连线必然有一段竖线走在**节点所在的带内部**，而折线的整体 AABB 有宽有高 ⇒
    // 单靠 contains 豁免不了它（layers 族实测 9 条）。decoration 是"这是背景带"的正确语义，
    // 与 swimlane 的做法一致；`contains` 保留（结构关系语义仍然成立，成员严格在带内）。
    const container = { elementId: cid, elementType: 'shape', kind: 'roundRect', bounds: [cb.x, cb.y, cb.w, cb.h], fill: style.neutral, line: { color: style.ink, width: style.lineWidth }, role: 'decoration', roleReason: '分组带（装饰层：跨带连线穿过属设计意图）', contains: [...new Set(inner)] }
    // 组标题只在**真的有空位**时才放：容器为了不越界会被夹进画布，夹紧后顶部留给标题的空间可能不足 16px，
    // 此时硬放就会压到首个节点上（判为"意外重叠"；压字/压盒都不该靠声明掩盖）。没位置 ⇒ 省略 + 记 note。
    if (g.label && y0 - cb.y >= 16) {
      const lid = id(`gl_${g.id}`)
      elements.push({ elementId: lid, elementType: 'text', bounds: [round(cb.x + 8), round(cb.y + 3), round(Math.min(cb.w - 16, measure(g.label, style.fontSize * 0.85) + 4)), 16], content: { text: g.label, fontSize: Math.max(10, Math.round(style.fontSize * 0.85)), color: style.ink, align: 'left' } })
      container.contains.push(lid)
    } else if (g.label) {
      notes.push(`分组 "${g.id}" 的标题放不下（容器贴到画布边后顶部空间不足）⇒ 已省略标题；需要标题请缩小内容或加大画布`)
    }
    containerOf.set(g.id, container)
    elements.push(container)
    groups.push({ id: gid, ...(g.label ? { label: g.label } : {}), members: [...new Set([...members.map(id), ...members.map((m) => id(`t_${m}`))])] })
  })

  // 容器必须画在节点**下面**（z-order = 数组序）
  const containerSet = new Set(containerOf.values())
  const ordered = [...containerSet, ...elements.filter((e) => !containerSet.has(e))]
  return {
    elements: ordered.map(({ _labelId, ...el }) => el),
    groups,
    notes,
    stats: { nodes: nodes.length, edges: edges.length, groups: irGroups.length, bands: bands.length, containers: containerOf.size },
  }
}

/** 简易换行（词级贪心，CJK 按字）：仅用于节点标签，避免长标签溢出节点。 */
function wrap(text, maxW, fontSize, measure) {
  const s = String(text ?? '')
  if (!s) return ['']
  const words = /[\u3000-\u9fff]/.test(s) ? [...s] : s.split(/\s+/)
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur}${/[\u3000-\u9fff]/.test(s) ? '' : ' '}${w}` : w
    if (measure(next, fontSize) > maxW && cur) { lines.push(cur); cur = w } else cur = next
  }
  if (cur) lines.push(cur)
  return lines
}

export { ATTACH_SIDES }
