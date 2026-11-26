#!/usr/bin/env python3
"""Filmroom growth report straight from Google Analytics (property 565936259).

    python3 server/scripts/ga-growth.py                 # daily, last 30 days
    python3 server/scripts/ga-growth.py --by month      # monthly, last 12 months
    python3 server/scripts/ga-growth.py --days 7        # daily, last 7 days
    python3 server/scripts/ga-growth.py --funnels-only  # only the funnels

Needs the Filmroom Google login (bash server/scripts/ga-login.sh). Numbers are what GA4 can see: people who pressed "No thanks", ad blockers and
Do Not Track are missing, and subscription renewals/churn only appear once the Worker sends them (see docs/ANALYTICS.md). Dodo's dashboard is the
source of truth for money.
"""
import argparse, json, os, subprocess, urllib.request, urllib.error

ap = argparse.ArgumentParser(); ap.add_argument('--by', choices=['day', 'month'], default='day'); ap.add_argument('--days', type=int); ap.add_argument('--funnels-only', action='store_true')
a = ap.parse_args(); days = a.days or (365 if a.by == 'month' else 30)
env = dict(os.environ, CLOUDSDK_CONFIG=os.path.expanduser('~/.config/gcloud-filmroom'))
TOKEN = subprocess.run(['gcloud', 'auth', 'application-default', 'print-access-token'], env=env, capture_output=True, text=True).stdout.strip()
assert TOKEN, 'no token: run bash server/scripts/ga-login.sh first'
BASE = 'https://analyticsdata.googleapis.com'; PROP = 'properties/565936259'

