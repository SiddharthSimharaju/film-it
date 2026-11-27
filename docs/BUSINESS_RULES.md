# Filmroom business rules

What each plan allows, and where each rule lives in the code. Every rule is checked by an automated test (`tests/run.html`, see the **Test** column).

**Single source of truth:** the `LIMITS` table in `index.html`. Change a number there and the app, the pricing cards, the account page and the messages all follow. Prices live in `PLANS`.

## Domain model

| Thing | Meaning |
|---|---|
| **Guest** | Someone who is not signed in. Gets exactly the Free limits. No account needed to use the app. |
| **Account** | A Google sign-in. Needed only to buy a plan; the plan belongs to the account. |
| **Plan** | `free`, `monthly`, `yearly` or `lifetime`. Decides every limit below. |
| **Photo** | One opened image, kept only in the browser tab. Photos never leave the device. |
| **Look** | A film simulation. 24 looks plus "Original". |
| **Upload** | A photo opened into the library. Free for everyone: there is no daily upload limit, because opening a photo costs nothing. |
| **Download** | One exported file saved to disk. A "Download all" ZIP counts one per photo inside it. |

## What each plan allows

| | Free | Pro Monthly | Pro Yearly | Lifetime |
|---|---|---|---|---|
| **Price (₹, GST included)** | 0 | 149 / month | 1,499 / year | 3,499 once |
| Photos open at once | 25 | 25 | 25 | 25 |
| Largest single file | 20 MB | 60 MB | 100 MB | 150 MB |
| Largest resolution | 24 MP | 60 MP | 100 MP | 120 MP |
| Downloads per day | 10 | unlimited | unlimited | unlimited |
| "Download all" ZIP | not included | up to 25 photos | up to 25 | up to 25 |
| Export size | 1024 px (long side) | original size | original size | original size |
| Export formats | JPEG, PNG | JPEG, PNG, WebP, AVIF*, TIFF, BMP | same | same |
| Film looks you can download | Original + 5 | all 24 | all 24 | all 24 |
| Crop, straighten, adjustments, grain, apply-look-to-all | yes | yes | yes | yes |

\* AVIF appears only in browsers that can save it.

**Safety ceilings** (apply to every plan, they protect the browser tab and are not pricing rules): file 150 MB, 120 MP, 100 photos, ZIP 1.5 GB, decode time 45 s, aspect ratio at most 20:1.

## Rules, where they are enforced, and the test that proves them

### Uploads
| # | Rule | Code | Test |
|---|---|---|---|
| U1 | At most *plan.photos* photos open at once. Free users get the upgrade nudge, paid users a plain message. | `addFiles`, `whyPhotos` | BR-F1, BR-M1, BR-Y1, BR-L1 |
| U2 | A file larger than *plan.fileMB* is refused before it is decoded. | `addFiles` | BR-F2 |
| U3 | An image above *plan.megapixels* is refused, from the file header when possible, otherwise after decoding. | `peekDims`, `addFiles` | BR-F3, BR-F4 |
| U4 | There is no daily upload limit on any plan (nothing is counted). | `addFiles` | BR-F5 |
| U5 | Any common photo format can be opened on every plan (JPG, PNG, WebP, AVIF, BMP, GIF, HEIC, TIFF). SVG is refused. | `isSvg`, `decode` | SEC-2, SEC-11, SEC-12 |
| U6 | A shape beyond 20:1 (for example 30000 x 2) is not a photo and is refused. | `addFiles` | SEC-3 |
| U7 | Images wider than the GPU can hold are scaled down to fit instead of breaking. | `clampBitmap` | SEC-4 |

### Downloads
| # | Rule | Code | Test |
|---|---|---|---|
| D1 | Free: at most 10 downloads a day, and the download menu shows how many are left. Paid plans: unlimited, with no counter. | `dl.onclick`, `remaining()` | BR-F6, BR-M5 |
| D2 | Exports are capped at *plan.exportPx* on the long side (Free: 1024 px). Other plans export at the original size. | `exportSource` | BR-F7, BR-M3 |
| D3 | Only the formats in *plan.formats* can be saved. Locked formats are shown with a PRO tag and open the upgrade nudge. | `resolveFmt`, `buildMenu` | BR-F8, BR-M2, BR-Y2, BR-L2 |
| D4 | Pro looks can be previewed on any photo but only downloaded on a paid plan. | `lookLocked` | BR-F9 |
| D5 | "Download all" needs a plan with a ZIP allowance and no more photos than *plan.zipMax*. | `downloadAll` | BR-F10, BR-M4 |
| D6 | A ZIP (paid plans only) contains every open photo, each with its own edits. | `downloadAll` | BR-M4 |
| D7 | A second click while an export is running is ignored, and counts once. | `exporting` flag | SEC-14 |

