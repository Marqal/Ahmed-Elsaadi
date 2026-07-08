/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  مسمار — تقرير صرف الفواتير (Disbursement / Cost-Invoice Report)  v1.1       ║
 * ║  STANDALONE script — separate from the audit-monitoring script.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * WHAT IT DOES (يعمل زي فلترة صفحة «التكاليف» في الأدمن ثم يضيف رقم اللوحة):
 *   • يجلب فواتير التكلفة B2B من نفس واجهة الأدمن:
 *       GET /adminApi/v2/orders-cost-invoices
 *   • وضعان (Mode):
 *       - «paid»   : الفواتير المصروفة (تم الدفع / الدفع بالأجل) ضمن «تاريخ الصرف من–إلى».
 *       - «unpaid» : الفواتير غير المصروفة (بدون تاريخ صرف) — لا نحدد لها تاريخًا.
 *   • فلترة «مكان الصرف» بالاسم (أو بالـID)، ونوع الطلب ثابت B2B_business.
 *   • المشكلة التي يحلّها: «رقم اللوحة» غير موجود في صفحة التكاليف، فيدخل كل طلب
 *       GET /adminApi/v1/orders/{orderId}
 *     ويستخرج رقم اللوحة (أرقام + حروف)، ويتحقق أن «تاريخ الصرف» مطابق للنطاق.
 *   • يكتب النتيجة في تبويب «تقرير الصرف».
 *
 * ══════════════ معاملات الـAPI (مؤكّدة من طلب الشبكة الفعلي) ══════════════
 *   ?businessOrderTypes=B2B_business
 *    &fromPaidDate=YYYY-MM-DD &toPaidDate=YYYY-MM-DD   ← تاريخ الصرف من/إلى
 *    &status=1                                          ← حالة الدفع (1=تم الدفع)
 *    &purchaseLocationsIds=862                          ← مكان الصرف (بالـID)
 *    &offset=0 &limit=100 &page=1
 *   الرد: { data: { raw: [...], total: N } }
 *   • status: 1 = تم الدفع (مؤكّد) · 2 = غير مدفوعة (من السكربت الأول) · 3 = بالأجل (يُرجى التأكد).
 *   • «مكان الصرف» في الأدمن بالـID؛ هنا نقبل الاسم (فلترة داخلية) أو الـID (أدق، server-side).
 *   • بديل: الصق كامل كويري البحث في خانة RAW_QUERY لضمان مطابقة الأدمن 100%.
 *   • أسماء حقول عناصر الـraw (المبلغ/المورد/النوع/تاريخ الصرف) تُقرأ بمرشّحات مرنة —
 *     لو ظهر عمود فارغ أرسل لي عنصر raw واحدًا وأثبّته.
 *
 * التوكن: يُحفظ بأمان في Script Properties (زر «حفظ التوكن»)، نفس توكن مسمار.
 * RUNTIME: V8.
 */

