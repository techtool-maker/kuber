/**
 * Merchant recognition dictionary.
 *
 * Each entry maps noisy strings found in Indian bank SMS / UPI VPAs onto a
 * canonical merchant name plus a default category. Matching is done on a
 * normalised (uppercased, punctuation-stripped) form of the raw merchant text.
 *
 * `match` entries are plain substrings unless wrapped in /slashes/ (regex).
 * Order matters only within a tie: longer matches win, so "AMAZON PAY" beats
 * "AMAZON".
 */

export const MERCHANTS = [
  // ---- Food delivery & restaurants -------------------------------------
  { name: 'Swiggy',            category: 'Food Delivery',  match: ['SWIGGY', 'SWIGY', 'BUNDL'] },
  { name: 'Swiggy Instamart',  category: 'Groceries',      match: ['INSTAMART', 'SWIGGY INSTAMART'] },
  { name: 'Zomato',            category: 'Food Delivery',  match: ['ZOMATO', 'ZOMATOLTD'] },
  { name: 'Blinkit',           category: 'Groceries',      match: ['BLINKIT', 'GROFERS'] },
  { name: 'Zepto',             category: 'Groceries',      match: ['ZEPTO', 'GEDDIT'] },
  { name: "Domino's Pizza",    category: 'Restaurants',    match: ['DOMINO', 'JUBILANT FOOD'] },
  { name: "McDonald's",        category: 'Restaurants',    match: ['MCDONALD', 'MCD ', 'HARDCASTLE'] },
  { name: 'KFC',               category: 'Restaurants',    match: ['KFC', 'DEVYANI'] },
  { name: 'Starbucks',         category: 'Restaurants',    match: ['STARBUCKS', 'TATA STARBUCKS'] },
  { name: 'Chaayos',           category: 'Restaurants',    match: ['CHAAYOS'] },
  { name: "Barista",           category: 'Restaurants',    match: ['BARISTA'] },
  { name: 'Cafe Coffee Day',   category: 'Restaurants',    match: ['CAFE COFFEE', 'CCD ', 'COFFEE DAY'] },
  { name: 'EatSure',           category: 'Food Delivery',  match: ['EATSURE', 'FAASOS', 'REBEL FOODS'] },

  // ---- Groceries & daily needs -----------------------------------------
  { name: 'BigBasket',         category: 'Groceries',      match: ['BIGBASKET', 'BIG BASKET', 'INNOVATIVE RETAIL'] },
  { name: 'DMart',             category: 'Groceries',      match: ['DMART', 'D MART', 'AVENUE SUPERMART'] },
  { name: 'Reliance Fresh',    category: 'Groceries',      match: ['RELIANCE FRESH', 'RELIANCE RETAIL', 'RELIANCE SMART'] },
  { name: 'More Retail',       category: 'Groceries',      match: ['MORE RETAIL', 'MORE MEGASTORE'] },
  { name: 'Spencer\'s',        category: 'Groceries',      match: ['SPENCER'] },
  { name: 'Country Delight',   category: 'Groceries',      match: ['COUNTRY DELIGHT', 'CDELIGHT'] },
  { name: 'Licious',           category: 'Groceries',      match: ['LICIOUS'] },

  // ---- Shopping / e-commerce -------------------------------------------
  { name: 'Amazon',            category: 'Shopping',       match: ['AMAZON', 'AMZN', 'CLICKTECH'] },
  { name: 'Amazon Pay',        category: 'Transfer',       match: ['AMAZON PAY', 'AMAZONPAY', 'APAY'] },
  { name: 'Flipkart',          category: 'Shopping',       match: ['FLIPKART', 'FKRT', 'INSTAKART'] },
  { name: 'Myntra',            category: 'Shopping',       match: ['MYNTRA'] },
  { name: 'Ajio',              category: 'Shopping',       match: ['AJIO', 'RELIANCE TRENDS'] },
  { name: 'Meesho',            category: 'Shopping',       match: ['MEESHO', 'FASHNEAR'] },
  { name: 'Nykaa',             category: 'Beauty',         match: ['NYKAA', 'FSN ECOMMERCE'] },
  { name: 'IKEA',              category: 'Home',           match: ['IKEA'] },
  { name: 'Decathlon',         category: 'Shopping',       match: ['DECATHLON'] },
  { name: 'Croma',             category: 'Shopping',       match: ['CROMA', 'INFINITI RETAIL'] },
  { name: 'Reliance Digital',  category: 'Shopping',       match: ['RELIANCE DIGITAL'] },
  { name: 'Tata Cliq',         category: 'Shopping',       match: ['TATACLIQ', 'TATA CLIQ'] },
  { name: 'Lenskart',          category: 'Healthcare',     match: ['LENSKART'] },
  { name: 'Titan',             category: 'Shopping',       match: ['TITAN COMPANY', 'TANISHQ'] },

  // ---- Transport & travel ----------------------------------------------
  { name: 'Uber',              category: 'Transport',      match: ['UBER'] },
  { name: 'Ola',               category: 'Transport',      match: ['OLA ', 'OLACABS', 'ANI TECHNOLOGIES'] },
  { name: 'Rapido',            category: 'Transport',      match: ['RAPIDO', 'ROPPEN'] },
  { name: 'Namma Yatri',       category: 'Transport',      match: ['NAMMA YATRI', 'NAMMAYATRI'] },
  { name: 'IRCTC',             category: 'Travel',         match: ['IRCTC', 'INDIAN RAILWAY'] },
  { name: 'MakeMyTrip',        category: 'Travel',         match: ['MAKEMYTRIP', 'MMT ', 'MMYT'] },
  { name: 'Goibibo',           category: 'Travel',         match: ['GOIBIBO'] },
  { name: 'Cleartrip',         category: 'Travel',         match: ['CLEARTRIP'] },
  { name: 'Yatra',             category: 'Travel',         match: ['YATRA ONLINE', 'YATRA.COM'] },
  { name: 'IndiGo',            category: 'Travel',         match: ['INDIGO', 'INTERGLOBE'] },
  { name: 'Air India',         category: 'Travel',         match: ['AIR INDIA', 'AIRINDIA'] },
  { name: 'Vistara',           category: 'Travel',         match: ['VISTARA', 'TATA SIA'] },
  { name: 'RedBus',            category: 'Travel',         match: ['REDBUS', 'PILANI SOFT'] },
  { name: 'OYO',               category: 'Travel',         match: ['OYO ', 'ORAVEL'] },
  { name: 'Airbnb',            category: 'Travel',         match: ['AIRBNB'] },
  { name: 'FASTag',            category: 'Transport',      match: ['FASTAG', 'NETC', 'NHAI', 'TOLL'] },
  { name: 'Delhi Metro',       category: 'Transport',      match: ['DMRC', 'DELHI METRO'] },
  { name: 'Namma Metro',       category: 'Transport',      match: ['BMRCL', 'NAMMA METRO'] },

  // ---- Fuel -------------------------------------------------------------
  { name: 'Indian Oil',        category: 'Fuel',           match: ['INDIAN OIL', 'INDIANOIL', 'IOCL', 'IOC '] },
  { name: 'HP Petrol',         category: 'Fuel',           match: ['HINDUSTAN PETROLEUM', 'HPCL', 'HP PETROL'] },
  { name: 'Bharat Petroleum',  category: 'Fuel',           match: ['BHARAT PETROLEUM', 'BPCL'] },
  { name: 'Shell',             category: 'Fuel',           match: ['SHELL '] },
  { name: 'Nayara',            category: 'Fuel',           match: ['NAYARA', 'ESSAR OIL'] },

  // ---- Entertainment & subscriptions ------------------------------------
  { name: 'Netflix',           category: 'Entertainment',  match: ['NETFLIX'],           recurring: true },
  { name: 'Amazon Prime',      category: 'Entertainment',  match: ['PRIME VIDEO', 'AMAZON PRIME'], recurring: true },
  { name: 'Spotify',           category: 'Entertainment',  match: ['SPOTIFY'],           recurring: true },
  { name: 'YouTube Premium',   category: 'Entertainment',  match: ['YOUTUBE', 'GOOGLE YOUTUBE'], recurring: true },
  { name: 'Disney+ Hotstar',   category: 'Entertainment',  match: ['HOTSTAR', 'DISNEY'], recurring: true },
  { name: 'JioCinema',         category: 'Entertainment',  match: ['JIOCINEMA'],         recurring: true },
  { name: 'SonyLIV',           category: 'Entertainment',  match: ['SONYLIV', 'SONY LIV'], recurring: true },
  { name: 'ZEE5',              category: 'Entertainment',  match: ['ZEE5'],              recurring: true },
  { name: 'Google One',        category: 'Utilities',      match: ['GOOGLE ONE', 'GOOGLE STORAGE'], recurring: true },
  { name: 'Google Play',       category: 'Entertainment',  match: ['GOOGLE PLAY', 'PLAYSTORE'] },
  { name: 'Apple',             category: 'Entertainment',  match: ['APPLE', 'ITUNES'],   recurring: true },
  { name: 'Microsoft 365',     category: 'Utilities',      match: ['MICROSOFT', 'MSFT '], recurring: true },
  { name: 'Adobe',             category: 'Utilities',      match: ['ADOBE'],             recurring: true },
  { name: 'OpenAI',            category: 'Utilities',      match: ['OPENAI', 'CHATGPT'], recurring: true },
  { name: 'Anthropic',         category: 'Utilities',      match: ['ANTHROPIC', 'CLAUDE.AI'], recurring: true },
  { name: 'BookMyShow',        category: 'Entertainment',  match: ['BOOKMYSHOW', 'BIGTREE'] },
  { name: 'PVR INOX',          category: 'Entertainment',  match: ['PVR', 'INOX'] },
  { name: 'Cult.fit',          category: 'Healthcare',     match: ['CULTFIT', 'CULT.FIT', 'CUREFIT'], recurring: true },

  // ---- Telecom / utilities ----------------------------------------------
  { name: 'Jio',               category: 'Recharge',       match: ['JIO ', 'RELIANCE JIO', 'JIOFIBER'], recurring: true },
  { name: 'Airtel',            category: 'Recharge',       match: ['AIRTEL', 'BHARTI AIRTEL'], recurring: true },
  { name: 'Vi',                category: 'Recharge',       match: ['VODAFONE', 'VI ', 'IDEA CELLULAR'], recurring: true },
  { name: 'BSNL',              category: 'Recharge',       match: ['BSNL'],              recurring: true },
  { name: 'ACT Fibernet',      category: 'Bills',          match: ['ACT FIBERNET', 'ATRIA'], recurring: true },
  { name: 'Tata Play',         category: 'Bills',          match: ['TATA PLAY', 'TATA SKY'], recurring: true },
  { name: 'Electricity Board', category: 'Utilities',      match: ['/\\b(BESCOM|MSEB|BSES|TNEB|TSSPDCL|APSPDCL|KSEB|PSPCL|UPPCL|MAHADISCOM|TORRENT POWER|ADANI ELECTRICITY)\\b/'], recurring: true },
  { name: 'Water Board',       category: 'Utilities',      match: ['BWSSB', 'DJB ', 'WATER BOARD'], recurring: true },
  { name: 'Gas',               category: 'Utilities',      match: ['INDANE', 'HP GAS', 'BHARATGAS', 'GAIL GAS', 'MAHANAGAR GAS', 'IGL '], recurring: true },

  // ---- Health -----------------------------------------------------------
  { name: 'Apollo Pharmacy',   category: 'Medical',        match: ['APOLLO'] },
  { name: 'PharmEasy',         category: 'Medical',        match: ['PHARMEASY', 'AXELIA'] },
  { name: '1mg',               category: 'Medical',        match: ['1MG', 'TATA 1MG'] },
  { name: 'Netmeds',           category: 'Medical',        match: ['NETMEDS'] },
  { name: 'Practo',            category: 'Healthcare',     match: ['PRACTO'] },
  { name: 'Fortis',            category: 'Medical',        match: ['FORTIS'] },
  { name: 'Max Healthcare',    category: 'Medical',        match: ['MAX HEALTHCARE', 'MAX HOSPITAL'] },
  { name: 'Manipal Hospital',  category: 'Medical',        match: ['MANIPAL'] },

  // ---- Education --------------------------------------------------------
  { name: 'Byju\'s',           category: 'Education',      match: ['BYJU', 'THINK AND LEARN'] },
  { name: 'Unacademy',         category: 'Education',      match: ['UNACADEMY', 'SORTING HAT'] },
  { name: 'Coursera',          category: 'Education',      match: ['COURSERA'],          recurring: true },
  { name: 'Udemy',             category: 'Education',      match: ['UDEMY'] },
  { name: 'Vedantu',           category: 'Education',      match: ['VEDANTU'] },

  // ---- Wallets / payment rails ------------------------------------------
  { name: 'Paytm',             category: 'Transfer',       match: ['PAYTM', 'ONE97'] },
  { name: 'PhonePe',           category: 'Transfer',       match: ['PHONEPE', 'PHONE PE'] },
  { name: 'Google Pay',        category: 'Transfer',       match: ['GOOGLE PAY', 'GPAY', 'GOOGLE INDIA DIGITAL'] },
  { name: 'CRED',              category: 'Transfer',       match: ['CRED ', 'DREAMPLUG'] },
  { name: 'Mobikwik',          category: 'Transfer',       match: ['MOBIKWIK'] },
  { name: 'Razorpay',          category: 'Transfer',       match: ['RAZORPAY', 'RAZOR PAY'] },
  { name: 'BharatPe',          category: 'Transfer',       match: ['BHARATPE'] },

  // ---- Investments ------------------------------------------------------
  { name: 'Zerodha',           category: 'Investment',     match: ['ZERODHA', 'ZERODHA BROKING'] },
  { name: 'Groww',             category: 'Investment',     match: ['GROWW', 'NEXTBILLION'] },
  { name: 'Upstox',            category: 'Investment',     match: ['UPSTOX', 'RKSV'] },
  { name: 'Angel One',         category: 'Investment',     match: ['ANGEL ONE', 'ANGEL BROKING'] },
  { name: 'Kuvera',            category: 'Investment',     match: ['KUVERA'] },
  { name: 'INDmoney',          category: 'Investment',     match: ['INDMONEY', 'INDWEALTH'] },
  { name: 'Coin by Zerodha',   category: 'Investment',     match: ['COIN ZERODHA'] },
  { name: 'SIP',               category: 'Investment',     match: ['SIP ', 'SYSTEMATIC INVESTMENT', 'NACH MF', 'BSE LTD MF', 'MF SIP'], recurring: true },
  { name: 'NPS',               category: 'Investment',     match: ['NPS ', 'NATIONAL PENSION'], recurring: true },
  { name: 'PPF',               category: 'Investment',     match: ['PPF '] },

  // ---- Insurance --------------------------------------------------------
  { name: 'LIC',               category: 'Insurance',      match: ['LIC ', 'LIFE INSURANCE CORP'], recurring: true },
  { name: 'HDFC Life',         category: 'Insurance',      match: ['HDFC LIFE'],         recurring: true },
  { name: 'ICICI Prudential',  category: 'Insurance',      match: ['ICICI PRU'],         recurring: true },
  { name: 'SBI Life',          category: 'Insurance',      match: ['SBI LIFE'],          recurring: true },
  { name: 'Star Health',       category: 'Insurance',      match: ['STAR HEALTH'],       recurring: true },
  { name: 'HDFC Ergo',         category: 'Insurance',      match: ['HDFC ERGO'],         recurring: true },
  { name: 'Bajaj Allianz',     category: 'Insurance',      match: ['BAJAJ ALLIANZ'],     recurring: true },
  { name: 'Acko',              category: 'Insurance',      match: ['ACKO'],              recurring: true },
  { name: 'PolicyBazaar',      category: 'Insurance',      match: ['POLICYBAZAAR', 'ETECHACES'] },
];

