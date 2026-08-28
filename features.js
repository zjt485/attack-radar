'use strict';
// ============================================================================
// features.js —— 特征工程层
// 把"分时 bars + 行情快照 + 板块数据"映射成一个标准化特征向量 + 人类可读信号。
// 设计原则：
//   1) 每个特征都有明确金融含义与取值方向（正=利好进攻）
//   2) 原始特征 → z-score 标准化（均值/方差由 stats.json 维护，冷启动用经验值）
//   3) 同时输出 signals[]（人类可读的核心信号），供候选卡与复盘报告展示
// ============================================================================

// ---------- 经验标准化参数（冷启动先验；样本累积后由 iterate.js 更新） ----------
// 每个特征：[mean, std]。基于规则引擎多年口径与 8/24-8/27 真实分时估计。
const PRIOR_STATS = {
  gap:        [3.5, 3.0],   // 高开幅度%
  washDepth:  [2.5, 2.0],   // 洗盘深度%
  washRatio:  [2.0, 1.5],   // 洗盘量能倍数
  recoverSpd: [0.05, 0.05], // 收复速度(每分钟收复的竞价价比例)
  swing:      [2.0, 1.2],   // 低点抬高链长度
  volStruct:  [8.0, 5.0],   // 量结构分(0-15)
  vp:         [6.0, 5.0],   // 量价配合奖励分(0-20)
  pulses:     [2.0, 2.5],   // 放量脉冲次数
  riseSpeed:  [0.15, 0.20], // 涨速 %/分钟
  riseAccel:  [0.0, 0.10],  // 涨速加速度
  amplitude:  [6.0, 4.0],   // 日内振幅%
  turnover:   [8.0, 6.0],   // 换手率%
  amtRank:    [0.5, 0.3],   // 成交额分位(0-1，越高越活跃)
  lbc:        [1.2, 1.2],   // 连板数
  zbc:        [0.5, 0.8],   // 炸板次数(负信号)
  fundRatio:  [0.02, 0.03], // 封单/流通市值
  rule:       [55.0, 18.0], // 规则引擎分(0-100)
  secZdf:     [1.5, 2.0],   // 所属板块涨幅%
  secRank:    [40.0, 20.0], // 板块涨幅排名(越小越好，此处存原始名次)
  secHot:     [1.5, 1.5],   // 板块涨停家数
  breadth:    [0.5, 0.15]   // 市场涨家占比(0-1)
};

// 特征方向：+1=越大越好，-1=越小越好（用于信号解释与排序学习）
const DIRECTION = {
  gap: 1, washDepth: 1, washRatio: 1, recoverSpd: 1, swing: 1, volStruct: 1,
  vp: 1, pulses: 1, riseSpeed: 1, riseAccel: 1, amplitude: 1, turnover: 1,
  amtRank: 1, lbc: 1, zbc: -1, fundRatio: 1, rule: 1,
  secZdf: 1, secRank: -1, secHot: 1, breadth: 1
};

const FEATURE_KEYS = Object.keys(PRIOR_STATS);

// ---------- z-score ----------
function z(key, raw, stats) {
  const s = (stats && stats[key]) || PRIOR_STATS[key];
  const [m, sd] = s;
  const v = (raw - m) / (sd || 1);
  return Math.max(-4, Math.min(4, v)); // 截断极端值，防单点爆掉线性模型
}

// ---------- 涨速与加速度（时序特征） ----------
// 涨速：近 n 根的价格斜率（%/分钟）；加速度：近段涨速 - 前段涨速
function momentum(bars, prevClose) {
  if (bars.length < 6) return { riseSpeed: 0, riseAccel: 0 };
  const n = bars.length;
  const win = Math.min(15, n - 1);
  const seg = bars.slice(n - win);
  const p0 = seg[0].p, p1 = seg[seg.length - 1].p;
  const riseSpeed = ((p1 / p0 - 1) * 100) / win; // %/分钟
  // 加速度：后半段涨速 - 前半段涨速
  const half = Math.floor(seg.length / 2);
  const spA = half > 1 ? ((seg[half].p / seg[0].p - 1) * 100) / half : 0;
  const spB = ((p1 / seg[half].p - 1) * 100) / Math.max(1, seg.length - half);
  return { riseSpeed: +riseSpeed.toFixed(4), riseAccel: +(spB - spA).toFixed(4) };
}

// ---------- 日内振幅 ----------
function amplitude(bars) {
  if (!bars.length) return 0;
  let hi = -Infinity, lo = Infinity;
  for (const b of bars) { if (b.p > hi) hi = b.p; if (b.p < lo) lo = b.p; }
  return lo > 0 ? +(((hi - lo) / lo) * 100).toFixed(2) : 0;
}

