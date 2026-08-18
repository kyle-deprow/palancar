import { EventEmitter } from 'node:events';

import { decodeAudioFrame, MAX_CONTROL_MESSAGE_BYTES, WEBSOCKET_SUBPROTOCOL } from '@palancar/contracts';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  contentFreeFailure,
  parseSecurityOpsConfig,
  runSecurityOps,
  type SecurityOpsDependencies,
  type SecurityOpsIo
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
const TICKET = Buffer.alloc(32, 2).toString('base64url');
const SESSION_ID = '00000000-0000-4000-8000-000000000010';
const SEGMENT_ID = '00000000-0000-4000-8000-000000000011';

class FakeSocket extends EventEmitter {
  readonly protocol = WEBSOCKET_SUBPROTOCOL;
  readyState: number = WebSocket.CONNECTING;
  readonly targets: string[];
  readonly frames: number[] = [];
  readonly duplicateFinal: boolean;
  #target = '';
  #utteranceId = '';

  constructor(targets: string[], duplicateFinal = false) {
    super();
    this.targets = targets;
    this.duplicateFinal = duplicateFinal;
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    });
  }

  send(data: string | Uint8Array): void {
    if (typeof data !== 'string') {
      const frame = decodeAudioFrame(data);
      this.frames.push(frame.sequence);
      this.emit('message', Buffer.from(JSON.stringify({
        type: 'audio.ack',
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        utteranceId: this.#utteranceId,
        highestContiguousExclusiveOffset: frame.offset + (frame.payload.byteLength / 2),
        flowState: 'normal'
      })), false);
      return;
    }
    const message = JSON.parse(data) as Record<string, unknown>;
    if (message.type === 'session.start') {
      this.#target = String(message.targetLanguage);
      this.targets.push(this.#target);
      this.emitJson({
        type: 'session.ready', result: 'new', sessionId: SESSION_ID, sessionEpoch: 1,
        targetLanguage: this.#target, languageRegistryVersion: '1.0.0', gatePolicyVersion: '1.0.0',
        effectiveLimits: message.requestedLimits, serverTime: '2026-08-18T00:00:00.000Z'
      });
    } else if (message.type === 'utterance.start') {
      this.#utteranceId = String(message.utteranceId);
    } else if (message.type === 'utterance.commit') {
      const targetText = this.#target === 'es' ? '¿Cómo está usted hoy?' : 'Bugün nasılsınız?';
      const targetSuggestions = this.#target === 'es'
        ? ['Sí, por favor.', 'No, gracias.']
        : ['Evet, lütfen.', 'Hayır, teşekkürler.'];
      const common = {
        sessionId: SESSION_ID, sessionEpoch: 1, utteranceId: this.#utteranceId,
        segmentId: SEGMENT_ID
      };
      const finalTranscript = {
        type: 'transcript.final', ...common, revision: 1, text: targetText,
        providerEventTime: '2026-08-18T00:00:01.000Z'
      };
      this.emitJson(finalTranscript);
      if (this.duplicateFinal) this.emitJson(finalTranscript);
      this.emitJson({
        type: 'language.decision', ...common, revision: 1, decision: 'target',
        selectedTargetLanguage: this.#target, detectedLanguage: this.#target,
        confidence: 0.99, gatePolicyVersion: '1.0.0'
      });
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
    } else if (message.type === 'session.end') {
      if (message.reason !== 'user_requested') throw new Error('invalid close reason');
      this.readyState = WebSocket.CLOSED;
      this.emit('close', 1000);
    }
  }

  emitJson(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000);
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
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

function fakeDependencies(options: { readonly duplicateFinal?: boolean } = {}): {
  dependencies: SecurityOpsDependencies;
  targets: string[];
  protocols: readonly string[][];
  requests: RequestInit[];
  issueCount: () => number;
} {
  const targets: string[] = [];
  const protocols: string[][] = [];
  const requests: RequestInit[] = [];
  let issues = 0;
  let fetches = 0;
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
    fetch: async (_input, init) => {
      requests.push(init ?? {});
      fetches += 1;
      if (fetches % 2 === 1) {
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toEqual({ 'content-type': 'application/json' });
        expect(init?.body).toBe(JSON.stringify({ pairingCode: PAIRING }));
        return Response.json({
          installationId: SESSION_ID, credential: CREDENTIAL, credentialVersion: 1,
          idleExpiresAt: '2026-08-18T01:00:00.000Z', absoluteExpiresAt: '2026-09-18T00:00:00.000Z'
        });
      }
      expect(init?.headers).toEqual({
        'content-type': 'application/json', authorization: `Bearer ${CREDENTIAL}`
      });
      return Response.json({
        ticket: TICKET, wssOrigin: ENV.PALANCAR_OP_RELAY_ORIGIN, wssPath: '/v1/stream',
        protocolVersion: 1, expiresAt: '2026-08-18T00:01:00.000Z'
      });
    },
    createSocket: (url, offered) => {
      expect(url).toBe('wss://relay.example.test/v1/stream');
      protocols.push([...offered]);
      return new FakeSocket(targets, options.duplicateFinal === true) as never;
    },
    delay: async () => undefined,
    now: (() => { let now = 0; return () => { now += 100; return now; }; })(),
    verifyAzureContext: async () => undefined
  };
  return { dependencies, targets, protocols, requests, issueCount: () => issues };
}

describe('security operations configuration', () => {
  it('constructs the exact table and audience boundary', () => {
    const config = parseSecurityOpsConfig(ENV);
    expect(config).toMatchObject({
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

  it.each([
    {},
    { ...ENV, PALANCAR_OP_UNKNOWN: 'x' },
    { ...ENV, PALANCAR_OP_TABLE_ENDPOINT: 'http://palancardevstateaeeacd8c.table.core.windows.net' },
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
    expect(fixture.issueCount()).toBe(2);
    expect(fixture.requests).toHaveLength(4);
    expect(fixture.protocols).toEqual([
      [WEBSOCKET_SUBPROTOCOL, `palancar.ticket.${TICKET}`],
      [WEBSOCKET_SUBPROTOCOL, `palancar.ticket.${TICKET}`]
    ]);
    const visible = `${output.stdout.join('')}${output.stderr.join('')}`;
    expect(visible).toMatch(/^security-ops smoke: pass targets=2 es_ms=\d+ tr_ms=\d+\n$/);
    for (const canary of [PAIRING, CREDENTIAL, TICKET, 'Cómo', 'Bugün', 'How are you']) {
      expect(visible).not.toContain(canary);
    }
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
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
  });

  it('rejects oversized HTTP bodies before parsing or opening a socket', async () => {
    const fixture = fakeDependencies();
    let sockets = 0;
    const dependencies: SecurityOpsDependencies = {
      ...fixture.dependencies,
      fetch: async () => new Response('x'.repeat(MAX_CONTROL_MESSAGE_BYTES + 1)),
      createSocket: () => { sockets += 1; return new FakeSocket([]) as never; }
    };
    await expect(runSecurityOps(['smoke'], ENV, fakeIo().io, dependencies)).rejects.toThrow(
      'Security operation failed.'
    );
    expect(sockets).toBe(0);
  });
});
