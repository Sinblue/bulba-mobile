// 手機查詢資料的匯出格式與搜尋規則：電腦端匯出頁、手機頁與 Node 測試共用這一份。
// 純 ES module，不可 import node: 模組或瀏覽器專屬 API；mobile/ 會單獨部署，也不可 import scripts/lib/。
//
// 卡種身分直接取 RowKey 前四段（RowKey 由 scripts/lib/rowrules.mjs 產生，是唯一規則來源）。

export const FORMAT = 'bulba-mobile';
export const VERSION = 1;

/** 手機端需要的欄位；其他欄位（外部編號、稽核欄、本機路徑）一律不匯出。 */
export const FIELDS = [
  'RowKey', 'Name', '卡名', '妙蛙系列', '狀態', '個體編號', '共幾張',
  '官方代碼', '我的分類', '卡號', '全套張數', '發行日期', 'Language', '變體',
  '購入價', '幣別', '購入日', '卡片狀態', '備註', '卡圖URL', '資料來源', '卡圖來源',
];
const ALLOWED = new Set([...FIELDS, 'thumb']);
const STATUS = new Set(['已收藏', '要收藏', '觀望']);
export const LANGUAGE_ORDER = ['繁中', '日文', '國際', '韓國'];
export const VARIANT_ORDER = ['一般', '初版', '大師球', '精靈球'];

const orderOf = (list, value) => {
  const index = list.indexOf(value);
  return index < 0 ? list.length : index;
};
export const codeOf = (row) => row.官方代碼 || row.我的分類 || '';
export const variantOf = (row) => row.變體 || '一般';
/** 卡種鍵＝RowKey 去掉最後一段（個體編號）。 */
export const kindKeyOf = (row) => String(row.RowKey).split('|').slice(0, 4).join('|');

/** 全形轉半形並轉小寫；與本機目錄搜尋相同的 NFKC 正規化。 */
export const normalizeText = (value) => String(value ?? '').normalize('NFKC').toLowerCase();

/** 只用於比對：轉半形、去空白與前導零（"001"→"1"、66→"66"）。匯出與顯示仍保留原值。 */
export function normalizeNumber(value) {
  const text = normalizeText(value).trim();
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text;
}

// ── 匯出 ─────────────────────────────────────────────

export function buildMobileExport(rows, { revision, exportedAt, thumbs = {} }) {
  const used = {};
  const out = rows.map((row) => {
    const picked = Object.fromEntries(FIELDS.map((field) => [field, row[field] ?? '']));
    const key = row.卡圖 && thumbs[row.卡圖] ? row.卡圖 : '';
    if (key) used[key] = thumbs[key];
    return { ...picked, thumb: key };
  });
  return {
    format: FORMAT, version: VERSION, exportedAt, sourceRevision: revision,
    rowCount: out.length, rows: out, thumbs: used,
  };
}

export function validateMobileExport(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['不是有效的匯出物件'];
  if (data.format !== FORMAT) errors.push(`format 應為 ${FORMAT}`);
  if (data.version !== VERSION) errors.push(`version 應為 ${VERSION}`);
  if (!Array.isArray(data.rows)) return [...errors, 'rows 必須是陣列'];
  if (data.rowCount !== data.rows.length) errors.push(`rowCount ${data.rowCount} 與實際列數 ${data.rows.length} 不符`);
  const thumbs = data.thumbs && typeof data.thumbs === 'object' ? data.thumbs : null;
  if (!thumbs) errors.push('thumbs 必須是物件');
  else for (const [key, value] of Object.entries(thumbs)) {
    if (typeof value !== 'string' || !value.startsWith('data:image/')) errors.push(`縮圖 ${key} 不是圖片 data URL`);
  }
  const seen = new Set();
  data.rows.forEach((row, index) => {
    const label = row?.RowKey || `第 ${index + 1} 列`;
    if (!row || typeof row !== 'object') { errors.push(`第 ${index + 1} 列不是物件`); return; }
    if (typeof row.RowKey !== 'string' || !row.RowKey) errors.push(`第 ${index + 1} 列缺 RowKey`);
    else if (seen.has(row.RowKey)) errors.push(`RowKey 重複：${row.RowKey}`);
    else seen.add(row.RowKey);
    for (const key of Object.keys(row)) if (!ALLOWED.has(key)) errors.push(`${label} 有不允許的欄位「${key}」`);
    if (!STATUS.has(row.狀態)) errors.push(`${label} 的狀態不是 已收藏／要收藏／觀望`);
    if (!LANGUAGE_ORDER.includes(row.Language)) errors.push(`${label} 的 Language 不是 日文／繁中／國際／韓國`);
    if (row.thumb && thumbs && !(row.thumb in thumbs)) errors.push(`${label} 的縮圖 ${row.thumb} 不存在`);
  });
  return errors;
}

