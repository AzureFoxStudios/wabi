import type {
  Document, DocTypeDef, FieldDef, IsoDate, Label, Locale, Minor, Party, PartySnapshot,
} from './types.ts';

export interface TaxCodeDef {
  code: string;
  label: Label;
  kind: 'standard' | 'zero' | 'exempt';
  /** Effective-dated rates; `to` inclusive. */
  rates: { from: IsoDate; to?: IsoDate; rate: number }[];
}

export interface WhtCategoryDef {
  id: string;
  label: Label;
  rate: number;
}

export interface AccountDef {
  code: string;
  name: Label;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
}

/** Account codes the core posting policy needs. */
export interface PostingAccounts {
  receivable: string;
  payable: string;
  revenueGoods: string;
  revenueServices: string;
  purchases: string;
  outputTax: string;
  inputTax: string;
  whtPrepaid: string;
  whtPayable: string;
  cash: string;
  bank: string;
  /** Retention held back by customers (asset) and held back from suppliers (liability). */
  retentionReceivable: string;
  retentionPayable: string;
}

export interface Issue {
  level: 'error' | 'warning';
  code: string;
  message: Label;
  field?: string;
}

export interface IssueContext {
  doc: Document;
  docType: DocTypeDef;
  party: Party;
  seller: PartySnapshot;
}

export interface WhtSuggestion {
  category: string;
  base: Minor;
  rate: number;
  amount: Minor;
}

/**
 * Everything jurisdiction-specific. The core computes totals, posts entries
 * and validates documents only through this interface.
 */
export interface Jurisdiction {
  id: string;
  label: Label;
  currency: string;
  currencySymbol: string;
  taxCodes: TaxCodeDef[];
  defaultTaxCode: string;
  whtCategories: WhtCategoryDef[];
  /** Extra party fields (e.g. Thai branch code). */
  partyFields: FieldDef[];
  /** Extra company (seller) fields. */
  companyFields: FieldDef[];
  chartOfAccounts: AccountDef[];
  postingAccounts: PostingAccounts;
  taxRate(code: string, date: IsoDate): number;
  validateTaxId(id: string): boolean;
  validateIssue(ctx: IssueContext): Issue[];
  /** WHT a *payer* would withhold on this document (sales: what the customer will deduct). */
  suggestWht(doc: Document, party: Party): WhtSuggestion[];
  amountInWords(minor: Minor, locale: Locale): string;
  formatDate(date: IsoDate, locale: Locale): string;
  /** Optional payment QR payload (e.g. PromptPay) for an amount. */
  paymentQr?(opts: { proxyId: string; amount: Minor; reference?: string; merchantName?: string }): string;
  /** Label for a party's tax identity line on paper, e.g. "Head office" / "Branch 00002". */
  describeTaxIdentity(snapshot: PartySnapshot, locale: Locale): string;
}
