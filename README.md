# Apps

Personal browser apps, served by GitHub Pages at https://rfernex.github.io/Apps/.

- **[Hours & Days](hours/)**: time tracking by week, against objectives and a plan.
- **[Expense Tracker](ledger/)**: income, spending and the remaining reserve.
- **[Admissions](phd/)**, **[Italiano](italian/)**, **[Reading Room](reading/)** and **[GRE Quant Quest](gre-quest/)**: private apps. Only a connect page is published.

## Private apps

The connect page of a private app needs its owner's key. Each private app is published as one encrypted bundle (`private.bin`, AES-GCM with a 256-bit key, version in `private.json`). With the key, `shared/private-gate.js` decrypts the bundle into the browser's cache, and the app's service worker (`shared/private-sw.js`) serves the app from there, also offline. Newer bundles are installed in the background. The key reaches a device through an unlock link whose key part follows a `#`, which browsers never send to a server. Without the key, nothing beyond the connect page can be read. The verb tables of Italiano (`italian/data/verb*.json`) and its PDF reader are published in clear because their licences allow it.

## Data

The apps contain no personal data. Everything entered is kept in the browser's local storage on the device that uses them, and is never sent to the publisher. An optional sync feature stores a copy in a private GitHub repository chosen by the user, through the GitHub API, with the user's own token. Each app can also save and restore a backup file.

## Outside services

The pages load nothing from outside services: fonts, MathJax and PDF.js are hosted in this repository. The GitHub API is called only when sync is turned on with a token. Some features of the private apps call further services when used (translation, literature search, Zotero, language models). The pages carry a no-index tag.

## Third-party material

- Fonts in `shared/fonts/files`: Archivo, JetBrains Mono, Zilla Slab, IBM Plex Mono, Source Sans 3 and Spectral, under the SIL Open Font License 1.1 (see `shared/fonts/LICENSE.md`).
- `shared/mathjax`: MathJax 3.2.2, under the Apache License 2.0 (see `shared/mathjax/LICENSE`).
- `ledger/vendor` and `italian/vendor`: Mozilla PDF.js 3.11.174 and 5.6.205, under the Apache License 2.0 (see the `PDFJS-LICENSE` file in each folder).
- `italian/data/verb*.json`: adapted from Ian Hamlin's verb-data, from English Wiktionary, under CC BY-SA 3.0 (see `italian/ATTRIBUTION.md`).

The privacy notice for rfernex.github.io, which covers these pages, is at https://rfernex.github.io/legal.html.
