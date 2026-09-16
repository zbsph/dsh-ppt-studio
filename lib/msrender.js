/**
 * Office 真渲染通道（v0.8.0，问题 2 落地）：
 * 有 Microsoft Office 时，用 PowerShell + PowerPoint COM 把任意 .pptx 逐页渲染成 PNG——
 * ① 理解用户原稿（先看后做）② 成品视觉审核（P2-2 的 Office 答案）③ 原版 vs 导入版对照。
 * 无 Office 时 findPowerPoint() 返回 null，整条通道自动隐藏（不影响既有工作流）。
 * 安全：只读打开 + finally Quit + 超时 kill 残留 POWERPNT 进程。
 */
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

const PS1 = `param(
  [string]$Pptx,
  [string]$Out,
  [int]$W = 1920,
  [int]$H = 1080,
  [string]$PagesJson = '',
  [switch]$NoWatermark
)
$ErrorActionPreference = 'Stop'
$pp = $null
try {
  $pp = New-Object -ComObject PowerPoint.Application
  $pp.Visible = -1
  $pres = $pp.Presentations.Open($Pptx, -1, 0, 0)
  $n = $pres.Slides.Count
  New-Item -ItemType Directory -Force -Path $Out | Out-Null
  # P5 修复：多页解析（"4,1" 按逗号拆——此前 -Pages 4,1 被绑定成 41）
  $list = if ($PagesJson -ne '') { ($PagesJson -split ',') | ForEach-Object { [int]$_ } | Sort-Object -Unique } else { 1..$n }
  foreach ($i in $list) {
    $pres.Slides.Item($i).Export((Join-Path $Out ('{0:D2}.png' -f $i)), 'PNG', $W, $H)
  }
  $pres.Close()
  # P9：真渲染图叠加轻量比例标注（1px=1pt · 960×540）+ 细边框——降低人工读图坐标误判
  if (-not $NoWatermark) {
    Add-Type -AssemblyName System.Drawing
    foreach ($f in Get-ChildItem $Out -Filter '*.png') {
      try {
        $img = [System.Drawing.Image]::FromFile($f.FullName)
        $g = [System.Drawing.Graphics]::FromImage($img)
        $g.SmoothingMode = 'AntiAlias'
        $font = New-Object System.Drawing.Font('Microsoft YaHei', 12, [System.Drawing.FontStyle]::Regular)
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(110, 60, 60, 60))
        $g.DrawString('1px=1pt · 960×540（比例参考）', $font, $brush, 8, ($img.Height - 34))
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(80, 90, 90, 90), 1)
        $g.DrawRectangle($pen, 0, 0, ($img.Width - 1), ($img.Height - 1))
        $g.Dispose(); $img.Dispose(); $font.Dispose(); $brush.Dispose(); $pen.Dispose()
      } catch { }
    }
  }
  Write-Output ("OK:" + $list.Count)
} finally {
  if ($pp) { try { $pp.Quit() } catch { } }
}
`

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
  'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
  'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
  'C:\\Program Files (x86)\\Microsoft Office\\root\\Office15\\POWERPNT.EXE',
  'C:\\Program Files\\Microsoft Office\\root\\Office15\\POWERPNT.EXE',
]

/** 能力探测：本机是否有 PowerPoint（后续真用 COM 时再验证，失败视为不可用）。 */
export function findPowerPoint() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p
  const base = ['C:\\Program Files\\Microsoft Office', 'C:\\Program Files (x86)\\Microsoft Office']
  for (const b of base) {
    try {
      const found = readdirSync(b).filter((d) => /^Office\d+$/.test(d)).map((d) => join(b, d, 'POWERPNT.EXE')).find((p) => existsSync(p))
      if (found) return found
    } catch { /* 目录不存在 */ }
  }
  return null
}

/**
 * 渲染 pptx → 逐页 PNG。
 * @returns { pages, outDir, files }；COM 不可用/渲染失败抛错（调用方负责降级）。
 */
export async function renderPptxToPng(pptx, outDir, { width = 1920, height = 1080, timeoutMs = 240000, pages, noWatermark = false } = {}) {
  if (!existsSync(pptx)) throw new Error(`pptx 不存在：${pptx}`)
  await mkdir(outDir, { recursive: true })
  const ps1 = join(tmpdir(), `dsh-ppt-render-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`)
  await writeFile(ps1, '\ufeff' + PS1, 'utf8') // BOM：Windows PowerShell 5.1 按 GBK 读无 BOM 文件 → 中文路径乱码
  try {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-Pptx', pptx, '-Out', outDir, '-W', String(width), '-H', String(height)]
    // A5/P5：按页渲染（单参数 JSON 串，避免 PS 数组绑定把 "4,1" 解析成 41）；水印默认开（P9）
    if (pages && pages.length) args.push('-PagesJson', pages.join(','))
    if (noWatermark) args.push('-NoWatermark')
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`PowerPoint 渲染超时（${timeoutMs}ms）`)) }, timeoutMs)
      child.on('exit', (code) => {
        clearTimeout(killer)
        code === 0 ? resolve(out) : reject(new Error(`PowerPoint COM 渲染失败（code ${code}）：${(err || out).slice(0, 500)}`))
      })
      child.on('error', (e) => { clearTimeout(killer); reject(e) })
    })
    const m = stdout.match(/OK:(\d+)/)
    const files = []
    if (m) {
      // 文件名 = 原页号（两位数补零）；按参数/全量存在者收集
      const find = pages && pages.length ? pages : Array.from({ length: Number(m[1]) }, (_, i) => i + 1)
      for (const i of find) {
        const f = join(outDir, `${String(i).padStart(2, '0')}.png`)
        if (existsSync(f)) files.push(f)
      }
    }
    return { pages: Number(m?.[1] ?? 0), outDir, files }
  } finally {
    await rm(ps1, { force: true }).catch(() => {})
  }
}
