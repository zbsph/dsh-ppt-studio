/**
 * 布局断言引擎（数字审阅核心）：输入 layout.json（renderDeck 或引擎快照），
 * 输出机器结果 + markdown 报告。
 *
 * 断言（v1）：
 *  - ERROR out-of-page    元素超出页面边界（永远不可声明）/ 超出安全区（声明制：expectedOutOfSafeArea）
 *  - ERROR overlap        AABB 相交（容差 1px；排除 id 前缀同源组）
 *  - ERROR text-overflow  文本估算高度/宽度超出容器（wrap=false 时宽度计入）
 *  - WARN  near-align     疑似未对齐：同缘差 ∈ (1, 6]px
 *  - WARN  hotspot        元素密集区（网格聚类，供重点审阅）
 *  - WARN  density        单页元素数 ≥ 15（信息密度警示）
 */

const TOL = 1 // px

const NEUTRAL_GRAY_RE = /^#(?:[0-9a-fA-F]{6})$/ // 黑白灰中性色宽判：RGB 各分量近等
function isNeutral(color) {
  if (!color || typeof color !== 'string') return true
  const m = color.match(/^#([0-9a-fA-F]{6})$/)
  if (!m) return true
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 0xff
  const g = (v >> 8) & 0xff
  const b = v & 0xff
  if (Math.abs(r - g) <= 8 && Math.abs(g - b) <= 8 && Math.abs(r - b) <= 8) return true // 灰度/中性
  return false
}

/** 页面美学建议（severity: 'suggestion'，永不作为门禁；冲突断言不受影响）。 */
export function aestheticSuggestions(page, size, theme) {
  const out = []
  const els = page.elements ?? []
  const pw = size.width
  const ph = size.height
  if (els.length < 2) return out
  const themeColors = new Set(Object.values(theme?.colors ?? {}).filter(Boolean))
  const themeFontSizes = new Set(Object.values(theme?.textStyles ?? {}).map((s) => s?.fontSize).filter(Boolean))

  // 1. 元素集重心 vs 页面中心（防"下方留大空白"构图失衡）
  {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const el of els) {
      minX = Math.min(minX, el.bounds.x); minY = Math.min(minY, el.bounds.y)
      maxX = Math.max(maxX, el.bounds.x + el.bounds.w); maxY = Math.max(maxY, el.bounds.y + el.bounds.h)
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const dx = Math.abs(cx - pw / 2) / pw
    const dy = Math.abs(cy - ph / 2) / ph
    if (dx > 0.08) out.push({ severity: 'suggestion', code: 'aesthetic-center', id: 'balance', message: `构图重心水平偏移 ${Math.round(dx * 100)}%（请检查左右留白/元素摆放）` })
    if (dy > 0.08) out.push({ severity: 'suggestion', code: 'aesthetic-center', id: 'balance', message: `构图重心垂直偏移 ${Math.round(dy * 100)}%（请检查上下留白/是否有空白带）` })
  }

  // 2. 外边界一致性（左右边距差）
  {
    const leftM = Math.min(...els.map((e) => e.bounds.x))
    const rightM = Math.min(...els.map((e) => pw - (e.bounds.x + e.bounds.w)))
    if (Math.abs(leftM - rightM) > 20) {
      out.push({ severity: 'suggestion', code: 'aesthetic-margin', id: 'margin', message: `左右外边界不一致（左 ${Math.round(leftM)}px / 右 ${Math.round(rightM)}px），建议对齐` })
    }
  }

  // 3. 左缘列数（散落排版）
  {
    const xs = [...new Set(els.map((e) => Math.round(e.bounds.x / 8) * 8))]
    if (xs.length > 5) out.push({ severity: 'suggestion', code: 'aesthetic-columns', id: 'columns', message: `左缘落在 ${xs.length} 个不同列位，建议收敛到 3-5 列网格` })
  }

  // 4. 同排相邻间距节奏（变异系数）
  {
    const gaps = []
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i].bounds, b = els[j].bounds
        const vOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (vOverlap < Math.min(2, a.h * 0.3, b.h * 0.3)) continue
        const g = b.x - (a.x + a.w)
        if (g > 0 && g < 200) gaps.push(g)
      }
    }
    if (gaps.length >= 4) {
      const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length
      const vars = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length
      const cv = Math.sqrt(vars) / (mean || 1)
      if (cv > 0.9) out.push({ severity: 'suggestion', code: 'aesthetic-rhythm', id: 'spacing', message: `同排间距节奏不统一（${gaps.length} 处间距变异系数 ${cv.toFixed(2)}），建议统一 8/16/24px 节奏` })
    }
  }

  // 5. 网格节奏（坐标/尺寸偏好 8px 基）
  {
    const base = theme?.grid?.base ?? 8
    const off = els.filter((e) => {
      const vals = [e.bounds.x, e.bounds.y, e.bounds.w, e.bounds.h]
      return vals.some((v) => Math.abs(v % base) > 4)
    })
    if (off.length > Math.max(2, els.length * 0.3)) {
      out.push({ severity: 'suggestion', code: 'aesthetic-grid', id: 'grid', message: `${off.length}/${els.length} 个元素偏离 ${base}px 网格节奏（>4px），建议对齐到网格` })
    }
  }

  // 6. 字号层级 + 最小字号
  {
    const fsSet = new Set()
    for (const el of els) {
      if (el.kind === 'text' && el.style?.fontSize) fsSet.add(el.style.fontSize)
    }
    if (fsSet.size > 4) out.push({ severity: 'suggestion', code: 'aesthetic-fonts', id: 'hierarchy', message: `页面字号有 ${fsSet.size} 种（${[...fsSet].join('/')}），建议精简为 3-4 级层级` })
    const minFs = Math.min(...fsSet)
    if (minFs < 12) out.push({ severity: 'suggestion', code: 'aesthetic-fonts', id: 'minimum', message: `最小字号 ${minFs}pt 低于 12pt 建议值，请检查（小字影响放映可读性）` })
    const stray = [...fsSet].filter((f) => !themeFontSizes.has(f))
    if (themeFontSizes.size > 0 && stray.length > 0) {
      out.push({ severity: 'suggestion', code: 'aesthetic-theme', id: 'fontStyle', message: `字号 ${stray.join('/')} 不在 theme.textStyles 中，建议纳入主题样式（页面内可能漂移）` })
    }
  }

  // 7. 主题颜色一致性
  {
    const stray = []
    for (const el of els) {
      const c = el.kind === 'text' ? el.style?.color : el.fill
      if (!c || typeof c !== 'string' || isNeutral(c)) continue
      if (themeColors && themeColors.size > 0 && !themeColors.has(c) && !stray.includes(c)) stray.push(c)
    }
    if (stray.length > 0) {
      out.push({ severity: 'suggestion', code: 'aesthetic-theme', id: 'color', message: `颜色 ${stray.join(' ')} 不在 theme.colors 中，建议改为主题色（风格统一）` })
    }
  }

  // 8. 文本信息密度 / 长句
  {
    for (const el of els) {
      if (el.kind !== 'text' || !el.text?.length) continue
      const text = el.text ?? ''
      if (text.length > 90) out.push({ severity: 'suggestion', code: 'aesthetic-text', id: el.id, message: `文本块 "${el.id}" 达 ${text.length} 字，建议拆点/精简（每块 ≤60 字更易读）` })
      const longest = text.split(/[。；！？\n]/).reduce((a, b) => (a.length >= b.length ? a : b), '')
      if (longest.length > 45) out.push({ severity: 'suggestion', code: 'aesthetic-text', id: el.id, message: `出现 ${longest.length} 字长句（"${longest.slice(0, 24)}…"），建议断句/分点表达` })
      const lineLong = text.split(/\n/).some((l) => l.replace(/\s/g, '').length > 34)
      if (lineLong) out.push({ severity: 'suggestion', code: 'aesthetic-text', id: el.id, message: `文本 "${el.id}" 存在单行超 34 字的长行，建议显式断行` })
    }
  }

  // 9. 孤独字/破句（D7 反馈）：自动换行 ≥2 行且末行估算宽 < 1.5×fontSize → 提示显式断行
  {
    const fs = (el) => el.style?.fontSize ?? 18
    for (const el of els) {
      if (el.kind !== 'text') continue
      const text = el.text ?? ''
      const m = el.metrics ?? {}
      const lines = m.lineWidths ?? []
      if (text.includes('\n') || lines.length < 2 || m.overflowY > 0) continue
      const last = lines[lines.length - 1]
      if (last < fs(el) * 1.5) {
        out.push({ severity: 'suggestion', code: 'aesthetic-text', id: el.id, message: `文本 "${el.id}" 自动换行后末行仅余 ${Math.round(last)}px（约 ${Math.round(last / fs(el))} 字），建议在语义断点显式断行避免孤字` })
      }
    }
  }

  // 10. 前景/背景对比度（D6 反馈）：文字色 vs 承载形状/页面实底背景
  {
    const bgColor = typeof page.background?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(page.background?.color)
      ? page.background.color : null
    for (const el of els) {
      if (el.kind !== 'text' || !el.text?.length) continue
      const fg = el.style?.color
      if (typeof fg !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(fg)) continue
      const cx = el.bounds.x + el.bounds.w / 2
      const cy = el.bounds.y + el.bounds.h / 2
      let holder = null
      let holderArea = 0
      for (const other of els) {
        if (other.kind !== 'shape' || typeof other.fill !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(other.fill)) continue
        if (!contains(other.bounds, { x: cx, y: cy, w: 1, h: 1 })) continue
        const area = other.bounds.w * other.bounds.h
        if (area > holderArea) { holder = other.fill; holderArea = area }
      }
      const base = holder ?? bgColor
      if (!base) continue
      const ratio = contrastRatio(fg, base)
      if (ratio !== null && ratio < 3) {
        const tone = ratio < 1.8 ? '极低（接近不可读）' : '偏低'
        out.push({ severity: 'suggestion', code: 'aesthetic-contrast', id: el.id, message: `文本 "${el.id}" 颜色 ${fg} 与${holder ? '承载色块' : '页面背景'} ${base} 对比度 ${ratio.toFixed(2)}（${tone}），建议深字浅底或浅字深底` })
      }
    }
  }

  // 11. 自定义模板背景未配置安全区（D5 反馈）：背景图为模板（含 logo/页眉页脚带）时提示
  {
    if (page.background?.type === 'image' && !theme?.safeArea && !page.safeArea) {
      out.push({ severity: 'suggestion', code: 'aesthetic-safearea', id: 'safeArea', message: '页面使用图片背景（可能是带 logo/页眉页脚带的模板）：建议在 theme.safeArea（或本页 safeArea）配置非内容区边距，verify 会把安全区外的元素判为出界' })
    }
  }

  return out
}

