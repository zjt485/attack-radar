'use strict';
// ============================================================================
// scoring.js —— 否决优先评分（重构版 v2）
//
// 设计依据（audit_clean_result.json，n=283 报警样本）：
//   · 旧版 score.js 的 6 维度 + 20 分量价配合奖励分，在干净口径下无区分力：
//       rule IC = 0.0844(vs浮盈) / -0.081(vs干净赢)
//       score>=95 组干净赢 10%  <  score<80 组 22.4%  → 甚至反向
//     原因：报警时刻的真实 score 从未落盘，samples.score 是收盘最终分（前瞻污染）。
//   · 唯一有真实风控价值的是【否决项】：
//       tag「洗盘后创新低」→ 触-4%止损率 35.7%，干净赢仅 7.1%（n=14）
//       tag「已翻绿」      → 干净赢 0%
//
// 所以 v2 把评分拆成两层，职责彻底分离：
//   1) veto()     —— 硬否决，命中任一直接出局（这是风控，不是预测）
//   2) strength() —— 0~100 强度分，【只用于排序展示】，绝不作为买入门槛
//
// 买入门槛交给 trigger.js（用唯一有 IC 的因子：alertPct + 时段）。
// ============================================================================

const { board, limitRatio } = require('./data');

// ---------- 从分钟线提取结构指标（纯函数，便于回测复用） ----------
// bars: [{t:'0930', p, v}] 升序
function derive(bars, q) {
  const n = bars.length;
  if (!n) return null;
  const prices = bars.map(b => b.p);
  const vols = bars.map(b => b.v);

  const peak = Math.max(...prices);
  const peakIdx = prices.indexOf(peak);
  const cur = q.price || prices[n - 1];
  const dayLow = Math.min(...prices);

  // 峰值之后是否创日内新低（洗盘失败 → 否决）
  const afterPeak = prices.slice(peakIdx);
  const newLowAfterPeak = afterPeak.length > 3 && cur <= dayLow * 1.001;

  // 距峰值回落 %
  const offPeakPct = peak > 0 ? ((cur - peak) / peak) * 100 : 0;

  // 近 15 根涨速（%/分钟）
  const win = Math.min(15, n);
  const p0 = prices[n - win];
  const momentum = p0 > 0 ? ((cur - p0) / p0) * 100 / win : 0;   // 每根涨幅

  // 近 5 根均量 / 全天均量（放量倍数）
  const recentVol = vols.slice(-5);
  const avgAll = vols.reduce((a, b) => a + b, 0) / n;
  const avgRecent = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
  const volExpand = avgAll > 0 ? avgRecent / avgAll : 0;

  // 高开幅度 %
  const gap = q.prevClose > 0 ? ((q.open - q.prevClose) / q.prevClose) * 100 : 0;

  return {
    n, peak, peakIdx, cur, dayLow,
    newLowAfterPeak,
    offPeakPct,          // 负数=在峰值下方
    momentum,            // %/分钟
    volExpand,           // 倍
    gap,                 // %
    turnover: q.turnover || 0,
    amount: q.amount || 0
  };
}

// ---------- 第一层：硬否决 ----------
// 返回 { vetoed:bool, reasons:[...] }
function veto(d, q, cfg, prevDay) {
  const reasons = [];
  const v = cfg.scoring.veto;

  // 1. 现价翻绿（相对昨收 <0）
  if (v.turnedGreen && q.prevClose > 0 && q.price < q.prevClose) {
    reasons.push('已翻绿');
  }

  // 2. 洗盘后创日内新低
  if (v.newLowAfterWash && d.newLowAfterPeak) {
    reasons.push('洗盘后创新低');
  }

  // 3. 跌破前日低点 > brokePrevLow %
  if (v.brokePrevLow != null && prevDay && prevDay.low > 0) {
    const breach = ((prevDay.low - d.dayLow) / prevDay.low) * 100;
    if (breach > v.brokePrevLow) {
      reasons.push(`破前日低${breach.toFixed(1)}%`);
    }
  }

  // 4. 距日内高点回落 > maxDrawdownFromPeak %（冲高回落已成立）
  if (v.maxDrawdownFromPeak != null && -d.offPeakPct > v.maxDrawdownFromPeak) {
    reasons.push(`距高点回落${(-d.offPeakPct).toFixed(1)}%`);
  }

  return { vetoed: reasons.length > 0, reasons };
}

// ---------- 第二层：强度分（0~100，仅排序展示） ----------
// 每个子分都归一到 0~1 再乘权重。权重见 config.scoring.strength。
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function strength(d, q, cfg, amountRankPct) {
  const w = cfg.scoring.strength;
  let total = 0, max = 0;

  // 高开适度：0~4% 给满分，>6% 或 <0 递减（旧版 2~8% 无依据）
  const gapScore = d.gap >= 0 && d.gap <= 4 ? 1
    : d.gap > 4 ? clamp01(1 - (d.gap - 4) / 6)
      : clamp01(1 + d.gap / 4);
  total += gapScore * w.wGap; max += w.wGap;

  // 涨速：0.3%/分钟 视为强（涨停约 0.5~1%/分钟冲刺）
  const momScore = clamp01(d.momentum / 0.3);
  total += momScore * w.wMomentum; max += w.wMomentum;

  // 放量：近5根/全天 2倍 视为强
  const volScore = clamp01((d.volExpand - 1) / 1);
  total += volScore * w.wVolExpand; max += w.wVolExpand;

  // 贴近日高：回落 0% = 1，回落 5% = 0
  const offScore = clamp01(1 + d.offPeakPct / 5);
  total += offScore * w.wOffPeak; max += w.wOffPeak;

  // 换手适度：5~15% 最佳
  const t = d.turnover;
  const turnScore = t >= 5 && t <= 15 ? 1 : t < 5 ? clamp01(t / 5) : clamp01(1 - (t - 15) / 20);
  total += turnScore * w.wTurnover; max += w.wTurnover;

  // 成交额分位（活跃度，来自候选池排名）
  const amtScore = clamp01(amountRankPct != null ? amountRankPct / 100 : 0.5);
  total += amtScore * w.wAmountRank; max += w.wAmountRank;

  return max > 0 ? Math.round((total / max) * 100) : 0;
}

// ---------- 一站式评分（候选池阶段调用） ----------
// 返回 { code, name, score, vetoed, vetoReasons, derive, tags }
function scoreStock(bars, q, cfg, opts = {}) {
  const { prevDay = null, amountRankPct = null } = opts;
  const d = derive(bars, q);
  if (!d || d.n < cfg.filter.minBars) {
    return { score: 0, vetoed: true, vetoReasons: ['分钟线不足'], derive: null, tags: [] };
  }
  const vr = veto(d, q, cfg, prevDay);
  const score = vr.vetoed ? 0 : strength(d, q, cfg, amountRankPct);

  // 可解释标签（看板展示，不参与计算）
  const tags = [];
  if (d.gap > 0 && d.gap <= 4) tags.push('适度高开');
  if (d.momentum >= 0.3) tags.push('涨速强');
  if (d.volExpand >= 2) tags.push('放量×' + d.volExpand.toFixed(1));
  if (-d.offPeakPct <= 1) tags.push('贴日高');
  if (vr.vetoed) tags.push(...vr.reasons.map(r => '✗' + r));

  return {
    score,
    vetoed: vr.vetoed,
    vetoReasons: vr.reasons,
    derive: d,
    tags,
    board: board(opts.code || q.code || ''),
    limitPct: limitRatio(opts.code || '', q.name) * 100
  };
}

module.exports = { derive, veto, strength, scoreStock };
