/**
 * 重解析点安全探针：Node 的 rmSync(recursive) 会不会**跟随 junction**把目标目录也删掉？
 * 背景：release-sync 会 `rmSync(D:\plugins\package, {recursive:true})`，而该目录里 install.mjs 建过
 * `node_modules/yaml` → profile 的 yaml 目录（junction）。若 Node 跟随重解析点，就会**清空 profile 的 yaml**
 *（2026-09-14 的真实事故形态——那次是 PowerShell 的 Remove-Item -Recurse 干的）。
 * 结论直接决定 release-sync 的删除写法是否安全。
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const base = join(tmpdir(), `reparse-probe-${Date.now()}`)
const canary = join(base, 'canary')      // 被指向的"重要目录"
const victim = join(base, 'victim')      // 将被递归删除的目录
mkdirSync(canary, { recursive: true })
mkdirSync(join(victim, 'node_modules'), { recursive: true })
writeFileSync(join(canary, 'IMPORTANT.txt'), 'must survive', 'utf8')
writeFileSync(join(victim, 'node_modules', 'filler.txt'), 'x', 'utf8')
symlinkSync(canary, join(victim, 'node_modules', 'linked'), 'junction')

const st = lstatSync(join(victim, 'node_modules', 'linked'))
console.log(`junction 建立：isSymbolicLink=${st.isSymbolicLink()} isDirectory=${st.isDirectory()}`)

rmSync(victim, { recursive: true, force: true })

const canaryAlive = existsSync(join(canary, 'IMPORTANT.txt'))
const victimGone = !existsSync(victim)
console.log(`victim 已删除：${victimGone}`)
console.log(`canary 内容仍在：${canaryAlive}${canaryAlive ? `（内容="${readFileSync(join(canary, 'IMPORTANT.txt'), 'utf8')}"）` : ' ← **被删空了！**'}`)
console.log(`\n==== 结论：Node rmSync(recursive) ${canaryAlive ? '**不跟随** junction（release-sync 的删法安全）' : '**会跟随** junction（必须改成先 rmdir 链接）'} ====`)
rmSync(base, { recursive: true, force: true })
process.exit(canaryAlive ? 0 : 1)
