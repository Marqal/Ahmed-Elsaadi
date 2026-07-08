/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  نظام مراقبة الفواتير — مسمار  v8.3  (analytic reports + Arabic-date fix)    ║
 * ║  Invoice Audit Monitoring System                                          ║
 * ║  Built on top of v8.x by Ahmed Elsaadi · feedback update                  ║
 * ║                                                                            ║
 * ║  v8.3: reports are now a per-agent FUNNEL (received→delivered→completed +   ║
 * ║        avg handling + completion rate) for today/week/month/custom range;  ║
 * ║        date prompts accept Arabic-Indic/Persian digits & pasted date-times ║
 * ║        (normalizeDate_) — fixes the «صيغة التاريخ غير صحيحة» popup.          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ════════════════ WHAT CHANGED vs v8.1 (this update, per feedback) ════════════════
 *
 * THE WORKFLOW (as clarified):
 *   Order becomes «تم التسليم» → it enters the audit queue → the auditor adds a
 *   «مورد الصرف» (disbursement supplier) → the invoice is settled and the order
 *   LEAVES the queue. So: supplier-added == completion, and the handling time we
 *   care about is  «تم التسليم» → «مورد الصرف».  AHT therefore starts at delivery.
 *
 * (1) ACTIVITY LOG IS NOW ONE ROW PER ORDER (upsert / update-in-place).
 *     Instead of many rows per order (entered / status-change / settled …), every
 *     order occupies a SINGLE row whose milestone cells fill in over time:
 *       وقت الجاهزية · وقت التسليم · وقت إضافة مورد الصرف · مدة المعالجة · الحالة.
 *     This keeps the log compact so reports are usable. Old multi-row logs are
 *     auto-migrated (collapsed per order) on first access. See ActivityLog.*.
 *
 * (2) «وقت إضافة مورد الصرف» NOW POPULATES. It is captured at settlement (when the
 *     order leaves the queue) from the order detail, and the handling minutes are
 *     computed as businessMinutes(deliveredAt → supplierAddedAt).
 *
 * (3) AHT STARTS ONLY AT «تم التسليم». computeMetric_() counts business minutes
 *     from the delivered timestamp for delivered orders only; ready/other orders
 *     are never counted.
 *
 * (4) DELIVERED TAB no longer has a «مورد الصرف» column (it would always be empty
 *     there, since adding the supplier removes the order from the queue). It now
 *     shows delivered-time + live handling since delivery.
 *
 * (5) DASHBOARD and «أداء المشرفين» sheets were REMOVED. A new «الأداء اليومي»
 *     tab replaces them with exactly the daily metrics requested:
 *       المشرف · إجمالي المسند · تم التسليم (قيد الإنجاز) · أنجز اليوم · متوسط المعالجة اليوم.
 *
 * (6) NEW «📆 تقرير حسب التاريخ (من - إلى)» menu item builds a report for any date
 *     range from the one-row log. Weekly/monthly reports reuse the same engine.
 *
 * ════════════════ VERIFY THESE AGAINST YOUR LIVE API ════════════════
 *   If the supplier/handling still shows «—», tune CFG.DELIVERED_STATUSES /
 *   CFG.SUPPLIER_KEYWORDS / CFG.SUPPLIER_FIELD_NAMES. Supplier time falls back to
 *   the order's last-action time at settlement, so the column should never be
 *   mysteriously blank again.
 *
 * RUNTIME: V8 (default). Keep "runtimeVersion":"V8" in appsscript.json.
 */

/* ════════════════════════════ CONFIG ════════════════════════════ */
const CFG = {
  // Sheet names
  SH_SET:      'الاعدادات',
  SH_MAIN:     'الطلبات',
  SH_DELIVERED:'الطلبات تم التسليم',
  SH_READY:    'الطلبات الجاهزة',
  SH_OTHER:    'طلبات أخرى',
  SH_NOTREADY: 'الطلبات غير الجاهزة',       // legacy (auto-migrated → SH_OTHER)
  SH_SUMMARY:  'اجمالي المراكز',
  SH_DAILY:    'الأداء اليومي',             // ── CHANGE v8.2: NEW daily performance tab
  SH_MATRIX:   'Invoice Audit Assignment Matrix',
  SH_LEAVES:   'قائمة الاجازات',
  SH_LOG:      'سجل النشاط',                // now: ONE ROW PER ORDER
  SH_LOG_ARC:  'سجل النشاط - ارشيف',
  SH_LOG_OLD:  'سجل النشاط - قديم',         // ── CHANGE v8.2: parked pre-migration log
  SH_SEARCH:   'بحث النشاط',
  SH_LOG_W:    'لوج اسبوعي',
  SH_LOG_M:    'لوج شهري',
  SH_RANGE:    'تقرير حسب التاريخ',         // ── CHANGE v8.2: custom range report output
  // REMOVED in v8.2: SH_DASH ('الداش بورد'), SH_PERF ('اداء المشرفين'), SH_STATE.
  SH_DASH_OLD: 'الداش بورد',
  SH_PERF_OLD: 'اداء المشرفين',
  SH_STATE_OLD:'__mismar_state',

  // Settings cells
  CELL_TOKEN:'B2', CELL_AHT:'B3', CELL_SHIFT_S:'B4', CELL_SHIFT_E:'B5', CELL_TZ:'B6',

  // Defaults
  DEF_AHT:5, DEF_SS:9, DEF_SE:18, DEF_TZ:'Asia/Riyadh',

  // API
  API_BASE:'https://api.mismarapp.com',
  ORIGIN:'https://admin.mismarapp.com',
  INV_LIMIT:100, MAX_PAGES:50,
  FETCH_CHUNK:25,
  SOFT_TIME_LIMIT_MS:4.5*60*1000,
  MAX_SETTLE_LOOKUPS:120,   // cap the per-run settlement detail fetches

  // Status buckets
  DELIVERED_STATUSES:['تم التسليم','تم التسليم بنجاح','delivered'],
  READY_STATUSES:['جاهز','جاهزة','مكتمل','completed','ready','تم التدقيق'],

  // «مورد الصرف» (disbursement supplier) detection at settlement
  SUPPLIER_KEYWORDS:['مورد الصرف','اضافة مورد الصرف','إضافة مورد الصرف','تم اضافة المورد','disbursement supplier'],
  SUPPLIER_FIELD_NAMES:['disbursementSupplier','costInvoiceSupplier','spendSupplier','supplier'],

  // Main sheet columns
  CM:{LOC:1,OID:2,IID:3,P1:4,P2:5,ACTIVE:6,STATUS:7,READY:8,DONE:9,DELIVERED:10,DUR:11,DELAY:12,COST:13,COLS:13},

  // Log retention
  LOG_MAX:8000,            // one row per order → grows slowly
  ARCHIVE_DAYS:30,         // completed orders older than this are archived

  // Colors
  C_HDR:'#0d1b2a', C_RED:'#fce8e6', C_GRN:'#e6f4ea', C_YEL:'#fff8e1',
  C_ORG:'#fff3e0', C_PRP:'#f3e5f5', C_BLU:'#e3f2fd', C_GRY:'#f5f5f5',
  C_ODD:'#f8f9fa', C_EVEN:'#ffffff', C_TEAL:'#e0f2f1'
};

// ── CHANGE v8.2: the log is now order-keyed. These are its (0-based) columns.
const LG = { OID:0, IID:1, LOC:2, ACTIVE:3, STATUS:4, COST:5, FIRST:6, READY:7, DELIVERED:8, SUPPLIER:9, MINS:10, STATE:11, UPDATED:12 };
const LOG_COLS = 13;
const LOG_HEADERS = [
  'رقم الاوردر', 'رقم الفاتورة', 'المركز', 'المسؤول', 'الحالة الحالية',
  'وقت إضافة الفاتورة', 'وقت الدخول للطابور', 'وقت الجاهزية', 'وقت التسليم',
  'وقت إضافة مورد الصرف', 'مدة المعالجة (دقائق)', 'الحالة', 'آخر تحديث'
];
const ST_QUEUE = 'قيد الطابور';
const ST_DONE  = 'مكتمل';

class AuthError extends Error {
  constructor(code){ super('AUTH_' + code); this.name = 'AuthError'; this.code = code; }
}

/* ════════════════════════════ SETTINGS / SECRETS ════════════════════════════ */
function getConfig_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CFG.SH_SET);
  const read = (cell, def) => {
    try { const v = sh ? sh.getRange(cell).getValue() : ''; return (v !== null && v !== '') ? v : def; }
    catch (e) { return def; }
  };
  const aht = parseInt(read(CFG.CELL_AHT, CFG.DEF_AHT), 10);
  const ss_ = parseInt(read(CFG.CELL_SHIFT_S, CFG.DEF_SS), 10);
  const se_ = parseInt(read(CFG.CELL_SHIFT_E, CFG.DEF_SE), 10);
  return {
    token: getToken_(sh),
    aht: Number.isFinite(aht) ? aht : CFG.DEF_AHT,
    shiftStart: Number.isFinite(ss_) ? ss_ : CFG.DEF_SS,
    shiftEnd: Number.isFinite(se_) ? se_ : CFG.DEF_SE,
    tz: read(CFG.CELL_TZ, CFG.DEF_TZ),
    readyStatuses: CFG.READY_STATUSES,
    deliveredStatuses: CFG.DELIVERED_STATUSES,
    supplierKeywords: CFG.SUPPLIER_KEYWORDS,
    supplierFields: CFG.SUPPLIER_FIELD_NAMES
  };
}

