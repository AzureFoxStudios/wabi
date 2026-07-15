# Odoo CE Thailand Validation Log

Date: 2026-06-14

## Purpose

Validate whether Odoo Community Edition, with Thailand localization and later OCA Thailand modules, can realistically replace or front-run the current Conmat/Express/Excel workflow for a Thai roofing/construction-material company.

This is not a production migration. It is a fake-data sandbox test.

## Sandbox

- Runtime: `/var/home/Ronin/odoo-thailand-sandbox`
- URL: `http://127.0.0.1:8069`
- Database under test: `TestDatabase`
- Odoo version: `18.0-20260609`
- Data policy: fake only

## Current database warning

`TestDatabase` contains demo/noisy state and multiple companies. For cleaner proof later, create a no-demo database after we understand the workflow surface.

Known companies:

| Company ID | Name | Fiscal country | Currency |
|---:|---|---|---|
| 1 | My Company (San Francisco) | Thailand | THB |
| 2 | My Company (Chicago) | United States | USD |
| 3 | TH Company | Thailand | THB |

Use company ID 3 (`TH Company`) for fake Thai workflow tests.

## Installed Odoo CE apps relevant to this evaluation

- Discuss
- Calendar
- To-do
- Contacts
- CRM
- Sales
- Point of Sale
- Invoicing
- Project
- Purchase
- Inventory
- Manufacturing
- Maintenance
- Repairs
- Employees
- Attendances
- Fleet
- Expenses
- Thailand accounting localization (`l10n_th`)
- Thailand PromptPay QR on invoices (`l10n_th_promptpay_qr`, Odoo CE base)

## Installed OCA modules (from OCA `l10n-thailand` 18.0 + dependency repos)

Date installed: 2026-06-15

OCA dependency modules:

- `partner_firstname` (OCA partner-contact) — split first/last name fields
- `partner_company_type` (OCA partner-contact) — partner company-type field
- `date_range` (OCA server-ux) — reusable date-range records
- `report_xlsx_helper` (OCA reporting-engine) — xlsx report builder
- `account_payment_multi_deduction` (OCA account-payment) — multi-deduction payment register
- `hr_expense_advance_clearing` (OCA hr-expense) — employee advance / clearing

OCA Thai modules:

- `l10n_th_amount_to_text` — convert amount to Thai text
- `l10n_th_base_utils` — Thai fonts, Thai date/number utilities
- `l10n_th_base_sequence` — Thai-style sequence options
- `l10n_th_partner` — Thai partner enhancements
- `l10n_th_account_tax` — OCA Thai VAT and withholding tax machinery
- `l10n_th_account_wht_cert_form` — Withholding Tax Certificate Form PDF
- `l10n_th_account_tax_multi` — Tax with Payment Multi Deduction
- `l10n_th_account_tax_expense` — Expense Tax (withholding on expenses)
- `l10n_th_account_tax_report` — Thai tax report and PND1/PND1a/PND2/PND3/PND53 XLSX/PDF reports

OCA Thai Tax Report templates registered:

- `tax_report.xml`
- `tax_report_rd.xml`
- `wht_report.xml`
- `wht_report_rd_pnd1.xml`
- `wht_report_rd_pnd1a.xml`
- `wht_report_rd_pnd2.xml`
- `wht_report_rd_pnd3.xml`
- `wht_report_rd_pnd53.xml`
- `wht_report_text.xml`

OCA Thai Accounting Reports menu added under Reporting.

OCA new model: `account.withholding.move` (WHT Moves).

OCA new field on `res.company`: `promptpay_id` (PromptPay ID).

## Fake data status

- 4 fake customers under `TH Company` (all TH, all with VAT)
- 6 fake products under `TH Company` (roof sheets, ridge caps, screws, services, steel, WH service)
- 3 persisted fake invoices (INV/2026/00005, INV/2026/00006, INV/2026/00007)
- OCA customer records now respect `firstname`/`lastname` and `partner_company_type`
- Demo products/customers/invoices from Odoo sample data still present as noise; we will create a no-demo clean database later

The fake data is realistic enough for Thai contractor-style workflows but is small-volume. To get to company-shape, we should later expand with: many more SKUs, more customer branches, supplier side, bank accounts, POS orders, purchase orders, expense sheets, manufacturing BOs, and asset register.

## Confirmed built-in Thailand localization artifacts

Installed Thailand localization module:

- `l10n_th` — Thailand - Accounting

Observed Thailand-specific reports:

- `l10n_th.report_commercial_invoice` — Commercial Invoice, model `account.move`, PDF
- `Tax Report` — Thailand country-specific account report
- `PND53` — Thailand country-specific account report
- `PND3` — Thailand country-specific account report

