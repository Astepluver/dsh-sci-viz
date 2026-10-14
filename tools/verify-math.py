"""
dsh-sci-viz 数值内核对拍脚本（Python / scipy 侧）

读取 tools/verify-math.mjs 生成的 math-cases.json，用 scipy 独立重算每一项，
逐项比对并打印报告。任何一项超差 -> 退出码 1。

用法（工作区已有 scipy 1.18 venv）：
    C:\\Users\\<已隐去>\\dsh\\.venv-skills\\stat\\Scripts\\python.exe tools/verify-math.py [cases.json]
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy import stats

HERE = Path(__file__).resolve().parent
DEFAULT_CASES = HERE.parent / ".tmp" / "math-cases.json"

# 相对 / 绝对容差（对拍 scipy；实现走的是不完全 Beta/Gamma，量级 1e-12）
RTOL = 1e-8
ATOL = 1e-10

failures: list[str] = []
checked = 0


def close(a: float, b: float) -> bool:
    if a is None or b is None:
        return False
    if isinstance(a, float) and math.isnan(a):
        return isinstance(b, float) and math.isnan(b)
    if math.isinf(a) or math.isinf(b):
        return a == b
    return abs(a - b) <= ATOL + RTOL * max(abs(a), abs(b))


def check(label: str, got: float, want: float, tol_note: str = "") -> None:
    global checked
    checked += 1
    if not close(got, want):
        failures.append(f"{label}: js={got!r} scipy={want!r} {tol_note}")


def check_vec(label: str, got, want) -> None:
    g = np.asarray(got, dtype=float)
    w = np.asarray(want, dtype=float)
    if g.shape != w.shape:
        failures.append(f"{label}: shape {g.shape} != {w.shape}")
        return
    global checked
    for i, (a, b) in enumerate(zip(g.ravel(), w.ravel())):
        checked += 1
        if not close(float(a), float(b)):
            failures.append(f"{label}[{i}]: js={a!r} scipy={b!r}")


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CASES
    if not path.exists():
        print(f"找不到 {path}；先运行 node tools/verify-math.mjs")
        return 2
    data = json.loads(path.read_text(encoding="utf-8"))

    # ---- 标量分布函数 ---------------------------------------------------
    scalar_dispatch = {
        "normalCdf": lambda a: stats.norm.cdf(a[0]),
        "normalPdf": lambda a: stats.norm.pdf(a[0]),
        "normalInv": lambda a: stats.norm.ppf(a[0]),
        "tCdf": lambda a: stats.t.cdf(a[0], a[1]),
        "tPdf": lambda a: stats.t.pdf(a[0], a[1]),
        "tInv": lambda a: stats.t.ppf(a[0], a[1]),
        "fCdf": lambda a: stats.f.cdf(a[0], a[1], a[2]),
        "fPdf": lambda a: stats.f.pdf(a[0], a[1], a[2]),
        "chi2Cdf": lambda a: stats.chi2.cdf(a[0], a[1]),
        "chi2Pdf": lambda a: stats.chi2.pdf(a[0], a[1]),
        "noncentralTCdf": lambda a: stats.nct.cdf(a[0], a[1], a[2]),
        "erf": lambda a: math.erf(a[0]),
        "lnGamma": lambda a: math.lgamma(a[0]),
        "incompleteBeta": lambda a: stats.beta.cdf(a[2], a[0], a[1]),
    }
    for case in data["scalars"]:
        fn = case["fn"]
        want = scalar_dispatch[fn](case["args"])
        check(f"{fn}{tuple(round(x, 6) for x in case['args'])}", float(case["js"]), float(want))

    d = data["datasets"]
    res = data["results"]

    # ---- 描述统计 -------------------------------------------------------
    g1 = np.asarray(d["g1"], dtype=float)
    g2 = np.asarray(d["g2"], dtype=float)
    g3 = np.asarray(d["g3"], dtype=float)
    ds = res["describeG1"]
    check("describe.n", ds["n"], g1.size)
    check("describe.mean", ds["mean"], float(np.mean(g1)))
    check("describe.sd", ds["sd"], float(np.std(g1, ddof=1)))
    check("describe.median", ds["median"], float(np.median(g1)))
    check("describe.q1", ds["q1"], float(np.quantile(g1, 0.25)))
    check("describe.q3", ds["q3"], float(np.quantile(g1, 0.75)))
    check("describe.min", ds["min"], float(np.min(g1)))
    check("describe.max", ds["max"], float(np.max(g1)))
    check("describe.se", ds["se"], float(stats.sem(g1)))
    check("describe.skew", ds["skew"], float(stats.skew(g1, bias=False)))
    check("describe.kurtosis", ds["kurtosis"], float(stats.kurtosis(g1, bias=False)))
    ci = stats.t.interval(0.95, len(g1) - 1, loc=np.mean(g1), scale=stats.sem(g1))
    check_vec("describe.ci", ds["ci"], ci)
    sk = res["describeSkew"]
    check("describeSkew.skew", sk["skew"], float(stats.skew(np.asarray(d["skewData"]), bias=False)))

    # ---- t 检验 ---------------------------------------------------------
    ts = res["ttOneSample"]
    r = stats.ttest_1samp(g1, 10.0)
    check("tt1.t", ts["t"], float(r.statistic))
    check("tt1.p", ts["p"], float(r.pvalue))
    check("tt1.df", ts["df"], len(g1) - 1)
    half = stats.t.ppf(0.975, len(g1) - 1) * stats.sem(g1)
    check("tt1.ci.lo", ts["ci"][0], float(np.mean(g1) - half))
    check("tt1.ci.hi", ts["ci"][1], float(np.mean(g1) + half))

    tw = res["ttWelch"]
    r = stats.ttest_ind(g1, g2, equal_var=False)
    check("ttWelch.t", tw["t"], float(r.statistic))
    check("ttWelch.p", tw["p"], float(r.pvalue))
    check("ttWelch.df", tw["df"], float(r.df))

    tsr = res["ttStudent"]
    r = stats.ttest_ind(g1, g2, equal_var=True)
    check("ttStudent.t", tsr["t"], float(r.statistic))
    check("ttStudent.p", tsr["p"], float(r.pvalue))
    check("ttStudent.df", tsr["df"], float(r.df))

    tp = res["ttPaired"]
    r = stats.ttest_rel(np.asarray(d["pairedA"]), np.asarray(d["pairedB"]))
    check("ttPaired.t", tp["t"], float(r.statistic))
    check("ttPaired.p", tp["p"], float(r.pvalue))

    # Cohen's d（合并标准差）
    def cohen_d(a: np.ndarray, b: np.ndarray) -> float:
        n1, n2 = a.size, b.size
        sp = math.sqrt(((n1 - 1) * a.var(ddof=1) + (n2 - 1) * b.var(ddof=1)) / (n1 + n2 - 2))
        return float((a.mean() - b.mean()) / sp)

    check("ttWelch.d", tw["effectSize"], cohen_d(g1, g2))

    # ---- ANOVA ----------------------------------------------------------
    an = res["anova"]
    F, p = stats.f_oneway(g1, g2, g3)
    check("anova.f", an["f"], float(F))
    check("anova.p", an["p"], float(p))
    check("anova.df1", an["df1"], 2)
    check("anova.df2", an["df2"], len(g1) + len(g2) + len(g3) - 3)
    allv = np.concatenate([g1, g2, g3])
    grand = allv.mean()
    ssb = sum(len(x) * (x.mean() - grand) ** 2 for x in (g1, g2, g3))
    ssw = sum(((x - x.mean()) ** 2).sum() for x in (g1, g2, g3))
    check("anova.ssBetween", an["ssBetween"], float(ssb))
    check("anova.ssWithin", an["ssWithin"], float(ssw))
    check("anova.eta2", an["eta2"], float(ssb / (ssb + ssw)))
    check("anova.posthoc.count", len(an["posthoc"]), 3)
    pw = stats.ttest_ind(g1, g2, equal_var=False)
    ph = [x for x in an["posthoc"] if {x["a"], x["b"]} == {"A", "B"}]
    if ph:
        check("anova.posthoc(A,B).p", ph[0]["p"], float(pw.pvalue))
        check("anova.posthoc(A,B).diff", ph[0]["meanDiff"], float(g1.mean() - g2.mean()))
    else:
        failures.append("anova.posthoc: 缺少 A-B 比较")

    # ---- 卡方 -----------------------------------------------------------
    ch = res["chi2"]
    c2, p2, dof, exp = stats.chi2_contingency(np.asarray(d["table2x2"]))
    check("chi2.stat", ch["chi2"], float(c2))
    check("chi2.p", ch["p"], float(p2))
    check("chi2.df", ch["df"], int(dof))
    check_vec("chi2.expected", ch["expected"], exp)
    c3, p3, dof3, exp3 = stats.chi2_contingency(np.asarray(d["table2x3"]))
    check("chi2x3.stat", res["chi2x3"]["chi2"], float(c3))
    check("chi2x3.p", res["chi2x3"]["p"], float(p3))
    check("chi2x3.df", res["chi2x3"]["df"], int(dof3))
    check_vec("chi2x3.expected", res["chi2x3"]["expected"], exp3)

    # ---- 线性回归 -------------------------------------------------------
    rg = res["regression"]
    lr = stats.linregress(np.asarray(d["regX"]), np.asarray(d["regY"]))
    check("reg.slope", rg["slope"], float(lr.slope))
    check("reg.intercept", rg["intercept"], float(lr.intercept))
    check("reg.r", rg["r"], float(lr.rvalue))
    check("reg.r2", rg["r2"], float(lr.rvalue) ** 2)
    check("reg.p", rg["p"], float(lr.pvalue))
    check("reg.seSlope", rg["seSlope"], float(lr.stderr))
    check("reg.n", rg["n"], len(d["regX"]))
    for i, pt in enumerate(data["toFitSample"]):
        check(f"reg.toFit[{i}].y", pt["y"], float(lr.intercept + lr.slope * pt["x"]))

    # ---- Shapiro-Wilk ---------------------------------------------------
    # 样本由 JS 侧一并写出（results.shapiroSamples），Python 端用 scipy 重算同一批数据
    shapiro_samples = res.get("shapiroSamples")
    if shapiro_samples is None:
        failures.append("缺少 results.shapiroSamples：JS 侧需把样本一起写出才能与 scipy 对拍")
    else:
        for key, sample in shapiro_samples.items():
            got = res["shapiro"][key]
            if math.isnan(got["w"]):
                continue
            w, p = stats.shapiro(np.asarray(sample, dtype=float))
            check(f"shapiro[{key}].w", got["w"], float(w))
            check(f"shapiro[{key}].p", got["p"], float(p))

    # ---- 功效 / 样本量 --------------------------------------------------
    for key, item in res["power"].items():
        n1, n2, dd, alpha = item["n1"], item["n2"], item["d"], item["alpha"]
        dfree = n1 + n2 - 2
        ncp = abs(dd) * math.sqrt(n1 * n2 / (n1 + n2))
        tcrit = stats.t.ppf(1 - alpha / 2, dfree)
        want = float(stats.nct.sf(tcrit, dfree, ncp) + stats.nct.cdf(-tcrit, dfree, ncp))
        check(f"power[{key}]", item["power"], want, "（非中心 t 数值积分）")

    for key, item in res["sampleSize"].items():
        dd = float(key[1:])
        n1 = item["n1"]
        dfree = 2 * n1 - 2
        ncp = abs(dd) * math.sqrt(n1 * n1 / (2 * n1))
        tcrit = stats.t.ppf(0.975, dfree)
        achieved = float(stats.nct.sf(tcrit, dfree, ncp) + stats.nct.cdf(-tcrit, dfree, ncp))
        if achieved < 0.8 - 1e-9:
            failures.append(f"sampleSize[{key}]: n1={n1} 的功效 {achieved:.6f} < 0.8")
        prev = n1 - 1
        if prev >= 2:
            dfp = 2 * prev - 2
            ncpp = abs(dd) * math.sqrt(prev * prev / (2 * prev))
            tc = stats.t.ppf(0.975, dfp)
            ach_prev = float(stats.nct.sf(tc, dfp, ncpp) + stats.nct.cdf(-tc, dfp, ncpp))
            if ach_prev >= 0.8 + 1e-9:
                failures.append(f"sampleSize[{key}]: n1={n1} 不是最小解（n1={prev} 已达标 {ach_prev:.6f}）")

    # ---- 报告 -----------------------------------------------------------
    lines: list[str] = [f"对拍项数: {checked}"]
    if failures:
        lines.append(f"超差 {len(failures)} 项：")
        for f in failures[:80]:
            lines.append(f"  [FAIL] {f}")
        if len(failures) > 80:
            lines.append(f"  ... 其余 {len(failures) - 80} 项省略")
        code = 1
    else:
        lines.append("全部通过：JS 数值内核与 scipy 1.18 在 rtol=1e-8 / atol=1e-10 内一致。")
        code = 0
    text = "\n".join(lines)
    report = HERE.parent / ".tmp" / "verify-math-report.txt"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(text + "\n", encoding="utf-8")
    print(f"checked={checked} failures={len(failures)} report={report}")
    return code


if __name__ == "__main__":
    sys.exit(main())
