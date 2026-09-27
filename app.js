// 妙蛙收藏查詢（手機第 0～3 階段）：離線。資料由電腦匯出檔匯入，存在這支手機的 IndexedDB。
// 第 1 階段：拍照用卡圖比對收藏（比對在 scan_worker.js，規則在 lib/card_match.mjs）。
// 第 3 階段：手機上的修改只存在 pending（不動匯入資料），畫面顯示「匯入資料＋待回傳」；匯出變更檔交給電腦套用。
// 除了使用者主動點「開原圖」，不發出任何外部網路請求。
import {
  CURRENCY_OPTIONS, DEFAULT_FILTERS, LANGUAGE_OPTIONS, LANGUAGE_ORDER, SORT_OPTIONS, STATUS_ORDER,
  USER_FIELDS, VARIANT_OPTIONS, applyPending, buildKinds, buildMobileChanges, codeGroups, emptyPending, filterRows,
  kindCountFor, normalizeCodeSelection, pendingRows, recordEdit, searchCards, sortKinds, toggleCodeSelection,
  validateAddition, validateMobileChanges, validateMobileExport,
} from './lib/mobile_format.mjs';
import { MATCH_PARAMS, MATCH_VERSION, classifyMatches, matchGroups } from './lib/card_match.mjs';
import { kindKeyFromRowKey, normalizeMarketRecord, pricesForKind, recordMarketEdit } from './lib/market_prices.mjs';

const STALE_DAYS = 14;
const FILTER_STORAGE = 'bulba-mobile-filters';
const LANGUAGE_CLASS = { 日文: 'language-ja', 繁中: 'language-zh', 韓國: 'language-ko', 國際: 'language-int' };
const $ = (selector) => document.querySelector(selector);
const search = $('#search');
const results = $('#results');
const hint = $('#hint');
const empty = $('#empty');
const multiNote = $('#multi-note');
const preview = $('#preview');
const detail = $('#detail');
const filterToggle = $('#filter-toggle');
const filterPanel = $('#filters');
const pendingFilter = $('#f-pending');
const pendingMode = $('#pending-mode');
const controls = { status: $('#f-status'), language: $('#f-language'), bulba: $('#f-bulba'), sort: $('#f-sort') };
const codeFilter = $('#code-filter');
const codeButton = $('#f-code');
const codeMenu = $('#f-code-menu');
const scanInput = $('#scan');
const scanPick = $('#scan-pick');
const scanAlbum = $('#scan-album');
const scanStatus = $('#scan-status');
let data = null;       // 匯入資料（不修改）
let pending = emptyPending(); // 待回傳的修改與新增
let view = null;       // 顯示用：data ＋ pending
let pendingImport = null;
let filters = { ...DEFAULT_FILTERS };
let pendingOnly = false; // 暫時檢視模式，不寫入篩選偏好或待回傳資料
let scanResult = null; // { photo, pending, ms, groups, error }
let marketKindKey = '';
let editingMarket = null;
let marketKindKeys = new Set();

// ── IndexedDB：current＝目前資料，previous＝上一份 ──────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('bulba-mobile', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction('snapshots').objectStore('snapshots').get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}
async function dbPutMany(entries) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite');
    const store = tx.objectStore('snapshots');
    for (const [key, value] of entries) value === null ? store.delete(key) : store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── 篩選（記在這支手機的 localStorage，只是方便用，讀不到就用預設） ──

function loadFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_STORAGE) ?? 'null');
    if (saved && typeof saved === 'object') filters = { ...DEFAULT_FILTERS, ...saved, code: normalizeCodeSelection(saved.code) };
  } catch { filters = { ...DEFAULT_FILTERS, code: [] }; }
}
function saveFilters() {
  try { localStorage.setItem(FILTER_STORAGE, JSON.stringify(filters)); } catch { /* 無痕模式等情況略過 */ }
}