function getToken_(settingsSheet) {
  const p = PropertiesService.getScriptProperties().getProperty('MISMAR_TOKEN');
  if (p && p.trim().length > 30) return p.trim();
  try {
    const v = settingsSheet ? settingsSheet.getRange(CFG.CELL_TOKEN).getValue() : '';
    return v ? String(v).trim() : '';
  } catch (e) { return ''; }
}

function setToken() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('حفظ التوكن (JWT)',
    'سيُحفظ بشكل آمن في Script Properties ولن يظهر داخل الشيت لأي شخص لديه صلاحية المشاهدة.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const t = res.getResponseText().trim();
  if (t.length < 30) { ui.alert('التوكن قصير/غير صالح.'); return; }
  PropertiesService.getScriptProperties().setProperty('MISMAR_TOKEN', t);
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SH_SET);
    if (sh) sh.getRange(CFG.CELL_TOKEN).setValue('✅ محفوظ بأمان (Script Properties)');
  } catch (e) {}
  ui.alert('تم حفظ التوكن بشكل آمن.');
}

/* ════════════════════════════ UTIL ════════════════════════════ */
const Util = {
  norm(name) {
    if (!name) return '';
    return String(name)
      .replace(/[ـً-ٟ]/g, '')   // strip tatweel + Arabic diacritics
      .replace(/مركز|شركة|مؤسسة|ورشة|خدمات|لخدمات|للخدمات|سيارات|لسيارات|للسيارات/g, '')
      .replace(/\s+/g, ' ').trim().toLowerCase();
  },

  tzDateAtHour(refDate, tz, hour) {
    const ymd = Utilities.formatDate(refDate, tz, 'yyyy-MM-dd');
    const z = Utilities.formatDate(refDate, tz, 'Z');
    const hh = ('0' + hour).slice(-2);
    return new Date(`${ymd}T${hh}:00:00${z.slice(0, 3)}:${z.slice(3)}`);
  },

  /** Business minutes between two Dates, counting only [shiftStart, shiftEnd) each
   *  day in tz. O(days), capped at 60 business days. */
  businessMinutes(start, end, shiftStart, shiftEnd, tz) {
    if (!(start instanceof Date) || !(end instanceof Date)) return 0;
    let s = start.getTime(), e = end.getTime();
    if (isNaN(s) || isNaN(e) || !(e > s)) return 0;
    if (shiftEnd <= shiftStart) return Math.round((e - s) / 60000);

    let totalMs = 0, guard = 0, cursor = new Date(s);
    const MAX_DAYS = 60;
    while (cursor.getTime() < e && guard <= MAX_DAYS) {
      const dayStart = this.tzDateAtHour(cursor, tz, shiftStart).getTime();
      const dayEnd   = this.tzDateAtHour(cursor, tz, shiftEnd).getTime();
      const winStart = Math.max(s, dayStart);
      const winEnd   = Math.min(e, dayEnd);
      if (winEnd > winStart) totalMs += (winEnd - winStart);
      const next = new Date(dayStart);
      next.setDate(next.getDate() + 1);
      cursor = next;
      guard++;
    }
    return Math.round(totalMs / 60000);
  },

  fmtDuration(mins) {
    mins = Math.max(0, Math.round(mins || 0));
    const h = Math.floor(mins / 60), m = mins % 60;
    return (h > 0 ? h + 'س ' : '') + m + 'د';
  },

  /** Format any Date/ISO into "yyyy-MM-dd HH:mm" in tz (also the log's stored form). */
  fmtDt(value, tz) {
    if (!value) return '';
    try {
      const d = value instanceof Date ? value : new Date(value);
      if (isNaN(d)) return String(value).replace('T', ' ').substr(0, 16);
      return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm');
    } catch (e) { return ''; }
  },

  dash(v) { return (v === '' || v === null || v === undefined) ? '—' : v; },

  todayStr(tz) { return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'); },
  daysAgoStr(tz, n) { return Utilities.formatDate(new Date(Date.now() - n * 86400000), tz, 'yyyy-MM-dd'); },

  nowIso() { return new Date().toISOString(); },

  safeText(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /^[=+\-@]/.test(s) ? "'" + s : s;
  }
};

/* ════════════════════════════ API LAYER ════════════════════════════ */
const Api = {
  headers(token) {
    return {
      Authorization: token,
      Accept: 'application/json, text/plain, */*',
      Origin: CFG.ORIGIN,
      Referer: CFG.ORIGIN + '/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
  },

  fetchAllInvoices(token) {
    const rows = [];
    for (let page = 1; page <= CFG.MAX_PAGES; page++) {
      const url = `${CFG.API_BASE}/adminApi/v2/orders-cost-invoices` +
        `?createdByType=3&businessOrderTypes=B2B_business&status=2` +
        `&limit=${CFG.INV_LIMIT}&page=${page}`;
      const r = UrlFetchApp.fetch(url, { method: 'get', headers: this.headers(token), muteHttpExceptions: true });
      const code = r.getResponseCode();
      if (code === 401 || code === 403) throw new AuthError(code);
      if (code !== 200) { console.warn(`invoice page ${page} → HTTP ${code}`); break; }

      let raw;
      try { raw = ((JSON.parse(r.getContentText()).data) || {}).raw || []; }
      catch (e) { console.warn('invoice JSON parse failed: ' + e); break; }
      if (!raw.length) break;

      raw.forEach(i => {
        if (i.paymentMethodId !== null && i.paymentMethodId !== '') return; // unpaid only
        rows.push({
          loc: (i.purchaseLocation && i.purchaseLocation.name) ? i.purchaseLocation.name : 'غير محدد',
          orderId: i.orderId || (i.order && i.order.id) || null,
          invoiceId: i.id || null,
          createdAt: i.createdAt || ''    // cost-invoice creation time (system input time)
        });
      });
      if (raw.length < CFG.INV_LIMIT) break;
    }
    console.log('pending invoices: ' + rows.length);
    return rows;
  },

  fetchOrderDetails(orderIds, token, softDeadline) {
    const out = {};
    let truncated = false;
    for (let i = 0; i < orderIds.length; i += CFG.FETCH_CHUNK) {
      if (softDeadline && Date.now() > softDeadline) { truncated = true; break; }
      const chunk = orderIds.slice(i, i + CFG.FETCH_CHUNK);
      const requests = chunk.map(id => ({
        url: `${CFG.API_BASE}/adminApi/v1/orders/${id}`,
        method: 'get', headers: this.headers(token), muteHttpExceptions: true
      }));
      let responses;
      try { responses = UrlFetchApp.fetchAll(requests); }
      catch (e) { console.warn('fetchAll chunk failed: ' + e); responses = []; }
      responses.forEach((resp, idx) => {
        const id = chunk[idx];
        const code = resp.getResponseCode();
        if (code === 401 || code === 403) throw new AuthError(code);
        out[id] = code === 200 ? parseOrderDetail_(resp.getContentText()) : null;
      });
    }
    out.__truncated = truncated;
    return out;
  },

  fetchOrderDetail(orderId, token) {
    try {
      const r = UrlFetchApp.fetch(`${CFG.API_BASE}/adminApi/v1/orders/${orderId}`,
        { method: 'get', headers: this.headers(token), muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) return null;
      return parseOrderDetail_(r.getContentText());
    } catch (e) { return null; }
  }
};

function parseOrderDetail_(text) {
  let d;
  try { d = JSON.parse(text).orderDetails || {}; } catch (e) { return null; }
  const tracking = Array.isArray(d.statusesTracking) ? d.statusesTracking : [];
  let statusName = '—', actor = '—', actionAt = '', createdAt = d.createdAt || '';
  if (tracking.length) {
    const last = tracking[tracking.length - 1];
    const si = last.statusInfo || {};
    statusName = si.internalStatusName || si.orderStatusName || '—';
    actor = (last.creator && last.creator.name) ? last.creator.name : '—';
    if (last.actionBy === -1) actor = 'النظام تلقائي';
    actionAt = last.updatedAt || last.createdAt || '';
  }
  // best-effort dedicated "disbursement supplier" field
  let supplierName = '', supplierAt = '', supplierBy = '';
  for (const f of CFG.SUPPLIER_FIELD_NAMES) {
    const sup = d[f];
    if (sup && typeof sup === 'object') {
      supplierName = sup.name || sup.supplierName || '';
      supplierAt   = sup.createdAt || sup.addedAt || sup.assignedAt || '';
      supplierBy   = (sup.createdBy && sup.createdBy.name) || sup.addedByName || '';
      if (supplierAt || supplierName) break;
    }
  }
  return { statusName, actor, actionAt, createdAt, tracking, supplierName, supplierAt, supplierBy };
}

/* ════════════════════════════ MATRIX / LEAVES / FUZZY MATCH ════════════════════════════ */
function readMatrix_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SH_MATRIX);
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(r => {
    const loc = String(r[0]).trim();
    if (loc) map[loc] = { p1: String(r[1] || '').trim(), p2: String(r[2] || '').trim() };
  });
  return map;
}

function readOnLeave_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SH_LEAVES);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  const today = new Date(); today.setHours(12, 0, 0, 0);
  sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(r => {
    const name = String(r[0] || '').trim();
    const from = r[1] ? new Date(r[1]) : null, to = r[2] ? new Date(r[2]) : null;
    if (!name || !from || !to || isNaN(from) || isNaN(to)) return;
    from.setHours(0, 0, 0, 0); to.setHours(23, 59, 59, 999);
    if (today >= from && today <= to) out[name] = true;
  });
  return out;
}