export function analyzePage(page, size) {
  const findings = []
  const els = page.elements ?? []
  const pw = size.width
  const ph = size.height
  const sa = page.safeArea ?? null // {top,bottom,left,right}；安全区外视为出界
  const minX = sa?.left ?? 0
  const minY = sa?.top ?? 0
  const maxX = pw - (sa?.right ?? 0)
  const maxY = ph - (sa?.bottom ?? 0)
  const declared = buildDeclaredSet(page.expectedOverlaps ?? [])
  const outOfSafe = new Set(page.expectedOutOfSafeArea ?? []) // 出界分级声明制（C3 修订）
  const lenient = page.overlapMode === 'lenient'
  const pairKey = (a, b) => [a, b].sort().join(' × ')

  for (const el of els) {
    const b = el.bounds
    // 出界分级：超页面边界 = 永远 ERROR（不可声明）；超安全区（仍在页面内）= 声明制
    const outOfPage = b.x < -TOL || b.y < -TOL || b.x + b.w > pw + TOL || b.y + b.h > ph + TOL
    const outOfSafeArea = !outOfPage && sa && (b.x < minX - TOL || b.y < minY - TOL || b.x + b.w > maxX + TOL || b.y + b.h > maxY + TOL)
    if (outOfPage) {
      findings.push({
        severity: 'error', code: 'out-of-page', id: el.id,
        message: `元素 "${el.id}" 超出页面边界：${fmtRect(b)}（页面 ${pw}×${ph}）—— 超页面边界不可声明，请修正`,
        area: b,
      })
    } else if (outOfSafeArea) {
      if (outOfSafe.has(el.id)) {
        // 设计声明确认：有意落在模板页眉页脚带（✓ 预期出界）
        findings.push({
          severity: 'confirmed', code: 'expected-out-of-safe', id: el.id,
          message: `预期出界（安全区外，设计声明确认）："${el.id}"（安全区 ${fmtSa(sa)}）`,
          area: b,
        })
      } else {
        findings.push({
          severity: 'error', code: 'out-of-page', id: el.id,
          message: `元素 "${el.id}" 超出页面安全区：${fmtRect(b)}（页面 ${pw}×${ph}，安全区 ${fmtSa(sa)}）—— 如属有意设计（logo/角标等），请将 "${el.id}" 加入本页 expectedOutOfSafeArea 后重验`,
          area: b,
        })
      }
    }
    // text overflow（wrap=true 只判垂直；wrap=false 判水平）
    if (el.kind === 'text') {
      const m = el.metrics ?? {}
      const wrap = el.style?.wrap !== false
      const ox = m.overflowX ?? 0
      const oy = m.overflowY ?? 0
      if (wrap && oy > TOL) {
        findings.push({
          severity: 'error', code: 'text-overflow', id: el.id,
          message: `文本 "${el.id}" 垂直溢出 ${oy}px（估算高 ${Math.round(m.textH ?? 0)}px / 容器高 ${b.h}px）`,
          area: b,
        })
      } else if (!wrap && ox > TOL) {
        findings.push({
          severity: 'error', code: 'text-overflow', id: el.id,
          message: `文本 "${el.id}" 水平溢出 ${ox}px（估算宽 ${Math.round(m.textW ?? 0)}px / 容器宽 ${b.w}px，wrap=false）`,
          area: b,
        })
      }
    }
  }

  // overlap（层叠意图语义模型；按 z-order：数组序 = 绘制序，后者在上层）
  // - 内容面×内容面（text/table/chart 互压）→ ERROR（"元素区块冲突"真正要防的）
  // - 内容面×承载面（shape/image 作底板/图片上标注/图表内注释）→ warning（合法设计）
  // - 承载面×承载面（装饰叠加）→ warning
  // - line 参与（引线/箭头跨越图案）→ warning
  // - 显式 role（background/content/decoration）覆盖推断，且可完全豁免
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i].bounds
      const b = els[j].bounds
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (ox > TOL && oy > TOL) {
        const ki = els[i].kind
        const kj = els[j].kind
        const ri = roleOf(els[i])
        const rj = roleOf(els[j])
        if (ri === 'decoration' || rj === 'decoration') continue // 显式声明装饰层：完全豁免（记录在元素 role 中）
        let severity = 'error'
        let code = 'overlap'
        let note = ''
        if (ki === 'line' || kj === 'line') {
          severity = 'warning'
          note = '—— 连线/箭头跨越，视为引导或标注线'
        } else if (ri === 'content' && rj === 'content') {
          severity = 'error'
          code = 'content-collision'
          note = '—— 内容互压（文字/表格/图表相互遮挡），不可声明豁免，请调整布局'
        } else {
          severity = 'warning'
          note = '—— 层叠承载/装饰模式（底色块、图片标注等）'
        }
        // 设计意图对照：warning 类重叠逐对与 expectedOverlaps 比对
        if (severity === 'warning') {
          const key = pairKey(els[i].id, els[j].id)
          if (declared.has(key)) {
            findings.push({ severity: 'confirmed', code: 'expected-overlap', id: key, message: `预期重叠（设计声明确认）：${key}`, area: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), w: ox, h: oy } })
            continue
          }
          if (!lenient) {
            severity = 'error'
            code = 'unexpected-overlap'
            note = '—— 设计预期外重叠：请修正布局，或若该重叠是有意设计请将元素对加入页面 expectedOverlaps 后重验'
          } else {
            note += '（lenient 模式：未声明重叠仅提示，建议补声明或修正）'
          }
        }
        findings.push({
          severity, code, id: `${els[i].id} × ${els[j].id}`,
          message: `元素 "${els[i].id}" 与 "${els[j].id}" 重叠（交叠 ${ox}×${oy}px）${note}`,
          area: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), w: ox, h: oy },
        })
      }
    }
  }

  // near-align：左缘/右缘/中线两两差 ∈ (1,6]px
  for (const mode of ['x', 'xr', 'cx']) {
    const keys = els.map((el) => ({
      el, v: mode === 'x' ? el.bounds.x : mode === 'xr' ? el.bounds.x + el.bounds.w : el.bounds.x + el.bounds.w / 2,
    }))
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const d = Math.abs(keys[i].v - keys[j].v)
        if (d > TOL && d <= 6) {
          findings.push({
            severity: 'warning', code: 'near-align', id: `${keys[i].el.id} × ${keys[j].el.id}`,
            message: `疑似未对齐： "${keys[i].el.id}" 与 "${keys[j].el.id}" 的${mode === 'x' ? '左缘' : mode === 'xr' ? '右缘' : '中线'}差 ${Math.round(d * 10) / 10}px`,
            area: union(keys[i].el.bounds, keys[j].el.bounds),
          })
        }
      }
    }
  }

  // hotspot：6×4 网格元素密度
  const COLS = 6
  const ROWS = 4
  const grid = new Map()
  for (const el of els) {
    const cx = Math.min(COLS - 1, Math.floor((el.bounds.x + el.bounds.w / 2) / (pw / COLS)))
    const cy = Math.min(ROWS - 1, Math.floor((el.bounds.y + el.bounds.h / 2) / (ph / ROWS)))
    const k = `${cx},${cy}`
    grid.set(k, (grid.get(k) ?? 0) + 1)
  }
  for (const [k, count] of grid) {
    if (count >= 5) {
      const [cx, cy] = k.split(',').map(Number)
      const gx = cx * (pw / COLS)
      const gy = cy * (ph / ROWS)
      findings.push({
        severity: 'warning', code: 'hotspot', id: 'density',
        message: `密集区（${count} 个元素）位于网格 (${k})，建议重点审阅`,
        area: { x: Math.round(gx), y: Math.round(gy), w: Math.round(pw / COLS), h: Math.round(ph / ROWS) },
      })
    }
  }
  if (els.length >= 15) {
    findings.push({ severity: 'warning', code: 'density', id: 'page', message: `页面含 ${els.length} 个元素，信息密度可能过高`, area: { x: 0, y: 0, w: pw, h: ph } })
  }

  return findings
}

