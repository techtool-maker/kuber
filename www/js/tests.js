/**
 * Engine regression suite.
 *
 * Runs in the browser at /tests.html — no test runner, no build step, which
 * keeps it usable on a machine with no Node installed.
 *
 * Every case here either encodes a bank template we claim to support, or pins
 * a bug that has actually been hit. Add a case whenever a real SMS parses
 * wrongly: that is what stops it regressing.
 */

import { parseSms } from './engine/parser.js';
import { categorise } from './engine/categorizer.js';
import { lookupMerchant, lookupBank } from './data/merchants.js';
import { detectRecurring, markDuplicates, forecastMonth } from './engine/intelligence.js';
import { parseQuery } from './ui/assistant.js';

const results = [];

function check(name, fn, detail = '') {
  let pass = false;
  let why = '';
  try {
    const r = fn();
    pass = r === true;
    if (!pass) why = typeof r === 'string' ? r : 'returned false';
  } catch (err) {
    why = `threw ${err.message}`;
  }
  results.push({ name, pass, why, detail });
}

/** Parse an SMS and assert on the resulting fields. */
function expectParse(label, sms, expected) {
  check(label, () => {
    const result = parseSms(sms);
    if (expected.reject) {
      return result.ok === false || `expected rejection, got ${result.txn?.merchant} ${result.txn?.amount}`;
    }
    if (!result.ok) return `rejected: ${result.reason}`;
    const t = result.txn;
    const cat = categorise(t, {}).category;

    for (const [key, want] of Object.entries(expected)) {
      const got = key === 'category' ? cat : t[key];
      if (got !== want) return `${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`;
    }
    return true;
  }, sms.body.slice(0, 90));
}

// --- Bank templates ---------------------------------------------------------

expectParse('HDFC UPI send',
  { sender: 'VM-HDFCBK', body: 'Sent Rs.449.00 From HDFC Bank A/C x1234 To SWIGGY On 12/07/25 Ref 512345678901 Not You? Call 18002586161' },
  { amount: 449, direction: 'debit', merchant: 'Swiggy', category: 'Food Delivery', bank: 'HDFC Bank', accountLast4: '1234', mode: 'upi' });

expectParse('HDFC card spend',
  { sender: 'VM-HDFCBK', body: 'Rs.2499.00 spent on HDFC Bank Card x4521 at AMAZON on 14-07-25. Avl Lmt INR 185000. Not you? Call 18002586161' },
  { amount: 2499, direction: 'debit', merchant: 'Amazon', category: 'Shopping', cardLast4: '4521', mode: 'card' });

expectParse('ICICI debit, counterparty credited',
  { sender: 'AD-ICICIB', body: 'ICICI Bank Acct XX789 debited for Rs 1250.00 on 15-Jul-25; ZOMATO credited. UPI:518234567890. Call 18002662 for dispute.' },
  { amount: 1250, direction: 'debit', merchant: 'Zomato', category: 'Food Delivery', bank: 'ICICI Bank' });

expectParse('SBI UPI transfer',
  { sender: 'JD-SBIINB', body: 'Dear UPI user A/C X5678 debited by 320.0 on date 16Jul25 trf to UBER INDIA Refno 519876543210. If not u? call 1800111109. -SBI' },
  { amount: 320, direction: 'debit', merchant: 'Uber', category: 'Transport', bank: 'SBI' });

expectParse('Axis card spend',
  { sender: 'AX-AXISBK', body: 'Spent Card no. XX8890 INR 1899 16-07-25 MYNTRA Avl Lmt INR 92000 SMS BLOCK 8890 to 919951860002' },
  { amount: 1899, direction: 'debit', merchant: 'Myntra', category: 'Shopping', bank: 'Axis Bank' });

expectParse('ATM withdrawal',
  { sender: 'VK-KOTAKB', body: 'Rs 5000.00 withdrawn from A/c XX3421 at ATM on 18-07-25. Avl Bal Rs 42350.75. Not you? Call 18602662666' },
  { amount: 5000, direction: 'debit', merchant: 'ATM Withdrawal', category: 'Cash Withdrawal', mode: 'atm', balance: 42350.75, needsReview: false });

