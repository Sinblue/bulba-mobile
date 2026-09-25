// 妙蛙收藏查詢（手機第 0 階段）：離線、唯讀。資料由電腦匯出檔匯入，存在這支手機的 IndexedDB。
// 除了使用者主動點「開原圖」，不發出任何外部網路請求。
import {
  DEFAULT_FILTERS, LANGUAGE_ORDER, SORT_OPTIONS, STATUS_ORDER,
  buildKinds, codeGroups, filterRows, searchCards, sortKinds, validateMobileExport,
} from './lib/mobile_format.mjs';

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
const controls = { status: $('#f-status'), language: $('#f-language'), code: $('#f-code'), bulba: $('#f-bulba'), sort: $('#f-sort') };
let data = null;
let pendingImport = null;
let filters = { ...DEFAULT_FILTERS };

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
    if (saved && typeof saved === 'object') filters = { ...DEFAULT_FILTERS, ...saved };
  } catch { filters = { ...DEFAULT_FILTERS }; }
}
function saveFilters() {
  try { localStorage.setItem(FILTER_STORAGE, JSON.stringify(filters)); } catch { /* 無痕模式等情況略過 */ }
}

const option = (value, label = value) => element('option', { value, textContent: label });
function fillFilterOptions() {
  controls.status.replaceChildren(option('', '全部狀態'), ...STATUS_ORDER.map((status) => option(status)));
  const languages = [...new Set(data.rows.map((row) => row.Language))]
    .sort((a, b) => LANGUAGE_ORDER.indexOf(a) - LANGUAGE_ORDER.indexOf(b));
  controls.language.replaceChildren(option('', '全部語言'), ...languages.map((language) => option(language)));
  controls.code.replaceChildren(option('', '全部官方代碼'), ...codeGroups(data.rows).map((group) =>
    element('optgroup', { label: group.label }, group.codes.map((code) => option(code)))));
  controls.sort.replaceChildren(...SORT_OPTIONS.map(([value, label]) => option(value, label)));
  for (const [key, select] of Object.entries(controls)) {
    const allowed = [...select.options].map((item) => item.value);
    if (!allowed.includes(filters[key])) filters[key] = DEFAULT_FILTERS[key];
    select.value = filters[key];
  }
}
function activeFilterCount() {
  return Object.keys(controls).filter((key) => filters[key] !== DEFAULT_FILTERS[key]).length;
}
function updateFilterToggle() {
  const count = activeFilterCount();
  filterToggle.textContent = count ? `篩選 ${count}` : '篩選';
  filterToggle.classList.toggle('active', count > 0);
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
  const src = key && data.thumbs[key];
  if (src) return element('img', { className, src, alt: '', loading: 'lazy', decoding: 'async' });
  return element('span', { className: `${className} placeholder`, textContent: '無圖' });
}

async function refreshInfo() {
  const info = $('#data-info');
  const ready = Boolean(data);
  search.disabled = !ready;
  filterToggle.disabled = !ready;
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
  const tile = element('button', { className: 'tile', type: 'button' }, [
    imageNode(kind.thumb, 'tile-image'),
    element('span', { className: 'tile-copy' }, [
      element('span', { className: 'tile-name', textContent: kind.cardName || '待補卡名' }),
      element('span', { className: 'tile-code', textContent: `${kind.code}-${kind.number}` }),
      tags,
      badgeNode(kind),
    ]),
  ]);
  tile.addEventListener('click', () => openDetail(kind));
  return tile;
}

// 詳細資料：欄位與本機目錄一致（唯讀欄位＋六個收藏欄位），第 0 階段不支援寫入。
const item = (label, value) => (value === '' || value == null
  ? []
  : [element('dt', { textContent: label }), element('dd', { textContent: String(value) })]);
const userItem = (label, value) => item(label, value === '' || value == null ? '未填' : value);

