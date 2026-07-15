export interface OdooConnectionConfig {
  host: string
  port: number
  database: string
  username: string
  apiKey: string
  ssl: boolean
}

export interface OdooFieldMapping {
  odooField: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'float' | 'integer' | 'selection' | 'many2one' | 'currency'
  editable: boolean
  minRole: string
  width?: number
  align?: 'left' | 'center' | 'right'
  format?: string
}

export interface SpreadsheetDefinition {
  id: string
  name: string
  odooModel: string
  domain: string[]
  fields: OdooFieldMapping[]
  sortField?: string
  sortOrder?: 'asc' | 'desc'
  pageSize: number
  refreshIntervalSeconds: number
  minRole: string
  createdBy: string
  createdAt: number
}

export interface DraftWorksheet {
  id: string
  templateId: string
  name: string
  channelId: string
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'pushed'
  data: Record<string, unknown>
  fieldPermissions: Record<string, string>
  attachments: WorksheetAttachment[]
  createdBy: string
  createdAt: number
  updatedAt: number
  approvedBy?: string
  approvedAt?: number
  rejectionReason?: string
  pushedToOdoo?: {
    model: string
    recordId: number
    pushedAt: number
  }
}

export interface WorksheetAttachment {
  id: string
  field: string
  fileName: string
  fileType: string
  url: string
  uploadedBy: string
  uploadedAt: number
}

export interface WorksheetTemplate {
  id: string
  name: string
  description: string
  odooModel: string
  fieldMappings: TemplateField[]
  category: string
}

export interface TemplateField {
  key: string
  label: string
  type: 'text' | 'number' | 'currency' | 'date' | 'select' | 'photo' | 'file'
  required: boolean
  options?: string[]
  defaultValue?: unknown
  minRole: string
  odooField?: string
}

export interface ApprovalRequest {
  id: string
  draftId: string
  requesterId: string
  requesterName: string
  currentRole: string
  amount: number
  currency: string
  currentTier: string
  status: 'pending' | 'approved' | 'rejected' | 'escalated'
  reviewers: ApprovalReviewer[]
  createdAt: number
  updatedAt: number
  approvedAt?: number
}

export interface ApprovalReviewer {
  userId: string
  role: string
  decision?: 'approved' | 'rejected'
  reason?: string
  decidedAt?: number
}

export interface ApprovedValueSnapshot {
  id: string
  odooRecordId: number
  model: string
  fields: SnapshotField[]
  snapshotHash: string
  approvedBy: string
  approvedAt: number
  pushedAt: number
}

export interface SnapshotField {
  name: string
  value: unknown
  hash: string
}

export interface TamperAlert {
  id: string
  model: string
  odooRecordId: number
  approvedHash: string
  currentHash: string
  changes: TamperChange[]
  detectedAt: number
  acknowledged: boolean
  acknowledgedBy?: string
}

export interface TamperChange {
  field: string
  oldValue: unknown
  newValue: unknown
}

export interface AuditEvent {
  id: string
  action: string
  actorId: string
  actorRole: string
  model?: string
  recordId?: number
  details: Record<string, unknown>
  timestamp: number
}

export interface OdooModelInfo {
  model: string
  name: string
  fields: OdooFieldInfo[]
}

export interface OdooFieldInfo {
  name: string
  type: string
  relation?: string
  required: boolean
  readonly: boolean
  string: string
  help?: string
  selection?: [string, string][]
}

export interface SpendingCap {
  role: string
  maxAmount: number
  currency: string
  requiresApproval: boolean
  escalationRole?: string
}

export interface TamperFieldConfig {
  fieldName: string
  sensitivity: 'locked' | 'monitored' | 'informational' | 'ignored'
  autoRevert: boolean
}