const option = (value, label = value) => element('option', { value, textContent: label });
function fillFilterOptions() {
  controls.status.replaceChildren(option('', '全部狀態'), ...STATUS_ORDER.map((status) => option(status)));
  const languages = [...new Set(view.rows.map((row) => row.Language))]
    .sort((a, b) => LANGUAGE_ORDER.indexOf(a) - LANGUAGE_ORDER.indexOf(b));
  controls.language.replaceChildren(option('', '全部語言'), ...languages.map((language) => option(language)));
  controls.sort.replaceChildren(...SORT_OPTIONS.map(([value, label]) => option(value, label)));
  for (const [key, select] of Object.entries(controls)) {
    const allowed = [...select.options].map((item) => item.value);
    if (!allowed.includes(filters[key])) filters[key] = DEFAULT_FILTERS[key];
    select.value = filters[key];
  }
}
function fillCodeMenu() {
  if (!view) return;
  const groups = codeGroups(view.rows);
  filters.code = normalizeCodeSelection(filters.code, groups.flatMap((group) => group.codes));
  codeButton.textContent = filters.code.length ? `已選 ${filters.code.length} 個代碼` : '全部官方代碼';
  const scroll = codeMenu.scrollTop;
  const clear = element('button', { type: 'button', className: 'code-clear', textContent: '全部官方代碼' });
  const sections = groups.map((group) => {
    const chosen = group.codes.filter((code) => filters.code.includes(code)).length;
    const groupInput = element('input', { type: 'checkbox', className: 'code-group-input', checked: chosen === group.codes.length });
    groupInput.dataset.group = group.label;
    groupInput.indeterminate = chosen > 0 && chosen < group.codes.length;
    const heading = element('label', { className: 'code-group-toggle' }, [groupInput, group.label]);
    const items = group.codes.map((code) => element('label', { className: 'code-option' }, [
      element('input', { type: 'checkbox', className: 'code-option-input', value: code, checked: filters.code.includes(code) }), code,
    ]));
    return element('section', { className: 'code-group' }, [heading, element('div', { className: 'code-options' }, items)]);
  });
  codeMenu.replaceChildren(clear, ...sections);
  codeMenu.scrollTop = scroll;
}
function setCodeMenuOpen(open) {
  codeMenu.hidden = !open;
  codeButton.setAttribute('aria-expanded', String(open));
  if (open) codeMenu.querySelector('input:checked, input, button')?.focus();
}
function activeFilterCount() {
  return Object.keys(controls).filter((key) => filters[key] !== DEFAULT_FILTERS[key]).length
    + Number(filters.code.length > 0) + Number(pendingOnly);
}
function updateFilterToggle() {
  const count = activeFilterCount();
  filterToggle.textContent = count ? `篩選 ${count}` : '篩選';
  filterToggle.classList.toggle('active', count > 0);
}
function updatePendingMode() {
  const count = view ? pendingRows(view.rows).length : 0;
  if (pendingOnly && count === 0) pendingOnly = false;
  pendingFilter.disabled = count === 0;
  pendingFilter.textContent = `只看待回傳 ${count}`;
  pendingFilter.setAttribute('aria-pressed', String(pendingOnly));
  pendingMode.hidden = !pendingOnly;
  $('#pending-mode-label').textContent = `只看待回傳 · ${count} 張`;
  updateFilterToggle();
}
function setPendingOnly(next) {
  pendingOnly = next;
  filters = { ...DEFAULT_FILTERS, code: [], sort: filters.sort };
  for (const [key, select] of Object.entries(controls)) select.value = filters[key];
  setCodeMenuOpen(false);
  fillCodeMenu();
  search.value = '';
  clearScan();
  saveFilters();
  updatePendingMode();
  filterPanel.hidden = true;
  filterToggle.setAttribute('aria-expanded', 'false');
  render();
}

// ── 畫面 ─────────────────────────────────────────────

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
const formatDate = (iso) => {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const daysSince = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));

function imageNode(key, className) {
  const src = key && view.thumbs[key];
  if (src) return element('img', { className, src, alt: '', loading: 'lazy', decoding: 'async' });
  return element('span', { className: `${className} placeholder`, textContent: '無圖' });
}

async function refreshInfo() {
  const info = $('#data-info');
  const ready = Boolean(data);
  search.disabled = !ready;
  filterToggle.disabled = !ready;
  scanInput.disabled = !ready;
  scanPick.disabled = !ready;
  scanAlbum.hidden = !ready;
  $('#add-button').disabled = !ready;
  $('#scan-button').classList.toggle('disabled', !ready);
  $('#welcome').hidden = ready;
  $('#restore').hidden = !(await dbGet('previous'));
  if (!ready) { info.textContent = '尚未匯入資料'; info.className = 'data-info'; return; }
  fillFilterOptions();
  updateFilterToggle();
  const days = daysSince(data.exportedAt);
  info.textContent = `資料匯出於 ${formatDate(data.exportedAt)}（${days === 0 ? '今天' : `${days} 天前`}）· ${data.rowCount} 列`
    + (days > STALE_DAYS ? ' · 資料可能已過期，建議重新匯出' : '');
  info.className = days > STALE_DAYS ? 'data-info stale' : 'data-info';
}

function badgeNode(kind) {
  if (kind.ownedCount) return element('span', { className: 'badge owned', textContent: `已收藏 ${kind.ownedCount} 張` });
  return element('span', { className: 'badge', textContent: kind.statuses.join('／') });
}

function tileNode(kind) {
  const tags = element('span', { className: 'tile-tags' }, [
    element('span', { className: `tile-lang ${LANGUAGE_CLASS[kind.language] ?? ''}`, textContent: kind.language }),
    kind.variant === '一般' ? '' : ` · ${kind.variant}`,
  ]);
  const priceMark = marketKindKeys.has(kind.kindKey) ? element('span', { className: 'tile-price-mark', textContent: '$' }) : '';
  if (priceMark) priceMark.setAttribute('aria-hidden', 'true');
  const tile = element('button', { className: 'tile', type: 'button' }, [
    imageNode(kind.thumb, 'tile-image'),
    element('span', { className: 'tile-copy' }, [
      element('span', { className: 'tile-name', textContent: kind.cardName || '待補卡名' }),
      element('span', { className: 'tile-code', textContent: `${kind.code}-${kind.number}` }),
      tags,
      badgeNode(kind),
      kind.rows.some((row) => row.pendingEdit || row.mobileId) ? element('span', { className: 'pending-mark', textContent: '待回傳' }) : '',
      priceMark,
    ]),
  ]);
  if (priceMark) tile.title = '有市場價格紀錄';
  tile.addEventListener('click', () => openDetail(kind));
  return tile;
}

// 詳細資料：欄位與本機目錄一致（唯讀欄位＋六個收藏欄位）；收藏欄位可在手機編輯，存成待回傳。
const item = (label, value) => (value === '' || value == null
  ? []
  : [element('dt', { textContent: label }), element('dd', { textContent: String(value) })]);
const userItem = (label, value) => item(label, value === '' || value == null ? '未填' : value);

let detailKindKey = '';
let marketListKindKey = '';
const marketListDialog = $('#market-list-dialog');
function currentMarketRecords() {
  const records = new Map((data?.marketPrices?.records ?? []).map((record) => [record.id, record]));
  for (const change of Object.values(pending.marketPrices ?? {})) records.set(change.id, change.next);
  return [...records.values()];
}