def post(version, method, body):
    req = urllib.request.Request(f'{BASE}/{version}/{PROP}:{method}', method='POST', data=json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + TOKEN, 'x-goog-user-project': 'filmroom-app-4919', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return {'error': json.loads(e.read())['error']['message']}
        except Exception: return {'error': f'HTTP {e.code}'}

RANGE = [{'startDate': f'{days}daysAgo', 'endDate': 'today'}]
PERIOD = 'date' if a.by == 'day' else 'yearMonth'

# ---------- 1. metrics per day / month ----------
EVENTS = [('sign_up', 'Sign-ups'), ('photo_added', 'Used'), ('photo_downloaded', 'Saved'), ('paywall_shown', 'Paywall'), ('view_item_list', 'Plans'),
          ('begin_checkout', 'Checkout'), ('purchase', 'Payments'), ('subscription_started', 'New subs'), ('subscription_renewed', 'Renewals'),
          ('subscription_churned', 'Churned'), ('refund', 'Refunds')]
if not a.funnels_only:
    base = post('v1beta', 'runReport', {'dateRanges': RANGE, 'dimensions': [{'name': PERIOD}], 'metrics': [{'name': 'activeUsers'}, {'name': 'newUsers'}, {'name': 'sessions'}, {'name': 'purchaseRevenue'}], 'orderBys': [{'dimension': {'dimensionName': PERIOD}}]})
    ev = post('v1beta', 'runReport', {'dateRanges': RANGE, 'dimensions': [{'name': PERIOD}, {'name': 'eventName'}], 'metrics': [{'name': 'activeUsers'}],
          'dimensionFilter': {'filter': {'fieldName': 'eventName', 'inListFilter': {'values': [e for e, _ in EVENTS]}}}})
    for r in (base, ev):
        if 'error' in r: raise SystemExit('Google said: ' + r['error'])
    rows = {}
    for r in base.get('rows', []):
        k = r['dimensionValues'][0]['value']; m = [x['value'] for x in r['metricValues']]
        rows[k] = {'Visitors': int(m[0]), 'New': int(m[1]), 'Sessions': int(m[2]), 'Revenue': float(m[3])}
    for r in ev.get('rows', []):
        k, name = (x['value'] for x in r['dimensionValues']); rows.setdefault(k, {})[name] = int(r['metricValues'][0]['value'])
    cols = ['Visitors', 'New', 'Sessions'] + [lbl for _, lbl in EVENTS] + ['Revenue']; names = {lbl: e for e, lbl in EVENTS}
    fmt = lambda k: (f'{k[:4]}-{k[4:6]}-{k[6:]}' if len(k) == 8 else f'{k[:4]}-{k[4:]}')
    print(f'\nGROWTH, {"daily" if a.by == "day" else "monthly"} (people, i.e. active users who did it; Revenue in INR)\n')
    print('Period'.ljust(11) + ''.join(c.rjust(10) for c in cols))
    tot = {c: 0 for c in cols}
    for k in sorted(rows):
        r = rows[k]; print(fmt(k).ljust(11) + ''.join((f'{r.get(c, 0):,.0f}' if c == 'Revenue' else str(r.get(c, 0))).rjust(10) for c in cols))
        for c in cols: tot[c] += r.get(c, 0)
    print('-' * (11 + 10 * len(cols))); print('Total'.ljust(11) + ''.join((f'{tot[c]:,.0f}' if c == 'Revenue' else str(tot[c])).rjust(10) for c in cols))
    print('\n(Used = people who opened a photo. Saved = saved a photo. New subs / Renewals / Churned come from the server, for visitors who accepted analytics.)')

# ---------- 1b. every event: how many times (NOT unique) vs how many different people (UNIQUE), and signed-in vs guests ----------
if not a.funnels_only:
    ev_all = post('v1beta', 'runReport', {'dateRanges': RANGE, 'dimensions': [{'name': 'eventName'}], 'metrics': [{'name': 'eventCount'}, {'name': 'totalUsers'}],
          'orderBys': [{'metric': {'metricName': 'eventCount'}, 'desc': True}], 'limit': 40})
    print(f'\nEVENTS, last {days} days: "Events" counts every time it happened (not unique); "People" counts each person once (unique)\n')
    if 'error' in ev_all: print('   Google said:', ev_all['error'])
    elif not ev_all.get('rows'): print('   (no data in this period yet)')
    else:
        print('   ' + 'Event'.ljust(28) + 'Events'.rjust(9) + 'People'.rjust(9) + 'Per person'.rjust(12))
        for r in ev_all['rows']:
            n, (cnt, ppl) = r['dimensionValues'][0]['value'], (int(x['value']) for x in r['metricValues'])
            print('   ' + n.ljust(28) + f'{cnt:>9}{ppl:>9}' + (f'{cnt / ppl:.1f}' if ppl else '-').rjust(12))
    KEY = ['upload_image', 'upload_multiple_images', 'download_image', 'download_multiple_images', 'sign_up', 'login', 'sign_out', 'paywall_shown', 'begin_checkout', 'purchase']
    split = post('v1beta', 'runReport', {'dateRanges': RANGE, 'dimensions': [{'name': 'eventName'}, {'name': 'customUser:signed_in'}], 'metrics': [{'name': 'eventCount'}, {'name': 'totalUsers'}],
          'dimensionFilter': {'filter': {'fieldName': 'eventName', 'inListFilter': {'values': KEY}}}, 'orderBys': [{'dimension': {'dimensionName': 'eventName'}}]})
    print('\nSIGNED IN vs GUESTS (from the "signed in visitor" property; starts counting once the page sends it)\n')
    if 'error' in split: print('   Google said:', split['error'])
    elif not split.get('rows'): print('   (no data yet: the property is new, check back after a day of traffic)')
    else:
        print('   ' + 'Event'.ljust(28) + 'Signed in?'.ljust(12) + 'Events'.rjust(9) + 'People'.rjust(9))
        for r in split['rows']:
            n, who = (x['value'] for x in r['dimensionValues']); cnt, ppl = (int(x['value']) for x in r['metricValues'])
            print('   ' + n.ljust(28) + {'yes': 'signed in', 'no': 'guest'}.get(who, who or '(not set)').ljust(12) + f'{cnt:>9}{ppl:>9}')

# ---------- 2. funnels ----------
def funnel(title, steps, note=''):
    body = {'dateRanges': RANGE, 'funnel': {'isOpenFunnel': True, 'steps': [{'name': n, 'filterExpression': {'funnelEventFilter': {'eventName': e}}} for n, e in steps]}}
    r = post('v1alpha', 'runFunnelReport', body)
    print(f'\n{title}' + (f'   {note}' if note else ''))
    if 'error' in r: print('   Google said:', r['error']); return
    vis = (r.get('funnelTable') or {}).get('rows', [])
    if not vis: print('   (no data in this period yet)'); return
    top = None
    print('   ' + 'Step'.ljust(30) + 'People'.rjust(8) + 'of landed'.rjust(11) + 'of prev step'.rjust(14))
    prev = None
    for (n, _), row in zip(steps, vis):
        v = int(row['metricValues'][0]['value']); top = top if top is not None else v
        pct = lambda x, y: (f'{100 * x / y:.1f}%' if y else '–')
        print('   ' + n.ljust(30) + f'{v:>8}' + pct(v, top).rjust(11) + pct(v, prev).rjust(14)); prev = v

print(f'\nFUNNELS, last {days} days (open funnels: people can enter at any step)')
funnel('1. Growth: landing -> using -> converting', [('Landed on the site', 'page_view'), ('Used it: opened a photo', 'photo_added'), ('Got value: saved a photo', 'photo_downloaded'),
       ('Hit a paywall', 'paywall_shown'), ('Viewed plans', 'view_item_list'), ('Started checkout', 'begin_checkout'), ('Paid', 'purchase')])
funnel('2. Sign-up: landing -> account -> paying', [('Landed on the site', 'page_view'), ('Signed up', 'sign_up'), ('Started checkout', 'begin_checkout'), ('Paid', 'purchase')])
funnel('3. Retention of paid customers', [('Started a subscription', 'subscription_started'), ('Renewed', 'subscription_renewed'), ('Churned', 'subscription_churned')], '(server events)')
print()
