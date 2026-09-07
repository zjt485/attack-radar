# -*- coding: utf-8 -*-
"""backtest_zt_next.py —— 涨停榜"次日走强"因子回测（9/7 用户需求驱动）
数据边界：东财涨停池 API 仅保留近期历史，实测 20260818~20260907 可用（15 个交易日）
回测样本：8/18~9/4 的 14 个涨停日（9/7 无次日数据），每票用 mootdx 日K结算次日表现

次日表现口径（买入价 = 涨停日收盘价，即打板/排板成交假设）：
  d1o   次日开盘溢价%（竞价定调）
  d1hi  次日最高冲幅%（盘中卖点空间）
  d1c   次日收盘收益%（持有一天）
  lb1   次日是否连板（收盘再封）
  red   次日是否收红（d1c>0）

候选因子（全部来自涨停池自带字段，收盘即可算，无未来函数）：
  fbt   封板时间（越早越强？）        zbc  炸板次数（0=干净板）
  fund/ltsz 封单占流通市值比（承接力）  lbc  连板高度
  hs    换手率                        secN 同板块当日涨停家数（题材共振）
  zttj  几天几板（days/ct 节奏）       ltsz 流通市值
  amount 成交额
用法：python backtest_zt_next.py        # 首次约3-5分钟（拉K线），之后走缓存秒出
"""
import json, os, time, datetime, urllib.request, sys

DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_POOL = os.path.join(DIR, 'zt_pool_cache.json')
CACHE_K = os.path.join(DIR, 'zt_kline_cache.json')
OUT = os.path.join(DIR, 'backtest_zt_next_result.json')

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://quote.eastmoney.com/'}

# ---------- 1. 涨停池（带缓存） ----------
def fetch_pools():
    if os.path.exists(CACHE_POOL):
        return json.load(open(CACHE_POOL, encoding='utf-8'))
    days = []
    d = datetime.date(2026, 9, 7)
    for i in range(15):   # 8/18~9/7 窗口
        dd = d - datetime.timedelta(days=i)
        if dd.weekday() < 5:
            days.append(dd.strftime('%Y%m%d'))
    pools = {}
    for ds in sorted(days):
        url = ('https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989'
               f'&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt:asc&date={ds}')
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers=UA)
                j = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
                pool = (j.get('data') or {}).get('pool') or []
                pools[ds] = pool
                print(f'[pool] {ds}: {len(pool)} 只')
                break
            except Exception as e:
                print(f'[pool] {ds} 第{attempt+1}次失败: {e}')
                time.sleep(2)
        time.sleep(0.4)
    json.dump(pools, open(CACHE_POOL, 'w', encoding='utf-8'), ensure_ascii=False)
    return pools

# ---------- 2. 日K（mootdx，带缓存） ----------
def fetch_klines(codes):
    cache = {}
    if os.path.exists(CACHE_K):
        cache = json.load(open(CACHE_K, encoding='utf-8'))
    todo = [c for c in codes if c not in cache]
    if todo:
        from mootdx.quotes import Quotes
        client = Quotes.factory(market='std')
        print(f'[kline] 需拉 {len(todo)} 只（缓存已有 {len(cache)}）')
        for i, c in enumerate(todo):
            for attempt in range(2):
                try:
                    df = client.bars(symbol=c, frequency=9, offset=30)
                    if df is not None and len(df):
                        cache[c] = [[str(r['datetime'])[:10], float(r['open']), float(r['close']),
                                     float(r['low']), float(r['high'])] for _, r in df.iterrows()]
                        break
                except Exception:
                    time.sleep(1)
            if (i + 1) % 100 == 0:
                print(f'[kline] {i+1}/{len(todo)}')
                json.dump(cache, open(CACHE_K, 'w', encoding='utf-8'))
        json.dump(cache, open(CACHE_K, 'w', encoding='utf-8'))
    return cache

# ---------- 3. 结算 ----------
def limit_pct(code, name):
    if 'ST' in (name or ''): return 5.0
    if code.startswith(('30', '68')): return 20.0
    if code.startswith(('8', '4', '92')): return 30.0
    return 10.0

