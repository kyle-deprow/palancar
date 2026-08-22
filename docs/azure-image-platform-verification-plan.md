# Azure image platform verification plan

## Objective

Prevent an ARM64 image, OCI index, manifest list, attestation, or unrelated registry artifact from reaching Terraform planning or a protected Azure rollout. Acceptance is based on the pinned remote ACR object, not local Docker metadata or an operator-claimed build command.

## Ownership and scope

Implementation may change only:

- `infra/scripts/verify-acr-image-platform.mjs` (new)
- `infra/scripts/verify-acr-image-platform.test.mjs` (new)
- `infra/scripts/dev-plan-lifecycle.mjs`
- `infra/scripts/dev-plan-lifecycle.test.mjs`
- `infra/README.md`

Do not change Terraform topology, image variables, Dockerfiles, plan guards, application code, registry settings, or credentials.

## Remote verifier

1. Accept only exact immutable references in the protected ACR host and the `palancar-relay` or `palancar-expiry-cleanup` repository. Reject tags, alternate hosts/repositories, malformed or uppercase digests, traversal, URL components, and ambiguous references.
2. Acquire an ACR pull token from the already-selected Azure CLI user/subscription context. Keep the token in memory only; never place it in argv, environment, files, output, errors, receipts, checkpoints, or hashes. Never use Docker login or registry admin credentials.
3. Fetch the pinned digest through the Registry v2 API with bounded HTTPS requests. Forward authorization only to the exact ACR host. If blob delivery redirects, allow only HTTPS Azure Blob targets and never forward ACR authorization.
4. Require the response header and locally computed body digest to equal the pinned digest; schema version 2; exactly one valid config descriptor; nonempty valid layers; and exactly one OCI image manifest or Docker v2 image manifest. Reject indexes, manifest lists, artifacts, attestations, and referrers even when they contain one amd64 child.
5. Fetch and digest-verify the config. Require the matching config media type, optional exact descriptor size, `os="linux"`, `architecture="amd64"`, and no nonempty variant or conflicting platform field.
6. Return only a deterministic, credential-free descriptor containing version, canonical reference/repository, manifest/config digests and media types, OS, architecture, and null variant. Emit fixed failure codes only.

## Lifecycle integration

1. Add the verifier to reviewed dependencies for every phase that references either image.
2. Parse the two image assignments from the protected private dev tfvars without accepting duplicates, interpolation, overrides, tags, malformed values, or automatic variable-file substitutions. Bind hosts to the protected ACR login server and repositories to their exact names.
3. During create, verify both remote images after state/worktree/environment/context checks but before `plan-started` and before invoking Terraform. On failure, produce no plan or success manifest and invalidate the run with a fixed image-platform reason.
4. Store the sorted deterministic descriptors and verifier hash in the protected manifest binding and `bindingSha256`; never store authentication metadata.
5. During guard, revalidate the verifier hash, re-run both remote checks, require exact descriptor equality, and prove the tfvars, Terraform show variables, Container App image, and cleanup-job image all equal the bound references. No guard receipt may be written on failure.

## Tests

- Verifier positives: OCI and Docker v2 single manifests with verified Linux/AMD64 configs; deterministic redacted output; authorized ACR request; safe blob redirect without authorization.
- Verifier negatives: index/list/artifact media types; ARM64/Windows/variant/missing platform; digest, size, descriptor, layer, JSON, timeout, status, challenge, redirect, host, repository, tag, traversal, and response-size failures; prove tokens and signed URLs never escape.
- Lifecycle positives: both checks precede Terraform, descriptors and verifier hash are bound, reviewed topology uses the exact references, and guard revalidates before receipt.
- Lifecycle negatives: either image fails or disappears; references differ across tfvars/plan/topology; missing/duplicate assignments; verifier missing/modified/malformed; Terraform call count remains zero on create-time failures and guard writes no receipt.

## Verification

- `node --test infra/scripts/verify-acr-image-platform.test.mjs`
- `node --test infra/scripts/dev-plan-lifecycle.test.mjs`
- `git diff --check`

## Operator contract

Build and push each runtime image using `docker buildx build --platform linux/amd64 --provenance=false --sbom=false --push`, then pin the returned immutable digest. Local Docker inspection is diagnostic only; the protected lifecycle's remote manifest/config verification is authoritative.

## Completion criteria

All tests pass, Sol returns `READY`, the current pinned relay and cleanup images verify remotely as single Linux/AMD64 manifests, and a protected runtime-cutover create cannot invoke Terraform unless both checks succeed.