expectParse('Salary credit',
  { sender: 'VM-HDFCBK', body: 'Rs.85000.00 credited to a/c XX1234 on 01-07-25 by NEFT SALARY ACME TECHNOLOGIES PVT LTD. Avl Bal Rs.127350.50' },
  { amount: 85000, direction: 'credit', category: 'Salary', balance: 127350.5 });

expectParse('Subscription debit',
  { sender: 'AD-ICICIB', body: 'Dear Customer, Rs.649.00 debited from ICICI Bank A/c XX789 on 05-Jul-25 towards NETFLIX subscription. Ref 512300099' },
  { amount: 649, merchant: 'Netflix', category: 'Entertainment', knownRecurring: true });

expectParse('SIP via VPA',
  { sender: 'VM-HDFCBK', body: 'Rs.5000.00 debited from a/c XX1234 on 05-07-25 to VPA sip@icicibank for SIP INVESTMENT. UPI Ref 512399887766' },
  { amount: 5000, category: 'Investment', vpa: 'sip@icicibank' });

expectParse('Loan EMI',
  { sender: 'AX-AXISBK', body: 'INR 18500.00 debited from A/c XX8890 on 07-07-25 towards HOME LOAN EMI. Ref 998877665544' },
  { amount: 18500, category: 'EMI', mode: 'emi' });

expectParse('Refund is a credit',
  { sender: 'AD-ICICIB', body: 'Rs 899.00 refunded to your ICICI Bank Card XX4521 by FLIPKART on 11-Jul-25. Ref 512366554433' },
  { amount: 899, direction: 'credit', merchant: 'Flipkart' });

// --- Rejections -------------------------------------------------------------

expectParse('OTP is rejected',
  { sender: 'VM-HDFCBK', body: 'OTP 483920 is your one time password for HDFC NetBanking. Valid for 10 mins. Do not share with anyone.' },
  { reject: true });

expectParse('Future-dated reminder is rejected',
  { sender: 'AD-ICICIB', body: 'Your EMI of Rs.18500 for Home Loan will be debited on 07-08-25. Please maintain sufficient balance.' },
  { reject: true });

expectParse('Declined transaction is rejected',
  { sender: 'VM-HDFCBK', body: 'Transaction of Rs.2500 at BIGBAZAAR was DECLINED due to insufficient balance on card XX4521.' },
  { reject: true });

expectParse('Loan promo is rejected',
  { sender: 'AX-AXISBK', body: 'Congratulations! You are pre-approved for a personal loan of Rs.5,00,000 at 10.5%. Click axisbank.in/pl to apply now.' },
  { reject: true });

expectParse('Collect request is rejected',
  { sender: 'VM-HDFCBK', body: 'ABC STORES is requesting Rs.500.00 via UPI. Approve only if you know the payee. Ref 512300123' },
  { reject: true });

expectParse('Balance enquiry is rejected',
  { sender: 'VM-HDFCBK', body: 'Available balance is Rs.42350.75 in your HDFC Bank A/c XX1234 as on 18-07-25.' },
  { reject: true });

// --- Regressions ------------------------------------------------------------
// Each of these encodes a bug that actually shipped.

expectParse('REGRESSION: "via IMPS" must not match the merchant "Vi"',
  { sender: 'VM-HDFCBK', body: 'Rs.24000.00 debited from a/c XX1234 on 02-07-25 via IMPS towards RENT PAYMENT. Ref 510000123456. Avl Bal Rs.74578.00' },
  { category: 'Rent' });

expectParse('REGRESSION: "credited" must not match the merchant "CRED"',
  { sender: 'VM-HDFCBK', body: 'Rs.1500.00 credited to a/c XX1234 on 03-07-25 by NEFT FROM RAHUL SHARMA. Avl Bal Rs.50000.00' },
  { direction: 'credit' });

check('REGRESSION: DOMINO still matches DOMINOS', () => {
  const m = lookupMerchant('DOMINOS');
  return m?.name === "Domino's Pizza" || `got ${m?.name}`;
});

check('REGRESSION: PAYTM matches PAYTMQR merchant strings', () => {
  const m = lookupMerchant('PAYTMQR2810050501011O3T2ZXQ7ZKB');
  return m?.name === 'Paytm' || `got ${m?.name}`;
});

