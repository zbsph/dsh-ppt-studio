/**
 * ppt-studio 路由：语义检测（双通道之"语义"）+ 工作流提示词注入。
 * 规则（设计定稿）：明确 PPT 任务意图才进、明确无关才退、弱信号不切；
 * /ppt on|off 命令强制（命令>语义）；工作流是"语境"而非能力切换。
 */

/**
 * PPT 意图判据（本轮修正）：
 * 旧实现是"动词紧邻名词"的固定式正则（`做\s*(一个)?\s*ppt`），只能命中"做个 PPT"这类最短句式；
 * 真实说法「帮我做一个 5 页的产品介绍 PPT」因为中间有修饰语而**判为无意向**——工作流提示词从不注入
 * （0.1.5-rc.2 适配期实测：28 次 system-prompt/assemble 全部无 ppt-workflow 段）。
 * 现改为"名词 + 任务动词在邻近窗口内共现"，两个方向都算：
 *   - 仍要求**显式任务动词**（保持"弱信号不切"：只提一句 PPT 不激活）；
 *   - 允许中间夹修饰语（页数/主题/定语），窗口 32 字符；
 *   - 附件是 .pptx/.ppt 时直接视为强意图（用户把原稿递过来了）。
 */
const PPT_NOUN_RE = /(?:ppt|pptx|powerpoint|幻灯片|演示文稿|演示文档|汇报文稿|deck|slides?)/i
const PPT_VERB_RE = /(?:做|制作|生成|创建|撰写|编写|设计|搞|整|改|修改|调整|调|补|补充|补完|添加|新增|追加|增页|加页|加几页|插入|美化|优化|统一|整理|替换|重做|换|总结|提炼|梳理|复盘|概述|浓缩|汇报|转换|复刻|导出|排版|配图|配色)/
/** 名词与动词之间允许的最大间隔（修饰语长度）。 */
const PPT_INTENT_WINDOW = 32

export function isPptIntent(text, attachments) {
  const t = text ?? ''
  if (!t && !attachments?.length) return false
  // 附件是 ppt/pptx：强意图（用户把原稿/模板递过来了）
  if (attachments?.some((a) => /\.pptx?$/i.test(a.name ?? a.path ?? a.filename ?? ''))) return true
  if (!t) return false
  return nearCooccur(t, PPT_NOUN_RE, PPT_VERB_RE, PPT_INTENT_WINDOW)
}

/** 两个模式是否在 text 中以 ≤ window 字符的间隔共现（与先后顺序无关）。 */
function nearCooccur(text, aRe, bRe, window) {
  const a = allMatches(text, aRe)
  if (a.length === 0) return false
  const b = allMatches(text, bRe)
  if (b.length === 0) return false
  for (const x of a) {
    for (const y of b) {
      const gap = x.index <= y.index ? y.index - (x.index + x[0].length) : x.index - (y.index + y[0].length)
      if (gap <= window) return true
    }
  }
  return false
}

function allMatches(text, re) {
  const out = []
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  let m
  while ((m = g.exec(text)) !== null) {
    out.push(m)
    if (m.index === g.lastIndex) g.lastIndex++
    if (out.length > 64) break
  }
  return out
}

/** 判断用户消息是否"明确无关"（触发工作流退出）。仅在工作流已激活时生效。 */
const PPT_OFF_RE = new RegExp(
  [
    // 否定/停止 + 名词：「不用做 PPT 了」「先不做幻灯片」
    String.raw`(?:别|不用|不需要|不要|取消|停止|退出|不做|不搞|不写|先不|别再|放弃).{0,8}(?:ppt|pptx|幻灯片|演示文稿|演示文档|deck|slides?)`,
    // 名词 + 收尾语：「PPT 不做了」「演示文稿先放一放」
    String.raw`(?:ppt|pptx|幻灯片|演示文稿|演示文档|deck|slides?).{0,8}(?:不做了|不弄了|不用了|先不做|先放一放|暂停|算了|到此为止)`,
    // 明确划清界限：「这跟 PPT 无关」「不是幻灯片」
    String.raw`(?:这|此|那|该)?(?:和|跟|与)?.{0,6}(?:ppt|pptx|幻灯片|演示文稿).{0,6}(?:无关|没关系|不是|无关紧要)`,
    String.raw`(?:无关|不是|不属于).{0,6}(?:ppt|pptx|幻灯片|演示文稿)`,
    String.raw`(?:ppt|pptx|幻灯片|演示文稿).{0,6}(?:无关|之外|以外)`,
  ].join('|'),
  'i',
)

