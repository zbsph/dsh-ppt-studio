/**
 * PPT 预览服务（需求 A「对话内看 PPT」，v0.6.0）：
 * host 侧：webServer 注册 `/ppt-preview/` 前缀路由，静态服务于"预览根"。
 * - 预览根 = ~/.dsh/ppt-studio/preview/<token>/：pages/（render 的 html）+ media/（deck 媒体）。
 *   render 输出的 html 引用 `../media/`（相对 deck 根）→ 预览根内 pages/../media/ 恰好解析。
 * - URL 为同源相对路径（/ppt-preview/<token>/pages/deck.html）：GUI 页面本身就在 host 上，
 *   点击/iframe 均同源，不依赖端口探测。
 */
import { mkdir, rm, copyFile, cp, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, extname, normalize } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { resolveDeck } from './pptd/schema.js'
import { renderDeck } from './pptd/render-html.js'

export const PREVIEW_ROOT = join(homedir(), '.dsh', 'ppt-studio', 'preview')
const tokens = new Map() // token -> previewRoot

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
}

/**
 * 构建预览根并分配 token。返回 { token, url, pages, previewRoot }。
 * render 复用预览管道（preview/*.html + layout.json），再拷贝到隔离预览根。
 */
export async function buildPreview(dir) {
  const ctx = await resolveDeck(dir)
  const r = await renderDeck(ctx, {})
  const token = createHash('md5').update(dir).digest('hex').slice(0, 10)
  const root = join(PREVIEW_ROOT, token)
  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, 'pages'), { recursive: true })
  for (const f of r.htmlFiles) {
    await copyFile(join(dir, 'preview', f), join(root, 'pages', f))
  }
  await copyFile(join(dir, 'preview', 'deck.html'), join(root, 'pages', 'deck.html'))
  // media（含页面背景图与**子目录**；html 以 ../media/ 引用）
  // 2026-09-26 修复：旧实现只 `readdir` 顶层再逐个 `copyFile` —— 目录条目会被当文件拷，Windows 上直接
  //   `EPERM: operation not permitted, copyfile '<deck>\media\sub' -> '<preview>\media\sub'`
  //   ⇒ `buildPreview` 整体抛出、`ppt_preview` 直接失败（**不是"缺图"**），预览根还留下半成品。
  //   DSL 允许 `media/子目录/x.png`（schema 对 image.src 只校验是字符串、未禁止子目录），文档也从未声明"平铺"，
  //   所以这里改成整目录镜像。`cp(recursive)` 保留相对路径 ⇒ 路由层（previewFileFor + join）本就能服务子路径。
  if (existsSync(join(dir, 'media'))) {
    await cp(join(dir, 'media'), join(root, 'media'), { recursive: true })
  }
  tokens.set(token, root)
  // 持久化映射（跨进程/重启后链接仍可用）：.meta.json 记录源目录
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, '.meta.json'), JSON.stringify({ sourceDir: dir, token }))
  } catch { /* 非致命 */ }
  return {
    token,
    url: `/ppt-preview/${token}/pages/${r.htmlFiles[0]}`,
    overviewUrl: `/ppt-preview/${token}/pages/deck.html`,
    pages: r.htmlFiles.length,
    previewRoot: root,
  }
}

/** token → 预览根（内存优先，miss 时从 .meta.json 恢复并回填）。 */
async function resolveToken(token) {
  if (tokens.has(token)) return tokens.get(token)
  const root = join(PREVIEW_ROOT, token)
  try {
    const meta = JSON.parse(await readFile(join(root, '.meta.json'), 'utf8'))
    if (meta?.sourceDir) {
      tokens.set(token, root)
      return root
    }
  } catch { /* miss */ }
  return null
}

