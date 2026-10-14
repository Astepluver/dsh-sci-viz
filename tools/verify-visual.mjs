/**
 * dsh-sci-viz 视觉验证：把浏览器端的绘制代码原样录成 SVG，再光栅化成 PNG。
 *
 * 为什么这么做：客户端渲染器是命令式的 canvas 代码，Node 里没有 canvas。
 * 但它的绘制调用只用一个受限子集，所以可以用一个「Canvas2D → SVG 记录器」把调用
 * 原样翻译成矢量图 —— 画出来的东西与浏览器里是同一套坐标与同一套指令，
 * 于是「我」能用 read_image 真正看到画面，而不是靠猜。
 *
 * 用法：
 *   node tools/verify-visual.mjs            # 输出到 .tmp/visual/*.svg 与 *.png
 * 光栅化用 profile 里的 sharp（resvg/vips，支持中日韩字形）。
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', '.tmp', 'visual')
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// Canvas2D → SVG 记录器
// ---------------------------------------------------------------------------

const MAT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
const mul = (m, n) => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
})

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 粗略文本宽度：CJK 按 1.0em，其余按 0.55em —— 只用于验证版式是否合理。 */
function textWidth(text, size) {
  let units = 0
  for (const ch of String(text)) units += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55
  return units * size
}

class Gradient {
  constructor(kind, args, ctx) {
    this.kind = kind
    this.args = args
    this.ctx = ctx
    this.stops = []
    this.id = `grad${ctx.nextId()}`
  }

  addColorStop(offset, color) {
    this.stops.push([offset, color])
  }

  def() {
    const stops = this.stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')
    if (this.kind === 'linear') {
      const [x0, y0, x1, y1] = this.args
      return `<linearGradient id="${this.id}" gradientUnits="userSpaceOnUse" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}">${stops}</linearGradient>`
    }
    const [x0, y0, r0, x1, y1, r1] = this.args
    return `<radialGradient id="${this.id}" gradientUnits="userSpaceOnUse" cx="${x1}" cy="${y1}" r="${r1}" fx="${x0}" fy="${y0}">${stops}</radialGradient>`
  }
}

/** 一个只实现浏览器端用到的子集的 CanvasRenderingContext2D。 */
class SvgContext {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.m = { ...MAT }
    this.stack = []
    this.body = []
    this.defs = []
    this.idSeq = 0
    this.fillStyle = '#000'
    this.strokeStyle = '#000'
    this.lineWidth = 1
    this.globalAlpha = 1
    this.font = '10px sans-serif'
    this.textAlign = 'left'
    this.textBaseline = 'alphabetic'
    this.lineCap = 'butt'
    this.lineJoin = 'miter'
    this.dash = []
    this.path = []
    this.cur = null
    this.clipId = null
    this.unsupported = new Set()
  }

  nextId() {
    this.idSeq += 1
    return `g${this.idSeq}`
  }

  // ---- 状态 ----
  save() {
    this.stack.push({
      m: { ...this.m }, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth, globalAlpha: this.globalAlpha, font: this.font,
      textAlign: this.textAlign, textBaseline: this.textBaseline,
      lineCap: this.lineCap, lineJoin: this.lineJoin, dash: this.dash.slice(), clipId: this.clipId,
    })
  }

  restore() {
    const s = this.stack.pop()
    if (!s) return
    this.m = s.m
    this.fillStyle = s.fillStyle
    this.strokeStyle = s.strokeStyle
    this.lineWidth = s.lineWidth
    this.globalAlpha = s.globalAlpha
    this.font = s.font
    this.textAlign = s.textAlign
    this.textBaseline = s.textBaseline
    this.lineCap = s.lineCap
    this.lineJoin = s.lineJoin
    this.dash = s.dash
    this.clipId = s.clipId
  }

  setTransform(a, b, c, d, e, f) {
    this.m = { a, b, c, d, e, f }
  }

  translate(x, y) {
    this.m = mul(this.m, { ...MAT, e: x, f: y })
  }

  rotate(rad) {
    const c = Math.cos(rad)
    const s = Math.sin(rad)
    this.m = mul(this.m, { a: c, b: s, c: -s, d: c, e: 0, f: 0 })
  }

  scale(x, y) {
    this.m = mul(this.m, { a: x, b: 0, c: 0, d: y, e: 0, f: 0 })
  }

  // ---- 样式 ----
  createLinearGradient(x0, y0, x1, y1) {
    const gr = new Gradient('linear', [x0, y0, x1, y1], this)
    this.pending = gr
    return gr
  }

  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    const gr = new Gradient('radial', [x0, y0, r0, x1, y1, r1], this)
    this.pending = gr
    return gr
  }

  setLineDash(arr) {
    this.dash = arr || []
  }

  measureText(text) {
    const size = parseFloat(/([\d.]+)px/.exec(this.font)?.[1] ?? '10')
    return { width: textWidth(text, size) }
  }

  // ---- 路径 ----
  beginPath() {
    this.path = []
    this.cur = null
  }

  moveTo(x, y) {
    this.cur = { pts: [[x, y]], closed: false }
    this.path.push(this.cur)
  }

  lineTo(x, y) {
    if (!this.cur) this.moveTo(x, y)
    else this.cur.pts.push([x, y])
  }

  closePath() {
    if (this.cur) this.cur.closed = true
  }

  rect(x, y, w, h) {
    this.cur = { pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }
    this.path.push(this.cur)
  }

  arc(cx, cy, r, a0, a1, ccw) {
    const full = Math.abs(Math.abs(a1 - a0) - Math.PI * 2) < 1e-6
    if (full) {
      const seg = { circle: [cx, cy, r], pts: [], closed: true }
      this.path.push(seg)
      this.cur = seg
      return
    }
    const steps = 24
    const start = ccw ? a1 : a0
    const end = ccw ? a0 : a1
    const sub = { pts: [], closed: false }
    for (let i = 0; i <= steps; i += 1) {
      const a = start + ((end - start) * i) / steps
      sub.pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
    this.path.push(sub)
    this.cur = sub
  }

  clip() {
    const d = this.pathData()
    if (!d) return
    const id = `clip${this.nextId()}`
    this.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${d}"/></clipPath>`)
    this.clipId = id
  }

  pathData() {
    const parts = []
    for (const sub of this.path) {
      if (sub.circle) {
        const [cx, cy, r] = sub.circle
        parts.push(`M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`)
        continue
      }
      if (!sub.pts.length) continue
      parts.push(`M ${sub.pts.map((p) => `${round(p[0])} ${round(p[1])}`).join(' L ')}`)
      if (sub.closed) parts.push('Z')
    }
    return parts.join(' ')
  }

  // ---- 绘制 ----
  paint(style) {
    if (style instanceof Gradient) return `url(#${style.id})`
    return style
  }

  attr(extra = '') {
    const alpha = this.globalAlpha < 1 ? ` opacity="${round(this.globalAlpha, 3)}"` : ''
    const clip = this.clipId ? ` clip-path="url(#${this.clipId})"` : ''
    return ` transform="matrix(${round(this.m.a, 6)} ${round(this.m.b, 6)} ${round(this.m.c, 6)} ${round(this.m.d, 6)} ${round(this.m.e, 3)} ${round(this.m.f, 3)})"${alpha}${clip}${extra}`
  }

  registerGradient(style) {
    if (style instanceof Gradient) this.defs.push(style.def())
    return this.paint(style)
  }

  fill() {
    const d = this.pathData()
    if (!d) return
    this.body.push(`<path d="${d}" fill="${this.registerGradient(this.fillStyle)}" ${this.attr()}/>`)
  }

  stroke() {
    const d = this.pathData()
    if (!d) return
    const dash = this.dash.length ? ` stroke-dasharray="${this.dash.join(' ')}"` : ''
    this.body.push(
      `<path d="${d}" fill="none" stroke="${this.registerGradient(this.strokeStyle)}" stroke-width="${round(this.lineWidth, 3)}"` +
      ` stroke-linecap="${this.lineCap}" stroke-linejoin="${this.lineJoin}"${dash} ${this.attr()}/>`,
    )
  }

  fillRect(x, y, w, h) {
    if (!(w > 0) && !(h > 0)) return
    this.body.push(
      `<rect x="${round(x, 3)}" y="${round(y, 3)}" width="${round(Math.abs(w), 3)}" height="${round(Math.abs(h), 3)}"` +
      ` fill="${this.registerGradient(this.fillStyle)}" ${this.attr()}/>`,
    )
  }

  strokeRect(x, y, w, h) {
    this.body.push(
      `<rect x="${round(x, 3)}" y="${round(y, 3)}" width="${round(Math.abs(w), 3)}" height="${round(Math.abs(h), 3)}"` +
      ` fill="none" stroke="${this.registerGradient(this.strokeStyle)}" stroke-width="${round(this.lineWidth, 3)}" ${this.attr()}/>`,
    )
  }

  clearRect() {
    /* 背景随后会被 fillRect 覆盖，验证图里可以忽略 */
  }

  fillText(text, x, y) {
    const size = parseFloat(/([\d.]+)px/.exec(this.font)?.[1] ?? '10')
    const weight = /(\d00|bold)/.test(this.font) ? (/bold/.test(this.font) ? '700' : /(\d00)/.exec(this.font)[1]) : '400'
    const family = this.font.replace(/^[^ ]+ /, '').replace(/^\d+ /, '')
    const anchor = this.textAlign === 'center' ? 'middle' : this.textAlign === 'right' ? 'end' : 'start'
    const baseline = this.textBaseline === 'middle' ? 'central'
      : this.textBaseline === 'top' ? 'hanging' : 'alphabetic'
    this.body.push(
      `<text x="${round(x, 2)}" y="${round(y, 2)}" fill="${this.registerGradient(this.fillStyle)}"` +
      ` font-size="${round(size, 2)}" font-weight="${weight}" font-family="${esc(family)}"` +
      ` text-anchor="${anchor}" dominant-baseline="${baseline}" ${this.attr()}>${esc(text)}</text>`,
    )
  }

  strokeText(text, x, y) {
    this.fillText(text, x, y)
  }

  /** 未实现的方法：记下来，验证时报警而不是静默画错。 */
  unsupportedCall(name) {
    this.unsupported.add(name)
  }

  toSvg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">` +
      `<defs>${this.defs.join('')}</defs>` +
      `<rect width="${this.width}" height="${this.height}" fill="#0f1318"/>` +
      this.body.join('\n') +
      '</svg>'
  }
}

