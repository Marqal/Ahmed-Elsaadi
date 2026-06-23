# مسمار — Invoice Audit Monitoring System · v8.1

This update reworks the v8.0 script around four requirements: a **three-way tab
split by order status**, **cost/invoice timestamp capture**, a **rewritten
dashboard**, and **delivered-order analytics** (disbursement-supplier time +
handling duration) fully wired into the logs and the supervisors report.

> The script is container-bound to the Google Sheet. Paste `Code.gs` into the
> Apps Script editor (Extensions → Apps Script) and keep `appsscript.json` as
> the manifest. Then run **نظام مسمار → ⚙ إعداد الشيتات أول مرة** once.

---

## 1) Sheet restructuring — three status tabs

The old two-tab model (`الطلبات الجاهزة` / `الطلبات غير الجاهزة`) is replaced by
three status-driven tabs:

| Tab | Arabic | Contains |
|-----|--------|----------|
| Delivered Orders | `الطلبات تم التسليم` | **only** orders whose status matches `CFG.DELIVERED_STATUSES` (default `تم التسليم`) |
| Ready Orders | `الطلبات الجاهزة` | auditable/ready statuses that are **not yet delivered** |
| Other Orders | `طلبات أخرى` | every remaining status (waiting / blocked / still-loading) |

**How:** a new `classifyOrder_()` returns `delivered | ready | other`, and
`renderStatusTabs_()` renders the three pages. The legacy `الطلبات غير الجاهزة`
sheet is auto-migrated to `طلبات أخرى` (renamed in `initSheets`, or removed on
the first run if a fresh `طلبات أخرى` already exists).

## 2) Invoice / cost date tracking

A new column **`وقت إضافة الفاتورة`** records *when the cost-invoice was
created* (NOT the order creation date). `resolveCostDate_()`:

1. **System input time** — prefers the API's `invoice.createdAt`.
2. **Sheet addition time** — if the API omits it, falls back to the moment our
   sheet first observed the invoice (`firstSeenAt`, persisted in the hidden
   `__mismar_state` sheet).

It is surfaced on the main sheet, all three status tabs, and the activity log.

## 3) Dashboard rewrite (UX + speed)

`renderDashboard_()` was rebuilt to **batch every write** — each block is one
`setValues` + one `setBackgrounds` instead of hundreds of single-cell calls, so
it loads far faster. New KPI cards: delivered, ready, other, delayed,
**SLA compliance %**, **delivered today**, **avg handling time**, on-leave. The
supervisors block now shows live load **plus** today's deliveries and average
handling time per supervisor.

## 4) Delivered-order analytics + supervisor performance

For delivered orders the script now captures, via `extractDeliveryInfo_()`:

* **`وقت إضافة مورد الصرف`** — when the disbursement supplier (`مورد الصرف`) was
  added (from `statusesTracking` keywords or a dedicated supplier field).
* **Handling time** — business-minutes from the chosen milestone
  (`CFG.HANDLING_FROM`, default `supplier`) until completion (delivery).

Both are written to the activity log (two new columns: `وقت إضافة الفاتورة`,
`وقت إضافة مورد الصرف`) under the new **`تم التسليم`** action, and rolled up by
`completedTodayByActor_()` into **أداء المشرفين**, the dashboard, and the
weekly/monthly reports (which now show supplier-adds and average handling time).

The activity log auto-migrates from 11 → 13 columns (`ensureAuditSchema_`),
preserving existing history.

---

## ⚠️ Verify these against your live mismar API

The API response shape is inferred (same caveat noted in v8.0). If the delivered
tab shows `— (غير مسجّل)` for the supplier or `—` for handling time, tune these
knobs at the top of `Code.gs`:

| Config | Purpose | Default |
|--------|---------|---------|
| `CFG.DELIVERED_STATUSES` | status keyword(s) that mean "delivered" | `['تم التسليم', …]` |
| `CFG.READY_STATUSES` | status keyword(s) that mean "ready/auditable" | `['جاهز','مكتمل', …]` |
| `CFG.SUPPLIER_KEYWORDS` | tracking status name(s) for "supplier added" | `['مورد الصرف', …]` |
| `CFG.SUPPLIER_FIELD_NAMES` | order-detail object field(s) holding the supplier | `['disbursementSupplier', …]` |
| `CFG.HANDLING_FROM` | milestone the handling time starts from | `'supplier'` (or `'assign'`) |

**Assumption made:** the handling-time milestone defaults to *supplier-added*
(`مورد الصرف`), since requirement 4a is the supplier timestamp and 4b is the
duration "until completion". Set `CFG.HANDLING_FROM = 'assign'` to measure from
the assignment time instead.

## Setup / migration checklist

1. Paste `Code.gs` + `appsscript.json` into the Apps Script project.
2. Reload the sheet → menu **نظام مسمار** appears.
3. **🔐 حفظ التوكن (آمن)** — store the JWT in Script Properties.
4. **⚙ إعداد الشيتات أول مرة** — creates/migrates all sheets (incl. the 3 tabs).
5. **▶ تشغيل التحديث الآن** — first run.
6. **⏰ تفعيل التشغيل التلقائي** — 5-minute refresh + weekly/monthly reports.
