'use strict';
// ============================================================================
// server2.js —— 重构版主服务（v2，端口 8733，与旧版 8732 并存做 A/B）
//
// 主循环（交易日 9:25-15:05，每轮间隔 2~5 分钟随机）：
//   1. 候选池：东财涨停池+炸板池（主） ∪ 腾讯成交额榜前80（补盲） ∪ 自选
//   2. 批量行情 → 硬过滤（ST/科创/北交/一字/封死/涨幅带）
//   3. 逐票分钟线 → scoring（否决优先 + 强度分排序）
//   4. trigger（唯一门槛层：时段窗 + 入场涨幅带；默认 paper 只记录不喊买）
//   5. risk.feed 跟踪已触发持仓的盘中出场
//   6. 14:45-14:57 → relay 出隔日接力名单（唯一验证正期望模块）
//   7. 15:05 后 → EOD：强平持仓、落盘信号（含冻结快照）、结算当日
//
// 与旧版的关键差异（全部来自审计实证）：
//   · 触发瞬间冻结快照落盘（修 66.4% 前瞻污染）
//   · 收益以入场价为基准（修 closePct 口径污染）
//   · 概率模型/早盘直取/买点状态机/特征引擎 → 删除（战绩见 config.disabled）
//   · 报警分级推送：live 模式才弹买入提醒
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CFG = require('./config');
const D = require('./data');
const { scoreStock } = require('./scoring');
const { checkTrigger } = require('./trigger');
const { openPosition, feed, forceCloseAtEOD } = require('./risk');
const { buildRelay, exitRule } = require('./relay');
const { buildDipStatus } = require('./dip');
const { resettleAlerts, replayDay, summarizeReplay } = require('./settle');

const DIR = __dirname;
const SIG_DIR = path.join(DIR, 'signals');
if (!fs.existsSync(SIG_DIR)) fs.mkdirSync(SIG_DIR, { recursive: true });

// ---------- 运行时状态 ----------
const state = {
  day: null,
  lastScan: null,
  scanCount: 0,
  ztCount: 0,
  regime: null,
  candidates: [],          // 本轮评分后的候选（排序展示）
  signals: [],             // 今日已触发（含冻结快照）
  positions: [],           // 今日持仓跟踪（paper/live 都跟踪）
  firedToday: new Set(),
  relay: null,             // 今日接力名单
  relayPrev: null,         // 昨日名单（次日早盘给 exitRule 建议）
  dip: [],                 // 低吸监听状态
  dipPool: [],
  review: null,            // 当日结算结果
  logs: [],
  error: null
};

function log(msg) {
  const line = `[${D.hhmmss()}] ${msg}`;
  state.logs.push(line);
  if (state.logs.length > 300) state.logs.shift();
  console.log(line);
}

// ---------- 每日重置 ----------
function dayRoll() {
  const today = D.todayStr();
  if (state.day === today) return false;
  // 昨天名单转为 relayPrev（次日早盘出场建议用）
  if (state.relay && state.day) {
    fs.writeFileSync(path.join(SIG_DIR, `relay_${state.day}.json`), JSON.stringify(state.relay, null, 2));
    state.relayPrev = state.relay;
  }
  state.day = today;
  state.signals = [];
  state.positions = [];
  state.firedToday = new Set();
  state.relay = null;
  state.review = null;
  state.candidates = [];
  log(`新交易日 ${today}，状态已重置`);
  return true;
}

