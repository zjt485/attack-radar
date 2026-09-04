# -*- coding: utf-8 -*-
"""
jj_bridge.py —— 盘前竞价抢筹采集桥（mootdx → jj_pre.json）

背景：腾讯行情在 9:15-9:25 集合竞价段"今开"恒为 0，拿不到撮合价；
但通达信(mootdx) TCP 的 bid1 字段在竞价期 = 实时虚拟撮合价，
9:25 后 = 开盘价，且带匹配量(bid_vol1)。本脚本就是真正的"盘前抢筹数据源"。

流程（9:12-9:26）：
1. 建候选集：昨日涨停池(东财，回退找最近非空日) + 雷达自选 + 昨日雷达样本
2. 竞价段每 5 秒轮询 mootdx，记录各票 bid1/bid_vol1 轨迹
3. 9:25:30 后结算：撮合价高开幅度 + 9:20-9:25 不可撤单段价格趋势 + 匹配量 → 强度分
4. 写 jj_pre.json（雷达 9:25 首轮读取）

强度分口径（0-100）：
  gapScore  高开2~9%给30~70分（抢筹主区间），0~2%给0~15，>9%按过热降权
  trendScore 9:20-9:25 撮合价走势（涨=真抢筹/跌=假拉出货），±20分
  volScore  最终匹配量，0~20分（log10）
  一字板/ST/科创/薄匹配量直接剔除
"""
import json, os, re, sys, time, datetime, math

DIR = os.path.dirname(os.path.abspath(__file__))
PYLOG = os.path.join(DIR, 'logs', 'jj_bridge.log')
OUT = os.path.join(DIR, 'jj_pre.json')
WATCH = ['sz301122', 'sh603629', 'sh600869', 'sh600497', 'sz301217', 'sz300313']
SAMPLE_EVERY = 5          # 秒
START, END = '0915', '092530'

