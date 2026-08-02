import type { OdooConnectionConfig, OdooModelInfo, OdooFieldInfo } from '../shared/types'

interface JsonRpcResponse<T> {
  jsonrpc: '2.0'
  id: number
  result?: T
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export class OdooClient {
  private config: OdooConnectionConfig | null = null
  private uid: number | null = null
  private sessionId: string | null = null
  private requestId = 0

  get connected(): boolean {
    return this.uid !== null
  }

  get connectionConfig(): OdooConnectionConfig | null {
    return this.config
  }

  async connect(config: OdooConnectionConfig): Promise<boolean> {
    this.config = config
    this.uid = null
    this.sessionId = null

    try {
      const baseUrl = `${config.ssl ? 'https' : 'http'}://${config.host}:${config.port}`

      const versionResp = await this.call<{
        server_version: string
        server_version_info: number[]
        server_serie: string
        protocol_version: number
      }>(baseUrl, '/jsonrpc', 'version', {})
      if (!versionResp) {
        throw new Error('Could not reach Odoo server')
      }

      const authResp = await this.call<number>(
        baseUrl,
        '/jsonrpc',
        'authenticate',
        {
          db: config.database,
          login: config.username,
          password: config.apiKey,
        },
        config.database
      )
      if (!authResp || typeof authResp !== 'number') {
        throw new Error('Authentication failed')
      }

      this.uid = authResp
      return true
    } catch (err) {
      this.uid = null
      throw err
    }
  }

  disconnect(): void {
    this.config = null
    this.uid = null
    this.sessionId = null
  }

  async getModels(): Promise<string[]> {
    // Odoo's execute_kw only accepts (model, uid, pwd, method, args, kwargs)
    // — the kwargs (4th tuple entry) is optional and is folded into args
    // when calling. We pass the kwarg as part of the args tuple.
    return this.executeKw<string[]>('ir.model', 'search', [[]])
  }

  async getModelInfo(model: string): Promise<OdooModelInfo> {
    const [fields, name] = await Promise.all([
      this.executeKw<OdooFieldInfo[]>('ir.model.fields', 'search_read', [
        [['model', '=', model], ['store', '=', true]],
        ['name', 'ttype', 'field_description', 'required', 'readonly', 'relation', 'help', 'selection'],
      ]),
      this.executeKw<string>('ir.model', 'search_read', [
        [['model', '=', model]],
        ['name'],
      ]),
    ])

    const modelName = Array.isArray(name) && name.length > 0
      ? (name[0] as { name: string }).name
      : model

    return {
      model,
      name: modelName,
      fields: fields.map((f: OdooFieldInfo) => ({
        name: f.name,
        type: f.type,
        relation: f.relation,
        required: f.required,
        readonly: f.readonly,
        string: f.string,
        help: f.help,
        selection: f.selection,
      })),
    }
  }

  async searchRead<T>(
    model: string,
    domain: unknown[],
    fields: string[],
    options?: {
      limit?: number
      offset?: number
      order?: string
    }
  ): Promise<T[]> {
    return this.executeKw<T[]>(model, 'search_read', [
      domain,
      fields,
      options?.limit ?? 100,
      options?.offset ?? 0,
      ...(options?.order ? [options.order] : []),
    ])
  }

  async read<T>(model: string, ids: number[], fields: string[]): Promise<T[]> {
    return this.executeKw<T[]>(model, 'read', [ids, fields])
  }

  async create(model: string, data: Record<string, unknown>): Promise<number> {
    return this.executeKw<number>(model, 'create', [data])
  }

  async write(model: string, id: number, data: Record<string, unknown>): Promise<boolean> {
    return this.executeKw<boolean>(model, 'write', [[id], data])
  }

  async getRecordCount(model: string, domain: unknown[]): Promise<number> {
    return this.executeKw<number>(model, 'search_count', [domain])
  }

  async getFields(model: string): Promise<OdooFieldInfo[]> {
    return this.executeKw<OdooFieldInfo[]>(model, 'fields_get', [
      [],
      ['name', 'type', 'relation', 'required', 'readonly', 'string', 'help', 'selection'],
    ])
  }

  private async call<T>(
    baseUrl: string,
    path: string,
    method: string,
    params: unknown,
    db?: string
  ): Promise<T> {
    this.requestId++

    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      id: this.requestId,
    }

    if (method === 'version') {
      body.method = 'version'
      body.params = {}
      body.service = 'common'
    } else if (method === 'authenticate') {
      body.method = 'authenticate'
      body.params = params
      body.service = 'common'
    } else {
      body.method = 'call'
      body.params = {
        service: 'object',
        method: 'execute_kw',
        args: [
          db || this.config?.database,
          this.uid,
          this.config?.apiKey,
          method,
          ...(Array.isArray(params) ? params : [params]),
        ],
      }
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`Odoo HTTP ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as JsonRpcResponse<T>

    if (data.error) {
      throw new Error(`Odoo RPC error ${data.error.code}: ${data.error.message}`)
    }

    return data.result as T
  }

  private async executeKw<T>(
    model: string,
    method: string,
    args: unknown[]
  ): Promise<T> {
    if (!this.config || !this.uid) {
      throw new Error('Not connected to Odoo')
    }

    const baseUrl = `${this.config.ssl ? 'https' : 'http'}://${this.config.host}:${this.config.port}`
    return this.call<T>(baseUrl, '/jsonrpc', method, args)
  }
}
