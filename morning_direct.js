'use strict';
// ============================================================================
// morning_direct.js —— 早盘直取（9:30-9:40 直拉窗口）
//
// 背景（8/28 江天化学漏报，9/1 用户批准落地，9/3 回测升级）：
//   报警引擎要 15 根分钟线（9:45 前够不着），成交额榜前80门槛（≈20亿）也不收
//   开盘直拉的小票。江天 5 分钟从平开拉到 +7.3%，介入窗口只存在 2-3 分钟，
//   雷达整个链路（入池层+评分层）都抓不住。
//
// 方案：9:30-9:40 高频窗口（每 35 秒一趟，独立于主扫描）：
//   主网 = 东财涨幅榜前80（早盘门槛涨幅极低，刚起爆的票必在榜）
//   辅网 = jj_pre.json 抢筹榜里的 20cm 票（竞价抢筹、开盘后稳步走高的类型）
//   候选 → 腾讯行情精算涨幅 → 落在直取窗口(2~5%) → 拉分钟线做量价加速确认
//   → 直接出"早盘直取"买点信号（不走报警确认门——直拉票等确认就过 5cm 了）。
//
// 9/3 回测升级（江天正面 + 芒果/赛微反面验证）：
//   ① 窗口 2~5cm（回测黄金区，原 1~3.5% 会漏江天 9:33 的 +4.81% 买点）
//   ② 删掉「量递增」假设（江天是首根爆量后量递减，volUp 会卡死它）
//   ③ 新增「开盘幅度门」+0~+3.5%（芒果超媒9/3高开+4.43%冲+11%崩回-1.8%，高开透支必拒）
//
// 纪律继承（用户 8/28 拍板）：只做 20cm（创业板 sz30）。
// 每只每日最多一条信号；落盘 samples/morning_direct_YYYYMMDD.json 供重启恢复。
// ============================================================================
const https = require('https');
const fs = require('fs');
const path = require('path');
const notify = require('./notify');   // 桌面提醒（9/4：早盘直取触发即弹窗+提示音）
const track = require('./track');     // 推荐跟踪（9/4：直取信号记入推荐价对比表）

const DIR = __dirname;

const CFG = {
  windowStart: 930, windowEnd: 940,   // 高频窗口（9:40 后还 <5% 的是磨叽票，不是直拉）
  openMin: 0,                         // 开盘幅度下限（低开=负，直接拒）
  openMax: 3.5,                       // 开盘幅度上限（高开跳空>3.5% = 透支，拒——芒果超媒9/3高开+4.43%冲崩教训）
  pctMin: 2.0,                        // 介入窗口下限 2cm（<2cm 多是弱票，剩余收益仅+0.39%）
  pctMax: 5.0,                        // 介入窗口上限 5cm（黄金区间上沿，≥5cm 空间收窄+超纪律）
  minBars: 2,                         // 至少2根分钟线（最早 9:32 可触发）
  maxBars: 11,                        // 最多11根（窗口9:30-9:40上限；防御盘中误触发/测试）
  minRising: 2,                       // 至少2连涨
  offPeakMax: 1.5,                    // 现价距日内高点最大回落%（防接冲高回落）
  rankN: 80                           // 东财涨幅榜抓取数
};

function fetchUrl(url, timeout = 8000, asBuffer = false) {
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

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- 主网：东财涨幅榜前80（fid=f3，早盘门槛极低，直拉起步票必在榜） ----------
async function getMDRank() {
  const url = `https://82.push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${CFG.rankN}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f3,f6`;
  const txt = await fetchUrl(url);
  try {
    const j = JSON.parse(txt);
    return (j.data?.diff || [])
      .map(r => ({ code: String(r.f12), name: String(r.f14).replace(/\s/g, ''), pct: parseFloat(r.f3), amt: parseFloat(r.f6) }))
      .filter(r => /^\d{6}$/.test(r.code) && isFinite(r.pct));
  } catch (e) { return []; }
}

// ---------- 辅网：抢筹榜里的 20cm 票（jj_bridge.py 9:25 产出） ----------
function loadJJPreCodes(day) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, 'jj_pre.json'), 'utf-8'));
    if (j.day !== day) return [];
    return (j.rows || []).map(r => r.code).filter(c => /^sz30/.test(c));
  } catch (e) { return []; }
}

