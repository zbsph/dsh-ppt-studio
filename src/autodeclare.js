/**
 * 一键声明（反馈 D2 ★★）：把警告级未声明重叠对写入页面 expectedOverlaps。
 * - 保留源文件注释（parseDocument + setIn，不重排全文件）。
 * - 内容互压（content-collision）不会出现在 collectDeclarable 中，必须手工修复。
 */
import { readFile, writeFile } from 'node:fs/promises'
import YAML from 'yaml'
import { collectDeclarable } from './verify.js'

/**
 * @param ctx    resolveDeck 结果（pages[].file 为页面 yaml 绝对路径）
 * @param layout renderDeck 的 layout（pages[] 含 elements/expectedOverlaps/size）
 * @returns [{ page, added }]
 */
export async function applyAutoDeclare(ctx, layout) {
  const added = []
  for (const pageL of layout.pages) {
    const pairs = collectDeclarable(pageL, layout.size)
    if (!pairs.length) continue
    const file = ctx.pages[pageL.index].file
    const text = await readFile(file, 'utf8')
    const doc = YAML.parseDocument(text)
    const existing = (doc.get('expectedOverlaps') ?? []).map((p) => ({
      pair: [String(p?.pair?.[0]), String(p?.pair?.[1])],
    }))
    const exSet = new Set(existing.map((p) => [p.pair[0], p.pair[1]].sort().join('×')))
    const add = pairs
      .filter(([a, b]) => !exSet.has([a, b].sort().join('×')))
      .map(([a, b]) => ({ pair: [a, b] }))
    if (!add.length) continue
    doc.setIn(['expectedOverlaps'], doc.createNode([...existing, ...add], { keepScalarTypes: true }))
    await writeFile(file, String(doc))
    added.push({ page: pageL.index + 1, added: add.length, file })
  }
  return added
}
