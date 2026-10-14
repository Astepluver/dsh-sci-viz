/**
 * dsh-sci-viz — 浏览器半边（Client half）
 *
 * 一个自包含的窗口：三维结构查看器 + 统计图表渲染器 + 技能库浏览器。
 *
 * 三条设计约束，都是刻意的：
 *  1. **不 import 任何模块**。bundle 是手写的，没有打包步骤：module 系统只认这个
 *     文件本身，相对 require 不在 boot graph 里会直接抛错。所以全部代码在这一个
 *     文件里，且只 require 不到任何东西（`factory(require)` 的 require 一次没用）。
 *  2. **挂在 document.body 上，不用 slot**。同工作区的 dsh-opencode-go-usage 已经
 *     证明了这条路在 Electron 与浏览器两种承载下都稳；slot 注册要赌 React 渲染与
 *     槽位时序，失败模式是「窗口根本不出现」。挂 body 的失败模式是「窗口在但样式怪」，
 *     后者可修，前者不可修。
 *  3. **绘制只走一个 2D context 的受限子集**（save/restore/translate/rotate/scale/
 *     setTransform、路径与 arc、fill/stroke、clip、线性与径向渐变、fillRect/strokeRect、
 *     fillText/measureText、setLineDash、clearRect）。tools/verify-visual.mjs 用同一份
 *     代码把这些调用录成 SVG 再光栅化成 PNG 交给人眼检查 —— 所以这里刻意不用
 *     drawImage / filter / shadow 之类的浏览器特有能力（那个 shim 不实现）。
 *
 * 数据流：宿主把「可视化文档」写进 state/current.json 并提供 /api/sci-viz/state，
 * 这里轮询版本号，变了才拉整份文档。
 *
 * @module dsh-sci-viz/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-sci-viz',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** 宿主路由前缀（同源）。 */
    const API = '/api/sci-viz'

    /** 客户端半边版本号，随 /hello 报给宿主，便于确认页面加载的是哪一版。 */
    const CLIENT_BUILD = '1.2.0'

    /**
     * 向宿主报个到 —— **这是「面板一片空白」唯一能留下的线索**。
     *
     * 浏览器半边的异常会被 DSH 加载器吞掉，页面上什么也看不见；宿主那边也只看到
     * 「clientHits = 0」，无从判断是没加载、加载了没注册、还是注册到一半炸了。
     * 所以挂载过程中每一步都报一次，出错的把消息和栈一起带上，/health 直接能读。
     */
    function report(phase, err) {
      try {
        const q = new URLSearchParams({ v: CLIENT_BUILD, phase })
        if (err) q.set('err', String(err).slice(0, 500))
        return fetch(`${API}/hello?${q}`).catch(() => {})
      } catch {
        return Promise.resolve()
      }
    }

    /**
     * React 来自平台种子表（PLATFORM_MODULES 里的静态模块，随 shell 一起启动，
     * 不需要 dsh.client.external 声明）。注册主面板需要它；取不到就退回浮窗。
     */
    let React = null
    try {
      React = require('react')
    } catch {
      React = null
    }

    // =====================================================================
    // 1. 小工具
    // =====================================================================

    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

    /** 数字 → 紧凑显示。 */
    function fmt(x, digits) {
      if (typeof x !== 'number' || !isFinite(x)) return '—'
      const abs = Math.abs(x)
      if (abs === 0) return '0'
      if (abs >= 1e5 || abs < 1e-4) return x.toExponential(2).replace('e', '×10^')
      const d = digits === undefined ? (abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3) : digits
      return String(Number(x.toFixed(d)))
    }

    /** 1-2-5 规则的好看刻度。 */
    function niceTicks(min, max, target) {
      if (!isFinite(min) || !isFinite(max)) return [0, 1]
      if (min === max) {
        const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1
        min -= pad
        max += pad
      }
      const span = max - min
      const raw = span / Math.max(2, target || 6)
      const mag = Math.pow(10, Math.floor(Math.log10(raw)))
      const norm = raw / mag
      const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
      const out = []
      for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
        out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
      }
      return out
    }

    /** 'rgba(...)' / '#rgb' / '#rrggbb' → {r,g,b,a}；失败返回 null。 */
    function parseColor(value) {
      if (typeof value !== 'string') return null
      const s = value.trim()
      if (s[0] === '#') {
        const hex = s.slice(1)
        if (hex.length === 3) {
          return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: 1 }
        }
        if (hex.length === 6) {
          return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: 1,
          }
        }
        return null
      }
      const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s)
      if (!m) return null
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }
    }

    /** 颜色明暗调整，k>0 变亮、k<0 变暗。 */
    function shade(color, k) {
      const c = parseColor(color)
      if (!c) return color
      const f = (v) => clamp(Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k)), 0, 255)
      return `rgba(${f(c.r)},${f(c.g)},${f(c.b)},${c.a})`
    }

    /** 两色之间线性插值（蓝→红 用作 B 因子/温度着色）。 */
    function lerpColor(a, b, t) {
      const A = parseColor(a)
      const B = parseColor(b)
      if (!A || !B) return a
      const f = (x, y) => Math.round(x + (y - x) * clamp(t, 0, 1))
      return `rgb(${f(A.r, B.r)},${f(A.g, B.g)},${f(A.b, B.b)})`
    }

    // =====================================================================
    // 2. 调色板
    // =====================================================================

    const CHAIN_PALETTE = [
      '#4c9aff', '#f2a33c', '#5ac8a8', '#e56b6f', '#a78bfa',
      '#f4d35e', '#4dd0e1', '#f28e2b', '#8bc34a', '#e15759',
      '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f',
    ]

    const SS_COLORS = { H: '#e56b6f', E: '#f4d35e', C: '#8fa3b8' }

    /** 氨基酸按性质着色。 */
    const RESIDUE_COLORS = {
      hydrophobic: '#f2a33c',
      polar: '#4dd0e1',
      acidic: '#e56b6f',
      basic: '#4c9aff',
      special: '#a78bfa',
      unknown: '#8fa3b8',
    }
    const RESIDUE_CLASS = {
      A: 'hydrophobic', V: 'hydrophobic', L: 'hydrophobic', I: 'hydrophobic', M: 'hydrophobic',
      F: 'hydrophobic', W: 'hydrophobic', Y: 'hydrophobic', P: 'hydrophobic', G: 'special',
      S: 'polar', T: 'polar', C: 'polar', N: 'polar', Q: 'polar',
      D: 'acidic', E: 'acidic',
      K: 'basic', R: 'basic', H: 'basic',
    }
    const AA3TO1 = {
      ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G',
      HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S',
      THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V', MSE: 'M', SEC: 'U', PYL: 'O',
      HID: 'H', HIE: 'H', HIP: 'H', CYX: 'C', CYM: 'C',
    }

    /** 主题色（带兜底值，独立于 DSH 主题也能看）。 */
    const THEME = {
      bg: 'var(--dsw-alias-bg-overlay, #191d23)',
      bgSolid: '#191d23',
      panel: 'rgba(255,255,255,0.03)',
      border: 'rgba(255,255,255,0.10)',
      text: '#e6edf3',
      textDim: '#8fa3b8',
      accent: '#4c9aff',
      grid: 'rgba(255,255,255,0.07)',
      axis: 'rgba(255,255,255,0.24)',
    }

    // =====================================================================
    // 3.5 基因组学面板：进化树 / 序列比对 / 富集气泡 / 基因组变异 / 覆盖度 / 火山图
    //
    // 这几种图放不进「x/y 标尺 + 图层」那套通用模型（树是递归布局、比对是矩阵、
    // 富集是分类轴 + 气泡），所以各自单独画，由 drawPanel 在开头分派。
    // 数据都来自技能库里的基因组学技能：phylogenetics/etetoolkit、protein_sequence_msa、
    // pathway-enrichment/reactome_database、pysam/deeptools/tiledbvcf、pydeseq2。
    // =====================================================================

    /** 面板底：统一的深色背板，和通用图表面板保持一致。 */
    function panelBackground(g, box) {
      g.fillStyle = 'rgba(255,255,255,0.022)'
      g.fillRect(box.x, box.y, box.w, box.h)
    }

    /**
     * 氨基酸按化学性质着色（MSA 常用配色）。
     * 分六类而不是 20 色：20 色在缩略图里根本分不出来，六类能一眼看出「这段是疏水核心」。
     */
    const AA_CLASSES = [
      { id: 'hydrophobic', color: '#4c9aff', chars: 'AVLIMFWYPG' },
      { id: 'polar', color: '#2fbf9b', chars: 'STNQ' },
      { id: 'positive', color: '#e56b6f', chars: 'KRH' },
      { id: 'negative', color: '#f2a33c', chars: 'DE' },
      { id: 'cysteine', color: '#c77dff', chars: 'C' },
      { id: 'special', color: '#8fa3b8', chars: 'GX' },
    ]
    const AA_COLOR = {}
    const AA_CLASS_OF = {}
    for (const c of AA_CLASSES) {
      for (const ch of c.chars) {
        AA_COLOR[ch] = c.color
        AA_CLASS_OF[ch] = c.id
      }
    }
    const aaColor = (ch) => AA_COLOR[ch] || '#6b7a8c'
    /** 保守性 → 颜色：越保守越暖（和「重要」的直觉一致）。 */
    function conservationColor(frac) {
      if (frac >= 0.95) return '#e56b6f'
      if (frac >= 0.8) return '#f2a33c'
      if (frac >= 0.6) return '#e8d44d'
      if (frac >= 0.4) return '#2fbf9b'
      return '#4c6b8a'
    }

    // ---- 1. 进化树 ---------------------------------------------------------

    /**
     * 解析 Newick。支持分支长度、内部节点标签（bootstrap）、引号标签、注释 [..] 忽略。
     * 返回带 children / length / label / name 的树。
     */
    function parseNewick(text) {
      const src = String(text || '').replace(/\[[^\]]*\]/g, '')
      let i = 0
      const skip = () => { while (i < src.length && /\s/.test(src[i])) i += 1 }
      const readLabel = () => {
        skip()
        if (src[i] === "'" || src[i] === '"') {
          const q = src[i]
          i += 1
          let out = ''
          while (i < src.length && src[i] !== q) {
            if (src[i] === q && src[i + 1] === q) { out += q; i += 2; continue }
            out += src[i]
            i += 1
          }
          i += 1
          return out
        }
        let out = ''
        while (i < src.length && !/[,():;]/.test(src[i])) { out += src[i]; i += 1 }
        return out.trim()
      }
      const readLength = () => {
        skip()
        if (src[i] !== ':') return null
        i += 1
        let out = ''
        while (i < src.length && /[0-9eE+\-.]/.test(src[i])) { out += src[i]; i += 1 }
        const v = Number(out)
        return Number.isFinite(v) ? v : null
      }
      const parseNode = () => {
        skip()
        const node = { children: [], label: '', length: null }
        if (src[i] === '(') {
          i += 1
          for (;;) {
            node.children.push(parseNode())
            skip()
            if (src[i] === ',') { i += 1; continue }
            if (src[i] === ')') { i += 1; break }
            break
          }
          node.label = readLabel()
        } else {
          node.label = readLabel()
        }
        node.length = readLength()
        return node
      }
      const root = parseNode()
      if (!root || root.children.length === 0) throw new Error('Newick 解析失败：没读到树结构')
      return root
    }

    /** 叶子列表 + 每个节点的深度（按分支长度；没有长度时按层数）。 */
    function layoutTree(root) {
      const leaves = []
      const hasLengths = (() => {
        let seen = false
        const walk = (n, d) => {
          if (n.length !== null && n.length > 0) seen = true
          for (const c of n.children) walk(c, d + 1)
        }
        walk(root, 0)
        return seen
      })()
      const walk = (node, depth, acc) => {
        node.depth = acc
        if (node.children.length === 0) {
          node.y = leaves.length
          leaves.push(node)
          return acc + (hasLengths ? (node.length || 0) : 1)
        }
        let best = -Infinity
        for (const c of node.children) {
          const d = walk(c, depth + 1, acc + (hasLengths ? (node.length || 0) : 1))
          if (d > best) best = d
        }
        node.y = (node.children[0].y + node.children[node.children.length - 1].y) / 2
        node.depth = best
        return best
      }
      walk(root, 0, 0)
      // node.depth 在叶子那里是「到该叶子的累计长度」，统一改成「自身 x 坐标」
      const assignX = (node, acc) => {
        node.x = acc
        for (const c of node.children) assignX(c, acc + (hasLengths ? (c.length || 0) : 1))
      }
      assignX(root, 0)
      let maxX = 0
      const scan = (n) => { if (n.x > maxX) maxX = n.x; for (const c of n.children) scan(c) }
      scan(root)
      return { leaves, maxX, hasLengths }
    }

    /** 矩形进化树：叶子在右，分支长度换成横向距离。 */
    function drawPhylo(g, panel, box) {
      panelBackground(g, box)
      let root
      try {
        root = parseNewick(panel.newick)
      } catch (e) {
        g.fillStyle = THEME.textDim
        g.font = '12px ui-sans-serif, system-ui, sans-serif'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(`进化树解析失败：${e.message}`, box.x + box.w / 2, box.y + box.h / 2)
        return
      }
      const { leaves, maxX } = layoutTree(root)
      const n = leaves.length
      if (n === 0) return

      // 分组配色：groups: [{ name, color, labels: [...] }]，按叶子名匹配（支持前缀 * 结尾）
      const groups = panel.groups || []
      const colorOf = (label) => {
        for (const grp of groups) {
          for (const pat of grp.labels || []) {
            if (pat.endsWith('*') ? label.startsWith(pat.slice(0, -1)) : label === pat) {
              return grp.color || THEME.accent
            }
          }
        }
        return null
      }

      // 标签宽度：留给叶子名，剩下的给树
      const labels = leaves.map((lf) => lf.label || '')
      const fontPx = n > 60 ? 9 : n > 30 ? 10 : 11
      let labelW = 0
      for (const s of labels) labelW = Math.max(labelW, s.length * fontPx * 0.62)
      labelW = Math.min(labelW, box.w * 0.42)
      const treeW = Math.max(40, box.w - labelW - 12)
      const rowH = box.h / Math.max(n, 1)
      const yOf = (leafIndex) => box.y + rowH * (leafIndex + 0.5)
      const xOf = (x) => box.x + (maxX > 0 ? (x / maxX) * treeW : 0)

      g.lineWidth = 1.4
      g.lineCap = 'round'
      const drawBranch = (node, parentX) => {
        const x = xOf(node.x)
        if (node.children.length === 0) {
          g.strokeStyle = colorOf(node.label) || THEME.axis
          g.beginPath()
          g.moveTo(parentX, yOf(node.y))
          g.lineTo(x, yOf(node.y))
          g.stroke()
        } else {
          const y0 = yOf(node.children[0].y)
          const y1 = yOf(node.children[node.children.length - 1].y)
          g.strokeStyle = THEME.axis
          g.beginPath()
          if (parentX < x) { g.moveTo(parentX, yOf(node.y)); g.lineTo(x, yOf(node.y)) }
          g.moveTo(x, y0)
          g.lineTo(x, y1)
          g.stroke()
          for (const c of node.children) {
            g.strokeStyle = c.children.length === 0 ? (colorOf(c.label) || THEME.axis) : THEME.axis
            g.beginPath()
            g.moveTo(x, yOf(c.y))
            g.lineTo(xOf(c.x), yOf(c.y))
            g.stroke()
            drawBranch(c, xOf(c.x))
          }
        }
      }
      g.strokeStyle = THEME.axis
      drawBranch(root, box.x)

      // 叶子标签：太多时只画有分组色的（其余用刻度线代替），否则会糊成一片
      g.font = `${fontPx}px ui-sans-serif, system-ui, "PingFang SC", sans-serif`
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      const labelX = box.x + treeW + 6
      const step = Math.ceil(n / Math.max(1, Math.floor(box.h / (fontPx + 3))))
      leaves.forEach((lf, i) => {
        const c = colorOf(lf.label)
        if (i % step === 0 || c) {
          g.fillStyle = c || THEME.textDim
          let s = lf.label
          const maxChars = Math.floor(labelW / (fontPx * 0.62))
          if (s.length > maxChars) s = `${s.slice(0, Math.max(1, maxChars - 1))}…`
          g.fillText(s, labelX, yOf(i))
        }
      })

      // bootstrap：只在节点数不多时标，否则数字会压满整棵树
      if (panel.showSupport !== false && n <= 30) {
        g.font = `${fontPx - 1}px ui-sans-serif, system-ui, sans-serif`
        g.fillStyle = THEME.textDim
        g.textAlign = 'center'
        g.textBaseline = 'bottom'
        const mark = (node) => {
          const lab = String(node.label || '')
          if (node.children.length > 0 && /^[0-9.]+$/.test(lab)) {
            g.fillText(lab, xOf(node.x), yOf(node.y) - 2)
          }
          for (const c of node.children) mark(c)
        }
        mark(root)
      }

      // 比例尺（有分支长度时才有意义）
      if (panel.scaleBar !== false && maxX > 0) {
        const barLen = maxX / 5
        const x0 = box.x + 4
        const y0 = box.y + box.h - 4
        g.strokeStyle = THEME.textDim
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(x0, y0)
        g.lineTo(x0 + (barLen / maxX) * treeW, y0)
        g.stroke()
        g.fillStyle = THEME.textDim
        g.font = '10px ui-sans-serif, system-ui, sans-serif'
        g.textAlign = 'left'
        g.textBaseline = 'bottom'
        g.fillText(fmt(barLen, 3), x0 + (barLen / maxX) * treeW + 4, y0)
      }
    }

    // ---- 2. 序列比对 -------------------------------------------------------

    /** 每列的保守度：最常见残基（不含 gap）占非 gap 的比例。 */
    function columnConservation(seqs, j) {
      const counts = new Map()
      let total = 0
      for (const s of seqs) {
        const ch = (s[j] || '-').toUpperCase()
        if (ch === '-' || ch === '.') continue
        counts.set(ch, (counts.get(ch) || 0) + 1)
        total += 1
      }
      if (total === 0) return { frac: 0, top: '-' }
      let best = 0
      let top = '-'
      for (const [ch, c] of counts) if (c > best) { best = c; top = ch }
      return { frac: best / total, top }
    }

    /** 多序列比对：上面一条保守度轨道，下面每行残基按性质着色。 */
    function drawMsa(g, panel, box) {
      panelBackground(g, box)
      const seqs = (panel.sequences || []).map((s) => String(s.seq || '').toUpperCase())
      if (seqs.length === 0) return
      const width = Math.max(...seqs.map((s) => s.length))
      if (width === 0) return
      const names = (panel.sequences || []).map((s, i) => s.name || `seq${i + 1}`)

      const showCons = panel.showConservation !== false
      const consH = showCons ? Math.max(18, Math.min(30, box.h * 0.12)) : 0
      const nameFont = seqs.length > 24 ? 9 : 10.5
      let nameW = 0
      for (const s of names) nameW = Math.max(nameW, Math.min(s.length, 14) * nameFont * 0.62)
      nameW = Math.min(Math.max(46, nameW + 6), box.w * 0.3)

      const gridX = box.x + nameW
      const gridW = box.w - nameW - 4
      const gridY = box.y + consH + 2
      const gridH = box.h - consH - 2
      const cellW = gridW / width
      const cellH = gridH / seqs.length
      const showLetters = cellW >= 5.2 && cellH >= 8

      // 保守度轨道
      if (showCons) {
        const cons = []
        for (let j = 0; j < width; j += 1) cons.push(columnConservation(seqs, j))
        g.fillStyle = 'rgba(255,255,255,0.05)'
        g.fillRect(gridX, box.y + 2, gridW, consH - 2)
        for (let j = 0; j < width; j += 1) {
          const { frac } = cons[j]
          if (frac <= 0) continue
          g.fillStyle = conservationColor(frac)
          const h = (consH - 4) * frac
          g.fillRect(gridX + j * cellW, box.y + consH - 2 - h, Math.max(1, cellW), h)
        }
        g.font = '9.5px ui-sans-serif, system-ui, sans-serif'
        g.fillStyle = THEME.textDim
        g.textAlign = 'left'
        g.textBaseline = 'top'
        g.fillText('保守度', box.x + 2, box.y + 3)
        g.strokeStyle = THEME.grid
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(gridX, box.y + consH)
        g.lineTo(gridX + gridW, box.y + consH)
        g.stroke()
      }

      // 残基网格
      for (let r = 0; r < seqs.length; r += 1) {
        const y = gridY + r * cellH
        g.fillStyle = r % 2 ? 'rgba(255,255,255,0.014)' : 'transparent'
        if (r % 2) g.fillRect(box.x, y, box.w, cellH)
        g.font = `${Math.max(8, Math.min(11, cellH - 2))}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
        g.fillStyle = THEME.textDim
        g.textAlign = 'right'
        g.textBaseline = 'middle'
        let nm = names[r]
        const maxChars = Math.floor((nameW - 6) / (nameFont * 0.62))
        if (nm.length > maxChars) nm = `${nm.slice(0, Math.max(1, maxChars - 1))}…`
        g.fillText(nm, box.x + nameW - 6, y + cellH / 2)

        g.textAlign = 'center'
        for (let j = 0; j < seqs[r].length; j += 1) {
          const ch = seqs[r][j]
          const x = gridX + j * cellW
          if (ch === '-' || ch === '.') {
            if (cellW >= 3) {
              g.fillStyle = 'rgba(255,255,255,0.06)'
              g.fillRect(x, y + 1, Math.max(1, cellW - 0.6), cellH - 2)
            }
            continue
          }
          g.fillStyle = (panel.colorBy === 'conservation'
            ? conservationColor(columnConservation(seqs, j).frac)
            : aaColor(ch))
          g.fillRect(x, y + 1, Math.max(1, cellW - 0.6), cellH - 2)
          if (showLetters) {
            g.fillStyle = '#0f1318'
            g.fillText(ch, x + cellW / 2, y + cellH / 2 + 0.5)
          }
        }
      }

      // 坐标：每 10 列标一次（按列宽决定间隔，避免标签叠在一起）
      const stride = [10, 20, 50, 100, 200].find((s) => (gridW / width) * s > 44) || 500
      g.font = '9.5px ui-sans-serif, system-ui, sans-serif'
      g.fillStyle = THEME.textDim
      g.textAlign = 'center'
      g.textBaseline = 'top'
      for (let j = stride; j <= width; j += stride) {
        g.fillText(String(j), gridX + (j - 0.5) * cellW, box.y + box.h - 11)
      }
    }

    // ---- 3. GO / KEGG 富集气泡图 -------------------------------------------

    /** -log10(p) → 颜色（暖 = 更显著）。 */
    function enrichColor(logp, maxLogp) {
      const t = maxLogp > 0 ? Math.max(0, Math.min(1, logp / maxLogp)) : 0
      const r = Math.round(76 + t * (229 - 76))
      const gg = Math.round(154 + t * (107 - 154))
      const b = Math.round(255 + t * (111 - 255))
      return `rgb(${r},${gg},${b})`
    }

    /** 富集气泡图：y = 通路（按显著性排序），x = 基因比例或基因数，气泡大小 = 基因数，颜色 = -log10(p)。 */
    function drawEnrich(g, panel, box) {
      panelBackground(g, box)
      const rows = (panel.terms || [])
        .filter((t) => t && t.term && isFinite(t.p) && t.p > 0)
        .map((t) => ({
          term: String(t.term),
          count: Number(t.count) || 1,
          ratio: isFinite(t.ratio) ? Number(t.ratio) : null,
          p: Number(t.p),
          category: t.category || '',
        }))
      if (rows.length === 0) return
      rows.sort((a, b) => a.p - b.p)
      const top = Math.min(rows.length, Math.max(3, panel.top || 20))
      const list = rows.slice(0, top).reverse() // 画的时候从上到下，所以反过来

      const maxLogp = Math.max(...list.map((r) => -Math.log10(r.p)))
      const useRatio = list.every((r) => r.ratio !== null)
      const xVals = list.map((r) => (useRatio ? r.ratio : r.count))
      const xMin = Math.min(...xVals)
      const xMax = Math.max(...xVals)
      const xLo = useRatio ? Math.max(0, xMin - (xMax - xMin) * 0.15) : 0
      const xHi = xMax + (xMax - xMin) * 0.15 || xMax + 1
      const counts = list.map((r) => r.count)
      const cMin = Math.min(...counts)
      const cMax = Math.max(...counts)
      const sizeOf = (c) => 4 + (cMax === cMin ? 0.5 : (c - cMin) / (cMax - cMin)) * 9

      // 分类配色（给了 category 就按分类描边，否则统一）
      const cats = [...new Set(list.map((r) => r.category).filter(Boolean))]
      const catColor = (c) => {
        const i = cats.indexOf(c)
        return ['#4c9aff', '#2fbf9b', '#f2a33c', '#c77dff', '#e56b6f'][i % 5]
      }

      const labelW = Math.min(box.w * 0.46, Math.max(...list.map((r) => r.term.length)) * 8.2 + 10)
      const plot = { x: box.x + labelW, y: box.y + 4, w: box.w - labelW - 8, h: box.h - 26 }
      const rowH = plot.h / list.length
      const sx = (v) => plot.x + ((v - xLo) / (xHi - xLo || 1)) * plot.w

      // x 轴网格
      g.font = '10px ui-sans-serif, system-ui, sans-serif'
      for (const t of niceTicks(xLo, xHi, Math.max(3, Math.floor(plot.w / 80)))) {
        const x = sx(t)
        g.strokeStyle = THEME.grid
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(x, plot.y)
        g.lineTo(x, plot.y + plot.h)
        g.stroke()
        g.fillStyle = THEME.textDim
        g.textAlign = 'center'
        g.textBaseline = 'top'
        g.fillText(fmt(t, 2), x, plot.y + plot.h + 4)
      }

      list.forEach((r, i) => {
        const y = plot.y + rowH * (i + 0.5)
        const x = sx(useRatio ? r.ratio : r.count)
        const rad = sizeOf(r.count)
        g.fillStyle = enrichColor(-Math.log10(r.p), maxLogp)
        g.globalAlpha = 0.85
        g.beginPath()
        g.arc(x, y, rad, 0, Math.PI * 2)
        g.fill()
        g.globalAlpha = 1
        if (r.category && cats.length > 1) {
          g.strokeStyle = catColor(r.category)
          g.lineWidth = 1.5
          g.stroke()
        }
        // 通路名（右对齐贴住绘图区左侧）
        g.fillStyle = THEME.text
        g.font = '10.5px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
        g.textAlign = 'right'
        g.textBaseline = 'middle'
        let nm = r.term
        const maxChars = Math.floor((labelW - 12) / 6.6)
        if (nm.length > maxChars) nm = `${nm.slice(0, Math.max(1, maxChars - 1))}…`
        g.fillText(nm, plot.x - 8, y)
        // 气泡右侧标基因数
        g.fillStyle = THEME.textDim
        g.font = '9.5px ui-sans-serif, system-ui, sans-serif'
        g.textAlign = 'left'
        g.fillText(String(r.count), x + rad + 3, y)
      })

      g.fillStyle = THEME.textDim
      g.font = '10px ui-sans-serif, system-ui, sans-serif'
      g.textAlign = 'right'
      g.textBaseline = 'bottom'
      g.fillText(useRatio ? '基因比例' : '基因数', box.x + box.w - 4, box.y + box.h)
      // 颜色图例
      const lw = 60
      const lx = box.x + 4
      const ly = box.y + box.h - 8
      for (let i = 0; i < lw; i += 1) {
        g.fillStyle = enrichColor((i / lw) * maxLogp, maxLogp)
        g.fillRect(lx + i, ly - 5, 1.2, 5)
      }
      g.fillStyle = THEME.textDim
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      g.font = '9.5px ui-sans-serif, system-ui, sans-serif'
      g.fillText(`-log10(p)  0 → ${fmt(maxLogp, 1)}（气泡大小 = 基因数 ${cMin}–${cMax}）`, lx + lw + 6, ly - 3)
      // 分类图例：只有一类时不必画，多类时描边颜色得说清楚是什么
      if (cats.length > 1) {
        let cx2 = lx + lw + 6
        const cy2 = ly - 14
        g.textBaseline = 'middle'
        for (const c of cats) {
          g.strokeStyle = catColor(c)
          g.lineWidth = 1.5
          g.beginPath()
          g.arc(cx2 + 4, cy2, 4, 0, Math.PI * 2)
          g.stroke()
          g.fillStyle = THEME.textDim
          g.fillText(c, cx2 + 11, cy2)
          cx2 += 18 + String(c).length * 6.4
        }
      }
    }

    // ---- 4. 全基因组变异分布 ------------------------------------------------

    /**
     * 线性基因组图：每条染色体一条横杠，变异按位置画成竖线/点，按类型着色。
     * 这是 VCF / 全基因组测序结果最直观的一张总览图。
     */
    function drawGenome(g, panel, box) {
      panelBackground(g, box)
      const chroms = (panel.chromosomes || []).filter((c) => c && c.name)
      if (chroms.length === 0) return
      const variants = (panel.variants || []).filter((v) => v && v.chrom)
      const types = [...new Set(variants.map((v) => v.type || 'SNP'))]
      const typeColor = (t) => {
        const map = { SNP: '#4c9aff', INDEL: '#f2a33c', CNV: '#c77dff', SV: '#c77dff' }
        if (map[String(t).toUpperCase()]) return map[String(t).toUpperCase()]
        return ['#4c9aff', '#f2a33c', '#c77dff', '#2fbf9b', '#e56b6f'][types.indexOf(t) % 5]
      }

      const nameW = Math.min(box.w * 0.18, Math.max(...chroms.map((c) => String(c.name).length)) * 7 + 10)
      const trackX = box.x + nameW
      const trackW = box.w - nameW - 8
      // 行距封顶并整体居中：4 条染色体摊在 700px 高里会显得又稀又空
      const rowH = Math.min(box.h / chroms.length, 60)
      const top = box.y + Math.max(0, (box.h - rowH * chroms.length) / 2)
      const barH = Math.max(6, Math.min(16, rowH * 0.34))

      const maxLen = Math.max(...chroms.map((c) => Number(c.length) || 0))
      // 最小可见宽度：4.41 Mb 的染色体旁边放 4 kb 的质粒时，按真实比例质粒不足 1px，
      // 画出来就是「什么都没有」。给个下限，长度差异靠右侧的长度标注说明。
      const barWidth = (len) => Math.max(4, maxLen > 0 ? (len / maxLen) * trackW : trackW)

      chroms.forEach((c, i) => {
        const y = top + rowH * (i + 0.5)
        const len = Number(c.length) || maxLen
        const w = barWidth(len)
        g.fillStyle = i % 2 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.10)'
        g.fillRect(trackX, y - barH / 2, w, barH)
        g.strokeStyle = THEME.border
        g.lineWidth = 1
        g.strokeRect(trackX + 0.5, y - barH / 2 + 0.5, Math.max(1, w - 1), barH - 1)
        g.fillStyle = THEME.textDim
        g.font = '10.5px ui-sans-serif, system-ui, sans-serif'
        g.textAlign = 'right'
        g.textBaseline = 'middle'
        g.fillText(String(c.name), trackX - 7, y)
        // 长度标尺：Mb / kb 自适应
        g.textAlign = 'left'
        g.font = '9px ui-sans-serif, system-ui, sans-serif'
        g.fillStyle = 'rgba(143,163,184,0.75)'
        const unit = len >= 1e6 ? `${fmt(len / 1e6, 1)} Mb` : `${fmt(len / 1e3, 0)} kb`
        g.fillText(unit, trackX + w + 6, y)
      })

      // 变异：画在染色体条上方（外显子/SNP）和下方（结构变异），避免互相压住
      const byChrom = new Map()
      for (const v of variants) {
        if (!byChrom.has(String(v.chrom))) byChrom.set(String(v.chrom), [])
        byChrom.get(String(v.chrom)).push(v)
      }
      const yOfChrom = new Map(chroms.map((c, i) => [String(c.name), top + rowH * (i + 0.5)]))
      /**
       * 密度分箱的阈值。
       *
       * 真实 WGS 是百万级变异：逐点画刻度会糊成一条实线，等于没画。超过这个数就换成
       * 「密度轨道」—— 沿染色体分箱，柱高 ∝ 该箱内变异数的平方根（平方根是为了让
       * 少量变异的区域也看得见，纯线性的话一个热点会把其余全压平）。
       */
      const DENSITY_AT = 600
      for (const [chrom, list] of byChrom) {
        const y0 = yOfChrom.get(chrom)
        if (y0 === undefined) continue
        const len = Number(chroms.find((c) => String(c.name) === chrom).length) || maxLen
        const chromW = barWidth(len)
        if (list.length > DENSITY_AT) {
          // —— 密度模式 ——
          const binPx = 2
          const bins = Math.max(8, Math.floor(chromW / binPx))
          const counts = new Float64Array(bins)
          for (const v of list) {
            const f = Math.max(0, Math.min(0.999999, (Number(v.pos) || 0) / (len || 1)))
            counts[Math.floor(f * bins)] += 1
          }
          let peak = 0
          for (const c of counts) if (c > peak) peak = c
          const maxBar = Math.max(10, barH * 3.2)
          g.fillStyle = typeColor('SNP')
          g.globalAlpha = 0.85
          const bw = Math.max(1, chromW / bins)
          for (let i = 0; i < bins; i += 1) {
            if (counts[i] === 0) continue
            const h = (Math.sqrt(counts[i]) / Math.sqrt(peak || 1)) * maxBar
            g.fillRect(trackX + i * bw, y0 - barH / 2 - 2 - h, Math.ceil(bw), h)
          }
          g.globalAlpha = 1
          g.fillStyle = THEME.textDim
          g.font = '9px ui-sans-serif, system-ui, sans-serif'
          g.textAlign = 'left'
          g.textBaseline = 'bottom'
          g.fillText(`${list.length} 个变异 · 密度分箱（峰值 ${fmt(peak, 0)}/箱）`,
            trackX + 2, y0 - barH / 2 - 4 - maxBar)
          continue
        }
        // 标签错层：相邻变异靠得太近时上一行标签会叠在一起
        const placed = []
        for (const v of [...list].sort((a, b) => (a.pos || 0) - (b.pos || 0))) {
          const x = trackX + (Math.max(0, Number(v.pos) || 0) / (len || 1)) * chromW
          const t = String(v.type || 'SNP').toUpperCase()
          const up = t === 'SNP' || t === 'INDEL'
          g.strokeStyle = typeColor(v.type)
          g.lineWidth = 1.6
          g.globalAlpha = list.length > 400 ? 0.55 : 0.95
          g.beginPath()
          g.moveTo(x, y0 + (up ? -barH / 2 - 1 : barH / 2 + 1))
          g.lineTo(x, y0 + (up ? -barH / 2 - 7 : barH / 2 + 7))
          g.stroke()
          g.globalAlpha = 1
          if (v.label && list.length <= 40) {
            // 找一个没被占用的层（最多 3 层）
            let lane = 0
            while (lane < 3 && placed.some((p) => p.lane === lane && Math.abs(p.x - x) < 70)) lane += 1
            if (lane < 3) placed.push({ x, lane })
            g.fillStyle = THEME.textDim
            g.font = '8.5px ui-sans-serif, system-ui, sans-serif'
            g.textAlign = 'center'
            g.textBaseline = up ? 'bottom' : 'top'
            g.fillText(String(v.label), x, y0 + (up ? -barH / 2 - 9 - lane * 10 : barH / 2 + 9 + lane * 10))
          }
        }
      }

      // 图例
      g.font = '10px ui-sans-serif, system-ui, sans-serif'
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      let lx = box.x + 4
      const ly = box.y + box.h - 6
      for (const t of types) {
        g.fillStyle = typeColor(t)
        g.fillRect(lx, ly - 3, 8, 6)
        g.fillStyle = THEME.textDim
        g.fillText(String(t), lx + 11, ly)
        lx += 16 + String(t).length * 6.4
      }
      g.fillStyle = THEME.textDim
      g.fillText(`变异 ${variants.length} 个 · 染色体 ${chroms.length} 条`, lx + 6, ly)
    }

    // ---- 5. 覆盖度轨道 ------------------------------------------------------

    /** 测序深度轨道：每条样本一条填充曲线，可选基因模型。pysam / deeptools 的典型输出。 */
    function drawCoverage(g, panel, box) {
      panelBackground(g, box)
      const tracks = (panel.tracks || []).filter((t) => t && t.points && t.points.length)
      if (tracks.length === 0) return
      const genes = panel.genes || []
      const geneH = genes.length ? Math.min(34, box.h * 0.22) : 0
      const plotH = box.h - geneH - 16
      const rowH = plotH / tracks.length
      let xMin = Infinity
      let xMax = -Infinity
      let yMax = 0
      for (const t of tracks) {
        for (const p of t.points) {
          if (p[0] < xMin) xMin = p[0]
          if (p[0] > xMax) xMax = p[0]
          if (p[1] > yMax) yMax = p[1]
        }
      }
      for (const gs of genes) {
        if (gs.start < xMin) xMin = gs.start
        if (gs.end > xMax) xMax = gs.end
      }
      if (!isFinite(xMin) || xMax <= xMin) return
      const axisW = 46
      const x0 = box.x + axisW
      const w = box.w - axisW - 6
      const sx = (v) => x0 + ((v - xMin) / (xMax - xMin)) * w
      const unit = xMax >= 1e6 ? (v) => `${fmt(v / 1e6, 1)}M` : xMax >= 1e3 ? (v) => `${fmt(v / 1e3, 0)}k` : (v) => fmt(v, 0)

      tracks.forEach((t, i) => {
        const top = box.y + 4 + i * rowH
        const h = rowH - 14
        // 每条轨道用自己的峰值当刻度 —— 共用全局最大值会让人误以为三条深度一样
        let tPeak = 0
        for (const p of t.points) if (p[1] > tPeak) tPeak = p[1]
        const sy = (v) => top + h - (v / (tPeak || 1)) * h
        g.strokeStyle = THEME.grid
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(x0, top + h)
        g.lineTo(x0 + w, top + h)
        g.stroke()
        const color = t.color || ['#4c9aff', '#2fbf9b', '#f2a33c', '#c77dff'][i % 4]
        g.fillStyle = color
        g.globalAlpha = 0.28
        g.beginPath()
        g.moveTo(sx(t.points[0][0]), top + h)
        for (const p of t.points) g.lineTo(sx(p[0]), sy(p[1]))
        g.lineTo(sx(t.points[t.points.length - 1][0]), top + h)
        g.closePath()
        g.fill()
        g.globalAlpha = 1
        g.strokeStyle = color
        g.lineWidth = 1.2
        g.beginPath()
        t.points.forEach((p, k) => (k ? g.lineTo(sx(p[0]), sy(p[1])) : g.moveTo(sx(p[0]), sy(p[1]))))
        g.stroke()
        g.fillStyle = THEME.textDim
        g.font = '10px ui-sans-serif, system-ui, sans-serif'
        g.textAlign = 'right'
        g.textBaseline = 'top'
        g.fillText(`${fmt(tPeak, 0)}×`, box.x + axisW - 6, top + 1)
        g.textAlign = 'left'
        g.fillStyle = color
        g.fillText(String(t.name || `track ${i + 1}`), x0 + 4, top + 1)
      })

      // 基因模型
      if (genes.length) {
        const gy = box.y + 4 + tracks.length * rowH + geneH * 0.45
        for (const gs of genes) {
          const gx0 = sx(gs.start)
          const gx1 = sx(gs.end)
          g.fillStyle = 'rgba(76,154,255,0.55)'
          g.fillRect(gx0, gy - 3.5, Math.max(2, gx1 - gx0), 7)
          g.fillStyle = THEME.textDim
          g.font = '9.5px ui-sans-serif, system-ui, sans-serif'
          g.textAlign = 'center'
          g.textBaseline = 'bottom'
          g.fillText(String(gs.name || ''), (gx0 + gx1) / 2, gy - 5)
        }
      }

      // 位置轴
      g.font = '10px ui-sans-serif, system-ui, sans-serif'
      for (const t of niceTicks(xMin, xMax, Math.max(3, Math.floor(w / 90)))) {
        const x = sx(t)
        g.strokeStyle = THEME.grid
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(x, box.y + 2)
        g.lineTo(x, box.y + box.h - 12)
        g.stroke()
        g.fillStyle = THEME.textDim
        g.textAlign = 'center'
        g.textBaseline = 'top'
        g.fillText(unit(t), x, box.y + box.h - 11)
      }
    }

    // ---- 6. 火山图（差异表达） ---------------------------------------------

    /** 火山图：x = log2FC，y = -log10(p)，按显著性与方向着色。 */
    function drawVolcano(g, panel, box) {
      panelBackground(g, box)
      const pts = (panel.points || []).filter((p) => isFinite(p[0]) && isFinite(p[1]))
      if (pts.length === 0) return
      const lfcCut = panel.lfcCutoff === undefined ? 1 : panel.lfcCutoff
      const pCut = panel.pCutoff === undefined ? 0.05 : panel.pCutoff
      const logPCut = -Math.log10(pCut)
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const xLim = Math.max(Math.abs(Math.min(...xs)), Math.abs(Math.max(...xs))) * 1.08 || 1
      const yMax = Math.max(...ys) * 1.08 || 1
      const pad = { l: 48, r: 10, t: 8, b: 34 }
      const plot = {
        x: box.x + pad.l, y: box.y + pad.t,
        w: box.w - pad.l - pad.r, h: box.h - pad.t - pad.b,
      }
      const sx = (v) => plot.x + ((v + xLim) / (2 * xLim)) * plot.w
      const sy = (v) => plot.y + plot.h - (v / yMax) * plot.h

      // 阈值线
      g.strokeStyle = 'rgba(255,255,255,0.22)'
      g.lineWidth = 1
      g.setLineDash([4, 4])
      for (const x of [-lfcCut, lfcCut]) {
        g.beginPath()
        g.moveTo(sx(x), plot.y)
        g.lineTo(sx(x), plot.y + plot.h)
        g.stroke()
      }
      g.beginPath()
      g.moveTo(plot.x, sy(logPCut))
      g.lineTo(plot.x + plot.w, sy(logPCut))
      g.stroke()
      g.setLineDash([])

      // 网格与坐标
      g.font = '10px ui-sans-serif, system-ui, sans-serif'
      for (const t of niceTicks(-xLim, xLim, 5)) {
        g.fillStyle = THEME.textDim
        g.textAlign = 'center'
        g.textBaseline = 'top'
        g.fillText(fmt(t, 1), sx(t), plot.y + plot.h + 4)
      }
      for (const t of niceTicks(0, yMax, 4)) {
        g.fillStyle = THEME.textDim
        g.textAlign = 'right'
        g.textBaseline = 'middle'
        g.fillText(fmt(t, 1), plot.x - 6, sy(t))
      }
      g.fillStyle = THEME.textDim
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      g.fillText(panel.xLabel || 'log2 倍数变化', plot.x + plot.w / 2, box.y + box.h)
      g.save()
      g.translate(box.x + 11, plot.y + plot.h / 2)
      g.rotate(-Math.PI / 2)
      g.textAlign = 'center'
      g.textBaseline = 'top'
      g.fillText(panel.yLabel || '-log10(p)', 0, 0)
      g.restore()

      // 点：不显著的先画，显著的压在上面
      const cls = (p) => {
        if (p[1] < logPCut) return 0
        if (p[0] >= lfcCut) return 1
        if (p[0] <= -lfcCut) return 2
        return 0
      }
      const colors = ['rgba(143,163,184,0.5)', '#e56b6f', '#4c9aff']
      for (const want of [0, 1, 2]) {
        g.fillStyle = colors[want]
        for (const p of pts) {
          if (cls(p) !== want) continue
          g.beginPath()
          g.arc(sx(p[0]), sy(p[1]), want === 0 ? 2 : 2.6, 0, Math.PI * 2)
          g.fill()
        }
      }
      // 标注最显著的几个
      if (panel.labels) {
        g.font = '9.5px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
        g.fillStyle = THEME.text
        g.textAlign = 'left'
        g.textBaseline = 'middle'
        for (const l of panel.labels) {
          if (!isFinite(l.x) || !isFinite(l.y)) continue
          g.fillText(String(l.name || ''), sx(l.x) + 5, sy(l.y))
        }
      }
    }

    // ---- 7. 热图（表达矩阵 / 相关性矩阵）-----------------------------------

    /** 色阶控制点：[位置, r, g, b]。生信里最常用的几套。 */
    const PALETTES = {
      redblue: [[0, 49, 92, 178], [0.5, 245, 245, 245], [1, 214, 47, 39]],
      redyellowgreen: [[0, 60, 130, 190], [0.5, 245, 222, 90], [1, 214, 47, 39]],
      viridis: [[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]],
      grays: [[0, 18, 22, 28], [1, 240, 244, 248]],
    }

    /** 取色：t∈[0,1] → css 颜色（控制点之间线性插值）。 */
    function paletteColor(name, t) {
      const stops = PALETTES[name] || PALETTES.redblue
      const x = Math.max(0, Math.min(1, t))
      for (let i = 1; i < stops.length; i += 1) {
        if (x <= stops[i][0] || i === stops.length - 1) {
          const [p0, r0, g0, b0] = stops[i - 1]
          const [p1, r1, g1, b1] = stops[i]
          const k = p1 === p0 ? 0 : (x - p0) / (p1 - p0)
          const mix = (a, b) => Math.round(a + (b - a) * k)
          return `rgb(${mix(r0, r1)},${mix(g0, g1)},${mix(b0, b1)})`
        }
      }
      return '#888'
    }

    /**
     * 矩阵热图。
     *
     * 行/列的聚类顺序与树由**宿主**算好（`rowOrder` / `colOrder` / `rowTree` / `colTree`），
     * 这里只管画 —— 和基因组学其他面板一个原则：渲染器不做统计。
     *
     * 色阶默认把 0 放在正中（发散色）：热图绝大多数场景是 z-score 或 log2FC，
     * 「偏红=上调、偏蓝=下调」才有意义。给了 scale:'minmax' 才按最小最大铺满。
     */
    function drawHeatmap(g, panel, box) {
      panelBackground(g, box)
      const raw = panel.values
      if (!Array.isArray(raw) || raw.length === 0) return
      const nRows = raw.length
      const nCols = Math.max(...raw.map((r) => (Array.isArray(r) ? r.length : 0)))
      if (nCols === 0) return

      const rowIdx = Array.isArray(panel.rowOrder) && panel.rowOrder.length === nRows
        ? panel.rowOrder : Array.from({ length: nRows }, (_, i) => i)
      const colIdx = Array.isArray(panel.colOrder) && panel.colOrder.length === nCols
        ? panel.colOrder : Array.from({ length: nCols }, (_, i) => i)

      const rowLabels = panel.rowLabels || []
      const colLabels = panel.colLabels || []
      const showRowLab = rowLabels.length > 0 && nRows <= 200
      const showColLab = colLabels.length > 0 && nCols <= 80
      const showValues = panel.showValues === true

      const rowDenW = panel.rowTree ? Math.min(54, box.w * 0.10) : 0
      const colDenH = panel.colTree ? Math.min(56, box.h * 0.16) : 0
      let rowLabW = 0
      if (showRowLab) {
        let maxLen = 0
        for (const l of rowLabels) maxLen = Math.max(maxLen, String(l).length)
        rowLabW = Math.min(box.w * 0.28, maxLen * 6.2 + 8)
      }
      const colLabH = showColLab
        // 斜排标签的垂直占用 ≈ 文字长度 × 字号 × sin(56°)；只按字数给会裁掉下半截
        ? Math.min(box.h * 0.3, Math.max(...colLabels.map((l) => String(l).length)) * 6.0 + 18)
        : 0
      const barW = 13
      const barGap = 44

      const grid = {
        x: box.x + rowDenW + rowLabW,
        y: box.y + colDenH,
        w: Math.max(20, box.w - rowDenW - rowLabW - barW - barGap),
        h: Math.max(20, box.h - colDenH - colLabH),
      }
      if (grid.w < 12 || grid.h < 12) return

      let lo = Infinity
      let hi = -Infinity
      for (const row of raw) for (const v of row) {
        if (!isFinite(v)) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      if (!isFinite(lo)) return
      const centered = panel.scale !== 'minmax'
      const bound = centered ? (Math.max(Math.abs(lo), Math.abs(hi)) || 1) : 0
      if (!centered && hi === lo) hi = lo + 1
      const tOf = (v) => (!isFinite(v) ? null
        : centered ? (v + bound) / (2 * bound) : (v - lo) / (hi - lo))

      const cellW = grid.w / nCols
      const cellH = grid.h / nRows

      for (let r = 0; r < nRows; r += 1) {
        const src = raw[rowIdx[r]]
        if (!Array.isArray(src)) continue
        for (let c = 0; c < nCols; c += 1) {
          const v = src[colIdx[c]]
          const x = grid.x + c * cellW
          const y = grid.y + r * cellH
          const t = tOf(v)
          g.fillStyle = t === null ? '#12161b' : paletteColor(panel.palette || 'redblue', t)
          g.fillRect(x, y, Math.ceil(cellW), Math.ceil(cellH))
          if (showValues && cellW >= 24 && cellH >= 11) {
            g.fillStyle = Math.abs((t ?? 0) - 0.5) > 0.28 ? '#ffffff' : '#20262e'
            g.font = '9.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
            g.textAlign = 'center'
            g.textBaseline = 'middle'
            g.fillText(fmt(v, 1), x + cellW / 2, y + cellH / 2)
          }
        }
      }

      if (showRowLab) {
        g.fillStyle = THEME.textDim
        g.font = `${nRows > 60 ? 9 : 10.5}px ui-sans-serif, system-ui, "PingFang SC", sans-serif`
        g.textAlign = 'right'
        g.textBaseline = 'middle'
        const step = cellH < 7 ? Math.ceil(7 / cellH) : 1
        for (let r = 0; r < nRows; r += step) {
          const label = rowLabels[rowIdx[r]]
          if (label === undefined) continue
          let s = String(label)
          const maxChars = Math.floor((rowLabW - 6) / 6)
          if (s.length > maxChars) s = `${s.slice(0, Math.max(1, maxChars - 1))}…`
          g.fillText(s, grid.x - 4, grid.y + (r + 0.5) * cellH)
        }
      }
      if (showColLab) {
        g.fillStyle = THEME.textDim
        g.font = '9.5px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
        for (let c = 0; c < nCols; c += 1) {
          const label = colLabels[colIdx[c]]
          if (label === undefined) continue
          g.save()
          g.translate(grid.x + (c + 0.5) * cellW, grid.y + grid.h + 4)
          g.rotate(-Math.PI / 3.2)
          g.textAlign = 'right'
          g.textBaseline = 'middle'
          g.fillText(String(label), 0, 0)
          g.restore()
        }
      }

      if (panel.rowTree) {
        drawDendro(g, panel.rowTree, { x: box.x, y: grid.y, w: rowDenW, h: grid.h, dir: 'row' })
      }
      if (panel.colTree) {
        drawDendro(g, panel.colTree, { x: grid.x, y: box.y, w: grid.w, h: colDenH, dir: 'col' })
      }

      // 色阶条
      const bx = grid.x + grid.w + 11
      const steps = 48
      for (let i = 0; i < steps; i += 1) {
        g.fillStyle = paletteColor(panel.palette || 'redblue', 1 - i / (steps - 1))
        g.fillRect(bx, grid.y + (i / steps) * grid.h, barW, grid.h / steps + 1)
      }
      g.strokeStyle = THEME.border
      g.lineWidth = 1
      g.strokeRect(bx + 0.5, grid.y + 0.5, barW - 1, grid.h - 1)
      g.fillStyle = THEME.textDim
      g.font = '9.5px ui-sans-serif, system-ui, sans-serif'
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      const top = centered ? bound : hi
      const bottom = centered ? -bound : lo
      g.fillText(fmt(top, 2), bx + barW + 4, grid.y + 5)
      g.fillText(fmt((top + bottom) / 2, 2), bx + barW + 4, grid.y + grid.h / 2)
      g.fillText(fmt(bottom, 2), bx + barW + 4, grid.y + grid.h - 5)
      g.fillStyle = 'rgba(143,163,184,0.75)'
      g.textAlign = 'left'
      g.textBaseline = 'bottom'
      g.fillText(`${nRows} × ${nCols}`, box.x + 3, box.y + box.h - 2)
    }

    /**
     * 聚类树。树由宿主算好：{ height, children: [左, 右] }，叶子是 { leaf: 序号 }。
     * 叶子位置按**排序后**的下标给，这样树和热图的行列必然对齐。
     */
    function drawDendro(g, tree, area) {
      const leaves = []
      const collect = (nd) => {
        if (!nd) return
        if (!nd.children || nd.children.length === 0) {
          leaves.push(nd)
          return
        }
        for (const c of nd.children) collect(c)
      }
      collect(tree)
      const n = leaves.length
      if (n === 0) return
      let maxH = 0
      const scan = (x) => {
        if (!x) return
        if (isFinite(x.height) && x.height > maxH) maxH = x.height
        for (const c of x.children || []) scan(c)
      }
      scan(tree)
      if (!(maxH > 0)) maxH = 1

      const isRow = area.dir === 'row'
      const leafPos = (i) => (isRow
        ? area.y + ((i + 0.5) / n) * area.h
        : area.x + ((i + 0.5) / n) * area.w)
      // 根在起始边（行：左；列：上），叶子在靠热图那一侧
      const axisPos = (h) => (isRow
        ? area.x + area.w - (h / maxH) * area.w
        : area.y + area.h - (h / maxH) * area.h)
      const tip = isRow ? area.x + area.w : area.y + area.h

      g.strokeStyle = 'rgba(143,163,184,0.7)'
      g.lineWidth = 1
      let cursor = 0
      const walk = (node) => {
        if (!node) return null
        if (!node.children || node.children.length === 0) {
          const p = leafPos(cursor)
          cursor += 1
          return p
        }
        const childPos = node.children.map(walk).filter((p) => p !== null)
        if (childPos.length === 0) return null
        const a = axisPos(node.height || 0)
        g.beginPath()
        for (let i = 0; i < node.children.length; i += 1) {
          const child = node.children[i]
          const cp = childPos[i]
          const from = child && child.children && child.children.length > 0
            ? axisPos(child.height || 0)
            : tip
          if (isRow) { g.moveTo(from, cp); g.lineTo(a, cp) } else { g.moveTo(cp, from); g.lineTo(cp, a) }
        }
        const lo2 = Math.min(...childPos)
        const hi2 = Math.max(...childPos)
        if (isRow) { g.moveTo(a, lo2); g.lineTo(a, hi2) } else { g.moveTo(lo2, a); g.lineTo(hi2, a) }
        g.stroke()
        return (lo2 + hi2) / 2
      }
      walk(tree)
    }

    // ---- 8. 生存曲线（Kaplan-Meier）-----------------------------------------

    /**
     * KM 曲线。曲线的阶梯点、删失位置、中位生存期都由宿主算好（numeric.js 的 kaplanMeier，
     * 已与 scipy 对拍），这里只画。
     *
     * 删失必须画出来 —— 不标删失的生存曲线是最常见的误读来源：读者会以为曲线末端
     * 是「都活着」，其实那里可能只剩两三个人在随访。
     */
    function drawSurvival(g, panel, box) {
      panelBackground(g, box)
      const groups = (panel.groups || []).filter((x) => x && x.points && x.points.length)
      if (groups.length === 0) return
      const COLORS = ['#4c9aff', '#e56b6f', '#2fbf9b', '#f2a33c', '#c77dff', '#8fa3b8']

      let tMax = 0
      for (const grp of groups) for (const p of grp.points) if (p.t > tMax) tMax = p.t
      if (!(tMax > 0)) return
      const pad = { l: 52, r: 12, t: 10, b: 42 }
      const plot = {
        x: box.x + pad.l, y: box.y + pad.t,
        w: Math.max(30, box.w - pad.l - pad.r), h: Math.max(30, box.h - pad.t - pad.b),
      }
      const sx = (t) => plot.x + (t / tMax) * plot.w
      const sy = (s) => plot.y + plot.h - s * plot.h

      // 网格与坐标
      g.font = '10px ui-sans-serif, system-ui, sans-serif'
      for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
        const y = sy(tick)
        g.strokeStyle = THEME.grid
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(plot.x, y)
        g.lineTo(plot.x + plot.w, y)
        g.stroke()
        g.fillStyle = THEME.textDim
        g.textAlign = 'right'
        g.textBaseline = 'middle'
        g.fillText(tick.toFixed(2), plot.x - 6, y)
      }
      for (const t of niceTicks(0, tMax, Math.max(3, Math.floor(plot.w / 80)))) {
        const x = sx(t)
        g.strokeStyle = THEME.grid
        g.beginPath()
        g.moveTo(x, plot.y)
        g.lineTo(x, plot.y + plot.h)
        g.stroke()
        g.fillStyle = THEME.textDim
        g.textAlign = 'center'
        g.textBaseline = 'top'
        g.fillText(fmt(t, 0), x, plot.y + plot.h + 5)
      }
      g.fillStyle = THEME.textDim
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      g.fillText(panel.xLabel || '时间', plot.x + plot.w / 2, box.y + box.h)
      g.save()
      g.translate(box.x + 12, plot.y + plot.h / 2)
      g.rotate(-Math.PI / 2)
      g.textAlign = 'center'
      g.textBaseline = 'top'
      g.fillText(panel.yLabel || '生存率', 0, 0)
      g.restore()

      groups.forEach((grp, gi) => {
        const color = grp.color || COLORS[gi % COLORS.length]
        const pts = grp.points
        // 阶梯线
        g.strokeStyle = color
        g.lineWidth = 1.8
        g.beginPath()
        g.moveTo(sx(pts[0].t), sy(pts[0].s))
        for (let i = 1; i < pts.length; i += 1) {
          g.lineTo(sx(pts[i].t), sy(pts[i - 1].s))
          g.lineTo(sx(pts[i].t), sy(pts[i].s))
        }
        g.stroke()
        // 删失竖杠
        if (panel.showCensor !== false) {
          g.lineWidth = 1.2
          for (const c of grp.censorMarks || []) {
            const x = sx(c.t)
            const y = sy(c.s)
            g.beginPath()
            g.moveTo(x, y - 4)
            g.lineTo(x, y + 4)
            g.stroke()
          }
        }
        // 中位生存期：从 y=0.5 拉一条虚线下来
        if (grp.median !== null && grp.median !== undefined) {
          g.strokeStyle = color
          g.globalAlpha = 0.4
          g.lineWidth = 1
          g.setLineDash([3, 3])
          g.beginPath()
          g.moveTo(plot.x, sy(0.5))
          g.lineTo(sx(grp.median), sy(0.5))
          g.lineTo(sx(grp.median), plot.y + plot.h)
          g.stroke()
          g.setLineDash([])
          g.globalAlpha = 1
        }
      })

      // 图例放右上角：KM 曲线从左上往右下走，右上角是唯一稳定空着的地方
      g.font = '10.5px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
      g.textAlign = 'right'
      g.textBaseline = 'middle'
      const legendW = Math.max(...groups.map((grp) => String(grp.label).length)) * 10 + 150
      const rightX = plot.x + plot.w - 6
      let ly = plot.y + 10
      groups.forEach((grp, gi) => {
        const color = grp.color || COLORS[gi % COLORS.length]
        const med = grp.median === null || grp.median === undefined ? '—' : fmt(grp.median, 1)
        const text = `${grp.label}（n=${grp.n}，事件 ${grp.events}，中位 ${med}）`
        g.strokeStyle = color
        g.lineWidth = 2.2
        g.beginPath()
        g.moveTo(rightX - legendW, ly)
        g.lineTo(rightX - legendW + 18, ly)
        g.stroke()
        g.fillStyle = THEME.text
        g.fillText(text, rightX, ly)
        ly += 15
      })
      if (panel.logRank) {
        g.fillStyle = THEME.textDim
        g.font = '10px ui-sans-serif, system-ui, sans-serif'
        const txt = `log-rank χ² = ${fmt(panel.logRank.chi2, 3)}，df = ${panel.logRank.df}，`
          + (panel.logRank.p < 1e-4 ? 'p < 0.0001' : `p = ${fmt(panel.logRank.p, 4)}`)
        g.fillText(txt, rightX, ly + 2)
      }
    }

    // ---- 9. ROC 曲线 --------------------------------------------------------

    /** ROC 曲线：曲线、对角参考线、AUC、可选多组对比。 */
    function drawRoc(g, panel, box) {
      panelBackground(g, box)
      const curves = panel.curves || (panel.points ? [{ label: panel.label || 'ROC', points: panel.points, auc: panel.auc }] : [])
      const list = curves.filter((c) => c && c.points && c.points.length)
      if (list.length === 0) return
      const COLORS = ['#4c9aff', '#e56b6f', '#2fbf9b', '#f2a33c', '#c77dff']
      const pad = { l: 52, r: 12, t: 10, b: 42 }
      const plot = {
        x: box.x + pad.l, y: box.y + pad.t,
        w: Math.max(30, box.w - pad.l - pad.r), h: Math.max(30, box.h - pad.t - pad.b),
      }
      // 正方形绘图区（ROC 的横纵轴必须等长，否则曲线形状会骗人）
      const side = Math.min(plot.w, plot.h)
      const sq = { x: plot.x, y: plot.y + (plot.h - side), w: side, h: side }
      const sx = (v) => sq.x + v * sq.w
      const sy = (v) => sq.y + sq.h - v * sq.h

      g.font = '10px ui-sans-serif, system-ui, sans-serif'
      for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
        g.strokeStyle = THEME.grid
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(sq.x, sy(tick))
        g.lineTo(sq.x + sq.w, sy(tick))
        g.moveTo(sx(tick), sq.y)
        g.lineTo(sx(tick), sq.y + sq.h)
        g.stroke()
        g.fillStyle = THEME.textDim
        g.textAlign = 'right'
        g.textBaseline = 'middle'
        g.fillText(tick.toFixed(2), sq.x - 6, sy(tick))
        g.textAlign = 'center'
        g.textBaseline = 'top'
        g.fillText(tick.toFixed(2), sx(tick), sq.y + sq.h + 5)
      }
      // 对角参考线（无判别力）
      g.strokeStyle = 'rgba(255,255,255,0.22)'
      g.setLineDash([4, 4])
      g.beginPath()
      g.moveTo(sx(0), sy(0))
      g.lineTo(sx(1), sy(1))
      g.stroke()
      g.setLineDash([])

      g.fillStyle = THEME.textDim
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      g.fillText(panel.xLabel || '假阳性率 (1 − 特异度)', sq.x + sq.w / 2, box.y + box.h)
      g.save()
      g.translate(box.x + 12, sq.y + sq.h / 2)
      g.rotate(-Math.PI / 2)
      g.textAlign = 'center'
      g.textBaseline = 'top'
      g.fillText(panel.yLabel || '真阳性率 (灵敏度)', 0, 0)
      g.restore()

      list.forEach((c, i) => {
        const color = c.color || COLORS[i % COLORS.length]
        g.strokeStyle = color
        g.lineWidth = 2
        g.beginPath()
        g.moveTo(sx(0), sy(0))
        for (const p of c.points) g.lineTo(sx(p[0]), sy(p[1]))
        g.stroke()
      })

      // 图例
      g.font = '10.5px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      let ly = sq.y + sq.h - 14 * (list.length - 1) - 10
      list.forEach((c, i) => {
        const color = c.color || COLORS[i % COLORS.length]
        g.strokeStyle = color
        g.lineWidth = 2.2
        g.beginPath()
        g.moveTo(sq.x + 10, ly)
        g.lineTo(sq.x + 28, ly)
        g.stroke()
        g.fillStyle = THEME.text
        const auc = isFinite(c.auc) ? `AUC = ${fmt(c.auc, 3)}` : ''
        const extra = c.best ? `，最佳切点 TPR ${fmt(c.best.tpr, 2)} / FPR ${fmt(c.best.fpr, 2)}` : ''
        g.fillText(`${c.label || 'ROC'}（${auc}${extra}）`, sq.x + 33, ly)
        ly += 15
      })
    }

    // ---- 10. 网络图（互作 / 通路）--------------------------------------------

    /**
     * 网络图。节点坐标由**宿主**算好（力导向布局，确定性、无随机数），这里只画 ——
     * 和基因组学其他面板一个原则，也让「布局是否稳定」能在 Node 里断言。
     */
    function drawNetwork(g, panel, box) {
      panelBackground(g, box)
      const nodes = (panel.nodes || []).filter((nd) => nd && isFinite(nd.x) && isFinite(nd.y))
      if (nodes.length === 0) return
      const links = panel.links || panel.edges || []
      const pad = 26
      const xs = nodes.map((nd) => nd.x)
      const ys = nodes.map((nd) => nd.y)
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      const spanX = maxX - minX || 1
      const spanY = maxY - minY || 1
      const scale = Math.min((box.w - pad * 2) / spanX, (box.h - pad * 2) / spanY)
      const offX = box.x + (box.w - spanX * scale) / 2
      const offY = box.y + (box.h - spanY * scale) / 2
      const px = (v) => offX + (v - minX) * scale
      const py = (v) => offY + (v - minY) * scale
      const byId = new Map(nodes.map((nd) => [String(nd.id ?? nd.label), nd]))

      let maxW = 1
      for (const e of links) if (Number(e.weight) > maxW) maxW = Number(e.weight)
      g.lineWidth = 1
      for (const e of links) {
        const a = byId.get(String(e.source))
        const b = byId.get(String(e.target))
        if (!a || !b) continue
        const w = Number(e.weight) || 1
        g.strokeStyle = e.color || 'rgba(143,163,184,0.42)'
        g.lineWidth = 0.7 + (w / maxW) * 2.6
        g.beginPath()
        g.moveTo(px(a.x), py(a.y))
        g.lineTo(px(b.x), py(b.y))
        g.stroke()
      }
      g.lineWidth = 1

      const CAT = ['#4c9aff', '#e56b6f', '#2fbf9b', '#f2a33c', '#c77dff', '#7ad0f5', '#d4e157', '#b0bec5']
      const cats = [...new Set(nodes.map((nd) => String(nd.group ?? '')))]
      const catColor = (grp) => (grp ? CAT[Math.max(0, cats.indexOf(String(grp))) % CAT.length] : '#8fa3b8')
      let maxSize = 1
      for (const nd of nodes) if (Number(nd.size) > maxSize) maxSize = Number(nd.size)
      const rOf = (nd) => 4 + (Math.sqrt(Number(nd.size) || 1) / Math.sqrt(maxSize)) * 9

      const showLabels = nodes.length <= 80
      for (const nd of nodes) {
        const r = rOf(nd)
        g.fillStyle = nd.color || catColor(nd.group)
        g.globalAlpha = 0.92
        g.beginPath()
        g.arc(px(nd.x), py(nd.y), r, 0, Math.PI * 2)
        g.fill()
        g.globalAlpha = 1
        if (showLabels) {
          g.fillStyle = THEME.text
          g.font = `${nodes.length > 40 ? 8.5 : 10}px ui-sans-serif, system-ui, "PingFang SC", sans-serif`
          g.textAlign = 'center'
          g.textBaseline = 'top'
          g.fillText(String(nd.label ?? nd.id ?? ''), px(nd.x), py(nd.y) + r + 2)
        }
      }

      if (cats.length > 1 && cats.some((c) => c !== '')) {
        g.font = '10px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
        g.textAlign = 'left'
        g.textBaseline = 'middle'
        let ly = box.y + 12
        for (const c of cats) {
          if (c === '') continue
          g.fillStyle = catColor(c)
          g.beginPath()
          g.arc(box.x + 11, ly, 4.5, 0, Math.PI * 2)
          g.fill()
          g.fillStyle = THEME.textDim
          g.fillText(c, box.x + 20, ly)
          ly += 15
        }
      }
      g.fillStyle = 'rgba(143,163,184,0.75)'
      g.font = '9.5px ui-sans-serif, system-ui, sans-serif'
      g.textAlign = 'right'
      g.textBaseline = 'bottom'
      g.fillText(`${nodes.length} 节点 · ${links.length} 条边`, box.x + box.w - 3, box.y + box.h - 2)
    }

    // ---- 11. 序列 Logo -------------------------------------------------------

    /**
     * 序列 Logo。每列的字母频率与信息量（bits）由宿主算好，这里只按高度堆叠。
     *
     * 字母高度必须用 scale(1, k) 纵向拉伸 —— Canvas 没有「指定字形高度」这种参数，
     * 不拉伸的话短字母和长字母一样高，图就退化成没有信息量的堆叠。
     */
    function drawLogo(g, panel, box) {
      panelBackground(g, box)
      const cols = panel.columns || []
      if (cols.length === 0) return
      const pad = { l: 44, r: 10, t: 10, b: 40 }
      const plot = {
        x: box.x + pad.l, y: box.y + pad.t,
        w: Math.max(20, box.w - pad.l - pad.r), h: Math.max(20, box.h - pad.t - pad.b),
      }
      const maxBits = panel.maxBits || 2
      const colW = plot.w / cols.length
      const yOf = (bits) => plot.y + plot.h - (bits / maxBits) * plot.h

      for (const t of niceTicks(0, maxBits, 4)) {
        const y = yOf(t)
        g.strokeStyle = THEME.grid
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(plot.x, y)
        g.lineTo(plot.x + plot.w, y)
        g.stroke()
        g.fillStyle = THEME.textDim
        g.font = '10px ui-sans-serif, system-ui, sans-serif'
        g.textAlign = 'right'
        g.textBaseline = 'middle'
        g.fillText(fmt(t, 1), plot.x - 6, y)
      }
      g.fillStyle = THEME.textDim
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      g.fillText(panel.yLabel || '信息量 (bits)', plot.x + plot.w / 2, box.y + box.h)

      const NT_COLORS = { A: '#4c9aff', C: '#f2a33c', G: '#2fbf9b', T: '#e56b6f', U: '#e56b6f' }
      const AA_TINT = (ch) => {
        const c = String(ch).toUpperCase()
        if ('AVLIMFWY'.includes(c)) return '#f2a33c'
        if ('KRH'.includes(c)) return '#4c9aff'
        if ('DE'.includes(c)) return '#e56b6f'
        if ('STNQ'.includes(c)) return '#2fbf9b'
        if ('GP'.includes(c)) return '#c77dff'
        return '#8fa3b8'
      }
      const letterColor = (ch) => NT_COLORS[String(ch).toUpperCase()] || AA_TINT(ch)

      cols.forEach((col, i) => {
        const x = plot.x + i * colW
        const bits = isFinite(col.bits) ? col.bits : 0
        const letters = (col.letters || []).filter((l) => l[1] > 0)
        const total = letters.reduce((s, l) => s + l[1], 0) || 1
        let acc = 0
        const fontSize = Math.min(22, Math.max(7, colW * 0.92))
        for (const [ch, freq] of letters) {
          const hBits = (freq / total) * bits
          const y0 = yOf(acc)
          const y1 = yOf(acc + hBits)
          acc += hBits
          const h = y0 - y1
          if (h < 1.2) continue
          g.save()
          g.translate(x + colW / 2, y1)
          g.scale(1, h / fontSize)
          g.fillStyle = letterColor(ch)
          g.font = `bold ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
          g.textAlign = 'center'
          g.textBaseline = 'alphabetic'
          g.fillText(String(ch), 0, fontSize * 0.78)
          g.restore()
        }
      })

      g.fillStyle = THEME.textDim
      g.font = '9.5px ui-sans-serif, system-ui, sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'top'
      const step = Math.max(1, Math.ceil(cols.length / Math.max(2, Math.floor(plot.w / 46))))
      for (let i = 0; i < cols.length; i += step) {
        g.fillText(String(i + 1), plot.x + (i + 0.5) * colW, plot.y + plot.h + 5)
      }
      if (panel.subtitle) {
        g.textAlign = 'right'
        g.textBaseline = 'bottom'
        g.fillStyle = 'rgba(143,163,184,0.75)'
        g.fillText(panel.subtitle, box.x + box.w - 3, box.y + box.h - 2)
      }
    }

    // =====================================================================
    // 4. 三维结构：几何编译 + 投影 + 绘制
    // =====================================================================

    /** 高亮配色：位点红、N 端绿、C 端紫 —— 三类同屏时一眼分得开。 */
    const HIGHLIGHT_COLORS = { site: '#ff3b30', nterm: '#3ddc84', cterm: '#c77dff' }
    const highlightColor = (role) => HIGHLIGHT_COLORS[role] || HIGHLIGHT_COLORS.site

    /** 由 yaw/pitch 生成 3×3 旋转矩阵（行主序）。 */
    function rotationMatrix(yaw, pitch) {
      const cy = Math.cos(yaw)
      const sy = Math.sin(yaw)
      const cp = Math.cos(pitch)
      const sp = Math.sin(pitch)
      return [
        cy, 0, sy,
        sp * sy, cp, -sp * cy,
        -cp * sy, sp, cp * cy,
      ]
    }

    /**
     * 结构视图状态与几何缓存。
     * 坐标统一先减去原点（默认 bbox 中心，给了 focus 就用 focus）再旋转，
     * 避免大坐标导致的抖动，也让「把镜头对准某个位点」变成一次简单的平移。
     */
    function createStructureView(doc) {
      const dict = doc.dict
      const rows = doc.atoms.rows
      const chains = doc.chains
      const bboxCenter = doc.bbox.center
      const focus = doc.view && doc.view.focus
      const origin = focus && focus.length === 3 ? [focus[0], focus[1], focus[2]] : bboxCenter

      // 链 id → 索引（highlight 给的是链字母）
      const chainIdToIndex = new Map()
      chains.forEach((c, i) => chainIdToIndex.set(c.id, i))

      /**
       * 高亮分两类：
       *   · site —— 调用方指定的位点（突变、活性残基…），红色
       *   · nterm / cterm —— 链的两端，绿色 / 紫色
       * 末端可以在面板上随时开关，所以两个集合分开存，`highlight` 是它们的合成结果。
       */
      const toHighlight = (h, fallbackRole) => ({
        chainIndex: chainIdToIndex.has(h.chain) ? chainIdToIndex.get(h.chain) : -1,
        chain: h.chain,
        resSeq: h.resSeq,
        label: h.label || `${h.resSeq}`,
        role: h.role || fallbackRole || 'site',
      })
      const siteHighlights = (doc.highlight || []).map((h) => toHighlight(h))
      const terminusHighlights = []
      for (const c of chains) {
        if (!c || c.residueCount <= 0 || c.first === null || c.last === null) continue
        terminusHighlights.push(toHighlight({ chain: c.id, resSeq: c.first, label: `${c.id} N端 ${c.first}`, role: 'nterm' }))
        if (c.last !== c.first) {
          terminusHighlights.push(toHighlight({ chain: c.id, resSeq: c.last, label: `${c.id} C端 ${c.last}`, role: 'cterm' }))
        }
      }

      const showTermini = !!(doc.view && doc.view.termini)
      let highlight = showTermini ? siteHighlights.concat(terminusHighlights) : siteHighlights.slice()
      const isHighlighted = (chainIndex, resSeq) =>
        highlight.some((h) => h.resSeq === resSeq && (h.chainIndex < 0 || h.chainIndex === chainIndex))
      const highlightRoleAt = (chainIndex, resSeq) => {
        const hit = highlight.find((h) => h.resSeq === resSeq && (h.chainIndex < 0 || h.chainIndex === chainIndex))
        return hit ? hit.role : null
      }

      // 解析坐标一次，之后各模式共享
      const atoms = new Array(rows.length)
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i]
        atoms[i] = {
          chain: r[0],
          resSeq: r[1],
          resName: dict.resName[r[2]],
          atomName: dict.atomName[r[3]],
          x: r[4] / 1000 - origin[0],
          y: r[5] / 1000 - origin[1],
          z: r[6] / 1000 - origin[2],
          el: dict.element[r[7]],
          b: r[8] * 5,
          het: r[9] === 1,
        }
      }
      const waterNames = new Set(['HOH', 'WAT', 'DOD'])
      for (const a of atoms) {
        a.water = a.het && waterNames.has(a.resName)
        const one = AA3TO1[a.resName] || 'X'
        a.one = one
        a.resClass = RESIDUE_CLASS[one] || 'unknown'
      }

      // Cα 轨迹
      const ca = (doc.ca || []).map((c) => ({
        chain: c[0],
        resSeq: c[1],
        ss: c[2],
        index: c[3],
      }))

      // 取景半径：拓扑/卡通按 Cα 量，球类按全部原子量。
      // 用「到原点的最大距离」而不是包围盒对角线 —— 后者对细长结构会把画面白缩一半。
      let fitCA = 0
      for (const c of ca) {
        const a = atoms[c.index]
        if (!a) continue
        const d = Math.hypot(a.x, a.y, a.z)
        if (d > fitCA) fitCA = d
      }
      let fitAll = 0
      for (const a of atoms) {
        if (a.water) continue
        const d = Math.hypot(a.x, a.y, a.z) + (elementInfoRaw(doc, a.el).radius || 1.7)
        if (d > fitAll) fitAll = d
      }

      // 给了 focus 时，额外记一份「聚焦点附近」的原子（默认 14 Å 口袋半径）：
      // 取景只围着它们，于是镜头真的会推进到突变位点/配体结合口袋，
      // 而不是像以前那样只是换了个旋转原点、画面依旧框住整个蛋白。
      let focusAtoms = null
      if (focus && focus.length === 3) {
        const list = []
        for (const a of atoms) {
          if (a.water) continue
          if (Math.hypot(a.x, a.y, a.z) <= 14) list.push(a)
        }
        if (list.length >= 8) focusAtoms = list
      }

      return {
        doc,
        atoms,
        ca,
        chains,
        highlight,
        siteHighlights,
        terminusHighlights,
        isHighlighted,
        highlightRoleAt,
        /** 末端开关：改完立刻重算合成后的 highlight。 */
        setTermini(on) {
          this.view.showTermini = !!on
          this.highlight = on ? siteHighlights.concat(terminusHighlights) : siteHighlights.slice()
        },
        radius: Math.max(4, fitAll || doc.bbox.radius || 20),
        fitCA: Math.max(4, fitCA || fitAll || 20),
        fitAll: Math.max(4, fitAll || 20),
        focusAtoms,
        elementTable: doc.elements || [],
        view: {
          yaw: 0.6,
          pitch: 0.32,
          zoom: 1,
          panX: 0,
          panY: 0,
          style: (doc.view && doc.view.style) || 'cartoon',
          colorBy: (doc.view && doc.view.colorBy) || 'chain',
          spin: false,
          // 末端高亮：宿主给了 termini 就默认打开；用户还能在工具栏上自己开关
          showTermini,
          // 工具参数 chains 之前被丢掉了：这里必须读进来，否则「只显示这些链」永远无效
          visibleChains: (doc.view && Array.isArray(doc.view.chains) && doc.view.chains.length)
            ? doc.view.chains.slice()
            : null,
          focus: focus || null,
          note: (doc.view && doc.view.note) || '',
        },
      }
    }

    /** 不依赖 view 对象的元素查表（createStructureView 里用得到）。 */
    function elementInfoRaw(doc, name) {
      const hit = (doc.elements || []).find((e) => e.el === name)
      return hit || { radius: 1.7, color: '#9aa4ad' }
    }

    const ELEMENT_BY_NAME = new Map()

    /** 元素半径与颜色（宿主传了就用，否则用一份内置兜底表）。 */
    function elementInfo(view, name) {
      let info = ELEMENT_BY_NAME.get(name)
      if (info) return info
      const hit = (view.elementTable || []).find((e) => e.el === name)
      info = hit ? { radius: hit.radius, color: hit.color } : { radius: 1.7, color: '#9aa4ad' }
      ELEMENT_BY_NAME.set(name, info)
      return info
    }

    /** 单原子着色（按当前着色方案）。 */
    function atomColor(view, atom) {
      const scheme = view.view.colorBy
      if (scheme === 'ss') {
        return SS_COLORS[ssOfResidue(view, atom)] || SS_COLORS.C
      }
      if (scheme === 'element') return elementInfo(view, atom.el).color
      if (scheme === 'resname') return RESIDUE_COLORS[atom.resClass] || RESIDUE_COLORS.unknown
      if (scheme === 'bfactor') {
        const range = (view.doc.stats && view.doc.stats.bFactorRange) || [0, 100]
        const t = range[1] > range[0] ? (atom.b - range[0]) / (range[1] - range[0]) : 0
        return lerpColor('#3b6fd4', '#e5524f', t)
      }
      if (scheme === 'rainbow') {
        const hue = Math.round((atom.resSeq % 120) * 3)
        return `hsl(${hue},62%,60%)`
      }
      return CHAIN_PALETTE[atom.chain % CHAIN_PALETTE.length]
    }

    /** 残基的二级结构类型（从 Cα 索引里查）。 */
    const ssCache = new WeakMap()
    function ssOfResidue(view, atom) {
      let map = ssCache.get(view)
      if (!map) {
        map = new Map()
        for (const c of view.ca) map.set(`${c.chain}\u0000${c.resSeq}`, c.ss)
        ssCache.set(view, map)
      }
      return map.get(`${atom.chain}\u0000${atom.resSeq}`) || 'C'
    }

    /**
     * 把结构编译成一组「可深度排序的绘制原语」。
     *
     * 每种风格产出同一组原语类型：
     *   { kind:'sphere', x,y,z, r, color, alpha, glow }
     *   { kind:'segment', x1,y1,z1, x2,y2,z2, w, color, alpha }
     *   { kind:'triangle', pts:[[x,y,z]×3], color, alpha }
     * 之后统一旋转 → 投影 → 按深度排序 → 绘制（画家算法）。
     */
    function buildPrimitives(view) {
      const style = view.view.style
      const prims = []
      const only = view.view.visibleChains
      const visible = (chainIndex) => !only || only.indexOf(view.chains[chainIndex] && view.chains[chainIndex].id) >= 0

      if (style === 'spacefill' || style === 'ballstick' || style === 'ligand') {
        const showProtein = style !== 'ligand'
        const ballRadius = style === 'spacefill' ? 1 : 0.28
        for (let i = 0; i < view.atoms.length; i += 1) {
          const a = view.atoms[i]
          if (a.water) continue
          if (!visible(a.chain)) continue
          const isLig = a.het
          if (!showProtein && !isLig) continue
          const el = elementInfo(view, a.el)
          const hlRole = view.highlightRoleAt(a.chain, a.resSeq)
          let color = isLig ? '#ff8a3d' : atomColor(view, a)
          if (style === 'ballstick') color = isLig ? '#ff8a3d' : el.color
          if (hlRole) color = highlightColor(hlRole)
          const r = ballRadius * (style === 'spacefill' ? el.radius : 1)
          prims.push({ kind: 'sphere', x: a.x, y: a.y, z: a.z, r, color, alpha: 1, glow: !!hlRole })
        }
        if (style === 'ballstick' || style === 'ligand') {
          const bonds = findBonds(view, style === 'ligand')
          for (const b of bonds) {
            const a1 = view.atoms[b[0]]
            const a2 = view.atoms[b[1]]
            if (!visible(a1.chain) || !visible(a2.chain)) continue
            const isLig = a1.het && !a1.water
            prims.push({
              kind: 'segment',
              x1: a1.x, y1: a1.y, z1: a1.z,
              x2: a2.x, y2: a2.y, z2: a2.z,
              w: isLig ? 0.22 : 0.16,
              color: isLig ? '#ffc27a' : (style === 'ligand' ? '#6b7a8c' : '#c8d2dc'),
              alpha: style === 'ligand' ? 0.5 : 0.9,
            })
          }
        }
      } else {
        // cartoon / trace：沿 Cα 走一条平滑曲线
        const runs = splitRuns(view)
        const sample = view.ca.length > 4000 ? 1 : 3
        for (const run of runs) {
          const pts = catmullRom(run, sample)
          for (let i = 0; i + 1 < pts.length; i += 1) {
            const p = pts[i]
            const q = pts[i + 1]
            if (!visible(p.atom.chain)) continue
            const ss = p.ss
            const hlRole = view.highlightRoleAt(p.atom.chain, p.atom.resSeq)
            let w = style === 'trace' ? 1.4 : (ss === 'H' ? 2.6 : ss === 'E' ? 3.0 : 1.1)
            let color
            if (hlRole) color = highlightColor(hlRole)
            else if (view.view.colorBy === 'ss') color = SS_COLORS[ss] || SS_COLORS.C
            else if (view.view.colorBy === 'resname') color = RESIDUE_COLORS[p.atom.resClass] || RESIDUE_COLORS.unknown
            else if (view.view.colorBy === 'bfactor') color = atomColor(view, p.atom)
            else if (view.view.colorBy === 'rainbow') color = atomColor(view, p.atom)
            else color = CHAIN_PALETTE[p.atom.chain % CHAIN_PALETTE.length]
            prims.push({
              kind: 'segment',
              x1: p.x, y1: p.y, z1: p.z,
              x2: q.x, y2: q.y, z2: q.z,
              w: hlRole ? w * 1.9 : w,
              color,
              alpha: 1,
            })
          }
          // β 折叠片末端画个箭头（在屏幕空间里做，见 drawPrimitives）
          if (style === 'cartoon') {
            const runs2 = sheetRuns(run)
            for (const sr of runs2) {
              const last = sr[sr.length - 1]
              const prev = sr[sr.length - 2]
              if (!last || !prev || !visible(last.atom.chain)) continue
              const color = view.view.colorBy === 'ss'
                ? SS_COLORS.E
                : CHAIN_PALETTE[last.atom.chain % CHAIN_PALETTE.length]
              prims.push({
                kind: 'arrow',
                x1: prev.x, y1: prev.y, z1: prev.z,
                x2: last.x, y2: last.y, z2: last.z,
                w: 3.4,
                color,
                alpha: 1,
              })
            }
          }
        }
      }
      return prims
    }

    /** 把 Cα 序列切成连续的片段（链内且相邻 Cα 距离合理）。 */
    function splitRuns(view) {
      const runs = []
      let current = []
      let prev = null
      for (const c of view.ca) {
        const atom = view.atoms[c.index]
        if (!atom) continue
        // ss 必须从 Cα 条目上取：atom 行里没有二级结构字段（曾经写成 p.atom.ss，
        // 结果所有残基都退化成 'C'，按二级结构着色整张图都是灰的）
        const entry = { atom, ss: c.ss, resSeq: c.resSeq, x: atom.x, y: atom.y, z: atom.z }
        if (prev && (prev.atom.chain !== atom.chain || dist3(prev, entry) > 5.5)) {
          if (current.length >= 2) runs.push(current)
          current = []
        }
        current.push(entry)
        prev = entry
      }
      if (current.length >= 2) runs.push(current)
      return runs
    }

    /** 片段里连续的 E（折叠片）子段，用于末端箭头。 */
    function sheetRuns(run) {
      const out = []
      let cur = []
      for (const p of run) {
        if (p.ss === 'E') cur.push(p)
        else {
          if (cur.length >= 4) out.push(cur)
          cur = []
        }
      }
      if (cur.length >= 4) out.push(cur)
      return out
    }

    function dist3(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    }

    /** Catmull-Rom 细分：每段插 sample 个点。 */
    function catmullRom(run, sample) {
      if (run.length < 2) return run.slice()
      const out = []
      const get = (i) => run[clamp(i, 0, run.length - 1)]
      for (let i = 0; i < run.length - 1; i += 1) {
        const p0 = get(i - 1)
        const p1 = get(i)
        const p2 = get(i + 1)
        const p3 = get(i + 2)
        for (let s = 0; s < sample; s += 1) {
          const t = s / sample
          const t2 = t * t
          const t3 = t2 * t
          out.push({
            x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
            y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
            z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
            atom: p1.atom,
            ss: p1.ss,
            resSeq: p1.resSeq,
          })
        }
      }
      out.push(run[run.length - 1])
      return out
    }

    /** 客户端成键判定：空间哈希 + 距离阈值。 */
    const bondCache = new WeakMap()
    function findBonds(view, ligandOnly) {
      const key = ligandOnly ? 'lig' : 'all'
      let cached = bondCache.get(view)
      if (cached && cached[key]) return cached[key]
      const bonds = []
      const candidates = []
      for (let i = 0; i < view.atoms.length; i += 1) {
        const a = view.atoms[i]
        if (a.water || a.el === 'H') continue
        if (ligandOnly && !a.het) continue
        candidates.push(i)
      }
      const cell = 2.0
      const grid = new Map()
      const key3 = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
      for (const i of candidates) {
        const a = view.atoms[i]
        const k = key3(a.x, a.y, a.z)
        let bucket = grid.get(k)
        if (!bucket) {
          bucket = []
          grid.set(k, bucket)
        }
        bucket.push(i)
      }
      const MAX_BONDS = 24000
      for (const i of candidates) {
        if (bonds.length >= MAX_BONDS) break
        const a = view.atoms[i]
        const cx = Math.floor(a.x / cell)
        const cy = Math.floor(a.y / cell)
        const cz = Math.floor(a.z / cell)
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dz = -1; dz <= 1; dz += 1) {
              const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`)
              if (!bucket) continue
              for (const j of bucket) {
                if (j <= i) continue
                const b = view.atoms[j]
                if (ligandOnly && a.het !== b.het) continue
                const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
                const limit = a.het && b.het ? 1.95 : 1.75
                if (d < limit) bonds.push([i, j])
              }
            }
          }
        }
      }
      cached = cached || {}
      cached[key] = bonds
      bondCache.set(view, cached)
      return bonds
    }

    /**
     * 投影参数：把 Å 映射到像素。
     *
     * 取景用「旋转后投影包围盒」而不是包围球。包围球对细长结构（长螺旋束、MCE 转运体
     * 这类）会把画面缩到只占一角 —— 球半径由最长轴决定，而短轴方向全是空白。
     * 投影包围盒能贴合当前姿态，球状和棒状都撑满画布。
     *
     * 逐帧重新取景会让自转时画面轻微「呼吸」，所以与上一帧的缩放做 3:1 平滑。
     */
    function projection(view, width, height, m) {
      const style = view.view.style
      const atomFit = style === 'spacefill' || style === 'ballstick' || style === 'ligand'
      // 有 focus 时优先框住聚焦点附近的原子（镜头推进到口袋），否则框整体
      const source = view.focusAtoms && view.focusAtoms.length
        ? view.focusAtoms
        : (atomFit ? view.atoms : view.ca)
      const step = Math.max(1, Math.floor(source.length / 3000))
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (let i = 0; i < source.length; i += step) {
        const atom = (view.focusAtoms && view.focusAtoms.length) ? source[i]
          : (atomFit ? source[i] : view.atoms[source[i].index])
        if (!atom || atom.water) continue
        const x = m[0] * atom.x + m[1] * atom.y + m[2] * atom.z
        const y = m[3] * atom.x + m[4] * atom.y + m[5] * atom.z
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      if (!isFinite(minX)) {
        minX = -1
        maxX = 1
        minY = -1
        maxY = 1
      }
      const w = Math.max(1e-3, maxX - minX)
      const h = Math.max(1e-3, maxY - minY)
      const fitScale = Math.min((width * 0.9) / w, (height * 0.9) / h)
      const prev = view._fitScale
      const smooth = prev === undefined ? fitScale : prev + (fitScale - prev) * 0.25
      view._fitScale = smooth
      const scale = smooth * view.view.zoom
      return {
        scale,
        cx: width / 2 - ((minX + maxX) / 2) * scale + view.view.panX,
        cy: height / 2 + ((minY + maxY) / 2) * scale + view.view.panY,
        width,
        height,
      }
    }

    /**
     * 旋转 + 正交投影一批点。
     * 返回 z 用于深度排序（越大越靠近观察者）。
     */
    function project(m, p, pr) {
      const x = m[0] * p.x + m[1] * p.y + m[2] * p.z
      const y = m[3] * p.x + m[4] * p.y + m[5] * p.z
      const z = m[6] * p.x + m[7] * p.y + m[8] * p.z
      return { sx: pr.cx + x * pr.scale, sy: pr.cy - y * pr.scale, depth: z }
    }

    /**
     * 画一批原语。
     * 深度雾：越远越暗、越透明，制造三维纵深感。
     */
    function drawPrimitives(g, view, prims, m, pr) {
      const radius = view.radius || 20
      /**
       * 聚焦模式的远近淡出。
       *
       * 只把镜头推进去还不够 —— 周围的结构照样画满整屏，位点反而淹没在里面。
       * 所以 focus 生效时，离聚焦点越远的原语越透明（16 Å 内全不透明，30 Å 外只剩 0.16），
       * 视觉上就真的「对准」了突变位点/结合口袋。
       */
      const FOCUS_IN = 16
      const FOCUS_OUT = 30
      const focusMode = !!(view.focusAtoms && view.focusAtoms.length)
      const focusAlpha = (x, y, z) => {
        if (!focusMode) return 1
        const d = Math.hypot(x, y, z)
        if (d <= FOCUS_IN) return 1
        if (d >= FOCUS_OUT) return 0.16
        return 1 - (0.84 * (d - FOCUS_IN)) / (FOCUS_OUT - FOCUS_IN)
      }
      const projected = []
      for (const p of prims) {
        if (p.kind === 'sphere') {
          const q = project(m, p, pr)
          if (q.sx < -60 || q.sy < -60 || q.sx > pr.width + 60 || q.sy > pr.height + 60) continue
          projected.push({ p, q, depth: q.depth, r: Math.max(0.7, p.r * pr.scale), fade: focusAlpha(p.x, p.y, p.z) })
        } else if (p.kind === 'segment' || p.kind === 'arrow') {
          const a = project(m, { x: p.x1, y: p.y1, z: p.z1 }, pr)
          const b = project(m, { x: p.x2, y: p.y2, z: p.z2 }, pr)
          if (Math.max(a.sx, b.sx) < -60 || Math.min(a.sx, b.sx) > pr.width + 60) continue
          if (Math.max(a.sy, b.sy) < -60 || Math.min(a.sy, b.sy) > pr.height + 60) continue
          projected.push({
            p, a, b,
            depth: (a.depth + b.depth) / 2,
            w: Math.max(0.8, p.w * pr.scale * 0.42),
            fade: focusAlpha((p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2, (p.z1 + p.z2) / 2),
          })
        }
      }
      projected.sort((x, y) => x.depth - y.depth)

      for (const item of projected) {
        const p = item.p
        const fog = clamp(0.62 + 0.38 * ((item.depth / radius + 1) / 2), 0.45, 1)
        const fade = item.fade === undefined ? 1 : item.fade
        if (p.kind === 'sphere') {
          g.globalAlpha = (p.alpha === undefined ? 1 : p.alpha) * (0.55 + 0.45 * fog) * fade
          if (item.r < 1.2 || g.globalAlpha < 0.03) continue
          drawSphere(g, item.q.sx, item.q.sy, item.r, p.color, item.depth / radius)
          if (p.glow) {
            g.globalAlpha = 0.9
            g.strokeStyle = '#ffd166'
            g.lineWidth = 1.6
            g.beginPath()
            g.arc(item.q.sx, item.q.sy, item.r + 2.4, 0, Math.PI * 2)
            g.stroke()
          }
        } else if (p.kind === 'segment') {
          g.globalAlpha = (p.alpha === undefined ? 1 : p.alpha) * fog * fade
          if (g.globalAlpha < 0.03) continue
          g.strokeStyle = p.color
          g.lineWidth = item.w
          g.lineCap = 'round'
          g.beginPath()
          g.moveTo(item.a.sx, item.a.sy)
          g.lineTo(item.b.sx, item.b.sy)
          g.stroke()
        } else if (p.kind === 'arrow') {
          // 屏幕空间三角形箭头：沿 (a→b) 方向，宽度 item.w
          g.globalAlpha = fog * fade
          if (g.globalAlpha < 0.03) continue
          const dx = item.b.sx - item.a.sx
          const dy = item.b.sy - item.a.sy
          const len = Math.hypot(dx, dy) || 1
          const ux = dx / len
          const uy = dy / len
          const px = -uy
          const py = ux
          const size = clamp(item.w * 2.6, 4, 22)
          const tipX = item.b.sx + ux * size * 0.9
          const tipY = item.b.sy + uy * size * 0.9
          g.fillStyle = p.color
          g.beginPath()
          g.moveTo(tipX, tipY)
          g.lineTo(item.b.sx - ux * size * 0.2 + px * size * 0.62, item.b.sy - uy * size * 0.2 + py * size * 0.62)
          g.lineTo(item.b.sx - ux * size * 0.2 - px * size * 0.62, item.b.sy - uy * size * 0.2 - py * size * 0.62)
          g.closePath()
          g.fill()
        }
      }
      g.globalAlpha = 1
    }

    /**
     * 画一个带光照的球。
     *
     * 渐变按 (元素色, 半径整数值) 缓存 —— 渐变定义在用户空间，配合 translate 使用，
     * 所以同一个渐变对象可以服务所有位置相同半径的球。这是让「两万个原子还能 30fps」
     * 的关键；半径很小时直接平涂（小球的明暗细节本来也看不见）。
     */
    const gradientCache = new Map()
    function sphereGradient(g, color, radius) {
      const key = `${color}|${radius}`
      let grad = gradientCache.get(key)
      if (!grad) {
        if (gradientCache.size > 400) gradientCache.clear()
        const grad0 = g.createRadialGradient(-radius * 0.32, -radius * 0.36, radius * 0.06, 0, 0, radius)
        grad0.addColorStop(0, shade(color, 0.55))
        grad0.addColorStop(0.45, color)
        grad0.addColorStop(1, shade(color, -0.55))
        grad = grad0
        gradientCache.set(key, grad)
      }
      return grad
    }

    function drawSphere(g, x, y, r, color, depthRatio) {
      const rr = Math.round(r * 2) / 2
      if (rr < 2.2) {
        g.fillStyle = shade(color, -0.12 + clamp(depthRatio, -1, 1) * 0.18)
        g.beginPath()
        g.arc(x, y, rr, 0, Math.PI * 2)
        g.fill()
        return
      }
      g.save()
      g.translate(x, y)
      g.fillStyle = sphereGradient(g, color, rr)
      g.beginPath()
      g.arc(0, 0, rr, 0, Math.PI * 2)
      g.fill()
      g.restore()
    }

    /** 结构面板的整体绘制。 */
    function paintStructure(g, view, width, height) {
      g.clearRect(0, 0, width, height)
      // 背景：径向渐变，中心略亮，像一盏顶灯
      const bg = g.createRadialGradient(width * 0.5, height * 0.36, 10, width * 0.5, height * 0.5, Math.max(width, height) * 0.72)
      bg.addColorStop(0, '#20262e')
      bg.addColorStop(1, '#12161b')
      g.fillStyle = bg
      g.fillRect(0, 0, width, height)

      const m = rotationMatrix(view.view.yaw, view.view.pitch)
      const pr = projection(view, width, height, m)
      const prims = buildPrimitives(view)
      drawPrimitives(g, view, prims, m, pr)

      // 高亮标签最后画，保证在最上层
      drawHighlightLabels(g, view, m, pr)
      drawAxisHint(g, width, height, view)
      return { primitives: prims.length, projected: pr }
    }

    function drawHighlightLabels(g, view, m, pr) {
      if (!view.highlight.length) return
      const placed = []
      for (const h of view.highlight) {
        // 找到该残基的 Cα（没有就退回首原子）
        let target = null
        for (const c of view.ca) {
          const atom = view.atoms[c.index]
          if (!atom) continue
          if (atom.resSeq === h.resSeq && (h.chainIndex < 0 || atom.chain === h.chainIndex)) {
            target = atom
            break
          }
        }
        if (!target) continue
        const q = project(m, target, pr)
        let x = q.sx
        let y = q.sy - 16
        // 简单避让：与已放置的标签重叠就上移
        for (let guard = 0; guard < 8; guard += 1) {
          const clash = placed.some((p) => Math.abs(p.x - x) < 66 && Math.abs(p.y - y) < 20)
          if (!clash) break
          y -= 20
        }
        placed.push({ x, y })
        const text = h.label
        const color = highlightColor(h.role)
        g.font = '600 12px ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif'
        const w = g.measureText(text).width + 14
        g.globalAlpha = 0.92
        g.fillStyle = color
        g.beginPath()
        g.arc(q.sx, q.sy, 4.2, 0, Math.PI * 2)
        g.fill()
        // 标签胶囊（边框用该高亮类别的颜色，一眼分得清位点 / N 端 / C 端）
        g.fillStyle = 'rgba(12,15,19,0.86)'
        g.fillRect(x - w / 2, y - 12, w, 18)
        g.strokeStyle = color
        g.lineWidth = 1
        g.strokeRect(x - w / 2, y - 12, w, 18)
        g.globalAlpha = 1
        g.fillStyle = color
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(text, x, y - 3)
      }
      g.textAlign = 'left'
      g.textBaseline = 'alphabetic'
    }

    /** 右下角画一个小坐标轴指示器。 */
    function drawAxisHint(g, width, height, view) {
      const m = rotationMatrix(view.view.yaw, view.view.pitch)
      const ox = width - 46
      const oy = height - 34
      const axes = [
        { v: [1, 0, 0], label: 'x', color: '#e56b6f' },
        { v: [0, 1, 0], label: 'y', color: '#5ac8a8' },
        { v: [0, 0, 1], label: 'z', color: '#4c9aff' },
      ]
      g.lineWidth = 1.6
      g.globalAlpha = 0.85
      g.font = '10px ui-sans-serif, system-ui, sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      for (const a of axes) {
        const x = m[0] * a.v[0] + m[1] * a.v[1] + m[2] * a.v[2]
        const y = m[3] * a.v[0] + m[4] * a.v[1] + m[5] * a.v[2]
        g.strokeStyle = a.color
        g.beginPath()
        g.moveTo(ox, oy)
        g.lineTo(ox + x * 16, oy - y * 16)
        g.stroke()
        g.fillStyle = a.color
        g.fillText(a.label, ox + x * 22, oy - y * 22)
      }
      g.globalAlpha = 1
      g.textAlign = 'left'
      g.textBaseline = 'alphabetic'
    }

    // =====================================================================
    // 4. 二维图表渲染
    // =====================================================================

    const MARGIN = { top: 30, right: 16, bottom: 42, left: 56 }

    /**
     * 图表面板的版式预算与最小高度。
     *
     * 这几个数字必须**同时**被两处用到：paintChart 用它排版，chartMinHeight 用它算
     * 「这张图至少要多少高度」。分开写死过一次，结果面板高度不够时每个 cell 的绘图区
     * 被压到 45.5px、撞上 `box.h < 46` 的兜底判断，于是**只剩标题、图全没了而且不报错**。
     */
    const CHART_TITLE_H = 22
    const CHART_AXIS_H = 40
    const CHART_CAPTION_H = 32
    const CHART_GAP = 14
    /** 绘图区低于这个高度就没有可读性，宁可把画布撑高让外面滚动 */
    const CHART_MIN_PLOT_H = 130
    /** 底轴长标签是斜排的，字号按这个估算垂直占用 */
    const CHART_TICK_FONT = 11

    /**
     * 底轴标签要占多高。
     *
     * 超过 12 字的标签会 -36° 斜排，垂直占用 ≈ 文字长度 × 字号 × sin(36°)。
     * 固定留 40px 会让「普通饲料 − 15%大豆饲料」这种 14 字标签直接压到下面的图注上
     * —— 截图里真实出现过，两行字叠在一起谁也读不清。
     */
    function panelAxisHeight(panel) {
      const labels = (panel && panel.xTickLabels) || []
      let longest = 0
      for (const s of labels) longest = Math.max(longest, String(s).length)
      if (longest <= 12) return CHART_AXIS_H
      const rotated = Math.ceil(longest * CHART_TICK_FONT * Math.sin(Math.PI / 5)) + 12
      return Math.min(108, Math.max(CHART_AXIS_H, rotated))
    }

    /** 一格里的所有面板共用高度，所以取全图最大的那个轴带。 */
    function chartAxisHeight(doc) {
      let h = CHART_AXIS_H
      for (const p of (doc && doc.panels) || []) h = Math.max(h, panelAxisHeight(p))
      return h
    }

    /**
     * 最后一行只剩一个面板时让它横跨整行。
     * 3 个面板的图（很常见：分布 + 箱线 + 森林）排成 2 列时，第 2 行右半边本来是空的，
     * 而森林图那串长标签恰恰最需要宽度。
     */
    function cellSpan(i, n, cols) {
      if (cols <= 1) return 1
      const lastRowStart = Math.floor((n - 1) / cols) * cols
      return i >= lastRowStart && n - lastRowStart === 1 ? cols : 1
    }

    /**
     * 基因组学面板各自需要多高。
     *
     * 树按叶子数、比对按序列数、富集按条目数、变异图按染色体数、覆盖度按轨道数 ——
     * 这些量都直接决定行高，挤扁了就只看得见标题（和通用图表面板踩过的是同一个坑）。
     */
    function panelMinHeight(panel) {
      const count = (a) => (Array.isArray(a) ? a.length : 0)
      switch (panel && panel.kind) {
        case 'phylo': {
          const leaves = String(panel.newick || '').split(',').length
          return 46 + leaves * (leaves > 40 ? 8 : leaves > 20 ? 11 : 15)
        }
        case 'msa': {
          const n = count(panel.sequences)
          return 52 + n * (n > 24 ? 10 : 14)
        }
        case 'enrich':
          return 46 + Math.min(count(panel.terms), Math.max(3, panel.top || 20)) * 20
        case 'genome':
          return 34 + count(panel.chromosomes) * 26
        case 'coverage':
          return 40 + count(panel.tracks) * 74 + (count(panel.genes) ? 30 : 0)
        case 'volcano':
          return 260
        case 'survival':
        case 'roc':
          // 两个都要正方形感：生存曲线矮了看不出阶梯，ROC 矮了曲线形状会骗人
          return 300
        case 'network':
          return 340
        case 'logo':
          return 240
        case 'heatmap': {
          // 热图的高度由行数决定：行多了就撑高让外面滚，别把格子压成一条线
          const rows = Array.isArray(panel.values) ? panel.values.length : 0
          return Math.min(2600, 96 + rows * 4)
        }
        default:
          return 0
      }
    }

    /** 一句话说清：这份图表在给定宽度下需要多少高度才画得完整。 */
    function chartMinHeight(doc, width) {
      const panels = (doc && doc.panels) || []
      if (panels.length === 0) return 240
      const cols = panels.length === 1 ? 1 : width > 900 ? 2 : 1
      const rows = Math.ceil(panels.length / cols)
      const anyCaption = panels.some((p) => !!p.caption)
      let cellH = CHART_TITLE_H + chartAxisHeight(doc) + (anyCaption ? CHART_CAPTION_H : 0) + CHART_MIN_PLOT_H
      for (const p of panels) cellH = Math.max(cellH, panelMinHeight(p))
      return CHART_GAP + rows * (cellH + CHART_GAP)
    }

    /** 计算一个面板的数据范围。 */
    function panelDomain(panel) {
      let xMin = Infinity
      let xMax = -Infinity
      let yMin = Infinity
      let yMax = -Infinity
      const addX = (v) => {
        if (!isFinite(v)) return
        if (v < xMin) xMin = v
        if (v > xMax) xMax = v
      }
      const addY = (v) => {
        if (!isFinite(v)) return
        if (v < yMin) yMin = v
        if (v > yMax) yMax = v
      }
      const categorical = !!(panel.xTickLabels && panel.xTickLabels.length)
      for (const layer of panel.layers || []) {
        if (layer.pts) for (const p of layer.pts) {
          addX(p[0])
          addY(p[1])
        }
        if (layer.items) {
          for (const it of layer.items) {
            addX(it.x)
            addY(it.y)
            if (it.lo !== undefined) addY(it.lo)
            if (it.hi !== undefined) addY(it.hi)
            if (it.err !== undefined) {
              addY(it.y - it.err)
              addY(it.y + it.err)
            }
          }
        }
        if (layer.bins) {
          for (const b of layer.bins) {
            addX(b.x0)
            addX(b.x1)
            addY(b.density !== undefined ? b.density : b.count)
          }
        }
        if (layer.type === 'vline') addX(layer.x)
        if (layer.type === 'hline') addY(layer.y)
        if (layer.type === 'rect') {
          addX(layer.x0)
          addX(layer.x1)
          if (layer.y0 !== undefined) addY(layer.y0)
          if (layer.y1 !== undefined) addY(layer.y1)
        }
        if (layer.type === 'text') {
          addX(layer.x)
          addY(layer.y)
        }
      }
      if (panel.xDomain) {
        xMin = panel.xDomain[0]
        xMax = panel.xDomain[1]
      }
      if (panel.yDomain) {
        yMin = panel.yDomain[0]
        yMax = panel.yDomain[1]
      }
      if (!isFinite(xMin) || !isFinite(xMax)) {
        xMin = 0
        xMax = 1
      }
      if (!isFinite(yMin) || !isFinite(yMax)) {
        yMin = 0
        yMax = 1
      }
      if (xMin === xMax) {
        xMin -= 0.5
        xMax += 0.5
      }
      if (yMin === yMax) {
        yMin -= 0.5
        yMax += 0.5
      }
      // 分类轴：x 用半整数边界包住每个类别
      if (categorical) {
        xMin = -0.6
        xMax = panel.xTickLabels.length - 0.4
      } else {
        const padX = (xMax - xMin) * 0.04
        xMin -= padX
        xMax += padX
      }
      if (!panel.yDomain) {
        const padY = (yMax - yMin) * 0.08
        if (yMin >= 0 && yMin - padY < 0) yMin = 0
        else yMin -= padY
        yMax += padY
      }
      return { xMin, xMax, yMin, yMax, categorical }
    }

    function makeScales(panel, box) {
      const d = panelDomain(panel)
      const sx = (x) => box.x + ((x - d.xMin) / (d.xMax - d.xMin)) * box.w
      const sy = (y) => box.y + box.h - ((y - d.yMin) / (d.yMax - d.yMin)) * box.h
      return { d, sx, sy }
    }

    /** 面板背景 + 坐标轴 + 网格 + 刻度。 */
    function drawFrame(g, panel, box) {
      const { d, sx, sy } = makeScales(panel, box)
      g.fillStyle = 'rgba(255,255,255,0.022)'
      g.fillRect(box.x, box.y, box.w, box.h)

      const yTicks = panel.yTicks || niceTicks(d.yMin, d.yMax, Math.max(3, Math.floor(box.h / 46)))
      g.font = '11px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
      g.textAlign = 'right'
      g.textBaseline = 'middle'
      for (const t of yTicks) {
        if (t < d.yMin - 1e-9 || t > d.yMax + 1e-9) continue
        const y = sy(t)
        g.strokeStyle = THEME.grid
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(box.x, y)
        g.lineTo(box.x + box.w, y)
        g.stroke()
        g.fillStyle = THEME.textDim
        g.fillText(fmt(t), box.x - 8, y)
      }

      let xTicks
      if (d.categorical) {
        xTicks = (panel.xTickLabels || []).map((label, i) => ({ v: i, label }))
      } else {
        xTicks = (panel.xTicks || niceTicks(d.xMin, d.xMax, Math.max(3, Math.floor(box.w / 70)))).map((v) => ({ v, label: fmt(v) }))
      }
      g.textAlign = 'center'
      g.textBaseline = 'top'
      for (const t of xTicks) {
        const x = d.categorical ? box.x + ((t.v - d.xMin) / (d.xMax - d.xMin)) * box.w : sx(t.v)
        if (x < box.x - 2 || x > box.x + box.w + 2) continue
        if (!d.categorical) {
          g.strokeStyle = THEME.grid
          g.beginPath()
          g.moveTo(x, box.y)
          g.lineTo(x, box.y + box.h)
          g.stroke()
        }
        g.fillStyle = THEME.textDim
        const text = String(t.label)
        if (text.length > 12) {
          g.save()
          g.translate(x, box.y + box.h + 8)
          g.rotate(-Math.PI / 5)
          g.textAlign = 'right'
          g.fillText(text, 0, 0)
          g.restore()
          g.textAlign = 'center'
        } else {
          g.fillText(text, x, box.y + box.h + 8)
        }
      }

      g.strokeStyle = THEME.axis
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(box.x, box.y)
      g.lineTo(box.x, box.y + box.h)
      g.lineTo(box.x + box.w, box.y + box.h)
      g.stroke()

      g.textAlign = 'left'
      g.textBaseline = 'alphabetic'
      if (panel.xLabel) {
        g.fillStyle = THEME.textDim
        g.font = '11.5px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
        g.textAlign = 'center'
        g.fillText(panel.xLabel, box.x + box.w / 2, box.y + box.h + 34)
      }
      if (panel.yLabel) {
        g.save()
        // 注意基准点是 box.x：早先写成固定 14，右侧面板的纵轴标题会画到左侧面板上去
        g.translate(box.x - 40, box.y + box.h / 2)
        g.rotate(-Math.PI / 2)
        g.fillStyle = THEME.textDim
        g.font = '11.5px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
        g.textAlign = 'center'
        g.fillText(panel.yLabel, 0, 0)
        g.restore()
      }
      g.textAlign = 'left'
      return { d, sx, sy }
    }

    /** 画一个面板的全部图层。 */
    function drawPanel(g, panel, box) {
      // 基因组学面板各有自己的坐标系（树是递归布局、比对是矩阵、富集是分类轴），
      // 不走「x/y 标尺 + 图层」那套，所以在最前面分派掉。
      switch (panel.kind) {
        case 'phylo': drawPhylo(g, panel, box); return
        case 'msa': drawMsa(g, panel, box); return
        case 'enrich': drawEnrich(g, panel, box); return
        case 'genome': drawGenome(g, panel, box); return
        case 'coverage': drawCoverage(g, panel, box); return
        case 'volcano': drawVolcano(g, panel, box); return
        case 'heatmap': drawHeatmap(g, panel, box); return
        case 'survival': drawSurvival(g, panel, box); return
        case 'roc': drawRoc(g, panel, box); return
        case 'network': drawNetwork(g, panel, box); return
        case 'logo': drawLogo(g, panel, box); return
        default: break
      }
      const scales = drawFrame(g, panel, box)
      const { sx, sy } = scales
      const clip = (fn) => {
        g.save()
        g.beginPath()
        g.rect(box.x, box.y, box.w, box.h)
        g.clip()
        fn()
        g.restore()
      }

      clip(() => {
        for (const layer of panel.layers || []) {
          g.globalAlpha = layer.opacity === undefined ? 1 : layer.opacity
          switch (layer.type) {
            case 'area': {
              if (!layer.pts || layer.pts.length < 2) break
              g.fillStyle = layer.color || 'rgba(76,154,255,0.2)'
              g.beginPath()
              g.moveTo(sx(layer.pts[0][0]), sy(layer.pts[0][1]))
              for (let i = 1; i < layer.pts.length; i += 1) g.lineTo(sx(layer.pts[i][0]), sy(layer.pts[i][1]))
              if (layer.baseline !== undefined) {
                // 收到指定基线（正态曲线的 ±kσ 阴影要收到 y=0，否则会连成一条横带）
                const yb = sy(layer.baseline)
                const last = layer.pts[layer.pts.length - 1]
                g.lineTo(sx(last[0]), yb)
                g.lineTo(sx(layer.pts[0][0]), yb)
              }
              g.closePath()
              g.fill()
              break
            }
            case 'hist': {
              for (const b of layer.bins || []) {
                const v = b.density !== undefined ? b.density : b.count
                const x0 = sx(b.x0)
                const x1 = sx(b.x1)
                const y = sy(v)
                g.fillStyle = layer.color || 'rgba(76,154,255,0.5)'
                g.fillRect(x0, y, Math.max(1, x1 - x0 - 1), box.y + box.h - y)
                g.strokeStyle = 'rgba(255,255,255,0.16)'
                g.lineWidth = 0.8
                g.strokeRect(x0, y, Math.max(1, x1 - x0 - 1), box.y + box.h - y)
              }
              break
            }
            case 'line': {
              if (!layer.pts || layer.pts.length < 2) break
              g.strokeStyle = layer.color || THEME.accent
              g.lineWidth = layer.width || 1.8
              g.lineJoin = 'round'
              g.lineCap = 'round'
              g.setLineDash(layer.dash || [])
              g.beginPath()
              g.moveTo(sx(layer.pts[0][0]), sy(layer.pts[0][1]))
              for (let i = 1; i < layer.pts.length; i += 1) g.lineTo(sx(layer.pts[i][0]), sy(layer.pts[i][1]))
              g.stroke()
              g.setLineDash([])
              break
            }
            case 'points': {
              const r = layer.r || 3
              const shape = layer.shape || 'circle'
              for (const p of layer.pts || []) {
                const x = sx(p[0])
                const y = sy(p[1])
                if (x < box.x - 8 || x > box.x + box.w + 8 || y < box.y - 8 || y > box.y + box.h + 8) continue
                g.fillStyle = layer.color || THEME.accent
                if (shape === 'diamond') {
                  g.beginPath()
                  g.moveTo(x, y - r * 1.35)
                  g.lineTo(x + r * 1.35, y)
                  g.lineTo(x, y + r * 1.35)
                  g.lineTo(x - r * 1.35, y)
                  g.closePath()
                  g.fill()
                } else {
                  g.beginPath()
                  g.arc(x, y, r, 0, Math.PI * 2)
                  g.fill()
                }
              }
              break
            }
            case 'bars': {
              const width = (layer.width || 0.7) * ((box.w / Math.max(1, (scales.d.xMax - scales.d.xMin))));
              for (const it of layer.items || []) {
                const x = sx(it.x)
                const y = sy(it.y)
                const base = sy(Math.max(0, scales.d.yMin))
                g.fillStyle = it.color || THEME.accent
                const w = clamp(width, 3, box.w)
                g.fillRect(x - w / 2, Math.min(y, base), w, Math.abs(base - y))
                if (it.err) {
                  const lo = sy(it.y - it.err)
                  const hi = sy(it.y + it.err)
                  g.strokeStyle = 'rgba(255,255,255,0.8)'
                  g.lineWidth = 1.4
                  g.beginPath()
                  g.moveTo(x, hi)
                  g.lineTo(x, lo)
                  g.moveTo(x - w * 0.22, hi)
                  g.lineTo(x + w * 0.22, hi)
                  g.moveTo(x - w * 0.22, lo)
                  g.lineTo(x + w * 0.22, lo)
                  g.stroke()
                }
              }
              break
            }
            case 'boxes': {
              const unit = box.w / Math.max(1, scales.d.xMax - scales.d.xMin)
              const half = clamp((layer.width || 0.45) * unit * 0.5, 6, 90)
              for (const it of layer.items || []) {
                const x = sx(it.x)
                const yQ1 = sy(it.q1)
                const yQ3 = sy(it.q3)
                const yMed = sy(it.med)
                const yLo = sy(it.lo)
                const yHi = sy(it.hi)
                const color = it.color || THEME.accent
                g.fillStyle = shade(color, -0.25)
                g.globalAlpha = (layer.opacity === undefined ? 1 : layer.opacity) * 0.55
                g.fillRect(x - half, Math.min(yQ1, yQ3), half * 2, Math.abs(yQ3 - yQ1))
                g.globalAlpha = layer.opacity === undefined ? 1 : layer.opacity
                g.strokeStyle = color
                g.lineWidth = 1.8
                g.strokeRect(x - half, Math.min(yQ1, yQ3), half * 2, Math.abs(yQ3 - yQ1))
                // 中位线
                g.strokeStyle = '#ffffff'
                g.lineWidth = 2
                g.beginPath()
                g.moveTo(x - half, yMed)
                g.lineTo(x + half, yMed)
                g.stroke()
                // 须
                g.strokeStyle = color
                g.lineWidth = 1.4
                g.beginPath()
                g.moveTo(x, yQ3)
                g.lineTo(x, yHi)
                g.moveTo(x, yQ1)
                g.lineTo(x, yLo)
                g.moveTo(x - half * 0.45, yHi)
                g.lineTo(x + half * 0.45, yHi)
                g.moveTo(x - half * 0.45, yLo)
                g.lineTo(x + half * 0.45, yLo)
                g.stroke()
                if (it.label) {
                  g.fillStyle = THEME.textDim
                  g.font = '10.5px ui-sans-serif, system-ui, sans-serif'
                  g.textAlign = 'center'
                  g.textBaseline = 'top'
                  // 支持多行（canvas 的 fillText 不认 \n，要自己拆）
                  const lines = String(it.label).split('\n')
                  lines.forEach((line, li) => g.fillText(line, x, yLo + 4 + li * 12))
                }
              }
              g.textAlign = 'left'
              g.textBaseline = 'alphabetic'
              break
            }
            case 'errorbars': {
              for (const it of layer.items || []) {
                const x = sx(it.x)
                const yLo = sy(it.lo)
                const yHi = sy(it.hi)
                const y = sy(it.y)
                g.strokeStyle = it.color || '#ffffff'
                g.lineWidth = 2
                g.beginPath()
                g.moveTo(x, yHi)
                g.lineTo(x, yLo)
                g.moveTo(x - 4, yHi)
                g.lineTo(x + 4, yHi)
                g.moveTo(x - 4, yLo)
                g.lineTo(x + 4, yLo)
                g.stroke()
                g.fillStyle = it.color || '#ffffff'
                g.beginPath()
                g.arc(x, y, 2.6, 0, Math.PI * 2)
                g.fill()
              }
              break
            }
            case 'vline': {
              const x = sx(layer.x)
              g.strokeStyle = layer.color || '#e6edf3'
              g.lineWidth = layer.width || 1.4
              g.setLineDash(layer.dash || [])
              g.beginPath()
              g.moveTo(x, box.y)
              g.lineTo(x, box.y + box.h)
              g.stroke()
              g.setLineDash([])
              if (layer.label) {
                g.fillStyle = layer.color || '#e6edf3'
                g.font = '10.5px ui-sans-serif, system-ui, sans-serif'
                g.textAlign = 'left'
                g.save()
                g.translate(x + 3, box.y + 12)
                g.fillText(layer.label, 0, 0)
                g.restore()
              }
              break
            }
            case 'hline': {
              const y = sy(layer.y)
              g.strokeStyle = layer.color || '#e6edf3'
              g.lineWidth = layer.width || 1.4
              g.setLineDash(layer.dash || [])
              g.beginPath()
              g.moveTo(box.x, y)
              g.lineTo(box.x + box.w, y)
              g.stroke()
              g.setLineDash([])
              if (layer.label) {
                g.fillStyle = layer.color || '#e6edf3'
                g.font = '10.5px ui-sans-serif, system-ui, sans-serif'
                g.textAlign = 'right'
                g.fillText(layer.label, box.x + box.w - 4, y - 4)
                g.textAlign = 'left'
              }
              break
            }
            case 'rect': {
              const x0 = sx(layer.x0)
              const x1 = sx(layer.x1)
              const y0 = layer.y0 === undefined ? box.y : sy(layer.y0)
              const y1 = layer.y1 === undefined ? box.y + box.h : sy(layer.y1)
              g.fillStyle = layer.color || 'rgba(255,255,255,0.08)'
              g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
              break
            }
            case 'text': {
              g.fillStyle = layer.color || THEME.textDim
              g.font = `${layer.size || 11}px ui-sans-serif, system-ui, "PingFang SC", sans-serif`
              g.textAlign = layer.align || 'center'
              g.textBaseline = 'middle'
              g.fillText(layer.text, sx(layer.x), sy(layer.y))
              g.textAlign = 'left'
              g.textBaseline = 'alphabetic'
              break
            }
            default:
              break
          }
          g.globalAlpha = 1
        }
      })

      // 图例
      if (panel.legend && panel.legend.length) {
        let lx = box.x + 10
        const ly = box.y + 8
        g.font = '10.5px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
        g.textBaseline = 'middle'
        for (const item of panel.legend) {
          g.fillStyle = item.color || THEME.accent
          g.fillRect(lx, ly - 4, 10, 8)
          g.fillStyle = THEME.textDim
          g.textAlign = 'left'
          g.fillText(item.label, lx + 14, ly)
          lx += 14 + g.measureText(item.label).width + 14
        }
        g.textBaseline = 'alphabetic'
      }
    }

    /** 画整张图表文档（可能含多个面板）。 */
    function paintChart(g, doc, width, height) {
      g.clearRect(0, 0, width, height)
      g.fillStyle = '#0f1318'
      g.fillRect(0, 0, width, height)

      const panels = doc.panels || []
      if (panels.length === 0) {
        g.fillStyle = THEME.textDim
        g.font = '13px ui-sans-serif, system-ui, sans-serif'
        g.textAlign = 'center'
        g.fillText('这份图表文档没有面板', width / 2, height / 2)
        g.textAlign = 'left'
        return { panels: 0 }
      }

      const cols = panels.length === 1 ? 1 : width > 900 ? 2 : 1
      const rows = Math.ceil(panels.length / cols)
      const gap = CHART_GAP
      const baseCellW = (width - gap * (cols + 1)) / cols
      const cellH = (height - gap * (rows + 1)) / rows
      const TITLE_H = CHART_TITLE_H
      // 轴带按本图最长标签算：长标签斜排要的地方比默认 40px 多得多
      const AXIS_H = chartAxisHeight(doc)
      const CAPTION_H = CHART_CAPTION_H
      let skipped = 0

      panels.forEach((panel, i) => {
        const span = cellSpan(i, panels.length, cols)
        const cellW = baseCellW * span + gap * (span - 1)
        const cx = gap + (i % cols) * (baseCellW + gap)
        const cy = gap + Math.floor(i / cols) * (cellH + gap)
        // 面板标题
        g.fillStyle = THEME.text
        g.font = '600 12.5px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
        g.textAlign = 'left'
        g.textBaseline = 'alphabetic'
        g.fillText(panel.title || `面板 ${i + 1}`, cx + 2, cy + 12)
        const hasCaption = !!panel.caption
        // 版式预算：标题 / 坐标轴 / 图注三条带各自预留，互不重叠
        const box = {
          x: cx + MARGIN.left * 0.72,
          y: cy + TITLE_H,
          w: cellW - MARGIN.left * 0.72 - MARGIN.right * 0.6,
          h: cellH - TITLE_H - AXIS_H - (hasCaption ? CAPTION_H : 0),
        }
        // 兜底：实在放不下就跳过，但**不装作没事** —— 计数报给宿主，
        // resizeCanvas 那边也会把画布撑到 chartMinHeight，正常不会走到这里。
        if (box.w < 60 || box.h < 46) {
          skipped += 1
          return
        }
        drawPanel(g, panel, box)
        if (hasCaption) {
          g.fillStyle = THEME.textDim
          g.font = '10.5px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
          g.textAlign = 'left'
          drawWrappedText(g, panel.caption, cx + 4, cy + cellH - CAPTION_H + 10, cellW - 8, 13, 2)
        }
      })
      return { panels: panels.length, skipped }
    }

    /** 简易换行绘制（按像素宽度切）。 */
    function drawWrappedText(g, text, x, y, maxWidth, lineHeight, maxLines) {
      const words = String(text).split(/(\s+|(?<=[,;，；。、]))/)
      const lines = []
      let current = ''
      for (const w of words) {
        const test = current + w
        if (g.measureText(test).width > maxWidth && current) {
          lines.push(current)
          current = w.trim() === '' ? '' : w
          if (lines.length >= maxLines) break
        } else {
          current = test
        }
      }
      if (lines.length < maxLines && current) lines.push(current)
      lines.forEach((line, i) => g.fillText(line.trim(), x, y + i * lineHeight))
    }

    // =====================================================================
    // 5. 窗口外壳
    // =====================================================================

    const CSS = `
.sciviz-launcher{position:fixed;z-index:2147482400;display:flex;align-items:center;gap:6px;padding:7px 11px;border-radius:999px;
 background:var(--dsw-alias-bg-overlay,#1b2027);color:var(--dsw-alias-label-primary,#e6edf3);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));
 box-shadow:0 6px 20px rgba(0,0,0,.34);cursor:pointer;font:12px/1 ui-sans-serif,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
 user-select:none;transition:transform .12s ease,box-shadow .12s ease}
.sciviz-launcher:hover{transform:translateY(-1px);box-shadow:0 9px 26px rgba(0,0,0,.42)}
.sciviz-launcher .dot{width:7px;height:7px;border-radius:50%;background:#f2a33c;display:none}
.sciviz-launcher.has-new .dot{display:block}
.sciviz-win{position:fixed;z-index:2147482300;display:flex;flex-direction:column;border-radius:12px;overflow:hidden;
 background:var(--dsw-alias-bg-overlay,#191d23);color:var(--dsw-alias-label-primary,#e6edf3);
 border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:0 18px 50px rgba(0,0,0,.52);
 font:12px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.sciviz-win[hidden]{display:none}
/* 主面板模式：铺满 shell 给的位置，去掉浮窗的外观（圆角/阴影/边框/固定定位） */
.sciviz-root-embedded{width:100%;height:100%;display:block}
.sciviz-win-embedded{position:relative;z-index:auto;width:100%;height:100%;border:0;border-radius:0;box-shadow:none;
 background:var(--dsw-alias-bg-base,#141821)}
.sciviz-win-embedded .sciviz-head{cursor:default}
.sciviz-win-embedded .sciviz-act[data-act="min"],
.sciviz-win-embedded .sciviz-act[data-act="close"],
.sciviz-win-embedded .sciviz-resize{display:none}
.sciviz-page-host{width:100%;height:100%;min-height:0;overflow:hidden}
/* 输入框工具行左侧的入口按钮：跟着 composer 的字号与配色走 */
.sciviz-compose-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border-radius:8px;
 border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:transparent;
 color:var(--dsw-alias-label-secondary,#9fb0c0);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
.sciviz-compose-btn:hover{color:var(--dsw-alias-label-primary,#e6edf3);background:var(--dsw-alias-fill-l1,rgba(255,255,255,.08))}
.sciviz-compose-btn .lbl{font-size:12px}
.sciviz-head{display:flex;align-items:center;gap:10px;padding:8px 10px;cursor:move;flex:none;
 background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.015));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}
.sciviz-title{display:flex;align-items:center;gap:7px;font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:44%}
.sciviz-title .sub{font-weight:400;color:var(--dsw-alias-label-secondary,#8fa3b8);font-size:11px}
.sciviz-tabs{display:flex;gap:2px;margin-left:auto;background:rgba(255,255,255,.05);border-radius:8px;padding:2px}
.sciviz-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8fa3b8);padding:4px 10px;border-radius:6px;cursor:pointer;
 font:inherit;font-size:11.5px;white-space:nowrap}
.sciviz-tab:hover{color:var(--dsw-alias-label-primary,#e6edf3)}
.sciviz-tab.on{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#e6edf3)}
.sciviz-act{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8fa3b8);width:24px;height:24px;border-radius:6px;cursor:pointer;font:inherit;font-size:14px;line-height:1}
.sciviz-act:hover{background:rgba(255,255,255,.1);color:var(--dsw-alias-label-primary,#e6edf3)}
.sciviz-act.on{background:rgba(76,154,255,.22);color:#9cc7ff}
/* 「返回对话」只在主面板模式出现：浮窗有自己的 ✕ */
.sciviz-back{display:none;width:auto;min-width:0;padding:0 10px;font-size:11.5px;white-space:nowrap;
 border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16))!important;gap:4px}
.sciviz-win-embedded .sciviz-back{display:inline-flex;align-items:center}
/* 导出按钮：文字比图形更好认 */
.sciviz-export{width:auto;min-width:0;padding:0 7px;font-size:10.5px;font-weight:600;letter-spacing:.02em;
 border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14))}
/* 「独立窗口」是有文字的动作按钮，不是方形图标按钮：
   不加 nowrap 的话 24px 宽会把四个字压成竖排（踩过）。给它一点强调色，和纯图标区分开。 */
.sciviz-window{width:auto;min-width:0;padding:0 9px;font-size:11px;white-space:nowrap;
 display:inline-flex;align-items:center;gap:4px;
 border:1px solid rgba(76,154,255,.35);background:rgba(76,154,255,.14);color:#dceaff}
.sciviz-window:hover{background:rgba(76,154,255,.26);border-color:rgba(76,154,255,.55);color:#fff}
.sciviz-toast{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:5;
 background:rgba(12,15,19,.92);color:#e6edf3;border:1px solid rgba(255,255,255,.16);border-radius:8px;
 padding:6px 12px;font-size:11.5px;pointer-events:none;opacity:0;transition:opacity .18s}
.sciviz-toast.on{opacity:1}
.sciviz-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
/* 必须显式写 [hidden]：下面这些类设了 display（flex/block），类选择器会压过 UA 样式表里的
   [hidden]{display:none}，于是 JS 里所有 el.hidden = true 全部形同虚设。踩过两次：
   · 技能库面板在每个标签页上都显示着，把画布挤到只剩一半高度（实测 257px，
     3 个图表面板因此全被跳过，只剩标题）；
   · 浮窗与入口药丸关不掉 —— 就是「打开了退不出去」的老毛病。
   注意：这段是模板字符串，注释里不能出现反引号。 */
.sciviz-canvasbox[hidden],.sciviz-skills[hidden],.sciviz-bar[hidden],
.sciviz-win[hidden],.sciviz-launcher[hidden],.sciviz-root-embedded[hidden]{display:none}
.sciviz-canvasbox{position:relative;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden}
.sciviz-canvasbox canvas{display:block;width:100%;height:100%}
.sciviz-toolbar{position:absolute;top:8px;left:8px;display:flex;flex-wrap:wrap;gap:4px;max-width:calc(100% - 16px)}
.sciviz-chip{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:rgba(10,13,17,.72);color:var(--dsw-alias-label-secondary,#a9b6c4);
 padding:3px 8px;border-radius:999px;cursor:pointer;font:inherit;font-size:11px;backdrop-filter:blur(6px)}
.sciviz-chip:hover{color:#fff;border-color:rgba(255,255,255,.3)}
.sciviz-chip.on{background:rgba(76,154,255,.28);border-color:rgba(76,154,255,.5);color:#dceaff}
.sciviz-legend{position:absolute;left:10px;bottom:8px;display:flex;flex-wrap:wrap;gap:8px;max-width:calc(100% - 20px);
 background:rgba(10,13,17,.66);border-radius:8px;padding:5px 8px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#a9b6c4)}
.sciviz-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.sciviz-foot{flex:none;padding:7px 11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));
 color:var(--dsw-alias-label-secondary,#8fa3b8);font-size:11px;max-height:76px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.sciviz-foot b{color:var(--dsw-alias-label-primary,#dbe4ee);font-weight:600}
/* 可操作条：结构页与图表页各一条，让面板自己就能干活，不用等模型推 */
.sciviz-bar{flex:none;display:flex;align-items:center;gap:6px;padding:6px 10px;
 border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));background:rgba(255,255,255,.022)}
.sciviz-bar[hidden]{display:none}
.sciviz-bar-col{flex-direction:column;align-items:stretch}
.sciviz-bar .row1{display:flex;align-items:center;gap:6px}
.sciviz-bar .lbl{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#8fa3b8)}
.sciviz-bar input,.sciviz-bar select,.sciviz-bar textarea{
 background:rgba(255,255,255,.06);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));
 color:inherit;border-radius:6px;padding:4px 7px;font:inherit;font-size:11.5px;outline:none}
.sciviz-bar input:focus,.sciviz-bar textarea:focus,.sciviz-bar select:focus{border-color:rgba(76,154,255,.55)}
.sciviz-bar .src{flex:1;min-width:80px}
.sciviz-bar .title{width:150px;flex:none}
.sciviz-bar .data{width:100%;box-sizing:border-box;margin-top:5px;resize:vertical;min-height:26px;max-height:150px;
 font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;transition:min-height .12s}
/* 平时只占一行，把高度让给画布；点进去要粘贴数据时才展开 */
.sciviz-bar .data:focus{min-height:84px}
.sciviz-bar .go{flex:none;border:1px solid rgba(76,154,255,.45);background:rgba(76,154,255,.22);color:#dceaff;
 border-radius:6px;padding:4px 12px;font:inherit;font-size:11.5px;cursor:pointer}
.sciviz-bar .go:hover{background:rgba(76,154,255,.32)}
.sciviz-bar .demo{flex:none;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:var(--dsw-alias-label-secondary,#9fb0c0);
 padding:3px 9px;border-radius:6px;cursor:pointer;font:inherit;font-size:11px}
.sciviz-bar .demo:hover{color:#dceaff;border-color:rgba(76,154,255,.5)}
.sciviz-bar .go:disabled{opacity:.5;cursor:default}
.sciviz-bar .tip{flex:none;font-size:11px;color:#f2a33c}
.sciviz-drop{outline:2px dashed rgba(76,154,255,.65);outline-offset:-6px}
.sciviz-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;
 background:linear-gradient(135deg,transparent 46%,rgba(255,255,255,.32) 50%,transparent 54%,transparent 66%,rgba(255,255,255,.32) 70%,transparent 74%)}
.sciviz-skills{flex:1;min-height:0;display:flex}
.sciviz-skills .list{width:47%;min-width:230px;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}
.sciviz-search{flex:none;padding:8px;display:flex;flex-direction:column;gap:6px}
.sciviz-search input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));
 color:inherit;border-radius:7px;padding:6px 9px;font:inherit;font-size:12px;outline:none}
.sciviz-search input:focus{border-color:rgba(76,154,255,.55)}
.sciviz-filters{display:flex;flex-wrap:wrap;gap:4px;max-height:74px;overflow:auto}
.sciviz-fchip{border:1px solid transparent;background:rgba(255,255,255,.06);color:var(--dsw-alias-label-secondary,#9fb0c0);
 border-radius:999px;padding:2px 8px;font:inherit;font-size:10.5px;cursor:pointer}
.sciviz-fchip.on{background:rgba(76,154,255,.26);color:#dceaff;border-color:rgba(76,154,255,.45)}
.sciviz-rows{flex:1;overflow:auto;padding:0 4px 8px}
.sciviz-row{padding:6px 8px;border-radius:7px;cursor:pointer;display:flex;gap:8px;align-items:flex-start}
.sciviz-row:hover{background:rgba(255,255,255,.06)}
.sciviz-row.on{background:rgba(76,154,255,.18)}
.sciviz-row .badge{flex:none;font-size:9.5px;padding:2px 5px;border-radius:4px;margin-top:1px;
 background:rgba(90,200,168,.2);color:#8fe0c8}
.sciviz-row .badge.lib{background:rgba(167,139,250,.2);color:#c4b1ff}
.sciviz-row .nm{font-weight:600;font-size:11.5px;word-break:break-all}
.sciviz-row .zh{color:var(--dsw-alias-label-secondary,#93a3b4);font-size:11px;margin-top:1px}
.sciviz-detail{flex:1;min-width:0;display:flex;flex-direction:column}
.sciviz-detail .dh{flex:none;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}
.sciviz-detail .dh h4{margin:0 0 4px;font-size:13px}
.sciviz-detail .meta{color:var(--dsw-alias-label-secondary,#8fa3b8);font-size:10.5px;word-break:break-all}
.sciviz-detail .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
.sciviz-detail pre{flex:1;overflow:auto;margin:0;padding:10px 12px;white-space:pre-wrap;word-break:break-word;
 font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#c8d3df}
.sciviz-empty{padding:22px;color:var(--dsw-alias-label-secondary,#8fa3b8);text-align:center}
.sciviz-table{width:100%;border-collapse:collapse;font-size:11px}
.sciviz-table th,.sciviz-table td{border-bottom:1px solid rgba(255,255,255,.08);padding:3px 6px;text-align:left}
.sciviz-table th{color:#9fb0c0;font-weight:600}
`

    const WIN_MIN_W = 420
    const WIN_MIN_H = 300

    /** 读/写窗口几何与偏好。 */
    function loadPrefs() {
      try {
        return JSON.parse(window.localStorage.getItem('dsh-sci-viz:prefs') || '{}') || {}
      } catch {
        return {}
      }
    }

    function savePrefs(prefs) {
      try {
        window.localStorage.setItem('dsh-sci-viz:prefs', JSON.stringify(prefs))
      } catch {
        /* 隐私模式下忽略 */
      }
    }

    /**
     * 创建整个可视化窗口（launcher + window）。
     * @returns {{destroy: Function, push: Function, setTab: Function}}
     */
    /**
     * 把粘贴进来的文本解析成检验参数。
     *
     * 规则刻意做得宽容，因为「从 Excel 复制一列/一张表粘进来」是最常见的动作：
     *   · `#` 或 `//` 开头的行是注释
     *   · 一行的分隔符可以是制表符、逗号、分号或空白
     *   · 行首非数字 → 那一行是「标签 + 数值」= 一组
     *   · 全数字：一列 → values；两列 → 回归的 x/y（其它检验按每列一组）；
     *     矩阵且 kind=chisq → 计数表；矩阵但不是 chisq → 每列一组
     * @returns {{groups?: Array, values?: number[], x?: number[], y?: number[], table?: number[][]}}
     */
    function parseDataTable(text, kind) {
      const rawLines = String(text || '').split(/\r?\n/)
      const isNum = (s) => /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)
      const rows = []
      const errors = []
      rawLines.forEach((raw, idx) => {
        const line = raw.trim()
        if (!line || line.startsWith('#') || line.startsWith('//')) return
        const tokens = line.split(/[\t,;\s]+/).filter((s) => s !== '')
        // 标签 = 第一个数字之前的全部内容，所以「对照组 8.2 …」和「野生型 H37Rv 8.2 …」都能认；
        // 只按制表符切会把「8.2 7.9 8.5」当成一整个格子，这正是第一版踩的坑。
        const firstNum = tokens.findIndex(isNum)
        if (firstNum < 0) {
          errors.push(`第 ${idx + 1} 行没找到数字：${line.slice(0, 40)}`)
          return
        }
        const tail = tokens.slice(firstNum)
        const bad = tail.find((t) => !isNum(t))
        if (bad !== undefined) {
          errors.push(`第 ${idx + 1} 行里「${bad}」不是数字（数值之间用空格、逗号或制表符分开）`)
          return
        }
        rows.push({
          label: firstNum > 0 ? tokens.slice(0, firstNum).join(' ') : null,
          nums: tail.map(Number),
        })
      })
      if (errors.length) throw new Error(errors[0])
      if (rows.length === 0) throw new Error('还没有数据 —— 把它粘贴到下面的框里')

      // 有标签 → 分组
      if (rows.some((r) => r.label !== null)) {
        return {
          groups: rows.map((r, i) => ({ label: r.label ?? `组${i + 1}`, values: r.nums })),
        }
      }

      const width = rows[0].nums.length
      const sameWidth = rows.every((r) => r.nums.length === width)

      if (kind === 'regression') {
        if (!sameWidth || width !== 2) throw new Error('线性回归要两列数字：第一列 x，第二列 y')
        return { x: rows.map((r) => r.nums[0]), y: rows.map((r) => r.nums[1]) }
      }
      if (kind === 'chisq') {
        if (!sameWidth || width < 2) throw new Error('卡方检验要一张计数表：每行同样多的整数（至少 2 列）')
        return { table: rows.map((r) => r.nums) }
      }
      if (kind === 'power') {
        const flat = rows.flatMap((r) => r.nums)
        return { d: flat[0] ?? 0.5, power: flat[1] ?? 0.8, alpha: flat[2] ?? 0.05 }
      }
      if (width === 1) return { values: rows.map((r) => r.nums[0]) }

      // 多列无标签：按列分组（粘贴一张表，每列一组，符合直觉）
      return {
        groups: Array.from({ length: width }, (_, j) => ({
          label: `组${j + 1}`,
          values: rows.map((r) => r.nums[j]).filter(Number.isFinite),
        })),
      }
    }

    const STAT_LABELS = {
      ttest: 't 检验', anova: '单因素方差分析', normal: '正态分布', descriptives: '描述统计',
      regression: '线性回归', chisq: '卡方检验', power: '功效 / 样本量',
    }


    /**
     * 创建可视化面板。
     *
     * 两种承载方式共用这一份实现：
     *   · `embedded: true` —— 作为 DSH 主面板的一页（sidebar.panellist 图标 + main 键位槽），
     *     铺满可用空间，不拖拽、不缩放、没有关闭按钮。
     *   · `embedded: false` —— 浮窗（同「蓝色大肥鱼」桌宠那套 body 挂载），带启动药丸、
     *     拖拽、缩放、最小化。作为槽位注册不可用时的退路。
     *
     * @param {{embedded?: boolean, onNewDoc?: Function}} [opts]
     */
    function createPanel(opts) {
      const embedded = !!(opts && opts.embedded)
      const onNewDoc = (opts && opts.onNewDoc) || null
      /** 浮窗模式下是否自带启动药丸；常驻入口已经有一个药丸时传 false 避免出现两个。 */
      const withLauncher = !embedded && !(opts && opts.withLauncher === false)
      const prefs = loadPrefs()
      const root = document.createElement('div')
      root.className = embedded ? 'sciviz-root sciviz-root-embedded' : 'sciviz-root'

      const launcher = document.createElement('div')
      launcher.className = 'sciviz-launcher'
      launcher.innerHTML = '<span>🔬</span><span>科研可视化</span><span class="dot"></span>'
      launcher.title = '打开科研可视化窗口（三维结构 / 统计图表 / 技能库）'

      const win = document.createElement('div')
      win.className = embedded ? 'sciviz-win sciviz-win-embedded' : 'sciviz-win'
      win.innerHTML = `
<div class="sciviz-head">
  <div class="sciviz-title"><span>🔬</span><span class="t">科研可视化</span><span class="sub"></span></div>
  <div class="sciviz-tabs">
    <button class="sciviz-tab" data-tab="structure">三维结构</button>
    <button class="sciviz-tab" data-tab="chart">统计图表</button>
    <button class="sciviz-tab" data-tab="genome">基因组</button>
    <button class="sciviz-tab" data-tab="skills">技能库</button>
  </div>
  <button class="sciviz-act" data-act="spin" title="自动旋转">↻</button>
  <button class="sciviz-act" data-act="reset" title="重置视角">⌖</button>
  <button class="sciviz-act sciviz-export" data-act="png" title="把当前画面导出为 PNG（2 倍分辨率，可直接放进报告）">PNG</button>
  <button class="sciviz-act sciviz-export" data-act="svg" title="导出为 SVG 矢量图（投稿用，可无损放大、可在 Illustrator / Inkscape 里改）">SVG</button>
  <button class="sciviz-act sciviz-export" data-act="csv" title="把当前图表的数据导出为 CSV">CSV</button>
  <button class="sciviz-act sciviz-window" data-act="window" title="在独立窗口里打开 —— 浏览器新窗口，可以拖到聊天框旁边，或全屏放到第二块屏">⧉<span>独立窗口</span></button>
  <button class="sciviz-act" data-act="autojump" title="新图自动跳转到这里">⇥</button>
  <button class="sciviz-act" data-act="min" title="收起">—</button>
  <button class="sciviz-act" data-act="close" title="关闭">✕</button>
  <button class="sciviz-act sciviz-back" data-act="back" title="返回对话（Esc）">← 返回对话</button>
</div>
<div class="sciviz-body">
  <!-- 输入条放在画布**上面**：主面板模式下画布会撑满高度，放在下面的条会被挤出视野，
       用户根本看不到「可以自己粘数据」这件事。 -->
  <div class="sciviz-bar" data-pane="openbar">
    <span class="lbl">打开结构</span>
    <input class="src" type="text" placeholder="本地路径 / 4 位 PDB ID / 网址 —— 也可以把 .pdb .cif 文件直接拖进画布" />
    <button class="go">打开</button>
    <span class="tip"></span>
  </div>
  <div class="sciviz-bar sciviz-bar-col" data-pane="statsbar" hidden>
    <div class="row1">
      <span class="lbl">数据</span>
      <select class="kind">
        <option value="ttest">t 检验</option>
        <option value="anova">单因素 ANOVA</option>
        <option value="normal">正态分布</option>
        <option value="descriptives">描述统计</option>
        <option value="regression">线性回归</option>
        <option value="chisq">卡方检验</option>
        <option value="power">功效 / 样本量</option>
        <option value="survival">生存曲线（KM）</option>
        <option value="roc">ROC 曲线</option>
      </select>
      <input class="title" type="text" placeholder="标题（可空）" />
      <button class="go">运行</button>
      <span class="tip"></span>
    </div>
    <textarea class="data" rows="1" spellcheck="false"
      placeholder="把它粘贴进来，点运行：每行一组「标签 数值 …」→ 分组比较（t 检验 / ANOVA）；纯数字一列 → 单样本 / 描述统计；两列 → 线性回归；矩阵 → 卡方；生存曲线填「时间 事件(1/0)」，每组一行样本名（点这里会展开，# 开头的行忽略）"></textarea>
  </div>
  <div class="sciviz-bar sciviz-bar-col" data-pane="genomebar" hidden>
    <div class="row1">
      <span class="lbl">基因组</span>
      <select class="kind">
        <option value="phylo">进化树</option>
        <option value="msa">序列比对</option>
        <option value="enrich">GO/KEGG 富集</option>
        <option value="genome">全基因组变异</option>
        <option value="coverage">测序覆盖度</option>
        <option value="volcano">差异表达火山图</option>
        <option value="heatmap">表达热图</option>
        <option value="logo">序列 Logo</option>
        <option value="network">基因互作网络</option>
      </select>
      <input class="title" type="text" placeholder="标题（可空）" />
      <button class="go">运行</button>
      <button class="demo" title="填入一段能跑的示例数据 —— 想试试这个类型是干什么的，点它再点运行">示例</button>
      <span class="tip"></span>
    </div>
    <textarea class="data" rows="1" spellcheck="false"
      placeholder="把数据粘贴进来，选好类型点运行（Ctrl+Enter 直接跑）：# 开头的行忽略。进化树=Newick；序列比对 / Logo=FASTA（长度须一致）；富集=通路/数量/p/分类；火山图=基因/log2FC/p；覆盖度=「位置 深度」，或用一行样本名分组；热图=「行名 数值…」，首行可写列名；变异=染色体/位置/类型/标签；网络=「源 靶 权重」"></textarea>
  </div>
  <div class="sciviz-canvasbox" data-pane="canvas">
    <canvas></canvas>
    <div class="sciviz-toolbar"></div>
    <div class="sciviz-legend"></div>
  </div>
  <div class="sciviz-skills" data-pane="skills" hidden>
    <div class="list">
      <!-- 搜索框按用户要求去掉：分类与来源芯片足够定位，省下的高度留给画布 -->
      <div class="sciviz-search">
        <div class="sciviz-filters"></div>
      </div>
      <div class="sciviz-rows"></div>
    </div>
    <div class="sciviz-detail">
      <div class="dh"><h4>选一个技能</h4><div class="meta">左侧列表点一下即可看说明、路径与正文摘要</div></div>
      <pre class="sciviz-intro">这 195 个技能**随插件一起分发**（打包在 data/skill-pack.json.gz 里，含完整 SKILL.md 正文）。
插件挂载时会把它们全部注册进 DSH 的技能系统，所以任何机器上装上就能用，不需要本地技能目录。

· 徽章「自带」= 插件带的；「本地」= 本机技能目录里额外加的（你自己后来丢进去的会出现在这里）。
· 分类、中文说明、标签、使用权重都随包走。
· scripts / references 等附属资源没打进包（源目录合计约 59 MB）；本机若正好有源目录，
  详情里会标出路径，可以直接去取。

想让某个技能跑起来，在对话里说一声即可（例如「用 pymol 技能把这个结构渲染一下」）。</pre>
    </div>
  </div>
  <div class="sciviz-foot"></div>
  <div class="sciviz-resize"></div>
</div>`

      root.appendChild(win)
      if (withLauncher) root.appendChild(launcher)

      const canvasBox = win.querySelector('[data-pane="canvas"]')
      const canvas = win.querySelector('canvas')
      const toolbar = win.querySelector('.sciviz-toolbar')
      const legendBox = win.querySelector('.sciviz-legend')
      const foot = win.querySelector('.sciviz-foot')
      const skillsPane = win.querySelector('[data-pane="skills"]')
      // 两条可操作条：结构页的「打开」与图表页的「粘贴数据 + 运行」
      const openBar = win.querySelector('[data-pane="openbar"]')
      const openInput = openBar.querySelector('.src')
      const openBtn = openBar.querySelector('.go')
      const openTip = openBar.querySelector('.tip')
      const statsBar = win.querySelector('[data-pane="statsbar"]')
      const statsKind = statsBar.querySelector('.kind')
      const statsTitle = statsBar.querySelector('.title')
      const statsData = statsBar.querySelector('.data')
      const statsBtn = statsBar.querySelector('.go')
      const statsTip = statsBar.querySelector('.tip')
      // 基因组页的输入条：粘贴 Newick / FASTA / TSV 就能自己出图，不必回头找 AI
      const genomeBar = win.querySelector('[data-pane="genomebar"]')
      const genomeKind = genomeBar.querySelector('.kind')
      const genomeTitle = genomeBar.querySelector('.title')
      const genomeData = genomeBar.querySelector('.data')
      const genomeBtn = genomeBar.querySelector('.go')
      const genomeDemo = genomeBar.querySelector('.demo')
      const genomeTip = genomeBar.querySelector('.tip')
      const rowsBox = win.querySelector('.sciviz-rows')
      const filtersBox = win.querySelector('.sciviz-filters')
      // 搜索框已去掉：查询词仍保留在 state.skillFilter.q 里（工具推的 doc.query 会写进去），
      // 但没有输入控件 → 过滤只按分类与来源芯片走。
      const searchInput = { value: '' }
      void searchInput
      const detailBox = win.querySelector('.sciviz-detail')
      const titleText = win.querySelector('.sciviz-title .t')
      const titleSub = win.querySelector('.sciviz-title .sub')
      const g = canvas.getContext('2d')

      // ---- 几何 ----
      const geom = {
        w: clamp(prefs.w || 900, WIN_MIN_W, window.innerWidth - 20),
        h: clamp(prefs.h || 620, WIN_MIN_H, window.innerHeight - 20),
        x: prefs.x === undefined ? Math.max(12, window.innerWidth - (prefs.w || 900) - 24) : prefs.x,
        y: prefs.y === undefined ? 70 : prefs.y,
        lx: prefs.lx === undefined ? window.innerWidth - 150 : prefs.lx,
        ly: prefs.ly === undefined ? window.innerHeight - 96 : prefs.ly,
        open: prefs.open !== false,
        collapsed: false,
        tab: prefs.tab || 'skills',
        autoJump: prefs.autoJump !== false,
      }
      autojumpRef.current = geom.autoJump
      const persist = () => {
        savePrefs({
          w: geom.w, h: geom.h, x: geom.x, y: geom.y, lx: geom.lx, ly: geom.ly,
          open: geom.open, tab: geom.tab, autoJump: geom.autoJump,
        })
      }
      const applyGeom = () => {
        if (embedded) return // 主面板模式：尺寸完全交给 shell 的布局
        win.style.width = `${geom.w}px`
        win.style.height = `${geom.h}px`
        win.style.left = `${clamp(geom.x, 0, Math.max(0, window.innerWidth - 120))}px`
        win.style.top = `${clamp(geom.y, 0, Math.max(0, window.innerHeight - 60))}px`
        if (withLauncher) {
          launcher.style.left = `${clamp(geom.lx, 0, window.innerWidth - 130)}px`
          launcher.style.top = `${clamp(geom.ly, 0, window.innerHeight - 40)}px`
        }
      }

      // ---- 状态 ----
      const state = {
        // 每个标签页各留一份文档：切回「三维结构」还能看到上次那个结构，
        // 而不是只剩最后推来的那张图（早先只存一份，切标签就变空画布）
        docs: { structure: null, chart: null, genome: null },
        rev: 0,
        structure: null,
        skills: null,
        skillFilter: { q: '', cat: '', layer: '' },
        selectedSkill: null,
        spin: false,
        raf: 0,
        timer: 0,
        newBadge: false,
      }

      /** 当前标签页对应的文档。 */
      const activeDoc = () => (geom.tab === 'structure' ? state.docs.structure
        : geom.tab === 'chart' ? state.docs.chart
          : geom.tab === 'genome' ? state.docs.genome : null)

      const setVisible = (open) => {
        if (embedded) return // 主面板模式：显隐由 shell 的侧边栏选择决定
        geom.open = open
        win.hidden = !open
        if (withLauncher) launcher.hidden = open
        if (open) state.newBadge = false
        if (withLauncher) launcher.classList.toggle('has-new', state.newBadge)
        persist()
      }

      /** 把窗口切到某个标签页。 */
      const setTab = (tab) => {
        geom.tab = tab
        for (const btn of win.querySelectorAll('.sciviz-tab')) btn.classList.toggle('on', btn.dataset.tab === tab)
        const isSkills = tab === 'skills'
        canvasBox.hidden = isSkills
        skillsPane.hidden = !isSkills
        // 导出按钮按标签页显隐：结构导出 PNG、图表两种都能导
        const pngBtn = win.querySelector('.sciviz-act[data-act="png"]')
        const csvBtn = win.querySelector('.sciviz-act[data-act="csv"]')
        const svgBtn = win.querySelector('.sciviz-act[data-act="svg"]')
        if (pngBtn) pngBtn.style.display = isSkills ? 'none' : ''
        if (svgBtn) svgBtn.style.display = isSkills ? 'none' : ''
        const winBtn = win.querySelector('.sciviz-act[data-act="window"]')
        if (winBtn) winBtn.style.display = isSkills ? 'none' : ''
        if (csvBtn) csvBtn.style.display = tab === 'chart' ? '' : 'none'
        // 可操作条跟着标签页走：结构页能打开、图表页能跑统计
        openBar.hidden = tab !== 'structure'
        statsBar.hidden = tab !== 'chart'
        genomeBar.hidden = tab !== 'genome'
        if (isSkills && !state.skills) void loadSkills()
        updateTitle()
        rebuildToolbar()
        resizeCanvas()
        persist()
        schedule()
      }

      /** 标题栏跟着当前标签页的文档走。 */
      function updateTitle() {
        const doc = activeDoc()
        if (!doc) {
          titleText.textContent = geom.tab === 'skills' ? '技能库' : '科研可视化'
          titleSub.textContent = geom.tab === 'skills'
            ? (state.skills ? `共 ${state.skills.counts.total} 个技能` : '正在读取…')
            : ''
          return
        }
        titleText.textContent = doc.title || '科研可视化'
        titleSub.textContent = doc.kind === 'structure'
          ? `${(doc.stats && doc.stats.chains) || 0} 链 · ${(doc.stats && doc.stats.atoms) || 0} 原子`
          : doc.kind === 'chart' ? `${(doc.panels || []).length} 个面板` : ''
      }

      // ---- 导出 ----
      /** 文件名：标题 → 安全字符 + 时间戳。 */
      const safeName = (title, ext) => {
        const base = String(title || 'sci-viz')
          .replace(/[\\/:*?"<>|\s]+/g, '_')
          .replace(/_+/g, '_')
          .slice(0, 60) || 'sci-viz'
        const t = new Date()
        const stamp = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}`
        return `${base}_${stamp}.${ext}`
      }

      const download = (blob, filename) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 4000)
      }

      /** 提示条：导出成功/失败都给一句人话。 */
      let toastTimer = 0
      const toast = (text) => {
        let el = win.querySelector('.sciviz-toast')
        if (!el) {
          el = document.createElement('div')
          el.className = 'sciviz-toast'
          win.querySelector('.sciviz-body').appendChild(el)
        }
        el.textContent = text
        el.classList.add('on')
        window.clearTimeout(toastTimer)
        toastTimer = window.setTimeout(() => el.classList.remove('on'), 2400)
      }

      /**
       * 导出当前画面为 PNG。
       *
       * 用离屏 canvas 按 scale 倍重画一遍，而不是放大现有像素 —— 结构/图表的绘制函数
       * 本来就接收 (g, doc, width, height)，换个尺寸就是重新排版，线宽、字号、球体半径
       * 全部按新尺寸重算，所以 2 倍图是真正的矢量级清晰度，放进论文/报告够用。
       */
      /** 把当前画面导成 SVG（矢量，投稿用）。录制与 PNG 走同一批绘制调用。 */
      function exportSvg() {
        const doc = activeDoc()
        if (!doc || geom.tab === 'skills') {
          toast('当前没有可导出的画面')
          return
        }
        const w = Math.max(200, Math.round(canvasW))
        const h = Math.max(200, Math.round(canvasH))
        try {
          const rec = createSvgRecorder(w, h)
          if (doc.kind === 'structure' && state.structure) {
            const keep = state.structure._fitScale
            state.structure._fitScale = undefined
            paintStructure(rec, state.structure, w, h)
            state.structure._fitScale = keep
          } else if (doc.kind === 'chart') {
            paintChart(rec, doc, w, h)
          } else {
            toast('当前没有可导出的画面')
            return
          }
          const svg = rec.toSvg()
          const filename = safeName(doc.title, 'svg')
          download(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), filename)
          toast(`已导出 ${filename}（矢量，${Math.round(svg.length / 1024)} KB）`)
        } catch (e) {
          toast(`导出失败：${e.message}`)
        }
      }

      /**
       * 把当前可视化放到一个**独立窗口**里。
       *
       * 地址不能从 location 拼：DSH 桌面版的渲染进程跑在 `dsh-app://` 自定义协议下，
       * `new URL('/api/sci-viz/viewer', location.href)` 会得到 `dsh-app://app/api/...` ——
       * 粘进浏览器打不开（用户实测：粘到搜索引擎里去了）。所以向宿主问真地址，
       * 宿主从 DSH_WEB_URL 拿（实测 http://127.0.0.1:19387）。
       *
       * 另外 Electron 对 window.open 是 deny，所以弹窗基本会失败 —— 失败就把地址复制给用户。
       */
      async function openStandalone() {
        let url = ''
        let reachable = false
        try {
          const r = await fetch(`${API}/hello`, { cache: 'no-store' })
          const j = await r.json()
          reachable = true
          url = j?.viewer ?? ''
        } catch {
          reachable = false
        }
        if (!url) {
          // 分两种情况说清楚，别让人去查网络：多半是宿主还是旧版
          toast(reachable
            ? '宿主还是旧版本，重启一次 DSH 后「独立窗口」才可用'
            : '连不上宿主：插件没在运行？')
          return
        }
        let win = null
        try {
          win = window.open(url, 'dsh-sci-viz-panel', 'width=1000,height=780,noopener')
        } catch {
          win = null
        }
        if (win) {
          toast('已在独立窗口打开')
          return
        }
        const done = () => toast(`地址已复制，粘到浏览器打开：${url}`)
        try {
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(url).then(done, () => toast(`独立窗口地址：${url}`))
            return
          }
        } catch {
          /* 落到下面的兜底 */
        }
        toast(`独立窗口地址：${url}`)
      }

      function exportPng(scale = 2) {
        const doc = activeDoc()
        if (!doc || geom.tab === 'skills') {
          toast('当前没有可导出的画面')
          return
        }
        const off = document.createElement('canvas')
        off.width = Math.max(200, Math.round(canvasW * scale))
        off.height = Math.max(200, Math.round(canvasH * scale))
        const og = off.getContext('2d')
        try {
          if (doc.kind === 'structure' && state.structure) {
            const keep = state.structure._fitScale
            state.structure._fitScale = undefined // 别把平滑值带进新尺寸，否则首帧会偏小
            paintStructure(og, state.structure, off.width, off.height)
            state.structure._fitScale = keep
          } else if (doc.kind === 'chart') {
            paintChart(og, doc, off.width, off.height)
          } else {
            toast('当前没有可导出的画面')
            return
          }
        } catch (e) {
          toast(`导出失败：${e.message}`)
          return
        }
        const filename = safeName(doc.title, 'png')
        if (typeof off.toBlob === 'function') {
          off.toBlob((blob) => {
            if (!blob) {
              toast('导出失败：canvas 没有产出数据')
              return
            }
            download(blob, filename)
            toast(`已导出 ${filename}（${off.width}×${off.height}）`)
          }, 'image/png')
        } else {
          toast('当前环境不支持导出 PNG')
        }
      }

      /** 把图表数据导出成 CSV（Excel / GraphPad 都能直接打开）。 */
      function exportCsv() {
        const doc = activeDoc()
        if (!doc || doc.kind !== 'chart') {
          toast('只有统计图表能导出 CSV')
          return
        }
        const lines = []
        const esc = (v) => {
          const s = String(v === undefined || v === null ? '' : v)
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        }
        lines.push(`# ${doc.title || '图表'}`)
        if (doc.subtitle) lines.push(`# ${doc.subtitle}`)
        lines.push('')

        // 表格优先
        if (doc.table && doc.table.columns && doc.table.rows) {
          if (doc.table.title) lines.push(`# ${doc.table.title}`)
          lines.push(doc.table.columns.map(esc).join(','))
          for (const row of doc.table.rows) lines.push(row.map(esc).join(','))
          lines.push('')
        }

        // 每个面板的原始数据点
        for (const panel of doc.panels || []) {
          const rows = []
          for (const layer of panel.layers || []) {
            if (layer.pts) {
              for (const p of layer.pts) rows.push([panel.title || '', layer.type, p[0], p[1]])
            }
            for (const it of layer.items || []) {
              rows.push([panel.title || '', layer.type, it.label || it.x, it.y,
                it.lo !== undefined ? it.lo : '', it.hi !== undefined ? it.hi : ''])
            }
            for (const b of layer.bins || []) {
              rows.push([panel.title || '', 'bin', `${b.x0}~${b.x1}`, b.density !== undefined ? b.density : b.count, b.count])
            }
          }
          if (!rows.length) continue
          lines.push(`# ${panel.title || '面板'}`)
          lines.push('panel,layer,x,y,lo,hi')
          for (const r of rows) lines.push(r.map(esc).join(','))
          lines.push('')
        }
        if (lines.length <= 3) {
          toast('这份图表没有可导出的数值数据')
          return
        }
        const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
        const filename = safeName(doc.title, 'csv')
        download(blob, filename)
        toast(`已导出 ${filename}`)
      }

      // ---- 面板自己发起的操作（不用等模型推） ----
      /**
       * POST 一个 JSON 并取回结果。
       *
       * 401/404 说明宿主那一半不是这一版（改了 lib/index.js 后，宿主半边按 URL 缓存 ESM，
       * 要重启 DSH 才生效）。这时给一句能照做的话，而不是把 HTTP 码丢给用户。
       */
      async function postJson(path, body) {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json().catch(() => null)
        if (res.status === 401 || res.status === 404) {
          throw new Error('宿主还是旧版本，重启 DSH 后可用')
        }
        if (!res.ok || !data || !data.ok) {
          throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`)
        }
        return data
      }

      /**
       * 本地动作拿到新文档后要同时对齐两处版本号，否则常驻 watcher 会再投递一次同样的
       * 文档，把用户刚拖好的视角重置掉。
       */
      function adoptLocalDoc(data) {
        if (data.rev) {
          state.rev = data.rev
          vizStore.rev = data.rev
        }
        if (data.doc) push(data.doc)
      }

      let opening = false
      /** 打开一个结构（路径 / PDB ID / 网址，或拖进来的文件文本）。 */
      async function openStructure(payload) {
        if (opening) return
        opening = true
        openBtn.disabled = true
        openTip.textContent = '打开中…'
        try {
          const data = await postJson(`${API}/open-structure`, payload)
          openTip.textContent = ''
          adoptLocalDoc(data)
          toast('已打开')
        } catch (e) {
          openTip.textContent = ''
          toast(`打开失败：${e.message}`)
        } finally {
          opening = false
          openBtn.disabled = false
        }
      }

      openBtn.addEventListener('click', () => {
        const source = openInput.value.trim()
        if (!source) {
          openTip.textContent = '先填路径或 PDB ID'
          openInput.focus()
          return
        }
        void openStructure({ source })
      })
      openInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') openBtn.click()
      })

      // 拖放 .pdb / .cif 到画布上直接打开 —— 比让人手打路径实用得多
      const dropTarget = canvasBox
      const stopDefault = (e) => {
        e.preventDefault()
        e.stopPropagation()
      }
      dropTarget.addEventListener('dragover', (e) => {
        stopDefault(e)
        dropTarget.classList.add('sciviz-drop')
      })
      dropTarget.addEventListener('dragleave', (e) => {
        stopDefault(e)
        dropTarget.classList.remove('sciviz-drop')
      })
      dropTarget.addEventListener('drop', async (e) => {
        stopDefault(e)
        dropTarget.classList.remove('sciviz-drop')
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
        if (!file) return
        if (!/\.(pdb|cif|mmcif|ent|txt)$/i.test(file.name)) {
          toast(`不支持的文件类型：${file.name}（要 .pdb / .cif）`)
          return
        }
        try {
          const text = await file.text()
          const format = /\.(cif|mmcif)$/i.test(file.name) ? 'mmcif' : 'pdb'
          await openStructure({ text, format, source: file.name, label: file.name })
        } catch (err) {
          toast(`读取文件失败：${err.message}`)
        }
      })

      let running = false
      /** 跑一次统计：解析粘贴的数据 → POST → 出图。 */
      async function runStats() {
        if (running) return
        const kind = statsKind.value
        running = true
        statsBtn.disabled = true
        statsTip.textContent = '计算中…'
        try {
          const parsed = parseDataTable(statsData.value, kind)
          const args = { kind, ...parsed }
          const title = statsTitle.value.trim()
          if (title) args.title = title
          const data = await postJson(`${API}/run-stats`, args)
          statsTip.textContent = ''
          adoptLocalDoc(data)
          toast('已出图')
        } catch (e) {
          statsTip.textContent = ''
          toast(`运行失败：${e.message}`)
        } finally {
          running = false
          statsBtn.disabled = false
        }
      }

      statsBtn.addEventListener('click', () => void runStats())
      statsKind.addEventListener('change', () => {
        if (!statsTitle.value.trim()) return
        statsTitle.value = ''
      })

      /** 基因组页的「粘贴 → 出图」。解析在宿主做，这里只发原文。 */
      async function runGenomics() {
        if (running) return
        const text = genomeData.value.trim()
        if (!text) {
          genomeTip.textContent = '先粘贴数据'
          return
        }
        running = true
        genomeBtn.disabled = true
        genomeTip.textContent = '解析中…'
        try {
          const body = { kind: genomeKind.value, text }
          const title = genomeTitle.value.trim()
          if (title) body.title = title
          const data = await postJson(`${API}/run-genomics`, body)
          genomeTip.textContent = ''
          adoptLocalDoc(data)
          toast('已出图')
        } catch (e) {
          genomeTip.textContent = ''
          toast(`运行失败：${e.message}`)
        } finally {
          running = false
          genomeBtn.disabled = false
        }
      }
      genomeBtn.addEventListener('click', () => void runGenomics())
      /**
       * 示例按钮：每个类型配一段真能跑通的小数据。
       *
       * 输入框最容易的死法是「打开了但不知道填什么」—— 光看占位符说明没人会去猜格式。
       * 点一下就能看到成品，再改成自己的数据。
       */
      const GENOME_DEMOS = {
        phylo: {
          title: '结核分枝杆菌复合群（示例）',
          text: '((L1:0.021,L2:0.019)96:0.009,(L3:0.019,(L4_H37Rv:0.003,L4_CDC1551:0.004)99:0.008)91:0.012)85:0.020;',
        },
        msa: {
          title: 'katG 片段（示例）',
          text: '>H37Rv\nMSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAALLRWRPASL\n>INH_res_1\nMSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAAFLRWRPASL\n>INH_res_2\nMSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAAFFRWRPASL\n>Bovis\nMSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAALLRWRPASL',
        },
        enrich: {
          title: '耐药株富集（示例）',
          text: '# 通路\t基因数\tp\t分类\nABC transporters\t24\t3.1e-9\tKEGG\nTwo-component system\t18\t8.4e-8\tKEGG\nBacterial secretion system\t11\t2.7e-6\tKEGG\nResponse to antibiotic (GO:0046677)\t15\t3.9e-4\tGO\nDrug transmembrane transport (GO:0006855)\t10\t8.2e-4\tGO\nDNA repair (GO:0006281)\t8\t5.1e-3\tGO',
        },
        genome: {
          title: 'H37Rv 变异（示例）',
          text: '# 染色体\t位置\t类型\t标签\nchr (4.41 Mb)\t7570\tSNP\tgyrA D94G\nchr (4.41 Mb)\t761110\tSNP\trpoB S450L\nchr (4.41 Mb)\t1472764\tINDEL\tembB M306I\nchr (4.41 Mb)\t1673425\tSNP\tpncA W68R\nchr (4.41 Mb)\t2153889\tSNP\tkatG S315T\nchr (4.41 Mb)\t3620000\tCNV',
        },
        coverage: {
          title: 'gyrA 区覆盖度（示例）',
          text: '# 一行样本名，下面是「位置 深度」\nH37Rv (对照)\n0\t120\n400\t135\n800\t118\n1200\t142\n1600\t90\n2000\t128\n2400\t150\n耐药株 A\n0\t95\n400\t88\n800\t102\n1200\t76\n1600\t110\n2000\t95\n2400\t99',
        },
        volcano: {
          title: '耐药 vs 敏感（示例）',
          text: '# 基因\tlog2FC\t-log10(p)\nkatG\t4.8\t7.9\ninhA\t3.6\t6.2\nahpC\t3.1\t4.4\nfabG1\t2.6\t3.8\nrpoB\t0.4\t0.3\ngyrA\t-0.2\t0.2\npncA\t-2.8\t4.1\nembB\t-3.4\t5.2\neis\t-4.1\t6.0\nRv0001\t-0.5\t0.4',
        },
        heatmap: {
          title: '表达热图（示例）',
          text: '# 首行是列名，第一格留空\n\t敏感-1\t敏感-2\t耐药-1\t耐药-2\nkatG\t2.4\t2.0\t-2.0\t-2.5\ninhA\t1.4\t2.0\t-1.7\t-2.1\nahpC\t-1.9\t-2.5\t2.0\t2.5\nfabG1\t-2.1\t-1.6\t2.2\t1.9\nrpoB\t0.3\t0.1\t0.0\t0.5\ngyrA\t0.4\t0.3\t0.4\t0.2',
        },
        logo: {
          title: '启动子区 Logo（示例）',
          text: '>株1\nTTGACATATGATAGC\n>株2\nTTGACATATGATAGC\n>株3\nTTGACATATGATAGT\n>株4\nTTGACATATGATAGC\n>株5\nTTGACATATGATAGC\n>株6\nTTGACATATGATAGC\n>株7\nTTGACATATGATAGG\n>株8\nTTGACATATGATAGC',
        },
        network: {
          title: '耐药基因互作（示例）',
          text: '# 源\t靶\t权重\nkatG\tinhA\t0.95\nkatG\tahpC\t0.72\noxyR\tahpC\t0.88\noxyR\tkatG\t0.61\nrpoB\tsigA\t0.55\nwhiB7\teis\t0.79\nwhiB7\trpoB\t0.44\ngyrA\trrs\t0.35\npncB\tembB\t0.40\nembB\teis\t0.50',
        },
      }
      genomeDemo.addEventListener('click', () => {
        const demo = GENOME_DEMOS[genomeKind.value]
        if (!demo) return
        genomeData.value = demo.text
        genomeTitle.value = demo.title
        genomeTip.textContent = '已填入示例，点运行'
        genomeData.focus()
      })
      genomeKind.addEventListener('change', () => {
        genomeTip.textContent = ''
      })
      genomeData.addEventListener('keydown', (e) => {
        // Ctrl+Enter 直接跑：粘贴大段数据时不用再去点按钮
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault()
          void runGenomics()
        }
      })

      // ---- 顶层按钮 ----
      win.querySelector('.sciviz-head').addEventListener('click', (e) => {
        const tab = e.target.closest('.sciviz-tab')
        if (tab) {
          setTab(tab.dataset.tab)
          return
        }
        const act = e.target.closest('.sciviz-act')
        if (!act) return
        const name = act.dataset.act
        if (name === 'close') setVisible(false)
        else if (name === 'back') goBack()
        else if (name === 'png') exportPng(2)
        else if (name === 'svg') exportSvg()
        else if (name === 'window') void openStandalone()
        else if (name === 'csv') exportCsv()
        else if (name === 'autojump') {
          geom.autoJump = !geom.autoJump
          autojumpRef.current = geom.autoJump
          act.classList.toggle('on', geom.autoJump)
          persist()
        } else if (name === 'min') {
          geom.collapsed = !geom.collapsed
          win.style.height = geom.collapsed ? '40px' : `${geom.h}px`
          act.textContent = geom.collapsed ? '▢' : '—'
        } else if (name === 'spin') {
          state.spin = !state.spin
          act.classList.toggle('on', state.spin)
        } else if (name === 'reset') {
          if (state.structure) {
            state.structure.view.yaw = 0.6
            state.structure.view.pitch = 0.32
            state.structure.view.zoom = 1
            state.structure.view.panX = 0
            state.structure.view.panY = 0
          }
          schedule()
        }
      })

      if (withLauncher) launcher.addEventListener('click', () => setVisible(!geom.open))

      /**
       * 返回对话。主面板模式下这是一个必须有的出口 —— 早先只藏了 ✕ 却没给回程，
       * 选中就出不来了。除了按钮，Esc 也走这条路。
       */
      const goBack = () => goBackToConversation()
      const onKeyDown = (e) => {
        if (!embedded) return
        if (e.key === 'Escape' && !e.target.closest('input,textarea')) {
          e.stopPropagation()
          goBack()
        }
      }
      win.addEventListener('keydown', onKeyDown)
      window.addEventListener('keydown', onKeyDown)

      // ---- 拖拽 / 缩放（仅浮窗模式） ----
      function makeDraggable(handle, target, get, set) {
        let start = null
        handle.addEventListener('pointerdown', (e) => {
          if (e.target.closest('button')) return
          start = { mx: e.clientX, my: e.clientY, ...get() }
          handle.setPointerCapture(e.pointerId)
          e.preventDefault()
        })
        handle.addEventListener('pointermove', (e) => {
          if (!start) return
          set(start.x + (e.clientX - start.mx), start.y + (e.clientY - start.my))
          applyGeom()
        })
        handle.addEventListener('pointerup', (e) => {
          if (!start) return
          start = null
          handle.releasePointerCapture(e.pointerId)
          persist()
        })
        void target
      }

      if (!embedded) {
        makeDraggable(
          win.querySelector('.sciviz-head'), win,
          () => ({ x: geom.x, y: geom.y }),
          (x, y) => {
            geom.x = clamp(x, -geom.w + 120, window.innerWidth - 120)
            geom.y = clamp(y, 0, window.innerHeight - 40)
          },
        )
        if (withLauncher) {
          makeDraggable(
            launcher, launcher,
            () => ({ x: geom.lx, y: geom.ly }),
            (x, y) => {
              geom.lx = clamp(x, 0, window.innerWidth - 130)
              geom.ly = clamp(y, 0, window.innerHeight - 40)
            },
          )
        }

        win.querySelector('.sciviz-resize').addEventListener('pointerdown', (e) => {
          const start = { mx: e.clientX, my: e.clientY, w: geom.w, h: geom.h }
          const move = (ev) => {
            geom.w = clamp(start.w + (ev.clientX - start.mx), WIN_MIN_W, window.innerWidth - 20)
            geom.h = clamp(start.h + (ev.clientY - start.my), WIN_MIN_H, window.innerHeight - 20)
            applyGeom()
            resizeCanvas()
            schedule()
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            persist()
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
          e.preventDefault()
        })
      }

      // ---- 画布尺寸 ----
      let canvasW = 0
      let canvasH = 0
      function resizeCanvas() {
        const rect = canvasBox.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        canvasW = Math.max(80, Math.floor(rect.width))
        const boxH = Math.max(80, Math.floor(rect.height))
        /**
         * 图表有「画得完整」的最小高度。面板矮的时候（实测遇到过 257px 高的画布），
         * 硬把 3 个面板压进去，每个 cell 的绘图区会小于兜底阈值 —— 于是只剩标题、
         * 图全没了，而且不报错。所以这里把画布撑到需要的高度，多余的交给外层滚动。
         */
        const doc = activeDoc()
        const needH = doc && doc.kind === 'chart' ? chartMinHeight(doc, canvasW) : 0
        canvasH = Math.max(boxH, needH)
        canvas.style.height = canvasH > boxH ? `${canvasH}px` : ''
        canvas.width = Math.floor(canvasW * dpr)
        canvas.height = Math.floor(canvasH * dpr)
        g.setTransform ? g.setTransform(dpr, 0, 0, dpr, 0, 0) : g.scale(dpr, dpr)
      }

      // ---- 绘制循环 ----
      /**
       * 绘制回执：内容变了才发，同一个状态不重复打扰宿主。
       * 宿主把它放在 /health 的 clientPaint 里，于是「空白画布」到底是没文档、
       * 画布 0×0、标签页不对，还是绘制抛异常，一眼可辨。
       */
      let lastPaintJson = ''
      function reportPaint(diag) {
        try {
          const json = JSON.stringify(diag)
          if (json === lastPaintJson) return
          lastPaintJson = json
          void fetch(`${API}/client-report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: json,
          }).catch(() => {})
        } catch {
          /* 诊断本身不能影响绘制 */
        }
      }

      function schedule() {
        if (state.raf) return
        state.raf = window.requestAnimationFrame(() => {
          state.raf = 0
          paint()
        })
      }

      function paint() {
        // 每次绘制都留一份「我看到了什么」的回执 —— 面板空白时这是唯一能问出真相的东西：
        // 画布多大、在哪个标签页、拿到文档没有、还是画到一半抛了。
        const diag = {
          tab: geom.tab, open: !!geom.open, collapsed: !!geom.collapsed,
          w: canvasW, h: canvasH, kind: 'none', panels: 0, skipped: 0, needH: 0, err: '',
        }
        try {
          if (!geom.open || geom.collapsed || geom.tab === 'skills') {
            diag.kind = 'skipped'
            return
          }
          if (canvasW === 0) resizeCanvas()
          diag.w = canvasW
          diag.h = canvasH
          const doc = activeDoc()
          diag.kind = doc ? doc.kind : 'none'
          diag.panels = doc && doc.panels ? doc.panels.length : 0
          if (doc && doc.kind === 'structure' && state.structure) {
            if (state.spin) {
              state.structure.view.yaw += 0.0075
            }
            paintStructure(g, state.structure, canvasW, canvasH)
            if (state.spin) schedule()
          } else if (doc && doc.kind === 'chart') {
            diag.needH = chartMinHeight(doc, canvasW)
            const res = paintChart(g, doc, canvasW, canvasH)
            if (res && res.skipped) diag.skipped = res.skipped
          } else {
            g.clearRect(0, 0, canvasW, canvasH)
            g.fillStyle = '#0f1318'
            g.fillRect(0, 0, canvasW, canvasH)
            g.fillStyle = THEME.textDim
            g.font = '13px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
            g.textAlign = 'center'
            const hint = geom.tab === 'structure'
              ? '还没有结构 —— 让 AI 用 sci_viz_structure 推一个进来'
              : '还没有图表 —— 让 AI 用 sci_viz_stats 跑一次统计'
            g.fillText(hint, canvasW / 2, canvasH / 2)
            g.textAlign = 'left'
          }
        } catch (e) {
          diag.err = `${e?.message} @ ${String(e?.stack ?? '').split('\n')[1]?.trim() ?? ''}`
        } finally {
          reportPaint(diag)
        }
      }

      // ---- 结构交互 ----
      let dragging = null
      canvas.addEventListener('pointerdown', (e) => {
        if (!state.structure) return
        dragging = { x: e.clientX, y: e.clientY, yaw: state.structure.view.yaw, pitch: state.structure.view.pitch, pan: e.shiftKey }
        canvas.setPointerCapture(e.pointerId)
      })
      canvas.addEventListener('pointermove', (e) => {
        if (!dragging || !state.structure) return
        const dx = e.clientX - dragging.x
        const dy = e.clientY - dragging.y
        if (dragging.pan) {
          state.structure.view.panX = state.structure.view.panX + dx - (dragging.lastDx || 0)
          state.structure.view.panY = state.structure.view.panY + dy - (dragging.lastDy || 0)
          dragging.lastDx = dx
          dragging.lastDy = dy
        } else {
          state.structure.view.yaw = dragging.yaw + dx * 0.009
          state.structure.view.pitch = clamp(dragging.pitch + dy * 0.009, -Math.PI / 2, Math.PI / 2)
        }
        schedule()
      })
      canvas.addEventListener('pointerup', (e) => {
        dragging = null
        try {
          canvas.releasePointerCapture(e.pointerId)
        } catch {
          /* 指针已释放 */
        }
      })
      canvas.addEventListener('wheel', (e) => {
        if (!state.structure) return
        e.preventDefault()
        const factor = Math.exp(-e.deltaY * 0.0012)
        state.structure.view.zoom = clamp(state.structure.view.zoom * factor, 0.12, 24)
        schedule()
      }, { passive: false })
      canvas.addEventListener('dblclick', () => {
        if (!state.structure) return
        state.structure.view.zoom = 1
        state.structure.view.panX = 0
        state.structure.view.panY = 0
        schedule()
      })

      // ---- 工具栏 ----
      const STYLE_LABELS = { cartoon: '卡通', trace: '骨架', ballstick: '球棍', spacefill: '空间填充', ligand: '仅配体' }
      const COLOR_LABELS = { chain: '按链', ss: '按二级结构', bfactor: '按 B 因子', resname: '按残基性质', rainbow: '彩虹' }

      function rebuildToolbar() {
        toolbar.innerHTML = ''
        legendBox.innerHTML = ''
        const doc = activeDoc()
        if (!doc) {
          foot.innerHTML = ''
          return
        }
        if (doc.kind === 'structure' && state.structure) {
          const v = state.structure.view
          for (const key of Object.keys(STYLE_LABELS)) {
            const b = document.createElement('button')
            b.className = `sciviz-chip${v.style === key ? ' on' : ''}`
            b.textContent = STYLE_LABELS[key]
            b.onclick = () => {
              v.style = key
              rebuildToolbar()
              schedule()
            }
            toolbar.appendChild(b)
          }
          for (const key of Object.keys(COLOR_LABELS)) {
            const b = document.createElement('button')
            b.className = `sciviz-chip${v.colorBy === key ? ' on' : ''}`
            b.textContent = COLOR_LABELS[key]
            b.onclick = () => {
              v.colorBy = key
              rebuildToolbar()
              schedule()
            }
            toolbar.appendChild(b)
          }
          // N 端 / C 端高亮开关：绿色 = N 端，紫色 = C 端，红色 = 指定位点
          {
            const b = document.createElement('button')
            b.className = `sciviz-chip${v.showTermini ? ' on' : ''}`
            b.textContent = v.showTermini
              ? `末端高亮 ✓（${state.structure.terminusHighlights.length}）`
              : '末端高亮'
            b.title = '高亮每条链的 N 端与 C 端残基（绿 = N 端，紫 = C 端）'
            b.onclick = () => {
              state.structure.setTermini(!v.showTermini)
              savePrefs({ ...loadPrefs(), termini: v.showTermini })
              rebuildToolbar()
              schedule()
            }
            toolbar.appendChild(b)
          }
          const chains = (doc.chains || []).filter((c) => c.residueCount > 0)
          if (chains.length > 1) {
            for (const c of chains.slice(0, 14)) {
              const on = !v.visibleChains || v.visibleChains.indexOf(c.id) >= 0
              const b = document.createElement('button')
              b.className = `sciviz-chip${on ? ' on' : ''}`
              b.textContent = `链 ${c.id}`
              b.onclick = () => {
                const all = chains.map((x) => x.id)
                let next = v.visibleChains ? v.visibleChains.slice() : all.slice()
                if (next.indexOf(c.id) >= 0) next = next.filter((x) => x !== c.id)
                else next.push(c.id)
                v.visibleChains = next.length === all.length ? null : next
                if (v.visibleChains && v.visibleChains.length === 0) v.visibleChains = null
                rebuildToolbar()
                schedule()
              }
              toolbar.appendChild(b)
            }
          }
          if (doc.highlight && doc.highlight.length) {
            for (const h of doc.highlight) {
              const b = document.createElement('button')
              b.className = 'sciviz-chip on'
              b.style.background = 'rgba(255,59,48,.28)'
              b.style.borderColor = 'rgba(255,59,48,.5)'
              b.textContent = `★ ${h.label}`
              toolbar.appendChild(b)
            }
          }
          // 图例
          const v2 = state.structure.view
          const items = v2.colorBy === 'ss'
            ? [['H', 'α 螺旋', SS_COLORS.H], ['E', 'β 折叠', SS_COLORS.E], ['C', '无规卷曲', SS_COLORS.C]]
            : v2.colorBy === 'chain'
              ? (doc.chains || []).filter((c) => c.residueCount > 0).slice(0, 10)
                .map((c) => [c.id, `链 ${c.id}（${c.residueCount} 残基）`, CHAIN_PALETTE[c.index % CHAIN_PALETTE.length]])
              : v2.colorBy === 'resname'
                ? [['h', '疏水', RESIDUE_COLORS.hydrophobic], ['p', '极性', RESIDUE_COLORS.polar],
                  ['a', '酸性', RESIDUE_COLORS.acidic], ['b', '碱性', RESIDUE_COLORS.basic]]
                : v2.colorBy === 'bfactor'
                  ? [['l', '低 B（刚性）', '#3b6fd4'], ['h', '高 B（柔性）', '#e5524f']]
                  : [['n', 'N 端', '#4c9aff'], ['c', 'C 端', '#e56b6f']]
          for (const [, label, color] of items) {
            const span = document.createElement('span')
            span.innerHTML = `<i style="background:${color}"></i>${label}`
            legendBox.appendChild(span)
          }
          // 高亮图例：只列当前真正开着的那几类，避免图例比图还长
          const marks = []
          if (state.structure.siteHighlights.length) {
            marks.push(['位点高亮', HIGHLIGHT_COLORS.site, state.structure.siteHighlights.length])
          }
          if (v2.showTermini) {
            const n = state.structure.terminusHighlights.filter((h) => h.role === 'nterm').length
            const c = state.structure.terminusHighlights.filter((h) => h.role === 'cterm').length
            marks.push(['N 端', HIGHLIGHT_COLORS.nterm, n], ['C 端', HIGHLIGHT_COLORS.cterm, c])
          }
          for (const [label, color, count] of marks) {
            const span = document.createElement('span')
            span.innerHTML = `<i style="background:${color}"></i>${label}${count ? ` ×${count}` : ''}`
            legendBox.appendChild(span)
          }
          foot.innerHTML = `<b>${escapeHtml(doc.title || '')}</b>\n` +
            `拖拽旋转 · 滚轮缩放 · Shift+拖拽平移 · 双击复位` +
            (doc.source && doc.source.path ? `\n来源：${escapeHtml(doc.source.path)}` : '') +
            (doc.view && doc.view.note ? `\n备注：${escapeHtml(doc.view.note)}` : '')
        } else if (doc.kind === 'chart') {
          const bits = []
          for (const p of doc.panels || []) if (p.caption) bits.push(`· ${p.caption}`)
          let html = `<b>${escapeHtml(doc.title || '')}</b>`
          if (doc.table && doc.table.rows) {
            html += '\n' + renderTableHtml(doc.table)
          }
          if (bits.length) html += `\n${bits.map(escapeHtml).join('\n')}`
          foot.innerHTML = html
        } else {
          foot.innerHTML = ''
        }
      }

      function escapeHtml(s) {
        return String(s === undefined || s === null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      }

      function renderTableHtml(table) {
        const head = `<tr>${(table.columns || []).map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`
        const body = (table.rows || []).slice(0, 8)
          .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
          .join('')
        return `<table class="sciviz-table">${head}${body}</table>`
      }

      // ---- 技能库 ----
      async function loadSkills() {
        rowsBox.innerHTML = '<div class="sciviz-empty">正在读取技能目录…</div>'
        try {
          const res = await fetch(`${API}/skills`)
          const data = await res.json()
          if (!data.ok) throw new Error(data.error || '读取失败')
          state.skills = data
          renderFilters()
          renderRows()
        } catch (e) {
          rowsBox.innerHTML = `<div class="sciviz-empty">读取技能库失败：${escapeHtml(e.message)}</div>`
        }
      }

      function renderFilters() {
        const data = state.skills
        if (!data) return
        filtersBox.innerHTML = ''
        const mk = (label, on, onClick) => {
          const b = document.createElement('button')
          b.className = `sciviz-fchip${on ? ' on' : ''}`
          b.textContent = label
          b.onclick = onClick
          filtersBox.appendChild(b)
        }
        mk(`全部 ${data.counts.total}`, !state.skillFilter.cat && !state.skillFilter.layer, () => {
          state.skillFilter.cat = ''
          state.skillFilter.layer = ''
          renderFilters()
          renderRows()
        })
        // 层级芯片改成「来源」：插件自带（随便怎么分发都有）与本机目录里额外加的
        const bundled = data.counts.bundled ?? data.counts.ready ?? 0
        const localN = data.counts.local ?? data.counts.library ?? 0
        mk(`插件自带 ${bundled}`, state.skillFilter.layer === 'bundled', () => {
          state.skillFilter.layer = state.skillFilter.layer === 'bundled' ? '' : 'bundled'
          renderFilters()
          renderRows()
        })
        if (localN > 0) {
          mk(`本地目录 ${localN}`, state.skillFilter.layer === 'local', () => {
            state.skillFilter.layer = state.skillFilter.layer === 'local' ? '' : 'local'
            renderFilters()
            renderRows()
          })
        }
        for (const cat of data.categories || []) {
          const n = data.skills.filter((s) => s.cat === cat.id).length
          if (!n) continue
          mk(`${cat.zh} ${n}`, state.skillFilter.cat === cat.id, () => {
            state.skillFilter.cat = state.skillFilter.cat === cat.id ? '' : cat.id
            renderFilters()
            renderRows()
          })
        }
      }

      function filtered() {
        const data = state.skills
        if (!data) return []
        const q = state.skillFilter.q.trim().toLowerCase()
        return data.skills
          .filter((s) => (state.skillFilter.layer ? s.layer === state.skillFilter.layer : true))
          .filter((s) => (state.skillFilter.cat ? s.cat === state.skillFilter.cat : true))
          .filter((s) => (q
            ? s.id.toLowerCase().indexOf(q) >= 0 ||
              (s.zh || '').toLowerCase().indexOf(q) >= 0 ||
              (s.tags || []).join(' ').toLowerCase().indexOf(q) >= 0 ||
              (s.title || '').toLowerCase().indexOf(q) >= 0
            : true))
          .sort((a, b) => (b.weight - a.weight) || a.id.localeCompare(b.id))
      }

      function renderRows() {
        const list = filtered()
        if (!list.length) {
          rowsBox.innerHTML = '<div class="sciviz-empty">没有匹配的技能</div>'
          return
        }
        const frag = document.createDocumentFragment()
        for (const s of list) {
          const row = document.createElement('div')
          row.className = `sciviz-row${state.selectedSkill && state.selectedSkill.id === s.id ? ' on' : ''}`
          const isLocal = s.layer === 'local'
          // 徽章表示「来源」：自带的随插件走，本地的是你后来加的
          row.innerHTML =
            `<span class="badge${isLocal ? ' lib' : ''}">${isLocal ? '本地' : '自带'}</span>` +
            `<span style="min-width:0"><span class="nm">${escapeHtml(s.id)}</span>` +
            `<div class="zh">${escapeHtml(s.zh || s.title || '')}</div></span>`
          row.onclick = () => selectSkill(s)
          frag.appendChild(row)
        }
        rowsBox.innerHTML = ''
        rowsBox.appendChild(frag)
      }

      async function selectSkill(skill) {
        state.selectedSkill = skill
        renderRows()
        detailBox.innerHTML = '<div class="dh"><h4>正在读取…</h4></div><pre></pre>'
        try {
          const res = await fetch(`${API}/skill?id=${encodeURIComponent(skill.id)}&layer=${encodeURIComponent(skill.layer)}`)
          const data = await res.json()
          if (!data.ok) throw new Error(data.error || '读取失败')
          const pre = detailBox.querySelector('pre')
          // `available` 是后加的字段：老宿主不返回它，此时按「有路径就说明能读正文」兜底，
          // 免得刷新了前端、宿主还没重启时把「能看正文」误报成「未配置技能目录」。
          const hasBody = data.available === undefined ? !!data.path : data.available
          const origin = data.layer === 'local'
            ? '本机技能目录（你自己加的）'
            : '插件自带技能包'
          const resources = data.available && (data.hasScripts || data.hasReferences)
            ? `${data.hasScripts ? ' · 含 scripts/' : ''}${data.hasReferences ? ' · 含 references/' : ''}`
            : ''
          detailBox.innerHTML =
            `<div class="dh"><h4>${escapeHtml(data.title || data.id)}${data.zh ? ` · ${escapeHtml(data.zh)}` : ''}</h4>` +
            `<div class="meta">${escapeHtml(origin)}` +
            (hasBody ? ` · 正文 ${(data.bytes / 1024).toFixed(1)} KB${resources}` : ' · 没有正文') +
            (data.path ? `<br>${escapeHtml(data.path)}` : '') +
            `</div><div class="acts"></div></div>`
          // 一键复制：路径可以直接粘到对话里让我去读，说明可以粘进自己的笔记
          const acts = detailBox.querySelector('.acts')
          const addBtn = (label, title, text) => {
            const b = document.createElement('button')
            b.className = 'sciviz-chip'
            b.textContent = label
            b.title = title
            b.onclick = async () => {
              try {
                await navigator.clipboard.writeText(text)
                toast(`已复制：${label}`)
              } catch {
                toast('复制失败（浏览器未授予剪贴板权限）')
              }
            }
            acts.appendChild(b)
          }
          if (hasBody && data.path) addBtn('复制路径', data.path, data.path)
          addBtn(
            '复制说明',
            '技能名 + 中文说明 + 正文开头',
            `${data.id}\t${data.zh || ''}\t${data.title || ''}\n${String(data.body || '').slice(0, 3000)}`,
          )
          addBtn('让 AI 用它', '把「用这个技能」这句话填进对话的提示', `用 ${data.id} 技能帮我做`)
          const pre2 = document.createElement('pre')
          pre2.textContent = data.body
          detailBox.appendChild(pre2)
          void pre
        } catch (e) {
          detailBox.innerHTML = `<div class="dh"><h4>读取失败</h4><div class="meta">${escapeHtml(e.message)}</div></div><pre></pre>`
        }
      }

      // 搜索框已按用户要求移除 —— 过滤只走分类与来源芯片

      // ---- 文档推送 ----
      /** 收到新文档：存进对应标签页、切过去、更新标题与工具栏。 */
      function push(doc) {
        if (!doc) return
        if (doc.kind === 'structure') {
          state.docs.structure = doc
          state.structure = createStructureView(doc)
          // 末端高亮是用户的一次性选择，记在偏好里；没记录过就沿用宿主给的 doc.view.termini
          const savedTermini = loadPrefs().termini
          if (savedTermini === true) state.structure.setTermini(true)
          else if (savedTermini === false) state.structure.setTermini(false)
          setTab('structure')
          updateTitle()
        } else if (doc.kind === 'chart') {
          // 基因组学文档（section: 'genome'）有自己的标签页；
          // 这样「进化树 / 比对 / 富集 / 变异分布」不会被混进统计图表里找不着。
          if (doc.section === 'genome') {
            state.docs.genome = doc
            setTab('genome')
          } else {
            state.docs.chart = doc
            setTab('chart')
          }
          updateTitle()
        } else if (doc.kind === 'skills') {
          if (!state.skills) void loadSkills()
          state.skillFilter.q = doc.query || ''
          state.skillFilter.cat = doc.category || ''
          state.skillFilter.layer = doc.layer || ''
          setTab('skills')
          titleText.textContent = '技能库'
          titleSub.textContent = `共 ${(doc.counts && doc.counts.total) || 195} 个技能`
          window.setTimeout(() => {
            renderFilters()
            renderRows()
            if (doc.focus) {
              const hit = (state.skills && state.skills.skills || []).find((s) => s.id === doc.focus)
              if (hit) {
                const row = [...rowsBox.querySelectorAll('.sciviz-row')]
                  .find((r) => r.textContent.indexOf(doc.focus) >= 0)
                if (row) row.scrollIntoView({ block: 'center' })
                void hit
              }
            }
          }, 60)
        } else if (doc.kind === 'empty') {
          state.docs.structure = null
          state.docs.chart = null
          state.structure = null
          foot.innerHTML = '<b>已清空</b>'
          rebuildToolbar()
          schedule()
          return
        }
        if (!geom.open) {
          state.newBadge = true
          launcher.classList.add('has-new')
          setVisible(true)
        }
        rebuildToolbar()
        resizeCanvas()
        schedule()
      }

      // ---- 轮询 ----
      let heartbeatAt = 0
      /** 报到：宿主用 /health 判断浏览器半边到底有没有加载成功。 */
      async function heartbeat(force) {
        const now = Date.now()
        if (!force && now - heartbeatAt < 15000) return
        heartbeatAt = now
        try {
          await fetch(`${API}/hello?v=${CLIENT_BUILD}`)
        } catch {
          /* 宿主没起来就算了 */
        }
      }

      async function poll() {
        try {
          const res = await fetch(`${API}/state?rev=${state.rev}`)
          const data = await res.json()
          if (data.changed && data.doc && data.rev !== state.rev) {
            state.rev = data.rev
            push(data.doc)
            if (onNewDoc) onNewDoc(data.doc)
          } else if (data.rev && data.rev !== state.rev && !data.doc) {
            state.rev = data.rev
          }
          await heartbeat(false)
        } catch {
          /* 宿主还没起来时安静重试 */
        } finally {
          state.timer = window.setTimeout(poll, embedded || geom.open ? 1500 : 4200)
        }
      }

      const onResize = () => {
        if (embedded) {
          resizeCanvas()
          schedule()
          return
        }
        applyGeom()
        resizeCanvas()
        schedule()
      }
      window.addEventListener('resize', onResize)

      // ---- 启动 ----
      // 主面板模式下 canvasBox 的尺寸要等布局完成才有值；用 ResizeObserver 跟进
      // （shell 拖动侧边栏 / 改窗口大小都不会触发 window.resize）。
      if (embedded && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          resizeCanvas()
          schedule()
        })
        ro.observe(canvasBox)
        state.resizeObserver = ro
      }
      applyGeom()
      setTab(geom.tab)
      setVisible(geom.open)
      const jumpBtn = win.querySelector('.sciviz-act[data-act="autojump"]')
      if (jumpBtn) {
        jumpBtn.classList.toggle('on', geom.autoJump)
        jumpBtn.title = geom.autoJump ? '新图自动跳转到本面板：开（点击关闭）' : '新图自动跳转：关（点击开启）'
      }
      window.setTimeout(() => {
        resizeCanvas()
        schedule()
      }, 40)
      if (!opts || !opts.managedByWatcher) void poll()

      return {
        root,
        push,
        setTab,
        setVisible,
        isVisible: () => !!geom.open,
        /** 让外部（watcher）把文档推进来，避免两处各自轮询。 */
        accept(doc) {
          if (doc) push(doc)
        },
        destroy() {
          window.clearTimeout(state.timer)
          if (state.raf) window.cancelAnimationFrame(state.raf)
          if (state.resizeObserver) state.resizeObserver.disconnect()
          window.removeEventListener('resize', onResize)
          window.removeEventListener('keydown', onKeyDown)
          win.removeEventListener('keydown', onKeyDown)
          root.remove()
        },
      }
    }

    // =====================================================================
    // 6. 插件体
    // =====================================================================

    /** 面板在侧边栏与 main 键位槽里共用的 id。 */
    const PANEL_ID = 'sci-viz'

    /** 侧边栏需要 layout 才能点开后切到主面板；slots 用来注册图标与页面。 */
    const inject = ['slots', 'layout']

    /**
     * 跨组件共享的「当前可视化文档」。
     *
     * 为什么要有它：主面板只有被选中时才挂载。如果轮询写在页面组件里，用户停在对话页时
     * 就没有人在听，AI 推来的图也不会自动把面板翻出来。所以另有一个常驻的隐形 watcher
     * 负责轮询与自动切页，页面组件只订阅这里的结果。
     */
    const vizStore = {
      rev: 0,
      doc: null,
      subs: new Set(),
      set(rev, doc) {
        this.rev = rev
        this.doc = doc
        for (const fn of [...this.subs]) {
          try {
            fn(doc)
          } catch {
            /* 单个订阅者出错不该拖垮其他人 */
          }
        }
      },
      subscribe(fn) {
        this.subs.add(fn)
        return () => this.subs.delete(fn)
      },
    }

    /**
     * 侧边栏图标。owner 会传 `{ size, active }`（见 sidebar.panellist 的 ownerProps），
     * 早期版本忽略了 size、也没用 active 做状态，图标在侧栏里显得很不起眼。
     */
    function SidebarIcon(props) {
      const size = (props && props.size) || 18
      const active = !!(props && props.active)
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          style: { opacity: active ? 1 : 0.82 },
          'aria-hidden': 'true',
        },
        React.createElement('circle', { cx: 10, cy: 10, r: 6.6, stroke: 'currentColor', strokeWidth: active ? 1.9 : 1.5 }),
        React.createElement('circle', { cx: 10, cy: 10, r: 2.2, fill: 'currentColor' }),
        React.createElement('path', {
          d: 'M10 1.4v2.6M10 16v2.6M1.4 10h2.6M16 10h2.6',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    /** 主面板页面：把嵌入式面板挂进 shell 给它的容器。 */
    function SciVizPage() {
      const hostRef = React.useRef(null)
      React.useEffect(() => {
        const host = hostRef.current
        if (!host) return undefined
        const panel = createPanel({ embedded: true, managedByWatcher: true })
        host.appendChild(panel.root)
        if (vizStore.doc) panel.accept(vizStore.doc)
        const unsubscribe = vizStore.subscribe((doc) => panel.accept(doc))
        // 首次挂载时容器尺寸可能还是 0，下一帧再量一次
        const raf = window.requestAnimationFrame(() => {
          window.dispatchEvent(new Event('resize'))
        })
        return () => {
          window.cancelAnimationFrame(raf)
          unsubscribe()
          panel.destroy()
        }
      }, [])
      return React.createElement('div', { className: 'sciviz-page-host', ref: hostRef })
    }

    /** 常驻隐形 watcher：轮询状态文件，有新文档就把主面板翻出来。 */
    function SciVizWatcher() {
      React.useEffect(() => {
        let stopped = false
        let timer = 0
        const tick = async () => {
          if (stopped) return
          try {
            const res = await fetch(`${API}/state?rev=${vizStore.rev}`)
            const data = await res.json()
            if (data.changed && data.doc && data.rev !== vizStore.rev) {
              // 先把文档放进 store —— 面板挂载时就会照着它渲染，
              // 所以下面翻页时图已经准备好了，不会看到一片空白。
              vizStore.set(data.rev, data.doc)
              // 工具推来的（doc.autoOpen）总是翻页：那是「我刚做完一次分析，结果摆到你面前」。
              // 其余更新（命令行推图等）尊重面板头部的 ⇥ 开关；关掉后只在入口上点个点。
              if (data.doc.autoOpen || autojumpRef.current) {
                try {
                  if (layoutRef.current && layoutRef.current.selectPanel) {
                    layoutRef.current.selectPanel(PANEL_ID)
                  }
                } catch {
                  /* 翻页失败不影响内容 */
                }
              } else if (pillRef.current) {
                pillRef.current.notify()
              }
            } else if (data.rev && data.rev !== vizStore.rev && !data.doc) {
              vizStore.rev = data.rev
            }
          } catch {
            /* 宿主未就绪时安静重试 */
          } finally {
            if (!stopped) timer = window.setTimeout(tick, 1600)
          }
        }
        void tick()
        return () => {
          stopped = true
          window.clearTimeout(timer)
        }
      }, [])
      // 不可见、不占位、不拦事件
      return React.createElement('span', {
        style: { display: 'none' },
        'aria-hidden': 'true',
      })
    }

    /** 插件挂载时从 ctx 里取到的 layout 服务，供 watcher 翻页用。 */
    const layoutRef = { current: null }

    /**
     * 新图是否自动把面板翻出来。默认开；面板头部有一个开关，关掉后 AI 推图
     * 只会更新内容，不会把正在读对话的你拽走。
     */
    const autojumpRef = { current: true }

    /** 回到对话页：selectPanel(null) 是 layout 服务里「显示 Conversation」的写法。 */
    function goBackToConversation() {
      try {
        if (layoutRef.current && layoutRef.current.selectPanel) layoutRef.current.selectPanel(null)
      } catch {
        /* layout 不可用时按钮点了没反应，但至少不会报错 */
      }
    }

    /** 打开面板的动作，由 apply 填进来；供 composer 按钮等入口复用。 */
    const openPanelRef = { current: null }

    /**
     * 输入框工具行左侧的小按钮（`conversation.input.left`）。
     *
     * 为什么加这个：侧边栏图标虽然注册成功，但第三方皮肤（例如 maid-atelier）会整体替换
     * 侧边栏，只渲染它认识的几行，自定义 panellist 条目根本不会出现。输入框属于 shipped UI，
     * 皮肤一般不动它，所以这里补一个看得见、点得到的入口。
     */
    function ComposerButton() {
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'sciviz-compose-btn',
          title: '打开科研可视化面板（三维结构 / 统计图表 / 技能库）',
          'aria-label': '打开科研可视化面板',
          onClick: () => {
            if (openPanelRef.current) openPanelRef.current()
          },
        },
        React.createElement('span', { 'aria-hidden': 'true' }, '🔬'),
        React.createElement('span', { className: 'lbl' }, '可视化'),
      )
    }

    /**
     * 常驻悬浮入口（药丸）。
     *
     * 为什么必须有它：入口这种「没有它整个功能等于不存在」的东西不能只押在一个位置上。
     * 侧边栏图标在第三方皮肤下不渲染，composer 按钮也可能被皮肤的样式吃掉，
     * 而挂在 body 上的药丸与皮肤无关，一定看得见、一定点得到。
     * 主面板可用时它只负责 selectPanel；不可用时才退化成开关浮窗。
     */
    function createLauncher(onOpen) {
      const el = document.createElement('div')
      el.className = 'sciviz-launcher'
      el.innerHTML = '<span>🔬</span><span>可视化</span><span class="dot"></span>'
      el.title = '打开科研可视化面板（三维结构 / 统计图表 / 技能库）｜拖动可换位置'
      const prefs = loadPrefs()
      const pos = {
        x: typeof prefs.lx === 'number' ? prefs.lx : window.innerWidth - 132,
        y: typeof prefs.ly === 'number' ? prefs.ly : window.innerHeight - 96,
      }
      const place = () => {
        el.style.left = `${clamp(pos.x, 0, Math.max(0, window.innerWidth - 120))}px`
        el.style.top = `${clamp(pos.y, 0, Math.max(0, window.innerHeight - 38))}px`
      }
      let drag = null
      let moved = false
      el.addEventListener('pointerdown', (e) => {
        drag = { mx: e.clientX, my: e.clientY, x: pos.x, y: pos.y }
        moved = false
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          /* 某些环境不支持捕获 */
        }
      })
      el.addEventListener('pointermove', (e) => {
        if (!drag) return
        const dx = e.clientX - drag.mx
        const dy = e.clientY - drag.my
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
        pos.x = drag.x + dx
        pos.y = drag.y + dy
        place()
      })
      el.addEventListener('pointerup', (e) => {
        if (drag && moved) savePrefs({ ...loadPrefs(), lx: pos.x, ly: pos.y })
        drag = null
        try {
          el.releasePointerCapture(e.pointerId)
        } catch {
          /* 忽略 */
        }
      })
      el.addEventListener('click', () => {
        if (moved) return // 拖动结束时不要顺带触发打开
        el.classList.remove('has-new')
        onOpen()
      })
      place()
      return {
        el,
        notify() {
          el.classList.add('has-new')
        },
        destroy() {
          el.remove()
        },
      }
    }

    /** 注入样式；返回移除函数。 */
    function installStyles() {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-sci-viz'
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    /**
     * 客户端插件体。
     *
     * 首选：注册到 `sidebar.panellist`（图标）+ `main`（页面）+ `shell.overlay`（隐形 watcher），
     * 于是它是一个真正的 DSH 主面板。
     * 退路：任一注册抛错（例如某个槽位在这个版本里不存在）就退回 body 挂载的浮窗 ——
     * 功能一样，只是样子不同。两条路共用同一份 createPanel 实现。
     */
/**
 * Canvas2D → SVG 录制器。
 *
 * 为什么这么做：所有面板都是用 Canvas 2D 画的，投稿却要矢量图。与其为每种图再写一套
 * 矢量绘制代码（两份实现必然会漂移），不如把同一批绘制调用录下来 —— 录进 SVG 而不是
 * 画进画布，两边永远一致。
 *
 * 每个元素都带一个 matrix 变换、坐标用局部坐标：旋转过的文字（热图列名）和缩放过的
 * 路径都能精确还原，不用手算坐标。
 */
function createSvgRecorder(width, height) {
  const body = []
  const scale = 1
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const stack = []
  let path = []
  let hasArc = false
  const st = {
    fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, globalAlpha: 1,
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', lineDash: [],
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const css = (v) => (typeof v === 'string' ? v : '#000000')
  const mul = (a, b) => ({
    a: a.a * b.a + a.c * b.b, b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d, d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e, f: a.b * b.e + a.d * b.f + a.f,
  })
  const tfAttr = () => (Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9
    ? (Math.abs(m.e) < 1e-9 && Math.abs(m.f) < 1e-9 ? '' : ` transform="translate(${m.e.toFixed(2)} ${m.f.toFixed(2)})"`)
    : ` transform="matrix(${m.a.toFixed(5)} ${m.b.toFixed(5)} ${m.c.toFixed(5)} ${m.d.toFixed(5)} ${m.e.toFixed(2)} ${m.f.toFixed(2)})"`)
  const alphaAttr = () => (st.globalAlpha >= 0.999 ? '' : ` opacity="${st.globalAlpha.toFixed(3)}"`)
  const dashAttr = () => (st.lineDash && st.lineDash.length ? ` stroke-dasharray="${st.lineDash.join(' ')}"` : '')
  // 字号从 font 简写里抠出来（录制器只用来估算 measureText）
  const fontPx = () => {
    const mm = /(\d+(?:\.\d+)?)px/.exec(st.font)
    return mm ? parseFloat(mm[1]) : 10
  }
  const anchor = () => (st.textAlign === 'center' ? 'middle' : st.textAlign === 'right' || st.textAlign === 'end' ? 'end' : 'start')
  const baseline = () => {
    if (st.textBaseline === 'middle') return 'central'
    if (st.textBaseline === 'top') return 'hanging'
    if (st.textBaseline === 'bottom') return 'text-after-edge'
    return 'auto'
  }
  const dOf = () => path.join(' ')

  return {
    canvas: { width, height },
    /** 录制出来的 SVG 文本 */
    toSvg() {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
        + `viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#12161b"/>`
        + body.join('') + '</svg>'
    },
    // —— 状态 ——
    save() { stack.push({ m: { ...m }, st: { ...st, lineDash: [...st.lineDash] } }) },
    restore() {
      const s = stack.pop()
      if (s) { m = s.m; Object.assign(st, s.st); st.lineDash = [...s.st.lineDash] }
    },
    translate(x, y) { m = mul(m, { a: 1, b: 0, c: 0, d: 1, e: x, f: y }) },
    scale(x, y) { m = mul(m, { a: x, b: 0, c: 0, d: y, e: 0, f: 0 }) },
    rotate(r) { m = mul(m, { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 0, f: 0 }) },
    setTransform(a, b, c, d, e, f) { m = { a, b, c, d, e, f } },
    setLineDash(arr) { st.lineDash = Array.isArray(arr) ? arr : [] },
    measureText(s) { return { width: String(s).length * fontPx() * 0.6 } },
    // —— 路径 ——
    beginPath() { path = []; hasArc = false },
    closePath() { path.push('Z') },
    moveTo(x, y) { path.push(`M${x.toFixed(2)} ${y.toFixed(2)}`) },
    lineTo(x, y) { path.push(`L${x.toFixed(2)} ${y.toFixed(2)}`) },
    rect(x, y, w, h) { path.push(`M${x.toFixed(2)} ${y.toFixed(2)}h${w.toFixed(2)}v${h.toFixed(2)}h${(-w).toFixed(2)}Z`) },
    arc(x, y, r, a0, a1) {
      hasArc = true
      // 整圆直接给 circle 语义；其余按 16 段折线近似（本插件只画气泡和圆点）
      const full = Math.abs((a1 - a0) - Math.PI * 2) < 1e-6
      if (full) { path.push(`M${(x + r).toFixed(2)} ${y.toFixed(2)}A${r} ${r} 0 1 0 ${(x - r).toFixed(2)} ${y.toFixed(2)}A${r} ${r} 0 1 0 ${(x + r).toFixed(2)} ${y.toFixed(2)}`) ; return }
      const n = 16
      for (let i = 0; i <= n; i += 1) {
        const a = a0 + ((a1 - a0) * i) / n
        path.push(`${i === 0 ? 'M' : 'L'}${(x + r * Math.cos(a)).toFixed(2)} ${(y + r * Math.sin(a)).toFixed(2)}`)
      }
    },
    fill() {
      if (path.length === 0) return
      body.push(`<path d="${dOf()}" fill="${css(st.fillStyle)}" stroke="none"${tfAttr()}${alphaAttr()}/>`)
    },
    stroke() {
      if (path.length === 0) return
      body.push(`<path d="${dOf()}" fill="none" stroke="${css(st.strokeStyle)}" stroke-width="${(st.lineWidth * scale).toFixed(2)}"`
        + `${dashAttr()} stroke-linejoin="round" stroke-linecap="round"${tfAttr()}${alphaAttr()}/>`)
    },
    // —— 直接元素 ——
    fillRect(x, y, w, h) {
      if (w <= 0 || h <= 0) return
      body.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"`
        + ` fill="${css(st.fillStyle)}"${tfAttr()}${alphaAttr()}/>`)
    },
    clearRect() { /* 背景由 panelBackground 画，这里不产出元素 */ },
    fillText(text, x, y) {
      if (text === '' || text === undefined || text === null) return
      const px = fontPx()
      body.push(`<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" fill="${css(st.fillStyle)}"`
        + ` font-family="ui-sans-serif, system-ui, PingFang SC, Microsoft YaHei, sans-serif" font-size="${px}"`
        + ` text-anchor="${anchor()}" dominant-baseline="${baseline()}"${tfAttr()}${alphaAttr()}>${esc(text)}</text>`)
    },
    strokeText(text, x, y) { this.fillText(text, x, y) },
    /** 结构渲染器里用到的补集：缺了会抛异常，整张导出就失败了。 */
    strokeRect(x, y, w, h) {
      body.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"`
        + ` fill="none" stroke="${css(st.strokeStyle)}" stroke-width="${(st.lineWidth * scale).toFixed(2)}"${tfAttr()}${alphaAttr()}/>`)
    },
    quadraticCurveTo(cx, cy, x, y) {
      const last = path.length ? path[path.length - 1].slice(1).split(' ').map(Number) : [0, 0]
      const n = 8
      for (let i = 1; i <= n; i += 1) {
        const t = i / n
        const px = (1 - t) * (1 - t) * last[0] + 2 * (1 - t) * t * cx + t * t * x
        const py = (1 - t) * (1 - t) * last[1] + 2 * (1 - t) * t * cy + t * t * y
        path.push(`L${px.toFixed(2)} ${py.toFixed(2)}`)
      }
    },
    clip() { /* 裁剪在导出里忽略：本插件的裁剪只用于结构画布的边界 */ },
    ellipse(x, y, rx, ry) {
      hasArc = true
      const n = 20
      for (let i = 0; i <= n; i += 1) {
        const a = (Math.PI * 2 * i) / n
        path.push(`${i === 0 ? 'M' : 'L'}${(x + rx * Math.cos(a)).toFixed(2)} ${(y + ry * Math.sin(a)).toFixed(2)}`)
      }
    },
    /** 渐变降级成第一个色标：SVG 里本来也能写渐变，但逐元素重写不值得。 */
    createLinearGradient() { return { addColorStop: (o, c) => { if (o === 0) st.fillStyle = c } } },
    createRadialGradient() { return { addColorStop: (o, c) => { if (o === 0) st.fillStyle = c } } },
    measureTextFull(s) { return { width: String(s).length * fontPx() * 0.6 } },
    // 属性直接挂上去，绘制时读取
    set fillStyle(v) { st.fillStyle = v },
    get fillStyle() { return st.fillStyle },
    set strokeStyle(v) { st.strokeStyle = v },
    get strokeStyle() { return st.strokeStyle },
    set lineWidth(v) { st.lineWidth = v },
    get lineWidth() { return st.lineWidth },
    set globalAlpha(v) { st.globalAlpha = v },
    get globalAlpha() { return st.globalAlpha },
    set font(v) { st.font = v },
    get font() { return st.font },
    set textAlign(v) { st.textAlign = v },
    get textAlign() { return st.textAlign },
    set textBaseline(v) { st.textBaseline = v },
    get textBaseline() { return st.textBaseline },
  }
}


    function apply(ctx) {
      // 分步上报：哪一步炸的，/health 的 clientPhase / clientError 直接看得出
      let step = 'start'
      void report('apply-start')
      try {
      step = 'styles'
      const removeStyles = installStyles()
      const get = (svc) => {
        try {
          return ctx.get ? ctx.get(svc) : undefined
        } catch {
          return undefined
        }
      }
      step = 'services'
      const layout = get('layout')
      layoutRef.current = layout || null
      const slots = get('slots')
      void report('apply-services')

      let panelMode = false
      let floating = null
      const launcherRef = { current: null }
      pillRef.current = launcherRef

      /**
       * 打开/收起面板。
       * 主面板可用时走 layout.selectPanel：已经在本面板上就切回对话（按钮变成开关），
       * 否则切到本面板；两者都不可用时退化成开关浮窗。
       */
      const openIt = () => {
        if (panelMode && layout && layout.selectPanel) {
          try {
            let active = null
            if (layout.panelInfo && typeof layout.panelInfo.getSnapshot === 'function') {
              const snap = layout.panelInfo.getSnapshot()
              active = snap && snap.activePanelId
            }
            layout.selectPanel(active === PANEL_ID ? null : PANEL_ID)
            return
          } catch {
            /* 键位没注册（理论上不该发生）——落到浮窗那条路 */
          }
        }
        if (!floating) {
          try {
            floating = createPanel({ embedded: false, withLauncher: false })
            document.body.appendChild(floating.root)
            floating.setVisible(false)
          } catch (e) {
            ctx.logger?.error?.(`dsh-sci-viz: 浮窗挂不上：${e?.message ?? e}`)
            return
          }
        }
        floating.setVisible(!floating.isVisible())
      }

      if (React && slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        try {
          step = 'slots'
          slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            label: '科研可视化',
          }, SidebarIcon))
          slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, SciVizPage))
          slots.inject('shell.overlay', () => slots.register({
            name: 'shell.overlay',
            id: 'sci-viz-watch',
            order: 40,
          }, SciVizWatcher))
          // 输入框里的入口（皮肤一般不替换 composer）
          slots.inject('conversation.input.left', () => slots.register({
            name: 'conversation.input.left',
            id: 'sci-viz-open',
            order: 40,
          }, ComposerButton))
          panelMode = true
          void report('apply-slots')
        } catch (e) {
          panelMode = false
          void report('apply-slots-error', `${e?.message}`)
          ctx.logger?.warn?.(`dsh-sci-viz: 主面板注册失败，改用浮窗：${e?.message ?? e}`)
        }
      }

      // 常驻入口：不管上面成功与否，用户总得有个能点的地方
      step = 'launcher'
      const launcher = createLauncher(openIt)
      document.body.appendChild(launcher.el)
      launcherRef.current = launcher
      openPanelRef.current = openIt
      void report('apply-ok')

      ctx.effect(() => () => {
        launcher.destroy()
        if (floating) floating.destroy()
        removeStyles()
      }, 'dsh-sci-viz: teardown')
      } catch (e) {
        // 报出去再抛：让 /health 留证据，同时让 DSH 的加载器照常记录这次失败
        void report(`apply-error@${step}`, `${e?.message} | ${String(e?.stack ?? '').split('\n').slice(0, 3).join(' <- ')}`)
        throw e
      }
    }

    /** watcher 想在「有新内容」时给入口按钮点个点，通过这个引用够到它。 */
    const pillRef = { current: null }

    exports.apply = apply
    exports.inject = inject
    exports.PANEL_ID = PANEL_ID

    /**
     * 供 tools/verify-visual.mjs 使用的内部入口：把渲染函数暴露出来，
     * 用同一份代码在 Node 里录成 SVG 检查画面（同 dsh-opencode-go-usage 的 rigInternals 做法）。
     */
    exports.__internals = {
      createStructureView,
      paintStructure,
      paintChart,
      buildPrimitives,
      projection,
      rotationMatrix,
      /** 粘贴数据 → 检验参数的解析器：给验证脚本留的口子（纯函数，好断言）。 */
      parseDataTable,
      /** Canvas2D → SVG 录制器：导出用，也是「同一批绘制调用、两种输出」的保证。 */
      createSvgRecorder,
      panelDomain,
      drawPanel,
      niceTicks,
      fmt,
      CSS,
      /** 图表面板的最小高度：验证脚本用它断言「矮画布必须被撑高」而不是压扁。 */
      chartMinHeight,
      chartAxisHeight,
      /**
       * 清空球体渐变缓存。浏览器里不需要（同一 context 一直活着），
       * 但验证脚本会用同一个模块连续渲染多份 SVG，每个 context 有各自的 <defs>，
       * 跨 context 复用渐变对象会引用到不存在的 id，所以每张图之前清一次。
       */
      resetGradientCache: () => gradientCache.clear(),
    }
    return module.exports
  },
})
