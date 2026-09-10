'use strict';
// ============================================================================
// trigger.js —— 盘中触发（重构版 v2）
//
// 审计结论：全系统只有两个因子在干净口径下有区分力——
//   1) 入场时涨幅 alertPct：IC = -0.4165（vs 入场后浮盈），越低越好
//   2) 触发时段：上午10:00-11:30 干净赢16% / 开盘30分钟 亏3%率38% / 下午 干净赢5%
// 其余（规则分/概率/量价结构）IC≈0 甚至反向，全部退出触发判定。
//
// ★ 诚实声明（写死在 config.trigger.mode 注释里）：
//   即便最优组合（上午+<3.5cm，n=27），均入场→收盘仍为 -0.34%。
//   日内进攻链路在真实口径下没有正期望 → 默认 mode='paper'，只记录不喊买。
//   切到 'live' 前必须先看到 settle.js 回测在剔除种子日后转正。
// ============================================================================

const { hm2min } = require('./data');

// 时段窗口判定：hm 为 HHMM 整数
function inWindows(hm, windows) {
  return windows.some(w => hm >= w.start && hm <= w.end);
}
function inBlackout(hm, blackouts) {
  return blackouts.find(b => hm >= b.start && hm <= b.end) || null;
}

// ---------- 触发判定（每轮扫描对每只候选调用） ----------
// ctx: { hm, code, name, price, pct, score, vetoed, src }
// state: { firedToday: Set, signalCount }  由 server 维护
// 返回 null 或 signal 对象（signal.entryPrice = 触发瞬间现价，即回测入场基准）
function checkTrigger(ctx, cfg, state) {
  const t = cfg.trigger;
  const { hm, code, pct } = ctx;

  // 0. 评分层已否决 → 不触发
  if (ctx.vetoed) return null;

  // 1. 禁入时段
  if (inBlackout(hm, t.blackout)) return null;

  // 2. 有效窗口
  if (!inWindows(hm, t.windows)) return null;

  // 3. 入场涨幅带（唯一强因子）：minEntryPct <= pct <= maxEntryPct
  if (pct < t.minEntryPct || pct > t.maxEntryPct) return null;

  // 4. 板别过滤（默认关；开则只做 20cm）
  if (t.only20cm && !/^sz30/.test(code)) return null;

  // 5. 每票每日一条
  if (state.firedToday.has(code)) return null;

  // 6. 每日总量上限
  if (state.signalCount >= t.maxSignalsPerDay) return null;

  const signal = {
    day: ctx.day,
    code,
    name: ctx.name,
    triggerT: String(hm).padStart(4, '0'),
    entryPrice: ctx.price,          // ★ 入场基准 = 触发瞬间现价（修 closePct 口径污染）
    entryPct: pct,                  // 触发时涨幅（回测里就是 alertPct）
    score: ctx.score,               // 强度分，仅展示
    src: ctx.src,                   // 来源池：涨停/炸板/成交额榜
    mode: t.mode,                   // paper / live
    tags: ctx.tags || [],
    // ★ 触发瞬间冻结的快照（修前瞻偏差：旧版 samples 存收盘最终分）
    snapshot: ctx.snapshot || null,
    firedAt: Date.now()
  };

  state.firedToday.add(code);
  state.signalCount++;
  return signal;
}

// ---------- 收盘后按真实结算给信号打标（settle.js 调用） ----------
// outcome: { maxGain, maxDrawdown, entryToClose, limitTouch }（相对入场价）
function grade(signal, outcome, cfg) {
  const r = cfg.risk;
  const stopHit = outcome.maxDrawdown <= r.stopLossPct;
  const tpHit = outcome.maxGain >= r.takeProfitPct;
  // 纪律结算：先到哪个算哪个（止损优先，保守口径）
  let exitPct;
  if (stopHit && tpHit) exitPct = r.stopLossPct;       // 同日双触 → 保守算止损
  else if (stopHit) exitPct = r.stopLossPct;
  else if (tpHit) exitPct = r.takeProfitPct;
  else exitPct = outcome.entryToClose;                 // 都没碰 → 收盘出
  return {
    stopHit, tpHit, exitPct: +exitPct.toFixed(2),
    win: exitPct > 0,
    grade: exitPct >= r.takeProfitPct ? 'A' : exitPct > 0 ? 'B' : exitPct > r.stopLossPct ? 'C' : 'D'
  };
}

module.exports = { checkTrigger, grade, inWindows, inBlackout };
