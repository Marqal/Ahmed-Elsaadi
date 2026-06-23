/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  نظام مراقبة الفواتير — مسمار  v8.1  (restructure + delivery analytics)     ║
 * ║  Invoice Audit Monitoring System                                          ║
 * ║  Built on top of v8.0 by Ahmed Elsaadi · feature update                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ════════════════ WHAT CHANGED vs v8.0 (this update) ════════════════
 *
 * (1) SHEET RESTRUCTURE — three status tabs instead of two:
 *       • "الطلبات تم التسليم"  (Delivered Orders)  → ONLY status «تم التسليم».
 *       • "الطلبات الجاهزة"     (Ready Orders)      → ready/auditable but NOT yet delivered.
 *       • "طلبات أخرى"          (Other Orders)      → every remaining status.
 *     The old single «الطلبات غير الجاهزة» tab is auto-migrated to «طلبات أخرى».
 *     New classifier classifyOrder_() returns one of: delivered | ready | other.
 *
 * (2) INVOICE / COST DATE TRACKING — capture WHEN the cost-invoice was created
 *     (NOT the order creation date). resolveCostDate_() prefers the API's
 *     invoice.createdAt (system input time); if absent it falls back to the
 *     moment our sheet first saw the invoice (sheet-addition time, persisted in
 *     the hidden state sheet as firstSeenAt). Surfaced as a new column on the
 *     main sheet + all three status tabs + the activity log.
 *
 * (3) DASHBOARD REWRITE — fully batched writes (a handful of setValues/
 *     setBackgrounds calls instead of hundreds of per-cell calls → much faster
 *     load). Richer KPI cards (delivered today, SLA %, avg handling time) and a
 *     redesigned «أداء المشرفين» block that now shows delivered-today, supplier-
 *     add count and average handling time per supervisor.
 *
 * (4) DELIVERED-ORDER ANALYTICS + SUPERVISOR PERFORMANCE — for delivered orders
 *     we now capture:
 *        a. the exact timestamp the «مورد الصرف» (disbursement supplier) was added
 *           (extractDeliveryInfo_ scans statusesTracking + a dedicated field).
 *        b. the handling time = business-minutes from the chosen milestone
 *           (default: supplier-added) until completion (delivery).
 *     Both are written to the structured activity log (2 new columns) and rolled
 *     up into «أداء المشرفين» + the dashboard + the weekly/monthly reports.
 *
 * ════════════════ VERIFY THESE AGAINST YOUR LIVE API ════════════════
 *  The mismar API response shape is inferred (same caveat as v8.0). If delivery
 *  / supplier tracking shows «—», adjust these CONFIG knobs:
 *    • CFG.DELIVERED_STATUSES  — keyword(s) that mark an order as delivered.
 *    • CFG.SUPPLIER_KEYWORDS   — status-name keyword(s) for "supplier added".
 *    • CFG.SUPPLIER_FIELD_NAMES— order-detail object fields that hold the supplier.
 *    • CFG.HANDLING_FROM       — 'supplier' (default) or 'assign' milestone.
 *
 * RUNTIME: V8 (default). Keep "runtimeVersion":"V8" in appsscript.json.
 */

/* ════════════════════════════ CONFIG ════════════════════════════ */
const CFG = {
  // Sheet names
  SH_SET:      'الاعدادات',
  SH_MAIN:     'الطلبات',
  SH_DELIVERED:'الطلبات تم التسليم',        // ── CHANGE v8.1: NEW dedicated delivered tab
  SH_READY:    'الطلبات الجاهزة',           // ready but NOT delivered
  SH_OTHER:    'طلبات أخرى',                // ── CHANGE v8.1: NEW "other statuses" tab
  SH_NOTREADY: 'الطلبات غير الجاهزة',       // legacy name (auto-migrated → SH_OTHER)
  SH_SUMMARY:  'اجمالي المراكز',
  SH_PERF:     'اداء المشرفين',
  SH_MATRIX:   'Invoice Audit Assignment Matrix',
  SH_LEAVES:   'قائمة الاجازات',
  SH_DASH:     'الداش بورد',
  SH_AUDIT:    'سجل النشاط',
  SH_AUDIT_ARC:'سجل النشاط - ارشيف',
  SH_SEARCH:   'بحث النشاط',
  SH_LOG_W:    'لوج اسبوعي',
  SH_LOG_M:    'لوج شهري',
  SH_STATE:    '__mismar_state',

  // Settings cells (legacy / fallback)
  CELL_TOKEN:'B2', CELL_AHT:'B3', CELL_SHIFT_S:'B4', CELL_SHIFT_E:'B5', CELL_TZ:'B6',

  // Defaults
  DEF_AHT:5, DEF_SS:9, DEF_SE:18, DEF_TZ:'Asia/Riyadh',

  // API
  API_BASE:'https://api.mismarapp.com',
  ORIGIN:'https://admin.mismarapp.com',
  INV_LIMIT:100, MAX_PAGES:50,
  FETCH_CHUNK:25,
  SOFT_TIME_LIMIT_MS:4.5*60*1000,

  // ── CHANGE v8.1: status buckets are now explicit so we can split into 3 tabs.
  // An order is DELIVERED if its status name contains any of these:
  DELIVERED_STATUSES:['تم التسليم','تم التسليم بنجاح','delivered'],
  // ...else READY (auditable) if it contains any of these:
  READY_STATUSES:['جاهز','مكتمل','جاهزة','completed','ready','تم التدقيق'],
  // ...else it falls into "Other".

  // If your workflow assigns the order at a specific status, add a keyword here
  // and AHT will start from that status's timestamp (else invoice.createdAt):
  ASSIGN_KEYWORDS:[],

  // ── CHANGE v8.1: "مورد الصرف" (disbursement supplier) detection.
  // We look for a status-tracking entry whose name contains one of these:
  SUPPLIER_KEYWORDS:['مورد الصرف','اضافة مورد الصرف','إضافة مورد الصرف','تم اضافة المورد','disbursement supplier'],
  // ...and/or a dedicated field on the order-detail object named one of these:
  SUPPLIER_FIELD_NAMES:['disbursementSupplier','costInvoiceSupplier','spendSupplier','supplier'],
  // Milestone the handling-time is measured FROM: 'supplier' (مورد الصرف) or 'assign'.
  HANDLING_FROM:'supplier',

  // Main sheet columns (── CHANGE v8.1: added COST = invoice/cost creation time)
  CM:{LOC:1,OID:2,IID:3,P1:4,P2:5,ACTIVE:6,STATUS:7,READY:8,DONE:9,ASSIGN:10,DUR:11,DELAY:12,COST:13,COLS:13},

  // ── CHANGE v8.1: activity log widened 11 → 13 (cost time + supplier time).
  AUDIT_COLS:13,

  // Audit log retention
  AUDIT_MAX:5000,
  STATE_PRUNE_DAYS:14,

  // Colors
  C_HDR:'#0d1b2a', C_RED:'#fce8e6', C_GRN:'#e6f4ea', C_YEL:'#fff8e1',
  C_ORG:'#fff3e0', C_PRP:'#f3e5f5', C_BLU:'#e3f2fd', C_GRY:'#f5f5f5',
  C_ODD:'#f8f9fa', C_EVEN:'#ffffff', C_TEAL:'#e0f2f1'
};

