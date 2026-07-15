import type { SpreadsheetDefinition, OdooFieldMapping } from '../shared/types'
import { OdooClient } from './odoo-client'

export interface SpreadsheetData {
  columns: ColumnDef[]
  rows: Record<string, unknown>[]
  totalCount: number
  offset: number
  limit: number
}

export interface ColumnDef {
  key: string
  label: string
  type: string
  align: string
  width?: number
  format?: string
  editable: boolean
}

export class SpreadsheetEngine {
  constructor(private odoo: OdooClient) {}

  async fetchData(
    def: SpreadsheetDefinition,
    options: {
      offset?: number
      limit?: number
      sortField?: string
      sortOrder?: 'asc' | 'desc'
      search?: string
      filters?: Record<string, unknown>
    }
  ): Promise<SpreadsheetData> {
    const fields = def.fields.map((f) => f.odooField)
    const domain = this.buildDomain(def.domain, options.search, options.filters)

    const order = options.sortField
      ? `${options.sortField} ${options.sortOrder || 'asc'}`
      : def.sortField
        ? `${def.sortField} ${def.sortOrder || 'asc'}`
        : undefined

    const [rows, totalCount] = await Promise.all([
      this.odoo.searchRead<Record<string, unknown>>(
        def.odooModel,
        domain,
        fields,
        {
          limit: options.limit ?? def.pageSize,
          offset: options.offset ?? 0,
          order,
        }
      ),
      this.odoo.getRecordCount(def.odooModel, domain),
    ])

    return {
      columns: def.fields.map((f) => this.toColumnDef(f)),
      rows: rows.map((r) => this.transformRow(r, def.fields)),
      totalCount,
      offset: options.offset ?? 0,
      limit: options.limit ?? def.pageSize,
    }
  }

  private toColumnDef(field: OdooFieldMapping): ColumnDef {
    return {
      key: field.odooField,
      label: field.label,
      type: field.type,
      align: field.align ?? 'left',
      width: field.width,
      format: field.format,
      editable: field.editable,
    }
  }

  private transformRow(
    row: Record<string, unknown>,
    fields: OdooFieldMapping[]
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const field of fields) {
      const val = row[field.odooField]
      if (field.type === 'many2one' && Array.isArray(val)) {
        result[field.odooField] = val[1] ?? val[0]
        result[`${field.odooField}_id`] = val[0]
      } else {
        result[field.odooField] = val
      }
    }
    return result
  }

  private buildDomain(
    baseDomain: string[],
    search?: string,
    filters?: Record<string, unknown>
  ): unknown[] {
    const domain: unknown[] = [...baseDomain]

    if (search && search.length > 0) {
      domain.push(['name', 'ilike', `%${search}%`])
    }

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (value !== null && value !== undefined && value !== '') {
          domain.push([key, '=', value])
        }
      }
    }

    return domain
  }
}
