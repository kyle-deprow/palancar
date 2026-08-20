import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { decodeAudioFrame, MAX_CONTROL_MESSAGE_BYTES, WEBSOCKET_SUBPROTOCOL } from '@palancar/contracts';
import { LANGUAGE_REGISTRY_VERSION } from '@palancar/language-registry';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import {
  contentFreeFailure,
  loadCheckedInSmokeFixture,
  parseSecurityOpsConfig,
  runSecurityOps,
  type SecurityOpsDependencies,
  type SecurityOpsIo,
  type SmokeTargetLanguage
} from '../src/index.js';

const ENV = Object.freeze({
  PALANCAR_OP_TABLE_ENDPOINT: 'https://palancardevstateaeeacd8c.table.core.windows.net',
  PALANCAR_OP_ENVIRONMENT: 'dev',
  PALANCAR_OP_RELAY_ORIGIN: 'wss://relay.example.test',
  PALANCAR_OP_OPERATOR_SCOPE: 'azure-cli:00000000-0000-4000-8000-000000000003',
  PALANCAR_OP_SUBSCRIPTION_ID: '00000000-0000-4000-8000-000000000001',
  PALANCAR_OP_TENANT_ID: '00000000-0000-4000-8000-000000000002',
  PALANCAR_OP_PRINCIPAL_ID: '00000000-0000-4000-8000-000000000003'
});

const PAIRING = '00000000000000000000000000';
const CREDENTIAL = Buffer.alloc(32, 1).toString('base64url');
const TICKETS = Object.freeze([
  Buffer.alloc(32, 2).toString('base64url'),
  Buffer.alloc(32, 3).toString('base64url')
]);
const SESSION_ID = '00000000-0000-4000-8000-000000000010';
const SEGMENT_ID = '00000000-0000-4000-8000-000000000011';
const OTHER_UTTERANCE_ID = '00000000-0000-4000-8000-000000000012';
const IRRELEVANT_PARTIAL_TEXT = 'irrelevant partial content';
const AUDIO_BYTES_PER_FRAME = 3_200;

function unitFixture(frameCount: number, seed: number): Uint8Array {
  const fixture = new Uint8Array(frameCount * AUDIO_BYTES_PER_FRAME);
  for (let index = 0; index < fixture.byteLength; index += 1) {
    fixture[index] = (index + seed) % 251 + 1;
  }
  return fixture;
}

const UNIT_FIXTURES: Readonly<Record<SmokeTargetLanguage, Uint8Array>> = Object.freeze({
  es: unitFixture(2, 7),
  tr: unitFixture(3, 19)
});

type InterFrameFailure = 'error' | 'close';
type ReadyMutation = 'registry' | 'gate' | 'limits';
type ReadyOutcome = '200' | '503' | 'network' | 'malformed' | 'status500';
type TerminalMutation =
  | 'uncertain-decision'
  | 'non-target-decision'
  | 'malformed-decision'
  | 'duplicate-decision'
  | 'mismatched-decision'
  | 'wrong-utterance';

interface AudioObservation {
  readonly target: string;
  readonly sequence: number;
  readonly offset: number;
  readonly samples: number;
  readonly payload: Uint8Array;
  readonly sentAt: number;
  acknowledgedAt: number | undefined;
}

interface CommitObservation {
  readonly target: string;
  readonly finalOriginalSampleOffset: number;
}

class FakeSocket extends EventEmitter {
  readonly protocol = WEBSOCKET_SUBPROTOCOL;
  readyState: number = WebSocket.CONNECTING;
  readonly targets: string[];
  readonly frames: number[] = [];
  readonly duplicateFinal: boolean;
  readonly firstAckDelayMs: number;
  readonly neverOpen: boolean;
  readonly interFrameFailure: InterFrameFailure | undefined;
  readonly readyMutation: ReadyMutation | undefined;
  readonly terminalMutation: TerminalMutation | undefined;
  readonly audio: AudioObservation[];
  readonly commits: CommitObservation[];
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
  terminateCount = 0;
  #interFrameFailureTriggered = false;
  #terminationStarted = false;
  #target = '';
  #utteranceId = '';