export function verifyDeck(layout) {
  const out = []
  const size = layout.size ?? { width: 960, height: 540 }
  const theme = layout.theme ?? null
  let total = 0
  for (const page of layout.pages ?? []) {
    const findings = analyzePage(page, size)
    const suggestions = theme ? aestheticSuggestions(page, size, theme) : []
    const confirmed = findings.filter((f) => f.severity === 'confirmed')
    const errors = findings.filter((f) => f.severity === 'error')
    const warns = findings.filter((f) => f.severity === 'warning')
    total += findings.length + suggestions.length
    const confOverlap = confirmed.filter((f) => f.code === 'expected-overlap').length
    const confOut = confirmed.filter((f) => f.code === 'expected-out-of-safe').length
    const confirmNote = [confOverlap ? `${confOverlap} 预期重叠✓` : '', confOut ? `${confOut} 预期出界✓` : ''].filter(Boolean).join(' / ')
    out.push(`## 第 ${page.index + 1} 页（${page.name}） ｜ ${errors.length} 错误 / ${warns.length} 警告 / ${suggestions.length} 建议${confirmNote}`)
    if (findings.length === 0) out.push('  ✓ 核心断言无问题')
    for (const f of findings) {
      if (f.severity === 'confirmed') continue
      out.push(`  - [${f.severity === 'error' ? '✗' : '~'}] ${f.code}｜${f.message}`)
    }
    for (const s of suggestions) {
      out.push(`  - [·] ${s.code}｜${s.message}`)
    }
  }
  return { text: out.join('\n'), total, size }
}

