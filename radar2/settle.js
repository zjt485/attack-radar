'use strict';
// ============================================================================
// settle.js —— 回测与结算（重构版 v2，deliverable #5 的核心）
//
// 两种模式，职责严格分开：
//
// 【A. replay 前向回放】—— 真正的无前瞻回测
//   输入：某票某日的完整分钟线 bars + 前日低点
//   过程：逐分钟喂入 scoring.derive → veto → strength → trigger.checkTrigger
//         → risk.feed，完全模拟盘中实时决策（第 t 分钟只用 <=t 的数据）
//   输出：触发信号 + 按 risk 状态机的真实出场收益
//   ★ 这是检验 v2 有效性的唯一可信方式（旧版 samples 存收盘最终分 = 前瞻污染）
//
// 【B. resettle 旧样本重结算】—— 与旧版对比口径
//   输入：audit_clean_result.json 的报警行（含 alertT/alertPct/closePct）
//   过程：剔除种子日 → 用【入场价】基准重算 entry→close（修 closePct 口径污染）
//   输出：旧版真实战绩（均入场→收盘、胜率、亏3%率）
//   ★ 用于回答"精简后 vs 旧版"的对比，不用于证明 v2 有效（那是 replay 的活）
// ============================================================================

const { hm2min } = require('./data');
const { derive, veto, strength } = require('./scoring');
const { checkTrigger } = require('./trigger');
const { openPosition, feed, forceCloseAtEOD } = require('./risk');

// ---------------------------------------------------------------------------
// A. replay：单票单日逐分钟前向回放
// ---------------------------------------------------------------------------
// bars: [{t:'0931', p, v}] 升序；prevDay: {low, close}；opts: {code, name, src}
// 返回 { signals:[...], positions:[...] }
function replayDay(bars, prevDay, cfg, opts = {}) {
  const signals = [];
  const positions = [];
  const state = { firedToday: new Set(), signalCount: 0 };

  // 构造一个滚动 quote（只用截至当前分钟的信息）
  let peak = -Infinity, low = Infinity, open = null, prevClose = prevDay ? prevDay.close : null;
  if (prevClose == null && bars.length) prevClose = bars[0].p; // 兜底

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const hm = parseInt(b.t, 10);
    if (open == null) open = b.p;
    if (b.p > peak) peak = b.p;
    if (b.p < low) low = b.p;

    const slice = bars.slice(0, i + 1);
    const q = {
      code: opts.code, name: opts.name,
      price: b.p, prevClose, open, high: peak, low,
      pct: prevClose > 0 ? ((b.p - prevClose) / prevClose) * 100 : 0,
      turnover: opts.turnover || 0, amount: opts.amount || 0
    };

    const d = derive(slice, q);
    if (!d || d.n < cfg.filter.minBars) continue;

    const vr = veto(d, q, cfg, prevDay);
    const score = vr.vetoed ? 0 : strength(d, q, cfg, opts.amountRankPct ?? 50);

    // 触发判定
    const sig = checkTrigger({
      day: opts.day, hm, code: opts.code, name: opts.name,
      price: b.p, pct: q.pct, score, vetoed: vr.vetoed,
      src: opts.src, tags: [], snapshot: { score, offPeakPct: d.offPeakPct, momentum: d.momentum, volExpand: d.volExpand }
    }, cfg, state);

    if (sig) {
      signals.push(sig);
      positions.push(openPosition(sig, cfg));
    }

    // 喂持仓风控
    for (const pos of positions) {
      if (!pos.exited) feed(pos, hm, b.p);
    }
  }

  // 收盘强平
  const lastP = bars.length ? bars[bars.length - 1].p : null;
  for (const pos of positions) {
    if (!pos.exited && lastP != null) forceCloseAtEOD(pos, lastP);
  }

  return { signals, positions };
}

// 汇总一组 replay 结果
function summarizeReplay(results) {
  const all = results.flatMap(r => r.positions);
  const n = all.length;
  if (!n) return { n: 0, avgExitPct: 0, winPct: 0, stopPct: 0, tpPct: 0, timeoutPct: 0 };
  const sum = all.reduce((a, p) => a + (p.exitPct || 0), 0);
  const win = all.filter(p => (p.exitPct || 0) > 0).length;
  const stop = all.filter(p => p.exitReason === 'stopLoss').length;
  const tp = all.filter(p => p.exitReason === 'takeProfit').length;
  const to = all.filter(p => p.exitReason === 'timeout' || p.exitReason === 'eod').length;
  return {
    n,
    avgExitPct: +(sum / n).toFixed(2),
    winPct: +((win / n) * 100).toFixed(1),
    stopPct: +((stop / n) * 100).toFixed(1),
    tpPct: +((tp / n) * 100).toFixed(1),
    timeoutPct: +((to / n) * 100).toFixed(1)
  };
}

// ---------------------------------------------------------------------------
// B. resettle：旧报警样本重结算（对比口径）
// ---------------------------------------------------------------------------
// rows: audit_clean_result.json 的 rows（含 day/alertT/alertPct/closePct/gainFromEntry...）
// 关键修正：
//   · 剔除种子日（config.settle.seedDayBlacklist）
//   · entry→close = ((1+closePct/100)/(1+alertPct/100)-1)*100  （入场价基准，非昨收）
function resettleAlerts(rows, cfg) {
  const blacklist = new Set(cfg.settle.seedDayBlacklist || []);
  const clean = rows.filter(r => r.alertT && !blacklist.has(String(r.day)));

  const n = clean.length;
  if (!n) return { n: 0 };

  let sumE2C = 0, win = 0, loss3 = 0, sumAlertPct = 0;
  const byWindow = { '0925-1000': [], '1000-1130': [], '1130-1255': [], '1255-1505': [] };

  for (const r of clean) {
    const alertPct = r.alertPct ?? 0;
    const closePct = r.closePct ?? (r.remainClose != null ? r.remainClose : alertPct);
    // 入场→收盘（入场价基准）
    const e2c = ((1 + closePct / 100) / (1 + alertPct / 100) - 1) * 100;
    sumE2C += e2c;
    sumAlertPct += alertPct;
    if (e2c > 0) win++;
    if (e2c <= -3) loss3++;

    // alertT 是 HHMM 字符串（如 "1030"），直接按 HHMM 整数分桶（勿转分钟，会串桶）
    const hm = parseInt(String(r.alertT).replace(/:/g, '').slice(0, 4), 10);
    if (hm < 1000) byWindow['0925-1000'].push(e2c);
    else if (hm < 1130) byWindow['1000-1130'].push(e2c);
    else if (hm < 1255) byWindow['1130-1255'].push(e2c);
    else byWindow['1255-1505'].push(e2c);
  }

  const winStat = arr => arr.length ? {
    n: arr.length,
    avg: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2),
    winPct: +((arr.filter(x => x > 0).length / arr.length) * 100).toFixed(1)
  } : { n: 0, avg: 0, winPct: 0 };

  return {
    n,
    avgEntryToClose: +(sumE2C / n).toFixed(2),
    avgAlertPct: +(sumAlertPct / n).toFixed(2),
    winPct: +((win / n) * 100).toFixed(1),
    loss3Pct: +((loss3 / n) * 100).toFixed(1),
    byWindow: Object.fromEntries(Object.entries(byWindow).map(([k, v]) => [k, winStat(v)])),
    seedRemoved: rows.filter(r => blacklist.has(String(r.day)) && r.alertT).length
  };
}

module.exports = { replayDay, summarizeReplay, resettleAlerts };
