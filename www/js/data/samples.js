/**
 * Demo corpus generator.
 *
 * Produces ~4 months of realistic Indian bank SMS across many different bank
 * templates so the parser, recurring detection, forecasting and budgeting all
 * have something meaningful to chew on before the user imports their own data.
 *
 * Also doubles as the regression fixture: `TEMPLATE_SAMPLES` covers one message
 * per known bank format, which is what `tests.js` asserts against.
 */

const DAY = 86_400_000;

/** One canonical message per bank template we claim to support. */
export const TEMPLATE_SAMPLES = [
  { sender: 'VM-HDFCBK', body: 'Sent Rs.449.00 From HDFC Bank A/C x1234 To SWIGGY On 12/07/25 Ref 512345678901 Not You? Call 18002586161' },
  { sender: 'VM-HDFCBK', body: 'Rs.2499.00 spent on HDFC Bank Card x4521 at AMAZON on 14-07-25. Avl Lmt INR 185000. Not you? Call 18002586161' },
  { sender: 'AD-ICICIB', body: 'ICICI Bank Acct XX789 debited for Rs 1250.00 on 15-Jul-25; ZOMATO credited. UPI:518234567890. Call 18002662 for dispute.' },
  { sender: 'JD-SBIINB', body: 'Dear UPI user A/C X5678 debited by 320.0 on date 16Jul25 trf to UBER INDIA Refno 519876543210. If not u? call 1800111109. -SBI' },
  { sender: 'AX-AXISBK', body: 'Spent Card no. XX8890 INR 1899 16-07-25 MYNTRA Avl Lmt INR 92000 SMS BLOCK 8890 to 919951860002' },
  { sender: 'VK-KOTAKB', body: 'Rs 5000.00 withdrawn from A/c XX3421 at ATM on 18-07-25. Avl Bal Rs 42350.75. Not you? Call 18602662666' },
  { sender: 'VM-HDFCBK', body: 'Rs.85000.00 credited to a/c XX1234 on 01-07-25 by NEFT SALARY ACME TECHNOLOGIES PVT LTD. Avl Bal Rs.127350.50' },
  { sender: 'AD-ICICIB', body: 'Dear Customer, Rs.649.00 debited from ICICI Bank A/c XX789 on 05-Jul-25 towards NETFLIX subscription. Ref 512300099' },
  { sender: 'VM-HDFCBK', body: 'Rs.5000.00 debited from a/c XX1234 on 05-07-25 to VPA sip@icicibank for SIP INVESTMENT. UPI Ref 512399887766' },
  { sender: 'AX-AXISBK', body: 'INR 18500.00 debited from A/c XX8890 on 07-07-25 towards HOME LOAN EMI. Ref 998877665544. Avl Bal INR 74500.00' },
  { sender: 'VM-HDFCBK', body: 'Rs.1200.00 debited from a/c XX1234 on 09-07-25 to VPA bescom.bng@okaxis. UPI Ref 512377665544' },
  { sender: 'AD-ICICIB', body: 'Rs 899.00 refunded to your ICICI Bank Card XX4521 by FLIPKART on 11-Jul-25. Ref 512366554433' },
  // Messages that must be rejected.
  { sender: 'VM-HDFCBK', body: 'OTP 483920 is your one time password for HDFC NetBanking. Valid for 10 mins. Do not share with anyone.' },
  { sender: 'AD-ICICIB', body: 'Your EMI of Rs.18500 for Home Loan will be debited on 07-08-25. Please maintain sufficient balance.' },
  { sender: 'VM-HDFCBK', body: 'Transaction of Rs.2500 at BIGBAZAAR was DECLINED due to insufficient balance on card XX4521.' },
  { sender: 'AX-AXISBK', body: 'Congratulations! You are pre-approved for a personal loan of Rs.5,00,000 at 10.5%. Click axisbank.in/pl to apply now.' },
];