function marketEntry(kind) {
  const count = pricesForKind(currentMarketRecords(), kind.kindKey).length;
  return element('button', { type: 'button', className: 'market-open-button',
    textContent: `市場價格紀錄（${count} 筆）`, onclick: () => openMarketList(kind.kindKey) });
}

function renderMarketList() {
  const kind = buildKinds(view.rows).find((item) => item.kindKey === marketListKindKey);
  const records = pricesForKind(currentMarketRecords(), marketListKindKey);
  $('#market-list-title').textContent = `${kind?.cardName || '待補卡名'} · 市場價格紀錄（${records.length} 筆）`;
  const existsOnComputer = data.rows.some((row) => kindKeyFromRowKey(row.RowKey) === marketListKindKey);
  const nodes = records.map((record) => {
    const pendingMark = pending.marketPrices?.[record.id] ? ' · 待回傳' : '';
    return element('div', { className: 'market-record' }, [
      element('strong', { textContent: `${record.date} · ${record.price} ${record.currency}${pendingMark}` }),
      element('span', { className: 'market-record-meta', textContent: [record.shop, record.note].filter(Boolean).join(' · ') }),
      element('button', { type: 'button', className: 'edit-button', textContent: '修改', onclick: () => openMarketForm(marketListKindKey, record) }),
    ]);
  });
  if (!nodes.length) nodes.push(element('p', { className: 'preview-note', textContent: existsOnComputer
    ? '尚無市場價格紀錄。' : '可先記錄；電腦審核時須先加入這張新卡，再套用價格。' }));
  $('#market-list-records').replaceChildren(...nodes);
}

function openMarketList(kindKey) {
  marketListKindKey = kindKey;
  renderMarketList();
  marketListDialog.showModal();
}
$('#market-list-close').addEventListener('click', () => marketListDialog.close());
marketListDialog.addEventListener('click', (event) => { if (event.target === marketListDialog) marketListDialog.close(); });
$('#market-list-add').addEventListener('click', () => openMarketForm(marketListKindKey));

function openDetail(kind) {
  detailKindKey = kind.kindKey;
  const first = kind.rows[0];
  $('#detail-title').textContent = kind.rows.length === 1
    ? first.Name
    : String(first.Name).replace(/\s#\d+$/, '');
  const image = imageNode(kind.thumb, 'detail-image');
  if (image.tagName === 'IMG') image.addEventListener('click', () => openViewer(image.src));

  const cardInfo = element('dl', {}, [
    ...(kind.rows.length === 1 ? item('RowKey', first.RowKey) : []),
    ...item('官方代碼', first.官方代碼), ...item('我的分類', first.我的分類),
    ...item('卡號', first.卡號), ...item('語言', first.Language), ...item('變體', first.變體),
    ...item('全套張數', first.全套張數), ...item('發行年月', first.發行日期 || '未提供'),
    ...item('資料來源', first.資料來源), ...item('卡圖來源', first.卡圖來源),
  ]);
  const copyBlocks = kind.rows.map((row) => element('section', { className: 'copy-block' }, [
    element('div', { className: 'copy-head' }, [
      element('h3', { textContent: kind.rows.length > 1 ? `#${row.個體編號 || '新'}` : '收藏' }),
      row.pendingEdit || row.mobileId ? element('span', { className: 'pending-mark', textContent: row.mobileId ? '手機新增' : '待回傳' }) : '',
      row.mobileId ? '' : element('button', { type: 'button', className: 'edit-button', textContent: '編輯', onclick: () => openEdit(row.RowKey) }),
    ]),
    element('dl', {}, [
      ...(kind.rows.length > 1 ? item('RowKey', row.RowKey) : []),
      ...userItem('狀態', row.狀態), ...userItem('購入日', row.購入日), ...userItem('購入價', row.購入價),
      ...userItem('幣別', row.幣別), ...userItem('卡片狀態', row.卡片狀態), ...userItem('備註', row.備註),
    ]),
  ]));
  const info = element('div', { className: 'detail-info' }, [marketEntry(kind), cardInfo, ...copyBlocks]);
  const copySource = kind.rows.find((row) => !row.mobileId);
  if (copySource) info.append(element('button', { type: 'button', className: 'edit-button add-copy-button', textContent: '多買一張',
    onclick: () => openAddition('copy', copySource.RowKey) }));
  if (first.卡圖URL) info.append(element('a', { className: 'original', href: first.卡圖URL, target: '_blank', rel: 'noopener noreferrer', textContent: '開原圖' }));
  $('#detail-body').replaceChildren(image, info);
  if (!detail.open) detail.showModal();
}
$('#detail-close').addEventListener('click', () => detail.close());
detail.addEventListener('click', (event) => { if (event.target === detail) detail.close(); });

const marketDialog = $('#market-dialog');
const marketForm = $('#market-form');
let marketFormStart = '';
function openMarketForm(kindKey, record = null) {
  marketKindKey = kindKey;
  editingMarket = record;
  marketForm.reset();
  $('#market-title').textContent = record ? '修改市場價格' : '記錄市場價格';
  $('#market-kind').textContent = kindKey;
  const today = new Date();
  marketForm.elements.date.value = record?.date ?? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  marketForm.elements.currency.value = record?.currency ?? 'NT';
  marketForm.elements.price.value = record?.price ?? '';
  marketForm.elements.shop.value = record?.shop ?? '';
  marketForm.elements.note.value = record?.note ?? '';
  $('#market-error').hidden = true;
  marketFormStart = JSON.stringify([...new FormData(marketForm)]);
  $('#market-unsaved').hidden = true;
  marketDialog.showModal();
}
const marketFormChanged = () => JSON.stringify([...new FormData(marketForm)]) !== marketFormStart;
$('#market-cancel').addEventListener('click', () => {
  if (marketFormChanged() && !confirm('這筆市場價格尚未儲存，確定放棄修改？')) return;
  marketDialog.close();
});
marketDialog.addEventListener('cancel', (event) => {
  if (marketFormChanged() && !confirm('這筆市場價格尚未儲存，確定放棄修改？')) event.preventDefault();
});
marketForm.addEventListener('input', () => { $('#market-unsaved').hidden = !marketFormChanged(); });
window.addEventListener('beforeunload', (event) => {
  if (!marketDialog.open || !marketFormChanged()) return;
  event.preventDefault();
  event.returnValue = '';
});
marketForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorNode = $('#market-error');
  try {
    const base = (data.marketPrices?.records ?? []).find((record) => record.id === editingMarket?.id) ?? null;
    const next = normalizeMarketRecord({
      id: editingMarket?.id ?? crypto.randomUUID(), kindKey: marketKindKey,
      date: marketForm.elements.date.value, currency: marketForm.elements.currency.value.trim(),
      price: Number(marketForm.elements.price.value), shop: marketForm.elements.shop.value.trim(), note: marketForm.elements.note.value.trim(),
    });
    await savePending(recordMarketEdit(pending, base, next, new Date().toISOString()));
    marketDialog.close();
    render();
    const kind = buildKinds(view.rows).find((item) => item.kindKey === detailKindKey);
    if (kind && detail.open) openDetail(kind);
    if (marketListDialog.open) renderMarketList();
    showNotice('市場價格已加入待回傳；匯出後需在電腦審核。');
  } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; }
});