const round = (v, digits = 2) => {
  const f = Math.pow(10, digits)
  return Math.round(v * f) / f
}

// 未实现的方法挂上去，画到就报警
for (const name of ['drawImage', 'createPattern', 'fillText2', 'ellipse', 'roundRect', 'bezierCurveTo', 'quadraticCurveTo', 'setTransform2', 'filter']) {
  if (!(name in SvgContext.prototype)) SvgContext.prototype[name] = function () { this.unsupportedCall(name) }
}

/** 包一层 Proxy：用到没实现的方法就抛错（越早发现越好）。 */
function guardContext(ctx) {
  return new Proxy(ctx, {
    get(target, prop) {
      const value = target[prop]
      if (value === undefined && typeof prop === 'string') {
        throw new Error(`渲染器调用了 SvgContext 未实现的成员：${prop}（验证脚本需要补上它）`)
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// ---------------------------------------------------------------------------
// 载入浏览器端代码
// ---------------------------------------------------------------------------

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      captured = { id, exports: factory(() => { throw new Error('client bundle must not require anything') }) }
    },
  },
}
globalThis.document = { createElement: () => ({ style: {}, dataset: {}, appendChild() {}, querySelector: () => null }) }

const clientPath = join(HERE, '..', 'lib', 'client.js')
await import(`file://${clientPath.replace(/\\/g, '/')}`)
if (!captured) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
const internals = captured.exports.__internals
const EXPORTED = Object.keys(captured.exports)
console.log(`client bundle id = ${captured.id}`)
console.log(`client exports = ${EXPORTED.join(', ')}`)
console.log(`internals = ${Object.keys(internals).join(', ')}`)

// ---------------------------------------------------------------------------
// 产出可视化工件
// ---------------------------------------------------------------------------

// sharp 只用于把 SVG 光栅化成 PNG 给人眼看，SVG 本身（几何断言的全部输入）不需要它。
// 解析顺序：本包自己的依赖 → DSH profile 里的宿主依赖（开发机上 sharp 装在那儿）。
// 两条都拿不到就跳过光栅化，而不是崩掉整个验证 —— 公开仓库里没人保证有 sharp。
function loadSharp() {
  const candidates = [import.meta.url, '<DSH profile>/package.json']
  for (const from of candidates) {
    if (from !== import.meta.url && !existsSync(from)) continue
    try {
      return createRequire(from)('sharp')
    } catch {
      /* 换下一个来源 */
    }
  }
  return null
}
const sharp = loadSharp()
if (!sharp) {
  console.log('提示：没有 sharp，跳过 PNG 光栅化（SVG 与全部几何断言照常跑）')
}

/**
 * 测试用的真实结构文件不在仓库里（AlphaFold 预测结构几十 KB 起，且不是本项目的产物）。
 * 开发机上它在 <测试数据目录>；换台机器用 SCIVIZ_FIXTURES 指过去即可跑满。
 * 找不到就把依赖它的断言标成「跳过」并如实计数，不让公开仓库的自检永远是红的。
 */
const FIXTURES = process.env.SCIVIZ_FIXTURES || '<测试数据目录>'
const fixture = (rel) => join(FIXTURES, rel)
const hasFixture = (rel) => existsSync(fixture(rel))
const skipped = []
const skip = (label, why) => {
  skipped.push({ label, why })
  console.log(`  跳过  ${label} — ${why}`)
}

const W = 1100
const H = 700
const artifacts = []

async function emit(name, svg) {
  const svgPath = join(OUT, `${name}.svg`)
  writeFileSync(svgPath, svg)
  if (!sharp) {
    artifacts.push({ name, svg: svgPath, png: null, bytes: Buffer.byteLength(svg) })
    return svgPath
  }
  const pngPath = join(OUT, `${name}.png`)
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  writeFileSync(pngPath, png)
  artifacts.push({ name, svg: svgPath, png: pngPath, bytes: png.length })
  return pngPath
}

/** 渲染一份结构文档。 */
async function renderStructure(doc, name, width = W, height = H) {
  internals.resetGradientCache()
  const g = guardContext(new SvgContext(width, height))
  const view = internals.createStructureView(doc)
  internals.paintStructure(g, view, width, height)
  if (g.unsupported.size) throw new Error(`结构渲染用到未实现方法：${[...g.unsupported].join(', ')}`)
  return emit(name, g.toSvg())
}

/** 渲染一份图表文档。 */
async function renderChart(doc, name, width = W, height = H) {
  internals.resetGradientCache()
  const g = guardContext(new SvgContext(width, height))
  internals.paintChart(g, doc, width, height)
  if (g.unsupported.size) throw new Error(`图表渲染用到未实现方法：${[...g.unsupported].join(', ')}`)
  return emit(name, g.toSvg())
}

// ---- 造真数据：用宿主工具产出的真实文档 ---------------------------------
const sandbox = mkdtempSync(join(tmpdir(), 'sciviz-visual-'))

/**
 * `--live`：直接渲染 state/current.json 里那一份「线上文档」。
 *
 * 用途是复现「面板上一片空白」这类只在真实文档上出现的问题 —— 浏览器里 poll()
 * 的 catch 会把渲染异常吞掉，画面就只是空的，什么线索都没有；在这里能拿到完整栈。
 */
if (process.argv.includes('--live')) {
  const statePath = join(HERE, '..', 'state', 'current.json')
  if (!existsSync(statePath)) {
    console.log(`没有 ${statePath}`)
    process.exit(1)
  }
  const doc = JSON.parse(readFileSync(statePath, 'utf8')).doc
  // 尺寸可以指定：面板里画布多高是可变的，「空白画布」常常是高度不够而不是没数据
  const sizeArg = process.argv.find((a) => a.startsWith('--size='))
  const [lw, lh] = sizeArg ? sizeArg.slice(7).split('x').map(Number) : [W, H]
  console.log(`线上文档：kind=${doc.kind} title=${doc.title}`)
  console.log(`panels=${doc.panels ? doc.panels.length : '-'} table=${doc.table ? doc.table.rows.length + ' 行' : '-'}`)
  console.log(`渲染尺寸：${lw}×${lh}`)
  try {
    if (doc.kind === 'chart') await renderChart(doc, 'live', lw, lh)
    else if (doc.kind === 'structure') await renderStructure(doc, 'live', lw, lh)
    else {
      console.log(`  不认识的 kind：${doc.kind}`)
      process.exit(2)
    }
    console.log('  ✓ 渲染成功，没有抛异常')
    console.log(`  产物：${OUT}\\live.${sharp ? 'png' : 'svg'}`)
  } catch (e) {
    console.log('  ✗ 渲染抛异常：')
    console.log(`    ${e && e.constructor ? e.constructor.name : 'Error'}: ${e && e.message}`)
    console.log(String(e && e.stack).split('\n').slice(1, 8).map((l) => '    ' + l.trim()).join('\n'))
    process.exit(3)
  }
  process.exit(0)
}

const toolDocs = new Map()
const tools = new Map()

const fakeCtx = {
  logger: { warn() {}, info() {}, error() {} },
  effect(body) { return body() },
  get: (n) => (n === 'tools' ? { register: (def) => { tools.set(def.name, def); return () => {} } } : undefined),
  webServer: { register: () => () => {} },
}

const host = await import(`file://${join(HERE, '..', 'lib', 'index.js').replace(/\\/g, '/')}`)
const N = await import(`file://${join(HERE, '..', 'lib', 'core', 'numeric.js').replace(/\\/g, '/')}`)
host.apply(fakeCtx, { stateDir: join(sandbox, 'state') })
await new Promise((r) => setTimeout(r, 500))

const runTool = async (name, args) => {
  const def = tools.get(name)
  if (!def) throw new Error(`工具没注册：${name}`)
  const value = await def.execute(args, {})
  const payload = JSON.parse(readFileSync(join(sandbox, 'state', 'current.json'), 'utf8'))
  toolDocs.set(name, payload.doc)
  return { value, doc: payload.doc }
}

console.log('\n== 生成结构画面 ==')
// 结构画面要真实 PDB/mmCIF。仓库里不带这些文件，缺了就跳过整段（其余断言不受影响）。
let baseDoc = null
if (hasFixture('AF_P9WJV1.pdb') && hasFixture('AF_O53740.pdb')) {
  const structRun = await runTool('sci_viz_structure', {
    source: fixture('AF_P9WJV1.pdb'),
    label: 'AF_P9WJV1（964 残基测试结构）',
  })
  void structRun
  baseDoc = toolDocs.get('sci_viz_structure')
  await renderStructure(baseDoc, 'structure-cartoon')

  for (const style of ['trace', 'spacefill', 'ballstick']) {
    const doc = { ...baseDoc, view: { ...baseDoc.view, style } }
    await renderStructure(doc, `structure-${style}`)
  }
  {
    const doc = { ...baseDoc, view: { ...baseDoc.view, style: 'cartoon', colorBy: 'ss' } }
    await renderStructure(doc, 'structure-cartoon-ss')
  }

  // 高亮 + 配体：换一个小一点的结构，并高亮几个残基
  const small = await runTool('sci_viz_structure', {
    source: fixture('AF_O53740.pdb'),
    label: '高亮与着色测试',
    highlight: ['12', '30', 'S50T'],
    style: 'ballstick',
    colorBy: 'resname',
  })
  void small
  await renderStructure(toolDocs.get('sci_viz_structure'), 'structure-highlight')
} else {
  skip('结构画面（6 张）：cartoon / trace / spacefill / ballstick / ss 着色 / 高亮',
    `缺 ${FIXTURES} 下的 AF_P9WJV1.pdb 或 AF_O53740.pdb —— 设 SCIVIZ_FIXTURES=<目录> 可跑满`)
}

console.log('\n== 生成统计画面 ==')
const G = {
  wt: [8.2, 7.9, 8.5, 8.1, 7.7, 8.8, 8.3, 8.0, 8.4, 7.8],
  mut: [7.1, 6.8, 7.4, 7.0, 6.6, 7.5, 7.2, 6.9, 7.3, 6.7],
  high: [6.2, 6.0, 6.5, 5.9, 6.4, 6.1, 6.3, 6.0, 6.2, 5.8],
}
const chartCases = [
  ['chart-normal', { kind: 'normal', values: [...G.wt, ...G.mut], mu: 7.6, sigma: 0.7, title: '正态分布 · MIC 分布拟合' }],
  ['chart-ttest', { kind: 'ttest', groups: [{ label: '野生型 H37Rv', values: G.wt }, { label: 'katG S315T 突变株', values: G.mut }], title: 't 检验 · 野生型 vs 突变株' }],
  ['chart-ttest-paired', { kind: 'ttest', paired: true, groups: [{ label: '用药前', values: G.wt }, { label: '用药后', values: G.mut }], title: '配对 t 检验' }],
  ['chart-anova', { kind: 'anova', groups: [{ label: '敏感株', values: G.wt }, { label: '单耐药', values: G.mut }, { label: '耐多药', values: G.high }], title: '单因素方差分析 · 三组 MIC' }],
  ['chart-chisq', { kind: 'chisq', table: [[18, 7], [6, 19]], rowLabels: ['敏感', '耐药'], colLabels: ['含药', '对照'], title: '卡方检验 · 耐药与处理' }],
  ['chart-regression', { kind: 'regression', x: G.wt.concat(G.mut), y: G.wt.concat(G.mut).map((v, i) => v * 0.8 + (i % 3) * 0.3 - 1), title: '线性回归 · 两法一致性' }],
  ['chart-power', { kind: 'power', d: 0.5, power: 0.8, title: '功效曲线与样本量' }],
  ['chart-descriptives', { kind: 'descriptives', groups: [{ label: '野生型', values: G.wt }, { label: '突变株', values: G.mut }], title: '描述统计' }],
]
for (const [name, args] of chartCases) {
  await runTool('sci_viz_stats', args)
  await renderChart(toolDocs.get('sci_viz_stats'), name)
}

console.log('\n== 生成自定义绘图画面 ==')
{
  const xs = Array.from({ length: 40 }, (_, i) => i * 0.25)
  const curve = xs.map((x) => [x, 100 / (1 + Math.exp(-(x - 4)))])
  const noisy = xs.filter((_, i) => i % 2 === 0).map((x) => [x, 100 / (1 + Math.exp(-(x - 4))) + Math.sin(x * 3) * 4])
  await runTool('sci_viz_plot', {
    title: '剂量-反应曲线（sci_viz_plot 通用入口）',
    panels: [{
      kind: 'xy',
      title: '四参数逻辑曲线',
      xLabel: '药物浓度 (μg/mL)',
      yLabel: '抑制率 (%)',
      xDomain: [0, 10],
      yDomain: [0, 105],
      layers: [
        { type: 'rect', x0: 3.5, x1: 4.5, color: 'rgba(244,211,94,0.12)' },
        { type: 'line', pts: curve, color: '#4c9aff', width: 2.4 },
        { type: 'points', pts: noisy, color: '#f2a33c', r: 3 },
        { type: 'vline', x: 4, color: '#5ac8a8', dash: [5, 4], label: 'IC50 = 4.0' },
        { type: 'hline', y: 50, color: '#8fa3b8', dash: [4, 4], label: '50% 抑制' },
        { type: 'text', x: 7.4, y: 88, text: '拟合曲线', color: '#4c9aff', size: 12 },
      ],
      caption: '通用入口示例：矩形高亮 + 曲线 + 散点 + 参考线 + 文字注释，五类图元一次画全。',
    }],
  })
  await renderChart(toolDocs.get('sci_viz_plot'), 'chart-custom')
}

// ---------------------------------------------------------------------------
// 基因组学面板：六种图各画一张，人眼过一遍
// ---------------------------------------------------------------------------
console.log('\n== 生成基因组学画面 ==')

const GENOMICS_CASES = [
  ['phylo', {
    title: '结核分枝杆菌复合群 · 进化树',
    note: 'Newick 输入 · 分支长度 + bootstrap 支持率 · 按谱系着色',
    newick: '((((L1_ICDC:0.0212,L1_CTRI:0.0198)96:0.0087,'
      + '(L2_Beijing:0.0091,L2_HN:0.0104)94:0.0092)88:0.0135,'
      + '(L3_CAS:0.0187,(L4_H37Rv:0.0034,L4_CDC1551:0.0041)99:0.0076)91:0.0121)85:0.0203,'
      + '((L5_AFRI:0.0231,(L6_CANETTI:0.0255,L9_BOVIS:0.0288)93:0.0140)87:0.0165,'
      + '(L7_lineage7:0.0266,L8_lineage8:0.0271)90:0.0172)84:0.0194)',
    groups: [
      { name: 'L1', color: '#4c9aff', labels: ['L1_*'] },
      { name: 'L2 Beijing', color: '#e56b6f', labels: ['L2_*'] },
      { name: 'L4', color: '#f2a33c', labels: ['L4_*'] },
    ],
  }],
  ['msa', {
    title: 'katG 片段多序列比对',
    note: '8 条序列 × 46 列 · 残基按化学性质着色 · 顶部为逐列保守度',
    sequences: [
      { name: 'H37Rv_ref', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAALLRWRPASL' },
      { name: 'INH_res_1', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAALLRWRPASL' },
      { name: 'INH_res_2', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAAFLRWRPASL' },
      { name: 'INH_res_3', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAAFFRWRPASL' },
      { name: 'Clinical_4', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAALLRWRPASL' },
      { name: 'Clinical_5', seq: 'MSTPGPQRWLAEQGHNVVAGVVGALAAALVLVLVAALLRWRPPSL' },
      { name: 'Bovis_6', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAALLRWRPASL' },
      { name: 'Outgroup_7', seq: 'MSTPGPQKWLAEQGHNVVAGVVGSLAAALILVLVAALLRWRPAPL' },
    ],
  }],
  ['enrich', {
    title: '耐药株差异表达基因 · KEGG 富集',
    note: '气泡大小 = 基因数，颜色 = -log10(p)，分类描边',
    terms: [
      { term: 'ABC transporters', count: 24, p: 3.1e-9, ratio: 0.31, category: 'KEGG' },
      { term: 'Two-component system', count: 18, p: 8.4e-8, ratio: 0.23, category: 'KEGG' },
      { term: 'Bacterial secretion system', count: 11, p: 2.7e-6, ratio: 0.14, category: 'KEGG' },
      { term: 'Fatty acid biosynthesis', count: 9, p: 1.1e-5, ratio: 0.12, category: 'KEGG' },
      { term: 'Peptidoglycan biosynthesis', count: 7, p: 4.3e-5, ratio: 0.09, category: 'KEGG' },
      { term: 'Oxidative phosphorylation', count: 12, p: 1.6e-4, ratio: 0.15, category: 'KEGG' },
      { term: 'Response to antibiotic (GO:0046677)', count: 15, p: 3.9e-4, ratio: 0.19, category: 'GO' },
      { term: 'Drug transmembrane transport (GO:0006855)', count: 10, p: 8.2e-4, ratio: 0.13, category: 'GO' },
      { term: 'Mycolic acid metabolic process', count: 6, p: 2.4e-3, ratio: 0.08, category: 'GO' },
      { term: 'DNA repair (GO:0006281)', count: 8, p: 5.1e-3, ratio: 0.10, category: 'GO' },
    ],
  }],
  ['genome', {
    title: 'H37Rv 全基因组变异分布',
    note: '4 条染色体/质粒 · SNP 画在条上方、INDEL 与 CNV 在下方',
    chromosomes: [
      { name: 'chr (4.41 Mb)', length: 4411532 },
      { name: 'pncA plasmid', length: 4300 },
      { name: 'pMZ1', length: 11000 },
      { name: 'pRS7', length: 7500 },
    ],
    variants: [
      { chrom: 'chr (4.41 Mb)', pos: 2153889, type: 'SNP', label: 'katG S315T' },
      { chrom: 'chr (4.41 Mb)', pos: 761110, type: 'SNP', label: 'rpoB S450L' },
      { chrom: 'chr (4.41 Mb)', pos: 7570, type: 'SNP', label: 'gyrA D94G' },
      { chrom: 'chr (4.41 Mb)', pos: 1673425, type: 'SNP', label: 'pncA W68R' },
      { chrom: 'chr (4.41 Mb)', pos: 1472764, type: 'INDEL', label: 'embB M306I' },
      { chrom: 'chr (4.41 Mb)', pos: 3620000, type: 'CNV' },
      { chrom: 'pncA plasmid', pos: 1200, type: 'SNP' },
      { chrom: 'pMZ1', pos: 5400, type: 'INDEL' },
      { chrom: 'pRS7', pos: 3100, type: 'SNP' },
    ],
  }],
  ['coverage', {
    title: 'gyrA 区域测序覆盖度',
    note: '三条样本轨道 + 基因模型 · pysam/deeptools 的典型输出',
    tracks: [
      { name: 'H37Rv (对照)', points: Array.from({ length: 60 }, (_, i) => [i * 400, 120 + Math.round(Math.sin(i / 4) * 60 + Math.cos(i / 2.4) * 35)]) },
      { name: '耐药株 A', points: Array.from({ length: 60 }, (_, i) => [i * 400, 95 + Math.round(Math.sin(i / 4 + 1) * 55 + Math.cos(i / 2.4) * 30)]) },
      { name: '耐药株 B', points: Array.from({ length: 60 }, (_, i) => [i * 400, 60 + Math.round(Math.sin(i / 3 + 2) * 25)]) },
    ],
    genes: [
      { name: 'gyrA', start: 4000, end: 4500 },
      { name: 'Rv0007', start: 9000, end: 9800 },
    ],
  }],
  ['volcano', {
    title: '耐药株 vs 敏感株 · 差异表达',
    note: '橙色上调、蓝色下调、灰色不显著；阈值 |log2FC| ≥ 1 且 p < 0.05',
    points: [
      ...Array.from({ length: 260 }, () => {
        const x = (Math.random() - 0.5) * 2
        const y = Math.abs(Math.random() * 1.2)
        return [x, y]
      }),
      ...Array.from({ length: 40 }, () => [1 + Math.random() * 4.5, 1.4 + Math.random() * 7]),
      ...Array.from({ length: 34 }, () => [-(1 + Math.random() * 4), 1.4 + Math.random() * 6]),
    ],
    labels: [
      { name: 'katG', x: 4.8, y: 7.9 },
      { name: 'inhA', x: 3.6, y: 6.2 },
      { name: 'rpoB', x: -3.9, y: 6.8 },
      { name: 'pncA', x: -2.8, y: 4.1 },
    ],
  }],
]

// 热图：造一个有真实结构的矩阵 —— 四个基因块各自相关，聚类应当把它们分出来
{
  const genes = ['Rv0001', 'Rv0002', 'Rv0003', 'Rv0004', 'Rv0005', 'Rv0006',
    'katG', 'inhA', 'ahpC', 'fabG1', 'rpoB', 'gyrA']
  const samples = ['敏感-1', '敏感-2', '敏感-3', '耐药-1', '耐药-2', '耐药-3']
  const base = {
    Rv0001: -1.2, Rv0002: -1.0, Rv0003: -1.4, Rv0004: -0.9, Rv0005: -1.1, Rv0006: -1.3,
    katG: -2.1, inhA: -1.8, ahpC: 2.2, fabG1: 1.9, rpoB: 0.3, gyrA: 0.2,
  }
  const values = genes.map((g, gi) => samples.map((_, si) => {
    const treated = si >= 3 ? 1 : -1
    const v = base[g] * (Math.abs(base[g]) > 1.5 ? treated : 1)
    // 一点确定性扰动（不用随机数，保证每次渲染一致，断言才有意义）
    return Number((v + Math.sin(gi * 3.7 + si * 1.9) * 0.35).toFixed(2))
  }))
  GENOMICS_CASES.push(['heatmap', {
    title: '耐药 vs 敏感 · 差异表达热图',    note: '12 个基因 × 6 个样本 · z-score 色阶（0 居中）· 行列均做层次聚类',
    values,
    rowLabels: genes,
    colLabels: samples,
    cluster: true,
    showValues: true,
  }])
  // 不带聚类的相关性矩阵：验证 minmax 色阶这条路
  GENOMICS_CASES.push(['heatmap-corr', {
    kind: 'heatmap',
    title: '样本相关性矩阵',
    note: 'minmax 色阶 · grays · 不聚类',
    values: samples.map((_, i) => samples.map((_, j) => (i === j ? 1 : Number((0.99 - Math.abs(i - j) * 0.18).toFixed(3))))),
    rowLabels: samples,
    colLabels: samples,
    palette: 'grays',
    scale: 'minmax',
    showValues: true,
  }])
  // 真实 WGS 量级的变异数：逐点画刻度会糊成一条实线，必须走密度分箱
  {
    const dense = []
    let seed = 7
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 24000; i += 1) {
      // 造三个热点区（PE/PPE 家族那种局部富集），其余均匀散布
      const hot = rnd() < 0.35
      const pos = hot
        ? Math.floor((0.2 + rnd() * 0.12) * 4411532)
        : Math.floor(rnd() * 4411532)
      dense.push({ chrom: 'chr (4.41 Mb)', pos, type: rnd() < 0.82 ? 'SNP' : 'INDEL' })
    }
    GENOMICS_CASES.push(['genome-dense', {
      kind: 'genome',
      title: '临床分离株全基因组变异密度',
      note: `${dense.length} 个变异 · 密度分箱（柱高 ∝ √该箱变异数）`,
      chromosomes: [{ name: 'chr (4.41 Mb)', length: 4411532 }],
      variants: dense,
    }])
  }
}

// 网络图：结核耐药基因互作（STRING 那类输出）
GENOMICS_CASES.push(['network', {
  title: '耐药相关基因互作网络',
  note: '节点大小 = 连接数 · 颜色 = 功能分组 · 线粗 = 互作得分',
  nodes: [
    { id: 'katG', group: '一线药靶点' }, { id: 'inhA', group: '一线药靶点' },
    { id: 'ahpC', group: '氧化应激' }, { id: 'oxyR', group: '氧化应激' },
    { id: 'rpoB', group: '一线药靶点' }, { id: 'gyrA', group: '一线药靶点' },
    { id: 'pncA', group: '二线药靶点' }, { id: 'embB', group: '二线药靶点' },
    { id: 'eis', group: '二线药靶点' }, { id: 'whiB7', group: '调控' },
    { id: 'sigA', group: '调控' }, { id: 'rrs', group: '二线药靶点' },
  ],
  edges: [
    { source: 'katG', target: 'inhA', weight: 0.95 },
    { source: 'katG', target: 'ahpC', weight: 0.72 },
    { source: 'oxyR', target: 'ahpC', weight: 0.88 },
    { source: 'oxyR', target: 'katG', weight: 0.61 },
    { source: 'rpoB', target: 'sigA', weight: 0.55 },
    { source: 'whiB7', target: 'eis', weight: 0.79 },
    { source: 'whiB7', target: 'rpoB', weight: 0.44 },
    { source: 'gyrA', target: 'rrs', weight: 0.35 },
    { source: 'pncA', target: 'embB', weight: 0.4 },
    { source: 'embB', target: 'eis', weight: 0.5 },
  ],
}])

// 序列 Logo：katG 启动子区（-10/-35 那种保守框应当顶到上限）
{
  const cols = ['T', 'T', 'G', 'A', 'C', 'A', 'T', 'A', 'T', 'G', 'C', 'T', 'A', 'G', 'G']
  const seqs = []
  const template = ['T', 'T', 'G', 'A', 'C', 'A', 'T', 'A', 'T', 'A', 'T', 'A', 'T', 'G', 'C']
  const mix = ['A', 'C', 'G', 'T']
  let seed = 11
  const rr = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let i = 0; i < 24; i += 1) {
    // 前 5 列几乎完全保守，后 10 列随机 → Logo 应当明显「前高后低」
    const seq = template.map((ch, ci) => (ci < 5 ? ch : (rr() < 0.55 ? ch : mix[Math.floor(rr() * 4)]))).join('')
    seqs.push({ name: `株${i + 1}`, seq })
  }
  void cols
  GENOMICS_CASES.push(['logo', {
    title: 'katG 启动子区序列 Logo',
    note: '24 条序列 × 15 列 · 前 5 列保守、后段发散',
    logoSequences: seqs,
  }])
}

for (const [name, args] of GENOMICS_CASES) {
  const { value } = await runTool('sci_viz_genomics', { kind: name, ...args })
  await renderChart(toolDocs.get('sci_viz_genomics'), `genomics-${name}`)
  console.log(`  ${name.padEnd(9)} ${value.summary}`)
}

// 小尺寸下的表现（窗口被拖小）
await renderChart(toolDocs.get('sci_viz_stats'), 'chart-small', 430, 330)

// ---------------------------------------------------------------------------
// 回归断言：这几个坑都真踩过，加断言免得改回去
// ---------------------------------------------------------------------------
console.log('\n== 回归断言 ==')
{
  const checks = []
  const ok = (cond, label) => {
    checks.push({ cond: !!cond, label })
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`)
  }

  // 画布矮的时候不能让图表面板被静默跳过（实测踩过：3 面板 + 257px 高的画布，
  // 每个 cell 的绘图区被压到 45.5px，撞上 `box.h < 46` 的兜底判断 —— 只剩标题、图全没了，
  // 而且不报错。现在 resizeCanvas 会把画布撑到 chartMinHeight，外面滚动。）
  {
    // 显式造一份 3 面板的文档：单面板图在 257px 下本来就放得下，验不出这个问题
    await runTool('sci_viz_stats', {
      kind: 'anova',
      title: '矮画布回归测试',
      groups: [
        { label: 'A组', values: [4.78, 4.65, 3.98, 4.04, 3.44, 3.77] },
        { label: 'B组', values: [4.65, 6.92, 4.44, 6.16, 5.99, 6.67] },
        { label: 'C组（长名字测试）', values: [6.8, 5.91, 7.28, 7.51, 7.51, 7.74] },
      ],
    })
    const doc = toolDocs.get('sci_viz_stats')
    ok((doc.panels || []).length === 3, `回归用文档有 ${(doc.panels || []).length} 个面板`)
    const need = internals.chartMinHeight(doc, 1001)
    ok(need > 257, `3 面板图表的最小高度 = ${need}px > 257px（矮画布要撑高，不是压扁）`)
    const paint = (h) => {
      const g = guardContext(new SvgContext(1001, h))
      const res = internals.paintChart(g, doc, 1001, h)
      return { g, res }
    }
    const big = paint(need)
    ok(big.res.skipped === 0, `按最小高度渲染不跳过任何面板（skipped=${big.res.skipped}）`)
    ok(big.g.body.length > 20, `画面元素 ${big.g.body.length} 个（不是只剩标题的空图）`)
    const small = paint(257)
    ok(small.res.skipped > 0,
      `矮画布确实会跳过面板（skipped=${small.res.skipped}）—— 所以撑高是必需的，不是保险`)
    // 长 x 轴标签要撑开轴带，否则会压到下面的图注上
    const forest = (doc.panels || []).find((p) => (p.xTickLabels || []).some((s) => String(s).length > 12))
    ok(!!forest, '这份文档里有一个带长标签的森林图面板')
    if (forest) {
      const axisH = internals.chartAxisHeight({ panels: [forest] })
      ok(axisH > 40, `长标签把轴带撑到 ${axisH}px（默认只有 40px，会压到图注上）`)
    }
  }

  // 生存曲线与 ROC：走 sci_viz_stats，数值内核已与 scipy 对拍，这里管画得对不对
  {
    const surv = await runTool('sci_viz_stats', {
      kind: 'survival',
      title: '两种方案的无进展生存',
      survivalGroups: [
        { label: '标准方案', times: [3, 5, 5, 7, 8, 10, 12, 12, 15, 18, 21, 24, 9, 14, 30], events: [1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0] },
        { label: '强化方案', times: [6, 9, 11, 13, 15, 17, 19, 22, 25, 28, 31, 34, 16, 20, 40], events: [1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0] },
      ],
      xLabel: '随访月数',
    })
    ok(/log-rank/.test(surv.value.summary), `生存：给了 log-rank（${surv.value.summary.slice(0, 46)}…）`)
    await renderChart(toolDocs.get('sci_viz_stats'), 'stats-survival')
  }
  {
    const roc = await runTool('sci_viz_stats', {
      kind: 'roc',
      title: '两个模型的判别力',
      rocCurves: [
        { label: '模型 A', labels: [1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0], scores: [0.91, 0.83, 0.77, 0.62, 0.55, 0.71, 0.44, 0.68, 0.31, 0.22, 0.58, 0.39] },
        { label: '模型 B', labels: [1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0], scores: [0.66, 0.61, 0.59, 0.58, 0.52, 0.57, 0.49, 0.55, 0.47, 0.42, 0.53, 0.45] },
      ],
    })
    ok(/AUC/.test(roc.value.summary), `ROC：给出了 AUC（${roc.value.summary.slice(0, 40)}…）`)
    await renderChart(toolDocs.get('sci_viz_stats'), 'stats-roc')
  }

  // 基因组学面板：每种图都要能画，且各自的布局量算得对
  {
    const paint1 = (doc, w = 1100, h = 700) => {
      const g = guardContext(new SvgContext(w, h))
      const res = internals.paintChart(g, doc, w, h)
      return { g, res }
    }
    const cases = [
      ['phylo', { kind: 'phylo', title: 'T', newick: '((A:0.1,B:0.1)90:0.2,(C:0.3,D:0.3)80:0.1)' }],
      ['msa', { kind: 'msa', title: 'M', sequences: [{ name: 'a', seq: 'MKTV' }, { name: 'b', seq: 'MKTA' }, { name: 'c', seq: 'MRTV' }] }],
      ['enrich', { kind: 'enrich', title: 'E', terms: [{ term: 'X', count: 3, p: 1e-4, ratio: 0.1 }, { term: 'Y', count: 9, p: 0.02, ratio: 0.3 }] }],
      ['genome', { kind: 'genome', title: 'G', chromosomes: [{ name: 'chr', length: 4411532 }, { name: 'p', length: 4300 }], variants: [{ chrom: 'chr', pos: 100, type: 'SNP' }] }],
      ['coverage', { kind: 'coverage', title: 'C', tracks: [{ name: 't1', points: [[0, 5], [100, 30], [200, 12]] }] }],
      ['volcano', { kind: 'volcano', title: 'V', points: [[2, 3], [-2, 3], [0.2, 0.1]] }],
      ['heatmap', {
        kind: 'heatmap', title: 'H',
        values: [[1, -1], [-1, 1]], rowLabels: ['a', 'b'], colLabels: ['x', 'y'],
      }],
    ]
    for (const [name, panel] of cases) {
      const doc = { kind: 'chart', title: name, panels: [panel] }
      const { g, res } = paint1(doc)
      ok(res.skipped === 0 && g.body.length > 3, `${name} 画出来了（${g.body.length} 个图元，未跳过）`)
      const need = internals.chartMinHeight(doc, 1100)
      ok(need > 100, `${name} 最小高度 ${need}px`)
    }
    // 4.41 Mb 的染色体旁边放 4 kb 质粒：按真实比例不足 1px，必须给最小可见宽度

    const gGenome = guardContext(new SvgContext(1100, 700))
    internals.paintChart(gGenome, {
      kind: 'chart', panels: [{
        kind: 'genome', title: 'G',
        chromosomes: [{ name: 'chr', length: 4411532 }, { name: 'plasmid', length: 4300 }],
        variants: [],
      }],
    }, 1100, 700)
    const rects = gGenome.body.filter((s) => s.startsWith('<rect'))
    ok(rects.length >= 2, `两条染色体都画了矩形（${rects.length} 个）`)

    // 真实 WGS 量级：2.4 万个变异必须走密度分箱，不能逐点画刻度
    const gDense = guardContext(new SvgContext(1100, 700))
    const denseVariants = []
    let sd = 3
    const rr = () => { sd = (sd * 1103515245 + 12345) % 2147483648; return sd / 2147483648 }
    for (let i = 0; i < 24000; i += 1) denseVariants.push({ chrom: 'chr', pos: Math.floor(rr() * 4411532), type: 'SNP' })
    internals.paintChart(gDense, {
      kind: 'chart', panels: [{ kind: 'genome', title: 'G', chromosomes: [{ name: 'chr', length: 4411532 }], variants: denseVariants }],
    }, 1100, 700)
    const denseRects = gDense.body.filter((s) => s.startsWith('<rect')).length
    const densePaths = gDense.body.filter((s) => s.startsWith('<path')).length
    ok(denseRects > 100 && densePaths < 60,
      `2.4 万变异走了密度分箱（${denseRects} 个密度柱，只有 ${densePaths} 条路径 —— 逐点画会是 24000 条）`)
    ok(gDense.body.some((s) => s.includes('密度分箱')), '密度图注明了分箱与峰值')

    // SVG 导出：用录制器把每种面板真渲染一遍，产出的必须是合法 SVG。
    // 这是「画布和矢量图同源」的保证 —— 两边走的是同一批绘制调用。
    const svgKinds = [
      ['heatmap', { kind: 'heatmap', title: 'H', values: [[1, -0.5], [-0.5, 1]], rowLabels: ['a', 'b'], colLabels: ['x', 'y'] }],
      ['survival', {
        kind: 'survival', title: 'S',
        groups: [{ label: 'A', n: 4, events: 2, points: [{ t: 0, s: 1 }, { t: 3, s: 0.6 }, { t: 6, s: 0.3 }], censorMarks: [{ t: 4, s: 0.6 }], median: 4 }],
        logRank: { chi2: 1.1, df: 1, p: 0.29 },
      }],
      ['roc', { kind: 'roc', title: 'R', curves: [{ label: 'A', points: [[0, 0], [0.2, 0.7], [0.6, 0.95], [1, 1]], auc: 0.88 }] }],
      ['phylo', { kind: 'phylo', title: 'T', newick: '((A:0.1,B:0.1)90:0.2,C:0.3)' }],
      ['msa', { kind: 'msa', title: 'M', sequences: [{ name: 'a', seq: 'MKTV' }, { name: 'b', seq: 'MKTA' }] }],
      ['enrich', { kind: 'enrich', title: 'E', terms: [{ term: 'X', count: 3, p: 1e-4, ratio: 0.1 }] }],
      ['genome', { kind: 'genome', title: 'G', chromosomes: [{ name: 'chr', length: 1000 }], variants: [{ chrom: 'chr', pos: 500, type: 'SNP' }] }],
      ['coverage', { kind: 'coverage', title: 'C', tracks: [{ name: 't', points: [[0, 5], [50, 30]] }] }],
      ['volcano', { kind: 'volcano', title: 'V', points: [[2, 3], [-2, 3]] }],
      ['bars', { kind: 'bars', title: 'B', series: [{ label: 's', values: [1, 2, 3] }], labels: ['a', 'b', 'c'] }],
    ]
    for (const [name, panel] of svgKinds) {
      const rec = internals.createSvgRecorder(900, 620)
      internals.paintChart(rec, { kind: 'chart', title: name, panels: [panel] }, 900, 620)
      const svg = rec.toSvg()
      const opens = (svg.match(/<(?!\/)[a-zA-Z]/g) || []).length
      const closes = (svg.match(/<\/[a-zA-Z]|<[a-zA-Z][^>]*\/>/g) || []).length
      const elements = opens - 1 // 减去 svg 根
      ok(svg.startsWith('<svg') && svg.endsWith('</svg>') && opens === closes && elements > 6,
        `SVG 导出：${name} 产出 ${elements} 个元素、标签配平（${Math.round(svg.length / 1024)} KB）`)
    }
    // 带旋转文字的图（热图列名）必须带 matrix，否则 SVG 里文字位置会全错
    {
      const rec = internals.createSvgRecorder(900, 620)
      internals.paintChart(rec, {
        kind: 'chart', panels: [{ kind: 'heatmap', title: 'H', values: [[1, -1], [-1, 1]], rowLabels: ['a', 'b'], colLabels: ['列一', '列二'] }],
      }, 900, 620)
      ok(/transform="matrix\(0\.5/.test(rec.toSvg()), '热图的斜排列名在 SVG 里带旋转变换')
    }
    // 序列 Logo：字母高度必须各不相同 —— 纵向拉伸失效的话所有字母会一样高，
    // 图看着还在、信息全丢了。SVG 里 scale(1,k) 会落成 matrix(1,0,0,k,...)，直接量 k。
    {
      const rec = internals.createSvgRecorder(900, 520)
      internals.paintChart(rec, {
        kind: 'chart',
        panels: [{
          kind: 'logo', title: 'L', maxBits: 2,
          columns: [
            { bits: 2.0, letters: [['A', 1]] },
            { bits: 1.0, letters: [['C', 0.75], ['G', 0.25]] },
            { bits: 0.2, letters: [['A', 0.3], ['C', 0.3], ['G', 0.2], ['T', 0.2]] },
          ],
        }],
      }, 900, 520)
      const svg = rec.toSvg()
      const ks = [...svg.matchAll(/matrix\(1\.00000 0\.00000 0\.00000 ([\d.]+) /g)].map((m) => parseFloat(m[1]))
      ok(ks.length >= 4, `Logo 画出 ${ks.length} 段字母（每列按频率堆叠）`)
      ok(new Set(ks.map((k) => k.toFixed(2))).size >= 3,
        `Logo 字母高度确实不同（${[...new Set(ks.map((k) => k.toFixed(2)))].slice(0, 5).join(' / ')}）—— 纵向拉伸生效`)
    }
    // 网络图：节点数与边数都要落到图元上
    {
      const rec = internals.createSvgRecorder(900, 600)
      internals.paintChart(rec, {
        kind: 'chart',
        panels: [{
          kind: 'network', title: 'N',
          nodes: [
            { id: 'a', label: 'a', group: 'G1', x: 100, y: 100 },
            { id: 'b', label: 'b', group: 'G2', x: 300, y: 200 },
            { id: 'c', label: 'c', group: 'G2', x: 200, y: 400 },
          ],
          links: [{ source: 'a', target: 'b', weight: 1 }, { source: 'b', target: 'c', weight: 2 }],
        }],
      }, 900, 600)
      const svg = rec.toSvg()
      const paths = (svg.match(/<path/g) || []).length
      ok(paths >= 5, `网络图画出 ${paths} 条路径（3 个节点圆 + 2 条边）`)
      ok(svg.includes('>G1<') && svg.includes('>G2<'), '网络图有分组图例')
    }
  }

  // 用多链结构测「只显示这些链」—— 同样要外部测试结构，仓库里不带，缺了就跳过这一整段
  if (hasFixture('af3/fold_2304plus3unit_model_0.cif')) {
    await runTool('sci_viz_structure', {
      source: fixture('af3/fold_2304plus3unit_model_0.cif'),
      label: '多链测试',
    })
    const multi = toolDocs.get('sci_viz_structure')

    const all = internals.createStructureView(multi)
    ok(all.view.visibleChains === null, '不给 chains 时显示全部链')
    const two = multi.chains.filter((c) => c.residueCount > 0).slice(0, 2).map((c) => c.id)
    const filtered = internals.createStructureView({ ...multi, view: { ...multi.view, chains: two } })
    ok(
      Array.isArray(filtered.view.visibleChains) && filtered.view.visibleChains.join() === two.join(),
      `视图参数 chains=[${two.join(',')}] 真的进了 visibleChains（曾经被丢掉，过滤永远无效）`,
    )
    const nAll = internals.buildPrimitives(all).length
    const nFew = internals.buildPrimitives(filtered).length
    ok(nFew < nAll, `过滤后绘制原语从 ${nAll} 降到 ${nFew}`)

    // focus 必须真的把镜头推进去：对比同一个多链结构在「全局取景」与「聚焦取景」下的缩放矩阵
    const midCa = all.ca[Math.floor(all.ca.length / 2)]
    const midAtom = all.atoms[midCa.index]
    const focusWorld = [
      midAtom.x + multi.bbox.center[0],
      midAtom.y + multi.bbox.center[1],
      midAtom.z + multi.bbox.center[2],
    ]
    const focused = internals.createStructureView({ ...multi, view: { ...multi.view, focus: focusWorld } })
    ok(
      focused.focusAtoms && focused.focusAtoms.length >= 8,
      `focus 圈出 ${focused.focusAtoms ? focused.focusAtoms.length : 0} 个邻近原子（≥8 才启用聚焦取景）`,
    )

    // 直接问投影函数要缩放比：比在 SVG 里正则找矩阵可靠得多
    const scaleOf = (view) => {
      delete view._fitScale // 别让上一帧的平滑值影响测量
      return internals.projection(view, 400, 300, internals.rotationMatrix(view.view.yaw, view.view.pitch)).scale
    }
    const sAll = scaleOf(all)
    const sFocus = scaleOf(focused)
    ok(sFocus > sAll * 1.2, `focus 后取景缩放 ${sFocus.toFixed(2)} > 全局 ${sAll.toFixed(2)}（真的推进去了）`)
    const focusDoc = { ...multi, view: { ...multi.view, focus: focusWorld } }
    await renderStructure(focusDoc, 'structure-focused')
    await renderStructure({ ...multi, view: { ...multi.view, chains: two } }, 'structure-chain-filter')

    // N 端 / C 端高亮（用户明确点名要的功能，行为必须钉住）
    {
      const chains = multi.chains.filter((c) => c.residueCount > 0)
      const off = internals.createStructureView({ ...multi, view: { ...multi.view, termini: false } })
      const on = internals.createStructureView({ ...multi, view: { ...multi.view, termini: true } })
      ok(off.highlight.every((h) => h.role === 'site'), '默认不开末端：高亮里只有位点')
      ok(on.highlight.length > off.highlight.length,
        `开启末端后高亮条目 ${off.highlight.length} → ${on.highlight.length}（${chains.length} 条链）`)
      const c0 = chains[0]
      const nEntry = on.highlight.find((h) => h.role === 'nterm' && h.chain === c0.id)
      const cEntry = on.highlight.find((h) => h.role === 'cterm' && h.chain === c0.id)
      ok(nEntry && nEntry.resSeq === c0.first, `链 ${c0.id} N 端 = ${nEntry && nEntry.resSeq}（首残基 ${c0.first}）`)
      ok(cEntry && cEntry.resSeq === c0.last, `链 ${c0.id} C 端 = ${cEntry && cEntry.resSeq}（末残基 ${c0.last}）`)
      on.setTermini(false)
      ok(!on.highlight.some((h) => h.role !== 'site'), '面板开关能关掉末端')
      on.setTermini(true)
      ok(on.highlight.some((h) => h.role === 'nterm') && on.highlight.some((h) => h.role === 'cterm'),
        '面板开关能重新打开，且 N/C 两类都在')
      await renderStructure({ ...multi, view: { ...multi.view, termini: true } }, 'structure-termini')
    }
  } else {
    skip('多链结构断言（chains 过滤 / focus 推进 / N-C 端高亮）',
      '缺 af3/fold_2304plus3unit_model_0.cif —— 设 SCIVIZ_FIXTURES=<目录> 可跑满')
  }

  // 单样本的描述统计不能给出 NaN 置信区间
  const one = N.describe([5])
  ok(Number.isFinite(one.ci[0]) && Number.isFinite(one.ci[1]), `n=1 的 95%CI = [${one.ci[0]}, ${one.ci[1]}] 而不是 NaN`)

  // 粘贴数据的解析器：面板上「运行」按钮的入口，规则必须钉住
  {
    const P = internals.parseDataTable
    const g = P('对照组\t8.2 7.9 8.5\n用药组\t7.1 6.8 7.4', 'ttest')
    ok(g.groups && g.groups.length === 2 && g.groups[0].label === '对照组' && g.groups[0].values.length === 3,
      '带标签的粘贴 → 两组')
    const one = P('# 注释\n1.2\n2.4\n3.6', 'descriptives')
    ok(Array.isArray(one.values) && one.values.length === 3, '纯数字一列 → values（# 开头被忽略）')
    const reg = P('1 2.4\n2 3.1\n3 4.0', 'regression')
    ok(Array.isArray(reg.x) && Array.isArray(reg.y) && reg.x.length === 3, '纯数字两列 + regression → x/y')
    const tab = P('18 7\n6 19', 'chisq')
    ok(Array.isArray(tab.table) && tab.table.length === 2 && tab.table[0].length === 2, '数字矩阵 + chisq → 计数表')
    const cols = P('1 10\n2 20\n3 30', 'ttest')
    ok(cols.groups && cols.groups.length === 2, '多列无标签 + ttest → 按列分组')
    const pw = P('0.5 0.9', 'power')
    ok(pw.d === 0.5 && pw.power === 0.9, 'power → 读 d / power')
    let threw = ''
    try { P('', 'ttest') } catch (e) { threw = e.message }
    ok(/还没有数据/.test(threw), `空输入给出可读错误：${threw}`)
    threw = ''
    try { P('1 2\n3', 'chisq') } catch (e) { threw = e.message }
    ok(/计数表/.test(threw), `卡方列数不齐时报错：${threw}`)
  }

  // kind=raw 必须从 stats 里消失（它并进了 sci_viz_plot）
  const statKinds = tools.get('sci_viz_stats').parameters.properties.kind.enum
  ok(!statKinds.includes('raw'), `kind 枚举 = ${statKinds.join('/')}`)
  ok(!!tools.get('sci_viz_plot').parameters.properties.panels, 'sci_viz_plot 才有 panels 参数')

  const failed = checks.filter((c) => !c.cond)
  if (failed.length) {
    console.log(`\n回归断言失败 ${failed.length} 项`)
    process.exitCode = 1
  }
}

console.log('\n== 结果 ==')
let total = 0
for (const a of artifacts) {
  total += a.bytes
  console.log(`  ${a.name.padEnd(26)} ${String(a.bytes).padStart(7)} B  ${a.png ?? a.svg}`)
}
console.log(sharp
  ? `共 ${artifacts.length} 张，PNG 合计 ${(total / 1024).toFixed(0)} KB`
  : `共 ${artifacts.length} 张 SVG（没有 sharp，未光栅化），合计 ${(total / 1024).toFixed(0)} KB`)
if (baseDoc) {
  console.log(`结构面板原语数：${internals.buildPrimitives(internals.createStructureView(baseDoc)).length}`)
}
if (skipped.length) {
  console.log(`\n跳过 ${skipped.length} 段依赖本机测试数据的检查（仓库里不带这些文件）：`)
  for (const s of skipped) console.log(`  - ${s.label}`)
  console.log('  想跑满：SCIVIZ_FIXTURES=<结构文件所在目录> node tools/verify-visual.mjs')
}
rmSync(sandbox, { recursive: true, force: true })

// 这些 PNG/SVG 加起来约 10 MB —— 只是给人眼看的中间产物，默认用完就删。
// 想自己打开看图就加 --keep。
if (process.argv.includes('--keep')) {
  console.log(`保留在 ${OUT}（--keep）`)
} else {
  rmSync(OUT, { recursive: true, force: true })
  console.log('已删除中间产物（加 --keep 可保留 PNG/SVG 自行查看）')
}
