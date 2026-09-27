/**
 * 阶段 D-①：样式档案（从**参考稿**观测 → 令牌 → 喂回引擎）。
 *
 * 立场（docs/07 D2 铁律）：**裁决优先级 = 用户口头要求 > 参考稿 > 其他**；引擎自身没有审美。
 * 本模块只做"观测 + 归纳"，把参考稿里**实际出现**的取色、线宽、字号阶梯、圆角归纳成令牌；
 * 再由 `profileToTheme()` 折成一个普通 theme 对象交给既有的 `styleProfileFrom()`——
 * 于是引擎侧**零改动**（它只是换了一份令牌来源）。
 *
 * 数据来源：`observeFromLayout(layout)` 从 layout.json（导入参考稿后渲染出的那份）观测；
 * 也可由调用方直接给 `extractStyleProfile({fills, lineWidths, fontSizes, radii, bg})`。
 */

/** 中性色判定（与 verify.js 的口径一致：RGB 各分量差 ≤ 8）。 */
function isNeutral(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? ''))
  if (!m) return true
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 0xff
  const g = (v >> 8) & 0xff
  const b = v & 0xff
  return Math.abs(r - g) <= 8 && Math.abs(g - b) <= 8 && Math.abs(r - b) <= 8
}
const norm = (hex) => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? ''))
  return m ? `#${m[1].toUpperCase()}` : null
}
const median = (arr) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

/**
 * 从 **deck（原始 DSL 元素）** 观测——比 layout.json 准：原始元素带 `line.width` 与 `content.fontSize`，
 * 而 layout.json 的形状快照只有 `{shape, fill, path, rotation}`（实测 lineWidths 会是空的）。
 */
export function observeFromDeck(ctx) {
  const fills = []
  const lineWidths = []
  const fontSizes = []
  const radii = []
  const bg = norm(ctx?.deck?.theme?.colors?.bg) ?? null
  for (const p of ctx?.pages ?? []) {
    for (const el of p.page?.elements ?? []) {
      if (typeof el.fill === 'string') fills.push(norm(el.fill) ?? el.fill)
      if (el.fill && typeof el.fill === 'object' && typeof el.fill.color === 'string') fills.push(norm(el.fill.color))
      if (el.line?.width) lineWidths.push(Number(el.line.width))
      if (el.content?.fontSize) fontSizes.push(Number(el.content.fontSize))
      if (typeof el.kind === 'string' && /roundRect|ellipse/.test(el.kind)) radii.push(8)
    }
  }
  return { fills: fills.filter(Boolean), lineWidths, fontSizes, radii, bg }
}

/** 便捷入口：deck（resolveDeck 结果）一步到档案 / theme。 */
export function profileFromDeck(ctx) {
  return extractStyleProfile(observeFromDeck(ctx))
}

/** 从 layout.json 观测"参考稿里实际出现了什么"。 */
export function observeFromLayout(layout) {
  const fills = []
  const lineWidths = []
  const fontSizes = []
  const radii = []
  let bg = null
  for (const page of layout?.pages ?? []) {
    if (!bg && typeof page.background === 'string') bg = norm(page.background)
    for (const el of page.elements ?? []) {
      if (typeof el.fill === 'string') fills.push(norm(el.fill) ?? el.fill)
      if (el.fill && typeof el.fill === 'object' && typeof el.fill.color === 'string') fills.push(norm(el.fill.color))
      if (el.line?.width) lineWidths.push(Number(el.line.width))
      if (el.style?.fontSize) fontSizes.push(Number(el.style.fontSize))
      if (el.kind === 'roundRect') radii.push(8)
      if (el.radius) radii.push(Number(el.radius))
    }
  }
  return { fills: fills.filter(Boolean), lineWidths, fontSizes, radii, bg }
}

/**
 * 归纳成样式档案（确定性：按**出现频次**排序，频次相同按色值字典序）。
 * @returns {{palette: string[], ink: string, bg: string, neutral: string, lineWidth: number, fontSize: number, radius: number, observed: object}}
 */
export function extractStyleProfile(observed = {}) {
  const counts = new Map()
  for (const c of observed.fills ?? []) counts.set(c, (counts.get(c) ?? 0) + 1)
  const all = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))
  const colorful = all.filter(([c]) => !isNeutral(c)).map(([c]) => c)
  const neutrals = all.filter(([c]) => isNeutral(c)).map(([c]) => c)
  const bg = norm(observed.bg) ?? neutrals[0] ?? '#FFFFFF'
  // 墨色：中性色里**最深**的那个（参考稿里的文字/描边色）
  const ink = [...neutrals].sort((a, b) => parseInt(a.slice(1), 16) - parseInt(b.slice(1), 16))[0] ?? '#1F2937'
  const lineWidth = median((observed.lineWidths ?? []).filter((n) => n > 0)) ?? 1
  const fontSize = median((observed.fontSizes ?? []).filter((n) => n >= 8)) ?? 14
  const radius = median((observed.radii ?? []).filter((n) => n >= 0)) ?? 8
  return {
    palette: colorful.length ? colorful : ['#2563EB'],
    ink,
    bg,
    neutral: neutrals.find((c) => c !== bg) ?? '#F1F5F9',
    lineWidth: Number(lineWidth),
    fontSize: Number(fontSize),
    radius: Number(radius),
    observed: { fills: [...counts.keys()].sort(), counts: Object.fromEntries(all) },
  }
}

/** 档案 → 普通 theme 对象（交给既有的 styleProfileFrom，引擎零改动）。 */
export function profileToTheme(profile) {
  const colors = {}
  colors.primary = profile.palette?.[0] ?? '#2563EB'
  if (profile.palette?.[1]) colors.accent = profile.palette[1]
  if (profile.palette?.[2]) colors.soft = profile.palette[2]
  colors.text = profile.ink ?? '#1F2937'
  colors.bg = profile.bg ?? '#F8FAFC'
  return {
    colors,
    textStyles: { body: { fontSize: profile.fontSize ?? 14, color: '$text' } },
    line: { width: profile.lineWidth ?? 1 },
    radius: profile.radius ?? 8,
  }
}

/** 便捷入口：layout.json 一步到 theme。 */
export function themeFromLayout(layout) {
  return profileToTheme(extractStyleProfile(observeFromLayout(layout)))
}
