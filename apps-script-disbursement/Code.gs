/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  مسمار — بيانات صرف الفواتير (Disbursement Data for Looker)  v1.2            ║
 * ║  STANDALONE script — separate from the audit-monitoring script.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * الهدف: يسحب فواتير التكلفة B2B بالجملة (مثلاً كل المسددة لسنة 2026، أو غير المسددة)
 * إلى تبويب واحد «بيانات الصرف» تفلتره في Looker Studio — **مع إضافة رقم اللوحة**
 * الذي لا يظهر في صفحة التكاليف (يُجلب من داخل كل طلب).
 *
 * ضمان صحّة البيانات:
 *   • كل **فاتورة تكلفة = صف واحد** (المفتاح = رقم الفاتورة، upsert).
 *   • **لا يوجد حذف تكرارات للسيارات**: لو سيارة اتعملها صيانة مرتين → فاتورتان →
 *     صفّان. لا نجمعهم أبدًا. التكرار الوحيد الممنوع هو تكرار **نفس الفاتورة**.
 *
 * السحب السنوي كبير، والحدّ 6 دقائق للتشغيل، لذلك:
 *   • جلب رقم اللوحة مُخزَّن في كاش دائم (orderId → لوحة) فلا يُعاد جلبه أبدًا.
 *   • التشغيل **قابل للاستئناف**: كل تشغيلة تكمل ما تبقّى؛ شغّل «إكمال جلب اللوحات»
 *     أو فعّل التشغيل التلقائي حتى تكتمل كل اللوحات.
 *
 * معاملات الـAPI مؤكّدة من طلب الأدمن الفعلي:
 *   ?businessOrderTypes=B2B_business&fromPaidDate=..&toPaidDate=..&status=1
 *    &purchaseLocationsIds=..&spendSupplierIds=..&offset=..&limit=..&page=..
 *   الرد: { data: { raw: [...], total: N } }.  status: 1=تم الدفع، 2=غير مدفوعة، 3=بالأجل(تأكيد).
 *
 * التوكن يُحفظ بأمان في Script Properties. RUNTIME: V8.
 */

