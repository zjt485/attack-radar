'use strict';
// ============================================================================
// buypoint.js —— 两阶段买点状态机（延续确认门 + 用户短线博弈纪律）
// 8/28 用户点题验证定稿：纯等回踩会漏掉直拉封板股（天山），纯追报警会套在日内顶。
// 正确答案 = 报警只进观察，必须"突破报警后新高（确认延续）"才解锁买入资格。
// 8/28 用户补纪律（只考虑20cm、<5cm介入，才有短线博弈价值）：
//   - 买点只做创业板(sz30)，10cm/科创板不进观察
//   - 报警时涨幅 ≥5cm → 已高位，不进观察（光智+9%/麦捷+11% 这类出局）
//   - 报警时涨幅 <3.5cm → 低位直取（确认门在低位是累赘：天山确认后买点+5.6%会超5cm被滤掉）
//   - 报警时 3.5~5cm → 走确认门，但买点价也必须 <5cm（超了不追，等更深回踩）
// 回测：天山低位直取+16.6%，今日4只套人票+光智/鑫磊全部出局。
// ============================================================================

// 默认参数（回测验证值）
const DEFAULT_CFG = {
  confirmPct: 0.6,      // 突破报警价上方 0.6% = 确认延续
  maxDrop: 4,           // 防线：报警价下方 4%
  microPull: 0.4,       // 微回踩最小深度（确认后）
  pullbackMin: 1.2,     // 深回踩最小深度
  volRatio: 1.5,        // 深回踩企稳量比
  confirmTimeout: 45,   // 确认窗口（分钟/根）
  // ---- 用户短线博弈纪律（8/28 拍板）----
  only20cm: true,       // 买点只做创业板(sz30)
  directEntryPct: 3.5,  // 报警涨幅 <3.5cm → 低位直取
  alertMaxPct: 5,       // 报警涨幅 ≥5cm → 不进观察
  entryMaxPct: 5        // 买点价相对昨收必须 <5cm
};

// 报警触发时的介入资格审查：非20cm / 报警超5cm → 不进观察
function eligibleWatch(code, alertPrice, prevClose, cfg = {}) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const raw = String(code).replace(/^(sz|sh|bj)/i, '');
  const is20cm = raw.startsWith('30');   // 创业板 30 开头 = 20cm（兼容 sz300313 / 300313 两种格式）
  if (c.only20cm && !is20cm) return { ok: false, reason: 'not_20cm' };
  const pct = (alertPrice / prevClose - 1) * 100;
  if (pct >= c.alertMaxPct) return { ok: false, reason: 'alert_too_high', pct };
  if (pct < c.directEntryPct) return { ok: true, mode: 'direct', pct };
  return { ok: true, mode: 'gate', pct };
}

// 创建观察态（报警触发时调用）；低位直取在创建瞬间即成买点
function createWatch(alertBar, alertPrice, prevClose, cfg = {}) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const pct = (alertPrice / prevClose - 1) * 100;
  const w = {
    cfg: c,
    alertT: alertBar.t,
    alertPrice,
    prevClose,
    peak: alertPrice,          // 报警后最高价
    confirmed: false,          // 是否已突破确认位
    confirmT: null,
    status: 'watching',        // watching | confirmed | entry | rejected
    rejectReason: null,
    entry: null,               // {t, price, mode}
    // 深回踩段累计
    pullbackPhase: false,
    pbLow: Infinity, pbVolSum: 0, pbBars: 0
  };
  if (pct < c.directEntryPct) {
    // 低位直取：报警时刻本身就是买点（+2.9% 的天山型），确认门在此档是累赘
    w.status = 'entry';
    w.entry = { t: alertBar.t, price: alertPrice, mode: 'direct', confirmT: alertBar.t, peak: alertPrice };
  }
  return w;
}

// 每根新 K 线喂进来推进状态机。返回更新后的 watch（原地修改）。
// bar = {t, p, v}，prevBar = 上一根（用于微回踩/企稳判定）
function feed(w, bar, prevBar, elapsed) {
  if (w.status === 'entry' || w.status === 'rejected') return w;
  const c = w.cfg;
  if (bar.p > w.peak) w.peak = bar.p;
  const floor = w.alertPrice * (1 - c.maxDrop / 100);
  const confirmLevel = w.alertPrice * (1 + c.confirmPct / 100);
  // 买点价纪律：超5cm不给买点（用户8/28：小于5cm介入才有博弈价值）
  const entryPct = (bar.p / w.prevClose - 1) * 100;

  // ---- 未确认阶段 ----
  if (!w.confirmed) {
    if (bar.p >= confirmLevel) {
      w.confirmed = true; w.confirmT = bar.t; w.peak = bar.p; w.status = 'confirmed';
      return w;
    }
    if (bar.p < floor) { w.status = 'rejected'; w.rejectReason = 'broke_floor_before_confirm'; return w; }
    if (elapsed >= c.confirmTimeout) { w.status = 'rejected'; w.rejectReason = 'no_confirm_top'; return w; }
    return w;
  }

  // ---- 已确认阶段：找买点 ----
  const dropFromPeak = (w.peak - bar.p) / w.peak * 100;

  if (!w.pullbackPhase) {
    if (dropFromPeak >= c.pullbackMin) {
      w.pullbackPhase = true; w.pbLow = bar.p; w.pbVolSum = bar.v; w.pbBars = 1;
      return w;
    }
    // 微回踩买点：缩量小回落（深度在 microPull ~ pullbackMin 之间），且买点价<5cm
    if (dropFromPeak >= c.microPull && dropFromPeak < c.pullbackMin && prevBar && entryPct < c.entryMaxPct) {
      if (bar.v < prevBar.v && bar.p < prevBar.p) {
        w.status = 'entry';
        w.entry = { t: bar.t, price: bar.p, mode: 'micro', confirmT: w.confirmT, peak: w.peak, entryPct: +entryPct.toFixed(2) };
        return w;
      }
    }
    return w;
  }

  // ---- 深回踩段 ----
  if (bar.p < w.pbLow) w.pbLow = bar.p;
  w.pbVolSum += bar.v; w.pbBars++;
  if (bar.p < floor) { w.status = 'rejected'; w.rejectReason = 'broke_floor'; return w; }
  const pbAvgVol = w.pbVolSum / w.pbBars;
  if (w.pbBars >= 2 && prevBar && bar.v > pbAvgVol * c.volRatio && bar.p > prevBar.p
      && (w.peak - bar.p) / w.peak * 100 >= c.pullbackMin * 0.4 && entryPct < c.entryMaxPct) {
    w.status = 'entry';
    w.entry = {
      t: bar.t, price: bar.p, mode: 'deep', confirmT: w.confirmT, peak: w.peak,
      dropPct: +((w.peak - w.pbLow) / w.peak * 100).toFixed(2), entryPct: +entryPct.toFixed(2)
    };
  }
  return w;
}

module.exports = { DEFAULT_CFG, eligibleWatch, createWatch, feed };
