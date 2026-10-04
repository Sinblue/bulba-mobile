// 兩端共用的幣別匯率設定與購入統計畫面；使用 DOM textContent，不解析使用者文字。
import { displayMoney, loadRates, saveRates, purchaseAmountText, purchaseSummary, PURCHASE_SORT_OPTIONS, RATE_STORAGE_KEY } from './purchase_summary.mjs';

const node = (tag, className = '', text = '') => {
  const result = document.createElement(tag);
  result.className = className;
  result.textContent = text;
  return result;
};
const button = (text, action, className = 'secondary') => {
  const result = node('button', className, text);
  result.type = 'button';
  result.addEventListener('click', action);
  return result;
};
const closeMenu = () => {
  document.querySelector('#settings-options').hidden = true;
  document.querySelector('#settings-toggle').setAttribute('aria-expanded', 'false');
};
const storage = () => window.localStorage;

export function installSettingsMenu() {
  const menu = document.querySelector('#settings-menu');
  const toggle = document.querySelector('#settings-toggle');
  const options = document.querySelector('#settings-options');
  toggle.addEventListener('click', () => {
    options.hidden = !options.hidden;
    toggle.setAttribute('aria-expanded', String(!options.hidden));
  });
  document.addEventListener('pointerdown', (event) => { if (!menu.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || options.hidden) return;
    event.preventDefault(); closeMenu(); toggle.focus();
  });
}

