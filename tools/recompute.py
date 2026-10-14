#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-sci-viz 自带统计 oracle —— 供验证规程「对拍层」独立重算用。

为什么要有它：
  scientific 图上的统计量是 lib/core/numeric.js 算的。要证明图上的数字没错，就不能拿同一份
  实现再算一遍 —— 那只是自我复述。这里用**完全独立的实现**（纯 stdlib，不 import numpy/scipy，
  也不碰 numeric.js 的任何代码）重算同一批量，然后由验证者比对两边数字。

为什么必须是纯标准库：
  这个插件是**分享出去就能用**的，不能假设对方机器装了 scipy。所以本 oracle 只依赖 Python
  标准库；对方环境里有 scipy 时，也可以额外跑 tools/verify-math.py 做更细的内核对拍 ——
  跑不起来就如实标「该通道不可用」，不要声称已对拍。两条通道互不依赖。

用法：
    python recompute.py --selftest          # 先自检（对着已发表的临界值），退出码 0 = 可信
    python recompute.py spec.json           # 对拍：按 spec 算，结果以 JSON 打到 stdout
    python recompute.py -                   # spec 从 stdin 读

spec 形状：
    {"test": "t_test", "args": {"a": [...], "b": [...], "welch": true}}
    或一次算多个：{"tests": [{"test": "...", "args": {...}}, ...]}

支持的 test：
    describe / t_test / anova_oneway / chi2_independence / chi2_goodness / ols / mean_ci
