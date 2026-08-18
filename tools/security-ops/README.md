# Security operations

This local-only CLI uses the signed-in Azure CLI identity. It never accepts
storage keys and never exposes relay runtime capabilities. Run it only from a
protected terminal with shell tracing disabled.

Required non-secret environment variables:

- `PALANCAR_OP_TABLE_ENDPOINT`
- `PALANCAR_OP_ENVIRONMENT`
- `PALANCAR_OP_RELAY_ORIGIN` (canonical `wss://` origin)
- `PALANCAR_OP_OPERATOR_SCOPE` (must be `azure-cli:<PALANCAR_OP_PRINCIPAL_ID>`)
- `PALANCAR_OP_SUBSCRIPTION_ID`
- `PALANCAR_OP_TENANT_ID`
- `PALANCAR_OP_PRINCIPAL_ID`

The last three values are checked against the active Azure CLI context before
any Table operation. `SecurityState` and `RateState` are fixed in code.

After Terraform grants the operator table-scoped data roles, build and run:

```sh
npm run build --workspace @palancar/security-ops
node tools/security-ops/dist/main.js initialize
node tools/security-ops/dist/main.js smoke
node tools/security-ops/dist/main.js cleanup
```

`smoke` runs exactly one fresh Spanish session and one fresh Turkish session
using synthetic audio. It prints only fixed pass/fail metadata and timings.
Pairing codes, installation credentials, tickets, transcripts, translations,
suggestions, and HTTP bodies are never printed.

`issue-pairing` is for a human enrollment flow. It refuses redirected input or
output and prints the one-time code exactly once. Do not invoke it through CI,
captured terminals, or shell command substitution.
