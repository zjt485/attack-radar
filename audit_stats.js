'use strict';
// ============================================================================
// audit_stats.js —— 选股系统审计统计（9/10 重构前置分析）
// 目的：用真实落盘数据回答"哪些筛选条件真的贡献收益、哪些冗余/冲突"
//
// 数据源：
//   samples/samples_YYYYMMDD.jsonl  —— 每只候选的最终快照（score/prob/tags/signals/z/src/alertT/alertPrice）
//   reviews/YYYYMMDD.json           —— 已结算结果（closePct/maxGain/maxDrawdown/limitTouch/closeLimit/hit）
//
// 两套口径（现有 hit 口径偏松，会虚高，必须并列看）：
//   looseHit  = 收涨>=5% 或 全日摸板        （现有 review.js 口径，含"开盘就摸板"的不可执行样本）
//   execWin   = 入场后最大浮盈 >= 3%        （可执行口径：真能赚到 3% 才算赢）
//   execLoss  = 入场后最大回撤 <= -4%       （触及止损线）
//   execEdge  = execWin 且未先触止损        （最严口径：先赚3%且没先亏4%）
//
// 入场价：有 alertT 用 alertPrice（报警即入场），否则用当日开盘价（review.js 同口径）
// 输出：audit_stats_result.json + 控制台摘要
// ============================================================================
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const SAMPLES = path.join(DIR, 'samples');
const REVIEWS = path.join(DIR, 'reviews');

// ---------- 载入并 join ----------
function loadAll() {
  const days = fs.readdirSync(REVIEWS).filter(f => /^\d{8}\.json$/.test(f)).map(f => f.slice(0, 8)).sort();
  const rows = [];
  for (const day of days) {
    let rev, smp = {};
    try { rev = JSON.parse(fs.readFileSync(path.join(REVIEWS, `${day}.json`), 'utf-8')); } catch (e) { continue; }
    try {
      const lines = fs.readFileSync(path.join(SAMPLES, `samples_${day}.jsonl`), 'utf-8').trim().split('\n');
      for (const l of lines) { try { const o = JSON.parse(l); if (o.day === day) smp[o.code] = o; } catch (e) {} }
    } catch (e) {}
    for (const r of (rev.rows || [])) {
      const s = smp[r.code] || {};
      rows.push({
        day, code: r.code, name: r.name,
        score: s.score, prob: r.prob, confidence: r.conf,
        tags: s.tags || [], signals: r.signals || [], z: r.z || {}, src: s.src || null,
        alertT: s.alertT || null, alertPrice: s.alertPrice || null,
        closePct: r.closePct, maxGain: r.maxGain, maxDrawdown: r.maxDrawdown,
        limitTouch: r.limitTouch, closeLimit: r.closeLimit, hit: r.hit
      });
    }
  }
  return rows;
}

// ---------- 口径计算 ----------
function derive(r) {
  const looseHit = r.closePct >= 5 || r.limitTouch;
  const execWin = r.maxGain >= 3;
  const execLoss = r.maxDrawdown <= -4;
  // 注意：maxGain/maxDrawdown 都是入场后极值，无法判先后顺序（review.js 没记时序）
  // execEdge 用"净收益"近似：收盘涨幅 >= 3% 且 最大回撤 > -4%（收盘口径可判真伪）
  const execEdge = r.closePct >= 3 && r.maxDrawdown > -4;
  const alerted = !!r.alertT;
  const entryPct = r.alertPrice ? null : null;   // alertPrice 相对昨收的涨幅需 prevClose，samples 有
  return { looseHit, execWin, execLoss, execEdge, alerted };
}

// ---------- 分组统计 ----------
function stats(arr, label) {
  const n = arr.length;
  if (!n) return { label, n: 0 };
  let lh = 0, ew = 0, el = 0, ee = 0, sClose = 0, sGain = 0, sDD = 0, cl = 0;
  for (const r of arr) {
    const d = r._d;
    if (d.looseHit) lh++;
    if (d.execWin) ew++;
    if (d.execLoss) el++;
    if (d.execEdge) ee++;
    sClose += r.closePct; sGain += r.maxGain; sDD += r.maxDrawdown;
    if (r.closeLimit) cl++;
  }
  return {
    label, n,
    looseHitPct: +(lh / n * 100).toFixed(1),
    execWinPct: +(ew / n * 100).toFixed(1),
    execEdgePct: +(ee / n * 100).toFixed(1),
    execLossPct: +(el / n * 100).toFixed(1),
    closeLimitPct: +(cl / n * 100).toFixed(1),
    avgClose: +(sClose / n).toFixed(2),
    avgMaxGain: +(sGain / n).toFixed(2),
    avgMaxDD: +(sDD / n).toFixed(2)
  };
}

