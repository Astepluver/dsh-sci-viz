/**
 * dsh-sci-viz — 数值核心（宿主侧，纯函数，零依赖）
 *
 * 提供：分布函数（正态 / t / F / 卡方）、描述统计、t 检验、单因素方差分析、
 * 两两事后比较、卡方检验、线性回归、功效与样本量、直方图分箱。
 *
 * 约定：
 *  - 所有检验默认双尾，p 值为精确值（走不完全 Beta / 不完全 Gamma，不是查表近似）。
 *  - 任何输入都不修改调用方数组。
 *  - 抛出的 Error 都是可以直接展示给用户的中文说明（模型会把 message 转述）。
 *
 * 精度：与 scipy 1.18 对拍（见 tools/verify-math.mjs），相对误差 < 1e-9。
 * @module dsh-sci-viz/core/numeric
 */

const SQRT2 = Math.SQRT2
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
]

/** 自然对数 Γ(z)，Lanczos 近似（|误差| < 3e-16 相对）。 */
export function lnGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z)
  const zz = z - 1
  let x = LANCZOS[0]
  for (let i = 1; i < 9; i += 1) x += LANCZOS[i] / (zz + i)
  const t = zz + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x)
}

/** 不完全 Beta 连分式（Lentz 法）。 */
function betaContinuedFraction(a, b, x) {
  const tiny = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 3e-16) break
  }
  return h
}

/** 正则化不完全 Beta 函数 I_x(a,b)。 */
export function incompleteBeta(a, b, x) {
  if (!(a > 0) || !(b > 0)) throw new Error('incompleteBeta: a、b 必须为正数')
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b
}

/** 正则化不完全 Gamma 函数 P(a,x)（级数展开）。 */
export function incompleteGammaP(a, x) {
  if (x < 0 || a <= 0) throw new Error('incompleteGammaP: 参数越界')
  if (x === 0) return 0
  if (x < a + 1) {
    let ap = a
    let sum = 1 / a
    let del = sum
    for (let n = 1; n <= 1000; n += 1) {
      ap += 1
      del *= x / ap
      sum += del
      if (Math.abs(del) < Math.abs(sum) * 3e-16) break
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a))
  }
  return 1 - incompleteGammaQ(a, x)
}

/** 正则化不完全 Gamma 函数 Q(a,x)（连分式）。 */
export function incompleteGammaQ(a, x) {
  if (x < 0 || a <= 0) throw new Error('incompleteGammaQ: 参数越界')
  if (x === 0) return 1
  if (x < a + 1) return 1 - incompleteGammaP(a, x)
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i <= 1000; i += 1) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 3e-16) break
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h
}

/** 误差函数 erf(x)。 */
export function erf(x) {
  if (x === 0) return 0
  return x < 0 ? -incompleteGammaP(0.5, x * x) : incompleteGammaP(0.5, x * x)
}

/** 余误差函数 erfc(x)。 */
export function erfc(x) {
  return 1 - erf(x)
}

// ---------------------------------------------------------------------------
// 分布函数
// ---------------------------------------------------------------------------

/** 正态分布密度。 */
export function normalPdf(x, mu = 0, sigma = 1) {
  const z = (x - mu) / sigma
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI))
}

/** 正态分布累积概率 Φ((x-μ)/σ)。 */
export function normalCdf(x, mu = 0, sigma = 1) {
  const z = (x - mu) / (sigma * SQRT2)
  return 0.5 * (1 + erf(z))
}

const ACKLAM_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
const ACKLAM_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
const ACKLAM_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
const ACKLAM_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]

/** 正态分位数（Acklam 有理逼近 + 一步 Halley 精修，相对误差 < 1e-15）。 */
export function normalInv(p, mu = 0, sigma = 1) {
  if (!(p > 0 && p < 1)) throw new Error(`normalInv: 概率必须落在 (0,1)，收到 ${p}`)
  const plow = 0.02425
  const phigh = 1 - plow
  let q
  let x
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p))
    x = (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q + ACKLAM_C[4]) * q + ACKLAM_C[5]) /
      ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1)
  } else if (p <= phigh) {
    q = p - 0.5
    const r = q * q
    x = (((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r + ACKLAM_A[4]) * r + ACKLAM_A[5]) * q /
      (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) * r + ACKLAM_B[4]) * r + 1)
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p))
    x = -(((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q + ACKLAM_C[4]) * q + ACKLAM_C[5]) /
      ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1)
  }
  const e = 0.5 * erfc(-x / SQRT2) - p
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2)
  return mu + sigma * (x - u / (1 + (x * u) / 2))
}

/** t 分布密度。 */
export function tPdf(t, df) {
  if (!(df > 0)) throw new Error('tPdf: 自由度必须为正')
  const c = Math.exp(lnGamma((df + 1) / 2) - lnGamma(df / 2)) / Math.sqrt(df * Math.PI)
  return c * Math.pow(1 + (t * t) / df, -(df + 1) / 2)
}

/**
 * t 分布累积概率 P(T ≤ t)。
 *
 * 用 y = t²/(df+t²) 走不完全 Beta 的互补分支：若直接算 x = df/(df+t²)，
 * 当 |t| ≲ 1e-8 时 1-x 会被完全抵消（df+t² 舍入回 df），导致 CDF 在 0 附近
 * 饱和成 0.5，分位数求根随之卡在 1e-8 量级。改用 y 后小 t 与大 t 都精确。
 * 恒等式：I_x(df/2, 1/2) = 1 - I_y(1/2, df/2)，其中 x = 1 - y。
 */
