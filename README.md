# @dsh-external/dsh-ppt-studio — PPT 工作室（v1.0.0）

在 DeepSeek Harness 上做一个 PPT 的完整工作区：**DSH 里说需求 → 插件做 PPT → 可验证地交付**。
配套 agent preset「PPT 工作室」（= standard 全量功能 + 本插件行），四类任务（从头 / 补完 / 修改 / 总结）共用同一个 PPTD 中间层，质量由「数字门禁 + 视觉审阅 + 真渲染复核」三轨保证。

> **新手不用读完本文档**：进入 PPT 工作室后直接说需求（如"帮我做一个 10 页的年度总结 PPT"），工作流会引导你；语法细节问模型即可（模型内置本手册 skill —— 你可以直接问"expectedOverlaps 怎么写"、"怎么只改原稿的某一页"）。

---

## 目录

0. [安装与上手（新用户：从下载到可用）](#0-安装与上手新用户从下载到可用)
1. [快速开始](#1-快速开始)
2. [四类任务与工作流](#2-四类任务与工作流)
3. [工具面全表](#3-工具面全表)
4. [PPTD 中间层（deck.yaml）](#4-pptd-中间层deckyaml)
5. [质量门禁体系（为什么不会元素打架）](#5-质量门禁体系为什么不会元素打架)
6. [保真与贴模板（三重通道）](#6-保真与贴模板三重通道)
7. [内置模板库](#7-内置模板库)
8. [常见问题 FAQ](#8-常见问题-faq)
9. [环境与能力边界](#9-环境与能力边界)
10. [开发与维护（给改插件的人）](#10-开发与维护给改插件的人)

---

## 0. 安装与上手（新用户：从下载到可用）

### 0.1 前提

- **DSH（DeepSeek Harness）web 实例**已在本机运行（`dsh web`）；本插件是预设+插件形态，不改变 DSH 安装。
- **宿主版本基线：DSH `0.1.6-alpha.2`**（2026-09-18 实测适配；上一基线 `0.1.5-rc.2` 亦已验证）。`tools` / `commands` / `systemPrompt` / `webServer` / `skills` / `session/event` / `system-prompt/assemble` 契约逐项核对，并在真实进程里跑过挂载、内嵌技能注册与工作流提示注入。更早的 0.1.x 未逐一验证；`skills` 服务缺失（极简装配）时插件仍完整可用，只是手册不以技能形式出现。
  > **升级 DSH 后请先跑 `npm test`**（自 2026-09-18 起含预设漂移自检）：本插件的「PPT 工作室」预设是**随包 standard 预设的全量副本 + 插件行**，上游改预设行（改包名、改 config、加/停用行）而副本没跟，会话就会挂不上——插件代码本身却完全正常，极易误判成"插件坏了"。
- 可选增强（没有也能用，自动降级）：本机 Microsoft Office（真渲染通道）、Edge/Chrome（截图与 M2 实测）、python + python-pptx（兜底引擎）。

### 0.2 方式 A：`dsh plugin add`（标准姿势 · **一条命令**，推荐）

本插件声明了 `dsh.bundle.patch`（见仓库根 `cordis.patch.yml`），所以**装完即挂载**——不需要手工建 junction、不需要跑安装器、**不需要 npm 账号**：

```powershell
# 资产 URL 从 Releases 页面复制：文件名 = 版本-构建时间-构建戳（取**时间最新**的那条，原因见下方"为什么带戳"）
dsh plugin --profile web add https://github.com/zbsph/dsh-ppt-studio/releases/download/v1.0.0/dsh-external-dsh-ppt-studio-1.0.0-<YYYYMMDD-HHmm>-<构建戳>.tgz

# 升级：用**更新的**资产 URL 再跑一次（**不需要先卸载**，URL 必变，见下）
# 懒得翻页面就用这行拿"当前版本"的资产名（按上传时间取最新，实测可用）：
#   gh release view v1.0.0 --json assets --jq '.assets | sort_by(.createdAt) | last | .name'
#   → 拼进上面的 URL 尾巴即可。**别用 `sort | tail -1`**：早期没有时间戳的资产名会排到后面，取到的是旧版本（实测踩到）。
# 卸载：dsh plugin --profile web remove @dsh-external/dsh-ppt-studio
# 装完 **重启 dsh web** 生效
```

**等价的第二条路（创意工坊 / 商店用的就是这条）**：直接装本仓库的 git 地址——`lib/` 已入库，产物与 tgz 完全一致：

```powershell
dsh plugin --profile web add https://github.com/zbsph/dsh-ppt-studio
```

`dsh plugin` 是**薄 pnpm 转发器**：在 `<DSH_HOME>/profiles/web/` 里跑 pnpm，然后按**已安装状态**核对
`dsh.profile.bundles`——声明了 `dsh.bundle` 的依赖会**自动进入层栈**（你不需要手改任何配置）。

> **为什么文件名带构建戳（2026-09-15 实测）**：同一个 URL 用 `--clobber` 覆盖内容后，
> **`dsh plugin add <同一 URL>` 不会重新下载**（pnpm 按 URL 规格复用旧副本，`--force` 也没绕过；
> 独立 GET 该 URL 证明 URL 本身已是新字节 ⇒ 是包管理器侧的复用）。所以资产名若固定，用户重跑同一条命令
> "升级"会拿到旧版本。改成把构建产物的 sha256 前 8 位写进文件名 ⇒ URL 必变 ⇒ 必然重取；
> 反向也已实测（`npm run test:bundle` 的升级自证）：**同版本号、内容不同的新规格 → 装到的就是新字节，且
> `dsh.profile.bundles` 与 `--dump-config` 都不丢**。
> **为什么还带构建时间**：Release 页面**有意保留历次构建**（老 URL 留给已装用户重装，删掉会让他们的
> `pnpm install` 失败），于是页面上会并排出现多个长得像的名字——sha 段看不出新旧，所以再加
> `<YYYYMMDD-HHmm>`：**取时间最新那条即当前版本**。
> 代价：URL 每次构建都不同，请从 Releases 页面复制当前那条（或 `gh release view v1.0.0 --json assets`）。
> **怎么认"当前那条"**：资产名 = `版本-构建时间-构建戳`，按**上传时间**取最新——`gh release view v1.0.0 --json assets --jq '.assets | sort_by(.createdAt) | last | .name'`。

> **装完怎么确认生效**：`dsh --profile web --dump-config` 里应出现 `ppt-studio` 插件行。
> 仓库自带这条路径的**真机自证**：`npm run test:bundle`（隔离 `DSH_HOME` + 真 `dsh plugin add` + dump-config 断言，**不碰你的 profiles**）。
> 本包**未发布到 npm registry**（保持 `private: true`）；不想装 pnpm / 要离线时用方式 B（下载 tgz + `install.mjs`）。

### 0.3 方式 B：下载发布包（离线/无 pnpm 时）

1. 在本仓库 [Releases](https://github.com/zbsph/dsh-ppt-studio/releases) 页面下载 `dsh-external-dsh-ppt-studio-<版本>.tgz`（v1.0.0 起）。
2. 解压到任意目录（如 `D:\plugins\dsh-ppt-studio`）：
   ```powershell
   tar -xzf dsh-external-dsh-ppt-studio-1.0.0.tgz -C D:\plugins
   # 得到 D:\plugins\package\（内含 lib/ scripts/ agent-presets/ docs/ skills/ templates/）
   ```
3. **一键安装**（会做三件事：链包进 profile node_modules、保证 yaml 依赖、写入 PPT 工作室预设）：
   ```powershell
   node D:\plugins\package\scripts\install.mjs
   # 自定义 DSH_HOME 时：node ...\install.mjs --prefix <你的 .dsh 目录>
   # 重装/强制：--force；只装包不写预设（配合注入器）：--no-preset
   ```
   安装器是幂等的——重复运行自动跳过已存在项。
4. **重启 dsh web** → 会话左上角/预设切换器选择「**PPT 工作室**」→ 直接提需求。
5. 验证安装成功：在 PPT 工作室里说"帮我做一个简单 PPT，用内置模板"——模型应开始走 PPT 工作流（工作流提示词自动注入）；或直接问模型"dsh-ppt-studio 怎么用"（内置 skill 手册会回答）。
   > 手册 skill 由**插件自己内嵌提供**（`ctx.skills.register`，落 PPT 工作室预设层，随插件同生共死、升级即新）。
   > **安装器默认不再把它镜像到 `<dshHome>/skills/`**（2026-09-18 起）：那是**文件系统技能根**，对该 profile 的**所有会话**可见，
   > 会让别的预设也看到这 4 本技能——与"只有选「PPT 工作室」才有这些技能"冲突。要给非 PPT 会话留"提问即用"的兜底，
   > 显式加 `--mirror-skills`（install.mjs 未开启时会**自动清理历史镜像**，避免旧副本继续泄漏）。
   > 想确认通道生效：让模型调一次 `ppt_state`，输出里的 `manualSkill` 会给出 `registered/visible`。

### 0.4 方式 C：git clone 源码（开发者/尝鲜）

```powershell
git clone https://github.com/zbsph/dsh-ppt-studio.git
cd dsh-ppt-studio
npm install            # 仅需 yaml（本地开发依赖）
node scripts/build.mjs # 免 tsc：src → lib
node scripts/install.mjs
# 重启 dsh web → 进入「PPT 工作室」
```

### 0.5 方式 D：已有 dsh-super-injector（生态惯例）

在注入器环境内：`dev_inject_plugin <解压目录>`（或源码目录）→ 注入器负责 junction + 重启恢复；预设同上（仓库 `agent-presets/ppt/agent.cordis.yml` 复制到 `~/.dsh/.agent-presets/ppt/`，或让安装器写：`node scripts/install.mjs --prefix <DSH_HOME> --no-preset` 后手工放预设）。

### 0.6 安装后的自检（四句命令）

```powershell
node scripts/smoke.mjs          # 239 断言（含全链路）
node scripts/preflight-1.0.mjs  # 11 断言（坏输入/边界/幂等/性能）
node scripts/check-preset.mjs   # 预设自检：本预设 vs 随包 standard 逐行比对（DSH 升级后必跑）
node scripts/e2e-1.0.mjs        # 13 断言（真浏览器测量 + 真 Office 渲染 + splice/slice 自证；约 2-3 分钟）
```
全部绿色 = 本机环境完整可用；无 Office/Edge 的机器 e2e 会自动降级标注（不是失败）。
`check-preset` 找不到 DSH 安装时跳过（不阻断）。

### 0.7 装法与冲突：bundle 行 vs 预设行（**二选一**）

本插件有两条**都合法但互斥**的挂载路径：

| 路径 | 由谁装 | 生效范围 | 附带 |
|---|---|---|---|
| **profile bundle 行**（`cordis.patch.yml`） | `dsh plugin --profile web add <包>` | **只有「PPT 工作室」预设的会话**（见下方"会话级隔离"） | 不含预设人格（预设由插件自交付） |
| **agent preset 行** | `node scripts/install.mjs`（写 `~/.dsh/.agent-presets/ppt/agent.cordis.yml`） | 仅**「PPT 工作室」预设会话** | 含预设人格（技能**默认不再**镜像到 `<dshHome>/skills/`，见 §0.3） |

> **会话级隔离（2026-09-18 起，两条路径都是）**：`ppt_*` 工具、`/ppt` 命令面、4 本内嵌技能、工作流提示段
> **都不再注册在 profile 层**。插件在 `apply` 里只装全局管道与 `agent/created` 钩子，能力面在该钩子里
> **按该 agent 的预设**挂到 `agent.ctx` 作用域 ⇒ **只有「PPT 工作室」预设的会话看得到**，
> 别的预设（含官方 standard）一点也看不到、也拿不到。
> - 判据：该 agent 的预设 id ∈ `config.presetIds`（默认 `['ppt']`）∪ 名册里"行中含本包/显示名含 PPT 工作室"的预设。
> - **失败开放**：拿不到 `agentPresets` 服务、或该 agent 未加入任何预设（如 headless）时照旧注册——环境不支持 roster 也不会把插件弄坏。
> - **预设由插件自交付**：`apply` 时若 `<dshHome>/.agent-presets/ppt/` 缺失就写一份（**只在不存在时写、绝不覆盖**；
>   交付的是剥离插件行的版本）。所以 `dsh plugin add` **一条命令**之后重启，选择器里就有「PPT 工作室」。
> - 想关掉自交付或改用别的预设 id：在 `cordis.patch.yml` 的插件行 `config` 里设 `autoPreset: false` / `presetIds: [...]`。
>
> 两者仍**互斥**（同时挂会被装配防重拦下：首个生效 + 告警）。**日常只需要第一条**（`dsh plugin add`）；

**两者都装会让同一个包在同进程被挂两次**：插件里有装配防重（首个生效 + 明确告警，见 `src/index.js`），
所以**不会崩**，但请二选一——已经用 `dsh plugin` 装了，就跑一次
`dsh plugin --profile web remove <包>` **或**删掉预设里的插件行。

### 0.8 卸载

删除 `~/.dsh/.agent-presets/ppt/` 与 `~/.dsh/profiles/web/node_modules/@dsh-external/dsh-ppt-studio`（junction，删链接即可），重启 dsh web。
若用 `dsh plugin` 装的：`dsh plugin --profile web remove <包名>`（会同时从 `dsh.profile.bundles` 层栈里退出）。

---

## 1. 快速开始

**三步交付**：

1. **进入 PPT 工作室**（agent 预设）——说需求。四类任务自动识别，也可 `/ppt` 命令面显式控制：
   ```
   /ppt quick        # 快速模式：低 token 快交付（质量底线不变）
   /ppt normal       # 完整模式：S0-S6 全流程（默认）
   /ppt quality audit  # 从严档：禁一键声明 + 强制视觉审阅 + 导出回读断言 + 自动真渲染审核
   /ppt template <id>    # 记录本会话默认模板
   /ppt help
   ```
2. **跟着工作流走**：S0 规格澄清 → S1 大纲 → S2 视觉定调（用内置模板或参考素材）→ S3 逐页制作 → S4 页审循环 → S5 整体审 → S6 导出交付。每页制作后自动跑 `ppt_render → ppt_verify → ppt_shot`。
3. **交付**：`.pptx`（默认 pptd 引擎）+ 中间层工程 + 交付说明；对话内可点 `ppt_preview` 链接直接看。**如果要改"已有精美 PPT 的某一页"：见 [第 6 节 splice](#6-保真与贴模板三重通道)。**

**最快试跑**：
```text
ppt_new(dir=D:\demo)                 # 一键生成可跑通全链路的示例工程（3 页，含全部范本）
ppt_render(D:\demo) → ppt_verify(D:\demo) → ppt_export(D:\demo)
```

### 1.4 内置技能包（提问式手册 + 制作手册）

插件自带 4 本技能，**随插件同生共死**（内嵌注册 `ctx.skills.register`，落 PPT 工作室预设层；升级即新、卸载即净）：

| 技能 | 何时加载 | 内容 |
|---|---|---|
| `ppt-studio-manual` | **只在用户提问时**（"这个插件怎么用 / XX 怎么写 / 为什么报错"）；制作任务进行中**不加载** | 提问式使用手册（四类任务、DSL 速查、声明制、splice 与贴模板、报错处置） |
| `ppt-studio-craft` | 定纲/定版式；"这页怎么排 / 太挤 / 太像模板了" | 叙事 spine、一页一论点、结论式标题、按内容量选构图、反模板自检 |
| `ppt-studio-data` | 页面要放数字或图表 | 图表选型、**成品里图表只有几何**（标签要自己补）、口径与来源标注、跨页数字一致 |
| `ppt-studio-copy` | 写标题与要点；"太 AI 了 / 像机器写的" | 页面三类角色的写法、成组 AI 味信号清单、before → after 对照 |

**三条承诺**：

1. **纯增量**：技能只给启发式与反例——**不改任何铁律、不定义任何门禁数值**；工作流提示词只在标准档新增了一行"何时加载"的指引，且由机器断言保证**旧行一行未改/未删**（`npm test` 里的两条"★老用户不受影响"）。
   另有 **13 条"手册 vs 源码"断言**（`npm test` §37/§38）盯住手册的**事实**不许说错：工具名是否真实存在、门禁错误码清单与源码是否一致、
   警告标记是 `[~]` 而不是 `[⚠]`、`density`/`near-align` 属警告而非建议、chart 的 `data` 形状、预览截断阈值、`/ppt` 子命令、
   讲稿是否写明了"不导出备注"、缩字下限常量、`SCHEMA_REF` 自洽，以及**文档里的"smoke N 断言"必须等于真实断言数**（加断言忘同步文档会当场红）。
2. **不加载也照常工作**：部署里没有 `dsh-skill`（无 `skills` 服务）或技能文件缺失时，插件功能完整，只是技能不以目录形式出现。
3. **不与用户自装技能打架**：技能注册表跨层重名按"就近层优先"裁决——PPT 会话内命中插件内嵌版，用户自装那份在其它会话照旧可见。想整体退掉：删掉本机的 `~/.dsh/skills/ppt-studio-*` 镜像即可（内嵌版仍在 PPT 会话内生效，反之亦然）。
4. **答疑手册不打扰制作**（2026-09-15 反馈修正）：`ppt-studio-manual` 讲的是"怎么回答用户提问"，不是"怎么做 PPT"——所以它**只由用户提问触发**，"制作任务进行中不要加载"这句写进了技能描述、技能正文横幅与工作流提示段三处；制作中拿不准某个写法时，权威来源是 `ppt_schema` / `ppt_check` / `ppt_verify` 的**输出**（手册可能落后于源码）。`npm test` §42 三条断言把这条纪律钉住（技能描述与 whenToUse、正文横幅与工作流分行、制作三本正文零指向答疑手册）。

想确认通道是否生效：让模型调一次 `ppt_state`，输出里的 `manualSkill.skills` 会逐个给出注册与可见状态。

---

## 2. 四类任务与工作流

| 类型 | 触发词 | 路径 | 交付 |
|---|---|---|---|
| **from-scratch 从头** | "做一个 XX 主题的 PPT" | 模板/定调 → 逐页制作 | 完整工程 + pptx |
| **augment 补完** | "补两页 / 加一个章节" | 默认可复用模板工作区；新增页 = 复制母版去 `_` 前缀 + 注册 deck.pages | 追加后的完整工程 + pptx（或 `ppt_splice` 进原稿） |
| **edit 修改** | "改第 15 页 / 美化这页" | `ppt_import` 读参考层真身 → 独立改该页 → **`ppt_splice` 替换回原稿** | 整册只变一页 + 单页版（`ppt_slice`） |
| **summarize 总结** | "把这 50 页总结成 10 页" | `ppt_import` 全稿 → 提炼 → 重排 | 新工程 + pptx |

> 任务识别是**语义路由**（明确 PPT 意图才进入工作流；只提一句无关话题不会误切）——非 PPT 需求行为与标准模式完全一致。

---

## 3. 工具面全表

**创作链**：

| 工具 | 用途 |
|---|---|
| `ppt_schema` | **语法速查**（deck.yaml / 元素 / 主题 token / 声明 / 安全区）——不熟 DSL 先调它 |
| `ppt_new` | 一键生成示例工程（现成范本：主题 token / 色块衬底声明 / safeArea / line 无 bounds 写法） |
| `ppt_check` | 结构校验（deck/页面 YAML、元素、主题引用 `$ref`、声明 id 防呆） |
| `ppt_render` | deck → `preview/*.html` + `layout.json`（数字审阅数据源）；`debug=true` 画安全区参考框 |
| `ppt_verify` | **数字审阅门禁**：重叠/出界/溢出/对齐/密度。`autoDeclare=true` 一键声明；`measured=true` 交叉实测档；`pages="2,5-7"` 局部审阅 |
| `ppt_shot` | Edge headless 截图 → PNG（视觉审阅；`index=N` 单页 / `overview=true` 整览） |
| `ppt_measure` | **M2 实测档**：浏览器真实排版测量（行盒/溢出/几何）→ `measured.json`；`ppt_verify measured=true` 交叉（实测=终审） |
| `ppt_crosscheck` | **M3 数据连贯**：跨页数字对账 + 数据来源核查表（交付说明用） |
| `ppt_preview` | 对话内预览：同源链接（整览+单页），用户点击即看 |

**输入链**：

| 工具 | 用途 |
|---|---|
| `ppt_import` | 任意 .pptx → deck 工程（内容保真 + 参考层：`source.pptx` 真相 + Office 真渲染整页 + theme 聚合；备注读回 `notes:`） |
| `ppt_visual` | Office PPT COM 真渲染 → 逐页 PNG；`pages="15"` 只渲指定页（页号=源原页号） |
| `ppt_media` | 图片元数据（尺寸/格式，估算 media 用量） |

**交付链**：

| 工具 | 用途 |
|---|---|
| `ppt_export` | 导出 .pptx（`auto`=pptd 主引擎，硬失败自动回退 python-pptx 并醒目标注；`out` 支持绝对路径；有 `notes:` 的页生成备注页，parity 自证） |
| `ppt_patch` | **手术模式**：以模板 .pptx 为底版贴内容（只改文本/表格 `<a:t>`，样式/几何/图片原样保留；未动页 sha256 验证） |
| `ppt_splice` | **替换进原稿**：工作区某页替换进源 .pptx（保留母版横幅/页脚/备注/媒体；其余页条目 SHA256 逐字节一致——自动自证） |
| `ppt_slice` | **单页版**：从 .pptx 修剪出"单页 + 完整母版/布局/主题"独立文件 |

**状态链**：`ppt_status`（工作流状态）/ `ppt_state`（会话状态）/ `ppt_templates`（模板清单）/ `/ppt` 命令面。

---

## 4. PPTD 中间层（deck.yaml）

**唯一事实源**：`deck.yaml` + `pages/*.yaml` + `media/`。导出/渲染/校验共用，1px = 1pt，原点左上，默认尺寸 960×540（约 10 英寸 × 5.63 英寸）。

```yaml
version: 1
title: 我的演示
size: [960, 540]              # 或 {width, height}
theme:                        # 样式只在 theme 定义元素引用 token；新增风格先改这
  colors: {primary: "#2563EB", ink: "#1F2937"}
  textStyles: {title: {fontSize: 32, color: "$ink", bold: true}, body: {fontSize: 16, color: "$ink"}}
  safeArea: {top: 20, bottom: 20}   # 可选：模板背景非内容区（logo/页眉页脚带）
  minFontSize: 14             # 可选：用户给出字号下限时设置（如"不得小于14号"→14）；缺省无强制下限
pages:
  - pages/01_cover.yaml
```

页面元素（`pages/01_cover.yaml`）：
```yaml
pageType: cover
background: "#F5F6F7"         # hex / $themeRef / {type: solid,color} / {type: image,src,fit}
notes: |                      # 可选：讲稿 → 导出为 **pptx 备注页**（PowerPoint"备注"区可见/可编辑）
  开场先给结论。
  第二行：再给证据。            # 单行也可写 notes: "一句话讲稿"
elements:
  - elementId: 页内唯一字符串   # 必须
    elementType: text|shape|line|image|table|chart
    bounds: [x, y, w, h]       # 必须（line 可省略：由 points 的 AABB 自动推导）
  # chart：
  - elementId: bar
    elementType: chart
    bounds: [60, 300, 400, 200]
    chart:
      type: bar                # bar|line|pie
      data: {cols: [分类, 值], rows: [[甲, 10], [乙, 20]]}   # 只认 {cols, rows}；多系列加 series: [{name,x,y}]
      colors: ["$primary"]     # 可选：$themeRef 在预览与成品两层都会解析；不写则用内置调色板（不在 theme.colors 里）
  # text：
  - elementId: t1
    elementType: text
    bounds: [60, 60, 400, 50]
    content:
      text: "正文，长句在语义断点显式 \n 换行"
      style: "$body"            # 引用 theme.textStyles；或直接写字段（**必须写在 content 内**！）
      # fontSize: 14 / color: "$ink" / bold / align / lineHeight / wrap
  # shape（常用 prst：rightArrow/leftArrow/upArrow/downArrow/leftRightArrow/pentagon/hexagon/
  #         chevron/parallelogram/diamond/octagon/star5/flowchartProcess|Decision|Data|Terminator
  #         + roundRect/ellipse/triangle/rect + custGeom 自定义路径）
  - elementId: card
    elementType: shape
    kind: roundRect
    bounds: [60, 60, 400, 200]
    fill: "$colors.primary"     # #hex | {color, alpha}（透明度）| {type: gradient, stops: [...], angle}
    line: {color: "#FFFFFF", width: 1}
    rotation: 0                 # 度
```

- **样式键必须在 `content` 内部**（元素级 `fontSize/color/…` 无效——v1.0.0 起 `ppt_check` 直接报错）。
- `expectedOverlaps` 流式/块式**等价**：`[{pair: [a,b]}]` 与 `- pair: [a,b]`，每对一行。
- **讲稿（`notes:`）**：写进页面，`ppt_export` 为这些页生成标准备注页（notesSlide + notesMaster，`ppt_export` 报告的 parity 里 `notesExp/notesOut` 自证）；
  `ppt_import` 会把原稿备注读回 `notes:`；**没有 `notes:` 的页不产生任何备注部件**（不写讲稿的工程产物与旧版逐字节一致）。
  没有翻页/计时字段（放映设置不在本插件范围）。
- 完整速查永远可以问模型（`ppt_schema`）或直接看 `examples/smoke` 样例工程。

---

## 5. 质量门禁体系（为什么不会元素打架）

**核心：重叠的合法性由"设计意图"决定，而非元素类型：设计时声明，审阅时对照。**

### 5.1 重叠声明制（expectedOverlaps）

- 设计时把**有意**重叠对记入页面 `expectedOverlaps: [{pair: [idA, idB]}, ...]`（图片标注/色块衬底/箭头跨越/装饰叠加）。
- 审阅（`ppt_verify`）逐对对照：命中 → ✓ 预期重叠（确认）；未命中 → **ERROR**（修正布局，或确认有意 → 补声明重验）。
- **声明闭包**：嵌套承载只需声明**相邻层**（面板→框→文字），隔层由包含关系传递自动通过（架构图声明省 1/3）。
- **内容互压（content-collision）永远 ERROR，不可声明**（文字/表格/图表相互遮挡——真正要防的冲突）。
- `role: decoration` 只豁免**重叠**，不豁免出界。
- 批量：`ppt_verify autoDeclare=true`（写入后附"声明清单 + 每对一句意图"；**audit 档禁用**）。

### 5.2 出界分级（与声明制同构）

- 超**页面边界** = 永远 ERROR，不可声明（放映不可见）——错误码 `out-of-page`。
- 超**安全区**（模板 logo/页眉页脚带）= 声明制：`expectedOutOfSafeArea: [idA, ...]` 手工声明（id 必须存在）——错误码 `out-of-safe-area`（2026-09-18 起与 `out-of-page` **分码**：前者补个声明就行，后者必须改布局，混用一个码会让"该做什么"说不清）。

### 5.3 文本度量与"下限 = 用户指令"

- 保守估算（CJK 1em·加粗 ×1.06 / Latin 数字 0.6em / 空格 0.4em），宁可误报不可漏报；渲染/校验/导出**同一度量**（溢出 > 1px 才缩字）。
- **字号下限 = 用户指令**（2026-09-06 用户拍板）：用户给出最小字号（如"不得小于 14 号"）→ 模型写入 `theme.minFontSize` 并严格执行（导出缩字不得低于它）；**未给下限不设强制**（auto-fit 仅 60% 原字号防荒谬保底，绝不升字）。插件不预设任何默认下限。
- verify 通过 ⇒ 导出不缩字；到达下限仍溢出 → 报告 ✗（修复：扩大容器/精简文案；下限是用户的，不是插件的）。
- **M2 实测档**（`ppt_measure` + `ppt_verify measured=true`）：浏览器真实排版测量——实测溢出且估算没报 = 新 error（估算漏报）；估算报但实测通过 = warning（字体差异，人工确认）。实测=终审、估算=预检。
  - **两档页号契约**（2026-09-18 明文）：`preview/layout.json` 与 `preview/measured.json` 的每页都带 **1 基 `pageNo`**，交叉核查按它配对（`index` 只是各自文件的内部数组下标）。对不上会报 `measured-unpaired` 错误而**不是静默跳过**——契约破坏必须响亮，因为"静默返空"与"真的没问题"在输出上不可区分。
  - **看到 `measured-unpaired` 怎么办**：几乎都是 `measured.json` 是旧版产物、或在 `ppt_measure` 之后又增删过页面 → **重跑一次 `ppt_render` + `ppt_measure`** 即可。
  - **表格字号**（2026-09-18）：表格 cell 字号 = `max(11pt, theme.minFontSize)`，**预览与成品同源**。未声明下限时仍是 11pt（既有工程观感零变化）；声明了下限（如"不得小于 14 号"）时表格会跟着抬到下限——否则 audit 档"最小字号 ≥ 下限"的回读断言会被表格自己架空，而 DSL 里没有别的手段能改表格字号。
  - **表格内容溢出进门槛**（2026-09-18）：表格单元格文字按列宽换行后超出表格高度 → `table-overflow` **ERROR**（与文本溢出同级）。此前表格内容**完全不进快照**，是内容门禁的盲区。度量与正文同源（同一保守估算），修复手段是**扩大表格高度 / 加宽列 / 精简单元格文案**。影响面已实测：仓库全部夹具 2 张表、0 张被判溢出。

### 5.4 主题一致性（统一基础样式）

- `theme-conformance` strict（默认）：页面颜色必须 ∈ `theme.colors` 或中性灰，出板 = ERROR；新增颜色先加进 theme。
- 字号/字体为建议级（[·]），单页多处时聚合出一条。
- **图表配色是建议级**（2026-09-14）：图表的默认调色板是内置的一套（**不在 `theme.colors` 里**，属既有行为、不报错也不提示）；
  你若**显式**写了 `chart.colors` 且其中有主题外颜色，会出一条 `[·] aesthetic-theme` 建议（可用 `$ref` 改成主题色）。
  刻意**不**把图表配色纳入门禁：那会给既有工程/模板凭空新增错误。
- 导入工程自动带**原稿全量色板**（c1-c7 高频 + 扩展），不再误报原稿色。

### 5.5 审阅节奏（三层校验）

```text
ppt_render + ppt_verify   # ① 数字门禁：ERROR 清零（快）
ppt_shot + read_image     # ② 视觉审阅：构图失衡/断行/比重（慢但必要，数字门禁发现不了）
ppt_visual                # ③ Office 真渲染复核（有条件时；audit 档导出自动跑）
```

`[·]` 建议（美学/对比度/孤字/密度）永不作为门禁——但请逐条斟酌采纳。

---

## 6. 保真与贴模板（三重通道）

| 通道 | 工具 | 适用 | 保真度 |
|---|---|---|---|
| **参考双轨**（想"像"） | `ppt_import` → `reference/previews/*.png` 真身 → 读 `audit.yaml` → 创作 | 按模板做/参考用户 PPT 做；导入改稿 | 风格级（新版式由你掌控） |
| **手术模式**（要"贴"） | `ppt_patch` | 成品要"看起来就是模板原样"（只换文字/表格内容） | 结构级（模板 XML 原样，只改文本槽） |
| **替换/单页**（要"保"） | `ppt_splice` / `ppt_slice` | **编辑既有精美 PPT 的某一页**——只换一页，其余逐字节不动，母版横幅/页脚/备注保留 | 逐字节级（其余页 SHA256 自证） |

**edit 任务的标准姿势（v1.0.0 起一键）**：
```text
ppt_import(<源.pptx>, D:\work)        # 读参考层真身（先 read_image 看 reference/previews）
# 改 D:\work\pages\slide_15.yaml → ppt_render → ppt_verify（0 错误）
ppt_splice(dir=D:\work, source=<源.pptx>, page=15)      # 整册副本，只变第 15 页
ppt_slice(source=<spliced产物>, page=15)                 # 单页版（可选）
ppt_visual(pptx=<spliced产物>, pages="15")               # 抽查该页真实观感（按页渲染）
```

---

## 7. 内置模板库

4 套版权自研风格（business-blue 商务蓝 / academic-white 学术会议 / tech-dark 科技深色 / pitch-bold 路演大字，各含 theme + 6 张版式母版）+ 外部模板（实用毕业设计/极简部门总结/深蓝质感答辩/简约商务等，双轨含真实模板 pptx + 真渲染预览）。

- `ppt_templates` 看清单与预览；`/ppt template <id>` 记默认。
- `ppt_new(dir, template=<id>)` 物化工作区：`pages/_*.yaml` 是**参考母版**（不进门禁）；`01_opening.yaml` 是正式副本（先 `ppt_verify autoDeclare=true` 声明模板固有叠层 → 剩余错误是模板原文案残留，替换后自然干净）。
- 你自己的模板：`ppt_import`（保留 source.pptx）→ `ppt_template_add` 永久进库 → 以后直接物化使用。

---

## 8. 常见问题 FAQ

**Q：为什么 verify 报重叠但我的设计是有意的？**
→ 这是设计意图声明制：把这对元素加进页面 `expectedOverlaps` 再重验（命中即 ✓）。说明不清意图的对子请改布局；内容互压（文字×文字）永远不能声明。

**Q：autoDeclare 为什么不声明全部？**
→ 只声明警告级（承载/装饰模式），内容互压不可声明（硬底线）；audit 档禁一键声明。写入后模型必须输出"每对一句意图"。

**Q：样式写了但效果不对/按 18pt 计量？**
→ 样式键必须写在 `content` 内。元素级 `fontSize` 无效（v1.0.0 起 ppt_check 直接报错并指引）。

**Q：预览链接打不开（404）？**
→ 路由由 PPT 工作室会话挂载时注册：请确认当前会话在 PPT 工作室；进入后链接即恢复。

**Q：Office 渲染时窗口闪一下？**
→ 正常（PowerPoint COM 需要）；只读打开、结束自动释放。

**Q：无 Edge/无 Office 还能用吗？**
→ 能。截图/实测/真渲染自动降级并标注（HTML 预览 + 结构断言仍在）；交付说明会标注"未经视觉审阅"。

**Q：图表支持哪些？**
→ bar/line/pie（矢量拼绘，可编辑）；python-pptx 兜底引擎下降级为表格（报告醒目标注）；复杂图表建议作为图片或直接用 Shape 拼。

**Q：讲稿/备注能进 pptx 吗？**
→ 能（2026-09-14 起）：页面写 `notes:`（多行用 `|` 块标量），导出即成 PowerPoint 备注页；`ppt_import` 会读回 `notes:`，可编辑。
没有 `notes:` 的页不产生备注部件（老工程产物不变）。翻页/计时（放映设置）不在插件范围。
`ppt_splice` 替换某页时保留**源文件该页既有**的备注关系（不会把 deck 里新写的 notes 塞进被替换的源页）。

**Q：从原稿导入后文字里的 `&amp;` / `&lt;` 是正常的吗？**
→ 不该出现（2026-09-14 修）：导入侧此前不做 XML 实体解码，会把 `R&D` 读成 `R&amp;D`。现在文本节点会正确解码（`&amp;/&lt;/&gt;/&quot;/&apos;` 与数字实体）。
如果你的导入工程是旧版本产物，重新 `ppt_import` 一次即可。

**Q：报告/状态里出现「⚠ 质量档降级」？**
→ 你的项目 `state.json`（或会话状态文件）**损坏或读不了**，插件按 `standard` 继续跑——`audit` 档的额外门禁（禁 autoDeclare / 强制视觉审阅 / 导出回读断言）**本轮未生效**。修好该文件，或重跑一次 `/ppt quality audit`。
（自 2026-09-18 起这类回落会**明说**；此前它是静默的：文件坏掉后 `audit` 会无声变成 `standard`。）

**Q：如何只改原稿第 15 页？** → `ppt_splice`（第 6 节）。**如何导出单页版？** → `ppt_slice`。

**Q：`dsh plugin add` 装了，但插件好像没生效？**
→ 三步查：① `dsh plugin --profile web list` 看包装上没（装不上会直接报错）；
② `dsh --profile web --dump-config` 看组合树里有没有 `ppt-studio` 插件行（有 = `dsh.bundle` 声明生效、已进层栈）；
③ **重启 dsh web**。
若第 ② 步看不到，多半是版本太老（v1.0.0 之前没有 `dsh.bundle` 声明——那时 `dsh plugin` 只会打一行
"declares no dsh.bundle … not a profile layer" 的警告，装了不挂载）→ 升到 v1.0.0+ 再装一次。

**Q：可以用 `dsh plugin` 和 `install.mjs` 同时装吗？**
→ 能装，但没必要，而且是**替代关系**（§0.7）。同时装会让同一个包在同进程挂两次——插件里有装配防重（首个生效 + 告警），
所以不会崩，但请二选一：`dsh plugin --profile web remove <包>` 或移除预设里的插件行。

**Q：怎么升级？**
→ `dsh plugin` 装的：用 **Releases 页面上的新资产 URL** 再跑一次 `add`（**必须换 URL**——同 URL 覆盖内容时 pnpm 不会重取，见 §0.2）；
`install.mjs` 装的：重新解压新包跑 `node scripts/install.mjs`。两种方式都**重启 dsh web** 后生效。

**Q：装的时候下载总超时/失败？**
→ 资产约 33MB、走 GitHub 直连；网络抖动时可在 `~/.dsh/profiles/web/.npmrc` 加：`fetch-timeout=600000`、`fetch-retries=5`、
`fetch-retry-maxtimeout=120000`，然后重跑 `add`（**失败不会破坏已有安装**，直接重试即可）。

**Q：模板页脚带被 logo 占着，内容放哪？**
→ deck.yaml `theme.safeArea` 声明安全区 → verify 把关；logo 类有意元素加 `expectedOutOfSafeArea`。

**Q：中文长句会被误报溢出？**
→ 估算保守（宁可误报）——按提示加宽容器/缩小字号/在语义断点显式 `\n` 换行；`ppt_measure` 实测档复核（实测=终审）。

**Q：导出总是 auto-fit 缩字？**
→ 先看 verify 是否已经报溢出；溢出清零后导出不再缩字。若仅个别页（导入近似稿存量问题）→ 改某页用 `ppt_splice` 而非整册重渲。

**Q：新增一页怎么注册？**
→ 复制母版去 `_` 前缀改名（如 `_06_...` → `06_...`）+ 在 deck.yaml `pages:` 注册；或新写完整页。

**Q：表格在 PowerPoint 里看不见/空白？**
→ 这是 v1.0.0-修订前旧引擎的结构 bug（graphicFrame 嵌套 `<a:xfrm>`，PowerPoint 打开时静默弃帧）——**已修复**；导出报告现在带 parity 回读自证（表 N/N · 图 M/M · 线方向 N/N · 结构合法）。旧产物请重新 `ppt_export`。

**Q：网页预览看着对，打开导出的 pptx 却发现斜线方向反了 / × 少一笔 / 阶梯竖线不见了？**
→ v1.0.0-修订前旧引擎**丢连线方向**：`straightConnector1` 在 OOXML 里只画包围盒左上→右下，真实走向必须靠 `flipH`/`flipV` 表达——漏写会镜像斜率，两条交叉线还会重合成一条。**已修复**；导出 parity 行现在打印"线方向 N/N（逐条从 OOXML 反推端点自证）"。**修复前导出的产物请重新 `ppt_export`**。

**Q：箭头在预览里有、到 PowerPoint 里没了？水平连接线在预览里是平的、到 PowerPoint 里变斜了？**
→ 同一族的两个导出编码 bug，**均已修复**：① `<a:tailEnd>`（箭头）之前被写在了 `<a:ln>` **外面**，PowerPoint 直接忽略；② 连线包围盒之前有 `max(1,…)` 兜底，水平线被抬成 1pt 高 → `straightConnector1` 画对角线就成了"假斜线"。现在箭头写在 `<a:ln>` 内，包围盒精确等于线段跨度（水平线 `cy=0`）。同样**旧产物请重新 `ppt_export`**。

**Q：为什么线画并没穿过标签，verify 还报重叠？**
→ 已修复（P6）：线元素按**真实几何**判定（线段×矩形 / 线段×线段），AABB 假阳性不再报、也不进声明队列；真跨越仍按"连线/箭头"声明制处理。

**Q：真渲染图上为什么有水印？**
→ 比例参考标注（"1px=1pt · 960×540" + 细边框），防人工读图坐标误判（P9）；脚本参数 `noWatermark` 可关。

**Q：PowerShell 解压 .pptx 报"not a supported archive format"？**
→ `Expand-Archive` 只认 .zip：先复制为 .zip 再解压，或 `tar -xzf <file> -C <out>`；读 zip 内 XML 请显式 UTF-8（P3/P4）。

**Q：改码后为什么会话里还是旧行为？**
→ 插件经 agent preset 会话装配（重启才生效）。修复后验证清单：`node scripts/build.mjs` → `node scripts/smoke.mjs`（回归）→ 会话内直跑 `node -e "import(...lib...)...验证修复产物"` → **重启 host 用真工具复验**；重启前需导出用 `engine=python-pptx` 兜底（P11）。

**Q：网页/百科内容查不到？**
→ `web_fetch` 受本机网络/DNS 限制（非公网 IP 拦截）；`ppt_crosscheck` 数据核查表为"页面 source 自证"机制，交付说明已如实标注（P2，环境侧）。

**Q：升级 DSH 之后「PPT 工作室」选不出来／切过去就报错（如 `$.prefix missing required value`、或某插件行 `Cannot find module`）？**
→ 这是**预设 composition 跟着上游漂移**，不是插件坏了——插件代码与其宿主契约在 0.1.5-rc.2 / 0.1.6-alpha.2 上都已逐项核对通过。
本预设是随包 standard 预设的**全量副本 + 插件行**，上游一改预设行（改 config / 改包名 / 加行 / 停用行），副本没跟就会被校验或解析拦下。已发生的两次：
① `0.1.5-rc.2` 把 `@deepseek-ai/dsh-persona` 由 `text` 改为 `prefix`(必填) + `suffix`；
② `0.1.6-alpha.2` **删掉了 `@deepseek-ai/dsh-workflow-worker-thread`**（换成 `@deepseek-ai/dsh-workflow-ptc`）、把 `tool-ralph` 改为默认停用、新增 `tool-plugin-manager`。
**修法**：拿到修好的版本后重跑安装即可（`node scripts/install.mjs` —— 预设以包为准总是刷新）。
**自查**：`npm test`（自 2026-09-18 起含预设自检）或单独 `node scripts/check-preset.mjs`；它逐行比对本预设与随包 standard，报漂移/缺行。
自建预设同样会中招，改法是**重新以随包 standard 为底生成 + 保留自己的插件行块**（别手工维护那两百多行）。

---

## 9. 环境与能力边界

**环境**：DSH web `0.1.6-alpha.2`（Windows 主机；宿主服务/事件契约已逐项核对）。Office/Edge 为**可选增强**（探测失败自动降级）；python-pptx 为**可选兜底**。路径/中间层一律 UTF-8；已兼容 WPS 导出的 UTF-16 文件。

**插件对外交付的三样东西**（都挂在插件 fiber 上，停用/卸载即净）：`ppt_*` 模型工具面 + `/ppt` 命令面；工作流提示词段（`system-prompt/assemble` 注入 `ppt-workflow`）；内置手册 skill（`ctx.skills.register` 内嵌注册）。自检入口：`ppt_state` 会一并报告手册 skill 的注册与可见状态。

**支持矩阵（PPTD v1 视觉子集）**：

| 类别 | 支持 | 说明 |
|---|---|---|
| 元素 | text / shape / line / image / table / chart | chart：bar/line/pie；line **仅 2 点**（多点拆多条） |
| shape | rect/roundRect/ellipse/triangle + **prst 常见形状**（箭头/菱形/五边形/流程图等）+ **custGeom 自定义路径** + rotation + 纯色/渐变/alpha fill | roundRect 圆角 8%；custGeom：moveTo/lnTo/quadBezTo/cubicBezTo/arcTo/close |
| 文本 | 主题引用、fontSize/family/color/bold/italic/align/lineHeight/wrap | 中文换行带标点禁则 |
| 背景 | hex / `$themeRef` / solid / image（cover/contain/fill + 媒体嵌入） | 渲染/导出/导入三端一致 |
| 图表 | 矢量拼绘（可编辑）；python-pptx 引擎降级为表格 | 数据全零显式警告 |

**诚实边界**（不承诺，均有替代路径）：
- 文本度量是**估算档 + 实测档**双档（实测依赖浏览器）；与 Office 原生排版存在字体级系统差（加粗 CJK 已计 1.06 补偿）。
- 导入：阴影/动画/超链接/母版继承不支持；渐变归一主色（stops 保留在 import-styles.json）；chart 降级为占位；**EMF 媒体**与跨实现（WPS）打开未验证。
- 引擎：pptxgenjs 第三引擎未实现（v1.0 前按计划不动）——**`/ppt engine pptxgenjs` 会被明确拒绝**，不会静默切到 pptd；python-pptx 仅兜底/显式指定，**在兜底引擎里 alpha / 渐变按纯色近似**（原生引擎 pptd 保留原样；生成脚本内会留一行注释）。
  > `/ppt engine <auto|pptd|python-pptx>` 设的档位**会被 `ppt_export` 采纳**（工具参数缺省时用它；显式传 `engine=` 时以参数为准）。
  > 兜底引擎的产物自 2026-09-18 起有**真消费者验证**：生成的 Python 必须过 `py_compile`，且必须真跑出 `.pptx` 并由 python-pptx 读回（`npm test` 里两条断言）。此前它连编译都过不去而无人察觉——因为它只在 pptd 硬失败时才被走到，而 python 是可选依赖，"跳过"与"通过"印在同一个颜色上。
- dsh 网页内嵌预览面板（client 面板）未实现——对话内预览已有 `ppt_preview` + `ppt_shot overview` 覆盖。
- 跨平台：COM/Edge 探测路径面向 Windows（macOS/Linux 主机需要对应适配，当前未验证）。

---

## 10. 开发与维护（给改插件的人）

```bash
node scripts/build.mjs          # 免 tsc：src → lib 复制（纯 ESM JS，源码即产物）
npm test                        # build + smoke（239 断言）+ 预设漂移自检（DSH 升级后必跑）
npm run test:real               # 真实资产回归（WPS fixture；19 页 deck 缺失自动跳过）
node scripts/preflight-1.0.mjs  # 发布前预检（坏输入/边界/幂等/性能/媒体 splice——11 断言）
npm run test:preset             # 预设自检：本预设 vs 随包 standard 逐行比对（DSH 升级后必跑）
npm run test:bundle             # 安装路径自证（20 断言）：隔离 DSH_HOME + 真 `dsh plugin add` + dump-config + `--local` 迭代模式（不碰你的 profiles）
npm run check:lib               # lib/ 新鲜度：提交的构建产物必须逐字节等于 src/（smoke 里有同义断言）
npm run eval:skills -- --a <deckA> --b <deckB>   # 技能效果对照打分（纯本地；两个 arm 各跑一次后复算口径，见 docs/06 §7）
node scripts/eval-skills-blind.mjs <deckA> <deckB>   # 生成匿名+随机的盲评材料（结构化盲评协议，见 docs/06 §7.6）
node scripts/audit-manual-facts.mjs  # 手册事实审计：逐条把"手册 vs 源码"验一遍并打印源码锚点（39 条）
```

**改完代码怎么让本机跑上新版**（两种模式，都**必须重启 `dsh web`**——profile bundle 挂载不热更）：

```bash
npm run sync -- --local   # 日常迭代：不发 GitHub，本机跑的=你刚构建的字节（构件落在 D:\plugins\_artifacts\）
npm run sync              # 发版：上传 GitHub 资产 + 把本机与 GitHub 拉回字节级同源
```

**改成本机只用预设行（＝只有「PPT 工作室」才有这些工具/skills）**：

```bash
dsh plugin --profile web remove @dsh-external/dsh-ppt-studio   # ① 先摘掉 profile bundle 行
node scripts/install.mjs                                       # ② 建 junction + 写含插件行的预设
# ③ 重启 dsh web
```

之后日常迭代照旧 `npm run sync -- --local`（非 bundle 模式下它会穿过 junction 逐文件 sha256 自证"挂载副本 == 刚构建的字节"，
并把预设**保留**插件行）。回退到全会话可用：`dsh plugin --profile web add <Releases 资产 URL>`。

- `--local` 会先 `git fetch` 检查本地是否落后于 `origin/<分支>`，**落后就直接失败**（怕"以为在最新版上迭代、其实不是"——这种偏差没有任何症状，直到发版才发现分叉）。离线时明确标注"未能确认"并继续。
- 两种模式都只有**一条挂载路径**（profile bundle 行），差别只在"从哪取字节"；`--local` 用本地 tgz 的 `file:` 规格，**不要**为了图快切回 junction/预设行装法——那会多出一条路径，"我改的是哪份代码"就有两种答案，而且答错不报错。
- 想退回 GitHub 版本：`dsh plugin --profile web add <Releases 页面上的资产 URL>`。

**关于发布到 npm**：本包**当前不发布**（`private: true`），一键安装走上面的 GitHub Release tgz URL（不需要 npm 账号）。
将来若要发布：删掉 `package.json` 的 `private`、加 `"publishConfig": { "access": "public" }`（作用域包默认 restricted），再 `npm login && npm publish`；
发布前建议先跑 `npm test` 与 `npm run test:bundle`。
**包名是单一事实源**：改名时必须同步 `cordis.patch.yml` 与 `agent-presets/ppt/agent.cordis.yml` 的插件行——
漏一处就是"装了不生效/预设挂不上"，smoke 有断言把三处钉在一起。

- **装配（两条互斥路径，见 §0.7）**：① profile bundle 行（`cordis.patch.yml`，`dsh plugin add` 走这条，**profile 级**——本仓库自己的安装也走这条）；
  ② agent preset 插件行（`<dshHome>/.agent-presets/ppt/agent.cordis.yml`，**会话级**；仅用于"不想动 profile / 离线 junction"场景，脚本 `install.mjs` 会按环境二选一并在 bundle 模式下**删掉插件行**）。
  改码 = build + **重启 host**（`dev_reload_package` 只覆盖注入器装配的包，本站两条路径都不在其域内）。
- **文档链（每次改动必同步）**：`docs/01-需求与目标.md`（需求/决策/冲突）· `docs/02-技术报告.md`（实现级）· `docs/03-更新日志.md`（版本记录）· `docs/04-路线图与里程碑.md`（验收）· `docs/05-迭代流程.md`(检查单) · `docs/06-评审与测试.md`（发布前评审/测试矩阵）。
- **git 约定**：一个功能/修复一个 commit；message `vX.Y.Z: <一句话目的>（反馈编号）`；**`lib/` 提交**（构建产物，见下）。
- **`lib/` 为什么提交**（2026-09-16）：`dsh plugin --profile web add <本仓库 git URL>` 只拿得到 git 里**已提交**的内容，而 `exports` 指向 `./lib/index.js`——lib 不入库时，git 安装出来的包缺入口文件、插件挂不上（实测：装到的包没有 lib/）。提交后 git 安装与 tgz 安装产物一致。代价是"改了 src 忘了 build + commit"会静默发出旧代码，所以配了守卫：`npm run check:lib` + smoke 里一条同义断言（lib 必须逐字节等于 src，且 `.gitignore` 不得忽略它、git 必须跟踪它）。改码流程 = 改 `src/` → `node scripts/build.mjs` → 连同 `lib/` 一起提交。
- **既有的自动化验证**：smoke（239 断言，全链路）→ preflight（发布预检）→ regression-real（真实资产）→ preset 自检（DSH 升级后）→ 手册事实审计（`audit-manual-facts.mjs`）→ 真实任务闭环（参考 docs/06 的测试矩阵与历轮反馈）。
- **OOXML 产物必须用真消费者验**（2026-09-14 教训）：加备注页时先写的 `notesMasterIdLst`，python-pptx 照读不误，**真 PowerPoint 却报"文件或目录损坏"**——
  第三方库通过 ≠ 能打开。凡改导出编码，至少走一次真 PowerPoint（`ppt_visual`）/真浏览器，别只信自证断言。

**版本规则**：semver。`major` 破坏中间层/接口兼容；`minor` 新特性；`patch` 修复/文档。v1.0.0 = 三轮真实端到端测试通过后的稳定基线。
