# 08 — Certification, registration and what they would take

Date: 2026-09-29. **Sabi is not certified, registered or approved by the Thai Revenue Department (RD), ETDA, depa or any auditor.** Nothing in the software or its documents may say it is. This page explains which approvals exist in Thailand, which apply to software like Sabi, and how Sabi measures against the one standard that matters most. It is a research summary, not legal advice. Confirm with a Thai tax adviser or the Area Revenue Office before relying on it.

## 1. Short answer

- **Thailand has no general licence or certificate for accounting/ERP software.** Nobody has to certify an invoicing program before a business may use it.
- **There is one standard that bites:** a VAT-registered business that keeps its statutory **VAT reports** (รายงานภาษีขาย, รายงานภาษีซื้อ, รายงานสินค้าและวัตถุดิบ, under ม.87 of the Revenue Code) **by computer** must use software that meets the RD's *software standard for revenue purposes* (มาตรฐานซอฟต์แวร์เพื่อภาษีสรรพากร), types ก–ง. Software written by a third party and supplied to others is expected to come from a **registered Software House** (ผู้ผลิตซอฟต์แวร์ที่ขึ้นทะเบียน) and to show its registration on the first screen.
- The RD has ruled that keeping the ม.87 reports with software that does **not** meet the standard does **not comply** with ม.87. That is an offence under ม.90(15) (ruling กค 0702/พ./1371, 2014).
- Everything else (e-Tax Invoice, e-Tax Service Provider, depa's digital-catalogue incentive, auditors' sign-off) is **voluntary**, or it applies to the business rather than the software.

**What this means for a Sabi user today:** use Sabi for operations, documents and books. Until a registration route exists (section 3), have the statutory VAT reports kept in the form your accountant already uses: RD-standard software, or reports prepared by the accountant from Sabi's CSV exports. Sabi's own VAT reports are working reports. Ask the Area Revenue Office how this applies to your business.

## 2. The approvals that exist

| What | Who issues it | Applies to | Mandatory? | Relevant to Sabi |
|---|---|---|---|---|
| **Software House registration** + software number (ล.ซ.1 to register, ล.ซ.2 to report sales) | RD, Area Revenue Office of the producer's head office. Legal basis: RD Order ท.378/2543 as amended, incl. ท.643/2556 | Producers who "sell" software for keeping the ม.87 reports. "Sell" includes giving it away, with or without payment, and supplying group companies. Resellers need their own registration | Needed for a producer's software to count as standard software for ม.87 | **Yes. This is the route (section 3).** |
| **Software standard types ก/ข/ค/ง** | RD VAT Director-General Notification No. 89 (1999), as amended incl. No. 202; clauses 10–14 | The software a VAT operator uses for the ม.87 reports | Yes, if the reports are kept by computer | **Yes. Conformance table in section 4.** |
| **e-Tax Invoice & e-Receipt** (XML to ETDA standard + digital signature; form บอ.01) | RD | Businesses that choose to issue tax invoices electronically | Voluntary | Future Thai-adapter integration |
| **e-Tax Invoice by Email** (PDF + ETDA timestamp; ≤ 30 M THB turnover; form กอ.01) | RD / ETDA | Small businesses | Voluntary | Future integration; smaller step |
| **e-Tax Service Provider** | RD, needs ≥ 50 M THB paid-up capital and certification to ขมธอ.21-2562 | Companies that sign and send e-tax invoices for others | Voluntary | **Out of reach for a FOSS project.** Sabi would integrate with a provider instead. |
| **depa dSURE / Thailand Digital Catalog** | depa | Products listed in the catalogue; buyers may deduct 200 % of the cost (cap 300,000 THB) until 31 Dec 2027 | Voluntary | Possible for a company that sells Sabi hosting or support |
| Accounting standard (TFRS for NPAEs), registered accountant, CPA audit, ภ.พ.06 VAT books | Federation of Accounting Professions / DBD / RD | The **business** and its accountant | Yes, for the business | Sabi's books help; they do not replace the accountant or auditor |

## 3. What registration would take (Software House route)

Only a **legal entity that produces and supplies** the software can register. A GitHub project cannot. For Sabi this could be a Thai company that packages, supports or hosts a specific Sabi release.

