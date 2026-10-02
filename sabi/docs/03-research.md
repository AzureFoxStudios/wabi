# 03 — Research: ERP coverage and Thai SME requirements

Existing ERPs are used here to check **coverage**, not as UX templates. Thai requirements are summarised from the sources linked below. **Sabi is not certified accounting software.** It records the particulars the law asks for and produces working reports. A registered accountant still has to review filings.

## 1. ERP coverage map

Capabilities that Odoo CE, ERPNext, Dynamics Business Central and Thai packages (Express, EASY-ACC, FlowAccount, PEAK) all share, mapped onto Sabi primitives:

| Capability | Typical ERP modules | Sabi representation | Milestone 1 |
|---|---|---|---|
| Customers / suppliers / contacts | CRM, Contacts | Party (roles), contact = child Party | ✅ |
| Leads / inquiries / opportunities | CRM pipeline | Job type, first workflow states | ✅ |
| Quotations | Sales | Document type (no effects) | ✅ |
| Sales orders, reservations | Sales + Inventory | Document type (`reserve`) | ✅ |
| Delivery notes | Inventory | Document type (`stock_out`) | ✅ (combined with tax invoice) |
| Invoices / tax invoices | Accounting | Document type (`receivable`) + jurisdiction rules | ✅ |
| Billing notes (ใบวางบิล) | Thai practice | Document type that groups invoices | ⏳ config only |
| Receipts | Accounting | Payment view | ✅ |
| Credit / debit notes | Accounting | Document type (reverse effects) | ⏳ |
| Purchase requests / orders | Purchasing | Document types | ✅ PO |
| Goods receipt | Inventory | Document type (`stock_in`) | ✅ |
| Supplier bills, expenses | Accounting | Document type (`payable`) | ✅ |
| Stock levels, locations, adjustments | Inventory | StockMove ledger | ✅ |
| Manufacturing / cutting | MRP | Job workflow states + tasks + material issue | ✅ (lightweight) |
| Projects, tasks, timesheets | Project | Job + Task (timesheets deferred) | ✅ / ⏳ |
| Field service / install scheduling | Field Service | Job state + due date + assignee | ✅ basic |
| Approvals | Approvals / Studio | Workflow guard `approval` + Approval record | ✅ |
| Discussion on records | Odoo chatter, ERPNext comments | Message on any subject, native to the workspace | ✅ |
| Documents / attachments | DMS | File on any subject | ✅ |
| Audit trail | Audit log (often an add-on) | Hash-chained journal, always on | ✅ |
| General ledger, chart of accounts | Accounting | JournalEntry via posting policy | ✅ core postings |
| Bank reconciliation | Accounting | ⏳ | ⏳ |
| VAT reports | Localisation | Jurisdiction reports | ✅ output/input tax report |
| WHT certificates / PND | Thai localisation | Payment WHT fields + report | ✅ record, ⏳ 50 ทวิ print |
| Payroll | HR | Out of scope (payroll-adjacent records only) | ❌ |
| POS / counter sales | POS | Walk-in party + delivery/tax invoice | ⏳ fast counter UI |
| Multi-currency, multi-company | Accounting | ❌ (THB, single company) | ❌ |
| Custom fields / forms | Studio / Customize Form | Field schema per type | ✅ |
| Reports / dashboards | BI | Attention inbox + focused reports | ✅ |

**What these ERPs teach and what Sabi does differently**
- Odoo's *chatter* is the right idea: discussion sits on the record. Sabi makes it the main surface of every workspace instead of a panel at the bottom of a form.
- ERPNext's document lineage (Quotation → Sales Order → Delivery Note → Sales Invoice with "against" links) is sound. Sabi keeps line-level lineage but does **not** show it as a stack of separate module screens: it all lives inside the job.
- Every major ERP separates *stock valuation*, *accounting* and *operations* into separate modules with separate navigation. Sabi keeps them separate in **code** (the three layers in `02-domain-model.md`) but brings them together in the **UI** around the work.
- Thai packages (Express, EASY-ACC) are strong on tax-document formats and weak on collaboration, data ownership and Linux/browser use (see `docs/research/thai-construction-business-tech-standardization.md`). Sabi aims for the reverse, and exports cleanly to the accountant's package.

## 2. Thai SME requirements