### Accounts and billing
| # | Rule | Code | Test |
|---|---|---|---|
| A1 | Buying a plan needs a sign-in. Free use does not. | `startCheckout`, `openPlans` | covered by `signIn()` in every paid scenario |
| A2 | The plan belongs to the account, is held by the server and is restored on sign-in. | `setAccount`, `restoreSession`, server `effective()` | BR-M1..L2 |
| A3 | Renewals are charged by Dodo and reported by webhook. A renewal that is a little late keeps Pro for 3 days; a failed one (`on_hold`) returns the account to Free. | server `effective()`, `webhook.js` | server unit tests, e2e 16-17 |
| A4 | Cancelling (at the end of the paid period, through Dodo) keeps Pro until that date, then the account falls back to Free. Resuming before then undoes it. | `changeCancel`, server `/billing/cancel`, `effective()` | BR-B1, BR-B2, e2e 11-12 |
| A5 | Lifetime never expires and cannot be cancelled. | `panePlan` | ACC-1 |
| A6 | When a plan lapses, the Free limits apply to *new* uploads and exports. Photos already open stay open. | `limits()` | BR-B2 |
| A7 | An account with an active subscription cannot be removed until it is cancelled. Removing an account deletes its server record and ends every session. Payment records stay with Dodo. | `deleteAccount`, server `DELETE /me` | ACC-4, ACC-5, e2e 15, 23 |
| A8 | Every successful payment is recorded against the account (from Dodo's signed webhook) and shown under Invoices. The Invoice button downloads Dodo's own PDF tax invoice, and only for that account's payments. | webhook `payment.succeeded`, `receiptFor`, server `/billing/invoice/:id` | ACC-6, e2e 7-8 |

| A11 | A subscriber can switch between Monthly and Yearly. **Monthly to Yearly** starts now: the server asks Dodo for the exact prorated amount (the yearly price minus credit for the unused part of the period), shows it, and charges the saved payment method only after the person confirms. **Yearly to Monthly** is scheduled for the next billing date, nothing is charged now, the account keeps Yearly until then, the pending switch is shown, and it can be undone. Product and proration mode are chosen by the server. Switching is refused with no subscription, on a subscription that is set to end (resume first), or to the plan already held. Lifetime is bought through checkout. | `renderSwitch`, `confirmSwitch`, `unschedule`, server `/billing/change-plan*` | PAY-2, PAY-4, e2e 25-33 |

### Daily download counter (Free only)
| # | Rule | Code | Test |
|---|---|---|---|
| C1 | The count is per day and resets at midnight (India time on the server, local time for guests). | `usageNow`, server `istDay` | BR-F5, BR-F6 |
| C2 | Signed in: the **server** counts and refuses the 11th download, atomically, even for parallel requests. Guests are counted in the browser only. | server `consumeDownloads`, `reserveDownloads` | SRV-1, ACC-3 |
| C3 | On one device the larger of the browser count and the server count applies, so signing in or out can't double the allowance. | `remaining` | BR-B4 |
| C4 | Winding the clock back by up to 2 days does not reset the guest count. | `usageNow` | BR-B3 |
| C5 | The server is asked first, and the file is saved only if it agrees. | `dl.onclick`, `downloadAll` | SRV-1 |

## What is still not enforced by the server

Plans, billing identity and the signed-in daily count are server-owned. Two things remain in the browser, on purpose (details in `SECURITY.md`):

- **Guest limits** (no account, so nothing to count against) and the **per-file limits** (size, megapixels, export size, formats, ZIP) are applied by the page that does the editing. A patched page can ignore them: the person only gets their own photos processed on their own machine.
- **The Pro look files** are public: free users preview all 24 looks, and the files are CC BY-SA community files. What Free cannot do is download a Pro look, which the page enforces.

## Coupons (Dodo Payments)

Coupons live in Dodo Payments, not in this code. The checkout page Dodo hosts has a discount-code box, so a code typed there works through the normal payment link. Test and live mode have separate coupons.

| Code | Mode | What it does |
|---|---|---|
| `FREEMONTH` | **test only** (`dsc_0Nsq600F432rrHehKKwGL`) | 100% off, **Filmroom Pro Monthly only** (Yearly and Lifetime refuse it), no cycle limit so renewals are free too, no expiry, no usage cap. For testers. |

- It does not exist in live mode. Create it there only on purpose (Dodo dashboard, Sales, Discounts), ideally with a usage limit and an expiry.
- Even at ₹0, Dodo asks for a card unless the product's **Card-optional at $0 price** setting is on (`zero_amount_payment_method_optional`). In test mode use the test card `4242 4242 4242 4242`.
- To stop testers: delete or edit the discount in the Dodo dashboard. Subscriptions already created keep their discount.