const viewer = $('#viewer');
function openViewer(src) {
  $('#viewer-image').src = src;
  viewer.showModal();
}
$('#viewer-close').addEventListener('click', () => viewer.close());
viewer.addEventListener('click', (event) => { if (event.target === viewer) viewer.close(); });

function groupNode(group) {
  const title = element('h2', { className: 'group-title' }, [`${group.cardName || '待補卡名'} ${group.code}-${group.number}`]);
  if (group.total !== '' && group.total != null) title.append(' ', element('small', { textContent: `／${group.total}` }));
  const owned = group.owned.length
    ? element('p', { className: 'group-owned', textContent: `已收藏：${group.owned.join('、')}` })
    : '';
  const prices = element('ul', { className: 'group-prices' }, group.prices.map((price) => element('li', {
    textContent: `${price.language}${price.variant === '一般' ? '' : price.variant}：${price.price}${price.date ? `（${price.date}）` : ''}`,
  })));
  return element('section', { className: 'group' }, [title, owned, prices, element('div', { className: 'grid' }, group.kinds.map(tileNode))]);
}

// ── 卡圖比對 ─────────────────────────────────────────
// 參考特徵：匯入資料後在背景算一次，存在 IndexedDB 的 features；資料或比對版本變了就重算。

let worker = null;
let workerSeq = 0;
const workerCalls = new Map();
let scanJob = null;
let scanJobRevision = '';

function resetWorker() {
  worker?.terminate();
  worker = null;
  for (const { reject } of workerCalls.values()) reject(new Error('已重新開始'));
  workerCalls.clear();
  scanJob = null;
  scanJobRevision = '';
}

function callWorker(type, payload = {}, onProgress = null) {
  if (!worker) {
    worker = new Worker('scan_worker.js');
    worker.onmessage = ({ data: message }) => {
      const call = workerCalls.get(message.id);
      if (!call) return;
      if (message.type === 'progress') { call.onProgress?.(message); return; }
      workerCalls.delete(message.id);
      if (message.type === 'done') call.resolve(message.result);
      else call.reject(new Error(message.message));
    };
    worker.onerror = (event) => {
      for (const { reject } of workerCalls.values()) reject(new Error(event.message || '比對程式載入失敗'));
      workerCalls.clear();
    };
  }
  const id = ++workerSeq;
  return new Promise((resolve, reject) => {
    workerCalls.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, ...payload });
  });
}

const featureRevision = (snapshot) => `${snapshot.sourceRevision}|${snapshot.exportedAt}|v${MATCH_VERSION}`;

function setScanStatus(text, isError = false) {
  scanStatus.textContent = text;
  scanStatus.hidden = !text;
  scanStatus.classList.toggle('error', isError);
}

function thumbEntries() {
  const keys = [...new Set(data.rows.map((row) => row.thumb).filter((key) => key && data.thumbs[key]))];
  return keys.map((key) => [key, data.thumbs[key]]);
}

/** 讓 worker 手上有目前資料的參考特徵：有快取就載入，沒有就計算並存起來。 */
function prepareScanner() {
  if (!data) return Promise.reject(new Error('尚未匯入資料'));
  const revision = featureRevision(data);
  if (scanJob && scanJobRevision === revision) return scanJob;
  scanJobRevision = revision;
  const job = (async () => {
    const cached = await dbGet('features');
    if (cached?.revision === revision) {
      setScanStatus('載入卡圖比對…');
      await callWorker('load', { refs: cached.refs });
    } else {
      const thumbs = thumbEntries();
      const progress = (done) => setScanStatus(`準備卡圖比對 ${done}/${thumbs.length}（只需一次，這段時間可以先用搜尋）`);
      progress(0);
      const { refs } = await callWorker('prepare', { thumbs }, (message) => progress(message.done));
      await dbPutMany([['features', { revision, refs }]]);
    }
    setScanStatus('');
  })();
  scanJob = job;
  job.catch((error) => {
    if (scanJob !== job) return;
    scanJob = null;
    scanJobRevision = '';
    setScanStatus(`卡圖比對無法使用：${error.message}`, true);
  });
  return job;
}

async function prepareIfStale() {
  if (!data) return;
  const cached = await dbGet('features');
  if (cached?.revision !== featureRevision(data)) prepareScanner().catch(() => {});
}

