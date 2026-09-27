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

// ── 手機變更（第 3 階段）──────────────────────────────
//
// 手機只記「變更」：edits＝現有列的 6 個使用者欄位（previous＝匯入資料的值、next＝手機改的值），
// additions＝手機新增的卡（copy＝同卡種多一張、new＝資料庫沒有的卡）。手機不算 RowKey／個體編號。
// 電腦端逐欄三方比對後，經 serve_collection 的 /api/save 寫入。細節見 plans/workorders/WO-003。

export const CHANGES_FORMAT = 'bulba-mobile-changes';
export const CHANGES_VERSION = 1;

/** 使用者管理的 6 個欄位與值域：電腦 serve_collection.mjs 與手機共用這一份。 */
export const USER_FIELDS = ['狀態', '購入價', '幣別', '購入日', '卡片狀態', '備註'];
export const CURRENCY_OPTIONS = ['', 'NT', 'JPY'];
export const CONDITION_OPTIONS = ['', '全新', '良好', '普通', '損傷'];
export const LANGUAGE_OPTIONS = ['日文', '繁中', '國際', '韓國'];
export const VARIANT_OPTIONS = ['', '初版', '大師球', '精靈球'];
const USER_FIELD_SET = new Set(USER_FIELDS);
const MAX_PHOTO_CHARS = 1_500_000;

