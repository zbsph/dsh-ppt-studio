---
name: diagram-steps-ring
description: 步骤环
whenToUse: 步骤环（真圆+编号点 或 卡片环）——需要画这类图时加载；先读 skills/diagram-drawing/mechanisms.md
---
# 步骤环（steps-ring）· 手画配方

## 两种画法
1. **卡片环**（快）：N 张卡沿椭圆分布 + 沿环直箭头（数值见 loop.md）。
2. **真圆 + 编号点**（更雅，旧版用的，**优先**）：ellipse 浅填充+主色描边 + 圆周上编号小圆点 + 圆外标签。

## 真圆数值
圆 ellipse 中心 (480,300)、r=190 ⇒ bounds [290,110,380,380]；fill 浅紫、line 主色 1.5。
编号点 ellipse 46×46 在圆周（角度 = −90° + i×360/N），点内序号 bold 白字；标签在半径+70 处 12pt。

## 专属坑
1. 编号点写进圆的 contains，或干脆都不声明 contains（避免"未真正包含"）。
2. 标签与编号点至少留 24px。

## 验收清单
- [ ] 门禁 0 错；[ ] 序号顺序可读；[ ] 圆与点同心。

## 本族应调用的机制（先读 mechanisms.md）

- **连边一律 `attach: {from:{ref,side}, to:{ref,side}}`**，不手算像素（含斜边形状 ⇒ 引擎接到真实斜边）。
- 容器（分组/泳道/面板/背景带）**必须把内部元素写进 `contains`**；只声明**相邻层**。
- 折线交给引擎**自动正交化**；刻意斜段（环/放射/漏斗）写 `role: decoration` 或 `roleReason` 声明。
- 箭头前直段 ≥18px 由引擎自动保证；修不了会由 `arrow-end-short-run` 报出 ⇒ **必须读警告**。
- 收工前**逐条解释本页每一条警告**（见 verify.md 铁律之二）。