function clearScan() {
  if (scanResult?.photo) URL.revokeObjectURL(scanResult.photo);
  scanResult = null;
}

async function runScan(file) {
  if (!file || !data) return;
  if (pendingOnly) { pendingOnly = false; updatePendingMode(); }
  clearScan();
  search.value = '';
  const current = { photo: URL.createObjectURL(file), file, pending: true };
  scanResult = current;
  render();
  try {
    await prepareScanner();
    const { matches, ms } = await callWorker('match', { blob: file });
    if (scanResult !== current) return;
    Object.assign(current, { pending: false, ms, groups: matchGroups(classifyMatches(matches, MATCH_PARAMS), view.rows) });
  } catch (error) {
    if (scanResult !== current) return;
    Object.assign(current, { pending: false, error: error.message });
  }
  render();
}

for (const input of [scanInput, scanPick]) {
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = '';
    runScan(file);
  });
}

function renderScan() {
  const scan = scanResult;
  const actions = element('span', { className: 'scan-actions' }, [
    element('label', { htmlFor: 'scan', className: 'text-button', textContent: '重拍' }),
    element('label', { htmlFor: 'scan-pick', className: 'text-button', textContent: '從相簿選' }),
    element('button', { type: 'button', className: 'text-button', textContent: '關閉', onclick: () => { clearScan(); render(); } }),
    element('button', { type: 'button', className: 'text-button', textContent: '找不到？新增這張卡',
      onclick: () => openAddition('new', '', scan.file) }),
  ]);
  let summary;
  if (scan.pending) summary = scanJob && !scanStatus.hidden ? '卡圖比對準備好後會自動比對…' : '比對中…';
  else if (scan.error) summary = `比對失敗：${scan.error}`;
  else summary = `卡圖比對 ${(scan.ms / 1000).toFixed(1)} 秒 · 找到 ${scan.groups.length} 張相近的卡（不套用篩選）`;
  const head = element('div', { className: 'scan-head' }, [
    element('img', { className: 'scan-photo', src: scan.photo, alt: '拍到的照片' }),
    element('div', { className: 'scan-summary' }, [element('p', { className: scan.error ? 'error' : '', textContent: summary }), actions]),
  ]);
  results.append(head);
  if (scan.pending || scan.error) return;
  if (!scan.groups.length) {
    empty.textContent = '沒有比對到相近的卡圖。這不代表確定沒有收藏——可以靠近一點、避開反光再拍一次，或改用卡號／卡名搜尋。';
    empty.hidden = false;
    return;
  }
  results.append(...scan.groups.map((group) => {
    const first = group.kinds[0];
    const title = element('h2', { className: 'group-title' }, [
      element('span', { className: `match-level ${group.level}`, textContent: group.level === 'high' ? '很可能' : '可能' }),
      ` ${first.cardName || '待補卡名'} ${first.code}-${first.number}`,
      element('small', { textContent: ` · 相符 ${group.inliers} 點` }),
    ]);
    const note = group.kinds.length > 1
      ? element('p', { className: 'group-owned', textContent: '這張卡有多個語言或版本，請看卡面確認。' })
      : '';
    return element('section', { className: 'group' }, [title, note, element('div', { className: 'grid' }, group.kinds.map(tileNode))]);
  }));
}

function render() {
  results.replaceChildren();
  empty.hidden = true;
  multiNote.hidden = true;
  hint.hidden = true;
  hint.classList.remove('error');
  if (!data) return;
  marketKindKeys = new Set(currentMarketRecords().map((record) => record.kindKey));
  if (scanResult && !search.value.trim()) { renderScan(); return; }
  const rows = filterRows(pendingOnly ? pendingRows(view.rows) : view.rows, filters);
  const filtered = pendingOnly || filters.code.length > 0 || ['status', 'language', 'bulba'].some((key) => filters[key]);
  const query = search.value.trim();

  if (!query) {
    // 瀏覽模式：依篩選與排序列出所有卡種。
    const kinds = sortKinds(buildKinds(rows), filters.sort);
    if (!kinds.length) { empty.textContent = pendingOnly ? '目前沒有待回傳的卡。' : '沒有符合篩選條件的卡。'; empty.hidden = false; return; }
    const owned = rows.filter((row) => row.狀態 === '已收藏').length;
    hint.textContent = `${pendingOnly ? '待回傳' : filtered ? '符合篩選' : '全部'} ${kinds.length} 種卡（${rows.length} 張，已收藏 ${owned}）。可輸入卡號／張數、代碼或卡名，多個詞用空白分開。`;
    hint.hidden = false;
    results.append(element('div', { className: 'grid' }, kinds.map(tileNode)));
    return;
  }

  const result = searchCards(rows, query, pendingOnly ? pendingRows(view.rows) : view.rows);
  if (!result.groups.length) {
    empty.textContent = (pendingOnly ? '待回傳的卡中沒有找到符合的卡。' : '收藏清單中沒有找到符合的卡。這不代表確定沒有收藏——請確認輸入的卡號、張數，或改用卡名搜尋。')
      + (filtered ? '（目前有套用篩選，可按「篩選」→「清除」再查一次。）' : '');
    empty.hidden = false;
    return;
  }
  multiNote.hidden = !result.multiSeries;
  results.append(...result.groups.map(groupNode));
}

