# Sol agent handoff: realtime audio adversarial review

## Assignment

- Model: `gpt-5.6-sol`
- Reasoning effort: `xhigh`
- Objective: Adversarially review Palancar's proposed low-latency G2-to-Azure transcription architecture and produce a prioritized correction plan that minimizes perceived transcript latency without violating the documented G2 or Foundry contracts.
- Done when: The response identifies the highest-risk assumptions and failure modes, gives a corrected end-to-end audio/commit/display strategy with an explicit latency budget, and clearly distinguishes verified facts from items requiring a deployment spike.

## Scope

- Inspect/use:
  - `/home/dev/repos/palancar_ws/palancar/docs/real-time-translation-plan.md`
  - `/home/dev/repos/palancar_ws/palancar/AGENTS.md`
  - `/home/dev/repos/palancar_ws/palancar/.agents/skills/g2-events-input/SKILL.md`
  - `/home/dev/repos/palancar_ws/palancar/.agents/skills/g2-sdk-bridge/SKILL.md`
  - `/home/dev/repos/palancar_ws/palancar/.agents/skills/g2-display-ui/SKILL.md`
  - `/home/dev/repos/palancar_ws/palancar/.agents/skills/g2-dev-toolchain/SKILL.md`
  - Microsoft Foundry realtime reference: `https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/realtime`
  - Microsoft Foundry WebSocket guide: `https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets`
  - Microsoft Foundry audio events reference: `https://learn.microsoft.com/en-us/azure/foundry-classic/openai/realtime-audio-reference-ga`
- Do not inspect/change:
  - Do not inspect `g2_openclaw` or unrelated workspace code.
  - Do not design the complete product, UI copy, pricing model, authentication product, or production rollout.
  - Do not provision Azure resources, install dependencies, or edit repository files.
- Write permission: Read-only. Return findings to the parent only.

## Method and evidence

- Required checks:
  - Challenge the assumption that 100 ms append frames plus three-second commits produce an acceptably realtime transcript.
  - Determine the documented relationship among append, commit, VAD, transcription delta, and completed events.
  - Verify sample-rate requirements and critique where continuous 16 kHz to 24 kHz resampling should occur.
  - Compare backend-relay WebSocket architecture against direct client-to-Foundry options while respecting that secrets cannot ship in the G2 bundle.
  - Assess callback aggregation, framing overhead, backpressure, sequence handling, reconnection, boundary loss, and transcript stitching.
  - Assess the G2 display update cadence and BLE serialization implications.
  - Propose an explicit target latency budget for capture, transport, transcription, backend relay, and display.
  - Identify the smallest deployment spike that can prove or disprove whether `gpt-4o-mini-transcribe-2025-12-15` delivers useful deltas before or only after commit.
  - Name an alternative transcription model or service only if the selected mini model cannot satisfy the latency goal, and state the trigger for switching.
- Evidence to return:
  - Exact local file section references and direct official documentation URLs for factual claims.
  - Prioritized findings labeled critical/high/medium/low.
  - A corrected technical approach and measurable acceptance criteria.
- Stop and escalate if:
  - Official documentation is contradictory about the selected model's delta/commit behavior.
  - The selected model is not verifiably supported by the current Azure realtime transcription contract.
  - A conclusion depends on physical G2 behavior not established by the local skill files.

## Response format

1. Result: concise verdict on whether the current plan can meet a near-realtime UX.
2. Findings: prioritized adversarial findings with evidence and severity.
3. Corrected approach: numbered end-to-end architecture and commit/display policy.
4. Latency budget: table with stage, target, warning threshold, and measurement point.
5. Spike plan: minimal experiments, expected evidence, and pass/fail criteria.
6. Checks run: files, URLs, and commands inspected.
7. Blockers or uncertainty: none, or explicit contradictions and unknowns.
