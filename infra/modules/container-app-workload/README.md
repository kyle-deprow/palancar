# Later relay Container App interface

The relay workload is intentionally not provisioned by the development
foundation. Its immutable application image and ADR 0005 evidence are required
before a workload apply. The later module must accept at least:

- `container_app_environment_id`
- `resource_group_name`, `location`, and required tags
- immutable `image_digest` (`repo@sha256:<digest>`; never a mutable tag)
- `image_pull_identity_id` and `runtime_identity_id`
- `acr_login_server`, workload table endpoint/names, Foundry endpoint, and
  deployment names
- health/readiness, one warm replica, one maximum replica, single revision, and
  Azure-provided external HTTPS/WebSocket ingress settings

It must configure the image-pull identity lifecycle as `None` and the runtime
identity lifecycle as `Main`, and it must not create or expose a secret. This
placeholder has no Terraform resources and is not called by `environments/dev`.