// Weighted merchant pools, roughly matching real urban Indian spending mix.
const DAILY_POOL = [
  { m: 'SWIGGY', w: 14, min: 180, max: 750, tpl: 'upi' },
  { m: 'ZOMATO', w: 10, min: 200, max: 800, tpl: 'upi' },
  { m: 'BLINKIT', w: 9, min: 150, max: 900, tpl: 'upi' },
  { m: 'ZEPTO', w: 6, min: 120, max: 700, tpl: 'upi' },
  { m: 'UBER INDIA', w: 11, min: 90, max: 480, tpl: 'sbi' },
  { m: 'RAPIDO', w: 5, min: 45, max: 180, tpl: 'upi' },
  { m: 'AMAZON', w: 8, min: 299, max: 4500, tpl: 'card' },
  { m: 'FLIPKART', w: 5, min: 349, max: 3200, tpl: 'card' },
  { m: 'MYNTRA', w: 3, min: 799, max: 3500, tpl: 'axis' },
  { m: 'BIGBASKET', w: 5, min: 600, max: 2800, tpl: 'icici' },
  { m: 'DMART', w: 4, min: 800, max: 3400, tpl: 'card' },
  { m: 'INDIAN OIL', w: 6, min: 500, max: 2500, tpl: 'card' },
  { m: 'STARBUCKS', w: 4, min: 250, max: 620, tpl: 'card' },
  { m: 'DOMINOS', w: 4, min: 300, max: 900, tpl: 'upi' },
  { m: 'APOLLO PHARMACY', w: 3, min: 150, max: 1800, tpl: 'upi' },
  { m: 'PHARMEASY', w: 2, min: 300, max: 2200, tpl: 'upi' },
  { m: 'BOOKMYSHOW', w: 2, min: 350, max: 1400, tpl: 'card' },
  { m: 'DECATHLON', w: 2, min: 900, max: 4800, tpl: 'card' },
  { m: 'NYKAA', w: 2, min: 450, max: 2600, tpl: 'card' },
  { m: 'IRCTC', w: 2, min: 450, max: 3200, tpl: 'icici' },
  { m: 'FASTAG RECHARGE', w: 3, min: 200, max: 1000, tpl: 'upi' },
  { m: 'CAFE COFFEE DAY', w: 3, min: 180, max: 480, tpl: 'upi' },
];

/** Fixed-cadence items — these are what recurring detection should find. */
const RECURRING_POOL = [
  { m: 'NETFLIX', amount: 649, day: 5, tpl: 'towards' },
  { m: 'SPOTIFY', amount: 119, day: 8, tpl: 'towards' },
  { m: 'AMAZON PRIME', amount: 299, day: 14, tpl: 'towards' },
  { m: 'GOOGLE ONE', amount: 210, day: 19, tpl: 'towards' },
  { m: 'CULTFIT', amount: 1499, day: 3, tpl: 'towards' },
  { m: 'AIRTEL', amount: 899, day: 11, tpl: 'upi' },
  { m: 'ACT FIBERNET', amount: 1180, day: 6, tpl: 'upi' },
  { m: 'BESCOM', amount: 0, day: 9, tpl: 'upi', vary: [900, 2400] },
  { m: 'SIP INVESTMENT', amount: 5000, day: 5, tpl: 'sip' },
  { m: 'CAR LOAN EMI', amount: 12500, day: 7, tpl: 'emi' },
  { m: 'STAR HEALTH', amount: 2450, day: 22, tpl: 'towards' },
  { m: 'RENT PAYMENT', amount: 24000, day: 2, tpl: 'imps' },
];

// Deterministic PRNG so the demo dataset is identical on every load — the same
// mulberry32 used elsewhere in these projects.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtSlash(d) { return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`; }
function fmtDash(d) { return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${String(d.getFullYear()).slice(2)}`; }
function fmtMon(d) { return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`; }
function fmtCompact(d) { return `${pad(d.getDate())}${MONTHS[d.getMonth()]}${String(d.getFullYear()).slice(2)}`; }

