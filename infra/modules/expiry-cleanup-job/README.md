# Expiry cleanup Container Apps Job

This module creates one scheduled `Microsoft.App/jobs@2026-01-01` resource.
The Job runs the immutable `expiry-cleanup` ACR image daily at `03:00 UTC`
with one replica, no retries, and a 300-second Azure replica timeout.

The Job uses separate user-assigned identities: the image-pull identity is
used only by the ACR registry configuration, while the runtime identity is
the `Main` identity and supplies `AZURE_CLIENT_ID` to the container. No
secrets, secret references, ingress, volumes, probes, commands, arguments,
sidecars, or non-schedule triggers are emitted.

Required inputs are the Job/resource-group/environment identifiers, the
lower-case immutable ACR digest and login server, both identity resource IDs,
the lower-case runtime client UUID, the trailing-slash Azure Table endpoint,
the exact `SecurityState` and `RateState` table names, the lower-case relay
environment, and the canonical Azure Container Apps `wss://` origin.

`cleanup_limit` defaults to `1000` and accepts integers from `1` through
`10000`. `cleanup_timeout_ms` is fixed at `240000`.

The only outputs are the non-sensitive Job `id` and `name`.
