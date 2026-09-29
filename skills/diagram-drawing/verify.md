# 验收流程（verify）

## 固定五步（每页都要走完）
1. 按子 skill 配方生成显式 `elements`（不手写"裸坐标"乱撞）。
2. `resolveDeck` → `renderDeck`（产出预览 HTML 与 layout.json）。
3. **过门禁**：`verifyDeck` 逐页 0 错（关系/重叠/溢出/对比度/贴边）；有错按 pitfalls 定位后再改。
4. `exportPptx` → **真渲染 PNG**。
5. **自己读图**：看层级、留白、避让、连线语义（谁指向谁）；不满意就地改，回到第 2 步。

## 两条看图通路
- **COM（首选）**：lib/msrender.js 的 renderPptxToPng(pptx, outDir, { pages })；页数要按实际页数传（传大了报 Slides.Item 越界）。
- **Edge 无头（备用）**：msedge --headless=new --window-size=W,H --screenshot=out.png file:///...preview.html —— 视口要按画布比例设，否则画面挤在角落。

## 判定口径（同内容对照时）
① **内容一致**（语义/数据/标签不丢 —— 门禁抓不到，只能靠与旧版并排读图）；② **可读性不降**（字号/对比度/避让，门禁可量化）；③ **观感不降**（构图/层级/留白，人眼判定）。

## 铁律
先图后数；改了引擎/页面必须**重出产物并替换**；边界能力如实标注；不用 expectedOverlaps 掩盖真实缺陷。

## 铁律之二：**警告也要逐条读**（2026-09 血的教训）

> 我连续多轮"门禁 0 错"就收工 ⇒ 用户连续反馈：竖线穿字、折点贴着箭头、箭头没接上平行四边形。
> 回查发现**这些全都在警告里早就报了**：`line-crossing`、`arrow-end-short-run`、`line-end-off-edge`、`arrow-tip-inside-shape`。
> ⇒ **0 错 ≠ 没问题**；0 错只等于"没有不可声明级缺陷"。

收工前必须做到：
1. 打印本页**全部警告**（按 code 分组计数）；
2. 每条警告给一句**处置结论**：改布局 / 改 `attach` / 写 `roleReason` 声明 / 判定为**信息性建议**（`hotspot`/`density`）；
3. **一条不解释就不许收工**。

配套索引见 `mechanisms.md`（何时用哪个机制 + 门禁 code 对照表）。
