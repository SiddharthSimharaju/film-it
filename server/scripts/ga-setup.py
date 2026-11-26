# One-time (and safe to re-run) setup of the Filmroom GA4 property: 14-month data retention, the custom dimensions that index.html sends, and the key events.
# Needs the Filmroom Google login first:  bash server/scripts/ga-login.sh      then:  python3 server/scripts/ga-setup.py
import json, os, subprocess, urllib.request, urllib.error

env = dict(os.environ, CLOUDSDK_CONFIG=os.path.expanduser('~/.config/gcloud-filmroom'))
TOKEN = subprocess.run(['gcloud', 'auth', 'application-default', 'print-access-token'], env=env, capture_output=True, text=True).stdout.strip()
assert TOKEN, 'no token'
BASE = 'https://analyticsadmin.googleapis.com/v1beta/properties/565936259'      # the "Filmroom" property (stream G-NWXGNCWTV6, https://filmroom.in/)

def call(method, path, body=None, mask=None):
    url = BASE + path + (f'?updateMask={mask}' if mask else '')
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': 'Bearer ' + TOKEN, 'x-goog-user-project': 'filmroom-app-4919', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except Exception: return e.code, {}

# 1. keep event data for 14 months (the default 2 months breaks funnels and trends)
s, d = call('PATCH', '/dataRetentionSettings', {'eventDataRetention': 'FOURTEEN_MONTHS'}, 'eventDataRetention')
print('retention ->', d.get('eventDataRetention') if s == 200 else f'FAILED {s} {d}')

# 2. custom dimensions: the event parameters / user property that index.html sends (so GA4 lets us report on them)
DIMS = [
    ('plan',      'USER',  'Plan',          'free, monthly, yearly or lifetime (user property)'),
    ('look',      'EVENT', 'Look',          'Film look id: look_selected, photo_downloaded'),
    ('reason',    'EVENT', 'Reason',        'Why the paywall appeared (paywall_shown) or an upload was refused (upload_rejected)'),
    ('format',    'EVENT', 'Format',        'File format of a download (photo_downloaded)'),
    ('signed_in', 'EVENT', 'Signed in',     'Whether the person was signed in when the paywall appeared'),
    ('locked',    'EVENT', 'Look locked',   'look_selected on a Pro look while on the Free plan'),
]
s, existing = call('GET', '/customDimensions')
have = {x['parameterName'] for x in existing.get('customDimensions', [])}
for name, scope, display, desc in DIMS:
    if name in have: print(f'dimension {name:10} already exists'); continue
    s, d = call('POST', '/customDimensions', {'parameterName': name, 'displayName': display, 'description': desc, 'scope': scope})
    print(f'dimension {name:10} {scope:5}', 'created' if s == 200 else f'FAILED {s} {d.get("error", {}).get("message", d)}')

# 3. key events (conversions): the steps that matter for the growth funnel (purchase is already one)
s, existing = call('GET', '/keyEvents')
have = {x['eventName'] for x in existing.get('keyEvents', [])}
for ev in ['sign_up', 'begin_checkout', 'photo_downloaded']:
    if ev in have: print(f'key event {ev:18} already exists'); continue
    s, d = call('POST', '/keyEvents', {'eventName': ev, 'countingMethod': 'ONCE_PER_EVENT'})
    print(f'key event {ev:18}', 'created' if s == 200 else f'FAILED {s} {d.get("error", {}).get("message", d)}')

# 4. read it all back
print('\n--- now on the property ---')
print('retention:', call('GET', '/dataRetentionSettings')[1].get('eventDataRetention'))
print('dimensions:', [(x['parameterName'], x['scope']) for x in call('GET', '/customDimensions')[1].get('customDimensions', [])])
print('key events:', [x['eventName'] for x in call('GET', '/keyEvents')[1].get('keyEvents', [])])
