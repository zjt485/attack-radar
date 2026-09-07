'use strict';
// ============================================================================
// zt_next.js —— 涨停榜次日关注模块（9/7 用户需求："收盘拉涨停榜，次日重点关注可介入机会"）
//
// 回测依据（backtest_zt_next.py，617样本/11个涨停日，2026-08-18~09-07）：
//   组合阶梯：早板<10:00+0炸板 → 开+3.55%/连板40%
//             +封单≥2%流通 → +5.59%/76%/54%
//             +流通20~300亿+换手<15% → +6.36%/82%/59%（C5，n=78）
//             +板块2~7家涨停 → +6.69%/84%/63%（C6，n=43）
//             C5内≥2连板 → +7.24%/87%/68%
//   单因子：封板时间最强（13:30后=垃圾，开-0.05%/连板4%）；封单/流通≥5%怪物层
//           （+7.73%/92%/73%）；换手≥25%出货（开-1.20%）；板块≥8家过热反噬（收-5.26%）
//   可介入性：C5组65%次日高开>5%追不上；开0~5%子集（n=17）收+2.99%/胜76%/冲高+8.66%
//             → 名单收盘出，介入信号次日开盘定（0~5%=可介入，>5%=只看不追，<0=弱开观察）
//
// 档位定义（直接映射回测组合，不发明新规则）：
//   S级 = C6/C5（早板<10:00 + 0炸 + 封单≥2% + 20~300亿 + 换手<15%）
//   A级 = 宽版（早板<10:30 + 炸≤1 + 封单≥1% + 20~300亿 + 换手<15%）
//   B级 = 底线（早板<10:00 + 0炸）——强度够但市值/封单有瑕疵
//   附加标记：≥2连板（回测连板率68%层）、一字板（次日大概率开>5%）、板块过热（≥8家）
//
// 流程：15:05后 buildZTNext(day) 拉当日全量涨停池→打分→落盘 samples/zt_next_YYYYMMDD.json
//       次日 9:31~9:50 morningCheck(state) 用腾讯行情核对开盘→0~5%弹"次日介入"通知+track记录
// ============================================================================
const https = require('https');
const fs = require('fs');
const path = require('path');
const notify = require('./notify');
const track = require('./track');

const DIR = __dirname;

function fetchUrl(url, timeout = 8000, asBuffer = false) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' }, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve(asBuffer ? buf : buf.toString('utf-8')); });
    });
    req.on('error', () => resolve(asBuffer ? Buffer.alloc(0) : ''));
    req.on('timeout', () => { req.destroy(); resolve(asBuffer ? Buffer.alloc(0) : ''); });
  });
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function hhmmss() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

function prefix(code) {
  if (/^(6|9|5)/.test(code)) return 'sh' + code;
  if (/^(4|8)/.test(code)) return 'bj' + code;
  return 'sz' + code;
}

// ---------- 全量涨停池（pagesize=500，热日200+家） ----------
async function getZTPoolFull(date) {
  const url = `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt:asc&date=${date}`;
  const txt = await fetchUrl(url);
  try {
    const z = JSON.parse(txt);
    return { tc: z.data?.tc || 0, pool: z.data?.pool || [] };
  } catch (e) { return { tc: 0, pool: [] }; }
}

// ---------- 腾讯批量行情（GBK） ----------
async function getBatchQuote(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += 50) {
    const chunk = codes.slice(i, i + 50);
    const buf = await fetchUrl('https://qt.gtimg.cn/q=' + chunk.join(','), 8000, true);
    if (!buf.length) continue;
    const txt = new TextDecoder('gbk').decode(buf);
    const re = /v_(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(txt))) {
      const f = m[2].split('~');
      if (f.length < 46) continue;
      out[m[1]] = { name: f[1], price: parseFloat(f[3]), prevClose: parseFloat(f[4]), open: parseFloat(f[5]) };
    }
  }
  return out;
}

