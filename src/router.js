/**
 * ppt-studio 路由：语义检测（双通道之"语义"）+ 工作流提示词注入。
 * 规则（设计定稿）：明确 PPT 任务意图才进、明确无关才退、弱信号不切；
 * /ppt on|off 命令强制（命令>语义）；工作流是"语境"而非能力切换。
 */

const PPT_INTENT_RE = [
  /(做|制作|生成|创建|撰写|编写|设计|搞|来|整)\s*(一?份|一个|张|套)?\s*(ppt|pptx|幻灯片|演示文稿|deck|slides|slide)/i,
  /(ppt|pptx|slides|slide|deck|演示文稿|幻灯片|汇报文稿)\s*(的)?\s*(制作|生成|修改|调整|美化|优化|补|添加|新增|追加|总结|提炼|梳理|复刻|转换)/i,
  /(改|修|调|补|美化|优化|统一|整理)\s*(一下|一页|几页|这份)?\s*(ppt|pptx|slides|deck|演示文稿|幻灯片)/i,
  /(总结|提炼|梳理|复盘|汇报)(一下|一份)?\s*(这份|这个|该)?\s*(ppt|pptx|slides|deck|演示文稿|幻灯片)/i,
  /(演示文稿|幻灯片|ppt|pptx|deck|slides)\s*(建议|大纲|脚本|备注|讲稿)/i,
]

const PPT_OFF_RE = /(这和|这事|与ppt|跟ppt|不是.*ppt|别管ppt|无关)/

const TASK_RULES = [
  { task: 'summarize', re: /(总结|提炼|梳理|复盘|概述|浓缩)/ },
  { task: 'edit', re: /(修改|调整|改动|统一|美化|优化|替换|重做|换)/ },
  { task: 'augment', re: /(补(充|完)?|添加|新增|追加|增页|加几页|插入)/ },
]

export function detectTaskType(text) {
  for (const rule of TASK_RULES) {
    if (rule.re.test(text)) return rule.task
  }
  return 'from-scratch'
}

export function isPptIntent(text, attachments) {
  if (!text && !attachments?.length) return false
  if (attachments?.some((a) => /\.pptx?$/i.test(a.name ?? a.path ?? a.filename ?? ''))) {
    if (!text || PPT_INTENT_RE.some((re) => re.test(text))) return true
    if (text && !PPT_OFF_RE.test(text)) return true
  }
  return PPT_INTENT_RE.some((re) => re.test(text ?? ''))
}

/** 判断用户消息是否"明确无关"（触发工作流退出）。 */
export function isPptOff(text) {
  if (!text) return false
  return PPT_OFF_RE.test(text)
}

/** 快速生成（Quick Mode）语义：quick 词 + ppt 语境（进入时需 ppt 意图；工作流内自动成立）。 */
const QUICK_RE = /(简单|快速|快点|随手|简版|简介|大概|随便做|弄个|quick|simple|minimal|brief)/i

export function isQuickIntent(text, inPptContext = false) {
  if (!QUICK_RE.test(text ?? '')) return false
  return inPptContext || isPptIntent(text)
}

