'use strict';
// ============================================================================
// iterate.js —— 参数迭代器（持续优化闭环的大脑）
// 每日收盘复盘后调用：
//   1) 给当日样本打标签 y：收盘涨停/盘中摸板 → y=1；收涨≥5% → y=0.7；其他 → y=0
//   2) SGD 更新模型权重（带 L2 正则，学习率随样本量衰减）
//   3) 分箱校准概率
//   4) 阈值寻优：在累积样本上网格搜索"报警阈值"，最大化 命中率-报警量 权衡
//   5) 更新特征统计量（均值/方差滚动估计），让 z-score 跟上市场风格漂移
//   6) 版本号+1，写入 model_state.json + iter_log.jsonl
// 冷启动期（累积样本<15）只记录不更新，避免拿极小样本瞎调参。
// ============================================================================
const fs = require('fs');
const path = require('path');
const model = require('./model');
const { FEATURE_KEYS } = require('./features');

const DIR = __dirname;
const ITER_LOG = path.join(DIR, 'iter_log.jsonl');
const REVIEWS_DIR = path.join(DIR, 'reviews');
const MIN_SAMPLES = 15;   // 冷启动门槛

function label(row) {
  if (row.closeLimit || row.limitTouch) return 1;
  if (row.closePct >= 5) return 0.7;
  return 0;
}

function runIterate(dayStr) {
  const reviewFile = path.join(REVIEWS_DIR, `${dayStr}.json`);
  if (!fs.existsSync(reviewFile)) return { skipped: 'no review' };
  // 幂等保护：同一天已迭代过则不重复（服务重启后二次复盘不会重复灌样本）
  if (fs.existsSync(ITER_LOG)) {
    const done = fs.readFileSync(ITER_LOG, 'utf-8').split('\n')
      .some(l => { try { return JSON.parse(l).day === dayStr; } catch (e) { return false; } });
    if (done) return { skipped: 'already iterated today', day: dayStr };
  }
  const report = JSON.parse(fs.readFileSync(reviewFile, 'utf-8'));
  const state = model.loadState();

  // 当日样本 → {z, y}（复盘行里需要带 z 向量，由 server 落盘时写入）
  const samples = (report.rows || [])
    .filter(r => r.z)
    .map(r => ({ z: r.z, y: label(r), prob: r.prob }));

  const entry = { day: dayStr, newSamples: samples.length, action: [] };

  // 累积样本池（滚动保留最近 20 个交易日，防远古数据拖累新风格）
  state.pool = state.pool || [];
  state.pool.push(...samples.map(s => ({ day: dayStr, z: s.z, y: s.y })));
  if (state.pool.length > 600) state.pool = state.pool.slice(-600);
  const pool = state.pool;

  if (pool.length < MIN_SAMPLES) {
    entry.action.push(`冷启动：累积${pool.length}/${MIN_SAMPLES}样本，只记录不更新`);
  } else {
    // 学习率衰减：样本越多步子越小
    const lr = Math.max(0.01, 0.08 - pool.length * 0.0003);
    model.sgdStep(pool, state, { lr, lambda: 0.02, epochs: 20 });
    model.calibrate(pool, state);
    state.samples = pool.length;
    entry.action.push(`SGD更新(累计${pool.length}样本, lr=${lr.toFixed(3)}) + 校准`);

    // 阈值寻优：网格搜索使"报警样本中命中率最高且报警数≥2"的阈值
    // 必须与 server 实时报警同一概率口径（predict().prob，含校准成熟度门槛），
    // 否则寻出的阈值与实盘不可比
    let best = { th: 0.5, f: -1 };
    for (let th = 0.3; th <= 0.85; th += 0.05) {
      const alerted = pool.filter(s => model.predict(s.z, state).prob >= th);
      if (alerted.length < 2) continue;
      const hitRate = alerted.filter(s => s.y >= 0.7).length / alerted.length;
      const f = hitRate - 0.02 * Math.max(0, alerted.length - 8); // 报太多要罚
      if (f > best.f) best = { th: +th.toFixed(2), f: +f.toFixed(3) };
    }
    if (best.f > -1) { state.alertThreshold = best.th; entry.action.push(`报警阈值寻优 → ${best.th}`); }

    // 特征统计滚动更新：均值=指数加权
    const alpha = 0.3;
    for (const k of FEATURE_KEYS) {
      const vals = pool.map(s => s.z[k]).filter(v => v !== undefined);
      if (!vals.length) continue;
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length);
      // z 向量本身理论上均值0方差1；偏移说明先验统计过时，记录漂移
      entry.drift = entry.drift || {};
      entry.drift[k] = { m: +m.toFixed(2), sd: +sd.toFixed(2) };
    }
  }

  state.version = (state.version || 0) + 1;
  model.saveState(state);
  entry.version = state.version;
  fs.appendFileSync(ITER_LOG, JSON.stringify(entry) + '\n');
  return entry;
}

module.exports = { runIterate };