/**
 * Sender-ID → bank name. Indian SMS sender IDs look like `VM-HDFCBK` or
 * `AD-ICICIB-S`; we test against the alphabetic core.
 */
export const BANK_SENDERS = {
  HDFCBK: 'HDFC Bank',    HDFCBN: 'HDFC Bank',
  ICICIB: 'ICICI Bank',   ICICIT: 'ICICI Bank',
  SBIINB: 'SBI',          SBIUPI: 'SBI',        ATMSBI: 'SBI',   SBICRD: 'SBI Card',   SBIPSG: 'SBI',
  AXISBK: 'Axis Bank',    AXISBL: 'Axis Bank',
  KOTAKB: 'Kotak Bank',   KOTAK: 'Kotak Bank',
  IDFCFB: 'IDFC First',   IDFCBK: 'IDFC First',
  YESBNK: 'Yes Bank',
  INDUSB: 'IndusInd Bank',
  PNBSMS: 'Punjab National Bank', PNBBNK: 'Punjab National Bank',
  CANBNK: 'Canara Bank',
  BOIIND: 'Bank of India',
  UNIONB: 'Union Bank',
  CBSSBI: 'SBI',
  RBLBNK: 'RBL Bank',
  AUBANK: 'AU Small Finance',
  BOBTXN: 'Bank of Baroda', BOBSMS: 'Bank of Baroda',
  FEDBNK: 'Federal Bank',
  PAYTMB: 'Paytm Payments Bank',
  AIRTLB: 'Airtel Payments Bank',
  JUPITR: 'Jupiter',
  SLICEIT: 'Slice',
  ONECRD: 'OneCard',
  AMEXIN: 'American Express',
  CITIBK: 'Citibank',
  SCBANK: 'Standard Chartered',
  HSBCIN: 'HSBC',
};

