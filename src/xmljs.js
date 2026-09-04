/**
 * 极简 XML 解析（pptx 读取用）：去命名空间的标签树。
 * 仅支持我们 OOXML 子集所需：元素/属性/文本/子节点，忽略注释/CDATA 内容按文本。
 */

export function parseXml(xml) {
  let i = 0
  const root = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) break
    if (xml.startsWith('<?', lt) || xml.startsWith('<!--', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt)
      i = end < 0 ? xml.length : end + 1
      continue
    }
    // text
    if (lt > i) appendText(stack[stack.length - 1], xml.slice(i, lt))
    if (xml.startsWith('</', lt)) {
      const end = xml.indexOf('>', lt)
      stack.pop()
      i = end < 0 ? xml.length : end + 1
      continue
    }
    const close = xml.indexOf('>', lt)
    const tagText = xml.slice(lt + 1, close).trim()
    const selfClose = tagText.endsWith('/')
    const body = selfClose ? tagText.slice(0, -1) : tagText
    const spAt = body.search(/\s/)
    const name = spAt < 0 ? body : body.slice(0, spAt)
    // attrs：支持带空格/引号的值（如 typeface="Microsoft YaHei"）——按 = 匹配，不按空格拆
    const attrs = {}
    const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g
    let mm
    let guard2 = 0
    while ((mm = attrRe.exec(body)) !== null && guard2++ < 200) {
      attrs[mm[1]] = mm[2] ?? mm[3] ?? mm[4]
    }
    const node = { tag: local(name), attrs, children: [], text: '' }
    stack[stack.length - 1].children.push(node)
    if (!selfClose) stack.push(node)
    i = close + 1
  }
  return root
}

function appendText(node, s) {
  if (s) node.text += s
}

function unquote(v) {
  const s = v.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}

function local(name) {
  const idx = name.indexOf(':')
  return idx >= 0 ? name.slice(idx + 1) : name
}

export function children(node, tag) {
  return tag ? node.children.filter((c) => c.tag === tag) : node.children
}

export function first(node, tag) {
  return node.children.find((c) => c.tag === tag)
}

export function textOf(node) {
  let out = node.text ?? ''
  for (const c of node.children) {
    if (c.tag === 't') out += c.text ?? ''
  }
  return out
}

export function allText(node) {
  let out = ''
  const walk = (n) => {
    if (n.tag === 't') out += n.text ?? ''
    for (const c of n.children) walk(c)
  }
  walk(node)
  return out
}

export function firstByPath(node, path) {
  let cur = node
  for (const tag of path.split('/')) {
    cur = first(cur, tag)
    if (!cur) return undefined
  }
  return cur
}