/** Render one transaction in a randomly chosen bank's template. */
function renderSms(tpl, { merchant, amount, date, ref, balance }) {
  const amt = amount.toFixed(2);
  switch (tpl) {
    case 'upi':
      return { sender: 'VM-HDFCBK', body: `Sent Rs.${amt} From HDFC Bank A/C x1234 To ${merchant} On ${fmtSlash(date)} Ref ${ref} Not You? Call 18002586161` };
    case 'card':
      return { sender: 'VM-HDFCBK', body: `Rs.${amt} spent on HDFC Bank Card x4521 at ${merchant} on ${fmtDash(date)}. Avl Lmt INR ${(200000 - amount).toFixed(0)}. Not you? Call 18002586161` };
    case 'icici':
      return { sender: 'AD-ICICIB', body: `ICICI Bank Acct XX789 debited for Rs ${amt} on ${fmtMon(date)}; ${merchant} credited. UPI:${ref}. Call 18002662 for dispute.` };
    case 'sbi':
      return { sender: 'JD-SBIINB', body: `Dear UPI user A/C X5678 debited by ${amt} on date ${fmtCompact(date)} trf to ${merchant} Refno ${ref}. If not u? call 1800111109. -SBI` };
    case 'axis':
      return { sender: 'AX-AXISBK', body: `Spent Card no. XX8890 INR ${amount.toFixed(0)} ${fmtDash(date)} ${merchant} Avl Lmt INR 92000 SMS BLOCK 8890 to 919951860002` };
    case 'towards':
      return { sender: 'AD-ICICIB', body: `Dear Customer, Rs.${amt} debited from ICICI Bank A/c XX789 on ${fmtMon(date)} towards ${merchant} subscription. Ref ${ref}` };
    case 'sip':
      return { sender: 'VM-HDFCBK', body: `Rs.${amt} debited from a/c XX1234 on ${fmtDash(date)} to VPA sip@icicibank for ${merchant}. UPI Ref ${ref}` };
    case 'emi':
      return { sender: 'AX-AXISBK', body: `INR ${amt} debited from A/c XX8890 on ${fmtDash(date)} towards ${merchant}. Ref ${ref}` };
    case 'imps':
      return { sender: 'VM-HDFCBK', body: `Rs.${amt} debited from a/c XX1234 on ${fmtDash(date)} via IMPS towards ${merchant}. Ref ${ref}. Avl Bal Rs.${balance.toFixed(2)}` };
    case 'salary':
      return { sender: 'VM-HDFCBK', body: `Rs.${amt} credited to a/c XX1234 on ${fmtDash(date)} by NEFT SALARY ACME TECHNOLOGIES PVT LTD. Avl Bal Rs.${balance.toFixed(2)}` };
    case 'refund':
      return { sender: 'AD-ICICIB', body: `Rs ${amt} refunded to your ICICI Bank Card XX4521 by ${merchant} on ${fmtMon(date)}. Ref ${ref}` };
    // Balance is only ever reported on the primary HDFC account, so the demo
    // has one coherent running balance rather than four contradictory ones.
    case 'atm':
      return { sender: 'VM-HDFCBK', body: `Rs ${amt} withdrawn from A/c XX1234 at ATM on ${fmtDash(date)}. Avl Bal Rs ${balance.toFixed(2)}. Not you? Call 18002586161` };
    default:
      return { sender: 'VM-HDFCBK', body: `Rs.${amt} debited from a/c XX1234 on ${fmtDash(date)} to ${merchant}. Ref ${ref}` };
  }
}

/**
 * Build the demo corpus.
 * @param {number} months how far back to generate (default 4)
 */