function buildNormMap_(matrix) {
  const m = {};
  Object.keys(matrix).forEach(k => { m[Util.norm(k)] = k; });
  return m;
}

function matchLoc_(raw, matrix, normMap) {
  if (!raw) return raw;
  if (matrix[raw]) return raw;
  const n = Util.norm(raw);
  if (normMap[n]) return normMap[n];
  let best = null, bestLen = 0;
  Object.keys(normMap).forEach(nk => {
    if ((n.indexOf(nk) !== -1 || nk.indexOf(n) !== -1) && nk.length > bestLen) { bestLen = nk.length; best = normMap[nk]; }
  });
  if (best) return best;
  const words = n.split(' ').filter(w => w.length > 2);
  let bestScore = 0; best = null;
  Object.keys(normMap).forEach(nk => {
    let s = 0; words.forEach(w => { if (nk.indexOf(w) !== -1) s++; });
    if (s > bestScore) { bestScore = s; best = normMap[nk]; }
  });
  return bestScore > 0 ? best : raw;
}

/* ════════════════════════════ DOMAIN: classify / delivery / metric ════════════════════════════ */
function classifyOrder_(statusName, cfg) {
  if (!statusName || statusName === '—' || statusName === 'قيد التحديث') {
    return { cat: 'other', delivered: false, ready: false, unknown: true };
  }
  if (cfg.deliveredStatuses.some(s => statusName.indexOf(s) !== -1)) {
    return { cat: 'delivered', delivered: true, ready: true, unknown: false };
  }
  if (cfg.readyStatuses.some(s => statusName.indexOf(s) !== -1)) {
    return { cat: 'ready', delivered: false, ready: true, unknown: false };
  }
  return { cat: 'other', delivered: false, ready: false, unknown: false };
}

/** Extract the delivered timestamp + the «مورد الصرف» (supplier) timestamp from an
 *  order detail. Supplier is best-effort; at settlement we also fall back to the
 *  order's last-action time so a completion time is always available. */
function extractDeliveryInfo_(detail, cfg) {
  const info = { deliveredAt: '', deliveredBy: '—', supplierAddedAt: '', supplierAddedBy: '—', supplierName: '' };
  if (!detail) return info;
  const tracking = Array.isArray(detail.tracking) ? detail.tracking : [];
  tracking.forEach(t => {
    const si = t.statusInfo || {};
    const nm = si.internalStatusName || si.orderStatusName || '';
    const at = t.updatedAt || t.createdAt || '';
    const who = (t.actionBy === -1) ? 'النظام تلقائي' : ((t.creator && t.creator.name) ? t.creator.name : '—');
    if (cfg.deliveredStatuses.some(k => nm.indexOf(k) !== -1)) { info.deliveredAt = at; info.deliveredBy = who; }
    if (!info.supplierAddedAt && cfg.supplierKeywords.some(k => nm.indexOf(k) !== -1)) {
      info.supplierAddedAt = at; info.supplierAddedBy = who; info.supplierName = nm;
    }
  });
  if (!info.supplierAddedAt && detail.supplierAt) {
    info.supplierAddedAt = detail.supplierAt; info.supplierAddedBy = detail.supplierBy || '—'; info.supplierName = detail.supplierName || '';
  }
  return info;
}

function resolveCostDisplay_(invIso, prevRow, cfg) {
  if (invIso) return Util.fmtDt(invIso, cfg.tz);                 // system input time
  if (prevRow && prevRow[LG.COST]) return String(prevRow[LG.COST]);
  if (prevRow && prevRow[LG.FIRST]) return String(prevRow[LG.FIRST]);  // sheet first-seen fallback
  return Util.fmtDt(new Date(), cfg.tz);
}

/** ── CHANGE v8.2: AHT counts ONLY for delivered orders, from the delivered time. */
function computeMetric_(rec, cfg, nowMs) {
  if (rec.cat !== 'delivered') {
    return { mins: null, dur: '—', breach: false, note: 'لا تُحتسب (غير مُسلّمة)' };
  }
  const start = rec.deliveredAt ? new Date(rec.deliveredAt) : null;
  if (!start || isNaN(start)) return { mins: 0, dur: Util.fmtDuration(0), breach: false, note: 'بانتظار وقت التسليم' };
  const mins = Util.businessMinutes(start, new Date(nowMs), cfg.shiftStart, cfg.shiftEnd, cfg.tz);
  const breach = mins > cfg.aht;
  return { mins, dur: Util.fmtDuration(mins), breach, note: breach ? 'متأخر +' + Util.fmtDuration(mins - cfg.aht) : 'ضمن الهدف' };
}

