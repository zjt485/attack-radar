'use strict';
// ============================================================================
// review.js —— 收盘自动复盘
// 输入：当日 samples.jsonl（每只候选股的最终快照：特征+概率+信号+评分时价格）
// 处理：补拉全天分时 → 算每只的真实结果 → 汇总命中率/平均涨幅/涨停率/最大回撤/校准误差/误判
// 输出：reviews/YYYYMMDD.json + reviews/report_YYYYMMDD.html
// ============================================================================
const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = __dirname;
const SAMPLES_DIR = path.join(DIR, 'samples');
const REVIEWS_DIR = path.join(DIR, 'reviews');

function samplesFile(dayStr) { return path.join(SAMPLES_DIR, `samples_${dayStr}.jsonl`); }

function fetchUrl(url, timeout = 8000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' }, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

// 拉全天分时（收盘后数据完整）
async function fetchDayBars(code) {
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
    return bars;
  } catch (e) { return null; }
}

function limitRatio(code, name) {
  if (/ST/.test(name || '')) return 0.05;
  if (/^(sz30|sh68)/.test(code)) return 0.20;
  return 0.10;
}

// ---------- 单只结果：全日结果 + 报警入场后的真实表现 ----------
// sample: {price, t, alertT?, alertPrice?, prevClose, code, name}
// 入场价 = 首次报警价（有报警时），否则用当日开盘价（衡量"全天持有"的盈亏）
function outcome(sample, bars) {
  const prevClose = sample.prevClose;
  const ratio = limitRatio(sample.code, sample.name);
  const lp = Math.round(prevClose * (1 + ratio) * 100) / 100;
  if (!bars.length) return null;
  const close = bars[bars.length - 1].p;
  // 全日极值与摸板
  let dayPeak = -Infinity, limitTouch = false;
  for (const b of bars) {
    if (b.p > dayPeak) dayPeak = b.p;
    if (b.p >= lp * 0.999) limitTouch = true;
  }
  const closePct = (close / prevClose - 1) * 100;
  // 入场点：有报警用报警价；无报警用开盘价（全天持有口径）
  const alerted = !!sample.alertT;
  const entry = alerted ? (sample.alertPrice || bars[0].p) : bars[0].p;
  const entryT = alerted ? sample.alertT : bars[0].t;
  const after = bars.filter(b => b.t >= entryT);
  let peak = entry, trough = entry;
  for (const b of after) { if (b.p > peak) peak = b.p; if (b.p < trough) trough = b.p; }
  return {
    closePct: +closePct.toFixed(2),
    maxGain: +(((peak - entry) / entry) * 100).toFixed(2),       // 入场后最大浮盈
    maxDrawdown: +(((trough - entry) / entry) * 100).toFixed(2), // 入场后最大回撤（负数）
    dayMaxGain: +(((dayPeak - prevClose) / prevClose) * 100).toFixed(2),
    limitTouch,                                                  // 全日是否摸到涨停
    closeLimit: close >= lp * 0.999,                             // 收盘是否封板
    alerted,
    hit: closePct >= 5 || limitTouch                             // "命中"=收涨≥5% 或全日摸板
  };
}