  constructor(
    targets: string[],
    options: {
      readonly duplicateFinal?: boolean;
      readonly firstAckDelayMs?: number;
      readonly neverOpen: boolean;
      readonly interFrameFailure: InterFrameFailure | undefined;
      readonly readyMutation: ReadyMutation | undefined;
      readonly terminalMutation: TerminalMutation | undefined;
      readonly audio: AudioObservation[];
      readonly commits: CommitObservation[];
      readonly now: () => number;
      readonly delay: (milliseconds: number) => Promise<void>;
    }
  ) {
    super();
    this.targets = targets;
    this.duplicateFinal = options.duplicateFinal === true;
    this.firstAckDelayMs = options.firstAckDelayMs ?? 0;
    this.neverOpen = options.neverOpen === true;
    this.interFrameFailure = options.interFrameFailure;
    this.readyMutation = options.readyMutation;
    this.terminalMutation = options.terminalMutation;
    this.audio = options.audio;
    this.commits = options.commits;
    this.now = options.now;
    this.delay = options.delay;
    if (!this.neverOpen) {
      queueMicrotask(() => {
        this.readyState = WebSocket.OPEN;
        this.emit('open');
      });
    }
  }

  send(data: string | Uint8Array): void {
    if (typeof data !== 'string') {
      const frame = decodeAudioFrame(data);
      this.frames.push(frame.sequence);
      const observation: AudioObservation = {
        target: this.#target,
        sequence: frame.sequence,
        offset: frame.offset,
        samples: frame.payload.byteLength / 2,
        payload: Uint8Array.from(frame.payload),
        sentAt: this.now(),
        acknowledgedAt: undefined
      };
      this.audio.push(observation);
      const acknowledge = (): void => {
        observation.acknowledgedAt = this.now();
        this.emit('message', Buffer.from(JSON.stringify({
          type: 'audio.ack',
          sessionId: SESSION_ID,
          sessionEpoch: 1,
          utteranceId: this.#utteranceId,
          highestContiguousExclusiveOffset: frame.offset + (frame.payload.byteLength / 2),
          flowState: 'normal'
        })), false);
      };
      if (this.frames.length === 1 && this.firstAckDelayMs > 0) {
        void this.delay(this.firstAckDelayMs).then(acknowledge);
      } else {
        queueMicrotask(acknowledge);
      }
      return;
    }
    const message = JSON.parse(data) as Record<string, unknown>;
    if (message.type === 'session.start') {
      this.#target = String(message.targetLanguage);
      this.targets.push(this.#target);
      const requestedLimits = message.requestedLimits as Record<string, number> & {
        readonly maxAudioPayloadBytes: number;
      };
      const effectiveLimits = { ...requestedLimits };
      this.emitJson({
        type: 'session.ready', result: 'new', sessionId: SESSION_ID, sessionEpoch: 1,
        targetLanguage: this.#target,
        languageRegistryVersion: this.readyMutation === 'registry' ? '1.0.0' : LANGUAGE_REGISTRY_VERSION,
        gatePolicyVersion: this.readyMutation === 'gate' ? '1.0.1' : '1.0.0',
        effectiveLimits: this.readyMutation === 'limits'
          ? { ...effectiveLimits, maxAudioPayloadBytes: requestedLimits.maxAudioPayloadBytes + 1 }
          : effectiveLimits,
        serverTime: '2026-08-18T00:00:00.000Z'
      });
    } else if (message.type === 'utterance.start') {
      this.#utteranceId = String(message.utteranceId);
    } else if (message.type === 'utterance.commit') {
      this.commits.push({
        target: this.#target,
        finalOriginalSampleOffset: Number(message.finalOriginalSampleOffset)
      });
      queueMicrotask(() => {
        const targetText = this.#target === 'es' ? '¿Cómo está usted hoy?' : 'Bugün nasılsınız?';
        const targetSuggestions = this.#target === 'es'
          ? ['Sí, por favor.', 'No, gracias.']
          : ['Evet, lütfen.', 'Hayır, teşekkürler.'];
        const common = {
          sessionId: SESSION_ID, sessionEpoch: 1, utteranceId: this.#utteranceId,
          segmentId: SEGMENT_ID
        };
        this.emitJson({
          type: 'transcript.partial', ...common, utteranceId: OTHER_UTTERANCE_ID, revision: 1,
          text: IRRELEVANT_PARTIAL_TEXT, providerEventTime: '2026-08-18T00:00:00.500Z'
        });
        const finalTranscript = {
          type: 'transcript.final', ...common, revision: 1, text: targetText,
          providerEventTime: '2026-08-18T00:00:01.000Z'
        };
        this.emitJson(finalTranscript);
        if (this.duplicateFinal) this.emitJson(finalTranscript);
        const decision = {
          type: 'language.decision', ...common, revision: 1, decision: 'target',
          selectedTargetLanguage: this.#target, detectedLanguage: this.#target,
          confidence: 0.99, gatePolicyVersion: '1.0.0'
        } as Record<string, unknown>;
        if (this.terminalMutation === 'uncertain-decision') {
          decision.decision = 'uncertain';
          delete decision.detectedLanguage;
          delete decision.confidence;
        } else if (this.terminalMutation === 'non-target-decision') {
          decision.decision = 'english';
          decision.detectedLanguage = 'en';
        } else if (this.terminalMutation === 'malformed-decision') {
          decision.extra = 'private-terminal-canary';
        } else if (this.terminalMutation === 'mismatched-decision') {
          decision.revision = 2;
        } else if (this.terminalMutation === 'wrong-utterance') {
          decision.utteranceId = OTHER_UTTERANCE_ID;
        }
        this.emitJson(decision);
        if (this.terminalMutation === 'duplicate-decision') this.emitJson(decision);
        if (this.terminalMutation !== undefined) return;
        this.emitJson({
          type: 'translation.ready', ...common, acceptedFinalRevision: 1,
          englishTranslation: 'How are you today?'
        });
        this.emitJson({
          type: 'suggestions.ready', ...common, acceptedFinalRevision: 1,
          suggestions: targetSuggestions.map((selectedTargetText, index) => ({
            englishText: index === 0 ? 'Yes, please.' : 'No, thank you.', selectedTargetText
          }))
        });
      });
    } else if (message.type === 'session.end') {
      if (message.reason !== 'user_requested') throw new Error('invalid close reason');
      this.readyState = WebSocket.CLOSED;
      this.emit('close', 1000);
    }
  }

  emitJson(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }

  triggerInterFrameFailure(): void {
    if (this.#interFrameFailureTriggered || this.interFrameFailure === undefined) return;
    this.#interFrameFailureTriggered = true;
    if (this.interFrameFailure === 'error') {
      this.emit('error');
      return;
    }
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1006);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000);
  }

