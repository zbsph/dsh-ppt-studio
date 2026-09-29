/**
 * 风格合规检查（Y3）：把"风格实现容易忘的事"变成**机器检查**（阶段 E）
 *
 * 为什么必须有：Y2-4b 实测过一次 —— `badge` 把圆徽塞进卡片却忘了声明 `contains`，
 * 门禁按"设计预期外重叠"报 9 条错误。**风格越自由，越需要机器守这些"结构常识"**。
 * 这就是宪法③"每条特型必须同时带合规检查"的落地形态，也是图族比纯 skill 强的地方：
 * 文档不会拦你，**门禁会**。
 *
 * 本模块是**纯函数**：输入 normalizePage 之后的元素数组（快照形态），输出 findings。
 * 快照形态（实测）：形状 `{id,kind:'shape',bounds:{x,y,w,h},contains,shape,fill}`；
 *                   文本 `{id,kind:'text',bounds,style:{fontSize,color,...}}`。
 * ⇒ 不依赖任何外部状态，便于单测与后续接入 verifyDeck。
 */

const isShape = (e) => e?.kind === 'shape' || e?.elementType === 'shape'
const isText = (e) => e?.kind === 'text' || e?.elementType === 'text'
const idOf = (e) => e?.id ?? e?.elementId ?? '?'
const rectOf = (b) => (Array.isArray(b) ? { x: b[0], y: b[1], w: b[2], h: b[3] } : (b ?? null))
const kindOf = (e) => e?.shape ?? (e?.kind && e.kind !== 'shape' ? e.kind : 'rect')
const pointsOf = (e) => (Array.isArray(e?.points) ? e.points : [])
/** 形状的内部区域（内缩 pad），用于判"某元素是否落在它里面" */
const inside = (r, outer, pad = 2) => !!r && !!outer
  && r.x >= outer.x + pad && r.y >= outer.y + pad
  && r.x + r.w <= outer.x + outer.w - pad && r.y + r.h <= outer.y + outer.h - pad

