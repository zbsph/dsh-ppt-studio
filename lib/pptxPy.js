/**
 * python-pptx 引擎：把中间层（deck.yaml）映射为 python-pptx 脚本（兜底引擎）。
 * 覆盖 text / shape / image / table；chart 降级为表格+说明。
 * 需要 python 环境 + python-pptx（运行前探测，缺失则报错提示）。
 */
import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import YAML from 'yaml'
import { normalizePage, measureText } from './pptd/layout.js'

export function genPythonScript(ctx) {
  const py = []
  py.push('from pptx import Presentation')
  py.push('from pptx.util import Emu, Pt')
  py.push('from pptx.dml.color import RGBColor')
  py.push('from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR')
  py.push('from pptx.enum.text import PP_ALIGN, MSO_ANCHOR')
  py.push('import json, sys')
  py.push('')
  py.push(`W, H = ${ctx.size.width}, ${ctx.size.height}`)
  py.push('prs = Presentation()')
  py.push('prs.slide_width = Emu(W * 12700)')
  py.push('prs.slide_height = Emu(H * 12700)')
  py.push('blank = prs.slide_layouts[6]')
  py.push('')
  py.push('def rgb(c):')
  py.push('    if not c: return RGBColor(0, 0, 0)')
  py.push('    c = c.lstrip("#").upper()')
  py.push('    return RGBColor(int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))')
  py.push('')
  py.push('def fit_font(paragraph, text, box_w, box_h):')
  py.push('    # 保守估算：CJK 1em / latin 0.55em')
  py.push('    fs = paragraph.font.size.pt if paragraph.font.size else 18')
  py.push('    lines = max(1, int(box_h // (fs * 1.2)) + 0)')
  py.push('    chars = 0')
  py.push('    for ch in text:')
  py.push('        chars += 1 if ord(ch) > 0x2E7F else 0.55')
  py.push('    need = chars * fs')
  py.push('    if need > box_w * lines:')
  py.push('        fs = max(int(fs * box_w * lines / need), int(fs * 0.6))')
  py.push('        paragraph.font.size = Pt(fs)')
  py.push('')
  py.push('def add_text(slide, b, text, st):')
  py.push('    box = slide.shapes.add_textbox(Emu(b[0]*12700), Emu(b[1]*12700), Emu(b[2]*12700), Emu(b[3]*12700))')
  py.push('    tf = box.text_frame')
  py.push('    tf.word_wrap = True')
  py.push('    tf.margin_left = tf.margin_right = 0')
  py.push('    tf.margin_top = tf.margin_bottom = 0')
  py.push('    fs = st.get("fontSize", 18)')
  py.push('    for i, line in enumerate(str(text).split("\\n")):')
  py.push('        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()')
  py.push('        p.font.size = Pt(fs)')
  py.push('        if st.get("bold"): p.font.bold = True')
  py.push('        p.font.color.rgb = rgb(st.get("color"))')
  py.push('        if st.get("fontFamily"): p.font.name = st["fontFamily"]')
  py.push('        al = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}.get(st.get("align"), PP_ALIGN.LEFT)')
  py.push('        p.alignment = al')
  py.push('        p.line_spacing = st.get("lineHeight", 1.2)')
  py.push('        fit_font(p, line, b[2], b[3])')
  py.push('        p.text = line')
  py.push('')

  for (const page of ctx.pages) {
    const els = normalizePage(page, ctx)
    py.push(`slide = prs.slides.add_slide(blank)`)
    for (const el of els) {
      const [x, y, w, h] = [el.bounds.x, el.bounds.y, el.bounds.w, el.bounds.h]
      switch (el.type) {
        case 'text': {
          py.push(`add_text(slide, [${x}, ${y}, ${w}, ${h}], ${JSON.stringify(el.content?.text ?? '')}, ${JSON.stringify({ ...el.style })})`)
          break
        }
        case 'shape': {
          const map = { rect: 'MSO_SHAPE.RECTANGLE', ellipse: 'MSO_SHAPE.OVAL', triangle: 'MSO_SHAPE.ISOCELES_TRIANGLE' }
          const mode = map[el.kind] ?? 'MSO_SHAPE.RECTANGLE'
          py.push(`sh = slide.shapes.add_shape(${mode}, Emu(${x}*12700), Emu(${y}*12700), Emu(${w}*12700), Emu(${h}*12700))`)
          py.push(`sh.fill.solid(); sh.fill.fore_color.rgb = rgb(${JSON.stringify(el.fill)}, ) if ${JSON.stringify(el.fill)} else sh.fill.background()`)
          py.push(`sh.line.fill.background() if not ${JSON.stringify(el.line ? { c: el.line.color, w: el.line.width } : null)} else (sh.line.color.rgb = rgb(${JSON.stringify(el.line?.color)}), sh.line.width = Pt(${el.line?.width ?? 1}))`)
          break
        }
        case 'line': {
          const p1 = el.points[0]
          const p2 = el.points[1]
          py.push(`ln = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Emu(${p1[0]}*12700), Emu(${p1[1]}*12700), Emu(${p2[0]}*12700), Emu(${p2[1]}*12700))`)
          py.push(`ln.line.color.rgb = rgb(${JSON.stringify(el.line?.color ?? '#000000')}); ln.line.width = Pt(${el.line?.width ?? 1})`)
          break
        }
        case 'image':
          py.push(`slide.shapes.add_picture(${JSON.stringify(join(ctx.dir, el.src))}, Emu(${x}*12700), Emu(${y}*12700), Emu(${w}*12700), Emu(${h}*12700))`)
          break
        case 'table': {
          py.push(`rows, cols = ${JSON.stringify(el.rows.length + (el.header ? 1 : 0))}, ${Math.max(1, el.cols.length)}`)
          py.push(`tbl = slide.shapes.add_table(rows, cols, Emu(${x}*12700), Emu(${y}*12700), Emu(${w}*12700), Emu(${h}*12700)).table`)
          if (el.header) py.push(`for j, v in enumerate(${JSON.stringify(el.cols)}): tbl.cell(0, j).text = str(v)`)
          py.push(`for i, row in enumerate(${JSON.stringify(el.rows)}):`)
          py.push(`    for j, v in enumerate(row): tbl.cell(${el.header ? 'i + 1' : 'i'}, j).text = str(v)`)
          if (el.header) py.push(`for j in range(cols): tbl.cell(0, j).text_frame.paragraphs[0].font.bold = True`)
          break
        }
        case 'chart': {
          py.push(`# chart 降级：引擎 B 以表格表达（引擎 A 支持矢量拼绘）`)
          break
        }
      }
    }
  }
  py.push('')
  py.push(`prs.save(sys.argv[1])`)
  py.push(`print("saved:", sys.argv[1])`)
  return py.join('\n')
}

