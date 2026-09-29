# 能力边界（capability-matrix）

> 交付时必须如实标注：**不支持的要么不用，要么标"近似"**；能让它在写入时就**报错**最好。

## 支持（预览与 OOXML 两端同源）
| 能力 | 说明 |
|---|---|
| 纯色 / **线性渐变**填充 | fill 对象形如 {type:'gradient', stops:[{pos,color}], angle}；预览转 CSS linear-gradient、导出转 a:gradFill |
| 形状图元 | rect / roundRect / ellipse / triangle / parallelogram / diamond / pentagon / hexagon / chevron / octagon / star5 |
| **custGeom 任意路径** | path.w/h + moveTo/lnTo/quadBezTo/cubicBezTo/arcTo/close ⇒ 梯形等自定义几何 |
| 折线 / 虚线 / 两端箭头 | line.points 支持 N 点；dash: dash；arrow: true|false|'end'|'both' |
| 分组与包含 | contains 声明"我包住谁"；跨容器穿入用 expectedOverlaps 声明 |

## 不支持（如实标注，勿假装）
| 能力 | 现状 |
|---|---|
| **逐形状阴影 / 卡片高光** | 导出层只有主题级 effectStyleLst，无逐形状 a:outerShdw；预览端无 box-shadow ⇒ 只能近似为"纯色/渐变 + 描边" |
| 手绘笔触质感 | 无 ⇒ 明确标"不支持真笔触" |
| 3 段以上复杂渐变 | 能写 stops 但视觉收益有限，建议 2 段 |

## 规矩
写"引擎画不出来的值"应当**直接报错**（例如 elevation 只允许 none），绝不静默无效。
