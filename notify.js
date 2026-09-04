'use strict';
// notify.js —— 雷达桌面提醒（零 npm 依赖，9/4 江天型漏提醒事故驱动）
// 通道：notifu.exe（Win32 气泡，免 AUMID 注册，附系统提示音）
// 位置：vendor/notifu/notifu64.exe（x64）/ notifu.exe（x86）
// 用法：notify.send({ type:'早盘直取', code:'sz301171', name:'易点天下',
//                    text:'+4.76% @36.09 涨幅榜 3根/2连涨' })
// 策略：
//   ① 去重A：同 code+type 60s 内只弹一次（各模块本身已按票去重，双保险）
//   ② 去重B：同 code 20s 内已弹过任意类型则跳过（防"强势报警+直取"同秒连弹）
//   ③ 队列：FIFO + 800ms 间隔逐个弹，多票同秒触发不丢（只错开）
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = __dirname;
const NOTIFU = path.join(DIR, 'vendor', 'notifu', os.arch() === 'x64' ? 'notifu64.exe' : 'notifu.exe');
const LOG = path.join(DIR, 'logs', 'notify.log');

const seen = new Map();   // `${type}|${code}` -> lastTs
const codeTs = new Map(); // code -> lastTs（跨类型 20s 抑制）
const queue = [];
let busy = false;

function log(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`); } catch (_) {}
}

// 安全清洗：去掉可能破坏命令行参数的字符
function esc(s) {
  return String(s || '').replace(/[\r\n"'`]/g, '').slice(0, 120);
}

function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const { title, message, key } = queue.shift();
  const args = ['/t', 'info', '/p', title, '/m', message, '/d', '10000', '/w', '/e'];
  const child = spawn(NOTIFU, args, { windowsHide: true });
  child.on('error', e => { log(`notifu 拉起失败: ${e.message} | ${message}`); busy = false; pump(); });
  child.on('exit', c => {
    log(`notifu exit=${c} | ${key} | ${message}`);
    busy = false;
    setTimeout(pump, 800);   // 队列间隔，防多票同秒刷屏
  });
}

function send(opts = {}) {
  const type = opts.type || '雷达';
  const title = esc(opts.title || type);
  const name = esc(opts.name || '');
  const code = esc(opts.code || '');
  const message = `${name}${code ? '(' + code + ')' : ''} ${esc(opts.text || '')}`.trim();

  // ① 同 code+type 60s 去重
  const key = `${type}|${code}`;
  const now = Date.now();
  if (seen.has(key) && now - seen.get(key) < 60000) return;
  seen.set(key, now);
  if (seen.size > 200) {
    const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) seen.delete(oldest[0]);
  }
  // ② 同 code 20s 跨类型抑制（强势报警紧跟直取/低吸等只弹首个）
  if (code && codeTs.has(code) && now - codeTs.get(code) < 20000) return;
  if (code) codeTs.set(code, now);

  queue.push({ title, message, key });
  log(`queued: ${key} | ${message}`);
  pump();
}

module.exports = { send, log };
