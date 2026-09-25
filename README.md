# PPT 工作室（dsh-ppt-studio）

在 DeepSeek Harness 里说需求，它把 PPT 做出来：先定大纲和版式，再逐页制作，每页过一遍自动检查，最后交付一个能用 PowerPoint 打开、继续改的 `.pptx`。

当前版本 **1.0.4**，安装包 **866 kB**（1.0.3 及更早的版本是 35 MB，因为随包带着 4 套没人用过的导入模板，1.0.4 把它们删了）。

装上之后，**这个 profile 的所有会话都能用**，不需要专门切到某个预设。预设「PPT 工作室」提供的是人格和身份，不是"开关"。

---

## 1. 装上

### 1.1 需要什么

一台能跑 `dsh web` 的机器，或者 **DeepSeek Harness 桌面端**（桌面端见 §1.7，装法不同）。宿主版本要求 **DSH `>= 0.1.7-rc.1`**（本包 1.0.7 起；`0.1.7-rc.1` 命令行版验过，`0.1.7-rc.2` 命令行版与**桌面端**都验过）。Office、Edge/Chrome、python-pptx 都是**可选增强**：没有它们插件照常工作，只是真渲染、截图、兜底引擎这些能力自动降级，交付说明里会写明。

### 1.2 一条命令

**npm（推荐）**：包名就叫 `dsh-ppt-studio`，装的人不需要 npm 账号（公开包匿名可下载）。

```powershell
dsh plugin --profile web add dsh-ppt-studio
# 装完重启 dsh web
```

升级用 `dsh plugin --profile web add dsh-ppt-studio@latest`（不带 `@latest` 时 pnpm 可能认为已满足当前范围而跳过）。

**或者从 Releases 装 tgz**（离线 / 归档通道；内容与同版本 npm 包一致）：