// ── CHANGE v8.1: single source of truth for the (now 13-column) activity log.
const AUDIT_HEADERS = [
  'الوقت', 'المصدر', 'نوع الإجراء', 'رقم الاوردر', 'رقم الفاتورة',
  'المركز', 'من حالة', 'إلى حالة', 'المنفّذ', 'مدة المعالجة (دقائق)',
  'وقت إضافة الفاتورة', 'وقت إضافة مورد الصرف', 'ملاحظة'
];

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
    deliveredStatuses: CFG.DELIVERED_STATUSES,   // ── CHANGE v8.1
    supplierKeywords: CFG.SUPPLIER_KEYWORDS,     // ── CHANGE v8.1
    supplierFields: CFG.SUPPLIER_FIELD_NAMES,    // ── CHANGE v8.1
    handlingFrom: CFG.HANDLING_FROM,             // ── CHANGE v8.1
    assignKeywords: CFG.ASSIGN_KEYWORDS
  };
}

/** Token is read from Script Properties first (secure), falling back to the
 *  legacy B2 cell so existing setups keep working. Use setToken() to migrate. */
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
  /** Normalise a center name for fuzzy matching. */
  norm(name) {
    if (!name) return '';
    return String(name)
      .replace(/[ـً-ٟ]/g, '')   // strip tatweel + Arabic diacritics
      .replace(/مركز|شركة|مؤسسة|ورشة|خدمات|لخدمات|للخدمات|سيارات|لسيارات|للسيارات/g, '')
      .replace(/\s+/g, ' ').trim().toLowerCase();
  },

  /** A Date at the given tz-local hour on refDate's day (DST-correct). */
  tzDateAtHour(refDate, tz, hour) {
    const ymd = Utilities.formatDate(refDate, tz, 'yyyy-MM-dd');
    const z = Utilities.formatDate(refDate, tz, 'Z');         // e.g. +0300
    const hh = ('0' + hour).slice(-2);
    return new Date(`${ymd}T${hh}:00:00${z.slice(0, 3)}:${z.slice(3)}`);
  },

  /** Business minutes between two Dates, counting only [shiftStart, shiftEnd)
   *  each day in tz. O(days), capped at 60 business days. */
  businessMinutes(start, end, shiftStart, shiftEnd, tz) {
    if (!(start instanceof Date) || !(end instanceof Date)) return 0;
    let s = start.getTime(), e = end.getTime();
    if (isNaN(s) || isNaN(e) || !(e > s)) return 0;
    if (shiftEnd <= shiftStart) return Math.round((e - s) / 60000);  // 24h/overnight fallback

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

  fmtDt(value, tz) {
    if (!value) return '—';
    try {
      const d = value instanceof Date ? value : new Date(value);
      if (isNaN(d)) return String(value).replace('T', ' ').substr(0, 16);
      return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm');
    } catch (e) { return '—'; }
  },

  nowIso() { return new Date().toISOString(); },

  /** Coerce to a string Sheets cannot interpret as a formula (anti-injection). */
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

  /** All pending B2B cost invoices (every page). Throws AuthError on 401/403. */
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
          // ── CHANGE v8.1: this is the COST-INVOICE creation time (system input
          // time), NOT the order creation date. Used by resolveCostDate_().
          createdAt: i.createdAt || ''
        });
      });
      if (raw.length < CFG.INV_LIMIT) break;
    }
    console.log('pending invoices: ' + rows.length);
    return rows;
  },

  /** Fetch many order details concurrently. Returns {orderId: detail|null}. */
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

  /** Single order detail (used for accurate settlement timestamps). */
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

  // ── CHANGE v8.1: best-effort dedicated "disbursement supplier" field. Some
  // APIs expose the supplier as an object rather than a tracking status; we
  // capture it here so extractDeliveryInfo_ can use it as a fallback.
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

/* ════════════════════════════ DOMAIN: classify / assign / metrics ════════════════════════════ */

/** ── CHANGE v8.1: three-way classifier driving the new tab split.
 *  Returns { cat:'delivered'|'ready'|'other', delivered, ready, blocked, unknown }. */
function classifyOrder_(statusName, cfg) {
  if (!statusName || statusName === '—' || statusName === 'قيد التحديث') {
    // Unknown / still-loading → parked in "Other", AHT paused.
    return { cat: 'other', delivered: false, ready: false, blocked: true, unknown: true };
  }
  if (cfg.deliveredStatuses.some(s => statusName.indexOf(s) !== -1)) {
    return { cat: 'delivered', delivered: true, ready: true, blocked: false, unknown: false };
  }
  if (cfg.readyStatuses.some(s => statusName.indexOf(s) !== -1)) {
    return { cat: 'ready', delivered: false, ready: true, blocked: false, unknown: false };
  }
  return { cat: 'other', delivered: false, ready: false, blocked: true, unknown: false };
}

function resolveAssignAt_(detail, invoiceCreatedAt, cfg) {
  if (detail && cfg.assignKeywords.length && detail.tracking && detail.tracking.length) {
    for (const t of detail.tracking) {
      const si = t.statusInfo || {};
      const nm = si.internalStatusName || si.orderStatusName || '';
      if (cfg.assignKeywords.some(k => nm.indexOf(k) !== -1)) return t.createdAt || t.updatedAt || invoiceCreatedAt;
    }
  }
  return invoiceCreatedAt; // default: queue entry
}

/** ── CHANGE v8.1: capture the cost/invoice timestamp.
 *  Primary = the API's invoice.createdAt (system input time).
 *  Fallback = the moment our sheet first observed this invoice (firstSeenAt),
 *  so we always have *some* "added on" time even if the API omits it. */
function resolveCostDate_(invoiceCreatedAt, prevState) {
  if (invoiceCreatedAt) return { at: invoiceCreatedAt, source: 'النظام' };
  if (prevState && prevState.firstSeenAt) return { at: prevState.firstSeenAt, source: 'الشيت' };
  return { at: Util.nowIso(), source: 'الشيت' };
}

/** ── CHANGE v8.1: extract «مورد الصرف» (supplier) + delivery milestones and
 *  compute the agent's handling time (milestone → completion). */
function extractDeliveryInfo_(detail, cfg) {
  const info = { deliveredAt: '', deliveredBy: '—', supplierAddedAt: '', supplierAddedBy: '—', supplierName: '', handlingMins: null };
  if (!detail) return info;

  const tracking = Array.isArray(detail.tracking) ? detail.tracking : [];
  tracking.forEach(t => {
    const si = t.statusInfo || {};
    const nm = si.internalStatusName || si.orderStatusName || '';
    const at = t.updatedAt || t.createdAt || '';
    const who = (t.actionBy === -1) ? 'النظام تلقائي' : ((t.creator && t.creator.name) ? t.creator.name : '—');
    // delivered → keep the LAST delivered timestamp (the actual completion).
    if (cfg.deliveredStatuses.some(k => nm.indexOf(k) !== -1)) { info.deliveredAt = at; info.deliveredBy = who; }
    // supplier added → keep the FIRST occurrence (when it entered handling).
    if (!info.supplierAddedAt && cfg.supplierKeywords.some(k => nm.indexOf(k) !== -1)) {
      info.supplierAddedAt = at; info.supplierAddedBy = who; info.supplierName = nm;
    }
  });

  // Fallback to a dedicated supplier field on the order detail.
  if (!info.supplierAddedAt && detail.supplierAt) {
    info.supplierAddedAt = detail.supplierAt;
    info.supplierAddedBy = detail.supplierBy || '—';
    info.supplierName = detail.supplierName || '';
  }
  // If still no explicit delivered status, use the last action timestamp.
  if (!info.deliveredAt && detail.actionAt) { info.deliveredAt = detail.actionAt; info.deliveredBy = detail.actor || '—'; }

  return info;
}

