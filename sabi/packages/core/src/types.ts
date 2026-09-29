/**
 * Sabi core types. Everything business-specific is *configuration* expressed
 * with these types; nothing here knows about any particular trade.
 */

export type Locale = 'en' | 'th';
/** A bilingual label. `en` is mandatory as the fallback. */
export type Label = { en: string; th?: string };

export type SubjectType = 'job' | 'document' | 'party' | 'item' | 'payment';

/** ISO date `YYYY-MM-DD` (business date, no timezone). */
export type IsoDate = string;
/** ISO timestamp. */
export type IsoTime = string;
/** Integer amount in minor units (satang for THB). */
export type Minor = number;

// ───────────────────────────── Configuration ─────────────────────────────

export type FieldType = 'text' | 'longtext' | 'number' | 'date' | 'select' | 'boolean' | 'user' | 'money';

export interface FieldDef {
  key: string;
  type: FieldType;
  label: Label;
  options?: { value: string; label: Label }[];
  unit?: string;
  placeholder?: Label;
  /** Show in list/board cards. */
  summary?: boolean;
}

export type JobPhase = 'open' | 'done' | 'cancelled';
export type DocPhase = 'draft' | 'issued' | 'closed' | 'void';
export type Tone = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';

export interface StateDef<P extends string> {
  id: string;
  label: Label;
  phase: P;
  /** Role that owns the next action while a record sits in this state. */
  ownerRole?: string;
  tone?: Tone;
  /** Short guidance shown while in this state. */
  hint?: Label;
}

export interface DocumentRequirement {
  type: string;
  phase: DocPhase | DocPhase[];
}

export interface Guard {
  /** Record fields (job/document `fields`, or core keys like `partyId`) that must be non-empty. */
  fields?: string[];
  /**
   * Related documents that must exist in a phase. For job workflows: documents
   * in the job. For document workflows: documents derived from this one.
   */
  documents?: DocumentRequirement[];
  /** All tasks on the subject must be done. */
  tasksDone?: boolean;
  /** Document workflows: must have at least one line. */
  lines?: boolean;
  /** Requires an approval from someone holding `role` when `when` (formula) is truthy. */
  approval?: { role: string; when?: string; reason?: Label };
}

export type WorkflowAction =
  | { createTask: { title: Label; role?: string; dueInDays?: number } }
  | { notifyRole: string; message?: Label };

export interface TransitionDef {
  id: string;
  from: string[] | '*';
  to: string;
  label: Label;
  /** The obvious next step from `from`. */
  primary?: boolean;
  /** Roles allowed to perform it (default: anyone with write capability on the subject). */
  roles?: string[];
  requires?: Guard;
  actions?: WorkflowAction[];
  /** Applied automatically by the system as soon as its guard passes. */
  auto?: boolean;
  /** Ask for a reason (stored on the event). */
  requireReason?: boolean;
  tone?: Tone;
}

export interface WorkflowDef<P extends string> {
  initial: string;
  states: StateDef<P>[];
  transitions: TransitionDef[];
}

export interface JobTypeDef {
  id: string;
  label: Label;
  numbering: { prefix: string };
  fields: FieldDef[];
  workflow: WorkflowDef<JobPhase>;
  /** Document types offered inside the job workspace, in lifecycle order. */
  documentTypes: string[];
}

export type Effect = 'reserve' | 'stock_out' | 'stock_in' | 'receivable' | 'payable';

export interface DocTypeDef {
  id: string;
  label: Label;
  /** Title printed on the paper (e.g. "ใบส่งของ/ใบกำกับภาษี"). */
  printTitle?: Label;
  direction: 'sales' | 'purchase';
  numbering: { prefix: string };
  effects: Effect[];
  convertsTo: string[];
  workflow: WorkflowDef<DocPhase>;
  fields?: FieldDef[];
  /** Default price mode for new documents. */
  priceMode?: 'exclusive' | 'inclusive';
  defaultDueDays?: number;
  /** What the due date means for this type (e.g. "Valid until", "Due"). */
  dueLabel?: Label;
  /** Jurisdiction-specific flags, interpreted only by the jurisdiction adapter. */
  jurisdiction?: Record<string, unknown>;
}

export interface MeasureTemplate {
  id: string;
  label: Label;
  inputs: { key: string; label: Label; unit?: string; step?: number }[];
  /** Formula yielding the billable quantity, e.g. `pieces * length`. */
  qty: string;
  /** Display template, e.g. `{pieces} × {length} m`. */
  describe?: string;
}

export type Capability =
  | 'all'
  | 'jobs.write'
  | 'documents.write'
  | 'documents.issue'
  | 'documents.void'
  | 'money.write'
  | 'stock.write'
  | 'parties.write'
  | 'items.write'
  | 'settings.write'
  | 'reports.read'
  | 'approve';

export interface RoleDef {
  id: string;
  label: Label;
  capabilities: Capability[];
}

/** Virtual stock locations known to the core (not configurable). */
export const VIRTUAL_LOCATIONS = ['supplier', 'customer', 'consumed', 'adjustment'] as const;

export interface LocationDef {
  id: string;
  name: Label;
  kind: 'internal' | 'virtual';
}

export interface Pack {
  id: string;
  label: Label;
  version: string;
  roles: RoleDef[];
  jobTypes: JobTypeDef[];
  documentTypes: DocTypeDef[];
  measureTemplates: MeasureTemplate[];
  partyFields: FieldDef[];
  itemFields: FieldDef[];
  locations: LocationDef[];
  /** Internal location used by stock effects unless a document says otherwise. */
  defaultLocation: string;
  units: { id: string; label: Label }[];
  paymentMethods: { id: string; label: Label; cash?: boolean }[];
}