/* ════════════════════════════ CONFIG ════════════════════════════ */
const CFG = {
  SH_SET:   'الاعدادات',
  SH_DATA:  'بيانات الصرف',        // ← مصدر Looker (صف لكل فاتورة، upsert)
  SH_CACHE: '__plate_cache',       // hidden: orderId → plate

  API_BASE: 'https://api.mismarapp.com',
  ORIGIN:   'https://admin.mismarapp.com',
  INV_ENDPOINT: '/adminApi/v2/orders-cost-invoices',
  ORDER_ENDPOINT: '/adminApi/v1/orders/',

  INV_LIMIT: 100,
  MAX_PAGES: 300,                  // up to 30k invoices per status per run
  FETCH_CHUNK: 25,
  SOFT_TIME_LIMIT_MS: 4.7 * 60 * 1000,
  DEF_TZ: 'Asia/Riyadh',

  // Settings cells
  CELL_TOKEN:'B2', CELL_MODE:'B3', CELL_FROM:'B4', CELL_TO:'B5',
  CELL_LOC:'B6', CELL_LOC_IDS:'B7', CELL_SUP:'B8', CELL_SUP_IDS:'B9',
  CELL_STATUSES:'B10', CELL_TZ:'B11', CELL_RAW:'B12',

  // ── CONFIRMED query params (from the live admin request)
  P_DATE_FROM: 'fromPaidDate', P_DATE_TO: 'toPaidDate', P_STATUS: 'status', P_LOC_IDS: 'purchaseLocationsIds',
  P_SUP_IDS: 'spendSupplierIds',   // ← مورد الصرف بالـID (نمط مثل purchaseLocationsIds — يُرجى التأكد)
  STATUS_LABELS: { '1': 'تم الدفع', '2': 'غير مدفوعة', '3': 'الدفع بالأجل' },
  STATUS_PAID_DEFAULT: '1,3', STATUS_UNPAID_DEFAULT: '2',

  // ── VERIFY: candidate JSON field paths for each list column (first match wins).
  F_ORDER_ID:  ['orderId', 'order.id', 'orderNumber'],
  F_INVOICE_ID:['id', 'invoiceId'],
  F_AMOUNT:    ['amount', 'spendAmount', 'total', 'value', 'cost', 'price', 'paidAmount'],
  F_TYPE:      ['spendType.name', 'costType.name', 'type.name', 'spendTypeName', 'costInvoiceType.name'],
  F_SUPPLIER:  ['supplier.name', 'spendSupplier.name', 'disbursementSupplier.name', 'costSupplier.name', 'supplierName'],
  F_LOCATION:  ['purchaseLocation.name', 'spendLocation.name', 'location.name', 'purchaseLocationName'],
  F_SPEND_AT:  ['paidDate', 'paidAt', 'spendDate', 'spendAt', 'disbursementDate', 'paymentDate'],
  F_DUE_AT:    ['dueDate', 'dueAt', 'entitlementDate'],
  F_INV_AT:    ['invoiceDate', 'invoiceCreatedAt', 'createdAt'],

  // ── VERIFY: order-detail plate field candidates.
  CAR_CONTAINERS: ['usersCar', 'car', 'vehicle', 'userCar', 'orderCar', 'carInfo'],
  F_PLATE_NUM:   ['plateNumber', 'plateNumbers', 'plateNo', 'plateEnglishNumbers', 'plateArabicNumbers', 'plateDigits', 'number'],
  F_PLATE_CHARS: ['plateCharacters', 'plateChars', 'plateArabicCharacters', 'plateEnglishCharacters', 'plateLetters', 'characters', 'letters'],
  F_PLATE_FULL:  ['licensePlate', 'fullPlate', 'plateText', 'plate'],

  C_HDR:'#0d1b2a', C_ODD:'#f8f9fa', C_EVEN:'#ffffff', C_GRN:'#e6f4ea', C_ORG:'#fff3e0'
};

// ── Data sheet columns (Looker-friendly). Amount numeric; dates as ISO text.
const DI = { IID:0, OID:1, PLATE:2, LOC:3, SUP:4, TYPE:5, AMOUNT:6, SPEND:7, YEAR:8, MONTH:9, DUE:10, INV:11, PAY:12, MODE:13, MATCH:14, UPDATED:15 };
const DATA_COLS = 16;
const DATA_HEADERS = [
  'رقم الفاتورة', 'رقم الطلب', 'رقم اللوحة', 'مكان الصرف', 'مورد الصرف', 'نوع الصرف',
  'المبلغ', 'تاريخ الصرف', 'السنة', 'الشهر', 'تاريخ الاستحقاق', 'تاريخ الفاتورة',
  'حالة الدفع', 'الوضع', 'مطابقة التاريخ', 'آخر تحديث'
];

class AuthError extends Error { constructor(code){ super('AUTH_'+code); this.name='AuthError'; this.code=code; } }

/* ════════════════════════════ SETTINGS / TOKEN ════════════════════════════ */
function getConfig_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SH_SET);
  const read = (cell, def) => { try { const v = sh ? sh.getRange(cell).getValue() : ''; return (v !== '' && v != null) ? v : def; } catch(e){ return def; } };
  const mode = String(read(CFG.CELL_MODE, 'paid')).trim().toLowerCase().indexOf('unpaid') > -1 ? 'unpaid' : 'paid';
  const cleanIds = s => String(s).replace(/[^\d,]/g, '').replace(/,+/g, ',').replace(/^,|,$/g, '').trim();
  let statuses = cleanIds(read(CFG.CELL_STATUSES, ''));
  if (!statuses) statuses = (mode === 'unpaid' ? CFG.STATUS_UNPAID_DEFAULT : CFG.STATUS_PAID_DEFAULT);
  return {
    token: getToken_(sh), mode,
    dateFrom: normalizeDate_(read(CFG.CELL_FROM, '')),
    dateTo:   normalizeDate_(read(CFG.CELL_TO, '')),
    location: String(read(CFG.CELL_LOC, '')).trim(),
    locationIds: cleanIds(read(CFG.CELL_LOC_IDS, '')),
    supplier: String(read(CFG.CELL_SUP, '')).trim(),
    supplierIds: cleanIds(read(CFG.CELL_SUP_IDS, '')),
    statuses: statuses.split(',').filter(Boolean),
    tz: read(CFG.CELL_TZ, CFG.DEF_TZ),
    rawQuery: String(read(CFG.CELL_RAW, '')).trim().replace(/^\?/, '')
  };
}

