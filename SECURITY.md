# Security: VAPT and IV&V report

Scope: the Filmroom web app (`index.html`), its vendored libraries, the sandboxed HEIC converter, the GitHub repo and the GitHub Pages hosting. Tested: 22 Nov 2026, against the app as it ran locally and the live Pages headers.

## What the system is (this decides everything below)

Filmroom is a **static, client-side app** (photos are processed in the browser and never uploaded) plus a **small API** (`server/`, a Cloudflare Worker) that owns identity, plans, billing and the signed-in Free download count. Payments are taken by Dodo Payments; the API creates the checkout and receives Dodo's signed webhook. The first version of this report (22 Nov 2026) was written before the API existed; sections 1 to 3 keep that history and section 4 says what changed.

Anything the **page** enforces (per-file limits, export size, formats, guest limits) runs on the user's own machine, so a determined user can bypass it. Anything the **server** enforces (who is Pro, the signed-in daily count, billing) they cannot. Section 4 lists exactly which is which.

## 1. Findings (VAPT)

I attacked the app the way a hostile user would (console, edited storage, malicious files, hostile pages) and reviewed the repo and hosting. Severity is for a product that charges money.

| ID | Severity | Finding | Status |
|---|---|---|---|
| V-01 | **Critical (by design)** | Plans, quotas and "Pro" are client-side only. Verified bypasses: setting the plan variable in the console, forging the saved account in `localStorage`, calling the purchase function directly, winding the clock back far enough. A forged Google token would also be accepted once real sign-in is connected, because nothing verifies it. | **Open. Needs a server (section 3).** Hardened: stored data is validated, one shared counter, rollback of up to 2 days blocked. |
| V-02 | High | The Pro look files (`luts/*.png`) are plain public files, served with `access-control-allow-origin: *`. Anyone can download them without an account. (They are also CC BY-SA community files, so they were never secret.) | **Open.** Needs your own paid looks, served only to entitled sessions. |
| V-03 | High | **Clickjacking:** any website could embed the app invisibly and trick clicks (sign-in, and later payment buttons). | **Fixed.** The page stays hidden unless it is the top window or framed by its own origin. Re-tested with a hostile page: blank. |
| V-04 | Medium | No Content-Security-Policy or other security headers (GitHub Pages cannot set headers). | **Fixed in the page:** hash-based CSP (no `unsafe-inline` or `unsafe-eval` for scripts), `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `strict-origin` referrer. *Residual:* no `frame-ancestors`, `X-Frame-Options` or `X-Content-Type-Options`, because those need response headers. |
| V-05 | Medium | Third-party scripts (heic2any, UTIF) were loaded from a CDN with no integrity check: a compromised CDN could run code in the app. | **Fixed.** Both are vendored in `vendor/` and pinned by SHA-384 (checked by a test). |
| V-06 | Medium | heic2any needs `eval`, which would force `unsafe-eval` onto the whole page. | **Fixed.** It runs in an `<iframe sandbox="allow-scripts">` with its own page and policy: it cannot read the app's storage, accounts or DOM, and the app only accepts its two message types. |
| V-07 | Medium | Editing saved data could crash the app (unknown plan, invoices as text, `__proto__`/`constructor` as an account id) or freeze it (a renewal date of `-1e300` ran the renewal loop for ages). | **Fixed.** Saved data is rebuilt field by field, ids are validated, storage uses a prototype-less map, renewal catch-up is arithmetic and capped. |
| V-08 | Medium | **Resource exhaustion:** a 186 KB PNG decoded to 196 megapixels (about 12 s and gigabytes of memory). 150 files were accepted at once. No limits existed. | **Fixed.** Per-plan file size, megapixel and photo limits, hard ceilings, header checks before decoding, decode timeouts, aspect-ratio cap, ZIP size cap. |
| V-09 | Medium (bug) | The first photo skipped the GPU size clamp, so images wider than 16384 px rendered broken. Found while testing V-08. | **Fixed.** |
| V-10 | Low | File names went into download and ZIP entry names unchanged (`<`, `>`, `"`, path characters): a "zip-slip" risk for whoever extracts. | **Fixed.** Names are sanitised. |
| V-11 | Low | The avatar accepted any URL (`javascript:`, tracking hosts). | **Fixed.** Only `https` on `googleusercontent.com`. |
| V-12 | Low | A newline in a display name could forge lines in a receipt. | **Fixed.** Control characters are stripped. |
| V-13 | Low (privacy) | **All 16 public commits carry your work email** as author and committer. | **Open (your call).** New commits now use GitHub's noreply address. Removing it from history needs a force-push, which I have not done. |
| V-14 | Info | SVG files are an XSS carrier. | Refused explicitly. |
| V-15 | Info | Double-clicking Download exported twice. | Fixed: one export, one count. |

**Checked and clean:** no script injection from file names, profile fields or storage (every sink escapes or uses `textContent`); no secrets anywhere in the repo or its history; HTTPS is enforced on Pages and HSTS is on; GitHub secret scanning and push protection are enabled; the committed images carry no EXIF or other metadata.

## 2. Verification and validation (IV&V)

**Verification (built right):** `tests/run.html` drives the real app through its UI. **45 browser tests at the time (49 now, see section 4)**:

- `BR-*` (23): every business rule in `docs/BUSINESS_RULES.md`, per plan: photo, size, resolution, photo, size and resolution limits, the Free download limit, export cap, formats, looks, ZIP, expiry, cancellation.
- `ACC-*` (8): the account dialog, account removal and the PDF receipt (including that hostile text cannot forge or break it).
- `SEC-*` (14): each attack above, as a regression test, plus the CSP, pinned libraries, network allow-list and the HEIC sandbox. (Clickjacking needs a second origin, so it was verified by hand with a hostile page.)

