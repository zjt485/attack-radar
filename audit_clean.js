'use strict';
// ============================================================================
// audit_clean.js —— 干净口径审计（9/10 重构前置分析·第二版）
//
// 为什么需要这一版：audit_stats.js 暴露了根本性前瞻偏差——
//   samples_*.jsonl 里 66.4% 的样本快照时刻在 15:00（收盘），
//   即 score/prob/tags 是用【全天完整分时】算的，却拿去"预测"【当天】的涨幅。
//   这不是预测，是"看着答案打分"。由此产生的伪结论：
//     · src='涨停' looseHit=100%（同义反复：收盘涨停池里的票当然摸过板）
//     · zbc炸3次+ execEdge=87.6%（能进炸板池=盘中触及过涨停=looseHit必然命中）
//     · prob>=0.9 execEdge=83%（模型在带偏差样本上训练，学的是"识别已涨停"）
//
// 干净口径 = 只用【有 alertT 的样本】：
//   alertT/alertPrice 是盘中真实触发报警的时刻与价格（review.js 里 alerted=true 分支），
//   maxGain/maxDrawdown/closePct 都是"入场之后"发生的 → 无前视。
//   这是唯一能回答"按这个信号买，真能赚钱吗"的子集。
//
// 额外校验：
//   A) 报警时刻分布 vs 报警后收益（验证 9/7 发现的"下午噪音"）
//   B) 报警时涨幅分位 vs 剩余收益（验证用户"<5cm才有博弈价值"纪律）
//   C) 报警后 maxGain 与 closePct 的落差（验证"冲高回落"是否为常态）
//   D) 各 score/tag 在干净子集里是否仍有区分力（vs 全样本的伪区分力）
// ============================================================================
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const SAMPLES = path.join(DIR, 'samples');
const REVIEWS = path.join(DIR, 'reviews');

function loadJoin() {
  const days = fs.readdirSync(REVIEWS).filter(f => /^\d{8}\.json$/.test(f)).map(f => f.slice(0, 8)).sort();
  const rows = [];
  for (const day of days) {
    let rev; const smp = {};
    try { rev = JSON.parse(fs.readFileSync(path.join(REVIEWS, `${day}.json`), 'utf-8')); } catch (e) { continue; }
    try {
      for (const l of fs.readFileSync(path.join(SAMPLES, `samples_${day}.jsonl`), 'utf-8').trim().split('\n')) {
        try { const o = JSON.parse(l); if (o.day === day) smp[o.code] = o; } catch (e) {}
      }
    } catch (e) {}
    for (const r of (rev.rows || [])) {
      const s = smp[r.code] || {};
      if (!s.alertT) continue;                       // ★ 只保留盘中真实报警样本
      const prevClose = s.prevClose || 0;
      const alertPct = (prevClose > 0 && s.alertPrice) ? +((s.alertPrice / prevClose - 1) * 100).toFixed(2) : null;
      rows.push({
        day, code: r.code, name: r.name,
        score: s.score, prob: r.prob, tags: s.tags || [], signals: r.signals || [], z: r.z || {}, src: s.src || null,
        alertT: s.alertT, alertPrice: s.alertPrice, alertPct,
        snapshotT: s.t,                               // 评分快照时刻（判断该样本评分是否也带前视）
        closePct: r.closePct, maxGain: r.maxGain, maxDrawdown: r.maxDrawdown,
        limitTouch: r.limitTouch, closeLimit: r.closeLimit
      });
    }
  }
  return rows;
}

// 报警后剩余收益口径（入场=alertPrice，全部指标都是入场后）
function derive(r) {
  return {
    remainClose: r.closePct,                                    // 入场后到收盘的绝对涨幅（相对昨收）
    gainFromEntry: r.maxGain,                                   // 入场后最大浮盈（相对入场价）
    ddFromEntry: r.maxDrawdown,                                 // 入场后最大回撤
    win3: r.maxGain >= 3,                                       // 入场后曾浮盈>=3%（可执行赢）
    win5: r.maxGain >= 5,
    loss4: r.maxDrawdown <= -4,                                 // 入场后曾亏>=4%（触止损）
    cleanWin: r.maxGain >= 3 && r.maxDrawdown > -4,             // 先赚到3%且没先亏4%（近似，无时序）
    closePos: r.closePct >= 3,                                  // 收盘仍>=3%（拿得住的利润）
    fadeOut: r.maxGain >= 5 && r.closePct < 2                   // 冲高回落：曾浮盈5%+但收盘<2%
  };
}