def log(msg):
    line = f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(PYLOG), exist_ok=True)
        with open(PYLOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass

def hm():
    return datetime.datetime.now().strftime('%H%M')

def today():
    return datetime.datetime.now().strftime('%Y%m%d')

import requests
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://quote.eastmoney.com/'}

def em_zt_pool(date):
    """东财涨停池（某交易日），返回 {code6: name}"""
    url = ('https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989'
           f'&dpt=wz.ztzt&Pageindex=0&pagesize=320&sort=fbt%3Aasc&date={date}')
    try:
        j = requests.get(url, headers=UA, timeout=8).json()
        pool = (j.get('data') or {}).get('pool') or []
        return {str(p['c']): p.get('n', '') for p in pool}
    except Exception as e:
        log(f'东财涨停池 {date} 失败: {e}')
        return {}

def last_trading_zt():
    """回退最多10天，找最近一个非空涨停池日（昨日涨停股=今日抢筹主力人群）"""
    d = datetime.date.today()
    for _ in range(10):
        d -= datetime.timedelta(days=1)
        if d.weekday() >= 5:
            continue
        pool = em_zt_pool(d.strftime('%Y%m%d'))
        if pool:
            log(f'昨日涨停池={d}，{len(pool)}只')
            return pool
    return {}

def sample_codes():
    """昨日雷达样本文件里的候选代码（取规则分前30）"""
    sdir = os.path.join(DIR, 'samples')
    if not os.path.isdir(sdir):
        return []
    files = sorted(f for f in os.listdir(sdir) if f.startswith('samples_'))
    if not files:
        return []
    try:
        rows = []
        with open(os.path.join(sdir, files[-1]), encoding='utf-8') as f:
            for line in f:
                try:
                    s = json.loads(line)
                    rows.append((s.get('rule', 0), s.get('code', '')))
                except Exception:
                    pass
        rows.sort(reverse=True)
        return [c for _, c in rows[:30] if c]
    except Exception:
        return []

def code6(prefixed):
    """sz301217 -> 301217"""
    return prefixed[2:] if prefixed[:2] in ('sz', 'sh', 'bj') else prefixed

def tencent_names(codes):
    """腾讯批量行情取名称（盘前名称字段可用）"""
    names = {}
    for i in range(0, len(codes), 60):
        batch = codes[i:i+60]
        try:
            r = requests.get('https://qt.gtimg.cn/q=' + ','.join(batch), timeout=6)
            for m in re.finditer(r'v_(\w+)="([^"]*)"', r.content.decode('gbk', 'ignore')):
                f = m.group(2).split('~')
                if len(f) > 1:
                    names[m.group(1)] = f[1]
        except Exception:
            pass
        time.sleep(0.3)
    return names

def limit_price(last_close, code6s, name):
    """涨跌停价（创业板/科创板20%，ST 5%，其余10%）"""
    pct = 0.20 if code6s.startswith(('300', '301', '302', '688', '689')) else (0.05 if 'ST' in name else 0.10)
    return round(last_close * (1 + pct), 2)

def strength_of(gap, trend, vol):
    """强度分（0-100）= 高开主区间分 + 9:20后趋势分 + 匹配量分"""
    if 2 <= gap <= 9:
        gap_score = 30 + 40 * (gap - 2) / 7
    elif 0 <= gap < 2:
        gap_score = 15 * gap / 2
    else:                                   # <0 或 9~11% 过热降权
        gap_score = max(0, 70 - (gap - 9) * 30) if gap > 9 else 0
    trend_score = max(-20, min(20, trend * 30))
    vol_score = min(20, math.log10(vol + 1) * 8)
    return round(min(100, gap_score + trend_score + vol_score), 1)

def main():
    log('=== jj_bridge 启动 ===')
    day = today()

    # 1. 候选集
    zt = last_trading_zt()
    codes = {}   # code6 -> name
    for c, n in zt.items():
        codes[c] = n
    for c in WATCH + sample_codes():
        c6 = code6(c)
        codes.setdefault(c6, '')
    codes = {c: n for c, n in codes.items() if c[:2] != '68'}   # 排科创
    log(f'候选集 {len(codes)} 只')
    if not codes:
        log('候选集为空，退出')
        return

    # 名称补齐（东财池里没名的走腾讯）
    missing = [c for c, n in codes.items() if not n]
    if missing:
        tn = tencent_names([('sh' if c.startswith(('6', '9', '5')) else 'sz') + c for c in missing])
        for c in missing:
            codes[c] = tn.get(('sh' if c.startswith(('6', '9', '5')) else 'sz') + c, '')

    # 2. 连接通达信
    # ★9/4 修复：原先 9:05 就连接、然后干等 10 分钟到 9:15——空闲连接被通达信
    #   服务端断开，进程静默死亡（无日志），当天竞价榜整体缺失。
    #   现在：空等期用短连接发心跳保活；9:15 前正式建轮询连接；轮询失败自动重连。
    from mootdx.quotes import Quotes

    def dial():
        return Quotes.factory(market='std')

    client = None
    clist = list(codes.keys())
    tracks = {c: [] for c in clist}   # code -> [(t, bid1, bid_vol1, last_close)]

    def poll_batch(batch):
        """单批轮询，失败重连重试一次；返回是否成功"""
        nonlocal client
        for attempt in range(2):
            try:
                if client is None:
                    client = dial()
                df = client.quotes(symbol=batch)
                if df is None:
                    raise RuntimeError('返回空')
                t = datetime.datetime.now().strftime('%H:%M:%S')
                for _, r in df.iterrows():
                    c = str(r['code'])
                    if c in tracks:
                        tracks[c].append((t, float(r['bid1']), int(r['bid_vol1']), float(r['last_close'])))
                return True
            except Exception as e:
                log(f'轮询批次失败(第{attempt + 1}次): {e}')
                client = None   # 丢弃可能已死的连接
        return False

    # 3. 竞价轮询：等到 9:15 开始（空等期每 2s 心跳，防空闲断连——9/4 事故修复）
    log(f'连接通达信成功（心跳保活模式），9:15 开始竞价轮询（每{SAMPLE_EVERY}s）')
    while hm() < START:
        try:
            if client is None:
                client = dial()
            client.quotes(symbol=[clist[0]])   # 心跳：单票小请求维持连接
        except Exception:
            client = None
        time.sleep(2)
    while hm() <= END:
        for i in range(0, len(clist), 80):
            poll_batch(clist[i:i + 80])
            time.sleep(0.2)
        time.sleep(SAMPLE_EVERY)
    log('竞价轮询结束，等待真实开盘（9:31+）')

    # 3.5 等 9:31 后拿真实开盘价——竞价虚拟撮合价与真实开盘可能差3个点
    #     （实证8/28：利通9:26虚拟价127.73/+2.0%，真实开盘124.00/-0.97%）
    #     9/4：空等期同样心跳保活（此前 5 分钟空闲也会断连）
    while hm() < '0931':
        try:
            if client is None:
                client = dial()
            client.quotes(symbol=[clist[0]])
        except Exception:
            client = None
        time.sleep(3)
    real_open = {}
    for i in range(0, len(clist), 80):
        batch = clist[i:i+80]
        for attempt in range(2):
            try:
                if client is None:
                    client = dial()
                df = client.quotes(symbol=batch)
                if df is None:
                    raise RuntimeError('返回空')
                for _, r in df.iterrows():
                    c = str(r['code'])
                    if float(r['open']) > 0:
                        real_open[c] = float(r['open'])
                break
            except Exception as e:
                log(f'开盘价批次失败(第{attempt + 1}次): {e}')
                client = None
        time.sleep(0.2)
    log(f'真实开盘价拿到 {len(real_open)} 只，开始结算')

    # 4. 结算（高开幅度用真实开盘；趋势/匹配量用竞价轨迹——这才是抢筹信号）
    rows = []
    for c, trk in tracks.items():
        trk = [x for x in trk if x[1] > 0 and x[3] > 0]
        if not trk:
            continue
        name = codes.get(c, '')
        if 'ST' in name or c.startswith('68'):
            continue
        open_p = real_open.get(c)
        if not open_p:
            continue
        last_close = trk[-1][3]
        gap = (open_p / last_close - 1) * 100             # 真实开盘高开
        jj_gap = (trk[-1][1] / last_close - 1) * 100      # 竞价虚拟撮合高开（对照参考）
        # 9:20-9:25 不可撤单段趋势
        win = [x for x in trk if '09:20' <= x[0] <= '09:26'] or trk
        trend = (win[-1][1] - win[0][1]) / last_close * 100 if len(win) > 1 else 0.0
        vol = trk[-1][2]                                  # 竞价最终匹配量（手）
        lp = limit_price(last_close, c, name)
        if abs(open_p - lp) < 0.005:                      # 一字板（按真实开盘判）
            continue
        if vol < 50:                                      # 匹配量太薄，无承接意义
            continue
        if gap < -1 or gap > 11:                          # 低开>1%无抢筹；>11%过热边缘
            continue
        strength = strength_of(gap, trend, vol)
        rows.append({
            'code': ('sh' if c.startswith(('6', '9', '5')) else 'sz') + c,
            'name': name, 'lastClose': round(last_close, 2), 'match': round(open_p, 2),
            'gap': round(gap, 2), 'jjGap': round(jj_gap, 2), 'trend': round(trend, 2),
            'matchVol': vol, 'strength': strength, 'samples': len(trk)
        })
    rows.sort(key=lambda x: -x['strength'])
    out = {'day': day, 'genT': datetime.datetime.now().strftime('%H:%M:%S'),
           'src': 'mootdx竞价', 'n': len(rows), 'rows': rows[:60]}
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    log(f'完成：{len(rows)}只写入 {OUT}，Top3 = ' +
        ' / '.join(f"{r['name']}({r['gap']:+.1f}%/强度{r['strength']})" for r in rows[:3]))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log(f'致命错误: {e}')
        sys.exit(1)
