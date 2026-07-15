# Thai Construction/Materials Business Tech Standardization Research

Date: 2026-06-14
Status: research framing complete enough to justify Odoo prototype planning; not a production commitment

## Purpose

This document captures the current picture before deeper research. The goal is not to prematurely choose Odoo, Wabi, Linux, or any single accounting package. The goal is to understand a real Thai family business environment and evaluate paths that standardize technology, simplify workflows, protect business data, and make fraud/tampering meaningfully harder.

## Business context as described

- Thai roofing / construction-material company operated by the user's partner's family.
- Current environment appears to include old and inconsistent Windows machines: Windows 7, Windows 10, unlicensed Windows 10, Windows 11.
- The family does not fully understand the security danger of unsupported systems such as Windows 7.
- Existing operational stack includes:
  - Conmat 5.5.x for construction/material-store workflows.
  - Express for Thai tax/accounting workflows.
  - Excel as business glue / shadow database.
  - Line and informal communication as semi-official operational memory.
- They are considering a system referred to as "White ACC" or similar. The shown UI reportedly looked Vista/Windows-7-era. Exact product identity still needs verification.
- Express was confirmed by the user to be specifically for Thai tax/accounting.
- Conmat was confirmed by the user to be specifically for materials/construction-store operations.
- Payment workflow observed/mentioned includes card reader and QR code. No barcode scanner has been observed yet; product pricing may rely on classic sticker labels on boxes/items.

## User's strategic goal

The user wants to help the company:

1. Standardize technology.
2. Simplify workflows.
3. Present better information for bigger business choices.
4. Own and preserve data where possible.
5. Move reception/admin workflows away from unsafe Windows desktops where possible.
6. Keep specialized Windows 11 machines only where genuinely required, e.g. AutoCAD/SketchUp if no practical Linux replacement exists.
7. Give employees individual accounts so actions become attributable.
8. Require approvals for sensitive actions involving money, credit, stock, or business-critical data.
9. Generate reports/evidence if theft or tampering occurs.
10. Separate internal employee communication from Line where practical.
11. Keep local business operations functional during internet outages, at least within one office LAN.
12. Dramatically lower the ease of harm by dishonest employees, malware, ransomware, or careless practices.

## Working threat model

The likely threat is not elite attackers. The likely threats are:

- Unsupported Windows 7 / stale Windows machines exposed to malware/ransomware.
- Shared passwords and shared local/admin accounts.
- Unlicensed or unmanaged software.
- No reliable per-user audit trail.
- Employees able to edit/delete/override sensitive records without approval.
- Excel files acting as mutable shadow databases.
- Line chats acting as unofficial approval/payment memory.
- Weak backup and restore discipline.
- USB/printer/scanner/network exposure.
- Payment evidence based on screenshots or verbal claims rather than reconciled bank/card/QR records.
- Family/business operators unable to quickly prove who changed what.

The practical objective is not perfect security. The objective is to make harmful behavior more work, more visible, and more attributable.

## Current high-level software roles

### Conmat

Likely role:
- Material-store operations.
- Product/stock handling.
- Sales counter workflows.
- Credit customers / receivables.
- Supplier purchasing.
- Returns / stock changes.
- Material price and stock history.

### Express

Likely role:
- Thai accounting/tax workflows.
- Accountant familiarity.
- Statutory/tax reporting.
- Possibly e-Tax/e-Receipt related ecosystem or integrations.

### Excel

Likely role:
- Ad-hoc reports.
- Manual reconciliation.
- Shadow tracking of stock, payments, supplier prices, debts, or special owner reports.

### Line / informal channels

Likely role:
- Internal requests.
- Payment screenshots.
- Price/credit/approval discussions.
- Supplier/customer communication fragments.
- Operational memory that is hard to audit later.

## Candidate modernization directions

### Option A: Conservative modernization

Keep Conmat and Express/Thai accounting package initially. Add better infrastructure, named accounts, backups, Linux reception where possible, Wabi for internal communication/approvals, and a safer Windows 11-only island for legacy apps.

This likely gives the fastest security improvement with lowest workflow disruption.

