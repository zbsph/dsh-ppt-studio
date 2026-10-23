/**
 * 发版档（`npm run test:release`，2026-09-27 新增）——**发版与批次边界**跑这一档。
 *
 * 与 `npm test` 的区别：`npm test` 是"核心门禁全量"（CI 与本地都跑）；本档在它之上再加
 * e2e / 隔离矩阵 / 原生图表自证 / 损失审计自证 / 安装路径自证。
 *
 * **并行/串行（2026-10-23 修假红）**：Office COM 相关任务（core 的 smoke 真渲染 / e2e 的真渲染 /
 * 原生图表自证）**必须串行**——实测三项并行会让 PowerPoint COM 争用（RPC 不可用 0x800706BA）与
 * 渲染结果互相污染；隔离矩阵改为只复制 tracked 内容后可与写生成物的任务并行。其余任务照旧并行。
 *
 * 每条子进程的输出写到**自己的日志**（`<tmp>/dsh-test-release/<name>.log`），末尾只汇总结论；
 * 失败时把该日志最后若干行打出来——并行不等于看不清谁失败。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root } from './test-map.mjs'

const logDir = join(tmpdir(), 'dsh-test-release')
mkdirSync(logDir, { recursive: true })

// serial: true ⇒ Office COM / 可写仓库的互斥任务；其余并行
const TASKS = [
  { name: 'core（build+LF+smoke 全量+预设门禁）', cmd: 'npm test', serial: true },
  { name: 'e2e（1.0 端到端）', cmd: 'node scripts/e2e-1.0.mjs', serial: true },
  { name: '隔离矩阵（真宿主作用域）', cmd: 'node scripts/verify-preset-scope.mjs' },
  { name: '原生图表自证（COM+反读+负对照）', cmd: 'node scripts/verify-native-charts.mjs', serial: true },
  { name: '损失审计自证', cmd: 'node scripts/verify-loss-audit.mjs' },
  { name: '安装路径自证（bundle/预设声明）', cmd: 'node scripts/verify-bundle-install.mjs', must: false },
  { name: '手册事实审计', cmd: 'node scripts/audit-manual-facts.mjs' },
]

const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7)
const picked = only ? TASKS.filter((t) => only.split(',').some((o) => t.name.includes(o))) : TASKS

function launch(t) {
  return new Promise((resolve) => {
    const logPath = join(logDir, `${t.name.replace(/[^\w\u4e00-\u9fa5]+/g, '_')}.log`)
    const fd = writeFileSync(logPath, `$ ${t.cmd}\n`, 'utf8')
    const p = spawn(t.cmd, { shell: true, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const onData = (d) => { buf += d.toString() }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    p.on('close', (code) => {
      writeFileSync(logPath, `$ ${t.cmd}\n${buf}`, 'utf8')
      resolve({ ...t, code: code ?? 1, logPath, tail: buf.split(/\r?\n/).filter((l) => l.trim()).slice(-6).join('\n') })
    })
    void fd
  })
}

console.log(`==== 发版档（test:release）：并行 ${picked.filter((t) => !t.serial).length} 项 + 串行 ${picked.filter((t) => t.serial).length} 项｜日志目录 ${logDir} ====`)
const t0 = Date.now()
const results = []
results.push(...(await Promise.all(picked.filter((t) => !t.serial).map(launch))))
for (const t of picked.filter((t) => t.serial)) results.push(await launch(t))
const wall = ((Date.now() - t0) / 1000).toFixed(1)
for (const r of results) console.log(`${r.code === 0 ? '✓' : '✗'} ${r.name}（${r.code === 0 ? '通过' : `exit ${r.code}`}）→ ${r.logPath}`)

const failed = results.filter((r) => r.code !== 0)
console.log(`==== 发版档结果：${results.length - failed.length}/${results.length} 通过｜墙钟 ${wall}s ====`)
for (const f of failed) {
  console.log(`\n── ✗ ${f.name} 的日志末尾（完整：${f.logPath}）──\n${f.tail}`)
}
// 只为让"日志文件确实写了内容"这件事可自证（避免并行下丢失输出）
const empty = results.filter((r) => readFileSync(r.logPath, 'utf8').trim().split(/\r?\n/).length < 2)
if (empty.length) console.log(`⚠ 这些任务的日志是空的（并行捕获可能失败）：${empty.map((e) => e.name).join('、')}`)
process.exit(failed.length ? 1 : 0)
