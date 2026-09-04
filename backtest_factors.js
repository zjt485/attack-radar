'use strict';
// ============================================================================
// backtest_factors.js —— 因子回测（基于 6 个交易日 506 样本 + 每日复盘真实结局）
//
// 目的：
//   1) 用真实结局验证外部研究结论（反转>动量、缩量>放量、位置条件性、板块效应、连板惯性）
//   2) 诊断现有模型（prob IC、score IC、双门互斥、分层单调性）
//   3) 验证用户买点纪律（<3.5cm 直取 / 3.5~5cm 确认 / ≥5cm 不进）
//
// 数据：samples_*.jsonl（特征 z + score + prob + price + prevClose + src）JOIN
//       reviews/*.json.rows（closePct / hit / limitTouch / maxGain / maxDrawdown）
// 标签：hit = 收盘涨幅≥5% 或 盘中摸板（与 review.js 同口径）
// 注意：区分「盘中样本」(t<1500，可交易) 与「收盘样本」(t=1500，仅作特征研究)
// ============================================================================
const fs = require('fs');
const path = require('path');
const { PRIOR_STATS, DIRECTION, FEATURE_KEYS } = require('./features');

const DIR = __dirname;
const DAYS = ['20260827', '20260828', '20260831', '20260901', '20260902', '20260903'];
const RELAY = {}; // day -> {regime, ztCount}

function loadRows() {
  const rows = [];
  for (const d of DAYS) {
    const sf = path.join(DIR, 'samples', `samples_${d}.jsonl`);
    const rf = path.join(DIR, 'reviews', `${d}.json`);
    const rf2 = path.join(DIR, 'samples', `relay_samples_${d}.json`);
    if (fs.existsSync(rf2)) {
      try { const rr = JSON.parse(fs.readFileSync(rf2, 'utf8')); RELAY[d] = { regime: rr.regime, ztCount: rr.ztCount }; } catch (e) {}
    }
    if (!fs.existsSync(sf) || !fs.existsSync(rf)) continue;
    const reviewMap = {};
    try { JSON.parse(fs.readFileSync(rf, 'utf8')).rows.forEach(r => { reviewMap[r.code] = r; }); } catch (e) {}
    const lines = fs.readFileSync(sf, 'utf8').trim().split('\n').filter(Boolean);
    for (const l of lines) {
      let s; try { s = JSON.parse(l); } catch (e) { continue; }
      const r = reviewMap[s.code];
      if (!r || !s.z) continue;
      rows.push({
        day: d, code: s.code, name: s.name, t: s.t,
        price: s.price, prevClose: s.prevClose, score: s.score, prob: s.prob, src: s.src,
        z: s.z,
        closePct: r.closePct, hit: r.hit, limitTouch: r.limitTouch,
        maxGain: r.maxGain, maxDrawdown: r.maxDrawdown
      });
    }
  }
  return rows;
}

// 从 z 反推原始值（PRIOR_STATS 作 mean/std；z 被截断到 ±4，反推仅作解读）
function unz(key, zv) {
  const [m, sd] = PRIOR_STATS[key];
  return zv * sd + m;
}

// 相关系数
function pearson(a, b) {
  if (a.length < 3) return 0;
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}
function spearman(a, b) {
  const rank = arr => { const s = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(arr.length); for (let i = 0; i < s.length; i++) r[s[i][1]] = i + 1; return r; };
  return pearson(rank(a), rank(b));
}
function mean(x) { return x.length ? x.reduce((p, c) => p + c, 0) / x.length : 0; }

// 分层统计：给定数组 arr（升序分组度量）与 labels（命中 0/1），输出分箱命中率
function binBy(values, labels, bins) {
  const n = values.length;
  if (!n) return [];
  const idx = values.map((v, i) => i).sort((x, y) => values[x] - values[y]);
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = Math.floor(n * b / bins), hi = Math.floor(n * (b + 1) / bins);
    if (hi <= lo) continue;
    let hit = 0, sumClose = 0, sumGain = 0, cnt = hi - lo;
    for (let i = lo; i < hi; i++) { const j = idx[i]; if (labels[j]) hit++; sumClose += rows[j].closePct; sumGain += rows[j].maxGain; }
    out.push({ lo: values[idx[lo]], hi: values[idx[hi - 1]], n: cnt, hitRate: hit / cnt, avgClose: sumClose / cnt, avgMaxGain: sumGain / cnt });
  }
  return out;
}

