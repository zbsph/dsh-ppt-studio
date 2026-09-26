# PPT 工作室（dsh-ppt-studio）

在 DeepSeek Harness 里说需求，它把 PPT 做出来：先定大纲和版式，再逐页制作，每页过一遍自动检查，最后交付一个能用 PowerPoint 打开、继续改的 `.pptx`。

当前版本 **1.1.2**，安装包约 **890 kB**（1.0.3 及更早的版本是 35 MB，因为随包带着 4 套没人用过的导入模板，1.0.4 把它们删了）。

**隔离是默认的**：装好之后，这套能力**只出现在「PPT 工作室」预设里**，其他预设与"没装插件"完全一样（§1.6）。
新建会话时选「PPT 工作室」即可；预设提供的是"完整工作台"——人格 + 22 个工具 + `/ppt` 命令 + 4 本手册 + 工作流提示段。

---

## 1. 装上

### 1.1 需要什么

一台能跑 `dsh web` 的机器，或者 **DeepSeek Harness 桌面端**（桌面端见 §1.7，装法不同）。宿主版本要求 **DSH `>= 0.1.7-rc.1`**（本包 1.0.7 起；`0.1.7-rc.1` 命令行版验过，`0.1.7-rc.2` 命令行版与**桌面端**都验过）。Office、Edge/Chrome、python-pptx 都是**可选增强**：没有它们插件照常工作，只是真渲染、截图、兜底引擎这些能力自动降级，交付说明里会写明。

### 1.2 一条命令（默认走 npm）

**npm 是本插件的默认安装途径**（web 端与桌面端都支持）：包名就是 `dsh-ppt-studio`，不需要账号、不需要配 registry，升级只需再跑一次同名命令。

**web 端**：

```powershell
dsh plugin --profile web add dsh-ppt-studio
# 装完重启 dsh web
```

**桌面端**：在「插件管理」里填同一个包名 `dsh-ppt-studio`（详见 §1.7）。

本插件声明了 `dsh.bundle.patch`（仓库根的 `cordis.patch.yml`），所以**装完就挂上了**：不用手工建链接，不用跑安装器，装的人也不需要任何账号（公开包）。