function getToken_(sh) {
  const p = PropertiesService.getScriptProperties().getProperty('MISMAR_TOKEN');
  if (p && p.trim().length > 30) return p.trim();
  try { const v = sh ? sh.getRange(CFG.CELL_TOKEN).getValue() : ''; return v ? String(v).trim() : ''; } catch(e){ return ''; }
}

function setToken() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('حفظ التوكن (JWT)', 'يُحفظ بأمان في Script Properties.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const t = res.getResponseText().trim();
  if (t.length < 30) { ui.alert('التوكن غير صالح.'); return; }
  PropertiesService.getScriptProperties().setProperty('MISMAR_TOKEN', t);
  try { const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SH_SET); if (sh) sh.getRange(CFG.CELL_TOKEN).setValue('✅ محفوظ بأمان'); } catch(e){}
  ui.alert('تم حفظ التوكن.');
}

/* ════════════════════════════ UTIL ════════════════════════════ */
const Util = {
  datePrefix(v, tz) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date) return isNaN(v) ? '' : Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    const s = String(v).trim();
    const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    const d = new Date(s); return isNaN(d) ? '' : Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  },
  fmtDt(v, tz) {
    if (!v) return '';
    try { const d = v instanceof Date ? v : new Date(v); return isNaN(d) ? String(v).replace('T',' ').substr(0,16) : Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm'); }
    catch(e){ return ''; }
  },
  norm(s) { return String(s || '').replace(/[ـً-ٟ]/g,'').replace(/مركز|شركة|مؤسسة|ورشة|خدمات|لخدمات|للخدمات|سيارات|لسيارات|للسيارات/g,'').replace(/\s+/g,' ').trim().toLowerCase(); },
  dash(v) { return (v === '' || v == null) ? '—' : v; },
  safeText(v) { if (v == null) return ''; const s = String(v); return /^[=+\-@]/.test(s) ? "'" + s : s; }
};

function normalizeDate_(s) {
  if (s == null) return '';
  if (s instanceof Date && !isNaN(s)) return Utilities.formatDate(s, CFG.DEF_TZ, 'yyyy-MM-dd');
  s = String(s)
    .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0)
    .replace(/[‎‏‪-‮⁦-⁩]/g, '');
  s = s.replace(/[.\\\/]/g, '-');
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  const mm = +m[2], dd = +m[3];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

function get_(obj, path) { return path.split('.').reduce((o, k) => (o && o[k] != null) ? o[k] : undefined, obj); }
function pick_(obj, paths) { for (const p of paths) { const v = get_(obj, p); if (v !== undefined && v !== null && v !== '') return v; } return ''; }
function statusLabel_(st) { st = String(st == null ? '' : st); return CFG.STATUS_LABELS[st] || (st ? 'حالة ' + st : '—'); }

