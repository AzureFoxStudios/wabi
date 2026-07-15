# Odoo Thailand Build Plan

Goal: Close gaps between Odoo CE + l10n_th and the current Conmat/Express/Excel stack for a Thai construction-material company.

## Phase 1: Quick wins

### 1a. PromptPay QR on invoice PDF
- Files: custom addon overriding `account.report_invoice` and `l10n_th.report_commercial_invoice`
- Logic: EMVCo CRC-16 QR generation from PromptPay ID (phone/tax ID) + amount
- Stamps QR and "ชำระผ่าน PromptPay" on printed invoice
- No external API, no recurring cost

### 1b. Install OCA modules (if available for 18.0)
- `account-reports` — may restore the Tax Report / PND3 / PND53 UI
- `l10n_th_account_tax_report` — Thai-specific report enhancements
- `l10n_th_account_wht_cert_form` — withholding tax certificate PDF
- If available, Phase 3 (CLI report generator) may be partially or fully eliminated

## Phase 2: Counter / sales workflow

### 2a. Partial deposit (เก็บหน้างาน)
- Custom Odoo module `l10n_th_partial_deposit`
- Adds `amount_cash_received` field to `account.move`
- Invoice posts with partial payment reconciled immediately
- Shows "paid / remaining" on printed invoice
- Handles the walk-in customer who puts money down, takes the goods, balance later

### 2b. POS Thai counter tweaks
- Tax-inclusive or tax-exclusive toggle (config already works)
- 4-level pricing if needed (partner-specific price lists exist)
- Customer last-price display (Odoo has this via pricelists + partner history)
- Fast product search for Thai names

## Phase 3: Reports

### 3a. CLI tax report generator
- Standalone Python script (can run in Odoo shell or as standalone with ORM import)
- Reads report definitions from `account.report.line` and `account.report.expression`
- Computes Tax Report, PND3, PND53 for a given month/company
- Outputs:
  - PDF (via WeasyPrint or wkhtmltopdf)
  - XLSX (via openpyxl)
  - Format matches Thai RDPrep-like layout
- Usage: `python3 thai_tax_report.py --company="TH Company" --month=2026-06 --report=pnd53 --format=pdf`

### 3b. (If OCA modules fail) Web report UI
- Minimal web controller to display computed reports in-browser
- Same calculation engine as CLI, wrapped in a simple HTML page

## Phase 4: Contracts & project billing

### 4a. Construction contract model
- `construction.contract`: partner, project name, total amount, retention %, status
- `contract.milestone`: description, amount, target_date, completion_date, state (pending/done/invoiced)
- Milestone done → auto-generate sales invoice with correct VAT/withholding
- Retention tracked as separate receivable line

### 4b. Retention money handling (เงินประกันผลงาน)
- 5-10% held back from each milestone invoice
- Released after defect period (e.g. 6 months post-completion)
- Separate receivable account for retention

## Phase 5: Testing & accountant review

- Full month-end cycle: 20+ sales, 10+ purchases, payments, reconciliations
- Generate all reports via CLI
- Compare against Express output side-by-side
- Have a Thai accountant review:
  - Tax Report (ภ.พ.30 equivalent)
  - PND3 (ภ.ง.ด.3)
  - PND53 (ภ.ง.ด.53)
  - Invoice / Tax Invoice PDF
  - Withholding tax certificate

## Key open questions

1. Are OCA `account-reports` 18.0 modules installable in this container? (Trial in Phase 1)
2. Does the accountant accept the standard `l10n_th` invoice PDF or need custom Thai formatting?
3. Partial deposits: do they need to support partial delivery too (take some goods, leave rest)?
4. Contract milestones: flat fee per milestone or percentage-based?
