'use strict';
// backtest_md.js —— 早盘直取新规则回测（江天指纹 + 正负样本）
// 验证「开盘幅度门 + 2~5cm 窗口 + 连涨 + 贴高点」能否：抓江天、拒芒果、拒赛微
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('backtest_md.json', 'utf-8'));

// 新规则（草案，待验证后写入 morning_direct.js）
const RULE = {
  openMin: 0,        // 开盘幅度下限（低开=负，直接拒）
  openMax: 3.5,      // 开盘幅度上限（高开跳空>3.5% = 透支，拒）
  pctMin: 2.0,       // 介入窗口下限 2cm
  pctMax: 5.0,       // 介入窗口上限 5cm（黄金区）
  minBars: 2,        // 最少2根
  maxBars: 11,       // 最多11根（开盘起爆）
  minRising: 2,      // 至少2连涨
  offPeakMax: 1.5    // 距日内高点回落≤1.5%
};

function check(bars, prevClose) {
  if (!bars || bars.length < RULE.minBars) return { ok: false, reason: 'bars<2' };
  if (bars.length > RULE.maxBars) return { ok: false, reason: 'bars>11' };
  const first = bars[0], last = bars[bars.length - 1];
  const openPct = (first.p / prevClose - 1) * 100;
  // ① 开盘幅度门：平开微高（排除高开透支 + 低开弱）
  if (openPct < RULE.openMin || openPct > RULE.openMax) return { ok: false, reason: `开盘+${openPct.toFixed(1)}%越界` };
  // ② 现价窗口 2~5cm
  const curPct = (last.p / prevClose - 1) * 100;
  if (curPct < RULE.pctMin || curPct >= RULE.pctMax) return { ok: false, reason: `现价+${curPct.toFixed(1)}%不在2~5cm` };
  // ③ 连涨≥2（从最新往回数）
  let rising = 0;
  for (let i = bars.length - 1; i >= 1; i--) { if (bars[i].p > bars[i - 1].p) rising++; else break; }
  if (rising < RULE.minRising) return { ok: false, reason: '连涨<2' };
  // ④ 贴日内高点
  const peak = Math.max(...bars.map(b => b.p));
  const offPeak = (peak - last.p) / peak * 100;
  if (offPeak > RULE.offPeakMax) return { ok: false, reason: '冲高回落' };
  return { ok: true, openPct: +openPct.toFixed(2), curPct: +curPct.toFixed(2), rising, bars: bars.length, t: last.t, price: last.p };
}

// 逐根回放：从第2根开始，找到第一根命中规则的时点
function replay(code) {
  const { name, day, prevClose, bars, closePct } = data[code];
  console.log(`\n=== ${name}(${code}) ${day} 昨收${prevClose} 收盘${closePct > 0 ? '+' : ''}${closePct}% ===`);
  for (let i = RULE.minBars; i < bars.length; i++) {
    const seg = bars.slice(0, i + 1);
    const r = check(seg, prevClose);
    if (r.ok) {
      const gain = (bars[bars.length - 1].p / r.price - 1) * 100;
      console.log(`  ★ 触发 @${r.t} 现价+${r.curPct}% (${r.rising}连涨/${r.bars}根)`);
      console.log(`    买入价${r.price} 收盘${bars[bars.length - 1].p} → 命中后 ${gain > 0 ? '+' : ''}${gain.toFixed(2)}%`);
      return { code, name, hit: true, t: r.t, buy: r.price, gain: +gain.toFixed(2) };
    }
  }
  const r = check(bars, prevClose);
  console.log(`  ✗ 全天未触发 (最后态: ${r.reason})`);
  return { code, name, hit: false, reason: r.reason };
}

for (const code of Object.keys(data)) replay(code);