/**
 * DSH 用户目录解析 —— 本插件**唯一**的实现。
 *
 * 为什么要有这个文件（2026-09-26，方案 B 第二批）：
 *   此前口径是分裂的 ——
 *     · `templates.js`（用户模板层）与 `index.js`（诊断日志）**调用时求值**、认 `DSH_HOME`；
 *     · `state.js`（会话状态）与 `preview-server.js`（预览根）是**模块常量** `homedir()/.dsh`，忽略 `DSH_HOME`。
 *   实测后果两条：
 *     ① 设了 `DSH_HOME` 的便携/CI 部署里，会话状态与预览**逃出隔离目录**（写进真实 `~/.dsh`）；
 *     ② 本机跑 `npm test` 会把 smoke 模板与预览缓存写进开发机**真实**的 `~/.dsh/ppt-studio/` ——
 *        与 smoke 自己那句"不碰开发机/CI 上真实目录"的承诺直接冲突（因此清理过两次真实目录）。
 *
 * 契约（两条都重要）：
 *   · **每次调用求值**：不能做成模块常量，否则测试/CI 无法用 `DSH_HOME` 覆盖（这也是 templates.js 当初的做法）。
 *   · **未设 `DSH_HOME` 时与旧行为等价**（`homedir()/.dsh`）⇒ 普通用户行为零变化、无需迁移。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

/** DSH home：`DSH_HOME` 优先，缺省 `~/.dsh`（Node 的 `homedir()` 在 Windows 认 `USERPROFILE`、POSIX 认 `HOME`）。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 本插件的用户数据目录：`<dshHome>/ppt-studio`。
 * 会话状态（`session-<id>.json`）、预览根（`preview/<token>/`）、用户模板层（`templates/`）、
 * 诊断日志（`debug.log`）都在这一层下面 —— 全插件共用同一个根，避免再出现口径分裂。
 */
export function pptStudioDir() {
  return join(dshHome(), 'ppt-studio')
}
