/**
 * 生成《功能清单.md》。
 *
 * 工具参数表不是手写的 —— 它从 lib/index.js 实际注册的工具定义里读出来再渲染成
 * markdown，所以清单和代码不会对不上。改完工具定义重跑一次即可。
 *
 * 用法：node tools/make-manifest.mjs
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const OUT = join(PLUGIN, '功能清单.md')

// ---- 挂载一次，拿到真实注册的工具定义 -------------------------------------
const tools = new Map()
const fakeCtx = {
  logger: { warn() {}, info() {}, error() {} },
  effect: (body) => body(),
  get: (n) => (n === 'tools' ? { register: (d) => { tools.set(d.name, d); return () => {} } } : undefined),
  webServer: { register: () => () => {} },
}
const host = await import(`file://${join(PLUGIN, 'lib', 'index.js').replace(/\\/g, '/')}`)
host.apply(fakeCtx, {})
await new Promise((r) => setTimeout(r, 400))

/** JSON Schema → 人话类型。 */
function typeOf(schema) {
  if (!schema || typeof schema !== 'object') return '任意'
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map(typeOf).join(' | ')
  if (Array.isArray(schema.enum)) return `枚举：${schema.enum.map((v) => `\`${v}\``).join(' / ')}`
  switch (schema.type) {
    case 'array': return `数组<${typeOf(schema.items)}>`
    case 'object': {
      const keys = Object.keys(schema.properties ?? {})
      return keys.length ? `对象 { ${keys.join(', ')} }` : '对象'
    }
    case 'integer': return '整数'
    case 'number': return '数字'
    case 'boolean': return '布尔'
    case 'string': return '字符串'
    default: return '任意'
  }
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()

function toolSection(def) {
  const req = new Set(def.parameters.required ?? [])
  const entries = Object.entries(def.parameters.properties ?? {})
  const rows = entries.map(([name, s]) =>
    `| \`${name}\` | ${esc(typeOf(s))} | ${req.has(name) ? '**必填**' : '可选'} | ${esc(s.description) || '—'} |`)
  return [
    `### \`${def.name}\``,
    '',
    def.description,
    '',
    '| 参数 | 类型 | 必填 | 说明 |',
    '|---|---|---|---|',
    ...rows,
    '',
    `返回字段：${Object.keys(def.output.schema.properties ?? {}).map((k) => `\`${k}\``).join('、')}`,
    '',
  ].join('\n')
}

const taxonomy = JSON.parse(readFileSync(join(PLUGIN, 'data', 'taxonomy.json'), 'utf8'))
const cats = (taxonomy.categories ?? []).map((c) => {
  const n = Object.values(taxonomy.skills).filter((s) => s.cat === c.id).length
  return `${c.zh} ${n}`
}).join(' · ')

const doc = `# dsh-sci-viz 功能清单