// ---------- IC（信息系数）：特征/评分与未来收益的秩相关 ----------
// Spearman：把 x 和 y 各自转成秩，再算 Pearson
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const rk = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rk[idx[k][1]] = avg;
    i = j + 1;
  }
  return rk;
}
function pearson(x, y) {
  const n = x.length;
  if (n < 5) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : NaN;
}
function spearmanIC(pairs) {
  const ok = pairs.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (ok.length < 10) return { ic: NaN, n: ok.length };
  return { ic: +pearson(ranks(ok.map(p => p[0])), ranks(ok.map(p => p[1]))).toFixed(4), n: ok.length };
}

// ---------- 主流程 ----------
const rows = loadAll();
for (const r of rows) r._d = derive(r);

const out = {
  generatedAt: new Date().toISOString(),
  days: [...new Set(rows.map(r => r.day))],
  totalSamples: rows.length,
  overall: stats(rows, '全部样本')
};

// ---- 1) score 分层：规则引擎分到底有没有区分力 ----
out.byScore = [
  stats(rows.filter(r => r.score >= 90), 'score>=90'),
  stats(rows.filter(r => r.score >= 80 && r.score < 90), 'score 80-89'),
  stats(rows.filter(r => r.score >= 70 && r.score < 80), 'score 70-79'),
  stats(rows.filter(r => r.score >= 60 && r.score < 70), 'score 60-69'),
  stats(rows.filter(r => r.score >= 50 && r.score < 60), 'score 50-59'),
  stats(rows.filter(r => r.score < 50), 'score<50')
];

// ---- 2) prob 分层：模型概率有没有区分力 ----
out.byProb = [
  stats(rows.filter(r => r.prob >= 0.9), 'prob>=0.90'),
  stats(rows.filter(r => r.prob >= 0.75 && r.prob < 0.9), 'prob 0.75-0.89'),
  stats(rows.filter(r => r.prob >= 0.5 && r.prob < 0.75), 'prob 0.50-0.74'),
  stats(rows.filter(r => r.prob >= 0.3 && r.prob < 0.5), 'prob 0.30-0.49'),
  stats(rows.filter(r => r.prob < 0.3), 'prob<0.30')
];

// ---- 3) 报警 vs 未报警（最关键的实盘口径）----
out.alerted = stats(rows.filter(r => r._d.alerted), '有报警(alertT存在)');
out.notAlerted = stats(rows.filter(r => !r._d.alerted), '无报警');

// ---- 4) 单特征 IC：21维 z 值 vs 收盘涨幅 / 最大浮盈 ----
const ZKEYS = Object.keys(rows[0]?.z || {});
out.featureIC = ZKEYS.map(k => ({
  feature: k,
  ic_vs_close: spearmanIC(rows.map(r => [r.z[k], r.closePct])).ic,
  ic_vs_maxGain: spearmanIC(rows.map(r => [r.z[k], r.maxGain])).ic,
  ic_vs_execEdge: spearmanIC(rows.map(r => [r.z[k], r._d.execEdge ? 1 : 0])).ic
})).sort((a, b) => Math.abs(b.ic_vs_execEdge || 0) - Math.abs(a.ic_vs_execEdge || 0));

// ---- 5) score/prob 自身 IC ----
out.modelIC = {
  score_vs_close: spearmanIC(rows.map(r => [r.score, r.closePct])).ic,
  score_vs_execEdge: spearmanIC(rows.map(r => [r.score, r._d.execEdge ? 1 : 0])).ic,
  prob_vs_close: spearmanIC(rows.map(r => [r.prob, r.closePct])).ic,
  prob_vs_execEdge: spearmanIC(rows.map(r => [r.prob, r._d.execEdge ? 1 : 0])).ic
};