/** Live metric for an OPEN invoice: elapsed business time vs the AHT target. */
function liveMetric_(assignAt, blocked, cfg, nowMs) {
  if (blocked) return { mins: null, dur: '—', breach: false, note: 'غير جاهزة — لا تُحتسب' };
  const start = assignAt ? new Date(assignAt) : null;
  if (!start || isNaN(start)) return { mins: null, dur: '—', breach: false, note: '—' };
  const mins = Util.businessMinutes(start, new Date(nowMs), cfg.shiftStart, cfg.shiftEnd, cfg.tz);
  const breach = mins > cfg.aht;
  const over = mins - cfg.aht;
  return { mins, dur: Util.fmtDuration(mins), breach, note: breach ? 'متأخر +' + Util.fmtDuration(over) : 'ضمن الهدف' };
}

/* ════════════════════════════ STATE STORE (cross-run change detection) ════════════════════════════ */
// ── CHANGE v8.1: widened 7 → 10 columns (added firstSeenAt, active, deliveredAt).
const State = {
  W: 10,
  HEADERS: ['orderId','lastStatus','lastActionAt','assignAt','settled','settledAt','lastSeen','firstSeenAt','active','deliveredAt'],
  sheet_() {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(CFG.SH_STATE);
    if (!sh) {
      sh = ss.insertSheet(CFG.SH_STATE);
      sh.getRange(1, 1, 1, this.W).setValues([this.HEADERS]);
      sh.hideSheet();
    }
    return sh;
  },
  load() {
    const sh = this.sheet_();
    const map = {};
    if (sh.getLastRow() < 2) return map;
    // Read W columns even on legacy 7-col sheets — Sheets returns '' for the extras.
    sh.getRange(2, 1, sh.getLastRow() - 1, this.W).getValues().forEach(r => {
      const id = String(r[0] || ''); if (!id) return;
      map[id] = {
        lastStatus: String(r[1] || ''), lastActionAt: String(r[2] || ''), assignAt: String(r[3] || ''),
        settled: r[4] === true || r[4] === 'TRUE', settledAt: String(r[5] || ''), lastSeen: String(r[6] || ''),
        firstSeenAt: String(r[7] || ''), active: String(r[8] || ''), deliveredAt: String(r[9] || '')
      };
    });
    return map;
  },
  save(map) {
    const sh = this.sheet_();
    const cutoff = Date.now() - CFG.STATE_PRUNE_DAYS * 86400000;
    const rows = Object.keys(map).filter(id => {
      const s = map[id];
      if (s.settled && s.settledAt) { const t = new Date(s.settledAt).getTime(); if (!isNaN(t) && t < cutoff) return false; }
      return true;
    }).map(id => {
      const s = map[id];
      return [id, s.lastStatus, s.lastActionAt, s.assignAt, !!s.settled, s.settledAt || '',
              s.lastSeen || '', s.firstSeenAt || '', s.active || '', s.deliveredAt || ''];
    });
    sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), this.W).clearContent();
    if (rows.length) sh.getRange(2, 1, rows.length, this.W).setValues(rows);
  }
};

/* ════════════════════════════ AUDIT LOG (activity tracking) ════════════════════════════ */
function writeAuditHeader_(sh) {
  sh.getRange(1, 1, 1, CFG.AUDIT_COLS).setValues([AUDIT_HEADERS])
    .setBackground('#1a237e').setFontColor('#fff').setFontWeight('bold');
  sh.setFrozenRows(1);
  [155, 80, 175, 110, 110, 190, 140, 140, 150, 120, 150, 150, 200].forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

/** ── CHANGE v8.1: migrate a legacy 11-column log to the new 13-column schema
 *  by inserting the two new columns BEFORE the old «ملاحظة», preserving history. */
function ensureAuditSchema_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol >= CFG.AUDIT_COLS) return;                 // already migrated
  const hdr = sh.getRange(1, 1, 1, Math.max(lastCol, 1)).getValues()[0];
  // Legacy layout had «ملاحظة» as column 11.
  if (hdr.length >= 11 && String(hdr[10]).indexOf('ملاحظة') > -1) {
    sh.insertColumns(11, 2);                             // shifts old col11 (ملاحظة) → col13
    sh.getRange(1, 11, 1, 2).setValues([[AUDIT_HEADERS[10], AUDIT_HEADERS[11]]])
      .setBackground('#1a237e').setFontColor('#fff').setFontWeight('bold');
  } else {
    // Unknown/older layout → just (re)write the full header row.
    writeAuditHeader_(sh);
  }
}

function auditSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CFG.SH_AUDIT);
  if (!sh) { sh = ss.insertSheet(CFG.SH_AUDIT); writeAuditHeader_(sh); }
  else ensureAuditSchema_(sh);
  return sh;
}

/** Append structured rows; pads/truncates each row to AUDIT_COLS defensively. */
function appendAudit_(rows) {
  if (!rows || !rows.length) return;
  const sh = auditSheet_();
  const W = CFG.AUDIT_COLS;
  const norm = rows.map(r => { const a = r.slice(0, W); while (a.length < W) a.push(''); return a; });
  sh.getRange(sh.getLastRow() + 1, 1, norm.length, W).setValues(norm);
}