function stats(arr, label) {
  const n = arr.length;
  if (!n) return { label, n: 0 };
  let win3 = 0, win5 = 0, loss4 = 0, cw = 0, cp = 0, fo = 0;
  let sG = 0, sD = 0, sC = 0, sA = 0;
  for (const r of arr) {
    const d = r._d;
    if (d.win3) win3++; if (d.win5) win5++; if (d.loss4) loss4++;
    if (d.cleanWin) cw++; if (d.closePos) cp++; if (d.fadeOut) fo++;
    sG += d.gainFromEntry; sD += d.ddFromEntry; sC += d.remainClose;
    if (r.alertPct !== null) sA += r.alertPct;
  }
  return {
    label, n,
    win3Pct: +(win3 / n * 100).toFixed(1),
    win5Pct: +(win5 / n * 100).toFixed(1),
    cleanWinPct: +(cw / n * 100).toFixed(1),
    loss4Pct: +(loss4 / n * 100).toFixed(1),
    closePosPct: +(cp / n * 100).toFixed(1),
    fadeOutPct: +(fo / n * 100).toFixed(1),
    avgGainFromEntry: +(sG / n).toFixed(2),
    avgDD: +(sD / n).toFixed(2),
    avgClose: +(sC / n).toFixed(2),
    avgAlertPct: +(sA / n).toFixed(2)
  };
}

function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const rk = new Array(a.length); let i = 0;
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) rk[idx[k][1]] = avg; i = j + 1; }
  return rk;
}
function pearson(x, y) {
  const n = x.length; if (n < 8) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return (sxx > 0 && syy > 0) ? +(sxy / Math.sqrt(sxx * syy)).toFixed(4) : NaN;
}
const ic = pairs => { const ok = pairs.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return ok.length < 10 ? NaN : pearson(ranks(ok.map(p => p[0])), ranks(ok.map(p => p[1]))); };

const rows = loadJoin();
for (const r of rows) r._d = derive(r);

const P = (...a) => console.log(...a);
P('\n════════ 干净口径审计：只用盘中真实报警样本（无前视） ════════');
P(`样本：${rows.length} 只次 / ${[...new Set(rows.map(r => r.day))].length} 个交易日`);
P('口径：入场=报警价，maxGain/maxDrawdown/closePct 均为入场后 → 可直接回答"按信号买能赚吗"');

const tbl = (title, arr) => {
  P(`\n── ${title} ──`);
  P('组别'.padEnd(30) + '  n   曾浮盈3%  曾浮盈5%  干净赢   触-4%止损  收盘>=3%  冲高回落  均浮盈   均回撤   均收盘  报警时涨幅');
  for (const s of arr) {
    if (!s.n) continue;
    P(String(s.label).padEnd(28) + String(s.n).padStart(5) + String(s.win3Pct + '%').padStart(10) + String(s.win5Pct + '%').padStart(10) +
      String(s.cleanWinPct + '%').padStart(9) + String(s.loss4Pct + '%').padStart(11) + String(s.closePosPct + '%').padStart(10) +
      String(s.fadeOutPct + '%').padStart(10) + String(s.avgGainFromEntry).padStart(9) + String(s.avgDD).padStart(9) +
      String(s.avgClose).padStart(9) + String(s.avgAlertPct).padStart(11));
  }
};

tbl('总体（全部报警样本）', [stats(rows, '全部报警')]);