// ---------- 腾讯批量行情（GBK 解码，同 server.js 口径） ----------
async function getBatchQuote(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += 50) {
    const chunk = codes.slice(i, i + 50);
    const buf = await fetchUrl('https://qt.gtimg.cn/q=' + chunk.join(','), 8000, true);
    const txt = new TextDecoder('gbk').decode(buf);
    const re = /v_(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(txt))) {
      const f = m[2].split('~');
      if (f.length < 46) continue;
      out[m[1]] = {
        name: f[1], price: parseFloat(f[3]), prevClose: parseFloat(f[4]),
        open: parseFloat(f[5]), st: /ST|\u9000/.test(f[1])
      };
    }
  }
  return out;
}

// ---------- 腾讯逐分钟分时 ----------
async function getMinute(code) {
  const txt = await fetchUrl(`https://ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`);
  try {
    const raw = JSON.parse(txt);
    const lines = raw.data[code].data.data;
    const bars = [];
    let prevCum = 0;
    for (const line of lines) {
      const f = line.split(' ');
      const v = parseFloat(f[2]) - prevCum;
      prevCum = parseFloat(f[2]);
      bars.push({ t: f[0], p: parseFloat(f[1]), v: Math.max(0, v) });
    }
    return bars;
  } catch (e) { return null; }
}

// ---------- 量价加速确认（9/1 江天指纹 + 9/3 回测修正） ----------
// 关键教训（9/3 回测）：江天化学是「首根爆量直拉」型（9:31 首根量=前日17倍），
//   后续分钟量反而递减，旧的「volUp 量递增」假设整个是反的，会把江天卡死。
//   正解：能快速从平开冲到 2~5cm 本身就蕴含了放量，无需再卡量递增；
//   改为「开盘幅度门」防高开透支/低开弱（芒果超媒9/3高开+4.43%冲+11%崩回-1.8% 是典型反面）。
function checkLaunch(bars, prevClose) {
  if (bars.length < CFG.minBars) return { ok: false, reason: 'bars<' + CFG.minBars };
  // 早盘直取=开盘起爆（窗口9:30-9:40内最多10根线）。>11根=开盘早就走完的长趋势票，不是起爆，拒绝
  if (bars.length > CFG.maxBars) return { ok: false, reason: 'bars>' + CFG.maxBars + '（非开盘起爆）' };
  const first = bars[0], last = bars[bars.length - 1];
  // ① 开盘幅度门：平开微高（+0~+3.5%）；低开=弱、高开跳空>3.5%=透支，均拒
  const openPct = (first.p / prevClose - 1) * 100;
  if (openPct < CFG.openMin || openPct > CFG.openMax) return { ok: false, reason: `开盘+${openPct.toFixed(1)}%越界` };
  // 连涨：从最新一根往回数，连续收涨的根数
  let rising = 0;
  for (let i = bars.length - 1; i >= 1; i--) {
    if (bars[i].p > bars[i - 1].p) rising++; else break;
  }
  if (rising < CFG.minRising) return { ok: false, reason: '连涨不足' };
  // 贴高点：现价距日内高点回落 ≤ offPeakMax%（防接冲高回落的顶）
  const peak = Math.max(...bars.map(b => b.p));
  const offPeak = (peak - last.p) / peak * 100;
  if (offPeak > CFG.offPeakMax) return { ok: false, reason: '冲高回落' };
  return { ok: true, rising, peak, openPct: +openPct.toFixed(2) };
}

// ---------- 落盘 ----------
function sigFile(day) { return path.join(DIR, 'samples', `morning_direct_${day}.json`); }
function loadSignals(day) {
  try { const j = JSON.parse(fs.readFileSync(sigFile(day), 'utf-8')); return Array.isArray(j) ? j : []; }
  catch (e) { return []; }
}
function saveSignals(day, sigs) {
  try { fs.writeFileSync(sigFile(day), JSON.stringify(sigs, null, 1)); } catch (e) {}
}

// ---------- 窗口状态（看板展示用） ----------
function windowStatus() {
  const now = new Date();
  const wd = now.getDay();
  if (wd < 1 || wd > 5) return 'off';
  const hm = now.getHours() * 100 + now.getMinutes();
  if (hm < CFG.windowStart) return 'pre';
  if (hm < CFG.windowEnd) return 'active';
  return 'post';
}

