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

  // 10. 前景/背景对比度（D6 反馈，P1-1 修正）：文字 vs **最上层（z-order）承载色块**/页面实底
  {
    const contrastExempt = new Set(page.contrastExempt ?? []) // P1-1：已确认承载层深色，豁免对比度建议
    const bgColor = typeof page.background?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(page.background?.color)
      ? page.background.color : null
    for (const el of els) {
      if (el.kind !== 'text' || !el.text?.length) continue
      if (contrastExempt.has(el.id)) continue // P1-1：已确认承载层深色，豁免
      const fg = el.style?.color
      if (typeof fg !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(fg)) continue
      const cx = el.bounds.x + el.bounds.w / 2
      const cy = el.bounds.y + el.bounds.h / 2
      // z-order = 数组序（后绘制者在上层）：从上层往下找第一个含文字中心的实底形状
      let holder = null
      for (let k = els.length - 1; k >= 0; k--) {
        const other = els[k]
        if (other.kind !== 'shape' || typeof other.fill !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(other.fill)) continue
        if (!contains(other.bounds, { x: cx, y: cy, w: 1, h: 1 })) continue
        holder = other.fill
        break
      }
      const base = holder ?? bgColor
      if (!base) continue
      const ratio = contrastRatio(fg, base)
      if (ratio !== null && ratio < 3) {
        const tone = ratio < 1.8 ? '极低（接近不可读）' : '偏低'
        out.push({ severity: 'suggestion', code: 'aesthetic-contrast', id: el.id, message: `文本 "${el.id}" 颜色 ${fg} 与${holder ? '承载色块（最上层）' : '页面背景'} ${base} 对比度 ${ratio.toFixed(2)}（${tone}），建议深字浅底或浅字深底（若已确认承载层深色，可加入本页 contrastExempt 豁免）` })
      }
    }
  }

  // 11. 自定义模板背景未配置安全区（D5 反馈）：背景图为模板（含 logo/页眉页脚带）时提示
  {
    if (page.background?.type === 'image' && !theme?.safeArea && !page.safeArea) {
      out.push({ severity: 'suggestion', code: 'aesthetic-safearea', id: 'safeArea', message: '页面使用图片背景（可能是带 logo/页眉页脚带的模板）：建议在 theme.safeArea（或本页 safeArea）配置非内容区边距，verify 会把安全区外的元素判为出界' })
    }
  }

  // 12. 相邻贴边清单（P2-4 反馈）：非重叠但间隙 < 4px（"安全相切"与"真重叠"分开提示）
  {
    const isContent = (e) => ['text', 'table', 'chart'].includes(e.kind)
    let n = 0
    for (let i = 0; i < els.length && n < 15; i++) {
      for (let j = i + 1; j < els.length && n < 15; j++) {
        const a = els[i].bounds
        const b = els[j].bounds
        if (els[i].kind === 'line' || els[j].kind === 'line') continue
        if (!isContent(els[i]) && !isContent(els[j])) continue // 纯形状贴边（芯片网格缝隙）常见合法，不报
        const vOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        const hOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const hGap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w)
        const vGap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h)
        if (vOverlap > TOL && hGap > TOL && hGap <= 4) {
          out.push({ severity: 'suggestion', code: 'aesthetic-spacing', id: `${els[i].id} × ${els[j].id}`, message: `相邻贴边："${els[i].id}" 与 "${els[j].id}" 水平间隙仅 ${Math.round(hGap)}px（建议 ≥8px 呼吸空间或确认有意）` })
          n++
        } else if (hOverlap > TOL && vGap > TOL && vGap <= 4) {
          out.push({ severity: 'suggestion', code: 'aesthetic-spacing', id: `${els[i].id} × ${els[j].id}`, message: `相邻贴边："${els[i].id}" 与 "${els[j].id}" 垂直间隙仅 ${Math.round(vGap)}px（建议 ≥8px 呼吸空间或确认有意）` })
          n++
        }
      }
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
  const declared = declaredClosure(page) // P0-2：声明闭包（嵌套承载相邻层声明 → 隔层自动通过）
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

  // near-align：左缘/右缘/中线两两差 ∈ (1,6]px（P1-2 修正：同区块才比 + 线元素豁免）
  for (const mode of ['x', 'xr', 'cx']) {
    const keys = els.map((el) => ({
      el, v: mode === 'x' ? el.bounds.x : mode === 'xr' ? el.bounds.x + el.bounds.w : el.bounds.x + el.bounds.w / 2,
    }))
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (keys[i].el.kind === 'line' || keys[j].el.kind === 'line') continue // 引线/箭头天然不对齐
        const a = keys[i].el.bounds
        const b = keys[j].el.bounds
        const vOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        // 同区块：垂直方向实质相邻（同排）；跨区块（不同行/上下分离）不比
        if (vOverlap < Math.min(12, Math.min(a.h, b.h) * 0.5)) continue
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
        message: `密集区（${count} 个元素）位于网格 (${k})，建议重点审阅（线框/架构页常见，可按元素类型比例判断）`,
        area: { x: Math.round(gx), y: Math.round(gy), w: Math.round(pw / COLS), h: Math.round(ph / ROWS) },
      })
    }
  }
  // P2-5：density 分层——按内容元素（text/table/chart）计数，线框图/纯图形页不再误报
  const contentCount = els.filter((e) => ['text', 'table', 'chart'].includes(e.kind)).length
  if (contentCount >= 12) {
    findings.push({ severity: 'warning', code: 'density', id: 'page', message: `页面含 ${contentCount} 个内容元素（文本/表格/图表），信息密度可能过高`, area: { x: 0, y: 0, w: pw, h: ph } })
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
    // 主题一致性（需求 4：统一模板生成基础样式保持的机器保证）——strict=颜色门禁 + 字号建议
    const conf = theme ? themeConformance(page, theme) : []
    findings.push(...conf)
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

/**
 * 主题一致性断言（需求 4「统一模板生成基础样式保持」的机器保证；v0.5.0）：
 * - 元素颜色（text color / shape fill / line color）必须是 theme.colors 成员或中性灰阶；
 *   strict 模式 => ERROR（门禁）；suggest 模式 => warning；off => 跳过。
 * - 字号不在 theme.textStyles => [·] 建议（3-4 级字号阶梯的软约束）。
 * theme.themeConformance: 'strict' | 'suggest' | 'off'（缺省 strict；无 theme.colors 自动跳过）。
 */
/**
 * M2 文本实测档交叉（D3：实测=终审、估算=预检）。
 * @param layout 估算档（layout.json：pages[].elements[].metrics）
 * @param measured 实测档（preview/measured.json：pages[].elements[]）
 * 语义：实测报错（估算没报）= M2 核心捕获（error，估算漏报）；实测复现（估算也报）= warning 佐证；
 *       估算报错但实测通过 = warning（字体差异，人工确认）；行数差异 = suggestion（断行差异目检）。
 */
export function measuredCrossCheck(layout, measured) {
  const out = []
  if (!measured?.pages) return out
  for (const mp of measured.pages ?? []) {
    const lp = (layout.pages ?? []).find((p) => p.index === mp.index)
    if (!lp) continue
    const est = new Map((lp.elements ?? []).map((e) => [e.id, e]))
    for (const el of mp.elements ?? []) {
      const snap = est.get(el.id)
      if (!snap) continue
      if (snap.kind === 'text') {
        const estOv = Number(snap.metrics?.overflowY ?? 0)
        const meaOv = Number(el.overflowY ?? 0)
        if (meaOv > 1 && estOv <= 1) {
          out.push({ severity: 'error', code: 'measured-overflow', id: el.id,
            message: `文本 "${el.id}" 实测溢出（实测 ${meaOv.toFixed(1)}px / 估算 ${estOv.toFixed(1)}px——估算漏报，M2 捕获）：扩大容器或精简文案` })
        } else if (meaOv > 1 && estOv > 1) {
          out.push({ severity: 'warning', code: 'measured-overflow', id: el.id,
            message: `文本 "${el.id}" 实测复现溢出（实测 ${meaOv.toFixed(1)}px / 估算 ${estOv.toFixed(1)}px）：按上方 error 修正` })
        } else if (estOv > 1 && meaOv <= 1) {
          out.push({ severity: 'warning', code: 'measured-relief', id: el.id,
            message: `文本 "${el.id}" 估算报溢出但实测通过（${estOv.toFixed(1)}px / ${meaOv.toFixed(1)}px）——字体渲染差异，人工确认后可忽略估算提示` })
        }
        const estLines = Number(snap.metrics?.lines ?? 0)
        const meaLines = Number(el.lines ?? 0)
        if (estLines > 0 && meaLines > estLines + 1) {
          out.push({ severity: 'suggestion', code: 'measured-lines', id: el.id,
            message: `文本 "${el.id}" 实测 ${meaLines} 行 vs 估算 ${estLines} 行（差 ${meaLines - estLines} 行）——断行差异，重点目检` })
        }
      } else {
        // 非文本几何对照（建议级）；rotation 元素跳过（旋转后 AABB 位移是真实物理，非漂移）
        if (snap.rotation) continue
        const sx = Number(snap.bounds?.x ?? 0)
        const sy = Number(snap.bounds?.y ?? 0)
        const d = Math.hypot(sx - Number(el.x), sy - Number(el.y))
        if (d > 2) {
          out.push({ severity: 'suggestion', code: 'measured-geometry', id: el.id,
            message: `元素 "${el.id}" 实测位置 (${Math.round(el.x)},${Math.round(el.y)}) vs 声明 (${Math.round(sx)},${Math.round(sy)})——漂移 ${Math.round(d)}px` })
        }
      }
    }
  }
  return out
}

export function themeConformance(page, theme) {
  const out = []
  const colors = new Set(Object.values(theme?.colors ?? {}).filter((c) => typeof c === 'string').map((c) => c.toUpperCase()))
  if (!colors.size) return out
  const mode = theme.themeConformance ?? 'strict'
  if (mode === 'off') return out
  const fsSet = new Set(Object.values(theme?.textStyles ?? {}).map((s) => s?.fontSize).filter(Boolean))
  const strayFont = new Map() // fontSize -> [ids]（v0.14.6 降噪：逐元素建议在 >3 处时聚合）
  for (const el of page.elements ?? []) {
    // v0.9.1：fill 为渐变对象时逐个 stop 颜色校验（不再逃过主题色门禁）
    const cs = fillColorsOf(el)
    for (const c of cs) {
      if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) && !colors.has(c.toUpperCase()) && !isNeutral(c)) {
        out.push({
          severity: mode === 'strict' ? 'error' : 'warning',
          code: 'theme-conformance', id: el.id,
          message: `元素 "${el.id}" 颜色 ${c} 不在主题色板（theme.colors）中，请改用主题色或中性色（模板一致性）`,
        })
      }
    }
    if (el.kind === 'text' && el.style?.fontSize && fsSet.size && !fsSet.has(el.style.fontSize)) {
      if (!strayFont.has(el.style.fontSize)) strayFont.set(el.style.fontSize, [])
      strayFont.get(el.style.fontSize).push(el.id)
    }
  }
  if (strayFont.size) {
    const total = [...strayFont.values()].reduce((n, ids) => n + ids.length, 0)
    const sizes = [...strayFont.keys()].sort((a, b) => a - b)
    if (total > 3) {
      // 降噪（反馈 F）：字号建议 >3 处 → 聚合为一条（列出档位与处数），避免淹没门禁级条目
      out.push({ severity: 'suggestion', code: 'aesthetic-theme', id: 'fontStyle',
        message: `字号 ${sizes.join('/')}pt 不在 theme.textStyles 中（本页 ${total} 处文本），建议将已用档位纳入主题样式（页面内可能漂移）` })
    } else {
      for (const [fs, ids] of strayFont) {
        out.push({ severity: 'suggestion', code: 'aesthetic-theme', id: ids[0], message: `字号 ${fs}pt 不在 theme.textStyles 中，建议纳入主题样式（页面内可能漂移）` })
      }
    }
  }
  return out
}

