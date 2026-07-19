# Kuber — architecture and design

Companion to the [README](../README.md). This covers the data model, the intelligence design, the security posture and the roadmap.

---

## 1. Product position

**The promise:** after setup, you never log an expense. Money data arrives on its own, gets understood, and turns into answers.

**The wedge:** Indian banks send an SMS for essentially every transaction. That stream is a near-complete ledger that already exists on the phone. The product is not "a place to type expenses" — it is a parser plus an interpreter over a feed the user already receives.

**What "done" means for v1:** you import a backup, and without touching anything you can see where your money went, what is due next, what you are subscribed to, and whether you can afford something.

### Non-goals for v1

Deliberately excluded, because building them badly is worse than not building them: bank API integrations, real-time push, multi-user/family mode, investment portfolio valuation, tax filing, and anything requiring a backend. A local-first single-user app has no need for microservices, an admin dashboard, or a CI/CD deployment pipeline — those appear in Phase 3 if a hosted version is ever justified.

---

## 2. Architecture

Layered, with a hard rule: **nothing below `js/ui/` may touch the DOM.** That is what makes the engine portable to Dart/Kotlin later.

```
┌──────────────────────────────────────────────┐
│  ui/          app.js · charts.js · assistant │  DOM, rendering, events
├──────────────────────────────────────────────┤
│  core/store.js                               │  persistence, pipeline, derived state
├──────────────────────────────────────────────┤
│  engine/  parser · categorizer               │  pure functions
│           intelligence · llm                 │
├──────────────────────────────────────────────┤
│  data/    merchants · samples                │  static dictionaries
└──────────────────────────────────────────────┘
```

`store.js` is the only module that knows about `localStorage`. Swapping in IndexedDB, SQLite (Flutter) or a real backend touches that one file.

### The ingest pipeline

```
raw SMS
  → parseSms()        extract fields, score confidence, reject noise
  → categorise()      overrides → rules → dictionary → keywords → mode → fallback
  → fingerprint       reject re-imports
  → markDuplicates()  cross-transaction pass
  → persist
  → derive()          memoised analytics over the whole set
```

`derive()` is memoised on a cache key of transaction count, last-write timestamp, budget contents and user-correction count. Switching tabs does not recompute the analytics stack.

---

## 3. Data model

A transaction, as stored:

| Field | Notes |
| --- | --- |
| `id` | generated, `t<base36>` |
| `raw`, `source`, `sender`, `receivedAt` | provenance; `raw` is kept so parsing can be improved retroactively |
| `ts` | transaction date parsed from the body, falling back to SMS receipt time |
| `amount`, `direction` | `debit` / `credit` |
| `merchant`, `merchantRaw` | canonical vs. as-extracted |
| `category`, `categorySource`, `categoryConfidence` | source ∈ user / rule / dictionary / keyword / mode / llm / learned / fallback |
| `bank`, `accountLast4`, `cardLast4`, `vpa`, `refId` | identity |
| `balance`, `creditLimit` | when the message reports them |
| `mode` | upi / card / atm / emi / autodebit / neft / imps / rtgs / wallet / netbanking / other |
| `flags` | refund, salary, emi, sip, autodebit, failed |
| `confidence`, `needsReview` | parse quality |
| `duplicateOf` | id of the earlier transaction, or null |
| `excluded` | user-hidden from totals |

Alongside: `learning.overrides` (merchant → category), `learning.rules`, `budgets`, `goals`, `profile`, `settings`, `dismissedInsights`.

**Why `raw` is retained.** Parsing will keep improving. Keeping the original message means a future version can re-derive better fields from data already imported, rather than asking the user to re-import.

---

## 4. Parsing design

The hard part is not extracting a number. It is deciding **which** number, and rejecting the 60% of bank SMS that are not transactions.

**Ordering matters.** Balance and credit-limit are extracted and *masked out of the string* before the amount is matched. Without that, `Avl Bal Rs.99999` wins over the actual `Rs.250` payment. Two tests pin this.

**Merchant extraction is a priority ladder,** not one regex — eight patterns ordered by how specific the surrounding template is, from ICICI's `; MERCHANT credited` down to a generic `by NAME`. First match wins, and each carries a weight that feeds confidence.

**Merchant matching is length-dependent.** Patterns of 5+ characters may prefix-match (`DOMINO` → `DOMINOS`, `PAYTM` → `PAYTMQR2810…`); shorter ones must match exactly. This is not arbitrary — a shipped bug had `VI ` (Vodafone Idea) matching the `VIA` in "via IMPS", filing rent under phone recharge. Exact-matching short patterns also stops `CRED` firing on every "credited". Three regression tests cover it.