/* ════════════════════════════ ACTIVITY LOG — one row per order (upsert) ════════════════════════════ */
const ActivityLog = {
  /** Ensure the log sheet exists in the NEW order-keyed schema (migrating an old
   *  multi-row log the first time it is seen). Returns the sheet. */
  sheet() {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(CFG.SH_LOG);
    if (!sh) { sh = ss.insertSheet(CFG.SH_LOG); this.writeHeader_(sh); return sh; }
    // detect schema by A1
    const a1 = sh.getLastColumn() >= 1 ? String(sh.getRange(1, 1).getValue()) : '';
    if (a1 !== LOG_HEADERS[0]) {
      try { this.migrateOld_(ss, sh); } catch (e) { console.warn('log migrate failed: ' + e); }
      // guarantee a valid new-schema SH_LOG exists no matter how migration ended
      sh = ss.getSheetByName(CFG.SH_LOG);
      if (!sh) { sh = ss.insertSheet(CFG.SH_LOG); this.writeHeader_(sh); }
      else if (String(sh.getRange(1, 1).getValue()) !== LOG_HEADERS[0]) this.resetTo_(sh);
    }
    return sh;
  },

  writeHeader_(sh) {
    sh.getRange(1, 1, 1, LOG_COLS).setValues([LOG_HEADERS])
      .setBackground('#1a237e').setFontColor('#fff').setFontWeight('bold');
    sh.setFrozenRows(1);
    [110, 110, 190, 160, 150, 150, 155, 150, 150, 165, 130, 110, 150].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  },

  resetTo_(sh) { sh.clear(); this.writeHeader_(sh); },

  /** Collapse an OLD multi-row (action-based) log into ONE row per order. */
  migrateOld_(ss, oldSheet) {
    const lastRow = oldSheet.getLastRow(), lastCol = Math.max(oldSheet.getLastColumn(), 1);
    const byOrder = {};
    if (lastRow >= 2) {
      const data = oldSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      // old layout: [time, source, action, oid, iid, loc, from, to, actor, mins, (cost?), (supplier?), note]
      data.forEach(r => {
        const oid = String(r[3] || '').trim(); if (!oid) return;
        const time = String(r[0] || ''), action = String(r[2] || ''), iid = String(r[4] || ''), loc = String(r[5] || ''),
              actor = String(r[8] || ''), mins = r[9], toStatus = String(r[7] || '');
        const o = byOrder[oid] || (byOrder[oid] = { iid: '', loc: '', actor: '', status: '', first: '', ready: '', delivered: '', supplier: '', mins: '', state: ST_QUEUE });
        if (iid) o.iid = iid;
        if (loc) o.loc = loc;
        if (actor && actor !== '—' && actor !== 'النظام تلقائي') o.actor = actor;
        if (toStatus) o.status = toStatus;
        // rows are appended chronologically → first touch = queue entry (received)
        if (!o.first) o.first = time;
        if ((action.indexOf('جاهز') > -1 || toStatus.indexOf('جاهز') > -1) && !o.ready) o.ready = time;
        // delivery may be an explicit action OR a status-change into «تم التسليم»
        if (action.indexOf('تسليم') > -1 || toStatus.indexOf('تم التسليم') > -1) { o.delivered = time; o.status = 'تم التسليم'; }
        if (action.indexOf('تسوية') > -1) { o.supplier = time; o.state = ST_DONE; if (mins !== '' && mins != null) o.mins = mins; }
      });
    }
    // park old sheet, create fresh new-schema sheet, write collapsed rows
    try { if (!ss.getSheetByName(CFG.SH_LOG_OLD)) oldSheet.setName(CFG.SH_LOG_OLD); else oldSheet.setName(CFG.SH_LOG_OLD + ' ' + Utilities.formatDate(new Date(), CFG.DEF_TZ, 'MMdd-HHmm')); }
    catch (e) {}
    const sh = ss.insertSheet(CFG.SH_LOG);
    this.writeHeader_(sh);
    const rows = Object.keys(byOrder).map(oid => {
      const o = byOrder[oid];
      const out = new Array(LOG_COLS).fill('');
      out[LG.OID] = oid; out[LG.IID] = o.iid; out[LG.LOC] = o.loc; out[LG.ACTIVE] = o.actor; out[LG.STATUS] = o.status;
      out[LG.FIRST] = o.first; out[LG.READY] = o.ready; out[LG.DELIVERED] = o.delivered; out[LG.SUPPLIER] = o.supplier;
      out[LG.MINS] = o.mins; out[LG.STATE] = o.state; out[LG.UPDATED] = o.supplier || o.delivered || o.first;
      return out;
    });
    if (rows.length) sh.getRange(2, 1, rows.length, LOG_COLS).setValues(rows.map(rr => rr.map((v, ci) => ci === LG.MINS ? v : Util.safeText(v))));
    console.log(`log migrated → ${rows.length} order rows`);
  },

  /** Read the whole log into memory: {sheet, rows[][], idx{oid:pos}}. */
  read() {
    const sh = this.sheet();
    const lastRow = sh.getLastRow();
    const rows = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, LOG_COLS).getValues() : [];
    const idx = {};
    rows.forEach((r, i) => { const id = String(r[0] || ''); if (id) idx[id] = i; });
    return { sheet: sh, rows, idx };
  },

  prev(log, oid) { const p = log.idx[String(oid)]; return p != null ? log.rows[p] : null; },

  /** Upsert current queue records, detect settlements (supplier added), archive
   *  old completed rows, and write the whole thing back in one setValues. */
  update(log, records, cfg) {
    const now = Util.fmtDt(new Date(), cfg.tz);
    const currentIds = new Set();

    // (a) upsert the live queue
    records.forEach(r => {
      if (!r.orderId) return;
      const id = String(r.orderId); currentIds.add(id);
      let pos = log.idx[id], row;
      if (pos == null) {
        row = new Array(LOG_COLS).fill('');
        row[LG.OID] = id; row[LG.FIRST] = now; row[LG.STATE] = ST_QUEUE;
        log.rows.push(row); log.idx[id] = log.rows.length - 1;
      } else row = log.rows[pos];

      row[LG.IID] = r.invoiceId || row[LG.IID] || '';
      row[LG.LOC] = r.loc || row[LG.LOC] || '';
      row[LG.ACTIVE] = r.active || row[LG.ACTIVE] || '';
      row[LG.STATUS] = r.status || row[LG.STATUS] || '';
      if (!row[LG.COST] && r.costDisplay) row[LG.COST] = r.costDisplay;
      if (!row[LG.READY] && (r.cat === 'ready' || r.cat === 'delivered')) row[LG.READY] = now;
      if (!row[LG.DELIVERED] && r.cat === 'delivered') row[LG.DELIVERED] = r.deliveredAt ? Util.fmtDt(r.deliveredAt, cfg.tz) : now;
      row[LG.STATE] = ST_QUEUE;
      row[LG.UPDATED] = now;
    });

    // (b) settlement: rows still "قيد الطابور" but no longer in the queue ⇒ supplier
    //     was added ⇒ completed. Capture supplier time + handling minutes.
    let lookups = 0;
    Object.keys(log.idx).forEach(id => {
      if (currentIds.has(id)) return;
      const row = log.rows[log.idx[id]];
      if (!row || row[LG.STATE] === ST_DONE) return;
      if (lookups >= CFG.MAX_SETTLE_LOOKUPS) return;  // defer the rest to the next run
      lookups++;
      const det = Api.fetchOrderDetail(id, cfg.token);
      const di = det ? extractDeliveryInfo_(det, cfg) : null;
      const completionIso = (di && di.supplierAddedAt) || (det && det.actionAt) || Util.nowIso();
      const deliveredIso  = (di && di.deliveredAt) || '';
      row[LG.SUPPLIER] = Util.fmtDt(completionIso, cfg.tz);
      if (!row[LG.DELIVERED] && deliveredIso) row[LG.DELIVERED] = Util.fmtDt(deliveredIso, cfg.tz);
      if (deliveredIso) row[LG.MINS] = Util.businessMinutes(new Date(deliveredIso), new Date(completionIso), cfg.shiftStart, cfg.shiftEnd, cfg.tz);
      if (det && det.statusName && det.statusName !== '—') row[LG.STATUS] = det.statusName;
      if (di && di.supplierAddedBy && di.supplierAddedBy !== '—') row[LG.ACTIVE] = row[LG.ACTIVE] || di.supplierAddedBy;
      row[LG.STATE] = ST_DONE;
      row[LG.UPDATED] = now;
    });

    // (c) archive completed rows older than ARCHIVE_DAYS (keeps the hot log small)
    const cutoff = Util.daysAgoStr(cfg.tz, CFG.ARCHIVE_DAYS);
    const keep = [], arch = [];
    log.rows.forEach(r => {
      const done = r[LG.STATE] === ST_DONE;
      const dp = String(r[LG.SUPPLIER] || '').substr(0, 10);
      if (done && dp && dp < cutoff) arch.push(r); else keep.push(r);
    });
    if (arch.length) this.archive_(arch);

    // (d) write back (clear then one setValues; handles shrink from archiving)
    const sh = log.sheet;
    const prevRows = Math.max(sh.getLastRow() - 1, 0);
    if (prevRows) { const rg = sh.getRange(2, 1, prevRows, LOG_COLS); rg.clearContent(); rg.setBackground(null); }
    if (keep.length) {
      sh.getRange(2, 1, keep.length, LOG_COLS)
        .setValues(keep.map(rr => rr.map((v, ci) => ci === LG.MINS ? v : Util.safeText(v))));
      sh.getRange(2, 1, keep.length, LOG_COLS).setNumberFormat('@');
      sh.getRange(2, LG.MINS + 1, keep.length, 1).setNumberFormat('0');
      // subtle status coloring
      const bg = keep.map(r => Array(LOG_COLS).fill(r[LG.STATE] === ST_DONE ? CFG.C_GRN : CFG.C_EVEN));
      sh.getRange(2, 1, keep.length, LOG_COLS).setBackgrounds(bg);
    }
    console.log(`log: ${keep.length} rows (settled this run: ${lookups}, archived: ${arch.length})`);
  },

  archive_(rows) {
    const ss = SpreadsheetApp.getActive();
    let arc = ss.getSheetByName(CFG.SH_LOG_ARC);
    // ── FIX v8.3: an archive left by v8.1 shares this name but has the OLD schema.
    // Park it so we never mix schemas in one sheet (which would corrupt reports).
    if (arc && String(arc.getRange(1, 1).getValue()) !== LOG_HEADERS[0]) {
      try { arc.setName(CFG.SH_LOG_ARC + ' - قديم'); } catch (e) {}
      arc = null;
    }
    if (!arc) { arc = ss.insertSheet(CFG.SH_LOG_ARC); arc.getRange(1, 1, 1, LOG_COLS).setValues([LOG_HEADERS]); arc.setFrozenRows(1); }
    arc.getRange(arc.getLastRow() + 1, 1, rows.length, LOG_COLS)
       .setValues(rows.map(rr => rr.map((v, ci) => ci === LG.MINS ? v : Util.safeText(v))));
  },

  /** All log rows (live + archive) as arrays — used by reports/daily.
   *  ── FIX v8.3: the live log is fetched via sheet() so it is MIGRATED to the new
   *  schema first. Reading it raw (as before) meant a report run before runMismar
   *  read the OLD schema with new indices → order id showed up in the «المشرف»
   *  column. sheet() guarantees the new order-keyed layout. */
  allRows() {
    const out = [];
    const ss = SpreadsheetApp.getActive();
    const live = this.sheet();   // ← ensures migration to the new schema
    if (live.getLastRow() >= 2) out.push(...live.getRange(2, 1, live.getLastRow() - 1, LOG_COLS).getValues());
    const arc = ss.getSheetByName(CFG.SH_LOG_ARC);
    // only include the archive if it is in the NEW schema (skip a stale v8.1 archive)
    if (arc && arc.getLastRow() >= 2 && String(arc.getRange(1, 1).getValue()) === LOG_HEADERS[0]) {
      out.push(...arc.getRange(2, 1, arc.getLastRow() - 1, LOG_COLS).getValues());
    }
    return out;
  }
};

/** ── FIX v8.3: resolve the responsible supervisor for a log row. A supervisor
 *  name is never purely numeric, so if the stored value is empty / «النظام تلقائي»
 *  / an order-id leak, fall back to the assigned auditor (matrix P1) by center.
 *  This is what stops the «المشرف» column from showing order/invoice numbers. */