想走归档通道（离线、或不想依赖 npm）也一样可以：从 [Releases 页面](https://github.com/zbsph/dsh-ppt-studio/releases) 复制**最新那条** `.tgz` 资产的完整链接即可。两条通道是**同一份字节**（可用 `sha256` 逐字节核对）：

```powershell
dsh plugin --profile web add <粘贴那条资产 URL>
```

资产名形如 `dsh-ppt-studio-<版本>-<YYYYMMDD-HHmm>-<构建戳前 8 位>.tgz`：版本、构建时间、构建内容的前 8 位哈希。页面会保留历次构建，所以**按上传时间取最新那条**。懒得翻页面就用这行拿名字（把 `<版本>` 换成当前 tag，例如 `v1.1.1`）：

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
# 升级：再跑一次同名命令即可（走 npm），不需要先卸载
dsh plugin --profile web add dsh-ppt-studio
# 桌面端：在「插件管理」里对 dsh-ppt-studio 重新安装 / 升级，然后重启应用

# 卸载
dsh plugin --profile web remove dsh-ppt-studio
```

> **刚发布的版本可能装不上（会静默装回旧版）**。宿主给 pnpm 带了供应链策略（`minimumReleaseAge`，实测窗口约 12 小时）：
> 新版本在窗口期内**不是**合法候选，于是按名字安装会**静默解析回旧的成熟版本**（命令成功、无警告、界面却仍显示旧版本号）。
> 要第一时间用上刚发布的版本，两条路：
> 1. 用 `.tgz` 装（tarball 规格不经过 registry 版本解析）：把 `dsh-ppt-studio-<版本>-….tgz` 放到一个**稳定目录**，
>    在插件管理里填它的绝对路径（**桌面端不要用 https 资产 URL**，会撞 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`，见 §1.7）；
> 2. 等窗口过去（约 12 小时）再按名字升级。
>
> 另外别把 tgz 装在会被清理的临时目录里（例如发版脚本的 `_artifacts/`）：那条 `file:` 依赖一旦悬空，下次装依赖会直接失败。

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

### 1.6 隔离：默认只有「PPT 工作室」能看到这些工具

**默认就是隔离的**：装完之后，**其他预设完全不受影响**——看不到 `ppt_*` 工具、看不到那 4 本手册，
也不会被注入任何 PPT 工作流提示段；只有在「PPT 工作室」预设里才有完整能力面（22 个工具 + `/ppt` + 4 本手册 + 工作流）。
要切换：新建会话时选「PPT 工作室」；已经开着的会话也可以直接切预设，工具会立刻出现。

怎么做到的（一句话）：插件声明预设时，会给自己那份组合**追加一行自定位行**——内容是本包入口的**绝对 `file://` 地址**，
于是预设的常驻组合会把插件再挂一次，那一次的工具/技能/提示段全部注册在**预设作用域**里。
用绝对地址是必须的：预设里的行都在**注册表所在那一层**的路径下解析（那里既不是你的 profile、也不是预设目录），
所以裸包名/相对路径都解析不到、预设会被判 `broken`；而绝对 `file://` 不受这个基准影响，且每次启动按 `import.meta.url` 现算——升级换代不会陈旧。

**两条保证**：

- **一条命令安装不变**：`dsh plugin --profile web add dsh-ppt-studio`（桌面端在插件管理里填同一个包名），不需要任何额外开关。
- **不会"装了却没能力"**：如果预设声明失败、或这台部署根本没有预设注册表（`headless`/`sdk` 这类），
  插件会**自动回落到全局能力面**并在日志里说明——功能完整，只是没隔离。真实状态可查：调一次 `ppt_state`，
  看 `presetDelivery.isolation`（`preset` = 隔离生效 / `profile-fallback` = 已回落 / `profile` = 你显式关掉了隔离）。

**想回到"所有预设都能用"**（传统档）：把 profile 里那行 `ppt-studio` 的 config 改成
`scope: profile`，或在 `cordis.patch.yml` 里显式写 `scope: 'profile'`。`install.mjs --isolate` 已无意义（隔离就是默认），保留只为兼容旧脚本。

### 1.7 桌面端（DeepSeek Harness 应用）

桌面版把 harness 打在自己的应用目录里，**profile 是独立的 `desktop`**（`~/.dsh/profiles/desktop`），
所以你之前给 `web` profile 装的那份不会自动出现在桌面端。

**默认装法同样是 npm**：在桌面端的「插件管理」里填包名 `dsh-ppt-studio` 即可（它内部就是 `pnpm add`，
装完会把这个包写进 profile 的 `dependencies` 与 `dsh.profile.bundles`）。装完**必须重启桌面端**——
bundle 层在启动时组合，不热更。这就是"一句话无脑安装"在桌面端的形态。

两条历史限制仍然存在，但它们只影响**归档通道**（不想用 npm 的时候）：

- **命令行不让你碰 `desktop` profile**。`dsh plugin --profile desktop ...` 会直接报
  `profile "desktop" is managed exclusively by the Electron application`；桌面端的插件安装走插件管理入口。
- **桌面端自带的 pnpm 装不了 tarball 网址**。它内置 pnpm 11.7.0，而桌面 profile 用的是
  `nodeLinker: hoisted`；这个组合下 `pnpm add <https…tgz>` 会报
  `ERR_PNPM_MISSING_TARBALL_INTEGRITY`。同样的 URL 换成 pnpm 11.21 或去掉 `nodeLinker` 都能装上。

所以只有当你要用 `.tgz` 资产（离线、或不经过 registry）时才需要专门的安装器——它只调用**应用自带的**
pnpm 和 Node，不会用系统 Node 去重编 profile 里的原生模块：

```powershell
# 从发布包解压后（或直接对源码目录）
node D:\plugins\package\scripts\install-desktop.mjs
# 自定义：--prefix <你的 .dsh 目录> / --app-dir <应用目录> / --spec <URL|tgz|目录>
# 先看看它会做什么、不动盘：--dry-run
# 卸载：--uninstall
```

它会：把本包打成一个 tgz 放进 `<profile>/.dsh-plugins/`，以相对 `file:` 规格装进 profile
（这样不会因为外部目录被删而让桌面端下次装依赖时失败），再把包名补进 `dsh.profile.bundles`。

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

你的模板库在 `<DSH_HOME>/ppt-studio/templates/`（没设 `DSH_HOME` 时就是 `~/.dsh/ppt-studio/templates/`；Windows：`C:\Users\<你>\.dsh\ppt-studio\templates`）。它**不在插件包里**，所以升级插件不会丢；随包那 4 套是只读的，删不掉（删了升级也会回来，不如不删）。入库之后，你自己的模板和随包模板在清单里同等可选，而且按上面的政策，**你给的模板优先级最高**——要用它就直接说。

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
bar / line / pie，**矢量拼绘**：我们在 pptx 里画的是**普通形状**（柱=矩形、折线=连接线+圆点、饼=按角度切分的饼形扇区），
**不是 PowerPoint 的图表对象**。所以成品里：移动/缩放/改色/改字号照常（它们就是形状），但**没有"编辑数据"**、不能切换图表类型，
改一个数字也不会让柱子高度或扇形角度跟着变（图形和文字是各自独立的对象）。
另外 `chart` 只画**图形本身**，分类名/数值/单位/图例要用文本元素自己写（DSL 里没有这些字段）——改了数字记得同时改形状或回来改 DSL 重导。
用 python-pptx 兜底引擎时图表是**原生可编辑图表**（带内嵌数据工作簿：PowerPoint 里能"编辑数据"、能换图表类型）——正好补上引擎 A 矢量图表不可改数据的短板。复杂图表也可以直接用图片或形状拼；引擎 A 要不要也改成原生图表，见 docs/04 的「原生图表」路线项。

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
- 图片 `src` 是相对 deck 根的路径：`media/子目录/图.png`、中文或带空格的文件名都可以（预览会正确处理）。
  两个**不同目录下的同名文件**也没问题——导出会自动给包内部件名加哈希避免互相覆盖（PPT 里的图片内容不受影响，导出输出里会说明改了什么）。
  `src` 写 http(s) 网址时**只有预览能显示**，导出会写 1×1 白色占位并醒目警告（插件不联网取图）。

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
npm test                        # build + LF 守卫 + smoke（298 断言）+ 预设漂移自检
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

**发版三步 + npm 自动发布（顺序不能换）**。`npm run sync` 在"本地有未推送提交"或"tag 不指向 HEAD"时会拒绝继续。

```bash
git push origin main                                    # ① 推提交
gh release create v<版本> --target "$(git rev-parse HEAD)" --title ... --notes-file ...   # ② tag 显式指到这一提交
npm run sync                                            # ③ 构建 → 上传资产 → git 前置检查 + 用户视角终验
```

**④ 不用你做**：资产一上传，`.github/workflows/publish.yml` 就被 `release: published` 唤醒 → 等 Release 资产出现 → **下载那个 tgz**（不重新打包，保证两条通道同一份字节）→ 用 **OIDC（Trusted Publishing）** 发到 npm → 发后自证 `registry dist.integrity == 本地 tgz 的 sha512`。**零长期 token，也不需要点任何按钮。**

`gh release create` 不指定 `--target` 时会按默认分支 HEAD 建 tag，本地没推就把 tag 建在旧提交上。v1.0.1 第一次发布就是这么错的：资产哈希全绿，而 GitHub 上的 tag 指向 v1.0.0 的代码。所以加了机器判据。`--skip-fresh` 能跳过终验，但状态文件里会留 `freshInstall: null`，不把"没验"伪装成"验过"。

**npm 通道的现状（2026-09-26）**：`dsh-ppt-studio@1.1.0` **已发布**（`dist-tags.latest`、public、发布者 `zbsph`、`fileCount` 179）；registry 的 tarball 与 GitHub Release 资产**逐字节相同**（sha256 `9303cc5c…`，`dist.integrity` 等于本地重算的 sha512）。
- 首版是 `npm publish <发版 tgz>` 直发完成的；**从下一版起改走 Trusted Publishing（OIDC）全自动通道** —— npm 已公告 Bypass-2FA 直发将于 2027-01 移除。
- 通道的**一次性人工前提**（npmjs.com 上那条 Trusted Publisher 连接）与失败排查清单写在 `docs/05-迭代流程.md`「发布-同步纪律」；通道**前提本身**由 `npm test` 的 smoke §51 四条断言钉住。
- 手动补发 / 重发：GitHub → Actions → *Publish to npm* → *Run workflow*（填 tag）。
> 留档：最早的卡点是 npm **网站**对出口 IP 返回 403（registry API 一直正常）；换出口后卡点转为 2FA 写入策略；最终按"直发一发版 + OIDC 常态化"两步走通。

**`lib/` 为什么提交**：`dsh plugin add <仓库 URL>` 只能拿到 git 里已提交的内容，而 `exports` 指向 `./lib/index.js`。lib 不入库，git 装出来的包就缺入口文件、挂不上。代价是"改了 src 忘了 build 就提交"会静默发旧代码，所以配了守卫：`npm run check:lib` 加 smoke 里一条同义断言（lib 必须逐字节等于 src，且不能被 `.gitignore` 忽略、必须被 git 跟踪）。改码流程就是改 `src/` → `node scripts/build.mjs` → 连 `lib/` 一起提交。

**包名是单一事实源**：改名要同步 `package.json`、`cordis.patch.yml` 的插件行，以及 `scripts/install.mjs` 里的落点路径。漏一处就是"装了不生效"，smoke 有断言盯着。

**OOXML 产物必须用真消费者验**。加备注页时先写的 `notesMasterIdLst`，python-pptx 照读不误，真 PowerPoint 却报"文件或目录损坏"。第三方库能读不等于能打开。凡改导出编码，至少走一次真 PowerPoint（`ppt_visual`）或真浏览器。

**文档链**（每次改动同步）：`docs/01-需求与目标.md`（需求与决策）、`docs/02-技术报告.md`（实现）、`docs/03-更新日志.md`（版本记录）、`docs/04-路线图与里程碑.md`（验收）、`docs/05-迭代流程.md`（检查单）、`docs/06-评审与测试.md`（发布前评审与测试矩阵）。

**版本规则**：semver。破坏中间层或接口兼容是 major，新特性是 minor，修复和文档是 patch。v1.0.0 是三轮真实端到端测试通过后的稳定基线。
