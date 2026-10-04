// 購入統計與手填匯率；HTML／手機共用，不連網、不改寫卡片資料。
export const RATE_STORAGE_KEY = 'bulba-exchange-rates-v1';
export const emptyRates = () => ({ NT: 1, JPY: null, USD: null });
export const PURCHASE_SORT_OPTIONS = [
  { value: 'date-desc', label: '購入日期：新 → 舊' },
  { value: 'date-asc', label: '購入日期：舊 → 新' },
  { value: 'price-desc', label: '價格：貴 → 便宜' },
  { value: 'price-asc', label: '價格：便宜 → 貴' },
  { value: 'currency', label: '幣別：NT → JPY → USD' },
];
const currencyOrder = ['NT', 'JPY', 'USD'];
const currencyRank = (currency) => {
  const index = currencyOrder.indexOf(currency);
  return index < 0 ? currencyOrder.length : index;
};

export function normalizeRates(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('匯率資料必須是物件');
  const rates = emptyRates();
  for (const currency of ['JPY', 'USD']) {
    const raw = input[currency];
    if (raw === '' || raw == null || (typeof raw === 'string' && !raw.trim())) continue;
    if (!['number', 'string'].includes(typeof raw)) throw new Error(`${currency} 匯率必須是正數或留空`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${currency} 匯率必須是正數或留空`);
    rates[currency] = value;
  }
  return rates;
}

export function loadRates(storage) {
  try { return normalizeRates(JSON.parse(storage.getItem(RATE_STORAGE_KEY)) ?? {}); }
  catch { return emptyRates(); }
}
export function saveRates(storage, input) {
  const rates = normalizeRates(input);
  storage.setItem(RATE_STORAGE_KEY, JSON.stringify(rates));
  return rates;
}

// 十進位整數運算：累加／換算後才四捨五入，避免 0.1 + 0.2 的誤差。
const decimal = (value) => {
  if (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value))) return null;
  const text = String(value).trim();
  if (text.length > 400) return null;
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? match[3] ?? '';
  let scale = fraction.length - Number(match[4] ?? 0);
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 400) return null;
  let units = BigInt((match[1] ?? '0') + fraction);
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  return { units, scale };
};
const add = (a, b) => {
  const scale = Math.max(a.scale, b.scale);
  return { units: a.units * 10n ** BigInt(scale - a.scale) + b.units * 10n ** BigInt(scale - b.scale), scale };
};
const multiply = (a, b) => ({ units: a.units * b.units, scale: a.scale + b.scale });
const compare = (a, b) => {
  const scale = Math.max(a.scale, b.scale);
  const left = a.units * 10n ** BigInt(scale - a.scale);
  const right = b.units * 10n ** BigInt(scale - b.scale);
  return left < right ? -1 : left > right ? 1 : 0;
};
const zero = () => ({ units: 0n, scale: 0 });
const moneyText = (value) => {
  let cents;
  if (value.scale <= 2) cents = value.units * 10n ** BigInt(2 - value.scale);
  else {
    const divisor = 10n ** BigInt(value.scale - 2);
    cents = (value.units + divisor / 2n) / divisor;
  }
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
};
export const displayMoney = (text) => String(text).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export const purchaseAmountText = (value) => {
  const amount = decimal(value);
  return amount ? displayMoney(moneyText(amount)) : '金額無效';
};

export function purchaseSummary(sourceRows, inputRates = emptyRates(), sort = 'price-desc') {
  if (!PURCHASE_SORT_OPTIONS.some((option) => option.value === sort)) sort = 'price-desc';
  const rates = normalizeRates(inputRates);
  const rows = [];
  const invalidRows = [];
  const totals = new Map();
  const counts = new Map();
  const prices = new Map();
  let twd = zero();
  const unconverted = new Map();
  for (const row of sourceRows) {
    if (row.狀態 !== '已收藏' || row.購入價 == null || String(row.購入價).trim() === '') continue;
    const amount = decimal(row.購入價);
    if (!amount) { invalidRows.push(row); continue; }
    rows.push(row);
    const currency = String(row.幣別 ?? '').trim().toUpperCase() || '(未填幣別)';
    totals.set(currency, add(totals.get(currency) ?? zero(), amount));
    counts.set(currency, (counts.get(currency) ?? 0) + 1);
    const rate = Object.hasOwn(rates, currency) ? rates[currency] : null;
    const converted = rate == null ? null : multiply(amount, decimal(rate));
    prices.set(row, { amount, currency, converted });
    if (rate == null) unconverted.set(currency, (unconverted.get(currency) ?? 0) + 1);
    else twd = add(twd, converted);
  }
  // 日期空白永遠置後；價格以未四捨五入的台幣估值比，缺匯率置後。
  // 幣別固定 NT → JPY → USD，同幣別以原額降序，不需要匯率。
  rows.sort((a, b) => {
    const left = prices.get(a), right = prices.get(b);
    let order = 0;
    if (sort.startsWith('date-')) {
      const aDate = String(a.購入日 ?? ''), bDate = String(b.購入日 ?? '');
      if (!aDate || !bDate) order = aDate ? -1 : bDate ? 1 : 0;
      else order = sort === 'date-asc' ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
    } else if (sort === 'currency') {
      order = currencyRank(left.currency) - currencyRank(right.currency)
        || left.currency.localeCompare(right.currency) || compare(right.amount, left.amount);
    }
    if (order) return order;
    const direction = sort === 'price-asc' ? 1 : -1;
    if (left.converted && right.converted) order = direction * compare(left.converted, right.converted);
    else if (left.converted || right.converted) order = left.converted ? -1 : 1;
    else order = left.currency.localeCompare(right.currency) || direction * compare(left.amount, right.amount);
    return order || String(b.購入日 ?? '').localeCompare(String(a.購入日 ?? '')) || a.RowKey.localeCompare(b.RowKey);
  });
  return {
    rows, invalidRows, rates, twd: moneyText(twd),
    totals: [...totals].map(([currency, amount]) => ({ currency, total: moneyText(amount), count: counts.get(currency) })),
    unconverted: [...unconverted].map(([currency, count]) => ({ currency, count })),
  };
}
