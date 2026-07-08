const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');

const Utilities = {
  formatDate(d, tz, fmt) {
    const t = new Date(d.getTime() + 3 * 3600 * 1000), p = n => String(n).padStart(2, '0');
    const Y = t.getUTCFullYear(), Mo = p(t.getUTCMonth() + 1), D = p(t.getUTCDate()), H = p(t.getUTCHours()), Mi = p(t.getUTCMinutes());
    if (fmt === 'yyyy-MM-dd') return `${Y}-${Mo}-${D}`;
    if (fmt === 'yyyy-MM-dd HH:mm') return `${Y}-${Mo}-${D} ${H}:${Mi}`;
    return `${Y}-${Mo}-${D}`;
  }
};
const ctx = { console, Utilities, SpreadsheetApp: {}, UrlFetchApp: {}, PropertiesService: {}, LockService: {} };
vm.createContext(ctx);
vm.runInContext(src + '\n;Object.assign(globalThis,{CFG,DI,DATA_COLS,Util,Api,get_,pick_,parseInvoice_,extractPlate_,plateFromCar_,deepFindPlate_,deepFindName_,normalizeDate_,statusLabel_,matchLabel_});', ctx);

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log((ok ? '✅' : '❌') + ' ' + n + (ok ? '' : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

// get_ / pick_
eq('get_ nested', ctx.get_({ purchaseLocation: { name: 'مركز أ' } }, 'purchaseLocation.name'), 'مركز أ');
eq('pick_ first match', ctx.pick_({ b: 2 }, ['a', 'b', 'c']), 2);
eq('pick_ none', ctx.pick_({}, ['a', 'b']), '');

// parseInvoice_ — paid vs unpaid via paymentMethodId
const inv1 = ctx.parseInvoice_({ orderId: 954222, id: 188599, amount: 7992.5, purchaseLocation: { name: 'شركة المديميغ التجارية' }, supplier: { name: 'مشرف قطع الغيار' }, spendType: { name: 'قطع غيار' }, spendDate: '2026-07-01', paymentMethodId: 3 });
eq('parse orderId', inv1.orderId, 954222);
eq('parse amount', inv1.amount, 7992.5);
eq('parse location', inv1.location, 'شركة المديميغ التجارية');
eq('parse supplier', inv1.supplier, 'مشرف قطع الغيار');
eq('parse type', inv1.type, 'قطع غيار');
eq('parse paid=true (paymentMethodId set)', inv1.paid, true);
const inv2 = ctx.parseInvoice_({ orderId: 1, id: 2, paymentMethodId: null });
eq('parse paid=false (paymentMethodId null)', inv2.paid, false);

// extractPlate_ — number + Arabic letters from the order detail (like the screenshot: 3039 / ا س ط)
const orderJson = JSON.stringify({ orderDetails: { usersCar: { manufactureYear: 2022, model: 'اتش دي 78', plateNumber: '3039', plateCharacters: 'ا س ط' } } });
eq('plate number+letters', ctx.extractPlate_(orderJson), '3039 ا س ط');
// full-plate field
eq('plate full field', ctx.extractPlate_(JSON.stringify({ orderDetails: { car: { licensePlate: 'أ ب ج 1234' } } })), 'أ ب ج 1234');
// deep-scan fallback (plate nested under an unknown container)
eq('plate deep scan', ctx.extractPlate_(JSON.stringify({ orderDetails: { foo: { bar: { plateNumbers: '7013', plateArabicCharacters: 'ن ق ل' } } } })), '7013 ن ق ل');
// missing plate → ''
eq('plate missing', ctx.extractPlate_(JSON.stringify({ orderDetails: {} })), '');

// normalizeDate_ (Arabic digits etc.)
eq('date arabic', ctx.normalizeDate_('٢٠٢٦-٠٧-٠١'), '2026-07-01');
eq('date slash', ctx.normalizeDate_('2026/7/1'), '2026-07-01');

// Util.datePrefix on a spend date
eq('datePrefix', ctx.Util.datePrefix('2026-07-01', 'Asia/Riyadh'), '2026-07-01');

// ── buildQuery must reproduce the CONFIRMED admin params
const cfgPaid = { mode: 'paid', dateFrom: '2026-07-01', dateTo: '2026-07-31', locationIds: '862', supplierIds: '', statuses: ['1', '3'], rawQuery: '' };
eq('buildQuery paid+loc', ctx.Api.buildQuery(cfgPaid, '1', 1),
   'businessOrderTypes=B2B_business&fromPaidDate=2026-07-01&toPaidDate=2026-07-31&status=1&purchaseLocationsIds=862&offset=0&limit=100&page=1');
const cfgSup = { mode: 'paid', dateFrom: '2026-07-01', dateTo: '2026-07-01', locationIds: '', supplierIds: '55', statuses: ['1'], rawQuery: '' };
eq('buildQuery supplier id', ctx.Api.buildQuery(cfgSup, '1', 2),
   'businessOrderTypes=B2B_business&fromPaidDate=2026-07-01&toPaidDate=2026-07-01&status=1&spendSupplierIds=55&offset=100&limit=100&page=2');
const cfgUnpaid = { mode: 'unpaid', dateFrom: '', dateTo: '', locationIds: '', supplierIds: '', statuses: ['2'], rawQuery: '' };
eq('buildQuery unpaid (no date)', ctx.Api.buildQuery(cfgUnpaid, '2', 1),
   'businessOrderTypes=B2B_business&status=2&offset=0&limit=100&page=1');
const cfgRaw = { rawQuery: 'businessOrderTypes=B2B_business&status=1&limit=10&page=1&offset=0' };
eq('buildQuery RAW override strips paging', ctx.Api.buildQuery(cfgRaw, null, 3),
   'businessOrderTypes=B2B_business&status=1&offset=200&limit=100&page=3');

// status classification + label
eq('parse status=1 → paid', ctx.parseInvoice_({ id: 1, status: 1 }).paid, true);
eq('parse status=2 → unpaid', ctx.parseInvoice_({ id: 1, status: 2 }).paid, false);
eq('parse status carried from query', ctx.parseInvoice_({ id: 1 }, '3').status, '3');
eq('statusLabel 1', ctx.statusLabel_(1), 'تم الدفع');
eq('statusLabel 3', ctx.statusLabel_('3'), 'الدفع بالأجل');

// date-match label
eq('match in range', ctx.matchLabel_({ mode: 'paid', dateFrom: '2026-01-01', dateTo: '2026-12-31' }, '2026-07-01'), '✅ مطابق');
eq('match out of range', ctx.matchLabel_({ mode: 'paid', dateFrom: '2026-07-01', dateTo: '2026-07-31' }, '2026-06-30'), '⚠️ خارج النطاق');
eq('match unpaid', ctx.matchLabel_({ mode: 'unpaid' }, ''), 'غير مصروفة');
eq('match no date', ctx.matchLabel_({ mode: 'paid', dateFrom: '2026-01-01', dateTo: '2026-12-31' }, ''), '⚠️ لا يوجد تاريخ صرف');

// ── NO-DEDUP invariant: upsert is keyed by invoiceId, so the SAME car/order with
// two different invoices produces TWO rows (a car serviced twice must not collapse).
(function () {
  const DI = ctx.DI, DATA_COLS = ctx.DATA_COLS;
  const rows = [], idx = {};
  const upsert = inv => {
    const iid = String(inv.invoiceId);
    let pos = idx[iid], row;
    if (pos == null) { row = new Array(DATA_COLS).fill(''); row[DI.IID] = iid; rows.push(row); idx[iid] = rows.length - 1; }
    else row = rows[pos];
    row[DI.OID] = String(inv.orderId); row[DI.PLATE] = inv.plate;
  };
  // same order 5001 / same plate, but TWO invoices (two services)
  upsert({ invoiceId: 'A1', orderId: 5001, plate: '3039 ا س ط' });
  upsert({ invoiceId: 'A2', orderId: 5001, plate: '3039 ا س ط' });
  upsert({ invoiceId: 'A1', orderId: 5001, plate: '3039 ا س ط' });   // re-sync same invoice → updates, no new row
  eq('two invoices same car → 2 rows', rows.length, 2);
  eq('re-sync does not duplicate', Object.keys(idx).length, 2);
})();

// ── PAGINATION: must pull ALL rows (empty-page stop), NOT stop at data.total.
function fetchFactory(dataset, pageSize, opts) {
  opts = opts || {};
  return (url) => {
    const m = String(url).match(/offset=(\d+)/); const off = m ? +m[1] : 0;
    const slice = opts.repeat ? dataset.slice(0, pageSize) : dataset.slice(off, off + pageSize);
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ data: { raw: slice, total: opts.total != null ? opts.total : dataset.length } }) };
  };
}
const ds350 = Array.from({ length: 350 }, (_, i) => ({ id: 1000 + i, orderId: 2000 + i, status: 1 }));
const cfgP = { rawQuery: '', statuses: ['1'], mode: 'paid', dateFrom: '2026-01-01', dateTo: '2026-12-31', locationIds: '', supplierIds: '' };
ctx.UrlFetchApp = { fetch: fetchFactory(ds350, 100, { total: 200 }) };   // total UNDER-reports (the bug)
eq('pagination pulls all 350 despite total=200', ctx.Api.fetchAllInvoices(cfgP).length, 350);
ctx.UrlFetchApp = { fetch: fetchFactory(ds350, 100, { repeat: true, total: 9999 }) };  // server ignores offset
eq('repeated page → dedup+stall stops at 100', ctx.Api.fetchAllInvoices(cfgP).length, 100);

// ── SUPPLIER deep-scan (the «مورد الصرف» empty-column fix)
const supRe = new RegExp(ctx.CFG.SUPPLIER_KEY_RE, 'i');
eq('supplier via paymentMethod.name', ctx.deepFindName_({ paymentMethod: { name: 'حساب التشغيل' } }, supRe, 0), 'حساب التشغيل');
eq('supplier skips numeric id', ctx.deepFindName_({ paymentMethodId: 3 }, supRe, 0), '');
eq('supplier deep nested', ctx.deepFindName_({ foo: { spendSupplier: { name: 'بطاقة ناصر' } } }, supRe, 0), 'بطاقة ناصر');
eq('parseInvoice supplier fallback', ctx.parseInvoice_({ id: 1, foo: { spendSupplier: { name: 'X' } } }).supplier, 'X');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