export function isPptOff(text) {
  if (!text) return false
  return PPT_OFF_RE.test(text)
}

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
        '2. 版式：直接用内置模板骨架（封面/内容/结尾 3 件套），不做视觉定调；只用主题默认色 + 2-3 级字号（下限以用户指令为准；未给下限不做强制）。',
        '3. 素材：只使用用户提供或纯色块/图形表达；不做素材搜索、不生成复杂图表（需要时用表格或简单柱形）。',
        '4. 页数：≤8 页（用户指定除外）；每页文本精简（每块 ≤40 字为默认参考，用户要求可放宽）。',
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
      '  - 制作手册（内置技能，按需加载；纯增益，不改任何铁律与门禁）：定纲/定版式前加载 `ppt-studio-craft`；页面要放数字与图表时加载 `ppt-studio-data`；写标题与要点时加载 `ppt-studio-copy`。三本只给启发式与反例——**门禁数值一律以 ppt_verify 输出与用户指令为准**；不加载也照常工作。',
      '  - line 元素可省略 bounds（由 points 的 AABB 自动推导，w/h≥1px）。',
      '  - 模板背景带 logo/页眉/页脚带：在 deck.yaml theme.safeArea（或页面级 safeArea）配置上/下/左/右安全边距，verify 会把安全区外的元素判为出界；ppt_render debug=true 会画出安全区参考框。',
      '  - 文本溢出：verify 与导出共用同一保守度量；**字号下限 = 用户指令**——用户给出最小字号（如"不得小于12号"）→ 把该值写入 theme.minFontSize 并严格执行（导出 auto-fit 缩字不得低于它，到下限仍溢出）会明确报告（✗）请扩大容器或精简文案；用户未给下限 → 不做强制（auto-fit 仅 60% 原字号保底，绝不升字）。',
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
      '6a. **视觉理解通道（v0.8.0→v0.9.1，先看后做；参考任务 = 参考双轨）**：用户提供的 .pptx（参考稿/待改稿）经 `ppt_import` 后工作区**自动带参考层**——`reference/source.pptx`（零失真真相）+ `reference/previews/NN.png`（Office 真渲染整页，COM 可用时）+ deck.yaml 顶部 `referenceSource`。**创作前先 read_image 看 reference/previews/*.png（整页真身：配色/版式/形状语言/字体气质/渐变阴影）→ 视觉理解写入设计摘要，再动手**——与模板双轨（6b）"按模板做"是同一通道、完全等价；无 Office 时自动降级（XML 推断 + source.pptx 可用 `ppt_visual` 补渲 + 标注"未经 Office 真渲染理解"）。**"完整明白原稿长什么样"是参考类任务的第一步，不能跳过**。',
      '6b. **模板决策（S1 前完成，需求 2/4）**：任务附用户模板文件 > 未附时问一次"内置模板库 or 从零定调"（ppt_templates 展示清单与预览图）> 从零。内置模板：business-blue 商务蓝 / academic-white 学术会议 / tech-dark 科技深色 / pitch-bold 路演大字；选定后 ppt_new dir=<工作区> template=<id> 复制工作区。**模板工作区语义（v0.7）**：`pages/_*.yaml` 是参考母版（**不注册进 deck.pages，不进 render/verify 门禁**，仅作版式参照）；`pages/01_opening.yaml` 是模板首母版的**正式副本**（注册进门禁）——先 `ppt_verify autoDeclare=true` 声明模板固有有意叠层，剩余错误是模板原文案残留，替换/删除后自然干净；新增正式页 = 复制母版去 `_` 前缀 + 注册进 deck.yaml pages。"统一模板保持基础样式"要求走同一路径（模板文件先 ppt_import 并启用其 theme 聚合块）。**模板一致性（v0.5）**：verify theme-conformance strict 默认门禁——页面颜色必须 ∈ theme.colors 或中性灰；页面要新颜色就先加进 theme。**模板双轨（v0.9）**：模板 = 骨架层（pages/_*.yaml 母版，结构机器可验证）+ 真相层（原始 pptx + Office 真渲染整页 PNG + styleAudit）。materialize 后工作区含 `reference/`（template.pptx、previews/NN.png、audit.yaml），deck.yaml 顶部记 `referenceTemplate`（id/previews 路径/audit 引用）。**"按模板做" = "参考用户给的 ppt 制作"，完全等价（同一参考双轨通道）**：创作前先 read_image 看 `reference/previews/*.png`（整页真身：配色/版式/形状语言/字体气质/渐变阴影）→ 读 `reference/audit.yaml`（视觉审计缓存，`ppt_template_styleaudit` 一次性生成）→ 视觉理解写入设计意图 → 再动手创作；无 reference（无 Office 收纳/内置模板）则退化为骨架层 + audit 缺失说明，不再有"从 40% 保真近似里猜"的失真环节。**手术模式（v0.10，候选 B）**：成品要"看起来就是模板原样"时用 `ppt_patch`（模板真身 + 工作区内容——只改 <a:t>，rPr/几何/渐变/字体/图片原样保留；未动页内容 sha256 验证不变；与 ppt_export 互不影响，常规导出仍走渲染）。模板工作区自带 reference/template.pptx 时直接用它作底版。',
      '7. 交付前：S4 全通过 + S6 导出 .pptx + 交付说明（素材来源、未视觉审阅项、修改指引）。**数据来源核查表（M3）**：重要数字页面用 `ppt_crosscheck`（跨页数字对账 + source 标注核查表）作为交付说明的"数据来源核查表"段——标注过的页为 grounded、未标注页提示补标注（unmapped）；跨页重复数字逐组人工核对"同一指标多页值是否一致"。制作进程中**供用户看稿优先用 ppt_preview(dir)**（返回同源预览链接，用户点击即看，附在交付信息里）；导出前/后均可预览。**修改既有精美 PPT 的某一页（edit/augment 高频场景）**：ppt_import 参考层读真身 → 改工作区页并审阅清零 → **`ppt_splice`**（只把该页替换进原稿：保留源母版横幅/页脚/备注关系/媒体，其余页条目 SHA256 逐字节一致——不要整册近似重渲伤及其他页）→ 交付整册副本；用户要"单页独立版"再 **`ppt_slice`**；抽查该页观感用 **`ppt_visual pages=N`**（按页真渲染，不必整册）；"看起来就是模板原样"用 `ppt_patch`（手术贴模板）。',
      '8. 版式系统（审美基线，用户风格优先）：写页面之前先定版式规则——默认基线：8px 网格对齐、3-4 级字号阶梯、4-5 色主题（只在 $theme 内取色）、统一间距节奏（8/16/24px）、左右外边界一致、构图重心居中；**用户对风格有要求（字体/字号/配色/密度）一律优先，默认基线仅为未指定时的风格参考**。文字：短句化（每块 ≤60 字为默认参考，可依内容放宽），**文本最小字号以用户指令为准**（hardConstraints；未给下限不设强制），长句在语义断点显式 \\\\n 换行。',
      '9. 审美建议（ppt_verify 输出的 [·] 建议）不是门禁，但请逐条斟酌采纳；overlap/out-of-page/text-overflow 错误仍必须清零（审美改进不得引入元素区块冲突）。',
      '10. 引擎：auto 默认 = pptd（自研主引擎，图表矢量拼绘）；pptd 硬失败时自动回退 python-pptx（报告醒目标注降级）；python-pptx 仅用户显式指定时使用（其图表降级为表格）——除非用户要求，不要自行切换引擎。',
      '11. 质量档 audit（/ppt quality audit，从严门禁）：禁 autoDeclare（工具已拦）；每页必须 ppt_shot + 读图视觉审阅（无读图能力则降级结构 Lint 并在交付说明标注"未经视觉审阅"）；导出报告必须包含并核对 audit 回读断言（页数/尺寸/最小字号 ≥ minFontSize）；有 Office 时导出后自动 **Office 真渲染**（成品视觉审核，逐页 read_image）；交付说明含素材来源与数据脱敏/假设标注。',
      '12. **真渲染抽检铁律（P1 事故教训）**：有 Office 时，真渲染抽查**必须覆盖所有含 table/chart/image/custGeom 的页**（每类至少一页，其余页轮换）——不要只挑"美观重点页"；抽查后逐页 read_image（渲染图已带 1px=1pt 比例标注水印，降低坐标误判）。导出报告会给出建议覆盖页清单（P8 行）。',
    ].join('\n'),
  }
}

/** 协作各维度 x 提示的轻量文案（供 S0 使用，已含在 section）。 */
export function modeBrief(cfg) {
  const mode = cfg.mode === 'auto' ? '自适应' : cfg.mode
  const fidelity = cfg.fidelity === 'auto' ? '自适应' : cfg.fidelity
  return `PPT 工作流（${mode} / ${fidelity} / review=${cfg.review} / quality=${cfg.quality}）`
}