### Option B: Odoo CE as operational backbone, Thai accounting remains separate

Use self-hosted Odoo CE for products, inventory, purchasing, sales, customers, suppliers, internal workflow/reporting. Keep Express/White ACC/EASY-ACC/other Thai accounting package for official tax/accounting until compliance and accountant acceptance are proven.

Wabi acts as communications, approval, evidence, and dashboard layer.

This is a strong research candidate.

### Option C: Full Odoo replacement

Odoo handles operations and accounting/tax. Wabi handles communication and approval context.

This is architecturally clean but highest risk. It requires proof around Thai tax localization, e-Tax/e-Receipt, accountant acceptance, QR/card reconciliation, POS/counter speed, and migration.

### Option D: Thai accounting/cloud/server package migration

Adopt a Thai package such as White ACC/EASY-ACC/AccCloud/FlowAccount/PEAK/etc. This may improve tax/accounting comfort but may not solve data ownership, LAN operation, Linux reception, or construction-material operations.

## Evaluation dimensions for research

Each candidate should be evaluated by workflow, not by marketing category:

1. Counter sale speed and receipt printing.
2. Cash/card/QR payment recording and reconciliation.
3. Credit customer workflow and credit limits.
4. Product lookup and price correctness without barcode scanner.
5. Optional barcode scanner support if added later.
6. Stock updates, stock counts, and manual stock adjustments.
7. Supplier purchasing and payable tracking.
8. Customer returns/refunds/credit notes.
9. Thai VAT/tax/e-Tax/e-Receipt compliance.
10. Named users and permissions.
11. Audit logs and historical edit/delete protection.
12. Approval gates for sensitive actions.
13. Data ownership, export, backup, and restore.
14. LAN/offline operation during internet outage.
15. Linux/browser usability for reception/admin.
16. Hardware support: receipt printer, cash drawer, card reader, QR payment workflow, scanners if needed.
17. Migration from Conmat/Express/Excel.
18. Vendor lock-in and survivability if subscription/vendor relationship fails.
19. Training burden for older/nontechnical employees.
20. Ability to produce owner-facing exception reports.

## Sensitive actions that should require approval or strong logging

- Refunds.
- Price overrides.
- Customer credit limit changes.
- Selling on credit when overdue/over limit.
- Manual stock adjustments.
- Supplier payment creation or bank detail changes.
- Editing paid invoices or historical receipts.
- Deleting/voiding financial records.
- Changing product cost price.
- Changing tax/accounting settings.
- Creating privileged users.
- Exporting large customer/supplier/product datasets.

## Owner/manager exception reports to research/design

- Sales below minimum margin.
- Frequent refunds by employee/customer.
- Stock adjustments by employee/item/time.
- Cash/card/QR mismatch by shift/day.
- Customer credit exceeded.
- Overdue receivables.
- Deleted/voided invoice attempts.
- Price edited after sale.
- Supplier price jump/outlier.
- Reused payment evidence screenshots.
- Employee login/activity outside normal hours.
- Backup success/failure and last restore test.

## Initial addon finding: Wabi verified-operations-odoo

The existing addon at `addons/source/verified-operations-odoo/` is conceptually aligned with Wabi + Odoo approval/audit ideas, but it is not deployable for real money/credit/stock workflows yet.

Major current issues:

- Backend plugin route shape appears incompatible with Wabi's current `BackendPlugin` type.
- TypeScript check fails with many structural errors.
- Odoo JSON-RPC implementation needs verification/correction.
- Credentials are stored through plugin storage; encryption is claimed in `plugin.json` but not proven in addon code.
- Request bodies supply user IDs and roles instead of deriving actor identity server-side from Wabi auth/session.
- Approval push path accepts client-provided values instead of pushing a frozen approved payload.
- Tamper detection uses a weak non-cryptographic hash despite naming it sha256.
- Audit logs are mutable arrays in plugin storage, not strong append-only records.
- Conflict detection is mostly scaffolded and not wired into the push path.
- Dashboard contains demo/hardcoded metrics.

Conclusion: keep as a prototype concept only. Rebuild in phases if Odoo becomes a serious path.

## Research TODO