def settle(pools, klines):
    rows = []
    for ds, pool in sorted(pools.items()):
        fmt = f'{ds[:4]}-{ds[4:6]}-{ds[6:]}'
        # 当日板块共振计数
        sec_count = {}
        for p in pool:
            sec_count[p.get('hybk') or ''] = sec_count.get(p.get('hybk') or '', 0) + 1
        for p in pool:
            code = str(p['c']); name = p['n']
            k = klines.get(code)
            if not k: continue
            idx = next((i for i, b in enumerate(k) if b[0] == fmt), -1)
            if idx < 0 or idx + 1 >= len(k): continue   # 无次日（9/7 或 K线缺失）
            d0, d1 = k[idx], k[idx + 1]
            buy = d0[2]   # 涨停日收盘=买入价
            if buy <= 0: continue
            lp = limit_pct(code, name)
            lb1 = d1[2] >= buy * (1 + lp / 100) * 0.995   # 次日收盘再封（容0.5%误差）
            rows.append({
                'day': ds, 'code': code, 'name': name,
                'hybk': p.get('hybk') or '', 'secN': sec_count.get(p.get('hybk') or '', 0),
                'fbt': int(p.get('fbt') or 0), 'zbc': int(p.get('zbc') or 0),
                'fund': float(p.get('fund') or 0), 'ltsz': float(p.get('ltsz') or 0),
                'fundLtsz': round(float(p.get('fund') or 0) / float(p.get('ltsz') or 1) * 100, 3),
                'lbc': int(p.get('lbc') or 1), 'hs': float(p.get('hs') or 0),
                'amount': float(p.get('amount') or 0),
                'zttjDays': (p.get('zttj') or {}).get('days'), 'zttjCt': (p.get('zttj') or {}).get('ct'),
                'd1o': round((d1[1] / buy - 1) * 100, 2),
                'd1hi': round((d1[4] / buy - 1) * 100, 2),
                'd1c': round((d1[2] / buy - 1) * 100, 2),
                'd1lo': round((d1[3] / buy - 1) * 100, 2),
                'lb1': lb1, 'red': d1[2] > buy,
            })
    return rows

# ---------- 4. 分层统计 ----------
def layer(rows, key, bins, labels):
    print(f'\n===== 因子：{key} =====')
    print(f"{'分层':<18}{'n':>5}{'次开%':>8}{'开胜率':>7}{'冲高%':>8}{'次收%':>8}{'收红率':>7}{'连板率':>7}")
    out = []
    for lo, hi, lab in zip(bins[:-1], bins[1:], labels):
        g = [r for r in rows if r[key] is not None and lo <= r[key] < hi]
        if not g:
            print(f'{lab:<18}{0:>5}'); continue
        n = len(g)
        a = lambda k2: sum(r[k2] for r in g) / n
        row = dict(label=lab, n=n, d1o=round(a('d1o'), 2), openWin=round(sum(1 for r in g if r['d1o'] > 0) / n * 100),
                   d1hi=round(a('d1hi'), 2), d1c=round(a('d1c'), 2),
                   redRate=round(sum(1 for r in g if r['red']) / n * 100), lb1=round(sum(1 for r in g if r['lb1']) / n * 100))
        out.append(row)
        print(f"{lab:<18}{n:>5}{row['d1o']:>+8.2f}{row['openWin']:>6}%{row['d1hi']:>+8.2f}{row['d1c']:>+8.2f}{row['redRate']:>6}%{row['lb1']:>6}%")
    return out

def main():
    t0 = time.time()
    pools = fetch_pools()
    codes = sorted({str(p['c']) for pool in pools.values() for p in pool})
    print(f'[main] 涨停日 {len(pools)} 天，唯一票 {len(codes)} 只')
    klines = fetch_klines(codes)
    rows = settle(pools, klines)
    print(f'[main] 可结算样本 {len(rows)} 条（耗时 {time.time()-t0:.0f}s）')
    if not rows:
        print('无样本，退出'); sys.exit(1)

    # fbt 转小时数便于分层（92500 → 9.42）
    for r in rows:
        f = r['fbt']
        r['fbtH'] = round((f // 10000) + (f // 100 % 100) / 60 + (f % 100) / 3600, 2) if f else None

    result = {'n': len(rows), 'days': sorted(pools.keys()), 'layers': {}}
    result['layers']['fbtH'] = layer(rows, 'fbtH', [9, 9.55, 10.0, 10.5, 11.5, 13.5, 14.5, 15.1],
        ['竞价/秒板<9:33', '9:33-10:00', '10:00-10:30', '10:30-11:30', '11:30-13:30午', '13:30-14:30', '尾盘14:30+'])
    result['layers']['zbc'] = layer(rows, 'zbc', [0, 1, 2, 99], ['0炸(干净)', '1炸', '≥2炸'])
    result['layers']['fundLtsz'] = layer(rows, 'fundLtsz', [-1, 0.5, 1, 2, 5, 100],
        ['封单<0.5%流通', '0.5-1%', '1-2%', '2-5%', '≥5%'])
    result['layers']['lbc'] = layer(rows, 'lbc', [1, 2, 3, 4, 99], ['首板', '2连板', '3连板', '≥4连板'])
    result['layers']['hs'] = layer(rows, 'hs', [0, 3, 6, 10, 15, 25, 101],
        ['换手<3%', '3-6%', '6-10%', '10-15%', '15-25%', '≥25%'])
    result['layers']['secN'] = layer(rows, 'secN', [1, 2, 3, 5, 8, 999],
        ['板块仅1家', '2家', '3-4家', '5-7家', '≥8家'])
    result['layers']['ltsz'] = layer(rows, 'ltsz', [0, 2e9, 5e9, 1e10, 3e10, 1e14],
        ['流通<20亿', '20-50亿', '50-100亿', '100-300亿', '≥300亿'])

    json.dump({'meta': result, 'rows': rows}, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'\n[落盘] {OUT}')

if __name__ == '__main__':
    main()