/* ════════════════════════════ API ════════════════════════════ */
const Api = {
  headers(token) {
    return { Authorization: token, Accept: 'application/json', Origin: CFG.ORIGIN, Referer: CFG.ORIGIN + '/',
      'Accept-Language': 'ar', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  },

  buildQuery(cfg, status, page) {
    const limit = CFG.INV_LIMIT, offset = (page - 1) * limit;
    if (cfg.rawQuery) {
      let q = cfg.rawQuery.replace(/([?&])(page|limit|offset)=[^&]*/g, '').replace(/^[?&]+|&+$/g, '').replace(/&&+/g, '&');
      return q + (q ? '&' : '') + `offset=${offset}&limit=${limit}&page=${page}`;
    }
    let q = 'businessOrderTypes=B2B_business';
    if (cfg.mode === 'paid' && cfg.dateFrom && cfg.dateTo) q += `&${CFG.P_DATE_FROM}=${cfg.dateFrom}&${CFG.P_DATE_TO}=${cfg.dateTo}`;
    if (status) q += `&${CFG.P_STATUS}=${status}`;
    if (cfg.locationIds) q += `&${CFG.P_LOC_IDS}=${cfg.locationIds}`;
    if (cfg.supplierIds) q += `&${CFG.P_SUP_IDS}=${cfg.supplierIds}`;
    q += `&offset=${offset}&limit=${limit}&page=${page}`;
    return q;
  },

  fetchAllInvoices(cfg) {
    const rows = [];
    const statusList = cfg.rawQuery ? [null] : (cfg.statuses.length ? cfg.statuses : [null]);
    for (const status of statusList) {
      for (let page = 1; page <= CFG.MAX_PAGES; page++) {
        const url = `${CFG.API_BASE}${CFG.INV_ENDPOINT}?${this.buildQuery(cfg, status, page)}`;
        const r = UrlFetchApp.fetch(url, { method: 'get', headers: this.headers(cfg.token), muteHttpExceptions: true });
        const code = r.getResponseCode();
        if (code === 401 || code === 403) throw new AuthError(code);
        if (code !== 200) { console.warn(`page ${page} status ${status} → HTTP ${code}`); break; }
        let raw = [], total = 0;
        try { const j = JSON.parse(r.getContentText()); const d = j.data || {}; raw = Array.isArray(d.raw) ? d.raw : []; total = d.total || 0; }
        catch(e){ console.warn('parse failed: ' + e); break; }
        raw.forEach(i => rows.push(parseInvoice_(i, status)));
        if (raw.length < CFG.INV_LIMIT) break;
        if (total && page * CFG.INV_LIMIT >= total) break;
      }
    }
    console.log('invoices fetched: ' + rows.length);
    return rows;
  },

  fetchOrderDetails(orderIds, token, softDeadline) {
    const out = {}; let truncated = false;
    for (let i = 0; i < orderIds.length; i += CFG.FETCH_CHUNK) {
      if (softDeadline && Date.now() > softDeadline) { truncated = true; break; }
      const chunk = orderIds.slice(i, i + CFG.FETCH_CHUNK);
      const reqs = chunk.map(id => ({ url: `${CFG.API_BASE}${CFG.ORDER_ENDPOINT}${id}`, method: 'get', headers: this.headers(token), muteHttpExceptions: true }));
      let resps; try { resps = UrlFetchApp.fetchAll(reqs); } catch(e){ console.warn('fetchAll failed: ' + e); resps = []; }
      resps.forEach((resp, idx) => {
        const id = chunk[idx], code = resp.getResponseCode();
        if (code === 401 || code === 403) throw new AuthError(code);
        out[id] = code === 200 ? extractPlate_(resp.getContentText()) : '';
      });
    }
    out.__truncated = truncated;
    return out;
  }
};

function parseInvoice_(i, queriedStatus) {
  const st = (i.status !== undefined && i.status !== null && i.status !== '') ? String(i.status)
           : (queriedStatus != null ? String(queriedStatus) : '');
  return {
    orderId:   pick_(i, CFG.F_ORDER_ID) || null,
    invoiceId: pick_(i, CFG.F_INVOICE_ID) || null,
    amount:    pick_(i, CFG.F_AMOUNT),
    type:      pick_(i, CFG.F_TYPE),
    supplier:  pick_(i, CFG.F_SUPPLIER),
    location:  pick_(i, CFG.F_LOCATION) || 'غير محدد',
    spendAt:   pick_(i, CFG.F_SPEND_AT),
    dueAt:     pick_(i, CFG.F_DUE_AT),
    invAt:     pick_(i, CFG.F_INV_AT),
    status:    st,
    paid:      st ? (st !== '2') : !(i.paymentMethodId === null || i.paymentMethodId === '' || i.paymentMethodId === undefined),
    _raw: i
  };
}

/* ════════════════════════════ PLATE EXTRACTION ════════════════════════════ */
function extractPlate_(text) {
  let d; try { d = JSON.parse(text); } catch(e){ return ''; }
  const od = d.orderDetails || d.data || d || {};
  for (const key of CFG.CAR_CONTAINERS) { const car = od[key]; if (car && typeof car === 'object') { const p = plateFromCar_(car); if (p) return p; } }
  return deepFindPlate_(od, 0);
}
function plateFromCar_(car) {
  const full = pick_(car, CFG.F_PLATE_FULL);
  if (full && /[0-9٠-٩ء-ي]/.test(String(full))) return String(full).trim();
  const num = String(pick_(car, CFG.F_PLATE_NUM) || '').trim();
  const chr = String(pick_(car, CFG.F_PLATE_CHARS) || '').trim();
  return [num, chr].filter(Boolean).join(' ').trim();
}
function deepFindPlate_(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 6) return '';
  const keys = Object.keys(obj);
  if (keys.some(k => /plate|لوحة/i.test(k))) { const p = plateFromCar_(obj); if (p) return p; }
  for (const k of keys) { const v = obj[k]; if (v && typeof v === 'object') { const p = deepFindPlate_(v, depth + 1); if (p) return p; } }
  return '';
}