function openDetail(kind) {
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
    ...(kind.rows.length > 1 ? [element('h3', { textContent: `#${row.個體編號}` })] : []),
    element('dl', {}, [
      ...(kind.rows.length > 1 ? item('RowKey', row.RowKey) : []),
      ...userItem('狀態', row.狀態), ...userItem('購入日', row.購入日), ...userItem('購入價', row.購入價),
      ...userItem('幣別', row.幣別), ...userItem('卡片狀態', row.卡片狀態), ...userItem('備註', row.備註),
    ]),
  ]));
  const info = element('div', { className: 'detail-info' }, [cardInfo, ...copyBlocks]);
  if (first.卡圖URL) info.append(element('a', { className: 'original', href: first.卡圖URL, target: '_blank', rel: 'noopener noreferrer', textContent: '開原圖（需連網）' }));
  info.append(element('p', { className: 'readonly-note', textContent: '手機版目前只能查看；修改請在電腦的收藏目錄。' }));
  $('#detail-body').replaceChildren(image, info);
  detail.showModal();
}
$('#detail-close').addEventListener('click', () => detail.close());
detail.addEventListener('click', (event) => { if (event.target === detail) detail.close(); });

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

function render() {
  results.replaceChildren();
  empty.hidden = true;
  multiNote.hidden = true;
  hint.hidden = true;
  hint.classList.remove('error');
  if (!data) return;
  const rows = filterRows(data.rows, filters);
  const filtered = ['status', 'language', 'code', 'bulba'].some((key) => filters[key]);
  const query = search.value.trim();

  if (!query) {
    // 瀏覽模式：依篩選與排序列出所有卡種。
    const kinds = sortKinds(buildKinds(rows), filters.sort);
    if (!kinds.length) { empty.textContent = '沒有符合篩選條件的卡。'; empty.hidden = false; return; }
    const owned = rows.filter((row) => row.狀態 === '已收藏').length;
    hint.textContent = `${filtered ? '符合篩選' : '全部'} ${kinds.length} 種卡（${rows.length} 張，已收藏 ${owned}）。可輸入卡號／張數、代碼或卡名，多個詞用空白分開。`;
    hint.hidden = false;
    results.append(element('div', { className: 'grid' }, kinds.map(tileNode)));
    return;
  }

  const result = searchCards(rows, query, data.rows);
  if (!result.groups.length) {
    empty.textContent = '收藏清單中沒有找到符合的卡。這不代表確定沒有收藏——請確認輸入的卡號、張數，或改用卡名搜尋。'
      + (filtered ? '（目前有套用篩選，可按「篩選」→「清除」再查一次。）' : '');
    empty.hidden = false;
    return;
  }
  multiNote.hidden = !result.multiSeries;
  results.append(...result.groups.map(groupNode));
}

let timer = 0;
search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 150); });
filterToggle.addEventListener('click', () => {
  filterPanel.hidden = !filterPanel.hidden;
  filterToggle.setAttribute('aria-expanded', String(!filterPanel.hidden));
});
for (const [key, select] of Object.entries(controls)) {
  select.addEventListener('change', () => { filters[key] = select.value; saveFilters(); updateFilterToggle(); render(); });
}
$('#f-clear').addEventListener('click', () => {
  filters = { ...DEFAULT_FILTERS };
  for (const [key, select] of Object.entries(controls)) select.value = filters[key];
  search.value = '';
  saveFilters();
  updateFilterToggle();
  render();
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
    ['縮圖', `${Object.keys(parsed.thumbs).length} 張`],
    ...(diff ? [['新增', `${diff.added} 列`], ['移除', `${diff.removed} 列`], ['狀態改變', `${diff.changed} 列`]] : []),
  ];
  $('#preview-stats').replaceChildren(...entries.flatMap(([label, value]) => [element('dt', { textContent: label }), element('dd', { textContent: value })]));
  preview.showModal();
});

preview.addEventListener('close', async () => {
  const next = pendingImport;
  pendingImport = null;
  if (preview.returnValue !== 'confirm' || !next) return;
  await dbPutMany([['previous', data], ['current', next]]);
  data = next;
  await refreshInfo();
  render();
});

$('#restore').addEventListener('click', async () => {
  const previous = await dbGet('previous');
  if (!previous || !confirm(`還原成 ${formatDate(previous.exportedAt)} 匯出的資料？目前的資料會改存為上一份。`)) return;
  await dbPutMany([['previous', data], ['current', previous]]);
  data = previous;
  await refreshInfo();
  render();
});

// ── 啟動 ─────────────────────────────────────────────

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
loadFilters();
data = await dbGet('current');
await refreshInfo();
render();