function fmtRect(b) { return `[${Math.round(b.x)}, ${Math.round(b.y)}, ${Math.round(b.w)}, ${Math.round(b.h)}]` }

function fmtSa(sa) {
  return `上${sa.top ?? 0} 下${sa.bottom ?? 0} 左${sa.left ?? 0} 右${sa.right ?? 0}`
}

/**
 * 一键声明数据源（反馈 D2 ★★）：收集页面上所有"警告级未声明重叠对"——
 * 承载/装饰模式（shape×text、image×text、line×任意），不含内容互压（content-collision
 * 不可声明）、不含 decoration（已豁免）、不含已声明对。返回 [[idA, idB], ...]。
 */
export function collectDeclarable(page, size) {
  const out = []
  const els = page.elements ?? []
  const declared = buildDeclaredSet(page.expectedOverlaps ?? [])
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i].bounds
      const b = els[j].bounds
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (ox <= TOL || oy <= TOL) continue
      const ri = roleOf(els[i])
      const rj = roleOf(els[j])
      if (ri === 'decoration' || rj === 'decoration') continue // 已完全豁免，无需声明
      if (ri === 'content' && rj === 'content') continue // 内容互压：不可声明豁免
      const key = pairKeyOf(els[i].id, els[j].id)
      if (declared.has(key)) continue
      out.push([els[i].id, els[j].id])
    }
  }
  return out
}

