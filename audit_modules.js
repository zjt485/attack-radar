'use strict';
// ============================================================================
// audit_modules.js —— 三个独立模块的真实结算（9/10 重构前置）
// 早盘直取 morning_direct / 主板首板接力 relay / 涨停榜次日 zt_next
// 这些模块有各自落盘，但从未结算（relay_verify.py 存在却从未运行）
// 全部用腾讯真实行情/K线结算，禁止编造
// ============================================================================
const https = require('https');
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

function fetchUrl(url, timeout = 10000, asBuffer = false) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' }, timeout }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => { const b = Buffer.concat(c); resolve(asBuffer ? b : b.toString('utf-8')); });
    });
    req.on('error', () => resolve(asBuffer ? Buffer.alloc(0) : ''));
    req.on('timeout', () => { req.destroy(); resolve(asBuffer ? Buffer.alloc(0) : ''); });
  });
}

// 日K（前复权）：用于结算 T+0/T+1/T+2
async function getDaily(code, n = 12) {
  const txt = await fetchUrl(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${n},qfq`);
  try {
    const raw = JSON.parse(txt);
    const arr = raw.data[code].qfqday || raw.data[code].day || [];
    // [date, open, close, high, low, volume]
    return arr.map(d => ({ date: d[0], open: +d[1], close: +d[2], high: +d[3], low: +d[4] }));
  } catch (e) { return []; }
}

// 当日分时（用于算入场后日内极值）
async function getMinute(code) {
  const txt = await fetchUrl(`https://ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`);
  try {
    const raw = JSON.parse(txt);
    const lines = raw.data[code].data.data;
    const bars = []; let prev = 0;
    for (const l of lines) { const f = l.split(' '); const v = parseFloat(f[2]) - prev; prev = parseFloat(f[2]); bars.push({ t: f[0], p: parseFloat(f[1]), v: Math.max(0, v) }); }
    return bars;
  } catch (e) { return null; }
}

function iso(day) { return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`; }
const P = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const out = { generatedAt: new Date().toISOString() };

  // ================= 模块1：早盘直取 =================
  P('\n════════ 模块1：早盘直取 morning_direct（入场=信号价，日内结算） ════════');
  const mdFiles = fs.readdirSync(path.join(DIR, 'samples')).filter(f => /^morning_direct_\d{8}\.json$/.test(f)).sort();
  const mdRows = [];
  for (const f of mdFiles) {
    const day = f.slice(15, 23);
    const sigs = JSON.parse(fs.readFileSync(path.join(DIR, 'samples', f), 'utf-8'));
    for (const s of sigs) {
      const bars = await getMinute(s.code);
      if (!bars) { mdRows.push({ day, ...s, err: 'nodata' }); continue; }
      // 入场后（含入场当根）日内极值
      const after = bars.filter(b => b.t >= String(s.t).replace(/:/g, '').slice(0, 4));
      const use = after.length >= 2 ? after : bars.slice(-30);
      const peak = Math.max(...use.map(b => b.p));
      const trough = Math.min(...use.map(b => b.p));
      const close = bars[bars.length - 1].p;
      const prevClose = bars[0] ? (s.price / (1 + s.pct / 100)) : 0;
      mdRows.push({
        day, t: s.t, code: s.code, name: s.name, src: s.src,
        entry: s.price, entryPct: s.pct, openPct: s.openPct, bars: s.bars, rising: s.rising,
        maxGain: +((peak / s.price - 1) * 100).toFixed(2),
        maxDD: +((trough / s.price - 1) * 100).toFixed(2),
        toClose: +((close / s.price - 1) * 100).toFixed(2),
        closePct: prevClose > 0 ? +((close / prevClose - 1) * 100).toFixed(2) : null,
        limitClose: false
      });
      await sleep(200);
    }
  }
  const mdOk = mdRows.filter(r => r.maxGain !== undefined);
  const mdS = (arr, lb) => {
    const n = arr.length; if (!n) { P(lb + ' n=0'); return null; }
    const w3 = arr.filter(x => x.maxGain >= 3).length, w5 = arr.filter(x => x.maxGain >= 5).length;
    const l4 = arr.filter(x => x.maxDD <= -4).length;
    const cw = arr.filter(x => x.maxGain >= 3 && x.maxDD > -4).length;
    const pos = arr.filter(x => x.toClose > 0).length;
    const g = arr.reduce((a, b) => a + b.maxGain, 0) / n, d = arr.reduce((a, b) => a + b.maxDD, 0) / n, c = arr.reduce((a, b) => a + b.toClose, 0) / n;
    P(lb.padEnd(20) + String(n).padStart(4) + (w3 / n * 100).toFixed(0).padStart(8) + '%' + (w5 / n * 100).toFixed(0).padStart(6) + '%' + (cw / n * 100).toFixed(0).padStart(7) + '%' + (l4 / n * 100).toFixed(0).padStart(7) + '%' + (pos / n * 100).toFixed(0).padStart(8) + '%' + g.toFixed(2).padStart(8) + d.toFixed(2).padStart(8) + c.toFixed(2).padStart(9));
    return { label: lb, n, win3Pct: +(w3 / n * 100).toFixed(1), win5Pct: +(w5 / n * 100).toFixed(1), cleanWinPct: +(cw / n * 100).toFixed(1), loss4Pct: +(l4 / n * 100).toFixed(1), closePosPct: +(pos / n * 100).toFixed(1), avgGain: +g.toFixed(2), avgDD: +d.toFixed(2), avgToClose: +c.toFixed(2) };
  };
  P('组别'.padEnd(18) + '  n  浮盈3%  浮盈5%  干净赢   触-4%   收盘为正  均浮盈   均回撤  均入场→收盘');
  out.md = { overall: mdS(mdOk, '全部早盘直取'), rows: mdRows };
  out.md.bySrc = {};
  for (const s of [...new Set(mdOk.map(r => r.src))]) out.md.bySrc[s] = mdS(mdOk.filter(r => r.src === s), '来源:' + s);
  out.md.byEntryPct = [
    mdS(mdOk.filter(r => r.entryPct < 3), '信号价<3cm'),
    mdS(mdOk.filter(r => r.entryPct >= 3 && r.entryPct < 4), '3~4cm'),
    mdS(mdOk.filter(r => r.entryPct >= 4), '>=4cm')
  ];
  out.md.byOpenPct = [
    mdS(mdOk.filter(r => r.openPct < 1.5), '开盘<1.5cm'),
    mdS(mdOk.filter(r => r.openPct >= 1.5 && r.openPct < 3), '开盘1.5~3cm'),
    mdS(mdOk.filter(r => r.openPct >= 3), '开盘>=3cm')
  ];
  P('\n明细：');
  for (const r of mdOk) P(`  ${r.day} ${r.t} ${r.name}(${r.code}) 入${r.entry}(+${r.entryPct}%) 开+${r.openPct}% → 浮盈${r.maxGain}% 回撤${r.maxDD}% 收盘${r.toClose >= 0 ? '+' : ''}${r.toClose}% [${r.src}]`);

  // ================= 模块2：主板首板接力 relay =================
  P('\n════════ 模块2：主板首板接力 relay（收盘买→次日/T+2 结算，从未跑过 verify） ════════');
  const rlFiles = fs.readdirSync(path.join(DIR, 'samples')).filter(f => /^relay_samples_\d{8}\.json$/.test(f)).sort();
  const rlRows = [];
  for (const f of rlFiles) {
    const snap = JSON.parse(fs.readFileSync(path.join(DIR, 'samples', f), 'utf-8'));
    const day = snap.day;
    for (const r of (snap.rows || [])) {
      const kl = await getDaily(r.code, 12);
      const i = kl.findIndex(k => k.date === iso(day));
      if (i < 0) { rlRows.push({ day, ...r, err: 'no-kline' }); continue; }
      const buy = kl[i].close;                                  // 纪律：收盘买
      const t1 = kl[i + 1], t2 = kl[i + 2];
      rlRows.push({
        day, code: r.code, name: r.name, regime: snap.regime, ztCount: snap.ztCount,
        prior10: r.prior10, fundWan: r.fundWan, ltszYi: r.ltszYi, price: r.price,
        buy, 
        t1Open: t1 ? +((t1.open / buy - 1) * 100).toFixed(2) : null,
        t1High: t1 ? +((t1.high / buy - 1) * 100).toFixed(2) : null,
        t1Close: t1 ? +((t1.close / buy - 1) * 100).toFixed(2) : null,
        t2Close: t2 ? +((t2.close / buy - 1) * 100).toFixed(2) : null,
        // 纪律口径：次日高开>2%持有看收盘，否则次日开盘卖
        ruleExit: t1 ? (t1.open / buy - 1 > 0.02 ? +((t1.close / buy - 1) * 100).toFixed(2) : +((t1.open / buy - 1) * 100).toFixed(2)) : null
      });
      await sleep(200);
    }
  }
  const rlOk = rlRows.filter(r => r.t1Close !== null);
  const rlS = (arr, lb) => {
    const n = arr.length; if (!n) { P(lb + ' n=0'); return null; }
    const pos = arr.filter(x => x.ruleExit > 0).length;
    const t1o = arr.filter(x => x.t1Open > 0).length;
    const hi = arr.filter(x => x.t1High >= 2).length;
    const avg = k => arr.reduce((a, b) => a + (b[k] || 0), 0) / n;
    P(lb.padEnd(22) + String(n).padStart(4) + (pos / n * 100).toFixed(0).padStart(9) + '%' + avg('ruleExit').toFixed(2).padStart(9) + (t1o / n * 100).toFixed(0).padStart(9) + '%' + avg('t1Open').toFixed(2).padStart(8) + (hi / n * 100).toFixed(0).padStart(8) + '%' + avg('t1High').toFixed(2).padStart(8) + avg('t1Close').toFixed(2).padStart(9) + (arr.filter(x => x.t2Close !== null).length ? avg('t2Close').toFixed(2) : 'n/a').padStart(8));
    return { label: lb, n, ruleWinPct: +(pos / n * 100).toFixed(1), avgRuleExit: +avg('ruleExit').toFixed(2), t1OpenPosPct: +(t1o / n * 100).toFixed(1), avgT1Open: +avg('t1Open').toFixed(2), t1High2Pct: +(hi / n * 100).toFixed(1), avgT1High: +avg('t1High').toFixed(2), avgT1Close: +avg('t1Close').toFixed(2), avgT2Close: +avg('t2Close').toFixed(2) };
  };
  P('组别'.padEnd(20) + '  n  纪律胜率  纪律均收  T1高开率  T1均开   T1冲2%率 T1均高   T1均收   T2均收');
  out.relay = { overall: rlS(rlOk, '全部接力名单'), rows: rlRows };
  out.relay.byRegime = {};
  for (const g of [...new Set(rlOk.map(r => r.regime))]) out.relay.byRegime[g] = rlS(rlOk.filter(r => r.regime === g), '市况:' + g);
  out.relay.byPrior10 = [
    rlS(rlOk.filter(r => r.prior10 < 0), '前10日<0%'),
    rlS(rlOk.filter(r => r.prior10 >= 0 && r.prior10 < 5), '前10日0~5%'),
    rlS(rlOk.filter(r => r.prior10 >= 5 && r.prior10 < 9.5), '前10日5~9.5%')
  ];
  out.relay.byFund = [
    rlS(rlOk.filter(r => r.fundWan < 5000), '封单<5000万'),
    rlS(rlOk.filter(r => r.fundWan >= 5000 && r.fundWan < 20000), '封单0.5~2亿'),
    rlS(rlOk.filter(r => r.fundWan >= 20000), '封单>=2亿')
  ];
  P('\n明细（前25条）：');
  for (const r of rlOk.slice(0, 25)) P(`  ${r.day} ${r.name}(${r.code}) [${r.regime}/涨停${r.ztCount}] 前10日+${r.prior10}% 封单${r.fundWan}万 买${r.buy} → T1开${r.t1Open}% 高${r.t1High}% 收${r.t1Close}% T2收${r.t2Close}% 纪律${r.ruleExit >= 0 ? '+' : ''}${r.ruleExit}%`);

  // ================= 模块3：涨停榜次日 zt_next =================
  P('\n════════ 模块3：涨停榜次日关注 zt_next（S/A/B 分级是否真有区分力） ════════');
  const znFiles = fs.readdirSync(path.join(DIR, 'samples')).filter(f => /^zt_next_\d{8}\.json$/.test(f)).sort();
  const znRows = [];
  for (const f of znFiles) {
    const snap = JSON.parse(fs.readFileSync(path.join(DIR, 'samples', f), 'utf-8'));
    const day = snap.day;
    for (const r of (snap.rows || [])) {
      const kl = await getDaily(r.code, 12);
      const i = kl.findIndex(k => k.date === iso(day));
      if (i < 0 || !kl[i + 1]) { znRows.push({ day, ...r, err: 'no-next' }); continue; }
      const t1 = kl[i + 1];
      const base = kl[i].close;
      znRows.push({
        day, code: r.code, name: r.name, tier: r.tier, lbc: r.lbc, hybk: r.hybk,
        fbtH: r.fbtH, zbc: r.zbc, fundLtsz: r.fundLtsz, ltszYi: r.ltszYi, hs: r.hs, secN: r.secN, tags: r.tags,
        openPct: +((t1.open / base - 1) * 100).toFixed(2),
        highPct: +((t1.high / base - 1) * 100).toFixed(2),
        lowPct: +((t1.low / base - 1) * 100).toFixed(2),
        closePct: +((t1.close / base - 1) * 100).toFixed(2)
      });
      await sleep(200);
    }
  }
  const znOk = znRows.filter(r => r.openPct !== undefined);
  const znS = (arr, lb) => {
    const n = arr.length; if (!n) { P(lb + ' n=0'); return null; }
    const avg = k => arr.reduce((a, b) => a + b[k], 0) / n;
    // 可执行口径：只在开0~5%时介入，收益=入场后到收盘
    const ent = arr.filter(x => x.openPct >= 0 && x.openPct < 5);
    const entRet = ent.length ? ent.reduce((a, b) => a + ((1 + b.closePct / 100) / (1 + b.openPct / 100) - 1) * 100, 0) / ent.length : null;
    const entWin = ent.length ? ent.filter(x => ((1 + x.closePct / 100) / (1 + x.openPct / 100) - 1) * 100 > 0).length / ent.length * 100 : null;
    P(lb.padEnd(24) + String(n).padStart(4) + avg('openPct').toFixed(2).padStart(9) + (arr.filter(x => x.openPct > 0).length / n * 100).toFixed(0).padStart(8) + '%' + avg('highPct').toFixed(2).padStart(9) + avg('closePct').toFixed(2).padStart(9) + (arr.filter(x => x.closePct > 0).length / n * 100).toFixed(0).padStart(8) + '%' + (arr.filter(x => x.closePct >= 9.8).length / n * 100).toFixed(0).padStart(8) + '%' + String(ent.length).padStart(6) + (entRet !== null ? entRet.toFixed(2) : 'n/a').padStart(9) + (entWin !== null ? entWin.toFixed(0) + '%' : 'n/a').padStart(7));
    return { label: lb, n, avgOpen: +avg('openPct').toFixed(2), openPosPct: +(arr.filter(x => x.openPct > 0).length / n * 100).toFixed(1), avgHigh: +avg('highPct').toFixed(2), avgClose: +avg('closePct').toFixed(2), closePosPct: +(arr.filter(x => x.closePct > 0).length / n * 100).toFixed(1), limitPct: +(arr.filter(x => x.closePct >= 9.8).length / n * 100).toFixed(1), entryableN: ent.length, entryAvgRet: entRet !== null ? +entRet.toFixed(2) : null, entryWinPct: entWin !== null ? +entWin.toFixed(1) : null };
  };
  P('组别'.padEnd(22) + '  n   均开盘   高开率    均最高    均收盘   收盘红   次日板  可介入n  介入均收  介入胜率');
  out.ztNext = { overall: znS(znOk, '全部名单'), rows: znRows };
  out.ztNext.byTier = {};
  for (const t of ['S', 'A', 'B']) out.ztNext.byTier[t] = znS(znOk.filter(r => r.tier === t), '档位:' + t);
  out.ztNext.byLbc = [znS(znOk.filter(r => r.lbc >= 2), '>=2连板'), znS(znOk.filter(r => r.lbc === 1), '首板')];
  out.ztNext.byFbt = [
    znS(znOk.filter(r => r.fbtH < 9.5), '封板<09:30(秒板)'),
    znS(znOk.filter(r => r.fbtH >= 9.5 && r.fbtH < 10), '封板09:30-10:00'),
    znS(znOk.filter(r => r.fbtH >= 10 && r.fbtH < 10.5), '封板10:00-10:30'),
    znS(znOk.filter(r => r.fbtH >= 10.5), '封板>10:30')
  ];
  out.ztNext.byFundLtsz = [
    znS(znOk.filter(r => r.fundLtsz < 2), '封单/流通<2%'),
    znS(znOk.filter(r => r.fundLtsz >= 2 && r.fundLtsz < 5), '2~5%'),
    znS(znOk.filter(r => r.fundLtsz >= 5), '>=5%怪物')
  ];
  out.ztNext.byHs = [
    znS(znOk.filter(r => r.hs < 10), '换手<10%'),
    znS(znOk.filter(r => r.hs >= 10 && r.hs < 15), '换手10~15%'),
    znS(znOk.filter(r => r.hs >= 15), '换手>=15%')
  ];
  out.ztNext.bySecN = [
    znS(znOk.filter(r => r.secN < 2), '板块1家(孤板)'),
    znS(znOk.filter(r => r.secN >= 2 && r.secN < 8), '板块2~7家'),
    znS(znOk.filter(r => r.secN >= 8), '板块>=8家过热')
  ];
  P('\n明细（前20条）：');
  for (const r of znOk.slice(0, 20)) P(`  ${r.day} [${r.tier}] ${r.name}(${r.code}) ${r.lbc}板 封${r.fbtH}h 炸${r.zbc} 封/流通${r.fundLtsz}% → 次日开${r.openPct}% 高${r.highPct}% 收${r.closePct}%`);

  fs.writeFileSync(path.join(DIR, 'audit_modules_result.json'), JSON.stringify(out, null, 1));
  P('\n结果已写入 audit_modules_result.json');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