/**
 * UPI handle → issuing bank/PSP. Used both to attribute the payment rail and
 * to strip the handle when deriving a merchant name from a VPA.
 */
export const UPI_HANDLES = {
  okhdfcbank: 'HDFC Bank', okicici: 'ICICI Bank', oksbi: 'SBI', okaxis: 'Axis Bank',
  ybl: 'PhonePe', ibl: 'PhonePe', axl: 'PhonePe',
  paytm: 'Paytm', ptyes: 'Paytm', ptaxis: 'Paytm', ptsbi: 'Paytm', pthdfc: 'Paytm',
  apl: 'Amazon Pay', yapl: 'Amazon Pay', rapl: 'Amazon Pay',
  upi: 'UPI', hdfcbank: 'HDFC Bank', icici: 'ICICI Bank', sbi: 'SBI', axisbank: 'Axis Bank',
  kotak: 'Kotak Bank', kmbl: 'Kotak Bank', idfcbank: 'IDFC First', yesbank: 'Yes Bank',
  fbl: 'Federal Bank', indus: 'IndusInd Bank', jupiteraxis: 'Jupiter', slice: 'Slice',
  abfspay: 'Aditya Birla', timecosmos: 'CRED', naviaxis: 'Navi', superyes: 'Super.money',
};

/** Domains that must never be treated as a UPI VPA. */
export const EMAIL_TLDS = new Set(['com', 'in', 'org', 'net', 'co', 'io', 'gov', 'edu', 'info', 'me']);

