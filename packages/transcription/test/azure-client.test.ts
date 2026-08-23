import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AZURE_REALTIME_APPEND_MAX_BYTES,
  DEFAULT_AZURE_REALTIME_SERVER_VAD_PREFIX_PADDING_MS,
  DEFAULT_AZURE_REALTIME_SERVER_VAD_SILENCE_DURATION_MS,
  DEFAULT_AZURE_REALTIME_SERVER_VAD_THRESHOLD,
  MAX_AZURE_REALTIME_APPEND_BYTES,
  AzureRealtimeClientMessageError,
  buildAzureRealtimeInputAudioAppendMessage,
  buildAzureRealtimeInputAudioClearMessage,
  buildAzureRealtimeInputAudioCommitMessage,
  buildAzureRealtimeSessionUpdateMessage
} from '../src/azure-client.js';

function expectReason(run: () => unknown, reason: string): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AzureRealtimeClientMessageError);
  expect(error).toMatchObject({ reason });
}

describe('Azure Realtime client message builders', () => {
  it('builds the exact transcription session update without a language key', () => {
    const message = buildAzureRealtimeSessionUpdateMessage('transcribe-prod');

    expect(message).toEqual({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: null,
            transcription: { model: 'transcribe-prod' }
          }
        }
      }
    });
    expect(message).not.toHaveProperty('language');
    expect(message.session.audio.input.transcription).not.toHaveProperty('language');
    expect(Object.getPrototypeOf(message)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(message.session)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(message.session.audio)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(message.session.audio.input)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(message.session.audio.input.format)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(message.session.audio.input.transcription)).toBe(Object.prototype);
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.session)).toBe(true);
    expect(Object.isFrozen(message.session.audio)).toBe(true);
    expect(Object.isFrozen(message.session.audio.input)).toBe(true);
    expect(Object.isFrozen(message.session.audio.input.format)).toBe(true);
    expect(Object.isFrozen(message.session.audio.input.transcription)).toBe(true);
  });

  it.each(['es', 'tr'] as const)('builds a selected-target transcription update for %s', (language) => {
    const message = buildAzureRealtimeSessionUpdateMessage('transcribe-prod', {
      languageMode: 'selected-target',
      languageHint: language
    });
    expect(message.session.audio.input.transcription).toEqual({
      model: 'transcribe-prod',
      language
    });
    expect(message).not.toHaveProperty('selectedTargetLanguage');
    expect(JSON.stringify(message)).not.toContain('selectedTargetLanguage');
    expect(Object.isFrozen(message.session.audio.input.transcription)).toBe(true);
  });

  it('builds the exact server-VAD transcription session variant', () => {
    const message = buildAzureRealtimeSessionUpdateMessage('transcribe-prod', {
      languageMode: 'automatic',
      serverVadMode: 'enabled'
    });

    expect(message.session.audio.input.turn_detection).toEqual({
      type: 'server_vad',
      threshold: DEFAULT_AZURE_REALTIME_SERVER_VAD_THRESHOLD,
      prefix_padding_ms: DEFAULT_AZURE_REALTIME_SERVER_VAD_PREFIX_PADDING_MS,
      silence_duration_ms: DEFAULT_AZURE_REALTIME_SERVER_VAD_SILENCE_DURATION_MS
    });
    expect(Object.isFrozen(message.session.audio.input.turn_detection)).toBe(true);
  });

  it('rejects malformed or non-exact language options', () => {
    for (const options of [
      { languageMode: 'automatic', languageHint: 'es' },
      { languageMode: 'selected-target' },
      { languageMode: 'selected-target', languageHint: 'ES' },
      { languageMode: 'selected-target', languageHint: 'spa' },
      { languageMode: 'selected-target', languageHint: ' es' },
      { languageMode: 'selected-target', languageHint: 'es', extra: true },
      { languageMode: 'automatic', serverVadMode: 'unknown' },
      { languageMode: 'automatic', serverVadMode: 'enabled', extra: true },
      { languageMode: 'unknown' },
      null,
      'automatic'
    ]) {
      expectReason(
        () => buildAzureRealtimeSessionUpdateMessage('transcribe-prod', options as never),
        'invalid-options'
      );
    }
  });

  it('rejects hostile option objects without invoking or mutating caller state', () => {
    let getterReads = 0;
    const changingGetter = { languageMode: 'selected-target' } as Record<string, unknown>;
    Object.defineProperty(changingGetter, 'languageHint', {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return getterReads === 1 ? 'es' : 'tr';
      }
    });
    expectReason(
      () => buildAzureRealtimeSessionUpdateMessage('transcribe-prod', changingGetter as never),
      'invalid-options'
    );
    expect(getterReads).toBe(0);

    const throwingGetter = { languageMode: 'selected-target' } as Record<string, unknown>;
    Object.defineProperty(throwingGetter, 'languageHint', {
      enumerable: true,
      get: () => { throw new Error('getter must not run'); }
    });
    expectReason(
      () => buildAzureRealtimeSessionUpdateMessage('transcribe-prod', throwingGetter as never),
      'invalid-options'
    );

    const proxy = new Proxy({ languageMode: 'selected-target', languageHint: 'es' }, {
      get: () => { throw new Error('proxy getter must not run'); }
    });
    expectReason(
      () => buildAzureRealtimeSessionUpdateMessage('transcribe-prod', proxy as never),
      'invalid-options'
    );

    const symbolKey = {
      languageMode: 'selected-target',
      languageHint: 'es',
      [Symbol('unexpected')]: true
    } as never;
    expectReason(
      () => buildAzureRealtimeSessionUpdateMessage('transcribe-prod', symbolKey),
      'invalid-options'
    );

    const hiddenKey = { languageMode: 'selected-target', languageHint: 'es' } as Record<string, unknown>;
    Object.defineProperty(hiddenKey, 'unexpected', { value: true, enumerable: false });
    expectReason(
      () => buildAzureRealtimeSessionUpdateMessage('transcribe-prod', hiddenKey as never),
      'invalid-options'
    );

    const invalidLanguage = { languageMode: 'selected-target', languageHint: 'zz' };
    const before = { ...invalidLanguage };
    expectReason(
      () => buildAzureRealtimeSessionUpdateMessage('transcribe-prod', invalidLanguage as never),
      'invalid-options'
    );
    expect(invalidLanguage).toEqual(before);

    const validLanguage = { languageMode: 'selected-target', languageHint: 'es' };
    const message = buildAzureRealtimeSessionUpdateMessage('transcribe-prod', validLanguage as never);
    validLanguage.languageHint = 'tr';
    expect(message.session.audio.input.transcription).toEqual({
      model: 'transcribe-prod',
      language: 'es'
    });
  });

  it('builds base64 append messages and synchronously owns the source bytes', () => {
    const pcm = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const message = buildAzureRealtimeInputAudioAppendMessage(pcm, { maxBytes: 6 });
    pcm.fill(0);

    expect(message).toEqual({
      type: 'input_audio_buffer.append',
      audio: 'AAEC/f7/'
    });
    expect(Object.isFrozen(message)).toBe(true);
  });

  it('builds exact commit and clear messages', () => {
    const commit = buildAzureRealtimeInputAudioCommitMessage();
    const clear = buildAzureRealtimeInputAudioClearMessage();

    expect(commit).toEqual({ type: 'input_audio_buffer.commit' });
    expect(clear).toEqual({ type: 'input_audio_buffer.clear' });
    expect(Object.isFrozen(commit)).toBe(true);
    expect(Object.isFrozen(clear)).toBe(true);
  });

  it('accepts append sizes at the configured and default boundaries', () => {
    expect(
      buildAzureRealtimeInputAudioAppendMessage(
        new Uint8Array(2),
        { maxBytes: 2 }
      )
    ).toEqual({ type: 'input_audio_buffer.append', audio: 'AAA=' });
    expect(
      buildAzureRealtimeInputAudioAppendMessage(
        new Uint8Array(DEFAULT_AZURE_REALTIME_APPEND_MAX_BYTES)
      ).audio
    ).toHaveLength(Math.ceil(DEFAULT_AZURE_REALTIME_APPEND_MAX_BYTES / 3) * 4);
    expect(
      buildAzureRealtimeInputAudioAppendMessage(
        new Uint8Array(MAX_AZURE_REALTIME_APPEND_BYTES),
        { maxBytes: MAX_AZURE_REALTIME_APPEND_BYTES }
      )
    ).toHaveProperty('type', 'input_audio_buffer.append');
  });

  it('rejects empty, oversized, and invalid append inputs', () => {
    expectReason(
      () => buildAzureRealtimeInputAudioAppendMessage(new Uint8Array()),
      'invalid-audio'
    );
    expectReason(
      () => buildAzureRealtimeInputAudioAppendMessage(new Uint8Array(4), { maxBytes: 2 }),
      'invalid-audio'
    );
    expectReason(
      () => buildAzureRealtimeInputAudioAppendMessage(new Uint8Array(1)),
      'invalid-audio'
    );
    expectReason(
      () => buildAzureRealtimeInputAudioAppendMessage(new Uint8Array(2), { maxBytes: 0 }),
      'invalid-options'
    );
    expectReason(
      () => buildAzureRealtimeInputAudioAppendMessage(new Uint8Array(2), { maxBytes: 3 }),
      'invalid-options'
    );
    expectReason(
      () => buildAzureRealtimeInputAudioAppendMessage(new Uint8Array(1), {
        maxBytes: MAX_AZURE_REALTIME_APPEND_BYTES + 1
      }),
      'invalid-options'
    );
    expectReason(
      () => buildAzureRealtimeInputAudioAppendMessage(new Uint8Array(1), {
        maxBytes: 1,
        extra: true
      } as never),
      'invalid-options'
    );
    expectReason(
      () => buildAzureRealtimeInputAudioAppendMessage(new Uint8Array(1), {
        maxBytes: 1.5
      }),
      'invalid-options'
    );
  });

  it('rejects deployment values outside the strict bounded pattern', () => {
    for (const deployment of [
      '',
      'Adeployment',
      '-deployment',
      'deployment-',
      'deployment name',
      'deployment/name',
      'deployment_name',
      'deployment.name',
      'x'.repeat(65)
    ]) {
      expectReason(
        () => buildAzureRealtimeSessionUpdateMessage(deployment),
        'invalid-deployment'
      );
    }

    expect(() => buildAzureRealtimeSessionUpdateMessage('a'.repeat(64))).not.toThrow();
    expect(() => buildAzureRealtimeSessionUpdateMessage('gpt-5-6-luna-2026-07-09')).not.toThrow();
  });

  it('does not expose caller values through typed validation errors', () => {
    const deployment = 'secret-deployment-value';
    let error: unknown;
    try {
      buildAzureRealtimeSessionUpdateMessage(deployment + '!');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AzureRealtimeClientMessageError);
    expect(String(error)).not.toContain(deployment);
    expect(JSON.stringify(error)).not.toContain(deployment);
  });
});
