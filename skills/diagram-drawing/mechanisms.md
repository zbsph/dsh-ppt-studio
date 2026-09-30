# 机制调度手册（何时调用哪个机制）

> **动笔前先读权威规则**：`ppt_schema` 工具（源码 `src/scaffold.js` 的 `SCHEMA_REF`）里写着引擎的全部词汇与硬规则。
> 本文件是"**什么时候该用哪一条**"的索引；两者冲突时**以 SCHEMA_REF 为准**。

## 0. 三条总纲（血泪换来的）

1. **连边一律优先 `attach`，绝不手算像素。**
   实测教训：某页我手写"卡片右沿 x=628"，引擎 `attach` 解析后是 **608** —— 我错了 20px 而不自知。
   `attach: { from: { ref: <id>, side: top|right|bottom|left }, to: { … } }` ⇒ 引擎把两端锚到**真实边缘**，
   并把"你写的坐标被改了多少"记成 `attach-override` 警告（**不是报错，是透明提示**）。
2. **错与警都要逐条读；警告不解释不许收工。**
   实测教训：我连续几轮"门禁 0 错"就收工，结果用户反馈的问题（竖线穿字、折点贴箭头、箭头没接上）
   **全都在警告里早就报了**：`line-crossing` / `arrow-end-short-run` / `arrow-end-gap`。
   0 错 ≠ 没问题；**0 错只说明"没有不可声明级缺陷"**。
3. **刻意设计要"声明"，不要靠"绕过"。**
   环/放射/漏斗的斜段、汇流交叉、装饰底板，都该 `role: decoration` 或 `roleReason: "…"` 明说；
   **不要**用 `expectedOverlaps` 去盖"压字/压盒"（那是掩盖真实缺陷）。

## 1. 连接线与箭头

| 想要的效果 | 用什么 | 备注 |
|---|---|---|
| 端点贴到某个元素的边 | **`attach`** | 首选；斜边形状（parallelogram/triangle/diamond）也接到**真实斜边** |
| 折线只用横/竖段 | 交给引擎（默认自动正交化） | 显式 `elements` 的折线**已自动**过 `orthogonalize` |
| 箭头前留足直段（≥18px） | 交给引擎（默认自动修） | **已自动生效**；修不了（会造折返）就原样保留并由 `arrow-end-short-run` 报出 |
| 刻意保留斜段（环形/放射/漏斗） | `role: decoration` 或 `roleReason` | 引擎的自动正交化对"斜段折线"自动跳过，但**警告仍会报** ⇒ 要声明 |
| 端点刻意留空（2–10px 缝） | `roleReason: "…"` | 否则报 `line-end-off-edge`/`arrow-end-gap` |

## 2. 门禁 code 对照表（看到 → 怎么做）

| code | 级别 | 含义 | 处置 |
|---|---|---|---|
| `line-crossing` | 警示 | 两条线交叉（+型） | 换车道/换进出边；刻意汇流 ⇒ `roleReason` |
| `line-end-off-edge` | 警示 | 端点离元素 2–10px 没接上 | **改 `attach`**（首选）或声明刻意留空 |
| `arrow-end-gap` | 警示 | 带箭头端点没接到目标 | 同上 |
| `arrow-end-short-run` | 警示 | 箭头前直段 <18px | 挪拐点；**`attach` 通常直接消灭它** |
| `arrow-tip-inside-shape` | 警示 | 箭头插进图形内部 | 改 `attach` 到边缘；刻意插入 ⇒ `roleReason` |
| `line-diagonal-segment` | 警示 | 折线有斜段 | 连接线改轴对齐；刻意（环/放射）⇒ `role: decoration` |
| `attach-override` | 警示 | 你的手写坐标与 attach 解析不一致 | **正常**；想清零就把 points 改成解析后的真实值 |
| `hotspot` / `density` | 建议 | 密集区/信息密度提示 | 信息性，可保留；但要**明说是建议级** |
| `content-collision` | **错** | 文字互压 | **不可声明豁免**，必须改布局 |
| `unexpected-overlap` | **错** | 设计外重叠 | 改布局，或按层级正确声明 |

## 3. 结构声明的正确姿势

- 容器（象限框、泳道带、软底板）**必须把内部元素写进 `contains`**；无内容的形状**省略** `contains`（不写空数组）。
- **声明闭包**：嵌套承载只需声明**相邻层**（card×inBox、inBox×inText），隔层组合由传递自动通过。
- 语义性底板/背景带优先 `role: decoration`（豁免重叠），不要用 `expectedOverlaps` 盖。
- 跨容器连线（泳道跨道）**必然穿带** ⇒ 只把**真正相交**的元素对写进 `expectedOverlaps`；过度声明会产生 `declared-stale` 噪音。

## 4. 渲染与交付通路（别在这栽跟头）

1. **渲染前确认没有进程占用目标 pptx**（尤其 PowerPoint 开着）——否则 COM 会**静默渲染内存里的旧副本**，
   导出还会 EBUSY 失败。对策：导出到**带时间戳的新文件名**。
2. **重出前先清空输出目录**，否则旧 PNG 残留会被当成新图复制。
3. **读图通路按路径缓存** ⇒ 大改后的页面要**复制到新文件名再读**。
4. 复跑 `smoke.mjs` 前先 `Remove-Item examples\smoke\.tmp-home -Recurse -Force`（它非幂等，残留即崩）。
5. **"崩"与"断言红"要分清**：崩多为环境/残留，红才是真回归。
6. **改了引擎必须重出产物**；只改源码不重出 = 用户看到的还是旧的。

