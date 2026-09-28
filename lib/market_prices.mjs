// 市場價格觀察紀錄；與 migration.json 分開保存，手機與電腦共用欄位驗證。
// kindKey 是 RowKey 前四段；最後的個體編號不影響同卡種的市場價格。
export const MARKET_FORMAT = 'bulba-market-prices';
export const MARKET_VERSION = 1;
export const MARKET_CURRENCY_OPTIONS = ['NT', 'JPY', 'USD'];
export const emptyMarketPrices = () => ({ format: MARKET_FORMAT, version: MARKET_VERSION, records: [] });
export const kindKeyFromRowKey = (rowKey) => String(rowKey ?? '').split('|').slice(0, 4).join('|');

const recordFields = ['id', 'kindKey', 'date', 'currency', 'price', 'shop', 'note'];
export const sameMarketRecord = (a, b) => recordFields.every((key) => a?.[key] === b?.[key]);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeMarketRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('市場價格紀錄必須是物件');
  if (Object.keys(input).some((key) => !recordFields.includes(key))) throw new Error('市場價格紀錄有不允許的欄位');
  const { id, kindKey, date, currency, price, shop = '', note = '' } = input;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error('市場價格紀錄 id 不正確');
  if (typeof kindKey !== 'string' || kindKey.length > 250 || kindKey.split('|').length !== 4 ||
      kindKey.split('|').some((part) => !part)) throw new Error('市場價格紀錄卡種鍵不正確');
  if (!validDate(date)) throw new Error('市場價格日期不正確');
  if (typeof currency !== 'string' || !MARKET_CURRENCY_OPTIONS.includes(currency.toUpperCase())) throw new Error('市場價格幣值必須是 NT、JPY 或 USD');
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 1_000_000_000) throw new Error('市場價格必須是 0～1,000,000,000 的數字');
  if (typeof shop !== 'string' || shop.length > 200) throw new Error('市場價格商店最多 200 字');
  if (typeof note !== 'string' || note.length > 2000) throw new Error('市場價格備註最多 2,000 字');
  return { id, kindKey, date, currency: currency.toUpperCase(), price, shop, note };
}

export function validateMarketPrices(data, allowedKinds = null) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['市場價格資料不是物件'];
  if (data.format !== MARKET_FORMAT || data.version !== MARKET_VERSION) errors.push('市場價格資料版本不正確');
  if (!Array.isArray(data.records)) return [...errors, '市場價格 records 必須是陣列'];
  const allowed = allowedKinds ? new Set(allowedKinds) : null;
  const ids = new Set();
  data.records.forEach((record, index) => {
    try {
      const normalized = normalizeMarketRecord(record);
      if (ids.has(normalized.id)) errors.push(`市場價格 id 重複：${normalized.id}`);
      ids.add(normalized.id);
      if (allowed && !allowed.has(normalized.kindKey)) errors.push(`第 ${index + 1} 筆市場價格找不到卡種`);
    } catch (error) { errors.push(`第 ${index + 1} 筆市場價格：${error.message}`); }
  });
  return errors;
}

export function pricesForKind(records, kindKey) {
  return records.filter((record) => record.kindKey === kindKey)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

/** 手機暫記新增／修改；修改回匯入時的原值就移除待回傳。 */
export function recordMarketEdit(pending, base, next, at) {
  const normalized = normalizeMarketRecord(next);
  const previous = base ? normalizeMarketRecord(base) : null;
  if (previous && (previous.id !== normalized.id || previous.kindKey !== normalized.kindKey)) throw new Error('不能改變市場價格紀錄的卡種或 id');
  const edits = { ...(pending.marketPrices ?? {}) };
  if (previous && sameMarketRecord(previous, normalized)) delete edits[normalized.id];
  else edits[normalized.id] = { id: normalized.id, at, previous, next: normalized };
  return { ...pending, marketPrices: edits };
}

/** 三方比對：新增沒有 previous；既有紀錄只在電腦仍與手機原值一致時自動套用。 */
export function planMarketChanges(records, changes, allowedKinds) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const allowed = new Set(allowedKinds);
  return changes.map((change) => {
    const current = byId.get(change.id) ?? null;
    let status;
    if (!allowed.has(change.next.kindKey)) status = 'missing-kind';
    else if (current && sameMarketRecord(current, change.next)) status = 'skipped';
    else if ((current === null && change.previous === null) ||
        (current && change.previous && sameMarketRecord(current, change.previous))) status = 'apply';
    else status = 'conflict';
    return { change, current, status };
  });
}
