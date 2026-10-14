# dsh-sci-viz · 科研可视化工作台

一个 DSH 插件，把三件事放进同一个面板：**蛋白质三维结构**、**统计图表**、**技能库浏览器**。
目的很直白：不要再让 AI 用文字描述「一个由 964 个残基组成的细长螺旋束」，直接看图。

- **随取随用**：**195 个技能随插件一起分发**（`data/skill-pack.json.gz`，含完整 SKILL.md 正文），
  挂载时全部注册进 DSH 技能系统 —— 对方装上就能直接调用，**不需要任何本地技能目录**。
- **零依赖**：宿主半边只用 `node:` 内置模块，浏览器半边只 require 平台自带的 `react`。
- **零构建**：没有打包步骤，改完 `lib/*.js` 刷新页面即生效。
- **体积**：运行时读的文件合计约 **1.2 MB**（其中技能包 0.84 MB）。见「八、体积」。

---

## 零、怎么装

```
1. 打开 DSH → 设置 → 插件
2. 在安装框里粘贴这一行：
   https://github.com/Astepluver/dsh-sci-viz/releases/latest/download/dsh-sci-viz.tgz
3. 等它装完，重启一次 DSH
4. 刷新页面，右下角会出现一枚可拖动的图标，点它打开面板
```

也可以下载 `.tgz` 后在安装框里填本地绝对路径。注意安装框不认 zip 文件本身的路径 ——
要先解压，再指向**解压出来的目录**。

**Release 还没建/附件坏了时的兜底**：直接把仓库地址粘进安装框也行 ——
`https://github.com/Astepluver/dsh-sci-viz`（DSH 会走 git 安装，公开仓库无需登录）。

**为什么要重启**：插件分两半，负责计算的那一半是 ESM 模块，Node 按 URL 缓存，
改完只有重启才会重新加载；负责绘制的那一半每次刷新页面重新取。

**怎么确认装好了**：打开 `http://127.0.0.1:19387/api/sci-viz/health`，应当看到
`skillRegistration.registered: 195` 与 `registry: { ours: 195, oursExpected: 195 }` ——
那是直接向 DSH 技能系统核对的结果，不是插件的自报数。

---

## 3.1.0 新增了什么

这一版加的是**保险**，不是新图型 —— 插件以前只负责画，画得对不对全靠用它的人自觉。

- **插件自带验证规程**：挂载时注册一段系统提示，把「图对不对」拆成四层
  （通道自检 → 契约层纯读 → 数值对拍 → 几何与视觉），并要求交付声明分三档
  （`已对拍` / `仅契约校验` / `待人工确认`）。**跟着插件走，分享出去对方也有**。
- **子代理验证通道**：子代理的 `write`/`edit` 默认被拒，只有 `<会话 cwd>/.dsh-verify/` 内放行，
  拒绝时带原因；Agent Teams 队友自动豁免。可用 `verifyProtocol` 整体关掉。
- **可移植 oracle `tools/recompute.py`**：纯 Python 标准库（不依赖 scipy），
  `--selftest` 自检 10 个已发表临界值，覆盖 t / ANOVA / 卡方 / 回归 / 描述统计。
- **规程自检 `tools/check-verify-protocol.mjs`**：33 条断言，防止这段保险静默失效。
- 工具调度纪律写进规程：验证时**不得调用 `sci_viz_*`**（会覆盖唯一真源、冲掉用户正在看的面板）。

详见第五节「可视化是怎么验证的」。

---

## 3.0.1 新增了什么

- **热图**（`heatmap`）：发散色阶 0 居中，可选**行列层次聚类树**，带色阶条
- **序列 Logo**（`logo`）：字母高度 = 信息量（bits），自动区分核酸/蛋白，间隙不计入
- **基因互作网络**（`network`）：力导向布局，**无随机数**（同输入必得同图）
- **生存曲线**（`survival`）：KM 阶梯 + **删失竖杠** + 中位虚线 + log-rank 检验
- **ROC 曲线**（`roc`）：正方形绘图区 + AUC + 最佳切点，支持多模型对比
- **SVG 矢量导出**：工具栏新按钮，投稿用；10 种面板都验证过产出合法 SVG
- **基因组页能自己干活了**：顶部输入条粘 Newick/FASTA/TSV 直接出图，Ctrl+Enter 跑
- **变异密度分箱**：2.4 万个变异画成 496 个密度柱，而不是 24000 条糊成实线的刻度
- **独立窗口**（3.0.1）：工具栏「⧉ 独立窗口」把可视化放进浏览器新窗口，可以拖到聊天框旁边看。
  那个窗口用的还是本插件的渲染器（同一份代码），三维结构照样能拖能缩放，另有 PNG / SVG 导出

