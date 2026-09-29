# 09 · Plain language and page layout

Sabi is used by people who are not "computer people": the owner of a metal-sheet shop, the workshop lead, the person who answers the phone. Many read only Thai, and many have never used business software. The goal is that anyone can open any screen and think **"Ohhh, I get it."**

This page lists the rules the UI follows. It also explains how to keep new screens, and new business packs, in line with them.

## 1. Rules

1. **Every page and every block says what it is for, in one sentence.** Under each page title there is a `.hint` line. Under each section heading there is another one that says what the section is and what to do with it. Example: "Someone on the team needs you to check these before they can continue. Open each one and choose Approve or Reject."
2. **Names first, codes after.** People recognise "Factory wall cladding, Rojana" and "Somsak Hardware", not `J2026-0002` or `IV2026-0001`.
   - Reference numbers are shown with the `.ref` class: small, grey, after the name.
   - Activity lines and "where did this happen" labels use names only. The server's `subjectLabel()` returns job titles, "document type · customer", and so on.
3. **Say it as a sentence, not a label.**
   - "We need 360 m but are short by 240 m. 300 are already ordered from the supplier — that will be enough." replaces "Short 240 · on order 300 (covers it)".
   - "No progress for 4 days" replaces "idle 4 days".
4. **Buttons say what will happen, starting with a verb.**
   - "Make a Sales order from this" replaces "→ Sales order".
   - "The customer paid — record it" replaces "Record payment".
   - "Yes, approve" / "No, send it back" replace "Approve" / "Reject".
5. **Explain why a button is disabled, right under it.** "You can't press this yet. First: …" Automatic steps say "No button needed: this moves to 'Accepted' by itself as soon as you do this — …".
6. **No accounting or tax jargon outside the accounting pages** (see the glossary). Official tax names such as ภ.พ.30, ภ.ง.ด.53 and 50 ทวิ are kept, because accountants and the Revenue Department use them. They always come with a plain explanation.
7. **Full money amounts.** Show ฿163,020, never ฿163.0k. `moneyShort()` rounds to whole baht but never abbreviates.
8. **Negative numbers become words.** Show "240 short" / "ขาด 240" instead of "−240". A negative VAT balance says "we paid more than we charged — nothing to pay, carried to next month".
9. **People are shown by name.** `@arun` in a message shows as **@Arun Wongsa**; a role mention shows the role's name (`mentionHtml()` in `lib/format.ts`). Roles show their label ("Manager"), never their id.
10. **Pages that most people never need say so.** The accounting page opens with "Not an accountant? You don't need this page."

## 2. Type and spacing

| Setting | Before | Now | Why |
|---|---|---|---|
| Font | IBM Plex Sans Thai (loopless) | **IBM Plex Sans Thai Looped** | Thai letters with loops (ตัวมีหัว) are what most Thai readers learned at school and read fastest. The loopless style looks modern but is harder for many people. The looped font also covers Latin, so English uses the same family. Printed documents keep **Sarabun**, the government-standard looped font. |
| Body size | 15px | **16px** | |
| Line height | 1.5 | **1.6** (EN), **1.7** (TH) | Thai stacks vowels and tone marks above and below the line. |
| Grey text | `#6d736f` / `#9aa09b` | `#545b57` / `#7a807c` | The old greys were too faint on the beige background. |
| Small text | 0.85rem / 0.76rem | 0.9rem / 0.82rem | |
| Section labels | tiny UPPERCASE | normal sentence case, darker | Uppercase doesn't exist in Thai, and small caps are hard to read. |
| Buttons / inputs | 34px | 38–40px tall | Easier to hit, and easier for older eyes. |
| Sections | 18px padding, light rule | 26px padding, stronger rule | Blocks are clearly separate. |

The progress bar shows numbered steps. Finished steps get ✓ and the current step is highlighted, so "where is this job?" can be answered at a glance.

## 3. Navigation

The menu is grouped into three plain questions:

- **Daily work:** Today — what needs me · Jobs · Quotes, orders & invoices
- **Lists:** Customers & suppliers · Products & stock
- **Money & tax:** Money in & out · Tax & reports · Accounting (for the accountant)

## 4. Glossary: words we replaced

