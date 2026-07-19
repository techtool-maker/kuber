# Kuber — automatic personal finance

Reads your bank SMS and works the rest out by itself: merchants, categories, subscriptions, duplicates, forecasts and budgets. No manual expense entry.

This is **v1: a local-first web app**. Everything runs in your browser, on your machine. There is no server, no account and no telemetry.

---

## Run it

```powershell
cd C:\Users\TyagiKe\Kuber
.\serve.ps1
```

Then open <http://localhost:5600>.

It must be served over HTTP — the app uses ES modules, which `file://` blocks. Port 5600 was chosen so it does not clash with Wobble (5599) or Millimeter (8123).

First run, click **Load demo data** to see the whole thing working against four months of synthetic Indian bank SMS before you put your own data in.

### Tests

<http://localhost:5600/tests.html> — 42 checks over the parsing, merchant-matching, categorisation, recurring-detection and query layers. Run it after touching anything in `js/engine/` or `js/data/`.

---

## Getting your real SMS in

Android does not let a web page read your inbox, so the transfer is manual — once.

1. Install **SMS Backup & Restore** (free, Play Store).
2. Back up **SMS only** (skip call logs). It writes an `.xml` file.
3. Move that file to this machine.
4. In Kuber: **Import → drop the XML**.

Everything after that is automatic. Re-importing a newer backup is safe: messages are fingerprinted on their raw text and timestamp, so nothing is double-counted.

You can also paste messages straight into the import dialog, which is the quickest way to test a template that is parsing badly.

---

## How the parsing works

Two layers, rules first.

**Layer 1 — deterministic (`js/engine/parser.js`).** Field extractors for amount, direction, merchant, bank, account/card, UPI VPA, reference, balance, date and payment mode, across the templates used by HDFC, ICICI, SBI, Axis, Kotak and others. Each parse carries a confidence score. On the demo corpus this resolves ~100% of messages with zero unknowns, offline and free. It also rejects the noise — OTPs, promos, declined payments, balance enquiries and future-dated reminders.

**Layer 2 — LLM fallback (`js/engine/llm.js`).** Only messages Layer 1 could not resolve confidently. Disabled by default. When enabled it:

- redacts account numbers, card digits, references and phone numbers before anything leaves the device;
- batches 20 messages per call;
- caches results by merchant, so each merchant is paid for at most once;
- fails soft — if the call fails, the rule-based answer stands.

Corrections you make are permanent and deterministic: recategorising a merchant updates every past transaction from it and every future one, without involving a model.

---

## What is actually built

| Area | Status |
| --- | --- |
| SMS parsing engine, 6+ bank templates | Working |
| Merchant dictionary (~140 Indian merchants) | Working |
| Categorisation, 32 categories, learned overrides, custom rules | Working |
| Recurring + subscription detection, next-due prediction | Working |
| Commitments (rent/EMI/insurance) tracked separately from subscriptions | Working |
| Duplicate detection | Working |
| Anomaly detection (median/MAD per merchant) | Working |
| Month-end forecasting | Working |
| Budgets (auto-generated from trimmed history) | Working |
| Goals with completion estimates | Working |
| Financial health score, 4 weighted components | Working |
| Natural-language search and assistant (local) | Working |
| AI assistant for open-ended questions | Needs an API key |
| Dashboard, timeline, insights, charts, calendar heatmap | Working |
| CSV exports: transactions, monthly, category, subscription, tax | Working |
| Dark/light, mobile-first layout | Working |
| Email parsing, bank APIs, Account Aggregator | Not built — see below |
| Push notifications, family mode, receipt OCR | Not built |

---

## Constraints worth knowing before Phase 2

These are real and they shape the roadmap.

**Google Play restricts `READ_SMS`.** Financial-transaction tracking was removed as an approved use case, so an app like this cannot be published to Play as an SMS reader. Sideloading onto your own phone is fine. A published version would have to source data from Account Aggregator instead.

**Account Aggregator requires RBI-regulated FIU status**, or a partnership with a licensed TSP (Finvu, Setu, OneMoney). Not reachable for a solo build, which is why it sits behind a clean interface rather than being half-implemented.

**Gmail API** read scopes need a CASA security assessment (paid, annual) for a *published* app. For your own account in Google Cloud "Testing" mode it is free and works immediately — which is the sane path for Phase 2 email parsing.

---

## Phase 2: the Android app

The engine here is deliberately framework-free and DOM-free below `js/ui/`, so it ports directly.

The path is already proven on this machine by Wobble: **no local Android SDK, APK built in GitHub Actions via Capacitor.** Same trick applies — wrap this app with Capacitor, add an SMS-reading plugin, and let CI produce a debug-signed APK for sideloading. That turns the manual XML export into a genuine background sync and delivers the actual "zero manual entry" promise.

---

## Layout

```
Kuber/
├── serve.ps1              static server, port 5600
├── www/
│   ├── index.html         app shell
│   ├── tests.html         regression suite
│   ├── css/app.css        design tokens + components
│   └── js/
│       ├── app.js         views, modals, import/export
│       ├── tests.js       42 engine tests
│       ├── core/store.js  persistence + pipeline + derived state
│       ├── engine/        parser, categorizer, intelligence, llm
│       ├── data/          merchant dictionary, demo generator
│       └── ui/            charts, assistant
└── docs/ARCHITECTURE.md   data model, AI design, security, roadmap
```

---

## Privacy

All data lives in this browser's `localStorage` on this device. Exporting a backup writes unencrypted JSON — treat it like a bank statement. If you enable the AI fallback, your API key is stored in `localStorage` too, and only redacted message text and aggregate summaries are sent to your chosen provider.