function logAgent_(row, matrix) {
  let a = String(row[LG.ACTIVE] || '').trim();
  const loc = String(row[LG.LOC] || '').trim();
  if ((!a || a === '—' || a === 'النظام تلقائي' || /^\d+$/.test(a)) && matrix && matrix[loc] && matrix[loc].p1) {
    a = matrix[loc].p1;
  }
  return a && !/^\d+$/.test(a) ? a : '—';   // never return a bare number as a name
}

/** Aggregate COMPLETED orders whose supplier-added date is within [fromStr,toStr]
 *  (yyyy-MM-dd inclusive) → per-supervisor {count, sumMins, cnt, avg}. */
function completedByActor_(fromStr, toStr) {
  const out = {};
  const matrix = readMatrix_();
  ActivityLog.allRows().forEach(r => {
    if (r[LG.STATE] !== ST_DONE) return;
    const dp = String(r[LG.SUPPLIER] || '').substr(0, 10);
    if (!dp || dp < fromStr || dp > toStr) return;
    const actor = logAgent_(r, matrix);
    const mins = Number(r[LG.MINS]) || 0;
    const o = out[actor] || (out[actor] = { count: 0, sumMins: 0, cnt: 0 });
    o.count++; if (mins > 0) { o.sumMins += mins; o.cnt++; }
  });
  Object.keys(out).forEach(k => { out[k].avg = out[k].cnt ? Math.round(out[k].sumMins / out[k].cnt) : 0; });
  return out;
}

/* ════════════════════════════ MAIN ORCHESTRATION ════════════════════════════ */
function runMismar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { notify_('هناك تحديث جارٍ بالفعل — تم التخطّي.'); return; }

  const t0 = Date.now();
  try {
    const cfg = getConfig_();
    if (!cfg.token || cfg.token.length < 30) {
      notify_('التوكن غير موجود. من القائمة: نظام مسمار ← حفظ التوكن (آمن).');
      return;
    }

    const ss = SpreadsheetApp.getActive();
    const matrix = readMatrix_();
    const normMap = buildNormMap_(matrix);
    const onLeave = readOnLeave_();
    const log = ActivityLog.read();     // one-row-per-order store (also our change-detection state)

    // 1) pending invoices
    const invoices = Api.fetchAllInvoices(cfg.token);
    invoices.forEach(inv => { inv.locM = matchLoc_(inv.loc, matrix, normMap); });

    // 2) unique orders + concurrent detail enrichment
    const orderIds = [...new Set(invoices.map(i => i.orderId).filter(Boolean).map(String))];
    const details = Api.fetchOrderDetails(orderIds, cfg.token, t0 + CFG.SOFT_TIME_LIMIT_MS);
    const truncated = details.__truncated === true; delete details.__truncated;

    // 3) build records
    const nowMs = Date.now();
    const records = invoices.map(inv => {
      const mx = matrix[inv.locM] || { p1: '—', p2: '—' };
      const active = (mx.p1 && onLeave[mx.p1]) ? (mx.p2 || mx.p1) : (mx.p1 || '—');
      const det = inv.orderId ? details[String(inv.orderId)] : null;
      const prev = inv.orderId ? ActivityLog.prev(log, inv.orderId) : null;

      let status, cls;
      if (det) { status = det.statusName; cls = classifyOrder_(status, cfg); }
      else if (inv.orderId && truncated && !(String(inv.orderId) in details)) { status = 'قيد التحديث'; cls = classifyOrder_('قيد التحديث', cfg); }
      else { status = '—'; cls = classifyOrder_('—', cfg); }

      // delivered timestamp (AHT start). From tracking; else last action time.
      let deliveredAt = '';
      if (cls.delivered) { const di = extractDeliveryInfo_(det, cfg); deliveredAt = di.deliveredAt || (det && det.actionAt) || ''; }

      const rec = {
        loc: inv.locM, orderId: inv.orderId, invoiceId: inv.invoiceId,
        p1: mx.p1 || '—', p2: mx.p2 || '—', active, status,
        cat: cls.cat, delivered: cls.delivered, ready: cls.ready, unknown: cls.unknown,
        deliveredAt, costDisplay: resolveCostDisplay_(inv.createdAt, prev, cfg),
        p1OnLeave: !!onLeave[mx.p1]
      };
      rec.metric = computeMetric_(rec, cfg, nowMs);
      return rec;
    });

    // 4) upsert the one-row-per-order log + detect settlements (supplier added)
    ActivityLog.update(log, records, cfg);

    // 5) render (batched)
    renderMain_(ss, records, cfg);
    renderStatusTabs_(ss, records, cfg);
    renderSummary_(ss, records, matrix, onLeave, cfg);
    renderDailyPerformance_(ss, records, onLeave, cfg);

    const secs = Math.round((Date.now() - t0) / 1000);
    const delivered = records.filter(r => r.cat === 'delivered').length;
    notify_(`تم التحديث في ${secs}ث · فواتير ${invoices.length} · تم التسليم ${delivered}` + (truncated ? ' · (تحديث جزئي)' : ''));
    console.log(`runMismar done in ${secs}s`);
  } catch (e) {
    if (e instanceof AuthError) {
      notify_('انتهت صلاحية التوكن (HTTP ' + e.code + '). جدّده من: نظام مسمار ← حفظ التوكن.');
      console.error('Auth failed: ' + e.message);
    } else {
      notify_('خطأ أثناء التحديث: ' + e.message);
      console.error(e.stack || e);
    }
  } finally {
    lock.releaseLock();
  }
}

/* ════════════════════════════ RENDER HELPERS ════════════════════════════ */
function getOrCreateSheet_(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }

function renderTable_(sh, titleRow, header, body, colorFn, widths, opts) {
  opts = opts || {};
  sh.clearContents(); sh.clearFormats();
  let top = 1;
  const cols = header.length;
  if (titleRow) {
    sh.getRange(1, 1, 1, cols).merge().setValue(titleRow)
      .setBackground(CFG.C_HDR).setFontColor('#fff').setFontSize(13).setFontWeight('bold')
      .setHorizontalAlignment('center');
    sh.setRowHeight(1, 42); top = 2;
  }
  sh.getRange(top, 1, 1, cols).setValues([header])
    .setBackground(opts.headerBg || '#1565c0').setFontColor('#fff').setFontWeight('bold')
    .setFontSize(10).setHorizontalAlignment('center');
  sh.setRowHeight(top, 30);

  if (body.length) {
    const start = top + 1;
    sh.getRange(start, 1, body.length, cols).setValues(body.map(r => r.map(Util.safeText)));
    if (colorFn) {
      const bg = body.map((r, i) => Array(cols).fill(colorFn(r, i)));
      sh.getRange(start, 1, body.length, cols).setBackgrounds(bg);
    }
    sh.getRange(start, 1, body.length, cols).setNumberFormat('@');
  }
  if (widths) widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setFrozenRows(top);
}

function queueSort_(a, b) {
  // delivered breaches first, then delivered, then ready, then other
  const rank = r => r.cat === 'delivered' ? (r.metric.breach ? 0 : 1) : (r.cat === 'ready' ? 2 : 3);
  const d = rank(a) - rank(b);
  return d !== 0 ? d : ((b.metric.mins || 0) - (a.metric.mins || 0));
}

function rowColor_(r) {
  if (r.cat === 'delivered') return r.metric.breach ? CFG.C_ORG : CFG.C_GRN;
  if (r.cat === 'ready') return CFG.C_BLU;
  if (r.p1OnLeave) return CFG.C_PRP;
  return CFG.C_GRY;
}

