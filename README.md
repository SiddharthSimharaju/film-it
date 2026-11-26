# Filmroom

Give any photo the look of classic Fujifilm and Polaroid film stocks, add grain, crop and straighten, then download it in the format you want. Everything runs in your browser, so your photos never leave your device.

**[Open the app](https://siddharthsimharaju.github.io/film-it/)**

![Filmroom](docs/screenshot.png)

## Features

- **Many photos at once:** drop or pick as many as you like. Each photo keeps its own film look, grain, adjustments and crop, **Apply look to all** copies one photo's look to the rest, and **Download all** saves every edited photo in one ZIP.
- **Film looks:** Provia 100F, Provia 400X, Velvia 50, Astia 100F, Reala 100, Sensia 100, Superia 400, X-Tra 800, Pro 400H, Superia XPRO, FP-100C (and Neg), Acros 100 and Polaroid 690.
- **Filter strength:** blend each look from 0 to 100%.
- **Film grain:** adjustable, scaled to the photo's resolution.
- **Adjustments:** exposure, contrast, highlights and shadows sliders (−100 to +100) that sit on top of the film look.
- **Crop and straighten:** aspect-ratio presets, a manual straighten slider, and auto-straighten that finds the horizon or vertical lines.
- **Any format in:** JPG, PNG, WebP, AVIF, BMP, GIF, HEIC and TIFF.
- **Any format out:** the same format as the original, or PNG, JPEG, WebP, TIFF and BMP (AVIF where the browser supports it). Browsers can't write HEIC, so those photos save as JPEG.
- **Full resolution:** processing happens on the GPU at the photo's original size.

## Plans (mock for now)

Pricing is built into the UI, but **no payments are processed**. Plan state is kept in the browser's `localStorage`, and the checkout screen is a demo.

| | Free | Pro Monthly | Pro Yearly | Lifetime |
|---|---|---|---|---|
| Price (₹, incl. GST) | 0 | 149 / month | 1,499 / year | 3,499 once |
| Film looks to download | Original + 5 (all 14 can be previewed) | All 14 | All 14 | All 14 |
| Photos open at once | 5 | 25 | 50 | 100 |
| Largest file / resolution | 20 MB / 24 MP | 60 MB / 60 MP | 100 MB / 100 MP | 150 MB / 120 MP |
| Downloads per day | 10 | unlimited | unlimited | unlimited |
| Export size and formats | 1024 px, JPEG and PNG | Original size, all formats | Same | Same |
| "Download all" ZIP | not included | up to 25 photos | up to 50 | up to 100 |

Every rule, where it is enforced and the test that proves it is in [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md). The numbers live in one table (`LIMITS` in `index.html`). Locked looks show a lock on their cartridge, and hitting any limit opens the plan picker (Free) or shows a plain message (paid). To wire up real payments, replace `startCheckout()` in `index.html`: create the order or subscription on a server, verify the payment, then call `activatePlan()`.

## Security and tests

The app is client-side only, so plans and limits behave correctly for honest users but **can be bypassed by a determined one** until a server owns them. [SECURITY.md](SECURITY.md) has the full penetration-test and verification report, what was fixed, and what to build before taking real payments.

To run the 44 automated tests (business rules and security): `python3 -m http.server 8731`, then open <http://localhost:8731/tests/run.html>. After editing any inline script, run `python3 tools/update-csp.py` to refresh the content-security policy's script hashes.

## Accounts (Google sign-in)

Plans belong to an account. Buying a plan needs a sign-in. The account dialog has three tabs: **General** (profile, sign-in method, delete account), **Plan & billing** (change plan, cancel or resume, payment method, invoices with a downloadable PDF receipt) and **Usage** (today's uploads and downloads against the plan's limits).

Sign-in is a **demo** until you add a Google OAuth client ID:

1. In Google Cloud Console, create an **OAuth client ID** of type *Web application*.
2. Add your site (for example `https://siddharthsimharaju.github.io`) and `http://localhost:8731` under *Authorized JavaScript origins*.
3. Paste the client ID into `GOOGLE_CLIENT_ID` near the top of the accounts code in `index.html`. "Continue with Google" then becomes Google's real button.

For now account and plan data is stored in the browser. Before real payments, move it to a server: verify the Google ID token there and store the plan against the verified account.

## How it works

The film looks are 3D colour lookup tables (Hald CLUTs) applied in a WebGL2 shader with trilinear interpolation. Cropping and rotation happen in the same shader, so an unrotated crop is a pixel-exact cut-out. The film cartridges on the shelf are 3D models rendered once with three.js (`tools/render-cartridges.html`) and shipped as small images in `assets/films/`, so the page never loads three.js.

It is a single `index.html` with no build step. To run it locally, serve the folder over HTTP (the lookup tables can't load from `file://`):

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Credits

The film simulation lookup tables are from the [RawTherapee Film Simulation Collection](https://rawpedia.rawtherapee.com/Film_Simulation) by Pat David, Pavlov Dmitry and Michael Ezra, licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). They approximate the look of each film and are not Fujifilm's own processing. Film and brand names are used for identification only, with no affiliation or endorsement.

Auto-straighten, HEIC and TIFF decoding use [heic2any](https://github.com/alexcorvi/heic2any) and [UTIF.js](https://github.com/photopea/UTIF.js), loaded on demand.

## About me

Hi, I'm Siddharth. Filmroom is a small project I designed and built with [Claude Code](https://claude.com/claude-code). You can find me on GitHub at [@SiddharthSimharaju](https://github.com/SiddharthSimharaju).
