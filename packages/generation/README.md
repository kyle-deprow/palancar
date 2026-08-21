# Direct Azure OpenAI generation

Generation uses the direct Azure OpenAI v1 chat-completions endpoint through
`AzureOpenAIChatGenerationProvider`. It sends one bounded, non-streaming
request to the configured deployment and validates the returned English and
selected-target-language text before returning it.

Authentication is Entra-only. The provider accepts an injected
`AzureTokenProvider`; it has no API-key configuration or authentication
fallback. Endpoints must be canonical HTTPS Azure OpenAI origins, and the
provider uses the fixed `/openai/v1/chat/completions` path with a fixed
15-second deadline and 8,192-byte response bound.

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
