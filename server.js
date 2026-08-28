'use strict';
// 进攻分时雷达 —— 盘中监控服务
// 数据源：东财涨停/炸板池(候选漏斗) + 腾讯批量行情/逐分钟分时/日K(特征计算)
// 评分引擎见 score.js；每轮：拉候选池 → 批量行情过滤 → 逐分钟评分 → 达档报警
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8732;
const DIR = __dirname;
const { scoreAttack } = require('./score');
const { buildFeatures } = require('./features');
const model = require('./model');
const { runReview } = require('./review');
const { runIterate } = require('./iterate');

// 扫描间隔：每轮结束后随机 2~5 分钟（随机化本身也是防限流手段）
function nextInterval() { return (2 + Math.random() * 3) * 60000; }

// 自选观察池（你的持仓+重点观察），与涨停生态合并成候选集
const WATCH = ['sz301122', 'sh603629', 'sh600869', 'sh600497', 'sz301217', 'sz300313'];

const state = {
  day: null,
  round: 0,
  lastScan: 0,
  running: false,
  stocks: {},      // code -> {name, quote, score, level, tags, d, series:[], alerted:{60,80}, status}
  alerts: [],      // 时间线
  log: []
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function fetchUrl(url, timeout = 8000, asBuffer = false) {
  // 每次请求前随机 0-400ms 抖动，避免整齐高频轰炸被识别为爬虫
  const jitter = Math.floor(Math.random() * 400);
  return new Promise((resolve) => {
    setTimeout(() => {
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' }, timeout }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(asBuffer ? buf : buf.toString('utf-8'));
        });
      });
      req.on('error', () => resolve(asBuffer ? Buffer.alloc(0) : ''));
      req.on('timeout', () => { req.destroy(); resolve(asBuffer ? Buffer.alloc(0) : ''); });
    }, jitter);
  });
}

// ---------- 候选池 ----------
// 东财涨停/炸板池：除连板/炸板次数外，还带 hybk(行业)、fund(封单额)、ltsz(流通市值)
// 返回 {codes: Map, ztCount: 当日涨停家数(市场热度代理)}
async function getPools() {
  const date = todayStr();
  const base = 'https://push2ex.eastmoney.com/';
  const ut = '7eea3edcaed734bea9cbfc24409ed989';
  const [zt, zb] = await Promise.all([
    fetchUrl(`${base}getTopicZTPool?ut=${ut}&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt:asc&date=${date}`),
    fetchUrl(`${base}getTopicZBPool?ut=${ut}&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fund:asc&date=${date}`)
  ]);
  const codes = new Map(); // code -> {src, hybk, fundWan, ltszYi, ...}
  let ztCount = 0;
  try {
    const z = JSON.parse(zt);
    ztCount = z.data?.tc || 0;
    (z.data?.pool || []).forEach(p => {
      const c = p.m === 1 ? 'sh' + p.c : 'sz' + p.c;
      codes.set(c, {
        name: p.n, src: '涨停', lbc: p.lbc, fbt: p.fbt, zbc: p.zbc,
        hybk: p.hybk || null,
        fundWan: (p.fund || 0) / 1e4,      // 封单额 元→万
        ltszYi: (p.ltsz || 0) / 1e8        // 流通市值 元→亿
      });
    });
  } catch (e) {}
  try {
    const b = JSON.parse(zb);
    (b.data?.pool || []).forEach(p => {
      const c = p.m === 1 ? 'sh' + p.c : 'sz' + p.c;
      if (!codes.has(c)) codes.set(c, {
        name: p.n, src: '炸板', lbc: p.lbc, zbc: p.zbc,
        hybk: p.hybk || null,
        fundWan: (p.fund || 0) / 1e4,
        ltszYi: (p.ltsz || 0) / 1e8
      });
    });
  } catch (e) {}
  return { codes, ztCount };
}