function pairKeyOf(a, b) { return [a, b].sort().join(' × ') }

/** WCAG 相对亮度（支持 #rrggbb；其余返回 null）。 */
function relLum(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex ?? ''))
  if (!m) return null
  const v = parseInt(m[1], 16)
  const conv = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * conv((v >> 16) & 0xff) + 0.7152 * conv((v >> 8) & 0xff) + 0.0722 * conv(v & 0xff)
}

function contrastRatio(a, b) {
  const la = relLum(a)
  const lb = relLum(b)
  if (la === null || lb === null) return null
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

function contains(outer, inner) {
  const T = 1
  return inner.x >= outer.x - T && inner.y >= outer.y - T
    && inner.x + inner.w <= outer.x + outer.w + T && inner.y + inner.h <= outer.y + outer.h + T
}

/** 设计声明集合：expectedOverlaps: [{pair: [idA, idB]}] → Set("A × B" 排序键)。 */
function buildDeclaredSet(list) {
  const set = new Set()
  for (const po of list ?? []) {
    if (po && Array.isArray(po.pair) && po.pair.length === 2) {
      set.add([po.pair[0], po.pair[1]].sort().join(' × '))
    }
  }
  return set
}

/** 层叠角色：显式 role（background/content/decoration）覆盖推断；
 *  默认推断：text/table/chart=content；shape/image=background；line=line（任意参与告警）。
 *  decoration = 完全豁免（声明为纯装饰层，不参与重叠报告）。 */
function roleOf(el) {
  const r = el.role
  if (r === 'background' || r === 'content' || r === 'decoration') return r
  if (el.kind === 'line') return 'line'
  if (el.kind === 'text' || el.kind === 'table' || el.kind === 'chart') return 'content'
  return 'background' // shape/image
}

function union(a, b) {
  return {
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
    h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y),
  }
}
