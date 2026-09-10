'use strict';
// test_settle.js —— v2 回测自检（deliverable #5 的实证）
// A. resettle：旧报警样本重结算（剔除种子日 + 入场价基准）
// B. replay：v2 逻辑在历史大涨股分钟线上的前向回放（无前瞻）
const path = require('path');
const fs = require('fs');
const CFG = require('./config');
const { resettleAlerts, replayDay, summarizeReplay } = require('./settle');

// ---- A. 旧样本重结算 ----
const auditPath = path.join(__dirname, '..', 'audit_clean_result.json');
if (fs.existsSync(auditPath)) {
  const j = JSON.parse(fs.readFileSync(auditPath, 'utf-8'));
  const r = resettleAlerts(j.rows, CFG);
  console.log('=== A. 旧报警重结算（剔除种子日，入场价基准）===');
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log('audit_clean_result.json 不存在，跳过 A');
}

// ---- B. 历史大涨股前向回放 ----
const btPath = path.join(__dirname, '..', 'backtest_days.json');
if (fs.existsSync(btPath)) {
  const bt = JSON.parse(fs.readFileSync(btPath, 'utf-8'));
  console.log('\n=== B. v2 前向回放（历史样本，无前瞻）===');
  const results = [];
  for (const [code, d] of Object.entries(bt)) {
    const bars = d.bars.map(b => ({ t: b.t, p: b.p, v: b.v }));
    const prevDay = { low: d.prevLow, close: d.prevClose };
    const r = replayDay(bars, prevDay, CFG, { code: 'sz' + code, name: d.name, day: (d.day || '').replace(/-/g, ''), src: '回测' });
    const s = summarizeReplay([r]);
    console.log(`${d.name}(${code}) ${d.day}: 触发${r.signals.length}笔 均收益${s.avgExitPct}% 胜${s.winPct}% 止损${s.stopPct}% 止盈${s.tpPct}%`);
    if (r.positions.length) {
      for (const p of r.positions) {
        console.log(`   入场${p.entryT}@${p.entryPrice} → 出场${p.exitT}@${p.exitPrice} ${p.exitReason} ${p.exitPct}%`);
      }
    }
    results.push(r);
  }
  const total = summarizeReplay(results);
  console.log('\n--- 回放总计 ---');
  console.log(JSON.stringify(total, null, 2));
} else {
  console.log('backtest_days.json 不存在，跳过 B');
}