// ---------- 加载低吸池（用户主观买区，外部可编辑） ----------
function loadDipPool() {
  const f = path.join(DIR, 'dip_pool.json');
  try {
    state.dipPool = JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (e) {
    state.dipPool = [];
  }
}

// ---------- 候选池构建 ----------
async function buildCandidatePool() {
  const codes = new Map();   // code -> { src, poolInfo }

  if (CFG.pool.useZTPool || CFG.pool.useZBPool) {
    const [zt, zb] = await Promise.all([
      CFG.pool.useZTPool ? D.getZTPool(state.day) : Promise.resolve({ tc: 0, pool: [] }),
      CFG.pool.useZBPool ? D.getZBPool(state.day) : Promise.resolve({ tc: 0, pool: [] })
    ]);
    state.ztCount = zt.tc || 0;
    for (const p of zt.pool) {
      const it = D.normPoolItem(p);
      codes.set(it.code, { src: '涨停', poolInfo: it });
    }
    for (const p of zb.pool) {
      const it = D.normPoolItem(p);
      if (!codes.has(it.code)) codes.set(it.code, { src: '炸板', poolInfo: it });
    }
  }

  if (CFG.pool.useTurnoverRank) {
    const rank = await D.getTurnoverRank(CFG.pool.turnoverRankN);
    rank.forEach((x, i) => {
      if (!codes.has(x.code)) {
        codes.set(x.code, { src: '成交额榜', poolInfo: { ...x, amountRankPct: 100 - (i / rank.length) * 100 } });
      } else {
        codes.get(x.code).amountRankPct = 100 - (i / rank.length) * 100;
      }
    });
  }

  for (const c of CFG.pool.watchlist) {
    if (!codes.has(c)) codes.set(c, { src: '自选', poolInfo: null });
  }

  return [...codes.entries()].map(([code, v]) => ({ code, ...v }));
}

// ---------- 硬过滤 ----------
function passFilter(code, name, q) {
  const f = CFG.filter;
  if (!q || !q.price) return '无行情';
  if (f.excludeST && q.st) return 'ST';
  const b = D.board(code);
  if (f.excludeKCB && b === 'kcb') return '科创板';
  if (f.excludeBJ && b === 'bj') return '北交所';

  const lp = D.limitPrice(q.prevClose, code, name);
  if (f.excludeOneWord && D.isOneWord(q, lp)) return '一字板';
  if (f.excludeLocked && q.price >= lp * (1 - f.lockedTolerancePct / 100)) return '已封死';
  if (q.pct < f.minPct) return `涨幅${q.pct.toFixed(1)}%<${f.minPct}`;
  return null;
}

// ---------- 一轮扫描 ----------
async function scanOnce() {
  const hm = D.nowHM();
  const s = CFG.service;
  if (hm < s.sessionStart || hm > s.sessionEnd) return;
  if (hm > s.lunchStart && hm < s.lunchEnd) return;

  dayRoll();
  const pool = await buildCandidatePool();
  const quotes = await D.getBatchQuote(pool.map(p => p.code));

  // 过滤
  const passed = [];
  const dropped = {};
  for (const p of pool) {
    const q = quotes[p.code];
    const why = passFilter(p.code, q ? q.name : p.poolInfo?.name || '', q);
    if (why) { dropped[why] = (dropped[why] || 0) + 1; continue; }
    passed.push({ ...p, q });
  }

  // 评分（分钟线并发拉取，限流 8）
  const scored = await D.mapLimit(passed, 8, async (p) => {
    const bars = await D.getMinute(p.code, s.minuteCacheMs);
    if (!bars || bars.length < CFG.filter.minBars) return null;
    const prevDay = await D.getPrevDay(p.code, state.day);
    const r = scoreStock(bars, p.q, CFG, {
      code: p.code,
      prevDay,
      amountRankPct: p.amountRankPct ?? (p.poolInfo?.fundWan != null ? 60 : 50)
    });
    return { ...p, ...r, barsLen: bars.length };
  });

  const alive = (scored || []).filter(Boolean).filter(x => !x.vetoed);
  alive.sort((a, b) => b.score - a.score);
  state.candidates = alive.slice(0, 40).map(x => ({
    code: x.code, name: x.q.name, price: x.q.price, pct: +x.q.pct.toFixed(2),
    score: x.score, src: x.src, tags: x.tags,
    lbc: x.poolInfo?.lbc ?? null, zbc: x.poolInfo?.zbc ?? null,
    sector: x.poolInfo?.sector ?? null, vetoed: false
  }));
  const vetoedList = (scored || []).filter(Boolean).filter(x => x.vetoed);

  // 触发 + 持仓跟踪
  const trigState = { firedToday: state.firedToday, signalCount: state.signals.length };
  let newSignals = 0;
  for (const x of alive) {
    const sig = checkTrigger({
      day: state.day, hm, code: x.code, name: x.q.name,
      price: x.q.price, pct: x.q.pct, score: x.score, vetoed: false,
      src: x.src, tags: x.tags,
      // ★ 冻结快照：触发瞬间的完整评分状态（修前瞻偏差的关键）
      snapshot: {
        score: x.score, offPeakPct: +x.derive.offPeakPct.toFixed(2),
        momentum: +x.derive.momentum.toFixed(3), volExpand: +x.derive.volExpand.toFixed(2),
        gap: +x.derive.gap.toFixed(2), turnover: x.derive.turnover,
        barsLen: x.barsLen, vetoReasons: x.vetoReasons,
        lbc: x.poolInfo?.lbc ?? null, zbc: x.poolInfo?.zbc ?? null,
        fundWan: x.poolInfo?.fundWan ?? null, sector: x.poolInfo?.sector ?? null
      }
    }, CFG, trigState);

    if (sig) {
      state.signals.push(sig);
      const pos = openPosition(sig, CFG);
      state.positions.push(pos);
      newSignals++;
      appendSignal(sig);
      log(`触发[${sig.mode}] ${sig.name}(${sig.code}) ${sig.triggerT} @${sig.entryPrice} 涨幅${sig.entryPct.toFixed(2)}% 强度${sig.score} 来源${sig.src}`);
      if (sig.mode === 'live' && CFG.notify.enabled) {
        notify(`买入信号 ${sig.name} ${sig.entryPrice} (+${sig.entryPct.toFixed(1)}%)`,
          `强度${sig.score} 来源${sig.src} 止损${CFG.risk.stopLossPct}% 止盈+${CFG.risk.takeProfitPct}%`);
      }
    }
  }

  // 持仓逐轮喂价（用本轮 quotes）
  for (const pos of state.positions) {
    if (pos.exited) continue;
    const q = quotes[pos.code];
    if (!q || !q.price) continue;
    const r = feed(pos, hm, q.price);
    if (r) {
      log(`出场 ${pos.name} ${r.reason} @${r.exitPrice} 收益${r.exitPct}%`);
      if (pos.mode === 'live' && CFG.notify.enabled) {
        notify(`出场 ${pos.name} ${r.reason} ${r.exitPct}%`, `价${r.exitPrice} 入场${pos.entryPrice}`);
      }
      persistPositions();
    }
  }

  // 接力名单窗口
  const rly = CFG.relay;
  if (rly.enabled && !state.relay && hm >= rly.buildWindow[0] && hm <= rly.buildWindow[1] + 8) {
    state.relay = await buildRelay(state.day, CFG);
    log(`接力名单构建完成：市况${state.relay.regime?.tag}(涨停${state.relay.ztCount}家) 共${state.relay.list.length}只`);
  }

  // 低吸监听
  if (CFG.dip.enabled && state.dipPool.length) {
    state.dip = await buildDipStatus(state.dipPool, CFG);
    for (const d of state.dip) {
      if (d.signal && d.signal.type === 'buy' && CFG.notify.enabled) {
        notify(`低吸真买确认 ${d.name}`, d.signal.reason);
      }
    }
  }

  state.lastScan = D.hhmmss();
  state.scanCount++;
  state.error = null;
}

// ---------- 落盘 ----------
function appendSignal(sig) {
  const f = path.join(SIG_DIR, `signals_${state.day}.jsonl`);
  fs.appendFileSync(f, JSON.stringify(sig) + '\n');
}
function persistPositions() {
  const f = path.join(SIG_DIR, `positions_${state.day}.json`);
  fs.writeFileSync(f, JSON.stringify(state.positions, null, 2));
}

// ---------- EOD 结算（15:05 后跑一次） ----------
async function runEOD() {
  if (state.review) return;
  // 强平仍持有的
  const quotes = await D.getBatchQuote(state.positions.filter(p => !p.exited).map(p => p.code));
  for (const pos of state.positions) {
    if (!pos.exited) {
      const q = quotes[pos.code];
      forceCloseAtEOD(pos, q ? q.price : pos.entryPrice);
    }
  }
  persistPositions();

  const summary = summarizeReplay([{ positions: state.positions }]);
  state.review = {
    day: state.day,
    mode: CFG.trigger.mode,
    signals: state.signals.length,
    ...summary,
    byReason: state.positions.reduce((a, p) => { a[p.exitReason] = (a[p.exitReason] || 0) + 1; return a; }, {}),
    detail: state.positions.map(p => ({
      code: p.code, name: p.name, entry: p.entryPrice, entryT: p.entryT,
      exit: p.exitPrice, exitT: p.exitT, reason: p.exitReason, pct: p.exitPct
    }))
  };
  fs.writeFileSync(path.join(SIG_DIR, `review_${state.day}.json`), JSON.stringify(state.review, null, 2));
  if (state.relay) fs.writeFileSync(path.join(SIG_DIR, `relay_${state.day}.json`), JSON.stringify(state.relay, null, 2));
  log(`EOD结算完成：${summary.n}笔 均收益${summary.avgExitPct}% 胜率${summary.winPct}%`);
}

// ---------- 桌面通知（notifu，与旧版同机制） ----------
let notifyQueue = [];
let notifying = false;
function notify(title, body) {
  notifyQueue.push({ title, body, ts: Date.now() });
  if (!notifying) drainNotify();
}
async function drainNotify() {
  notifying = true;
  while (notifyQueue.length) {
    const n = notifyQueue.shift();
    const notifu = path.join(DIR, '..', 'notifu.exe');
    try {
      if (fs.existsSync(notifu)) {
        execFile(notifu, ['/m', n.body, '/t', n.title, '/d', '10'], () => {});
      }
    } catch (e) { /* 静默 */ }
    await new Promise(r => setTimeout(r, CFG.notify.queueIntervalMs));
  }
  notifying = false;
}

// ---------- 主循环 ----------
async function loop() {
  const isWeekday = () => { const d = new Date().getDay(); return d >= 1 && d <= 5; };
  setInterval(async () => {
    try {
      if (!isWeekday()) return;
      const hm = D.nowHM();
      dayRoll();
      if (hm >= CFG.service.sessionStart && hm <= CFG.service.sessionEnd) {
        await scanThrottled();
      }
      if (hm > 1505 && hm < 1600 && state.signals.length && !state.review) {
        await runEOD();
      }
    } catch (e) {
      state.error = e.message;
      log('扫描异常: ' + e.message);
    }
  }, 30000);   // 30s 检查一次，scanOnce 内部自带节流（分钟缓存+间隔）
}

// scanOnce 节流：距上轮 < scanIntervalMs[0] 则跳过
let lastScanTs = 0;
async function scanThrottled() {
  const [lo] = CFG.service.scanIntervalMs;
  if (Date.now() - lastScanTs < lo) return;
  lastScanTs = Date.now();
  await scanOnce();
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const json = (obj, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (url === '/' || url === '/index.html' || url === '/radar2.html') {
      const f = path.join(DIR, 'radar2.html');
      if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(f));
      } else json({ error: 'dashboard missing' }, 404);
      return;
    }
    if (url === '/api/data') {
      return json({
        day: state.day, lastScan: state.lastScan, scanCount: state.scanCount,
        ztCount: state.ztCount, mode: CFG.trigger.mode, error: state.error,
        candidates: state.candidates, signals: state.signals,
        positions: state.positions.map(p => ({
          code: p.code, name: p.name, entry: p.entryPrice, entryT: p.entryT,
          curPct: p.curPct, peakPct: p.peakPct, exited: p.exited,
          exitReason: p.exitReason, exitPct: p.exitPct
        })),
        relay: state.relay, relayPrev: state.relayPrev,
        dip: state.dip, review: state.review,
        logs: state.logs.slice(-60)
      });
    }
    if (url === '/api/scan') { lastScanTs = 0; await scanOnce(); return json({ ok: true, candidates: state.candidates.length }); }
    if (url === '/api/review') { await runEOD(); return json(state.review); }
    if (url === '/api/config') return json(CFG);
    // 次日早盘：对昨日接力名单给出场建议
    if (url === '/api/relay-exit') {
      if (!state.relayPrev || !state.relayPrev.list.length) return json({ list: [] });
      const quotes = await D.getBatchQuote(state.relayPrev.list.map(x => x.code));
      const out = state.relayPrev.list.map(x => {
        const q = quotes[x.code];
        if (!q) return { ...x, action: 'nodata' };
        const rule = exitRule(q, CFG);
        return { ...x, price: q.price, openPct: q.prevClose > 0 ? +(((q.open - q.prevClose) / q.prevClose) * 100).toFixed(2) : null, ...rule };
      });
      return json({ day: state.relayPrev.regime, list: out });
    }
    // 对比口径：旧报警样本重结算（deliverable #5）
    if (url === '/api/compare') {
      const f = path.join(DIR, '..', 'audit_clean_result.json');
      if (!fs.existsSync(f)) return json({ error: 'audit_clean_result.json missing' }, 404);
      const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
      return json(resettleAlerts(j.rows, CFG));
    }
    json({ error: 'not found' }, 404);
  } catch (e) {
    json({ error: e.message }, 500);
  }
});

// ---------- 保命钩子（8/28 事故教训：异步错误=静默死亡） ----------
process.on('uncaughtException', e => {
  try { fs.appendFileSync(path.join(DIR, 'crash.log'), `[${new Date().toISOString()}] uncaught: ${e.stack}\n`); } catch (_) {}
  log('uncaughtException 已捕获: ' + e.message);
});
process.on('unhandledRejection', e => {
  try { fs.appendFileSync(path.join(DIR, 'crash.log'), `[${new Date().toISOString()}] unhandled: ${e}\n`); } catch (_) {}
  log('unhandledRejection 已捕获: ' + e);
});

// ---------- 启动 ----------
loadDipPool();
dayRoll();
server.listen(CFG.service.port, '127.0.0.1', () => {
  log(`radar2 启动：http://127.0.0.1:${CFG.service.port}  模式=${CFG.trigger.mode}  (旧版8732并存)`);
  loop();
});
