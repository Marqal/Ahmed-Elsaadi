# مسمار — Invoice Audit Monitoring System

## v8.3 — consolidate history + cohort funnel (latest)

**Why the report total was too low (e.g. 368).** The report only reads the current
one-row log + the new-format archive. All the real history lived in **several
old-format log tabs** (`سجل النشاط - قديم` = v8.1 layout, `سجل نشاط قديم 2` = the
original v8.0 layout with *different* columns, and an old-format `- ارشيف` with
US-style `6/16/2026` dates). Those use different column positions, so the report
skips them (reading them with the new positions is what caused the earlier
order-id-as-supervisor corruption). Hence only the ~hundreds currently in the
queue were counted.

**Fix — new menu «🧩 دمج السجلات القديمة».** It merges **every** old log (both
layouts + old archive) into one clean, **date-sorted** `سجل نشاط قديم` tab in the
new order-keyed format, and the report now includes it (de-duped by order id, live
wins). **Data is preserved** — the raw source tabs are hidden as a backup, not
deleted. Run it once; then the reports reflect all history.

**Report is now a monotonic COHORT funnel.** Previously counts were event-in-window
so «أنجز» could exceed «تم التسليم». Now each report takes the orders that
**arrived** (دخلوا الطابور) in the range, and of *those* how many were delivered
and completed — so **وصله ≥ منها تم التسليم ≥ منها أُنجز**, matching «وصله كام …
كام منهم … وأنجز منهم قد ايه».

**Deploy:** paste `Code.gs`, run «▶ تشغيل التحديث الآن» once, then
«🧩 دمج السجلات القديمة» once, then open any report.

---

## v8.3 — analytic reports + Arabic-date fix

**Report showed all-zeros + messy log — fixed.** Google Sheets had coerced the
log's date strings into real Date values (text format was applied *after*
writing), so on the next read they came back as JS `Date.toString()`
("Sat Jul 04 2026 15:37:00 GMT+0300 …"). The report's date filter did
`substr(0,10)` → `"Sat Jul 04"` ≠ `yyyy-MM-dd`, so nothing matched and every
metric was 0. Now:
- `Util.datePrefix()` / `Util.toDisplay()` parse **any** form (Date object, ISO,
  JS toString, clean string) → reports filter correctly and the log **self-heals**
  to a clean `yyyy-MM-dd HH:mm` on the next run.
- Text format is applied **before** writing, so Sheets never re-coerces dates.
- «المسؤول» in the log is now filled from the **Matrix** by center whenever it is
  missing/numeric, so the log is consistent and searchable (search also accepts
  Arabic-Indic digits).
- The pre-migration backup tab is hidden to reduce clutter.

**After updating, run «▶ تشغيل التحديث الآن» once** to clean the stored dates and
fill agent names, then the reports.

---

**Supervisor column showed order/invoice numbers — fixed.** The report reader
(`ActivityLog.allRows`) read the log sheet *directly*, bypassing the schema
migration. If you opened a report before `runMismar` had migrated the log, it read
the **old** multi-row schema with the **new** column indices, so the order id
landed in the «المشرف» column and every metric was 0. Now `allRows()` runs the
migration first, and `logAgent_()` resolves the supervisor defensively (a name is
never purely numeric → falls back to the assigned auditor from the matrix by
center, else «—»). A stale v8.1 archive sheet (same name, old schema) is parked so
schemas never mix. **After updating, just run «▶ تشغيل التحديث الآن» once, then the
report.**