// ---------- 行业板块涨幅榜（腾讯，东财口径行业名，可与涨停池 hybk 对上） ----------
async function getSectorRank() {
  const txt = await fetchUrl('https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hy&sort_type=price&direct=down&offset=0&count=100');
  try {
    const j = JSON.parse(txt);
    const list = j.data?.rank_list || [];
    const map = {};
    list.forEach((x, i) => {
      map[x.name] = { zdf: parseFloat(x.zdf) || 0, rank: i + 1 };
    });
    return map;
  } catch (e) { return {}; }
}

// ---------- 成交额榜（腾讯，全市场前80 —— 补盲区 + 竞价抢筹快照的数据源） ----------
async function getTurnoverRank() {
  const txt = await fetchUrl('https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList?board_code=aStock&sort_type=turnover&direct=down&offset=0&count=80');
  try {
    const j = JSON.parse(txt);
    const list = (j.data && j.data.rank_list) || [];
    return list
      .filter(x => /^(sh|sz)\d{6}$/.test(x.code))
      .map(x => ({
        code: x.code, name: x.name,
        zdf: parseFloat(x.zdf) || 0,          // 涨跌幅%
        amtWan: parseFloat(x.turnover) || 0,  // 成交额（万元）
        ltszYi: parseFloat(x.ltsz) || 0,      // 流通市值（亿）
        hsl: parseFloat(x.hsl) || 0           // 换手率%
      }));
  } catch (e) { return []; }
}

// ---------- 批量行情（腾讯） ----------
async function getBatchQuote(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += 50) {
    const chunk = codes.slice(i, i + 50);
    const buf = await fetchUrl('https://qt.gtimg.cn/q=' + chunk.join(','), 8000, true);
    // 腾讯批量行情是 GBK 编码，必须按 GBK 解码，否则股票名乱码
    const txt = new TextDecoder('gbk').decode(buf);
    const re = /v_(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(txt))) {
      const f = m[2].split('~');
      if (f.length < 46) continue;
      const prevClose = parseFloat(f[4]);
      out[m[1]] = {
        name: f[1], price: parseFloat(f[3]), prevClose,
        open: parseFloat(f[5]), low: parseFloat(f[34]), high: parseFloat(f[33]),
        pct: parseFloat(f[32]), turnover: parseFloat(f[38]),
        st: /ST|\u9000/.test(f[1])
      };
    }
  }
  return out;
}

// ---------- 逐分钟分时（腾讯，累计量做差分；缓存40秒防同轮重复） ----------
const minuteCache = {}; // code -> {ts, bars}
async function getMinute(code) {
  if (minuteCache[code] && Date.now() - minuteCache[code].ts < 40000) return minuteCache[code].bars;
  const txt = await fetchUrl(`https://ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`);
  try {
    const raw = JSON.parse(txt);
    const lines = raw.data[code].data.data;
    const bars = [];
    let prevCum = 0;
    for (const line of lines) {
      const [t, p, cumV] = line.split(' ');
      const v = parseFloat(cumV) - prevCum;
      prevCum = parseFloat(cumV);
      bars.push({ t, p: parseFloat(p), v: Math.max(0, v) });
    }
    minuteCache[code] = { ts: Date.now(), bars };
    return bars;
  } catch (e) { return null; }
}