/* ════════════════════════════ PLATE CACHE (persistent, resumable) ════════════════════════════ */
const PlateCache = {
  _map: null,
  sheet_() {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(CFG.SH_CACHE);
    if (!sh) { sh = ss.insertSheet(CFG.SH_CACHE); sh.getRange(1, 1, 1, 2).setValues([['orderId', 'plate']]); sh.hideSheet(); }
    return sh;
  },
  load() {
    const sh = this.sheet_(); this._map = {};
    if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(r => { const id = String(r[0] || ''); if (id) this._map[id] = String(r[1] || ''); });
    return this;
  },
  has(id) { return Object.prototype.hasOwnProperty.call(this._map, String(id)); },   // fetched before (even if empty)
  get(id) { return this._map[String(id)]; },
  set(id, plate) { this._map[String(id)] = (plate == null ? '' : String(plate)); },
  save() {
    const sh = this.sheet_();
    const ids = Object.keys(this._map);
    const prev = Math.max(sh.getLastRow() - 1, 0);
    if (prev) sh.getRange(2, 1, prev, 2).clearContent();
    if (ids.length) {
      const rng = sh.getRange(2, 1, ids.length, 2); rng.setNumberFormat('@');
      rng.setValues(ids.map(id => [Util.safeText(id), Util.safeText(this._map[id])]));
    }
  }
};