数值内核新增 KM / log-rank / ROC，**与 scipy 逐项对拍**（log-rank χ² 相对误差 1.2e-16）。

---

## 一、它长什么样

**三个入口，随便哪个都能打开**（入口这种东西不能只押一个位置 —— 第三方皮肤会替换侧边栏，
自定义的 panellist 条目在那种皮肤里根本不会渲染）：

| 入口 | 位置 | 是否受皮肤影响 |
|---|---|---|
| 🔬 可视化 药丸 | 悬浮在界面右下角，**可拖动**换位置 | 不受（挂在 body 上） |
| 🔬 可视化 按钮 | 输入框工具行左侧（`conversation.input.left`），就在「+」旁边 | 一般不受（composer 属 shipped UI） |
| 科研可视化 图标 | 侧边栏面板图标行（`sidebar.panellist`） | **受**：maid-atelier 这类整体替换侧边栏的皮肤不会显示 |

点一下打开，再点一下切回对话；面板标题栏右侧还有「← 返回对话」按钮，**Esc** 同样可以退出。
标题栏的 `⇥` 开关控制「AI 推来新图时是否自动跳到本面板」—— 不想被打断就关掉，内容照常更新，
有新内容时入口药丸会亮一个小点提示你。

面板本身是 DSH 主面板里的一页（`main` 键位槽，和官方「插件」页同一个机制），三个标签页：

| 标签页 | 内容 |
|---|---|
| 三维结构 | PDB/mmCIF 交互式查看：卡通 / 骨架 / 球棍 / 空间填充 / 仅配体；按链 / 二级结构 / B 因子 / 残基性质 / 元素 / 彩虹着色；**N 端（绿）/ C 端（紫）/ 指定位点（红）三类高亮**，都带标签；`focus` 聚焦把镜头推进到口袋并把远处结构淡出；拖拽旋转、滚轮缩放、Shift 拖拽平移、双击复位 |
| 统计图表 | 正态分布曲线、t 分布拒绝域、F 分布、箱线图 + 抖动散点、直方图 + 正态拟合、Q-Q 图、效应量森林图、残差图、功效曲线；图下附统计表与一句话结论 |
| 技能库 | **195 个技能随插件分发**（含完整 SKILL.md 正文，打包 0.85 MB），挂载时全部注册进 DSH 技能系统 —— 分享给别人，对方装上就能直接调用；面板里可检索、可按分类与来源筛选、可读正文 |

> **分享这件事**：`data/skill-pack.json.gz` 里是 195 个技能的完整正文，`apply()` 时通过
> `ctx.skills.register({ source: 'bundled', ... })` 逐个注册。所以对方**不需要**任何本地技能目录，
> 装上插件技能就能用。附属资源（`scripts/` `references/`，源目录合计约 59 MB）没有打包，
> 由 `tools/build-skill-pack.mjs` 把清单记在正文里。
>
> 早期版本用「即用层 / 技能库层」标注，那是原工作区目录结构的划分；现在技能全部随插件注册，
> 这个区别对使用者不再有意义，已改成按**来源**标注（自带 / 本地目录）。

> 踩过的坑，记在这里免得重犯：
> 1. 早期版本浮窗没有关闭按钮、侧栏入口在皮肤下不渲染，结果「打开了出不去、关上了进不来」。
>    现在入口有三个、出口有两个（按钮 + Esc），且主面板和浮窗共用同一份 `createPanel` 实现。
> 2. **绝不用 PowerShell 的 `Get-Content` / `Set-Content` 搬运这个插件的源码**。Windows PowerShell 5.1
>    按 ANSI（GBK）读 UTF-8 文件，写回时中文变乱码、尾字节还会吞掉相邻的引号/反引号/换行 ——
>    一次这样的「裁剪」把 `lib/index.js` 写坏了，最后是靠重放会话日志里的 `write` + 每次 `edit` 才救回来。
>    改文件只用编辑器工具（read / edit / write）；要用脚本就直接在 Node 里用 `fs`，让编码归 Node 管。