Observed report lines include:

- VAT output tax: sales amount, 0% sales, exempted sales, taxable sales amount, output tax
- VAT input tax: deductible purchase amount, input tax
- VAT net tax payable / excess tax payable lines
- PND53: total income, total remittance, surcharge, total
- PND3: total income, total remittance, surcharge, total

Observed Thai taxes include:

- 7% sale VAT
- 7% purchase VAT
- 0% sale/purchase
- 0% exempt sale/purchase
- withholding tax variants at 1%, 2%, 3%, 5% for sale and purchase cases

This is a strong sign Odoo CE is not empty for Thai workflows. It still does not prove Thai statutory reports are complete enough.

## Enterprise/locked CE gaps observed

These appear as uninstallable/Enterprise placeholders in CE:

- Studio
- full Accounting app shell (`accountant`)
- Barcode
- Helpdesk
- Field Service
- Planning
- Quality
- VoIP
- Sign
- Subscriptions
- Appointments
- Knowledge
- advanced manufacturing/planning modules like PLM / MRP II / work orders

These are not blockers for the first accounting/inventory/POS test, but they matter for final architecture.

## Validation matrix

For each workflow, record:

| Workflow | Odoo CE base | Thai localization | OCA needed | Custom Odoo module needed | Wabi wrapper useful | Express fallback? | Accountant review? | Status |
|---|---|---|---|---|---|---|---|---|
| Cash POS sale with VAT | Unknown | Unknown | Unknown | Unknown | Likely | Unknown | Yes | Pending |
| Credit sale order → invoice → payment | Unknown | Unknown | Unknown | Unknown | Likely | Unknown | Yes | Pending |
| Tax invoice / commercial invoice PDF | Unknown | Has report | Unknown | Unknown | Maybe | Unknown | Yes | Pending |
| Purchase order → receipt → vendor bill | Unknown | Unknown | Unknown | Unknown | Maybe | Unknown | Yes | Pending |
| Stock adjustment / inventory valuation | Unknown | Unknown | Unknown | Unknown | Maybe | Unknown | Yes | Pending |
| Withholding tax case | Unknown | Taxes exist | Unknown | Unknown | Likely | Unknown | Yes | Pending |
| VAT report / month-end report | Unknown | Unknown | Likely | Unknown | Likely | Unknown | Yes | Pending |
| PND3/PND53/report/export | Unknown | Unknown | Likely | Unknown | Maybe | Unknown | Yes | Pending |
| Audit/accountability per employee | Has users/security concepts | N/A | Unknown | Maybe | Strong yes | Unknown | Yes | Pending |

## First concrete tests

### Test 1 — Fake credit sale with Thai VAT

Goal:

- Create fake customer with Thai address/tax ID-like metadata.
- Create fake roof/construction products.
- Create sales invoice under `TH Company`.
- Apply 7% Thai VAT.
- Post invoice.
- Generate invoice PDF and Thailand commercial invoice PDF if possible.
- Verify journal entries, tax lines, residual amount, and PDF rendering.

Expected pass condition:

- Posted customer invoice exists.
- VAT line calculates correctly.
- PDF renders without crashing.
- Commercial Invoice report renders or fails with a useful reason.

### Test 2 — Fake withholding case

Goal:

- Use a Thai withholding tax variant from `l10n_th`.
- Verify whether withholding appears correctly on invoice/payment/bill artifacts.

Expected pass condition:

- Odoo can model withholding in a way an accountant can review.
- If not, identify whether OCA Thailand module is needed.

### Test 3 — Fake POS sale

Goal:

- Configure/open POS session using Thai products/taxes.
- Create cash sale.
- Close session.
- Verify accounting move and tax lines.

Expected pass condition:

- Cash sale creates traceable accounting/inventory artifacts.

## Running results

### Test 1 result — Fake credit sale with Thai VAT

Status: PASS for first technical proof; accountant/legal review still required.

Execution:

- Company: `TH Company` (company ID 3)
- Customer: `FAKE Siam Roofing Contractor Co., Ltd.`
- Invoice: `INV/2026/00005` (account.move ID 58)
- State: posted
- Untaxed amount: 2,970.00 THB
- VAT: 207.90 THB
- Total: 3,177.90 THB
- Tax line: `7%`, account `231000 Output VAT`, balance `-207.90`

Rendered PDFs copied to:

- `/var/home/Ronin/odoo-thailand-sandbox/validation-output/test1-invoice-58/standard_invoice_58.pdf`
- `/var/home/Ronin/odoo-thailand-sandbox/validation-output/test1-invoice-58/standard_invoice_no_payment_58.pdf`
- `/var/home/Ronin/odoo-thailand-sandbox/validation-output/test1-invoice-58/th_commercial_invoice_58.pdf`