export function tCdf(t, df) {
  if (!(df > 0)) throw new Error('tCdf: 自由度必须为正')
  const t2 = t * t
  const y = t2 / (df + t2)
  const half = 0.5 * incompleteBeta(0.5, df / 2, y)
  return t > 0 ? 0.5 + half : 0.5 - half
}

/** t 分布分位数：二分求根 + 牛顿抛光（括号保证不越界）。 */
export function tInv(p, df) {
  if (!(p > 0 && p < 1)) throw new Error(`tInv: 概率必须落在 (0,1)，收到 ${p}`)
  if (p === 0.5) return 0
  let lo = -1e4
  let hi = 1e4
  if (tCdf(lo, df) > p) return lo
  if (tCdf(hi, df) < p) return hi
  for (let i = 0; i < 120; i += 1) {
    const mid = 0.5 * (lo + hi)
    if (mid <= lo || mid >= hi) break
    if (tCdf(mid, df) < p) lo = mid
    else hi = mid
  }
  let x = 0.5 * (lo + hi)
  for (let k = 0; k < 6; k += 1) {
    const slope = tPdf(x, df)
    if (!(slope > 0)) break
    const step = (tCdf(x, df) - p) / slope
    if (!Number.isFinite(step) || step === 0) break
    const next = x - step
    if (next <= lo || next >= hi) break
    x = next
  }
  return x
}

/** F 分布密度。 */
export function fPdf(f, d1, d2) {
  if (!(d1 > 0 && d2 > 0)) throw new Error('fPdf: 自由度必须为正')
  if (f <= 0) return 0
  const lnC = (d1 / 2) * Math.log(d1 / d2) + lnGamma((d1 + d2) / 2) - lnGamma(d1 / 2) - lnGamma(d2 / 2)
  return Math.exp(lnC + (d1 / 2 - 1) * Math.log(f) - ((d1 + d2) / 2) * Math.log(1 + (d1 * f) / d2))
}

/** F 分布累积概率。 */
export function fCdf(f, d1, d2) {
  if (!(d1 > 0 && d2 > 0)) throw new Error('fCdf: 自由度必须为正')
  if (f <= 0) return 0
  return incompleteBeta(d1 / 2, d2 / 2, (d1 * f) / (d1 * f + d2))
}

/** F 分布分位数。 */
export function fInv(p, d1, d2) {
  if (!(p > 0 && p < 1)) throw new Error(`fInv: 概率必须落在 (0,1)，收到 ${p}`)
  let lo = 0
  let hi = 1e6
  while (fCdf(hi, d1, d2) < p && hi < 1e12) hi *= 10
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi)
    if (fCdf(mid, d1, d2) < p) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

/** 卡方分布密度。 */
export function chi2Pdf(x, df) {
  if (x <= 0) return 0
  const k = df / 2
  return Math.exp((k - 1) * Math.log(x) - x / 2 - lnGamma(k) - k * Math.log(2))
}

/** 卡方分布累积概率。 */
export function chi2Cdf(x, df) {
  if (x <= 0) return 0
  return incompleteGammaP(df / 2, x / 2)
}

/** 卡方分布分位数。 */
export function chi2Inv(p, df) {
  if (!(p > 0 && p < 1)) throw new Error(`chi2Inv: 概率必须落在 (0,1)，收到 ${p}`)
  let lo = 0
  let hi = Math.max(10, df * 4)
  while (chi2Cdf(hi, df) < p && hi < 1e12) hi *= 2
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi)
    if (chi2Cdf(mid, df) < p) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

// ---------------------------------------------------------------------------
// 描述统计
// ---------------------------------------------------------------------------