---

## 二、模型侧：5 个工具

| 工具 | 用途 |
|---|---|
| `sci_viz_structure` | 打开一个结构。`source` 支持本地路径、4 位 PDB ID（自动从 RCSB 下载）、http(s) 链接；`highlight` 支持 `S315T` / `S315` / `315` / `A:315` |
| `sci_viz_stats` | 跑统计**并**出图。`kind` = `normal` / `ttest` / `anova` / `chisq` / `regression` / `power` / `descriptives` / `survival` / `roc` |
| `sci_viz_genomics` | 基因组学出图。`kind` = `phylo` / `msa` / `enrich` / `genome` / `coverage` / `volcano` / `heatmap` / `network` / `logo` |
| `sci_viz_plot` | 通用逃生门：直接给面板定义，画任何 `sci_viz_stats` 覆盖不到的图 |
| `sci_viz_skills` | 把面板切到技能页并按关键词 / 分类 / 层级筛选、高亮 |

```jsonc
// 看一个突变位点
{ "source": "1SJ0", "label": "KatG S315T", "highlight": ["S315T"],
  "style": "ballstick", "colorBy": "element", "focus": [10.2, 4.5, 22.1] }

// 两组 MIC 比一比
{ "kind": "ttest",
  "groups": [{ "label": "野生型 H37Rv", "values": [8.2,7.9,8.5,8.1] },
             { "label": "katG S315T",   "values": [7.1,6.8,7.4,7.0] }] }

// 三组以上的 MIC
{ "kind": "anova", "groups": [ { "label": "敏感株", "values": [ /* … */ ] },
                               { "label": "单耐药", "values": [ /* … */ ] },
                               { "label": "耐多药", "values": [ /* … */ ] } ] }
```

---

## 三、便携性（不依赖本地 skill 包）

技能清单的两层来源：

| 来源 | 提供什么 | 是否必需 |
|---|---|---|
| 插件自带 `data/taxonomy.json` | 195 个技能的目录名、分类、中文说明、英文说明、标签、权重、层级 | **必需，已随插件打包** |
| 配置项 `skillsDirs` 指向的技能目录 | `SKILL.md` 正文、路径、体积、是否有 `scripts/` `references/` | 可选增强 |

- **不配 `skillsDirs`**：技能库照常浏览，分类/搜索/标签全部可用；点开某条只显示快照说明。
- **配了但目录不存在**（换机器最常见的情况）：静默跳过，不报错、不降级、不影响其它功能。
- `tools/enrich-taxonomy.mjs` 负责把 `SKILL.md` 的标题与说明抄进快照 —— 这是**构建期**
  的一次性动作，运行期不再需要技能目录。

`GET /api/sci-viz/health` 会报告 `config.portable` 与 `skills.readable`，一眼能看出当前是哪种形态。

---

## 四、统计的可靠性

数值内核 `lib/core/numeric.js` 是纯函数，**没有查表近似**：正态走不完全 Gamma，
t / F 走不完全 Beta，卡方走不完全 Gamma，p 值是精确值。

`tools/verify-math.mjs` + `tools/verify-math.py` 用工作区里现成的 scipy 1.18 独立对拍：

```
node tools/verify-math.mjs
.venv-skills\stat\Scripts\python.exe tools/verify-math.py
→ checked=546 failures=0
```

覆盖 546 项：正态 PDF/CDF/分位数、t PDF/CDF/分位数（df = 1…1000）、F、卡方、非中心 t、
不完全 Beta/Gamma、erf/lgamma；描述统计（含偏度/峰度的无偏定义）、单样本/独立/Welch/配对
t 检验、单因素 ANOVA（含事后比较）、卡方（含 Yates）、线性回归、Shapiro-Wilk（n = 6…1000）、
t 检验功效与非中心 t 积分。容差 rtol = 1e-8 / atol = 1e-10。

> 已知边界：ANOVA / 卡方的 F、χ² 分布图在观测统计量远大于临界值时横轴会被拉得很长，
> 曲线挤在左侧。图仍然正确（观测值标在右侧、拒绝域涂红），只是形态不美观。

---

## 五、可视化是怎么验证的

### 5.1 渲染层：没有浏览器也能确认画面对不对