/* ════════════════════════════ DATA TABLE (upsert by invoiceId) ════════════════════════════ */
const DataTable = {
  sheet_() {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(CFG.SH_DATA);
    if (!sh) sh = ss.insertSheet(CFG.SH_DATA);
    if (String(sh.getRange(1, 1).getValue()) !== DATA_HEADERS[0]) {
      sh.getRange(1, 1, 1, DATA_COLS).setValues([DATA_HEADERS]).setBackground('#0d1b2a').setFontColor('#fff').setFontWeight('bold');
      sh.setFrozenRows(1);
      [110, 100, 140, 220, 190, 150, 100, 110, 70, 90, 110, 110, 120, 90, 160, 150].forEach((w, i) => sh.setColumnWidth(i + 1, w));
    }
    return sh;
  },
  read() {
    const sh = this.sheet_();
    const rows = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, DATA_COLS).getValues() : [];
    const idx = {}; rows.forEach((r, i) => { const id = String(r[DI.IID] || ''); if (id) idx[id] = i; });
    return { sheet: sh, rows, idx };
  },
  write(rows) {
    const sh = this.sheet_();
    const prev = Math.max(sh.getLastRow() - 1, 0);
    if (prev) { const rg = sh.getRange(2, 1, prev, DATA_COLS); rg.clearContent(); rg.setBackground(null); }
    if (!rows.length) return;
    const rng = sh.getRange(2, 1, rows.length, DATA_COLS);
    rng.setNumberFormat('@');                                   // text first (dates stay ISO text)
    sh.getRange(2, DI.AMOUNT + 1, rows.length, 1).setNumberFormat('0.00');   // amount numeric for Looker
    rng.setValues(rows.map(r => r.map((v, ci) => ci === DI.AMOUNT ? (v === '' || v == null ? '' : Number(v)) : Util.safeText(v))));
    const bg = rows.map(r => Array(DATA_COLS).fill(
      !String(r[DI.PLATE] || '').trim() ? CFG.C_ORG : (String(r[DI.MATCH]).indexOf('⚠️') > -1 ? CFG.C_ORG : CFG.C_EVEN)));
    rng.setBackgrounds(bg);
  }
};

/* ════════════════════════════ MAIN: sync + enrich (resumable) ════════════════════════════ */
/** Full sync: fetch invoices for the configured scope, upsert into «بيانات الصرف»
 *  (one row per invoice — never dedupe cars), then enrich plates until the soft
 *  deadline. Safe to run repeatedly; plates complete over successive runs. */
function syncDisbursementData() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { notify_('هناك تشغيل جارٍ — تم التخطّي.'); return; }
  const t0 = Date.now();
  try {
    const cfg = getConfig_();
    if (!cfg.token || cfg.token.length < 30) { notify_('التوكن غير موجود. من القائمة: حفظ التوكن.'); return; }
    if (cfg.mode === 'paid' && !cfg.rawQuery && (!cfg.dateFrom || !cfg.dateTo)) {
      alertSafe_('وضع «paid» يحتاج «من تاريخ» و«إلى تاريخ» (مثلاً 2026-01-01 → 2026-12-31)، أو الصق كويري البحث في RAW_QUERY.'); return;
    }

    const data = DataTable.read();
    const cache = PlateCache.load();

    // 1) fetch + client-side name filters (location/supplier)
    let invoices = Api.fetchAllInvoices(cfg);
    const locNorm = Util.norm(cfg.location), supNorm = Util.norm(cfg.supplier);
    invoices = invoices.filter(inv => {
      if (locNorm && !cfg.locationIds) { const n = Util.norm(inv.location); if (n.indexOf(locNorm) === -1 && locNorm.indexOf(n) === -1) return false; }
      if (supNorm && !cfg.supplierIds) { const n = Util.norm(inv.supplier); if (n.indexOf(supNorm) === -1 && supNorm.indexOf(n) === -1) return false; }
      return true;
    });

    // 2) upsert one row per invoice (keyed by invoiceId — cars are NOT de-duplicated)
    const now = Util.fmtDt(new Date(), cfg.tz);
    invoices.forEach(inv => {
      const iid = String(inv.invoiceId || ''); if (!iid) return;
      let pos = data.idx[iid], row;
      if (pos == null) { row = new Array(DATA_COLS).fill(''); row[DI.IID] = iid; data.rows.push(row); data.idx[iid] = data.rows.length - 1; }
      else row = data.rows[pos];
      const oid = String(inv.orderId || '');
      const sp = Util.datePrefix(inv.spendAt, cfg.tz);
      row[DI.OID] = oid;
      if (cache.has(oid)) row[DI.PLATE] = cache.get(oid) || '—';   // else keep whatever we had (or '')
      row[DI.LOC] = inv.location; row[DI.SUP] = Util.dash(inv.supplier); row[DI.TYPE] = Util.dash(inv.type);
      row[DI.AMOUNT] = (inv.amount !== '' && !isNaN(Number(inv.amount))) ? Number(inv.amount) : '';
      row[DI.SPEND] = sp; row[DI.YEAR] = sp ? sp.substr(0, 4) : ''; row[DI.MONTH] = sp ? sp.substr(0, 7) : '';
      row[DI.DUE] = Util.datePrefix(inv.dueAt, cfg.tz); row[DI.INV] = Util.datePrefix(inv.invAt, cfg.tz);
      row[DI.PAY] = statusLabel_(inv.status); row[DI.MODE] = cfg.mode;
      row[DI.MATCH] = matchLabel_(cfg, sp);
      row[DI.UPDATED] = now;
    });

    // 3) enrich plates (cached, time-boxed)
    enrichPlates_(data, cache, cfg, t0 + CFG.SOFT_TIME_LIMIT_MS);

    DataTable.write(data.rows);
    PlateCache.save(cache);

    const pending = data.rows.filter(r => !String(r[DI.PLATE] || '').trim()).length;
    const secs = Math.round((Date.now() - t0) / 1000);
    notify_(`تم في ${secs}ث · فواتير ${data.rows.length}` + (pending ? ` · لوحات ناقصة ${pending} (شغّل «إكمال جلب اللوحات»)` : ' · كل اللوحات مكتملة'));
  } catch (e) {
    if (e instanceof AuthError) notify_('انتهت صلاحية التوكن (HTTP ' + e.code + '). جدّد التوكن.');
    else { notify_('خطأ: ' + e.message); console.error(e.stack || e); }
  } finally { lock.releaseLock(); }
}