/** 线性插值分位数（与 numpy 默认 method='linear' 一致）。 */
export function quantile(sorted, p) {
  const n = sorted.length
  if (n === 0) throw new Error('quantile: 空数组')
  if (n === 1) return sorted[0]
  const h = (n - 1) * p
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

/** 数值数组清洗：只保留有限数。 */
export function finite(xs) {
  const out = []
  for (const x of xs) {
    const v = typeof x === 'number' ? x : Number(x)
    if (Number.isFinite(v)) out.push(v)
  }
  return out
}

/**
 * 描述统计。
 * @param {number[]} values 原始数值（可为字符串数字，自动转换）
 * @param {{label?: string, ci?: number}} [opts] ci 为置信水平，默认 0.95
 */
export function describe(values, opts = {}) {
  const xs = finite(values)
  const n = xs.length
  if (n === 0) throw new Error('describe: 该组没有有效数值')
  const sorted = [...xs].sort((a, b) => a - b)
  const mean = xs.reduce((a, b) => a + b, 0) / n
  let ss = 0
  let m3 = 0
  let m4 = 0
  for (const x of xs) {
    const d = x - mean
    ss += d * d
    m3 += d * d * d
    m4 += d * d * d * d
  }
  const variance = n > 1 ? ss / (n - 1) : 0
  const sd = Math.sqrt(variance)
  const se = n > 0 ? sd / Math.sqrt(n) : 0
  const level = opts.ci ?? 0.95
  const tcrit = n > 1 ? tInv(1 - (1 - level) / 2, n - 1) : Number.NaN
  // n = 1 时标准误无从估计，置信区间退化成点本身 —— 不能给 NaN，
  // 否则箱线图/误差棒的坐标会变成 NaN，canvas 静默什么都不画。
  const ci = n > 1 ? [mean - tcrit * se, mean + tcrit * se] : [mean, mean]
  // 偏度/峰度用无偏（bias=False）定义，与 scipy.stats.skew / kurtosis 一致
  const m2 = ss / n
  const g1 = m2 > 0 ? m3 / n / Math.pow(m2, 1.5) : 0
  const skew = n > 2 ? (g1 * Math.sqrt(n * (n - 1))) / (n - 2) : 0
  const g2 = m2 > 0 ? m4 / n / (m2 * m2) - 3 : 0
  const kurt = n > 3 ? ((n + 1) * g2 * (n - 1)) / ((n - 2) * (n - 3)) + (6 * (n - 1)) / ((n - 2) * (n - 3)) : 0
  return {
    label: opts.label ?? '',
    n,
    mean,
    sd,
    se,
    variance,
    median: quantile(sorted, 0.5),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
    iqr: quantile(sorted, 0.75) - quantile(sorted, 0.25),
    min: sorted[0],
    max: sorted[n - 1],
    sum: xs.reduce((a, b) => a + b, 0),
    cv: mean !== 0 ? sd / Math.abs(mean) : Number.NaN,
    skew,
    kurtosis: kurt,
    ciLevel: level,
    ci,
    ciHalf: n > 1 ? tcrit * se : Number.NaN,
  }
}

/**
 * 正态性检验 —— Shapiro-Wilk（Royston AS R94）。
 *
 * 只实现 n ≥ 6 的一般分支（n < 6 时 AS R94 需要另一套系数，且小样本下检验本身
 * 几乎没有判别力，因此直接如实说明而不是返回一个不可靠的 p）。与
 * scipy.stats.shapiro 对拍（tools/verify-math.mjs，n = 6…5000 抽查）。
 * @param {number[]} values
 * @returns {{w: number, p: number, note: string}} w 为统计量，p 为双尾 p 值
 */
export function shapiroWilk(values) {
  const xs = finite(values)
  const n = xs.length
  if (n < 6) return { w: Number.NaN, p: Number.NaN, note: '样本量 < 6，本实现不给出 Shapiro-Wilk（建议看 Q-Q 图目视判断）' }
  if (n > 5000) return { w: Number.NaN, p: Number.NaN, note: '样本量 > 5000，超出 Royston 近似适用范围' }
  const sorted = [...xs].sort((a, b) => a - b)
  const mean = sorted.reduce((a, b) => a + b, 0) / n
  const ss = sorted.reduce((a, b) => a + (b - mean) * (b - mean), 0)
  if (ss === 0) return { w: 1, p: 1, note: '所有取值相同（方差为 0）' }

  // 期望次序统计量的正态得分 m_i，及其单位向量 c_i
  const m = new Array(n)
  for (let i = 0; i < n; i += 1) m[i] = normalInv((i + 1 - 0.375) / (n + 0.25))
  const msum2 = m.reduce((a, b) => a + b * b, 0)
  const rootMsum2 = Math.sqrt(msum2)
  const u = 1 / Math.sqrt(n)
  const poly = (c0, c1, c2, c3, c4, c5) => c0 + c1 * u + c2 * u ** 2 + c3 * u ** 3 + c4 * u ** 4 + c5 * u ** 5
  const an = m[n - 1] / rootMsum2 +
    poly(0, 0.221157, -0.147981, -2.071190, 4.434685, -2.706056)
  const an1 = m[n - 2] / rootMsum2 +
    poly(0, 0.042981, -0.293762, -1.752461, 5.682633, -3.582633)

  const a = new Array(n).fill(0)
  a[n - 1] = an
  a[0] = -an
  a[n - 2] = an1
  a[1] = -an1
  const denom = 1 - 2 * an * an - 2 * an1 * an1
  const phi = (msum2 - 2 * m[n - 1] * m[n - 1] - 2 * m[n - 2] * m[n - 2]) / denom
  const rootPhi = Math.sqrt(phi)
  for (let i = 2; i < n - 2; i += 1) a[i] = m[i] / rootPhi

  let w = 0
  for (let i = 0; i < n; i += 1) w += a[i] * sorted[i]
  w = (w * w) / ss

  // Royston 正态化变换
  let z
  if (n <= 11) {
    const g = -2.273 + 0.459 * n
    const mu = 0.5440 - 0.39978 * n + 0.025054 * n * n - 0.0006714 * n * n * n
    const sigma = Math.exp(1.3822 - 0.77857 * n + 0.062767 * n * n - 0.0020322 * n * n * n)
    const y = -Math.log(g - Math.log(1 - w))
    z = (y - mu) / sigma
  } else {
    const ln = Math.log(n)
    const mu = -1.5861 - 0.31082 * ln - 0.083751 * ln * ln + 0.0038915 * ln ** 3
    const sigma = Math.exp(-0.4803 - 0.082676 * ln + 0.0030302 * ln * ln)
    z = (Math.log(1 - w) - mu) / sigma
  }
  const p = 1 - normalCdf(z)
  return { w, p: Math.min(1, Math.max(0, p)), note: '' }
}

// ---------------------------------------------------------------------------
// 检验
// ---------------------------------------------------------------------------

function tailFromCdf(cdf, alternative) {
  if (alternative === 'greater') return 1 - cdf
  if (alternative === 'less') return cdf
  return 2 * Math.min(cdf, 1 - cdf)
}

/** Cohen's d（合并标准差版）。 */
export function cohensD(mean1, mean2, sd1, n1, sd2, n2) {
  const df = n1 + n2 - 2
  if (df <= 0) return Number.NaN
  const sp2 = ((n1 - 1) * sd1 * sd1 + (n2 - 1) * sd2 * sd2) / df
  if (sp2 <= 0) return Number.NaN
  return (mean1 - mean2) / Math.sqrt(sp2)
}

/**
 * t 检验。
 * @param {number[]} a 第一组（单样本时即样本）
 * @param {number[]} [b] 第二组；配对检验时长度必须与 a 相同
 * @param {{mu?: number, paired?: boolean, welch?: boolean, alternative?: 'two-sided'|'greater'|'less', labelA?: string, labelB?: string}} [opts]
 */
export function tTest(a, b, opts = {}) {
  const xa = finite(a)
  const alternative = opts.alternative ?? 'two-sided'
  if (xa.length < 2) throw new Error('t 检验：第一组至少需要 2 个有效数值')
  const level = 0.95
  if (b === undefined || b === null) {
    const mu0 = opts.mu ?? 0
    const d = describe(xa, { label: opts.labelA ?? '样本' })
    const t = (d.mean - mu0) / d.se
    const df = d.n - 1
    const p = tailFromCdf(tCdf(t, df), alternative)
    const tcrit = tInv(1 - (1 - level) / 2, df)
    return {
      kind: 'one-sample',
      testName: '单样本 t 检验',
      h0: `总体均值 = ${mu0}`,
      t, df, p, alternative,
      estimate: d.mean, mu0,
      meanDiff: d.mean - mu0,
      ci: [d.mean - tcrit * d.se, d.mean + tcrit * d.se],
      effectSize: d.sd > 0 ? (d.mean - mu0) / d.sd : Number.NaN,
      effectName: "Cohen's d",
      groups: [d],
      n: d.n,
    }
  }
  const xb = finite(b)
  if (xb.length < 2) throw new Error('t 检验：第二组至少需要 2 个有效数值')
  if (opts.paired) {
    if (xa.length !== xb.length) throw new Error(`配对 t 检验：两组样本量必须相同（收到 ${xa.length} 与 ${xb.length}）`)
    const diffs = xa.map((v, i) => v - xb[i]).filter(Number.isFinite)
    const d = describe(diffs, { label: '差值' })
    const t = d.mean / d.se
    const df = d.n - 1
    const p = tailFromCdf(tCdf(t, df), alternative)
    const tcrit = tInv(1 - (1 - level) / 2, df)
    const da = describe(xa, { label: opts.labelA ?? 'A' })
    const db = describe(xb, { label: opts.labelB ?? 'B' })
    return {
      kind: 'paired',
      testName: '配对 t 检验',
      h0: '差值的总体均值 = 0',
      t, df, p, alternative,
      estimate: d.mean,
      meanDiff: d.mean,
      ci: [d.mean - tcrit * d.se, d.mean + tcrit * d.se],
      effectSize: d.sd > 0 ? d.mean / d.sd : Number.NaN,
      effectName: "Cohen's dz",
      groups: [da, db, d],
      n: d.n,
      pairs: { a: xa, b: xb, diff: diffs },
    }
  }
  const da = describe(xa, { label: opts.labelA ?? 'A' })
  const db = describe(xb, { label: opts.labelB ?? 'B' })
  const welch = opts.welch ?? true
  let t
  let df
  if (welch) {
    const va = da.variance / da.n
    const vb = db.variance / db.n
    t = (da.mean - db.mean) / Math.sqrt(va + vb)
    df = Math.pow(va + vb, 2) / ((va * va) / (da.n - 1) + (vb * vb) / (db.n - 1))
  } else {
    const sp2 = ((da.n - 1) * da.variance + (db.n - 1) * db.variance) / (da.n + db.n - 2)
    t = (da.mean - db.mean) / Math.sqrt(sp2 * (1 / da.n + 1 / db.n))
    df = da.n + db.n - 2
  }
  const p = tailFromCdf(tCdf(t, df), alternative)
  const meanDiff = da.mean - db.mean
  const seDiff = welch
    ? Math.sqrt(da.variance / da.n + db.variance / db.n)
    : Math.sqrt((((da.n - 1) * da.variance + (db.n - 1) * db.variance) / (da.n + db.n - 2)) * (1 / da.n + 1 / db.n))
  const tcrit = tInv(1 - (1 - level) / 2, df)
  // 方差齐性：F 检验（较大方差为分子）
  const fNum = da.variance >= db.variance ? da.variance : db.variance
  const fDen = da.variance >= db.variance ? db.variance : da.variance
  const fStat = fDen > 0 ? fNum / fDen : Number.NaN
  const fDf1 = da.variance >= db.variance ? da.n - 1 : db.n - 1
  const fDf2 = da.variance >= db.variance ? db.n - 1 : da.n - 1
  const leveneP = Number.isFinite(fStat) ? 2 * Math.min(fCdf(fStat, fDf1, fDf2), 1 - fCdf(fStat, fDf1, fDf2)) : Number.NaN
  return {
    kind: welch ? 'welch' : 'student',
    testName: welch ? "Welch's 独立样本 t 检验" : 'Student 独立样本 t 检验',
    h0: '两组总体均值相等',
    t, df, p, alternative,
    estimate: meanDiff,
    meanDiff,
    ci: [meanDiff - tcrit * seDiff, meanDiff + tcrit * seDiff],
    effectSize: cohensD(da.mean, db.mean, da.sd, da.n, db.sd, db.n),
    effectName: "Cohen's d",
    groups: [da, db],
    n: da.n + db.n,
    varianceTest: { f: fStat, df1: fDf1, df2: fDf2, p: leveneP, note: 'F 检验（方差齐性）；p > 0.05 时 Student 检验与 Welch 结果接近' },
  }
}

/**
 * 单因素方差分析 + 事后两两比较（Welch t + Holm-Bonferroni 校正）。
 * @param {Array<{label: string, values: number[]}>} groups
 */
export function anovaOneWay(groups) {
  if (!Array.isArray(groups) || groups.length < 2) throw new Error('ANOVA：至少需要 2 组')
  const prepared = groups.map((g, i) => ({
    label: g.label ?? `组${i + 1}`,
    values: finite(g.values ?? g.data ?? g),
  }))
  for (const g of prepared) {
    if (g.values.length < 2) throw new Error(`ANOVA：组「${g.label}」至少需要 2 个有效数值`)
  }
  const k = prepared.length
  const stats = prepared.map((g) => describe(g.values, { label: g.label }))
  const N = stats.reduce((a, d) => a + d.n, 0)
  const grandMean = stats.reduce((a, d) => a + d.mean * d.n, 0) / N
  const ssBetween = stats.reduce((a, d) => a + d.n * (d.mean - grandMean) ** 2, 0)
  const ssWithin = stats.reduce((a, d) => a + (d.n - 1) * d.variance, 0)
  const df1 = k - 1
  const df2 = N - k
  if (df2 <= 0) throw new Error('ANOVA：总样本量不足以估计组内方差（每组至少 2 个观测）')
  const msBetween = ssBetween / df1
  const msWithin = ssWithin / df2
  const f = msWithin > 0 ? msBetween / msWithin : Number.POSITIVE_INFINITY
  const ssTotal = ssBetween + ssWithin
  const p = Number.isFinite(f) ? 1 - fCdf(f, df1, df2) : 0
  const eta2 = ssTotal > 0 ? ssBetween / ssTotal : Number.NaN
  const omega2 = ssTotal > 0 ? (ssBetween - df1 * msWithin) / (ssTotal + msWithin) : Number.NaN
  const fcrit = fInv(0.95, df1, df2)
  // 事后两两比较（Welch t，Holm-Bonferroni）
  const posthoc = []
  for (let i = 0; i < k; i += 1) {
    for (let j = i + 1; j < k; j += 1) {
      const r = tTest(prepared[i].values, prepared[j].values, {
        welch: true,
        labelA: prepared[i].label,
        labelB: prepared[j].label,
      })
      posthoc.push({
        a: prepared[i].label,
        b: prepared[j].label,
        meanDiff: r.meanDiff,
        p: r.p,
        d: r.effectSize,
        ci: r.ci,
      })
    }
  }
  const sorted = [...posthoc].sort((x, y) => x.p - y.p)
  const m = sorted.length
  let prev = 0
  for (let i = 0; i < m; i += 1) {
    const adj = Math.min(1, Math.max(prev, (m - i) * sorted[i].p))
    sorted[i].pHolm = adj
    prev = adj
  }
  const byKey = new Map(sorted.map((r) => [`${r.a}\u0000${r.b}`, r.pHolm]))
  for (const r of posthoc) r.pHolm = byKey.get(`${r.a}\u0000${r.b}`)
  posthoc.sort((x, y) => (x.pHolm ?? 1) - (y.pHolm ?? 1))
  return {
    kind: 'anova',
    testName: '单因素方差分析（One-way ANOVA）',
    h0: '所有组的总体均值相等',
    f, df1, df2, p,
    ssBetween, ssWithin, ssTotal, msBetween, msWithin,
    eta2, omega2, fcrit,
    groups: stats,
    posthoc,
    posthocMethod: 'Welch t 检验 + Holm-Bonferroni 校正',
  }
}

/** 卡方独立性检验（含 Yates 连续性校正选项）。 */
export function chiSquareTest(table, opts = {}) {
  if (!Array.isArray(table) || table.length < 2) throw new Error('卡方检验：至少 2 行')
  const rows = table.length
  const cols = table[0].length
  if (cols < 2) throw new Error('卡方检验：至少 2 列')
  for (const r of table) if (r.length !== cols) throw new Error('卡方检验：每行列数必须一致')
  const values = table.map((r) => r.map((v) => Number(v)))
  for (const r of values) for (const v of r) if (!Number.isFinite(v) || v < 0) throw new Error('卡方检验：所有格子必须是非负数')
  const rowSum = values.map((r) => r.reduce((a, b) => a + b, 0))
  const colSum = new Array(cols).fill(0)
  for (const r of values) for (let j = 0; j < cols; j += 1) colSum[j] += r[j]
  const total = rowSum.reduce((a, b) => a + b, 0)
  if (total <= 0) throw new Error('卡方检验：总数必须大于 0')
  const useYates = opts.yates ?? (rows === 2 && cols === 2)
  let chi2 = 0
  let minExpected = Number.POSITIVE_INFINITY
  const expected = []
  for (let i = 0; i < rows; i += 1) {
    expected.push([])
    for (let j = 0; j < cols; j += 1) {
      const e = (rowSum[i] * colSum[j]) / total
      expected[i].push(e)
      minExpected = Math.min(minExpected, e)
      if (e <= 0) continue
      let o = values[i][j]
      if (useYates) {
        const diff = Math.abs(o - e) - 0.5
        o = e + Math.sign(o - e) * Math.max(0, diff)
      }
      chi2 += ((o - e) * (o - e)) / e
    }
  }
  const df = (rows - 1) * (cols - 1)
  const p = 1 - chi2Cdf(chi2, df)
  const cramersV = Math.sqrt(chi2 / (total * Math.min(rows - 1, cols - 1)))
  return {
    kind: 'chi2',
    testName: '卡方独立性检验',
    h0: '两变量相互独立',
    chi2, df, p, yates: useYates,
    total, cramersV,
    expected, minExpected,
    warn: minExpected < 5 ? `最小期望频数 ${minExpected.toFixed(2)} < 5，卡方近似可能不可靠（改用 Fisher 精确检验）` : '',
  }
}

/** 简单线性回归（最小二乘）+ 斜率检验 + 95% 置信带。 */
export function linearRegression(xs, ys) {
  const pairs = []
  const n0 = Math.min(xs.length, ys.length)
  for (let i = 0; i < n0; i += 1) {
    const x = Number(xs[i])
    const y = Number(ys[i])
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y])
  }
  const n = pairs.length
  if (n < 3) throw new Error('线性回归：至少需要 3 对有效数据')
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n
  const my = pairs.reduce((a, p) => a + p[1], 0) / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const [x, y] of pairs) {
    sxx += (x - mx) ** 2
    sxy += (x - mx) * (y - my)
    syy += (y - my) ** 2
  }
  if (sxx === 0) throw new Error('线性回归：所有 x 相同，无法拟合')
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const sse = syy - slope * sxy
  const df = n - 2
  const mse = df > 0 ? Math.max(0, sse) / df : 0
  const seSlope = Math.sqrt(mse / sxx)
  const seIntercept = Math.sqrt(mse * (1 / n + (mx * mx) / sxx))
  const r = syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0
  const t = seSlope > 0 ? slope / seSlope : Number.POSITIVE_INFINITY
  const p = tailFromCdf(tCdf(t, df), 'two-sided')
  const tcrit = tInv(0.975, df)
  const seResid = Math.sqrt(mse)
  const xMin = Math.min(...pairs.map((q) => q[0]))
  const xMax = Math.max(...pairs.map((q) => q[0]))
  const toFit = (x) => {
    const yhat = intercept + slope * x
    const seMean = seResid * Math.sqrt(1 / n + (x - mx) ** 2 / sxx)
    return { x, y: yhat, lo: yhat - tcrit * seMean, hi: yhat + tcrit * seMean }
  }
  return {
    kind: 'regression',
    testName: '简单线性回归',
    n, slope, intercept, r, r2: r * r, df,
    seSlope, seIntercept, seResid, mse, t, p, sse,
    slopeCi: [slope - tcrit * seSlope, slope + tcrit * seSlope],
    interceptCi: [intercept - tcrit * seIntercept, intercept + tcrit * seIntercept],
    pairs, xMin, xMax,
    toFit,
  }
}

