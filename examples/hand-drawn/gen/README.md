# 手画 12+1 页面生成器（配方入库）

> 背景：这些配方原先活在某次会话的临时目录里（%TEMP%），**改一页要翻临时脚本**，与"改画法只动 skills/生成器"矛盾。
> 现收入仓库。**每页只认一个当前版本**（见下表），历史版本保留仅供追溯。

| 生成器 | 负责页面 | 状态 |
|---|---|---|
| `s3.cjs` | 12 分层架构（唯一） | |
| `s5.cjs` | 01 层级树 / 03 时间轴 / 07 漏斗（07 已被 gen07.cjs 取代） | |
| `gen07.cjs` | 07 漏斗（custGeom 真梯形，覆盖 s5 的版本） | |
| `gen-02.cjs` | 02 矩阵（三档处置列 × 两行频次，覆盖早期版本） | |
| `gen-020406.cjs` | 02/04/06 早期版本（04、06 已被 gen-fix6.cjs 取代） | |
| `gen-0508.cjs` | 05 左右对比 / 08 步骤环（08 已被 gen-fix6.cjs 取代） | |
| `gen-fix6.cjs` | **01 / 04 / 06 / 08 / 09 / 10 的当前版本**（01 直线、04 折点 22px、06/08 卡边裁剪、09 白底芯片、10 标签贴线） | |
| `gen-1113.cjs` | 11 流程图 / 13 平台架构（13 已被 gen13-attach.cjs 取代） | |
| `gen13-attach.cjs` | **13 的当前版本**（改用 attach 接真实斜边，撤掉手算内缩与声明） | |

## 用法

```powershell
node examples/hand-drawn/gen/<生成器>.cjs   # 写出对应 pages/*.yaml
# 然后跑管线（门禁 → 导出 → 真渲染 PNG）：
node examples/hand-drawn/gen/gen-1113.cjs   # 该脚本尾部自带：resolveDeck → renderDeck → 门禁 → 导出 → COM 渲染 → 按页序命名 PNG
```

## 约束（血泪换来的，别违反）

- **连边一律用 `attach`**（含斜边形状 ⇒ 引擎接到真实斜边），不手算像素（引擎实测纠过我 20px 的错误）。
- **导出前确认没有进程占用目标 pptx**（PowerPoint 开着 ⇒ COM 静默渲染旧副本 + 导出 EBUSY）。
- **改了引擎必须重出产物**；重出前先清空输出目录（残留会被当新图复制）。
- 收工前**逐条解释门禁警告**（`line-crossing` / `arrow-end-short-run` / `line-end-off-edge` / `arrow-tip-inside-shape` 等）。
