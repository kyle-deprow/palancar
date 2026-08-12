# Luna handoff — LiteLLM generation provider

## Objective

Implement a real LiteLLM OpenAI-compatible chat provider in
`packages/generation`, with unit tests. This slice must not touch relay,
infrastructure, Docker, Azure, or deployment files.

## Files you may change

- `packages/generation/src/litellm.ts`
- `packages/generation/src/index.ts`
- `packages/generation/test/litellm-provider.test.ts`
- `packages/generation/package.json` only if a runtime dependency is truly
  required; prefer no dependency.

## Files you must not change

- Any file outside `packages/generation`.
- Existing `packages/generation/src/service.ts` contract unless the task is
  impossible without it; if so, stop and report a blocker.
- `package-lock.json`, unless `package.json` must change.
- Any generated `dist/**` file.

## Requirements

- Read `/home/dev/repos/palancar_ws/palancar/.codex/plans/litellm-openrouter-generation-plan.md`
  before editing.
- Add `LiteLLMChatGenerationProvider` implementing `GenerationProvider`.
- Config:
  - `baseUrl`: HTTP/HTTPS URL with no query/fragment; normalize trailing slash.
  - `apiKey`: nonempty string.
  - `model`: nonempty string, max 128.
  - `timeoutMs`: positive integer, recommended default 15_000, max 60_000.
  - `maxResponseBytes`: positive integer, default 16_384, max 16_384.
  - `maxTokens`: positive integer, default 1_024, max 1_024.
  - optional `id`/`version` with provider-safe values.
- Use Node 22 global `fetch`; do not add dependencies unless necessary.
- POST to `<baseUrl>/v1/chat/completions`.
- Include:
  - `Authorization: Bearer <apiKey>`
  - `content-type: application/json`
  - `model`
  - `stream: false`
  - small `temperature`
  - bounded `max_tokens`
  - strict JSON-schema `response_format` with:
    - `type: "json_schema"`
    - stable schema names
    - `strict: true`
    - `additionalProperties: false` at every object level
- Translation result JSON schema:
  - object with only required string field `englishTranslation`.
- Suggestion result JSON schema:
  - object with required `suggestions`, array min 2 max 3.
  - each item object with required string fields `englishText` and
    `selectedTargetText`.
- Prompts must instruct:
  - translate from selected target language to English.
  - suggest 2-3 concise likely English responses and selected-target-language
    equivalents.
  - output JSON only.
- Do not retain conversation history.
- Redaction:
  - Never include API key, transcript text, translation text, suggestion text,
    prompt text, response bodies, or provider error bodies in thrown errors.
  - Provider HTTP/network failures should throw a generic error so
    `GenerationService` maps to `provider-failure`.
  - Malformed generated JSON should also fail generically under the current
    service contract.
- Defensive parsing:
  - Reject non-object response envelopes.
  - Reject missing `choices[0].message.content`.
  - Reject tool calls/refusals when present.
  - Reject finish reasons other than `stop`.
  - Reject content over `maxResponseBytes` before JSON parse.
  - Parse JSON content and return plain objects for service validation.

## Tests

Create `packages/generation/test/litellm-provider.test.ts`.

Mock `globalThis.fetch` with Vitest; no real network calls.

Test at least:

- Constructor rejects invalid config without leaking values.
- `translate()` sends the expected URL, bearer auth, model, non-streaming body,
  strict response schema, and returns `{ englishTranslation }`.
- `suggest()` sends suggestion schema and returns `{ suggestions }`.
- Non-2xx response throws generic error with no secret or body content.
- Network failure throws generic error with no secret/content.
- Missing choice/content, non-stop finish reason, refusal, tool calls,
  overlarge content, and malformed JSON all fail generically.
- No thrown error includes canary API key, transcript, translation,
  suggestion, or provider response body.

## Verification

Run and report actual output:

```sh
npm run lint -w @palancar/generation
npm run typecheck -w @palancar/generation
npm run test -w @palancar/generation
```

## Completion report

Report:

- changed files
- verification commands and actual results
- unresolved issues

End with `DONE` only if complete.
