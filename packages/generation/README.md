# Generated-language validation

Generation validates every English and selected-target output before returning
model text. Services default to `production-calibrated`, where only calibrated
evidence with non-null confidence basis points can pass.

The explicit `development-provisional` validation mode exists only for the dev
prototype. Its evidence uses `provisionalScoreBasisPoints` and requires
`confidenceBasisPoints: null`; the raw ELD-small score is not a probability,
confidence, or calibration result. Calibrated and provisional evidence cannot
be substituted for one another. Provisional validation snapshots exact plain
five- or seven-check inputs and fails closed on proxies, accessors, symbols,
descriptor changes, sparse arrays, or altered check topology.

Physical-G2 measurements and an approved calibration ADR remain the external
production gate. This package does not promote the provisional detector to a
production language boundary.