/** Keep the hot log bounded; move the oldest 30% to the archive sheet. */
function rotateAuditIfNeeded_() {
  const sh = auditSheet_();
  const n = sh.getLastRow() - 1;
  if (n <= CFG.AUDIT_MAX) return;
  const moveCount = Math.floor(CFG.AUDIT_MAX * 0.3);
  const ss = SpreadsheetApp.getActive();
  let arc = ss.getSheetByName(CFG.SH_AUDIT_ARC);
  if (!arc) { arc = ss.insertSheet(CFG.SH_AUDIT_ARC); arc.getRange(1, 1, 1, CFG.AUDIT_COLS).setValues([AUDIT_HEADERS]); arc.setFrozenRows(1); }
  const block = sh.getRange(2, 1, moveCount, CFG.AUDIT_COLS).getValues();
  arc.getRange(arc.getLastRow() + 1, 1, moveCount, CFG.AUDIT_COLS).setValues(block);
  sh.deleteRows(2, moveCount);
  console.log(`archived ${moveCount} audit rows`);
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
    const state = State.load();          // ── CHANGE v8.1: load once, reuse for cost-date + attribution

    // 1) pending invoices
    const invoices = Api.fetchAllInvoices(cfg.token);
    invoices.forEach(inv => { inv.locM = matchLoc_(inv.loc, matrix, normMap); });

    // 2) unique orders + concurrent detail enrichment
    const orderIds = [...new Set(invoices.map(i => i.orderId).filter(Boolean).map(String))];
    const details = Api.fetchOrderDetails(orderIds, cfg.token, t0 + CFG.SOFT_TIME_LIMIT_MS);
    const truncated = details.__truncated === true; delete details.__truncated;

    // 3) build the unified record set
    const nowMs = Date.now();
    const records = invoices.map(inv => {
      const mx = matrix[inv.locM] || { p1: '—', p2: '—' };
      const active = (mx.p1 && onLeave[mx.p1]) ? (mx.p2 || mx.p1) : (mx.p1 || '—');
      const det = inv.orderId ? details[String(inv.orderId)] : null;
      const prevState = inv.orderId ? state[String(inv.orderId)] : null;

      let status, cls, assignAt;
      if (det) {
        status = det.statusName; cls = classifyOrder_(status, cfg);
        assignAt = resolveAssignAt_(det, inv.createdAt, cfg);
      } else if (inv.orderId && truncated && orderIds.indexOf(String(inv.orderId)) >= 0 && !(String(inv.orderId) in details)) {
        status = 'قيد التحديث'; cls = classifyOrder_('قيد التحديث', cfg); assignAt = inv.createdAt;
      } else {
        status = '—'; cls = classifyOrder_('—', cfg); assignAt = inv.createdAt;
      }

      const m = liveMetric_(assignAt, cls.blocked, cfg, nowMs);

      // ── CHANGE v8.1: cost/invoice creation time + delivery analytics.
      const cost = resolveCostDate_(inv.createdAt, prevState);
      const di = extractDeliveryInfo_(det, cfg);
      let handlingMins = null;
      if (cls.delivered) {
        const fromAt = (cfg.handlingFrom === 'supplier' && di.supplierAddedAt) ? di.supplierAddedAt : assignAt;
        const toAt = di.deliveredAt || (det && det.actionAt) || '';
        if (fromAt && toAt) handlingMins = Util.businessMinutes(new Date(fromAt), new Date(toAt), cfg.shiftStart, cfg.shiftEnd, cfg.tz);
      }

      return {
        loc: inv.locM, orderId: inv.orderId, invoiceId: inv.invoiceId,
        p1: mx.p1 || '—', p2: mx.p2 || '—', active, status,
        cat: cls.cat, delivered: cls.delivered, ready: cls.ready, blocked: cls.blocked, unknown: cls.unknown,
        assignAt, lastActionAt: det ? det.actionAt : '', actor: det ? det.actor : '—',
        mins: m.mins, dur: m.dur, breach: m.breach, note: m.note,
        costDate: cost.at, costSource: cost.source,
        supplierAddedAt: di.supplierAddedAt, supplierAddedBy: di.supplierAddedBy, supplierName: di.supplierName,
        deliveredAt: di.deliveredAt, deliveredBy: di.deliveredBy, handlingMins,
        p1OnLeave: !!onLeave[mx.p1]
      };
    });

    // 4) change/settlement/delivery detection → audit log (mutates + saves state)
    detectAndLogChanges_(records, cfg, state);

    // 5) render everything (batched)
    renderMain_(ss, records, cfg);
    renderStatusTabs_(ss, records, cfg);     // ── CHANGE v8.1: 3 tabs (delivered/ready/other)
    renderSummary_(ss, records, matrix, onLeave, cfg);
    renderPerformance_(ss, records, onLeave, cfg);
    renderDashboard_(ss, records, onLeave, cfg, truncated);

    rotateAuditIfNeeded_();

    const secs = Math.round((Date.now() - t0) / 1000);
    const delivered = records.filter(r => r.cat === 'delivered').length;
    notify_(`تم التحديث في ${secs}ث · فواتير ${invoices.length} · تم التسليم ${delivered}` +
            (truncated ? ' · (تحديث جزئي)' : ''));
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

/** Change detection + settlement detection + delivery logging. */
function detectAndLogChanges_(records, cfg, state) {
  const now = Util.fmtDt(new Date(), cfg.tz);
  const runIso = Util.nowIso();
  const auditRows = [];
  const currentIds = new Set();

  records.forEach(r => {
    if (!r.orderId) return;
    const id = String(r.orderId);
    currentIds.add(id);
    const prev = state[id];

    // helper to push a "delivered" audit row (── CHANGE v8.1)
    const logDelivered = (fromStatus) => {
      const note = `تم التسليم بواسطة ${r.deliveredBy || '—'}` +
                   (r.supplierName ? ` | مورد: ${r.supplierName}` : '') +
                   (r.supplierAddedBy && r.supplierAddedBy !== '—' ? ` | أضاف المورد: ${r.supplierAddedBy}` : '');
      auditRows.push([
        now, 'API', 'تم التسليم', id, r.invoiceId || '', r.loc, fromStatus || '', r.status,
        r.active || r.deliveredBy || '—',
        r.handlingMins != null ? r.handlingMins : '',
        Util.fmtDt(r.costDate, cfg.tz),
        r.supplierAddedAt ? Util.fmtDt(r.supplierAddedAt, cfg.tz) : '',
        note
      ]);
    };

    if (!prev) {
      // brand-new invoice → record first-seen (sheet-addition time) + queue entry.
      auditRows.push([now, 'API', 'دخول للطابور', id, r.invoiceId || '', r.loc, '', r.status, r.actor || '—', '',
                      Util.fmtDt(r.costDate, cfg.tz), '', 'فاتورة جديدة']);
      state[id] = { lastStatus: r.status, lastActionAt: r.lastActionAt, assignAt: r.assignAt,
                    settled: false, settledAt: '', lastSeen: runIso,
                    firstSeenAt: runIso, active: r.active, deliveredAt: '' };
      if (r.delivered && r.deliveredAt) { logDelivered(''); state[id].deliveredAt = r.deliveredAt; }
    } else {
      if (r.status !== '—' && r.status !== 'قيد التحديث' && prev.lastStatus && prev.lastStatus !== r.status) {
        auditRows.push([now, 'API', 'تغيّر الحالة', id, r.invoiceId || '', r.loc, prev.lastStatus, r.status, r.actor || '—', '',
                        Util.fmtDt(r.costDate, cfg.tz), '', '']);
      }
      // first time we observe delivery for this order → log it once.
      if (r.delivered && r.deliveredAt && !prev.deliveredAt) { logDelivered(prev.lastStatus); prev.deliveredAt = r.deliveredAt; }

      prev.lastStatus = (r.status === '—' || r.status === 'قيد التحديث') ? prev.lastStatus : r.status;
      prev.lastActionAt = r.lastActionAt || prev.lastActionAt;
      if (!prev.assignAt) prev.assignAt = r.assignAt;
      if (!prev.firstSeenAt) prev.firstSeenAt = runIso;
      prev.active = r.active || prev.active;
      prev.settled = false; prev.lastSeen = runIso;
    }
  });

  // settlement: was tracked + open, now absent from the live queue.
  Object.keys(state).forEach(id => {
    const s = state[id];
    if (s.settled || currentIds.has(id)) return;
    const det = Api.fetchOrderDetail(id, cfg.token);   // one extra call for the true completion time
    const di = det ? extractDeliveryInfo_(det, cfg) : null;
    const settleAt = (di && di.deliveredAt) ? di.deliveredAt : (det && det.actionAt ? det.actionAt : runIso);
    const actor = s.active || (det && det.actor ? det.actor : '—');

    // handling time = milestone → completion (── CHANGE v8.1)
    let handling = '';
    const fromAt = (cfg.handlingFrom === 'supplier' && di && di.supplierAddedAt) ? di.supplierAddedAt : s.assignAt;
    if (fromAt) handling = Util.businessMinutes(new Date(fromAt), new Date(settleAt), cfg.shiftStart, cfg.shiftEnd, cfg.tz);

    auditRows.push([
      Util.fmtDt(new Date(), cfg.tz), 'API', 'تمت التسوية', id, '', '', s.lastStatus, det ? det.statusName : 'منتهية',
      actor, handling, '',
      (di && di.supplierAddedAt) ? Util.fmtDt(di.supplierAddedAt, cfg.tz) : '',
      'خرجت من الطابور' + (di && di.deliveredBy && di.deliveredBy !== '—' ? ' | سلّمها: ' + di.deliveredBy : '')
    ]);
    s.settled = true; s.settledAt = settleAt;
  });

  appendAudit_(auditRows);
  State.save(state);
}

/* ════════════════════════════ RENDER HELPERS ════════════════════════════ */
function getOrCreateSheet_(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }

/** Generic batched table renderer for read-only sheets. */
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
  const rank = r => r.breach ? 0 : (r.blocked ? 2 : 1);
  const d = rank(a) - rank(b);
  return d !== 0 ? d : (b.mins || 0) - (a.mins || 0);
}

function rowColor_(r) {
  if (r.delivered) return CFG.C_GRN;       // ── CHANGE v8.1: delivered rows = green
  if (r.breach) return CFG.C_ORG;
  if (r.blocked) return CFG.C_GRY;
  if (r.p1OnLeave) return CFG.C_PRP;
  return CFG.C_EVEN;
}

