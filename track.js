'use strict';
// track.js —— 推荐跟踪表（9/4 用户需求："推荐时的价格和现价都记录下来，有对比"）
// 记录每次推荐动作（早盘直取/强势报警/直取买点/买点确认/低吸买区）的触发价，
// 此后定时刷新这些票的现价，算出 chgPct（现价 vs 推荐价），供看板对比 & 收盘复盘。
//
// 数据落盘：samples/rec_track_YYYYMMDD.json（samples/ 已在 .gitignore，运行时数据不入库）
// 行结构：{ day, code, name, type, triggerT, triggerPrice, lastT, lastPrice, chgPct, note }
// 幂等：同 type|code 当日只记首次触发价（各信号本身已按票去重；重复 record 无害）
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
let day = '';
let rows = [];          // 数组保序；record 追加到尾部
const idx = new Map();  // `${type}|${code}` -> row 引用
let saveTimer = null;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function hhmmss(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
function file() { return path.join(DIR, 'samples', `rec_track_${day}.json`); }

function load(d) {
  day = d;
  rows = []; idx.clear();
  try {
    const arr = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    for (const r of arr) { rows.push(r); idx.set(`${r.type}|${r.code}`, r); }
  } catch (_) { /* 无今日文件 = 空表 */ }
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(path.join(DIR, 'samples'), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(rows, null, 1)); } catch (_) {}
  }, 800);
}

// 记录一条推荐（幂等：同 type|code 当日只保留首次触发价；name/note 若有则补齐）
function record({ type, code, name, price, t, note } = {}) {
  if (!code || !type) return;
  const key = `${type}|${code}`;
  let row = idx.get(key);
  const now = hhmmss();
  if (!row) {
    row = {
      day, code, name: name || '', type,
      triggerT: t || now, triggerPrice: isFinite(price) ? price : null,
      lastT: now, lastPrice: isFinite(price) ? price : null,   // 刷新前先顶到触发价（避免"现价待刷新"空窗）
      chgPct: 0, note: note || ''
    };
    rows.push(row);
    idx.set(key, row);
  } else {
    if (name && !row.name) row.name = name;
    if (note && !row.note) row.note = note;
  }
  save();
}

// 定时刷新现价（腾讯批量行情，GBK 解码，50 只一批）
function fetchUrl(url, timeout = 8000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' }, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(Buffer.alloc(0)));
    req.on('timeout', () => { req.destroy(); resolve(Buffer.alloc(0)); });
  });
}

async function refreshQuotes() {
  if (!rows.length) return {};
  const codes = [...new Set(rows.map(r => r.code))];
  const priceMap = {};
  for (let i = 0; i < codes.length; i += 50) {
    const chunk = codes.slice(i, i + 50);
    const buf = await fetchUrl('https://qt.gtimg.cn/q=' + chunk.join(','));
    if (!buf.length) continue;
    const txt = new TextDecoder('gbk').decode(buf);
    const re = /v_(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(txt))) {
      const f = m[2].split('~');
      if (f.length < 5) continue;
      const p = parseFloat(f[3]);
      if (isFinite(p)) priceMap[m[1]] = p;
    }
  }
  const now = hhmmss();
  let touched = false;
  for (const r of rows) {
    const p = priceMap[r.code];
    if (isFinite(p) && p > 0) {
      r.lastPrice = p; r.lastT = now; touched = true;
      r.chgPct = r.triggerPrice ? +((p / r.triggerPrice - 1) * 100).toFixed(2) : 0;
    }
  }
  if (touched) save();
  return priceMap;   // 供调用方（如 server 的买点信号卡）同步现价
}

// 看板/复盘用：新→旧排序
function list() { return [...rows].reverse(); }
function count() { return rows.length; }

module.exports = { load, record, refreshQuotes, list, count, _file: file, _day: () => day };