/** 皮尔逊相关（含 t 检验）。 */
export function pearson(xs, ys) {
  const r = linearRegression(xs, ys)
  return { r: r.r, r2: r.r2, t: r.t, df: r.df, p: r.p, n: r.n }
}

/** 独立样本 t 检验的功效。 */
export function tTestPower(n1, n2, d, alpha = 0.05) {
  if (!(n1 > 1 && n2 > 1)) return Number.NaN
  const df = n1 + n2 - 2
  const ncp = Math.abs(d) * Math.sqrt((n1 * n2) / (n1 + n2))
  const tcrit = tInv(1 - alpha / 2, df)
  // P(T > tcrit | ncp) + P(T < -tcrit | ncp)
  const upper = 1 - noncentralTCdf(tcrit, df, ncp)
  const lower = noncentralTCdf(-tcrit, df, ncp)
  return Math.min(1, Math.max(0, upper + lower))
}

/**
 * 非中心 t 分布 CDF：P(T ≤ t)，T = (Z + ncp)/sqrt(V/df)，Z~N(0,1)，V~χ²(df)。
 *
 * 据定义展开为对 Z 的一维积分（被积函数在 [0,1] 内有界且光滑，Simpson 收敛快）：
 *   t > 0：P = Φ(-ncp) + ∫_{-ncp}^{∞} φ(z)·[1 - F_χ²(df·(z+ncp)²/t²)] dz
 *   t < 0：P = ∫_{-∞}^{-ncp} φ(z)·F_χ²(df·(z+ncp)²/t²) dz
 *   t = 0：P = Φ(-ncp)
 * 与 scipy.stats.nct.cdf 对拍（tools/verify-math.mjs）。
 */