/* ── Main work queue (الطلبات) ── */
function renderMain_(ss, records, cfg) {
  const sh = getOrCreateSheet_(ss, CFG.SH_MAIN);
  const C = CFG.CM;

  // preserve user-entered DONE + assign time keyed by invoiceId
  const prev = {};
  if (sh.getLastRow() >= 2 && sh.getLastColumn() >= C.IID) {
    const w = Math.min(sh.getLastColumn(), C.COLS);
    sh.getRange(2, 1, sh.getLastRow() - 1, w).getValues().forEach(r => {
      const iid = String(r[C.IID - 1] || '');
      if (iid) prev[iid] = { done: r[C.DONE - 1] === true, assign: r[C.ASSIGN - 1] };
    });
  }

  const open = records.slice().sort(queueSort_);
  const header = ['المركز', 'رقم الاوردر', 'رقم الفاتورة', 'P1 (اساسي)', 'P2 (احتياطي)',
    'المسؤول الفعلي', 'حالة الاوردر', 'جاهزة للتدقيق؟', 'تم الإنجاز؟',
    'وقت الإسناد', 'مدة المعالجة', 'الحالة/التأخير', 'وقت إضافة الفاتورة'];   // ── CHANGE v8.1: +cost col

  const body = open.map(r => {
    const st = prev[String(r.invoiceId)] || {};
    const assignShown = st.assign || Util.fmtDt(r.assignAt, cfg.tz);
    const readyLabel = r.delivered ? '📦 تم التسليم' : (r.ready ? '✅ جاهزة' : '⛔ غير جاهزة');
    return [r.loc, r.orderId || '—', r.invoiceId || '—', r.p1, r.p2, r.active,
      r.status, readyLabel, st.done === true,
      assignShown, r.dur, r.note, Util.fmtDt(r.costDate, cfg.tz)];
  });

  sh.clearContents(); sh.clearFormats();
  sh.getRange(1, 1, 1, C.COLS).setValues([header])
    .setBackground(CFG.C_HDR).setFontColor('#fff').setFontWeight('bold')
    .setFontSize(10).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setRowHeight(1, 38); sh.setFrozenRows(1); sh.setFrozenColumns(1);

  if (body.length) {
    sh.getRange(2, 1, body.length, C.COLS).setValues(body.map(r => r.map((v, ci) =>
      ci === (C.DONE - 1) ? v : Util.safeText(v))));   // keep DONE boolean, sanitise the rest
    sh.getRange(2, C.DONE, body.length, 1).insertCheckboxes();
    const bg = open.map(r => Array(C.COLS).fill(rowColor_(r)));
    sh.getRange(2, 1, body.length, C.COLS).setBackgrounds(bg);
    // text format on text columns only (skip the DONE checkbox column 9)
    sh.getRange(2, 1, body.length, 8).setNumberFormat('@');
    sh.getRange(2, 10, body.length, 4).setNumberFormat('@');
  }
  [225, 110, 110, 150, 150, 150, 175, 130, 90, 150, 105, 165, 150].forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

/* ── ── CHANGE v8.1: THREE status tabs (Delivered / Ready / Other) ── */
function renderStatusTabs_(ss, records, cfg) {
  const nowStr = Util.fmtDt(new Date(), cfg.tz);

  // a) Delivered Orders — only «تم التسليم»
  const delivered = records.filter(r => r.cat === 'delivered')
    .sort((a, b) => (new Date(b.deliveredAt || 0)) - (new Date(a.deliveredAt || 0)));
  const shD = getOrCreateSheet_(ss, CFG.SH_DELIVERED);
  renderTable_(shD,
    `الطلبات تم التسليم (${delivered.length}) | ${nowStr}`,
    ['المركز', 'رقم الاوردر', 'رقم الفاتورة', 'المسؤول الفعلي', 'الحالة',
     'وقت إضافة الفاتورة', 'وقت إضافة مورد الصرف', 'مورد الصرف (بواسطة)',
     'وقت التسليم', 'مدة المعالجة (مورد→تسليم)', 'إجمالي منذ الإسناد'],
    delivered.map(r => [r.loc, r.orderId || '—', r.invoiceId || '—', r.active, r.status,
      Util.fmtDt(r.costDate, cfg.tz),
      r.supplierAddedAt ? Util.fmtDt(r.supplierAddedAt, cfg.tz) : '— (غير مسجّل)',
      r.supplierAddedBy || '—',
      Util.fmtDt(r.deliveredAt, cfg.tz),
      r.handlingMins != null ? Util.fmtDuration(r.handlingMins) : '—',
      r.dur]),
    (r) => {
      // highlight handling that breached the AHT target
      const hm = parseHandlingCell_(r[9]);
      return hm != null && hm > cfg.aht ? CFG.C_ORG : CFG.C_GRN;
    },
    [205, 105, 105, 165, 150, 150, 160, 150, 150, 180, 140],
    { headerBg: '#1b5e20' });

  // b) Ready Orders — auditable but not yet delivered
  const ready = records.filter(r => r.cat === 'ready').sort((a, b) => (b.mins || 0) - (a.mins || 0));
  const shR = getOrCreateSheet_(ss, CFG.SH_READY);
  renderTable_(shR,
    `الطلبات الجاهزة للتدقيق (${ready.length}) | ${nowStr}`,
    ['المركز', 'رقم الاوردر', 'رقم الفاتورة', 'المسؤول الفعلي', 'الحالة', 'وقت إضافة الفاتورة', 'مدة الانتظار', 'الحالة/التأخير'],
    ready.map(r => [r.loc, r.orderId || '—', r.invoiceId || '—', r.active, r.status, Util.fmtDt(r.costDate, cfg.tz), r.dur, r.note]),
    r => (String(r[7]) || '').indexOf('متأخر') > -1 ? CFG.C_ORG : CFG.C_EVEN,
    [210, 110, 110, 165, 175, 150, 120, 165],
    { headerBg: '#1565c0' });

  // c) Other Orders — every remaining status (waiting / unknown / blocked)
  const other = records.filter(r => r.cat === 'other').sort((a, b) => String(a.loc).localeCompare(String(b.loc)));
  const shO = getOrCreateSheet_(ss, CFG.SH_OTHER);
  renderTable_(shO,
    `طلبات أخرى — حالات مختلفة (${other.length}) | ${nowStr}`,
    ['المركز', 'رقم الاوردر', 'رقم الفاتورة', 'المسؤول الفعلي', 'الحالة', 'وقت إضافة الفاتورة', 'ملاحظة'],
    other.map(r => [r.loc, r.orderId || '—', r.invoiceId || '—', r.active, r.status, Util.fmtDt(r.costDate, cfg.tz),
      r.unknown ? 'بانتظار تحديث الحالة' : 'بانتظار جهة أخرى']),
    () => CFG.C_GRY,
    [210, 110, 110, 165, 200, 150, 175],
    { headerBg: '#546e7a' });

  // migrate the old single "not ready" tab away (kept as a friendly redirect note)
  const legacy = ss.getSheetByName(CFG.SH_NOTREADY);
  if (legacy && legacy.getName() !== CFG.SH_OTHER) {
    try { ss.deleteSheet(legacy); } catch (e) { /* if it's the last visible sheet, ignore */ }
  }
}

/** Parse a "Xس Yد" duration cell back to minutes (for conditional coloring). */
function parseHandlingCell_(s) {
  s = String(s || '');
  if (!s || s === '—') return null;
  let mins = 0;
  const h = s.match(/(\d+)\s*س/); const m = s.match(/(\d+)\s*د/);
  if (h) mins += parseInt(h[1], 10) * 60;
  if (m) mins += parseInt(m[1], 10);
  return mins;
}

/* ── Summary by center (── CHANGE v8.1: now also counts delivered) ── */
function renderSummary_(ss, records, matrix, onLeave, cfg) {
  const sh = getOrCreateSheet_(ss, CFG.SH_SUMMARY);
  const map = {};
  records.forEach(r => {
    const m = map[r.loc] || (map[r.loc] = { total: 0, delivered: 0, ready: 0, delayed: 0, other: 0 });
    m.total++;
    if (r.cat === 'delivered') m.delivered++;
    else if (r.cat === 'ready') { m.ready++; if (r.breach) m.delayed++; }
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

/* ── Supervisor performance (live queue + today's delivered/handling from the log) ── */
function renderPerformance_(ss, records, onLeave, cfg) {
  const sh = getOrCreateSheet_(ss, CFG.SH_PERF);

  const agg = {};
  records.forEach(r => {
    if (r.active === '—') return;
    const a = agg[r.active] || (agg[r.active] = { open: 0, blocked: 0, breached: 0, deliveredLive: 0 });
    if (r.cat === 'delivered') { a.deliveredLive++; a.open++; }
    else if (r.blocked) a.blocked++;
    else { a.open++; if (r.breach) a.breached++; }
  });

  // ── CHANGE v8.1: today's completed metrics (delivered + settled) incl. handling.
  const done = completedTodayByActor_(cfg);

  const nowStr = Util.fmtDt(new Date(), cfg.tz);
  const header = ['المشرف', 'مُسنَد', 'مفتوحة', 'محجوبة', 'متأخرة',
    'سُلِّم اليوم', 'مورد الصرف اليوم', 'متوسط المعالجة (مورد→تسليم)', 'التقييم'];
  const names = Object.keys(agg).sort((a, b) => (agg[b].open + agg[b].blocked) - (agg[a].open + agg[a].blocked));
  const body = names.map(name => {
    const a = agg[name];
    const off = !!onLeave[name];
    const d = done[name] || { count: 0, avg: 0, supplierCount: 0 };
    const score = a.open === 0 ? '—' : (a.breached === 0 ? 'ممتاز 🌟' : (a.breached <= 2 ? 'جيد 👍' : 'يحتاج متابعة ⚠️'));
    return [(off ? '🏖 ' : '') + name, a.open + a.blocked, a.open, a.blocked, a.breached,
      d.count, d.supplierCount, d.avg ? Util.fmtDuration(d.avg) : '—', off ? '🏖 على إجازة' : score];
  });

  renderTable_(sh,
    `أداء المشرفين الحي | ${nowStr}`,
    header, body,
    (r, i) => String(r[0]).indexOf('🏖') > -1 ? CFG.C_PRP : (Number(r[4]) > 0 ? CFG.C_ORG : (Number(r[5]) > 0 ? CFG.C_GRN : (i % 2 ? CFG.C_EVEN : CFG.C_ODD))),
    [185, 95, 95, 95, 95, 105, 130, 200, 150], { headerBg: '#1a237e' });
}

/** ── CHANGE v8.1: read today's «تم التسليم»/«تمت التسوية» rows from the structured
 *  log and aggregate per actor: completions, supplier-adds, avg handling minutes.
 *  De-dupes a delivered + settled pair for the same order so we don't double count. */
function completedTodayByActor_(cfg) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SH_AUDIT);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  const today = Utilities.formatDate(new Date(), cfg.tz, 'yyyy-MM-dd');
  const W = CFG.AUDIT_COLS;
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, W).getValues();

  // pass 1: which orders already have a "delivered" row today
  const deliveredOrders = new Set();
  data.forEach(r => {
    if (String(r[0] || '').substr(0, 10) !== today) return;
    if (String(r[2] || '').indexOf('تسليم') > -1) deliveredOrders.add(String(r[3] || ''));
  });

  // pass 2: aggregate
  data.forEach(r => {
    const ts = String(r[0] || ''); if (ts.substr(0, 10) !== today) return;
    const action = String(r[2] || ''), oid = String(r[3] || ''), actor = String(r[8] || '—');
    const mins = Number(r[9]) || 0, supplierAt = String(r[11] || '');
    const isDelivered = action.indexOf('تسليم') > -1;
    const isSettle = action.indexOf('تسوية') > -1;
    if (!isDelivered && !isSettle) return;
    if (isSettle && deliveredOrders.has(oid)) return;     // avoid double-count
    const o = out[actor] || (out[actor] = { count: 0, sumHandling: 0, handlingCount: 0, supplierCount: 0 });
    o.count++;
    if (mins > 0) { o.sumHandling += mins; o.handlingCount++; }
    if (supplierAt) o.supplierCount++;
  });
  Object.keys(out).forEach(k => { const o = out[k]; o.avg = o.handlingCount ? Math.round(o.sumHandling / o.handlingCount) : 0; });
  return out;
}

/* ════════════════════════════ DASHBOARD (rewritten, fully batched) ════════════════════════════ */
// ── CHANGE v8.1: the old dashboard wrote cell-by-cell (slow). This version
// assembles each block as a 2D array and pushes it with a single setValues +
// single setBackgrounds, which is dramatically faster and easier to extend.
function renderDashboard_(ss, records, onLeave, cfg, truncated) {
  const dash = getOrCreateSheet_(ss, CFG.SH_DASH);
  dash.clearContents(); dash.clearFormats();
  dash.getCharts().forEach(ch => dash.removeChart(ch));

  const nowStr = Util.fmtDt(new Date(), cfg.tz);

  // ---- aggregate once ----
  let delivered = 0, ready = 0, other = 0, delayed = 0;
  const load = {};                  // per-supervisor live load
  records.forEach(r => {
    if (r.cat === 'delivered') delivered++;
    else if (r.cat === 'ready') { ready++; if (r.breach) delayed++; }
    else other++;
    if (r.active !== '—') {
      const a = load[r.active] || (load[r.active] = { total: 0, del: 0, blk: 0, brk: 0 });
      a.total++;
      if (r.cat === 'delivered') a.del++;
      else if (r.blocked) a.blk++;
      else if (r.breach) a.brk++;
    }
  });
  const auditable = ready + delivered;
  const slaPct = auditable > 0 ? Math.round((auditable - delayed) / auditable * 100) : 100;
  const done = completedTodayByActor_(cfg);
  const deliveredToday = Object.values(done).reduce((a, d) => a + d.count, 0);
  const handAvgAll = (() => {
    let s = 0, c = 0; Object.values(done).forEach(d => { s += d.sumHandling; c += d.handlingCount; });
    return c ? Math.round(s / c) : 0;
  })();
  const leaveN = Object.keys(onLeave).length;

  const COLS = 9;
  let R = 1;

  // ---- title + subtitle + credit (3 banner rows) ----
  dash.getRange(R, 1, 1, COLS).merge()
    .setValue('لوحة التحكم — نظام مراقبة الفواتير · مسمار v8.1')
    .setBackground('#0d1b2a').setFontColor('#e3f2fd').setFontSize(16).setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  dash.setRowHeight(R, 54); R++;

  dash.getRange(R, 1, 1, COLS).merge()
    .setValue(`آخر تحديث: ${nowStr} · شيفت ${cfg.shiftStart}:00–${cfg.shiftEnd}:00 · هدف AHT ${cfg.aht}د` +
              (truncated ? ' · (تحديث جزئي)' : ''))
    .setBackground('#162032').setFontColor('#90caf9').setFontSize(10).setHorizontalAlignment('center');
  dash.setRowHeight(R, 24); R++;

  dash.getRange(R, 1, 1, 5).merge().setValue('Built by Ahmed Elsaadi')
    .setBackground('#0d1b2a').setFontColor('#607d8b').setFontSize(9).setHorizontalAlignment('left');
  dash.getRange(R, 6, 1, 4).merge()
    .setFormula('=HYPERLINK("https://www.linkedin.com/in/ahmed-elsaadi","LinkedIn: Ahmed Elsaadi")')
    .setBackground('#0d1b2a').setFontColor('#1e88e5').setFontSize(9).setHorizontalAlignment('right');
  dash.setRowHeight(R, 20); R += 2;

  // ---- KPI cards (titles row + values row, each written in ONE call) ----
  const cards = [
    { t: 'اجمالي الفواتير', v: records.length, c: '#37474f' },
    { t: 'تم التسليم', v: delivered, c: '#1b5e20' },
    { t: 'جاهزة للتدقيق', v: ready, c: '#1565c0' },
    { t: 'طلبات أخرى', v: other, c: '#546e7a' },
    { t: 'متأخرة عن الهدف', v: delayed, c: '#e65100' },
    { t: 'الالتزام بالSLA', v: slaPct + '%', c: slaPct >= 90 ? '#2e7d32' : '#c62828' },
    { t: 'سُلّم اليوم', v: deliveredToday, c: '#00695c' },
    { t: 'متوسط المعالجة', v: handAvgAll ? Util.fmtDuration(handAvgAll) : '—', c: '#4527a0' },
    { t: 'على إجازة اليوم', v: leaveN, c: '#4a148c' }
  ];
  dash.getRange(R, 1, 1, COLS).setValues([cards.map(c => c.t)])
    .setBackgrounds([cards.map(c => c.c)]).setFontColor('#fff')
    .setFontWeight('bold').setFontSize(9).setHorizontalAlignment('center').setVerticalAlignment('middle');
  dash.setRowHeight(R, 30); R++;
  dash.getRange(R, 1, 1, COLS).setValues([cards.map(c => c.v)])
    .setBackgrounds([cards.map(() => '#fafafa')]).setFontColors([cards.map(c => c.c)])
    .setFontWeight('bold').setFontSize(17).setHorizontalAlignment('center').setVerticalAlignment('middle');
  dash.setRowHeight(R, 52);
  for (let i = 0; i < COLS; i++) dash.setColumnWidth(i + 1, 122);
  R += 2;

  // ---- Supervisors performance block (title + header + rows, batched) ----
  dash.getRange(R, 1, 1, 7).merge().setValue('أداء المشرفين — حي + إنجاز اليوم')
    .setBackground('#1a237e').setFontColor('#fff').setFontSize(11).setFontWeight('bold').setHorizontalAlignment('center');
  dash.setRowHeight(R, 28); R++;

  const perfHeader = ['المشرف', 'مسندة', 'متأخرة', 'محجوبة', 'سُلِّم اليوم', 'متوسط المعالجة', 'الحالة'];
  dash.getRange(R, 1, 1, 7).setValues([perfHeader])
    .setBackground('#283593').setFontColor('#fff').setFontWeight('bold').setHorizontalAlignment('center');
  dash.setRowHeight(R, 26); R++;

  const supNames = Object.keys(load).sort((a, b) => load[b].total - load[a].total);
  if (supNames.length) {
    const rows = [], colors = [];
    supNames.forEach((name, idx) => {
      const a = load[name], off = !!onLeave[name], d = done[name] || { count: 0, avg: 0 };
      const status = off ? '🏖 على إجازة' : (a.brk === 0 ? '✅ جيد' : '⚠️ ' + a.brk + ' متأخرة');
      rows.push([(off ? '🏖 ' : '') + name, a.total, a.brk, a.blk, d.count, d.avg ? Util.fmtDuration(d.avg) : '—', status]);
      const c = off ? CFG.C_PRP : (a.brk > 0 ? CFG.C_ORG : (d.count > 0 ? CFG.C_GRN : (idx % 2 ? CFG.C_EVEN : CFG.C_ODD)));
      colors.push(Array(7).fill(c));
    });
    dash.getRange(R, 1, rows.length, 7).setValues(rows).setBackgrounds(colors).setHorizontalAlignment('center');
    R += rows.length;
  }
  R += 1;

  // ---- Top centers + chart (batched) ----
  const locCount = {};
  records.forEach(r => { locCount[r.loc] = (locCount[r.loc] || 0) + 1; });
  const top = Object.keys(locCount).sort((a, b) => locCount[b] - locCount[a]).slice(0, 10);

  dash.getRange(R, 1, 1, 2).merge().setValue('أكثر 10 مراكز فواتير معلقة')
    .setBackground('#c62828').setFontColor('#fff').setFontSize(11).setFontWeight('bold').setHorizontalAlignment('center');
  dash.setRowHeight(R, 28); R++;
  const chartStart = R;
  if (top.length) {
    const rows = top.map(loc => [loc, locCount[loc]]);
    const colors = top.map((loc, idx) => [idx < 3 ? CFG.C_RED : (idx % 2 ? CFG.C_EVEN : CFG.C_ODD), idx < 3 ? CFG.C_RED : (idx % 2 ? CFG.C_EVEN : CFG.C_ODD)]);
    dash.getRange(R, 1, rows.length, 2).setValues(rows).setBackgrounds(colors);
    dash.getRange(R, 2, rows.length, 1).setFontWeight('bold').setHorizontalAlignment('center');
    R += rows.length;

    try {
      const chart = dash.newChart().asColumnChart()
        .addRange(dash.getRange(chartStart, 1, top.length, 2))
        .setPosition(chartStart, 4, 0, 0)
        .setOption('title', 'الفواتير حسب المركز')
        .setOption('legend', { position: 'none' })
        .setOption('colors', ['#1565c0'])
        .setOption('width', 540).setOption('height', 300)
        .build();
      dash.insertChart(chart);
    } catch (e) { console.warn('chart build skipped: ' + e); }
  }
  dash.setFrozenRows(1);
}

/* ════════════════════════════ ACTIVITY SEARCH (filter the audit log) ════════════════════════════ */
function searchActivity() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SH_AUDIT);
  if (!sh || sh.getLastRow() < 2) { ui.alert('سجل النشاط فارغ.'); return; }

  const agentRes = ui.prompt('بحث النشاط', 'اسم المشرف (اتركه فارغًا للكل):', ui.ButtonSet.OK_CANCEL);
  if (agentRes.getSelectedButton() !== ui.Button.OK) return;
  const agent = agentRes.getResponseText().trim();

  const dateRes = ui.prompt('بحث النشاط', 'التاريخ بصيغة YYYY-MM-DD (اتركه فارغًا للكل):', ui.ButtonSet.OK_CANCEL);
  if (dateRes.getSelectedButton() !== ui.Button.OK) return;
  const date = dateRes.getResponseText().trim();

  const orderRes = ui.prompt('بحث النشاط', 'رقم الأوردر (اتركه فارغًا للكل):', ui.ButtonSet.OK_CANCEL);
  if (orderRes.getSelectedButton() !== ui.Button.OK) return;
  const order = orderRes.getResponseText().trim();

  const W = CFG.AUDIT_COLS;
  const header = sh.getRange(1, 1, 1, W).getValues();
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, W).getValues();
  const hits = data.filter(r => {
    if (agent && String(r[8] || '').indexOf(agent) === -1) return false;
    if (date && String(r[0] || '').substr(0, 10) !== date) return false;
    if (order && String(r[3] || '') !== order) return false;
    return true;
  });

  const out = getOrCreateSheet_(SpreadsheetApp.getActive(), CFG.SH_SEARCH);
  out.clearContents(); out.clearFormats();
  out.getRange(1, 1, 1, W).setValues(header).setBackground('#1a237e').setFontColor('#fff').setFontWeight('bold');
  if (hits.length) out.getRange(2, 1, hits.length, W).setValues(hits);
  out.setFrozenRows(1);
  SpreadsheetApp.setActiveSheet(out);
  ui.alert(`عدد النتائج: ${hits.length}`);
}