/* ════════════════════════════ CONFIG ════════════════════════════ */
const CFG = {
  SH_SET:    'الاعدادات',
  SH_REPORT: 'تقرير الصرف',

  API_BASE: 'https://api.mismarapp.com',
  ORIGIN:   'https://admin.mismarapp.com',
  INV_ENDPOINT: '/adminApi/v2/orders-cost-invoices',
  ORDER_ENDPOINT: '/adminApi/v1/orders/',

  INV_LIMIT: 100,
  MAX_PAGES: 100,
  FETCH_CHUNK: 25,
  SOFT_TIME_LIMIT_MS: 4.5 * 60 * 1000,
  DEF_TZ: 'Asia/Riyadh',

  // Settings cells
  CELL_TOKEN:'B2', CELL_MODE:'B3', CELL_FROM:'B4', CELL_TO:'B5',
  CELL_LOC:'B6', CELL_LOC_IDS:'B7', CELL_SUP:'B8', CELL_SUP_IDS:'B9',
  CELL_STATUSES:'B10', CELL_TZ:'B11', CELL_RAW:'B12',

  // ── CONFIRMED query params (from the live admin request)
  P_DATE_FROM: 'fromPaidDate', P_DATE_TO: 'toPaidDate', P_STATUS: 'status', P_LOC_IDS: 'purchaseLocationsIds',
  P_SUP_IDS: 'spendSupplierIds',   // ← مورد الصرف بالـID (نمط مثل purchaseLocationsIds — يُرجى التأكد)
  // payment status ids: 1=تم الدفع (confirmed) · 2=غير مدفوعة · 3=بالأجل (verify)
  STATUS_LABELS: { '1': 'تم الدفع', '2': 'غير مدفوعة', '3': 'الدفع بالأجل' },
  STATUS_PAID_DEFAULT: '1,3', STATUS_UNPAID_DEFAULT: '2',

  // ── VERIFY: candidate JSON field paths for each list column (first match wins).
  F_ORDER_ID:  ['orderId', 'order.id', 'orderNumber'],
  F_INVOICE_ID:['id', 'invoiceId'],
  F_AMOUNT:    ['amount', 'spendAmount', 'total', 'value', 'cost', 'price', 'paidAmount'],
  F_TYPE:      ['spendType.name', 'costType.name', 'type.name', 'spendTypeName', 'costInvoiceType.name'],
  F_SUPPLIER:  ['supplier.name', 'spendSupplier.name', 'disbursementSupplier.name', 'costSupplier.name', 'supplierName'],
  F_LOCATION:  ['purchaseLocation.name', 'spendLocation.name', 'location.name', 'purchaseLocationName'],
  F_SPEND_AT:  ['paidDate', 'paidAt', 'spendDate', 'spendAt', 'disbursementDate', 'paymentDate'],   // ← paidDate (matches fromPaidDate/toPaidDate)
  F_DUE_AT:    ['dueDate', 'dueAt', 'entitlementDate'],
  F_INV_AT:    ['invoiceDate', 'invoiceCreatedAt', 'createdAt'],

  // ── VERIFY: order-detail plate field candidates (number + letters, or full text).
  CAR_CONTAINERS: ['usersCar', 'car', 'vehicle', 'userCar', 'orderCar', 'carInfo'],
  F_PLATE_NUM:   ['plateNumber', 'plateNumbers', 'plateNo', 'plateEnglishNumbers', 'plateArabicNumbers', 'plateDigits', 'number'],
  F_PLATE_CHARS: ['plateCharacters', 'plateChars', 'plateArabicCharacters', 'plateEnglishCharacters', 'plateLetters', 'characters', 'letters'],
  F_PLATE_FULL:  ['licensePlate', 'fullPlate', 'plateText', 'plate'],

  C_HDR:'#0d1b2a', C_ODD:'#f8f9fa', C_EVEN:'#ffffff', C_GRN:'#e6f4ea', C_ORG:'#fff3e0', C_GRY:'#f5f5f5'
};

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

  /** Build one page's query. status may be a single id (server-side) or null.
   *  RAW_QUERY (pasted from the admin) wins and only pagination is appended. */
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

  /** Fetch every page for every requested status, following data.total. */
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

/** Parse one cost-invoice list item into a flat record. */
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
    // paid = status not "2" (unpaid); fall back to paymentMethodId when status absent
    paid:      st ? (st !== '2') : !(i.paymentMethodId === null || i.paymentMethodId === '' || i.paymentMethodId === undefined),
    _raw: i
  };
}

/* ════════════════════════════ PLATE EXTRACTION ════════════════════════════
 * Plate is NOT on the cost page — only inside the order detail. The order page
 * renders it as a number ("3039") + Arabic letters ("ا س ط"). We parse
 * /adminApi/v1/orders/{id} and assemble "<number> <letters>". */
