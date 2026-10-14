/**
 * dsh-sci-viz 数值内核对拍脚本（JS 侧）
 *
 * 生成固定的测试数据与检验结果，写成 JSON；由 tools/verify-math.py 用
 * scipy 1.18 重算并逐项比对。用法：
 *
 *   node tools/verify-math.mjs            # 写 .tmp/math-cases.json
 *   <venv>/python.exe tools/verify-math.py
 *
 * 退出码非 0 表示有任何一项超差。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as N from '../lib/core/numeric.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.argv[2] ?? join(HERE, '..', '.tmp', 'math-cases.json')

/** 确定性 PRNG（mulberry32），保证每次生成的样本一致。 */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller：标准正态样本。 */
function normalSample(r, n) {
  const out = []
  while (out.length < n) {
    const u1 = Math.max(r(), 1e-12)
    const u2 = r()
    const rad = Math.sqrt(-2 * Math.log(u1))
    out.push(rad * Math.cos(2 * Math.PI * u2))
    if (out.length < n) out.push(rad * Math.sin(2 * Math.PI * u2))
  }
  return out
}

const cases = { scalars: [], datasets: {} }

// --- 标量：分布函数 ------------------------------------------------------
for (const x of [-6, -3.5, -1.96, -1, -0.25, 0, 0.25, 1, 1.96, 3.5, 6]) {
  cases.scalars.push({ fn: 'normalCdf', args: [x], js: N.normalCdf(x) })
  cases.scalars.push({ fn: 'normalPdf', args: [x], js: N.normalPdf(x) })
}
for (const p of [1e-6, 1e-4, 0.001, 0.025, 0.1, 0.5, 0.9, 0.975, 0.999, 1 - 1e-4]) {
  cases.scalars.push({ fn: 'normalInv', args: [p], js: N.normalInv(p) })
}
for (const df of [1, 2, 3, 5, 10, 30, 100, 1000]) {
  for (const t of [-5, -2.5, -1, -0.5, 0, 0.5, 1, 2.5, 5]) {
    cases.scalars.push({ fn: 'tCdf', args: [t, df], js: N.tCdf(t, df) })
    cases.scalars.push({ fn: 'tPdf', args: [t, df], js: N.tPdf(t, df) })
  }
  for (const p of [0.001, 0.025, 0.5, 0.975, 0.999]) {
    cases.scalars.push({ fn: 'tInv', args: [p, df], js: N.tInv(p, df) })
  }
}
for (const [d1, d2] of [[1, 1], [2, 10], [3, 20], [5, 5], [10, 100]]) {
  for (const f of [0.05, 0.1, 0.5, 1, 2, 4, 10]) {
    cases.scalars.push({ fn: 'fCdf', args: [f, d1, d2], js: N.fCdf(f, d1, d2) })
    cases.scalars.push({ fn: 'fPdf', args: [f, d1, d2], js: N.fPdf(f, d1, d2) })
  }
}
for (const df of [1, 2, 5, 10, 30]) {
  for (const x of [0.1, 1, 3.8415, 10, 30, 50]) {
    cases.scalars.push({ fn: 'chi2Cdf', args: [x, df], js: N.chi2Cdf(x, df) })
    cases.scalars.push({ fn: 'chi2Pdf', args: [x, df], js: N.chi2Pdf(x, df) })
  }
}
for (const df of [5, 10, 30]) {
  for (const ncp of [0, 1, 2, 3]) {
    for (const t of [-3, -1, 0, 1, 3]) {
      cases.scalars.push({ fn: 'noncentralTCdf', args: [t, df, ncp], js: N.noncentralTCdf(t, df, ncp) })
    }
  }
}
for (const z of [-4, -1.5, 0, 0.7, 2.2]) {
  cases.scalars.push({ fn: 'erf', args: [z], js: N.erf(z) })
  cases.scalars.push({ fn: 'lnGamma', args: [Math.abs(z) + 0.5], js: N.lnGamma(Math.abs(z) + 0.5) })
}
for (const a of [0.5, 2, 7.3]) {
  for (const b of [1.5, 4, 9]) {
    for (const x of [0.05, 0.3, 0.6, 0.95]) {
      cases.scalars.push({ fn: 'incompleteBeta', args: [a, b, x], js: N.incompleteBeta(a, b, x) })
    }
  }
}