/** Phase-2 only: finish missing plates WITHOUT re-fetching the invoice list. */
function enrichPlatesRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { notify_('هناك تشغيل جارٍ — تم التخطّي.'); return; }
  const t0 = Date.now();
  try {
    const cfg = getConfig_();
    if (!cfg.token || cfg.token.length < 30) { notify_('التوكن غير موجود.'); return; }
    const data = DataTable.read();
    if (!data.rows.length) { notify_('لا توجد بيانات بعد — شغّل «سحب/تحديث البيانات» أولًا.'); return; }
    const cache = PlateCache.load();
    enrichPlates_(data, cache, cfg, t0 + CFG.SOFT_TIME_LIMIT_MS);
    DataTable.write(data.rows);
    PlateCache.save(cache);
    const pending = data.rows.filter(r => !String(r[DI.PLATE] || '').trim()).length;
    notify_(pending ? `باقٍ ${pending} لوحة — أعِد التشغيل.` : 'اكتملت كل اللوحات ✅');
  } catch (e) {
    if (e instanceof AuthError) notify_('انتهت صلاحية التوكن (HTTP ' + e.code + ').');
    else { notify_('خطأ: ' + e.message); console.error(e.stack || e); }
  } finally { lock.releaseLock(); }
}

/** Fetch plates for orders not yet cached, time-boxed; apply cache to all rows. */
function enrichPlates_(data, cache, cfg, deadline) {
  const need = [...new Set(data.rows.filter(r => !String(r[DI.PLATE] || '').trim() && r[DI.OID]).map(r => String(r[DI.OID])))].filter(id => !cache.has(id));
  if (need.length) {
    const plates = Api.fetchOrderDetails(need, cfg.token, deadline);
    delete plates.__truncated;
    Object.keys(plates).forEach(id => cache.set(id, plates[id]));   // store result (even '' = fetched, no retry)
  }
  data.rows.forEach(r => { const oid = String(r[DI.OID] || ''); if (!String(r[DI.PLATE] || '').trim() && cache.has(oid)) r[DI.PLATE] = cache.get(oid) || '—'; });
}

function matchLabel_(cfg, sp) {
  if (cfg.mode === 'unpaid') return 'غير مصروفة';
  if (!sp) return '⚠️ لا يوجد تاريخ صرف';
  if (cfg.dateFrom && cfg.dateTo) return (sp >= cfg.dateFrom && sp <= cfg.dateTo) ? '✅ مطابق' : '⚠️ خارج النطاق';
  return sp;
}

