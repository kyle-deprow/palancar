# ADR 0000: Registry-driven target-language gate

Status: Accepted

Date: 2026-08-09

## Context

Palancar's first language foundation must support an English-speaking wearer
selecting either Spanish (`es`) or Turkish (`tr`) for a session. The target
language is a session choice, and only an authoritative final transcript may
cross the generation boundary. The initial implementation must be independent
of a cloud transcription provider and must not imply that small controlled
fixtures measure detector accuracy.

## Decision

Each session has exactly one selected target language, chosen from the immutable
language registry. The registry is the source of target display metadata,
advisory transcription hints, confidence thresholds, mixed-language policy, and
fixture-suite identifiers. The initial entries are Spanish and Turkish with
the same policy shape and an initial confidence threshold of `0.80`.

The gate uses registry lookup and generic language-code comparisons. Its core
implementation contains no Spanish- or Turkish-specific branches. A final
selected-target result is generation-eligible only when evidence meets the
selected registry entry's threshold. Confidence is valid only when it is finite
and within the closed interval `[0, 1]`; values outside that interval are
uncertain even when they exceed the numeric threshold. Provisional revisions, English,
mixed-language evidence, the other enabled target, unsupported languages, and
uncertain evidence are never generation-eligible.

The v1 mixed-language policy is `reject`. A single mixed-language label cannot
establish that enough selected-target content is safe for translation or
response generation, so mixed evidence remains outside the generation
boundary.

Transcription hints are advisory only. A hint may influence a future provider's
recognition behavior, but it cannot authorize generation; authorization comes
from finalized evidence evaluated by the registry-driven gate.

## Controlled fixtures and detector accuracy

The controlled fixtures package contains an aligned, typed policy matrix for
each selected target, with synthetic finalized-text evidence including the
selected target, every other enabled target, English, mixed,
unsupported, low-confidence, missing-language, and provisional cases. These
fixtures test policy behavior only and make no claim about detector accuracy.
Detector selection, physical microphone conditions, measured thresholds, and
accuracy evidence are deferred to the physical-G2 transcription spike.

## Extension and conformance rule

Every newly enabled target language must receive the same conformance suite as
every existing target. The suite must prove self-acceptance, rejection of
English, mixed evidence, and each other enabled target, plus provisional,
uncertain, unsupported-selection, and immutable-registry behavior. Each target
also receives an independently measured confidence threshold and false-accept
and false-reject evidence before it can authorize generation.

Adding a target is a registry and fixture change, not a language-specific gate
branch. Any change to mixed-language behavior requires a new ADR before mixed
evidence can cross the generation boundary.
