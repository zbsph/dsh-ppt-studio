---
name: diagram-swimlane
description: 泳道图
whenToUse: 泳道、跨角色流程（装饰泳道带 + 跨道走车道间隙）——需要画这类图时加载；先读 skills/diagram-drawing/mechanisms.md
---
# 泳道图（swimlane）· 手画配方

## 骨架
左泳道名芯片 + 右侧泳道带；任务卡按角色落到对应道；跨道连线允许穿带（**必须声明**）。

## 配方数值
芯片 roundRect 96×72 @ x=60；道 i 的 y=156+i×84。带 rect 780×72 @ x=156（同 y），奇数道浅紫、偶数道白底。
任务卡 roundRect 110×44（文字 11pt bold），首卡 x=176、间距 124。

## 专属坑
1. **带的 contains 要列出本道全部任务卡与其文字**（否则报"背景压内容"）。
2. 跨道连线只把**真正相交**的对写进 expectedOverlaps（过声明会产生 declared-stale 噪音）。

## 验收清单
- [ ] 门禁 0 错；[ ] 归属一眼可辨；[ ] 声明清单无 stale。

## 本族应调用的机制（先读 mechanisms.md）

- **连边一律 `attach: {from:{ref,side}, to:{ref,side}}`**，不手算像素（含斜边形状 ⇒ 引擎接到真实斜边）。
- 容器（分组/泳道/面板/背景带）**必须把内部元素写进 `contains`**；只声明**相邻层**。
- 折线交给引擎**自动正交化**；刻意斜段（环/放射/漏斗）写 `role: decoration` 或 `roleReason` 声明。
- 箭头前直段 ≥18px 由引擎自动保证；修不了会由 `arrow-end-short-run` 报出 ⇒ **必须读警告**。
- 收工前**逐条解释本页每一条警告**（见 verify.md 铁律之二）。
