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
vm.runInContext(src + '\n;Object.assign(globalThis,{CFG,Util,get_,pick_,parseInvoice_,extractPlate_,plateFromCar_,deepFindPlate_,normalizeDate_});', ctx);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