const NORMALISE_RE = /[^A-Z0-9 ]+/g;

/** Uppercase + strip punctuation so dictionary matching is stable. */
export function normalise(text) {
  return String(text || '').toUpperCase().replace(NORMALISE_RE, ' ').replace(/\s+/g, ' ').trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Patterns at least this long may match the start of a longer word. */
const PREFIX_MIN = 5;

// Pre-compile the dictionary once at module load.
const COMPILED = MERCHANTS.map((m) => ({
  ...m,
  tests: m.match.map((pattern) => {
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const end = pattern.lastIndexOf('/');
      return { re: new RegExp(pattern.slice(1, end), pattern.slice(end + 1) || 'i'), len: pattern.length };
    }
    const text = normalise(pattern);
    // Word-boundary matching, not substring: space-padding used to let the
    // pattern "VI " match the "VIA" in "via IMPS", filing rent under recharge.
    //
    // Patterns from PREFIX_MIN characters up may still match a longer word, so
    // "DOMINO" catches "DOMINOS" and "PAYTM" catches "PAYTMQR2810". Shorter
    // ones must match exactly, because prefix-matching them is precisely what
    // caused the bug — and "CRED" would otherwise fire on every "credited".
    const anchor = text.length >= PREFIX_MIN ? '\\w*' : '\\b';
    return { re: new RegExp(`\\b${escapeRe(text)}${anchor}`), len: text.length };
  }),
}));