// ---------- 主流程：每 35 秒一趟 ----------
// state: { mdSignals: [], mdCodes: Set, buySignals: [] }（server.js 传入）
// opts: { force: 忽略窗口限制（测试用）, dryRun: 不写文件不推信号（测试用） }
let busy = false;
async function tick(state, opts = {}) {
  const now = new Date();
  const hm = now.getHours() * 100 + now.getMinutes();
  const day = todayStr();
  if (!opts.force && (hm < CFG.windowStart || hm >= CFG.windowEnd)) return { skip: '非窗口时段' };
  if (busy) return { skip: '上一轮未完成' };
  busy = true;
  try {
    const [rank, jjCodes] = await Promise.all([getMDRank(), loadJJPreCodes(day)]);
    const cand = new Map(); // code -> {src}
    for (const r of rank) {
      if (!/^30/.test(r.code)) continue;               // 只做 20cm（创业板）
      if (/ST|\u9000/.test(r.name)) continue;
      cand.set('sz' + r.code, { src: '涨幅榜' });
    }
    for (const c of jjCodes) { if (!cand.has(c)) cand.set(c, { src: '抢筹榜' }); }
    if (!cand.size) return { n: 0, msg: '无20cm候选' };

    const quotes = await getBatchQuote([...cand.keys()]);
    const hits = [];
    for (const [code, meta] of cand) {
      const q = quotes[code];
      if (!q || q.st || !q.prevClose) continue;
      const pct = (q.price / q.prevClose - 1) * 100;
      if (pct < CFG.pctMin || pct >= CFG.pctMax) continue;      // 直取窗口 2~5cm
      // 开盘即顶一字（开盘价≈20cm涨停价）买不进
      if (q.open > 0 && q.open >= q.prevClose * 1.2 * 0.998) continue;
      if (state.mdCodes && state.mdCodes.has(code)) continue;   // 每只每日一条
      const bars = await getMinute(code);
      if (!bars) continue;
      const chk = checkLaunch(bars, q.prevClose);
      if (!chk.ok) continue;
      hits.push({ code, q, pct, meta, bars, chk });
    }

    for (const h of hits) {
      const t = now.toLocaleTimeString('zh-CN', { hour12: false });
      const sig = {
        day, t, code: h.code, name: h.q.name,
        price: h.q.price, pct: +h.pct.toFixed(2),
        mode: '早盘直取', src: h.meta.src,
        bars: h.bars.length, rising: h.chk.rising, openPct: h.chk.openPct
      };
      if (opts.dryRun) { console.log(`[早盘直取·dryRun] ${sig.name}(${sig.code}) +${sig.pct}% ${sig.src} ${sig.bars}根/${sig.rising}连涨`); continue; }
      state.mdCodes.add(h.code);
      state.mdSignals.unshift(sig);
      // 推进 buySignals 统一展示（补齐渲染所需字段：报警=买点自身，无确认门）
      state.buySignals.unshift({
        t, code: h.code, name: h.q.name, price: h.q.price,
        mode: '早盘直取', confirmT: t, alertT: t, alertPrice: h.q.price,
        dropPct: 0, curPrice: h.q.price, entryPct: +h.pct.toFixed(2), pctVsAlert: 0
      });
      console.log(`[早盘直取] ${h.q.name}(${h.code}) +${h.pct.toFixed(2)}% @${h.q.price} ← ${h.meta.src} ${h.bars.length}根/${h.chk.rising}连涨`);
      // 9/4：触发即弹桌面气泡+提示音（此前只写看板，用户不看板就漏提醒）
      notify.send({ type: '早盘直取', code: h.code, name: h.q.name, text: `+${h.pct.toFixed(2)}% @${h.q.price} ${h.meta.src} 开盘+${h.chk.openPct}% ${h.bars.length}根/${h.chk.rising}连涨` });
      // 9/4：记入推荐跟踪表（推荐价 vs 现价对比；现价由 server 刷新循环每 45s 补齐）
      track.record({ type: '早盘直取', code: h.code, name: h.q.name, price: h.q.price, t, note: `开盘+${h.chk.openPct}% ${h.bars.length}根/${h.chk.rising}连涨 ${h.meta.src}` });
    }
    if (!opts.dryRun && hits.length) saveSignals(day, state.mdSignals);
    return { n: hits.length, candN: cand.size };
  } finally { busy = false; }
}

module.exports = { CFG, tick, loadSignals, saveSignals, windowStatus, checkLaunch };