客户端渲染器只用一个受限的 Canvas2D 指令子集，
`tools/verify-visual.mjs` 里有一个 **Canvas2D → SVG 记录器**，把浏览器端**同一份代码**
的绘制调用录成 SVG，再用 profile 里已有的 `sharp` 光栅化成 PNG 交给人眼检查。

```
node tools/verify-visual.mjs            # 32 张，检查完自动删掉中间产物
node tools/verify-visual.mjs --keep     # 保留 PNG/SVG 自己看
```

覆盖：5 种结构表现方式 × 多种着色、高亮 + 标签、7 种统计图、通用绘图入口、窄版式。
渲染器一旦用到 shim 没实现的 canvas 成员，脚本直接抛错而不是静默画错。

**但它验不到语义**：断言全是数量与几何量（图元数、rect/path 比例、标签配平、旋转矩阵、缩放比），
没有像素基线；`measureText` 只是按字宽估算（CJK 1.0em / 其余 0.55em）。
所以标签遮挡、截断、配色语义、数据→几何映射是否正确，机器判不了 —— 必须由人确认。

### 5.2 规程层：插件自带的验证规程（3.1.0 起）

插件挂载时会注册一段系统提示（`lib/verify-protocol.js`，`order 750`），
把「图对不对」拆成四层，任何一层都不许冒充另一层：

| 层 | 做什么 | 谁能做 |
|---|---|---|
| 0 通道自检 | 先确认这台机器上哪些验证通道真能跑；跑不起来就如实标「不可用」 | 模型 |
| 1 契约层 | 纯读状态文件与工具返回：`doc.kind`／分组／样本量／来源与日期／数字可追溯 | 模型 |
| 2 数值对拍 | 用 `tools/recompute.py` 独立重算关键统计量，容差 rtol≈1e-6 | 模型 |
| 3 几何与视觉 | 机器只验几何量；**语义、遮挡、配色交回人** | 人 |

同时给**子代理会话**加一道只读守卫：`write` / `edit` 默认被拒，
**只有 `<会话 cwd>/.dsh-verify/` 内放行**（验证经常要写对拍脚本，全禁会让验证做不了）。
Agent Teams 队友自动豁免。全部可在 `cordis.patch.yml` 的 `verifyProtocol` 关掉：

```yaml
verifyProtocol:
  enabled: true
  verifyScratchDir: '.dsh-verify'   # 相对会话 cwd
  subagentReadOnly: true
  allowScratchWrites: true
  deniedTools: [write, edit]
  denyShell: false                  # 拦了 shell，子代理就跑不了对拍脚本
```

### 5.3 数值层：两条互补的对拍通道

| 通道 | 覆盖 | 依赖 |
|---|---|---|
| `tools/verify-math.py`（配 `verify-math.mjs`） | JS 数值内核 vs scipy，546 项 | **需要 scipy**；没有就标该通道不可用 |
| `tools/recompute.py`（3.1.0 新增） | 独立重算 t / ANOVA / 卡方 / 回归 / 描述统计 | **纯 Python 标准库**，分享到任何机器都能跑 |

```bash
python tools/recompute.py --selftest        # 先自检：10 个已发表临界值全过才允许用
python tools/recompute.py spec.json         # 对拍：{"test":"t_test","args":{...}}
```

### 5.4 规程自检

```bash
node tools/check-verify-protocol.mjs        # 33 条断言：身份分发/该拦该放/越界/降级/不写死用户目录
```

存在的理由很具体：这段保险的失败模式是**静默失效**（不注入、不生效、且没有报错），
所以把它钉成断言 —— 谁改了 `verify-protocol.js`，跑一遍就知道有没有把它改坏。

---

## 六、安装 / 卸载

```powershell
# 用 plugin_manager 工具（推荐）：install_bundle，target = 插件目录
# 或命令行：
node "<dsh 命令>" plugin --profile desktop add "<插件目录>"
```

本地路径安装走 pnpm 的 `link:`，**不复制文件**，改完即可生效。
卸载：`plugin_manager` 的 `remove_bundle`，或在 Plugins 页面里关掉这一行。

> 改了 `lib/index.js`（宿主半边）之后，插件管理器的启用/禁用切换**不一定**会重新 import
> 那个模块（Node 的 ESM 缓存按 URL 记）。要确保宿主侧改动生效，重启 DSH 最稳。
> 浏览器半边 `lib/client.js` 是每次从磁盘读并带版本号的，刷新页面即可拿到最新版。