// ---------- 成交额分位：在成交额榜中的相对位置 ----------
// amtRankWan=该股成交额(万)，rankList=成交额榜数组(降序)。返回 0-1 分位。
function amountRankPct(amtWan, rankAmts) {
  if (!rankAmts || !rankAmts.length) return 0.5;
  let below = 0;
  for (const a of rankAmts) if (amtWan >= a) below++;
  return below / rankAmts.length;
}

// ============================================================================
// 主入口：构造特征向量 + 信号
// input: {
//   bars, prevClose,          // 分时
//   d,                        // score.js 输出的细项 {sGap,sWash,...,vp,pulses,...}
//   ruleScore,                // 规则引擎总分
//   q,                        // 行情 {turnover,...}
//   meta,                     // {lbc,zbc,hybk,src}
//   fundWan, ltszYi,          // 封单(万)、流通市值(亿)
//   amtWan, rankAmts,         // 该股成交额(万)、成交额榜数组
//   sec,                      // {zdf, rank, hot, name} 板块
//   breadth                   // 市场涨家占比 0-1
// }
// output: { raw:{...}, z:{...}, signals:[...] }
// ============================================================================
function buildFeatures(inp, stats) {
  const d = inp.d || {};
  const bars = inp.bars || [];
  const mom = momentum(bars, inp.prevClose);
  const raw = {};

  raw.gap = d.gap ?? 0;
  raw.washDepth = d.washDepth ?? 0;
  raw.washRatio = d.washRatio ?? 0;
  // 收复速度：1/收复分钟数（越快越大）；未收复=0
  raw.recoverSpd = (d.recoverMin && d.recoverMin > 0) ? +(1 / d.recoverMin).toFixed(4) : 0;
  raw.swing = d.swingChain ?? 0;
  raw.volStruct = d.sVol ?? 0;
  raw.vp = d.vp ?? 0;
  raw.pulses = d.pulses ?? 0;
  raw.riseSpeed = mom.riseSpeed;
  raw.riseAccel = mom.riseAccel;
  raw.amplitude = amplitude(bars);
  raw.turnover = (inp.q && inp.q.turnover) || 0;
  raw.amtRank = amountRankPct(inp.amtWan || 0, inp.rankAmts);
  raw.lbc = inp.meta?.lbc || 0;
  raw.zbc = inp.meta?.zbc || 0;
  raw.fundRatio = (inp.ltszYi > 0) ? +((inp.fundWan || 0) * 1e4 / (inp.ltszYi * 1e8)).toFixed(5) : 0;
  raw.rule = inp.ruleScore ?? 0;
  raw.secZdf = inp.sec?.zdf ?? 0;
  raw.secRank = inp.sec?.rank ?? 60;
  raw.secHot = inp.sec?.hot ?? 0;
  raw.breadth = inp.breadth ?? 0.5;

  const zvec = {};
  for (const k of FEATURE_KEYS) zvec[k] = z(k, raw[k], stats);

  // ---------- 人类可读信号（选最突出的几条） ----------
  const signals = [];
  if (raw.gap >= 2 && raw.gap <= 9) signals.push(`高开+${raw.gap.toFixed(1)}%`);
  if (raw.washDepth >= 3 && raw.washRatio >= 2) signals.push(`深洗盘${raw.washDepth.toFixed(1)}%·承接${raw.washRatio.toFixed(1)}倍`);
  if (raw.recoverSpd > 0) signals.push(`${d.recoverMin}分钟收复竞价价`);
  if (raw.swing >= 3) signals.push('低点连续抬高');
  if (raw.pulses >= 2) signals.push(`放量脉冲×${raw.pulses}`);
  if (raw.vp >= 15) signals.push('量化攻击结构');
  if (raw.riseSpeed >= 0.3) signals.push(`急拉${raw.riseSpeed.toFixed(2)}%/分`);
  if (raw.lbc >= 2) signals.push(`${raw.lbc}连板`);
  if (raw.zbc >= 1) signals.push(`炸板×${raw.zbc}`);
  if (raw.fundRatio >= 0.02) signals.push(`封单占流通${(raw.fundRatio * 100).toFixed(1)}%`);
  if (raw.secZdf >= 3) signals.push(`板块${inp.sec?.name || ''}+${raw.secZdf.toFixed(1)}%`);
  if (raw.secHot >= 3) signals.push(`板块${raw.secHot}家涨停`);

  return { raw, z: zvec, signals };
}

module.exports = { buildFeatures, PRIOR_STATS, DIRECTION, FEATURE_KEYS, momentum };