// ---- 6) tag 贡献：每个标签的分组收益（判断冗余/冲突）----
const tagSet = {};
for (const r of rows) for (const t of r.tags) { (tagSet[t] = tagSet[t] || []).push(r); }
out.byTag = Object.entries(tagSet)
  .filter(([, arr]) => arr.length >= 15)                 // 样本太少不具统计意义
  .map(([t, arr]) => stats(arr, t))
  .sort((a, b) => b.execEdgePct - a.execEdgePct);

// ---- 7) signal 贡献（features.js 生成的人类可读信号）----
const sigSet = {};
for (const r of rows) for (const s of r.signals) {
  const key = s.replace(/[\d.]+/g, 'N');                 // 归一化数字：'高开+N%'
  (sigSet[key] = sigSet[key] || []).push(r);
}
out.bySignal = Object.entries(sigSet)
  .filter(([, arr]) => arr.length >= 15)
  .map(([s, arr]) => stats(arr, s))
  .sort((a, b) => b.execEdgePct - a.execEdgePct);

// ---- 8) src 来源贡献（候选池哪个源有效）----
const srcSet = {};
for (const r of rows) { const k = r.src || 'unknown'; (srcSet[k] = srcSet[k] || []).push(r); }
out.bySrc = Object.entries(srcSet).map(([s, arr]) => stats(arr, s)).sort((a, b) => b.execEdgePct - a.execEdgePct);

// ---- 9) 板块特征分箱：secHot（板块涨停家数）与 breadth（市场宽度）----
function binBy(getter, edges, labels) {
  return labels.map((lb, i) => {
    const lo = edges[i - 1] === undefined ? -Infinity : edges[i - 1];
    const hi = edges[i];
    return stats(rows.filter(r => { const v = getter(r); return v > lo && v <= hi; }), lb);
  }).filter(s => s.n >= 10);
}
out.bySecHot = binBy(r => r.z.secHot, [-0.5, 0.5, 1.5, 100], ['secHot极低(z<=-0.5)', 'secHot低(-0.5~0.5)', 'secHot中(0.5~1.5)', 'secHot高(z>1.5)']);
out.byBreadth = binBy(r => r.z.breadth, [-0.5, 0, 0.5, 100], ['breadth极冷', 'breadth冷', 'breadth中', 'breadth热']);
out.byLbc = binBy(r => r.z.lbc, [-0.5, 0.5, 1.5, 100], ['lbc=0/无', 'lbc首板', 'lbc 2板', 'lbc 3板+']);
out.byZbc = binBy(r => r.z.zbc, [-0.5, 0.5, 1.5, 100], ['zbc=0无炸板', 'zbc炸1次', 'zbc炸2次', 'zbc炸3次+']);

// ---- 10) 每日趋势（模型是否随时间变好/过拟合）----
out.byDay = [...new Set(rows.map(r => r.day))].map(d => stats(rows.filter(r => r.day === d), d));

// ---- 11) 时段效应：报警时间对结果的影响（9/7 复盘发现下午报警是噪音）----
function hhmm2min(t) { if (!t || !/^\d{3,4}$/.test(t)) return null; const s = t.padStart(4, '0'); return parseInt(s.slice(0, 2)) * 60 + parseInt(s.slice(2)); }
const alertRows = rows.filter(r => r.alertT);
out.byAlertTime = [
  stats(alertRows.filter(r => { const m = hhmm2min(r.alertT); return m !== null && m < 10 * 60; }), '报警<10:00'),
  stats(alertRows.filter(r => { const m = hhmm2min(r.alertT); return m !== null && m >= 10 * 60 && m < 11 * 60 + 30; }), '报警10:00-11:30'),
  stats(alertRows.filter(r => { const m = hhmm2min(r.alertT); return m !== null && m >= 13 * 60 && m < 14 * 60; }), '报警13:00-14:00'),
  stats(alertRows.filter(r => { const m = hhmm2min(r.alertT); return m !== null && m >= 14 * 60; }), '报警>=14:00')
];

// ---- 12) 20cm vs 主板（buypoint 只做 20cm 的纪律是否成立）----
out.byBoard = [
  stats(rows.filter(r => /^sz30/.test(r.code)), '创业板20cm(sz30)'),
  stats(rows.filter(r => /^(sh60|sz00)/.test(r.code)), '主板10cm(sh60/sz00)'),
  stats(rows.filter(r => /^sh68/.test(r.code)), '科创板688(买不了)')
];

