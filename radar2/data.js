'use strict';
// ============================================================================
// data.js —— 统一数据层（重构版 v2）
//
// 为什么要这个文件：审计发现同一个函数在多文件重复实现，口径已经分叉
//   getBatchQuote  → 5 份（server/morning_direct/relay/zt_next/seed_review）
//   fetchUrl       → 16 份
//   getMinute      → 7 份
//   todayStr       → 5 份
//   limitRatio     → 4 份
//   getZTPoolFull  → 2 份
// 后果实例：seed_review.js 的炸板池用 sort=fund:asc（返回空池），
//           server.js 用 fbt:asc（正确）—— 同一份数据两种口径，
//           而 seed_review 产出的 8/27 数据成了污染整个回测的种子。
//
// 本文件是唯一数据出口。所有模块只准 require('./data')。
// ============================================================================
const https = require('https');
const { TextDecoder } = require('util');

// ---------- 通用请求（带抖动 + 超时 + 静默失败） ----------
function fetchUrl(url, { timeout = 8000, asBuffer = false, jitter = 400 } = {}) {
  return new Promise(resolve => {
    const delay = Math.floor(Math.random() * jitter);
    setTimeout(() => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' },
        timeout
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(asBuffer ? buf : buf.toString('utf-8'));
        });
      });
      req.on('error', () => resolve(asBuffer ? Buffer.alloc(0) : ''));
      req.on('timeout', () => { req.destroy(); resolve(asBuffer ? Buffer.alloc(0) : ''); });
    }, delay);
  });
}