/** Trigger tick: finish plates first if any are pending, else do a full sync. */
function syncTick() {
  const data = DataTable.read();
  const pending = data.rows.filter(r => !String(r[DI.PLATE] || '').trim()).length;
  if (pending > 0) enrichPlatesRun(); else syncDisbursementData();
}

/* ════════════════════════════ MENU / TRIGGERS / SETUP ════════════════════════════ */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('بيانات الصرف')
    .addItem('▶ سحب / تحديث البيانات', 'syncDisbursementData')
    .addItem('🚗 إكمال جلب اللوحات', 'enrichPlatesRun')
    .addSeparator()
    .addItem('🔐 حفظ التوكن (آمن)', 'setToken')
    .addItem('⚙ إعداد الشيت أول مرة', 'initSheets')
    .addItem('⏰ تفعيل التحديث التلقائي (كل 10 دقائق)', 'setupTriggers')
    .addItem('🗑 حذف التريغرات', 'removeTriggers')
    .addToUi();
}

function setupTriggers() {
  removeTriggers();
  ScriptApp.newTrigger('syncTick').timeBased().everyMinutes(10).create();
  alertSafe_('تم تفعيل التحديث التلقائي كل 10 دقائق (يكمل اللوحات ثم يحدّث البيانات).');
}
function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'syncTick') ScriptApp.deleteTrigger(t); });
}

function initSheets() {
  const ss = SpreadsheetApp.getActive();
  const set = ss.getSheetByName(CFG.SH_SET) || ss.insertSheet(CFG.SH_SET);
  set.clearContents(); set.clearFormats();
  set.getRange(1, 1, 12, 2).setValues([
    ['الإعداد', 'القيمة'],
    ['التوكن (JWT)', 'استخدم زر «حفظ التوكن (آمن)»'],
    ['الوضع (paid = مصروفة / unpaid = غير مصروفة)', 'paid'],
    ['من تاريخ الصرف (YYYY-MM-DD)', '2026-01-01'],
    ['إلى تاريخ الصرف (YYYY-MM-DD)', '2026-12-31'],
    ['اسم المركز (فلترة بالاسم) — فارغ = الكل', ''],
    ['purchaseLocationsIds (اختياري: فلترة بالـID)', ''],
    ['اسم مورد الصرف (فلترة بالاسم) — فارغ = الكل', ''],
    ['spendSupplierIds (اختياري: فلترة المورد بالـID)', ''],
    ['حالات الدفع (فارغ=تلقائي: paid→1,3 / unpaid→2)', ''],
    ['المنطقة الزمنية', CFG.DEF_TZ],
    ['RAW_QUERY (اختياري: الصق كويري البحث من الأدمن)', '']
  ]);
  set.getRange(1, 1, 1, 2).setBackground('#37474f').setFontColor('#fff').setFontWeight('bold');
  set.setColumnWidth(1, 360); set.setColumnWidth(2, 480); set.setFrozenRows(1);
  DataTable.sheet_(); PlateCache.sheet_();
  alertSafe_('تم الإعداد!\n1) احفظ التوكن.\n2) لسحب سنة 2026 المسددة: الوضع paid، والتاريخ 2026-01-01 → 2026-12-31.\n' +
             '3) «سحب / تحديث البيانات»، ثم «إكمال جلب اللوحات» حتى تكتمل، أو فعّل التحديث التلقائي.\n' +
             '4) اربط Looker Studio بتبويب «بيانات الصرف».\n\nملاحظة: كل فاتورة = صف؛ السيارة المكرّرة تظهر بعدد فواتيرها (لا يوجد حذف تكرار).');
}

/* ════════════════════════════ MESSAGING ════════════════════════════ */
function notify_(msg) { try { SpreadsheetApp.getActive().toast(msg, 'بيانات الصرف', 6); } catch(e){} console.log('[notify] ' + msg); }
function alertSafe_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch(e){ notify_(msg); } }
