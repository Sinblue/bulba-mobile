// 卡種最愛：RowKey 前四段為單位；手機與本機共用格式與三方比對。
import { kindKeyFromRowKey } from './market_prices.mjs';
export const FAVORITES_FORMAT = 'bulba-favorites';
export const FAVORITES_VERSION = 1;
export const emptyFavorites = () => ({ format: FAVORITES_FORMAT, version: FAVORITES_VERSION, kindKeys: [] });

export function validateFavorites(data, allowedKinds = null) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['最愛資料必須是物件'];
  const errors = [];
  if (data.format !== FAVORITES_FORMAT || data.version !== FAVORITES_VERSION) errors.push('最愛資料格式或版本不正確');
  if (!Array.isArray(data.kindKeys)) return [...errors, 'kindKeys 必須是陣列'];
  const allowed = allowedKinds ? new Set(allowedKinds) : null;
  const seen = new Set();
  for (const key of data.kindKeys) {
    if (typeof key !== 'string' || key.split('|').length !== 4 || key.split('|').some((part) => !part)) errors.push('最愛卡種鍵格式不正確');
    else if (seen.has(key)) errors.push(`最愛卡種鍵重複：${key}`);
    else if (allowed && !allowed.has(key)) errors.push(`找不到最愛卡種：${key}`);
    seen.add(key);
  }
  if (data.revision !== undefined && typeof data.revision !== 'string') errors.push('最愛 revision 必須是文字');
  return errors;
}

export function currentFavoriteKeys(snapshot, pending = {}) {
  const keys = new Set(snapshot?.kindKeys ?? []);
  for (const change of Object.values(pending.favorites ?? {})) {
    if (change.next) keys.add(change.kindKey);
    else keys.delete(change.kindKey);
  }
  return keys;
}

/** 與一般篩選／搜尋交集使用，保留同卡種的全部個體列。 */
export const filterFavoriteRows = (rows, keys) => rows.filter((row) => keys.has(kindKeyFromRowKey(row.RowKey)));

/** 點星號後與快照相同就移除待回傳，避免無效變更。 */
export function recordFavoriteToggle(pending, snapshot, kindKey, at) {
  const base = (snapshot?.kindKeys ?? []).includes(kindKey);
  const next = !currentFavoriteKeys(snapshot, pending).has(kindKey);
  const favorites = { ...(pending.favorites ?? {}) };
  if (next === base) delete favorites[kindKey];
  else favorites[kindKey] = { kindKey, previous: base, next, at };
  return { ...pending, favorites };
}

export function validateFavoriteChanges(changes) {
  if (!Array.isArray(changes)) return ['favoriteChanges 必須是陣列'];
  const errors = [];
  const seen = new Set();
  for (const change of changes) {
    const key = change?.kindKey;
    if (typeof key !== 'string' || key.split('|').length !== 4 || key.split('|').some((part) => !part) || seen.has(key)) errors.push('最愛卡種鍵無效或重複');
    else seen.add(key);
    if (typeof change?.previous !== 'boolean' || typeof change?.next !== 'boolean' || change.previous === change.next) errors.push('最愛前後狀態不正確');
    if (typeof change?.at !== 'string' || !change.at) errors.push('最愛變更缺時間');
  }
  return errors;
}

export function planFavoriteChanges(kindKeys, changes, allowedKinds) {
  const current = new Set(kindKeys);
  const allowed = new Set(allowedKinds);
  return changes.map((change) => {
    const value = current.has(change.kindKey);
    const status = change.next && !allowed.has(change.kindKey) ? 'missing-kind'
      : value === change.next ? 'skipped' : value === change.previous ? 'apply' : 'conflict';
    return { change, current: value, status };
  });
}
