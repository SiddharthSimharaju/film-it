# Gives the Worker permission to send subscription events (started, renewed, ended, refunded) to Google Analytics:
# creates (or reuses) a Measurement Protocol secret on the Filmroom stream and stores it as the Worker secret GA_API_SECRET WITHOUT ever printing it.
#
# FIRST, in Google Analytics (this is a legal statement only the property owner can make, so this script will not do it for you):
#   Admin -> Property settings -> Data collection and modification -> Data collection -> "User data collection acknowledgement" -> Acknowledge.
# Then:  bash server/scripts/ga-login.sh   (once)      python3 server/scripts/ga-mp-secret.py
import json, os, subprocess, sys, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__)); SERVER = os.path.dirname(HERE)
env = dict(os.environ, CLOUDSDK_CONFIG=os.path.expanduser('~/.config/gcloud-filmroom'))
TOKEN = subprocess.run(['gcloud', 'auth', 'application-default', 'print-access-token'], env=env, capture_output=True, text=True).stdout.strip()
assert TOKEN, 'no token: run bash server/scripts/ga-login.sh first'
PROP, MEASUREMENT_ID = 'properties/565936259', 'G-NWXGNCWTV6'

def call(method, path, body=None):
    req = urllib.request.Request(f'https://analyticsadmin.googleapis.com/v1beta/{PROP}{path}', method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + TOKEN, 'x-goog-user-project': 'filmroom-app-4919', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except Exception: return e.code, {}

s, d = call('GET', '/dataStreams')
stream = next(x for x in d['dataStreams'] if x.get('webStreamData', {}).get('measurementId') == MEASUREMENT_ID)
base = '/dataStreams/' + stream['name'].split('/')[-1] + '/measurementProtocolSecrets'
s, d = call('GET', base)
mine = [x for x in d.get('measurementProtocolSecrets', []) if x.get('displayName') == 'filmroom-api' and x.get('secretValue')]
if mine: secret = mine[0]['secretValue']; print('reusing the existing filmroom-api secret')
else:
    s, d = call('POST', base, {'displayName': 'filmroom-api'})
    if s != 200 or not d.get('secretValue'):
        msg = (d.get('error') or {}).get('message', d)
        sys.exit(f'Google refused: {msg}\n\nIf it mentions the "User Data Collection Acknowledgement", acknowledge it in Google Analytics first (see the top of this file).')
    secret = d['secretValue']; print('created the filmroom-api secret')
r = subprocess.run(['npx', 'wrangler', 'secret', 'put', 'GA_API_SECRET'], cwd=SERVER, input=secret, capture_output=True, text=True)
ok = 'Success' in (r.stdout + r.stderr)
print('stored as the Worker secret GA_API_SECRET:', 'ok' if ok else 'FAILED ' + (r.stderr or r.stdout)[-200:].replace(secret, '<value>'))
sys.exit(0 if ok else 1)