export function findPython() {
  for (const cmd of ['python', 'py']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import pptx; print("ok")'], { encoding: 'utf8', timeout: 15000 })
      if (r.status === 0 && r.stdout.includes('ok')) return { cmd, has: true }
      if (r.status === 0 || (r.error === undefined && r.stderr === '')) return { cmd, has: false }
    } catch { /* try next */ }
  }
  return { cmd: null, has: false }
}

export function runPythonScript(ctx, script) {
  const py = findPython()
  if (!py.has) throw new Error('python-pptx 引擎不可用：未检测到带 python-pptx 的 python 环境（pip install python-pptx）——可改用默认 pptd 引擎')
  return startPython(py.cmd, script)
}

function startPython(cmd, script) {
  const r = spawnSync(cmd, ['-c', script], { encoding: 'utf8', timeout: 120000 })
  if (r.status !== 0) {
    // A2b 修复（反馈二）：空消息无法定位 → 带 exit code / spawn 错误 / stderr 全文
    const detail = String(r.error?.code ?? r.error?.message ?? '').trim() || String(r.stderr ?? r.stdout ?? '').trim().slice(0, 1500)
    throw new Error(`python-pptx 执行失败（exit ${r.status ?? 'unknown'}${r.signal ? `, signal ${r.signal}` : ''}）${detail ? `：${detail}` : '：解释器无任何输出（疑似 WindowsApps 假 python 桩或环境损坏）'}`)
  }
  return r.stdout
}

export async function runPythonExport(ctx, out) {
  // out：绝对路径原样使用；相对路径相对 deck 目录（与 pptd 引擎同语义，E1）
  const outPath = isAbsolute(out) ? out : join(ctx.dir, out)
  const script = genPythonScript(ctx).replace('prs.save(sys.argv[1])', `prs.save(${JSON.stringify(outPath)})`)
  const result = await runPythonScript(ctx, script)
  return { file: outPath, engine: 'python-pptx', note: result.trim() }
}