/* ════════════════════════════ PERIODIC REPORTS (from structured audit log) ════════════════════════════ */
function buildWeeklyReport()  { buildReport_('week'); }
function buildMonthlyReport() { buildReport_('month'); }

function buildReport_(period) {
  const cfg = getConfig_();
  const ss = SpreadsheetApp.getActive();
  const audit = ss.getSheetByName(CFG.SH_AUDIT);
  if (!audit || audit.getLastRow() < 2) { alertSafe_('سجل النشاط فارغ — لا توجد بيانات للتقرير.'); return; }

  const cutoff = new Date();
  if (period === 'week') cutoff.setDate(cutoff.getDate() - 7); else cutoff.setMonth(cutoff.getMonth() - 1);

  const W = CFG.AUDIT_COLS;
  const data = audit.getRange(2, 1, audit.getLastRow() - 1, W).getValues();
  const byAgent = {}, byLoc = {};
  data.forEach(r => {
    const ts = new Date(r[0]); if (isNaN(ts) || ts < cutoff) return;
    const action = String(r[2] || ''), agent = String(r[8] || '—'), loc = String(r[5] || '—'), mins = Number(r[9]) || 0;
    const supplierAt = String(r[11] || '');
    const isSettle = action.indexOf('تسوية') > -1;
    const isDelivered = action.indexOf('تسليم') > -1;     // ── CHANGE v8.1
    const isChange = action.indexOf('تغيّر') > -1;
    const a = byAgent[agent] || (byAgent[agent] = { actions: 0, completed: 0, sumMins: 0, handCount: 0, supplier: 0 });
    a.actions++;
    if (isSettle || isDelivered) { a.completed++; if (mins > 0) { a.sumMins += mins; a.handCount++; } if (supplierAt) a.supplier++; }
    if (loc !== '—' && (isSettle || isChange || isDelivered)) { const l = byLoc[loc] || (byLoc[loc] = { actions: 0 }); l.actions++; }
  });

  const shName = period === 'week' ? CFG.SH_LOG_W : CFG.SH_LOG_M;
  const sh = getOrCreateSheet_(ss, shName);
  sh.clearContents(); sh.clearFormats();
  const title = period === 'week' ? 'التقرير الاسبوعي' : 'التقرير الشهري';
  const nowStr = Utilities.formatDate(new Date(), cfg.tz, 'yyyy-MM-dd');

  sh.getRange(1, 1, 1, 6).merge().setValue(`${title} | ${nowStr}`)
    .setBackground(CFG.C_HDR).setFontColor('#fff').setFontSize(14).setFontWeight('bold').setHorizontalAlignment('center');
  sh.setRowHeight(1, 44);

  let R = 3;
  // ── CHANGE v8.1: report now includes supplier-adds + avg handling time.
  sh.getRange(R, 1, 1, 6).setValues([['المشرف', 'إجمالي الإجراءات', 'مكتملة/مسلّمة', 'مورد الصرف', 'متوسط المعالجة', 'إنتاجية']])
    .setBackground('#1976d2').setFontColor('#fff').setFontWeight('bold').setHorizontalAlignment('center'); R++;
  Object.keys(byAgent).sort((a, b) => byAgent[b].completed - byAgent[a].completed).forEach((name, i) => {
    const x = byAgent[name];
    const avg = x.handCount ? Util.fmtDuration(Math.round(x.sumMins / x.handCount)) : '—';
    sh.getRange(R, 1, 1, 6).setValues([[name, x.actions, x.completed, x.supplier, avg, x.completed]])
      .setBackground(i % 2 ? CFG.C_EVEN : CFG.C_ODD); R++;
  });

  R += 2;
  sh.getRange(R, 1, 1, 2).setValues([['المركز', 'عدد الإجراءات']])
    .setBackground('#6a1b9a').setFontColor('#fff').setFontWeight('bold').setHorizontalAlignment('center'); R++;
  Object.keys(byLoc).sort((a, b) => byLoc[b].actions - byLoc[a].actions).forEach((loc, i) => {
    sh.getRange(R, 1, 1, 2).setValues([[loc, byLoc[loc].actions]]).setBackground(i % 2 ? CFG.C_EVEN : CFG.C_ODD); R++;
  });

  [220, 150, 140, 120, 150, 110].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setFrozenRows(1);
  alertSafe_(title + ' جاهز.');
}