check('REGRESSION: short pattern "VI" does not match "VIA"', () => {
  const m = lookupMerchant('PAID VIA IMPS');
  return m === null || `matched ${m?.name}`;
});

check('REGRESSION: balance is not mistaken for the amount', () => {
  const r = parseSms({ sender: 'VM-HDFCBK', body: 'Rs.250.00 debited from a/c XX1234 on 05-07-25 to SWIGGY. Avl Bal Rs.99999.00' });
  return r.txn.amount === 250 || `got ${r.txn.amount}`;
});

check('REGRESSION: credit limit is not mistaken for the amount', () => {
  const r = parseSms({ sender: 'AX-AXISBK', body: 'Spent Card no. XX8890 INR 1899 16-07-25 MYNTRA Avl Lmt INR 92000' });
  return r.txn.amount === 1899 || `got ${r.txn.amount}`;
});

check('REGRESSION: email addresses are not read as UPI VPAs', () => {
  const r = parseSms({ sender: 'VM-HDFCBK', body: 'Rs.500.00 debited from a/c XX1234 on 05-07-25 to SWIGGY. Query support@hdfcbank.com' });
  return r.txn.vpa === null || `got ${r.txn.vpa}`;
});

check('REGRESSION: numeric VPA handle is a person, not a merchant', () => {
  const r = parseSms({ sender: 'VM-HDFCBK', body: 'Rs.500.00 debited from a/c XX1234 on 05-07-25 to VPA 9876543210@ybl. UPI Ref 512300111' });
  return r.txn.merchant === 'Unknown' || `got ${r.txn.merchant}`;
});

// --- Dates ------------------------------------------------------------------

check('Date: day-first dd/mm/yy', () => {
  const r = parseSms({ sender: 'X', body: 'Sent Rs.100.00 From HDFC Bank A/C x1234 To SWIGGY On 03/04/25 Ref 1' });
  const d = new Date(r.txn.ts);
  return (d.getDate() === 3 && d.getMonth() === 3) || `got ${d.toDateString()}`;
});

check('Date: compact 16Jul25', () => {
  const r = parseSms({ sender: 'X', body: 'A/C X5678 debited by 320.0 on date 16Jul25 trf to UBER Refno 1' });
  const d = new Date(r.txn.ts);
  return (d.getDate() === 16 && d.getMonth() === 6) || `got ${d.toDateString()}`;
});

// --- Bank attribution -------------------------------------------------------

check('Bank: sender ID VM-HDFCBK', () => lookupBank('VM-HDFCBK') === 'HDFC Bank' || 'no match');
check('Bank: sender ID AD-ICICIB-S', () => lookupBank('AD-ICICIB-S') === 'ICICI Bank' || 'no match');
check('Bank: unknown sender returns null', () => lookupBank('ZZ-NOPE') === null || 'unexpected match');

// --- Duplicates -------------------------------------------------------------

check('Duplicates: same merchant + amount within minutes', () => {
  const base = Date.now();
  const txns = [
    { id: 'a', ts: base, amount: 500, merchant: 'Swiggy', direction: 'debit' },
    { id: 'b', ts: base + 60_000, amount: 500, merchant: 'Swiggy', direction: 'debit' },
    { id: 'c', ts: base + 60 * 60_000, amount: 500, merchant: 'Swiggy', direction: 'debit' },
  ];
  markDuplicates(txns);
  return (txns[1].duplicateOf === 'a' && txns[2].duplicateOf === null) || 'wrong flags';
});

check('Duplicates: shared reference ID is conclusive', () => {
  const base = Date.now();
  const txns = [
    { id: 'a', ts: base, amount: 500, merchant: 'Swiggy', direction: 'debit', refId: 'XYZ123456' },
    { id: 'b', ts: base + 5 * 3600_000, amount: 700, merchant: 'Zomato', direction: 'debit', refId: 'XYZ123456' },
  ];
  markDuplicates(txns);
  return txns[1].duplicateOf === 'a' || 'not flagged';
});

// --- Recurring --------------------------------------------------------------

