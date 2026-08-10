# G2 client Azure relay origin Luna handoff

## Objective

Switch the G2 client package configuration from the localhost development relay to the deployed Azure relay HTTPS ticket endpoint, while keeping validation strict.

## Files you may change

- `/home/dev/repos/palancar_ws/palancar/apps/g2-client/relay-origin.json`
- `/home/dev/repos/palancar_ws/palancar/apps/g2-client/app.json`
- `/home/dev/repos/palancar_ws/palancar/apps/g2-client/scripts/validate-relay-origin.mjs`

## Files you must not change

- Any files outside the three listed above
- Runtime TypeScript source, Terraform, relay code, docs, package-lock, build artifacts, or `.ehpk` files

## Required behavior

- Set `apps/g2-client/relay-origin.json` to production mode.
- Set the relay origin to the HTTPS endpoint for the deployed relay:

```text
https://ca-palancar-dev-relay-aeeacd8c.graysmoke-757a2980.eastus2.azurecontainerapps.io
```

- Set `apps/g2-client/app.json` network whitelist to exactly the same HTTPS origin.
- Keep the existing validator guarantees:
  - config contains only `mode` and `relayOrigin`;
  - origin has no path/query/fragment and no username/password;
  - wildcards are forbidden;
  - app manifest network whitelist must exactly equal the validated origin.
- Production must require HTTPS for the ticket endpoint. Do not use `wss://` in the G2 client manifest/config because the app fetches session tickets over HTTPS; the relay returns the WebSocket `wssOrigin` in the ticket response.
- If you edit validator messages, keep them precise.

## Verification

Run:

```bash
npm run check:relay-origin -w @palancar/g2-client
npm run build -w @palancar/g2-client
```

## Completion report

Return:

- changed files
- exact verification output
- unresolved issues, if any
- final line `DONE` only if complete