export function noncentralTCdf(t, df, ncp) {
  if (!(df > 0)) throw new Error('noncentralTCdf: 自由度必须为正')
  if (t === 0) return normalCdf(-ncp)
  const Z_LIMIT = 9
  const steps = 2400
  const simpson = (from, to, f) => {
    if (!(to > from)) return 0
    const h = (to - from) / steps
    let acc = f(from) + f(to)
    for (let i = 1; i < steps; i += 1) acc += f(from + i * h) * (i % 2 === 1 ? 4 : 2)
    return (acc * h) / 3
  }
  let value
  if (t > 0) {
    const from = -ncp
    const to = Z_LIMIT
    value = normalCdf(-ncp) + simpson(from, Math.max(from, to), (z) => {
      const s = z + ncp
      return normalPdf(z) * (1 - chi2Cdf((df * s * s) / (t * t), df))
    })
  } else {
    const from = -Z_LIMIT
    const to = -ncp
    value = simpson(Math.min(from, to), to, (z) => {
      const s = z + ncp
      return normalPdf(z) * chi2Cdf((df * s * s) / (t * t), df)
    })
  }
  return Math.min(1, Math.max(0, value))
}

/** 达到目标功效所需每组样本量（双侧独立 t 检验，对 n 二分搜索：功效随 n 单调不减）。 */
export function sampleSizeTTest(d, power = 0.8, alpha = 0.05, ratio = 1) {
  if (!Number.isFinite(d) || d === 0) throw new Error('样本量估算：效应量 d 必须是非零有限数')
  if (!(power > 0 && power < 1)) throw new Error('样本量估算：目标功效必须落在 (0,1)')
  const powerAt = (n1) => {
    const n2 = Math.max(2, Math.round(n1 * ratio))
    return tTestPower(n1, n2, d, alpha)
  }
  const HI = 100000
  if (powerAt(HI) < power) throw new Error('样本量估算：在每组 n ≤ 100000 内未达到目标功效')
  let lo = 2
  let hi = HI
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (powerAt(mid) >= power) hi = mid
    else lo = mid + 1
  }
  const n2 = Math.max(2, Math.round(lo * ratio))
  return { n1: lo, n2, total: lo + n2, power: tTestPower(lo, n2, d, alpha) }
}

