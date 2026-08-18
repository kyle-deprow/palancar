# Language registry and gate

This package owns the pure target-language registry, authoritative text
classifier contracts, and transcript/generation gate. It does not ship a
detector runtime or a FastText dependency.

## Evidence boundary

`TextLanguageClassifier` returns `ClassifiedLanguageEvidence`. Calibrated
evidence always contains `detectedLanguage`, `confidence`, `detectorVersion`,
and `calibrationVersion`. Every non-calibrated status forbids confidence and a
calibration version.

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
