# Vendored third-party code

Kept in the repo (not loaded from a CDN) so a compromised CDN can't change what runs in the app.

| File | Package | Version | License | SHA-384 |
|---|---|---|---|---|
| `heic2any.min.js` | [heic2any](https://github.com/alexcorvi/heic2any) | 0.0.4 | MIT | `OTofQ0MEeiSgh62havBcemCIK0gqj809wX6UA0uPISNMRnR6NZyCdGzX3SbLrgwL` |
| `UTIF.js` | [UTIF.js](https://github.com/photopea/UTIF.js) | 3.1.0 | MIT | `RyBmXHdfZ/Uon+ud+/AqSyWpUWnKYt2tkRG/P4gWoRUGDU+qIAV3tGBPNlYTBZEF` |

`heic2any` runs only inside `heic-sandbox.html`, in a sandboxed iframe with no access to the app. `tests/run.html` checks these hashes.