**Confidence** starts at 0.5 and moves with every field resolved or guessed. Below 0.62, or with an unresolved merchant, the transaction is flagged `needsReview` and becomes a candidate for the LLM layer.

---

## 5. Intelligence design

**Recurring detection.** Group debits by merchant, require a stable interval (weekly/monthly/quarterly/yearly within tolerance) *and* a stable amount (≤35% spread). Two occurrences suffice for a dictionary-known subscription; three otherwise, because two coincidental payments to the same shop are common and three on a cadence are not. Confidence rises with sample size and falls with interval jitter.

**Subscriptions vs. commitments.** A monthly recurring payment is not automatically a subscription. Rent, EMIs, loans, insurance, investments, tax and transfers are classified as *commitments*: tracked and forecast, but never presented as things to cancel. Without this split the demo reported "13 subscriptions costing ₹53,370/month" — including rent and a car loan — and the health score's subscription component sat at 0/100. Two tests pin the distinction.

**Forecasting** blends two signals: the discretionary run-rate so far this month, and known recurring payments still to land. Run-rate alone misses a ₹40k EMI on the 28th; recurring alone misses daily spend. Recurring already paid this month is excluded so it is not double-counted.

**Anomaly detection** uses median/MAD rather than mean/σ, so one past outlier cannot mask the next one. Anything above the global 95th percentile is also surfaced, which catches first-time-large merchants that have no history to compare against.

**Budgets** use a trimmed mean over trailing months — the highest month is dropped — plus 10% headroom, rounded to ₹100. A budget you breach every month stops being information.

**Health score** is four weighted components (savings rate 35%, debt burden 25%, spending stability 25%, subscription load 15%), each explainable on screen. The user should always be able to see why it moved.

---

## 6. AI design

**Rules first is a cost and privacy decision, not a technical compromise.** The deterministic layer resolves essentially the entire demo corpus. The LLM exists for the tail: unfamiliar templates, regional banks, obscure merchants.

Three properties keep it honest:

1. **Redaction before transmission.** Account numbers, card digits, references and phone numbers are stripped. Categorisation needs the merchant and context words; it has no need for identifiers.
2. **Merchant-keyed caching.** Each unknown merchant costs at most one call, ever. The system gets cheaper the longer it runs.
3. **Soft failure.** A failed call leaves the rule-based answer in place. The AI can never make the app worse than it was without it.

The assistant follows the same shape: a local intent parser handles the question forms that actually recur (aggregation, listing, next-due, affordability, subscription audit, health, forecast, why-did-spending-change, what-to-cut). Only genuinely open-ended questions reach a model, and they receive an **aggregate summary** — totals, categories, cadences — never raw messages.

---

## 7. Security and privacy

**Current posture (local-first).** No server, no account, no telemetry, no third-party requests except the LLM provider you configure. Data lives in `localStorage` on one device.

**Honest limitations.** `localStorage` is not encrypted; anything with access to the browser profile can read it, including the API key. Exported backups are plaintext JSON. This is acceptable for a single-user local test and is stated plainly in Settings — it is *not* acceptable for a shipped multi-user product.

**What a production version needs:** SQLCipher or platform keystore for at-rest encryption, biometric/PIN gating, key material in Android Keystore / iOS Keychain rather than app storage, certificate pinning, and no plaintext export without an explicit warning and passphrase.

**Data rights.** Full export and full erase are both one click, today. Any hosted version must keep that property.

---

## 8. Testing

`www/tests.html` — 42 checks, no runner, no build step, which matters on a machine with no Node.

Three categories: **bank templates** (one per supported format), **rejections** (OTP, promo, declined, future-dated, collect request, balance enquiry), and **regressions** (each pins a bug that actually shipped).

The rule: when a real SMS parses wrongly, add a case before fixing it. The suite has already caught four real bugs including a silently-discarded `needsReview` flag, an email address being read as a UPI VPA, and the merchant prefix-matching bug.

---

## 9. Roadmap

**Phase 2 — Android (the actual product).** Capacitor wrapper, APK built in GitHub Actions (no local Android SDK needed — proven by the Wobble project on this machine), SMS read permission, background sync, local notifications for due payments. This is what converts a manual XML export into genuine zero-touch tracking.

**Phase 2.5 — Email.** Gmail API in Google Cloud "Testing" mode for a personal account. Order confirmations and statements fill the gaps SMS leaves: line items, not just totals.

**Phase 3 — only if a hosted product is justified.** Account Aggregator via a licensed TSP, real accounts and sync, family mode, receipt OCR. Each requires a backend, and therefore a genuine security model rather than the local-first one above.

**Deferred indefinitely:** crypto tracking, tax filing, credit-score monitoring. Each is a product in its own right.