// ── 搜尋 ─────────────────────────────────────────────
//
// 規則只有一條：輸入切成詞，一列要「每個詞都中」才輸出，符合的全部列出、依相關度排序。
//   N/T     ：卡號＝N 且 全套張數＝T（去前導零比對）
//   純數字  ：等於卡號或全套張數
//   其他文字：包含於代碼、Name 或卡名
// 空白與 - 都是分隔符，所以 sv2a 1、SV2a-001、001/165、妙蛙 165 都走同一條規則。

export function tokenize(text) {
  const tokens = [];
  for (const chunk of normalizeText(text).split(/\s+/).filter(Boolean)) {
    const pair = chunk.match(/^(\d+)\/(\d+)$/);
    if (pair) { tokens.push({ kind: 'pair', number: normalizeNumber(pair[1]), total: normalizeNumber(pair[2]) }); continue; }
    for (const part of chunk.split('-').filter(Boolean)) {
      tokens.push(/^\d+$/.test(part) ? { kind: 'number', value: normalizeNumber(part) } : { kind: 'text', value: part });
    }
  }
  return tokens;
}

/** 回傳這列的相關分數；有任何一個詞沒中就回傳 0（不輸出）。 */
function scoreRow(row, tokens) {
  const number = normalizeNumber(row.卡號);
  const total = normalizeNumber(row.全套張數);
  const code = normalizeText(codeOf(row));
  const name = normalizeText(row.Name);
  const cardName = normalizeText(row.卡名);
  let score = 0;
  for (const token of tokens) {
    if (token.kind === 'pair') {
      if (token.number !== number || token.total !== total) return 0;
      score += 100;
    } else if (token.kind === 'number') {
      if (token.value === number) score += 30;
      else if (token.value === total) score += 10;
      else return 0;
    } else if (token.value === code) score += 20;
    else if (code.includes(token.value)) score += 10;
    else if (name.includes(token.value) || cardName.includes(token.value)) score += 5;
    else return 0;
  }
  return score;
}

export const priceText = (row) => (row.購入價 === '' || row.購入價 == null ? '' : `${row.購入價}${row.幣別 ? ` ${row.幣別}` : ''}`);
const kindLabel = (kind) => `${kind.language}${kind.variant === '一般' ? '' : kind.variant}`;
const byLanguageVariant = (a, b) =>
  orderOf(LANGUAGE_ORDER, a.language) - orderOf(LANGUAGE_ORDER, b.language)
  || orderOf(VARIANT_ORDER, a.variant) - orderOf(VARIANT_ORDER, b.variant);

/**
 * 把列依卡種（RowKey 前四段）合併：
 * { kindKey, code, number, total, cardName, language, variant, thumb, release, purchased, rows, ownedCount, statuses }
 * purchased 為該卡種最新的購入日。回傳順序為輸入列首次出現的順序。
 */
export function buildKinds(rows) {
  const kinds = new Map();
  for (const row of rows) {
    const key = kindKeyOf(row);
    let kind = kinds.get(key);
    if (!kind) {
      kind = {
        kindKey: key, code: codeOf(row), number: row.卡號, total: row.全套張數, cardName: row.卡名,
        language: row.Language, variant: variantOf(row), thumb: '', release: row.發行日期 || '', purchased: '', rows: [],
      };
      kinds.set(key, kind);
    }
    if (!kind.cardName && row.卡名) kind.cardName = row.卡名;
    if (!kind.thumb && row.thumb) kind.thumb = row.thumb;
    if (!kind.release && row.發行日期) kind.release = row.發行日期;
    if (row.購入日 && row.購入日 > kind.purchased) kind.purchased = row.購入日;
    kind.rows.push(row);
  }
  for (const kind of kinds.values()) {
    kind.rows.sort((a, b) => Number(a.個體編號) - Number(b.個體編號));
    kind.ownedCount = kind.rows.filter((row) => row.狀態 === '已收藏').length;
    kind.statuses = [...new Set(kind.rows.map((row) => row.狀態))];
  }
  return [...kinds.values()];
}

// ── 篩選與排序（與本機收藏目錄的選項一致） ─────────────────

export const STATUS_ORDER = ['已收藏', '要收藏', '觀望'];
export const SORT_OPTIONS = [
  ['發行日期', '發行日期（新到舊）'], ['發行日期-asc', '發行日期（舊到新）'],
  ['購入日', '購入日（新到舊）'], ['購入日-asc', '購入日（舊到新）'], ['語言', '語言'],
];
export const DEFAULT_FILTERS = { status: '', language: '', code: '', bulba: '', sort: '發行日期' };