从 [Releases 页面](https://github.com/zbsph/dsh-ppt-studio/releases) 复制**最新那条** `.tgz` 资产的完整链接，然后：

```powershell
dsh plugin --profile web add <粘贴那条资产 URL>
```

本插件声明了 `dsh.bundle.patch`（仓库根的 `cordis.patch.yml`），所以**装完就挂上了**：不用手工建链接，不用跑安装器。

> npm 包与同版本的 Release 资产是**同一份字节**：发布时先冻结提交、两条通道各跑一次 `npm pack`（同一棵树 ⇒ 同一个 tgz），所以两条命令装到的内容一致。

资产名形如 `dsh-ppt-studio-1.1.0-20260926-0204-8f428210.tgz`：版本、构建时间、构建内容的前 8 位哈希。页面会保留历次构建，所以**按上传时间取最新那条**。懒得翻页面就用这行拿名字：

```powershell
gh release view v1.1.0 --json assets --jq '.assets | sort_by(.createdAt) | last | .name'
```

也可以直接装仓库地址，产物和 tgz 一样（`lib/` 已入库）：

```powershell
dsh plugin --profile web add https://github.com/zbsph/dsh-ppt-studio
```

> 为什么资产名不固定：同一个 URL 用 `--clobber` 覆盖内容后，pnpm 会复用本地旧副本，`dsh plugin add <同一 URL>` 不会重新下载（2026-09-15 实测，`--force` 也绕不过）。把构建哈希写进文件名，URL 必变，升级才真的换字节。

### 1.3 装完怎么确认

```powershell
dsh --profile web --dump-config      # 组合树里应出现 ppt-studio 插件行
```

看到这行就说明挂上了，重启 `dsh web` 后生效。

### 1.4 升级 / 卸载

```powershell
# 升级：拿新的资产 URL 再跑一次 add，不需要先卸载
dsh plugin --profile web add <新的资产 URL>

# 卸载
dsh plugin --profile web remove dsh-ppt-studio
```

从 v1.0.2 或更早升上来的注意一件事：那时的包名是 `@dsh-external/dsh-ppt-studio`。旧包会作为独立依赖留在 profile 里，和新包一起被挂载两次。先摘掉它：

```powershell
dsh plugin --profile web remove @dsh-external/dsh-ppt-studio
```

同时装不会崩（插件里有防重），但没必要。安装器检测到旧包残留时会提醒你。

### 1.5 没有 pnpm，或者想离线装

下载 `.tgz`，解压到任意目录，然后跑安装器：

```powershell
tar -xzf dsh-ppt-studio-<版本>-<构建时间>-<构建戳>.tgz -C D:\plugins
node D:\plugins\package\scripts\install.mjs
# 自定义 DSH_HOME：加 --prefix <你的 .dsh 目录>
# 指定安装规格：--spec <URL|目录>；跳过预设资产校验：--no-preset
```

安装器是幂等的，重复跑会跳过已经存在的项。装完一样要重启 `dsh web`。

如果你已经在用 dsh-super-injector，在注入器环境里对解压目录（或源码目录）跑 `dev_inject_plugin` 也行，注入器负责建链接和重启恢复。

### 1.6 想让工具只在「PPT 工作室」里出现

**本版本（DSH 0.1.7 及以后）不支持这种隔离**，安装器的 `--isolate` 会直接拒绝并说明原因，而不是写出一个永远不会被读到的预设。

原因是宿主换了机制：0.1.6 及以前，预设是"磁盘上的一个目录"（`~/.dsh/.agent-presets/ppt/`），
所以隔离可以靠"预设目录里放一个链接 + 预设里写一行相对路径"实现；**0.1.7 把目录发现整个删掉了**
（上游原文：*the harness discovers no preset on disk*），预设改为向 `agentPresets` 注册表**声明**，
而预设里的每一行都要在**注册表所在那一层**的路径下解析——那里既不是你的 profile，也不是预设目录，
所以相对路径和包名都解析不到，预设会被判 `broken`，选择器里根本不会列出它。

于是本版本只有一条受支持的装法：**默认的全局装法**（`dsh plugin add` / `install.mjs` 不带 `--isolate`），
这个 profile 的所有会话都能用 ppt_* 工具与手册。预设「PPT 工作室」仍然存在、仍可选，它提供的是**人格与身份**（见 §1.1）。

> 想要"只在某个预设里生效"需要把插件行写进**预设声明本身**，并给它一个安装期算出的绝对 `file://` 名字。
> 这块还没做——宁可明确拒绝，也不静默失败。

### 1.7 桌面端（DeepSeek Harness 应用）

桌面版把 harness 打在自己的应用目录里，**profile 是独立的 `desktop`**（`~/.dsh/profiles/desktop`），
所以你之前给 `web` profile 装的那份不会自动出现在桌面端。

装法不同，因为桌面端有两条限制：

- **命令行不让你碰 `desktop` profile**。`dsh plugin --profile desktop ...` 会直接报
  `profile "desktop" is managed exclusively by the Electron application`，
  启动和插件管理都是这样，没有绕过开关。
- **桌面端自带的 pnpm 装不了 tarball 网址**。它内置 pnpm 11.7.0，而桌面 profile 用的是
  `nodeLinker: hoisted`；这个组合下 `pnpm add <https…tgz>` 会报
  `ERR_PNPM_MISSING_TARBALL_INTEGRITY`。同样的 URL 换成 pnpm 11.21 或去掉 `nodeLinker` 都能装上。

所以桌面端用专门的安装器（它只调用**应用自带的** pnpm 和 Node，不会用系统 Node 去重编 profile 里的原生模块）：

```powershell
# 从发布包解压后（或直接对源码目录）
node D:\plugins\package\scripts\install-desktop.mjs
# 自定义：--prefix <你的 .dsh 目录> / --app-dir <应用目录> / --spec <URL|tgz|目录>
# 先看看它会做什么、不动盘：--dry-run
# 卸载：--uninstall
```

它会：把本包打成一个 tgz 放进 `<profile>/.dsh-plugins/`，以相对 `file:` 规格装进 profile
（这样不会因为外部目录被删而让桌面端下次装依赖时失败），再把包名补进 `dsh.profile.bundles`
（桌面端启动只认这个列表）。装完**必须重启桌面端**——bundle 层在启动时组合，不热更。

> 显式给 `--spec <https…tgz>` 时，安装器会先按原样试；撞上上面那个缺陷就自动回退
> （有可用的系统 pnpm 就用它，否则下载到 profile 内走 `file:`）。
> 两条路都实测过。安装失败时它会**把 profile 文件还原回原样**，不会留半个状态给你。

重启后确认：新建会话的预设选择器里能看到「PPT 工作室」；在会话里调一次 `ppt_state`，
`presetDelivery` 字段会写明预设声明成功与否。

---

## 2. 用起来

### 2.1 三步

1. 进入「PPT 工作室」，直接说需求，比如"帮我做一个 10 页的年度总结 PPT"。它会按题材定风格；你也可以点名用内置模板（"用内置模板"），或者把它自己的 ppt 丢给它参考。
2. 跟着工作流走：澄清需求 → 定大纲 → 定版式 → 逐页制作 → 页审 → 整体审 → 导出。每页做完会自动跑一遍渲染和检查。
3. 拿交付物：`.pptx` + 中间层工程 + 一份说明（素材来源、没做视觉审阅的部分、怎么改）。对话里会给你一个预览链接，点开就能看。

```text
/ppt quick           # 快速模式：省 token，页数≤8、文本精简、跳过视觉审阅（交付说明会标注）
/ppt normal          # 完整模式（默认）
/ppt quality audit   # 从严档：禁止一键声明、强制逐页视觉审阅、导出后回读断言 + 真渲染复核
/ppt template <id>   # 记本会话默认模板
/ppt help
```

还不熟 DSL 的话，让它先 `ppt_new(dir=D:\demo)` 生成一个能跑通的示例工程，改那个比从空文件写快。

### 2.2 四类任务

| 任务 | 怎么说 | 它怎么做 | 你拿到什么 |
|---|---|---|---|
| 从头做 | "做一个 XX 主题的 PPT" | 按题材定风格（你指定用内置模板、或某个模板明显适配时才用现成的），逐页做 | 完整工程 + pptx |
| 补完 | "补两页 / 加个章节" | 复制母版当参考，新增页注册进页表 | 追加后的工程 + pptx |
| 修改 | "改第 15 页 / 美化这页" | 导入原稿读真身 → 只改这页 → 替换回原稿 | 整册只变一页（其余页逐字节不动）+ 可选单页版 |
| 总结 | "把这 50 页总结成 10 页" | 导入全稿，提炼重排 | 新工程 + pptx |

任务是按语义识别的：说清楚是 PPT 需求才进入工作流，随便提一句"我昨天做了个 PPT"不会误触发。

### 2.3 自带 4 本手册

插件里内置了 4 本手册，模型按需加载，不用你管：

| 手册 | 什么时候用 |
|---|---|
| `ppt-studio-manual` | 你**提问**时用（"这插件怎么用 / XX 怎么写 / 为什么报错"）。制作过程中不加载 |
| `ppt-studio-craft` | 定大纲、定版式，"这页怎么排 / 太挤 / 太像模板了" |
| `ppt-studio-data` | 页面要放数字或图表 |
| `ppt-studio-copy` | 写标题要点，"太 AI 了 / 像机器写的" |

这 4 本是纯增量：只给启发式和反例，不改规则、也不定义任何检查数值。没有 `dsh-skill` 服务的极简装配下也能用，只是手册不以目录形式出现。

---

## 3. 模板

自带 4 套自研风格，每套含主题和 6 张版式母版：`business-blue`（商务蓝）、`academic-white`（学术会议）、`tech-dark`（科技深色）、`pitch-bold`（路演大字）。

**什么时候会用它们**：你明确要求用内置模板时（它把清单和预览图给你挑），或者某个模板明显贴合你的题材时。**你没提模板的话，它默认按题材自己设计风格**，不会拿现成模板凑——历史题材那种明显不适配的，硬套只会更差。**如果你给它自己的 PPT，或让它改你已有的稿，它只参考你那份**，内置模板完全不参与。

```text
ppt_templates                      # 看清单和预览图
/ppt template business-blue        # 记本会话默认
ppt_new(dir=D:\demo, template=business-blue)   # 物化成工作区
```

物化出来的工作区里，`pages/_*.yaml` 是**参考母版**（不进检查），`01_opening.yaml` 是正式页。第一件事是跑 `ppt_verify autoDeclare=true` 把模板自带的有意叠层声明掉；剩下的错误都是模板原文案残留，替换掉就干净了。

想用自己的模板：**把 .pptx 直接交给它**，一句话就行（"把这个模板加进模板库"）。它会保留你那份原始 pptx 当真相层，存到**你自己的模板库**里：

```text
ppt_template_add pptx=D:\我的模板.pptx        # 入库（可给多份，逐个来）
ppt_template_remove id=我的模板                # 删掉（只能删你自己加的）
ppt_templates                                # 看清单：你的 + 随包的分别列出
```

你的模板库在 `~/.dsh/ppt-studio/templates/`（Windows：`C:\Users\<你>\.dsh\ppt-studio\templates`）。它**不在插件包里**，所以升级插件不会丢；随包那 4 套是只读的，删不掉（删了升级也会回来，不如不删）。入库之后，你自己的模板和随包模板在清单里同等可选，而且按上面的政策，**你给的模板优先级最高**——要用它就直接说。

> **1.0.4 变更**：随包不再带 4 套"从真实 PPT 导入"的重型模板（实用毕业设计论文答辩、极简实用部门工作总结、深蓝质感论文答辩、简约商务）。它们合计 46.2 MB，占安装包 96%，实际从未被用过。想找回来：从 [v1.0.3 的资产](https://github.com/zbsph/dsh-ppt-studio/releases/tag/v1.0.3) 里取 `package/templates/<id>/`，或从 git 历史取 `git show v1.0.3:templates/<id>/...`（注意 `previews/` 是 Office 渲染产物，没进 git，只在资产里）。放回 `templates/` 就能用。

---

## 4. 保真与改稿（三条通道）

| 你的目标 | 用什么 | 保真到什么程度 |
|---|---|---|
| 想"像"某个模板或原稿 | `ppt_import` 导入 → 看 `reference/previews/*.png` 真身 → 自己创作 | 风格级，版式由你掌控 |
| 要"看起来就是模板原样" | `ppt_patch`（只替换文字和表格内容，样式几何图片原样保留） | 结构级，模板 XML 不动 |
| 改既有精美 PPT 的**某一页** | `ppt_splice` 替换一页；要单页文件再用 `ppt_slice` | 逐字节级，其余页 SHA256 自证没动 |

改一页的标准流程：

```text
ppt_import(<源.pptx>, D:\work)          # 导入，顺带拿到参考层
# 先看 reference/previews 里的整页真身，再改 D:\work\pages\slide_15.yaml
ppt_render → ppt_verify                  # 检查清零
ppt_splice(dir=D:\work, source=<源.pptx>, page=15)   # 整册副本，只变第 15 页
ppt_visual(pptx=<spliced 产物>, pages="15")          # 抽查这页真实观感
```

改一页别用"整册重新导出"：近似稿重渲会顺手改坏其他页的观感。`ppt_splice` 只替换目标页，其余条目逐字节不变，它会自己打印 SHA256 校验结果。

---

## 5. 常见问题

**装了但好像没生效？**
按顺序查：`dsh plugin --profile web list` 看包装上没 → `dsh --profile web --dump-config` 看组合树里有没有 `ppt-studio` 行 → **重启 dsh web**。第二步看不到通常是版本太老（v1.0.0 之前没有 `dsh.bundle` 声明，装了不挂载），升级后重装一次。

**为什么 verify 报重叠，可我就是想让它重叠？**
把这对元素写进该页 `expectedOverlaps` 再重验，命中就显示 ✓ 预期重叠。嵌套的卡片只要声明**相邻层**（面板→框→文字），隔层自动通过。但文字压文字、表格压图表这种**内容互压永远不放过**，那是真冲突，得改布局。

**样式写了没生效。**
样式键必须写在 `content` 里面。元素级写 `fontSize: 14` 无效，`ppt_check` 会直接报错。

**字号能到 11pt 吗？**
能。字号下限**只由你的指令决定**：你说"不得小于 14 号"，它就写进 `theme.minFontSize` 并严格遵守；你没说，就没有强制下限（导出自动缩字最多到原字号的 60%，不会往上抬）。表格单元格另有 11pt 的底。

**导出总在缩字。**
先看 verify 是不是已经报了溢出。溢出清零后导出就不会再缩。只有个别页有存量问题（导入的近似稿常见），用 `ppt_splice` 改那一页，别整册重渲。

**中文长句被误报溢出。**
度量偏保守，宁可误报不可漏报。按提示加宽容器、精简文案，或在语义断点显式 `\n` 换行。想确认到底溢没溢，跑 `ppt_measure` 用浏览器实测复核（实测是终审）。

**预览链接 404。**
路由由「PPT 工作室」会话挂载时注册。确认当前会话是 PPT 工作室；进去之后链接就有了。

**没有 Edge / 没有 Office 还能用吗？**
能。截图、实测、真渲染会自动降级并标注，HTML 预览和结构检查照常。交付说明里会写"未经视觉审阅"。

**图表支持哪些？**
bar / line / pie，矢量拼绘，导出的图在 PowerPoint 里可编辑。用 python-pptx 兜底引擎时会降级成表格（报告里会标注）。复杂图表建议用图片，或者直接用形状拼。

**讲稿能进 pptx 吗？**
能。页面写 `notes:`（多行用 `|` 块标量），导出就成了 PowerPoint 备注页，`ppt_import` 也能读回来改。没写 `notes:` 的页不会产生备注部件，老工程导出结果不变。翻页和计时属于放映设置，不在插件范围内。

**导入后文字里出现 `&amp;` `&lt;`？**
不该出现（2026-09-14 修）。旧版本导入的工程重新 `ppt_import` 一次即可。

**报告里出现"质量档降级"？**
你的工程状态文件（`state.json`）损坏或读不出来，插件按 standard 继续跑，audit 档的额外检查这一轮没生效。修好文件或重跑 `/ppt quality audit`。2026-09-18 起这类回落会明说，之前是静默的。

**装的时候下载超时？**
网络抖动时在 `~/.dsh/profiles/web/.npmrc` 里加这几行，然后重跑：

```ini
fetch-timeout=600000
fetch-retries=5
fetch-retry-maxtimeout=120000
```

失败不会破坏已有安装，直接重试。

**表格在 PowerPoint 里不见了 / 一片空白？**
v1.0.0 修订前旧引擎的结构 bug（graphicFrame 里嵌了 `<a:xfrm>`，PowerPoint 会静默丢帧）。已修复，导出报告现在带 parity 回读自证（表 N/N、图 M/M、线方向 N/N）。旧产物重新 `ppt_export`。

**网页预览是对的，打开 pptx 斜线方向反了 / 叉号少一笔 / 水平线变斜了？**
同一个家族的三个旧引擎编码 bug，都已修复：连线方向丢 `flipH/flipV`、箭头 `<a:tailEnd>` 写在 `<a:ln>` 外面、水平线包围盒被 `max(1,…)` 抬成 1pt 高。导出报告的 parity 行会逐条从 OOXML 反推端点自证。**修复前导出的产物请重新 `ppt_export`**。

**真渲染图上怎么有水印？**
那是比例标注（"1px=1pt · 960×540" 加细边框），防止人工读图时把坐标看错。脚本参数 `noWatermark` 可以关。

**PowerShell 解压 .pptx 报 "not a supported archive format"？**
`Expand-Archive` 只认 `.zip`。先复制成 `.zip` 再解，或者用 `tar -xzf <file> -C <out>`。

**Office 渲染时窗口闪一下？**
正常，PowerPoint COM 需要。只读打开，结束自动释放。

**升级 DSH 之后「PPT 工作室」选不出来，或者切过去就报错？**
先分清是"预设漂移"还是"宿主换了预设机制"，两者的修法不同：

- **内容漂移**：本插件的预设是随包 standard 预设的副本，只加了一处有意差异（persona 人格，理由写在 `agent-presets/ppt/agent.cordis.yml` 顶部，白名单在 `scripts/check-preset.mjs`）。上游改预设（改配置、加行、停用行）而副本没跟，会话行为就会不一致。发生过两次：`0.1.5-rc.2` 把 persona 从 `text` 改成必填的 `prefix`；`0.1.6-alpha.2` 删掉了 `dsh-workflow-worker-thread`、把 `tool-ralph` 改成默认停用、新增 `tool-plugin-manager`。修法是拿到修好的版本后重跑安装，或者单独跑 `node scripts/check-preset.mjs` 看漂移。
- **机制变更**：`0.1.7` 换了预设的交付方式（磁盘目录 → 注册表声明，见 §1.6），参照物文件也从 `dsh-agent-presets/presets/standard/agent.cordis.yml` 换成了 `dsh-web-app/presets/standard.patch.yml`。本包 1.0.7 起已适配；`check-preset.mjs` 两种格式都认，认到哪种会在输出第一屏写明。
- **完全看不到这个预设**：调一次 `ppt_state`，看 `presetDelivery` 字段——它会写明是否已声明、以及失败原因（例如宿主没装配 `agentPresets` 注册表）。这比翻日志可靠。

**插件对外只交付三样东西**：`ppt_*` 工具面 + `/ppt` 命令面、工作流提示段、内置手册。都挂在插件实例上，卸载即净。想确认手册通道：调一次 `ppt_state`，`manualSkill` 会报注册与可见状态。

---

## 6. 环境要求与已知边界

**环境**：DSH web `0.1.7-rc.2`（Windows 主机实测；COM/Edge 探测路径按 Windows 写的，macOS/Linux 未验证）。路径与中间层一律 UTF-8，也兼容 WPS 导出的 UTF-16 文件。

**支持的元素**：text / shape / line / image / table / chart。

- shape 支持 rect、roundRect、ellipse、triangle，常见的 prst 自选图形（箭头、菱形、五边形、流程图等），以及 custGeom 自定义路径，带旋转、纯色/渐变/透明度填充。
- line 只有两个点，多点折线要拆成首尾相接的多条。
- chart 支持 bar/line/pie；图表里的分类名、数值、单位、图例需要你自己用文本元素补上（DSL 里没有这些字段）。
- 背景支持 hex、主题引用、纯色、图片（cover/contain/fill）。

**这些不做，都有替代路径**：

- 文本度量是估算档加实测档。实测依赖浏览器；和 Office 原生排版之间存在字体级系统差异（加粗中文已按 1.06 倍补偿）。
- 导入不支持阴影、动画、超链接、母版继承；渐变归一到主色（原始 stops 存在 `import-styles.json`）；chart 降级成占位；EMF 媒体和 WPS 跨实现打开未验证。
- pptxgenjs 第三引擎没做，`/ppt engine pptxgenjs` 会被明确拒绝，不会静默换成别的引擎。python-pptx 只在兜底或显式指定时用，且里头的透明度和渐变按纯色近似。
- dsh 网页里的内嵌预览面板没做，对话内用 `ppt_preview` 和整览截图已经够用。
- **模板的整页真身预览需要本机装 Microsoft Office**。没有 Office 时，参考层只注入 `source: reference/template.pptx`，原件还在，可以自己打开对照。这一条有机器断言钉着：smoke 分别断言"有预览就必须注入并拷贝"和"没有预览就只能注入 source，且不得出现 previews 引用"。

---

## 7. 参考：中间层 DSL

整个工程就是 `deck.yaml` + `pages/*.yaml` + `media/`。渲染、检查、导出都读这一份，1px = 1pt，原点在左上，默认 960×540。

```yaml
version: 1
title: 我的演示
size: [960, 540]              # 也可写 {width, height}
theme:                        # 样式统一在 theme 定义，元素只引用 token
  colors: {primary: "#2563EB", ink: "#1F2937"}
  textStyles:
    title: {fontSize: 32, color: "$ink", bold: true}
    body: {fontSize: 16, color: "$ink"}
  safeArea: {top: 20, bottom: 20}   # 可选：模板页眉页脚带这类非内容区
  minFontSize: 14             # 可选：你给了字号下限时才写
pages:
  - pages/01_cover.yaml
```

页面文件：

```yaml
pageType: cover
background: "#F5F6F7"         # hex / $themeRef / {type: solid,color} / {type: image,src,fit}
notes: |                      # 可选：讲稿，导出成 pptx 备注页
  开场先给结论。
  第二行给证据。
elements:
  - elementId: t1             # 页内唯一，必填
    elementType: text         # text|shape|line|image|table|chart
    bounds: [60, 60, 400, 50] # 必填（line 可省，由 points 推导）
    content:
      text: "正文，长句在语义断点显式 \n 换行"
      style: "$body"          # 引用 theme.textStyles，或直接写样式字段（必须写在 content 内）
  - elementId: bar
    elementType: chart
    bounds: [60, 300, 400, 200]
    chart:
      type: bar
      data: {cols: [分类, 值], rows: [[甲, 10], [乙, 20]]}   # 只认 cols + rows；多系列加 series
  - elementId: card
    elementType: shape
    kind: roundRect           # 也可以是 rightArrow / diamond / flowchartProcess / custGeom …
    bounds: [60, 60, 400, 200]
    fill: "$colors.primary"   # 或 {color, alpha}、{type: gradient, stops: [...], angle}
    line: {color: "#FFFFFF", width: 1}
```

几个容易踩的点：

- 样式键必须在 `content` 里面。
- `expectedOverlaps` 两种写法等价：`[{pair: [a,b]}]` 和 `- pair: [a,b]`，每对一行。
- 声明里的 id 必须是本页真实存在的元素，写错会被防呆拦住。
- 更全的写法直接问模型（`ppt_schema`），或者看 `examples/smoke` 里的样例工程。

---

## 8. 参考：质量检查体系

核心思路：**重叠合不合法，由设计意图决定，不由元素类型决定**。设计时声明，审阅时对照。

**重叠**。有意重叠写进该页 `expectedOverlaps`，检查时逐对对照，命中就是 ✓，没命中就是错误（要么改布局，要么确认有意后补声明）。嵌套承载只需声明相邻层。内容互压永远不放过。`role: decoration` 只豁免重叠，不豁免出界。批量声明用 `ppt_verify autoDeclare=true`（audit 档禁用）。

**出界**分两级。超页面边界是 `out-of-page`，永远错误，不可声明（放映时看不到）。超安全区是 `out-of-safe-area`，可以声明：把有意落在页眉页脚带上的 logo、角标写进该页 `expectedOutOfSafeArea`。这两个码分开是因为处置完全不同：一个补声明就行，另一个必须改布局。

**文本**。估算偏保守，渲染、检查、导出用同一套度量。字号下限由你的指令决定。表格单元格按列宽换行后超出表格高度会报 `table-overflow`，修法是扩大表格高度、加宽列或精简单元格文案。

**主题一致性**。`theme-conformance` 默认 strict：页面颜色必须来自 `theme.colors` 或中性灰，出板就报错。要加新颜色先加进 theme。字号字体是建议级。导入的工程会自动带上原稿全量色板，不会误报原稿色。

**审阅三层**：

```text
ppt_render + ppt_verify     # 数字检查，快，错误必须清零
ppt_shot + 读图             # 视觉审阅，慢，但构图失衡这类问题只有看图才发现
ppt_visual                  # Office 真渲染复核（有 Office 时；audit 档导出后自动跑）
```

`[·]` 开头的建议（美学、对比度、孤字、密度）永远不是门禁，但值得逐条看。

**实测档**。`ppt_measure` 用浏览器真实排版测量，`ppt_verify measured=true` 拿它和估算交叉：实测发现溢出而估算没发现，算新错误；估算报了而实测没事，降为警告（字体差异，人工确认）。两个文件每页都带 1 基的 `pageNo` 用来配对，对不上会报 `measured-unpaired` 而不是静默跳过。看到这个错，基本都是 `measured.json` 是旧产物，或者在测量之后又动过页面，重跑 `ppt_render` + `ppt_measure` 即可。

---

## 9. 参考：工具一览

**创作链**：`ppt_schema`（语法速查）、`ppt_new`（生成示例工程）、`ppt_check`（结构校验）、`ppt_render`（渲染 HTML + `layout.json`）、`ppt_verify`（布局检查，支持 `autoDeclare` / `measured` / `pages` 局部审阅）、`ppt_shot`（截图，`overview=true` 出整览）、`ppt_measure`（浏览器实测）、`ppt_crosscheck`（内容审阅材料包）、`ppt_preview`（对话内预览链接）。

**输入链**：`ppt_import`（pptx → 工程 + 参考层）、`ppt_visual`（Office 逐页真渲染）、`ppt_media`（图片尺寸格式）。

**交付链**：`ppt_export`（导出 pptx，默认 pptd 引擎）、`ppt_patch`（贴模板手术）、`ppt_splice`（替换进原稿）、`ppt_slice`（裁单页）。

**模板链**：`ppt_templates`（清单与预览）、`ppt_template_add`（收纳自己的模板）、`ppt_template_styleaudit`（写/看模板的视觉审计缓存）。

**状态链**：`ppt_status`、`ppt_state`。

`ppt_crosscheck` 值得单独说一句：它**不做判断**，只把材料摆上桌（全页正文按阅读顺序、工作区里实际有哪些素材、一份审阅协议）。判定由审阅者给，默认用独立子代理（你说"不要用子代理"时它自己审并标注）；没有外部素材时只能判"无法核实"，不会报绿。它不进任何门禁，输出里也没有可"变绿"的东西。

---

## 10. 开发与维护

```bash
node scripts/build.mjs          # 免 tsc：src → lib 复制（纯 ESM JS，源码即产物）
npm test                        # build + LF 守卫 + smoke（262 断言）+ 预设漂移自检
npm run check:eol               # 发行字节守卫：跟踪的文本文件必须全 LF（--fix 就地修）
npm run fresh                   # 用户视角终验：干净克隆 npm test + 真装一遍
npm run test:bundle             # 安装路径自证：隔离 DSH_HOME + 真 dsh plugin add + dump-config
npm run test:preset             # 预设自检：本预设 vs 随包 standard 逐行比对（DSH 升级后必跑）
npm run check:lib               # lib/ 必须逐字节等于 src/
node scripts/preflight-1.0.mjs  # 发布前预检（11 断言）
node scripts/e2e-1.0.mjs        # 端到端（13 断言：真浏览器测量 + 真 Office 渲染 + splice/slice）
node scripts/audit-manual-facts.mjs   # 手册事实审计：逐条核对"手册 vs 源码"（39 条）
```

**"干净检出"才算验收**。`.github/workflows/ci.yml` 在 ubuntu 和 windows 上各自干净检出后跑 `npm test`，并在 windows 上真跑一遍用户会敲的那条命令。这条规矩来自两次真实事故：Windows 干净克隆是 CRLF（Git for Windows 默认 `core.autocrlf=true`），按 `\n` 做的文本手术会**静默失效**；没有 Office 的机器上，整页预览断言必红，而预览本来就是 PowerPoint COM 渲染出来的。现在 `.gitattributes` 把检出字节钉成 LF，`normalizeText()` 兜住手改过的 CRLF/BOM 文件，Office 和浏览器相关的断言一律显式降级为跳过、且保持断言总数恒定。

**改完代码让本机跑上新版**（都要重启 `dsh web`，profile bundle 不热更）：

```bash
npm run sync -- --local   # 日常迭代：不发 GitHub，本机跑刚构建的字节
npm run sync              # 发版：上传资产 + 本机与 GitHub 拉齐 + 用户视角终验
```

**发版四步，顺序不能换**。`npm run sync` 在"本地有未推送提交"或"tag 不指向 HEAD"时会拒绝继续。

```bash
git push origin main                                    # ① 推提交
gh release create v<版本> --target "$(git rev-parse HEAD)" --title ... --notes-file ...   # ② tag 显式指到这一提交
npm run sync                                            # ③ 构建 → 上传资产 → git 前置检查 + 用户视角终验
npm publish "<③ 产出的那个 tgz>"                          # ④ 发 npm（用同一个 tgz，保证两条通道同一份字节）
```

`gh release create` 不指定 `--target` 时会按默认分支 HEAD 建 tag，本地没推就把 tag 建在旧提交上。v1.0.1 第一次发布就是这么错的：资产哈希全绿，而 GitHub 上的 tag 指向 v1.0.0 的代码。所以加了机器判据。`--skip-fresh` 能跳过终验，但状态文件里会留 `freshInstall: null`，不把"没验"伪装成"验过"。

**npm 通道的现状**：包名已经改成无 scope 的 `dsh-ppt-studio`，`private` 也去掉了，但**还没有发布成功**——npm 网站对我们这个出口 IP 返回 403，注册和创建 token 都走不通（细节见 docs/06 §六）。所以现在不要用 `dsh plugin --profile web add dsh-ppt-studio`，它取不到包。首次发布时用上面第 ④ 步的那个 tgz。

**`lib/` 为什么提交**：`dsh plugin add <仓库 URL>` 只能拿到 git 里已提交的内容，而 `exports` 指向 `./lib/index.js`。lib 不入库，git 装出来的包就缺入口文件、挂不上。代价是"改了 src 忘了 build 就提交"会静默发旧代码，所以配了守卫：`npm run check:lib` 加 smoke 里一条同义断言（lib 必须逐字节等于 src，且不能被 `.gitignore` 忽略、必须被 git 跟踪）。改码流程就是改 `src/` → `node scripts/build.mjs` → 连 `lib/` 一起提交。

**包名是单一事实源**：改名要同步 `package.json`、`cordis.patch.yml` 的插件行，以及 `scripts/install.mjs` 里的落点路径。漏一处就是"装了不生效"，smoke 有断言盯着。

**OOXML 产物必须用真消费者验**。加备注页时先写的 `notesMasterIdLst`，python-pptx 照读不误，真 PowerPoint 却报"文件或目录损坏"。第三方库能读不等于能打开。凡改导出编码，至少走一次真 PowerPoint（`ppt_visual`）或真浏览器。

**文档链**（每次改动同步）：`docs/01-需求与目标.md`（需求与决策）、`docs/02-技术报告.md`（实现）、`docs/03-更新日志.md`（版本记录）、`docs/04-路线图与里程碑.md`（验收）、`docs/05-迭代流程.md`（检查单）、`docs/06-评审与测试.md`（发布前评审与测试矩阵）。

**版本规则**：semver。破坏中间层或接口兼容是 major，新特性是 minor，修复和文档是 patch。v1.0.0 是三轮真实端到端测试通过后的稳定基线。