function extractPlate_(text) {
  let d; try { d = JSON.parse(text); } catch(e){ return ''; }
  const od = d.orderDetails || d.data || d || {};
  for (const key of CFG.CAR_CONTAINERS) {
    const car = od[key];
    if (car && typeof car === 'object') { const p = plateFromCar_(car); if (p) return p; }
  }
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

/* ════════════════════════════ MAIN ════════════════════════════ */
function runDisbursementReport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { notify_('هناك تشغيل جارٍ — تم التخطّي.'); return; }
  const t0 = Date.now();
  try {
    const cfg = getConfig_();
    if (!cfg.token || cfg.token.length < 30) { notify_('التوكن غير موجود. من القائمة: حفظ التوكن.'); return; }
    if (cfg.mode === 'paid' && !cfg.rawQuery && (!cfg.dateFrom || !cfg.dateTo)) {
      alertSafe_('وضع «paid» يحتاج «من تاريخ» و«إلى تاريخ»، أو الصق كويري البحث في خانة RAW_QUERY.'); return;
    }

    // 1) fetch + parse invoices (server-side: date + status + optional location IDs)
    let invoices = Api.fetchAllInvoices(cfg);

    // 2) client-side safety net (location + supplier by NAME)
    const locNorm = Util.norm(cfg.location), supNorm = Util.norm(cfg.supplier);
    invoices = invoices.filter(inv => {
      if (locNorm && !cfg.locationIds) { const n = Util.norm(inv.location); if (n.indexOf(locNorm) === -1 && locNorm.indexOf(n) === -1) return false; }
      if (supNorm && !cfg.supplierIds) { const n = Util.norm(inv.supplier); if (n.indexOf(supNorm) === -1 && supNorm.indexOf(n) === -1) return false; }
      return true;
    });

    // 3) enrich with plate (concurrent order-detail fetch)
    const orderIds = [...new Set(invoices.map(i => i.orderId).filter(Boolean).map(String))];
    const plates = Api.fetchOrderDetails(orderIds, cfg.token, t0 + CFG.SOFT_TIME_LIMIT_MS);
    const truncated = plates.__truncated === true; delete plates.__truncated;

    // 4) build rows + verify «تاريخ الصرف» matches the chosen range
    const rows = invoices.map(inv => {
      const plate = inv.orderId ? (plates[String(inv.orderId)] || '') : '';
      const dp = Util.datePrefix(inv.spendAt, cfg.tz);
      let match;
      if (cfg.mode === 'unpaid') match = 'غير مصروفة';
      else if (!dp) match = '⚠️ لا يوجد تاريخ صرف';
      else if (cfg.dateFrom && cfg.dateTo) match = (dp >= cfg.dateFrom && dp <= cfg.dateTo) ? '✅ مطابق' : '⚠️ خارج النطاق (' + dp + ')';
      else match = dp;
      return {
        orderId: inv.orderId || '—', invoiceId: inv.invoiceId || '—',
        plate: plate || '⚠️ غير متوفر', location: inv.location,
        supplier: Util.dash(inv.supplier), type: Util.dash(inv.type), amount: Util.dash(inv.amount),
        spend: inv.spendAt ? Util.fmtDt(inv.spendAt, cfg.tz) : '—',
        due: inv.dueAt ? Util.fmtDt(inv.dueAt, cfg.tz) : '—',
        payStatus: statusLabel_(inv.status),
        match
      };
    }).sort((a, b) => String(a.location).localeCompare(String(b.location)));

    renderReport_(rows, cfg, truncated);

    const secs = Math.round((Date.now() - t0) / 1000);
    notify_(`تم في ${secs}ث · النتائج ${rows.length}` + (truncated ? ' · (بعض اللوحات ستكتمل لاحقًا)' : ''));
  } catch (e) {
    if (e instanceof AuthError) { notify_('انتهت صلاحية التوكن (HTTP ' + e.code + '). جدّد التوكن.'); }
    else { notify_('خطأ: ' + e.message); console.error(e.stack || e); }
  } finally { lock.releaseLock(); }
}

