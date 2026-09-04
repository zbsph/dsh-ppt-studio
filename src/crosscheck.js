/**
 * M3 数据连贯（v0.13）：跨页对账 ——
 * ① 数字对账：同数字（含百分比）在多页出现 → 上下文清单（供识别"值不一致但同一指标"的连贯问题）；
 * ② 证据核查表：页面 source 标注（page.source）→ 数据来源映射状态（有 = grounded；无 = unmapped）；
 * 建议级输出（数据连贯需要语义判断，不进门禁）。
 */
export function crosscheckDeck(ctx) {
  const pages = ctx.pages.map((p, i) => ({
    index: i + 1,
    file: p.ref,
    source: p.page.source ?? null,
    status: p.page.source ? 'grounded' : 'unmapped',
  }))
  const numMap = new Map()
  for (const [i, p] of ctx.pages.entries()) {
    for (const el of p.page.elements ?? []) {
      if (el.elementType !== 'text' && el.elementType !== 'table') continue
      const texts = []
      if (el.elementType === 'text') texts.push(el.content?.text ?? '')
      else {
        for (const row of el.rows ?? []) for (const c of row) texts.push(String(c ?? ''))
      }
      for (const t of texts) {
        if (!t) continue
        const re = /(\d+(?:\.\d+)?)(\s*[%％])?/g
        let m
        while ((m = re.exec(t))) {
          const key = m[1] + (m[2] ? '%' : '')
          const ctx3 = t.slice(Math.max(0, m.index - 10), Math.min(t.length, m.index + m[1].length + 14)).replace(/\s+/g, ' ')
          if (!numMap.has(key)) numMap.set(key, [])
          numMap.get(key).push({ page: i + 1, ctx: ctx3 })
        }
      }
    }
  }
  // 只报跨页重复（>1 页）；按页数降序；上限 30（工具报告 cap，完整数据在输出中截断标注）
  const groups = [...numMap.entries()]
    .filter(([, v]) => new Set(v.map((x) => x.page)).size > 1)
    .map(([num, v]) => ({
      num,
      pages: [...new Set(v.map((x) => x.page))],
      count: v.length,
      contexts: v.slice(0, 6).map((x) => ({ page: x.page, ctx: x.ctx })),
    }))
    .sort((a, b) => b.pages.length - a.pages.length || b.count - a.count)
  return { pages, groups: groups.slice(0, 30), totalGroups: groups.length }
}

/** 输出文本（markdown 表 + 核查表），供工具调用方直接呈现。 */
export function crosscheckReport(ctx) {
  const r = crosscheckDeck(ctx)
  const lines = []
  lines.push(`## 数据连贯核查（${ctx.pages.length} 页）`)
  lines.push(`- 证据状态：grounded ${r.pages.filter((p) => p.status === 'grounded').length} 页 / unmapped ${r.pages.filter((p) => p.status === 'unmapped').length} 页`)
  lines.push(`- 跨页数字 ${r.groups.length} 组（前 10 组展示${r.totalGroups > r.groups.length ? `，其余 ${r.totalGroups - r.groups.length} 组见下】` : ''}）`,)
  lines.push('')
  if (r.pages.some((p) => p.source)) {
    lines.push('| 页 | 数据来源 | 状态 |')
    lines.push('|---|---|---|')
    for (const p of r.pages) lines.push(`| ${p.index} | ${p.source ? `\`${p.source}\`` : '（未标注）'} | ${p.status === 'grounded' ? '✓ grounded' : '⚠ unmapped'} |`)
    lines.push('')
  }
  for (const g of r.groups.slice(0, 10)) {
    lines.push(`**${g.num}** — 出现于页 ${g.pages.join('、')}（${g.count} 处）：`)
    for (const c of g.contexts) lines.push(`  - 第 ${c.page} 页：\`${c.ctx}\``)
    lines.push('')
  }
  if (r.totalGroups > r.groups.length) lines.push(`…（共 ${r.totalGroups} 组跨页数字；运行结果已按页数降序，建议重点核对出现页数最多的组）`)
  lines.push('')
  lines.push('> 语义：数字跨页重复 ≠ 错误（年份/页码/通用数字正常）；需人工判断"同一指标多页值不一致"。建议核查后把关键数字的页面加 `source:` 标注（数据来源），下次核查即 grounded。')
  return lines.join('\n')
}
