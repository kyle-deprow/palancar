# Sol agent handoff: Palancar implementation plan

## Assignment

- Model: `gpt-5.6-sol`
- Reasoning effort: `xhigh`
- Objective: Produce a buildable implementation plan for the Palancar G2 realtime Spanish-or-Turkish-to-English translation application, covering application code, backend services, Terraform-managed Azure infrastructure, test harnesses, delivery dependencies, and safe parallelization.
- Done when: The response gives concrete components and proposed paths, interfaces and ownership boundaries, a dependency-aware phase graph, parallel work lanes with merge gates, verification commands or test categories, and explicit decisions versus unresolved choices.

## Required inputs

Read completely:

- `/home/dev/repos/palancar_ws/palancar/AGENTS.md`
- `/home/dev/repos/palancar_ws/palancar/docs/real-time-translation-plan.md`
- `/home/dev/repos/palancar_ws/palancar/.agents/skills/g2-events-input/SKILL.md`
- `/home/dev/repos/palancar_ws/palancar/.agents/skills/g2-sdk-bridge/SKILL.md`
- `/home/dev/repos/palancar_ws/palancar/.agents/skills/g2-display-ui/SKILL.md`
- `/home/dev/repos/palancar_ws/palancar/.agents/skills/g2-dev-toolchain/SKILL.md`
- `/home/dev/repos/palancar_ws/palancar/.agents/skills/g2-simulator-automation/SKILL.md`

Do not inspect `g2_openclaw` or unrelated repositories. The Palancar repository currently contains planning and agent guidance but no application scaffold.

## Constraints and settled decisions

- G2 client: TypeScript, Vite, `@evenrealities/even_hub_sdk` exactly `0.0.12`.
- Backend credentials never ship to the extractable `.ehpk` bundle.
- G2 microphone input is arbitrary chunks of 16 kHz PCM16 little-endian mono.
- Azure transcription path must be proven by a timestamped deployment spike before production relay implementation.
- First transcription candidate: `gpt-4o-mini-transcribe-2025-12-15`; fallback trigger is failure of the latency/accuracy gates in the product plan.
- Translation and response deployment: Azure AI Foundry `gpt-5.6-luna` as requested by the product owner.
- Azure infrastructure is Terraform only, with pinned providers, lock file, remote encrypted state, managed identity, least privilege, and no avoidable portal-only configuration.
- Initial language set: English wearer with one selected target language, Spanish (`es`) or Turkish (`tr`). Core behavior must be language-agnostic and registry-driven rather than specialized for only one target. Finalized transcript segments pass through a language gate; English-only and supported-but-unselected target-language segments must not invoke translation or suggestion generation.
- Initial end-to-end partial transcript target: under 1.5 seconds p95 on physical G2.
- This task is planning only. Do not edit files, install dependencies, provision cloud resources, or create credentials.

## Questions the plan must answer

1. What exact code packages/services should exist, and what does each own?
2. What versioned WebSocket/control/data contracts must be defined first so client, backend, and fixtures can be built independently?
3. Where do audio framing, acknowledgements, stateful resampling, Azure session management, VAD/commit mode, transcript revisions, language gating, translation, suggestions, and display scheduling live?
4. Which Terraform roots/modules/resources are needed for bootstrap, dev, observability, deployment identity, backend compute, registry/build artifacts, networking, Foundry deployments, secrets, budgets, and CI/CD identity?
5. Which infrastructure details cannot be finalized until subscription, region, quota, model availability, DNS, authentication, and budget choices are known?
6. What is the smallest vertical slice, and which phases can proceed in parallel without coupling to unproven Azure realtime behavior?
7. What merge gates prevent parallel lanes from drifting at protocol, schema, environment-output, and deployment boundaries?
8. What automated, simulator, Azure integration, and physical-hardware evidence closes each phase?
9. How should the target-language registry and gate support Spanish and Turkish equally, reject the unselected supported language, and avoid treating a source-language hint as an enforcement boundary?
10. What should be deliberately deferred from the first vertical slice?

## Response format

1. Architecture verdict and recommended technology choices, including alternatives only where a decision remains consequential.
2. Proposed repository tree with concise ownership annotations.
3. Build contracts: versioned schemas/interfaces and Terraform outputs consumed across lanes.
4. Dependency graph and numbered phases with entry criteria, work, exit evidence, and blockers.
5. Parallelization matrix: lane, files owned, can start after, can run with, merge gate.
6. Terraform plan: bootstrap and environment stacks, resources/modules, identity and secret flow, observability, and deployment workflow.
7. Test and acceptance matrix, including language-gate and latency evidence.
8. Risks and deferred decisions ranked critical/high/medium/low.
9. Recommended first implementation increment sized for one reviewable change.

Keep the plan implementation-oriented and explicit. Distinguish facts established by the repository from recommendations and subscription-dependent assumptions.
