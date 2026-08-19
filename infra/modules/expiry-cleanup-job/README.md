# Expiry cleanup Container Apps Job

This module creates one scheduled `Microsoft.App/jobs@2026-01-01` resource.
The Job runs the immutable `expiry-cleanup` ACR image daily at `03:00 UTC`
with one replica, no retries, and a 300-second Azure replica timeout.

The Job uses separate user-assigned identities: the image-pull identity is
used only by the ACR registry configuration, while the runtime identity is
the `Main` identity and supplies `AZURE_CLIENT_ID` to the container. No
secrets, secret references, ingress, volumes, probes, commands, arguments,
sidecars, or non-schedule triggers are emitted.

The Job name must contain 2-32 lower-case alphanumeric characters with single
internal hyphens only. Other required inputs are the resource-group/environment
identifiers, the lower-case immutable
`<acr>.azurecr.io/palancar-expiry-cleanup@sha256:<digest>` image and login
server, both identity resource IDs, the lower-case runtime client UUID, and the
canonical Azure Table account origin serialized without a trailing slash (for
example, `https://account.table.core.windows.net`). Parsing that origin as a URL
still yields pathname `/`. The exact `SecurityState` and `RateState` table
names, lower-case relay environment, and canonical Azure Container Apps
`wss://` origin are also required. The Table endpoint is emitted to the
container unchanged.

`cleanup_limit` defaults to `1000` and accepts integers from `1` through
`10000`. `cleanup_timeout_ms` is fixed at `240000`.

The only outputs are the non-sensitive Job `id` and `name`.
