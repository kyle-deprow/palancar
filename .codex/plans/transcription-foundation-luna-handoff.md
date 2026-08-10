# Luna implementation handoff: transcription foundation

Implement only `packages/transcription/**`, a provider-neutral transcription
contract and deterministic mock adapter. Azure/OpenAI API selection remains
unproven and out of scope. You are not alone; preserve active G2/package-lock,
infra, and Azure work. Do not run npm install, edit package-lock/root files,
commit, call providers, or mutate Azure.

## Inputs

Read the transcription/Phase 3 sections of `docs/implementation-plan.md`, ADRs
0001/0002 if present and 0004, `packages/contracts/**`, `packages/audio/**`, and
both target definitions in `packages/language-registry/**`.

## Required API

- Strict ESM package with capability types declaring provider/model/version,
  accepted input rate/format/channels, native vs required resampling, server VAD
  support/mode, manual commit support/cadence, language mode (`automatic` or
  selected-target hint), partial support, and provider-retention status.
- Session lifecycle with `start`, `pushAudio`, `finalize`, `cancel`, `close`.
  Enforce exactly one active utterance; typed idempotent finalize/cancel;
  push only while active; reset resampler/session state between utterances;
  no event after cancel/close; close is idempotent.
- Input always uses original 16 kHz S16LE mono bytes with original exclusive
  sample offsets. Process arbitrary even chunks, copy views/subclasses, reject
  odd/empty/gap/overlap/stale/wrong IDs/effective utterance overflow without
  mutation. Provider adapter offsets never replace original offsets.
- Normalized events: partial and final with session epoch, utterance, stable
  segment ID, monotonic revision, provider event timestamp, language evidence,
  original accepted-through offset, and finalization reason. Validate via
  existing contract schemas where applicable; stale revisions are rejected.
- Deterministic mock adapter configurable symmetrically for Spanish and Turkish.
  It emits scripted partial(s) and final only after enough accepted samples or
  explicit finalize. It must also script English, supported-unselected, mixed,
  unsupported, and uncertain language evidence without specializing to Spanish.
- Metadata-only evidence record/collector schema allowing timestamps, opaque
  IDs, event/status/config/model versions, sample/byte/token counts, latency,
  and aggregate score fields. Categorically reject strings/keys for PCM/audio,
  transcript text, translation, suggestions, prompts/responses, provider body,
  credentials/tokens/keys. Reject `ArrayBuffer`, typed arrays, Buffer subclasses,
  Blob/File-like binary values, nested forbidden keys, non-finite numbers, and
  unknown fields. Collector copies/deep-freezes inputs and emits JSONL without
  content.

## Tests

Cover lifecycle/idempotence, arbitrary view copies, offsets and all rejection
classes/no mutation, max/one-over utterance, cancel/close no-late-events,
revision monotonicity, stable segment IDs, both targets symmetric and all gate
evidence categories, identity resampler reset, metadata allow-list and deep
privacy canaries including casing/nesting/binary subclasses, deep immutability,
and JSONL round-trip. Add deterministic fast-check partitions/state sequences
with recorded seeds and at least 200 runs.

## Verification

Use existing installed workspace tooling without modifying the lockfile. Run
package lint/typecheck/test/build directly, then root commands only if they do
not alter package-lock; run Node 22 ESM import and `git diff --check`. Report
files, API, tests/seeds, and verification. End DONE only when complete.