## 5. 一页图的固定动作单

1. 读 `SCHEMA_REF`（机制词汇 + 本节对照表）；
2. 写 `elements`：**连边用 `attach`**、容器写 `contains`、刻意设计写 `role/roleReason`；
3. `resolveDeck` → `renderDeck` → `verifyDeck`：**错清零，且逐条解释每一条警**；
4. 导出 → **真渲染 PNG** → **自己读图**（层级/留白/避让/语义）→ 不满意回第 2 步；
5. 与旧版/参考稿**并排对照**，记录"更好/持平/变差"及依据。

## 6. 各子 skill 的专属机制速查

| 子 skill | 必用机制 / 专属要点 |
|---|---|
| tree | 父→子折线用 `attach(bottom→top)`；同组子树加**分组容器**（contains 相邻层） |
| matrix | 象限框为容器，**格内卡片写进其 contains**；高亮**唯一** |
| timeline | 刻度线 `attach` 到标签/主轴端点（避免 4px 缝）；里程碑**只高亮一个** |
| swimlane | 跨道箭头用 `attach` 两端 + 只声明**真正相交**的泳道带；带 contains 本道任务 |
| compare | 面板 contains 要点卡；中间标记**宽度 ≤ 间隙**（36px 落进 40px） |
| loop | 环形弦 = 刻意斜段 ⇒ `role: decoration` + `roleReason: 环形语义`；端点用 `attach` |
| funnel | 用 **custGeom 梯形**（矩形堆叠是台阶不是漏斗）；段间边界相接不算重叠 |
| steps-ring | 真圆用 `ellipse`（浅填充+主色描边）+ 编号小圆点；点与标签留 ≥24px |
| sequence | 生命线 `attach` 到参与者卡底边；消息标签加**白底芯片**；汇流交叉写 `roleReason` |
| state | 转移标签贴箭头上方 **4px**，卡距≥标签宽（70px）；返工回边走**外圈车道** |
| flow | 起止 `roundRect`、末步 accent；异常回边标签放**车道上方**独立一行 |
| layers | 层带 contains 层内卡；层间箭头用 `attach`（left/right 边） |

## 7. 契约：2 点直连线 ≠ 折线（2026-09 实测确认，**别再踩**）

| 形态 | 导出 | 规则 |
|---|---|---|
| **2 点直连线**（含斜向！） | `<p:cxnSp>`（带 `flipH`/`flipV`） | **受支持的连接符** ✓ —— **绝对不要正交化它** ✗ |
| **n≥3 折线** | 一帧 `p:sp` + `custGeom` 开放路径 | **保证轴对齐** ✓（斜段会被自动拆成横/竖两段） |

**实测事故**：我曾把"折线永远轴对齐"套到 2 点斜连线上 ⇒ 它们被拆成 custGeom ✗ ⇒
`cxnSp` 数归零 ⇒ smoke 的 **6 条连线方向专项断言全崩**（`✗ 连线：全部 6 条 cxnSp 已导出` +
`TypeError … reading 'flipH'`）✓。**这是代码真错，不是 fixture** ✗。

**实现现状**（`src/pptd/route-geometry.js` 的 `routePolyline`）：
```js
if (raw.length < 3) return raw                    // 2 点直连线：原样（cxnSp 契约）
const fixed = orthogonalize(arrowEndRuns(orthogonalize(raw), arrow))
return hasFoldback(fixed) ? raw : fixed           // 折返守卫：不造尖刺，交门禁报
```
**豁免声明**（`layout.js`，只看显式声明）：`orthogonal: false` ／ `role: decoration` ／ `roleReason: '…'`。

**推论**：环形/放射图若用 **2 点弦**（如 06/08）⇒ **本来就不会被正交化** ✓，
此时写 `role: decoration` 只为**消掉 `line-diagonal-segment` 警告** ✓（属警告清理，不是功能必需）。

## 8. 泛用性不降级（G3）：手画是**一等公民**，不是退路

**引擎的既定教义**（`SCHEMA_REF` 第 6 条原文）："一页可以**既用 diagram 又手写元素**（缝合页）；
assistant 想要家族库没有的图，就按上面几条手写 elements 拼出来——**这是被支持的路径，不是退路**。"


**机制层面手画与族已等价**（G1 完成后）：
| 能力 | 族 | 手画 |
|---|---|---|
| 正交化 + 箭头端 ≥18px + 折返守卫 | ✅ | ✅ **同一份实现**（`route-geometry.js`） |
| `attach` 锚边（含**斜边真实轮廓**） | ✅ | ✅ 同一实现 |
| 线×文字 / 线×线 / 贴边 / 尖端入形 / 斜段 等检查 | ✅ | ✅ 同一门禁 |
| 结构声明（`contains`／`expectedOverlaps`／`role`） | ✅ | ✅ 同一套 |
| **自由构图**（族没有的图） | ❌ 受族模板限 | ✅ **不受限**（图 13 即样例） |

⇒ 泛用性**严格更强** ✓：族覆盖范围内按 skill 配方调用机制 ✓；范围外退化为手画但**机制不减** ✓。



### 补充 code（§2 对照表增补）

| code | 严重级 | 含义 | 怎么修 |
|---|---|---|---|
| `unknown-key` | **warning（不阻断）** | 页面级/元素级出现**未知键**（拼写错误或残留字段）——过去会被静默忽略，可能悄悄出空页/漏项 | 改对键名；若是合法新字段，说明白名单漏项（`scripts/check-unknown-keys.mjs` 会在本仓示例上**直接报失败**逼你补） |

