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
| **Look** | A film simulation. 14 looks plus "Original". |
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
| Film looks you can download | Original + 5 | all 14 | all 14 | all 14 |
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
| A2 | The plan belongs to the account and is restored on sign-in. | `syncPlan`, `completeSignIn` | BR-M1..L2 |
| A3 | Monthly renews every 30 days, yearly every 365. Missed renewals are caught up (at most 24 invoices). | `syncPlan` | SEC-6 |
| A4 | Cancelling keeps Pro until the period ends, then the account falls back to Free. Resuming before then undoes it. | `renderCancel`, `syncPlan` | BR-B1, BR-B2 |
| A5 | Lifetime never expires and cannot be cancelled. | `panePlan` | ACC-1 |
| A6 | When a plan lapses, the Free limits apply to *new* uploads and exports. Photos already open stay open. | `limits()` | BR-B2 |
| A7 | An account with an active subscription cannot be removed until it is cancelled. Removing an account clears its saved plan data. | `deleteAccount` | ACC-4, ACC-5 |
| A8 | Every payment creates an invoice. Its receipt is a one-page PDF with the receipt number, transaction ID, date and time (IST), payment method, billed-to and from details, the billing period, the price split into subtotal and GST (18%, included in the price) and the total paid. Seller details (legal name, address, GSTIN) come from `BUSINESS` in `index.html`: fill them in before launch. | `activatePlan`, `buildReceiptPDF` | ACC-6, ACC-7 |

### Daily download counter (Free only)
| # | Rule | Code | Test |
|---|---|---|---|
| C1 | The count is per device per local day and resets at midnight. | `usageNow` | BR-F5, BR-F6 |
| C2 | One shared counter for guests and every account on the device, so signing in or out can't double the allowance. | `usageNow` | BR-B4 |
| C3 | Winding the clock back by up to 2 days does not reset the count. | `usageNow` | BR-B3 |
| C4 | The count moves only when a file was actually saved. | `dl.onclick` | BR-F6 |

## Where the rules are *not* enforced yet

Every rule above runs in the browser, because the app has no server. That is enough to behave correctly for honest users and to survive broken input, but **a determined person can bypass any of them** (see `SECURITY.md`, findings V-01 and V-02). Before real money is taken, the plan, the counters and the premium files need to move to a server.