  terminate(): void {
    this.terminateCount += 1;
    if (this.#terminationStarted) return;
    this.#terminationStarted = true;
    this.readyState = WebSocket.CLOSING;
    queueMicrotask(() => {
      this.emit('error');
      queueMicrotask(() => {
        this.readyState = WebSocket.CLOSED;
        this.emit('close', 1006);
      });
    });
  }
}

function fakeIo(): { io: SecurityOpsIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdinIsTty: false,
      stdoutIsTty: false,
      stdout: (value) => { stdout.push(value); },
      stderr: (value) => { stderr.push(value); }
    }
  };
}

function fakeDependencies(options: {
  readonly duplicateFinal?: boolean;
  readonly firstAckDelayMs?: number;
  readonly interFrameFailure?: InterFrameFailure;
  readonly readyMutation?: ReadyMutation;
  readonly terminalMutation?: TerminalMutation;
  readonly neverOpen?: boolean;
  readonly holdInterFrameDelay?: boolean;
  readonly readyOutcomes?: readonly ReadyOutcome[];
  readonly readyOutcome?: ReadyOutcome;
  readonly fixtureErrorTarget?: SmokeTargetLanguage;
  readonly fixtures?: Partial<Readonly<Record<SmokeTargetLanguage, Uint8Array>>>;
  readonly cleanupResponse?: () => Response;
} = {}): {
  dependencies: SecurityOpsDependencies;
  targets: string[];
  protocols: readonly string[][];
  requests: RequestInit[];
  requestUrls: string[];
  issueCount: () => number;
  redemptionCount: () => number;
  ticketCount: () => number;
  cleanupCount: () => number;
  readinessCount: () => number;
  loadedTargets: SmokeTargetLanguage[];
  audio: AudioObservation[];
  commits: CommitObservation[];
  sockets: FakeSocket[];
} {
  const targets: string[] = [];
  const protocols: string[][] = [];
  const requests: RequestInit[] = [];
  const requestUrls: string[] = [];
  const loadedTargets: SmokeTargetLanguage[] = [];
  const audio: AudioObservation[] = [];
  const commits: CommitObservation[] = [];
  let issues = 0;
  let redemptions = 0;
  let tickets = 0;
  let cleanups = 0;
  let readiness = 0;
  let clock = 0;
  let currentSocket: FakeSocket | undefined;
  const sockets: FakeSocket[] = [];
  const delay = async (milliseconds: number): Promise<void> => {
    if (options.holdInterFrameDelay === true && milliseconds === 100) {
      await new Promise<void>(() => undefined);
      return;
    }
    clock += milliseconds;
    currentSocket?.triggerInterFrameFailure();
  };
  const operations = {
    bootstrap: { initializeState: async () => undefined },
    operator: {
      issuePairing: async () => {
        issues += 1;
        return { pairingCode: PAIRING, issuedAt: 0, expiresAt: 60_000 };
      },
      revokePairing: async () => undefined
    },
    maintenance: {
      checkReadiness: async () => undefined,
      cleanupExpired: async () => ({ visited: 3, removed: 2 })
    }
  };
  const dependencies: SecurityOpsDependencies = {
    createOperations: () => operations as never,
    fetch: async (input, init) => {
      const url = String(input);
      requests.push(init ?? {});
      requestUrls.push(url);
      if (url === 'https://relay.example.test/readyz') {
        readiness += 1;
        expect(init?.method).toBe('GET');
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toBeUndefined();
        expect(init?.body).toBeUndefined();
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(issues).toBe(0);
        const outcome = options.readyOutcomes?.[readiness - 1] ?? options.readyOutcome ?? '200';
        if (outcome === '503') return new Response('not ready', { status: 503 });
        if (outcome === 'network') throw new Error('network failure');
        if (outcome === 'malformed') return new Response('{"ready":true,"extra":false}', { status: 200 });
        if (outcome === 'status500') return new Response('server failure', { status: 500 });
        return Response.json({ ready: true });
      }
      if (url === 'https://relay.example.test/v1/pairing-redemptions') {
        redemptions += 1;
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toEqual({ 'content-type': 'application/json' });
        expect(init?.body).toBe(JSON.stringify({ pairingCode: PAIRING }));
        return Response.json({
          installationId: SESSION_ID, credential: CREDENTIAL, credentialVersion: 1,
          idleExpiresAt: '2026-08-18T01:00:00.000Z', absoluteExpiresAt: '2026-09-18T00:00:00.000Z'
        });
      }
      if (url === 'https://relay.example.test/v1/session-tickets') {
        tickets += 1;
        expect(tickets).toBeLessThanOrEqual(2);
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toEqual({
          'content-type': 'application/json', authorization: `Bearer ${CREDENTIAL}`
        });
        expect(init?.body).toBe(JSON.stringify({ protocolVersion: 1, intent: 'new' }));
        return Response.json({
          ticket: TICKETS[tickets - 1], wssOrigin: ENV.PALANCAR_OP_RELAY_ORIGIN, wssPath: '/v1/stream',
          protocolVersion: 1, expiresAt: '2026-08-18T00:01:00.000Z'
        });
      }
      if (url === 'https://relay.example.test/v1/installations/current') {
        cleanups += 1;
        expect(init?.method).toBe('DELETE');
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toEqual({ authorization: `Bearer ${CREDENTIAL}` });
        expect(init?.body).toBeUndefined();
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return options.cleanupResponse?.() ?? new Response(null, {
          status: 204,
          headers: { 'cache-control': 'no-store' }
        });
      }
      throw new Error('unexpected request');
    },
    createSocket: (url, offered) => {
      expect(url).toBe('wss://relay.example.test/v1/stream');
      protocols.push([...offered]);
      const socket = new FakeSocket(targets, {
        duplicateFinal: options.duplicateFinal === true,
        firstAckDelayMs: options.firstAckDelayMs ?? 0,
        interFrameFailure: options.interFrameFailure,
        readyMutation: options.readyMutation,
        terminalMutation: options.terminalMutation,
        neverOpen: options.neverOpen === true,
        audio,
        commits,
        now: () => clock,
        delay
      });
      sockets.push(socket);
      currentSocket = socket;
      return socket as never;
    },
    delay,
    now: () => clock,
    verifyAzureContext: async () => undefined,
    loadSmokeFixture: async (targetLanguage) => {
      loadedTargets.push(targetLanguage);
      if (options.fixtureErrorTarget === targetLanguage) {
        throw new Error('fixture failure canary');
      }
      return Uint8Array.from(options.fixtures?.[targetLanguage] ?? UNIT_FIXTURES[targetLanguage]);
    }
  };
  return {
    dependencies,
    targets,
    protocols,
    requests,
    requestUrls,
    issueCount: () => issues,
    redemptionCount: () => redemptions,
    ticketCount: () => tickets,
    cleanupCount: () => cleanups,
    readinessCount: () => readiness,
    loadedTargets,
    audio,
    commits,
    sockets
  };
}