/** 列層級篩選；bulba：'bulba'＝妙蛙系列、'other'＝其他。 */
export function filterRows(rows, { status = '', language = '', code = '', bulba = '' } = {}) {
  return rows.filter((row) => (!status || row.狀態 === status)
    && (!language || row.Language === language)
    && (!code || codeOf(row) === code)
    && (!bulba || (bulba === 'bulba' ? Boolean(row.妙蛙系列) : !row.妙蛙系列)));
}

/** 官方代碼依最早發行年份由新到舊分組，沒有年份的歸到最後的 Other（同本機目錄）。 */
export function codeGroups(rows) {
  const years = new Map();
  for (const row of rows) {
    const code = codeOf(row);
    if (!code) continue;
    const year = /^\d{4}-\d{2}$/.test(row.發行日期 || '') ? row.發行日期.slice(0, 4) : '';
    const previous = years.get(code);
    if (previous === undefined || (year && (!previous || year < previous))) years.set(code, year);
  }
  const groups = new Map();
  for (const [code, year] of years) {
    const label = year || 'Other';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(code);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === 'Other') - (b === 'Other') || b.localeCompare(a))
    .map(([label, codes]) => ({ label, codes: codes.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) }));
}

/** 瀏覽模式的卡種排序；日期不論方向，空白都放最後。 */
export function sortKinds(kinds, sort = '發行日期') {
  const text = (x, y) => String(x ?? '').localeCompare(String(y ?? ''), 'zh-Hant', { numeric: true });
  const field = sort.startsWith('購入日') ? 'purchased' : sort.startsWith('發行日期') ? 'release' : '';
  return [...kinds].sort((a, b) => {
    if (field) {
      const left = a[field];
      const right = b[field];
      if (left || right) {
        if (!left) return 1;
        if (!right) return -1;
        if (left !== right) return sort.endsWith('-asc') ? left.localeCompare(right) : right.localeCompare(left);
      }
    } else if (sort === '語言') {
      const result = orderOf(LANGUAGE_ORDER, a.language) - orderOf(LANGUAGE_ORDER, b.language);
      if (result) return result;
    }
    return text(a.code, b.code) || text(a.number, b.number) || byLanguageVariant(a, b);
  });
}

/**
 * 依「代碼＋卡號」分組回傳：
 * { tokens, multiSeries, groups: [{ code, number, total, cardName, score, owned, prices, kinds: [...] }] }
 * multiSeries：用 N/T 查詢而結果跨多個代碼（同卡號出現在不同系列），畫面須提示看卡面代碼確認。
 * 要套篩選時，先以 filterRows 過濾再傳入 rows，並把未篩選的全部列傳入 allRows：
 * 圖卡只顯示篩選後的卡種，但「已收藏」摘要與過往購入價一律依全部列計算，避免篩選造成「沒有收藏」的誤會。
 */
export function searchCards(rows, text, allRows = rows) {
  const tokens = tokenize(text);
  if (!tokens.length) return { tokens, multiSeries: false, groups: [] };
  const groups = new Map();
  for (const row of rows) {
    const score = scoreRow(row, tokens);
    if (!score) continue;
    const groupKey = `${codeOf(row)}|${normalizeNumber(row.卡號)}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { code: codeOf(row), number: row.卡號, total: row.全套張數, cardName: row.卡名, score: 0, rows: [] };
      groups.set(groupKey, group);
    }
    group.score = Math.max(group.score, score);
    if (!group.cardName && row.卡名) group.cardName = row.卡名;
    group.rows.push(row);
  }

  const fullGroups = new Map();
  if (allRows !== rows) {
    for (const row of allRows) {
      const groupKey = `${codeOf(row)}|${normalizeNumber(row.卡號)}`;
      if (groups.has(groupKey)) (fullGroups.get(groupKey) ?? fullGroups.set(groupKey, []).get(groupKey)).push(row);
    }
  }
  const list = [...groups.entries()].map(([groupKey, { rows: groupRows, ...group }]) => {
    const kinds = buildKinds(groupRows).sort(byLanguageVariant);
    const allKinds = fullGroups.has(groupKey) ? buildKinds(fullGroups.get(groupKey)).sort(byLanguageVariant) : kinds;
    const prices = allKinds.flatMap((kind) => kind.rows.filter((row) => priceText(row)).map((row) => ({
      language: kind.language, variant: kind.variant, price: priceText(row), date: row.購入日 || '',
    })));
    return { ...group, kinds, owned: allKinds.filter((kind) => kind.ownedCount).map(kindLabel), prices };
  }).sort((a, b) => b.score - a.score
    || a.code.localeCompare(b.code, 'en', { numeric: true })
    || Number(normalizeNumber(a.number)) - Number(normalizeNumber(b.number)));

  const multiSeries = tokens.some((token) => token.kind === 'pair') && new Set(list.map((group) => group.code)).size > 1;
  return { tokens, multiSeries, groups: list };
}
