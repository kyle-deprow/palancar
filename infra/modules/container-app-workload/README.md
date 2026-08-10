# Relay Container App workload

This module owns the complete relay Container App through one
`azapi_resource` using `Microsoft.App/containerApps@2026-01-01`. It expects an
immutable ACR digest and two user-assigned identities: one for image pulls and
one for application runtime access. The module does not create secrets or
accept registry credentials.

The workload uses a single revision, one warm replica, an Azure-provided
external WebSocket origin, and HTTP liveness/readiness probes. Runtime
configuration is supplied through non-secret environment variables and the
managed identities are configured with `None` and `Main` lifecycles for image
pull and application runtime respectively.