| Was (TH) | Now (TH) | Was (EN) | Now (EN) |
|---|---|---|---|
| ลูกหนี้ | ลูกค้าที่ยังค้างจ่ายเรา | Receivables | Customers who still owe us |
| เจ้าหนี้ | ผู้ขายที่เรายังต้องจ่าย | Payables | Suppliers we still have to pay |
| 1-30 วัน (aging) | เลยมา 1–30 วัน | 1-30 days | 1–30 days late |
| VAT เดือนนี้ (ขาย − ซื้อ) | VAT ที่ต้องจ่ายสรรพากรเดือนนี้ / ซื้อมากกว่าขาย ไม่ต้องจ่าย ยกไปเดือนหน้า | VAT this month (output − input) | VAT to pay the Revenue Dept. this month |
| ตัดชำระ | จ่ายครั้งนี้ / จ่ายบิลใบไหน | Settle / Settles | Paying now / For which bills |
| หัก ณ ที่จ่าย (column) | ภาษีที่หักไว้ | WHT | Tax kept back |
| คงเหลือ / จองแล้ว / กำลังเข้า / ใช้ได้ | มีในคลัง / จองให้งานแล้ว / สั่งแล้ว กำลังมา / ว่างให้ใช้ | On hand / Reserved / Incoming / Available | In stock / Promised to jobs / Ordered, on the way / Free to use |
| ต่ำกว่าจุดสั่งซื้อ | ใกล้หมด — ควรมีอย่างน้อย … | Below reorder point | Running low — keep at least … |
| ติดขัด/มีความเสี่ยง | ปัญหาที่ต้องแก้ | Blocked or at risk | Problems to sort out |
| ผู้รับผิดชอบขั้นนี้ | ถึงตาใคร | Owner of this step | Whose turn |
| ไม่ขยับ 4 วัน | ไม่มีความคืบหน้ามา 4 วัน | idle 4 days | No progress for 4 days |
| → ใบสั่งขาย | ทำ ใบสั่งขาย จากใบนี้ | → Sales order | Make a Sales order from this |
| จะเปลี่ยนเป็น … อัตโนมัติเมื่อ: ต้องมี ใบสั่งขาย ที่ออกแล้ว | ไม่ต้องกดปุ่ม: จะเลื่อนไปขั้น "…" ให้เอง เมื่อทำสิ่งนี้เสร็จ — ต้องออกใบสั่งขายก่อน | Moves to … automatically when: Needs Sales order issued | No button needed: this moves to "…" by itself as soon as you do this — First make and issue a Sales order |
| เก็บเข้าคลัง (archive — a mistranslation) | เลิกใช้ (ซ่อน) | Archive | Stop using (hide) |
| ปรับยอดสต็อก | แก้ยอดของในคลัง | Adjust stock | Correct the stock |
| เงินประกันผลงานถูกหัก | เงินประกันผลงานที่ลูกค้าหักไว้จนกว่าจะรับงาน | Retention held | Guarantee money the customer holds back until the work is accepted |
| ไม่รวม VAT / รวม VAT | ยังไม่รวม VAT (บวกเพิ่ม 7%) / รวม VAT แล้ว | Excl. / Incl. VAT | do not include VAT (add 7% on top) / already include VAT |
| VAT7 / EXEMPT (tax codes) | 7% / ไม่มี VAT (ยกเว้น) | VAT7 / EXEMPT | 7% / No VAT (exempt) |
| jobs.write · money.write (role rights) | เปิดและแก้ไขงาน, บันทึกรับ–จ่ายเงิน | jobs.write · money.write | open and update jobs, record money in and out |
| reserve, stock_out (document effects) | จองของในคลัง, ตัดของออกจากคลัง | reserve, stock_out | reserves stock, takes goods out of stock |
| ระงับ (user) | ปิดการเข้าระบบ (ลาออกแล้ว) | Deactivate | Block login (left the company) |
| เวิร์กสเปซ | ระบบของบริษัท | workspace | (avoided) |
| Void | ยกเลิก (…ขีดฆ่า ยังเก็บไว้) | Void | Cancel (the record stays, marked cancelled) |

## 5. For business-pack authors

Words that belong to a business live in the pack, not the core. A pack should give:

- `DocTypeDef.description` and `JobTypeDef.description`: one plain sentence about what the paper or job is. It is shown under the document title and in *Settings → How this business is set up*. Example for a quotation: "A price offer for the customer. It is not a sale yet — nothing is reserved or billed until the customer agrees."
- `state.hint`: what to do while a job or document is in this state ("Waiting for the customer to decide.").
- Transition labels written as actions people say out loud ("Customer accepted", "Start cutting"). Avoid system verbs such as "Post" or "Commit".

## 6. Checklist for a new screen

- [ ] A title plus a one-sentence `.hint` saying what the page is for.
- [ ] Every section has a heading plus a hint saying what to do there.
- [ ] Names before codes; codes use `.ref`.
- [ ] Buttons start with a verb and say the result.
- [ ] An empty state that says what to do next ("No jobs here. Press 'New job' when a customer calls…").
- [ ] No uppercase labels, no abbreviations (k, M, WHT, AR/AP, PO) in Thai text, no negative numbers shown raw.
- [ ] Checked in Thai at 1440px and at a narrow width.
