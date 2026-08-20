# Relay language boundary modes

The relay keeps fixture, deny-all, production-approved, and development
provisional language boundaries distinct. `development-provisional` is enabled
only by the exact `PALANCAR_LANGUAGE_BOUNDARY_MODE=development-provisional`
setting in the `dev` Azure deployment slot. It is rejected by local-mock,
staging, and production configurations and is never selected by default.

The dev implementation lazily imports the installed local `eld/small` 2.1.0
module on first provisional classification, creates one isolated detector for
source and generated-language checks, and makes no network or model call.
Deny-all and production-calibrated host composition do not initialize the ELD
detector. Provisional readiness resolves only after module loading, detector
construction, and exact reliable Spanish, Turkish, and English sanity
detections, so malformed or semantically incompatible initialization keeps
`/readyz` closed. Input is NFKC-normalized and bounded to 512 Unicode code
points by the symmetric `eld-small-dev-5` profile. Within that bound every
qualifying clause and every overlapping one-through-eight-word window is
inspected. A conflicting interval is strong only when its raw score and margin
meet the profile thresholds; text above the bound is uncertain and cannot
authorize release. Source text must first have a reliable selected-target full
detection. Its minimal conflicting cores reject when one core has at least two
words or when two distinct singleton positions survive; exactly one singleton
core is accepted with reason `MATCH_IGNORED_SINGLETON`. Generated output keeps
the strict existential rule, so one reliable conflicting word in any generated
slot rejects the output. ELD's exact no-detection tuple (an empty language, no
score keys, and an unreliable result) is treated only as a weak internal
unknown: it is ignored as an isolated window, cannot satisfy readiness, and
cannot authorize a full source or generated result. Every other empty or
mismatched detector shape fails closed. Metrics contain only bounded
mode/reason/detected labels and raw-score basis points—never source or generated
text. The raw score is not probability, confidence, or calibration.

This is a development prototype only. Physical-G2 evidence and an approved ADR
with calibrated symmetric Spanish/Turkish results remain mandatory before any
production language-boundary promotion.