// 全局 rows
const rows = loadRows();
const intraday = rows.filter(r => r.t < '1500');

function fmtPct(v) { return (v * 100).toFixed(1) + '%'; }

// ============ 输出 JSON 结果 ============
const RESULT = {
  meta: { total: rows.length, intraday: intraday.length, days: DAYS.length },
  overview: {},
  probIc: {},
  scoreIc: {},
  factorIc: {},
  reverse: {}, shrink: {}, position: {}, sector: {}, lbc: {}, fund: {}, regime: {}, buypoint: {}, dualGate: {},
  rawBins: {}
};

(function main() {
  // ---------- 概览 ----------
  for (const d of DAYS) {
    const dr = rows.filter(r => r.day === d);
    if (!dr.length) continue;
    const hits = dr.filter(r => r.hit).length;
    RESULT.overview[d] = {
      n: dr.length, hitRate: +(hits / dr.length).toFixed(3),
      limitRate: +(dr.filter(r => r.limitTouch).length / dr.length).toFixed(3),
      avgClose: +mean(dr.map(r => r.closePct)).toFixed(2),
      relay: RELAY[d] || null
    };
  }

  // ---------- 模型诊断：prob / score 的预测力 ----------
  const allHit = rows.map(r => r.hit ? 1 : 0);
  const idHit = intraday.map(r => r.hit ? 1 : 0);
  RESULT.probIc = {
    all: { pearson: +pearson(rows.map(r => r.prob), allHit).toFixed(4), spearman: +spearman(rows.map(r => r.prob), allHit).toFixed(4) },
    intraday: { pearson: +pearson(intraday.map(r => r.prob), idHit).toFixed(4), spearman: +spearman(intraday.map(r => r.prob), idHit).toFixed(4) }
  };
  RESULT.scoreIc = {
    all: { pearson: +pearson(rows.map(r => r.score || 0), allHit).toFixed(4), spearman: +spearman(rows.map(r => r.score || 0), allHit).toFixed(4) },
    intraday: { pearson: +pearson(intraday.map(r => r.score || 0), idHit).toFixed(4), spearman: +spearman(intraday.map(r => r.score || 0), idHit).toFixed(4) }
  };

  // prob 分箱单调性（盘中）
  const pb = [0.2, 0.4, 0.6, 0.8];
  for (let i = 0; i < pb.length; i++) {
    const lo = pb[i], hi = i + 1 < pb.length ? pb[i + 1] : 1.01;
    const seg = intraday.filter(r => r.prob >= lo && r.prob < hi);
    if (!seg.length) { RESULT.rawBins['prob_' + lo] = null; continue; }
    const h = seg.filter(r => r.hit).length / seg.length;
    RESULT.rawBins['prob_' + lo] = { n: seg.length, hitRate: +h.toFixed(3), avgClose: +mean(seg.map(r => r.closePct)).toFixed(2) };
  }

  // ---------- 双门互斥诊断 ----------
  const gateScore80 = intraday.filter(r => (r.score || 0) >= 80);
  const gateProb80 = intraday.filter(r => r.prob >= 0.8);
  const gateBoth = intraday.filter(r => (r.score || 0) >= 80 && r.prob >= 0.8);
  RESULT.dualGate = {
    score80: { n: gateScore80.length, hitRate: gateScore80.length ? +(gateScore80.filter(r => r.hit).length / gateScore80.length).toFixed(3) : 0 },
    prob80: { n: gateProb80.length, hitRate: gateProb80.length ? +(gateProb80.filter(r => r.hit).length / gateProb80.length).toFixed(3) : 0 },
    both: { n: gateBoth.length, names: gateBoth.map(r => r.name) }
  };

  // ---------- 单因子 IC（盘中样本，sign-aligned z） ----------
  const fIc = {};
  for (const k of FEATURE_KEYS) {
    const dir = DIRECTION[k] || 1;
    const vals = intraday.map(r => (r.z[k] ?? 0) * dir); // 统一正向
    fIc[k] = +spearman(vals, idHit).toFixed(4);
  }
  RESULT.factorIc = Object.entries(fIc).sort((a, b) => b[1] - a[1]);

  // ---------- 反转假设：采样时涨幅 vs 后续 ----------
  const pctAll = rows.map(r => (r.price / r.prevClose - 1) * 100);
  const pctId = intraday.map(r => (r.price / r.prevClose - 1) * 100);
  RESULT.reverse = {
    icAll: +spearman(pctAll, allHit).toFixed(4),
    icIntraday: +spearman(pctId, idHit).toFixed(4),
    bins: binByRows(intraday, r => (r.price / r.prevClose - 1) * 100, r => r.hit ? 1 : 0, [0, 2, 4, 6, 8, 10, 100])
  };

  // ---------- 缩量假设：换手率(turnover) / 量结构(volStruct) ----------
  RESULT.shrink.turnover = binByRows(intraday, r => unz('turnover', r.z.turnover), r => r.hit ? 1 : 0, [0, 6, 10, 15, 20, 100]);
  RESULT.shrink.volStruct = binByRows(intraday, r => unz('volStruct', r.z.volStruct), r => r.hit ? 1 : 0, [0, 5, 8, 10, 13, 16]);

  // ---------- 位置条件性：gap(高开) 分层 ----------
  RESULT.position.gap = binByRows(intraday, r => unz('gap', r.z.gap), r => r.hit ? 1 : 0, [-100, 1, 3, 5, 7, 100]);
  RESULT.position.amplitude = binByRows(intraday, r => unz('amplitude', r.z.amplitude), r => r.hit ? 1 : 0, [0, 4, 6, 8, 10, 100]);

  // ---------- 板块效应 / 连板 / 封单 ----------
  RESULT.sector = binByRows(intraday, r => unz('secHot', r.z.secHot), r => r.hit ? 1 : 0, [0, 1, 2, 3, 4, 20]);
  RESULT.lbc = binByRows(intraday, r => unz('lbc', r.z.lbc), r => r.hit ? 1 : 0, [0, 1, 2, 3, 4, 20]);
  RESULT.fund = binByRows(intraday, r => unz('fundRatio', r.z.fundRatio) * 100, r => r.hit ? 1 : 0, [-1, 1, 2, 3, 5, 20]);

  // ---------- 情绪环境：按日 ----------
  for (const d of DAYS) {
    if (!RESULT.overview[d]) continue;
    const o = RESULT.overview[d];
    RESULT.regime[d] = { ztCount: o.relay?.ztCount ?? null, regime: o.relay?.regime ?? null, hitRate: o.hitRate, n: o.n };
  }

  // ---------- 买点纪律：<3.5 / 3.5~5 / ≥5 （盘中） ----------
  const segs = [
    ['<3.5cm', r => (r.price / r.prevClose - 1) * 100 < 3.5],
    ['3.5~5cm', r => { const p = (r.price / r.prevClose - 1) * 100; return p >= 3.5 && p < 5; }],
    ['5~8cm', r => { const p = (r.price / r.prevClose - 1) * 100; return p >= 5 && p < 8; }],
    ['≥8cm', r => (r.price / r.prevClose - 1) * 100 >= 8]
  ];
  for (const [label, fn] of segs) {
    const seg = intraday.filter(fn);
    if (!seg.length) { RESULT.buypoint[label] = null; continue; }
    const h = seg.filter(r => r.hit).length / seg.length;
    const zt = seg.filter(r => r.limitTouch).length / seg.length;
    RESULT.buypoint[label] = {
      n: seg.length, hitRate: +h.toFixed(3), limitRate: +zt.toFixed(3),
      avgClose: +mean(seg.map(r => r.closePct)).toFixed(2),
      avgMaxGain: +mean(seg.map(r => r.maxGain)).toFixed(2),
      avgMaxDD: +mean(seg.map(r => r.maxDrawdown)).toFixed(2)
    };
  }

  // 写结果
  fs.writeFileSync(path.join(DIR, 'backtest_factors_result.json'), JSON.stringify(RESULT, null, 2));
  console.log(JSON.stringify(RESULT, null, 2).slice(0, 6000));
})();

// 分箱辅助（复用 rows 闭包）
function binByRows(arr, valFn, labFn, edges) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const seg = arr.filter((r, idx) => { const v = valFn(r); return v >= lo && v < hi; });
    if (!seg.length) { out.push({ range: `${lo}~${hi}`, n: 0 }); continue; }
    const h = seg.filter(r => labFn(r)).length / seg.length;
    out.push({
      range: `${lo}~${hi}`, n: seg.length,
      hitRate: +h.toFixed(3),
      avgClose: +mean(seg.map(r => r.closePct)).toFixed(2),
      avgMaxGain: +mean(seg.map(r => r.maxGain)).toFixed(2)
    });
  }
  return out;
}