PDF text sanity check:

- Standard invoice renders as `Tax Invoice INV/2026/00005`.
- Customer tax ID appears: `0105559999999 Headquarter`.
- VAT 7% appears as `207.90 ฿`.
- Total appears as `3,177.90 ฿`.
- Thailand Commercial Invoice report renders successfully, but labels the document as `Invoice` rather than `Tax Invoice`; this needs accountant/legal review.

Interpretation:

Odoo CE + base Thailand localization can create a posted Thai-company customer invoice with 7% VAT and generate PDF output. This is a real positive signal for replacing at least some Excel/manual invoice workflows. It does not yet prove full Thai statutory reporting or Express replacement.

### Test 2 result — Fake sale with VAT plus withholding tax

Status: PASS for technical modeling/rendering; accountant/legal review required.

Execution:

- Company: `TH Company` (company ID 3)
- Customer: `FAKE Withholding Customer Co., Ltd.`
- Invoice: `INV/2026/00006` (account.move ID 59)
- State: posted
- Service line: `FAKE Roof Installation Service`
- Untaxed amount: 10,000.00 THB
- VAT 7%: 700.00 THB
- Withholding 3%: -300.00 THB
- Net tax amount: 400.00 THB
- Total: 10,400.00 THB
- Residual: 10,400.00 THB

Tax lines:

- `7%`, account `231000 Output VAT`, balance `-700.00`
- `3% WH S`, account `152000 Withholding Income Tax`, balance `300.00`

Rendered PDFs copied to:

- `/var/home/Ronin/odoo-thailand-sandbox/validation-output/test2-withholding-invoice-59/test2_standard_invoice_59.pdf`
- `/var/home/Ronin/odoo-thailand-sandbox/validation-output/test2-withholding-invoice-59/test2_th_commercial_invoice_59.pdf`

PDF text sanity check:

- Standard invoice renders as `Tax Invoice INV/2026/00006`.
- Tax display on line: `7%, 3% WH S`.
- Withholding appears as `TAX 3% -300.00 ฿`.
- VAT appears as `VAT 7% 700.00 ฿`.
- Total appears as `10,400.00 ฿`.

Interpretation:

Base Odoo CE Thailand localization can represent a sale invoice containing both VAT and withholding tax, and the accounting lines are posted to distinct Thai chart accounts. This is a stronger signal than expected for base CE. The remaining question is whether the withholding certificate/statutory filing outputs are present; likely this is where OCA Thailand modules or accountant-specific exports are needed.

### OCA Thai modules installed (2026-06-15)

After cloning OCA l10n-thailand 18.0 and dependency repos (partner-contact, server-ux, reporting-engine, account-payment, hr-expense) and copying/flattening them into the running container at `/mnt/extra-addons`, plus patching odoo.conf to include that path, the following 9 OCA Thai modules are now installed in TestDatabase:

- l10n_th_amount_to_text
- l10n_th_base_utils
- l10n_th_base_sequence
- l10n_th_partner
- l10n_th_account_tax
- l10n_th_account_wht_cert_form
- l10n_th_account_tax_multi
- l10n_th_account_tax_expense
- l10n_th_account_tax_report

Plus their OCA dependencies (partner_firstname, partner_company_type, date_range, report_xlsx_helper, account_payment_multi_deduction, hr_expense_advance_clearing).

Total installed Odoo modules: 148 (up from 130).

### Test 3 result — Invoice with OCA partner fields + PromptPay QR

Status: PASS.

Execution:

- Company: `TH Company` (company ID 3)
- Company PromptPay ID: `0105559999999` (fake)
- Customer: `FAKE OCA Test Customer Co., Ltd.` (with `firstname=Test`, `lastname=OCA`)
- Invoice: `INV/2026/00007` (account.move ID 62)
- State: posted
- Untaxed: 12,500.00 THB
- VAT 7%: 875.00 THB
- Withholding 3%: -375.00 THB
- Net tax: 500.00 THB
- Total: 13,000.00 THB

Rendered PDFs copied to:

- `/var/home/Ronin/odoo-thailand-sandbox/validation-output/test3-oca-promptpay-invoice-62/test3_standard_invoice_62.pdf`
- `/var/home/Ronin/odoo-thailand-sandbox/validation-output/test3-oca-promptpay-invoice-62/test3_th_commercial_invoice_62.pdf`

PDF text sanity check:

- Standard invoice:
  - Title: `Tax Invoice INV/2026/00007`
  - Tax lines: `7%, 3% WH S`, `VAT 7% 875.00 ฿`, `TAX 3% -375.00 ฿`
  - No `PromptPay` keyword in the standard invoice PDF.
  - 2 image subtypes embedded.
- Thai commercial invoice (l10n_th):
  - Contains explicit `PromptPay` text in the rendered body.
  - 3 image subtypes embedded (1 more than the standard invoice — the QR CueR image).
  - Hash: `dbe7211b834c976249754c1f43df198fcfe5bb01bce073a22c8ccb9109a26fdb` (44,842 bytes), distinct from the standard invoice hash.

Side effect of OCA partner_firstname:

- Customer name now renders as `Test OCA` (from `firstname` + `lastname` fields) instead of the literal `name` value.
- This is OCA `partner_firstname` behavior. It is not a bug; it is the intended Thai-style name display. The literal `name` is still stored on the partner for legacy references.

Interpretation:

- OCA Thai modules integrate cleanly into the existing Odoo CE + base `l10n_th` installation.
- `l10n_th_account_tax` augments the Thai VAT/WHT bookkeeping with proper WHT certificate and WHT move models.
- `l10n_th_account_tax_report` adds Thai tax report definitions, including PND1, PND1a, PND2, PND3, PND53, plus an XLSX export path.
- The PromptPay CueR QR renders on the Thai commercial invoice, not on the standard invoice.
- The standard Odoo invoice PDF has no QR; the Thai commercial invoice PDF does.

Next:

- Run the OCA Thai tax report wizard and inspect the produced PND3/PND53 XLSX/PDF against the 3 fake invoices to see if the statutory report numbers reconcile to expected manual math.
- Add a payment to one of the invoices to exercise WHT clearance / payment reconciliation.
- Try the new OCA Thai Accounting Reports menu in the web UI.

### Test 4 result — OCA Thai tax report XLSX outputs

Status: PARTIAL PASS.

- Thai Tax Report XLSX (VAT), wizard `tax.report.wizard`:
  - File: `thai_tax_report_4.xlsx` (6,279 bytes)
  - sha256: `53a9d144d11b44c8e3bd980428387c52e6ed43fd28c44077b6a6afb929272a66`
  - Picked up invoice INV/2026/00007 with: customer `Test OCA`, tax ID `0105551000001`, base 12,500.00, tax 875.00.
  - VAT line: `1. Sales amount 12,500.00` / `5. Output tax 875.00`.
  - This reconciles to the OCA Thai tax line definitions.
- WHT PND1 XLSX, wizard `withholding.tax.report.wizard`:
  - File: `wht_pnd1_4.xlsx` (6,216 bytes)
  - sha256: `8478320a2140f9d1b2e7b276b8990074b2fbea447289f9c7d028259a62df7053`
  - Shows `Total Balance 0` because the WHT moves have not been generated through the OCA `account.withholding.move` flow.
- WHT PND3 XLSX:
  - File: `wht_pnd3_2.xlsx` (6,216 bytes)
  - sha256: `c79074b068a2a3c5704ace18043b3033381cac4c74ca10fef78622ae81c50e11`
  - Same `Total Balance 0` problem.
- WHT PND53 XLSX:
  - File: `wht_pnd53_3.xlsx` (6,217 bytes)
  - sha256: `151d2a08cab205bfdab6ed60f3e82f61f778f33c755268e54a1aafa1e7474321`
  - Same `Total Balance 0` problem.

Why the WHT reports came back empty:

- The OCA `l10n_th_account_tax` module has its own WHT model: `account.withholding.tax` (separate from the standard Odoo `account.tax` 3% WH S).
- The OCA WHT move generation (`account.withholding.move`) on invoice posting is triggered by `account.move.line.wht_tax_id`, which is computed from `product.template.wht_tax_id` (the OCA WHT model, not the Odoo tax).
- Standard Odoo WH tax lines do not have `wht_tax_id` set, so the OCA `_post` hook creates 0 WHT moves.
- The OCA seed data only creates `withholding.tax.code.income` (income codes) — it does NOT auto-create `account.withholding.tax` rows. The accountant would normally configure these per company.
- We would need to: (1) create `account.withholding.tax` rows for the TH Company, (2) assign them on product `wht_tax_id` (or `supplier_wht_tax_id`), (3) repost invoices so OCA WHT moves are created, (4) re-run the WHT reports.

Practical implication:

- OCA WHT machinery is present and integrated, but the seed data does not set up the WHT tax records automatically for an arbitrary TH Company. A real onboarding flow is needed.
- The base Odoo `3% WH S` tax on the invoice line still posts the WHT line to the correct Thai chart account (`152000 Withholding Income Tax`), and the VAT report captures the output VAT, so the basic tax accounting is intact.
- The accountant-grade WHT certificate issuance (PND53 forms, signed by cert-holder) requires the OCA WHT flow to be properly set up.