/**
 * Kaplan-Meier 生存曲线。
 *
 * groups: [{ label, times: number[], events: number[] }]，events 1 = 事件发生、0 = 删失。
 * 返回每组的阶梯点（含 Greenwood 标准误）、事件数、中位生存期。
 * 删失点单独记下来，画图时要在曲线上打竖杠 —— 不标删失是生存曲线最常见的误读来源。
 */
export function kaplanMeier(groups) {
  const out = []
  for (const g of groups || []) {
    const pairs = []
    const times = g.times || []
    for (let i = 0; i < times.length; i += 1) {
      const t = times[i]
      if (!isFinite(t)) continue
      pairs.push({ t, e: g.events && g.events[i] ? 1 : 0 })
    }
    pairs.sort((a, b) => a.t - b.t)
    const n = pairs.length
    let atRisk = n
    let s = 1
    let varSum = 0
    const points = [{ t: 0, s: 1, atRisk: n, se: 0 }]
    const censorMarks = []
    let i = 0
    while (i < pairs.length) {
      const t = pairs[i].t
      let d = 0
      let c = 0
      while (i < pairs.length && pairs[i].t === t) {
        if (pairs[i].e) d += 1
        else c += 1
        i += 1
      }
      if (d > 0 && atRisk > 0) {
        s *= (atRisk - d) / atRisk
        if (atRisk - d > 0) varSum += d / (atRisk * (atRisk - d))
      }
      atRisk -= d + c
      points.push({ t, s, atRisk, se: s * Math.sqrt(varSum), events: d, censored: c })
      if (c > 0) censorMarks.push({ t, s, count: c })
    }
    let median = null
    for (const p of points) if (p.s <= 0.5) { median = p.t; break }
    out.push({
      label: g.label || `组${out.length + 1}`,
      n,
      events: pairs.filter((p) => p.e).length,
      censored: pairs.filter((p) => !p.e).length,
      points,
      censorMarks,
      median,
      /** 曲线末端取值 = 该时刻的生存率（画图大致到这个位置） */
      minS: points.length ? points[points.length - 1].s : 1,
    })
  }
  return out
}