let timer = 0;
search.addEventListener('input', () => { if (scanResult) clearScan(); clearTimeout(timer); timer = setTimeout(render, 150); });
filterToggle.addEventListener('click', () => {
  filterPanel.hidden = !filterPanel.hidden;
  filterToggle.setAttribute('aria-expanded', String(!filterPanel.hidden));
  if (filterPanel.hidden) setCodeMenuOpen(false);
});
for (const [key, select] of Object.entries(controls)) {
  select.addEventListener('change', () => { filters[key] = select.value; saveFilters(); updateFilterToggle(); render(); });
}
codeButton.addEventListener('click', () => setCodeMenuOpen(codeMenu.hidden));
codeMenu.addEventListener('click', (event) => {
  if (!event.target.closest('.code-clear')) return;
  filters.code = [];
  fillCodeMenu();
  saveFilters();
  updateFilterToggle();
  render();
});
codeMenu.addEventListener('change', (event) => {
  const input = event.target;
  if (input.matches('.code-option-input')) filters.code = toggleCodeSelection(filters.code, [input.value]);
  else if (input.matches('.code-group-input')) {
    const group = codeGroups(view.rows).find((item) => item.label === input.dataset.group);
    if (!group) return;
    filters.code = toggleCodeSelection(filters.code, group.codes);
  } else return;
  const focusValue = input.value;
  const focusGroup = input.dataset.group;
  fillCodeMenu();
  [...codeMenu.querySelectorAll('input')].find((item) => focusGroup ? item.dataset.group === focusGroup : item.value === focusValue)?.focus();
  saveFilters();
  updateFilterToggle();
  render();
});
document.addEventListener('pointerdown', (event) => {
  if (!codeFilter.contains(event.target)) setCodeMenuOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || codeMenu.hidden) return;
  event.preventDefault();
  setCodeMenuOpen(false);
  codeButton.focus();
});
$('#f-clear').addEventListener('click', () => {
  pendingOnly = false;
  filters = { ...DEFAULT_FILTERS, code: [] };
  for (const [key, select] of Object.entries(controls)) select.value = filters[key];
  setCodeMenuOpen(false);
  fillCodeMenu();
  search.value = '';
  clearScan();
  saveFilters();
  updatePendingMode();
  render();
});
pendingFilter.addEventListener('click', () => setPendingOnly(!pendingOnly));
$('#pending-exit').addEventListener('click', () => setPendingOnly(false));

// ── 待回傳（第 3 階段）：手機修改存在 IndexedDB 的 pending，匯出成變更檔交給電腦 ──

const pendingButton = $('#pending-button');
const pendingDialog = $('#pending-dialog');
const editDialog = $('#edit');
const editForm = $('#edit-form');
const notice = $('#notice');
let editingRowKey = '';

function refreshView() {
  view = data ? applyPending(data, pending) : null;
  if (view) fillCodeMenu();
  const count = pendingCount();
  pendingButton.hidden = !data || count === 0;
  pendingButton.textContent = `待回傳 ${count}`;
  updatePendingMode();
}

const pendingCount = () => Object.keys(pending.edits).length + pending.additions.length + Object.keys(pending.marketPrices ?? {}).length;
const pendingClearText = () => `${pendingCount()} 筆待回傳（${Object.keys(pending.edits).length} 筆卡片修改、${pending.additions.length} 筆新增卡、${Object.keys(pending.marketPrices ?? {}).length} 筆市場價格）`;

async function savePending(next) {
  pending = next;
  await dbPutMany([['pending', pending]]);
  refreshView();
}

function showNotice(text) {
  notice.textContent = text;
  notice.hidden = !text;
  clearTimeout(showNotice.timer);
  if (text) showNotice.timer = setTimeout(() => { notice.hidden = true; }, 10_000);
}

const now = () => new Date().toISOString();
const shown = (value) => (value === '' || value == null ? '（空白）' : String(value));
const fillSelect = (select, values) => select.replaceChildren(...values.map((value) => option(value, value || '（空白）')));
fillSelect(editForm.elements.狀態, STATUS_ORDER);
fillSelect(editForm.elements.幣別, CURRENCY_OPTIONS);

function openEdit(rowKey) {
  const row = view.rows.find((item) => item.RowKey === rowKey);
  if (!row) return;
  editingRowKey = rowKey;
  $('#edit-title').textContent = row.Name;
  for (const field of ['狀態', '購入日', '幣別', '卡片狀態', '備註']) editForm.elements[field].value = row[field] ?? '';
  editForm.elements.購入價.value = row.購入價 === '' || row.購入價 == null ? '' : String(row.購入價);
  $('#edit-error').hidden = true;
  editDialog.showModal();
}

// 改成「已收藏」且購入日空白時，順手帶入今天（仍可改）。
editForm.elements.狀態.addEventListener('change', () => {
  if (editForm.elements.狀態.value === '已收藏' && !editForm.elements.購入日.value) editForm.elements.購入日.value = formatDate(now());
});

editForm.addEventListener('submit', async (event) => {
  if (event.submitter?.value !== 'save') return;
  event.preventDefault();
  const base = data.rows.find((row) => row.RowKey === editingRowKey);
  const priceText = editForm.elements.購入價.value.trim();
  const fields = {
    狀態: editForm.elements.狀態.value,
    購入價: priceText === '' ? '' : Number(priceText),
    幣別: editForm.elements.幣別.value,
    購入日: editForm.elements.購入日.value,
    卡片狀態: editForm.elements.卡片狀態.value,
    備註: editForm.elements.備註.value,
  };
  try {
    await savePending(recordEdit(pending, base, fields, now()));
  } catch (error) {
    $('#edit-error').textContent = error.message;
    $('#edit-error').hidden = false;
    return;
  }
  editDialog.close();
  render();
  const kind = buildKinds(view.rows).find((item) => item.kindKey === detailKindKey);
  if (kind && detail.open) openDetail(kind);
});