// ---------- 收盘构建次日关注名单 ----------
async function buildZTNext(day) {
  const { tc, pool } = await getZTPoolFull(day);
  if (!pool.length) return { day, n: 0, tc, rows: [], note: '涨停池为空（API仅保留近期历史）' };

  // 板块共振计数
  const secN = {};
  for (const p of pool) { const bk = p.hybk || ''; secN[bk] = (secN[bk] || 0) + 1; }

  const rows = [];
  for (const p of pool) {
    const code = String(p.c);
    const name = String(p.n || '').replace(/\s/g, '');
    if (/ST|退/.test(name)) continue;
    const fbt = parseInt(p.fbt || 0, 10);
    const fbtH = fbt ? Math.floor(fbt / 10000) + (Math.floor(fbt / 100) % 100) / 60 : 99;
    const zbc = parseInt(p.zbc || 0, 10);
    const fund = parseFloat(p.fund || 0);
    const ltsz = parseFloat(p.ltsz || 0);
    const fundLtsz = ltsz > 0 ? fund / ltsz * 100 : 0;
    const hs = parseFloat(p.hs || 0);
    const lbc = parseInt(p.lbc || 1, 10);
    const bk = p.hybk || '';
    const sec = secN[bk] || 1;
    const yizi = fbt <= 92500 && zbc === 0;          // 竞价/秒板=大概率一字（次日高开追不上标记）
    const closePrice = (parseInt(p.p || 0, 10) / 1000);

    // 档位判定（直接映射回测组合）
    const sizeOk = ltsz >= 2e9 && ltsz < 3e10;         // 流通20~300亿
    const hsOk = hs < 15;
    let tier = null;
    if (fbtH < 10 && zbc === 0 && fundLtsz >= 2 && sizeOk && hsOk) tier = 'S';
    else if (fbtH < 10.5 && zbc <= 1 && fundLtsz >= 1 && sizeOk && hsOk) tier = 'A';
    else if (fbtH < 10 && zbc === 0) tier = 'B';
    if (!tier) continue;                               // 回测证明无优势的层不进名单

    const tags = [];
    if (lbc >= 2) tags.push(`${lbc}连板`);             // C5内≥2连板：开+7.24%/胜87%/连板68%
    if (yizi) tags.push('一字/秒板');
    if (sec >= 8) tags.push(`板块过热${sec}家`);        // ≥8家次日反噬（收-5.26%）
    else if (sec >= 2) tags.push(`板块${sec}家`);
    if (fundLtsz >= 5) tags.push('封单≥5%怪物');        // 回测最强层：开+7.73%/胜92%/连板73%
    if (fbtH < 9.55) tags.push('秒板');
    if (hs < 3) tags.push('锁筹(换手<3%)');

    rows.push({
      code: prefix(code), name, hybk: bk, tier, lbc,
      fbt: String(fbt).padStart(6, '0'), fbtH: +fbtH.toFixed(2), zbc,
      fundWan: Math.round(fund / 1e4), fundLtsz: +fundLtsz.toFixed(2),
      ltszYi: +(ltsz / 1e8).toFixed(1), hs: +hs.toFixed(1),
      secN: sec, closePrice: +closePrice.toFixed(2), tags
    });
  }

  // 排序：S>A>B，同级按封单比降序；截断20只（名单要精不要多）
  const tierRank = { S: 0, A: 1, B: 2 };
  rows.sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.fundLtsz - a.fundLtsz);
  const out = {
    day, genT: hhmmss(), tc, n: Math.min(rows.length, 20),
    regime: tc >= 126 ? '极热' : tc >= 103 ? '热' : tc >= 60 ? '中' : '冷',
    note: 'S=C5/C6组合(回测开+6.4~6.7%/胜82~84%/连板59~63%) A=宽版(+3.8%/69%/39%) B=早板0炸底线',
    rows: rows.slice(0, 20)
  };
  return out;
}

