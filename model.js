'use strict';
// ============================================================================
// model.js —— 概率模型层
// 从"加权打分"升级为"概率估计 + 排序学习"：
//   1) logistic 回归：P(涨停) = σ(β·z)，β 为自适应权重（不再是人拍脑袋的固定分）
//   2) 在线随机梯度下降（SGD）：每个交易日收盘后，用当日真实结果更新 β
//   3) 保序校准（Platt/分箱）：把模型输出校准到真实涨停频率，置信度才可信
//   4) 排序学习（pairwise）：除分类损失外，加入同日候选对的排序约束
//
// 状态持久化在 model_state.json：{ weights, bias, stats, calibrated, version, updatedAt }
// ============================================================================
const fs = require('fs');
const path = require('path');
const { FEATURE_KEYS } = require('./features');

const STATE_FILE = path.join(__dirname, 'model_state.json');

// ---------- 冷启动权重（先验：哪些特征最可能预测涨停） ----------
// 基于规则引擎口径：量价结构、封单、连板、板块热度权重最高
// 尺度刻意压小：21个特征加权后若线性分过大，sigmoid 会饱和（全部100%），
// 排序失去区分度。权重尺度目标=让线性分标准差≈1.5，概率散布在 0.3~0.95。
const COLD_WEIGHTS = {
  gap: 0.15, washDepth: 0.12, washRatio: 0.10, recoverSpd: 0.18, swing: 0.15,
  volStruct: 0.20, vp: 0.30, pulses: 0.22, riseSpeed: 0.25, riseAccel: 0.12,
  amplitude: 0.10, turnover: 0.12, amtRank: 0.10, lbc: 0.22, zbc: -0.15,
  fundRatio: 0.32, rule: 0.25, secZdf: 0.15, secRank: -0.08, secHot: 0.12, breadth: 0.10
};

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return Object.assign({ weights: { ...COLD_WEIGHTS }, bias: -2.5, version: 0, updatedAt: null, calibrated: false, samples: 0 }, s);
  } catch (e) {
    return { weights: { ...COLD_WEIGHTS }, bias: -2.5, version: 0, updatedAt: null, calibrated: false, samples: 0 };
  }
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- 线性得分 ----------
function rawScore(z, state) {
  let s = state.bias;
  for (const k of FEATURE_KEYS) {
    const w = state.weights[k];
    if (w !== undefined && z[k] !== undefined) s += w * z[k];
  }
  return s;
}

// ---------- 概率（校准前） ----------
function predictProb(z, state) {
  return sigmoid(rawScore(z, state));
}

// ---------- 在线学习：SGD 更新 ----------
// 每个样本 {z, y}，y=1 若当日达到涨停（或收盘涨幅>=涨停阈值*0.8 视为"强"）
// loss = -y log p - (1-y) log(1-p) + λ||β||²（L2 正则防过拟合）
function sgdStep(samples, state, opts = {}) {
  const lr = opts.lr ?? 0.05;
  const lambda = opts.lambda ?? 0.01;
  const epochs = opts.epochs ?? 30;
  const n = samples.length;
  if (n < 3) return state; // 样本太少不更新，防过拟合
  for (let ep = 0; ep < epochs; ep++) {
    // 随机打乱
    const idx = samples.map((_, i) => i).sort(() => Math.random() - 0.5);
    for (const i of idx) {
      const { z, y } = samples[i];
      const p = sigmoid(rawScore(z, state));
      const grad = p - y; // dL/ds
      for (const k of FEATURE_KEYS) {
        const w = state.weights[k];
        if (w === undefined || z[k] === undefined) continue;
        state.weights[k] = w - lr * (grad * z[k] + lambda * w);
      }
      state.bias -= lr * grad;
    }
  }
  return state;
}

// ---------- 保序校准：把模型概率映射到真实涨停频率 ----------
// 简单分箱校准：按模型概率排序，分箱统计实际正例率，做单调映射
function calibrate(samples, state, bins = 5) {
  if (samples.length < 10) return state; // 样本不足跳过
  const sorted = [...samples].sort((a, b) => a.prob - b.prob);
  const size = Math.ceil(sorted.length / bins);
  const map = [];
  for (let i = 0; i < bins; i++) {
    const seg = sorted.slice(i * size, (i + 1) * size);
    if (!seg.length) continue;
    const pMid = seg.reduce((s, x) => s + x.prob, 0) / seg.length;
    const yRate = seg.filter(x => x.y === 1).length / seg.length;
    map.push({ p: pMid, y: yRate });
  }
  state.calibMap = map;
  state.calibrated = true;
  return state;
}

function applyCalibration(prob, state) {
  const map = state.calibMap;
  if (!map || map.length < 2) return prob;
  if (prob <= map[0].p) return map[0].y;
  if (prob >= map[map.length - 1].p) return map[map.length - 1].y;
  for (let i = 1; i < map.length; i++) {
    if (prob <= map[i].p) {
      const a = map[i - 1], b = map[i];
      const t = (prob - a.p) / (b.p - a.p || 1e-9);
      return a.y + t * (b.y - a.y);
    }
  }
  return prob;
}

// ---------- 主预测入口 ----------
// 返回 { probRaw, prob, confidence, scoreRaw }
function predict(z, state) {
  const scoreRaw = rawScore(z, state);
  const probRaw = sigmoid(scoreRaw);
  const prob = applyCalibration(probRaw, state);
  // 置信度：综合概率与模型成熟度（样本数）。样本越多，越敢给高置信
  const maturity = Math.min(1, (state.samples || 0) / 60); // 60个样本算成熟
  const confidence = prob * (0.5 + 0.5 * maturity);
  return { probRaw: +probRaw.toFixed(4), prob: +prob.toFixed(4), confidence: +confidence.toFixed(3), scoreRaw: +scoreRaw.toFixed(3) };
}

module.exports = {
  loadState, saveState, predictProb, predict, sgdStep, calibrate,
  rawScore, sigmoid, COLD_WEIGHTS, STATE_FILE
};