/** 工作流激活段（注入 assembled.sections）。 */
export function workflowSection(taskType, cfg) {
  if (cfg.quick) {
    return {
      name: 'ppt-workflow',
      text: [
        '=== PPT 工作流已激活（dsh-ppt-studio · 快速模式） ===',
        `任务类型：${taskType ?? 'unknown'}（from-scratch 从头 / augment 补完 / edit 修改 / summarize 总结）｜协作 ${cfg.mode}｜引擎 ${cfg.engine}（常见值见下）`,
        '',
        '【快速模式铁律】（低 token 快交付，质量底线不变）',
        '0. 不熟悉 DSL 语法：先调 ppt_schema；要现成骨架：ppt_new 生成样例再改。',
        '1. S0 最小化：按消息推断，最多一次简短确认（≤1 问）；不 grill、不做多轮讨论。',
        '2. 版式：直接用内置模板骨架（封面/内容/结尾 3 件套），不做视觉定调；只用主题默认色 + 2-3 级字号（≥12pt）。',
        '3. 素材：只使用用户提供或纯色块/图形表达；不做素材搜索、不生成复杂图表（需要时用表格或简单柱形）。',
        '4. 页数：≤8 页（用户指定除外）；每页文本精简（每块 ≤40 字）。',
        '5. 审阅：ppt_render + ppt_verify 必跑——内容互压/出界/文本溢出/预期外重叠（设计意图声明制）必须清零；出界分级同标准模式（超页面不可声明；安全区外有意元素逐项加 expectedOutOfSafeArea）；autoDeclare 后附一句意图说明；跳过截图视觉审阅与美学迭代。',
        '6. 交付：ppt_export（引擎 auto=pptd）→ 交付说明标注"快速模式：未经视觉审阅"。',
        '7. 引擎：auto 默认 = pptd（自研主引擎，图表矢量拼绘）；python-pptx 仅显式指定或 pptd 失败时使用（其图表降级为表格）。不要自行切换引擎。',
        '8. 用户明确要求始终优先；回到完整模式：/ppt normal。',
      ].join('\n'),
    }
  }
  return {
    name: 'ppt-workflow',
    text: [
      '=== PPT 制作工作流已激活（dsh-ppt-studio） ===',
      `任务类型：${taskType ?? 'unknown'}（from-scratch 从头 / augment 补完 / edit 修改 / summarize 总结）`,
      `协作模式：${cfg.mode}｜内容忠实度 ${cfg.fidelity}｜审阅 ${cfg.review}｜质量 ${cfg.quality}｜引擎 ${cfg.engine}｜暂停点 ${cfg.pauseAfter.length ? cfg.pauseAfter.join(',') : '无'}（/ppt 可改）`,
      '',
      '【执行阶段】（按序推进，已完成可跳过，循环至交付）：',
      '  S0 规格澄清 → S1 大纲与素材准备 → S2 视觉定调（样例页）→ S3 逐页制作 → S4 页审循环 → S5 整体审 → S6 导出交付',
      '',
      '【入门（减少试错，反馈整合）】',
      '  - 语法速查：先调 ppt_schema（deck.yaml/元素/主题 token/声明/安全区速查）；要完整可跑样例：ppt_new 生成示例工程（含 expectedOverlaps 与 safeArea 范本）；回归样例在插件 examples/smoke。',
      '  - line 元素可省略 bounds（由 points 的 AABB 自动推导，w/h≥1px）。',
      '  - 模板背景带 logo/页眉/页脚带：在 deck.yaml theme.safeArea（或页面级 safeArea）配置上/下/左/右安全边距，verify 会把安全区外的元素判为出界；ppt_render debug=true 会画出安全区参考框。',
      '  - 文本溢出：verify 与导出共用同一保守度量；导出 auto-fit 缩字不低于 theme.minFontSize（默认 12pt），到下限仍溢出会明确报告（✗），此时请扩大容器或精简文案，不要接受低于 12pt 的缩字。',
      '  - 批量声明：色块衬底/图片标注/箭头跨越等"警告级"未声明重叠，用 ppt_verify autoDeclare=true 一键写入 expectedOverlaps；内容互压（content-collision）不支持自动声明，必须手工改布局。写入后输出**声明清单**（每对附一句意图：色块衬底/图上标注/箭头跨越），说不清意图的对子必须改布局而不是声明（D1）。',
      '  - 出界声明（expectedOutOfSafeArea）不批量、必须手工：验证报安全区出界错误时，确认"这是有意的 logo/角标"才加入声明；不确定就先移动元素。',
      '',
      '【铁律】',
      '1. 产物 = 中间层项目（deck.yaml + pages/*.yaml + media/）。页面用元素描述（bounds 为 [x,y,w,h] px，1px=1pt，原点左上）；不要直接写 pptx。',
      '2. 每页制作后依次运行：ppt_render → ppt_verify（数字审阅）→ ppt_shot（有读图能力时视觉审阅）；overlap/out-of-page/text-overflow 错误清零后才算通过。**重叠语义（设计意图声明制）**：设计页面时把**有意**重叠的元素对记入页面 `expectedOverlaps`（图片上标注、色块衬底、箭头跨越等）；审阅时警告级重叠逐对与声明对照——命中 = 确认（✓ 预期重叠），未命中 = 设计预期外错误（修正布局，或确认是有意的 → 补声明再验）；**嵌套承载（面板→框→文字）只需声明相邻层对，隔层由声明闭包自动通过**；**内容互压（文字/表格/图表相互遮挡）不支持声明豁免，永远错误**；纯装饰元素可加 `role: decoration` 豁免**重叠**（装饰性=设计意图声明）。**出界分级（与声明制同构）**：超页面边界=永远错误不可声明；超安全区（模板页眉页脚带）=声明制——有意落在带上的 logo/角标/水印逐元素写入页面 `expectedOutOfSafeArea`（不批量、必须手工，id 必须存在）；未命中=错误。declaration 之后若要免声明批量使用：仅重叠可用 `ppt_verify autoDeclare=true`（见入门段），出界声明永远手工。',
      '3. 样式只用 theme token（$colors/$textStyles 引用）；新增风格先改 theme，不允许页面里出现脱离主题的颜色/字号。',
      '4. 文本必须给出文本框实际容纳能力：先算文本面积再放框（字体字号→行宽行数），溢出用更小字号或更大框修复，不要靠视觉猜。',
      '5. 用户明确要求（hardConstraints）任何模式下严格遵循；未指定处可自决。',
      '6. 素材：用户提供的 > 从用户内容提取（文档/网页）> 自行生成/搜索；素材理解（物理规格程序化读取 + 语义理解），无读图能力时请用户描述后写入素材说明。',
      '6a. **视觉理解通道（v0.8.0，先看后做）**：用户提供的 .pptx（参考稿/待改稿）先用 `ppt_visual`（本机有 Office 时）渲染逐页 PNG → read_image 逐页/抽样查看——**把视觉理解（配色/版式/形状语言/字体气质/渐变阴影）写入设计摘要**；无 Office 时降级为 XML 推断 + 说明"未经 Office 真渲染理解"。**"完整明白原稿长什么样"是参考类任务的第一步，不能跳过**。',
      '6b. **模板决策（S1 前完成，需求 2/4）**：任务附用户模板文件 > 未附时问一次"内置模板库 or 从零定调"（ppt_templates 展示清单与预览图）> 从零。内置模板：business-blue 商务蓝 / academic-white 学术会议 / tech-dark 科技深色 / pitch-bold 路演大字；选定后 ppt_new dir=<工作区> template=<id> 复制工作区。**模板工作区语义（v0.7）**：`pages/_*.yaml` 是参考母版（**不注册进 deck.pages，不进 render/verify 门禁**，仅作版式参照）；`pages/01_opening.yaml` 是模板首母版的**正式副本**（注册进门禁）——先 `ppt_verify autoDeclare=true` 声明模板固有有意叠层，剩余错误是模板原文案残留，替换/删除后自然干净；新增正式页 = 复制母版去 `_` 前缀 + 注册进 deck.yaml pages。"统一模板保持基础样式"要求走同一路径（模板文件先 ppt_import 并启用其 theme 聚合块）。**模板一致性（v0.5）**：verify theme-conformance strict 默认门禁——页面颜色必须 ∈ theme.colors 或中性灰；页面要新颜色就先加进 theme。',
      '7. 交付前：S4 全通过 + S6 导出 .pptx + 交付说明（素材来源、未视觉审阅项、修改指引）。制作进程中**供用户看稿优先用 ppt_preview(dir)**（返回同源预览链接，用户点击即看，附在交付信息里）；导出前/后均可预览。',
      '8. 版式系统（审美约束）：写页面之前先定版式规则——8px 网格对齐、3-4 级字号阶梯、4-5 色主题（只在 $theme 内取色）、统一间距节奏（8/16/24px）、左右外边界一致、构图重心居中。文字：短句化（每块 ≤60 字），中文最小字号 12pt，长句在语义断点显式 \\\\n 换行。',
      '9. 审美建议（ppt_verify 输出的 [·] 建议）不是门禁，但请逐条斟酌采纳；overlap/out-of-page/text-overflow 错误仍必须清零（审美改进不得引入元素区块冲突）。',
      '10. 引擎：auto 默认 = pptd（自研主引擎，图表矢量拼绘）；pptd 硬失败时自动回退 python-pptx（报告醒目标注降级）；python-pptx 仅用户显式指定时使用（其图表降级为表格）——除非用户要求，不要自行切换引擎。',
      '11. 质量档 audit（/ppt quality audit，从严门禁）：禁 autoDeclare（工具已拦）；每页必须 ppt_shot + 读图视觉审阅（无读图能力则降级结构 Lint 并在交付说明标注"未经视觉审阅"）；导出报告必须包含并核对 audit 回读断言（页数/尺寸/最小字号 ≥ minFontSize）；有 Office 时导出后自动 **Office 真渲染**（成品视觉审核，逐页 read_image）；交付说明含素材来源与数据脱敏/假设标注。',
    ].join('\n'),
  }
}

/** 协作各维度 x 提示的轻量文案（供 S0 使用，已含在 section）。 */
export function modeBrief(cfg) {
  const mode = cfg.mode === 'auto' ? '自适应' : cfg.mode
  const fidelity = cfg.fidelity === 'auto' ? '自适应' : cfg.fidelity
  return `PPT 工作流（${mode} / ${fidelity} / review=${cfg.review} / quality=${cfg.quality}）`
}
