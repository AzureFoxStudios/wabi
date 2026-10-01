# Wabi Project plugin source package

This optional assistant integration connects to one operator-selected shared
Wabi Project. Each self-hosted installation uses its own server, bot and
connector. There is no required wabi.chat account or global Wabi identity.

`plugin.json` and `skills/` are the portable source package. Generate the final
`mcp.json` for a real deployed HTTPS endpoint with:

```bash
node scripts/package-wabi-project-plugin.mjs HTTPS_MCP_URL NEW_OUTPUT_DIRECTORY
```

Run this from the repository root. Do not put credentials in the generated
package. The directory is an assistant plugin package, not an operator-installed
Wabi backend runtime plugin. The separate gateway reads its protected Project
connection file; the Authority continues to own admission and community data.

See [operator setup](../../docs/features/PROJECT_PLUGIN.md) and
[tested boundaries](../../docs/testing/PROJECT_PLUGIN_ACCEPTANCE_2026-09-30.md).