export function mountPurchaseTools({ home, header, getRows, getImage, onOpen }) {
  const ratesDialog = node('dialog', 'rates-dialog');
  ratesDialog.setAttribute('aria-labelledby', 'rates-title');
  const form = node('form', 'rates-form');
  const title = node('h2', '', '幣別匯率');
  title.id = 'rates-title';
  const fields = {};
  form.append(title, node('p', 'purchase-note', '1 單位外幣換算成多少 NT；NT 固定為 1。'));
  for (const currency of ['JPY', 'USD']) {
    const label = node('label', '', `1 ${currency} ＝ NT`);
    const input = node('input');
    input.name = currency; input.type = 'number'; input.min = '0'; input.step = 'any';
    input.inputMode = 'decimal'; input.placeholder = '未設定';
    fields[currency] = input;
    label.append(input); form.append(label);
  }
  const error = node('p', 'error');
  error.hidden = true;
  const actions = node('div', 'purchase-actions');
  const save = node('button', '', '儲存'); save.type = 'submit';
  actions.append(button('取消', () => ratesDialog.close()), save);
  form.append(node('p', 'purchase-note', '留空的幣別不計入台幣總額。設定只保存在這個瀏覽器，不連網。'), error, actions);
  ratesDialog.append(form); document.body.append(ratesDialog);

  const page = node('main', 'purchase-page');
  page.id = 'purchase-page'; page.hidden = true;
  const heading = node('h2', '', '購入統計'); heading.tabIndex = -1;
  const summary = node('div', 'purchase-totals');
  const note = node('p', 'purchase-note');
  const list = node('div', 'purchase-list');
  const head = node('div', 'purchase-head');
  const sortLabel = node('label', 'purchase-sort', '排序');
  const sortSelect = node('select');
  sortSelect.id = 'purchase-sort';
  for (const { value, label } of PURCHASE_SORT_OPTIONS) {
    const option = node('option', '', label); option.value = value; sortSelect.append(option);
  }
  sortSelect.value = 'price-desc';
  sortLabel.append(sortSelect);
  sortSelect.addEventListener('change', refresh);
  head.hidden = true;
  const exit = () => {
    page.hidden = true; head.hidden = true; home.hidden = false; delete document.body.dataset.page;
    document.querySelector('#settings-toggle').focus();
  };
  head.append(button('← 返回主頁', exit), heading, sortLabel);
  header.append(head);
  page.append(note, summary, list); document.body.append(page);

  const readRates = () => { try { return loadRates(storage()); } catch { return loadRates(null); } };
  function refresh() {
    if (page.hidden) return;
    const stats = purchaseSummary(getRows(), readRates(), sortSelect.value);
    note.textContent = `已收藏且有購入價：${stats.rows.length} 張；逐張計算，不套用主頁篩選。${sortSelect.value.startsWith('price-') ? '價格排序依台幣估值，缺匯率者置後。' : ''}`;
    summary.replaceChildren();
    for (const total of stats.totals) {
      summary.append(node('p', 'purchase-total', `${total.currency}　${displayMoney(total.total)}　（${total.count} 張）`));
    }
    summary.append(node('p', 'purchase-twd', `換算台幣${stats.unconverted.length ? '小計' : '總額'}：NT ${displayMoney(stats.twd)}`));
    const used = ['JPY', 'USD'].filter((currency) => stats.rates[currency] != null)
      .map((currency) => `1 ${currency}＝${stats.rates[currency]} NT`).join('；');
    summary.append(node('p', 'purchase-note', `依手填匯率估算${used ? `（${used}）` : ''}，非購入當時的實際台幣支出。`));
    if (stats.unconverted.length) {
      summary.append(node('p', 'purchase-warning', `尚未計入台幣：${stats.unconverted.map(({ currency, count }) => `${currency} ${count} 張`).join('、')}；請在「設定 → 幣別匯率」補匯率，或補齊卡片幣別。`));
    }
    if (stats.invalidRows.length) summary.append(node('p', 'purchase-warning', `${stats.invalidRows.length} 張購入金額無效，未納入計算。`));
    list.replaceChildren();
    if (!stats.rows.length) list.append(node('p', 'purchase-note', '沒有已收藏且填寫購入價的卡片。'));
    for (const row of stats.rows) {
      const entry = node('button', 'purchase-row');
      entry.type = 'button';
      entry.dataset.rowKey = row.RowKey;
      entry.setAttribute('aria-label', `查看 ${row.Name || row.卡名 || row.RowKey} 詳細資料`);
      entry.addEventListener('click', () => onOpen(row, stats.rows));
      const image = getImage(row);
      const thumb = image ? node('img', 'purchase-thumb') : node('span', 'purchase-thumb placeholder', '無圖');
      if (image) { thumb.src = image; thumb.alt = row.Name || row.卡名 || ''; thumb.loading = 'lazy'; thumb.decoding = 'async'; }
      const info = node('span', 'purchase-copy');
      info.append(node('strong', '', row.Name || `${row.卡名 || '待補卡名'} ${row.官方代碼 || row.我的分類}-${row.卡號}`),
        node('span', 'purchase-line', `${row.Language || ''}${row.變體 ? ` · ${row.變體}` : ''} · ${row.RowKey.split('|')[0]} · 第 ${row.個體編號 || '待回傳'} 張`),
        node('span', 'purchase-line', `購入日：${row.購入日 || '未填'} · 購買商店：${row.購買商店 || '未填'}`));
      if (row.pendingEdit || row.mobileId) info.append(node('span', 'purchase-warning', '待回傳'));
      const amount = node('strong', 'purchase-amount', `${purchaseAmountText(row.購入價)} ${row.幣別 || '(未填幣別)'}`);
      entry.append(thumb, info, amount); list.append(entry);
    }
  }
  function openRates() {
    closeMenu(); const rates = readRates();
    for (const currency of ['JPY', 'USD']) fields[currency].value = rates[currency] ?? '';
    error.hidden = true; ratesDialog.showModal();
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      saveRates(storage(), Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])));
      ratesDialog.close(); refresh(); document.querySelector('#settings-toggle').focus();
    } catch (problem) {
      error.textContent = `匯率未儲存：${problem.message}`; error.hidden = false;
    }
  });
  document.querySelector('#exchange-rates').addEventListener('click', openRates);
  document.querySelector('#purchase-open').addEventListener('click', () => {
    closeMenu(); home.hidden = true; page.hidden = false; head.hidden = false; document.body.dataset.page = 'purchases';
    refresh(); heading.focus(); window.scrollTo(0, 0);
  });
  window.addEventListener('storage', (event) => { if (event.key === RATE_STORAGE_KEY) refresh(); });
  return { refresh };
}