/** 小矩阵求逆（Gauss-Jordan）。log-rank 的协方差阵最多几阶，够用。 */
function invertSmall(m) {
  const n = m.length
  const a = m.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))))
  for (let col = 0; col < n; col += 1) {
    let piv = col
    for (let r = col + 1; r < n; r += 1) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r
    if (Math.abs(a[piv][col]) < 1e-12) return null
    ;[a[col], a[piv]] = [a[piv], a[col]]
    const d = a[col][col]
    for (let c = 0; c < 2 * n; c += 1) a[col][c] /= d
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue
      const f = a[r][col]
      if (f === 0) continue
      for (let c = 0; c < 2 * n; c += 1) a[r][c] -= f * a[col][c]
    }
  }
  return a.map((row) => row.slice(n))
}

/**
 * log-rank 检验（多组比较）。
 *
 * 标准算法：在每个事件时刻，按各组风险人数算期望事件数 E 与协方差阵 V，
 * 统计量 (O−E)ᵀ V⁻¹ (O−E) 服从 df = k−1 的卡方分布。
 * 返回 { chi2, df, p, observed, expected }；组数不足 2 或没有事件时返回 null。
 */
export function logRankTest(groups) {
  const km = (groups || []).map((g) => {
    const pairs = []
    const times = g.times || []
    for (let i = 0; i < times.length; i += 1) {
      if (isFinite(times[i])) pairs.push({ t: times[i], e: g.events && g.events[i] ? 1 : 0 })
    }
    pairs.sort((a, b) => a.t - b.t)
    return pairs
  })
  const k = km.length
  if (k < 2) return null
  const allTimes = [...new Set(km.flatMap((p) => p.filter((x) => x.e).map((x) => x.t)))].sort((a, b) => a - b)
  if (allTimes.length === 0) return null
  const O = new Array(k).fill(0)
  const E = new Array(k).fill(0)
  const V = Array.from({ length: k }, () => new Array(k).fill(0))
  for (const t of allTimes) {
    const n = km.map((pairs) => pairs.filter((x) => x.t >= t).length)
    const d = km.map((pairs) => pairs.filter((x) => x.t === t && x.e).length)
    const N = n.reduce((a, b) => a + b, 0)
    const D = d.reduce((a, b) => a + b, 0)
    if (N === 0 || D === 0) continue
    for (let i = 0; i < k; i += 1) {
      const pi = n[i] / N
      O[i] += d[i]
      E[i] += D * pi
      for (let j = 0; j < k; j += 1) {
        const pj = n[j] / N
        V[i][j] += (D * pi * (i === j ? 1 - pi : -pj) * (N - D)) / (N - 1 || 1)
      }
    }
  }
  // 去掉最后一组（行列线性相关），用前 k−1 阶
  const m = k - 1
  const Vr = Array.from({ length: m }, (_, i) => V[i].slice(0, m))
  const Vinv = invertSmall(Vr)
  if (!Vinv) return null
  const diff = Array.from({ length: m }, (_, i) => O[i] - E[i])
  let chi2 = 0
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < m; j += 1) chi2 += diff[i] * Vinv[i][j] * diff[j]
  }
  chi2 = Math.max(0, chi2)
  return { chi2, df: m, p: 1 - chi2Cdf(chi2, m), observed: O, expected: E }
}