/* ── Main work queue (الطلبات) ── */
function renderMain_(ss, records, cfg) {
  const sh = getOrCreateSheet_(ss, CFG.SH_MAIN);
  const C = CFG.CM;

  // preserve user-entered DONE keyed by invoiceId
  const prev = {};
  if (sh.getLastRow() >= 2 && sh.getLastColumn() >= C.IID) {
    const w = Math.min(sh.getLastColumn(), C.COLS);
    sh.getRange(2, 1, sh.getLastRow() - 1, w).getValues().forEach(r => {
      const iid = String(r[C.IID - 1] || '');
      if (iid) prev[iid] = { done: r[C.DONE - 1] === true };
    });
  }

  const open = records.slice().sort(queueSort_);
  const header = ['المركز', 'رقم الاوردر', 'رقم الفاتورة', 'P1 (اساسي)', 'P2 (احتياطي)',
    'المسؤول الفعلي', 'حالة الاوردر', 'جاهزة؟', 'تم الإنجاز؟',
    'وقت التسليم', 'مدة المعالجة (منذ التسليم)', 'الحالة/التأخير', 'وقت إضافة الفاتورة'];

  const body = open.map(r => {
    const st = prev[String(r.invoiceId)] || {};
    const readyLabel = r.delivered ? '📦 تم التسليم' : (r.ready ? '✅ جاهزة' : '⛔ غير جاهزة');
    return [r.loc, r.orderId || '—', r.invoiceId || '—', r.p1, r.p2, r.active,
      r.status, readyLabel, st.done === true,
      Util.dash(r.delivered ? Util.fmtDt(r.deliveredAt, cfg.tz) : ''), r.metric.dur, r.metric.note, Util.dash(r.costDisplay)];
  });

  sh.clearContents(); sh.clearFormats();
  sh.getRange(1, 1, 1, C.COLS).setValues([header])
    .setBackground(CFG.C_HDR).setFontColor('#fff').setFontWeight('bold')
    .setFontSize(10).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setRowHeight(1, 38); sh.setFrozenRows(1); sh.setFrozenColumns(1);

  if (body.length) {
    sh.getRange(2, 1, body.length, C.COLS).setValues(body.map(r => r.map((v, ci) =>
      ci === (C.DONE - 1) ? v : Util.safeText(v))));
    sh.getRange(2, C.DONE, body.length, 1).insertCheckboxes();
    const bg = open.map(r => Array(C.COLS).fill(rowColor_(r)));
    sh.getRange(2, 1, body.length, C.COLS).setBackgrounds(bg);
    sh.getRange(2, 1, body.length, 8).setNumberFormat('@');
    sh.getRange(2, 10, body.length, 4).setNumberFormat('@');
  }
  [225, 110, 110, 150, 150, 150, 175, 110, 90, 150, 175, 150, 150].forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

/* ── Three status tabs ── */
function renderStatusTabs_(ss, records, cfg) {
  const nowStr = Util.fmtDt(new Date(), cfg.tz);

  // a) Delivered — only «تم التسليم». AHT clock is running. NO supplier column
  //    (adding the supplier removes the order from the queue entirely).
  const delivered = records.filter(r => r.cat === 'delivered').sort((a, b) => (b.metric.mins || 0) - (a.metric.mins || 0));
  const shD = getOrCreateSheet_(ss, CFG.SH_DELIVERED);
  renderTable_(shD,
    `الطلبات تم التسليم — بانتظار مورد الصرف (${delivered.length}) | ${nowStr}`,
    ['المركز', 'رقم الاوردر', 'رقم الفاتورة', 'المسؤول الفعلي', 'الحالة',
     'وقت إضافة الفاتورة', 'وقت التسليم', 'مدة المعالجة (منذ التسليم)', 'الحالة/التأخير'],
    delivered.map(r => [r.loc, r.orderId || '—', r.invoiceId || '—', r.active, r.status,
      Util.dash(r.costDisplay), Util.dash(Util.fmtDt(r.deliveredAt, cfg.tz)), r.metric.dur, r.metric.note]),
    r => (String(r[8]) || '').indexOf('متأخر') > -1 ? CFG.C_ORG : CFG.C_GRN,
    [205, 105, 105, 165, 150, 155, 150, 190, 175],
    { headerBg: '#1b5e20' });

  // b) Ready — auditable but not yet delivered. AHT does NOT count here.
  const ready = records.filter(r => r.cat === 'ready').sort((a, b) => String(a.loc).localeCompare(String(b.loc)));
  const shR = getOrCreateSheet_(ss, CFG.SH_READY);
  renderTable_(shR,
    `الطلبات الجاهزة — بانتظار التسليم (${ready.length}) | ${nowStr}`,
    ['المركز', 'رقم الاوردر', 'رقم الفاتورة', 'المسؤول الفعلي', 'الحالة', 'وقت إضافة الفاتورة', 'ملاحظة'],
    ready.map(r => [r.loc, r.orderId || '—', r.invoiceId || '—', r.active, r.status, Util.dash(r.costDisplay), 'بانتظار التسليم — لا يُحتسب AHT']),
    () => CFG.C_BLU,
    [210, 110, 110, 165, 190, 155, 210],
    { headerBg: '#1565c0' });

  // c) Other — every remaining status
  const other = records.filter(r => r.cat === 'other').sort((a, b) => String(a.loc).localeCompare(String(b.loc)));
  const shO = getOrCreateSheet_(ss, CFG.SH_OTHER);
  renderTable_(shO,
    `طلبات أخرى — حالات مختلفة (${other.length}) | ${nowStr}`,
    ['المركز', 'رقم الاوردر', 'رقم الفاتورة', 'المسؤول الفعلي', 'الحالة', 'وقت إضافة الفاتورة', 'ملاحظة'],
    other.map(r => [r.loc, r.orderId || '—', r.invoiceId || '—', r.active, r.status, Util.dash(r.costDisplay),
      r.unknown ? 'بانتظار تحديث الحالة' : 'بانتظار جهة أخرى']),
    () => CFG.C_GRY,
    [210, 110, 110, 165, 200, 155, 175],
    { headerBg: '#546e7a' });

  // clean up the legacy single "not ready" tab
  const legacy = ss.getSheetByName(CFG.SH_NOTREADY);
  if (legacy && legacy.getName() !== CFG.SH_OTHER) { try { ss.deleteSheet(legacy); } catch (e) {} }
}

/* ── Summary by center ── */
function renderSummary_(ss, records, matrix, onLeave, cfg) {
  const sh = getOrCreateSheet_(ss, CFG.SH_SUMMARY);
  const map = {};
  records.forEach(r => {
    const m = map[r.loc] || (map[r.loc] = { total: 0, delivered: 0, ready: 0, delayed: 0, other: 0 });
    m.total++;
    if (r.cat === 'delivered') { m.delivered++; if (r.metric.breach) m.delayed++; }
    else if (r.cat === 'ready') m.ready++;
    else m.other++;
  });
  const nowStr = Util.fmtDt(new Date(), cfg.tz);
  const header = ['اسم المركز', 'اجمالي الفواتير', 'P1', 'P2', 'المسؤول الفعلي', 'تم التسليم', 'جاهزة', 'متأخرة', 'أخرى'];
  const locs = Object.keys(map).sort((a, b) => map[b].total - map[a].total);
  const body = locs.map(loc => {
    const t = map[loc], mx = matrix[loc] || { p1: '—', p2: '—' };
    const active = (mx.p1 && onLeave[mx.p1]) ? (mx.p2 || mx.p1) : (mx.p1 || '—');
    return [loc, t.total, mx.p1, mx.p2, active, t.delivered, t.ready, t.delayed, t.other];
  });
  const sum = c => body.reduce((a, r) => a + (Number(r[c]) || 0), 0);
  body.push(['الاجمالي الكلي', records.length, '', '', '', sum(5), sum(6), sum(7), sum(8)]);
  renderTable_(sh,
    `اجمالي الفواتير المعلقة لكل مركز | ${nowStr}`,
    header, body,
    (r, i) => i === body.length - 1 ? CFG.C_HDR
      : (Number(r[7]) > 0 ? CFG.C_ORG : (Number(r[5]) > 0 ? CFG.C_GRN : (i % 2 ? CFG.C_EVEN : CFG.C_ODD))),
    [230, 120, 150, 150, 150, 100, 90, 95, 90], { headerBg: '#1565c0' });
}

/* ── ── CHANGE v8.2: DAILY PERFORMANCE (replaces dashboard + supervisors perf) ── */
function renderDailyPerformance_(ss, records, onLeave, cfg) {
  const sh = getOrCreateSheet_(ss, CFG.SH_DAILY);

  // live load per supervisor
  const live = {};
  records.forEach(r => {
    if (r.active === '—') return;
    const a = live[r.active] || (live[r.active] = { total: 0, deliveredOpen: 0, breached: 0 });
    a.total++;
    if (r.cat === 'delivered') { a.deliveredOpen++; if (r.metric.breach) a.breached++; }
  });

  // today's completions (supplier added today) from the one-row log
  const today = Util.todayStr(cfg.tz);
  const done = completedByActor_(today, today);

  const nowStr = Util.fmtDt(new Date(), cfg.tz);
  const names = [...new Set([...Object.keys(live), ...Object.keys(done)])]
    .filter(n => n && n !== '—')
    .sort((a, b) => ((live[b] ? live[b].total : 0) - (live[a] ? live[a].total : 0)));

  const header = ['المشرف', 'إجمالي المسند', 'تم التسليم (قيد الإنجاز)', 'أنجز اليوم', 'متوسط المعالجة اليوم', 'متأخرة الآن'];
  const body = names.map(name => {
    const a = live[name] || { total: 0, deliveredOpen: 0, breached: 0 };
    const d = done[name] || { count: 0, avg: 0 };
    const off = !!onLeave[name];
    return [(off ? '🏖 ' : '') + name, a.total, a.deliveredOpen, d.count, d.avg ? Util.fmtDuration(d.avg) : '—', a.breached];
  });
  // totals row
  const col = c => body.reduce((s, r) => s + (Number(r[c]) || 0), 0);
  body.push(['الإجمالي', col(1), col(2), col(3), '—', col(5)]);

  renderTable_(sh,
    `الأداء اليومي — ${today} | ${nowStr}`,
    header, body,
    (r, i) => i === body.length - 1 ? CFG.C_HDR
      : (String(r[0]).indexOf('🏖') > -1 ? CFG.C_PRP
        : (Number(r[5]) > 0 ? CFG.C_ORG : (Number(r[3]) > 0 ? CFG.C_GRN : (i % 2 ? CFG.C_EVEN : CFG.C_ODD)))),
    [200, 130, 175, 120, 175, 120], { headerBg: '#1a237e' });
}

/* ════════════════════════════ REPORTS (analysis from the one-row log) ════════════════════════════ */
function buildTodayReport()   { const c = getConfig_(); const d = Util.todayStr(c.tz); buildRangeReport_(d, d, 'تقرير اليوم', CFG.SH_RANGE); try { SpreadsheetApp.setActiveSheet(SpreadsheetApp.getActive().getSheetByName(CFG.SH_RANGE)); } catch (e) {} }
function buildWeeklyReport()  { const c = getConfig_(); buildRangeReport_(Util.daysAgoStr(c.tz, 7),  Util.todayStr(c.tz), 'التقرير الأسبوعي', CFG.SH_LOG_W); }
function buildMonthlyReport() { const c = getConfig_(); buildRangeReport_(Util.daysAgoStr(c.tz, 30), Util.todayStr(c.tz), 'التقرير الشهري',  CFG.SH_LOG_M); }

/** ── FIX v8.3: robustly parse a user-typed date → 'YYYY-MM-DD'. Handles
 *  Arabic-Indic (٠-٩) & Persian (۰-۹) digits, RTL/bidi marks, «.» «/» «\» separators,
 *  single-digit m/d, and a trailing time (pasting "2026-07-01 09:12"). '' if bad.
 *  This is what fixes the «صيغة التاريخ غير صحيحة» popup for Arabic keyboards. */
function normalizeDate_(s) {
  if (s == null) return '';
  s = String(s)
    .replace(/[\u0660-\u0669]/g, d => d.charCodeAt(0) - 0x0660)   // Arabic-Indic digits -> 0-9
    .replace(/[\u06F0-\u06F9]/g, d => d.charCodeAt(0) - 0x06F0)   // Persian digits -> 0-9
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');    // strip bidi/RTL marks
  s = s.replace(/[.\\\/]/g, '-');
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  const mm = +m[2], dd = +m[3];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

/** ── CHANGE v8.3: pick a from/to date and build the analytic report for that range. */
function buildDateRangeReport() {
  const ui = SpreadsheetApp.getUi();
  const f = ui.prompt('تقرير حسب التاريخ', 'من تاريخ (مثال: 2026-07-01):', ui.ButtonSet.OK_CANCEL);
  if (f.getSelectedButton() !== ui.Button.OK) return;
  const t = ui.prompt('تقرير حسب التاريخ', 'إلى تاريخ (مثال: 2026-07-08):', ui.ButtonSet.OK_CANCEL);
  if (t.getSelectedButton() !== ui.Button.OK) return;
  const from = normalizeDate_(f.getResponseText()), to = normalizeDate_(t.getResponseText());
  if (!from || !to) { ui.alert('صيغة التاريخ غير صحيحة.\nاكتب التاريخ بصيغة سنة-شهر-يوم، مثال: 2026-07-01'); return; }
  const lo = from <= to ? from : to, hi = from <= to ? to : from;
  buildRangeReport_(lo, hi, 'تقرير حسب التاريخ', CFG.SH_RANGE);
  SpreadsheetApp.setActiveSheet(SpreadsheetApp.getActive().getSheetByName(CFG.SH_RANGE));
}

/** ── CHANGE v8.3: funnel per agent + per center for a date range, using the
 *  one-row log's milestone dates:
 *    received  = وقت الدخول للطابور within range   (كام أوردر وصله)
 *    delivered = وقت التسليم within range           (كام تم التسليم)
 *    completed = وقت إضافة مورد الصرف within range  (كام أنجز) + handling avg
 *  Counts are event-in-window so daily/weekly/monthly are directly comparable. */
function rangeFunnel_(fromStr, toStr) {
  const inRange = v => { const d = String(v || '').substr(0, 10); return d && d >= fromStr && d <= toStr; };
  const matrix = readMatrix_();
  const byAgent = {}, byLoc = {};
  const T = { received: 0, delivered: 0, completed: 0, sumMins: 0, cnt: 0 };
  ActivityLog.allRows().forEach(r => {
    const agent = logAgent_(r, matrix);   // ── FIX v8.3: robust supervisor (never an order id)
    const loc = String(r[LG.LOC] || '—') || '—';
    const a = byAgent[agent] || (byAgent[agent] = { received: 0, delivered: 0, completed: 0, sumMins: 0, cnt: 0 });
    const l = byLoc[loc] || (byLoc[loc] = { received: 0, delivered: 0, completed: 0 });
    if (inRange(r[LG.FIRST]))     { a.received++;  l.received++;  T.received++; }
    if (inRange(r[LG.DELIVERED])) { a.delivered++; l.delivered++; T.delivered++; }
    if (r[LG.STATE] === ST_DONE && inRange(r[LG.SUPPLIER])) {
      a.completed++; l.completed++; T.completed++;
      const mins = Number(r[LG.MINS]) || 0;
      if (mins > 0) { a.sumMins += mins; a.cnt++; T.sumMins += mins; T.cnt++; }
    }
  });
  Object.keys(byAgent).forEach(k => { const a = byAgent[k]; a.avg = a.cnt ? Math.round(a.sumMins / a.cnt) : 0; });
  T.avg = T.cnt ? Math.round(T.sumMins / T.cnt) : 0;
  return { byAgent, byLoc, totals: T };
}

/** Core report engine: renders the per-agent funnel (وصله/تم التسليم/أنجز +
 *  متوسط المعالجة + نسبة الإنجاز) and a per-center funnel for a date range. */
function buildRangeReport_(fromStr, toStr, title, sheetName) {
  const cfg = getConfig_();
  const ss = SpreadsheetApp.getActive();
  const { byAgent, byLoc, totals } = rangeFunnel_(fromStr, toStr);

  const sh = getOrCreateSheet_(ss, sheetName);
  sh.clearContents(); sh.clearFormats();
  const nowStr = Utilities.formatDate(new Date(), cfg.tz, 'yyyy-MM-dd HH:mm');

  // title + KPI summary line
  sh.getRange(1, 1, 1, 6).merge().setValue(`${title}  (${fromStr} ← ${toStr})`)
    .setBackground(CFG.C_HDR).setFontColor('#fff').setFontSize(14).setFontWeight('bold').setHorizontalAlignment('center');
  sh.setRowHeight(1, 44);
  sh.getRange(2, 1, 1, 6).merge().setValue(
    `وصله ${totals.received} · تم التسليم ${totals.delivered} · أنجز ${totals.completed} · ` +
    `متوسط المعالجة ${totals.avg ? Util.fmtDuration(totals.avg) : '—'} · حُدّث ${nowStr}`)
    .setBackground('#162032').setFontColor('#90caf9').setFontSize(10).setHorizontalAlignment('center');
  sh.setRowHeight(2, 24);

  // per-agent funnel
  let R = 4;
  sh.getRange(R, 1, 1, 6).setValues([['المشرف', 'وصله (دخل الطابور)', 'تم التسليم', 'أنجز (مكتمل)', 'متوسط المعالجة', 'نسبة الإنجاز']])
    .setBackground('#1976d2').setFontColor('#fff').setFontWeight('bold').setHorizontalAlignment('center'); R++;
  const agents = Object.keys(byAgent).filter(a => a !== '—')
    .sort((a, b) => (byAgent[b].received - byAgent[a].received) || (byAgent[b].completed - byAgent[a].completed));
  if (agents.length) {
    const body = agents.map(name => {
      const x = byAgent[name];
      const rate = x.received ? Math.round(x.completed / x.received * 100) + '%' : '—';
      return [name, x.received, x.delivered, x.completed, x.avg ? Util.fmtDuration(x.avg) : '—', rate];
    });
    body.push(['الإجمالي', totals.received, totals.delivered, totals.completed,
      totals.avg ? Util.fmtDuration(totals.avg) : '—',
      totals.received ? Math.round(totals.completed / totals.received * 100) + '%' : '—']);
    sh.getRange(R, 1, body.length, 6).setValues(body.map(r => r.map(Util.safeText)))
      .setBackgrounds(body.map((r, i) => Array(6).fill(i === body.length - 1 ? CFG.C_HDR : (i % 2 ? CFG.C_EVEN : CFG.C_ODD))))
      .setHorizontalAlignment('center');
    sh.getRange(R + body.length - 1, 1, 1, 6).setFontColor('#fff').setFontWeight('bold');  // totals row
    R += body.length;
  } else { sh.getRange(R, 1).setValue('لا يوجد نشاط في هذه الفترة.'); R++; }

  // per-center funnel
  R += 2;
  sh.getRange(R, 1, 1, 4).setValues([['المركز', 'وصله', 'تم التسليم', 'أنجز']])
    .setBackground('#6a1b9a').setFontColor('#fff').setFontWeight('bold').setHorizontalAlignment('center'); R++;
  const locs = Object.keys(byLoc).filter(l => l !== '—').sort((a, b) => byLoc[b].received - byLoc[a].received);
  if (locs.length) {
    const body = locs.map(loc => { const x = byLoc[loc]; return [loc, x.received, x.delivered, x.completed]; });
    sh.getRange(R, 1, body.length, 4).setValues(body.map(r => r.map(Util.safeText)))
      .setBackgrounds(body.map((r, i) => Array(4).fill(i % 2 ? CFG.C_EVEN : CFG.C_ODD))).setHorizontalAlignment('center');
    R += body.length;
  }

  [230, 175, 130, 130, 155, 120].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setFrozenRows(2);
  alertSafe_(`${title} جاهز — وصله ${totals.received} · تم التسليم ${totals.delivered} · أنجز ${totals.completed}.`);
}

/* ════════════════════════════ ACTIVITY SEARCH ════════════════════════════ */
function searchActivity() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SH_LOG);
  if (!sh || sh.getLastRow() < 2) { ui.alert('سجل النشاط فارغ.'); return; }

  const oidRes = ui.prompt('بحث النشاط', 'رقم الأوردر (اتركه فارغًا للكل):', ui.ButtonSet.OK_CANCEL);
  if (oidRes.getSelectedButton() !== ui.Button.OK) return;
  const oid = oidRes.getResponseText().trim();

  const agentRes = ui.prompt('بحث النشاط', 'اسم المشرف (اتركه فارغًا للكل):', ui.ButtonSet.OK_CANCEL);
  if (agentRes.getSelectedButton() !== ui.Button.OK) return;
  const agent = agentRes.getResponseText().trim();

  const dateRes = ui.prompt('بحث النشاط', 'التاريخ YYYY-MM-DD (يطابق أي مرحلة، فارغ=الكل):', ui.ButtonSet.OK_CANCEL);
  if (dateRes.getSelectedButton() !== ui.Button.OK) return;
  const date = dateRes.getResponseText().trim();

  const data = ActivityLog.allRows();
  const dateCols = [LG.COST, LG.FIRST, LG.READY, LG.DELIVERED, LG.SUPPLIER];
  const hits = data.filter(r => {
    if (oid && String(r[LG.OID] || '') !== oid) return false;
    if (agent && String(r[LG.ACTIVE] || '').indexOf(agent) === -1) return false;
    if (date && !dateCols.some(c => String(r[c] || '').substr(0, 10) === date)) return false;
    return true;
  });

  const out = getOrCreateSheet_(SpreadsheetApp.getActive(), CFG.SH_SEARCH);
  out.clearContents(); out.clearFormats();
  out.getRange(1, 1, 1, LOG_COLS).setValues([LOG_HEADERS]).setBackground('#1a237e').setFontColor('#fff').setFontWeight('bold');
  if (hits.length) out.getRange(2, 1, hits.length, LOG_COLS).setValues(hits.map(r => r.map(Util.safeText)));
  out.setFrozenRows(1);
  SpreadsheetApp.setActiveSheet(out);
  ui.alert(`عدد النتائج: ${hits.length}`);
}

