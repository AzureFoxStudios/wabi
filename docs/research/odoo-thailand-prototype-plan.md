# Odoo Thailand Prototype Plan

Date: 2026-06-14
Status: proposed next phase after desk research

## Decision framing

Current research suggests Odoo is the leading candidate for the company's operational standardization layer. This does **not** mean Odoo is already proven as the final legal/tax/accounting replacement. It means Odoo is strong enough to justify a hands-on prototype before spending more time on generic research.

The prototype goal is to answer concrete questions with real software behavior:

- Can Odoo CE + Thailand localization + OCA Thailand modules handle the company's day-to-day operations?
- Can it produce or export the legal/tax/accounting outputs the company/accountant needs?
- Which parts require custom Odoo modules?
- Which parts are better handled by Wabi as approval/chat/evidence workflow?
- Which parts should remain in Express/EASY-ACC/another Thai accounting package as fallback?

## Working hypothesis

Odoo should be treated as the likely operational backbone:

- products
- inventory
- purchases
- sales
- POS/counter workflows
- customers/vendors
- credit customer visibility
- invoicing/payment records
- Thai localization proof

Wabi should be treated as the accountability/communications layer:

- employee chat separate from Line
- approval requests
- evidence/photos/payment context
- alerts and exception reports
- incident/audit bundles linked to Odoo records

Express/EASY-ACC/other Thai accounting software should be treated as fallback/legal comparator until Odoo CE/OCA is proven:

- official tax reports
- accountant month-end/year-end outputs
- e-Tax/e-Receipt if Odoo path is incomplete
- RDPrep/Revenue Department workflow

## Prototype scope

Use fake data only. Do not connect to the real company yet.

### Fake company profile

- Thai construction/roofing/material supplier.
- One office/branch initially.
- Reception/counter staff use browser.
- Manager/owner approves sensitive actions.
- Accountant needs monthly Thai tax/accounting outputs.

### Fake products

Create representative products:

- roof sheet SKU variants
- cement bag
- screws/fasteners
- insulation
- steel/metal pieces
- flashing
- paint/sealant
- tile/roof accessories
- service/labor line
- delivery/transport line

Include:

- sale price
- cost price
- stock quantity
- unit of measure where useful
- product categories
- at least one low-stock item
- at least one deadstock-style item

### Fake customers

Create:

- walk-in cash customer
- normal named customer
- contractor on credit
- overdue credit customer
- company customer with Thai tax ID
- branch/headquarter test customer if supported

### Fake suppliers

Create:

- material supplier
- roofing supplier
- service vendor subject to withholding tax
- transportation/delivery vendor

## Workflows to test

### Operations

1. Cash sale at counter.
2. QR payment sale.
3. Card payment sale.
4. Credit sale to contractor.
5. Credit customer exceeds limit or has overdue balance.
6. Customer payment against receivable.
7. Purchase order to supplier.
8. Receive goods into stock.
9. Supplier bill.
10. Return/refund/credit note.
11. Manual stock adjustment.
12. Price override / discount case.
13. Low-stock reorder point behavior.
14. Daily sales summary.
15. Cash/card/QR reconciliation workflow.

### Thai legal/tax/accounting outputs

1. Tax invoice PDF.
2. Sales VAT report.
3. Purchase VAT report.
4. VAT Excel export for Revenue Department if available.
5. PND3 case.
6. PND53 case.
7. Withholding tax certificate/report.
8. RDPrep-compatible export.
9. PromptPay QR invoice/payment test.
10. Branch/headquarter printed fields.
11. Customer/vendor Thai tax ID handling.
12. Month-end accountant export package.

### Security/accountability

1. Named employee users.
2. Cashier cannot see/modify cost price if possible.
3. Cashier cannot delete posted invoices if possible.
4. Stock adjustment permission separation.
5. Refund/credit note approval requirement or gap.
6. Credit limit/overdue warning or gap.
7. Audit trail visibility.
8. Export/admin permissions.
9. Backup/restore procedure.

## Odoo version strategy

Start with Odoo 18 CE unless a later check proves Odoo 19 is clearly better for this prototype.

Reason:

- OCA/l10n-thailand has visible 18.0 branch support.
- OCA 18.0 modules include Thai VAT/withholding and tax reports.
- Odoo 19 official docs are current, but OCA compatibility may lag or differ.

If Odoo 18 works, later research can test Odoo 19 separately.

## Modules to investigate/install

Core / official:

- base Odoo CE
- Invoicing/account base
- Sales
- Purchase
- Inventory
- Point of Sale
- Thailand localization (`l10n_th`)
- any available official Thailand report modules for chosen version

OCA / community:

- OCA/l10n-thailand repository for chosen version
- `l10n_th_account_tax`
- `l10n_th_account_tax_report`
- `l10n_th_account_wht_cert_form` if available for chosen version
- `l10n_th_partner`
- `l10n_th_base_sequence`
- `l10n_th_base_utils`
- required dependencies listed by manifests

Possible supporting OCA dependencies:

- date range
- report_xlsx_helper
- account financial reporting modules if needed

## Evidence to capture

For each workflow/output:

- screenshots of relevant screens
- generated PDFs/XLSX/CSV files
- notes on exact menu path
- whether the workflow required Enterprise-only features
- whether the workflow required OCA modules
- whether output looked accountant-ready or only intermediate
- errors/blockers
- custom work needed

## Decision matrix format

Use this table shape in the final prototype report:

| Workflow/output | Works in CE? | OCA needed? | Custom Odoo needed? | Wabi useful? | Express fallback? | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Cash sale | TBD | TBD | TBD | TBD | TBD | TBD |
| QR sale | TBD | TBD | TBD | TBD | TBD | TBD |
| Credit customer | TBD | TBD | TBD | TBD | TBD | TBD |
| VAT sales report | TBD | TBD | TBD | TBD | TBD | TBD |
| PND53 | TBD | TBD | TBD | TBD | TBD | TBD |
| Withholding certificate | TBD | TBD | TBD | TBD | TBD | TBD |
| Stock valuation | TBD | TBD | TBD | TBD | TBD | TBD |
| Refund approval | TBD | TBD | TBD | TBD | TBD | TBD |

## Non-destructive inspection plan for current Express/Conmat machine

If access to a real company machine is organized, keep it separate from the prototype.

Rules:

1. Get explicit owner/family permission.
2. Do not modify live business records.
3. Do not install tools on the business machine without approval.
4. First document versions, paths, backup/export options, and workflows.
5. Prefer built-in export/report tools.
6. If copying raw data, close the app first and copy to external/test machine.
7. Analyze copies, never live files.
8. Keep an action log.
9. Do not run repair/upgrade/compact/migration tools on production.
10. Do not bypass passwords or licensing.

Information to gather:

- product exports
- customer/vendor exports
- sales/purchase report exports
- debtor/creditor reports
- tax report examples
- stock valuation/count reports
- backup location and format
- database/file location if visible
- installed version/license/server layout
- daily/monthly workflows actually used

## Prototype success criteria

A prototype is successful if it answers:

1. Can Odoo CE + Thai modules run the operational workflow better than the current stack?
2. Can Odoo CE + Thai modules satisfy legal/tax outputs directly?
3. If not directly, are missing outputs rare/simple enough for Express/EASY-ACC fallback?
4. Which Wabi integrations would materially reduce fraud/tampering/Line chaos?
5. What exact gaps remain before real business pilot?

## Prototype non-goals

- No real company data.
- No production deployment.
- No promise to replace Express/Conmat yet.
- No Wabi addon rewrite yet.
- No official legal/tax conclusion without accountant review.
- No migration/import into real systems.