// A) 报警时涨幅分箱 —— 验证用户"<5cm才有博弈价值"纪律
tbl('A. 报警时涨幅分箱（验证 <5cm 纪律）', [
  stats(rows.filter(r => r.alertPct !== null && r.alertPct < 2), '报警时 <2cm'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct >= 2 && r.alertPct < 3.5), '报警时 2~3.5cm'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct >= 3.5 && r.alertPct < 5), '报警时 3.5~5cm'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct >= 5 && r.alertPct < 7), '报警时 5~7cm'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct >= 7 && r.alertPct < 9), '报警时 7~9cm'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct >= 9), '报警时 >=9cm(近板)')
]);

// B) 报警时刻分箱 —— 验证 9/7 发现的下午噪音
const hm = t => { const s = String(t).padStart(4, '0'); return parseInt(s.slice(0, 2)) * 60 + parseInt(s.slice(2)); };
tbl('B. 报警时刻分箱（验证时段效应）', [
  stats(rows.filter(r => hm(r.alertT) < 9 * 60 + 40), '09:25-09:40'),
  stats(rows.filter(r => { const m = hm(r.alertT); return m >= 9 * 60 + 40 && m < 10 * 60 + 30; }), '09:40-10:30'),
  stats(rows.filter(r => { const m = hm(r.alertT); return m >= 10 * 60 + 30 && m < 11 * 60 + 35; }), '10:30-11:35'),
  stats(rows.filter(r => { const m = hm(r.alertT); return m >= 12 * 60 + 55 && m < 14 * 60; }), '12:55-14:00'),
  stats(rows.filter(r => hm(r.alertT) >= 14 * 60), '14:00-15:05')
]);

// C) score 分层（干净子集里 score 还有区分力吗）
tbl('C. score 分层（干净子集）', [
  stats(rows.filter(r => r.score >= 95), 'score>=95'),
  stats(rows.filter(r => r.score >= 90 && r.score < 95), 'score 90-94'),
  stats(rows.filter(r => r.score >= 85 && r.score < 90), 'score 85-89'),
  stats(rows.filter(r => r.score >= 80 && r.score < 85), 'score 80-84'),
  stats(rows.filter(r => r.score < 80), 'score<80(炸板降权门外)')
]);

// D) prob 分层（干净子集）
tbl('D. prob 分层（干净子集）', [
  stats(rows.filter(r => r.prob >= 0.9), 'prob>=0.90'),
  stats(rows.filter(r => r.prob >= 0.75 && r.prob < 0.9), 'prob 0.75-0.89'),
  stats(rows.filter(r => r.prob < 0.75), 'prob<0.75')
]);

// E) 板别（20cm 纪律）
tbl('E. 板别（验证"只做20cm"纪律）', [
  stats(rows.filter(r => /^sz30/.test(r.code)), '创业板20cm'),
  stats(rows.filter(r => /^(sh60|sz00)/.test(r.code)), '主板10cm'),
  stats(rows.filter(r => /^sh68/.test(r.code)), '科创688')
]);

// F) src（报警样本的来源）
const srcG = {};
for (const r of rows) { const k = r.src || '?'; (srcG[k] = srcG[k] || []).push(r); }
tbl('F. 候选池来源（干净子集）', Object.entries(srcG).map(([k, a]) => stats(a, k)).sort((a, b) => b.cleanWinPct - a.cleanWinPct));

// G) tag 贡献（干净子集，样本>=12）
const tagG = {};
for (const r of rows) for (const t of r.tags) (tagG[t] = tagG[t] || []).push(r);
tbl('G. tag 贡献（干净子集 n>=12，按干净赢排序）',
  Object.entries(tagG).filter(([, a]) => a.length >= 12).map(([t, a]) => stats(a, t)).sort((x, y) => y.cleanWinPct - x.cleanWinPct));

