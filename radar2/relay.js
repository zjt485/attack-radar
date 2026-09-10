'use strict';
// ============================================================================
// relay.js —— 主板首板隔日接力（重构版 v2）
//
// ★ 这是全系统唯一被真实结算验证为正期望的模块（audit_modules.js，85条）：
//     纪律均收 +1.88% / 胜率 49% / T1冲2%率 73% / T2均收 +2.02%
//   纪律 = 次日高开>2%持有看收盘，否则开盘卖。
//
// ★ 旧版致命 bug（已修）：CFG.regimeHot=103 / regimeVeryHot=126，
//   而实测 9 个交易日涨停数区间只有 35~94 → 全部被判"冷"，市况分层从未生效。
//   新阈值按实测分组收益重定（见 config.relay）：
//     <50 冷(+2.24%/54%)  50~75 中(+1.30%)  75~90 热(+0.86%)  >=90 极热(+4.13%/75%)
//
// ★ 可执行性诚实标注：封单/流通>=3% 组纸面收益最强(+3.35%)，但那是"封死买不进"；
//   真正可买的 <1% 组均收仅 +1.02%。所以名单照出，但看板必须标注"可买收益打折"。
// ============================================================================

const { getZTPool, normPoolItem, board, getDaily, getPrevDay, mapLimit, dayIso } = require('./data');

// 市况分层
function regime(ztCount, cfg) {
  const r = cfg.relay;
  if (ztCount >= r.regimeVeryHot) return { tag: '极热', count: ztCount, expect: '+4.13%/胜75%' };
  if (ztCount >= r.regimeHot) return { tag: '热', count: ztCount, expect: '+0.86%' };
  if (ztCount >= r.regimeCold) return { tag: '中', count: ztCount, expect: '+1.30%' };
  return { tag: '冷', count: ztCount, expect: '+2.24%/胜54%' };
}

// 前10日涨幅（新鲜度）
async function prior10Pct(code, day) {
  const kl = await getDaily(code, 12);
  const hist = kl.filter(d => d.date !== dayIso(day));
  if (hist.length < 11) return null;
  const now = hist[hist.length - 1].close;
  const ago = hist[hist.length - 11].close;
  return ago > 0 ? +(((now - ago) / ago) * 100).toFixed(2) : null;
}

// ---------- 构建接力名单（14:45-14:57 调用） ----------
// 返回 { regime, list:[...] }
async function buildRelay(day, cfg) {
  const r = cfg.relay;
  if (!r.enabled) return { regime: null, list: [] };

  const { tc, pool } = await getZTPool(day);
  const rg = regime(tc, cfg);

  // 初筛：主板 + 首板 + 价格 + 封单
  let cands = pool.map(normPoolItem).filter(p => {
    if (r.mainBoardOnly && board(p.code) !== 'main') return false;
    if (r.firstBoardOnly && p.lbc !== 1) return false;
    if (r.maxPrice && p.price > r.maxPrice) return false;
    if (r.minFundWan && p.fundWan < r.minFundWan) return false;
    if (/ST|退/.test(p.name)) return false;
    return true;
  });

  // 补前10日涨幅（并发限流）
  const enriched = await mapLimit(cands, 6, async (p) => {
    const p10 = await prior10Pct(p.code, day);
    return { ...p, prior10Pct: p10 };
  });

  // 新鲜度过滤
  let list = enriched.filter(p => {
    if (p.prior10Pct == null) return true;            // 数据缺 → 保留但标注
    if (r.maxPrior10Pct != null && p.prior10Pct > r.maxPrior10Pct) return false;
    return true;
  });

  // 排序：封单额降序（封单越大次日惯性越强），同封单按前10日涨幅升序（越新鲜越好）
  list.sort((a, b) => (b.fundWan - a.fundWan) || ((a.prior10Pct ?? 99) - (b.prior10Pct ?? 99)));
  list = list.slice(0, r.maxList);

  // 标注最优区间（前10日 0~5%）+ 可买性
  list = list.map(p => {
    const [lo, hi] = r.bestPrior10Range;
    const inBest = p.prior10Pct != null && p.prior10Pct >= lo && p.prior10Pct <= hi;
    const sealRatio = p.floatCapYi > 0 ? (p.fundWan / 1e4) / p.floatCapYi * 100 : null; // 封单/流通 %
    return {
      ...p,
      inBestRange: inBest,
      sealRatioPct: sealRatio != null ? +sealRatio.toFixed(2) : null,
      buyable: sealRatio != null && sealRatio < 3,   // >=3% 基本封死买不进
      note: inBest ? '★新鲜度最优区' : ''
    };
  });

  return { regime: rg, list, ztCount: tc };
}

// ---------- 次日出场纪律（T+1 早盘调用） ----------
// q: 次日实时行情；返回 { action, reason }
function exitRule(q, cfg) {
  const e = cfg.relay.exitRule;
  const openPct = q.prevClose > 0 ? ((q.open - q.prevClose) / q.prevClose) * 100 : 0;
  if (openPct >= e.holdIfOpenAbove) {
    return { action: 'hold', reason: `高开${openPct.toFixed(1)}%>=${e.holdIfOpenAbove}% → 持有看收盘` };
  }
  return { action: 'sellOpen', reason: `高开${openPct.toFixed(1)}%<${e.holdIfOpenAbove}% → 开盘卖` };
}

module.exports = { buildRelay, regime, exitRule, prior10Pct };