### 2.1 VAT
- The statutory rate is 10%, but it has been held at 7% by successive Royal Decrees. Royal Decree No. 799 set 7% until 30 Sep 2026 [1](https://sherrings.com/value-added-tax-rates-thailand.html). On 27 July 2026 the Cabinet approved extending 7% from 1 Oct 2026 to 30 Sep 2027 [2](https://orbitax.com/news/country/article/Thailand-Extends-7-VAT-Rate-a-62687).
  → **Design:** tax rates carry **effective-date ranges** in the jurisdiction package, and the rate is chosen by the document date. The rate is never a hard-coded constant.
- VAT registration is compulsory above 1.8 M THB turnover. A monthly **PP.30** return is due by the 15th of the following month on paper or the 23rd by e-filing, even when there were no sales. VAT records must be kept for five years [3](https://www.thailawonline.com/vat-registration-in-thailand/).
  → **Design:** a monthly output/input tax report grouped by tax period, with filing reminders as attention items (reminders are roadmap).
- Input tax invoices can be claimed for six months [3](https://www.thailawonline.com/vat-registration-in-thailand/).

### 2.2 Tax invoices
- A **full tax invoice** must show: the words "Tax Invoice", the seller's tax ID, name and address, the buyer's name and address, the serial number (and book number if any), the date of issue, the name, type, quantity and value of the goods or services, and the VAT amount shown separately from the value [4](https://www.thailand.go.th/issue-focus-detail/006_124).
- Both seller and buyer must be marked **Head Office (สำนักงานใหญ่) or Branch No. XXXXX**. Leaving this out is a common reason invoices are rejected for input-VAT credit [5](https://invoicedataextraction.com/blog/thailand-tax-invoice-requirements).
- For goods, the tax invoice is issued **on delivery**. For services, it is issued **on receipt of payment**. At least two copies are required [4](https://www.thailand.go.th/issue-focus-detail/006_124).
- To cancel, recall the original, mark it cancelled and issue a new one [4](https://www.thailand.go.th/issue-focus-detail/006_124). Debit and credit notes count as tax invoices in their own right [4](https://www.thailand.go.th/issue-focus-detail/006_124).

→ **Design consequences in `jurisdiction-th`:**
1. `validateIssue()` blocks issuing a tax document while any required particular is missing: seller tax ID and branch, buyer name, address, tax ID and branch.
2. Numbers are gapless per document type and year, assigned at issue inside the same transaction.
3. The seller and buyer snapshot is frozen at issue.
4. Voiding keeps the number and records a reason. Nothing is ever deleted.
5. Document types declare `taxPoint: 'delivery' | 'payment'`. The metal-sheet pack uses the common Thai materials-shop combined document **ใบส่งของ/ใบกำกับภาษี** (delivery note/tax invoice) for goods.

### 2.3 e-Tax Invoice / e-Receipt
- Thailand's e-Tax system is voluntary. Paper invoices are still allowed, and businesses may run both side by side [6](https://pkfthailand.asia/understanding-e-tax-invoice-in-thailand/).
- There are two routes. The full route needs XML to ETDA standard 3-2560 with a CA digital signature. The *e-Tax Invoice by Email* route, for businesses with turnover ≤ THB 30 M, uses PDF/A-3 with an ETDA time stamp [7](https://www.fiscal-requirements.com/news/4698).
  → **Design:** out of scope for milestone 1. It is planned as a jurisdiction **adapter output** (XML/PDF-A3 generator plus an email time-stamp integration). The document snapshot already holds every field these formats need.

### 2.4 Withholding tax (WHT)
- The payer withholds tax on service payments of 1,000 THB or more. It is calculated on the amount **before VAT**. Rates: 3% for services and contract work (including construction and repairs), 5% for rent, 2% for advertising, 1% for transport [8](https://plizz.co/tax-in-thailand/withholding-tax/) [9](https://yoassistant.com/thailand/how-to-handle-withholding-tax-in-thailand-properly/).
- Filing uses **PND.3** when the payee is an individual and **PND.53** when the payee is a juristic person. It is due by the 7th (paper) or the 15th (e-filing) of the following month. A WHT certificate (50 ทวิ) must be issued at each withholding [10](https://orbitacc.com/en/blog/wht-pnd3-pnd53-sme-guide).

→ **Design:** items carry a `wht_category`. When a payment is recorded, the jurisdiction suggests the WHT amount from the service lines of the allocated documents. The payment stores `wht_amount`, the certificate number and the PND form.
For the metal-sheet business: when a corporate customer pays for **installation**, it withholds 3% on the labour. The shop receives 97% plus a 50 ทวิ certificate, and that WHT is a tax credit, posted to "WHT prepaid" rather than lost.

### 2.5 Retention, audit and identity
- VAT documents and reports: keep for at least 5 years [3](https://www.thailawonline.com/vat-registration-in-thailand/). Guidance puts overall retention at 5–7 years [11](https://www.vatupdate.com/2026/07/09/thailand-e-invoicing-e-reporting-country-booklet/).
  → **Design:** the journal is append-only, issued documents are immutable, there is no hard delete, and the data is exportable (JSONL journal plus a SQLite backup).
- The 13-digit tax ID is the company registration number [5](https://invoicedataextraction.com/blog/thailand-tax-invoice-requirements). The last digit is a mod-11 checksum, which `jurisdiction-th` validates.
- Personal data (PDPA B.E. 2562) applies to customer contact data. Sabi keeps it on the owner's own server, and the export and inspection features support data-subject requests. Anonymising a customer without breaking the tax records it appears on is roadmap.

### 2.6 Document flow common in Thai materials and construction SMEs
Sales: ใบเสนอราคา (quotation) → ใบสั่งขาย (sales order) → ใบส่งของ/ใบกำกับภาษี (delivery note/tax invoice) → ใบวางบิล (billing note, for credit customers) → ใบเสร็จรับเงิน (receipt).
Purchases: ใบขอซื้อ (PR) → ใบสั่งซื้อ (PO) → ใบรับสินค้า (goods receipt) → supplier's tax invoice → ใบสำคัญจ่าย (payment voucher) + 50 ทวิ.

These are **document types in the metal-sheet configuration pack**, not core tables.

### 2.7 Practical findings from the earlier research in this repository
From `docs/research/thai-construction-business-tech-standardization.md`:
- The biggest risks are shared accounts, edits that cannot be attributed to anyone, Excel shadow databases, approvals given in LINE, and screenshots used as payment evidence.
- Sensitive actions that need an approval or strong logging: price overrides and discounts, credit-limit breaches, manual stock adjustments, voiding financial records, and editing paid invoices.
→ Sabi's answer:
- **Named users**, and every change is an attributable journal event.
- **Approval guards**, for example a discount above a configured threshold.
- **Adjustment reasons** are required.
- **Void rather than edit.**
- **Payment evidence** (a slip photo) is attached to the payment.

## 3. Not claimed
- Not certified by the Revenue Department and not an approved e-Tax service provider.
- It does not file PP.30 or PND forms. It prepares the figures for them.
- The posting policy is a reasonable SME default. An accountant should review the chart of accounts before relying on it.