export function isValidDate(value) {
  if (value === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 驗證並正規化使用者欄位（只含傳入的欄位）；不合規則就丟出錯誤。label 用於錯誤訊息。 */
export function normalizeUserFields(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label} 的 fields 必須是物件`);
  const keys = Object.keys(input);
  if (!keys.length) throw new Error(`${label} 沒有要儲存的欄位`);
  for (const key of keys) if (!USER_FIELD_SET.has(key)) throw new Error(`${label} 不允許修改「${key}」`);
  const out = {};
  for (const key of keys) {
    const value = input[key];
    if (key === '狀態') {
      if (typeof value !== 'string' || !STATUS.has(value)) throw new Error(`${label} 的狀態必須是 已收藏／要收藏／觀望`);
      out[key] = value;
    } else if (key === '購入價') {
      if (value === '' || value == null) out[key] = '';
      else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
      else throw new Error(`${label} 的購入價必須是 0 或正數`);
    } else if (key === '幣別') {
      if (typeof value !== 'string' || !CURRENCY_OPTIONS.includes(value)) throw new Error(`${label} 的幣別必須是 NT、JPY 或空白`);
      out[key] = value;
    } else if (key === '購入日') {
      if (typeof value !== 'string' || !isValidDate(value)) throw new Error(`${label} 的購入日不是有效日期`);
      out[key] = value;
    } else if (key === '卡片狀態') {
      if (typeof value !== 'string' || !CONDITION_OPTIONS.includes(value)) throw new Error(`${label} 的卡片狀態不是允許的選項`);
      out[key] = value;
    } else if (key === '備註') {
      if (typeof value !== 'string' || value.length > 2000) throw new Error(`${label} 的備註必須是 2,000 字以內文字`);
      out[key] = value;
    }
  }
  return out;
}

const sameValue = (a, b) => (a ?? '') === (b ?? '');
export const emptyPending = () => ({ edits: {}, additions: [], lastExportedAt: '' });

/**
 * 手機記一筆修改：baseRow 是匯入資料的列（改之前）。只保留和 baseRow 不同的欄位；
 * 全部改回原值就移除這筆。回傳新的 pending（不修改傳入的物件）。
 */
export function recordEdit(pending, baseRow, fields, at) {
  const normalized = normalizeUserFields(fields, baseRow.RowKey);
  const previous = {};
  const next = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (!sameValue(baseRow[key], value)) { previous[key] = baseRow[key] ?? ''; next[key] = value; }
  }
  const edits = { ...pending.edits };
  if (Object.keys(next).length) edits[baseRow.RowKey] = { previous, next, at };
  else delete edits[baseRow.RowKey];
  return { ...pending, edits };
}

const ADDITION_KEYS = {
  copy: new Set(['id', 'at', 'type', 'copyOf', '變體', 'photo', 'baseCount', ...USER_FIELDS]),
  new: new Set(['id', 'at', 'type', '官方代碼', '卡號', 'Language', '變體', '卡名', 'photo', ...USER_FIELDS]),
};
const plainText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[|\r\n]/.test(value);

/** 驗證一筆手機新增；回傳錯誤字串陣列。 */
export function validateAddition(addition) {
  if (!addition || typeof addition !== 'object' || Array.isArray(addition)) return ['新增資料必須是物件'];
  const label = `新增 ${addition.id || '(無 id)'}`;
  const allowed = ADDITION_KEYS[addition.type];
  if (!allowed) return [`${label} 的 type 必須是 copy 或 new`];
  const errors = [];
  if (typeof addition.id !== 'string' || !addition.id) errors.push(`${label} 缺 id`);
  for (const key of Object.keys(addition)) if (!allowed.has(key)) errors.push(`${label} 有不允許的欄位「${key}」`);
  if (addition.type === 'copy' && (typeof addition.copyOf !== 'string' || !addition.copyOf)) errors.push(`${label} 缺 copyOf`);
  if (addition.type === 'new') {
    if (!plainText(addition.官方代碼, 60)) errors.push(`${label} 的官方代碼不可空白、過長或包含分隔符號`);
    if (!plainText(addition.卡號, 40)) errors.push(`${label} 的卡號不可空白、過長或包含分隔符號`);
    if (!LANGUAGE_OPTIONS.includes(addition.Language)) errors.push(`${label} 的語言必須是日文、繁中、國際或韓國`);
    if (addition.卡名 !== undefined && (typeof addition.卡名 !== 'string' || addition.卡名.length > 100)) errors.push(`${label} 的卡名過長`);
  }
  if (!VARIANT_OPTIONS.includes(addition.變體 ?? '')) errors.push(`${label} 的變體不是允許的選項`);
  if (addition.photo !== undefined && (typeof addition.photo !== 'string' || !addition.photo.startsWith('data:image/')
      || addition.photo.length > MAX_PHOTO_CHARS)) errors.push(`${label} 的照片不是圖片或太大`);
  const fields = Object.fromEntries(USER_FIELDS.filter((key) => key in addition).map((key) => [key, addition[key]]));
  if (!('狀態' in fields)) errors.push(`${label} 缺狀態`);
  else try { normalizeUserFields(fields, label); } catch (error) { errors.push(error.message); }
  return errors;
}

/** 手機匯出變更檔。base＝手機目前匯入資料的 { sourceRevision, exportedAt }。 */
export function buildMobileChanges(pending, { base, exportedAt, exportId }) {
  return {
    format: CHANGES_FORMAT, version: CHANGES_VERSION, exportId, exportedAt, base,
    edits: Object.entries(pending.edits).map(([rowKey, edit]) => ({ rowKey, at: edit.at, previous: edit.previous, next: edit.next })),
    additions: pending.additions.map(({ baseCount, ...addition }) => addition),
  };
}

export function validateMobileChanges(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['不是有效的變更檔'];
  const errors = [];
  if (data.format !== CHANGES_FORMAT) errors.push(`format 應為 ${CHANGES_FORMAT}`);
  if (data.version !== CHANGES_VERSION) errors.push(`version 應為 ${CHANGES_VERSION}`);
  if (typeof data.exportId !== 'string' || !data.exportId) errors.push('缺 exportId');
  if (!Array.isArray(data.edits) || !Array.isArray(data.additions)) return [...errors, 'edits 與 additions 必須是陣列'];
  const rowKeys = new Set();
  for (const edit of data.edits) {
    if (!edit || typeof edit.rowKey !== 'string' || !edit.rowKey) { errors.push('有一筆變更缺 rowKey'); continue; }
    if (rowKeys.has(edit.rowKey)) errors.push(`變更的 rowKey 重複：${edit.rowKey}`);
    rowKeys.add(edit.rowKey);
    const previous = edit.previous && typeof edit.previous === 'object' ? edit.previous : null;
    const next = edit.next && typeof edit.next === 'object' ? edit.next : null;
    if (!previous || !next) { errors.push(`${edit.rowKey} 缺 previous 或 next`); continue; }
    const keys = Object.keys(next);
    if (!keys.length || keys.length !== Object.keys(previous).length || keys.some((key) => !(key in previous))) {
      errors.push(`${edit.rowKey} 的 previous 與 next 欄位不一致`);
    }
    try { normalizeUserFields(next, edit.rowKey); } catch (error) { errors.push(error.message); }
  }
  const ids = new Set();
  for (const addition of data.additions) {
    if (addition?.id && ids.has(addition.id)) errors.push(`新增 id 重複：${addition.id}`);
    if (addition?.id) ids.add(addition.id);
    errors.push(...validateAddition(addition));
  }
  return errors;
}

/**
 * 電腦端：一筆手機變更對上電腦目前的列（逐欄三方比對）。
 *   目前值 = next → skipped（已套用或兩邊改成一樣）；= previous → apply；其他 → conflicts。
 * currentRow 不存在時 missing 為 true。
 */
export function threeWay(currentRow, edit) {
  if (!currentRow) return { missing: true, apply: {}, skipped: [], conflicts: [] };
  const apply = {};
  const skipped = [];
  const conflicts = [];
  for (const [field, phone] of Object.entries(edit.next)) {
    const current = currentRow[field] ?? '';
    if (sameValue(current, phone)) skipped.push(field);
    else if (sameValue(current, edit.previous[field])) apply[field] = phone;
    else conflicts.push({ field, previous: edit.previous[field] ?? '', phone, current });
  }
  return { missing: false, apply, skipped, conflicts };
}

const mobileKind = (code, number, language, variant) => [`${code}-${number}`, code, language || '?', variant || '一般'].join('|');

/**
 * 手機顯示用資料：匯入資料 ＋ 待回傳變更。
 * edits 覆蓋欄位並標 pendingEdit；additions 轉成暫時列（RowKey 第五段為 m<id>，標 mobileId），
 * copy 併入同卡種、new 自成一個卡種。照片放進 thumbs（key 為 mobile:<id>）。不修改傳入的資料。
 */
export function applyPending(snapshot, pending) {
  const byKey = new Map(snapshot.rows.map((row) => [row.RowKey, row]));
  const byKind = new Map(snapshot.rows.map((row) => [kindKeyOf(row), row]));
  const rows = snapshot.rows.map((row) => {
    const edit = pending.edits[row.RowKey];
    return edit ? { ...row, ...edit.next, pendingEdit: true } : row;
  });
  const thumbs = { ...snapshot.thumbs };
  for (const addition of pending.additions) {
    const fields = Object.fromEntries(USER_FIELDS.map((key) => [key, addition[key] ?? '']));
    const photoKey = addition.photo ? `mobile:${addition.id}` : '';
    if (photoKey) thumbs[photoKey] = addition.photo;
    let row;
    if (addition.type === 'copy') {
      const source = byKey.get(addition.copyOf);
      if (!source) continue;
      const variant = addition.變體 ?? source.變體 ?? '';
      const kind = mobileKind(codeOf(source), source.卡號, source.Language, variant);
      const template = byKind.get(kind);
      row = { ...(template ?? source), ...fields, 變體: variant, 個體編號: '', thumb: photoKey || template?.thumb || '',
        RowKey: `${kind}|m${addition.id}` };
      if (!template) {
        row.卡圖URL = '';
        row.卡圖來源 = 'pending';
      }
    } else {
      const variant = addition.變體 ?? '';
      row = { ...Object.fromEntries(FIELDS.map((key) => [key, ''])), ...fields,
        卡名: addition.卡名 ?? '', 官方代碼: addition.官方代碼, 卡號: addition.卡號, Language: addition.Language, 變體: variant,
        thumb: photoKey,
        RowKey: `${mobileKind(addition.官方代碼, addition.卡號, addition.Language, variant)}|m${addition.id}` };
    }
    row.Name = `${row.卡名 || '(無卡名)'} ${codeOf(row)}-${row.卡號}（手機新增）`;
    rows.push({ ...row, mobileId: addition.id });
  }
  return { ...snapshot, rows, thumbs };
}

/** 主頁「只看待回傳」：包含待回傳修改的原列與手機新增／複製的暫時列。 */
export const pendingRows = (rows) => rows.filter((row) => row.pendingEdit || row.mobileId);

/** copy 新增在建立當下，該卡種（含變體）在匯入資料中的張數。 */
export function kindCountFor(rows, copyOf, variant) {
  const kind = [...String(copyOf).split('|').slice(0, 3), variant || '一般'].join('|');
  return rows.filter((row) => kindKeyOf(row) === kind).length;
}

/**
 * 電腦端：整份變更檔的 edits 對上目前資料，逐筆做三方比對。
 * 回傳 [{ rowKey, name, edit, missing, apply, skipped, conflicts }]，順序同變更檔。
 */
export function planMobileEdits(rows, edits) {
  const byKey = new Map(rows.map((row) => [row.RowKey, row]));
  return edits.map((edit) => {
    const row = byKey.get(edit.rowKey);
    return { rowKey: edit.rowKey, name: row?.Name ?? edit.rowKey, edit, ...threeWay(row, edit) };
  });
}

/**
 * 依比對結果與衝突選擇組出 /api/save 的 changes。
 * choices：{ 'RowKey|欄位': 'phone' | 'current' }；沒選的衝突一律保留電腦目前值（不改）。
 */
export function saveChangesFromPlan(plan, choices = {}) {
  return plan.flatMap((item) => {
    if (item.missing) return [];
    const fields = { ...item.apply };
    for (const conflict of item.conflicts) {
      if (choices[`${item.rowKey}|${conflict.field}`] === 'phone') fields[conflict.field] = conflict.phone;
    }
    return Object.keys(fields).length ? [{ rowKey: item.rowKey, fields }] : [];
  });
}