// 新增只寫 pending；手機不決定 RowKey／個體編號。照片壓成小圖，留在變更檔供電腦審核。
const additionDialog = $('#addition');
const additionForm = $('#addition-form');
let additionMode = 'new';
let additionCopyOf = '';
let additionScanFile = null;
fillSelect(additionForm.elements.Language, LANGUAGE_OPTIONS);
fillSelect(additionForm.elements.變體, VARIANT_OPTIONS);
fillSelect(additionForm.elements.狀態, STATUS_ORDER);
fillSelect(additionForm.elements.幣別, CURRENCY_OPTIONS);

function openAddition(mode, copyOf = '', scanFile = null) {
  additionMode = mode;
  additionCopyOf = copyOf;
  additionScanFile = scanFile;
  additionForm.reset();
  additionForm.elements.狀態.value = '要收藏';
  $('#addition-title').textContent = mode === 'copy' ? '多買一張' : '新增卡';
  const source = mode === 'copy' ? data.rows.find((row) => row.RowKey === copyOf) : null;
  $('#addition-source').hidden = !source;
  $('#addition-source').textContent = source ? `${source.Name} · 只可改變體與收藏資料` : '';
  for (const name of ['官方代碼', '卡號', 'Language', '卡名']) {
    const field = additionForm.elements[name];
    field.closest('label').hidden = mode === 'copy';
    field.required = mode === 'new' && name !== '卡名';
  }
  additionForm.elements.變體.value = source?.變體 ?? '';
  $('#addition-photo-note').textContent = scanFile ? '已附上剛拍的照片；也可另外選一張取代。' : '';
  $('#addition-error').hidden = true;
  additionDialog.showModal();
}
$('#add-button').addEventListener('click', () => openAddition('new'));
$('#addition-cancel').addEventListener('click', () => additionDialog.close());
additionForm.elements.photo.addEventListener('change', () => {
  $('#addition-photo-note').textContent = additionForm.elements.photo.files[0]?.name || (additionScanFile ? '已附上剛拍的照片。' : '');
});

async function compressedPhoto(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } finally { bitmap.close(); }
}

additionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = additionForm.elements;
  const price = form.購入價.value.trim();
  const fields = {
    狀態: form.狀態.value, 購入價: price === '' ? '' : Number(price), 幣別: form.幣別.value,
    購入日: form.購入日.value, 卡片狀態: form.卡片狀態.value, 備註: form.備註.value,
  };
  const addition = { id: crypto.randomUUID(), at: now(), type: additionMode,
    變體: form.變體.value, ...fields };
  if (additionMode === 'copy') {
    addition.copyOf = additionCopyOf;
    addition.baseCount = kindCountFor(data.rows, additionCopyOf, addition.變體);
  } else {
    Object.assign(addition, { 官方代碼: form.官方代碼.value.trim(), 卡號: form.卡號.value.trim(),
      Language: form.Language.value, 卡名: form.卡名.value.trim() });
  }
  const errorNode = $('#addition-error');
  try {
    if (additionMode === 'new' && view.rows.some((row) => row.官方代碼 === addition.官方代碼
        && row.卡號 === addition.卡號 && row.Language === addition.Language
        && (row.變體 || '') === addition.變體)) throw new Error('這個卡種已存在；請到卡片詳細資料使用「多買一張」。');
    const photo = form.photo.files[0] ?? additionScanFile;
    if (photo) addition.photo = await compressedPhoto(photo);
    const errors = validateAddition(addition);
    if (errors.length) throw new Error(errors.join('；'));
    await savePending({ ...pending, additions: [...pending.additions, addition] });
    await refreshInfo();
    additionDialog.close();
    render();
    if (detail.open) detail.close();
    showNotice('已加入待回傳；匯出後還需在電腦審核。');
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  }
});

function openPending() {
  const byKey = new Map(data.rows.map((row) => [row.RowKey, row]));
  const items = Object.entries(pending.edits).map(([rowKey, edit]) => {
    const changes = Object.keys(edit.next).map((field) => `${field}：${shown(edit.previous[field])} → ${shown(edit.next[field])}`);
    const cancel = element('button', {
      type: 'button', className: 'text-button', textContent: '取消這筆',
      onclick: async () => {
        const edits = { ...pending.edits };
        delete edits[rowKey];
        await savePending({ ...pending, edits });
        render();
        openPending();
      },
    });
    return element('li', {}, [
      element('strong', { textContent: byKey.get(rowKey)?.Name ?? rowKey }),
      element('span', { className: 'pending-changes', textContent: changes.join('；') }),
      cancel,
    ]);
  });
  const additions = pending.additions.map((addition) => {
    const label = addition.type === 'copy' ? `多買一張：${addition.copyOf}（${addition.變體 || '一般'}）`
      : `新增卡：${addition.官方代碼}-${addition.卡號} ${addition.Language} ${addition.變體 || '一般'}`;
    return element('li', {}, [
      element('strong', { textContent: label }),
      addition.photo ? element('img', { className: 'pending-photo', src: addition.photo, alt: '新增卡照片' }) : '',
      element('span', { className: 'pending-changes', textContent: USER_FIELDS.map((key) => `${key}：${shown(addition[key])}`).join('；') }),
      element('button', { type: 'button', className: 'text-button', textContent: '取消這筆', onclick: async () => {
        await savePending({ ...pending, additions: pending.additions.filter((item) => item.id !== addition.id) });
        await refreshInfo();
        render();
        openPending();
      } }),
    ]);
  });
  const prices = Object.values(pending.marketPrices ?? {}).map((change) => element('li', {}, [
    element('strong', { textContent: `市場價格：${change.next.kindKey}` }),
    element('span', { className: 'pending-changes', textContent: `${change.next.date} · ${change.next.price} ${change.next.currency} · ${change.next.shop || '未填商店'}${change.next.note ? ` · ${change.next.note}` : ''}` }),
    element('button', { type: 'button', className: 'text-button', textContent: '取消這筆', onclick: async () => {
      const marketPrices = { ...(pending.marketPrices ?? {}) };
      delete marketPrices[change.id];
      await savePending({ ...pending, marketPrices });
      render();
      openPending();
    } }),
  ]));
  $('#pending-list').replaceChildren(...items, ...additions, ...prices);
  $('#pending-note').textContent = `${items.length} 筆卡片修改、${additions.length} 筆新增卡、${prices.length} 筆市場價格。`
    + (pending.lastExportedAt ? `上次匯出：${formatDate(pending.lastExportedAt)}。` : '')
    + '匯出後仍會保留；確認重新匯入或還原資料時，所有待回傳都會清除。';
  $('#pending-export').disabled = !items.length && !pending.additions.length && !prices.length;
  if (!pendingDialog.open) pendingDialog.showModal();
}
pendingButton.addEventListener('click', openPending);
$('#pending-close').addEventListener('click', () => pendingDialog.close());