// H) 特征 IC（干净子集）—— 哪些特征对"报警后剩余收益"真有预测力
P('\n── H. 特征 IC（干净子集，Spearman）──');
P('feature'.padEnd(14) + 'IC_vs_入场后浮盈  IC_vs_收盘涨幅  IC_vs_干净赢');
const zKeys = Object.keys(rows[0]?.z || {});
const featIC = zKeys.map(k => ({
  f: k,
  icGain: ic(rows.map(r => [r.z[k], r._d.gainFromEntry])),
  icClose: ic(rows.map(r => [r.z[k], r._d.remainClose])),
  icCW: ic(rows.map(r => [r.z[k], r._d.cleanWin ? 1 : 0]))
})).sort((a, b) => Math.abs(b.icCW || 0) - Math.abs(a.icCW || 0));
for (const f of featIC) P(String(f.f).padEnd(14) + String(f.icGain).padStart(16) + String(f.icClose).padStart(15) + String(f.icCW).padStart(13));

P('\n── I. score/prob/alertPct 自身 IC（干净子集）──');
const modelIC = {
  score_vs_gain: ic(rows.map(r => [r.score, r._d.gainFromEntry])),
  score_vs_cw: ic(rows.map(r => [r.score, r._d.cleanWin ? 1 : 0])),
  prob_vs_gain: ic(rows.map(r => [r.prob, r._d.gainFromEntry])),
  prob_vs_cw: ic(rows.map(r => [r.prob, r._d.cleanWin ? 1 : 0])),
  alertPct_vs_gain: ic(rows.filter(r => r.alertPct !== null).map(r => [r.alertPct, r._d.gainFromEntry])),
  alertPct_vs_cw: ic(rows.filter(r => r.alertPct !== null).map(r => [r.alertPct, r._d.cleanWin ? 1 : 0]))
};
P(JSON.stringify(modelIC, null, 1));

// J) 前瞻偏差量化：报警样本中，评分快照时刻晚于报警时刻的比例
const lateSnapshot = rows.filter(r => hm(r.snapshotT) > hm(r.alertT) + 5).length;
P('\n── J. 前瞻偏差量化 ──');
P(`报警样本中"评分快照晚于报警时刻>5分钟"的占比：${(lateSnapshot / rows.length * 100).toFixed(1)}% (${lateSnapshot}/${rows.length})`);
P('  → 这些样本的 score/tags 掺入了报警之后的走势信息（samples 只存最终快照，跨轮覆写）');
P('  → 因此 score/tag 的区分力仍偏乐观，唯有 alertPct（报警瞬间已定）与入场后收益是干净的');

// K) 组合条件（干净子集）：找真正可执行的门槛
tbl('K. 组合门槛（干净子集）', [
  stats(rows, '基线：全部报警'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct < 5), '报警<5cm'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct >= 2 && r.alertPct < 5), '报警2~5cm（现直取区）'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct >= 2 && r.alertPct < 5 && /^sz30/.test(r.code)), '2~5cm + 20cm'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct < 5 && hm(r.alertT) < 11 * 60 + 35), '报警<5cm + 上午'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct >= 2 && r.alertPct < 5 && hm(r.alertT) < 11 * 60 + 35), '2~5cm + 上午'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct >= 2 && r.alertPct < 5 && hm(r.alertT) < 11 * 60 + 35 && /^sz30/.test(r.code)), '2~5cm + 上午 + 20cm'),
  stats(rows.filter(r => r.alertPct !== null && r.alertPct >= 5), '报警>=5cm（应禁）'),
  stats(rows.filter(r => hm(r.alertT) >= 13 * 60), '下午报警（应禁？）')
]);

fs.writeFileSync(path.join(DIR, 'audit_clean_result.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), n: rows.length,
  days: [...new Set(rows.map(r => r.day))],
  overall: stats(rows, '全部报警'),
  featureIC: featIC, modelIC,
  lateSnapshotPct: +(lateSnapshot / rows.length * 100).toFixed(1),
  rows: rows.map(r => ({ day: r.day, code: r.code, name: r.name, score: r.score, prob: r.prob, alertT: r.alertT, alertPct: r.alertPct, src: r.src, tags: r.tags, ...r._d }))
}, null, 1));
P('\n结果已写入 audit_clean_result.json');