/**
 * Resolve a raw merchant fragment to a canonical merchant.
 * Returns `null` when nothing in the dictionary matches.
 *
 * @param {string} raw
 * @param {object} opts  `minLen` ignores short patterns. Callers matching
 *   against a whole SMS body pass a floor so three-letter names like KFC or
 *   LIC cannot fire on incidental words elsewhere in the message.
 */
export function lookupMerchant(raw, { minLen = 0 } = {}) {
  if (!raw) return null;
  const hay = ' ' + normalise(raw) + ' ';
  let best = null;

  for (const entry of COMPILED) {
    for (const test of entry.tests) {
      if (test.len < minLen) continue;
      if (test.re.test(hay) && (!best || test.len > best.len)) {
        best = { name: entry.name, category: entry.category, recurring: !!entry.recurring, len: test.len };
      }
    }
  }
  return best ? { name: best.name, category: best.category, recurring: best.recurring } : null;
}

/** Map a bank sender ID (e.g. `VM-HDFCBK-S`) to a readable bank name. */
export function lookupBank(sender) {
  if (!sender) return null;
  const parts = String(sender).toUpperCase().split(/[-_.]/).filter(Boolean);
  for (const part of parts) {
    const alpha = part.replace(/[^A-Z]/g, '');
    if (alpha.length >= 3 && BANK_SENDERS[alpha]) return BANK_SENDERS[alpha];
  }
  const whole = String(sender).toUpperCase().replace(/[^A-Z]/g, '');
  for (const [key, bank] of Object.entries(BANK_SENDERS)) {
    if (whole.includes(key)) return bank;
  }
  return null;
}