$('#pending-export').addEventListener('click', async () => {
  const at = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  const exportId = `${stamp}${pad(at.getSeconds())}-${Math.random().toString(16).slice(2, 6)}`;
  const changes = buildMobileChanges(pending, {
    base: { sourceRevision: data.sourceRevision, marketRevision: data.marketPrices?.revision ?? '', exportedAt: data.exportedAt }, exportedAt: at.toISOString(), exportId,
  });
  const problems = validateMobileChanges(changes);
  if (problems.length) { $('#pending-note').textContent = `變更檔驗證失敗：${problems.slice(0, 3).join('；')}`; return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(changes)], { type: 'application/json' }));
  const link = element('a', { href: url, download: `bulba_changes_${stamp}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  await savePending({ ...pending, lastExportedAt: at.toISOString() });
  openPending();
});

// ── 匯入與還原 ───────────────────────────────────────

function showError(lines) {
  hint.textContent = lines.join('\n');
  hint.classList.add('error');
  hint.hidden = false;
}

function diffSummary(next, current) {
  if (!current) return null;
  const before = new Map(current.rows.map((row) => [row.RowKey, row]));
  const after = new Set(next.rows.map((row) => row.RowKey));
  let added = 0;
  let changed = 0;
  for (const row of next.rows) {
    const old = before.get(row.RowKey);
    if (!old) added += 1;
    else if (old.狀態 !== row.狀態) changed += 1;
  }
  const removed = current.rows.filter((row) => !after.has(row.RowKey)).length;
  return { added, removed, changed };
}

$('#file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch { showError(['這不是有效的 JSON 檔案。']); return; }
  const problems = validateMobileExport(parsed);
  if (problems.length) { showError(['匯入檔驗證失敗，沒有寫入：', ...problems.slice(0, 5)]); return; }
  pendingImport = parsed;
  const diff = diffSummary(parsed, data);
  const entries = [
    ['匯出時間', `${formatDate(parsed.exportedAt)}（${daysSince(parsed.exportedAt)} 天前）`],
    ['列數', String(parsed.rowCount)],
    ['市場價格紀錄', `${parsed.marketPrices?.records?.length ?? 0} 筆`],
    ['縮圖', `${Object.keys(parsed.thumbs).length} 張`],
    ...(diff ? [['新增', `${diff.added} 列`], ['移除', `${diff.removed} 列`], ['狀態改變', `${diff.changed} 列`]] : []),
  ];
  $('#preview-stats').replaceChildren(...entries.flatMap(([label, value]) => [element('dt', { textContent: label }), element('dd', { textContent: value })]));
  const warning = $('#preview-pending-warning');
  warning.hidden = pendingCount() === 0;
  warning.textContent = pendingCount() ? `確認匯入後將清除手機上的 ${pendingClearText()}，不再以手機暫記覆蓋匯入資料；未匯出的內容與照片無法從手機復原。` : '';
  preview.showModal();
});

// 按鈕送出時處理（不靠 dialog 的 close 事件：部分瀏覽器環境不會觸發）。
preview.querySelector('form').addEventListener('submit', async (event) => {
  const next = pendingImport;
  pendingImport = null;
  if (event.submitter?.value !== 'confirm' || !next) return;
  const removed = pendingCount();
  const cleared = emptyPending();
  await dbPutMany([['previous', data], ['current', next], ['pending', cleared]]);
  data = next;
  pending = cleared;
  refreshView();
  resetWorker();
  clearScan();
  await refreshInfo();
  render();
  if (removed) showNotice(`已採用匯入資料，清除 ${removed} 筆手機待回傳。`);
  prepareIfStale();
});

$('#restore').addEventListener('click', async () => {
  const previous = await dbGet('previous');
  if (!previous) return;
  const removed = pendingCount();
  const warning = removed ? `\n手機上的 ${pendingClearText()}也會清除；未匯出的內容與照片無法從手機復原。` : '';
  if (!confirm(`還原成 ${formatDate(previous.exportedAt)} 匯出的資料？目前的資料會改存為上一份。${warning}`)) return;
  const cleared = emptyPending();
  await dbPutMany([['previous', data], ['current', previous], ['pending', cleared]]);
  data = previous;
  pending = cleared;
  refreshView();
  resetWorker();
  clearScan();
  await refreshInfo();
  render();
  if (removed) showNotice(`已還原上一份資料，清除 ${removed} 筆手機待回傳。`);
  prepareIfStale();
});

// ── 啟動 ─────────────────────────────────────────────

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
loadFilters();
data = await dbGet('current');
pending = { ...emptyPending(), ...((await dbGet('pending')) ?? {}) };
refreshView();
await refreshInfo();
render();
prepareIfStale();
