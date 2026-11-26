// Switches the Filmroom API from Dodo TEST mode to LIVE mode. Run it yourself in a normal terminal (not through a chat):
//     cd server && node scripts/go-live.mjs
// Keys are typed at hidden prompts and go straight to Cloudflare as Worker secrets: never on a command line, never in a file, never in chat.
// Before you run it, in Dodo's LIVE dashboard: business verification approved, and an API key created (Developer -> API Keys).
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = path.join(root, 'wrangler.jsonc');
const WORKER = 'https://filmroom-api.siddharth-simharaju.workers.dev';

function ask(q, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => process.stdout.write(s.includes(q) || /^\r?\n$/.test(s) ? s : '*');
    rl.question(q, a => { rl.close(); resolve(a.trim()); });
  });
}
const run = (cmd, args, input, env = {}) => spawnSync(cmd, args, { cwd: root, input, encoding: 'utf8', env: { ...process.env, ...env } });
const die = m => { console.error('\nStopped: ' + m + '\nNothing was switched to live.'); process.exit(1); };

const health = async () => { try { return await (await fetch(WORKER + '/health')).json(); } catch { return null; } };
console.log('\n=== Filmroom: switch to LIVE payments ===\n');
const before = await health();
if (!before) die('the API is not reachable. Check your internet connection.');
if (before.mode === 'live_mode') die('the API is already in live mode.');
console.log('This makes filmroom.in take REAL money. Test purchases stop working.');
console.log('Existing test accounts and subscriptions stay in test mode and are not carried over.\n');
if ((await ask('Type  live  to continue: ')) !== 'live') die('cancelled.');

// 1. live API key -> live products
const apiKey = await ask('\nLIVE Dodo API key (hidden): ', true);
if (!apiKey) die('no key entered.');
if (/test/i.test(apiKey.slice(0, 12))) die('that looks like a TEST key. Create the key in the dashboard with the Test/Live switch on LIVE.');
console.log('\nCreating the three live products...');
const made = run('node', ['scripts/create-products.mjs'], undefined, { DODO_API_KEY: apiKey, DODO_ENV: 'live_mode' });
process.stdout.write((made.stdout || '').split('\n').filter(l => /^(found|created)/.test(l)).join('\n') + '\n');
const ids = Object.fromEntries(['MONTHLY', 'YEARLY', 'LIFETIME'].map(k => [k, ((made.stdout || '').match(new RegExp(`"PRODUCT_${k}": "(pdt_[A-Za-z0-9]+)"`)) || [])[1]]));
if (made.status !== 0 || Object.values(ids).some(v => !v)) die('could not create the products with that key:\n' + (made.stderr || made.stdout || '').split(apiKey).join('<key>').slice(-400));

// 2. live webhook
console.log(`
In Dodo's LIVE dashboard: Developer -> Webhooks -> Add endpoint
    URL:     ${WORKER}/webhooks/dodo
    Events:  payment.*, subscription.*, refund.*, dispute.*
Then open that endpoint and copy its Signing secret (starts with whsec_).`);
const whsec = await ask('\nLIVE webhook signing secret (hidden): ', true);
if (!/^whsec_[A-Za-z0-9+/=_-]{16,}$/.test(whsec)) die('that does not look like a webhook signing secret (it starts with whsec_).');

// 3. apply: config, secrets, deploy
const original = fs.readFileSync(cfgPath, 'utf8');
let cfg = original.replace(/"DODO_ENV": "test_mode"/, '"DODO_ENV": "live_mode"');
for (const [k, v] of Object.entries(ids)) cfg = cfg.replace(new RegExp(`("PRODUCT_${k}": ")pdt_[A-Za-z0-9]+(")`), `$1${v}$2`);
if (!cfg.includes('live_mode')) die('could not update wrangler.jsonc.');
console.log('\nStoring secrets and deploying...');
for (const [name, value] of [['DODO_API_KEY', apiKey], ['DODO_WEBHOOK_SECRET', whsec]]) {
  const r = run('npx', ['wrangler', 'secret', 'put', name], value);
  if (!/Success/.test(r.stdout + r.stderr)) die(`could not store ${name}.`);
  console.log(`  stored ${name}`);
}
fs.writeFileSync(cfgPath, cfg);
const dep = run('npx', ['wrangler', 'deploy']);
if (dep.status !== 0) { fs.writeFileSync(cfgPath, original); die('deploy failed; wrangler.jsonc restored.\n' + (dep.stderr || '').slice(-300) + '\n(Secrets were already replaced: restore test mode by re-running `wrangler secret put` with the test key and secret.)'); }

// 4. check
await new Promise(r => setTimeout(r, 3000));
const after = await health();
console.log(`\nAPI health: ${JSON.stringify(after)}`);
if (after && after.mode === 'live_mode') console.log('\nLIVE. Next: buy the cheapest plan yourself with a real card on https://filmroom.in, check the plan appears and the invoice downloads, then refund it in the Dodo dashboard.');
else console.log('\nThe API did not report live_mode. Do not announce anything yet; tell Claude what you see.');