/* ════════════════════════════ onEdit (agent action logging) ════════════════════════════ */
function onEdit(e) {
  try {
    const sh = e.range.getSheet();
    if (sh.getName() !== CFG.SH_MAIN) return;
    const C = CFG.CM, row = e.range.getRow(), col = e.range.getColumn();
    if (col !== C.DONE || row <= 1) return;

    const cfg = getConfig_();
    const tz = cfg.tz;
    const nowStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
    const checked = e.range.getValue() === true;

    if (checked) {
      sh.getRange(row, C.ASSIGN).setValue(nowStr);
      sh.getRange(row, 1, 1, C.COLS).setBackground(CFG.C_YEL);
    } else {
      sh.getRange(row, C.ASSIGN).clearContent();
      sh.getRange(row, 1, 1, C.COLS).setBackground(null);
    }

    let user = '';
    try { user = Session.getActiveUser().getEmail(); } catch (e2) {}
    const oid = sh.getRange(row, C.OID).getValue();
    const iid = sh.getRange(row, C.IID).getValue();
    const loc = sh.getRange(row, C.LOC).getValue();
    const cost = sh.getRange(row, C.COST).getValue();   // ── CHANGE v8.1: carry cost time into log
    appendAudit_([[
      Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
      'SHEET', checked ? 'وضع علامة إنجاز' : 'إلغاء الإنجاز',
      oid || '', iid || '', loc || '', '', '', user || 'مستخدم', '', cost || '', '', ''
    ]]);
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

  // ── CHANGE v8.1: ensure the three status tabs exist; migrate the legacy one.
  const legacy = ss.getSheetByName(CFG.SH_NOTREADY);
  if (legacy && !ss.getSheetByName(CFG.SH_OTHER)) {
    legacy.setName(CFG.SH_OTHER);   // preserve position; content is regenerated each run
  }
  getOrCreateSheet_(ss, CFG.SH_DELIVERED);
  getOrCreateSheet_(ss, CFG.SH_READY);
  getOrCreateSheet_(ss, CFG.SH_OTHER);

  auditSheet_();      // create / migrate the activity log to the 13-col schema
  State.sheet_();     // create the hidden state sheet

  alertSafe_('تم الإعداد!\n\n1) احفظ التوكن من «حفظ التوكن (آمن)»\n2) أضف المراكز وP1/P2 في Matrix\n' +
             '3) أضف الإجازات عند الحاجة\n4) شغّل «تشغيل التحديث الآن»\n5) فعّل التشغيل التلقائي\n\n' +
             'تبويبات الحالة الجديدة: «الطلبات تم التسليم» / «الطلبات الجاهزة» / «طلبات أخرى».');
}

/* ════════════════════════════ UI-SAFE MESSAGING ════════════════════════════ */
/** toast works in the editor/UI; in trigger context it is a harmless no-op. */
function notify_(msg) {
  try { SpreadsheetApp.getActive().toast(msg, 'مسمار', 6); } catch (e) {}
  console.log('[notify] ' + msg);
}
/** alert is only safe from menu-invoked functions; falls back to toast. */
function alertSafe_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { notify_(msg); }
}