Run it: `python3 -m http.server 8731`, open `http://localhost:8731/tests/run.html`. After editing any inline script, run `python3 tools/update-csp.py` (a test fails if the policy is stale).

Two bugs in my own work were caught this way (the usage-clock check and a stale class name) and fixed.

**Validation (right thing built):** the rules map to how the product is sold. Free is generous enough to try every look and finish a few photos, but cannot be used as a free bulk exporter (no ZIP, 1024 px cap, 10 downloads a day). Paid plans are different in a way people can see, and each limit is shown in the pricing cards, the download menu and the account Usage tab.

## 3. What cannot be fixed in the browser, and what to build

Not fixable client-side: V-01 and V-02. People who "misuse" the app this way only get things they could get anyway (they process their own photos on their own machine), but **before taking real money** you need a server:

1. **Identity:** verify the Google ID token on the server (signature, `aud`, `iss`, `exp`), then use an `HttpOnly; Secure; SameSite=Lax` session cookie. Never trust the browser's claim of who someone is.
2. **Plans:** store entitlements server-side, written *only* by a verified Razorpay webhook (check `X-Razorpay-Signature` as HMAC-SHA256 over the raw body, constant-time compare, idempotent per event id, and match the order's amount, currency and plan to one *you* created). Never accept "payment succeeded" from the browser. Handle refunds and chargebacks by revoking access.
3. **Quotas:** count the Free plan's daily downloads per account on the server (atomic increments). Because editing happens in the browser, a patched client could still save a file locally. If strict enforcement of full-resolution export matters, render Pro exports on the server.
4. **Pro files:** serve paid looks only to entitled sessions (signed, short-lived URLs). Use looks you own: the current ones are CC BY-SA.
5. **Hardening:** rate-limit sign-in, webhook and download-ticket routes; strict CORS; request size limits; response headers (`Content-Security-Policy` with `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`); secrets in environment variables; dependency scanning; logging and alerts.
6. **Data protection:** keep only Google's id, name and email; provide account removal (the UI exists, the server must honour it); set a retention rule. Check India's DPDP Act requirements before launch.

Section 4 records what has since been built.

## 4. Update: server-owned plans and Dodo Payments

What was built, against the list in section 3:

| Section 3 item | Status |
|---|---|
| 1. Identity | **Done.** The server verifies the Google ID token (RS256 signature against Google's published keys, `aud`, `iss`, `exp`, freshness under 10 minutes, verified email, numeric subject). It issues a random 256-bit session token; only its SHA-256 hash is stored, it lasts 30 days and is revocable (sign out, delete account). *Deviation:* a bearer token in `localStorage` instead of an HttpOnly cookie, because the API lives on `workers.dev` (cross-site to `filmroom.in`, and Safari and Firefox block cross-site cookies). If DNS moves to Cloudflare the API can sit on `api.filmroom.in` and use a cookie. The CSP (no inline or eval script) is what protects the token from script injection. |
| 2. Plans | **Done.** A plan is granted only by Dodo's webhook: Standard Webhooks HMAC-SHA256 over the raw body, constant-time compare, 5-minute replay window, one-time processing per `webhook-id`. The body only names the object; the facts (status, product, dates) are re-read from Dodo's API, and the product must be one of ours. Checkout sessions are built on the server from the verified account (the browser sends only a plan name), with the account id in Dodo metadata. Refunds and lost disputes revoke Lifetime; failed renewals return the account to Free. |
| 3. Quotas | **Done for signed-in accounts.** A per-user Durable Object counts Free downloads atomically (15 parallel requests: exactly 10 allowed). The page asks first and saves only if the server agrees. *Remaining:* a signed-out visitor is counted in the browser only, because there is no identity to count against (counting by IP would punish shared mobile networks). A patched page could skip the request and save a file anyway: rendering exports on the server would be the only fix, and it is not worth it for photos the person already has. |
| 4. Pro files | **Deliberately not done.** Free users preview all 14 looks, which needs the look files; they are CC BY-SA community files. Gating them would break the product and protect nothing. The line that matters, downloading a Pro look, is enforced by the page. |
| 5. Hardening | **Mostly done.** Strict per-origin CORS, 8 KB body limit, rate limits on sign-in and checkout (Cloudflare rate-limit binding, 20 a minute), invoices only for payments recorded on the caller's own account, `nosniff` and `no-store` on every response, secrets only as Worker secrets, dev-only routes that exist only when `ENABLE_DEV_ROUTES=1` in an untracked file. *Not done:* the page's own response headers (`frame-ancestors`, `X-Content-Type-Options`), which GitHub Pages cannot set. |
| 6. Data protection | **Partly.** The server keeps the Google id, name, email, avatar URL, plan state and recent payment ids. Deleting the account erases it all and ends every session; Dodo keeps payment records, as it must for tax. A retention rule and an India DPDP check are still yours to do before launch. |

**Tests:** 36 server unit tests (webhook signatures, Google token attacks, plan rules, webhook handling), 24 local end-to-end checks (forged, replayed and unsigned webhooks; someone else's invoice; double subscription; refund; account deletion) and the 49-test browser suite, which now also covers checkout, the return from Dodo, the server-side download cap and forged browser storage.

**Residual risks to know about:** the plan is only as trustworthy as the Dodo API key and webhook secret (keep them as Worker secrets, rotate if leaked); if the webhook endpoint is down Dodo retries, but a buyer may wait a few minutes for Pro (the page says so and keeps checking); the Dodo `payment.succeeded`/`subscription.*` payload shapes were handled defensively but should be confirmed with a real test-mode purchase before going live (see `server/README.md`).

## Reporting a vulnerability

Please open a private security advisory on the GitHub repo rather than a public issue.
