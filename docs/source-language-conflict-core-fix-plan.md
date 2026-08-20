# Source-language conflict-core fix plan

## Status and evidence

The reviewed generation-output image is healthy in development. Its single
controlled bilingual smoke stopped on the Spanish turn after transcription
succeeded and the development-provisional source classifier returned
`MIXED`. Content-free telemetry recorded an overall Spanish ELD score of 7,757
basis points. No translation, suggestion, generation-provider, or state-store
failure occurred, and cleanup preserved the active/current baseline.

The intended fixture text is accepted locally. The failure therefore occurs
at the interaction between 600 ms Azure transcription commits and the source
classifier's existential mixed-language rule: one reliable one-word window can
override a strongly selected full transcript.

## Reviewed source policy

Keep the existing ELD reliability boundary unchanged:

- score threshold: `0.65`
- margin threshold: `0.08`
- source minimum multiword conflict core: `2` words
- source minimum distinct singleton conflict cores: `2`

For source transcription only:

1. The full text must be reliable, meet both thresholds, and detect as the
   selected target language. English-only, unsupported-only, and
   supported-unselected-only text therefore remain rejected.
2. Collect reliable nonselected-language intervals from the existing clause
   and one-through-eight-word analysis windows.
3. Deduplicate equal intervals and, per conflicting language, remove intervals
   that strictly contain a smaller conflicting interval. The survivors are
   minimal conflict cores.
4. Return `MIXED` when any minimal core is at least two words, or when at least
   two distinct singleton core positions exist. Ignore exactly one singleton
   core and accept with the explicit reason `MATCH_IGNORED_SINGLETON`.
5. Apply the algorithm identically to Spanish and Turkish. The bounded
   exception accepts one genuinely embedded nonselected word in otherwise
   strongly selected source speech because it is indistinguishable from the
   observed short-fragment artifact without another model call or provider
   trust.

Generated-output validation remains strict: its current existential
strong-language-mix rule, including a single conflicting word in any slot,
must remain unchanged.

## Implementation boundary

- `apps/relay/src/provisional-language-boundary.ts`
- `apps/relay/test/provisional-language-boundary.test.ts`
- `packages/language-registry/src/classifier.ts`
- `packages/language-registry/src/gate.ts`
- `packages/language-registry/src/registry.ts`
- `packages/language-registry/test/language-registry.test.ts`
- `apps/relay/src/telemetry.ts`
- `apps/relay/src/types.ts`
- `apps/relay/src/session.ts`
- focused relay telemetry/core tests affected by the exact reason vocabulary

The development-provisional profile version must advance from
`eld-small-dev-4` to `eld-small-dev-5`. The new accepted reason is validated at
every evidence and telemetry boundary and emitted without transcript content,
making old-reject/new-accept events directly countable. No new metric name,
model call, detector call, provider trust, language-specific branch, commit
cadence change, infrastructure resource, or production approval is permitted.

## Adversarial verification

- Both selected languages: ordinary target text and one singleton conflict
  accept; the singleton case uses only `MATCH_IGNORED_SINGLETON`.
- Both selected languages: two separated singleton conflicts, one multiword
  conflict, English-only, the other selected language only, unsupported-only,
  short, unreliable, and detector-error cases reject.
- Overlapping conflict windows reduce to their minimal cores; duplicates do
  not inflate singleton counts; conflicting languages at the same lexical
  position count as one position.
- Clause spans, punctuation, Unicode, repeated words, maximum input, hostile
  detector objects, readiness, cancellation, and exact evidence descriptors
  remain fail-closed.
- Generated validation continues rejecting one conflicting word in every
  English and target-language slot for both two- and three-suggestion outputs.
- Language-gate tests prove both accepted reasons require the exact detector,
  profile, score, selected language, final event, and
  `development-provisional` mode.
- Telemetry accepts the new reason only on a successful target decision with a
  valid score and detected selected language; malformed combinations are
  dropped.

## Rollout gates

1. Luna implements only the bounded policy/contracts/tests.
2. Run focused suites, then root lint, typecheck, tests, and build.
3. Sol independently reviews the complete diff; repeat the fix/review loop
   until READY, then commit.
4. Build an immutable relay image, repin the Terraform predecessor guard to
   the currently healthy generation-output digest, review and apply only an
   exact guard-approved saved plan, and verify one healthy 100%-traffic
   revision.
5. Run exactly one new controlled Spanish/Turkish smoke for that genuinely new
   reviewed deployment. Do not retry a failed smoke blindly.
6. Verify content-free telemetry: both targets report `target` with `MATCH` or
   `MATCH_IGNORED_SINGLETON`, both reach translation and suggestions, no
   generation/provider/state failure occurs, and cleanup restores the
   active/current baseline.
7. Prove a normally refreshed terminal no-drift plan. The profile remains
   `productionApproved=false`; production promotion requires a separately
   calibrated corpus and staged shadow evidence.