// ─────────────────────────────── Records ────────────────────────────────

export type Fields = Record<string, unknown>;

export interface Address {
  line1?: string;
  line2?: string;
  district?: string;
  province?: string;
  postcode?: string;
  country?: string;
}

export interface Party {
  id: string;
  kind: 'person' | 'organization';
  name: string;
  roles: string[];
  taxId?: string;
  phone?: string;
  email?: string;
  address?: Address;
  parentId?: string;
  paymentTermsDays?: number;
  creditLimit?: Minor;
  fields: Fields;
  archived?: boolean;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface Item {
  id: string;
  sku: string;
  name: string;
  kind: 'stock' | 'service' | 'non_stock';
  uom: string;
  salePrice: Minor;
  costPrice: Minor;
  taxCode: string;
  whtCategory?: string;
  measureTemplate?: string;
  fields: Fields;
  active: boolean;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface Job {
  id: string;
  number: string;
  type: string;
  title: string;
  partyId: string;
  contactId?: string;
  ownerId?: string;
  state: string;
  phase: JobPhase;
  dueDate?: IsoDate;
  fields: Fields;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  closedAt?: IsoTime;
}

export interface DocLine {
  id: string;
  itemId?: string;
  description: string;
  measures?: Record<string, number>;
  qty: number;
  uom: string;
  unitPrice: Minor;
  discountPct: number;
  taxCode: string;
  whtCategory?: string;
  /** Kind of the item at the time the line was written (drives revenue split / stock). */
  itemKind?: Item['kind'];
  sourceLineId?: string;
}

export interface TaxLine {
  code: string;
  rate: number;
  base: Minor;
  amount: Minor;
}

export interface Totals {
  /** Σ qty × price before line discounts (in the document's price mode). */
  gross: Minor;
  discount: Minor;
  /** Tax-exclusive base. */
  net: Minor;
  taxes: TaxLine[];
  tax: Minor;
  total: Minor;
  /** Tax-exclusive amounts per WHT category (for withholding suggestions). */
  whtBases: { category: string; base: Minor }[];
  /** Net split by item kind (goods vs services) for revenue posting. */
  netGoods: Minor;
  netServices: Minor;
  maxDiscountPct: number;
}

export interface PartySnapshot {
  name: string;
  taxId?: string;
  address?: Address;
  phone?: string;
  email?: string;
  fields: Fields;
}

export interface Document {
  id: string;
  type: string;
  number?: string;
  state: string;
  phase: DocPhase;
  partyId: string;
  jobId?: string;
  sourceId?: string;
  date: IsoDate;
  dueDate?: IsoDate;
  priceMode: 'exclusive' | 'inclusive';
  lines: DocLine[];
  notes?: string;
  fields: Fields;
  totals: Totals;
  partySnapshot?: PartySnapshot;
  sellerSnapshot?: PartySnapshot;
  issuedAt?: IsoTime;
  issuedBy?: string;
  voidReason?: string;
  createdBy: string;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface PaymentAllocation {
  documentId: string;
  amount: Minor;
}

export interface Payment {
  id: string;
  number: string;
  direction: 'in' | 'out';
  partyId: string;
  date: IsoDate;
  method: string;
  /** Money actually moved. */
  amount: Minor;
  /** Tax withheld by the payer (settles the document together with `amount`). */
  whtAmount: Minor;
  whtCategory?: string;
  whtCertificate?: string;
  reference?: string;
  allocations: PaymentAllocation[];
  voided?: boolean;
  voidReason?: string;
  createdBy: string;
  createdAt: IsoTime;
}

export interface StockMove {
  id: string;
  itemId: string;
  qty: number;
  from: string;
  to: string;
  documentId?: string;
  jobId?: string;
  lineId?: string;
  note?: string;
  at: IsoTime;
  by: string;
}

export interface Task {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  title: string;
  assigneeId?: string;
  role?: string;
  due?: IsoDate;
  doneAt?: IsoTime;
  doneBy?: string;
  createdBy: string;
  createdAt: IsoTime;
}

export interface Message {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  authorId: string;
  body: string;
  mentions: string[];
  fileIds: string[];
  createdAt: IsoTime;
}

export interface FileRecord {
  id: string;
  sha256: string;
  name: string;
  mime: string;
  size: number;
  subjectType: SubjectType;
  subjectId: string;
  uploadedBy: string;
  createdAt: IsoTime;
}

export interface Approval {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  transitionId: string;
  role: string;
  reason?: string;
  state: 'pending' | 'approved' | 'rejected' | 'stale';
  requestedBy: string;
  requestedAt: IsoTime;
  decidedBy?: string;
  decidedAt?: IsoTime;
  comment?: string;
}

export interface JournalLine {
  account: string;
  debit: Minor;
  credit: Minor;
  partyId?: string;
}

export interface JournalEntry {
  id: string;
  date: IsoDate;
  memo: string;
  source: { type: 'document' | 'payment'; id: string };
  reversalOf?: string;
  lines: JournalLine[];
}

/** An event as stored in the journal. */
export interface JournalEvent<D = Record<string, unknown>> {
  seq: number;
  id: string;
  at: IsoTime;
  actorId: string;
  type: string;
  subjectType: SubjectType | 'user' | 'settings' | 'system';
  subjectId: string;
  data: D;
  prevHash: string;
  hash: string;
}