check('Recurring: monthly subscription is detected', () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const txns = [0, 1, 2, 3].map((i) => ({
    id: `n${i}`, ts: now - (3 - i) * 30 * DAY, amount: 649, merchant: 'Netflix',
    direction: 'debit', category: 'Entertainment', knownRecurring: true,
  }));
  const found = detectRecurring(txns);
  const netflix = found.find((r) => r.merchant === 'Netflix');
  if (!netflix) return 'not detected';
  if (netflix.cadence !== 'monthly') return `cadence ${netflix.cadence}`;
  return netflix.nextDue > now || 'nextDue is in the past';
});

check('Recurring: irregular amounts at one merchant are not a subscription', () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const txns = [120, 890, 340, 1500].map((amount, i) => ({
    id: `s${i}`, ts: now - (3 - i) * 30 * DAY, amount, merchant: 'Corner Shop',
    direction: 'debit', category: 'Groceries', knownRecurring: false,
  }));
  return detectRecurring(txns).length === 0 || 'falsely detected';
});

check('Recurring: two visits are not enough for an unknown merchant', () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const txns = [0, 1].map((i) => ({
    id: `t${i}`, ts: now - (1 - i) * 30 * DAY, amount: 500, merchant: 'Some Shop',
    direction: 'debit', category: 'Shopping', knownRecurring: false,
  }));
  return detectRecurring(txns).length === 0 || 'falsely detected';
});

check('REGRESSION: rent is a commitment, not a cancellable subscription', () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const txns = [0, 1, 2, 3].map((i) => ({
    id: `r${i}`, ts: now - (3 - i) * 30 * DAY, amount: 24000, merchant: 'Rent',
    direction: 'debit', category: 'Rent', knownRecurring: false,
  }));
  const r = detectRecurring(txns)[0];
  if (!r) return 'not detected at all';
  return (r.isCommitment === true && r.isSubscription === false) || `isCommitment=${r.isCommitment} isSubscription=${r.isSubscription}`;
});

check('Netflix is a subscription, not a commitment', () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const txns = [0, 1, 2].map((i) => ({
    id: `x${i}`, ts: now - (2 - i) * 30 * DAY, amount: 649, merchant: 'Netflix',
    direction: 'debit', category: 'Entertainment', knownRecurring: true,
  }));
  const r = detectRecurring(txns)[0];
  if (!r) return 'not detected';
  return (r.isSubscription === true && r.isCommitment === false) || `isSubscription=${r.isSubscription}`;
});

// --- Forecast ---------------------------------------------------------------

check('Forecast: projection is at least what has been spent', () => {
  const now = Date.now();
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
  const txns = [1, 2, 3].map((i) => ({
    id: `f${i}`, ts: monthStart + i * 86_400_000, amount: 1000, merchant: 'Shop',
    direction: 'debit', category: 'Shopping',
  }));
  const f = forecastMonth(txns, [], now);
  return f.projected >= f.spentSoFar || `projected ${f.projected} < spent ${f.spentSoFar}`;
});

// --- Query parsing ----------------------------------------------------------

check('Query: "food last month" resolves a category and a period', () => {
  const q = parseQuery('how much did I spend on food last month');
  // Coerce explicitly: `a && b && c` yields the last truthy value, not `true`.
  return Boolean(q.category === 'Food Delivery' && q.from && q.to) || JSON.stringify(q);
});

check('Query: "above 1000" sets a minimum', () => {
  const q = parseQuery('restaurants above 1000');
  return q.minAmount === 1000 || `got ${q.minAmount}`;
});

check('Query: "upi" sets the payment mode', () => {
  const q = parseQuery('show all upi payments');
  return q.mode === 'upi' || `got ${q.mode}`;
});

// --- Render -----------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

document.getElementById('out').innerHTML = `
  <div class="summary" style="color:${failed ? 'var(--spend)' : 'var(--income)'}">
    ${passed} passed · ${failed} failed
  </div>
  <div class="card">
    ${results.map((r) => `
      <div class="case ${r.pass ? 'pass' : 'fail'}">
        <span class="mark">${r.pass ? '✓' : '✗'}</span>
        <span class="detail">
          <div>${r.name}</div>
          ${r.why ? `<div class="why">${r.why}</div>` : ''}
          ${r.detail ? `<div class="raw">${r.detail}</div>` : ''}
        </span>
      </div>`).join('')}
  </div>`;

// Machine-readable handle for automated checks.
window.testResults = { passed, failed, results };
console.log(`Kuber tests: ${passed} passed, ${failed} failed`);