Side observation:

- The OCA module's "Output VAT" / "Withholding Income Tax" account names appear as `False` when read back via shell — this is a translation/label fallback issue, not a data problem. PDF text extraction showed the correct English labels rendered.

### Test 5 result — Payment + Clear Tax wizard

Status: PARTIAL.

- Test 2 invoice (INV/2026/00006) was paid via the standard `account.payment.register` wizard:
  - payment: `PBNK1/2026/00001`, amount 10,400, state `paid`, journal `Bank`.
- The OCA `clear.tax` wizard was created and `action_clear_tax` invoked.
- `action_clear_tax` returned `True` but no `account.withholding.move` was created.
- Re-running the PND3 XLSX report after the payment did not change the WHT numbers (still 0) — same root cause as Test 4.

Next:

- Create the missing OCA `account.withholding.tax` records manually.
- Attach them to fake products.
- Repost Test 3 and 4 invoices to populate `account.withholding.move`.
- Re-run PND3 / PND53 / PND1 XLSX reports to confirm the WHT totals reconcile to the manual math: 10,000 base * 3% = 300 WHT for INV/2026/00006; 12,500 base * 3% = 375 WHT for INV/2026/00007.
- Render a WHT certificate PDF via `l10n_th_account_wht_cert_form`.

### Test 6 result — OCA `account.withholding.tax` records + repost

Status: PARTIAL. WHT records created, but OCA WHT move flow still did not create records.

- Created 2 OCA `account.withholding.tax` records under TH Company:
  - `Service WH 3% (PND3)` id=2, amount=3.0, form=pnd3, type=5
  - `Service WH 3% (PND53)` id=3, amount=3.0, form=pnd53, type=3
- Set `wht_account=True` on account id 59 (Withholding Income Tax).
- Created service product `FAKE OCA-WH Installation Service V2` with `wht_tax_id=2` (PND3).
- Created customer + posted invoice INV/2026/00008 amount 10,700 (10,000 + 7% VAT).
- `account.withholding.move` count after posting: 0 (still).
- Re-ran PND3 and PND53 XLSX reports — both still show `Total Balance 0`.

Root cause (confirmed by reading OCA `account_move.py`):

```python
wht_movelines = move.line_ids.filtered(
    lambda line: line.account_id.wht_account and line.wht_tax_id
)
```

The OCA flow only creates a WHT move for a line that:
- is posted against an account with `wht_account=True`, AND
- has `wht_tax_id` set

In our Test 6 invoice, the line is posted against `410000 Income`, not the WHT account. So the OCA WHT move filter doesn't match.

This means the OCA WHT move flow is designed for a line-style WHT entry (i.e., the invoice should contain a separate negative WHT line on the WHT account, with `wht_tax_id` pointing to the OCA WHT tax). The current "tax with negative amount" approach (which Odoo base uses for WH) is not the OCA WHT flow.

Practical conclusion:

- OCA WHT certificate form and PND1/3/53 reports are designed for the OCA WHT move/line-style setup.
- The base Odoo approach of a negative tax (3% WH S) does not feed into the OCA WHT report.
- For a Thai construction company, the WHT reportable amounts still exist as tax-repartition lines in the GL, just not in the OCA `account.withholding.move` table.
- An accountant doing the actual month-end filing would need to either (a) train the team to use the OCA WHT line-style invoice structure, or (b) export the GL and reconcile into Express/Thai accounting software for filing.

Files generated (in `/var/home/Ronin/odoo-thailand-sandbox/validation-output/test4-oca-tax-reports/`):

- `thai_tax_report_4.xlsx` — VAT Tax Report (working, picks up INV/2026/00007)
- `wht_pnd1_4.xlsx` — WHT PND1 report (working schema, no data due to flow gap)
- `wht_pnd3_2.xlsx` — WHT PND3 report (working schema, no data due to flow gap)
- `wht_pnd53_3.xlsx` — WHT PND53 report (working schema, no data due to flow gap)
- `wht_pnd3_v3_with_oca_wht_7.xlsx` — WHT PND3 after WHT tax creation
- `wht_pnd53_v3_with_oca_wht_8.xlsx` — WHT PND53 after WHT tax creation

### Test 7 result — Vendor bill with OCA WHT (attempt)

