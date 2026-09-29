/**
 * 风格特型（traits）——图族"授人以渔"机制里的**结构特型闭集**（阶段 E / Y2）
 *
 * 设计口径（用户 2026-09-30 明确）：
 *   · **不内置任何风格画像**。风格只有两个来源：① 用户要求优先；② 用户没要求时助手按场景自设计。
 *   · 风格拆两块：**paint（无限、直通）** + **traits（有限闭集、引擎必须"懂"）**。
 *     - paint：颜色/渐变/线宽/字体/圆角/阴影 —— 引擎照搬即可，破坏不了几何；
 *     - traits：会影响**画法**的结构选择（卡片形态、徽标、副标题、连接符形状、导轨、密度…）
 *       ⇒ 引擎必须逐条实现，**未知键或非法值一律报错**（绝不静默忽略——静默忽略会让"风格"悄悄画坏图）。
 *
 * 三条宪法（docs/15）：
 *   ① 风格不得改拓扑与端口；② 风格只可改 间距常量 / 绘制方式 / 附加装饰层；③ 新增做法必须同时带合规检查。
 *
 * 本模块只做三件事：**校验、补默认、把"生效了什么"说清楚**（供族写入 notes，作为"机制是否发挥作用"的过程证据）。
 */

/** traits 闭集：键 → 允许值（数组=枚举；对象=子键枚举）。`true/false` 用 [true,false] 表达。 */
export const TRAIT_SPEC = {
  // 卡片：形态与投影属"结构"（会改文本安全内边距）；填充/描边属 paint（任意，不在此列）
  card: { shape: ['rect', 'roundRect', 'pill'], elevation: ['none', 'soft', 'strong'] },
  badge: ['none', 'number'],              // 状态编号圆徽：会预留卡内左侧栏
  subtitle: [true, false],                // 卡内第二行（进入动作/说明）：会抬高卡片最小高度
  label: ['inside', 'below'],             // 状态名在卡内 / 卡下
  edge: { glyph: ['arrow', 'chevron', 'open'], backStyle: ['solid', 'dashed'] }, // 连接符形状；回边实/虚
  edgeLabel: ['masked', 'plain'],         // 转移标签是否带底板遮线
  markers: ['none', 'startEnd'],          // 初始/终止标记
  density: ['compact', 'normal', 'loose'],// 只影响间距常量（不得影响路由候选集合）
  frame: { title: [true, false], rails: ['none', 'rows', 'return'] }, // 预留带：顶部标题带 / 行导轨 / 回边导轨
}

/** 默认 traits = **今天的行为**（保证"不传 style 时逐像素不变"）。 */
export const DEFAULT_TRAITS = Object.freeze({
  card: Object.freeze({ shape: 'roundRect', elevation: 'none' }),
  badge: 'none',
  subtitle: false,
  label: 'inside',
  edge: Object.freeze({ glyph: 'arrow', backStyle: 'solid' }),
  edgeLabel: 'masked',
  markers: 'none',
  density: 'normal',
  frame: Object.freeze({ title: false, rails: 'none' }),
})

/** 密度步长（只允许改常量；族按此取间距，不得改路由候选与优先级） */
export const DENSITY = Object.freeze({
  compact: { rowGap: 0.85, colGap: 0.9, laneStep: 0.85, pad: 0.9 },
  normal: { rowGap: 1, colGap: 1, laneStep: 1, pad: 1 },
  loose: { rowGap: 1.2, colGap: 1.15, laneStep: 1.15, pad: 1.1 },
})

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 校验并补默认。
 * @returns {{ traits: object, errors: string[], honored: string[] }}
 *   errors：未知特型键 / 非法值（**必须让上层当作校验错误抛出**，不得忽略）
 *   honored：实际生效（与默认不同）的特型说明，供族写入 notes 作为过程证据
 */
export function validateTraits(raw) {
  const errors = []
  const honored = []
  const traits = {
    card: { ...DEFAULT_TRAITS.card },
    edge: { ...DEFAULT_TRAITS.edge },
    frame: { ...DEFAULT_TRAITS.frame },
    badge: DEFAULT_TRAITS.badge,
    subtitle: DEFAULT_TRAITS.subtitle,
    label: DEFAULT_TRAITS.label,
    edgeLabel: DEFAULT_TRAITS.edgeLabel,
    markers: DEFAULT_TRAITS.markers,
    density: DEFAULT_TRAITS.density,
  }
  if (raw === undefined || raw === null) return { traits, errors, honored }
  if (!isPlainObject(raw)) return { traits, errors: [`style.traits 必须是对象，收到 ${typeof raw}`], honored }

  for (const [key, val] of Object.entries(raw)) {
    const spec = TRAIT_SPEC[key]
    if (!spec) {
      errors.push(`未知风格特型 "${key}"（闭集：${Object.keys(TRAIT_SPEC).join(' / ')}）—— 按宪法③，新做法必须先加入闭集并同时提交它的合规检查，不得静默忽略`)
      continue
    }
    if (Array.isArray(spec)) {
      if (!spec.includes(val)) { errors.push(`风格特型 "${key}" 的取值非法：${JSON.stringify(val)}（允许：${spec.map((s) => JSON.stringify(s)).join(' | ')}）`); continue }
      if (val !== DEFAULT_TRAITS[key]) honored.push(`${key}=${JSON.stringify(val)}`)
      traits[key] = val
      continue
    }
    // 子对象（card / edge / frame）
    if (!isPlainObject(val)) { errors.push(`风格特型 "${key}" 必须是对象（子键：${Object.keys(spec).join(' / ')}）`); continue }
    for (const [sub, subVal] of Object.entries(val)) {
      const allowed = spec[sub]
      if (!allowed) { errors.push(`风格特型 "${key}.${sub}" 不在闭集内（允许：${Object.keys(spec).join(' / ')}）`); continue }
      if (!allowed.includes(subVal)) { errors.push(`风格特型 "${key}.${sub}" 的取值非法：${JSON.stringify(subVal)}（允许：${allowed.map((s) => JSON.stringify(s)).join(' | ')}）`); continue }
      if (subVal !== DEFAULT_TRAITS[key][sub]) honored.push(`${key}.${sub}=${JSON.stringify(subVal)}`)
      traits[key][sub] = subVal
    }
  }
  return { traits, errors, honored }
}

/** 过程证据：一句话说清"这套风格实际要求了什么"（族写进 notes） */
export function traitSummary(traits) {
  const t = traits ?? DEFAULT_TRAITS
  return [
    `card=${t.card.shape}/${t.card.elevation}`,
    `badge=${t.badge}`,
    `subtitle=${t.subtitle}`,
    `label=${t.label}`,
    `edge=${t.edge.glyph}/${t.edge.backStyle}`,
    `edgeLabel=${t.edgeLabel}`,
    `markers=${t.markers}`,
    `density=${t.density}`,
    `frame=${t.frame.title ? 'title' : 'no-title'}/${t.frame.rails}`,
  ].join(' ')
}
