'use strict';
// 进攻分时评分引擎
// 模板来源：天山生物 8/24 分时（高开+4.45% → 巨量洗盘不破前低 → V型收复竞价价 → 低点抬高 → 缩量整理放量上攻 → 早盘封板）
//
// 输入:
//   bars: [{t:'0930', p:13.37, v:7813}] 升序，p=该分钟价，v=该分钟成交量(手)，要求已含竞价首笔
//   ctx:  {prevClose, prevLow|null}
// 输出:
//   {score:0-100, level:'强势'|'关注'|'无', tags:[], d:{细项}}
//
// 六个维度（满分100）:
//   gap     10  竞价高开幅度（+2%~+8% 最佳区）
//   wash    20  开盘洗盘深度 + 洗盘量能
//   defend  20  关键防守：洗盘低点不破前一日低点（一票否决项）
//   recover 20  V型收复竞价价的速度
//   swing   15  洗盘后摆动低点依次抬高（重心）
//   vol     15  量结构：整理缩量 + 上攻放量
//
// 量价配合奖励分（最高 +20，8/27 新增，天山/利通真实分时校准，总分封顶100）:
//   刻画"量化拉升"微观结构——程序化资金攻击在分时上留下四类指纹：
//   A 放量脉冲   5  攻击段出现≥2次"量≥2.5倍近10根均量且价上行"的脉冲单（大单点火）
//   B 脉冲递升   5  脉冲价依次抬高≥3级（波浪式上攻；反例利通5个脉冲但先砸后拉=递升链断裂）
//   C 脉冲后守稳 5  最后一次脉冲后5根以上不回吐>0.5%（算法托盘锁仓，非拉高出货）
//   D 量价同步   5  近20根上涨分钟带量比例≥55%（涨放量跌缩量的健康结构）
//   否决项对 基础分+奖励分 一并封顶，烂结构拿不到奖励分
//   注：曾考虑"整点/半点发动"（量化定时触发假设），实测两样本0命中，弃用
//
// 否决/降档规则:
//   - 洗盘破前低 >3% → 总分封顶 40
//   - 现价已翻绿 → 总分封顶 50
//   - 洗盘后创出新低 → 总分封顶 45
//   - 收复竞价价后不足 8 根K线 → 总分封顶 75（量结构未确认）

const W = { gap: 10, wash: 20, defend: 20, recover: 20, swing: 15, vol: 15 };
const WVP = { pulse: 5, chain: 5, hold: 5, sync: 5 };