/** 颜色集合（v0.9.1/0.11）：文本色 / 形状 fill（渐变 → stops 颜色；{color, alpha} → color / line 色）。 */
function fillColorsOf(el) {
  if (el.kind === 'text') return [el.style?.color].filter(Boolean)
  if (el.kind === 'shape') {
    const f = el.fill
    if (typeof f === 'string') return [f]
    if (f && Array.isArray(f.stops)) return f.stops.map((s) => s.color).filter(Boolean)
    if (f && f.color) return [f.color]
    return []
  }
  if (el.kind === 'line') return [el.line?.color].filter(Boolean)
  return []
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
  const declared = declaredClosure(page) // P0-2：闭包后已覆盖的隔层对不再建议
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

/**
 * 声明闭包（P0-2 反馈 ★★）：嵌套承载只需声明**相邻层**（如 card×inBox、inBox×inText），
 * 隔层组合（card×inText）由"包含关系传递"自动通过——声明 (a,b)（b 在 a 内）且 c 在 b 内
 * ⇒ (a,c) 视为已声明（迭代至不动点）。语义：承载沿嵌套链传递，避免声明清单膨胀 1/3 的传递对。
 */
function declaredClosure(page) {
  const els = page.elements ?? []
  const decl = buildDeclaredSet(page.expectedOverlaps ?? [])
  const T = 1
  const byId = new Map(els.map((e) => [e.id, e]))
  const inside = (innerBounds, outerBounds) => innerBounds.x >= outerBounds.x - T && innerBounds.y >= outerBounds.y - T
    && innerBounds.x + innerBounds.w <= outerBounds.x + outerBounds.w + T
    && innerBounds.y + innerBounds.h <= outerBounds.y + outerBounds.h + T
  const within = (outerId) => {
    const o = byId.get(outerId)
    if (!o) return []
    return els.filter((e) => e.id !== outerId && inside(e.bounds, o.bounds))
  }
  let changed = true
  let guard = 0
  while (changed && guard++ < 24) {
    changed = false
    for (const key of [...decl]) {
      let [a, b] = key.split(' × ')
      // 定向：pairKey 排序丢失"容器"信息——若 b 包含 a，则交换使 a 为容器、b 为被承载
      const A = byId.get(a)
      const B = byId.get(b)
      if (A && B && inside(A.bounds, B.bounds)) { const t = a; a = b; b = t }
      for (const c of within(b)) {
        const k = [a, c.id].sort().join(' × ')
        if (!decl.has(k)) { decl.add(k); changed = true }
      }
    }
  }
  return decl
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