// ---------- 时间/代码工具 ----------
function todayStr(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function dayIso(day) { return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`; }
function nowHM(d = new Date()) { return d.getHours() * 100 + d.getMinutes(); }
function hhmmss(d = new Date()) { return d.toLocaleTimeString('zh-CN', { hour12: false }); }
// HHMM 或 HH:MM:SS → 分钟数（便于比较时段）
function hm2min(t) {
  const s = String(t || '').replace(/:/g, '').slice(0, 4).padStart(4, '0');
  return parseInt(s.slice(0, 2)) * 60 + parseInt(s.slice(2));
}
// 裸代码 → 带市场前缀
function prefix(code) {
  const c = String(code).replace(/^(sh|sz|bj)/i, '');
  if (/^(6|9|5)/.test(c)) return 'sh' + c;
  if (/^(4|8)/.test(c)) return 'bj' + c;
  return 'sz' + c;
}
function rawCode(code) { return String(code).replace(/^(sh|sz|bj)/i, ''); }

// ---------- 涨跌停比例 / 板别 ----------
function limitRatio(code, name) {
  if (/ST/.test(name || '')) return 0.05;
  if (/^(sz30|sh68)/.test(code)) return 0.20;
  return 0.10;
}
function limitPrice(prevClose, code, name) {
  return Math.round(prevClose * (1 + limitRatio(code, name)) * 100) / 100;
}
function board(code) {
  const c = rawCode(code);
  if (c.startsWith('30')) return '20cm';      // 创业板
  if (c.startsWith('68')) return 'kcb';       // 科创板（用户买不了）
  if (c.startsWith('60') || c.startsWith('00')) return 'main';  // 主板
  if (c.startsWith('8') || c.startsWith('4')) return 'bj';
  return 'other';
}
// 一字/T字板：开盘即贴涨停且未下探 = 买不进
function isOneWord(q, lp) {
  return q.open >= lp * 0.998 && q.low >= q.open * 0.995;
}

// ---------- 腾讯批量行情（GBK；唯一实现） ----------
// 返回：{ [code]: {name, price, prevClose, open, high, low, pct, turnover, amount, st} }
async function getBatchQuote(codes) {
  const out = {};
  const list = [...new Set(codes)].filter(Boolean);
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const buf = await fetchUrl('https://qt.gtimg.cn/q=' + chunk.join(','), { asBuffer: true });
    if (!buf || !buf.length) continue;
    const txt = new TextDecoder('gbk').decode(buf);
    const re = /v_(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(txt))) {
      const f = m[2].split('~');
      if (f.length < 46) continue;
      const prevClose = parseFloat(f[4]);
      out[m[1]] = {
        name: f[1],
        price: parseFloat(f[3]),
        prevClose,
        open: parseFloat(f[5]),
        high: parseFloat(f[33]),
        low: parseFloat(f[34]),
        pct: parseFloat(f[32]),                      // 涨跌幅%（腾讯口径）
        turnover: parseFloat(f[38]),                 // 换手率%
        amount: parseFloat(f[37]) || 0,              // 成交额(万)
        floatCapYi: parseFloat(f[44]) || 0,          // 流通市值(亿)
        st: /ST|退/.test(f[1])
      };
    }
  }
  return out;
}

// ---------- 腾讯逐分钟分时（累计量做差分；唯一实现） ----------
// 返回：[{t:'0930', p, v}] 升序，v=该分钟量（手）
const minuteCache = new Map();
async function getMinute(code, cacheMs = 40000) {
  const hit = minuteCache.get(code);
  if (hit && Date.now() - hit.ts < cacheMs) return hit.bars;
  const txt = await fetchUrl(`https://ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`);
  try {
    const raw = JSON.parse(txt);
    const lines = raw.data[code].data.data;
    const bars = [];
    let prevCum = 0;
    for (const line of lines) {
      const f = line.split(' ');
      const cum = parseFloat(f[2]);
      const v = cum - prevCum;
      prevCum = cum;
      bars.push({ t: f[0].slice(0, 2) + f[0].slice(2, 4), p: parseFloat(f[1]), v: Math.max(0, v) });
    }
    minuteCache.set(code, { ts: Date.now(), bars });
    return bars;
  } catch (e) { return null; }
}

// ---------- 日K（前复权；唯一实现） ----------
// 返回：[{date:'2026-09-10', open, close, high, low, volume}]
async function getDaily(code, n = 12) {
  const txt = await fetchUrl(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${n},qfq`);
  try {
    const raw = JSON.parse(txt);
    const arr = raw.data[code].qfqday || raw.data[code].day || [];
    return arr.map(d => ({ date: d[0], open: +d[1], close: +d[2], high: +d[3], low: +d[4], volume: +d[5] || 0 }));
  } catch (e) { return []; }
}

// ---------- 前一交易日低点（评分否决项用；每日缓存） ----------
const prevDayCache = new Map();
async function getPrevDay(code, day) {
  const key = code + '|' + day;
  if (prevDayCache.has(key)) return prevDayCache.get(key);
  const kl = await getDaily(code, 8);
  const hist = kl.filter(d => d.date !== dayIso(day));
  const bar = hist.length ? hist[hist.length - 1] : null;
  const r = bar ? { date: bar.date, low: bar.low, close: bar.close } : null;
  prevDayCache.set(key, r);
  return r;
}

// ---------- 东财涨停池 / 炸板池 ----------
// ★ 口径修正：炸板池 sort 必须用 fbt:asc（fund:asc 返回空池 → 8/28 实证 zbc 全丢）
// ★ pagesize=500：热日涨停 >200 家，200 上限会漏票
const EM_UT = '7eea3edcaed734bea9cbfc24409ed989';
async function getZTPool(date, { pagesize = 500 } = {}) {
  const url = `https://push2ex.eastmoney.com/getTopicZTPool?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=${pagesize}&sort=fbt:asc&date=${date}`;
  const txt = await fetchUrl(url);
  try {
    const z = JSON.parse(txt);
    return { tc: z.data?.tc || 0, pool: z.data?.pool || [] };
  } catch (e) { return { tc: 0, pool: [] }; }
}
async function getZBPool(date, { pagesize = 500 } = {}) {
  const url = `https://push2ex.eastmoney.com/getTopicZBPool?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=${pagesize}&sort=fbt:asc&date=${date}`;
  const txt = await fetchUrl(url);
  try {
    const z = JSON.parse(txt);
    return { tc: z.data?.tc || 0, pool: z.data?.pool || [] };
  } catch (e) { return { tc: 0, pool: [] }; }
}
// 池条目标准化（东财字段名晦涩，统一成可读字段；p 单位是千分位）
function normPoolItem(p) {
  const code = (p.m === 1 ? 'sh' : 'sz') + p.c;
  const fbt = parseInt(p.fbt || 0, 10);
  return {
    code,
    name: String(p.n || '').replace(/\s/g, ''),
    price: (parseInt(p.p || 0, 10) / 1000),
    lbc: parseInt(p.lbc || 1, 10),                  // 连板数
    zbc: parseInt(p.zbc || 0, 10),                  // 炸板次数
    fbt,                                            // 首次封板时间 HHMMSS
    fbtHour: fbt ? Math.floor(fbt / 10000) + (Math.floor(fbt / 100) % 100) / 60 : 99,
    fundWan: (p.fund || 0) / 1e4,                   // 封单额(万)
    floatCapYi: (p.ltsz || 0) / 1e8,                // 流通市值(亿)
    turnover: parseFloat(p.hs || 0),                // 换手率%
    sector: p.hybk || null                          // 所属行业板块
  };
}

// ---------- 腾讯成交额榜（补盲区） ----------
async function getTurnoverRank(count = 80) {
  const txt = await fetchUrl(`https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList?board_code=aStock&sort_type=turnover&direct=down&offset=0&count=${count}`);
  try {
    const j = JSON.parse(txt);
    return ((j.data && j.data.rank_list) || [])
      .filter(x => /^(sh|sz)\d{6}$/.test(x.code))
      .map(x => ({
        code: x.code, name: x.name,
        pct: parseFloat(x.zdf) || 0,
        amountWan: parseFloat(x.turnover) || 0,
        floatCapYi: parseFloat(x.ltsz) || 0,
        turnover: parseFloat(x.hsl) || 0
      }));
  } catch (e) { return []; }
}

// ---------- 腾讯行业板块涨幅榜（板块联动） ----------
async function getSectorRank() {
  const txt = await fetchUrl('https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hy&sort_type=price&direct=down&offset=0&count=100');
  try {
    const j = JSON.parse(txt);
    const map = {};
    ((j.data?.rank_list) || []).forEach((x, i) => { map[x.name] = { pct: parseFloat(x.zdf) || 0, rank: i + 1 }; });
    return map;
  } catch (e) { return {}; }
}

// ---------- 并发控制（防限流：同时最多 N 个请求） ----------
async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { ret[idx] = await fn(items[idx], idx); } catch (e) { ret[idx] = null; }
    }
  });
  await Promise.all(workers);
  return ret;
}

module.exports = {
  fetchUrl, todayStr, dayIso, nowHM, hhmmss, hm2min, prefix, rawCode,
  limitRatio, limitPrice, board, isOneWord,
  getBatchQuote, getMinute, getDaily, getPrevDay,
  getZTPool, getZBPool, normPoolItem, getTurnoverRank, getSectorRank,
  mapLimit, minuteCache
};