/**
 * 装配双源（注入器 registry 恢复 + agent preset 行挂载）可能同时挂载本插件——
 * 「duplicate /ppt-preview」崩溃的根因（时序竞态）。路由注册幂等化，**双重防线**：
 * ① **以 webServer 前缀表为皇帝位**——注册前先查表：已有 /ppt-preview（无论谁注册的、
 *    refcount 状态如何）→ 跳过注册（只计数）；防任何时序的双注册。
 * ② refcount 管理（globalThis，跨模块实例共享；双源经 junction/真实路径可能是两个
 *    ESM 实例，模块级变量不可靠）。
 * **v0.14.5 补**：卸载器 u() 是异步的（u() 返回 Promise，未 await 会导致"卸载未完成时
 *   新注册 → duplicate"——v0.14.4 取消路径实测复现）；卸载路径全部 await。
 */
const ROUTE_REG = globalThis.__pptRouteReg ?? { count: 0, unreg: null }
globalThis.__pptRouteReg = ROUTE_REG

/** 卸载决策：count 归零且有卸载器 → await 卸载（失败保留残留，由表判据挡住重复注册）。 */
async function releaseRouteWhenZero() {
  if (ROUTE_REG.count === 0 && ROUTE_REG.unreg) {
    const u = ROUTE_REG.unreg
    ROUTE_REG.unreg = null
    try { await u() } catch { /* 幂等；残留由注册前表判据兜底 */ }
  }
}

/**
 * 调用 `webServer.register` 并**归一化**它的返回值与异常。
 *
 * 真契约（2026-09-26 实测 DSH 0.1.7-rc.2，源码 `dsh-host-webserver/lib/index.js:177-184`）：
 * register 是**同步**方法 —— 成功返回 disposer **函数**，重复注册**同步抛错**（不是 Promise！）。
 * 历史实现写的是 `ws.register({...}).then(...)`：
 *   对同步返回的函数调 `.then` 立即 TypeError，而它是在 `apply()` 里**同步抛出**的
 *   ⇒ **整个插件条目激活失败**（桌面端实测："1 entry did not activate ppt-studio"），
 *   用户连 `ppt_state` 都调不到。假对象当时写成 async，给这个 bug 背了书（smoke §29 已改真契约）。
 *
 * 这里吃三种返回形态：同步函数 / Promise<函数> / `{dispose()}` 对象；同步抛错归一成 `{ thrown }`
 * （不向外抛：预览只是附加能力，不该让插件整体装不上）。
 */
function attemptRegister(ws, makeRoute) {
  try {
    return { value: ws.register(makeRoute()) }
  } catch (error) {
    return { thrown: error }
  }
}