> 这份清单里的**工具参数表是从代码里实际注册的定义生成的**（\`tools/make-manifest.mjs\`），
> 不是手抄的，所以不会和实现脱节。其余部分是面板行为的人工说明。
> 生成时间：${new Date().toISOString().slice(0, 10)}

## 一句话

在 DSH 里开一个面板，把「说不清楚的蛋白质三维结构」和「一堆数字的统计结果」直接画出来；
顺带把工作区的技能清单做成可检索的浏览器。零依赖、零构建、随插件目录搬走就能用。

---

## 一、怎么打开、怎么退出

| 入口 | 位置 | 受第三方皮肤影响？ |
|---|---|---|
| 🔬 可视化 药丸 | 悬浮在界面右下角，**可拖动**换位置 | 不受（挂在 body 上） |
| 🔬 可视化 按钮 | 输入框工具行左侧，就在「+」旁边 | 一般不受 |
| 科研可视化 图标 | 侧边栏面板图标行 | **受**：整体替换侧边栏的皮肤（如 maid-atelier）不会显示 |

| 出口 | 说明 |
|---|---|
| 「← 返回对话」按钮 | 面板标题栏右侧 |
| **Esc** | 键盘直接退出 |

入口按钮是**开关**：已在面板上再点一次就切回对话。
标题栏的 \`⇥\` 控制「AI 推来新图时是否自动跳转到本面板」，关掉后内容照常更新，
入口药丸会亮一个小点提示有新内容。

---

## 一点五、面板上直接能做的事（不用叫 AI）

这是这个插件的重点：**不是给 AI 用的看板，是给你自己用的工具**。打开面板后不需要我参与：

| 想做的事 | 在哪儿做 |
|---|---|
| 打开一个 PDB / mmCIF | 结构页底部的「打开结构」输入框：填本地路径、4 位 PDB ID 或网址，回车即开；**也可以把 .pdb/.cif 文件直接拖进画布** |
| 换表现方式 / 着色 / 只看某条链 | 结构页左上角的芯片，点一下即时生效 |
| 高亮 N 端 / C 端 | 结构页工具栏「末端高亮」芯片（绿 N 端 / 紫 C 端），选择会被记住 |
| 旋转、缩放、平移、复位 | 直接拖拽 / 滚轮 / Shift+拖拽 / 双击 |
| 跑一次统计并出图 | 图表页底部的「数据」条：选检验类型 → 把数据粘进文本框 → 点「运行」 |
| 存图 / 存数据 | 标题栏 \`PNG\`（2 倍分辨率）与 \`CSV\` |
| 找技能、看技能正文 | 技能库页搜索 / 筛选 / 点开，另有三个一键复制 |

**粘贴数据的规则**（文本框里有同样的提示）：

\`\`\`
对照组   8.2 7.9 8.5 8.1      ← 每行一组「标签 数值 …」→ t 检验 / ANOVA
8.2                           ← 纯数字一列 → 单样本 / 描述统计 / 正态拟合
7.9
1 2.4                         ← 纯数字两列 + 线性回归 → x 与 y
2 3.1
18 7                          ← 数字矩阵 + 卡方 → 计数表
6 19
\`\`\`

标签可以带空格（\`野生型 H37Rv 8.2 …\`）；\`#\` 或 \`//\` 开头的行会被忽略；
多列且无标签时按「每列一组」处理。

> **面板上的按钮和 AI 调用的工具走的是同一份实现**（宿主的 \`buildStructureDoc\` / \`buildStatsDoc\`），
> 所以界面上能做的事不比工具少，出错信息也一模一样。

---

## 二、三维结构（结构标签页）

**能读**：PDB 与 mmCIF；来源可以是本地路径、4 位 PDB ID（自动从 RCSB 下载）、http(s) 链接。
AlphaFold 这类没有 HELIX/SHEET 注释的文件，二级结构由 Cα 几何推算，并在结果里标明来源。

**五种表现**：卡通（螺旋/折叠用不同粗细，折叠片末端带箭头）· 骨架 · 球棍 · 空间填充 · 仅配体

**六种着色**：按链 · 按二级结构（红 α / 黄 β / 灰卷曲）· 按 B 因子 · 按残基性质 · 彩虹 · 按元素（CPK）

**高亮三类，颜色分得开**：

| 类别 | 颜色 | 怎么触发 |
|---|---|---|
| 指定位点 | 红 | 工具参数 \`highlight\`，写法 \`S315T\` / \`S315\` / \`315\` / \`A:315\` |
| N 端 | 绿 | 工具栏「末端高亮」芯片，或工具参数 \`termini: true\` |
| C 端 | 紫 | 同上 |

末端高亮标的是**每条链**的首/末残基，标签写着链号与残基号（如 \`A N端 1\`、\`A C端 964\`）。
工具栏上的开关会记住你的选择，换成别的结构也保持。

**聚焦模式**：给了 \`focus\`（\`[x, y, z]\`，Å）之后，镜头推进到该点 14 Å 范围，
16 Å 内保持不透明、30 Å 外淡到 0.16 —— 远处结构自动让位，突变位点/结合口袋从背景里跳出来。

**交互**：左键拖拽旋转 · 滚轮缩放 · Shift+拖拽平移 · 双击复位视角 · \`↻\` 自动旋转 · \`⌖\` 重置
**多链**：工具栏按链给开关，可只显示其中几条
**图例**：左下角自动列出当前着色方案与开启中的高亮类别及数量

---

## 三、统计图表（图表标签页）

七种分析，每种都是「算 + 画」一起做，图下面还给统计表和一句话结论：

| \`kind\` | 出什么图 | 算什么 |
|---|---|---|
| \`normal\` | 正态曲线（±1/2/3σ 分层阴影）+ 累积分布；给了 \`values\` 再附直方图+正态拟合与 Q-Q 图 | μ、σ、分位点、95% 中心区间、Shapiro-Wilk 正态性 |
| \`ttest\` | t 分布拒绝域 + 两组箱线图（抖动散点 + 均值 + 95%CI）+ 效应量森林图 | 单样本 / 独立 / Welch / 配对；t、df、精确 p、均值差与 CI、Cohen's d / dz、方差齐性 F 检验 |
| \`anova\` | F 分布 + 各组箱线图 + 事后两两比较森林图 | F、df、精确 p、η²、ω²，事后用 Welch t + Holm-Bonferroni |
| \`chisq\` | 观察频数柱状图（白菱形标期望）+ 卡方分布 | χ²、df、精确 p、Cramér's V，2×2 自动 Yates 校正 |
| \`regression\` | 散点 + 最小二乘线 + 95% 置信带；残差图 | 斜率/截距及 CI、R²、r、斜率 t 检验 p |
| \`power\` | 功效曲线（对 n） | 达到目标功效所需每组样本量 |
| \`descriptives\` | 箱线图 + 直方图 | n、均值、SD、SE、中位数、Q1/Q3、极值、95%CI、偏度、峰度 |

p 值是精确值（不完全 Beta / Gamma），不是查表近似 —— 与 scipy 1.18 逐项对拍通过（见第九节）。

**通用绘图**：\`sci_viz_plot\` 直接给面板定义，图元支持
\`area / line / points / bars / boxes / hist / errorbars / vline / hline / rect / text\`，
适合动力学曲线、剂量-反应曲线、示意图这类统计检验覆盖不到的图。

---

## 三、基因组学（基因组标签页）

对应技能库里的 DNA/RNA 类技能：\`phylogenetics\`·\`etetoolkit\` 建树看树、\`protein_sequence_msa\` 比对、
\`pathway-enrichment\`·\`reactome_database\` 富集、\`pysam\`·\`deeptools\`·\`tiledbvcf\` 覆盖度与 VCF、
\`pydeseq2\` 差异表达。六种图，一次调用出一张：

| \`kind\` | 出什么图 | 输入 |
|---|---|---|
| \`phylo\` | 矩形进化树：分支长度成横向距离，内部节点标 bootstrap，叶子可按谱系着色 | Newick 字符串（支持分支长度、引号标签、\`[注释]\`） |
| \`msa\` | 多序列比对：残基按化学性质着色（六类），顶部一条逐列保守度轨道，带列坐标 | \`[{name, seq}]\`（已比对） |
| \`enrich\` | GO/KEGG 富集气泡图：y = 通路（按 p 排序），x = 基因比例或基因数，气泡大小 = 基因数，颜色 = −log10(p) | \`[{term, count, p, ratio, category}]\` |
| \`genome\` | 线性基因组图：每条染色体一条横杠，SNP/INDEL 画上方、CNV/SV 画下方，标签自动错层 | \`chromosomes\` + \`variants\` |
| \`coverage\` | 测序覆盖度轨道：每样本一条填充曲线（各带自己的峰值刻度）＋可选基因模型 | \`tracks\` + \`genes\` |
| \`volcano\` | 差异表达火山图：log2FC vs −log10(p)，阈值线与方向着色，可标注基因 | \`points\` + 可选 \`labels\` |
| \`heatmap\` | 表达/相关性热图：发散色阶（0 居中）或 minmax，可选**行列层次聚类树**，带色阶条 | \`values\` 二维矩阵 + 可选行列标签 |
| \`logo\` | 序列 Logo：每列字母按频率堆叠、高度 = 信息量（bits），自动区分核酸/蛋白，**间隙不计入** | \`logoSequences\`（已比对 FASTA） |
| \`network\` | 互作网络：力导向布局（**确定性、无随机数**），节点大小按度数、颜色按分组、线粗按权重 | \`nodes\` + \`edges\`，或粘贴「源 靶 权重」边表 |

**面板上可以直接干活**：基因组页顶部有输入条，粘贴 Newick / FASTA / 富集 TSV / 火山 TSV /
覆盖度 / 热图矩阵 / 变异列表 / 边表就能自己出图，不必回头找模型。解析在宿主完成，
报错是人话（「序列长度不一致（4–5）：比对图要求先把序列比对好」），Ctrl+Enter 直接跑。

**三个刻意的取舍**：

- **质粒给最小可见宽度**。4.41 Mb 的染色体旁边放 4 kb 的质粒，按真实比例不足 1 像素，
  画出来就是「什么都没有」；所以给 4px 下限，长度差异交给右侧的长度标注说明。
- **覆盖度每条轨道用自己的峰值**当刻度。三条轨道共用一个全局最大值，会让人误以为测序深度一样。
- **变异超过 600 个改画密度柱**（柱高 ∝ √该箱变异数）。真实 WGS 是百万级变异，逐点画刻度
  会糊成一条实线；实测 2.4 万个变异 → 496 个柱子，而不是 24000 条线。

---

## 四、生存分析与 ROC（统计图表标签页）

数值内核里新写了 Kaplan-Meier、log-rank 与 ROC/AUC，**与 scipy 逐项对拍**：
KM 的中位生存期/事件数/删失数完全一致，log-rank 的 χ² 相对误差 **1.2e-16**，AUC 精确吻合。

| \`kind\` | 出什么图 |
|---|---|
| \`survival\` | KM 阶梯曲线 + **删失竖杠** + 中位生存虚线 + log-rank χ²/p，末端标 n 与事件数 |
| \`roc\` | ROC 曲线（正方形绘图区，避免曲线形状骗人）+ 对角参考线 + AUC + 最佳切点，支持多模型对比 |

删失必须画出来 —— 不标删失的生存曲线是最常见的误读来源：读者会以为曲线末端是「都活着」，
其实那里可能只剩两三个人在随访。打分方向反了（AUC < 0.5）会明确提示，而不是让人自己猜。

---

## 五、矢量导出

工具栏的 **SVG** 按钮把当前画面导成矢量图（投稿用）。做法是：所有面板本来就用 Canvas 2D 画，
与其再写一套矢量绘制代码（两份实现必然漂移），不如把**同一批绘制调用录进 SVG** ——
每个元素带一个 matrix 变换，旋转过的文字（热图列名）和缩放过的路径都能精确还原。
10 种面板全部经断言验证产出标签配平的合法 SVG。

---

## 六、技能库（技能库标签页）—— 分享出去就能用

- **${taxonomy.snapshot?.onDisk ?? 195} 个技能随插件一起分发**，含完整 SKILL.md 正文
  （打包在 \`data/skill-pack.json.gz\`，约 0.85 MB）
- **插件挂载时把它们全部注册进 DSH 的技能系统**（\`ctx.skills.register\`，\`source: 'bundled'\`），
  所以对方装上插件就能直接调用其中任何一个 —— 不需要本地技能目录，也不需要额外配置
- 徽章「自带」= 插件带的；「本地」= 本机技能目录里额外加的（你自己后来丢进去的会出现在这里）
- 分类：${cats}
- 搜索匹配技能名、中文说明、标签；分类芯片与来源芯片可叠加筛选
- 点开看标题、中文说明、正文、体积、本机源目录路径（若有），以及一键复制：
  \`复制路径\` · \`复制说明\` · \`让 AI 用它\`

**附属资源**：\`scripts/\` \`references/\` \`assets/\` 合计约 59 MB，没有打进包。每个技能的正文里
写明了它期望哪些文件；本机若正好有源目录，详情里会给出路径，可以直接去取。

**自己加技能**：把技能目录丢进 \`skillsDirs\` 指向的位置，它会以「本地」徽章出现在清单里，
点开能读正文 —— 这条路不需要重打技能包。

> 早先版本用「即用层 / 技能库层」标注，那是**原工作区目录结构**的划分（哪些技能的名字常驻上下文）。
> 现在技能全部随插件注册，这个区别对使用者不再有意义，已改成按**来源**标注。

---

## 五、导出

| 按钮 | 作用 |
|---|---|
| \`PNG\` | 当前画面导出为 **2 倍分辨率** PNG（离屏重画，不是放大像素），文件名带标题与时间戳，可直接放进报告 |
| \`CSV\` | 图表数据导出为带 BOM 的 UTF-8 CSV（Excel / GraphPad 直接打开）：统计表 + 每个面板的原始数据点 |

按钮按标签页显隐：结构页只有 PNG，图表页两个都有，技能页都不显示。

---

## 六、模型侧工具

共 ${tools.size} 个，都是宿主注册、模型可调用；调一次就把内容推进面板。

${[...tools.values()].map(toolSection).join('\n')}
---

## 七、配置项（\`cordis.patch.yml\`）

| 键 | 默认 | 说明 |
|---|---|---|
| \`skillsDirs\` | \`[]\` | **可选**。\`[{dir, layer, zh}]\`，配上才能读 SKILL.md 正文；不配/目录不存在都不影响技能清单 |
| \`structureRoots\` | \`[]\` | \`sci_viz_structure\` 收到相对路径时的搜索根目录；空则用进程工作目录 |
| \`stateDir\` | 插件目录\`/state\` | 可视化状态文件所在目录 |
| \`taxonomyPath\` | 插件目录\`/data/taxonomy.json\` | 技能快照 |
| \`rcsb\` | \`https://files.rcsb.org/download\` | PDB ID 下载地址模板 |
| \`maxStateBytes\` | 6 MB | 超过就不落盘（只留内存），避免状态文件膨胀 |
| \`skillPreviewChars\` | 6000 | 技能正文预览上限 |

---

## 八、HTTP 接口（同源，仅限本机 127.0.0.1）

| 路径 | 说明 |
|---|---|
| \`GET /api/sci-viz/state?rev=\` | 取当前可视化文档；rev 相同只回 \`{changed:false}\` |
| \`GET /api/sci-viz/skills\` | 技能清单（JSON） |
| \`GET /api/sci-viz/skill?id=&layer=\` | 某个技能的详情与正文 |
| \`POST /api/sci-viz/clear\` | 清空面板 |
| \`GET /api/sci-viz/hello?v=\` | 浏览器半边报到（存活探测） |
| \`GET /api/sci-viz/health\` | 宿主/客户端存活、技能数、是否便携模式、当前配置 |
| \`POST /api/sci-viz/open-structure\` | **面板「打开结构」用的**：body 同 \`sci_viz_structure\` 参数 |
| \`POST /api/sci-viz/run-stats\` | **面板「运行」用的**：body 同 \`sci_viz_stats\` 参数 |

**状态文件是唯一真源**：任何进程往 \`state/current.json\` 写一份文档，面板 1.5 秒内就会显示。
命令行入口：

\`\`\`powershell
node tools/push-viz.mjs structure <路径|PDB ID> --style=cartoon --color=ss --termini --highlight=S315T
node tools/push-viz.mjs show
node tools/push-viz.mjs clear
\`\`\`

---

## 九、验证命令

\`\`\`powershell
node tools/verify-math.mjs                                    # 生成对拍用例
.venv-skills\\stat\\Scripts\\python.exe tools/verify-math.py   # 与 scipy 逐项比对
node tools/smoke-structure.mjs                                # 解析真实 PDB/mmCIF
node tools/smoke-host.mjs                                     # 工具/路由/便携模式
node tools/verify-visual.mjs                                  # 18 张画面 + 14 条回归断言
node tools/check-client.mjs                                   # 入口与出口链路
node tools/check-delivery.mjs                                 # 零依赖/零构建/体积
node tools/make-manifest.mjs                                  # 重新生成这份清单
\`\`\`

## 十、已知边界

- **分布图横轴**：ANOVA / 卡方的 F、χ² 观测值远大于临界值时（如 F=120 vs 3.1），
  横轴被拉得很长、曲线挤在左侧。图本身正确（观测值标在右侧、拒绝域涂红），只是不美观。
- **样本量**：Shapiro-Wilk 只做 n ≥ 6；n < 6 时如实说明而不是给一个不可靠的 p。
  单样本（n=1）的置信区间退化成点本身。
- **原子上限**：单个结构最多 24000 个原子，超出会截断并在结果里报告。
- **x 轴不支持对数刻度**；分类轴与数值轴自动判定。
- **宿主侧改动需要重启 DSH**：Node 按 URL 缓存 ESM，插件管理器的启用/禁用不保证重新 import
  \`lib/index.js\`（实测有时只刷新路由、不刷新工具表）。\`lib/client.js\` 是每次从磁盘读的，刷新页面即生效。
`

writeFileSync(OUT, doc, 'utf8')
console.log(`已生成 ${OUT}`)
console.log(`  ${(doc.length / 1024).toFixed(1)} KB，工具 ${tools.size} 个：${[...tools.keys()].join(' / ')}`)
