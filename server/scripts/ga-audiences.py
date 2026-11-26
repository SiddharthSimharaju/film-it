# Growth audiences, one extra custom dimension and the subscription key event for the Filmroom GA4 property. Safe to re-run (it skips what exists).
# Needs the Filmroom Google login first:  bash server/scripts/ga-login.sh      then:  python3 server/scripts/ga-audiences.py
# Audiences are not retroactive: each one starts counting people from the moment it is created.
import json, os, subprocess, urllib.request, urllib.error

env = dict(os.environ, CLOUDSDK_CONFIG=os.path.expanduser('~/.config/gcloud-filmroom'))
TOKEN = subprocess.run(['gcloud', 'auth', 'application-default', 'print-access-token'], env=env, capture_output=True, text=True).stdout.strip()
assert TOKEN, 'no token: run bash server/scripts/ga-login.sh first'
PROP = 'properties/565936259'                                  # the "Filmroom" property (stream G-NWXGNCWTV6, https://filmroom.in/)

def call(version, method, path, body=None):
    req = urllib.request.Request(f'https://analyticsadmin.googleapis.com/{version}/{PROP}{path}', method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + TOKEN, 'x-goog-user-project': 'filmroom-app-4919', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {'raw': raw[:200].decode(errors='replace')}

def msg(d): return (d.get('error') or {}).get('message', d)

# 1. an event-scoped "plan" so events (purchases, renewals, churn) can be split by plan (the user-scoped "plan" already exists)
s, d = call('v1beta', 'GET', '/customDimensions')
have = {(x['parameterName'], x['scope']) for x in d.get('customDimensions', [])}
if ('plan', 'EVENT') not in have:
    s, d = call('v1beta', 'POST', '/customDimensions', {'parameterName': 'plan', 'displayName': 'Plan on event', 'description': 'Plan on the event: purchase, subscription_started, subscription_renewed, subscription_churned, photo_downloaded', 'scope': 'EVENT'})
    print('dimension plan on event:', 'created' if s == 200 else f'FAILED {msg(d)}')
else: print('dimension plan on event: already exists')

# 2. subscription_started is the "became a paying subscriber" conversion
s, d = call('v1beta', 'GET', '/keyEvents'); have = {x['eventName'] for x in d.get('keyEvents', [])}
for ev in ['subscription_started']:
    if ev in have: print(f'key event {ev}: already exists'); continue
    s, d = call('v1beta', 'POST', '/keyEvents', {'eventName': ev, 'countingMethod': 'ONCE_PER_EVENT'}); print(f'key event {ev}:', 'created' if s == 200 else f'FAILED {msg(d)}')

# 3. audiences = "how many PEOPLE did X" (the people counts GA4 shows in Admin > Audiences and can use as report comparisons)
def ev(name): return {'eventFilter': {'eventName': name}}
AUD = [
    ('Signed up',                      'Created an account (sign_up)',                                      [('INCLUDE', ev('sign_up'))]),
    ('Activated: added a photo',       'Opened at least one photo in the editor (photo_added)',            [('INCLUDE', ev('photo_added'))]),
    ('Got value: downloaded a photo',  'Saved at least one edited photo (photo_downloaded)',               [('INCLUDE', ev('photo_downloaded'))]),
    ('Hit a paywall',                  'Ran into a Free limit or a Pro feature (paywall_shown)',           [('INCLUDE', ev('paywall_shown'))]),
    ('Viewed plans',                   'Opened the plans screen (view_item_list)',                         [('INCLUDE', ev('view_item_list'))]),
    ('Started checkout',               'Pressed Continue to payment (begin_checkout)',                     [('INCLUDE', ev('begin_checkout'))]),
    ('Paid customers',                 'Made at least one payment (purchase)',                             [('INCLUDE', ev('purchase'))]),
    ('Churned subscribers',            'A paid subscription of theirs ended (subscription_churned, sent by the server)', [('INCLUDE', ev('subscription_churned'))]),
    ('Active paying subscribers',      'Paid at least once and has not churned (purchase and not subscription_churned)', [('INCLUDE', ev('purchase')), ('EXCLUDE', ev('subscription_churned'))]),
]
s, d = call('v1alpha', 'GET', '/audiences'); have = {x.get('displayName') for x in d.get('audiences', [])}
for name, desc, clauses in AUD:
    if name in have: print(f'audience "{name}": already exists'); continue
    body = {'displayName': name, 'description': desc, 'membershipDurationDays': 540,
            'filterClauses': [{'clauseType': t, 'simpleFilter': {'scope': 'AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS', 'filterExpression': {'andGroup': {'filterExpressions': [{'orGroup': {'filterExpressions': [f]}}]}}}} for t, f in clauses]}
    s, d = call('v1alpha', 'POST', '/audiences', body); print(f'audience "{name}":', 'created' if s == 200 else f'FAILED {msg(d)}')

s, d = call('v1alpha', 'GET', '/audiences'); print('\naudiences on the property:', [x.get('displayName') for x in d.get('audiences', [])])