// ---- 13) 组合条件测试：现有各筛选门槛叠加后的效果 ----
out.combos = [
  stats(rows.filter(r => r.score >= 80), 'A: score>=80（现报警门）'),
  stats(rows.filter(r => r.score >= 80 && r.prob >= 0.75), 'B: score>=80 且 prob>=0.75（双门）'),
  stats(rows.filter(r => r.score >= 80 && /^sz30/.test(r.code)), 'C: score>=80 且 20cm'),
  stats(rows.filter(r => r.score >= 80 && /^sz30/.test(r.code) && (r.z.zbc === undefined || r.z.zbc <= 0.5)), 'D: C 且 无炸板'),
  stats(rows.filter(r => r.score >= 80 && r._d.alerted), 'E: score>=80 且 实际报警过'),
  stats(rows.filter(r => r.score >= 85 && /^sz30/.test(r.code) && r.z.secHot > 0.5), 'F: score>=85+20cm+板块热'),
  stats(rows.filter(r => r.score >= 80 && r.closePct < 5 && !r.limitTouch), 'G: score>=80 但结果差（假阳性样本）')
];

fs.writeFileSync(path.join(DIR, 'audit_stats_result.json'), JSON.stringify(out, null, 1));

// ---------- 控制台摘要 ----------
const P = (...a) => console.log(...a);
P('\n════════ 选股系统审计统计（真实数据，无编造） ════════');
P(`样本：${out.totalSamples} 只次 / ${out.days.length} 个交易日（${out.days[0]}~${out.days[out.days.length - 1]}）`);
P(`总体：looseHit ${out.overall.looseHitPct}% | execWin(浮盈>=3%) ${out.overall.execWinPct}% | execEdge(收>=3%且未破-4%) ${out.overall.execEdgePct}% | execLoss(破-4%) ${out.overall.execLossPct}% | 均收 ${out.overall.avgClose}% | 均浮盈 ${out.overall.avgMaxGain}% | 均回撤 ${out.overall.avgMaxDD}%`);

const tbl = (title, arr) => {
  P(`\n── ${title} ──`);
  P('组别'.padEnd(34) + ' n  looseHit  execWin  execEdge  execLoss  均收    均浮盈  均回撤');
  for (const s of arr) {
    if (!s.n) continue;
    P(String(s.label).padEnd(32) + String(s.n).padStart(5) + String(s.looseHitPct + '%').padStart(9) + String(s.execWinPct + '%').padStart(9) + String(s.execEdgePct + '%').padStart(9) + String(s.execLossPct + '%').padStart(9) + String(s.avgClose).padStart(7) + String(s.avgMaxGain).padStart(8) + String(s.avgMaxDD).padStart(8));
  }
};
tbl('1. score 分层（规则引擎区分力）', out.byScore);
tbl('2. prob 分层（模型概率区分力）', out.byProb);
tbl('3. 报警 vs 未报警', [out.alerted, out.notAlerted]);
tbl('4. 候选池来源', out.bySrc);
tbl('5. 板块/市场/连板/炸板 分箱', [...out.bySecHot, ...out.byBreadth, ...out.byLbc, ...out.byZbc]);
tbl('6. 板别（20cm纪律验证）', out.byBoard);
tbl('7. 报警时段（9/7发现的下午噪音）', out.byAlertTime);
tbl('8. 组合门槛', out.combos);
tbl('9. tag 贡献（按 execEdge 排序）', out.byTag);
tbl('10. signal 贡献（数字归一化）', out.bySignal);
tbl('11. 每日趋势', out.byDay);

P('\n── 特征 IC（Spearman 秩相关，vs execEdge=收>=3%且未破-4%）──');
P('feature'.padEnd(14) + 'IC_vs_close  IC_vs_maxGain  IC_vs_execEdge');
for (const f of out.featureIC) {
  P(String(f.feature).padEnd(14) + String(f.ic_vs_close).padStart(10) + String(f.ic_vs_maxGain).padStart(14) + String(f.ic_vs_execEdge).padStart(15));
}
P('\n── 模型自身 IC ──');
P(JSON.stringify(out.modelIC, null, 1));
P('\n结果已写入 audit_stats_result.json');
