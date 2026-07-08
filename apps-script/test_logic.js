const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, 'Code.gs'), 'utf8');

// ---- Minimal Apps Script stubs (fixed +03:00, no DST — fine for logic tests) ----
const Utilities = {
  formatDate(d, tz, fmt) {
    const t = new Date(d.getTime() + 3 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    const Y = t.getUTCFullYear(), Mo = p(t.getUTCMonth() + 1), D = p(t.getUTCDate());
    const H = p(t.getUTCHours()), Mi = p(t.getUTCMinutes()), S = p(t.getUTCSeconds());
    if (fmt === 'Z') return '+0300';
    if (fmt === 'yyyy-MM-dd') return `${Y}-${Mo}-${D}`;
    if (fmt === 'yyyy-MM-dd HH:mm') return `${Y}-${Mo}-${D} ${H}:${Mi}`;
    if (fmt === 'yyyy-MM-dd HH:mm:ss') return `${Y}-${Mo}-${D} ${H}:${Mi}:${S}`;
    if (fmt === 'MMdd-HHmm') return `${Mo}${D}-${H}${Mi}`;
    return `${Y}-${Mo}-${D}`;
  }
};
const noop = () => {};
const ctx = {
  console, Utilities,
  SpreadsheetApp: {}, UrlFetchApp: {}, PropertiesService: {}, LockService: {}, ScriptApp: {}, Session: {},
};
vm.createContext(ctx);
// const/function bindings aren't auto-attached to the vm global — export them explicitly
const shim = '\n;globalThis.__D = s => new Date(s);' +   // build Dates INSIDE the vm (instanceof)
  '\n;Object.assign(globalThis,{CFG,LG,Util,Api,ActivityLog,LOG_COLS,LOG_HEADERS,ST_QUEUE,ST_DONE,' +
  'classifyOrder_,computeMetric_,extractDeliveryInfo_,resolveCostDisplay_,completedByActor_});';
vm.runInContext(src + shim, ctx);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '✅' : '❌') + ' ' + name + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const cfg = {
  aht: 5, shiftStart: 9, shiftEnd: 18, tz: 'Asia/Riyadh',
  readyStatuses: ctx.CFG.READY_STATUSES, deliveredStatuses: ctx.CFG.DELIVERED_STATUSES,
  supplierKeywords: ctx.CFG.SUPPLIER_KEYWORDS, supplierFields: ctx.CFG.SUPPLIER_FIELD_NAMES
};

// 1) classification
eq('classify delivered', ctx.classifyOrder_('تم التسليم', cfg).cat, 'delivered');
eq('classify ready', ctx.classifyOrder_('جاهزة', cfg).cat, 'ready');
eq('classify other (waiting)', ctx.classifyOrder_('بانتظار المراجعة على عرض السعر', cfg).cat, 'other');
eq('classify unknown→other', ctx.classifyOrder_('—', cfg).cat, 'other');

// 2) business minutes within a shift
const bm = ctx.Util.businessMinutes(ctx.__D('2026-06-16T09:00:00+03:00'), ctx.__D('2026-06-16T10:00:00+03:00'), 9, 18, 'Asia/Riyadh');
eq('businessMinutes 1h', bm, 60);
// crossing overnight: 17:30→ next day 09:30 should be 30 (before close) + 30 (after open) = 60
const bm2 = ctx.Util.businessMinutes(ctx.__D('2026-06-16T17:30:00+03:00'), ctx.__D('2026-06-17T09:30:00+03:00'), 9, 18, 'Asia/Riyadh');
eq('businessMinutes overnight', bm2, 60);

// 3) AHT metric: ONLY delivered counts, starts at deliveredAt
const now = Date.parse('2026-06-16T10:00:00+03:00');
eq('metric delivered breach', ctx.computeMetric_({ cat: 'delivered', deliveredAt: '2026-06-16T09:00:00+03:00' }, cfg, now).breach, true);
eq('metric ready not counted', ctx.computeMetric_({ cat: 'ready', deliveredAt: '' }, cfg, now).mins, null);
eq('metric other not counted', ctx.computeMetric_({ cat: 'other' }, cfg, now).mins, null);
eq('metric delivered within target', ctx.computeMetric_({ cat: 'delivered', deliveredAt: '2026-06-16T09:57:00+03:00' }, cfg, now).breach, false);