function scoreAttack(bars, ctx) {
  const tags = [];
  if (!bars || bars.length < 15 || !ctx || !ctx.prevClose) {
    return { score: 0, level: '无', tags: ['数据不足'], d: {} };
  }
  const open = bars[0].p;
  const gap = open / ctx.prevClose - 1;

  // 1) 竞价高开区域
  let sGap;
  if (gap >= 0.02 && gap <= 0.08) sGap = W.gap;
  else if (gap >= 0.005 && gap <= 0.10) sGap = 6;
  else sGap = 2;

  // 2) 洗盘：前 20 分钟内的最低点
  const scanN = Math.min(20, bars.length);
  let washIdx = 0;
  for (let i = 1; i < scanN; i++) if (bars[i].p < bars[washIdx].p) washIdx = i;
  const washLow = bars[washIdx].p;
  const washDepth = (open - washLow) / open;
  const avgVol = bars.reduce((a, b) => a + b.v, 0) / bars.length;
  const washVol = Math.max(...bars.slice(0, Math.min(washIdx + 3, 12)).map(b => b.v));
  const washRatio = avgVol > 0 ? washVol / avgVol : 0;
  let sWash;
  if (washDepth >= 0.03 && washRatio >= 3) { sWash = W.wash; tags.push('深洗盘+巨量承接'); }
  else if (washDepth >= 0.03 && washRatio >= 2) sWash = 14;
  else if (washDepth >= 0.02) sWash = 8;
  else { sWash = 6; tags.push('无洗盘直拉型'); }

  // 3) 关键防守（一票否决项）
  let sDef, broken = false;
  if (ctx.prevLow == null) { sDef = 12; tags.push('无前日参照'); }
  else if (washLow >= ctx.prevLow * 0.99) { sDef = W.defend; tags.push('防守位保住'); }
  else { broken = true; sDef = washLow >= ctx.prevLow * 0.97 ? 8 : 0; tags.push('防守位被破'); }

  // 4) V型收复竞价价
  let recIdx = -1;
  for (let i = washIdx + 1; i < bars.length; i++) if (bars[i].p >= open) { recIdx = i; break; }
  let sRec = 0, recoverMin = null;
  if (recIdx > 0) {
    const dt = recIdx - washIdx;
    recoverMin = dt;
    sRec = dt <= 15 ? W.recover : dt <= 25 ? 14 : dt <= 40 ? 8 : 4;
    if (washDepth < 0.015) sRec = Math.min(sRec, 8); // 没出现真洗盘时收复分不算数
  }

  // 5) 摆动低点抬高（窗口±2 局部极小，贪心升序链）
  const lows = [];
  for (let i = washIdx; i < bars.length; i++) {
    const lo = Math.max(0, i - 2), hi = Math.min(bars.length - 1, i + 2);
    let isMin = true;
    for (let j = lo; j <= hi; j++) if (bars[j].p < bars[i].p) { isMin = false; break; }
    if (isMin) lows.push(bars[i].p);
  }
  const chain = lows.length ? [lows[0]] : [washLow];
  for (const p of lows) if (p > chain[chain.length - 1] * 1.002) chain.push(p);
  const sSwing = chain.length >= 3 ? W.swing : chain.length === 2 ? 8 : 0;

  // 6) 量结构：收复后前半段缩量 / 后半段放量
  let sVol = 0;
  if (recIdx > 0 && bars.length - recIdx >= 8) {
    const post = bars.slice(recIdx);
    const half = Math.floor(post.length / 2);
    const avg = arr => arr.reduce((x, y) => x + y.v, 0) / arr.length;
    const consA = avg(post.slice(0, half)), recA = avg(post.slice(half));
    const shrink = consA < washVol * 0.5;
    const expand = recA > consA * 1.3;
    sVol = (shrink && expand) ? W.vol : (shrink || expand) ? 8 : 2;
    if (shrink) tags.push('整理缩量');
    if (expand) tags.push('上攻放量');
  } else if (recIdx > 0) tags.push('量结构待确认');

  // 7) 量价配合奖励分：刻画"量化拉升"的微观指纹（8/27 新增）
  // 7a) 放量脉冲：量≥2.5倍近10根均量 且 价格上行 = 大单点火
  const pulses = [];
  for (let i = 5; i < bars.length; i++) {
    const win = bars.slice(Math.max(0, i - 10), i);
    if (win.length < 5) continue;
    const avg = win.reduce((s, b) => s + b.v, 0) / win.length;
    if (avg > 0 && bars[i].v >= avg * 2.5 && bars[i].p > bars[i - 1].p) pulses.push(i);
  }
  const sPulse = pulses.length >= 2 ? WVP.pulse : 0;
  if (sPulse) tags.push(`放量脉冲×${pulses.length}`);

  // 7b) 脉冲递升：脉冲价依次抬高≥3级 = 波浪式上攻（反例：先砸后拉的乱脉冲不算）
  let pulseChain = 0;
  if (pulses.length) {
    pulseChain = 1;
    let chainEnd = bars[pulses[0]].p;
    for (let k = 1; k < pulses.length; k++) {
      const pp = bars[pulses[k]].p;
      if (pp > chainEnd * 1.002) { pulseChain++; chainEnd = pp; }
    }
  }
  const sChain = pulseChain >= 3 ? WVP.chain : pulseChain === 2 ? 3 : 0;
  if (pulseChain >= 3) tags.push('脉冲递升');

  // 7c) 脉冲后守稳：最后一次脉冲后≥5根不回吐>0.5% = 算法托盘，非拉高出货
  let sHold = 0;
  if (pulses.length) {
    const li = pulses[pulses.length - 1];
    if (bars.length - li >= 5) {
      const lp = bars[li].p;
      const afterMin = Math.min(...bars.slice(li + 1).map(b => b.p));
      if (afterMin >= lp * 0.995) { sHold = WVP.hold; tags.push('脉冲后守稳'); }
    }
  }

  // 7d) 量价同步：近20根上涨分钟带量比例 = 涨放量/跌缩量的健康结构
  const tail = Math.min(20, bars.length - 1);
  const tailBars = bars.slice(bars.length - tail);
  const tailAvg = tailBars.reduce((s, b) => s + b.v, 0) / tailBars.length;
  let upCnt = 0, upWithVol = 0;
  for (let i = bars.length - tail; i < bars.length; i++) {
    if (bars[i].p > bars[i - 1].p) { upCnt++; if (bars[i].v > tailAvg) upWithVol++; }
  }
  const syncRate = upCnt > 0 ? upWithVol / upCnt : 0;
  const sSync = upCnt >= 8 ? (syncRate >= 0.55 ? WVP.sync : syncRate >= 0.4 ? 3 : 0) : 0;
  if (sSync >= WVP.sync) tags.push('量价同步');

  const vp = sPulse + sChain + sHold + sSync;
  if (vp >= 15) tags.push('量化攻击结构');

  let score = sGap + sWash + sDef + sRec + sSwing + sVol + vp;
  const last = bars[bars.length - 1].p;
  const pct = last / ctx.prevClose - 1;

  // 否决/降档（对基础分+奖励分一并生效）
  if (pct < 0) { score = Math.min(score, 50); tags.push('已翻绿'); }
  if (last < washLow * 0.999) { score = Math.min(score, 45); tags.push('洗盘后创新低'); }
  if (broken) score = Math.min(score, 40);
  if (recIdx > 0 && bars.length - recIdx < 8) score = Math.min(score, 75);

  score = Math.round(Math.min(score, 100));
  const level = score >= 80 ? '强势' : score >= 60 ? '关注' : '无';
  return {
    score, level, tags,
    d: {
      gap: +(gap * 100).toFixed(2), washDepth: +(washDepth * 100).toFixed(2),
      washRatio: +washRatio.toFixed(1), recoverMin, swingChain: chain.length,
      pct: +(pct * 100).toFixed(2), sGap, sWash, sDef, sRec, sSwing, sVol,
      vp, sPulse, sChain, sHold, sSync, pulses: pulses.length
    }
  };
}

module.exports = { scoreAttack };
