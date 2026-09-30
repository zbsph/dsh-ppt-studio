---
name: diagram-funnel
description: 漏斗/金字塔
whenToUse: 漏斗、金字塔（custGeom 梯形逐段收窄）——需要画这类图时加载；先读 skills/diagram-drawing/mechanisms.md
---
# 漏斗（funnel）· 手画配方

## 骨架
用 **custGeom 梯形**逐段收窄（矩形堆叠是台阶，不是漏斗）。

## 配方数值
段 bounds [80, 148+i×70, 800, 70]；段内标签**限宽** = min(上宽,下宽) − 60 且居中。
示例上/下宽：760→560→360→200→100（末段 accent）。
path：w:800、h:70；moveTo[(800−wTop)/2,0] → lnTo[(800+wTop)/2,0] → lnTo[(800+wBot)/2,70] → lnTo[(800−wBot)/2,70] → close。

## 专属坑
1. 段间边界相接（下段上宽 = 上段下宽），相接不算重叠。
2. 标签必须落在梯形内部 ⇒ 必须限宽。
3. 段太薄时宁可省略段内文字。

## 验收清单
- [ ] 门禁 0 错；[ ] 两侧斜边连续；[ ] 每段文字在梯形内。

## 本族应调用的机制（先读 mechanisms.md）

- **连边一律 `attach: {from:{ref,side}, to:{ref,side}}`**，不手算像素（含斜边形状 ⇒ 引擎接到真实斜边）。
- 容器（分组/泳道/面板/背景带）**必须把内部元素写进 `contains`**；只声明**相邻层**。
- 折线交给引擎**自动正交化**；刻意斜段（环/放射/漏斗）写 `role: decoration` 或 `roleReason` 声明。
- 箭头前直段 ≥18px 由引擎自动保证；修不了会由 `arrow-end-short-run` 报出 ⇒ **必须读警告**。
- 收工前**逐条解释本页每一条警告**（见 verify.md 铁律之二）。