/** 注册预览路由（返回 disposer；无 webServer 环境返回 null）。 */
export function registerPreviewRoute(ctx) {
  const ws = ctx.get('webServer')
  if (!ws) return null
  const hasRoute = () => (ws.prefixes?.has?.('/ppt-preview') ?? false) === true
  if (hasRoute() || ROUTE_REG.count > 0) {
    // 幂等分支：表已注册（任何来源）或本组已发起注册 → 只计数，不重复注册
    ROUTE_REG.count++
    // Cordis 语义：`ctx.effect(cb)` 立即执行 cb、用其**返回值**当 disposer。
    // 这里必须"返回一个函数"——原实现把 `count--` 写在 cb 体里，等于注册当刻就递减，
    // 于是本文档承诺的"首个注册者真注册、最后卸载者真卸载"实际不成立（路由永不释放）。
    // 2026-09-14 修正（与 index.js 的装配防重同一处语义错误）。
    return ctx.effect(() => () => { ROUTE_REG.count--; void releaseRouteWhenZero() }, 'ppt-studio: preview route (ref)')
  }
  let cancelled = false
  const reg = attemptRegister(ws, () => ({
    kind: 'prefix',
    path: '/ppt-preview', // prefix 语义：path 不带尾斜杠（实测：带斜杠不命中）
    async handler(req, res) {
      try {
        const u = new URL(req.url ?? '/', 'http://localhost') // 仅作为解析相对路径的基准，不用于输出
        // token 允许字母/数字/连字符（hex 预览 token 与固定 token 均匹配；v0.14.1 曾因 [a-zA-Z0-9]+ 不含 '-' 导致画廊 404）
        const m = u.pathname.match(/^\/ppt-preview\/([a-zA-Z0-9-]+)\/(.*)$/)
        if (!m) return notFound(res)
        const root = await resolveToken(m[1])
        const file = root ? previewFileFor(root, m[2]) : null
        if (!file || !existsSync(file)) return notFound(res)
        const st = await stat(file)
        if (st.isDirectory()) return notFound(res)
        const buf = await readFile(file)
        res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
        res.end(buf)
      } catch {
        res.writeHead(500)
        res.end('preview error')
      }
    },
  }))
  if (reg.thrown) {
    // 重复注册（并发装配的另一路已抢先注册）⇒ 按上方表判据语义：只计数，不再注册。
    ROUTE_REG.count++
    return ctx.effect(() => () => { ROUTE_REG.count--; void releaseRouteWhenZero() }, 'ppt-studio: preview route (dup)')
  }
  const unregPromise = Promise.resolve(reg.value).then(async (u) => {
    const dispose = typeof u === 'function' ? u : (u && typeof u.dispose === 'function' ? () => u.dispose() : null)
    if (cancelled) { if (dispose) { try { await dispose() } catch { /* 幂等 */ } } ; return null }
    ROUTE_REG.unreg = dispose
    return dispose
  }).catch(() => null)
  ROUTE_REG.count++
  // 同上：cb 立即执行、返回值是 disposer —— 清理逻辑必须包在**返回的函数**里。
  return ctx.effect(() => () => {
    ROUTE_REG.count--
    if (cancelled) return
    if (ROUTE_REG.unreg) { void releaseRouteWhenZero(); return }
    cancelled = true
    unregPromise.then(() => releaseRouteWhenZero())
  }, 'ppt-studio: preview route')
}

/**
 * 把 `/ppt-preview/<token>/` 之后的**原始请求路径**解析成预览根内的文件；越界或畸形编码返回 null。
 * 抽成导出函数是为了可单测（smoke §54 直接断言，不必起 HTTP）。
 *
 * 2026-09-26 修复两件事：
 *  ① **必须 `decodeURIComponent` 一次**：浏览器会把 `media/中文 图.png` 编码成 `%E4%B8%AD…%20…` 再请求，
 *     而 `new URL().pathname` **保留编码形式** ⇒ 旧实现拼出的磁盘路径里含 `%E4%B8%AD`，`existsSync` 必失败。
 *     实测：图片已正确拷进预览根，预览仍 404（导出正常）——中文/空格文件名是中文用户的常态。
 *  ② 穿越判定改为**按路径段**看 `..`：旧实现 `rel.includes('..')` 会顺带误杀 `a..b.png` 这类合法文件名。
 */
export function previewFileFor(root, rawRel) {
  let decoded = String(rawRel ?? '')
  try { decoded = decodeURIComponent(decoded) } catch { return null } // 畸形百分号编码 → 当作不存在
  if (decoded.includes('\0')) return null
  // 任何 `..` **路径段**一律拒绝（保守策略：浏览器发出的请求路径本已规范化，代价为零）。
  // 注意必须**先判再 normalize**——`path.normalize` 会把 `media/../x` 折叠成 `x`，折叠后就看不出越级意图了。
  // 旧实现用 `rel.includes('..')`，会顺带误杀 `a..b.png` 这类合法文件名；这里只拦真正的上级目录段。
  if (decoded.split(/[/\\]+/).some((seg) => seg === '..')) return null
  const norm = normalize(decoded).replace(/^([/\\])+/, '')
  if (!norm) return null
  if (norm.split(/[/\\]+/).some((seg) => seg === '..')) return null // 归一化后仍越界（双保险）
  return join(root, norm)
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
}