/* ════════════════════════════ onEdit (visual only — keeps the log one-row) ════════════════════════════ */
function onEdit(e) {
  try {
    const sh = e.range.getSheet();
    if (sh.getName() !== CFG.SH_MAIN) return;
    const C = CFG.CM, row = e.range.getRow(), col = e.range.getColumn();
    if (col !== C.DONE || row <= 1) return;
    const checked = e.range.getValue() === true;
    // just highlight — completion is tracked automatically when the order leaves the queue
    sh.getRange(row, 1, 1, C.COLS).setBackground(checked ? CFG.C_YEL : null);
  } catch (err) {
    console.warn('onEdit: ' + err);
  }
}

/* ════════════════════════════ MENU / TRIGGERS / SETUP ════════════════════════════ */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('نظام مسمار')
    .addItem('▶ تشغيل التحديث الآن', 'runMismar')
    .addSeparator()
    .addItem('🔎 بحث في سجل النشاط', 'searchActivity')
    .addItem('📆 تقرير حسب التاريخ (من - إلى)', 'buildDateRangeReport')
    .addItem('📊 تقرير اليوم', 'buildTodayReport')
    .addItem('📊 التقرير الأسبوعي', 'buildWeeklyReport')
    .addItem('📅 التقرير الشهري', 'buildMonthlyReport')
    .addSeparator()
    .addItem('🔐 حفظ التوكن (آمن)', 'setToken')
    .addItem('⚙ إعداد الشيتات أول مرة', 'initSheets')
    .addItem('⏰ تفعيل التشغيل التلقائي (كل 5 دقائق)', 'setupTriggers')
    .addItem('🗑 حذف التريغرات', 'removeTriggers')
    .addToUi();
}

