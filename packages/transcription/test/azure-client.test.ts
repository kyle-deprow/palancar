import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AZURE_REALTIME_APPEND_MAX_BYTES,
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
