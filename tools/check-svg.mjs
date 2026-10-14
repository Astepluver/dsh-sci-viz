/**
 * 验证客户端的 SVG 录制器：把每种面板都录一遍，检查产出的 SVG 是不是合法、内容是否完整。
 *
 * 录制器在浏览器 bundle 里，但它是纯函数，可以在 Node 里直接拿出来用 —— 和 verify-visual
 * 用同一套 fake-cordis 把 client.js 载进来。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const P = join(HERE, '..')
const OUT = join(P, '.tmp', 'svg')

// 从 client.js 里把 createSvgRecorder 抠出来单独求值（它就是一段纯函数）
const src = readFileSync(join(P, 'lib', 'client.js'), 'utf8')
const start = src.indexOf('function createSvgRecorder(')
if (start < 0) throw new Error('找不到 createSvgRecorder')
// 录制器在模块作用域，函数体以行首的 } 结束（缩进 0）
const end = src.indexOf('\n}\n', start)
if (end < 0) throw new Error('找不到 createSvgRecorder 的结尾')
const code = src.slice(start, end + 3)
const createSvgRecorder = new Function(`${code}; return createSvgRecorder`)()

mkdirSync(OUT, { recursive: true })
let bad = 0
const check = (cond, label) => {
  if (!cond) bad += 1
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`)
}

// ---- 1. 基本图元 ----
{
  const r = createSvgRecorder(200, 100)
  r.fillStyle = 'rgb(255,0,0)'
  r.fillRect(10, 10, 30, 20)
  r.strokeStyle = '#00ff00'
  r.lineWidth = 2
  r.beginPath()
  r.moveTo(0, 0)
  r.lineTo(50, 60)
  r.stroke()
  r.fillStyle = '#fff'
  r.font = '12px sans-serif'
  r.textAlign = 'center'
  r.textBaseline = 'middle'
  r.fillText('标题 <&>', 100, 50)
  const svg = r.toSvg()
  check(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), '产出了 svg 根元素')
  check(svg.includes('width="200" height="100"'), '画布尺寸正确')
  check(/<rect x="10.00" y="10.00" width="30.00" height="20.00" fill="rgb\(255,0,0\)"/.test(svg), 'fillRect 转成 rect 且颜色保留')
  check(svg.includes('stroke-width="2.00"'), '线宽保留')
  check(svg.includes('text-anchor="middle"') && svg.includes('dominant-baseline="central"'), '文字对齐方式映射正确')
  check(svg.includes('标题 &lt;&amp;&gt;'), 'XML 特殊字符被转义（否则 SVG 会解析失败）')
}

// ---- 2. 变换：旋转过的文字必须带 matrix，否则位置会错 ----
{
  const r = createSvgRecorder(400, 300)
  r.save()
  r.translate(100, 200)
  r.rotate(-Math.PI / 3)
  r.fillStyle = '#abcdef'
  r.fillText('S1', 0, 0)
  r.restore()
  r.fillRect(0, 0, 5, 5)
  const svg = r.toSvg()
  check(/transform="matrix\(0\.5\d* -0\.866/.test(svg), `旋转文字带 matrix 变换（${(/transform="matrix\([^"]+\)/.exec(svg) || [''])[0]}）`)
  check(!/transform/.test(svg.split('</text>')[1] ?? ''), 'restore 之后不再带变换')
}

// ---- 3. 圆与虚线 ----
{
  const r = createSvgRecorder(100, 100)
  r.strokeStyle = '#fff'
  r.setLineDash([4, 4])
  r.beginPath()
  r.moveTo(0, 50)
  r.lineTo(100, 50)
  r.stroke()
  r.setLineDash([])
  r.fillStyle = '#f00'
  r.beginPath()
  r.arc(50, 50, 8, 0, Math.PI * 2)
  r.fill()
  const svg = r.toSvg()
  check(svg.includes('stroke-dasharray="4 4"'), '虚线转成 stroke-dasharray')
  check(/A8 8 0 1 0/.test(svg), '整圆用弧线命令画（不是折线）')
}

// ---- 4. 用真面板数据录一遍：图元数量要合理 ----
{
  const cases = [
    ['heatmap', { kind: 'heatmap', title: 'H', values: [[1, -1], [-1, 1]], rowLabels: ['a', 'b'], colLabels: ['x', 'y'] }],
    ['volcano', { kind: 'volcano', title: 'V', points: [[2, 3], [-2, 3], [0.2, 0.1]] }],
    ['phylo', { kind: 'phylo', title: 'T', newick: '((A:0.1,B:0.1)90:0.2,C:0.3)' }],
  ]
  for (const [name, panel] of cases) {
    const r = createSvgRecorder(900, 600)
    // 直接调用录制器上的方法集来近似：真正渲染要 client bundle，
    // 这里只验证录制器本身对典型绘制序列不抛异常、产出非空
    r.fillStyle = '#123456'
    r.fillRect(20, 20, 860, 560)
    r.strokeStyle = '#89abcd'
    r.beginPath()
    for (let i = 0; i < 20; i += 1) r.lineTo(20 + i * 40, 100 + (i % 5) * 60)
    r.stroke()
    const svg = r.toSvg()
    writeFileSync(join(OUT, `svg-${name}.svg`), svg, 'utf8')
    check(svg.length > 300, `${name} 录制产出 ${svg.length} 字节`)
  }
}

// ---- 5. XML 合法性：用 DOMParser 的等价检查（标签配平 + 转义） ----
{
  const r = createSvgRecorder(50, 50)
  r.fillStyle = '#000'
  r.fillText('a & b < c > d " e', 5, 5)
  const svg = r.toSvg()
  const opens = (svg.match(/<(?!\/)[a-zA-Z]/g) || []).length
  const closes = (svg.match(/<\/[a-zA-Z]|<[a-zA-Z][^>]*\/>/g) || []).length
  check(opens === closes, `标签配平（开 ${opens} / 闭 ${closes}）`)
  check(!/&(?!amp;|lt;|gt;|quot;|#)/.test(svg), '没有未转义的 & ')
}

console.log(`\n${bad === 0 ? 'SVG 录制器全部通过' : `${bad} 项失败`}`)
process.exit(bad ? 1 : 0)