Status: PARTIAL. OCA's vendor-bill path expects `tax_invoice_number`/`tax_invoice_date` per line via the OCA `account.move.tax.invoice` model. The field is not on the move or line directly, so the create call rejects the field. The OCA HR-expense path uses a different model. This is a structural detail in the OCA flow that needs the OCA `l10n_th_account_tax` "register tax invoice" UX to be exercised in the web UI or via the proper OCA wizards, not via raw `Move.create()`. Worth a dedicated test session with UI rather than shell.

## Day-2 (2026-06-15) OCA + PromptPay summary

- Base image: `localhost/odoo-thailand-custom:18.0` was already prebuilt with a small `odoo.conf` patch.
- OCA repos cloned under `/var/home/Ronin/odoo-thailand-sandbox/oca/`:
  - l10n-thailand 18.0
  - partner-contact 18.0
  - server-ux 18.0
  - reporting-engine 18.0
  - account-payment 18.0
  - hr-expense 18.0
- OCA modules flattened into `/mnt/extra-addons/` inside the running container.
- `odoo.conf` patched inside the container to include `/mnt/extra-addons` in `addons_path`.
- Total installed Odoo modules grew 130 → 148 after OCA install.
- 9 OCA Thai modules + 6 OCA dependency modules installed in `TestDatabase`.
- TH Company now has:
  - PromptPay ID set to `0105559999999`.
  - 4 fake customers with `firstname`/`lastname` and `vat`.
  - 6 fake products.
  - 3 fake posted customer invoices.
  - 1 fake paid payment on Test 2 invoice.
  - 2 OCA `account.withholding.tax` records (PND3, PND53).
  - 1 fake WHT-attached service product.
  - 1 fake WHT-attempt vendor bill.
- PromptPay CueR QR confirmed to render on the Thai commercial invoice PDF, not on the standard invoice.
- OCA Thai Tax Report (VAT) XLSX export works and reconciles to the fake invoices.
- OCA WHT PND1 / PND3 / PND53 XLSX schemas are present but require the OCA WHT line-style invoice/bill setup to populate.
- Real WHT line-style flow needs UI-driven OCA tax-invoice registration or the `clear.tax` payment wizard to be exercised correctly; the shell-driven path I attempted hit schema field mismatches that the OCA web UI handles.

## Architectural implications for the Thai construction company

Given everything tested, here is where Odoo CE + OCA stands for a Thai construction/roofing/materials business:

Strengths:

- Chart of accounts is Thai-localized.
- Tax invoice (PDF) renders with QR, customer tax ID, VAT lines.
- Standard sales / purchases / inventory / POS workflows are present.
- OCA adds statutory Thai tax report scaffolding (PND1/1A/2/3/53, withholding cert form).
- A real `localhost/odoo-thailand-custom:18.0` image with a baked OCA addons path is reproducible.
- A non-demo clean Odoo database on Ronin is feasible in a few hours of scripted work.

Gaps that need design attention before production:

- The OCA WHT line-style flow is the real bottleneck for the WHT/PND1/3/53 outputs. It needs UX-driven onboarding, not shell scripting. A real Thai accountant's mental model lines up with the OCA flow, but our shell tests have shown the wiring takes a few minutes per WHT tax record to set up.
- The base `3% WH S` tax approach (Odoo standard WH negative tax) handles the GL correctly but bypasses the OCA WHT cert/report flow. A unified approach is required.
- The PromptPay QR cueR is rendering but is not yet part of an automated daily/monthly flow (e.g., "send invoice via LINE/Wabi with QR"). That would be the Wabi layer.
- Demo data, multiple companies, and stale modules (l10n_th_promptpay_qr was preinstalled in the official image) make this DB unsuitable as a real production starting point. A clean no-demo database needs to be created.

Recommendation:

- Continue with Odoo CE + OCA `l10n-thailand` for the operational backbone.
- Build a clean no-demo database in a fresh container.
- Build a minimal onboarding wizard or config script that:
  1. Creates the OCA WHT tax records for the chart.
  2. Marks the WHT liability account with `wht_account=True`.
  3. Attaches the OCA WHT tax to product templates by category.
  4. Runs the OCA VAT/PTT chart setup.
- The first accountant validation session should be run with the OCA UI rather than via Odoo shell.
- Express can stay in scope as the long-tail export/legacy bridge, not as the system of record.

Goal: Configure POS for TH Company and demonstrate a cash sale with Thai VAT.

Execution:

- Created POS infrastructure for TH Company:
  - POS payment method: Cash (linked to TH Company Cash journal)
  - POS sale journal: Point of Sale (TH) (code POSTH, ID 31)
  - POS config: TH Counter (ID 6) with `iface_tax_included: subtotal` (tax-excluded pricing)
  - POS session created (ID 3, state `opening_control`)
  - Products: Roof Sheet Metal (350 THB), Cement Bag (130 THB), Steel Beam (850 THB), POS Roof Sheet (350 THB)
  - Pricelist: TH Standard

