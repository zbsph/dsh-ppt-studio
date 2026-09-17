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
  // OUT 由 runPythonExport 替换成字面量路径（见文件末尾的 replace）。
  // 旧实现是 `prs.save(sys.argv[1])` + `print("saved:", sys.argv[1])`，导出时只替换了 save 那一行，
  // 于是脚本**存完文件后**在 print 处 IndexError（`python -c` 下没有 argv[1]）——文件其实已经写出来了，
  // 调用方却收到"执行失败"。改成变量后再不会有这个错位。
  py.push('OUT = sys.argv[1] if len(sys.argv) > 1 else "out.pptx"')
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
  py.push('def fit_font(font, text, box_w, box_h):')
  py.push('    # 保守估算：CJK 1em / latin 0.55em')
  py.push('    fs = font.size.pt if font.size else 18')
  py.push('    lines = max(1, int(box_h // (fs * 1.2)))')
  py.push('    chars = 0')
  py.push('    for ch in text:')
  py.push('        chars += 1 if ord(ch) > 0x2E7F else 0.55')
  py.push('    need = chars * fs')
  py.push('    if need > box_w * lines:')
  py.push('        fs = max(int(fs * box_w * lines / need), int(fs * 0.6))')
  py.push('        font.size = Pt(fs)')
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
  py.push('        run = p.add_run()')
  py.push('        run.text = line')
  // 样式必须落在 **run** 上：`paragraph.font` 只写 pPr/defRPr，而 `p.text = …` 会新建 run，
  // 之前那种"先设 paragraph.font 再 p.text=" 的写法会把字号/颜色/粗体全部丢掉（导出看着有字、样式全无）。
  py.push('        f = run.font')
  py.push('        f.size = Pt(fs)')
  py.push('        if st.get("bold"): f.bold = True')
  py.push('        f.color.rgb = rgb(st.get("color"))')
  py.push('        if st.get("fontFamily"): f.name = st["fontFamily"]')
  py.push('        p.alignment = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}.get(st.get("align"), PP_ALIGN.LEFT)')
  py.push('        p.line_spacing = st.get("lineHeight", 1.2)')
  py.push('        fit_font(f, line, b[2], b[3])')
  py.push('')

  for (const page of ctx.pages) {
    const els = normalizePage(page, ctx)
    py.push(`slide = prs.slides.add_slide(blank)`)
    for (const el of els) {
      const [x, y, w, h] = [el.bounds.x, el.bounds.y, el.bounds.w, el.bounds.h]
      switch (el.type) {
        case 'text': {
          py.push(`add_text(slide, [${x}, ${y}, ${w}, ${h}], ${JSON.stringify(el.content?.text ?? '')}, ${pyLit({ ...el.style })})`)
          break
        }
        case 'shape': {
          const map = { rect: 'MSO_SHAPE.RECTANGLE', ellipse: 'MSO_SHAPE.OVAL', triangle: 'MSO_SHAPE.ISOCELES_TRIANGLE' }
          const mode = map[el.kind] ?? 'MSO_SHAPE.RECTANGLE'
          py.push(`sh = slide.shapes.add_shape(${mode}, Emu(${x}*12700), Emu(${y}*12700), Emu(${w}*12700), Emu(${h}*12700))`)
          // 填充/描边必须生成**语句**，不能写成单行条件表达式。原实现写的是
          //   `sh.line.fill.background() if not {...} else (sh.line.color.rgb = …, sh.line.width = …)`
          // 一次踩三种雷：① `else (a = b, …)`——赋值是**语句**不是表达式 ⇒ 直接 **SyntaxError**（连编译都过不去）；
          // ② fill/line 缺省时插值出 JS 的 `undefined` / `null`，Python 里不存在 ⇒ NameError；
          // ③ `{color, alpha}` 被 JSON.stringify 成 dict 直接喂给 `rgb()` ⇒ AttributeError。
          // 兜底引擎的全部意义是"pptd 硬失败时还能出片"，它自己语法错就等于没有兜底。
          const solid = fillColorOf(el.fill)
          if (solid) {
            py.push('sh.fill.solid()')
            py.push(`sh.fill.fore_color.rgb = rgb(${JSON.stringify(solid)})`)
            if (isApproxFill(el.fill)) py.push('# 注意：alpha / 渐变在兜底引擎里按纯色近似（原生引擎 pptd 保留原样）')
          } else {
            py.push('sh.fill.background()')
          }
          if (el.line?.color) {
            py.push(`sh.line.color.rgb = rgb(${JSON.stringify(el.line.color)})`)
            py.push(`sh.line.width = Pt(${Number(el.line.width) || 1})`)
          } else {
            py.push('sh.line.fill.background()')
          }
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
          if (el.header) py.push(`for j, v in enumerate(${pyLit(el.cols)}): tbl.cell(0, j).text = str(v)`)
          py.push(`for i, row in enumerate(${pyLit(el.rows)}):`)
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
  py.push(`prs.save(OUT)`)
  py.push(`print("saved:", OUT)`)
  return py.join('\n')
}

/** JS 值 → **Python** 字面量。
 *  为什么不能直接用 JSON.stringify：它产出的是 **JSON**，而 JSON 的 true/false/null 在 Python 里非法。
 *  真 bug 现场：文本元素的样式字典 `{"wrap":true}` 原样进脚本 ⇒ `NameError: name 'true' is not defined`——
 *  而文本是最高频的路径，等于兜底引擎对几乎任何 deck 都不可用。 */
function pyLit(v) {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None'
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(pyLit).join(', ')}]`
  if (typeof v === 'object') return `{${Object.entries(v).map(([k, val]) => `${JSON.stringify(k)}: ${pyLit(val)}`).join(', ')}}`
  return 'None'
}

/** fill 归一化后的取色：'#hex' | {color,alpha} | {type:'gradient',stops} → '#hex' | null（无填充）。 */
function fillColorOf(fill) {
  if (fill == null) return null
  if (typeof fill === 'string') return /^#/.test(fill) ? fill : null
  if (Array.isArray(fill.stops)) return fillColorOf(fill.stops[0]?.color ?? null)
  if (fill.color != null) return fillColorOf(fill.color)
  return null
}

/** 兜底引擎会**近似**的填充（alpha / 渐变）——用于在生成脚本里留下诚实标注，而不是悄悄改变观感。 */
function isApproxFill(fill) {
  return Boolean(fill && typeof fill === 'object'
    && (fill.type === 'gradient' || fill.alpha != null || Array.isArray(fill.stops)))
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
  // 替换 OUT 那一行（不再替换 save 行——旧写法只换 save，导致 print 仍在读 argv[1]：
  //   `python -c` 下没有 argv[1] ⇒ **文件已写出却报执行失败**）
  const script = genPythonScript(ctx).replace(/^OUT = .*$/m, `OUT = ${JSON.stringify(outPath)}`)
  const result = await runPythonScript(ctx, script)
  return { file: outPath, engine: 'python-pptx', note: result.trim() }
}
