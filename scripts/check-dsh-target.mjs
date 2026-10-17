#!/usr/bin/env node
/**
 * dsh 目标版本一致性守卫（无网络、秒级）。
 *
 * 事实源 = dsh-target.json（CI install-path 的被测 DSH 版本）。
 * 本脚本强制三处一致，防"改了预设忘了改钉版"这类假红/漏测：
 *   ① dsh-target.json 的 dsh
 *   ② docs/14-发布清单（草稿）.md 里的 `dsh-target: <ver>` 行
 *   ③ package.json 的 dsh.engines.dsh 下限 ≤ 目标版本（下限写高了会把老宿主挡在门外）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = []
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const target = JSON.parse(read('dsh-target.json')).dsh
if (typeof target !== 'string' || !/^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/i.test(target)) {
  fail.push(`dsh-target.json 的 dsh 不是合法版本号：${JSON.stringify(target)}`)
}

const docLine = /`dsh-target:\s*([0-9][0-9a-z.\-]*)`/i.exec(read('docs/14-发布清单（草稿）.md'))
if (!docLine) fail.push('docs/14 缺少 `dsh-target: <版本>` 行（与 dsh-target.json 同源）')
else if (docLine[1] !== target) fail.push(`docs/14 的 dsh-target=${docLine[1]} 与 dsh-target.json=${target} 不一致`)

const engines = JSON.parse(read('package.json'))?.dsh?.engines?.dsh ?? ''
const low = /(\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)/i.exec(engines)?.[1]
if (!low) fail.push('package.json 缺少 dsh.engines.dsh 下限')
else {
  const cmp = (a, b) => {
    const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
    const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? 0, y = pb[i] ?? 0
      if (x === y) continue
      if (typeof x === 'number' && typeof y === 'number') return x - y
      return String(x).localeCompare(String(y))
    }
    return 0
  }
  if (cmp(low, target) > 0) fail.push(`dsh.engines.dsh 下限 ${low} 高于目标 ${target}（会把老宿主挡在门外）`)
}

if (fail.length) {
  console.error('✗ dsh 目标版本一致性：失败')
  for (const f of fail) console.error('  · ' + f)
  process.exit(1)
}
console.log(`✓ dsh 目标版本一致：${target}（dsh-target.json = docs/14 = engines 下限 ${low}）`)
