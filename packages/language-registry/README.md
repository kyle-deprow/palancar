# Language registry and gate

This package owns the pure target-language registry, authoritative text
classifier contracts, and transcript/generation gate. Detector runtimes remain
outside this package.

## Evidence boundary

`TextLanguageClassifier` returns `ClassifiedLanguageEvidence`. Calibrated
evidence always contains `detectedLanguage`, `confidence`, `detectorVersion`,
and `calibrationVersion`. Every non-calibrated status forbids confidence and a
calibration version.

Development-only provisional evidence instead carries an ELD-small detector
version, profile version, decision/reason, and `provisionalScore`. That raw score
is neither a probability nor confidence and has no calibration version. Exact
validation snapshots only exact plain own data properties and rejects
accessors, symbols, hidden fields, and attempts to add confidence or calibration
claims. The shared package remains platform-neutral; the Node relay rejects
native proxies before passing evidence into this descriptor validator.

`RawLanguageDetectorOutput` is deliberately separate. Detector-native values
are named `score`; they are not probabilities and cannot be copied into gate
confidence without an explicit calibration step. The runtime validators reject
extra fields and reject confidence on insufficient, uncalibrated, conflicting,
or unavailable evidence.

Provider language metadata, transcription hints, and token logprobs are
advisory. They are not `ClassifiedLanguageEvidence` and must never be passed to
`evaluateLanguageGate` as authoritative evidence.

## Gate behavior

For a finalized transcript, only calibrated evidence matching the selected
definition's exact `finalCalibration` detector/calibration pair and threshold
can authorize anything. It must also identify the selected target before
transcript display and generation are permitted.
English, supported-but-unselected languages, mixed language, unsupported
language, low confidence, and every non-calibrated status produce only a gate
decision; both permissions remain false.

The explicit `development-provisional` mode is a dev prototype boundary. It
accepts exact selected-target `MATCH` or source-only
`MATCH_IGNORED_SINGLETON` evidence from the active Spanish/Turkish ELD-small
profile at or above its raw-score threshold. English, the other target,
unsupported languages, mixed text, short text, unknowns, and detector errors
remain closed. The `eld-small-dev-7` profile caps inputs at 512 Unicode code
points and inspects every overlapping one-through-eight-word window plus every
qualifying clause. Selected-target source classification uses registry-driven
source margins of `.04` for Spanish and `.08` for Turkish; non-selected full
detections retain the shared `.08` margin. Generated English and Turkish
full-text retain `.08`; generated Spanish full-text alone uses `.05` to accept
proven correct Spanish/Catalan-close output, while a different top language
still rejects. Source classification removes strictly containing same-language
intervals before applying the two-word or two-singleton mixed thresholds;
generated-output validation remains strict for any reliable second language,
including one conflicting word. A source conflict interval counts only when its raw score meets the profile
threshold and its margin meets the generic provisional margin; the lowered
selected-target source margin applies only to intervals detected as the
selected target;
oversized input is uncertain.
Production-calibrated mode cannot consume this evidence.

Partials never permit generation. Partial transcript display requires the
selected registry definition to carry an explicit
`partialDisplayCalibration` profile, and the evidence must match its target,
detector version, calibration version, and threshold. The production Spanish
and Turkish definitions intentionally have no partial profile, so their
partials remain suppressed.

The built-in Spanish and Turkish final profiles accept only the explicitly
named controlled-fixture detector and calibration versions. They are test
profiles, not FastText or production calibration, so unmeasured runtime and
provider detectors remain closed by default.

The gate uses registry data only and has no Spanish-specific branch; the same
rules apply to Turkish and future registry languages.

Production promotion remains external: physical-G2 evidence and an approved
ADR must establish calibrated thresholds and error bounds. The provisional
profile cannot satisfy that gate.
