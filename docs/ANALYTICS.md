# Analytics (Google Analytics 4)

Free, and it answers the growth questions: how many visitors, how many try the app, who hits a limit, who looks at plans, who starts checkout, who pays, and where each group drops off.

## Status

**On**, with Measurement ID `G-NWXGNCWTV6` (`const GA_ID` in `index.html`). It is a direct GA4 integration (`gtag.js`), **not Google Tag Manager**. GTM would let anyone with access to the container run code on Filmroom, where sign-in sessions and payments live, and it would force the content-security policy to be loosened. If you ever need GTM, add it as a deliberate change with that in mind.

**Property setup is done** (property `Filmroom`, `properties/565936259`, stream `Film Room` at https://filmroom.in/): event data is kept for **14 months**; the custom dimensions Plan, Look, Reason, Format, Signed in and Look locked are registered; `purchase`, `sign_up`, `begin_checkout` and `photo_downloaded` are key events. It was applied with `server/scripts/ga-setup.py` (safe to re-run). Steps 1 to 7 below are kept as the manual route and as a record of what the script does.

## Growth metrics, daily or monthly, and the funnels

**The numbers, from a script (the quickest view).** It reads Google Analytics directly:

```
python3 server/scripts/ga-growth.py                 # daily, last 30 days
python3 server/scripts/ga-growth.py --by month      # monthly, last 12 months
python3 server/scripts/ga-growth.py --funnels-only
```

Columns: Visitors, New, Sessions, Sign-ups, Used (opened a photo), Saved (downloaded), Paywall, Plans, Checkout, Payments, New subs, Renewals, Churned, Refunds, Revenue. Then three funnels (growth, sign-up, retention of paid customers) with the share of people reaching each step.

**In the Google Analytics screen** (daily and monthly are both built in):
- Any line chart in Reports has a **Day / Week / Month** switch above it. In Explore → Free form, put **Date** or **Year month** in Rows.
- Reports → Realtime now. Reports → Acquisition → Traffic acquisition for visitors and sources. Reports → Monetization → Ecommerce purchases for payments and revenue.
- Admin → Audiences shows how many *people* are in each of the audiences below.

**Audiences created for you** (they start counting from the day they were created, not retroactively): Signed up · Activated: added a photo · Got value: downloaded a photo · Hit a paywall · Viewed plans · Started checkout · Paid customers · **Churned subscribers** · **Active paying subscribers** (paid and not churned). `Paid customers` and `Churned subscribers` are the "number of people who paid / churned".

**The funnel to build in Explore** (Google offers no way to create saved explorations from outside, so this takes two minutes): Explore → *Funnel exploration* → name it "Filmroom growth" → choose **Open funnel** → add these steps, each as *Event name* equals:
1. `page_view` (Landed) · 2. `photo_added` (**Using it**) · 3. `photo_downloaded` (Got value) · 4. `paywall_shown` · 5. `view_item_list` (Viewed plans) · 6. `begin_checkout` · 7. `purchase` (**Converted**)

Then set **Breakdown** to *Device category* or *Session default channel group*. The step with the biggest drop is where to work. For a second tab use: `page_view` → `sign_up` → `begin_checkout` → `purchase`.

**Churn, paid people and renewals come from the server.** They happen at Dodo, not in the browser, so the Worker sends them to Google Analytics when Dodo reports them: `subscription_started`, `subscription_renewed`, `subscription_plan_changed`, `subscription_churned` (the paid plan really ended, once, with `reason` cancelled or expired), `subscription_on_hold` (a renewal failed: churn risk), `refund`, `chargeback`, plus a `purchase` for every payment. Google merges a browser `purchase` and the server one by `transaction_id`, so nothing is counted twice.
- **Consent first.** They are sent only for people who pressed OK and are signed in. Everyone else sends nothing, so these counts are a **lower bound**. **Dodo's dashboard is the exact record** of subscribers, renewals, churn and revenue; use Google Analytics for the funnel and trends.
- **To switch it on** (a one-time step that must be done by the property owner): Google Analytics → Admin → Property settings → Data collection and modification → Data collection → **User data collection acknowledgement** → Acknowledge. It is a legal statement that you have the privacy disclosures and rights from your users, so it cannot be done on your behalf. Then run `bash server/scripts/ga-login.sh` (if needed) and `python3 server/scripts/ga-mp-secret.py`, which stores the key as a Worker secret without printing it. Until then the Worker sends nothing.

## Switch it on (about 10 minutes)

1. **Create the property.** [analytics.google.com](https://analytics.google.com) → Admin → *Create* → Property. Name `Filmroom`, time zone India, currency INR.
2. **Add a web data stream** for `https://filmroom.in`. Leave *Enhanced measurement* on. Copy the **Measurement ID** (`G-XXXXXXXXXX`).
3. **Keep the history longer.** Admin → Data collection and modification → *Data retention* → **14 months** (the default is 2 months and breaks year-on-year comparisons and long funnels).
4. **Put the ID in the page.** `const GA_ID = ''` near the top of the main script in `index.html`, then `python3 tools/update-csp.py` (it opens the content-security policy to Google's analytics hosts only when an ID is set), then push.
5. **Check it works.** Open https://filmroom.in, press **OK** on the notice, and watch Reports → Realtime in GA4. Your visit should appear within a minute.
6. **Register the custom dimensions** (Admin → Custom definitions → Create custom dimension), otherwise GA4 collects them but won't let you report on them:

| Dimension name | Scope | Event parameter / property |
|---|---|---|
| Plan | User | `plan` |
| Look | Event | `look` |
| Paywall reason | Event | `reason` |
| Format | Event | `format` |
| Signed in | Event | `signed_in` |
| Upload problem | Event | `reason` (shared with Paywall reason, fine) |

7. **Mark key events** (Admin → Events → toggle *Mark as key event*): `purchase` (already on by default), `sign_up`, `begin_checkout`, `photo_downloaded`.

## What is tracked

| Event | When | Useful parameters |
|---|---|---|
| `page_view`, `first_visit`, `session_start` | automatic | source, medium, country, device |
| `photo_added` | photos opened | `photos`, `total`, `rejected` |
| `upload_rejected` | nothing could be opened | `reason` (`too_big`, `too_many_mp`, `photo_limit`, `not_image`, `svg`, …) |
| `look_selected` | a film look clicked | `look`, `locked` (a Pro look on Free), `has_photo` |
| `photo_downloaded` / `download_all` | a file was saved | `format`, `look`, `capped`, `plan` |
| `paywall_shown` | a limit or Pro feature was hit | `reason` (`pro_look`, `photo_limit`, `daily_downloads`, `zip`, `export_format`, `menu`), `signed_in` |
| `sign_up` / `login` | Google sign-in done | `method` |
| `view_item_list` | plans screen opened | the three plans |
| `select_item` | a plan clicked | `item_id` = `monthly` / `yearly` / `lifetime` |
| `begin_checkout` | "Continue to payment" | `value`, `currency` |
| `checkout_returned` | back from Dodo | `confirmed` |
| `purchase` | the plan is active (once per payment) | `transaction_id`, `value`, `currency`, plan |
| `subscription_cancelled` / `subscription_resumed` / `account_deleted` | account actions | `plan` |

The user property `plan` (`free` / `monthly` / `yearly` / `lifetime`) lets every report be split by plan.

**Never sent:** photos, file names, emails, names, account ids, payment details.

## The funnel (Explore → Funnel exploration)

Build one with these steps, in order, *open* (users can enter at any step):

1. `first_visit` or `session_start` (visitors)
2. `photo_added` (**activation**: tried the product)
3. `photo_downloaded` (**got value**)
4. `paywall_shown` (hit a limit)
5. `view_item_list` (looked at plans)
6. `select_item` (chose a plan)
7. `begin_checkout` (went to pay)
8. `purchase` (**converted**)

Turn on *Show elapsed time* and break down by *Device category*, *Session source / medium* and the **Plan** and **Paywall reason** dimensions. The step with the biggest drop is where to work.

Questions and where to find them:

| Question | Where |
|---|---|
| How many visitors, from where? | Reports → Acquisition → Traffic acquisition |
| How many people use it (not just visit)? | Explore → Funnel step 2, or Reports → Engagement → Events → `photo_added` |
| Which limit makes people consider paying? | Events → `paywall_shown` by **Paywall reason** |
| Which looks are popular / which Pro looks tempt people? | Events → `look_selected` by **Look**, filter `locked = true` |
| Which plan do people pick? | Events → `select_item`, and `purchase` by item name (Monetization → Ecommerce purchases) |
| Where do payers drop in checkout? | `select_item` → `begin_checkout` → `purchase` in the funnel |
| Do returning users convert more? | Add a *New vs returning* breakdown, or Reports → Retention |
| Revenue | Monetization → Ecommerce purchases (**Dodo's dashboard is the source of truth**, see below) |

## Honest limits

- **Undercounting.** Ad blockers, Do Not Track / Global Privacy Control (the page honours both) and visitors who press *No thanks* mean GA4 sees fewer people than visit, typically a quarter to half fewer on a tech-leaning audience. Use it for rates and trends, not absolute headcounts. Cookie-less pings still count some of the declined visitors.
- **Revenue and churn: use Dodo.** `purchase` is sent from the browser when the buyer returns to the site, so it misses people who close the tab at Dodo's page, and it does not see renewals, refunds, chargebacks or churn. Dodo's dashboard has the exact figures; GA4's job is the funnel *before* payment. (Sending purchases from the server through GA's Measurement Protocol would close most of that gap; it needs a GA API secret and is a possible next step.)
- **Demographics.** Google Signals is switched off in the page's config, which is better for privacy and means GA4 won't show age/gender reports.
- **Privacy notice.** The notice asks for consent before analytics cookies; until then GA4 receives only cookie-less pings. If you want stricter handling for the EU/UK (no pings until consent), say so and the default can be tightened. Add a line about analytics to your privacy policy when you write one (India's DPDP Act applies).

## Developing

Analytics is off on `localhost`, so tests and local work never pollute the data. The tests (`ANA-1` to `ANA-3`) replace `trackSink()` to read the event stream and check that no event carries personal data.