// ---------- 前一日低点（日K，每日缓存） ----------
const prevLowCache = {};
async function getPrevLow(code) {
  if (prevLowCache[code]?.day === state.day) return prevLowCache[code].low;
  const txt = await fetchUrl(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,5,qfq`);
  try {
    const raw = JSON.parse(txt);
    const days = raw.data[code].qfqday || raw.data[code].day;
    const tStr = `${state.day.slice(0, 4)}-${state.day.slice(4, 6)}-${state.day.slice(6)}`;
    // 剔除今日K，取最后一根=前一交易日
    const hist = days.filter(d => d[0] !== tStr);
    const bar = hist.length ? hist[hist.length - 1] : null;
    const low = bar ? parseFloat(bar[4]) : null;
    prevLowCache[code] = { day: state.day, low };
    return low;
  } catch (e) { return null; }
}

// ---------- 涨停价 / 一字板判定 ----------
function limitRatio(code, name) {
  if (/ST/.test(name)) return 0.05;
  if (/^(sz30|sh68)/.test(code)) return 0.20;
  return 0.10;
}
function limitPrice(prevClose, code, name) {
  return Math.round(prevClose * (1 + limitRatio(code, name)) * 100) / 100;
}
function isOneWord(q, lp) {
  // 开盘即贴涨停且全天未下探超过 0.5%
  return q.open >= lp * 0.998 && q.low >= q.open * 0.995;
}

// ---------- 交易时段 ----------
function inSession(force) {
  if (force) return true;
  const now = new Date();
  const wd = now.getDay();
  if (wd === 0 || wd === 6) return false;
  const hm = now.getHours() * 100 + now.getMinutes();
  return (hm >= 925 && hm <= 1135) || (hm >= 1255 && hm <= 1505);
}

// 盘外使用：算出距下一个交易时段开始的毫秒数（一觉睡到点，期间零请求）
function msToNextSession() {
  const now = new Date();
  const hm = now.getHours() * 100 + now.getMinutes();
  const toSec = h => Math.floor(h / 100) * 3600 + (h % 100) * 60;
  const sessions = [925, 1255]; // 两段开盘：9:25 / 12:55
  // 今天还有未开始的时段 → 直接睡到那段
  for (const s of sessions) {
    if (hm < s) return (toSec(s) - toSec(hm)) * 1000;
  }
  // 今天已收盘 → 算到下一个工作日的 9:25（跳过周末）
  let days = 1;
  const d = new Date(now);
  while (true) {
    d.setDate(d.getDate() + 1);
    const w = d.getDay();
    if (w !== 0 && w !== 6) break;
    days++;
  }
  return ((days * 24 * 3600) - toSec(hm) + toSec(925)) * 1000;
}

// ---------- 主扫描 ----------
async function mapPool(items, worker, n = 4) {
  const out = [];
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

// ---------- 竞价抢筹快照（东财竞价池接口已死，用成交额榜自建） ----------
// 口径：竞价高开2~9% + 成交额门槛（流通<50亿≥800万 / 50~200亿≥1500万 / >200亿≥3000万）+ 排ST/科创/一字
// 每日仅抓一次：9:25-9:45 窗口内首轮命中即存，9:30 之后冻结不再更新
function maybeCaptureJJ(rank, quotes) {
  if (state.jjSnapshot && state.jjSnapshot.frozen) return;
  const now = new Date();
  const hm = now.getHours() * 100 + now.getMinutes();
  if (hm < 925 || hm > 945) return;
  const hits = [];
  for (const r of rank) {
    const q = quotes[r.code];
    if (!q || q.st) continue;
    if (r.code.startsWith('sh68')) continue;
    const gap = (q.open / q.prevClose - 1) * 100;   // 竞价高开=开盘价/昨收
    if (gap < 2 || gap > 9) continue;
    const amt = r.amtWan * 1e4;                      // 万元 → 元
    const ltsz = r.ltszYi * 1e8;                     // 亿 → 元
    const need = ltsz < 50e8 ? 8e6 : ltsz < 200e8 ? 15e6 : 30e6;
    if (amt < need) continue;
    const lp = limitPrice(q.prevClose, r.code, q.name);
    if (isOneWord(q, lp)) continue;
    hits.push({
      code: r.code, name: q.name, gap: +gap.toFixed(2), price: q.price,
      amtYi: +(amt / 1e8).toFixed(2), ltszYi: r.ltszYi, hsl: r.hsl
    });
  }
  hits.sort((a, b) => b.amtYi - a.amtYi);
  state.jjSnapshot = {
    t: now.toLocaleTimeString('zh-CN', { hour12: false }),
    frozen: hm >= 930,
    hits: hits.slice(0, 25)
  };
}

async function scan(force) {
  const day = todayStr();
  if (state.day !== day) { state.day = day; state.stocks = {}; state.alerts = []; state.log = []; state.rounds = []; state.jjSnapshot = null; state.samples = {}; state.topList = []; state.reviewDone = false; }
  state.round++;
  state.lastScan = Date.now();
  state.running = true;

  const t0 = Date.now();
  const stat = {
    round: state.round,
    t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    poolZt: 0, poolZb: 0, poolRank: 0, watch: WATCH.length, quotesOk: 0,
    excluded: { st: 0, kcb: 0, word: 0, weak: 0, locked: 0 },
    candidates: 0, scored: 0, noData: 0, costMs: 0
  };

  const [poolRes, rank, sectorMap] = await Promise.all([getPools(), getTurnoverRank(), getSectorRank()]);
  const pool = poolRes.codes;
  const ztCount = poolRes.ztCount;                       // 全市场涨停家数（市场热度代理）
  const rankAmts = rank.map(r => r.amtWan).sort((a, b) => b - a); // 成交额榜降序（分位用）
  for (const m of pool.values()) { if (m.src === '涨停') stat.poolZt++; else if (m.src === '炸板') stat.poolZb++; }
  // 成交额榜补盲区：没涨停但资金活跃的票（板块爆发日跟涨股），不与涨停/炸板池重复计数
  for (const r of rank) {
    if (!pool.has(r.code)) { pool.set(r.code, { name: r.name, src: '成交额榜', ltszYi: r.ltszYi, amtWan: r.amtWan }); stat.poolRank++; }
  }
  const allCodes = [...new Set([...pool.keys(), ...WATCH])];
  const quotes = await getBatchQuote(allCodes);

  // 板块联动统计（自洽口径：用池内同板块票算涨停家数与平均涨幅，不依赖外部行业映射）
  const secAgg = {};
  for (const [code, m] of pool) {
    if (!m.hybk || m.src !== '涨停') continue;
    secAgg[m.hybk] = secAgg[m.hybk] || { hot: 0 };
    secAgg[m.hybk].hot++;
  }

  // 竞价抢筹快照：每日仅 9:25-9:45 窗口抓取一次，9:30 后冻结
  maybeCaptureJJ(rank, quotes);

  const candidates = [];
  for (const code of allCodes) {
    const q = quotes[code];
    if (!q) continue;
    stat.quotesOk++;
    if (q.st) { stat.excluded.st++; continue; }
    if (code.startsWith('sh68')) { stat.excluded.kcb++; continue; }   // 科创板你买不了
    const meta = pool.get(code) || { src: WATCH.includes(code) ? '自选' : '?' };
    const lp = limitPrice(q.prevClose, code, q.name);
    if (isOneWord(q, lp)) { stat.excluded.word++; continue; }          // 一字/T字买不进
    if (q.pct < 1.5) { stat.excluded.weak++; continue; }               // 涨幅太弱不在进攻形态射程
    // 已封死涨停盘中追不进；--locked-ok 仅用于盘后回测验证
    if (!process.argv.includes('--locked-ok') && q.pct >= (limitRatio(code, q.name) * 100) - 0.3) { stat.excluded.locked++; continue; }
    candidates.push({ code, q, meta, lp });
  }
  stat.candidates = candidates.length;

  // 用户要求（8/27）：封死涨停的停评分，没涨停的继续评。
  // 掉出候选但仍在榜的票分两类处理：
  //   A) 已封死涨停/一字板 → 停评分（买不进、形态走完），只刷行情，标"已停评分"
  //   B) 没涨停（只是掉出成交额榜前80）→ 放回评分集继续评，别让涨幅/评分冻结
  const candidateCodes = new Set(candidates.map(c => c.code));
  const dropped = Object.values(state.stocks).filter(s => !candidateCodes.has(s.code));
  const scoringSet = [...candidates];
  if (dropped.length) {
    const droppedQuotes = await getBatchQuote(dropped.map(s => s.code));
    for (const s of dropped) {
      const q = droppedQuotes[s.code];
      if (!q) continue;   // 行情拉不到，保持原样下轮再试
      const lp = limitPrice(q.prevClose, s.code, q.name);
      const locked = q.pct >= (limitRatio(s.code, q.name) * 100) - 0.3;
      if (locked || isOneWord(q, lp)) {
        // A) 封死：停评分，仅刷行情
        s.quote = q;
        s.stale = true;
        s.nearLimit = true;
      } else {
        // B) 没封死：继续评分
        scoringSet.push({ code: s.code, q, meta: { src: s.src || '成交额榜', lbc: s.lbc || 1, hybk: s.hybk, ltszYi: s.ltszYi, amtWan: s.amtWan }, lp });
      }
    }
  }

  const mState = model.loadState();
  const breadth = Math.min(1, ztCount / 80);   // 80家涨停=极热；0=冰点

  await mapPool(scoringSet, async ({ code, q, meta, lp }) => {
    const bars = await getMinute(code);
    if (!bars || bars.length < 15) { stat.noData++; return; }
    const prevLow = await getPrevLow(code);
    const r = scoreAttack(bars, { prevClose: q.prevClose, prevLow });
    stat.scored++;

    // ---- 特征 → 概率 → 置信度（概率模型层） ----
    const hybk = meta.hybk || null;
    let sec = null;
    if (hybk) {
      const hot = secAgg[hybk]?.hot || 0;
      const tm = sectorMap[hybk];   // 腾讯行业榜同名命中则取其涨幅/名次
      sec = {
        name: hybk, hot,
        zdf: tm ? tm.zdf : 0,
        rank: tm ? tm.rank : 60
      };
    }
    const amtWan = meta.amtWan || (meta.ltszYi && q.turnover ? meta.ltszYi * q.turnover / 100 * 1e4 : 0);
    const feat = buildFeatures({
      bars, prevClose: q.prevClose, d: r.d, ruleScore: r.score,
      q, meta: { lbc: meta.lbc, zbc: meta.zbc },
      fundWan: meta.fundWan || 0, ltszYi: meta.ltszYi || 0,
      amtWan, rankAmts, sec, breadth
    }, mState.stats);
    const pred = model.predict(feat.z, mState);

    const nearLimit = q.price >= lp * 0.995;
    const st = state.stocks[code] || { series: [], alerted: {} };
    // stale:false —— 清掉历史残留标记（修复"没涨停却一直显示已停评分"的粘性bug）
    Object.assign(st, {
      code, name: q.name, src: meta.src, lbc: meta.lbc || 1, zbc: meta.zbc,
      hybk, quote: q, result: r, nearLimit, stale: false,
      prob: pred.prob, confidence: pred.confidence, signals: feat.signals, z: feat.z, raw: feat.raw
    });
    st.series.push({ t: bars[bars.length - 1].t, score: r.score, prob: pred.prob });
    if (st.series.length > 400) st.series.shift();
    state.stocks[code] = st;

    // ---- 样本落盘：每只只保留当天最后一份快照（复盘以最终形态为准） ----
    // alertT/alertPrice 只记录"首次"报警，跨轮覆写时必须继承，否则复盘入场点丢失
    const prevSample = state.samples[code];
    state.samples[code] = {
      day, code, name: q.name, t: bars[bars.length - 1].t, price: q.price, prevClose: q.prevClose,
      score: r.score, prob: pred.prob, confidence: pred.confidence,
      signals: feat.signals, z: feat.z, tags: r.tags, src: meta.src,
      alertT: prevSample?.alertT, alertPrice: prevSample?.alertPrice
    };

    // 报警：概率阈值（模型自适应）+ 规则分≥80 双确认，每档每天一次
    const th = mState.alertThreshold || 0.5;
    for (const [lv, name_] of [[80, '强势']]) {
      if (r.score >= lv && pred.prob >= th && !st.alerted[lv]) {
        st.alerted[lv] = true;
        // 首次报警时刻/价格写入样本 = 复盘的"入场点"（算报警后浮盈/回撤）
        if (state.samples[code]) {
          state.samples[code].alertT = bars[bars.length - 1].t;
          state.samples[code].alertPrice = q.price;
        }
        state.alerts.unshift({
          t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          code, name: q.name, level: name_, score: r.score,
          prob: pred.prob, confidence: pred.confidence,
          pct: r.d.pct, tags: r.tags.join('/'), signals: feat.signals.join('·'),
          price: q.price, src: meta.src, lbc: meta.lbc
        });
        state.log.push({ ts: Date.now(), code, name: q.name, level: name_, score: r.score, prob: pred.prob, tags: r.tags });
      }
    }
  }, 4);

  // ---- 每日候选榜：按概率取 Top10（核心信号+置信度） ----
  state.topList = Object.values(state.stocks)
    .filter(s => s.prob !== undefined && !s.nearLimit)
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 10)
    .map(s => ({
      code: s.code, name: s.name, src: s.src, price: s.quote.price,
      pct: +((s.quote.price / s.quote.prevClose - 1) * 100).toFixed(2),
      score: s.result.score, prob: s.prob, confidence: s.confidence,
      signals: s.signals, hybk: s.hybk, lbc: s.lbc
    }));

  // ---- 样本文件落盘（整份覆写，崩溃最多丢一轮） ----
  try {
    const sdir = path.join(DIR, 'samples');
    if (!fs.existsSync(sdir)) fs.mkdirSync(sdir, { recursive: true });
    const lines = Object.values(state.samples).map(s => JSON.stringify(s));
    fs.writeFileSync(path.join(sdir, `samples_${day}.jsonl`), lines.join('\n'));
  } catch (e) { console.error('[samples write]', e.message); }

  if (state.alerts.length > 80) state.alerts.length = 80;
  state.running = false;
  stat.costMs = Date.now() - t0;
  state.rounds = state.rounds || [];
  state.rounds.unshift(stat);
  if (state.rounds.length > 30) state.rounds.length = 30;   // 只留最近30轮
  console.log(`[round ${stat.round}] ${stat.t} 涨停${stat.poolZt}/炸板${stat.poolZb}/成交额榜+${stat.poolRank}(市场涨停${ztCount}家) → 候选${stat.candidates}(+回捞${scoringSet.length - candidates.length}) 评分${stat.scored} | 排除:一字${stat.excluded.word} 封死${stat.excluded.locked} 弱${stat.excluded.weak} ST${stat.excluded.st} 科创${stat.excluded.kcb} | 耗时${stat.costMs}ms`);
}

// ---------- HTTP ----------
function snapshot() {
  const list = Object.values(state.stocks)
    .map(s => ({
      code: s.code, name: s.name, src: s.src, lbc: s.lbc, hybk: s.hybk,
      price: s.quote.price,
      pct: +((s.quote.price / s.quote.prevClose - 1) * 100).toFixed(2),   // 涨幅用实时行情算，不用评分时的旧值
      turnover: s.quote.turnover,
      score: s.result.score, level: s.result.level, tags: s.result.tags, d: s.result.d,
      prob: s.prob, confidence: s.confidence, signals: s.signals,
      nearLimit: s.nearLimit, stale: !!s.stale, series: s.series.slice(-120)
    }))
    .sort((a, b) => b.score - a.score);
  return {
    ts: Date.now(), day: state.day, round: state.round, running: state.running, nextScanAt,
    rounds: state.rounds || [], alerts: state.alerts, jj: state.jjSnapshot || null,
    topList: state.topList || [],
    model: { version: (model.loadState().version || 0), alertThreshold: model.loadState().alertThreshold || 0.5, samples: model.loadState().samples || 0, reviewDone: !!state.reviewDone },
    list
  };
}

// ---------- 盘后复盘 + 迭代（收盘后只跑一次） ----------
async function doReviewAndIterate() {
  if (state.reviewDone) return;
  const day = todayStr();
  state.reviewDone = true;   // 先占位，防并发重跑
  try {
    console.log(`[review] ${day} 收盘，开始自动复盘...`);
    const report = await runReview(day);
    if (report.error) { console.log('[review] 跳过:', report.error); state.reviewDone = false; return; }
    const iter = runIterate(day);
    console.log(`[review] ${day} 完成：候选${report.n} 命中率${report.hitRate}% 涨停率${report.limitRate}% | 迭代v${iter.version} ${(iter.action || []).join(';')}`);
    state.lastReview = { day, report, iter };
  } catch (e) {
    console.error('[review error]', e.message);
    state.reviewDone = false;
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/data')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  if (req.url.startsWith('/api/scan')) {
    if (!inSession(false)) { res.end('closed'); return; }   // 非交易时段手动强扫也拦下，不浪费请求
    scan(true); res.end('ok'); return;
  }
  if (req.url.startsWith('/api/review')) {
    // 手动触发复盘（盘后调试用）
    doReviewAndIterate().then(() => res.end('ok'));
    return;
  }
  if (req.url.startsWith('/api/report')) {
    // 返回当日复盘HTML
    const day = todayStr();
    const f = path.join(DIR, 'reviews', `report_${day}.html`);
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(f, 'utf-8')); }
    else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<meta charset="utf-8">当日复盘报告尚未生成（收盘后自动生成，或访问 /api/review 触发）'); }
    return;
  }
  if (req.url.startsWith('/api/restart')) {
    // 一键重启：先关闭监听释放端口 → 拉起新进程（detached）→ 本进程退出
    // 注意顺序：若先 spawn 后退出，新进程会撞上 EADDRINUSE 安静死掉
    res.end('restarting');
    setTimeout(() => {
      let spawned = false;
      const doSpawn = () => {
        if (spawned) return;
        spawned = true;
        const child = spawn(process.execPath, [path.join(DIR, 'server.js')], {
          detached: true,
          stdio: ['ignore', fs.openSync(path.join(DIR, 'logs', 'service.log'), 'a'), fs.openSync(path.join(DIR, 'logs', 'service.err.log'), 'a')]
        });
        child.unref();
        console.log('[attack-radar] 收到重启指令，新进程 PID', child.pid);
        setTimeout(() => process.exit(0), 300);
      };
      server.close(doSpawn);
      if (server.closeIdleConnections) server.closeIdleConnections();
      setTimeout(doSpawn, 2000);   // 兜底：连接迟迟不关也强制交接
    }, 300);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(DIR, 'radar.html'), 'utf-8'));
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('[attack-radar] 端口已被占用（服务已在运行），本次启动安静退出。');
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, () => console.log(`[attack-radar] http://localhost:${PORT}`));

let nextScanAt = 0;

async function loop() {
  if (!inSession(process.argv.includes('--force'))) {
    // 盘后复盘窗口：工作日 15:05-16:30，每日仅跑一次（收盘数据已完整）
    const now = new Date();
    const hm = now.getHours() * 100 + now.getMinutes();
    const wd = now.getDay();
    if (wd >= 1 && wd <= 5 && hm >= 1505 && hm <= 1630 && !state.reviewDone) {
      await doReviewAndIterate();
    }
    // 非交易时段：零请求，直接睡到下一个交易时段开始（跨午休/跨周末都精确计算）
    const wait = Math.max(30000, msToNextSession());
    console.log(`[attack-radar] 非交易时段，休眠 ${Math.round(wait / 60000)} 分钟后再看`);
    setTimeout(loop, wait);
    return;
  }
  if (state.running) { setTimeout(loop, 5000); return; }
  try { await scan(false); } catch (e) { console.error('[scan error]', e.message); state.running = false; }
  const wait = nextInterval();
  nextScanAt = Date.now() + wait;
  setTimeout(loop, wait);
}
setTimeout(loop, 3000);

// 收盘后把当天报警日志落盘，供复盘
process.on('SIGINT', () => {
  fs.writeFileSync(path.join(DIR, 'logs', `${state.day}.json`), JSON.stringify(state.log, null, 1));
  process.exit(0);
});
