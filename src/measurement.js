/**
 * M2 文本实测档（渲染回读精确测量，D3 落地）：
 * 浏览器真测量通道——Edge headless 加载预览 HTML，页面内 JS 采集每个元素的实际
 * 排版几何（getBoundingClientRect / Range.getClientRects 行盒 / scrollHeight），
 * JSON 回传（<script id="__ppt_measured"> 注入 DOM，--dump-dom 提取）。
 * 输出 preview/measured.json（measured 档）供 ppt_verify measured=true 消费。
 *
 * 与估算的关系（D3）：实测=终审、估算=预检——估算报错必须处理（保持门禁）；
 * 实测报错（估算没报）= M2 的核心捕获（估算漏报 → 新增 error）；
 * 无浏览器/路径失败 → 降级估算 + 标注"未实测"（绝不静默）。
 *
 * 诚实声明：测量 = Chromium 排版真值（系统字库）——仍非 PowerPoint 引擎；
 * 与 ppt_shot 同一渲染链（HTML 预览），因此字体/尺寸差异同源。
 */
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/**
 * 测量脚本（注入每个页面 HTML 尾部）：
 * 文本元素 → 行盒（Range.getClientRects）行数/内容高/溢出；其余元素 → 实际几何对照。
 * 结果写入 <script id="__ppt_measured" type="application/json">，dump-dom 可提取。
 */
const MEASURE_JS = `(function(){
  function collect(){
    var out=[];
    var els=document.querySelectorAll('.el');
    for(var i=0;i<els.length;i++){
      var el=els[i]; var r=el.getBoundingClientRect();
      var rec={id:el.id,kind:el.dataset.kind||el.dataset.shape||'',x:Math.round(r.left*100)/100,y:Math.round(r.top*100)/100,w:Math.round(r.width*100)/100,h:Math.round(r.height*100)/100};
      if(el.dataset&&el.dataset.kind==='text'){
        var rects=[];
        var walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
        var n;
        while((n=walker.nextNode())){
          if(!n.textContent||!n.textContent.trim())continue;
          var rng=document.createRange();
          rng.selectNodeContents(n);
          var qs=rng.getClientRects();
          for(var j=0;j<qs.length;j++)rects.push(qs[j]);
        }
        var tops=[];
        for(var k=0;k<rects.length;k++){var t=Math.round(rects[k].top*10)/10;if(tops.indexOf(t)<0)tops.push(t);}
        rec.lines=tops.length;
        rec.clientHeight=el.clientHeight;
        rec.contentHeight=el.scrollHeight;
        rec.overflowY=Math.round((el.scrollHeight-el.clientHeight)*10)/10;
      }
      out.push(rec);
    }
    return out;
  }
  window.addEventListener('load',function(){setTimeout(function(){
    var s=document.createElement('script');
    s.id='__ppt_measured';s.type='application/json';
    try{s.textContent=JSON.stringify(collect());}catch(e){s.textContent='{"__error":'+JSON.stringify(String(e))+'}'}
    document.head.appendChild(s);
  },250)});
})();`

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 注入测量脚本到 HTML（返回新内容）。script 是 raw text：内容原样嵌入（不实体转义——JS 里的 < 会被转坏）。 */
export function injectMeasureScript(html) {
  const tag = `<script>\n${MEASURE_JS}\n</script>`
  if (!html.includes('</body>')) return html + tag
  return html.replace('</body>', tag + '\n</body>')
}

/** 从 dump-dom 输出提取 __ppt_measured JSON。 */
export function extractMeasured(dom) {
  const m = /<script id="__ppt_measured"[^>]*>([\s\S]*?)<\/script>/.exec(dom)
  if (!m) return null
  try {
    const data = JSON.parse(m[1])
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/**
 * 测量一个 deck 项目：render → 每页注入脚本 → Edge dump-dom → 采集 → preview/measured.json。
 * @param dir deck 目录
 * @returns { measured, outDir, browser, pages, notes }（measured.json 已写入 preview/）
 */
export async function measureLayout(dir, { edge } = {}) {
  const { resolveDeck } = await import('./pptd/schema.js')
  const { renderDeck } = await import('./pptd/render-html.js')
  const ctx = await resolveDeck(dir)
  const r = await renderDeck(ctx, {})
  const browser = edge ?? findEdge()
  const notes = []
  if (!browser) {
    notes.push('⚠ 未检测到 Edge/Chrome：实测档不可用（降级估算 + 标注"未实测"）——请用 ppt_verify 保持估算门禁')
    return { measured: null, outDir: r.outDir, browser: null, pages: 0, notes }
  }
  const tmp = join(dir, 'preview', '_measure-tmp')
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  const pages = []
  const t0 = Date.now()
  try {
    // 并发测量（D5 基准：顺序 3.2s/页 → 并发 4 ≈ 0.9s/页；Edge 每页独立实例无共享状态）
    const CONCURRENCY = 4
    const jobs = r.htmlFiles.map((f, i) => ({ f, i }))
    let cursor = 0
    const results = new Array(r.htmlFiles.length).fill(null)
    const errors = new Array(r.htmlFiles.length).fill(null)
    const worker = async () => {
      while (cursor < jobs.length) {
        const idx = cursor++
        const { f, i } = jobs[idx]
        try {
          const src = join(r.outDir, f)
          const html = injectMeasureScript(await readFile(src, 'utf8'))
          const probe = join(tmp, `p${i + 1}.html`)
          await writeFile(probe, html, 'utf8')
          // 独立 user-data-dir：Edge 多实例共用默认 profile → Singleton 锁串行化 + 变慢（shotOne 同款修复）
          const profile = join(tmp, `profile-${i + 1}`)
          await mkdir(profile, { recursive: true })
          const url = 'file:///' + probe.replace(/\\/g, '/')
          const dom = await new Promise((resolve, reject) => {
            const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
              '--dump-dom', '--virtual-time-budget=2500', `--user-data-dir=${profile}`,
              `--window-size=${ctx.size.width},${ctx.size.height}`, url], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
            let outBuf = ''
            child.stdout.on('data', (d) => { outBuf += d })
            child.on('error', reject)
            child.on('exit', (code) => code === 0 ? resolve(outBuf) : reject(new Error(`Edge 退出码 ${code}`)))
          })
          const data = extractMeasured(dom)
          if (!data) { errors[idx] = `第 ${i + 1} 页测量回传失败（DOM 提取空）`; continue }
          if (data.__error) { errors[idx] = `第 ${i + 1} 页测量脚本异常：${data.__error}`; continue }
          results[idx] = { index: i + 1, file: f, elements: data }
        } catch (e) {
          errors[idx] = `第 ${i + 1} 页测量失败：${String(e)}`
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
    for (let i = 0; i < results.length; i++) {
      if (results[i]) pages.push(results[i])
      else if (errors[i]) notes.push(`⚠ ${errors[i]}；该页无实测数据`)
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
  const measured = {
    browser: 'Edge/Chrome headless',
    ts: new Date().toISOString(),
    size: { width: ctx.size.width, height: ctx.size.height },
    pages,
  }
  await writeFile(join(r.outDir, 'measured.json'), JSON.stringify(measured, null, 2))
  return { measured, outDir: r.outDir, browser, pages: pages.length, notes, elapsedMs: Date.now() - t0 }
}
