'use strict';
// ============================================================================
// risk.js —— 盘中持仓风控状态机（重构版 v2）
//
// 职责：对已触发（paper 或 live）的信号，逐分钟跟踪价格，判定出场。
// 与 trigger.grade() 的区别：
//   · grade() 是【收盘后】用 maxGain/maxDrawdown 做的保守结算（回测口径）
//   · risk.js 是【盘中实时】的出场决策（实盘/模拟盘口径，按分钟线逐根喂）
// 两者必须分开，否则又会把"全天最高价"当成"我能卖到的价"（前瞻偏差）。
//
// 出场优先级（先到先出，保守）：
//   硬止损 -3%  >  移动止盈回撤  >  固定止盈 +3%  >  超时 90 分钟  >  收盘
// ============================================================================

const { hm2min } = require('./data');

// 创建一个持仓跟踪对象（信号触发时调用）
function openPosition(signal, cfg) {
  const r = cfg.risk;
  return {
    code: signal.code,
    name: signal.name,
    entryPrice: signal.entryPrice,
    entryT: signal.triggerT,
    entryHM: hm2min(signal.triggerT),
    mode: signal.mode,
    // 跟踪状态
    peakPrice: signal.entryPrice,
    peakPct: 0,                 // 相对入场价的最高浮盈 %
    curPct: 0,
    exited: false,
    exitReason: null,
    exitPrice: null,
    exitPct: null,
    cfg: r
  };
}

// 喂一根分钟线（或一次报价）。返回 { exited, reason, exitPct } 或 null（继续持有）
function feed(pos, hm, price) {
  if (pos.exited) return null;
  const r = pos.cfg;

  const pct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  pos.curPct = +pct.toFixed(2);
  if (price > pos.peakPrice) {
    pos.peakPrice = price;
    pos.peakPct = +(((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
  }

  // 1. 硬止损（最高优先级）
  if (pct <= r.stopLossPct) {
    return close(pos, hm, price, 'stopLoss');
  }

  // 2. 移动止盈：浮盈曾 >trailingAfterPct，随后从峰值回撤 >trailingDrawdownPct
  if (pos.peakPct >= r.trailingAfterPct) {
    const drawdown = pos.peakPct - pct;
    if (drawdown >= r.trailingDrawdownPct) {
      return close(pos, hm, price, 'trailing');
    }
  }

  // 3. 固定止盈
  if (pct >= r.takeProfitPct) {
    return close(pos, hm, price, 'takeProfit');
  }

  // 4. 超时（持有超过 maxHoldMinutes）
  const heldMin = hm2min(hm) - pos.entryHM;
  if (heldMin >= r.maxHoldMinutes) {
    return close(pos, hm, price, 'timeout');
  }

  return null;
}

function close(pos, hm, price, reason) {
  pos.exited = true;
  pos.exitReason = reason;
  pos.exitPrice = price;
  pos.exitPct = +(((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
  pos.exitT = String(hm).padStart(4, '0');
  return { exited: true, reason, exitPct: pos.exitPct, exitPrice: price, exitT: pos.exitT };
}

// 收盘强制平仓（15:00 仍持有的，按收盘价结算）
function forceCloseAtEOD(pos, closePrice) {
  if (pos.exited) return null;
  return close(pos, 1500, closePrice, 'eod');
}

module.exports = { openPosition, feed, forceCloseAtEOD };