function savePath(day) { return path.join(DIR, 'samples', `zt_next_${day}.json`); }
function saveZTNext(snap) {
  try { fs.mkdirSync(path.join(DIR, 'samples'), { recursive: true }); fs.writeFileSync(savePath(snap.day), JSON.stringify(snap, null, 1)); } catch (_) {}
}
function loadZTNext(day) {
  try { return JSON.parse(fs.readFileSync(savePath(day), 'utf-8')); } catch (_) { return null; }
}
// 找最近一个交易日的名单（次日早盘用：today 之前最新的 zt_next 文件）
function loadLatestBefore(today) {
  try {
    const files = fs.readdirSync(path.join(DIR, 'samples')).filter(f => /^zt_next_\d{8}\.json$/.test(f));
    const days = files.map(f => f.slice(8, 16)).filter(d => d < today).sort();
    if (!days.length) return null;
    return loadZTNext(days[days.length - 1]);
  } catch (_) { return null; }
}

// ---------- 次日早盘核对（9:31~9:50，开盘价定介入信号） ----------
// 回测依据：S/A级组次日开0~5%子集 收+2.99%/胜76%/冲高+8.66%（可介入）；
//           开>5%占65%（追不上，只看不追）；开<0弱开（需盘中走强确认，v1只标记）
async function morningCheck(state) {
  const today = todayStr();
  if (state.ztNextMorning && state.ztNextMorning.day === today) return { skipped: 'today-done' };
  const snap = loadLatestBefore(today);
  if (!snap || !snap.rows || !snap.rows.length) return { skipped: 'no-list' };

  const now = new Date();
  const hm = now.getHours() * 100 + now.getMinutes();
  if (hm < 931) return { skipped: 'before-931' };

  const quotes = await getBatchQuote(snap.rows.map(r => r.code));
  const signals = [];
  for (const r of snap.rows) {
    const q = quotes[r.code];
    if (!q || !(q.prevClose > 0) || !(q.open > 0)) continue;
    const openPct = +((q.open / q.prevClose - 1) * 100).toFixed(2);
    const curPct = +((q.price / q.prevClose - 1) * 100).toFixed(2);
    let verdict, action;
    if (openPct >= 0 && openPct < 5) {
      verdict = 'entry'; action = `开${openPct >= 0 ? '+' : ''}${openPct}%落0~5%介入区（回测：收+2.99%/胜76%）`;
    } else if (openPct >= 5) {
      verdict = 'high'; action = `高开${openPct}%超5cm纪律，只看不追（等回踩或放弃）`;
    } else {
      verdict = 'weak'; action = `低开${openPct}%弱开，需盘中放量走强再确认，不抢`;
    }
    signals.push({ code: r.code, name: r.name, tier: r.tier, lbc: r.lbc, hybk: r.hybk, open: q.open, openPct, price: q.price, curPct, verdict, action, tags: r.tags });
    if (verdict === 'entry') {
      notify.send({ type: '次日介入', code: r.code, name: r.name, text: `${r.tier}级 开+${openPct}%@${q.open} 落介入区 现${curPct >= 0 ? '+' : ''}${curPct}% ${r.tags.join('/')}` });
      track.record({ type: '次日介入', code: r.code, name: r.name, price: q.price, note: `${r.tier}级 开盘价${q.open}(+${openPct}%) 涨停日${snap.day}` });
    } else {
      track.record({ type: '次日观察', code: r.code, name: r.name, price: q.price, note: `${r.tier}级 ${verdict === 'high' ? '高开' + openPct + '%只看不追' : '低开' + openPct + '%弱开'} 涨停日${snap.day}` });
    }
  }
  state.ztNextMorning = { day: today, listDay: snap.day, checkedAt: hhmmss(), signals };
  try { fs.writeFileSync(path.join(DIR, 'samples', `zt_next_morning_${today}.json`), JSON.stringify(state.ztNextMorning, null, 1)); } catch (_) {}
  const nE = signals.filter(s => s.verdict === 'entry').length;
  console.log(`[zt-next] 早盘核对完成：名单${snap.rows.length}只(${snap.day}) → 介入区${nE}只 高开${signals.filter(s => s.verdict === 'high').length} 弱开${signals.filter(s => s.verdict === 'weak').length}`);
  return state.ztNextMorning;
}

module.exports = { buildZTNext, saveZTNext, loadZTNext, loadLatestBefore, morningCheck };