1. **Register the producer:** file ล.ซ.1 at the Area Revenue Office of the company's head office, with company documents and a description of the software and the standard type claimed (ก, ข, ค or ง).
2. **The RD examines the software** against clauses 10–14 (section 4). Expect to demonstrate the flowchart screen, the access screen, the password controls, the corrections report and the posting of every sale to the GL.
3. **Show the registration on the first screen** in the prescribed words, for example: "ซอฟต์แวร์นี้เขียนขึ้นโดย … ซึ่งมีเลขประจำตัวซอฟต์แวร์เฮ้าส์เลขที่ … เป็นซอฟต์แวร์เลขที่ … และเป็นซอฟต์แวร์ตามมาตรฐานซอฟต์แวร์เพื่อภาษีสรรพากรของกรมสรรพากรชนิด …". Sabi already has the mechanism: **Settings → Integrations → Sign-in notice** shows owner-set text on the sign-in screen. **Do not enter a statement you do not hold.**
4. **Report every installation or sale** with ล.ซ.2.
5. **A business writing its own software** for itself has a separate first-screen wording ("ซอฟต์แวร์นี้เขียนขึ้นโดย … และเป็นซอฟต์แวร์ตามมาตรฐาน…ชนิด…"). Confirm with the Area Revenue Office whether self-hosting an unmodified open-source release qualifies. The rules do not address it, and a foreign product's reseller may not borrow another firm's registration.

**Type to aim for:** type **ข** (standard ก plus sales and stock computerised and posting directly to the GL) fits Sabi's design. Type ค (all subsystems) would need payroll and fixed assets. Type ง adds lodging a password with the RD in a sealed envelope.

### The open-source question (risk)

An unofficial forum claim says registered producers must not hand out source code. **This is not in the official texts reviewed** (Notification 89/202, ท.378/2543 as amended, ท.643/2556). The standard's concern is that *users* cannot make traceless edits (cl. 12(ข)). Sabi addresses that with an append-only, hash-chained journal (`sabi verify`), not by hiding code. Anyone with file access can rebuild a database, and **that is equally true of closed software.** Still, the RD may take a different view of software whose users can modify it. A registering company should:

- register a **specific, signed release** (commit hash) and show it in the application;
- state in its application that modified builds are not the registered software;
- ask the RD in writing before relying on registration.

## 4. Conformance with the standard (clauses 12–14, Notification 89 as amended)

Status: **Meets** = implemented and tested in this repository; **Partial** = implemented but short of the text; **Gap** = not implemented. This is a self-assessment. Only the RD can decide whether Sabi conforms.

### Clause 10 — the base requirements (type ก)
| Requirement | Sabi | Status |
|---|---|---|
| (1) No traceless edits after posting to the GL; corrections by adjusting entries | The journal is append-only (SQLite triggers) and hash-chained. Issued documents cannot be edited. Corrections are credit/debit notes, voids with reversal, or reversing entries (ADR-11) | Meets |
| (2) Prevents tax evasion | See cl. 13 | Partial |
| (3) Security, access control | Per-user sign-in, scrypt passwords, roles with capabilities, login throttling | Meets |
| (4) Double entry | Every posting balances, which is tested; there is a trial balance and a GL per account | Meets |
| (5) Sales and stock computerised, posting directly to the GL (type ข) | Invoices, bills, payments, notes and retention post automatically. Stock moves come from delivery, receipt, note and adjustment documents | Meets for sales, purchases and stock. Payroll and fixed assets are absent (needed for type ค) |

### Clause 12 — ledger and adjustments
| Requirement | Sabi | Status |
|---|---|---|
| (ก) Post to the GL and print GL reports | Books → General ledger (any account and period, opening and running balance, CSV, print); Reports → Trial balance | Meets |
| (ข) No deleting; adjusting entries showing before and after | Nothing is deleted. Credit/debit notes print the original value, correct value and difference. Reversals reference the entry reversed | Meets |
| (ค) Automatic adjustment report with doc ref, date, **time**, user id, count and amount | Books → Corrections report: time, user name and username, kind, reference, amount, reason, and a count and total per kind | Meets |
| (ง) The adjustment report cannot be hidden | It is derived from the journal on every request, with no switch to disable it | Meets |