export function generateDemoSms({ months = 4, seed = 20260719 } = {}) {
  const rand = mulberry32(seed);
  const now = new Date();
  const messages = [];
  let refCounter = 510000000000;
  const nextRef = () => String(refCounter += Math.floor(rand() * 9000) + 100);

  // Running balance, so the dashboard shows a plausible figure.
  let balance = 165000;
  // Salary is set well above the fixed commitments below (~₹38k of rent, EMI,
  // SIP, insurance and bills) so the demo shows a healthy positive savings
  // rate rather than a household quietly going broke.
  const SALARY = 145000;

  const start = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
  const totalPool = DAILY_POOL.reduce((a, m) => a + m.w, 0);

  for (let d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) {
    const date = new Date(d);
    const dayOfMonth = date.getDate();
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;

    // Salary on the 1st.
    if (dayOfMonth === 1) {
      balance += SALARY;
      messages.push({ ...renderSms('salary', { merchant: 'SALARY', amount: SALARY, date, ref: nextRef(), balance }), ts: date.getTime() + 10 * 3600_000 });
    }

    // Recurring items on their fixed day.
    for (const r of RECURRING_POOL) {
      if (r.day !== dayOfMonth) continue;
      const amount = r.vary
        ? Math.round(r.vary[0] + rand() * (r.vary[1] - r.vary[0]))
        : r.amount;
      balance -= amount;
      messages.push({ ...renderSms(r.tpl, { merchant: r.m, amount, date, ref: nextRef(), balance }), ts: date.getTime() + 9 * 3600_000 });
    }

    // ATM withdrawal roughly twice a month.
    if (dayOfMonth === 12 || dayOfMonth === 26) {
      const amount = [2000, 3000, 5000][Math.floor(rand() * 3)];
      balance -= amount;
      messages.push({ ...renderSms('atm', { merchant: 'ATM', amount, date, ref: nextRef(), balance }), ts: date.getTime() + 19 * 3600_000 });
    }

    // Discretionary spend: more on weekends.
    const count = Math.floor(rand() * (isWeekend ? 3 : 2)) + 1;
    for (let i = 0; i < count; i++) {
      let pick = rand() * totalPool;
      const choice = DAILY_POOL.find((m) => (pick -= m.w) <= 0) || DAILY_POOL[0];
      const amount = Math.round((choice.min + rand() * (choice.max - choice.min)) * 100) / 100;
      balance -= amount;
      const hour = 8 + Math.floor(rand() * 14);
      messages.push({
        ...renderSms(choice.tpl, { merchant: choice.m, amount, date, ref: nextRef(), balance }),
        ts: date.getTime() + hour * 3600_000 + Math.floor(rand() * 3600_000),
      });
    }

    // Occasional refund.
    if (rand() < 0.03) {
      const amount = Math.round((200 + rand() * 2500) * 100) / 100;
      balance += amount;
      messages.push({ ...renderSms('refund', { merchant: rand() < 0.5 ? 'FLIPKART' : 'AMAZON', amount, date, ref: nextRef(), balance }), ts: date.getTime() + 15 * 3600_000 });
    }

    // Noise: OTPs and promos the parser must reject.
    if (rand() < 0.25) {
      messages.push({ sender: 'VM-HDFCBK', body: `OTP ${Math.floor(100000 + rand() * 899999)} is your one time password for HDFC NetBanking. Valid for 10 mins. Do not share with anyone.`, ts: date.getTime() + 12 * 3600_000 });
    }
    if (rand() < 0.12) {
      messages.push({ sender: 'AX-AXISBK', body: 'Congratulations! You are pre-approved for a personal loan of Rs.5,00,000 at 10.5%. Click axisbank.in/pl to apply now.', ts: date.getTime() + 16 * 3600_000 });
    }

    // One deterministic double-charge on the 17th of each month, so duplicate
    // detection always has something real to catch in the demo.
    if (dayOfMonth === 17 && messages.length > 5) {
      const last = messages[messages.length - 1];
      messages.push({ ...last, ts: last.ts + 90_000 });
    }
  }

  return messages.sort((a, b) => a.ts - b.ts);
}