// 4) supplier + delivered extraction, handling = delivered→supplier
const detail = {
  tracking: [
    { statusInfo: { internalStatusName: 'تم التسليم' }, updatedAt: '2026-06-16T09:00:00+03:00', creator: { name: 'System' }, actionBy: -1 },
    { statusInfo: { internalStatusName: 'اضافة مورد الصرف' }, updatedAt: '2026-06-16T09:40:00+03:00', creator: { name: 'Ahmed' }, actionBy: 5 }
  ]
};
const di = ctx.extractDeliveryInfo_(detail, cfg);
eq('extract deliveredAt', di.deliveredAt, '2026-06-16T09:00:00+03:00');
eq('extract supplierAt', di.supplierAddedAt, '2026-06-16T09:40:00+03:00');
eq('extract supplierBy', di.supplierAddedBy, 'Ahmed');
eq('handling delivered→supplier', ctx.Util.businessMinutes(ctx.__D(di.deliveredAt), ctx.__D(di.supplierAddedAt), 9, 18, 'Asia/Riyadh'), 40);
// supplier via dedicated field fallback
const di2 = ctx.extractDeliveryInfo_({ tracking: [{ statusInfo: { internalStatusName: 'تم التسليم' }, updatedAt: 'x', creator: {} }], supplierAt: '2026-06-16T11:00:00+03:00', supplierBy: 'Sara', supplierName: 'ABC' }, cfg);
eq('extract supplier via field', di2.supplierAddedAt, '2026-06-16T11:00:00+03:00');

// 5) cost display: system time preferred, else prev firstSeen
eq('cost from system', ctx.resolveCostDisplay_('2026-06-16T08:00:00+03:00', null, cfg), '2026-06-16 08:00');
const LG = ctx.LG;
const prevRow = new Array(ctx.LOG_COLS).fill('');
prevRow[LG.FIRST] = '2026-06-15 07:30';
eq('cost fallback to firstSeen', ctx.resolveCostDisplay_('', prevRow, cfg), '2026-06-15 07:30');

// 6) date-range aggregation by supervisor (completedByActor_)
function mkRow(oid, actor, supplierDisplay, mins, state) {
  const r = new Array(ctx.LOG_COLS).fill('');
  r[LG.OID] = oid; r[LG.ACTIVE] = actor; r[LG.SUPPLIER] = supplierDisplay; r[LG.MINS] = mins; r[LG.STATE] = state;
  return r;
}
ctx.ActivityLog.allRows = () => [
  mkRow('1', 'Ahmed', '2026-06-16 09:40', 40, ctx.ST_DONE ?? 'مكتمل'),
  mkRow('2', 'Ahmed', '2026-06-16 12:00', 20, 'مكتمل'),
  mkRow('3', 'Sara', '2026-06-16 13:00', 60, 'مكتمل'),
  mkRow('4', 'Ahmed', '2026-06-10 09:00', 10, 'مكتمل'), // out of range
  mkRow('5', 'Ahmed', '', '', 'قيد الطابور'),            // not completed
];
const agg = ctx.completedByActor_('2026-06-16', '2026-06-16');
eq('agg Ahmed count', agg.Ahmed.count, 2);
eq('agg Ahmed avg', agg.Ahmed.avg, 30);
eq('agg Sara count', agg.Sara.count, 1);
eq('agg excludes out-of-range', Object.keys(agg).sort(), ['Ahmed', 'Sara']);

// 7) migration collapse: verify indices map old→new correctly (spot check)
eq('LG.SUPPLIER index', LG.SUPPLIER, 9);
eq('LG.MINS index', LG.MINS, 10);
eq('LOG_COLS', ctx.LOG_COLS, 13);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