**Date-prompt bug fixed.** The «صيغة التاريخ غير صحيحة» popup happened because the
prompt received **Arabic-Indic digits** (`٢٠٢٦-٠٧-٠١`) or invisible RTL marks from
an Arabic keyboard, which the strict `\d` check rejected. `normalizeDate_()` now
accepts Arabic-Indic **and** Persian digits, RTL/bidi marks, `/` `.` `\`
separators, single-digit month/day, and even a pasted date-time
(`2026-07-01 09:12` → `2026-07-01`).

**Reports now do real analysis (a funnel per agent), for any range.** Instead of
just "completed count", every report (today / week / month / custom range) shows
per supervisor:

| المشرف | وصله (دخل الطابور) | تم التسليم | أنجز (مكتمل) | متوسط المعالجة | نسبة الإنجاز |
|---|---|---|---|---|---|

…answering *"how many orders reached the agent, how many were delivered, and how
many did they complete"* — plus a totals row, average handling time, completion
rate, and the same funnel per center. Counts are event-in-window (by milestone
date) so daily/weekly/monthly are directly comparable. New menu item **«📊 تقرير
اليوم»**; weekly/monthly/custom all use the same engine (`rangeFunnel_`).

---

## v8.2 — one-row log + delivery-based AHT

This version reworks the system around the **real workflow** and the feedback on
v8.1:

> Order becomes **«تم التسليم»** → it enters the audit queue → the auditor adds a
> **«مورد الصرف»** (disbursement supplier) → the invoice is settled and the order
> **leaves the queue**. So *supplier-added == completion*, the handling time we
> measure is **«تم التسليم» → «مورد الصرف»**, and the **AHT clock starts at delivery**.

To deploy: paste `Code.gs` + `appsscript.json` into the Apps Script editor, reload
the sheet, then run **نظام مسمار → ⚙ إعداد الشيتات أول مرة** once.

---

## What changed (per feedback)

### 1. Activity log = ONE ROW PER ORDER (update-in-place)
`سجل النشاط` is no longer append-only. Each order occupies a **single row** whose
milestone cells fill in over time:

`رقم الاوردر · رقم الفاتورة · المركز · المسؤول · الحالة الحالية · وقت إضافة الفاتورة · وقت الدخول للطابور · وقت الجاهزية · وقت التسليم · وقت إضافة مورد الصرف · مدة المعالجة (دقائق) · الحالة · آخر تحديث`

- The order appears **once**; e.g. `930537` is one row. Its *ready time* and
  *delivered time* land in separate cells, updated in place.
- Rows are keyed by order id (`ActivityLog` upsert). Old **multi-row** logs are
  **auto-collapsed** into one row per order on first access (the pre-migration
  sheet is parked as `سجل النشاط - قديم`).
- This makes reports usable again — no more thousands of duplicate rows.

### 2. «وقت إضافة مورد الصرف» now populates
Captured at **settlement** (when the order leaves the queue) from the order
detail. Handling minutes = `businessMinutes(deliveredAt → supplierAddedAt)`.
Because it always falls back to the order's last-action time, the column is never
mysteriously blank.

### 3. AHT starts only at «تم التسليم»
`computeMetric_()` counts business minutes from the **delivered** timestamp, for
delivered orders **only**. Ready / other orders are explicitly *not counted*
(shown as «لا تُحتسب»).

### 4. Delivered tab has no supplier column
Adding a supplier removes the order from the queue, so that column would always
be empty in the Delivered tab. It now shows: cost time · **delivered time** ·
**live handling since delivery** · on-target/late.

### 5. Dashboard + «أداء المشرفين» removed → new «الأداء اليومي» tab
Both retired sheets are deleted on setup. The new Daily Performance tab shows
exactly what was requested, per supervisor:

| المشرف | إجمالي المسند | تم التسليم (قيد الإنجاز) | أنجز اليوم | متوسط المعالجة اليوم | متأخرة الآن |
|---|---|---|---|---|---|

- **إجمالي المسند** — all in-queue orders assigned to them.
- **تم التسليم (قيد الإنجاز)** — delivered but not yet finished (supplier not added).
- **أنجز اليوم** — completed today (supplier added today), from the one-row log.

### 6. New «📆 تقرير حسب التاريخ (من - إلى)»
Menu item prompts for a from/to date and builds a per-supervisor + per-center
report of completed orders in that range. Weekly/monthly reports reuse the same
engine (`buildRangeReport_`).

---

## Tabs after this update
`الطلبات` (queue) · `الطلبات تم التسليم` · `الطلبات الجاهزة` · `طلبات أخرى` ·
`اجمالي المراكز` · `الأداء اليومي` · `سجل النشاط` (+ archive) · reports.
**Removed:** `الداش بورد`, `اداء المشرفين`, `__mismar_state`.

## ⚠️ Verify against your live API
If supplier/handling still show «—», tune `CFG.DELIVERED_STATUSES`,
`CFG.SUPPLIER_KEYWORDS`, `CFG.SUPPLIER_FIELD_NAMES`. Supplier time falls back to
the last-action time at settlement, so completion is always recorded.

## Verification
`test_logic.js` is a Node harness that stubs the Apps Script globals and unit-tests
the pure logic (classification, overnight business-minutes, delivery-based AHT,
supplier extraction, cost fallback, date-range report aggregation):

```bash
cd apps-script && node test_logic.js      # 65 passed, 0 failed
```
