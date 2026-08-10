# Luna fix handoff: relay core Sol review findings

## Objective

Fix the relay-core implementation defects found by Sol review. This is a narrow fix task; do not redesign the relay or add network/Azure behavior.

## Files you may change

- `apps/relay/src/session.ts`
- `apps/relay/test/relay-core.test.ts`

## Files and actions you must not change

- Do not edit package manifests, lockfiles, docs, infra, generated `dist`, existing packages, or G2 client files.
- Do not commit.

## Required fixes

1. **Pre-ready first-message classification**
   - In `RelaySessionCore.openWithFirstText` / `#parsePreReady`, determine the expected first message type from `ticketClaim.intent.intent` immediately after JSON parsing:
     - new ticket expects `session.start`;
     - resume ticket expects `session.resume`.
   - If parsed control `type` is the opposite session type or any other known client control type (`utterance.start`, `utterance.commit`, `utterance.cancel`, `session.end`), reject with `session.rejected` code `authentication_failed`, close `{ code: 4401, reason: 'authentication_failed' }`, even if the message is schema-incomplete.
   - If `type` is missing/unknown, reject malformed as before.
   - Only classify unsupported protocol version or unsupported target language when the relevant field has the correct primitive type:
     - `typeof protocolVersion === 'number' && protocolVersion !== 1` -> `unsupported_protocol_version` / `1002` / `unsupported_protocol`;
     - `typeof targetLanguage === 'string' && targetLanguage !== 'es' && targetLanguage !== 'tr'` -> `unsupported_target_language` / `1008` / `unsupported_target`.
   - Wrong primitive types such as `"protocolVersion": "1"` or `"targetLanguage": 7` must be `malformed_message` / `1002` / `protocol_error`.

2. **Commit idempotency and conflict**
   - Track the committed final offset.
   - Repeating the same `utterance.commit` for the same active utterance and same final offset is idempotent and returns no outgoing messages.
   - Repeating commit for the same active utterance with a different `finalOriginalSampleOffset` must emit generic `error` code `flow_control`, scope `audio`, recoverable `false`, close `{ code: 1002, reason: 'protocol_error' }`, and cleanup terminal state.

3. **Audio after commit**
   - Once an utterance is committed, any later binary audio for that utterance before final provider event is a protocol error.
   - It must emit generic `error` code `flow_control`, scope `audio`, recoverable `false`, close `{ code: 1002, reason: 'protocol_error' }`, cleanup active transcription, and must not forward audio or emit `audio.ack`.

4. **Test gaps from Sol review**
   - Add tests for:
     - new-ticket first `{"type":"session.resume"}` returns authentication_failed/4401, not malformed;
     - resume-ticket first `{"type":"session.start"}` returns authentication_failed/4401;
     - wrong-typed `protocolVersion: "1"` is malformed/1002, not unsupported protocol;
     - wrong-typed `targetLanguage: 7` is malformed/1002, not unsupported target;
     - conflicting repeated commits close 1002;
     - audio after commit closes 1002 and does not forward/ACK;
     - actual overlap frame path, not just gap/stale/conflict;
     - accepted audio verifies forwarded `originalSampleOffset`;
     - provider-loss/terminal cleanup asserts `closeCalls`;
     - thrown transcription-provider canary string is absent from serialized result.

## Verification

Run and report actual outputs:

- `npm run lint -w @palancar/relay`
- `npm run typecheck -w @palancar/relay`
- `npm run test -w @palancar/relay`
- `npm run build -w @palancar/relay`
- `git diff --check -- apps/relay/src/session.ts apps/relay/test/relay-core.test.ts`

## Completion report

List changed files, verification outputs, unresolved risks. End with `DONE` only if all fixes and checks pass.