// ---------- 主复盘 ----------
async function runReview(dayStr) {
  if (!fs.existsSync(REVIEWS_DIR)) fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  const sf = samplesFile(dayStr);
  const lines = fs.existsSync(sf) ? fs.readFileSync(sf, 'utf-8').trim().split('\n') : [];
  const todaySamples = lines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(s => s && s.day === dayStr);
  if (!todaySamples.length) return { day: dayStr, error: '当日无样本' };

  // 每只取当天最后一次快照（最终形态）
  const byCode = {};
  for (const s of todaySamples) byCode[s.code] = s;
  const samples = Object.values(byCode).sort((a, b) => b.prob - a.prob);

  const rows = [];
  for (const s of samples) {
    const bars = await fetchDayBars(s.code);
    if (!bars) continue;
    const o = outcome(s, bars);
    if (!o) continue;
    rows.push(Object.assign({}, s, o));
  }
  if (!rows.length) return { day: dayStr, error: '分时数据拉取失败' };

  // ---------- 汇总指标 ----------
  const n = rows.length;
  const hits = rows.filter(r => r.hit).length;
  const limits = rows.filter(r => r.limitTouch).length;
  const avgClose = rows.reduce((s, r) => s + r.closePct, 0) / n;
  const avgMax = rows.reduce((s, r) => s + r.maxGain, 0) / n;
  const avgDD = rows.reduce((s, r) => s + r.maxDrawdown, 0) / n;
  // 校准误差：平均概率 vs 实际命中率（Brier 分数）
  const brier = rows.reduce((s, r) => s + Math.pow(r.prob - (r.hit ? 1 : 0), 2), 0) / n;
  const probMean = rows.reduce((s, r) => s + r.prob, 0) / n;
  const hitRate = hits / n;

  // 误判案例：高置信但结果差（假阳性）；低置信但大涨（漏报）
  const falsePos = rows.filter(r => r.prob >= 0.5 && r.closePct < 2).sort((a, b) => a.closePct - b.closePct);
  const misses = rows.filter(r => r.prob < 0.35 && r.closePct >= 8).sort((a, b) => b.closePct - a.closePct);

  const report = {
    day: dayStr, n, hits, limits,
    hitRate: +(hitRate * 100).toFixed(1),
    limitRate: +((limits / n) * 100).toFixed(1),
    avgClose: +avgClose.toFixed(2),
    avgMaxGain: +avgMax.toFixed(2),
    avgMaxDrawdown: +avgDD.toFixed(2),
    brier: +brier.toFixed(4),
    probMean: +probMean.toFixed(3),
    calibrationGap: +((probMean - hitRate) * 100).toFixed(1),
    falsePos: falsePos.slice(0, 8),
    misses: misses.slice(0, 8),
    rows: rows.map(r => ({
      code: r.code, name: r.name, t: r.t, price: r.price,
      prob: r.prob, conf: r.confidence, signals: r.signals, z: r.z,
      closePct: r.closePct, maxGain: r.maxGain, maxDrawdown: r.maxDrawdown,
      limitTouch: r.limitTouch, closeLimit: r.closeLimit, hit: r.hit
    }))
  };
  fs.writeFileSync(path.join(REVIEWS_DIR, `${dayStr}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(REVIEWS_DIR, `report_${dayStr}.html`), renderHTML(report));
  return report;
}

// ---------- HTML 报告 ----------
function renderHTML(rep) {
  const d = `${rep.day.slice(0,4)}-${rep.day.slice(4,6)}-${rep.day.slice(6)}`;
  const bar = (v, max, color) => `<span style="display:inline-block;height:10px;border-radius:5px;background:${color};width:${Math.min(100, Math.max(2, v / max * 100))}%;min-width:3px"></span>`;
  const rowHtml = rep.rows.map((r, i) => `
    <tr style="border-top:1px solid #eee">
      <td style="padding:6px 8px;color:#999">${i+1}</td>
      <td style="padding:6px 8px"><b>${r.name}</b><br><span style="color:#999;font-size:11px">${r.code}</span></td>
      <td style="padding:6px 8px;color:#666">${r.t}</td>
      <td style="padding:6px 8px"><b style="color:${r.prob>=0.6?'#d4380d':'#333'}">${(r.prob*100).toFixed(0)}%</b> ${bar(r.prob,1,'#fa8c16')}</td>
      <td style="padding:6px 8px;color:#666;font-size:12px">${(r.signals||[]).slice(0,3).join('·')||'-'}</td>
      <td style="padding:6px 8px;text-align:right;color:${r.closePct>=0?'#d4380d':'#389e0d'};font-weight:600">${r.closePct>0?'+':''}${r.closePct}%</td>
      <td style="padding:6px 8px;text-align:right;color:${r.maxGain>=0?'#d4380d':'#389e0d'}">${r.maxGain>0?'+':''}${r.maxGain}%</td>
      <td style="padding:6px 8px;text-align:right;color:#389e0d">${r.maxDrawdown}%</td>
      <td style="padding:6px 8px;text-align:center">${r.limitTouch?'<span style="background:#fff1f0;color:#d4380d;padding:1px 6px;border-radius:3px;font-size:11px">摸板</span>':''}${r.closeLimit?'<span style="background:#d4380d;color:#fff;padding:1px 6px;border-radius:3px;font-size:11px">封板</span>':''}${r.hit&&!r.limitTouch&&!r.closeLimit?'<span style="background:#f6ffed;color:#389e0d;padding:1px 6px;border-radius:3px;font-size:11px">命中</span>':''}</td>
    </tr>`).join('');
  const fpHtml = rep.falsePos.length ? rep.falsePos.map(r=>`<div style="padding:6px 0;border-top:1px dashed #eee"><b>${r.name}</b> 概率${(r.prob*100).toFixed(0)}% 实际收${r.closePct}% — 高置信误判，复盘其特征：${(r.signals||[]).join('·')||'无突出信号'}</div>`).join('') : '<div style="color:#389e0d;padding:6px 0">无高置信误判</div>';
  const missHtml = rep.misses.length ? rep.misses.map(r=>`<div style="padding:6px 0;border-top:1px dashed #eee"><b>${r.name}</b> 概率仅${(r.prob*100).toFixed(0)}% 实际收+${r.closePct}% — 漏报，待研究其特征缺口</div>`).join('') : '<div style="color:#999;padding:6px 0">无低置信大涨股（或该股不在样本内）</div>';
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>进攻雷达复盘 ${d}</title></head>
<body style="font-family:'PingFang SC','Microsoft YaHei',sans-serif;max-width:1000px;margin:20px auto;padding:0 16px;color:#222">
<h2 style="margin:0 0 4px">进攻分时雷达 · 每日复盘 ${d}</h2>
<div style="color:#888;font-size:13px">候选样本 ${rep.n} 只 · 命中口径：收涨≥5% 或盘中摸板 · 概率模型输出，自动迭代中</div>
<div style="display:flex;flex-wrap:wrap;gap:12px;margin:16px 0">
  ${[['命中率', rep.hitRate+'%', '#d4380d'],['涨停率', rep.limitRate+'%', '#722ed1'],['平均收盘涨幅', (rep.avgClose>0?'+':'')+rep.avgClose+'%', rep.avgClose>=0?'#d4380d':'#389e0d'],['平均最大浮盈', '+'+rep.avgMaxGain+'%', '#d4380d'],['平均最大回撤', rep.avgMaxDrawdown+'%', '#389e0d'],['Brier校准误差', rep.brier, '#1677ff'],['平均输出概率', (rep.probMean*100).toFixed(0)+'%', '#fa8c16']].map(x=>`<div style="flex:1;min-width:110px;background:#fafafa;border:1px solid #f0f0f0;border-radius:8px;padding:10px 14px"><div style="font-size:12px;color:#999">${x[0]}</div><div style="font-size:20px;font-weight:600;color:${x[2]}">${x[1]}</div></div>`).join('')}
</div>
${rep.calibrationGap > 10 ? `<div style="background:#fff7e6;border:1px solid #ffe7ba;padding:8px 12px;border-radius:6px;font-size:13px">校准提示：平均输出概率比实际命中率高 ${rep.calibrationGap} 个百分点，置信度偏乐观，迭代器将在样本累积后收紧。</div>` : ''}
<h3 style="margin:20px 0 8px">候选明细（按概率排序）</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px">
<thead><tr style="background:#fafafa;color:#666"><th style="padding:8px;text-align:left">#</th><th style="padding:8px;text-align:left">标的</th><th style="padding:8px;text-align:left">快照时刻</th><th style="padding:8px;text-align:left">涨停概率</th><th style="padding:8px;text-align:left">核心信号</th><th style="padding:8px;text-align:right">收盘涨幅</th><th style="padding:8px;text-align:right">最大浮盈</th><th style="padding:8px;text-align:right">最大回撤</th><th style="padding:8px;text-align:center">结果</th></tr></thead>
<tbody>${rowHtml}</tbody></table>
<h3 style="margin:24px 0 8px">误判案例（高置信 → 弱结果）</h3>${fpHtml}
<h3 style="margin:24px 0 8px">漏报案例（低置信 → 大涨）</h3>${missHtml}
<div style="margin-top:24px;color:#bbb;font-size:12px">进攻分时雷达 · 概率模型自动复盘 · 样本持续累积，参数随复盘迭代</div>
</body></html>`;
}

module.exports = { runReview, outcome, samplesFile, REVIEWS_DIR };