### Clause 13 — processing controls
| Requirement | Sabi | Status |
|---|---|---|
| (ก) Follows the Revenue Code | Thai adapter: tax invoice content (ม.86/4), notes (ม.86/9, 86/10), WHT categories, 50 ทวิ, branch codes, tax-ID checksum | Partial: working reports are not in RD filing formats |
| (ข) No processing contrary to reality (e.g. the same item sometimes VAT-able, sometimes not) | The tax code belongs to the item. With the pack option `taxCodeFromItem` (on in the sheet-metal pack), item lines always carry the item's code, enforced on the server and read-only in the editor (tested). Free-text lines still choose a code | Meets for catalogue items |
| (ค) Control totals during processing | Document totals are recomputed on the server. VAT reports carry totals. Payments must allocate exactly amount + WHT | Meets |
| (ง) Record counts reconcile with imported counts | Import is all-or-nothing and returns the created count. `sabi verify` compares a replay against the stored projections | Meets |
| (จ) Sub-statement and branch detail | Counterparty branch is on every VAT row. **The seller has a single branch** | Partial: multi-branch sellers are not supported |
| (ฉ) A sale cannot post without VAT at the same time | Issue posts revenue and output VAT in one entry, in one transaction | Meets |
| (ช) Add-back items report their source | Every GL line links to its source document or payment; notes reference the invoice they correct | Meets |

### Clause 14 — system and access controls
| Requirement | Sabi | Status |
|---|---|---|
| (ก) Display a system flowchart | Settings → Controls & audit → "How data flows" | Meets |
| (ข) Screen showing the number and level of staff who can record, read or edit | Settings → Controls & audit → "Who can do what": each role's capabilities, with the people and head count | Meets |
| (ค) Password control, with a separate password for editors | Sign-in password per user plus the **corrections password** for voids, reversals and manual entries | Meets |
| (ง) Log of password use (user id, task, date, time); for edits: user id, count, detail | `auth_log`: sign-ins, failed sign-ins, each use of the corrections password with what it was for, and password changes; shown under Controls & audit. Edits are itemised in the corrections report | Meets |
| (จ) Every decryption logged | Sabi does not encrypt data at rest, so there is nothing to decrypt. **Encryption at rest is not implemented** | N/A / Gap if the RD expects encryption |

### Other ม.87 report rules (Notification 89)
| Rule | Sabi | Status |
|---|---|---|
| cl. 2/2–2/3: sales and purchase reports show the counterparty tax ID and HQ/branch, including for notes | Yes, on every row | Meets |
| cl. 8(7): received CN/DN entered within 3 business days | Supplier credits can be recorded; there is no deadline check | Partial |
| cl. 9: stock report per movement, with vouchers, by type and size, within 3 business days | Item stock card with every movement, voucher reference and running balance, per item and location. **There is no printed ม.87 stock report layout (qty and value by day)** | Partial |

## 5. What is still needed before anyone applies

1. The ม.87 **stock and raw-material report** layout with quantities and values (cl. 9), and the sales and purchase tax reports in the RD's printed layout (the current screens carry the required columns).
2. Multi-branch sellers (cl. 13(จ)), if the business has branches.
3. A signed-release build that shows its version and commit on the first screen.
4. A written enquiry to the RD on open-source distribution (section 3).
5. A registering Thai company willing to support that release.

## Sources

- RD, VAT Director-General Notification No. 89 (1999), as amended incl. No. 202, clauses 2/2–14: <https://www.rd.go.th/3374.html>
- RD, Software House registration and standard software (ท.378/2543 as amended; ท.643/2556; registry): <https://www.rd.go.th/314.html>, <https://www.rd.go.th/5993.html>, <https://www.rd.go.th/27996.html>
- RD ruling กค 0702/พ./1371 (2014) on non-standard software for the ม.87 reports: <https://www.rd.go.th/52536.html>
- No licensing regime for billing software in Thailand (law-firm summary): thelegal.co.th
- e-Tax Invoice & e-Receipt, e-Tax by Email, Service Provider criteria: rd.go.th e-Tax pages
- depa Thailand Digital Catalog / 200 % deduction: <https://www.depa.or.th/th/tax200>
