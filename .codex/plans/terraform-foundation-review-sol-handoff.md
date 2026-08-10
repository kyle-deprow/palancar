# Terraform foundation review handoff (GPT-5.6 Sol)

## Role

Perform a read-only adversarial Azure/Terraform architecture, security, correctness, cost, and operability review of `infra/**`. Do not edit, initialize with mutation, apply, commit, or mutate Azure.

## Read

- `AGENTS.md`
- `.codex/plans/terraform-foundation-luna-handoff.md`
- `docs/phase-0-decisions.md`
- `docs/adr/0003-client-authentication.md`
- `docs/adr/0004-data-retention.md`
- `docs/adr/0005-compute-host.md`
- Terraform sections of `docs/implementation-plan.md`
- Every candidate file under `infra/**`

## Acceptance focus

1. Bootstrap is actually executable from local Azure CLI without circularly requiring the backend it creates; Entra state access, container creation, shared-key steady state, migration, locking/versioning/soft delete, prevent-destroy, and restore steps are honest.
2. Live state/backend/tfvars/plans/keys are ignored while examples and lockfiles remain committed.
3. Provider/CLI pins are current exact versions, lockfiles valid, AzureRM/AzAPI ownership never overlaps, and no unnecessary provider exists.
4. Budget and alerts precede Foundry/model and future warm workload spend, with usable dates/contacts and no hard-coded personal data.
5. Workload Storage/Tables with shared-key disabled can actually be created/managed using the declared Azure AD data-plane identity and role propagation; runtime receives only required Table access.
6. Image-pull/runtime identities and AcrPull/Table/OpenAI roles are least-privilege, acyclic, and expose no credential. No application path can request the image-pull identity later.
7. Log Analytics has exact 30-day immediate purge, Application Insights is workspace based, and no content/body capture or sensitive root output exists.
8. ACR, Container Apps environment, Foundry account, exact model versions/SKU/capacity, Entra-only inference, and names are region/provider-valid for East US 2.
9. No placeholder workload/job image undermines the cleanup/privacy contract; the later immutable-image boundary and any deliberate foundation-vs-workload sequencing difference is explicit.
10. Variables/validations/examples produce an acyclic usable dev plan and deterministic Azure-valid names. Outputs are non-secret or correctly sensitive.
11. `fmt`, `init -backend=false`, and `validate` pass independently; flag deprecated, impossible, or plan-time unknown constructs even if validation accepts them.
12. The design is cost-conscious for a Visual Studio Enterprise Subscription and does not create surprise premium/network resources.

Independently run only non-mutating checks. Group findings as Must-Fix, Should-Fix, and Nits with file/path evidence, impact, and exact correction. End exactly `READY` when no Must-Fix remains, otherwise `NEEDS WORK`.