"""

from __future__ import annotations

import json
import math
import sys

# ───────────────────────── 数值底座（Numerical Recipes 风格） ─────────────────────────

_MAXIT = 200
_EPS = 3.0e-16
_FPMIN = 1.0e-300


def betacf(a: float, b: float, x: float) -> float:
    """连分式展开：正则化不完全 beta 的连分式部分。"""
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < _FPMIN:
        d = _FPMIN
    d = 1.0 / d
    h = d
    for m in range(1, _MAXIT + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < _FPMIN:
            d = _FPMIN
        c = 1.0 + aa / c
        if abs(c) < _FPMIN:
            c = _FPMIN
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < _FPMIN:
            d = _FPMIN
        c = 1.0 + aa / c
        if abs(c) < _FPMIN:
            c = _FPMIN
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < _EPS:
            break
    return h


def betai(a: float, b: float, x: float) -> float:
    """正则化不完全 beta 函数 I_x(a, b)。"""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    lbt = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log1p(-x)
    bt = math.exp(lbt)
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * betacf(a, b, x) / a
    return 1.0 - bt * betacf(b, a, 1.0 - x) / b


def gammp(a: float, x: float) -> float:
    """正则化下不完全 gamma P(a, x)。"""
    if x < 0.0 or a <= 0.0:
        raise ValueError("gammp: 参数越界")
    if x == 0.0:
        return 0.0
    if x < a + 1.0:
        ap, total, delta = a, 1.0 / a, 1.0 / a
        for _ in range(_MAXIT):
            ap += 1.0
            delta *= x / ap
            total += delta
            if abs(delta) < abs(total) * _EPS:
                break
        return total * math.exp(-x + a * math.log(x) - math.lgamma(a))
    return 1.0 - gammq(a, x)


def gammq(a: float, x: float) -> float:
    """正则化上不完全 gamma Q(a, x) = 1 - P(a, x)。"""
    if x < a + 1.0:
        return 1.0 - gammp(a, x)
    b, c, d = x + 1.0 - a, 1.0 / _FPMIN, 1.0 / (x + 1.0 - a)
    h = d
    for i in range(1, _MAXIT + 1):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < _FPMIN:
            d = _FPMIN
        c = b + an / c
        if abs(c) < _FPMIN:
            c = _FPMIN
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < _EPS:
            break
    return math.exp(-x + a * math.log(x) - math.lgamma(a)) * h


def norm_sf_two_sided(z: float) -> float:
    """标准正态双侧 p 值。"""
    return math.erfc(abs(z) / math.sqrt(2.0))


def t_p_two_sided(t: float, df: float) -> float:
    """Student t 双侧 p 值。"""
    if df <= 0:
        raise ValueError("t 分布自由度必须 > 0")
    return betai(df / 2.0, 0.5, df / (df + t * t))


def chi2_sf(x: float, df: float) -> float:
    """卡方上尾概率。"""
    if df <= 0:
        raise ValueError("卡方自由度必须 > 0")
    return gammq(df / 2.0, x / 2.0)


def f_sf(f: float, d1: float, d2: float) -> float:
    """F 分布上尾概率。"""
    if f <= 0:
        return 1.0
    return betai(d2 / 2.0, d1 / 2.0, d2 / (d2 + d1 * f))


def _t_crit(df: float, level: float = 0.95) -> float:
    """二分求 t 临界值（用于置信区间）。"""
    target = 1.0 - level
    lo, hi = 0.0, 1e4
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if t_p_two_sided(mid, df) > target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


# ───────────────────────── 统计量 ─────────────────────────


def _floats(seq, name):
    if not isinstance(seq, (list, tuple)) or len(seq) == 0:
        raise ValueError(f"{name} 必须是非空数组")
    out = []
    for v in seq:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"{name} 含非数值元素：{v!r}")
        if not math.isfinite(v):
            raise ValueError(f"{name} 含 NaN/Inf：{v!r}")
        out.append(float(v))
    return out


def _mean(xs):
    return sum(xs) / len(xs)


def _var(xs, ddof=1):
    if len(xs) <= ddof:
        raise ValueError("样本量不足以估计方差")
    m = _mean(xs)
    return sum((x - m) ** 2 for x in xs) / (len(xs) - ddof)


def _quantile(sorted_xs, q):
    if not sorted_xs:
        raise ValueError("空数组")
    pos = (len(sorted_xs) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return sorted_xs[lo]
    return sorted_xs[lo] + (sorted_xs[hi] - sorted_xs[lo]) * (pos - lo)


def op_describe(args):
    xs = _floats(args.get("x"), "x")
    s = sorted(xs)
    n = len(xs)
    sd = math.sqrt(_var(xs)) if n > 1 else 0.0
    return {
        "n": n,
        "mean": _mean(xs),
        "sd": sd,
        "se": sd / math.sqrt(n) if n > 1 else None,
        "median": _quantile(s, 0.5),
        "q1": _quantile(s, 0.25),
        "q3": _quantile(s, 0.75),
        "iqr": _quantile(s, 0.75) - _quantile(s, 0.25),
        "min": s[0],
        "max": s[-1],
    }


def op_mean_ci(args):
    xs = _floats(args.get("x"), "x")
    level = float(args.get("level", 0.95))
    n = len(xs)
    if n < 2:
        raise ValueError("置信区间至少需要 2 个观测")
    m, sd = _mean(xs), math.sqrt(_var(xs))
    tc = _t_crit(n - 1, level)
    half = tc * sd / math.sqrt(n)
    return {"n": n, "mean": m, "sd": sd, "level": level, "t_crit": tc, "ci_low": m - half, "ci_high": m + half}


def op_t_test(args):
    a = _floats(args.get("a"), "a")
    b_raw = args.get("b")
    level = float(args.get("level", 0.95))
    if b_raw is None:
        mu0 = float(args.get("mu", 0.0))
        n = len(a)
        if n < 2:
            raise ValueError("单样本 t 检验至少需要 2 个观测")
        m, sd = _mean(a), math.sqrt(_var(a))
        se = sd / math.sqrt(n)
        t = (m - mu0) / se
        df = n - 1
        tc = _t_crit(df, level)
        return {
            "test": "one_sample_t",
            "n": n,
            "mean": m,
            "sd": sd,
            "se": se,
            "mu": mu0,
            "t": t,
            "df": df,
            "p": t_p_two_sided(t, df),
            "ci_low": m - tc * se,
            "ci_high": m + tc * se,
        }
    b = _floats(b_raw, "b")
    welch = bool(args.get("welch", True))
    n1, n2 = len(a), len(b)
    if n1 < 2 or n2 < 2:
        raise ValueError("两样本 t 检验每组至少 2 个观测")
    m1, m2 = _mean(a), _mean(b)
    v1, v2 = _var(a), _var(b)
    if welch:
        se = math.sqrt(v1 / n1 + v2 / n2)
        df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1))
        kind = "welch_t"
    else:
        sp2 = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2)
        se = math.sqrt(sp2 * (1.0 / n1 + 1.0 / n2))
        df = n1 + n2 - 2
        kind = "student_t"
    t = (m1 - m2) / se
    tc = _t_crit(df, level)
    return {
        "test": kind,
        "n1": n1,
        "n2": n2,
        "mean1": m1,
        "mean2": m2,
        "mean_diff": m1 - m2,
        "se_diff": se,
        "t": t,
        "df": df,
        "p": t_p_two_sided(t, df),
        "ci_low": (m1 - m2) - tc * se,
        "ci_high": (m1 - m2) + tc * se,
        "cohens_d": (m1 - m2) / math.sqrt((v1 + v2) / 2.0),
    }


def op_anova_oneway(args):
    groups_raw = args.get("groups")
    if not isinstance(groups_raw, list) or len(groups_raw) < 2:
        raise ValueError("ANOVA 至少需要 2 组")
    groups = [_floats(g, f"groups[{i}]") for i, g in enumerate(groups_raw)]
    k = len(groups)
    ns = [len(g) for g in groups]
    total_n = sum(ns)
    if total_n - k < 1:
        raise ValueError("ANOVA 组内自由度不足")
    grand = sum(sum(g) for g in groups) / total_n
    ss_between = sum(n * (_mean(g) - grand) ** 2 for n, g in zip(ns, groups))
    ss_within = sum(sum((x - _mean(g)) ** 2 for x in g) for g in groups)
    df_b, df_w = k - 1, total_n - k
    ms_b, ms_w = ss_between / df_b, ss_within / df_w
    f = ms_b / ms_w if ms_w > 0 else float("inf")
    return {
        "test": "one_way_anova",
        "k": k,
        "n": total_n,
        "group_means": [_mean(g) for g in groups],
        "group_sds": [math.sqrt(_var(g)) for g in groups],
        "ss_between": ss_between,
        "ss_within": ss_within,
        "df_between": df_b,
        "df_within": df_w,
        "ms_between": ms_b,
        "ms_within": ms_w,
        "F": f,
        "p": f_sf(f, df_b, df_w) if math.isfinite(f) else 0.0,
        "eta_squared": ss_between / (ss_between + ss_within),
    }


def op_chi2_independence(args):
    table = args.get("table")
    if not isinstance(table, list) or len(table) < 2:
        raise ValueError("列联表至少 2 行")
    rows = [[float(v) for v in row] for row in table]
    if any(len(r) != len(rows[0]) for r in rows):
        raise ValueError("列联表各行长度必须一致")
    r, c = len(rows), len(rows[0])
    if r < 2 or c < 2:
        raise ValueError("列联表至少 2×2")
    row_sums = [sum(row) for row in rows]
    col_sums = [sum(rows[i][j] for i in range(r)) for j in range(c)]
    total = sum(row_sums)
    if total <= 0:
        raise ValueError("列联表合计必须 > 0")
    expected_min = float("inf")
    chi2 = 0.0
    for i in range(r):
        for j in range(c):
            e = row_sums[i] * col_sums[j] / total
            expected_min = min(expected_min, e)
            if e > 0:
                chi2 += (rows[i][j] - e) ** 2 / e
    df = (r - 1) * (c - 1)
    return {
        "test": "chi2_independence",
        "rows": r,
        "cols": c,
        "n": total,
        "chi2": chi2,
        "df": df,
        "p": chi2_sf(chi2, df) if df > 0 else None,
        "cramers_v": math.sqrt(chi2 / (total * min(r - 1, c - 1))),
        "min_expected": expected_min,
        "expected_below_5": expected_min < 5.0,
    }


def op_chi2_goodness(args):
    observed = _floats(args.get("observed"), "observed")
    expected_raw = args.get("expected")
    if expected_raw is None:
        e = sum(observed) / len(observed)
        expected = [e] * len(observed)
    else:
        expected = _floats(expected_raw, "expected")
        if len(expected) != len(observed):
            raise ValueError("observed 与 expected 长度必须一致")
    if abs(sum(observed) - sum(expected)) > 1e-6 * max(1.0, sum(observed)):
        raise ValueError("observed 与 expected 合计必须一致")
    df_adj = int(args.get("df_adjust", 0))
    chi2 = sum((o - e) ** 2 / e for o, e in zip(observed, expected) if e > 0)
    df = len(observed) - 1 - df_adj
    if df <= 0:
        raise ValueError("自由度 <= 0")
    return {
        "test": "chi2_goodness",
        "k": len(observed),
        "chi2": chi2,
        "df": df,
        "p": chi2_sf(chi2, df),
        "min_expected": min(expected),
        "expected_below_5": min(expected) < 5.0,
    }


def op_ols(args):
    x = _floats(args.get("x"), "x")
    y = _floats(args.get("y"), "y")
    if len(x) != len(y):
        raise ValueError("x 与 y 长度必须一致")
    n = len(x)
    if n < 3:
        raise ValueError("回归至少需要 3 个观测")
    mx, my = _mean(x), _mean(y)
    sxx = sum((xi - mx) ** 2 for xi in x)
    sxy = sum((xi - mx) * (yi - my) for xi, yi in zip(x, y))
    syy = sum((yi - my) ** 2 for yi in y)
    if sxx == 0:
        raise ValueError("x 无变异，无法拟合斜率")
    slope = sxy / sxx
    intercept = my - slope * mx
    ss_res = syy - slope * sxy
    r2 = 1.0 - ss_res / syy if syy > 0 else 0.0
    df = n - 2
    mse = ss_res / df
    se_slope = math.sqrt(mse / sxx)
    t = slope / se_slope if se_slope > 0 else float("inf")
    return {
        "test": "ols",
        "n": n,
        "slope": slope,
        "intercept": intercept,
        "r2": r2,
        "adj_r2": 1.0 - (1.0 - r2) * (n - 1) / df,
        "se_slope": se_slope,
        "t": t,
        "df": df,
        "p": t_p_two_sided(t, df) if math.isfinite(t) else 0.0,
        "pearson_r": math.sqrt(max(r2, 0.0)) * (1.0 if slope >= 0 else -1.0),
    }


OPS = {
    "describe": op_describe,
    "mean_ci": op_mean_ci,
    "t_test": op_t_test,
    "anova_oneway": op_anova_oneway,
    "chi2_independence": op_chi2_independence,
    "chi2_goodness": op_chi2_goodness,
    "ols": op_ols,
}


# ───────────────────────── 自检：对着已发表临界值 ─────────────────────────

ANCHORS = [
    # 常数取自标准临界值表（精确到 6–7 位有效数字）。第一次写这组锚点时我把 df=10 的 t 写成
    # 2.228、把 F(2,3) 写成 19.39582，自检当场报 FAIL —— 错的锚点会被当成 oracle 错，所以
    # 这一步必须留，而且要写出精确常数。
    ("t 双侧 t=2.306004, df=8", lambda: t_p_two_sided(2.306004, 8), 0.05),
    ("t 双侧 t=2.228139, df=10", lambda: t_p_two_sided(2.228139, 10), 0.05),
    ("t 双侧 t=1.959964, df=1e6", lambda: t_p_two_sided(1.959964, 1e6), 0.05),
    ("正态双侧 z=1.959964", lambda: norm_sf_two_sided(1.959964), 0.05),
    ("卡方上尾 3.841459, df=1", lambda: chi2_sf(3.841459, 1), 0.05),
    ("卡方上尾 5.991465, df=2", lambda: chi2_sf(5.991465, 2), 0.05),
    ("卡方上尾 7.814728, df=3", lambda: chi2_sf(7.814728, 3), 0.05),
    ("F 上尾 5.317655, df=(1,8)", lambda: f_sf(5.317655, 1, 8), 0.05),
    ("F 上尾 4.102821, df=(2,10)", lambda: f_sf(4.102821, 2, 10), 0.05),
    ("F 上尾 9.552094, df=(2,3)", lambda: f_sf(9.552094, 2, 3), 0.05),
]


def selftest():
    failures = []
    for label, fn, expected in ANCHORS:
        try:
            got = fn()
        except Exception as exc:  # noqa: BLE001
            failures.append((label, f"抛异常 {type(exc).__name__}: {exc}", expected))
            continue
        if not math.isfinite(got) or abs(got - expected) > 1e-4 * max(1e-12, abs(expected)):
            failures.append((label, got, expected))
    return failures


def main(argv):
    try:  # Windows 控制台默认 GBK，中文报告会变乱码；统一按 UTF-8 输出
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    if "--selftest" in argv:
        failures = selftest()
        for label, got, expected in failures:
            print(f"FAIL {label}: got={got} expected={expected}")
        print(f"oracle 自检：{len(ANCHORS) - len(failures)}/{len(ANCHORS)} 通过")
        if failures:
            print("结论：不可信，禁止用它做对拍")
            return 1
        print("结论：可信（全部锚点命中已发表临界值）")
        return 0

    src = argv[1] if len(argv) > 1 else "-"
    try:
        raw = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
        spec = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"spec 读取失败：{exc}"}, ensure_ascii=False))
        return 2

    jobs = spec.get("tests") if isinstance(spec, dict) and "tests" in spec else [spec]
    results = []
    for job in jobs:
        name = job.get("test")
        args = job.get("args", {})
        op = OPS.get(name)
        if op is None:
            results.append({"test": name, "ok": False, "error": f"未知 test，可用：{sorted(OPS)}"})
            continue
        try:
            results.append({"test": name, "ok": True, "result": op(args)})
        except Exception as exc:  # noqa: BLE001
            results.append({"test": name, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
    print(json.dumps({"ok": all(r["ok"] for r in results), "oracle": "dsh-sci-viz/tools/recompute.py", "results": results}, ensure_ascii=False, indent=2))
    return 0 if all(r["ok"] for r in results) else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv))