/* ════════════════════════════ RENDER ════════════════════════════ */
function renderReport_(rows, cfg, truncated) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CFG.SH_REPORT) || ss.insertSheet(CFG.SH_REPORT);
  sh.clearContents(); sh.clearFormats();

  const scope = cfg.mode === 'unpaid'
    ? 'غير المصروفة (بدون تاريخ صرف)'
    : (cfg.rawQuery ? 'مصروفة — حسب فلترة الأدمن' : `مصروفة من ${cfg.dateFrom} إلى ${cfg.dateTo}`);
  const title = `تقرير صرف الفواتير — ${scope}` +
                (cfg.location ? ` · المركز: ${cfg.location}` : (cfg.locationIds ? ` · مكان الصرف #${cfg.locationIds}` : '')) +
                (cfg.supplier ? ` · المورد: ${cfg.supplier}` : (cfg.supplierIds ? ` · مورد #${cfg.supplierIds}` : '')) +
                ` · ${Util.fmtDt(new Date(), cfg.tz)}` + (truncated ? ' · (تحديث جزئي)' : '');

  const header = ['رقم الطلب', 'رقم الفاتورة', 'رقم اللوحة', 'مكان الصرف', 'مورد الصرف', 'نوع الصرف',
    'مبلغ الصرف', 'تاريخ الصرف', 'تاريخ الاستحقاق', 'حالة الدفع', 'مطابقة التاريخ'];
  const COLS = header.length;

  sh.getRange(1, 1, 1, COLS).merge().setValue(title)
    .setBackground(CFG.C_HDR).setFontColor('#fff').setFontSize(12).setFontWeight('bold').setHorizontalAlignment('center');
  sh.setRowHeight(1, 40);
  sh.getRange(2, 1, 1, COLS).setValues([header])
    .setBackground('#1565c0').setFontColor('#fff').setFontWeight('bold').setFontSize(10).setHorizontalAlignment('center');
  sh.setFrozenRows(2);

  if (rows.length) {
    const body = rows.map(r => [r.orderId, r.invoiceId, r.plate, r.location, r.supplier, r.type, r.amount, r.spend, r.due, r.payStatus, r.match]);
    const rng = sh.getRange(3, 1, body.length, COLS);
    rng.setNumberFormat('@');
    rng.setValues(body.map(row => row.map(Util.safeText)));
    const bg = rows.map((r, i) => Array(COLS).fill(
      String(r.match).indexOf('⚠️') > -1 || String(r.plate).indexOf('⚠️') > -1 ? CFG.C_ORG
      : (String(r.match).indexOf('✅') > -1 ? CFG.C_GRN : (i % 2 ? CFG.C_EVEN : CFG.C_ODD))));
    rng.setBackgrounds(bg);
  } else {
    sh.getRange(3, 1).setValue('لا توجد نتائج بهذه الفلاتر.');
  }
  [110, 110, 140, 230, 190, 150, 110, 150, 150, 130, 175].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  SpreadsheetApp.setActiveSheet(sh);
}

/* ════════════════════════════ MENU / SETUP ════════════════════════════ */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('تقرير الصرف')
    .addItem('▶ تشغيل التقرير الآن', 'runDisbursementReport')
    .addSeparator()
    .addItem('🔐 حفظ التوكن (آمن)', 'setToken')
    .addItem('⚙ إعداد الشيت أول مرة', 'initSheets')
    .addToUi();
}

function initSheets() {
  const ss = SpreadsheetApp.getActive();
  const set = ss.getSheetByName(CFG.SH_SET) || ss.insertSheet(CFG.SH_SET);
  set.clearContents(); set.clearFormats();
  set.getRange(1, 1, 12, 2).setValues([
    ['الإعداد', 'القيمة'],
    ['التوكن (JWT)', 'استخدم زر «حفظ التوكن (آمن)»'],
    ['الوضع (paid = مصروفة / unpaid = غير مصروفة)', 'paid'],
    ['من تاريخ الصرف (YYYY-MM-DD)', ''],
    ['إلى تاريخ الصرف (YYYY-MM-DD)', ''],
    ['اسم المركز (فلترة بالاسم) — فارغ = الكل', ''],
    ['purchaseLocationsIds (اختياري: فلترة بالـID، أدق)', ''],
    ['اسم مورد الصرف (فلترة بالاسم) — فارغ = الكل', ''],
    ['spendSupplierIds (اختياري: فلترة المورد بالـID)', ''],
    ['حالات الدفع (فارغ=تلقائي: paid→1,3 / unpaid→2)', ''],
    ['المنطقة الزمنية', CFG.DEF_TZ],
    ['RAW_QUERY (اختياري: الصق كويري البحث من الأدمن)', '']
  ]);
  set.getRange(1, 1, 1, 2).setBackground('#37474f').setFontColor('#fff').setFontWeight('bold');
  set.setColumnWidth(1, 360); set.setColumnWidth(2, 480); set.setFrozenRows(1);
  ss.getSheetByName(CFG.SH_REPORT) || ss.insertSheet(CFG.SH_REPORT);
  alertSafe_('تم الإعداد!\n1) احفظ التوكن.\n2) اضبط الوضع والتواريخ واسم المركز (أو الـID).\n3) شغّل «تشغيل التقرير الآن».\n\n' +
             'ملاحظة: مكان الصرف بالـID أدق (purchaseLocationsIds). بالاسم تتم الفلترة داخليًا.');
}

/* ════════════════════════════ MESSAGING ════════════════════════════ */
function notify_(msg) { try { SpreadsheetApp.getActive().toast(msg, 'تقرير الصرف', 6); } catch(e){} console.log('[notify] ' + msg); }
function alertSafe_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch(e){ notify_(msg); } }
