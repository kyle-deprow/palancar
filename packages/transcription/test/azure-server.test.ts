import { describe, expect, it } from 'vitest';

import { MAX_CONTROL_MESSAGE_BYTES } from '@palancar/contracts';

import {
  AzureRealtimeServerEventError,
  parseAzureRealtimeServerEvent as parseServerEventInternal,
  type AzureRealtimeServerEventParserOptions
} from '../src/azure-server.js';

const EXPECTED_DEPLOYMENT = 'gpt-4o-mini-transcribe';
const MAX_JSON_BYTES = MAX_CONTROL_MESSAGE_BYTES;
const MAX_TEXT_BYTES = 4_096;
const MAX_CONTENT_INDEX = 255;
const MAX_LOGPROBS = 128;
const MAX_LOGPROB_TOKEN_BYTES = 256;
const MAX_LOGPROB_BYTES = 256;
const MAX_EVENT_ID_BYTES = 128;
const MAX_OBFUSCATION_BYTES = 256;
const MAX_PROVIDER_STRING_BYTES = 256;
const LANGUAGE_CODE_BYTES = 2;
const MAX_LANGUAGES = 16;
const MAX_KEYWORDS = 64;
const MAX_KEYWORD_BYTES = 256;
const MAX_USAGE_COUNT = 1_000_000;
const MAX_DEPLOYMENT_BYTES = 64;
const MAX_TURN_DETECTION_MS = 60_000;
const MAX_AUDIO_OFFSET_MS = 86_400_000;
const MAX_SEGMENT_SECONDS = 86_400;

function parseServerEvent(
  input: string | Uint8Array,
  options: Partial<AzureRealtimeServerEventParserOptions> = {}
) {
  return parseServerEventInternal(input, {
    expectedDeployment: EXPECTED_DEPLOYMENT,
    ...options
  });
}

function expectReason(run: () => unknown, reason: string): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AzureRealtimeServerEventError);
  expect(error).toMatchObject({ reason });
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function providerEvent(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function logprob(index: number): Record<string, unknown> {
  return { token: `t${index}`, bytes: [116], logprob: -0.25 };
}

const createdSession = {
  type: 'transcription',
  object: 'realtime.transcription_session',
  id: 'sess_C9G5QPteg4UIbotdKLoYQ',
  expires_at: 1_800_000_000
};

const session = {
  type: 'transcription',
  object: 'realtime.transcription_session',
  id: 'sess_C9G5QPteg4UIbotdKLoYQ',
  expires_at: 1_800_000_000,
  audio: {
    input: {
      format: { type: 'audio/pcm', rate: 24_000 },
      transcription: {
        model: EXPECTED_DEPLOYMENT,
        languages: ['en', 'es'],
        prompt: 'Customer support terminology',
        delay: 'medium'
      },
      noise_reduction: { type: 'far_field' },
      turn_detection: null
    }
  },
  include: ['item.input_audio_transcription.logprobs']
};

function deltaEvent(delta = 'hello'): Record<string, unknown> {
  return {
    type: 'conversation.item.input_audio_transcription.delta',
    event_id: 'event_CCXGRxsAimPAs8kS2Wc7Z',
    item_id: 'item_CCXGQ4e1ht4cOraEYcuR2',
    content_index: 0,
    delta
  };
}

function completedEvent(transcript = 'hello'): Record<string, unknown> {
  return {
    type: 'conversation.item.input_audio_transcription.completed',
    event_id: 'event_CCXGRvtUVrax5SJAnNOWZ',
    item_id: 'item_CCXGQ4e1ht4cOraEYcuR2',
    content_index: 0,
    transcript,
    usage: {
      type: 'tokens',
      total_tokens: 2,
      input_tokens: 1,
      output_tokens: 1
    }
  };
}

function segmentEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'conversation.item.input_audio_transcription.segment',
    event_id: 'event_6501',
    id: 'seg_0001',
    item_id: 'msg_011',
    content_index: 0,
    text: 'hello',
    speaker: 'spk_1',
    start: 0,
    end: 0.4,
    ...overrides
  };
}

