# Registers what the page's usage events need in Google Analytics (property 565936259): the "signed in / guest" visitor dimension, the slider-control dimension, a
# "photos" metric (how many photos an upload or download covered) and audiences for the new events. Safe to re-run (it skips what exists).
# Needs the Filmroom Google login first:  bash server/scripts/ga-login.sh      then:  python3 server/scripts/ga-events-setup.py
import json, os, subprocess, urllib.request, urllib.error

env = dict(os.environ, CLOUDSDK_CONFIG=os.path.expanduser('~/.config/gcloud-filmroom'))
TOKEN = subprocess.run(['gcloud', 'auth', 'application-default', 'print-access-token'], env=env, capture_output=True, text=True).stdout.strip()
assert TOKEN, 'no token: run bash server/scripts/ga-login.sh first'
PROP = 'properties/565936259'

def call(version, method, path, body=None):
    req = urllib.request.Request(f'https://analyticsadmin.googleapis.com/{version}/{PROP}{path}', method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + TOKEN, 'x-goog-user-project': 'filmroom-app-4919', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {'raw': raw[:200].decode(errors='replace')}
msg = lambda d: (d.get('error') or {}).get('message', d)

# 1. custom dimensions (parameter name + scope must be unique; "signed_in" already exists at EVENT scope, this adds the VISITOR one)
s, d = call('v1beta', 'GET', '/customDimensions'); have = {(x['parameterName'], x['scope']) for x in d.get('customDimensions', [])}
for name, scope, display, desc in [
    ('signed_in', 'USER',  'Signed in visitor', 'yes when the visitor is signed in, no for a guest (set on every visit; split any report by it)'),
    ('control',   'EVENT', 'Slider control',    'Which control was used first in a visit: filter, grain, exposure, contrast, highlights, shadows (adjustment_used)'),
]:
    if (name, scope) in have: print(f'dimension {name} ({scope}): already exists'); continue
    s, d = call('v1beta', 'POST', '/customDimensions', {'parameterName': name, 'displayName': display, 'description': desc, 'scope': scope})
    print(f'dimension {name} ({scope}):', 'created' if s == 200 else f'FAILED {msg(d)}')

# 2. custom metric: how many photos an event covered (upload_multiple_images, download_multiple_images, ...). Sum it for "total photos uploaded / downloaded".
s, d = call('v1beta', 'GET', '/customMetrics'); have = {x['parameterName'] for x in d.get('customMetrics', [])}
if 'photos' in have: print('metric photos: already exists')
else:
    s, d = call('v1beta', 'POST', '/customMetrics', {'parameterName': 'photos', 'displayName': 'Photos in event', 'description': 'How many photos an upload or download event covered', 'scope': 'EVENT', 'measurementUnit': 'STANDARD'})
    print('metric photos:', 'created' if s == 200 else f'FAILED {msg(d)}')

# 3. audiences: people who did X (Admin > Audiences shows the count). Not retroactive.
def ev(name): return {'eventFilter': {'eventName': name}}
def user_prop(value, field): return {'dimensionOrMetricFilter': {'fieldName': field, 'stringFilter': {'matchType': 'EXACT', 'value': value}, 'atAnyPointInTime': True}}
def make(name, desc, clauses):
    return {'displayName': name, 'description': desc, 'membershipDurationDays': 540,
            'filterClauses': [{'clauseType': t, 'simpleFilter': {'scope': 'AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS',
                              'filterExpression': {'andGroup': {'filterExpressions': [{'orGroup': {'filterExpressions': f if isinstance(f, list) else [f]}}]}}}} for t, f in clauses]}
s, d = call('v1alpha', 'GET', '/audiences'); have = {x.get('displayName') for x in d.get('audiences', [])}
for name, desc, clauses in [
    ('Uploaded one image',        'Opened a single photo (upload_image)',                                         [('INCLUDE', ev('upload_image'))]),
    ('Uploaded multiple images',  'Opened several photos at once (upload_multiple_images)',                        [('INCLUDE', ev('upload_multiple_images'))]),
    ('Downloaded images',         'Saved at least one photo or a batch (download_image or download_multiple_images)', [('INCLUDE', [ev('download_image'), ev('download_multiple_images')])]),
]:
    if name in have: print(f'audience "{name}": already exists'); continue
    s, d = call('v1alpha', 'POST', '/audiences', make(name, desc, clauses)); print(f'audience "{name}":', 'created' if s == 200 else f'FAILED {msg(d)}')
for name, value, desc in [('Signed-in visitors', 'yes', 'Visitors who were signed in (user property signed_in = yes)'), ('Guests (not signed in)', 'no', 'Visitors who were not signed in (user property signed_in = no)')]:
    if name in have: print(f'audience "{name}": already exists'); continue
    for field in ('customUser:signed_in', 'signed_in'):                  # Google's docs are unclear on whether the scope prefix is expected, so try both
        s, d = call('v1alpha', 'POST', '/audiences', make(name, desc, [('INCLUDE', user_prop(value, field))]))
        if s == 200: print(f'audience "{name}": created (field {field})'); break
    else: print(f'audience "{name}": FAILED {msg(d)}')

s, d = call('v1beta', 'GET', '/customDimensions'); print('\ndimensions:', sorted((x['parameterName'], x['scope']) for x in d.get('customDimensions', [])))
s, d = call('v1beta', 'GET', '/customMetrics'); print('metrics:', [x['parameterName'] for x in d.get('customMetrics', [])])
s, d = call('v1alpha', 'GET', '/audiences'); print('audiences:', sorted(x.get('displayName') for x in d.get('audiences', [])))