describe('checked-in smoke fixtures', () => {
  it.each([
    {
      targetLanguage: 'es' as const,
      byteLength: 96_000,
      sha256: '2acdb87adc12791634b1c8c9602ba20abc62621f2d6184a3d60a62787ccd7357'
    },
    {
      targetLanguage: 'tr' as const,
      byteLength: 102_400,
      sha256: 'fa0357cf46980fb436140105a6d7ecdd06ad7abc0f7fd8fdcf27ef9c47de7d6a'
    }
  ])(
    'verifies the exact checked-in $targetLanguage PCM fixture',
    async ({ targetLanguage, byteLength, sha256 }) => {
      const fixture = await loadCheckedInSmokeFixture(targetLanguage);
      expect(fixture.byteLength).toBe(byteLength);
      expect(fixture.byteLength % AUDIO_BYTES_PER_FRAME).toBe(0);
      expect(fixture.some((value) => value !== 0)).toBe(true);
      expect(createHash('sha256').update(fixture).digest('hex')).toBe(sha256);

      const tampered = Uint8Array.from(fixture);
      tampered[Math.floor(tampered.byteLength / 2)]! ^= 1;
      await expect(
        loadCheckedInSmokeFixture(targetLanguage, async () => tampered)
      ).rejects.toThrow('Security operation failed.');
    }
  );

  it.each([
    ['missing', async (): Promise<Uint8Array> => { throw new Error('private path canary'); }],
    ['wrong-size', async () => unitFixture(1, 3)],
    ['misaligned', async () => new Uint8Array(3_201).fill(1)],
    ['all-zero', async () => new Uint8Array(96_000)],
    ['malformed-target', async () => unitFixture(30, 3)]
  ] as const)('fails content-free for %s fixture input', async (kind, readFixture) => {
    const target = kind === 'malformed-target' ? ('fr' as never) : 'es';
    let failure: unknown;
    try {
      await loadCheckedInSmokeFixture(target, readFixture);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Security operation failed.');
    expect((failure as Error).message).not.toMatch(/private|fixture|path|sha|pcm/i);
  });
});

describe('security operations configuration', () => {
  it('constructs the exact table and audience boundary', () => {
    const config = parseSecurityOpsConfig(ENV);
    expect(config).toMatchObject({
      endpoint: 'https://palancardevstateaeeacd8c.table.core.windows.net',
      securityTableName: 'SecurityState',
      rateTableName: 'RateState',
      environment: 'dev',
      relayOrigin: 'wss://relay.example.test',
      audience: {
        origin: 'wss://relay.example.test',
        path: '/v1/stream',
        protocol: 'palancar.v1'
      }
    });
  });

  it('accepts one optional Table endpoint slash and normalizes both forms to the origin', () => {
    const withoutSlash = parseSecurityOpsConfig(ENV);
    const withSlash = parseSecurityOpsConfig({
      ...ENV,
      PALANCAR_OP_TABLE_ENDPOINT: `${ENV.PALANCAR_OP_TABLE_ENDPOINT}/`
    });
    expect(withSlash.endpoint).toBe(withoutSlash.endpoint);
    expect(withSlash.endpoint).toBe('https://palancardevstateaeeacd8c.table.core.windows.net');
  });

  it.each([
    {},
    { ...ENV, PALANCAR_OP_UNKNOWN: 'x' },
    { ...ENV, PALANCAR_OP_TABLE_ENDPOINT: 'http://palancardevstateaeeacd8c.table.core.windows.net' },
    { ...ENV, PALANCAR_OP_TABLE_ENDPOINT: 'https://palancardevstateaeeacd8c.table.core.windows.net/path' },
    { ...ENV, PALANCAR_OP_TABLE_ENDPOINT: 'https://palancardevstateaeeacd8c.table.core.windows.net/?query=x' },
    { ...ENV, PALANCAR_OP_TABLE_ENDPOINT: 'https://palancardevstateaeeacd8c.table.core.windows.net/#fragment' },
    { ...ENV, PALANCAR_OP_TABLE_ENDPOINT: 'https://user:pass@palancardevstateaeeacd8c.table.core.windows.net' },
    { ...ENV, PALANCAR_OP_TABLE_ENDPOINT: 'https://palancardevstateaeeacd8c.table.core.windows.net:443' },
    { ...ENV, PALANCAR_OP_TABLE_ENDPOINT: 'https://palancardevstateaeeacd8c.table.core.windows.net//' },
    { ...ENV, PALANCAR_OP_TABLE_ENDPOINT: 'https://example.test' },
    { ...ENV, PALANCAR_OP_RELAY_ORIGIN: 'wss://relay.example.test/path' },
    { ...ENV, PALANCAR_OP_OPERATOR_SCOPE: 'contains whitespace' }
  ])('fails closed for invalid configuration without reflecting values', (env) => {
    const canary = JSON.stringify(env);
    expect(() => parseSecurityOpsConfig(env)).toThrow('Security operation failed.');
    expect(contentFreeFailure()).not.toContain(canary);
  });

  it('uses one fixed content-free public failure', () => {
    expect(contentFreeFailure()).toBe('security-ops: failed\n');
  });

  it('refuses non-TTY pairing before issuing a secret', async () => {
    const fixture = fakeDependencies();
    const output = fakeIo();
    await expect(runSecurityOps(['issue-pairing'], ENV, output.io, fixture.dependencies)).rejects.toThrow(
      'Security operation failed.'
    );
    expect(fixture.issueCount()).toBe(0);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
  });

  it('runs exactly one fresh Spanish and Turkish generation with bounded secret-free output', async () => {
    const fixture = fakeDependencies();
    const output = fakeIo();
    await runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies);
    expect(fixture.targets).toEqual(['es', 'tr']);
    expect(fixture.readinessCount()).toBe(1);
    expect(fixture.issueCount()).toBe(1);
    expect(fixture.redemptionCount()).toBe(1);
    expect(fixture.ticketCount()).toBe(2);
    expect(fixture.cleanupCount()).toBe(1);
    expect(fixture.loadedTargets).toEqual(['es', 'tr']);
    expect(fixture.requests).toHaveLength(5);
    expect(fixture.requestUrls).toEqual([
      'https://relay.example.test/readyz',
      'https://relay.example.test/v1/pairing-redemptions',
      'https://relay.example.test/v1/session-tickets',
      'https://relay.example.test/v1/session-tickets',
      'https://relay.example.test/v1/installations/current'
    ]);
    expect(fixture.protocols).toEqual([
      [WEBSOCKET_SUBPROTOCOL, `palancar.ticket.${TICKETS[0]}`],
      [WEBSOCKET_SUBPROTOCOL, `palancar.ticket.${TICKETS[1]}`]
    ]);
    const visible = `${output.stdout.join('')}${output.stderr.join('')}`;
    expect(visible).toMatch(/^security-ops smoke: pass targets=2 es_ms=\d+ tr_ms=\d+\n$/);
    for (const canary of [PAIRING, CREDENTIAL, ...TICKETS, IRRELEVANT_PARTIAL_TEXT, 'Cómo', 'Bugün', 'How are you']) {
      expect(visible).not.toContain(canary);
    }
  });

  it.each(['es', 'tr'] as const)(
    'deletes the redeemed installation after a %s target fixture failure',
    async (targetLanguage) => {
      const fixture = fakeDependencies({ fixtureErrorTarget: targetLanguage });
      const output = fakeIo();

      await expect(
        runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies)
      ).rejects.toThrow('Security operation failed.');

      expect(fixture.cleanupCount()).toBe(1);
      expect(fixture.requestUrls.at(-1)).toBe(
        'https://relay.example.test/v1/installations/current'
      );
      expect(fixture.loadedTargets).toEqual(targetLanguage === 'es' ? ['es'] : ['es', 'tr']);
      expect(fixture.ticketCount()).toBe(targetLanguage === 'es' ? 0 : 1);
      const visible = `${output.stdout.join('')}${output.stderr.join('')}`;
      expect(visible).toBe('');
      expect(visible).not.toContain(CREDENTIAL);
      expect(visible).not.toMatch(/fixture|audio|content/i);
    }
  );

  it.each([
    ['empty', new Uint8Array()],
    ['misaligned', new Uint8Array(3_201).fill(1)],
    ['all-zero', new Uint8Array(AUDIO_BYTES_PER_FRAME)]
  ] as const)('rejects %s injected PCM and still deletes the installation', async (_kind, pcm) => {
    const fixture = fakeDependencies({ fixtures: { es: pcm } });
    const output = fakeIo();

    await expect(
      runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies)
    ).rejects.toThrow('Security operation failed.');

    expect(fixture.cleanupCount()).toBe(1);
    expect(fixture.ticketCount()).toBe(0);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
  });

  it('fails content-free when installation deletion violates the exact 204 contract', async () => {
    const cleanupCanary = 'private cleanup response content';
    const fixture = fakeDependencies({
      cleanupResponse: () => new Response(cleanupCanary, {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/plain'
        }
      })
    });
    const output = fakeIo();

    await expect(
      runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies)
    ).rejects.toThrow('Security operation failed.');

    expect(fixture.cleanupCount()).toBe(1);
    const visible = `${output.stdout.join('')}${output.stderr.join('')}`;
    expect(visible).toBe('');
    expect(visible).not.toContain(cleanupCanary);
    expect(visible).not.toContain(CREDENTIAL);
  });

  it.each([
    ['missing no-store', () => new Response(null, { status: 204 })],
    [
      'content type',
      () => new Response(null, {
        status: 204,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' }
      })
    ],
    [
      'content length',
      () => new Response(null, {
        status: 204,
        headers: { 'cache-control': 'no-store', 'content-length': '0' }
      })
    ]
  ] as const)('rejects deletion success with %s', async (_kind, cleanupResponse) => {
    const fixture = fakeDependencies({ cleanupResponse });
    const output = fakeIo();

    await expect(
      runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies)
    ).rejects.toThrow('Security operation failed.');

    expect(fixture.cleanupCount()).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
  });

  it('waits for relay readiness through 503 and network failure before pairing', async () => {
    const fixture = fakeDependencies({ readyOutcomes: ['503', 'network', '200'] });
    const output = fakeIo();
    await runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies);
    expect(fixture.readinessCount()).toBe(3);
    expect(fixture.issueCount()).toBe(1);
    expect(fixture.requestUrls.slice(0, 3)).toEqual([
      'https://relay.example.test/readyz',
      'https://relay.example.test/readyz',
      'https://relay.example.test/readyz'
    ]);
    expect(output.stderr).toEqual([]);
  });

  it('fails content-free at the readiness deadline without issuing pairing', async () => {
    const fixture = fakeDependencies({ readyOutcome: '503' });
    const output = fakeIo();
    await expect(runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies)).rejects.toThrow(
      'Security operation failed.'
    );
    expect(fixture.readinessCount()).toBe(120);
    expect(fixture.issueCount()).toBe(0);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
  });

  it.each(['malformed', 'status500'] as const)('rejects readiness %s immediately without pairing', async (outcome) => {
    const fixture = fakeDependencies({ readyOutcomes: [outcome] });
    const output = fakeIo();
    await expect(runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies)).rejects.toThrow(
      'Security operation failed.'
    );
    expect(fixture.readinessCount()).toBe(1);
    expect(fixture.issueCount()).toBe(0);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
  });

  it.each(['registry', 'gate', 'limits'] as const)('fails closed for session.ready %s mismatches', async (readyMutation) => {
    const fixture = fakeDependencies({ readyMutation });
    const output = fakeIo();
    await expect(runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies)).rejects.toThrow(
      'Security operation failed.'
    );
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
  });

  it.each(['error', 'close'] as const)('fails content-free on a socket %s during inter-frame delay', async (failure) => {
    const fixture = fakeDependencies({ interFrameFailure: failure });
    const output = fakeIo();
    await expect(runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies)).rejects.toThrow(
      'Security operation failed.'
    );
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
    const socket = fixture.sockets[0]!;
    expect(socket.listenerCount('error')).toBe(0);
    expect(socket.listenerCount('close')).toBe(0);
  });

  it('terminates the exact socket at the total deadline and disposes lifecycle state', async () => {
    vi.useFakeTimers();
    try {
      const fixture = fakeDependencies({ holdInterFrameDelay: true });
      const operation = runSecurityOps(['smoke'], ENV, fakeIo().io, fixture.dependencies);
      const rejected = expect(operation).rejects.toThrow('Security operation failed.');
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.sockets).toHaveLength(1);
      const socket = fixture.sockets[0]!;
      expect(socket.terminateCount).toBe(0);

      await vi.advanceTimersByTimeAsync(119_999);
      expect(socket.terminateCount).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;

      expect(socket.terminateCount).toBe(1);
      expect(socket.listenerCount('error')).toBe(0);
      expect(socket.listenerCount('close')).toBe(0);
      expect(socket.listenerCount('open')).toBe(0);
      expect(socket.listenerCount('unexpected-response')).toBe(0);
      expect(socket.listenerCount('message')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('awaits asynchronous never-open termination without uncaught socket errors', async () => {
    vi.useFakeTimers();
    try {
      const fixture = fakeDependencies({ neverOpen: true });
      const output = fakeIo();
      const operation = runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies);
      const rejected = expect(operation).rejects.toThrow('Security operation failed.');
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.sockets).toHaveLength(1);
      const socket = fixture.sockets[0]!;

      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;

      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual([]);
      expect(socket.terminateCount).toBe(1);
      expect(socket.listenerCount('error')).toBe(0);
      expect(socket.listenerCount('close')).toBe(0);
      expect(socket.listenerCount('open')).toBe(0);
      expect(socket.listenerCount('unexpected-response')).toBe(0);
      expect(socket.listenerCount('message')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('paces every frame from its preceding delayed acknowledgement within the rolling quota', async () => {
    const fixture = fakeDependencies({ firstAckDelayMs: 1_200 });
    await runSecurityOps(['smoke'], ENV, fakeIo().io, fixture.dependencies);

    expect(fixture.audio).toHaveLength(5);
    for (const target of ['es', 'tr'] as const) {
      const expectedFixture = UNIT_FIXTURES[target];
      const frameCount = expectedFixture.byteLength / AUDIO_BYTES_PER_FRAME;
      const frames = fixture.audio.filter((frame) => frame.target === target);
      expect(frames).toHaveLength(frameCount);
      expect(frames.map((frame) => frame.sequence)).toEqual(
        Array.from({ length: frameCount }, (_, sequence) => sequence)
      );
      expect(frames.every((frame, index) =>
        frame.offset === index * 1_600 && frame.samples === 1_600
      )).toBe(true);
      for (const [index, frame] of frames.entries()) {
        expect(frame.payload).toEqual(
          expectedFixture.slice(
            index * AUDIO_BYTES_PER_FRAME,
            (index + 1) * AUDIO_BYTES_PER_FRAME
          )
        );
      }
      for (let index = 1; index < frames.length; index += 1) {
        const previous = frames[index - 1]!;
        const current = frames[index]!;
        expect(current.acknowledgedAt).toBeDefined();
        expect(current.sentAt - (previous.acknowledgedAt ?? Number.POSITIVE_INFINITY))
          .toBeGreaterThanOrEqual(100);
      }
      for (const current of frames) {
        const rollingSamples = frames
          .filter((candidate) =>
            candidate.sentAt > current.sentAt - 1_000 && candidate.sentAt <= current.sentAt
          )
          .reduce((total, candidate) => total + candidate.samples, 0);
        expect(rollingSamples).toBeLessThanOrEqual(2 * 8_000);
      }
    }

    const spanish = fixture.audio.filter((frame) => frame.target === 'es');
    expect(spanish[0]!.acknowledgedAt).toBe(1_200);
    expect(spanish[1]!.sentAt).toBe(1_300);
    expect(fixture.commits).toEqual([
      { target: 'es', finalOriginalSampleOffset: UNIT_FIXTURES.es.byteLength / 2 },
      { target: 'tr', finalOriginalSampleOffset: UNIT_FIXTURES.tr.byteLength / 2 }
    ]);
  });

  it('runs initialization and bounded cleanup without content output', async () => {
    const fixture = fakeDependencies();
    const initialized = fakeIo();
    await runSecurityOps(['initialize'], ENV, initialized.io, fixture.dependencies);
    expect(initialized.stdout).toEqual(['security-ops initialize: pass\n']);
    const cleaned = fakeIo();
    await runSecurityOps(['cleanup'], ENV, cleaned.io, fixture.dependencies);
    expect(cleaned.stdout).toEqual(['security-ops cleanup: pass visited=3 removed=2\n']);
  });

  it('fails closed on duplicate turn events without reflecting content', async () => {
    const fixture = fakeDependencies({ duplicateFinal: true });
    const output = fakeIo();
    await expect(runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies)).rejects.toThrow(
      'Security operation failed.'
    );
    expect(fixture.cleanupCount()).toBe(1);
    expect(fixture.sockets[0]?.listenerCount('message')).toBe(0);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
  });

  it.each([
    'uncertain-decision',
    'non-target-decision',
    'malformed-decision',
    'duplicate-decision',
    'mismatched-decision',
    'wrong-utterance'
  ] as const)('fails immediately and cleans up on a %s terminal tuple', async (terminalMutation) => {
    const fixture = fakeDependencies({ terminalMutation });
    const output = fakeIo();

    await expect(
      runSecurityOps(['smoke'], ENV, output.io, fixture.dependencies)
    ).rejects.toThrow('Security operation failed.');

    expect(fixture.cleanupCount()).toBe(1);
    expect(fixture.sockets).toHaveLength(1);
    expect(fixture.sockets[0]?.listenerCount('message')).toBe(0);
    const visible = `${output.stdout.join('')}${output.stderr.join('')}`;
    expect(visible).toBe('');
    expect(visible).not.toContain(CREDENTIAL);
    expect(visible).not.toContain('private-terminal-canary');
  });

  it('rejects oversized HTTP bodies before parsing or opening a socket', async () => {
    const fixture = fakeDependencies();
    let sockets = 0;
    const dependencies: SecurityOpsDependencies = {
      ...fixture.dependencies,
      fetch: async () => new Response('x'.repeat(MAX_CONTROL_MESSAGE_BYTES + 1)),
      createSocket: () => {
        sockets += 1;
        return new FakeSocket([], {
          audio: [], commits: [], now: () => 0, delay: async () => undefined,
          neverOpen: false, interFrameFailure: undefined, readyMutation: undefined,
          terminalMutation: undefined
        }) as never;
      }
    };
    await expect(runSecurityOps(['smoke'], ENV, fakeIo().io, dependencies)).rejects.toThrow(
      'Security operation failed.'
    );
    expect(sockets).toBe(0);
  });
});
