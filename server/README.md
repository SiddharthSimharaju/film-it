# Filmroom API

A Cloudflare Worker that owns **identity, plans, billing and the signed-in Free download count** for Filmroom. The page (`../index.html`) never decides who is Pro; it asks this API.

```
browser ──Bearer session──▶ Worker ──secret API key──▶ Dodo Payments
                              ▲   Durable Object per user: plan, payments, download count
                              │   KV: sessions, webhook de-duplication, customer→account index
Dodo ──signed webhook────────┘   (the ONLY thing that grants a plan)
```

| Route | What it does |
|---|---|
| `POST /auth/google` | Verifies a Google ID token, returns a session token and the account. |
| `GET /me`, `DELETE /me` | The account (plan, invoices, today's count). Delete is refused while a subscription is live. |
| `POST /checkout` | `{plan}` → a Dodo checkout URL. Product, price and customer come from the server, never the browser. |
| `POST /billing/cancel`, `/billing/resume` | Cancel at the end of the paid period, or undo it. |
| `POST /billing/portal` | A link to Dodo's customer portal (payment method, billing details). |
| `GET /billing/invoice/pay_…` | Dodo's PDF invoice, only for payments recorded on the caller's account. |
| `POST /usage/download` | `{n}` → counts Free downloads atomically; says no after 10 a day. |
| `POST /webhooks/dodo` | Dodo → us. Signature-verified, replay-protected, processed once per `webhook-id`. |

## One-time setup

You need a Cloudflare account (free tier is enough) and the Dodo **test-mode** API key.

```bash
cd server && npm install
npx wrangler login                               # opens a browser
npx wrangler kv namespace create FILMROOM_KV     # prints an id → paste it into wrangler.jsonc ("kv_namespaces")
npx wrangler secret put DODO_API_KEY             # paste the Dodo API key (Developer → API Keys). It is never written to a file.
npx wrangler deploy                              # prints https://filmroom-api.<your-subdomain>.workers.dev
```

Then:

1. **Webhook.** Dodo dashboard → *Developer → Webhooks* → add endpoint `https://filmroom-api.<your-subdomain>.workers.dev/webhooks/dodo`, subscribe to `payment.*`, `subscription.*`, `refund.*`, `dispute.*`. Copy its signing secret (`whsec_…`) and run `npx wrangler secret put DODO_WEBHOOK_SECRET`.
2. **Point the page at the API.** In `../index.html` replace `https://filmroom-api.REPLACE-ME.workers.dev` in `API_URL` with the real URL, run `python3 ../tools/update-csp.py` (it derives `connect-src` from `API_URL`), then commit and push.
3. **Google.** `https://filmroom.in` must be an authorised JavaScript origin of the OAuth client (it signs in from the page, not the API).

The API key needs these Dodo permissions: checkout sessions, subscriptions, payments, customers, invoices (read).

## Local development and tests

```bash
cp test/dev.vars.example .dev.vars     # fake key and secret, dev-only routes ON. Git-ignored; never deployed.
node test/mock-dodo.mjs &              # fake Dodo on :8799
npx wrangler dev --port 8787 &
npm test                               # 36 unit tests
node test/e2e-local.mjs                # 24 end-to-end checks (restart wrangler with a clean .wrangler/state to rerun)
```

The browser suite (`../tests/run.html`) uses the same processes; see the top-level README.

## Test mode → live mode

Everything that differs between modes is configuration. **Test and live are separate Dodo accounts' worth of data: products, API keys, webhooks and customers do not carry over.**

1. **Dodo:** finish business verification (KYC) and payout details in the dashboard. Live payments stay off until Dodo approves it. *Only you can do this.*
2. **Live products.** With a *live* API key: `DODO_API_KEY=<live key> DODO_ENV=live_mode node scripts/create-products.mjs`. It prints the three product ids.
3. **Live webhook.** In the live dashboard add the same `/webhooks/dodo` URL and copy that endpoint's own signing secret.
4. **Switch the Worker.** In `wrangler.jsonc` set `"DODO_ENV": "live_mode"` and the three live `PRODUCT_*` ids. Then:
   ```bash
   npx wrangler secret put DODO_API_KEY          # the LIVE key
   npx wrangler secret put DODO_WEBHOOK_SECRET   # the LIVE endpoint's secret
   npx wrangler deploy
   curl https://filmroom-api.<subdomain>.workers.dev/health    # must say "live_mode"
   ```
5. **Rehearse with real money, small.** Buy the cheapest plan yourself with a real card, confirm: checkout opens on `checkout.dodopayments.com`, you return to Filmroom, the "Confirming…" screen turns into your plan, the invoice downloads, *Manage billing* opens the portal. Then cancel, and refund the payment from the Dodo dashboard and confirm Pro is removed (Lifetime) or the subscription ends.
6. **Business details Dodo shows on invoices** (legal name, address, support email) are set in the Dodo dashboard, not here.

Rollback is the same switch in reverse: `"DODO_ENV": "test_mode"`, the test product ids, the test secrets, `wrangler deploy`.

## Operating notes

- **Logs:** `npx wrangler tail` shows each webhook outcome (`webhook subscription.active {...}`) and any failure. A webhook that can't be processed returns 500 so Dodo retries it; one that can't be matched to an account is parked in KV under `o:<id>` for 30 days.
- **Secrets never go in git.** `.dev.vars` is ignored. `wrangler.jsonc` holds only non-secret settings.
- **Rotating the Dodo webhook secret:** Dodo keeps the old one valid for 24 hours; `wrangler secret put DODO_WEBHOOK_SECRET` with the new one inside that window.
- **Plan prices** are in `../index.html` (`PLANS`, what is shown) and in the Dodo product (what is charged). Change both, in that order of care: Dodo decides the charge.