/**
 * ROC 曲线与 AUC。
 *
 * labels: 0/1（1 = 阳性）；scores: 连续打分，越大越倾向阳性。
 * 返回 { points: [[fpr, tpr], ...], auc, best: { threshold, tpr, fpr, youden }, n1, n0 }。
 * 同分样本归到同一阈值（标准做法），否则曲线会凭空多出锯齿。
 */
export function rocCurve(labels, scores) {
  const pairs = []
  for (let i = 0; i < labels.length; i += 1) {
    if (!isFinite(scores[i])) continue
    pairs.push({ s: scores[i], y: labels[i] ? 1 : 0 })
  }
  const n1 = pairs.filter((p) => p.y === 1).length
  const n0 = pairs.length - n1
  if (n1 === 0 || n0 === 0) return null
  pairs.sort((a, b) => b.s - a.s)
  const points = [[0, 0]]
  let tp = 0
  let fp = 0
  let best = { threshold: pairs[0].s, tpr: 0, fpr: 0, youden: -Infinity }
  let auc = 0
  let prevFpr = 0
  let prevTpr = 0
  let i = 0
  while (i < pairs.length) {
    const s = pairs[i].s
    while (i < pairs.length && pairs[i].s === s) {
      if (pairs[i].y === 1) tp += 1
      else fp += 1
      i += 1
    }
    const tpr = tp / n1
    const fpr = fp / n0
    auc += ((fpr - prevFpr) * (tpr + prevTpr)) / 2
    points.push([fpr, tpr])
    const youden = tpr - fpr
    if (youden > best.youden) best = { threshold: s, tpr, fpr, youden }
    prevFpr = fpr
    prevTpr = tpr
  }
  return { points, auc, best, n1, n0 }
}

/** 直方图分箱（Freedman-Diaconis，样本量小时退回 Sturges）。 */
export function histogram(values, binCount) {
  const xs = finite(values)
  if (xs.length === 0) throw new Error('直方图：没有有效数值')
  const sorted = [...xs].sort((a, b) => a - b)
  const n = sorted.length
  let bins = binCount
  if (!bins) {
    const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25)
    const h = iqr > 0 ? 2 * iqr * Math.pow(n, -1 / 3) : 0
    const range = sorted[n - 1] - sorted[0]
    if (h > 0 && range / h >= 2) bins = Math.ceil(range / h)
    else bins = Math.ceil(Math.log2(n)) + 1
    bins = Math.min(60, Math.max(4, bins))
  }
  const lo = sorted[0]
  const hi = sorted[n - 1]
  const width = (hi - lo) / bins || 1
  const counts = new Array(bins).fill(0)
  for (const x of xs) {
    let idx = Math.floor((x - lo) / width)
    if (idx >= bins) idx = bins - 1
    if (idx < 0) idx = 0
    counts[idx] += 1
  }
  return {
    bins,
    width,
    lo,
    hi,
    edges: Array.from({ length: bins + 1 }, (_, i) => lo + i * width),
    centers: Array.from({ length: bins }, (_, i) => lo + (i + 0.5) * width),
    counts,
    density: counts.map((c) => c / (n * width)),
    n,
  }
}

/** 对数刻度下的“好看”刻度值（1-2-5 规则）。 */
export function niceTicks(min, max, target = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1
    min -= pad
    max += pad
  }
  const span = max - min
  const raw = span / Math.max(2, target)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const start = Math.ceil(min / step) * step
  const out = []
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  return out
}

/** 数字 → 紧凑字符串（图表标签用）。 */
export function fmt(x, digits) {
  if (!Number.isFinite(x)) return '—'
  const abs = Math.abs(x)
  if (abs === 0) return '0'
  if (abs >= 1e5 || abs < 1e-4) return x.toExponential(2).replace('e', '×10^')
  const d = digits ?? (abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3)
  return Number(x.toFixed(d)).toString()
}

/** p 值格式化（科研写作惯例）。 */
export function fmtP(p) {
  if (!Number.isFinite(p)) return '—'
  if (p < 1e-4) return 'p < 0.0001'
  if (p < 0.001) return `p = ${p.toExponential(2)}`
  return `p = ${p.toFixed(4)}`
}