1. Identify "White ACC" precisely.
2. Compare Thai accounting candidates: Express, EASY-ACC, AccCloud, FlowAccount, PEAK, and any actual White ACC product.
3. Compare Odoo Community vs Enterprise for accounting, inventory, POS/barcode, approvals, audit logs, Thai localization, e-Tax/e-Receipt, and offline/LAN deployment.
4. Research Odoo Thai localization modules and maintenance quality.
5. Research migration paths from Conmat/Express/Excel.
6. Research Linux reception feasibility with Thai printers/card readers/QR workflows.
7. Research practical security baseline for a small Thai business moving away from Win7.
8. Produce a decision matrix and staged migration proposal.

## Initial research notes: 2026-06-14

### White ACC identity status

Searches for exact strings did **not** identify a clean canonical product called `White ACC`:

- `"White ACC" "โปรแกรมบัญชี"`
- `"WhiteACC" "โปรแกรมบัญชี"`
- `"White Account" "โปรแกรมบัญชี"`
- `"ไวท์" "ACC" "โปรแกรมบัญชี"`

Search results repeatedly surfaced EASY-ACC, AccCloud, FlowAccount, PEAK, and other Thai accounting products. This makes `White ACC` unresolved. It may be:

- EASY-ACC misheard/misremembered.
- A reseller-branded product.
- A Thai accounting product with weak English indexing.
- A cloud/server subscription edition with a legacy Windows-looking client.
- A product that needs direct identification from a screenshot, quotation, installer name, invoice, shortcut icon, or vendor website.

Action item: obtain a screenshot, product URL, invoice/quote, executable name, or vendor contact before treating `White ACC` as a real candidate.

### EASY-ACC findings

Sources checked:

- https://www.businesssoft.com/easyacc
- https://www.easyit2u.com/easy-acc-accounting.html

Findings:

- EASY-ACC is a Thai Windows accounting package from Business Soft.
- It advertises accounting and document workflows: tax invoices, receipts, purchase orders, billing, vouchers, checks, reports, and forms.
- It explicitly mentions transfer of withholding-tax data to RDPrep.
- It advertises e-Tax Invoice support using PDF/A-3u according to Revenue Department requirements, after user registration with the Revenue Department.
- It claims real-time reporting without post-processing.
- It supports PC and LAN multi-machine usage.
- EasyIT2U lists a Network package for 10 simultaneous machines and separate modules for GL, Inventory Control, AP, AR, invoice/sales, and purchases.
- EasyIT2U also describes a USB/Flash Drive installed version of EASY-ACC Accounting System for Windows.

Interpretation:

- EASY-ACC is a serious Thai accounting candidate if the goal is local/accountant-friendly tax handling.
- It remains Windows-oriented, so it may not support the Linux-reception goal unless used only by accounting/back office.
- It may be useful as the official tax/accounting layer while Odoo/Wabi handle operations and internal accountability.

### Express findings

Source checked earlier:

- https://express.co.th/

Findings:

- Express Accounting Version 1 is listed as Windows x86 only and does not support Windows on ARM.
- Express offers Version 2 On Cloud and Express on Cloud.
- Express advertises e-Tax Invoice & e-Receipt integrations and Krungsri Bill Payment integration.
- Pricing is visible for Windows Single/LAN variants.
- Express has a Thai support/training ecosystem.

Interpretation:

- Express is likely hard to beat for Thai accountant comfort.
- It may be acceptable to preserve Express for official tax/accounting while modernizing everything around it.
- Express cloud variants may reduce server burden but conflict with the local-data/LAN-survival goal.

### AccCloud findings

Sources checked:

- https://acccloud.co.th/
- https://acccloud.tech/

Findings:

- AccCloud markets itself as online ERP/accounting for medium-large businesses.
- It advertises accounting, manufacturing/production, construction/service tracking, inventory, purchasing, sales, data analysis, and Excel export.
- It mentions cash, check, credit-card, bank-transfer payment recording.
- It mentions FIFO stock valuation and connected purchase/sales stock flows.
- It mentions API.
- It states costs include one-time implementation/setup and annual service fees.

Interpretation:

- AccCloud may fit Thai ERP/accounting workflows better than raw Odoo CE, especially if they need Thai implementation support.
- It likely weakens the local-first/data-ownership/LAN-offline target unless self-hosted/private deployment exists.
- It should be evaluated as a Thai ERP vendor option, not just an accounting app.

### FlowAccount findings

Source checked:

- https://flowaccount.com/en

Findings:

- FlowAccount is cloud accounting for small businesses/SMEs.
- It advertises tax invoices and withholding-tax documents as Revenue Department-compliant.
- Paid tiers include e-Tax Invoice by Time Stamp, VAT and withholding tax submission support, inventory management, purchase orders, partial payments/deposits/delivery goods, KBank dynamic QR scanning, API, and product barcode scanning through mobile camera.

Interpretation:

- FlowAccount is attractive for Thai SME cloud accounting and QR/payment workflows.
- It likely does not satisfy local LAN/offline ownership goals.
- It may be a good benchmark for expected Thai accounting/payment UX even if not chosen.

### PEAK findings

Source checked:

- https://peakaccount.com/

Findings:

- PEAK is 100% cloud accounting for SMEs.
- It advertises stock/profit tracking, purchase/sale history, customer price memory, credit limits and credit terms, tax invoices, receipts, e-Tax Invoice/e-Receipt, API, bank reconciliation, QR Code payment support, payroll/tax/social-security workflows, and security features such as 2FA/PIN/permission limits/Microsoft Azure cloud backup.

Interpretation:

- PEAK overlaps heavily with the desired accounting/reporting/payment features.
- It is cloud-first, so it conflicts with local LAN resilience and local data ownership.
- It is worth comparing against Odoo/Express/EASY-ACC because it shows what Thai modern accounting vendors consider table stakes.

### Odoo CE / Enterprise findings

Sources checked:

- https://www.odoo.com/page/editions
- https://www.odoo.com/documentation/19.0/applications/finance/accounting.html
- https://github.com/OCA/l10n-thailand

Odoo edition table parsed from the official Odoo editions page:

| Feature | Community | Enterprise |
| --- | --- | --- |
| Desktop web browser | yes | yes |
| Mobile Android/iOS app | no | yes |
| Accounting | no | yes |
| Comprehensive accounting | no | yes |
| Invoicing | yes | yes |
| Payments | yes | yes |
| Documents | no | yes |
| Point of Sale | yes | yes |
| Inventory | yes | yes |
| Barcode | no | yes |
| Manufacturing (MRP) | yes | yes |
| Shopfloor/control panel/scheduling | no | yes |
| Purchase | yes | yes |
| Discuss | yes | yes |
| Approvals | no | yes |
| Spreadsheet | no | yes |

Odoo accounting documentation says Odoo Accounting includes double-entry bookkeeping, receivables/payables, bank/cash accounts, reporting, VAT/taxes, accounting reports, inventory valuation, and fiscal localization concepts. However, the official edition page places Accounting and Comprehensive Accounting in Enterprise, while Community has Invoicing.

OCA Thai localization repository exists and includes modules such as:

- Thai Localization - VAT and Withholding Tax
- Thai Localization - VAT and Withholding Tax Reports
- Thai Localization - Withholding Tax Certificate Form
- Thai Localization - Assets Management
- Thai amount text conversion
- Thai partner/base sequence/MIS/tier-department modules

Interpretation:

- Odoo CE looks strong for operational backbone pieces: web, POS, inventory, MRP, purchase, sales/invoicing, Discuss.
- Odoo CE does **not** appear to include official full Accounting, Barcode, Approvals, Documents, Spreadsheet, or mobile app per the official editions page.
- A CE-only plan must either avoid those features, replace them with OCA/community modules/custom Wabi features, or accept Enterprise/paid modules.
- OCA Thai localization is promising but requires practical validation with a Thai accountant and the exact Odoo version chosen.
- Odoo CE should not be assumed to replace Express/EASY-ACC for official Thai tax/accounting without a specific localization/accountant proof.

Additional Odoo Thailand research:

- Official Odoo 19 Thailand localization docs exist at https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/thailand.html.
- Odoo's Thailand fiscal package lists `l10n_th` and `l10n_th_reports`.
- It includes VAT 7%, VAT-exempted, withholding tax, withholding income tax, tax reports, VAT Excel exports for Revenue Department submission, PND3/PND53 CSV export for RDPrep, tax invoice PDF behavior, headquarter/branch number handling, and PromptPay QR code on invoices.
- Important warning from Odoo docs: Odoo cannot directly generate the PND/PDF report or withholding tax certificate; the PND3/PND53 CSV files must be exported to an external tool to convert them into withholding PND/PDF output.
- OCA module `l10n_th_account_tax` is maintained under OCA/l10n-thailand, authored by Ecosoft, AGPL-3, and targets Thai VAT and withholding tax behavior including tax invoice number/date handling and withholding/PIT configuration.
- OCA module `l10n_th_account_tax_report` provides Thai TAX Report views/exports and is also authored by Ecosoft / maintained by OCA.

Interpretation update:

- Yes, smart Thai/Odoo people have already built Thai localization pieces.
- Odoo is pluginable through Odoo addons/modules, and Thai accounting/tax extensions already exist.
- The correct place for tax/accounting logic is Odoo's ledger/module layer, not Wabi. Wabi can add approval, chat, evidence, and exception-report UX around Odoo records, but should not become the statutory accounting engine.
- The remaining question is not "can it be coded?" but "which Odoo edition/version + which official/OCA modules cover the exact statutory outputs the accountant needs, and what gaps remain?"

CE legality feasibility note:

- Odoo CE source includes the `account` addon, but its manifest labels it `Invoicing`, not full Enterprise `Accounting`. The manifest describes it as simplified accounting/invoicing for tracking invoices, vendors, customers, and payments, especially when an external accountant keeps the books.
- Official edition marketing separates `Invoicing` (Community yes) from `Accounting` / `Comprehensive Accounting` (Enterprise yes, Community no). This means CE has accounting primitives but not the full official accounting product surface.
- OCA Thai modules such as `l10n_th_account_tax` depend on `account`, so they are designed to extend that accounting/invoicing layer and are installable Odoo addons, but their manifests mark development status as `Beta` in the checked 18.0 branch.
- OCA 18.0 `l10n_th_account_tax_report` includes report templates for PND1, PND1A, PND2, PND3, PND53, tax reports, XLSX helper dependencies, and Thai withholding/VAT reports. This suggests CE + OCA may cover more legal output than the earlier official-doc warning alone implied.
- Therefore, do **not** assume legal/tax cannot be done in CE. Treat it as unproven-but-plausible pending a hands-on Odoo CE + OCA Thailand proof-of-concept and accountant review.

### Early comparison insight

The strongest research path is not "Odoo vs Thai software" as a binary choice. The stronger path is layered:

1. Thai accounting/tax layer: Express, EASY-ACC, PEAK, FlowAccount, AccCloud, or Odoo Enterprise/OCA if proven.
2. Material operations layer: Conmat, Odoo inventory/POS/purchase/sales, AccCloud ERP, or another vertical package.
3. Communications/accountability layer: Wabi.
4. Infrastructure/security layer: Linux reception where possible, clean Windows 11 where required, server/NAS/backups/network segmentation/named accounts.

This allows modernization without betting the family business on one risky migration.

## Prototype transition

A dedicated prototype plan has been created:

- `docs/research/odoo-thailand-prototype-plan.md`

Current working assumption: Odoo is the leading candidate for hands-on prototyping as the operational backbone. This is not a production commitment and does not yet prove Thai legal/tax replacement. The prototype should use fake data to test Odoo CE + Thailand localization + OCA Thailand modules against construction-material workflows, Thai tax/accounting outputs, security/accountability needs, and Wabi integration opportunities.

If access to real Express/Conmat machines is later organized, inspect them non-destructively and separately from the Odoo prototype. Use built-in exports/backups/copies only, never live mutation.

## Non-goals for now

- No commitment to Odoo.
- No commitment to replacing Express.
- No commitment to replacing Conmat.
- No implementation work in Wabi addon yet.
- No migration until workflows and compliance are proven.
