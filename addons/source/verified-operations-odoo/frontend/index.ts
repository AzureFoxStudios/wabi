export const businessSpreadsheetPlugin = {
  id: 'verified-operations-odoo',
  commands: ['/biz', '/odoo'],
  workspacePanels: ['business-dashboard'],
  routes: [
    '/api/plugins/runtime/verified-operations-odoo/status',
    '/api/plugins/runtime/verified-operations-odoo/connect',
    '/api/plugins/runtime/verified-operations-odoo/sheets',
    '/api/plugins/runtime/verified-operations-odoo/drafts',
    '/api/plugins/runtime/verified-operations-odoo/approvals',
    '/api/plugins/runtime/verified-operations-odoo/verify',
    '/api/plugins/runtime/verified-operations-odoo/conflicts',
    '/api/plugins/runtime/verified-operations-odoo/caps',
    '/api/plugins/runtime/verified-operations-odoo/tamper-config',
    '/api/plugins/runtime/verified-operations-odoo/templates',
    '/api/plugins/runtime/verified-operations-odoo/audit',
  ],
  notes: 'Odoo-integrated business dashboard with spreadsheet views, draft worksheets, approval workflows, spending controls, and post-approval tamper detection.',
}

export default businessSpreadsheetPlugin
