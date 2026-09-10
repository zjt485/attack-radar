'use strict';
// ============================================================================
// dip.js —— 低吸监听（重构版 v2）
//
// 审计结论：track 结算 23 条，均值 +0.71% / 上涨占比 57% —— 全系统最好的真实战绩。
// 原因很简单：买区是用户/米糕基于基本面+支撑位【主观设定】的，不是算法拟合的。
// 所以这个模块 v2 原样保留，只做两件事：
//   1. 数据层统一（用 data.js，不再自己 fetch）
//   2. 把"真买确认"的尺子显式化：收盘位置 >70%（用户 8/4 确立的铁律）
//
// 买区由外部维护（dip_pool.json 或 server 注入），本模块只负责监听+判定。
// ============================================================================

const { getBatchQuote, getMinute } = require('./data');

// 收盘位置：现价在当日 [low, high] 区间的百分位（0~100）
function closePos(q) {
  if (!q || q.high <= q.low) return null;
  return +(((q.price - q.low) / (q.high - q.low)) * 100).toFixed(1);
}

// ---------- 构建低吸状态 ----------
// pool: [{ code, name, buyLow, buyHigh, stopLoss, note }]
// 返回每只票的实时状态 + 信号
async function buildDipStatus(pool, cfg) {
  const d = cfg.dip;
  if (!d.enabled || !pool || !pool.length) return [];

  const quotes = await getBatchQuote(pool.map(p => p.code));
  const out = [];

  for (const p of pool) {
    const q = quotes[p.code];
    if (!q || !q.price) continue;

    const pos = closePos(q);
    // 距买区上沿的距离 %（负数=已在买区内）
    const distToZone = p.buyHigh > 0 ? ((q.price - p.buyHigh) / p.buyHigh) * 100 : null;

    let status = '观望';
    let signal = null;

    if (distToZone != null) {
      if (q.price <= p.buyHigh && q.price >= p.buyLow) {
        // 已在买区内
        if (pos != null && pos >= d.requireClosePos) {
          status = '真买确认';
          signal = { type: 'buy', reason: `价${q.price}在买区[${p.buyLow},${p.buyHigh}] 且收盘位置${pos}%>=${d.requireClosePos}%` };
        } else {
          status = '买区内(待确认)';
          signal = { type: 'watch', reason: `价${q.price}在买区，但收盘位置${pos ?? '?'}%<${d.requireClosePos}%，等收位确认` };
        }
      } else if (distToZone > 0 && distToZone <= d.nearThresholdPct) {
        status = '接近买区';
        signal = { type: 'near', reason: `距买区上沿仅${distToZone.toFixed(1)}%` };
      } else if (q.price < p.buyLow) {
        status = '跌破买区';
        if (p.stopLoss && q.price <= p.stopLoss) {
          signal = { type: 'stop', reason: `价${q.price}<=止损${p.stopLoss}` };
        } else {
          signal = { type: 'below', reason: `价${q.price}已跌破买区下沿${p.buyLow}，等止跌信号(缩量+收位>50%+主力停流出)` };
        }
      }
    }

    out.push({
      ...p,
      price: q.price,
      pct: q.pct,
      closePos: pos,
      distToZone: distToZone != null ? +distToZone.toFixed(2) : null,
      status,
      signal
    });
  }
  return out;
}

module.exports = { buildDipStatus, closePos };