// --- 数据集 --------------------------------------------------------------
const r1 = rng(20260101)
const g1 = normalSample(r1, 12).map((v) => v * 1.5 + 10)
const g2 = normalSample(r1, 12).map((v) => v * 2.2 + 11.4)
const g3 = normalSample(r1, 12).map((v) => v * 1.1 + 12.8)
const pairedA = normalSample(r1, 15).map((v) => v * 3 + 40)
const pairedB = pairedA.map((v, i) => v + 1.2 + normalSample(rng(900 + i), 1)[0] * 0.8)
const regX = Array.from({ length: 25 }, (_, i) => i * 0.5 - 3 + normalSample(r1, 1)[0] * 0.2)
const regY = regX.map((x) => 2.4 + 0.85 * x + normalSample(r1, 1)[0] * 0.5)
const skewData = normalSample(r1, 40).map((v) => Math.exp(v * 0.7))

const datasets = {
  g1, g2, g3, pairedA, pairedB, regX, regY, skewData,
  table2x2: [[18, 7], [6, 19]],
  table2x3: [[12, 5, 9], [7, 14, 4]],
}

cases.datasets = datasets
cases.results = {
  describeG1: N.describe(g1),
  describeSkew: N.describe(skewData),
  ttOneSample: N.tTest(g1, undefined, { mu: 10 }),
  ttWelch: N.tTest(g1, g2, { welch: true }),
  ttStudent: N.tTest(g1, g2, { welch: false }),
  ttPaired: N.tTest(pairedA, pairedB, { paired: true }),
  anova: N.anovaOneWay([
    { label: 'A', values: g1 },
    { label: 'B', values: g2 },
    { label: 'C', values: g3 },
  ]),
  chi2: N.chiSquareTest(datasets.table2x2),
  chi2x3: N.chiSquareTest(datasets.table2x3),
  regression: (() => {
    const r = N.linearRegression(regX, regY)
    const { pairs, toFit, ...rest } = r
    void pairs
    void toFit
    return rest
  })(),
  shapiro: {},
  shapiroSamples: {},
}

for (const n of [6, 7, 8, 11, 12, 20, 50, 200, 1000]) {
  const sample = normalSample(rng(4242 + n), n).map((v) => v * 2 + 5)
  cases.results.shapiro[`n${n}_normal`] = N.shapiroWilk(sample)
  cases.results.shapiroSamples[`n${n}_normal`] = sample
}
for (const n of [8, 20, 100]) {
  const sample = Array.from({ length: n }, () => Math.exp(normalSample(r1, 1)[0]))
  cases.results.shapiro[`n${n}_lognormal`] = N.shapiroWilk(sample)
  cases.results.shapiroSamples[`n${n}_lognormal`] = sample
}

// 样本量/功效（与 scipy 的 nct 公式比对）
cases.results.power = {}
for (const [n1, n2, d] of [[10, 10, 0.5], [20, 20, 0.8], [15, 30, 0.4], [50, 50, 0.2]]) {
  cases.results.power[`n${n1}_${n2}_d${d}`] = { n1, n2, d, alpha: 0.05, power: N.tTestPower(n1, n2, d, 0.05) }
}
cases.results.sampleSize = {}
for (const d of [0.2, 0.5, 0.8]) cases.results.sampleSize[`d${d}`] = N.sampleSizeTTest(d, 0.8, 0.05)

cases.toFitSample = [-2, -1, 0, 1, 2].map((x) => {
  const r = N.linearRegression(regX, regY)
  return { x, ...r.toFit(x) }
})

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(cases, null, 1))
console.log(`wrote ${OUT} (${JSON.stringify(cases).length} bytes)`)
console.log(`scalars: ${cases.scalars.length}, datasets: ${Object.keys(datasets).length}, result blocks: ${Object.keys(cases.results).length}`)
