'use strict';
// ============================================================================
// buypoint.js —— 两阶段买点状态机（延续确认门 + 用户短线博弈纪律）
// 注释已更新为 9/3 回测修正版，见文首 DEFAULT_CFG 说明。
// ============================================================================

// 默认参数（回测验证值）
// 9/3 因子回测修正：黄金介入区间是「已启动、未涨停」的 2~6cm 段，不是越低越好。
//   <2cm 的盘中样本剩余收益仅 +0.39%、正收益占比 39%（平开/低开多为弱票）→ 不直取，走确认门
//   2~5cm 剩余收益 +2.75%~+3.32%、正占比 83%~86% → 直取区
//   ≥5cm 空间收窄且违背用户「<5cm 介入才有博弈价值」纪律 → 不进
const DEFAULT_CFG = {
  confirmPct: 0.6,      // 突破报警价上方 0.6% = 确认延续
  maxDrop: 4,           // 防线：报警价下方 4%
  microPull: 0.4,       // 微回踩最小深度（确认后）
  pullbackMin: 1.2,     // 深回踩最小深度
  volRatio: 1.5,        // 深回踩企稳量比
  confirmTimeout: 45,   // 确认窗口（分钟/根）
  // ---- 用户短线博弈纪律（8/28 拍板 + 9/3 回测修正）----
  only20cm: true,       // 买点只做创业板(sz30)
  directEntryPct: 2.0,  // 直取区间下限：报警涨幅 ≥2cm 且 <5cm → 直取（<2cm 弱票走确认门）
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
  // 2~5cm = 直取区（已启动、有空间）；<2cm = 弱票，走确认门（不盲买）
  if (pct >= c.directEntryPct && pct < c.alertMaxPct) return { ok: true, mode: 'direct', pct };
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
  if (pct >= c.directEntryPct && pct < c.alertMaxPct) {
    // 直取区（2~5cm）：报警时刻本身就是买点，确认门在此档是累赘
    w.status = 'entry';
    w.entry = { t: alertBar.t, price: alertPrice, mode: 'direct', confirmT: alertBar.t, peak: alertPrice };
  }
  // <2cm：弱票，走确认门（watching），等突破确认延续或回踩企稳再买
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