/** 颜色 → 相对亮度（WCAG 近似）；非 #rrggbb 返回 null */
export function luminance(color) {
  if (typeof color !== 'string') return null
  const m = /^#([0-9a-fA-F]{6})$/.exec(color.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}
/** WCAG 对比度（1..21） */
export function contrastRatio(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return null
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * @param {Array} els 快照形态元素
 * @param {{minContrast?:number}} opts
 * @returns {Array<{code:string,message:string,id:string}>} findings（均为**可声明豁免**的警告级）
 */
export function checkStyleCompliance(els, opts = {}) {
  // 阈值取 3.0（≈WCAG 大号字/加粗字下限）。实测依据：12 族夹具里白字压在琥珀色
  // #F59E0B 上只有 2.15:1 —— 那是**真缺陷**（在已交付页面上确实难读），不是检查误报；
  // 当前批次 fresh-sea 的玫红 #E11D48 上白字 ≈4.2:1 可通过 ⇒ 阈值提到 3.0 不产生噪声。
  const minContrast = opts.minContrast ?? 3.0
  const out = []
  const list = Array.isArray(els) ? els : []
  const shapes = list.filter(isShape)
  const texts = list.filter(isText)

  // ① 结构关系完整性：落在某个形状**内部**的图形，必须被某个 contains 覆盖（含自身容器）
  //    实测背景：badge 漏声明 ⇒ 门禁报"设计预期外重叠"9 条。
  const declared = new Map() // 子 id → 父**列表**（同一元素可能同时被外层底板与卡片声明）
  for (const s of shapes) for (const c of (s.contains ?? [])) {
    if (!declared.has(c)) declared.set(c, [])
    declared.get(c).push(s)
  }
  /** 取"最小面积"的父 = **直接容器**。对比度与溢出必须按直接容器判：
   *  实测教训——文本同时被浅色外层底板与彩色卡片声明时，取外层会把白字判成"低对比度"（5 条误报）。 */
  const parentOf = (childId) => {
    let best = null
    let bestArea = Infinity
    for (const p of declared.get(childId) ?? []) {
      const r = rectOf(p.bounds)
      const a = r ? r.w * r.h : Infinity
      if (a < bestArea) { bestArea = a; best = p }
    }
    return best
  }
  for (const s of shapes) {
    if (s.role === 'decoration' || s.roleReason) continue
    const r = rectOf(s.bounds)
    for (const o of shapes) {
      if (o === s || o.role === 'decoration' || o.roleReason) continue
      const ro = rectOf(o.bounds)
      if (!inside(r, ro)) continue
      if (!(declared.get(idOf(s)) ?? []).some((p) => idOf(p) === idOf(o))) {
        out.push({
          code: 'style-undeclared-containment',
          id: `${idOf(o)} ⊃ ${idOf(s)}`,
          message: `元素 "${idOf(s)}" 落在 "${idOf(o)}" 内部，但**没有**被它的 contains 声明 ⇒ 门禁会按"设计预期外重叠"报错。请把 "${idOf(s)}" 加进 "${idOf(o)}".contains（风格新增卡内元素时最容易忘这一步）`,
        })
      }
    }
  }

  // ② 徽标与标题间距：卡片 contains 里若有椭圆（徽标），卡内文本必须让出栏位
  for (const s of shapes) {
    const kids = (s.contains ?? []).map((cid) => list.find((e) => idOf(e) === cid)).filter(Boolean)
    const badge = kids.find((k) => isShape(k) && kindOf(k) === 'ellipse')
    if (!badge) continue
    const br = rectOf(badge.bounds)
    const texts2 = kids.filter(isText)
    for (const t of texts2) {
      const tr = rectOf(t.bounds)
      if (!tr || !br) continue
      if (tr.x < br.x + br.w - 0.5) {
        out.push({
          code: 'style-badge-too-tight',
          id: `${idOf(s)} · ${idOf(t)}`,
          message: `"${idOf(s)}" 内徽标（右沿 x=${(br.x + br.w).toFixed(1)}）与标题（左沿 x=${tr.x.toFixed(1)}）间距不足 ⇒ 会互压。给标题让出「徽标直径 + 4px」`,
        })
      }
    }
  }

  // ③ 卡内文字溢出：文本矩形不得越出它的容器
  for (const t of texts) {
    const parent = parentOf(idOf(t))
    if (!parent) continue
    const parentId = idOf(parent)
    const pr = rectOf(parent?.bounds)
    const tr = rectOf(t.bounds)
    if (!pr || !tr) continue
    if (tr.x < pr.x - 0.5 || tr.y < pr.y - 0.5 || tr.x + tr.w > pr.x + pr.w + 0.5 || tr.y + tr.h > pr.y + pr.h + 0.5) {
      out.push({
        code: 'style-text-overflow',
        id: `${parentId} · ${idOf(t)}`,
        message: `"${idOf(t)}" 越出容器 "${parentId}"（文本 ${JSON.stringify(tr)} vs 容器 ${JSON.stringify(pr)}）⇒ 文字会溢到卡片外`,
      })
    }
  }

  // ④ 对比度：文本颜色 vs 其容器填充（无填充=白底）
  for (const t of texts) {
    const color = t.style?.color ?? t.content?.color
    const parent = parentOf(idOf(t))
    const bg = parent?.fill && parent.fill !== 'none' ? parent.fill : '#FFFFFF'
    const ratio = contrastRatio(color, bg)
    if (ratio !== null && ratio < minContrast) {
      out.push({
        code: 'style-contrast-low',
        id: `${idOf(t)}`,
        message: `"${idOf(t)}" 文字色 ${color} 与底色 ${bg} 对比度仅 ${ratio.toFixed(2)}:1（阈值 ${minContrast}）⇒ 看不清；换色或声明 contrastExempt`,
      })
    }
  }

  // ⑤ 导轨**不得穿过内容图形**：只对"导轨类"装饰生效（roleReason 含「导轨」）。
  //    刻意不覆盖泳道分隔线等结构性装饰 —— 它们语义上就该横跨整道（实测：早期把它们当导轨会误报）。
  for (const d of list) {
    const isDecor = d.role === 'decoration' || !!d.roleReason
    if (!isDecor || !/导轨/.test(String(d.roleReason ?? ''))) continue
    const pts = pointsOf(d)
    if (pts.length < 2) continue
    for (const s of shapes) {
      if (s === d || s.role === 'decoration' || s.roleReason) continue
      const r = rectOf(s.bounds)
      if (!r) continue
      for (let i = 0; i + 1 < pts.length; i++) {
        const [x1, y1] = pts[i]
        const [x2, y2] = pts[i + 1]
        const x0 = Math.min(x1, x2); const x3 = Math.max(x1, x2)
        const y0 = Math.min(y1, y2); const y3 = Math.max(y1, y2)
        if (x3 > r.x + 2 && x0 < r.x + r.w - 2 && y3 > r.y + 2 && y0 < r.y + r.h - 2) {
          out.push({
            code: 'style-rail-over-content',
            id: `${idOf(d)} × ${idOf(s)}`,
            message: `导轨 "${idOf(d)}" 穿过内容图形 "${idOf(s)}" ⇒ 导轨应走在内容之外（改车道/位置，或把该图形移开）`,
          })
          break
        }
      }
    }
  }

  // ⑥ 连接符（chevron 等非线条图形）尖端必须**贴住目标轮廓**（>2.5px 视为没接上）
  for (const g of shapes) {
    if (kindOf(g) !== 'chevron') continue
    const gr = rectOf(g.bounds)
    if (!gr) continue
    let best = Infinity
    for (const s of shapes) {
      if (s === g || s.role === 'decoration' || s.roleReason) continue
      const r = rectOf(s.bounds)
      if (!r) continue
      const dx = Math.max(r.x - (gr.x + gr.w), gr.x - (r.x + r.w), 0)
      const dy = Math.max(r.y - (gr.y + gr.h), gr.y - (r.y + r.h), 0)
      best = Math.min(best, Math.hypot(dx, dy))
    }
    if (best > 2.5) {
      out.push({
        code: 'style-connector-off-target',
        id: idOf(g),
        message: `连接符 "${idOf(g)}" 离最近的内容图形还有 ${best.toFixed(1)}px ⇒ 尖端没接上（应贴住目标轮廓，±2.5px 内）`,
      })
    }
  }

  // ⑤ 穿禁区（band-crossing，Z2）：连线或文本**穿过预留区**（标题带/导轨栏/标签带…）
  // 预留区的语义是"这块地方已经有人占了" ⇒ 任何后来者压上去都是缺陷（可声明豁免）。
  const bands = Array.isArray(opts.reservedBands) ? opts.reservedBands : []
  if (bands.length) {
    for (const e of list) {
      if (e.role === 'decoration' || e.roleReason) continue
      const r = rectOf(e.bounds)
      const pts = pointsOf(e)
      for (const b of bands) {
        const br = rectOf(b)
        if (!br) continue
        let hit = false
        if (r) hit = r.x < br.x + br.w - 1 && r.x + r.w > br.x + 1 && r.y < br.y + br.h - 1 && r.y + r.h > br.y + 1
        if (!hit && pts.length) {
          for (let i = 0; i + 1 < pts.length && !hit; i++) {
            const [x1, y1] = pts[i]
            const [x2, y2] = pts[i + 1]
            const x0 = Math.min(x1, x2); const x3 = Math.max(x1, x2)
            const y0 = Math.min(y1, y2); const y3 = Math.max(y1, y2)
            hit = x3 > br.x + 1 && x0 < br.x + br.w - 1 && y3 > br.y + 1 && y0 < br.y + br.h - 1
          }
        }
        if (hit) out.push({
          code: 'band-crossing',
          id: `${idOf(e)} × ${b.id}`,
          message: `元素 "${idOf(e)}" **穿过预留区 "${b.id}"（${b.reason ?? ''}）** ⇒ 该区域已被占用（标题带/导轨栏/标签带）；请让连线绕开，或用 roleReason 声明这是有意为之`,
        })
      }
    }
  }

  return out
}
