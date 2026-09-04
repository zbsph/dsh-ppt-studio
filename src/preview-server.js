/**
 * PPT 预览服务（需求 A「对话内看 PPT」，v0.6.0）：
 * host 侧：webServer 注册 `/ppt-preview/` 前缀路由，静态服务于"预览根"。
 * - 预览根 = ~/.dsh/ppt-studio/preview/<token>/：pages/（render 的 html）+ media/（deck 媒体）。
 *   render 输出的 html 引用 `../media/`（相对 deck 根）→ 预览根内 pages/../media/ 恰好解析。
 * - URL 为同源相对路径（/ppt-preview/<token>/pages/deck.html）：GUI 页面本身就在 host 上，
 *   点击/iframe 均同源，不依赖端口探测。
 */
import { mkdir, rm, copyFile, readFile, stat } from 'node:fs/promises'
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
  // media（含页面背景图；html 以 ../media/ 引用）
  if (existsSync(join(dir, 'media'))) {
    const mediaDir = join(root, 'media')
    await mkdir(mediaDir, { recursive: true })
    for (const name of await import('node:fs/promises').then((f) => f.readdir(join(dir, 'media')))) {
      await copyFile(join(dir, 'media', name), join(mediaDir, name))
    }
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

/** 注册预览路由（返回 disposer；无 webServer 环境返回 null）。 */
export function registerPreviewRoute(ctx) {
  const ws = ctx.get('webServer')
  if (!ws) return null
  return ctx.effect(() => ws.register({
    kind: 'prefix',
    path: '/ppt-preview', // prefix 语义：path 不带尾斜杠（实测：带斜杠不命中）
    async handler(req, res) {
      try {
        const u = new URL(req.url ?? '/', 'http://localhost')
        const m = u.pathname.match(/^\/ppt-preview\/([a-zA-Z0-9]+)\/(.*)$/)
        if (!m) return notFound(res)
        const root = await resolveToken(m[1])
        const rel = normalize(m[2]).replace(/^([/\\])+/, '')
        if (!root || rel.includes('..')) return notFound(res)
        const file = join(root, rel)
        if (!existsSync(file)) return notFound(res)
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
  }), 'ppt-studio: preview route')
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
}