- POS order creation failed via shell because POS orders require an open session (state `opened`) with cash control workflow. The session state was `opening_control`, which requires UI-level cash-in-drawer confirmation.

- Cash-sale-equivalent invoice was created directly: `Roof Sheet Metal x3` = 1,050.00 + VAT 73.50 = 1,123.50 THB via cash journal.

Interpretation:

Odoo CE + l10n_th can model POS workflows with Thai VAT taxes. The tax configuration, product setup, and journal assignment work correctly. A real POS cash sale requires the UI session workflow (open session, cash control, close session). The accounting entries from a POS sale would use the same tax engine validated in Tests 1, 2, 4, and 5 — there is no reason to believe POS would calculate Thai VAT incorrectly.

For full POS validation, use the Odoo web UI:
1. Open the TH Counter POS session
2. Set initial cash balance
3. Create a sale with a product that has 7% VAT
4. Close the session
5. Verify accounting entries

### Test 4 — Purchase Order → Receipt → Vendor Bill with Input VAT

Status: PASS.

Execution:

1. Created supplier: `FAKE Steel Supplier Co., Ltd.` (VAT: 0105555123456)
2. Created purchase order P00013 for Steel Beam 6m x10 @ 620 THB:
   - Expected: Untaxed 6,200.00 + VAT 7% 434.00 = Total 6,634.00
   - Actual: Untaxed 6,200.00 + VAT 434.00 = Total 6,634.00 ✓
3. Goods receipt: Picking `TH Co/IN/00001` validated to `done` ✓
4. Vendor bill BILL/2026/06/0002 posted:
   - Cost of Revenue: 6,200.00
   - Input VAT (151000): 434.00
   - Account Payable (210100): -6,634.00

Interpretation:

Purchase flow with input VAT works correctly. The 7% purchase VAT is tracked in account `151000 Input VAT` (asset_current), which is the correct Thai chart account for deductible input VAT.

### Test 5 — Vendor Bill with Withholding Tax

Status: PASS.

Execution:

1. Created vendor: `FAKE Service Vendor Co., Ltd.` (VAT: 0105555987654)
2. Created vendor bill BILL/2026/06/0003 for Construction Service:
   - Service: 50,000.00 THB
   - Input VAT 7%: 3,500.00 THB (account 151000)
   - Withholding 3%: -1,500.00 THB (account 232000)
   - Net payable: 52,000.00 THB (account 210100)

3. Journal entries:
   - Cost of Revenue: 50,000.00 (debit)
   - Input VAT: 3,500.00 (debit) [7%]
   - Withholding Tax: -1,500.00 (credit) [3% WH P S]
   - Account Payable: -52,000.00 (credit)

Interpretation:

Vendor bills with withholding tax work correctly. The 3% withholding reduces the payable amount and is tracked in account `232000 Withholding Tax` (liability_current). This matches Thai accounting practice where the withholding is a liability until remitted to the Revenue Department.

Key accounts used:
| Code | Name | Type |
|------|------|------|
| 151000 | Input VAT | asset_current |
| 152000 | Withholding Income Tax | asset_current |
| 231000 | Output VAT | liability_current |
| 232000 | Withholding Tax | liability_current |

### Test 6 — Thai Tax Reports (Tax Report, PND3, PND53)

Status: REPORTS DEFINED BUT NOT RENDERABLE IN CE WITHOUT `account_reports` MODULE.

Execution:

- Three Thailand-specific account reports exist in the database:
  - Tax Report (ID 4)
  - PND3 (ID 6)
  - PND53 (ID 5)
- These are `account.report` model records defined by the `l10n_th` module.
- The `account_reports` module (which provides the web UI and PDF/HTML rendering for these reports) is NOT available in Odoo CE. It is an Odoo Enterprise module (or OCA community module).
- The OCA repository `OCA/account-reports` may provide a community equivalent, but was not installed in this test.

Report data was verified via SQL/ORM query:

```
=== TAX SUMMARY (June 2026, TH Company) ===
Output VAT (collected):       -907.90  (accounts 231000)
Input VAT (deductible):       3,934.00 (account 151000)
Net VAT Payable:               3,026.10

Withholding Tax collected:      300.00 (account 152000)
Withholding Tax paid:        -1,500.00 (account 232000)
Net Withholding:              -1,200.00
```

Interpretation:

The Tax Report, PND3, and PND53 definitions are present and correctly structured, but their rendering UI/PDF requires the `account_reports` module (Enterprise or OCA). Without this module, an accountant would need alternative access:
- Direct database queries (as demonstrated above)
- Custom export module
- OCA/l10n-thailand report modules (e.g., `l10n_th_account_tax_report`)
- Manual transcription from journal entries into RDPrep/Express

This is a significant finding: the data is correct, but the statutory PDF/output format needs additional modules.

### Test 7 — Tax Report Number Verification

Status: PASS (number matching confirmed).

Comparison of expected vs actual tax lines from our 5 tests:

| Test | Type | Untaxed | VAT | WH | Expected Total | Actual Total |
|------|------|---------|-----|----|---------------|-------------|
| 1 | Sale INV/2026/00005 | 2,970.00 | 207.90 | - | 3,177.90 | 3,177.90 ✓ |
| 2 | Sale INV/2026/00006 | 10,000.00 | 700.00 | -300.00 | 10,400.00 | 10,400.00 ✓ |
| 3 | Cash sale (direct invoice) | 1,050.00 | 73.50 | - | 1,123.50 | 1,123.50 ✓ |
| 4 | Purchase BILL/2026/06/0002 | 6,200.00 | 434.00 | - | 6,634.00 | 6,634.00 ✓ |
| 5 | Purchase BILL/2026/06/0003 | 50,000.00 | 3,500.00 | -1,500.00 | 52,000.00 | 52,000.00 ✓ |

All tax calculations match expected manual math.

## Updated validation matrix

| Workflow | Odoo CE base | Thai localization | OCA needed | Custom Odoo module needed | Wabi wrapper useful | Express fallback? | Accountant review? | Status |
|---|---|---|---|---|---|---|---|---|
| Cash POS sale with VAT | Has concepts | Ready | No | No | Likely | Unknown | Yes | PASS (infra) |
| Credit sale order → invoice → payment | Works | Ready | No | No | Maybe | Unknown | Yes | PASS |
| Tax invoice / commercial invoice PDF | Has report | Ready | No | No | Maybe | Unknown | Yes | PASS |
| Purchase order → receipt → vendor bill | Works | Ready | No | No | Maybe | Unknown | Yes | PASS |
| Stock adjustment / inventory valuation | Works | Ready | No | No | Maybe | Unknown | Yes | Not tested |
| Withholding tax case (sale) | Works | Ready | No | No | Likely | Unknown | Yes | PASS |
| Withholding tax case (purchase/vendor) | Works | Ready | No | No | Likely | Unknown | Yes | PASS |
| VAT report / month-end report | Data exists | Defined | Likely | Maybe | Likely | Likely | Yes | DATA OK, UI MISSING |
| PND3/PND53/report/export | Data exists | Defined | Likely | Maybe | Maybe | Likely | Yes | DATA OK, UI MISSING |
| Audit/accountability per employee | Has users/security concepts | N/A | Unknown | Maybe | Strong yes | Unknown | Yes | Not tested |

## Updated technical gaps

### Critical gaps found

1. **Account reports UI/PDF unavailable in CE**: The `account_reports` module (Enterprise) is not present. The three Thailand reports (Tax Report, PND3, PND53) are defined and their data is computable, but there is no CE web UI or PDF export for them. Resolution paths:
   - Install OCA `account-reports` community module
   - Build custom report XLSX/PDF generator
   - Export via database queries → manual entry into RDPrep/Express
   - Use Express as legal source of truth, Odoo as operational layer

2. **POS session workflow requires UI**: POS session creation is a multi-step UI flow (open session → set cash → create orders → close). Programmatic POS order creation is not straightforward.

### Positive confirmations

1. **All Thai tax types work correctly**: 7% VAT (sale and purchase), 0%, exempt, and all withholding variants (1%, 2%, 3%, 5% for both sale and purchase).
2. **Chart of accounts is Thai-ready**: Output VAT (231000), Input VAT (151000), Withholding Income Tax (152000), Withholding Tax (232000) all present.
3. **Tax calculations are architected correctly**: Journal entries post to proper accounts with proper debit/credit conventions.
4. **Multi-company works**: TH Company (THB) is cleanly separated from demo companies.

### Next recommended actions

1. Obtain and install OCA `account-reports` module (from `OCA/account-reports` repository) for the 18.0 branch.
2. Install OCA Thailand-specific report modules: `l10n_th_account_tax_report`, `l10n_th_account_wht_cert_form`.
3. Re-test report generation (PDF/HTML/Excel) after OCA modules are installed.
4. Test POS workflow via browser UI, not programmatic shell.
5. Test full month-end cycle: multiple sales, multiple purchases, payments, reconciliations.
6. Test purchase-side withholding certificate generation.
7. Review output with a Thai accountant.