function setupTriggers() {
  removeTriggers();
  ScriptApp.newTrigger('runMismar').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('buildWeeklyReport').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(8).create();
  ScriptApp.newTrigger('buildMonthlyReport').timeBased().onMonthDay(1).atHour(7).create();
  alertSafe_('تم تفعيل التشغيل التلقائي:\n• تحديث كل 5 دقائق\n• تقرير أسبوعي (الأحد 8:00)\n• تقرير شهري (أول الشهر 7:00)');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const f = t.getHandlerFunction();
    if (f === 'runMismar' || f === 'buildWeeklyReport' || f === 'buildMonthlyReport') ScriptApp.deleteTrigger(t);
  });
}

function initSheets() {
  const ss = SpreadsheetApp.getActive();

  const set = ss.getSheetByName(CFG.SH_SET) || ss.insertSheet(CFG.SH_SET);
  set.clearContents(); set.clearFormats();
  set.getRange(1, 1, 6, 2).setValues([
    ['الإعداد', 'القيمة'],
    ['التوكن (JWT)', 'استخدم زر «حفظ التوكن (آمن)» — لا تضعه هنا'],
    ['AHT (دقائق)', CFG.DEF_AHT],
    ['بداية الشيفت (0-23)', CFG.DEF_SS],
    ['نهاية الشيفت (0-23)', CFG.DEF_SE],
    ['المنطقة الزمنية', CFG.DEF_TZ]
  ]);
  set.getRange(1, 1, 1, 2).setBackground('#37474f').setFontColor('#fff').setFontWeight('bold');
  set.setColumnWidth(1, 220); set.setColumnWidth(2, 520); set.setFrozenRows(1);

  const mx = ss.getSheetByName(CFG.SH_MATRIX) || ss.insertSheet(CFG.SH_MATRIX);
  if (mx.getLastRow() === 0) {
    mx.getRange(1, 1, 1, 3).setValues([['اسم المركز', 'Primary Auditor 1 (P1)', 'Primary Auditor 2 (P2)']])
      .setBackground('#1565c0').setFontColor('#fff').setFontWeight('bold').setHorizontalAlignment('center');
    [250, 200, 200].forEach((w, i) => mx.setColumnWidth(i + 1, w)); mx.setFrozenRows(1);
  }

  const lv = ss.getSheetByName(CFG.SH_LEAVES) || ss.insertSheet(CFG.SH_LEAVES);
  if (lv.getLastRow() === 0) {
    lv.getRange(1, 1, 1, 4).setValues([['اسم المشرف', 'من تاريخ', 'الى تاريخ', 'ملاحظة']])
      .setBackground('#4a148c').setFontColor('#fff').setFontWeight('bold').setHorizontalAlignment('center');
    [200, 130, 130, 180].forEach((w, i) => lv.setColumnWidth(i + 1, w)); lv.setFrozenRows(1);
  }

  // status tabs + daily performance
  const legacy = ss.getSheetByName(CFG.SH_NOTREADY);
  if (legacy && !ss.getSheetByName(CFG.SH_OTHER)) legacy.setName(CFG.SH_OTHER);
  getOrCreateSheet_(ss, CFG.SH_DELIVERED);
  getOrCreateSheet_(ss, CFG.SH_READY);
  getOrCreateSheet_(ss, CFG.SH_OTHER);
  getOrCreateSheet_(ss, CFG.SH_DAILY);

  // ── CHANGE v8.2: remove the retired dashboard / supervisors-performance / state sheets
  [CFG.SH_DASH_OLD, CFG.SH_PERF_OLD, CFG.SH_STATE_OLD].forEach(name => {
    const s = ss.getSheetByName(name); if (s) { try { ss.deleteSheet(s); } catch (e) {} }
  });

  ActivityLog.sheet();   // create/migrate the one-row-per-order log

  alertSafe_('تم الإعداد!\n\n1) احفظ التوكن من «حفظ التوكن (آمن)»\n2) أضف المراكز وP1/P2 في Matrix\n' +
             '3) أضف الإجازات عند الحاجة\n4) شغّل «تشغيل التحديث الآن»\n5) فعّل التشغيل التلقائي\n\n' +
             'ملاحظة: سجل النشاط أصبح سطرًا واحدًا لكل طلب، وAHT يبدأ من «تم التسليم» فقط.');
}

/* ════════════════════════════ UI-SAFE MESSAGING ════════════════════════════ */
function notify_(msg) {
  try { SpreadsheetApp.getActive().toast(msg, 'مسمار', 6); } catch (e) {}
  console.log('[notify] ' + msg);
}
function alertSafe_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { notify_(msg); }
}