---

## 七、目录

```
dsh-sci-viz/
├─ package.json            # dsh.bundle.patch → cordis.patch.yml；dsh.client → ./client
├─ cordis.patch.yml        # 插入行 + 可覆盖的配置（skillsDirs / structureRoots / stateDir）
├─ lib/
│  ├─ index.js             # 宿主半边：路由、工具、技能清单、图表构造
│  ├─ client.js            # 浏览器半边：主面板 + 隐形 watcher + 三维渲染 + 二维图表（单文件自包含）
│  └─ core/
│     ├─ numeric.js        # 分布函数与统计检验（纯函数）
│     └─ structure.js      # PDB/mmCIF 解析 + 结构几何编译
├─ data/taxonomy.json      # 195 个技能的自包含快照（78 KB）
├─ 功能清单.md             # 完整功能说明（工具参数表由 tools/make-manifest.mjs 从代码生成）
├─ tools/                  # 验证与构建脚本（不参与运行时）
│  ├─ verify-math.mjs/.py  # 数值内核对拍 scipy
│  ├─ verify-visual.mjs    # Canvas2D→SVG→PNG 视觉验证 + 回归断言
│  ├─ smoke-host.mjs       # 假 ctx 挂载：工具/路由/便携模式
│  ├─ smoke-structure.mjs  # 解析器冒烟
│  ├─ check-client.mjs     # 入口与出口链路自检
│  ├─ check-delivery.mjs   # 零依赖 / 零构建 / 体积约束
│  ├─ push-viz.mjs         # 命令行推图（不经过工具注册，直接写状态文件）
│  ├─ make-manifest.mjs    # 生成《功能清单.md》
│  └─ enrich-taxonomy.mjs  # 把 SKILL.md 标题与说明抄进快照（构建期，一次性）
└─ state/current.json      # 当前可视化文档（唯一真源，运行期产物）
```

> **改完怎么重新生成清单**：`node tools/make-manifest.mjs`。工具参数表是从实际注册的定义里
> 读出来渲染的，所以只要重跑就不会和代码脱节。

## 八、体积

| 部分 | 大小 |
|---|---|
| `lib/index.js` + `lib/core/*` | 约 124 KB |
| `lib/client.js` | 约 100 KB |
| `data/taxonomy.json`（195 技能快照） | 78 KB |
| `tools/*`（验证/构建，可不随插件走） | 约 60 KB |
| **运行时合计** | **约 250 KB** |
| `state/current.json` | 随当前文档变化（结构几十~几百 KB，图表 10–30 KB，只有一个文件、每次覆盖） |

`.tmp/` 是验证脚本的中间产物（约 10 MB），脚本默认用完即删；`--keep` 才保留。

## 九、实现上的几个刻意选择

1. **不 import `@deepseek-ai/*`。** 插件以 `link:` 装在工作区目录，Node 按 realpath 解析
   bare specifier，走到 `插件\` 就断了 —— 找不到 profile 的 `node_modules`。所以宿主半边
   只用内置模块；工具用普通对象直接交给 `ctx.tools.register()`（它只要求 `defineTool`
   产出的那个**形状**：原始 JSON Schema + `output.render`），参数校验自己补上
   （`validateAgainst`），因为 `register()` 不会替我们校验。
2. **主面板 + 隐形 watcher。** 面板只有被选中时才挂载，所以轮询放在 `shell.overlay` 里
   一个不可见的 watcher 上：它负责取文档、按开关决定要不要 `layout.selectPanel()` 翻页；
   页面组件只订阅结果。用户停在对话页时新图也能被发现，不想被打断就关掉 `⇥`。
3. **状态文件是唯一真源。** 工具、命令行、任何外部脚本都只是往 `state/current.json`
   写一份文档，浏览器轮询 `GET /api/sci-viz/state?rev=` 取。于是「推一张图到面板」
   不依赖工具注册是否成功，`node -e "..."` 也能做到。
4. **取景用投影包围盒，不是包围球。** 细长结构（长螺旋束、MCE 转运体）用包围球会被
   缩到只占一角；按当前姿态的投影包围盒取景，球状和棒状都能撑满画布。