describe('Azure Realtime GA server event parser', () => {
  it('requires and validates the expected deployment', () => {
    const event = providerEvent({
      type: 'input_audio_buffer.cleared',
      event_id: 'event_options'
    });
    expectReason(
      () => parseServerEventInternal(event, undefined as never),
      'invalid-input'
    );
    for (const expectedDeployment of [
      '',
      '-leading',
      'trailing-',
      'UPPER',
      'a'.repeat(MAX_DEPLOYMENT_BYTES + 1),
      '\ud800'
    ]) {
      expectReason(
        () => parseServerEvent(event, { expectedDeployment }),
        'invalid-input'
      );
    }
    const maxDeployment = `a${'b'.repeat(MAX_DEPLOYMENT_BYTES - 2)}z`;
    expect(new TextEncoder().encode(maxDeployment)).toHaveLength(MAX_DEPLOYMENT_BYTES);
    expect(parseServerEvent(event, { expectedDeployment: maxDeployment })).toEqual({
      type: 'input_audio_buffer.cleared'
    });
    expectReason(
      () => parseServerEventInternal(event, {
        expectedDeployment: EXPECTED_DEPLOYMENT,
        unknown: true
      } as never),
      'invalid-input'
    );
  });

  it('enforces custom JSON byte limits and the maxBytes alias with multibyte input', () => {
    const multibyte = providerEvent({
      type: 'error',
      event_id: 'event_multibyte_limit',
      error: { type: 'server_error', message: '😀' }
    });
    const exactBytes = new TextEncoder().encode(multibyte).byteLength;
    expect(parseServerEvent(multibyte, { maxJsonBytes: exactBytes })).toEqual({
      type: 'error',
      category: 'protocol-failure'
    });
    expect(parseServerEvent(new TextEncoder().encode(multibyte), {
      maxBytes: exactBytes
    })).toEqual({ type: 'error', category: 'protocol-failure' });
    for (const input of [multibyte, new TextEncoder().encode(multibyte)]) {
      expectReason(
        () => parseServerEvent(input, { maxJsonBytes: exactBytes - 1 }),
        'oversize'
      );
      expectReason(
        () => parseServerEvent(input, { maxBytes: exactBytes - 1 }),
        'oversize'
      );
    }
    expectReason(() => parseServerEvent(multibyte, {
      maxJsonBytes: exactBytes,
      maxBytes: exactBytes
    }), 'invalid-input');
    for (const maxJsonBytes of [0, MAX_JSON_BYTES + 1, 1.5]) {
      expectReason(
        () => parseServerEvent(multibyte, { maxJsonBytes }),
        'invalid-input'
      );
    }
  });

  it('accepts realistic provider fixtures and normalizes safe fields only', () => {
    expect(parseServerEvent(providerEvent({
      type: 'session.created',
      event_id: 'event_C9G5RJeJ2gF77mV7f2B1j',
      session: createdSession
    }))).toEqual({
      type: 'session.created',
      session: {
        type: 'transcription',
        id: createdSession.id,
        phase: 'basic',
        configured: false
      }
    });
    expect(parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_C9G5RJeJ2gF77mV7f2B2j',
      session: { ...session, audio: session.audio }
    }))).toEqual({
      type: 'session.updated',
      session: {
        type: 'transcription',
        id: session.id,
        phase: 'configured',
        configured: true
      }
    });
    expect(parseServerEvent(providerEvent({
      type: 'input_audio_buffer.committed',
      event_id: 'event_1121',
      item_id: 'msg_002',
      previous_item_id: 'msg_001'
    }))).toEqual({
      type: 'input_audio_buffer.committed',
      item_id: 'msg_002',
      previous_item_id: 'msg_001'
    });
    expect(parseServerEvent(providerEvent({
      type: 'input_audio_buffer.cleared',
      event_id: 'event_1314'
    }))).toEqual({ type: 'input_audio_buffer.cleared' });
    expect(parseServerEvent(providerEvent({
      ...deltaEvent(),
      obfuscation: 'aLxx0jTEciOGe',
      logprobs: [logprob(1)]
    }))).toEqual({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item_CCXGQ4e1ht4cOraEYcuR2',
      content_index: 0,
      delta: 'hello',
      obfuscation: 'aLxx0jTEciOGe',
      logprobs: { count: 1, present: true }
    });
    expect(parseServerEvent(providerEvent({
      ...completedEvent(),
      languages: [{ code: 'en' }, { code: 'es' }],
      usage: {
        type: 'tokens',
        total_tokens: 22,
        input_tokens: 13,
        input_token_details: { text_tokens: 0, audio_tokens: 13 },
        output_tokens: 9
      }
    }))).toEqual({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_CCXGQ4e1ht4cOraEYcuR2',
      content_index: 0,
      transcript: 'hello',
      languages: { count: 2, codes: ['en', 'es'] },
      usage: {
        type: 'tokens',
        total_tokens: 22,
        input_tokens: 13,
        input_token_details: { text_tokens: 0, audio_tokens: 13 },
        output_tokens: 9
      }
    });
    expect(parseServerEvent(providerEvent(segmentEvent()))).toEqual({
      type: 'conversation.item.input_audio_transcription.segment',
      id: 'seg_0001',
      item_id: 'msg_011',
      content_index: 0,
      text: 'hello',
      speaker: 'spk_1',
      start: 0,
      end: 0.4
    });
    expect(parseServerEvent(providerEvent({
      type: 'conversation.item.input_audio_transcription.failed',
      event_id: 'event_2324',
      item_id: 'msg_003',
      content_index: 0,
      error: {
        type: 'transcription_error',
        code: 'audio_unintelligible',
        message: 'The audio could not be transcribed.',
        param: null
      }
    }))).toEqual({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'msg_003',
      content_index: 0,
      category: 'provider-failure'
    });
    expect(parseServerEvent(providerEvent({
      type: 'error',
      event_id: 'event_890',
      error: {
        type: 'invalid request/error',
        code: 'provider code with spaces',
        message: 'provider text',
        param: '',
        event_id: null
      }
    }))).toEqual({ type: 'error', category: 'protocol-failure' });
  });

  it('requires a bounded event_id on every supported server event', () => {
    const events = [
      { type: 'session.created', session },
      { type: 'session.updated', session },
      {
        type: 'input_audio_buffer.committed',
        item_id: 'msg_002',
        previous_item_id: null
      },
      { type: 'input_audio_buffer.cleared' },
      {
        type: 'input_audio_buffer.speech_started',
        item_id: 'item_speech',
        audio_start_ms: 0
      },
      {
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'item_speech',
        audio_end_ms: 1
      },
      {
        type: 'input_audio_buffer.timeout_triggered',
        item_id: 'item_timeout',
        audio_start_ms: 0,
        audio_end_ms: 1
      },
      {
        type: 'conversation.item.created',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_audio' }]
        }
      },
      { ...deltaEvent(), event_id: undefined },
      { ...completedEvent(), event_id: undefined },
      { ...segmentEvent(), event_id: undefined },
      {
        type: 'conversation.item.input_audio_transcription.failed',
        item_id: 'msg_003',
        content_index: 0,
        error: {}
      },
      {
        type: 'error',
        error: { type: 'server_error', message: 'provider failure' }
      }
    ];
    for (const event of events) {
      expectReason(() => parseServerEvent(providerEvent(event)), 'invalid-field');
    }
    expectReason(
      () => parseServerEvent(providerEvent({
        ...deltaEvent(),
        event_id: `e${'x'.repeat(MAX_EVENT_ID_BYTES)}`
      })),
      'invalid-field'
    );
  });

  it('validates realistic session configuration without exposing it', () => {
    expectReason(() => parseServerEvent(providerEvent({
      type: 'session.created',
      event_id: 'event_1'
    })), 'invalid-event');
    expectReason(() => parseServerEvent(providerEvent({
      type: 'session.created',
      event_id: 'event_1',
      session: { type: 'transcription' }
    })), 'invalid-event');
    expectReason(() => parseServerEvent(providerEvent({
      type: 'session.created',
      event_id: 'event_1',
      session: { ...session, id: 'not an id' }
    })), 'invalid-field');
    expectReason(() => parseServerEvent(providerEvent({
      type: 'session.created',
      event_id: 'event_1',
      session: {
        ...session,
        audio: {
          input: {
            ...session.audio.input,
            format: { type: 'audio/pcm', rate: 8_000 }
          }
        }
      }
    })), 'invalid-field');
    const result = parseServerEvent(providerEvent({
      type: 'session.created',
      event_id: 'event_1',
      session
    }));
    expect(result).toEqual({
      type: 'session.created',
      session: {
        type: 'transcription',
        id: session.id,
        phase: 'basic',
        configured: false
      }
    });
    expect(JSON.stringify(result)).not.toContain('Customer support terminology');
    expect(Object.isFrozen(result)).toBe(true);
    if (result.type === 'session.created' || result.type === 'session.updated') {
      expect(Object.isFrozen(result.session)).toBe(true);
    }
  });

  it('accepts bounded basic created sessions without claiming readiness', () => {
    const basicFixtures = [
      { ...createdSession },
      { ...createdSession, audio: {} },
      { ...createdSession, audio: { input: {} } },
      {
        ...createdSession,
        audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' } } }
      }
    ];
    for (const basicSession of basicFixtures) {
      expect(parseServerEvent(providerEvent({
        type: 'session.created',
        event_id: 'event_basic',
        session: basicSession
      }))).toEqual({
        type: 'session.created',
        session: {
          type: 'transcription',
          id: createdSession.id,
          phase: 'basic',
          configured: false
        }
      });
    }

    expect(parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_basic_updated',
      session: createdSession
    }))).toEqual({
      type: 'session.updated',
      session: {
        type: 'transcription',
        id: createdSession.id,
        phase: 'basic',
        configured: false
      }
    });
  });

  it('marks updated sessions configured only for the exact deployment and manual PCM24k', () => {
    const configured = parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_configured',
      session
    }));
    expect(configured).toMatchObject({
      session: { phase: 'configured', configured: true }
    });

    const baseInput = session.audio.input;
    const unconfiguredInputs = [
      {
        ...baseInput,
        transcription: { ...baseInput.transcription, model: 'another-deployment' }
      },
      {
        ...baseInput,
        format: { type: 'audio/pcmu' }
      },
      {
        format: baseInput.format,
        transcription: baseInput.transcription
      },
      {
        ...baseInput,
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      },
      {
        format: baseInput.format,
        turn_detection: null
      },
      {
        ...baseInput,
        format: {}
      },
      {
        ...baseInput,
        format: { type: 'audio/pcm' }
      },
      {
        ...baseInput,
        format: { rate: 24_000 }
      }
    ];
    for (const input of unconfiguredInputs) {
      expect(parseServerEvent(providerEvent({
        type: 'session.updated',
        event_id: 'event_not_configured',
        session: { ...createdSession, audio: { input } }
      }))).toMatchObject({
        session: { phase: 'basic', configured: false }
      });
    }

    expect(parseServerEvent(providerEvent({
      type: 'session.created',
      event_id: 'event_created_exact_config',
      session
    }))).toMatchObject({
      session: { phase: 'basic', configured: false }
    });

    const configuredEvent = providerEvent({
      type: 'session.updated',
      event_id: 'event_deployment_scope',
      session
    });
    expect(parseServerEvent(configuredEvent, {
      expectedDeployment: 'other-deployment'
    })).toMatchObject({ session: { phase: 'basic', configured: false } });
    expect(parseServerEvent(configuredEvent, {
      expectedDeployment: EXPECTED_DEPLOYMENT
    })).toMatchObject({ session: { phase: 'configured', configured: true } });

    expectReason(() => parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_invalid_language_not_ready',
      session: {
        ...session,
        audio: {
          input: {
            ...session.audio.input,
            transcription: {
              ...session.audio.input.transcription,
              language: 'mixed'
            }
          }
        }
      }
    })), 'invalid-field');
  });

  it('accepts only the dedicated transcription-session GA response shape', () => {
    for (const invalidIdentity of [
      { ...createdSession, object: 'realtime.session' },
      { ...createdSession, type: 'realtime' }
    ]) {
      expectReason(() => parseServerEvent(providerEvent({
        type: 'session.created',
        event_id: 'event_wrong_session_kind',
        session: invalidIdentity
      })), 'invalid-field');
    }

    const serverVadSession = {
      ...createdSession,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          transcription: {
            model: EXPECTED_DEPLOYMENT,
            language: 'en',
            languages: [
              'es',
              ...Array.from(
                { length: MAX_LANGUAGES - 1 },
                () => 'en'
              )
            ],
            keywords: ['Palancar', 'customer support'],
            prompt: '',
            delay: 'xhigh'
          },
          noise_reduction: null,
          turn_detection: {
            type: 'server_vad',
            threshold: 1,
            prefix_padding_ms: MAX_TURN_DETECTION_MS,
            silence_duration_ms: 0,
            create_response: false,
            interrupt_response: true,
            idle_timeout_ms: MAX_TURN_DETECTION_MS
          }
        }
      }
    };
    expect(parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_server_vad',
      session: serverVadSession
    }))).toMatchObject({
      session: { phase: 'basic', configured: false }
    });

    expect(parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_semantic_vad',
      session: {
        ...serverVadSession,
        audio: {
          input: {
            ...serverVadSession.audio.input,
            turn_detection: {
              type: 'semantic_vad',
              create_response: true,
              interrupt_response: false,
              eagerness: 'auto'
            }
          }
        }
      }
    }))).toMatchObject({
      session: { phase: 'basic', configured: false }
    });

    const invalidInputs = [
      {
        ...serverVadSession.audio.input,
        turn_detection: { type: 'semantic_vad', threshold: 0.5 }
      },
      {
        ...serverVadSession.audio.input,
        turn_detection: { type: 'server_vad', eagerness: 'auto' }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, delay: 'instant' }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, languages: [] }
      },
      {
        ...serverVadSession.audio.input,
        transcription: {
          model: EXPECTED_DEPLOYMENT,
          languages: Array.from(
            { length: MAX_LANGUAGES + 1 },
            () => 'en'
          )
        }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, languages: ['EN'] }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, languages: ['mixed'] }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, languages: ['eng'] }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, languages: ['en-US'] }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, languages: ['zz'] }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, language: 'mixed' }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, language: 'eng' }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, language: 'en-US' }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, language: 'zz' }
      },
      {
        ...serverVadSession.audio.input,
        transcription: { model: EXPECTED_DEPLOYMENT, language: null }
      },
      {
        ...serverVadSession.audio.input,
        turn_detection: { type: 'server_vad', create_response: 'yes' }
      },
      {
        ...serverVadSession.audio.input,
        turn_detection: { type: 'semantic_vad', eagerness: 'instant' }
      }
    ];
    for (const input of invalidInputs) {
      expectReason(() => parseServerEvent(providerEvent({
        type: 'session.updated',
        event_id: 'event_invalid_transcription_session',
        session: { ...createdSession, audio: { input } }
      })), 'invalid-field');
    }
  });

  it('bounds transcription keywords and every GA turn-detection field', () => {
    const exactKeyword = '😀'.repeat(MAX_KEYWORD_BYTES / 4);
    expect(new TextEncoder().encode(exactKeyword)).toHaveLength(MAX_KEYWORD_BYTES);
    const keywordSession = {
      ...session,
      audio: {
        input: {
          ...session.audio.input,
          transcription: {
            ...session.audio.input.transcription,
            language: 'en',
            languages: Array.from({ length: MAX_LANGUAGES }, () => 'en'),
            keywords: [
              exactKeyword,
              ...Array.from({ length: MAX_KEYWORDS - 1 }, () => 'term')
            ]
          }
        }
      }
    };
    expect(parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_keyword_boundaries',
      session: keywordSession
    }))).toMatchObject({ session: { configured: true } });
    expect(parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_empty_keyword_and_noise_defaults',
      session: {
        ...session,
        audio: {
          input: {
            ...session.audio.input,
            transcription: { model: EXPECTED_DEPLOYMENT, keywords: [''] },
            noise_reduction: {}
          }
        }
      }
    }))).toMatchObject({ session: { configured: true } });
    for (const delay of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
      expect(parseServerEvent(providerEvent({
        type: 'session.updated',
        event_id: 'event_valid_delay',
        session: {
          ...session,
          audio: {
            input: {
              ...session.audio.input,
              transcription: {
                model: EXPECTED_DEPLOYMENT,
                delay
              }
            }
          }
        }
      }))).toMatchObject({ session: { configured: true } });
    }

    const invalidTranscriptions = [
      {
        model: EXPECTED_DEPLOYMENT,
        keywords: Array.from({ length: MAX_KEYWORDS + 1 }, () => 'term')
      },
      { model: EXPECTED_DEPLOYMENT, keywords: [`${exactKeyword}a`] },
      { model: EXPECTED_DEPLOYMENT, keywords: ['\ud800'] }
    ];
    for (const transcription of invalidTranscriptions) {
      expectReason(() => parseServerEvent(providerEvent({
        type: 'session.updated',
        event_id: 'event_bad_keywords',
        session: {
          ...session,
          audio: {
            input: { ...session.audio.input, transcription }
          }
        }
      })), 'invalid-field');
    }

    const exactServerVad = {
      type: 'server_vad',
      threshold: 0,
      prefix_padding_ms: MAX_TURN_DETECTION_MS,
      silence_duration_ms: MAX_TURN_DETECTION_MS,
      idle_timeout_ms: MAX_TURN_DETECTION_MS,
      create_response: true,
      interrupt_response: false
    };
    expect(parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_exact_server_vad',
      session: {
        ...createdSession,
        audio: { input: { turn_detection: exactServerVad } }
      }
    }))).toMatchObject({ session: { configured: false } });
    expect(parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_null_idle_timeout',
      session: {
        ...createdSession,
        audio: {
          input: {
            turn_detection: { type: 'server_vad', idle_timeout_ms: null }
          }
        }
      }
    }))).toMatchObject({ session: { configured: false } });

    for (const field of [
      'prefix_padding_ms',
      'silence_duration_ms',
      'idle_timeout_ms'
    ] as const) {
      expectReason(() => parseServerEvent(providerEvent({
        type: 'session.updated',
        event_id: 'event_turn_detection_over',
        session: {
          ...createdSession,
          audio: {
            input: {
              turn_detection: {
                ...exactServerVad,
                [field]: MAX_TURN_DETECTION_MS + 1
              }
            }
          }
        }
      })), 'invalid-field');
    }
    expectReason(() => parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_threshold_over',
      session: {
        ...createdSession,
        audio: { input: { turn_detection: { type: 'server_vad', threshold: 1.01 } } }
      }
    })), 'invalid-field');
    expectReason(() => parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_threshold_under',
      session: {
        ...createdSession,
        audio: { input: { turn_detection: { type: 'server_vad', threshold: -0.01 } } }
      }
    })), 'invalid-field');
    expectReason(() => parseServerEvent(providerEvent({
      type: 'session.updated',
      event_id: 'event_milliseconds_under',
      session: {
        ...createdSession,
        audio: {
          input: { turn_detection: { type: 'server_vad', prefix_padding_ms: -1 } }
        }
      }
    })), 'invalid-field');

    for (const eagerness of ['auto', 'low', 'medium', 'high']) {
      expect(parseServerEvent(providerEvent({
        type: 'session.updated',
        event_id: 'event_semantic_eagerness',
        session: {
          ...createdSession,
          audio: {
            input: {
              turn_detection: {
                type: 'semantic_vad',
                eagerness,
                create_response: false,
                interrupt_response: true
              }
            }
          }
        }
      }))).toMatchObject({ session: { configured: false } });
    }
  });

  it('rejects malformed optional session members', () => {
    const malformedSessions = [
      { ...createdSession, audio: null },
      { ...createdSession, audio: { input: null } },
      { ...createdSession, audio: { input: { unknown: true } } },
      { ...createdSession, audio: { unknown: true } },
      {
        ...createdSession,
        audio: { input: { format: { type: 'audio/pcm', rate: 24_001 } } }
      },
      {
        ...createdSession,
        audio: { input: { transcription: { model: '' } } }
      }
    ];
    for (const malformedSession of malformedSessions) {
      expectReason(() => parseServerEvent(providerEvent({
        type: 'session.created',
        event_id: 'event_malformed_session',
        session: malformedSession
      })), 'invalid-field');
    }
  });

  it('accepts only essential bounded companion events for transcription streams', () => {
    const events = [
      {
        type: 'input_audio_buffer.speech_started',
        event_id: 'event_speech_started',
        item_id: 'item_speech',
        audio_start_ms: MAX_AUDIO_OFFSET_MS
      },
      {
        type: 'input_audio_buffer.speech_stopped',
        event_id: 'event_speech_stopped',
        item_id: 'item_speech',
        audio_end_ms: MAX_AUDIO_OFFSET_MS
      },
      {
        type: 'input_audio_buffer.timeout_triggered',
        event_id: 'event_timeout',
        item_id: 'item_timeout',
        audio_start_ms: 0,
        audio_end_ms: MAX_AUDIO_OFFSET_MS
      },
      {
        type: 'conversation.item.created',
        event_id: 'event_item_created',
        previous_item_id: null,
        item: {
          id: 'item_created',
          object: 'realtime.item',
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [{ type: 'input_audio', transcript: null }]
        }
      }
    ];
    for (const event of events) {
      const result = parseServerEvent(providerEvent(event));
      expect(result).toEqual({ type: event.type, category: 'ignored' });
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('item_created');
    }

    const malformedEvents = [
      { ...events[0], audio_start_ms: MAX_AUDIO_OFFSET_MS + 1 },
      { ...events[1], audio_end_ms: MAX_AUDIO_OFFSET_MS + 1 },
      {
        ...events[2],
        audio_start_ms: 2,
        audio_end_ms: 1
      },
      {
        ...events[3],
        item: {
          ...(events[3]!.item as Record<string, unknown>),
          content: [{ type: 'input_audio', transcript: null, audio: 'not-returned' }]
        }
      },
      {
        ...events[3],
        item: {
          ...(events[3]!.item as Record<string, unknown>),
          role: 'assistant'
        }
      }
    ];
    for (const event of malformedEvents) {
      expectReason(() => parseServerEvent(providerEvent(event)), 'invalid-field');
    }
    expectReason(
      () => parseServerEvent(providerEvent({ ...events[2], extra: true })),
      'invalid-event'
    );

    expect(parseServerEvent(providerEvent({
      type: 'input_audio_buffer.committed',
      event_id: 'event_commit_without_previous',
      item_id: 'item_commit_without_previous'
    }))).toEqual({
      type: 'input_audio_buffer.committed',
      item_id: 'item_commit_without_previous',
      previous_item_id: null
    });
  });

  it('normalizes exact GA transcription segments and rejects every malformed field', () => {
    const exactId = `s${'x'.repeat(MAX_EVENT_ID_BYTES - 1)}`;
    const exactText = '😀'.repeat(MAX_TEXT_BYTES / 4);
    const exactSpeaker = 's'.repeat(MAX_PROVIDER_STRING_BYTES);
    const result = parseServerEvent(providerEvent(segmentEvent({
      event_id: exactId,
      id: exactId,
      item_id: exactId,
      content_index: MAX_CONTENT_INDEX,
      text: exactText,
      speaker: exactSpeaker,
      start: 0,
      end: MAX_SEGMENT_SECONDS
    })));
    expect(result).toEqual({
      type: 'conversation.item.input_audio_transcription.segment',
      id: exactId,
      item_id: exactId,
      content_index: MAX_CONTENT_INDEX,
      text: exactText,
      speaker: exactSpeaker,
      start: 0,
      end: MAX_SEGMENT_SECONDS
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('event_id');
    expect(parseServerEvent(providerEvent(segmentEvent({ speaker: '' })))).toHaveProperty(
      'speaker',
      ''
    );

    const overId = `s${'x'.repeat(MAX_EVENT_ID_BYTES)}`;
    const malformedSegments = [
      segmentEvent({ id: overId }),
      segmentEvent({ item_id: overId }),
      segmentEvent({ content_index: MAX_CONTENT_INDEX + 1 }),
      segmentEvent({ text: `${'x'.repeat(MAX_TEXT_BYTES)}x` }),
      segmentEvent({ speaker: `${exactSpeaker}x` }),
      segmentEvent({ start: MAX_SEGMENT_SECONDS + 1 }),
      segmentEvent({ end: MAX_SEGMENT_SECONDS + 1 }),
      segmentEvent({ start: 1, end: 0 })
    ];
    for (const event of malformedSegments) {
      expectReason(() => parseServerEvent(providerEvent(event)), 'invalid-field');
    }
    expectReason(
      () => parseServerEvent(providerEvent({ ...segmentEvent(), extra: true })),
      'invalid-event'
    );
    const missingSpeaker = segmentEvent();
    delete missingSpeaker.speaker;
    expectReason(
      () => parseServerEvent(providerEvent(missingSpeaker)),
      'invalid-event'
    );
  });

  it('accepts exactly 4096 UTF-8 text bytes and rejects over-bound text', () => {
    const exactAscii = 'a'.repeat(MAX_TEXT_BYTES);
    expect(parseServerEvent(providerEvent(deltaEvent(exactAscii)))).toHaveProperty(
      'delta',
      exactAscii
    );
    expectReason(
      () => parseServerEvent(providerEvent(deltaEvent(`${exactAscii}a`))),
      'invalid-field'
    );

    const exactUnicode = '😀'.repeat(MAX_TEXT_BYTES / 4);
    expect(parseServerEvent(providerEvent(completedEvent(exactUnicode)))).toHaveProperty(
      'transcript',
      exactUnicode
    );
    expectReason(
      () => parseServerEvent(providerEvent(completedEvent(`${exactUnicode}a`))),
      'invalid-field'
    );
    expectReason(
      () => parseServerEvent(providerEvent(completedEvent('\ud800'))),
      'invalid-field'
    );
    expect(parseServerEvent(providerEvent(completedEvent('')))).toHaveProperty(
      'transcript',
      ''
    );
  });

  it('accepts the exact maximum wire JSON size before parsing and rejects one byte over', () => {
    const compact = providerEvent({
      type: 'input_audio_buffer.cleared',
      event_id: 'event_1314'
    });
    const compactBytes = new TextEncoder().encode(compact).byteLength;
    const exact = `${compact}${' '.repeat(
      MAX_JSON_BYTES - compactBytes
    )}`;
    expect(new TextEncoder().encode(exact)).toHaveLength(
      MAX_JSON_BYTES
    );
    expect(parseServerEvent(exact)).toEqual({
      type: 'input_audio_buffer.cleared'
    });
    expect(parseServerEvent(new TextEncoder().encode(exact))).toEqual({
      type: 'input_audio_buffer.cleared'
    });
    expectReason(
      () => parseServerEvent(`${exact} `),
      'oversize'
    );
    expectReason(
      () => parseServerEvent(new TextEncoder().encode(`${exact} `)),
      'oversize'
    );
  });

  it('rejects invalid UTF-8 and raw object input before object validation', () => {
    expectReason(
      () => parseServerEvent(new Uint8Array([
        0x7b, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3a, 0xc3, 0x28, 0x7d
      ])),
      'invalid-json'
    );
    expectReason(() => parseServerEvent('\ud800'), 'invalid-json');
    const overCharLimitWithLoneSurrogate =
      `${' '.repeat(MAX_JSON_BYTES + 1)}\ud800`;
    expectReason(
      () => parseServerEvent(overCharLimitWithLoneSurrogate),
      'oversize'
    );
    expectReason(
      () => parseServerEvent({ type: 'input_audio_buffer.cleared' } as never),
      'invalid-input'
    );
  });

  it('caps logprobs, redacts provider details, and freezes normalized data', () => {
    const logs = Array.from(
      { length: MAX_LOGPROBS },
      (_, index) => logprob(index)
    );
    const result = parseServerEvent(providerEvent({
      ...completedEvent('x'),
      logprobs: logs,
      usage: {
        type: 'tokens',
        total_tokens: 1,
        input_tokens: 1,
        input_token_details: { audio_tokens: 1 },
        output_tokens: 0
      },
      languages: [{ code: 'en' }]
    }));
    expect(result).toMatchObject({ logprobs: { count: MAX_LOGPROBS } });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.type === 'conversation.item.input_audio_transcription.completed') {
      expect(result.logprobs === undefined || Object.isFrozen(result.logprobs)).toBe(true);
      expect(Object.isFrozen(result.usage)).toBe(true);
      if (result.usage.type === 'tokens') {
        expect(Object.isFrozen(result.usage.input_token_details)).toBe(true);
      }
      expect(result.languages === undefined || Object.isFrozen(result.languages)).toBe(true);
      expect(
        result.languages === undefined || Object.isFrozen(result.languages.codes)
      ).toBe(true);
    }
    expect(() => {
      (result as { transcript: string }).transcript = 'changed';
    }).toThrow();

    expectReason(() => parseServerEvent(providerEvent({
      ...deltaEvent(),
      logprobs: [...logs, logprob(999)]
    })), 'invalid-field');

    const exactToken = '😀'.repeat(MAX_LOGPROB_TOKEN_BYTES / 4);
    const exactBytes = Array.from({ length: MAX_LOGPROB_BYTES }, () => 255);
    expect(new TextEncoder().encode(exactToken)).toHaveLength(
      MAX_LOGPROB_TOKEN_BYTES
    );
    expect(parseServerEvent(providerEvent({
      ...deltaEvent(),
      logprobs: [{ token: exactToken, bytes: exactBytes, logprob: -1 }]
    }))).toMatchObject({ logprobs: { count: 1, present: true } });
    for (const invalidLogprob of [
      { token: `${exactToken}a`, bytes: [1], logprob: -1 },
      { token: 'x', bytes: [...exactBytes, 1], logprob: -1 },
      { token: 'x', bytes: [256], logprob: -1 },
      { token: 'x', bytes: [-1], logprob: -1 }
    ]) {
      expectReason(() => parseServerEvent(providerEvent({
        ...deltaEvent(),
        logprobs: [invalidLogprob]
      })), 'invalid-field');
    }

    const secret = 'do-not-retain-provider-secret';
    const errorResult = parseServerEvent(providerEvent({
      type: 'error',
      event_id: 'event_secret',
      error: {
        type: 'invalid_request_error',
        code: 'secret code',
        message: secret,
        param: secret,
        event_id: 'event_nested'
      }
    }));
    expect(JSON.stringify(errorResult)).not.toContain(secret);
    expect(errorResult).toEqual({ type: 'error', category: 'protocol-failure' });
  });

  it('requires coherent completion usage and accepts independent detail counters', () => {
    const missingUsage = completedEvent();
    delete missingUsage.usage;
    expectReason(
      () => parseServerEvent(providerEvent(missingUsage)),
      'invalid-event'
    );
    expectReason(() => parseServerEvent(providerEvent({
      ...completedEvent(),
      usage: null
    })), 'invalid-field');

    for (const input_token_details of [
      {},
      { text_tokens: 5 },
      { audio_tokens: 5 }
    ]) {
      const result = parseServerEvent(providerEvent({
        ...completedEvent(),
        usage: {
          type: 'tokens',
          total_tokens: 6,
          input_tokens: 5,
          input_token_details,
          output_tokens: 1
        },
        logprobs: null,
        languages: [{ code: 'en' }]
      }));
      expect(result).toMatchObject({
        usage: { input_token_details },
        logprobs: { count: 0, present: false },
        languages: { count: 1, codes: ['en'] }
      });
      if (result.type === 'conversation.item.input_audio_transcription.completed') {
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.usage)).toBe(true);
        expect(
          result.usage.type !== 'tokens' ||
          Object.isFrozen(result.usage.input_token_details)
        ).toBe(true);
        expect(Object.isFrozen(result.logprobs)).toBe(true);
        expect(Object.isFrozen(result.languages)).toBe(true);
        expect(Object.isFrozen(result.languages?.codes)).toBe(true);
      }
    }

    const inconsistentUsage = [
      {
        type: 'tokens',
        total_tokens: 7,
        input_tokens: 5,
        output_tokens: 1
      },
      {
        type: 'tokens',
        total_tokens: 6,
        input_tokens: 5,
        input_token_details: { text_tokens: 2, audio_tokens: 2 },
        output_tokens: 1
      },
      {
        type: 'tokens',
        total_tokens: 6,
        input_tokens: 5,
        input_token_details: { text_tokens: 6 },
        output_tokens: 1
      },
      {
        type: 'tokens',
        total_tokens: 6,
        input_tokens: 5,
        input_token_details: { audio_tokens: 6 },
        output_tokens: 1
      }
    ];
    for (const usage of inconsistentUsage) {
      expectReason(() => parseServerEvent(providerEvent({
        ...completedEvent(),
        usage
      })), 'invalid-field');
    }
  });

  it('bounds optional usage, languages, obfuscation, and failed-event fields', () => {
    expect(parseServerEvent(providerEvent({
      ...completedEvent(),
      usage: { type: 'duration', seconds: MAX_USAGE_COUNT }
    })).type).toBe('conversation.item.input_audio_transcription.completed');
    expect(parseServerEvent(providerEvent({
      ...completedEvent(),
      usage: {
        type: 'tokens',
        total_tokens: MAX_USAGE_COUNT,
        input_tokens: MAX_USAGE_COUNT,
        input_token_details: { text_tokens: MAX_USAGE_COUNT },
        output_tokens: 0
      }
    })).type).toBe('conversation.item.input_audio_transcription.completed');
    expectReason(() => parseServerEvent(providerEvent({
      ...completedEvent(),
      usage: {
        type: 'tokens',
        total_tokens: MAX_USAGE_COUNT + 1,
        input_tokens: 1,
        output_tokens: 0
      }
    })), 'invalid-field');
    expectReason(() => parseServerEvent(providerEvent({
      ...completedEvent(),
      usage: { type: 'duration', seconds: MAX_USAGE_COUNT + 1 }
    })), 'invalid-field');
    expectReason(() => parseServerEvent(providerEvent({
      ...completedEvent(),
      languages: Array.from({ length: MAX_LANGUAGES + 1 }, () => ({
        code: 'en'
      }))
    })), 'invalid-field');
    expect(parseServerEvent(providerEvent({
      ...deltaEvent(),
      obfuscation: 'x'.repeat(MAX_OBFUSCATION_BYTES)
    }))).toHaveProperty('obfuscation', 'x'.repeat(MAX_OBFUSCATION_BYTES));
    expectReason(() => parseServerEvent(providerEvent({
      ...deltaEvent(),
      obfuscation: 'x'.repeat(MAX_OBFUSCATION_BYTES + 1)
    })), 'invalid-field');
    expectReason(() => parseServerEvent(providerEvent({
      type: 'conversation.item.input_audio_transcription.failed',
      event_id: 'event_2324',
      item_id: 'msg_003',
      content_index: MAX_CONTENT_INDEX + 1,
      error: {}
    })), 'invalid-field');
    expectReason(() => parseServerEvent(providerEvent({
      type: 'conversation.item.input_audio_transcription.failed',
      event_id: 'event_2324',
      item_id: 'msg_003',
      content_index: 0,
      error: { message: 'x'.repeat(MAX_PROVIDER_STRING_BYTES + 1) }
    })), 'invalid-field');
    expect(parseServerEvent(providerEvent({
      type: 'conversation.item.input_audio_transcription.failed',
      event_id: 'event_exact_provider_string',
      item_id: 'msg_003',
      content_index: 0,
      error: { message: 'x'.repeat(MAX_PROVIDER_STRING_BYTES) }
    }))).toMatchObject({ category: 'provider-failure' });

    expect(parseServerEvent(providerEvent({
      type: 'session.created',
      event_id: 'event_exact_include_count',
      session: {
        ...createdSession,
        include: Array.from(
          { length: MAX_LANGUAGES },
          () => 'item.input_audio_transcription.logprobs'
        )
      }
    }))).toMatchObject({ session: { configured: false } });
    expectReason(() => parseServerEvent(providerEvent({
      type: 'session.created',
      event_id: 'event_over_include_count',
      session: {
        ...createdSession,
        include: Array.from(
          { length: MAX_LANGUAGES + 1 },
          () => 'item.input_audio_transcription.logprobs'
        )
      }
    })), 'invalid-field');
  });

  it('normalizes bounded language records to frozen codes and count', () => {
    const exactCode = 'en';
    expect(new TextEncoder().encode(exactCode)).toHaveLength(
      LANGUAGE_CODE_BYTES
    );
    const result = parseServerEvent(providerEvent({
      ...completedEvent(),
      languages: Array.from(
        { length: MAX_LANGUAGES },
        (_, index) => ({ code: index === 0 ? exactCode : 'en' })
      )
    }));
    expect(result).toMatchObject({
      languages: {
        count: MAX_LANGUAGES,
        codes: [exactCode, ...Array.from({ length: MAX_LANGUAGES - 1 }, () => 'en')]
      }
    });
    if (result.type === 'conversation.item.input_audio_transcription.completed') {
      expect(Object.isFrozen(result.languages)).toBe(true);
      expect(result.languages === undefined || Object.isFrozen(result.languages.codes)).toBe(true);
    }

    const malformedLanguages = [
      ['en'],
      [{ code: '' }],
      [{ code: 'EN' }],
      [{ code: 'eng' }],
      [{ code: 'en-US' }],
      [{ code: 'mixed' }],
      [{ code: 'zz' }],
      [{ code: 'en', confidence: 0.9 }],
      [{ code: null }],
      [null]
    ];
    for (const languages of malformedLanguages) {
      expectReason(() => parseServerEvent(providerEvent({
        ...completedEvent(),
        languages
      })), 'invalid-field');
    }
  });

  it('separates general error references from transcription failure details', () => {
    const arbitraryReference = '😀'.repeat(32);
    expect(new TextEncoder().encode(arbitraryReference)).toHaveLength(
      MAX_EVENT_ID_BYTES
    );
    const generalError = parseServerEvent(providerEvent({
      type: 'error',
      event_id: 'event_general_error',
      error: {
        type: 'invalid_request_error',
        message: 'redacted provider message',
        event_id: arbitraryReference
      }
    }));
    expect(generalError).toEqual({ type: 'error', category: 'protocol-failure' });
    expect(JSON.stringify(generalError)).not.toContain(arbitraryReference);
    expect(parseServerEvent(providerEvent({
      type: 'error',
      event_id: 'event_empty_reference',
      error: {
        type: 'server_error',
        message: 'provider message',
        event_id: 'not an identifier / but valid Unicode ✅'
      }
    }))).toEqual({ type: 'error', category: 'protocol-failure' });
    for (const event_id of ['', null]) {
      expect(parseServerEvent(providerEvent({
        type: 'error',
        event_id: 'event_nullable_reference',
        error: { type: 'server_error', message: 'provider message', event_id }
      }))).toEqual({ type: 'error', category: 'protocol-failure' });
    }

    for (const event_id of [`${arbitraryReference}a`, '\ud800']) {
      expectReason(() => parseServerEvent(providerEvent({
        type: 'error',
        event_id: 'event_bad_nested_reference',
        error: { type: 'server_error', message: 'provider message', event_id }
      })), 'invalid-field');
    }
    for (const error of [
      { message: 'missing type' },
      { type: 'server_error' },
      { type: '', message: 'empty type' },
      { type: 'server_error', message: '' }
    ]) {
      expectReason(() => parseServerEvent(providerEvent({
        type: 'error',
        event_id: 'event_bad_general_error',
        error
      })), 'invalid-field');
    }

    const failure = {
      type: 'conversation.item.input_audio_transcription.failed',
      event_id: 'event_transcription_failure',
      item_id: 'item_transcription_failure',
      content_index: 0,
      error: {
        type: 'transcription_error',
        code: 'audio_unintelligible',
        message: 'provider failure',
        param: null
      }
    };
    expect(parseServerEvent(providerEvent(failure))).toEqual({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'item_transcription_failure',
      content_index: 0,
      category: 'provider-failure'
    });
    expectReason(() => parseServerEvent(providerEvent({
      ...failure,
      error: { ...failure.error, event_id: null }
    })), 'invalid-field');
  });

  it('rejects unknown, polluted, accessor, and malformed provider shapes', () => {
    expectReason(() => parseServerEvent(providerEvent({
      ...deltaEvent(),
      extra: true
    })), 'invalid-event');
    expectReason(() => parseServerEvent(providerEvent({
      ...deltaEvent(),
      event_id: 'bad id'
    })), 'invalid-field');
    expectReason(() => parseServerEvent(providerEvent({
      ...deltaEvent(),
      content_index: -1
    })), 'invalid-field');
    expectReason(() => parseServerEvent(providerEvent({ type: 'nope' })), 'invalid-event');
    expectReason(() => parseServerEvent('not-json'), 'invalid-json');
    expectReason(() => parseServerEvent(jsonBytes({ type: 'nope' })), 'invalid-event');

    const polluted = Object.create({ inherited: true }) as Record<string, unknown>;
    polluted.type = 'input_audio_buffer.cleared';
    expectReason(() => parseServerEvent(polluted as never), 'invalid-input');
    const accessor = { type: 'input_audio_buffer.cleared' };
    Object.defineProperty(accessor, 'event_id', { get: () => 'event_1' });
    expectReason(() => parseServerEvent(accessor as never), 'invalid-input');
  });
});
