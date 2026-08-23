import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';

import {
  MAX_CONTROL_MESSAGE_BYTES,
  WEBSOCKET_SUBPROTOCOL,
  decodeAudioFrame,
  assertCanonicalWssOrigin,
  assertCredentialRotationConfirmationRequest,
  assertCredentialRotationRequest,
  assertPairingRedemptionRequest,
  assertPairingRedemptionResponse,
  assertRotationBeginResponse,
  assertRotationConfirmationResponse,
  assertSessionStart,
  assertUtteranceStart,
  assertSessionTicketRequest,
  assertSessionTicketResponse,
  isInstallationCredential,
  type NegotiatedLimits,
  type ServerControlMessage
} from '@palancar/contracts';
import {
  AzureOpenAIChatGenerationProvider,
  DeterministicFixtureLanguageValidator,
  DeterministicMockProvider,
  FailClosedGeneratedLanguageValidator,
  GenerationService,
  isDeterministicFixtureLanguageValidator,
  isFailClosedGeneratedLanguageValidator,
  type GeneratedLanguageValidator,
  type GenerationProvider,
  type GenerationProviderCompletion,
} from '@palancar/generation';
import {
  createAzureManagedIdentityTokenSource,
  type AzureTokenProvider
} from '@palancar/azure-auth';
import {
  AzureRealtimeTranscriptionAdapter,
  DeterministicMockTranscriptionAdapter,
  type TranscriptionAdapter
} from '@palancar/transcription';
import type { TargetLanguage, TextLanguageClassifier } from '@palancar/language-registry';
import { RelayOrderedFrameAcceptor } from '@palancar/audio';
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_AUDIO_GRANT_SAMPLES,
  SecurityStateError,
  assertCanonicalUuid,
  type HostTrustedOpaqueSource,
  type CredentialPromotionResult,
  type InstallationRevocationResult,
  type SecurityRuntimeStore,
  type SecurityStateMaintenanceStore,
  type SessionLease
} from '@palancar/security-state';
import type { AudioGrantMeter } from '@palancar/security-state/testing';
import { WebSocketServer, WebSocket } from 'ws';

import { negotiateLimits, prepareStreamUpgrade } from './protocol.js';
import { RelaySessionCore } from './session.js';
import {
  createControlledFixtureTextLanguageClassifier,
  createFailClosedDeployedTextLanguageClassifier,
  isControlledFixtureTextLanguageClassifier,
  isFailClosedDeployedTextLanguageClassifier
} from './language-classifier.js';
import {
  createDevelopmentProvisionalLanguageBoundary,
  isDevelopmentProvisionalGeneratedLanguageValidator,
  isDevelopmentProvisionalTextLanguageClassifier
} from './provisional-language-boundary.js';
import {
  createAzureTableSecurityComposition,
  createConnectionAudioGrantMeter,
  createLocalMockSecurityComposition,
  isDurableSecurityRuntime,
  type RelaySecurityComposition
} from './security.js';
import type {
  RelayClock,
  RelayIdGenerator,
  RelayLanguageBoundaryMode,
  RelayMetricSink,
  RelayStepResult,
  RelayUpgradeAudience
} from './types.js';
import {
  createDisabledRelayMetricSink,
  createProductionRelayMetricSink,
  isDisabledRelayMetricSink,
  type RelayMetricSinkConfig
} from './telemetry.js';
import {
  evaluateBrowserOrigin,
  parseBrowserOriginPolicy,
  type BrowserOriginDecision,
  type BrowserOriginPolicy
} from './origin-policy.js';

const SESSION_TICKET_PATH = '/v1/session-tickets';
const PAIRING_REDEMPTION_PATH = '/v1/pairing-redemptions';
const CREDENTIAL_ROTATION_PATH = '/v1/credential-rotations';
const CREDENTIAL_ROTATION_CONFIRMATION_PATH = '/v1/credential-rotation-confirmations';
const CURRENT_INSTALLATION_PATH = '/v1/installations/current';
const STREAM_PATH = '/v1/stream';
const MAX_AUTH_JSON_BODY_BYTES = 4_096;
const DEFAULT_PORT = 8_787;
const DEFAULT_GATE_POLICY_VERSION = '1.0.0';
const DEFAULT_BIND_HOST = '127.0.0.1' as const;
const REQUEST_REJECTED_BODY = Object.freeze({ error: 'request_rejected' });
const RELAY_CONFIGURATION_ERROR = 'Invalid relay host configuration.';
const READINESS_TIMEOUT_MS = 6_000;
const READINESS_SUCCESS_CACHE_MS = 30_000;
const READINESS_FAILURE_CACHE_MS = 2_000;
const DISABLED_RELAY_METRIC_SINK = createDisabledRelayMetricSink();
const SOCKET_CLOSE_WAIT_MS = 1_000;
const CONNECTION_WORK_DRAIN_TIMEOUT_MS = 6_000;
const REQUEST_WORK_DRAIN_TIMEOUT_MS = 6_000;
const DURABLE_CLEANUP_TIMEOUT_MS = 6_000;
const SHUTDOWN_TELEMETRY_TIMEOUT_MS = 5_000;
const RESOURCE_ROLLBACK_TIMEOUT_MS = 5_000;
const BODYLESS_REQUEST_TIMEOUT_MS = 1_000;
const AZURE_GENERATION_DEPLOYMENT = 'gpt-5.6-luna' as const;
const PREFLIGHT_VARY = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';
const DEFAULT_BROWSER_ORIGIN_POLICY: BrowserOriginPolicy = Object.freeze({
  allowedOrigins: Object.freeze([]),
  allowNullOrigin: false
});

type RelayBindHost = '127.0.0.1' | '0.0.0.0';

interface MockGenerationReadiness {
  readonly provider: 'mock';
  readonly providerId: string;
  readonly model: 'mock';
}

interface AzureOpenAIGenerationReadiness {
  readonly provider: 'azure-openai-chat';
  readonly providerId: string;
  readonly model: typeof AZURE_GENERATION_DEPLOYMENT;
  readonly check: (signal?: AbortSignal) => Promise<boolean>;
}

export type RelayGenerationReadiness = MockGenerationReadiness | AzureOpenAIGenerationReadiness;

export type RelayHostLifecycleState =
  | 'created'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped';

export interface RelayAzureTokenSource {
  readonly tokenProvider: AzureTokenProvider;
  close(): void;
}

export type RelayAzureTokenSourceFactory = (
  options: Readonly<{ readonly clientId: string }>
) => RelayAzureTokenSource;

export type RelayAzureTranscriptionAdapterFactory = (
  options: Readonly<{
    readonly endpoint: string;
    readonly deployment: string;
    readonly tokenProvider: AzureTokenProvider;
  }>
) => TranscriptionAdapter;

export type RelayAzureGenerationProviderFactory = (
  options: Readonly<{
    readonly endpoint: string;
    readonly deployment: typeof AZURE_GENERATION_DEPLOYMENT;
    readonly tokenProvider: AzureTokenProvider;
  }>
) => GenerationProvider;

export interface RelayHostConfig {
  readonly environment: string;
  readonly origin: string;
  readonly browserOriginPolicy?: BrowserOriginPolicy;
  readonly port: number;
  readonly bindHost?: RelayBindHost;
  readonly gatePolicyVersion: string;
  readonly securityMode?: RelaySecurityComposition['mode'];
  readonly deploymentSlot?: 'dev' | 'staging' | 'production';
  readonly security?: RelaySecurityComposition;
  readonly securityFactory?: () => RelaySecurityComposition;
  readonly clock?: RelayClock;
  readonly ids?: RelayIdGenerator;
  readonly languageBoundaryMode?: RelayLanguageBoundaryMode;
  readonly transcriptionAdapters?: Readonly<Record<TargetLanguage, TranscriptionAdapter>>;
  readonly languageClassifier?: TextLanguageClassifier;
  readonly generationService?: GenerationService;
  readonly generationProvider?: 'mock' | 'azure-openai';
  readonly azureGenerationEndpoint?: string;
  readonly azureGenerationDeployment?: string;
  readonly azureGenerationProviderFactory?: RelayAzureGenerationProviderFactory;
  readonly productionApprovedGenerationValidator?: GeneratedLanguageValidator;
  readonly developmentProvisionalGenerationValidator?: GeneratedLanguageValidator;
  readonly generationReadiness?: RelayGenerationReadiness;
  readonly metricSink?: RelayMetricSink;
  readonly metricSinkFactory?: () => RelayMetricSink;
  readonly transcriptionProvider?: 'mock' | 'azure-realtime';
  readonly azureTranscriptionEndpoint?: string;
  readonly azureTranscriptionDeployment?: string;
  readonly managedIdentityClientId?: string;
  readonly azureTokenSourceFactory?: RelayAzureTokenSourceFactory;
  readonly azureTranscriptionAdapterFactory?: RelayAzureTranscriptionAdapterFactory;
  readonly beforeServerMessageDelivery?: (message: ServerControlMessage) => void | Promise<void>;
}

export interface RelayHost {
  readonly server: Server;
  readonly securityRuntime: SecurityRuntimeStore;
  readonly securityMaintenance: SecurityStateMaintenanceStore;
  readonly lifecycleState: RelayHostLifecycleState;
  start(): Promise<{ readonly port: number }>;
  stop(): Promise<void>;
}

interface RelayConnection {
  readonly socket: WebSocket;
  readonly core: RelaySessionCore;
  queue: Promise<void>;
  closed: boolean;
  coreClosed: boolean;
  drainScheduled: boolean;
  lease: SessionLease;
  activated: boolean;
  ended: boolean;
  endPromise: Promise<void> | undefined;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  audio: RelayConnectionAudio | undefined;
  limits: NegotiatedLimits | undefined;
}

interface RelayConnectionAudio {
  readonly utteranceId: string;
  readonly acceptor: RelayOrderedFrameAcceptor;
  meter: AudioGrantMeter;
}

interface BodyReadResult {
  readonly status: 'ok' | 'too_large' | 'invalid';
  readonly value?: unknown;
}

interface AuthRouteDefinition {
  readonly method: 'POST' | 'DELETE';
  readonly allowHeaders: readonly string[];
  readonly requiresJsonBody: boolean;
}

const AUTH_ROUTES: Readonly<Record<string, AuthRouteDefinition>> = Object.freeze({
  [PAIRING_REDEMPTION_PATH]: Object.freeze({
    method: 'POST',
    allowHeaders: Object.freeze(['Content-Type']),
    requiresJsonBody: true
  }),
  [SESSION_TICKET_PATH]: Object.freeze({
    method: 'POST',
    allowHeaders: Object.freeze(['Authorization', 'Content-Type']),
    requiresJsonBody: true
  }),
  [CREDENTIAL_ROTATION_PATH]: Object.freeze({
    method: 'POST',
    allowHeaders: Object.freeze(['Authorization', 'Content-Type']),
    requiresJsonBody: true
  }),
  [CREDENTIAL_ROTATION_CONFIRMATION_PATH]: Object.freeze({
    method: 'POST',
    allowHeaders: Object.freeze(['Authorization', 'Content-Type']),
    requiresJsonBody: true
  }),
  [CURRENT_INSTALLATION_PATH]: Object.freeze({
    method: 'DELETE',
    allowHeaders: Object.freeze(['Authorization']),
    requiresJsonBody: false
  })
});

function systemClock(): RelayClock {
  return {
    nowIso: () => new Date().toISOString(),
    nowMonotonicMs: () => performance.now()
  };
}

function systemIds(): RelayIdGenerator {
  return {
    sessionId: () => randomUUID(),
    errorId: () => randomUUID()
  };
}

const BUILT_IN_FIXTURE_GENERATION_SERVICES = new WeakSet<GenerationService>();
const BUILT_IN_DEPLOYED_GENERATION_SERVICES = new WeakSet<GenerationService>();

class RelayDeterministicMockProvider extends DeterministicMockProvider {
  override async complete(
    input: Parameters<DeterministicMockProvider['complete']>[0],
    context: Parameters<DeterministicMockProvider['complete']>[1]
  ): Promise<GenerationProviderCompletion> {
    if (context.signal.aborted) throw new Error('aborted');
    return input.selectedTargetLanguage === 'es'
      ? {
          englishTranslation: 'A Spanish phrase translated to English.',
          suggestions: [
            { englishText: 'Yes, please.', selectedTargetText: 'Sí, por favor.' },
            { englishText: 'No, thank you.', selectedTargetText: 'No, gracias.' }
          ]
        }
      : {
          englishTranslation: 'A Turkish phrase translated to English.',
          suggestions: [
            { englishText: 'Yes, please.', selectedTargetText: 'Evet, lütfen.' },
            { englishText: 'No, thank you.', selectedTargetText: 'Hayır, teşekkürler.' }
          ]
        };
  }
}

function defaultTranscriptionAdapters(): Readonly<Record<TargetLanguage, TranscriptionAdapter>> {
  return Object.freeze({
    es: new DeterministicMockTranscriptionAdapter({
      evidenceCategory: 'selected-target',
      fixtureTargetLanguage: 'es'
    }),
    tr: new DeterministicMockTranscriptionAdapter({
      evidenceCategory: 'selected-target',
      fixtureTargetLanguage: 'tr'
    })
  });
}

function defaultGenerationService(
  boundary: 'fixture' | 'deny-all' | 'development-provisional',
  provisionalValidator?: GeneratedLanguageValidator
): GenerationService {
  const provider = new RelayDeterministicMockProvider({
    id: 'deterministic-mock-generation',
    version: '1.0.0',
    complete: {
      result: {
        englishTranslation: 'A Spanish phrase translated to English.',
        suggestions: [
          { englishText: 'Yes, please.', selectedTargetText: 'Sí, por favor.' },
          { englishText: 'No, thank you.', selectedTargetText: 'No, gracias.' }
        ]
      }
    }
  });
  const service = new GenerationService({
    provider,
    validator:
      boundary === 'fixture'
        ? new DeterministicFixtureLanguageValidator()
        : boundary === 'development-provisional'
          ? provisionalValidator ?? new FailClosedGeneratedLanguageValidator()
          : new FailClosedGeneratedLanguageValidator(),
    ...(boundary === 'development-provisional'
      ? { languageValidationMode: 'development-provisional' as const }
      : {})
  });
  if (boundary === 'fixture') {
    BUILT_IN_FIXTURE_GENERATION_SERVICES.add(service);
  } else {
    BUILT_IN_DEPLOYED_GENERATION_SERVICES.add(service);
  }
  return service;
}

function defaultGenerationReadiness(providerId: string): MockGenerationReadiness {
  return Object.freeze({
    provider: 'mock',
    providerId,
    model: 'mock'
  });
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError('Relay port is invalid');
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }
  if (!/^\d+$/.test(value)) {
    throw new RangeError('Relay PORT is invalid');
  }
  return normalizePort(Number(value));
}

function parseBindHost(value: string | undefined): RelayBindHost {
  const bindHost = value ?? DEFAULT_BIND_HOST;
  if (bindHost !== '127.0.0.1' && bindHost !== '0.0.0.0') {
    throw new RangeError('Relay bind host is invalid');
  }
  return bindHost;
}

function requiredEnvironmentString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value;
}

const CANONICAL_AZURE_CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_AZURE_TRANSCRIPTION_ENDPOINT =
  /^wss:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openai\.azure\.com\/openai\/v1\/realtime\?intent=transcription$/;
const CANONICAL_AZURE_TRANSCRIPTION_DEPLOYMENT =
  /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;
const CANONICAL_AZURE_GENERATION_ENDPOINT =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openai\.azure\.com$/;
const APPLICATION_INSIGHTS_REGIONAL_SUFFIX = '.in.applicationinsights.azure.com';
const APPLICATION_INSIGHTS_CLASSIC_HOST = 'dc.services.visualstudio.com';
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ALLOWED_PALANCAR_ENVIRONMENT_KEYS = new Set([
  'PALANCAR_RELAY_ORIGIN',
  'PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON',
  'PALANCAR_ALLOW_NULL_BROWSER_ORIGIN',
  'PALANCAR_SECURITY_MODE',
  'PALANCAR_SECURITY_STATE_TABLE',
  'PALANCAR_RATE_STATE_TABLE',
  'PALANCAR_GENERATION_PROVIDER',
  'PALANCAR_TRANSCRIPTION_PROVIDER',
  'PALANCAR_RELAY_ENVIRONMENT',
  'PALANCAR_RELAY_BIND_HOST',
  'PALANCAR_GATE_POLICY_VERSION',
  'PALANCAR_WORKLOAD_TABLE_ENDPOINT',
  'PALANCAR_DEPLOYMENT_SLOT',
  'PALANCAR_LANGUAGE_BOUNDARY_MODE',
  'PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT',
  'PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT',
  'PALANCAR_AZURE_GENERATION_ENDPOINT',
  'PALANCAR_AZURE_GENERATION_DEPLOYMENT'
]);

function hasEnvironmentValue(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] !== undefined;
}

function rejectUnknownPalancarEnvironmentKeys(env: NodeJS.ProcessEnv): void {
  if (
    Object.keys(env).some(
      (name) => name.startsWith('PALANCAR_') && !ALLOWED_PALANCAR_ENVIRONMENT_KEYS.has(name)
    )
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
}

function rejectEnvironmentKeys(
  env: NodeJS.ProcessEnv,
  predicate: (name: string) => boolean
): void {
  if (Object.keys(env).some((name) => predicate(name) && hasEnvironmentValue(env, name))) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
}

function rejectBoundarySelectionEnvironment(env: NodeJS.ProcessEnv): void {
  rejectEnvironmentKeys(env, (name) => {
    if (name === 'PALANCAR_LANGUAGE_BOUNDARY_MODE') return false;
    const normalized = name.toUpperCase();
    return normalized.includes('LANGUAGE_BOUNDARY') ||
      normalized.includes('BOUNDARY_MODE') ||
      normalized.includes('PRODUCTION_APPROVED') ||
      normalized.includes('CALIBRATION_PROFILE');
  });
}

export function canonicalAzureClientId(value: string): string {
  if (value !== value.toLowerCase() || !CANONICAL_AZURE_CLIENT_ID.test(value)) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value;
}

function canonicalAzureTranscriptionEndpoint(value: string): string {
  if (!CANONICAL_AZURE_TRANSCRIPTION_ENDPOINT.test(value)) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value;
}

function canonicalAzureTranscriptionDeployment(value: string): string {
  if (!CANONICAL_AZURE_TRANSCRIPTION_DEPLOYMENT.test(value)) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value;
}

export function canonicalAzureGenerationEndpoint(value: string): string {
  if (!CANONICAL_AZURE_GENERATION_ENDPOINT.test(value)) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value;
}

export function canonicalAzureGenerationDeployment(value: string): string {
  if (value !== AZURE_GENERATION_DEPLOYMENT) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value;
}

function validateApplicationInsightsConnectionString(value: string): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 2_048 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  const entries = value.endsWith(';') ? value.slice(0, -1).split(';') : value.split(';');
  if (entries.length !== 2) throw new TypeError(RELAY_CONFIGURATION_ERROR);
  const values = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new TypeError(RELAY_CONFIGURATION_ERROR);
    const key = entry.slice(0, separator);
    const item = entry.slice(separator + 1);
    if (key.length === 0 || item.length === 0 || values.has(key)) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    values.set(key, item);
  }
  const instrumentationKey = values.get('InstrumentationKey');
  const ingestionEndpoint = values.get('IngestionEndpoint');
  let parsedIngestionEndpoint: URL | undefined;
  try {
    parsedIngestionEndpoint = ingestionEndpoint === undefined
      ? undefined
      : new URL(ingestionEndpoint);
  } catch {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  const ingestionHost = parsedIngestionEndpoint?.hostname;
  const regionalPrefix = ingestionHost?.endsWith(APPLICATION_INSIGHTS_REGIONAL_SUFFIX)
    ? ingestionHost.slice(0, -APPLICATION_INSIGHTS_REGIONAL_SUFFIX.length)
    : undefined;
  const approvedIngestionHost = ingestionHost === APPLICATION_INSIGHTS_CLASSIC_HOST ||
    (regionalPrefix !== undefined &&
      regionalPrefix.length > 0 &&
      regionalPrefix.split('.').every((label) => DNS_LABEL.test(label)));
  if (
    values.size !== 2 ||
    instrumentationKey === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instrumentationKey) ||
    parsedIngestionEndpoint === undefined ||
    parsedIngestionEndpoint.protocol !== 'https:' ||
    parsedIngestionEndpoint.username !== '' ||
    parsedIngestionEndpoint.password !== '' ||
    parsedIngestionEndpoint.port !== '' ||
    parsedIngestionEndpoint.pathname !== '/' ||
    parsedIngestionEndpoint.search !== '' ||
    parsedIngestionEndpoint.hash !== '' ||
    ingestionHost !== ingestionHost?.toLowerCase() ||
    !approvedIngestionHost
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      utilTypes.isProxy(value)
    ) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

const RELAY_HOST_CONFIG_KEYS = new Set<PropertyKey>([
  'environment',
  'origin',
  'browserOriginPolicy',
  'port',
  'bindHost',
  'gatePolicyVersion',
  'securityMode',
  'deploymentSlot',
  'security',
  'securityFactory',
  'clock',
  'ids',
  'languageBoundaryMode',
  'transcriptionAdapters',
  'languageClassifier',
  'generationService',
  'generationProvider',
  'azureGenerationEndpoint',
  'azureGenerationDeployment',
  'azureGenerationProviderFactory',
  'productionApprovedGenerationValidator',
  'developmentProvisionalGenerationValidator',
  'generationReadiness',
  'metricSink',
  'metricSinkFactory',
  'transcriptionProvider',
  'azureTranscriptionEndpoint',
  'azureTranscriptionDeployment',
  'managedIdentityClientId',
  'azureTokenSourceFactory',
  'azureTranscriptionAdapterFactory',
  'beforeServerMessageDelivery'
]);

const SECURITY_RUNTIME_METHODS = Object.freeze([
  'redeemPairing',
  'authenticateCredential',
  'beginCredentialRotation',
  'promoteCredential',
  'revokeInstallation',
  'revokeCurrentInstallation',
  'issueSessionTicket',
  'consumeSessionTicket',
  'activateSession',
  'heartbeatSession',
  'endSession',
  'reserveAudio',
  'authorizeGeneration',
  'providerStart',
  'heartbeatGeneration',
  'completeGeneration',
  'releaseGeneration'
] as const);

function exactOwnDataValues(
  value: unknown,
  allowedKeys: ReadonlySet<PropertyKey>
): Readonly<Record<PropertyKey, unknown>> {
  if (!isPlainObject(value)) throw new TypeError(RELAY_CONFIGURATION_ERROR);
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  } catch {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  const result: Record<PropertyKey, unknown> = Object.create(null) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !allowedKeys.has(key) ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function dataProperty(value: unknown, key: PropertyKey): unknown {
  try {
    if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const visited = new Set<object>();
    let current: object | null = value;
    while (current !== null) {
      if (utilTypes.isProxy(current) || visited.has(current)) {
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value')) throw new TypeError(RELAY_CONFIGURATION_ERROR);
        return descriptor.value;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  throw new TypeError(RELAY_CONFIGURATION_ERROR);
}

function optionalDataProperty(value: unknown, key: PropertyKey): unknown | undefined {
  try {
    return dataProperty(value, key);
  } catch {
    return undefined;
  }
}

function hasMethods(value: unknown, names: readonly PropertyKey[]): boolean {
  try {
    return names.every((name) => typeof dataProperty(value, name) === 'function');
  } catch {
    return false;
  }
}

function validateSecurityCompositionShape(
  value: unknown,
  expectedMode?: RelaySecurityComposition['mode']
): RelaySecurityComposition {
  const values = exactOwnDataValues(value, new Set(['mode', 'runtime', 'maintenance']));
  if (Reflect.ownKeys(values).length !== 3) throw new TypeError(RELAY_CONFIGURATION_ERROR);
  const mode = values.mode;
  if (
    (mode !== 'local-mock' && mode !== 'azure-table') ||
    (expectedMode !== undefined && mode !== expectedMode) ||
    !hasMethods(values.runtime, SECURITY_RUNTIME_METHODS) ||
    !hasMethods(values.maintenance, ['checkReadiness', 'cleanupExpired'])
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return Object.freeze({
    mode,
    runtime: values.runtime as SecurityRuntimeStore,
    maintenance: values.maintenance as SecurityStateMaintenanceStore
  });
}

function validateTranscriptionAdapter(value: unknown): TranscriptionAdapter {
  if (
    !hasMethods(value, ['createSession', 'checkReadiness']) ||
    optionalDataProperty(value, 'capabilities') === undefined
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value as TranscriptionAdapter;
}

function validateTranscriptionAdapterMap(
  value: unknown
): Readonly<Record<TargetLanguage, TranscriptionAdapter>> {
  const values = exactOwnDataValues(value, new Set(['es', 'tr']));
  if (Reflect.ownKeys(values).length !== 2) throw new TypeError(RELAY_CONFIGURATION_ERROR);
  return Object.freeze({
    es: validateTranscriptionAdapter(values.es),
    tr: validateTranscriptionAdapter(values.tr)
  });
}

function validateLanguageClassifier(value: unknown): TextLanguageClassifier {
  const ready = optionalDataProperty(value, 'ready');
  if (
    ready === undefined ||
    !hasMethods(ready, ['then']) ||
    !hasMethods(value, ['classify'])
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value as TextLanguageClassifier;
}

function validateGeneratedLanguageValidator(value: unknown): GeneratedLanguageValidator {
  const id = optionalDataProperty(value, 'id');
  const version = optionalDataProperty(value, 'version');
  const validate = optionalDataProperty(value, 'validate');
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof version !== 'string' ||
    version.length === 0 ||
    typeof validate !== 'function' ||
    utilTypes.isProxy(validate)
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value as GeneratedLanguageValidator;
}

function generatedLanguageValidatorMetadata(value: unknown): Readonly<{
  readonly id: string;
  readonly version: string;
}> {
  const id = dataProperty(value, 'id');
  const version = dataProperty(value, 'version');
  const validate = dataProperty(value, 'validate');
  if (
    typeof id !== 'string' ||
    typeof version !== 'string' ||
    typeof validate !== 'function' ||
    utilTypes.isProxy(validate)
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return Object.freeze({ id, version });
}

interface GenerationServiceMetadata {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly validatorId: string;
  readonly validatorVersion: string;
  readonly languageValidationMode: GenerationService['languageValidationMode'];
  readonly usesValidator: (value: unknown) => boolean;
}

function generationServiceMetadata(value: unknown): GenerationServiceMetadata {
  if (!(value instanceof GenerationService) || utilTypes.isProxy(value)) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  try {
    const providerGetter = Object.getOwnPropertyDescriptor(
      GenerationService.prototype,
      'provider'
    )?.get;
    const validatorGetter = Object.getOwnPropertyDescriptor(
      GenerationService.prototype,
      'validator'
    )?.get;
    const modeGetter = Object.getOwnPropertyDescriptor(
      GenerationService.prototype,
      'languageValidationMode'
    )?.get;
    const usesValidatorMethod = Object.getOwnPropertyDescriptor(
      GenerationService.prototype,
      'usesValidator'
    )?.value;
    if (
      providerGetter === undefined ||
      validatorGetter === undefined ||
      modeGetter === undefined ||
      typeof usesValidatorMethod !== 'function'
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const provider = exactOwnDataValues(
      Reflect.apply(providerGetter, value, []),
      new Set(['id', 'version'])
    );
    const validator = exactOwnDataValues(
      Reflect.apply(validatorGetter, value, []),
      new Set(['id', 'version'])
    );
    const languageValidationMode = Reflect.apply(modeGetter, value, []);
    if (
      Reflect.ownKeys(provider).length !== 2 ||
      typeof provider.id !== 'string' ||
      typeof provider.version !== 'string' ||
      Reflect.ownKeys(validator).length !== 2 ||
      typeof validator.id !== 'string' ||
      typeof validator.version !== 'string' ||
      (languageValidationMode !== 'production-calibrated' &&
        languageValidationMode !== 'development-provisional')
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    return Object.freeze({
      providerId: provider.id,
      providerVersion: provider.version,
      validatorId: validator.id,
      validatorVersion: validator.version,
      languageValidationMode,
      usesValidator: (candidate: unknown): boolean =>
        Reflect.apply(usesValidatorMethod, value, [candidate]) === true
    });
  } catch {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
}

function validateAzureGenerationProvider(value: unknown): GenerationProvider {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  const id = dataProperty(value, 'id');
  const version = dataProperty(value, 'version');
  const complete = dataProperty(value, 'complete');
  if (
    id !== 'azure-openai-chat' ||
    version !== '1.0.0' ||
    typeof complete !== 'function' ||
    utilTypes.isProxy(complete)
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value as GenerationProvider;
}

function validateMetricSink(value: unknown): RelayMetricSink & {
  checkReadiness(signal?: AbortSignal): Promise<boolean>;
  shutdown(): Promise<void>;
} {
  if (!hasMethods(value, ['record', 'checkReadiness', 'shutdown'])) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  return value as RelayMetricSink & {
    checkReadiness(signal?: AbortSignal): Promise<boolean>;
    shutdown(): Promise<void>;
  };
}

function validateGenerationReadiness(
  value: unknown,
  expectedProviderId: string
): RelayGenerationReadiness {
  if (!isPlainObject(value)) throw new TypeError(RELAY_CONFIGURATION_ERROR);
  const provider = dataProperty(value, 'provider');
  if (provider === 'mock') {
    const values = exactOwnDataValues(value, new Set(['provider', 'providerId', 'model']));
    if (
      Reflect.ownKeys(values).length !== 3 ||
      values.providerId !== expectedProviderId ||
      values.model !== 'mock'
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    return Object.freeze({
      provider: 'mock',
      providerId: values.providerId as string,
      model: 'mock'
    });
  }
  if (provider === 'azure-openai-chat') {
    const values = exactOwnDataValues(
      value,
      new Set(['provider', 'providerId', 'model', 'check'])
    );
    if (
      Reflect.ownKeys(values).length !== 4 ||
      values.providerId !== expectedProviderId ||
      values.model !== AZURE_GENERATION_DEPLOYMENT ||
      typeof values.check !== 'function' ||
      utilTypes.isProxy(values.check)
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    return Object.freeze({
      provider: 'azure-openai-chat',
      providerId: values.providerId as string,
      model: AZURE_GENERATION_DEPLOYMENT,
      check: values.check as AzureOpenAIGenerationReadiness['check']
    });
  }
  throw new TypeError(RELAY_CONFIGURATION_ERROR);
}

function snapshotRelayHostConfig(config: RelayHostConfig): RelayHostConfig {
  const values = exactOwnDataValues(config, RELAY_HOST_CONFIG_KEYS);
  for (const required of ['environment', 'origin', 'port', 'gatePolicyVersion'] as const) {
    if (!Object.hasOwn(values, required)) throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  if (
    typeof values.environment !== 'string' ||
    values.environment.length === 0 ||
    typeof values.origin !== 'string' ||
    typeof values.port !== 'number' ||
    typeof values.gatePolicyVersion !== 'string' ||
    values.gatePolicyVersion.length === 0
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  if (
    values.securityMode !== undefined &&
    values.securityMode !== 'local-mock' &&
    values.securityMode !== 'azure-table'
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  if (
    values.deploymentSlot !== undefined &&
    values.deploymentSlot !== 'dev' &&
    values.deploymentSlot !== 'staging' &&
    values.deploymentSlot !== 'production'
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  if (
    values.languageBoundaryMode !== undefined &&
    values.languageBoundaryMode !== 'fixture' &&
    values.languageBoundaryMode !== 'deny-all' &&
    values.languageBoundaryMode !== 'production-approved' &&
    values.languageBoundaryMode !== 'development-provisional'
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  if (
    values.transcriptionProvider !== undefined &&
    values.transcriptionProvider !== 'mock' &&
    values.transcriptionProvider !== 'azure-realtime'
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  if (
    values.generationProvider === undefined ||
    (values.generationProvider !== 'mock' &&
      values.generationProvider !== 'azure-openai')
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  for (const key of [
    'securityFactory',
    'metricSinkFactory',
    'azureTokenSourceFactory',
    'azureTranscriptionAdapterFactory',
    'azureGenerationProviderFactory',
    'beforeServerMessageDelivery'
  ] as const) {
    if (
      values[key] !== undefined &&
      (typeof values[key] !== 'function' || utilTypes.isProxy(values[key]))
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
  }
  if (values.clock !== undefined && !hasMethods(values.clock, ['nowIso', 'nowMonotonicMs'])) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  if (values.ids !== undefined && !hasMethods(values.ids, ['sessionId', 'errorId'])) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  if (
    values.generationService !== undefined &&
    !(values.generationService instanceof GenerationService)
  ) {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
  if (values.productionApprovedGenerationValidator !== undefined) {
    validateGeneratedLanguageValidator(values.productionApprovedGenerationValidator);
  }
  if (values.developmentProvisionalGenerationValidator !== undefined) {
    validateGeneratedLanguageValidator(values.developmentProvisionalGenerationValidator);
  }
  if (values.languageClassifier !== undefined) validateLanguageClassifier(values.languageClassifier);
  if (values.transcriptionAdapters !== undefined) {
    validateTranscriptionAdapterMap(values.transcriptionAdapters);
  }
  if (values.metricSink !== undefined) validateMetricSink(values.metricSink);
  if (values.azureTranscriptionEndpoint !== undefined) {
    if (typeof values.azureTranscriptionEndpoint !== 'string') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    canonicalAzureTranscriptionEndpoint(values.azureTranscriptionEndpoint);
  }
  if (values.azureTranscriptionDeployment !== undefined) {
    if (typeof values.azureTranscriptionDeployment !== 'string') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    canonicalAzureTranscriptionDeployment(values.azureTranscriptionDeployment);
  }
  if (values.azureGenerationEndpoint !== undefined) {
    if (typeof values.azureGenerationEndpoint !== 'string') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    canonicalAzureGenerationEndpoint(values.azureGenerationEndpoint);
  }
  if (values.azureGenerationDeployment !== undefined) {
    if (typeof values.azureGenerationDeployment !== 'string') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    canonicalAzureGenerationDeployment(values.azureGenerationDeployment);
  }
  if (values.managedIdentityClientId !== undefined) {
    if (typeof values.managedIdentityClientId !== 'string') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    canonicalAzureClientId(values.managedIdentityClientId);
  }
  return Object.freeze({ ...values }) as unknown as RelayHostConfig;
}

function normalizeBrowserOriginPolicy(
  value: BrowserOriginPolicy | undefined
): BrowserOriginPolicy {
  if (value === undefined) return DEFAULT_BROWSER_ORIGIN_POLICY;
  try {
    if (!isPlainObject(value)) throw new TypeError(RELAY_CONFIGURATION_ERROR);
    const keys = Object.keys(value);
    if (
      keys.length !== 2 ||
      !keys.includes('allowedOrigins') ||
      !keys.includes('allowNullOrigin') ||
      !Array.isArray(value.allowedOrigins) ||
      typeof value.allowNullOrigin !== 'boolean'
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    return parseBrowserOriginPolicy({
      PALANCAR_BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify([...value.allowedOrigins]),
      PALANCAR_ALLOW_NULL_BROWSER_ORIGIN: String(value.allowNullOrigin)
    });
  } catch {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
}

async function boundedReadinessCheck(
  parentSignal: AbortSignal,
  check: (signal: AbortSignal) => Promise<boolean>
): Promise<boolean> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let parentListener: (() => void) | undefined;
  const abortedResult = new Promise<boolean>((resolve) => {
    parentListener = () => {
      controller.abort();
      resolve(false);
    };
    try {
      parentSignal.addEventListener('abort', parentListener, { once: true });
      if (parentSignal.aborted) parentListener();
    } catch {
      parentListener();
    }
  });
  const timeoutResult = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, READINESS_TIMEOUT_MS);
  });
  try {
    const checkResult = Promise.resolve().then(() => check(controller.signal)).then(
      (ready) => ready === true,
      () => false
    );
    return await Promise.race([checkResult, timeoutResult, abortedResult]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (parentListener !== undefined) {
      try {
        parentSignal.removeEventListener('abort', parentListener);
      } catch {
        // Readiness cancellation cleanup is best effort.
      }
    }
  }
}

function applyCors(
  response: ServerResponse,
  origin: string | undefined,
  vary = 'Origin'
): void {
  if (origin === undefined) {
    return;
  }
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', vary);
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  corsOrigin?: string,
  vary = 'Origin'
): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  applyCors(response, corsOrigin, vary);
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function writeSensitiveJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  corsOrigin?: string,
  vary = 'Origin'
): void {
  response.setHeader('cache-control', 'no-store');
  writeJson(response, status, value, corsOrigin, vary);
}

function writeNoContent(response: ServerResponse, corsOrigin?: string): void {
  response.statusCode = 204;
  applyCors(response, corsOrigin);
  response.setHeader('cache-control', 'no-store');
  response.removeHeader('content-type');
  response.removeHeader('content-length');
  response.end();
}

function securityHttpStatus(error: unknown): 400 | 401 | 409 | 429 | 503 {
  if (!(error instanceof SecurityStateError)) return 503;
  const category = error.category;
  if (category === 'credential-conflict') return 409;
  if (category === 'quota-exceeded' || category === 'rate-limited') return 429;
  if (category === 'state-unavailable') return 503;
  if (category === 'session-rejected' || category === 'stale-lease') return 409;
  if (category === 'invalid-input') return 400;
  return 401;
}

function assertRelayRequest<T>(assertion: () => T): T {
  try {
    return assertion();
  } catch {
    throw new SecurityStateError('invalid-input');
  }
}

function bearerCredential(request: IncomingMessage): string | undefined {
  const values = rawHeaderValues(request, 'authorization');
  const authorization = values[0];
  if (values.length !== 1 || authorization === undefined || !authorization.startsWith('Bearer ')) {
    return undefined;
  }
  const credential = authorization.slice('Bearer '.length);
  return isInstallationCredential(credential) ? credential : undefined;
}

function trustedSocketSource(request: IncomingMessage): HostTrustedOpaqueSource | undefined {
  const address = request.socket.remoteAddress;
  if (address === undefined || address.length === 0 || address.length > 128) return undefined;
  return `socket:${address}` as HostTrustedOpaqueSource;
}

interface UpgradeSocket {
  write(chunk: string): void;
  destroy(): void;
}

interface PendingUpgrade {
  readonly socket: UpgradeSocket;
  decision: Promise<void>;
  preparedLease?: SessionLease;
  cancelled: boolean;
}

function writeRejectedUpgrade(socket: UpgradeSocket, status: number): void {
  const body = JSON.stringify(REQUEST_REJECTED_BODY);
  const reason = status === 400
    ? 'Bad Request'
    : status === 401
      ? 'Unauthorized'
      : status === 403
        ? 'Forbidden'
        : status === 404
          ? 'Not Found'
          : status === 409
            ? 'Conflict'
            : status === 429
              ? 'Too Many Requests'
              : 'Service Unavailable';
  const response = [
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    'Cache-Control: no-store',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n');
  socket.write(response);
  socket.destroy();
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value.join(',');
  }
  return value;
}

function rawHeaderValues(request: IncomingMessage, name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== name.toLowerCase()) continue;
    const value = request.rawHeaders[index + 1];
    if (value !== undefined) values.push(value);
  }
  return values;
}

function evaluateRequestOrigin(
  policy: BrowserOriginPolicy,
  request: IncomingMessage
): BrowserOriginDecision {
  const values = rawHeaderValues(request, 'origin');
  if (values.length > 1) return { kind: 'rejected' };
  return evaluateBrowserOrigin(policy, values[0]);
}

function offeredSubprotocols(request: IncomingMessage): readonly string[] {
  const header = headerValue(request, 'sec-websocket-protocol');
  if (header === undefined) {
    return [];
  }
  return header.split(',').map((value) => value.trim());
}

function readJsonBody(request: IncomingMessage): Promise<BodyReadResult> {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined && /^\d+$/.test(contentLength)) {
    if (Number(contentLength) > MAX_AUTH_JSON_BODY_BYTES) {
      request.resume();
      return Promise.resolve({ status: 'too_large' });
    }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;

    const finish = (result: BodyReadResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > MAX_AUTH_JSON_BODY_BYTES) {
        finish({ status: 'too_large' });
        request.removeAllListeners('data');
        request.resume();
        return;
      }
      chunks.push(bytes);
    });
    request.on('end', () => {
      if (settled) {
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        finish({ status: 'ok', value: JSON.parse(text) as unknown });
      } catch {
        finish({ status: 'invalid' });
      }
    });
    request.on('error', () => finish({ status: 'invalid' }));
  });
}

function readNoBody(request: IncomingMessage): Promise<boolean> {
  const contentLength = headerValue(request, 'content-length');
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > 0) {
      request.resume();
      return Promise.resolve(false);
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = (): void => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('aborted', onFailure);
      request.removeListener('close', onFailure);
      request.removeListener('error', onFailure);
      clearTimeout(timeout);
    };
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      if ((Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)) > 0) {
        finish(false);
        request.resume();
      }
    };
    const onEnd = (): void => finish(true);
    const onFailure = (): void => finish(false);
    const timeout = setTimeout(() => {
      finish(false);
      request.resume();
    }, BODYLESS_REQUEST_TIMEOUT_MS);
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onFailure);
    request.once('close', onFailure);
    request.once('error', onFailure);
    if (request.readableEnded) finish(true);
  });
}

function requestedCorsHeaders(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const tokens = value.split(',');
  if (tokens.some((token) => token.trim().length === 0)) return undefined;
  const normalized = tokens.map((token) => token.trim().toLowerCase());
  if (normalized.some((token) => !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(token))) {
    return undefined;
  }
  if (new Set(normalized).size !== normalized.length) return undefined;
  return Object.freeze(normalized);
}

function validPreflight(
  request: IncomingMessage,
  route: AuthRouteDefinition
): boolean {
  if (headerValue(request, 'access-control-request-method') !== route.method) return false;
  const requestMetadata = new Set([
    'access-control-request-method',
    'access-control-request-headers'
  ]);
  if (Object.keys(request.headers).some((name) =>
    name.toLowerCase().startsWith('access-control-request-') &&
    !requestMetadata.has(name.toLowerCase())
  )) return false;
  const requested = requestedCorsHeaders(headerValue(request, 'access-control-request-headers'));
  if (requested === undefined || requested.length !== route.allowHeaders.length) return false;
  const allowed = new Set(route.allowHeaders.map((header) => header.toLowerCase()));
  return requested.every((header) => allowed.has(header));
}

function writePreflight(
  response: ServerResponse,
  route: AuthRouteDefinition,
  origin: string | undefined
): void {
  if (origin !== undefined) {
    response.setHeader('access-control-allow-origin', origin);
  }
  response.setHeader(
    'vary',
    PREFLIGHT_VARY
  );
  response.setHeader('cache-control', 'no-store');
  response.setHeader('access-control-allow-methods', route.method);
  response.setHeader('access-control-allow-headers', route.allowHeaders.join(', '));
  response.statusCode = 204;
  response.removeHeader('content-type');
  response.removeHeader('content-length');
  response.end();
}

function rawDataBuffer(data: unknown): Buffer | undefined {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    const buffers: Buffer[] = [];
    for (const part of data) {
      if (Buffer.isBuffer(part)) {
        buffers.push(part);
      } else if (part instanceof ArrayBuffer) {
        buffers.push(Buffer.from(part));
      } else if (ArrayBuffer.isView(part)) {
        buffers.push(Buffer.from(
          part.buffer as ArrayBuffer,
          part.byteOffset,
          part.byteLength
        ));
      } else {
        return undefined;
      }
    }
    return Buffer.concat(buffers);
  }
  return undefined;
}

export function parseRelayHostConfig(env: NodeJS.ProcessEnv = process.env): RelayHostConfig {
  try {
    rejectUnknownPalancarEnvironmentKeys(env);
    rejectEnvironmentKeys(env, (name) =>
      name.startsWith('PALANCAR_LITELLM_') ||
      name.startsWith('OPENROUTER_') ||
      name === 'LITELLM_MASTER_KEY' ||
      name.startsWith('OPENAI_') ||
      name.startsWith('AZURE_OPENAI_') ||
      name === 'AZURE_FOUNDRY_TOKEN_SCOPE' ||
      name === 'AZURE_API_KEY' ||
      (name.startsWith('PALANCAR_GENERATION_') &&
        name !== 'PALANCAR_GENERATION_PROVIDER') ||
      (name.startsWith('PALANCAR_AZURE_GENERATION_') &&
        name !== 'PALANCAR_AZURE_GENERATION_ENDPOINT' &&
        name !== 'PALANCAR_AZURE_GENERATION_DEPLOYMENT')
    );
    rejectBoundarySelectionEnvironment(env);
    rejectEnvironmentKeys(env, (name) =>
      name.startsWith('PALANCAR_OTLP') ||
      name.startsWith('OTEL_EXPORTER') ||
      name === 'AZURE_LOG_LEVEL'
    );
    const port = parsePort(env.PORT);
    const origin = env.PALANCAR_RELAY_ORIGIN ??
      (port === 0 ? 'wss://127.0.0.1' : `wss://127.0.0.1:${port}`);
    assertCanonicalWssOrigin(origin);
    const browserOriginPolicy = parseBrowserOriginPolicy(env);
    const securityMode = env.PALANCAR_SECURITY_MODE;
    if (securityMode !== 'local-mock' && securityMode !== 'azure-table') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    if (
      securityMode === 'azure-table' &&
      (env.PALANCAR_SECURITY_STATE_TABLE !== 'SecurityState' ||
        env.PALANCAR_RATE_STATE_TABLE !== 'RateState')
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const generationProvider = env.PALANCAR_GENERATION_PROVIDER;
    if (generationProvider !== 'mock' && generationProvider !== 'azure-openai') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const transcriptionProvider = env.PALANCAR_TRANSCRIPTION_PROVIDER;
    if (transcriptionProvider !== 'mock' && transcriptionProvider !== 'azure-realtime') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }

    const environment = securityMode === 'local-mock'
      ? 'local-mock'
      : requiredEnvironmentString(env, 'PALANCAR_RELAY_ENVIRONMENT');
    const bindHost = parseBindHost(env.PALANCAR_RELAY_BIND_HOST);
    const originHost = new URL(origin).hostname;
    const audience = Object.freeze({
      origin,
      path: STREAM_PATH,
      protocol: WEBSOCKET_SUBPROTOCOL
    });

    if (securityMode === 'local-mock') {
      if (
        generationProvider !== 'mock' ||
        transcriptionProvider !== 'mock' ||
        bindHost !== '127.0.0.1' ||
        originHost !== '127.0.0.1' ||
        hasEnvironmentValue(env, 'PALANCAR_RELAY_ENVIRONMENT') ||
        hasEnvironmentValue(env, 'PALANCAR_LANGUAGE_BOUNDARY_MODE')
      ) {
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
      rejectEnvironmentKeys(env, (name) =>
        name.startsWith('PALANCAR_AZURE_') ||
        name === 'PALANCAR_WORKLOAD_TABLE_ENDPOINT' ||
        name === 'PALANCAR_SECURITY_STATE_TABLE' ||
        name === 'PALANCAR_RATE_STATE_TABLE' ||
        name === 'AZURE_CLIENT_ID' ||
        name === 'PALANCAR_DEPLOYMENT_SLOT' ||
        name === 'APPLICATIONINSIGHTS_CONNECTION_STRING' ||
        name === 'APPLICATIONINSIGHTS_STATSBEAT_DISABLED' ||
        name === 'APPLICATION_INSIGHTS_NO_STATSBEAT' ||
        name === 'AZURE_API_KEY'
      );
      const generationService = defaultGenerationService('fixture');
      return Object.freeze({
        environment,
        origin,
        browserOriginPolicy,
        port,
        bindHost,
        gatePolicyVersion: env.PALANCAR_GATE_POLICY_VERSION ?? DEFAULT_GATE_POLICY_VERSION,
        securityMode: 'local-mock' as const,
        languageBoundaryMode: 'fixture' as const,
        transcriptionProvider: 'mock' as const,
        generationProvider: 'mock' as const,
        generationService,
        generationReadiness: defaultGenerationReadiness(
          generationServiceMetadata(generationService).providerId
        )
      });
    }

    if (
      env.PALANCAR_SECURITY_STATE_TABLE !== 'SecurityState' ||
      env.PALANCAR_RATE_STATE_TABLE !== 'RateState'
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    rejectEnvironmentKeys(env, (name) => name === 'PALANCAR_TRANSCRIPTION_API_KEY');
    const tableEndpoint = requiredEnvironmentString(env, 'PALANCAR_WORKLOAD_TABLE_ENDPOINT');
    const managedIdentityClientId = canonicalAzureClientId(
      requiredEnvironmentString(env, 'AZURE_CLIENT_ID')
    );
    const deploymentSlot = env.PALANCAR_DEPLOYMENT_SLOT;
    if (deploymentSlot !== 'dev' && deploymentSlot !== 'staging' && deploymentSlot !== 'production') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const requestedLanguageBoundary = env.PALANCAR_LANGUAGE_BOUNDARY_MODE;
    if (
      requestedLanguageBoundary !== undefined &&
      requestedLanguageBoundary !== 'deny-all' &&
      requestedLanguageBoundary !== 'development-provisional'
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    if (
      requestedLanguageBoundary === 'development-provisional' &&
      deploymentSlot !== 'dev'
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const provisionalBoundary =
      requestedLanguageBoundary === 'development-provisional'
        ? createDevelopmentProvisionalLanguageBoundary()
        : undefined;
    if (env.APPLICATIONINSIGHTS_STATSBEAT_DISABLED !== 'true' ||
      env.APPLICATION_INSIGHTS_NO_STATSBEAT !== 'true') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const connectionString = validateApplicationInsightsConnectionString(
      requiredEnvironmentString(env, 'APPLICATIONINSIGHTS_CONNECTION_STRING')
    );
    const azureTranscriptionEndpoint = transcriptionProvider === 'azure-realtime'
      ? canonicalAzureTranscriptionEndpoint(
          requiredEnvironmentString(env, 'PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT')
        )
      : undefined;
    const azureTranscriptionDeployment = transcriptionProvider === 'azure-realtime'
      ? canonicalAzureTranscriptionDeployment(
          requiredEnvironmentString(env, 'PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT')
        )
      : undefined;
    rejectEnvironmentKeys(env, (name) =>
      name.startsWith('PALANCAR_AZURE_') &&
      name !== 'PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT' &&
      name !== 'PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT' &&
      name !== 'PALANCAR_AZURE_GENERATION_ENDPOINT' &&
      name !== 'PALANCAR_AZURE_GENERATION_DEPLOYMENT'
    );
    if (
      transcriptionProvider === 'mock' &&
      (hasEnvironmentValue(env, 'PALANCAR_AZURE_TRANSCRIPTION_ENDPOINT') ||
        hasEnvironmentValue(env, 'PALANCAR_AZURE_TRANSCRIPTION_DEPLOYMENT'))
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    if (generationProvider !== 'azure-openai') {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const azureGenerationEndpoint = canonicalAzureGenerationEndpoint(
      requiredEnvironmentString(env, 'PALANCAR_AZURE_GENERATION_ENDPOINT')
    );
    const azureGenerationDeployment = canonicalAzureGenerationDeployment(
      requiredEnvironmentString(env, 'PALANCAR_AZURE_GENERATION_DEPLOYMENT')
    );

    const baseConfig: Omit<RelayHostConfig, 'generationService' | 'generationReadiness'> = {
      environment,
      origin,
      browserOriginPolicy,
      port,
      bindHost,
      gatePolicyVersion: env.PALANCAR_GATE_POLICY_VERSION ?? DEFAULT_GATE_POLICY_VERSION,
      securityMode: 'azure-table' as const,
      deploymentSlot,
      generationProvider: 'azure-openai' as const,
      azureGenerationEndpoint,
      azureGenerationDeployment,
      securityFactory: () => createAzureTableSecurityComposition({
        endpoint: tableEndpoint,
        environment,
        audience,
        managedIdentityClientId
      }),
      languageBoundaryMode:
        provisionalBoundary === undefined
          ? 'deny-all' as const
          : 'development-provisional' as const,
      ...(provisionalBoundary === undefined
        ? {}
        : {
            languageClassifier: provisionalBoundary.classifier,
            developmentProvisionalGenerationValidator:
              provisionalBoundary.generatedLanguageValidator
          }),
      transcriptionProvider: transcriptionProvider as 'mock' | 'azure-realtime',
      ...(azureTranscriptionEndpoint === undefined
        ? {}
        : { azureTranscriptionEndpoint }),
      ...(azureTranscriptionDeployment === undefined
        ? {}
        : { azureTranscriptionDeployment }),
      managedIdentityClientId,
      metricSinkFactory: () => createProductionRelayMetricSink({
        clientId: managedIdentityClientId,
        deploymentSlot,
        connectionString,
        applicationInsightsStatsbeatDisabled: true,
        applicationInsightsNoStatsbeat: true
      } satisfies RelayMetricSinkConfig)
    };
    return Object.freeze(baseConfig);
  } catch {
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
}

function containCleanupPromise(value: unknown, timeoutMs: number): void {
  if (value === undefined || value === null || !hasMethods(value, ['then'])) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  void Promise.race([
    Promise.resolve(value).then(() => undefined, () => undefined),
    timeout
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function invokeResourceCleanup(operation: () => unknown): void {
  try {
    containCleanupPromise(operation(), RESOURCE_ROLLBACK_TIMEOUT_MS);
  } catch {
    // Construction rollback is intentionally content-free.
  }
}

export function createRelayHost(config: RelayHostConfig): RelayHost {
  const acquiredCloseables: Array<() => unknown> = [];
  let acquiredMetricSink: ReturnType<typeof validateMetricSink> | undefined;
  let partialMetricCleanup: (() => unknown) | undefined;
  try {
    const validatedConfig = snapshotRelayHostConfig(config);
    const environment = validatedConfig.environment;
    const origin = assertCanonicalWssOrigin(validatedConfig.origin);
    const browserOriginPolicy = normalizeBrowserOriginPolicy(validatedConfig.browserOriginPolicy);
    const port = normalizePort(validatedConfig.port);
    const bindHost = parseBindHost(validatedConfig.bindHost);
    const gatePolicyVersion = validatedConfig.gatePolicyVersion;
    const clock = validatedConfig.clock ?? systemClock();
    const ids = validatedConfig.ids ?? systemIds();
    const beforeServerMessageDelivery = validatedConfig.beforeServerMessageDelivery;
    const audience: RelayUpgradeAudience = Object.freeze({
      origin,
      path: STREAM_PATH,
      protocol: WEBSOCKET_SUBPROTOCOL
    });
    const configuredSecurity = validatedConfig.security === undefined
      ? undefined
      : validateSecurityCompositionShape(validatedConfig.security, validatedConfig.securityMode);
    if (configuredSecurity !== undefined && validatedConfig.securityFactory !== undefined) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const securityMode = validatedConfig.securityMode ?? configuredSecurity?.mode ?? 'local-mock';
    if (securityMode === 'azure-table' &&
      configuredSecurity === undefined && validatedConfig.securityFactory === undefined) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    if (securityMode === 'local-mock' && validatedConfig.securityFactory !== undefined) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const localComposition = securityMode === 'local-mock';
    const loopbackComposition = bindHost === '127.0.0.1' && new URL(origin).hostname === '127.0.0.1';
    const explicitFixtureHarness = configuredSecurity !== undefined &&
      validatedConfig.languageBoundaryMode === 'fixture' &&
      validatedConfig.transcriptionProvider === undefined;

    if (localComposition && (environment !== 'local-mock' || !loopbackComposition)) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const configuredMetricSink = validatedConfig.metricSink;
    const telemetryMechanisms = Number(configuredMetricSink !== undefined) +
      Number(validatedConfig.metricSinkFactory !== undefined);
    if (
      (localComposition &&
        (validatedConfig.metricSinkFactory !== undefined ||
          (configuredMetricSink !== undefined &&
            configuredMetricSink !== DISABLED_RELAY_METRIC_SINK))) ||
      (!localComposition &&
        (telemetryMechanisms !== 1 || isDisabledRelayMetricSink(configuredMetricSink)))
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }

    const configuredAdapters = validatedConfig.transcriptionAdapters === undefined
      ? undefined
      : validateTranscriptionAdapterMap(validatedConfig.transcriptionAdapters);
    const configuredAdaptersAreTargetSpecificMocks = configuredAdapters !== undefined &&
      configuredAdapters.es instanceof DeterministicMockTranscriptionAdapter &&
      configuredAdapters.tr instanceof DeterministicMockTranscriptionAdapter &&
      configuredAdapters.es.configuration.fixtureTargetLanguage === 'es' &&
      configuredAdapters.tr.configuration.fixtureTargetLanguage === 'tr';
    const configuredAdaptersAreAzureShared = configuredAdapters !== undefined &&
      configuredAdapters.es instanceof AzureRealtimeTranscriptionAdapter &&
      configuredAdapters.es === configuredAdapters.tr;
    const inferredTranscriptionProvider = validatedConfig.transcriptionProvider ??
      (configuredAdaptersAreAzureShared ? 'azure-realtime' : 'mock');
    const hasTokenFactory = validatedConfig.azureTokenSourceFactory !== undefined;
    const hasAdapterFactory = validatedConfig.azureTranscriptionAdapterFactory !== undefined;
    const generationMode = validatedConfig.generationProvider;
    const generationIsAzure = generationMode === 'azure-openai';
    if (
      (hasAdapterFactory && inferredTranscriptionProvider !== 'azure-realtime') ||
      (!hasTokenFactory && hasAdapterFactory) ||
      (!generationIsAzure && hasTokenFactory && inferredTranscriptionProvider !== 'azure-realtime')
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    if (inferredTranscriptionProvider === 'azure-realtime') {
      if (
        configuredAdapters !== undefined ||
        validatedConfig.managedIdentityClientId === undefined ||
        validatedConfig.azureTranscriptionEndpoint === undefined ||
        validatedConfig.azureTranscriptionDeployment === undefined
      ) {
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
    } else if (
      validatedConfig.azureTranscriptionEndpoint !== undefined ||
      validatedConfig.azureTranscriptionDeployment !== undefined ||
      hasAdapterFactory
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    if (
      generationIsAzure &&
      (validatedConfig.generationService !== undefined ||
        validatedConfig.generationReadiness !== undefined)
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    if (
      generationIsAzure &&
      (validatedConfig.azureGenerationEndpoint === undefined ||
        validatedConfig.azureGenerationDeployment === undefined ||
        validatedConfig.managedIdentityClientId === undefined)
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    if (
      !generationIsAzure &&
      (validatedConfig.azureGenerationEndpoint !== undefined ||
        validatedConfig.azureGenerationDeployment !== undefined ||
        validatedConfig.azureGenerationProviderFactory !== undefined)
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    let generationService!: GenerationService;
    let generationServiceInfo!: GenerationServiceMetadata;
    let generationReadiness!: RelayGenerationReadiness;
    if (!generationIsAzure) {
      generationService = validatedConfig.generationService ??
        defaultGenerationService(localComposition ? 'fixture' : 'deny-all');
      generationServiceInfo = generationServiceMetadata(generationService);
      generationReadiness = validatedConfig.generationReadiness === undefined
        ? defaultGenerationReadiness(generationServiceInfo.providerId)
        : validateGenerationReadiness(
            validatedConfig.generationReadiness,
            generationServiceInfo.providerId
          );
      if (
        !explicitFixtureHarness &&
        (generationReadiness.provider !== 'mock' ||
          !generationServiceInfo.providerId.startsWith('deterministic-mock'))
      ) {
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
    }
    let metricSink: ReturnType<typeof validateMetricSink>;
    if (localComposition) {
      metricSink = validateMetricSink(DISABLED_RELAY_METRIC_SINK);
    } else if (configuredMetricSink !== undefined) {
      metricSink = validateMetricSink(configuredMetricSink);
      acquiredMetricSink = metricSink;
    } else {
      let metricSinkCandidate: unknown;
      try {
        metricSinkCandidate = (validatedConfig.metricSinkFactory as () => RelayMetricSink)();
        if (isDisabledRelayMetricSink(metricSinkCandidate)) {
          throw new TypeError(RELAY_CONFIGURATION_ERROR);
        }
        metricSink = validateMetricSink(metricSinkCandidate);
        acquiredMetricSink = metricSink;
      } catch {
        if (!isDisabledRelayMetricSink(metricSinkCandidate)) {
          const partialShutdown = optionalDataProperty(metricSinkCandidate, 'shutdown');
          if (typeof partialShutdown === 'function' && !utilTypes.isProxy(partialShutdown)) {
            partialMetricCleanup = () => partialShutdown.call(metricSinkCandidate);
          }
        }
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
    }

    const security = configuredSecurity ??
      (validatedConfig.securityFactory === undefined
        ? validateSecurityCompositionShape(
            createLocalMockSecurityComposition({ audience }),
            'local-mock'
          )
        : validateSecurityCompositionShape(
            validatedConfig.securityFactory(),
            securityMode
          ));
    if (!localComposition && !isDurableSecurityRuntime(security.runtime)) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const needsAzureTokenSource = generationIsAzure || inferredTranscriptionProvider === 'azure-realtime';
    let sharedTokenProvider: AzureTokenProvider | undefined;
    if (needsAzureTokenSource) {
      const clientId = validatedConfig.managedIdentityClientId as string;
      const tokenSourceFactory = validatedConfig.azureTokenSourceFactory ??
        ((options: Readonly<{ readonly clientId: string }>) =>
          createAzureManagedIdentityTokenSource(options));
      const tokenSource = tokenSourceFactory({ clientId });
      const tokenProvider = optionalDataProperty(tokenSource, 'tokenProvider');
      const closeTokenSource = optionalDataProperty(tokenSource, 'close');
      if (
        typeof tokenProvider !== 'function' ||
        utilTypes.isProxy(tokenProvider) ||
        typeof closeTokenSource !== 'function' ||
        utilTypes.isProxy(closeTokenSource)
      ) {
        if (typeof closeTokenSource === 'function' && !utilTypes.isProxy(closeTokenSource)) {
          invokeResourceCleanup(() => closeTokenSource.call(tokenSource));
        }
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
      sharedTokenProvider = tokenProvider as AzureTokenProvider;
      acquiredCloseables.push(() => closeTokenSource.call(tokenSource));
    }

    if (generationIsAzure) {
      const providerFactory = validatedConfig.azureGenerationProviderFactory ??
        ((options: Parameters<RelayAzureGenerationProviderFactory>[0]) =>
          new AzureOpenAIChatGenerationProvider(options));
      let providerCandidate: unknown;
      try {
        providerCandidate = providerFactory({
          endpoint: validatedConfig.azureGenerationEndpoint as string,
          deployment: validatedConfig.azureGenerationDeployment as typeof AZURE_GENERATION_DEPLOYMENT,
          tokenProvider: sharedTokenProvider as AzureTokenProvider
        });
        const provider = validateAzureGenerationProvider(providerCandidate);
        generationService = new GenerationService({
          provider,
          validator:
            validatedConfig.developmentProvisionalGenerationValidator ??
            validatedConfig.productionApprovedGenerationValidator ??
            new FailClosedGeneratedLanguageValidator(),
          ...(validatedConfig.developmentProvisionalGenerationValidator === undefined
            ? {}
            : { languageValidationMode: 'development-provisional' as const })
        });
        generationServiceInfo = generationServiceMetadata(generationService);
      } catch {
        const partialClose = optionalDataProperty(providerCandidate, 'close');
        if (typeof partialClose === 'function' && !utilTypes.isProxy(partialClose)) {
          invokeResourceCleanup(() => partialClose.call(providerCandidate));
        }
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
      generationReadiness = Object.freeze({
        provider: 'azure-openai-chat' as const,
        providerId: generationServiceInfo.providerId,
        model: AZURE_GENERATION_DEPLOYMENT,
        check: async (signal?: AbortSignal): Promise<boolean> => {
          if (sharedTokenProvider === undefined) return false;
          try {
            await sharedTokenProvider(signal ?? new AbortController().signal);
            return true;
          } catch {
            return false;
          }
        }
      });
    }
    const requestedBoundary = validatedConfig.languageBoundaryMode;
    const adaptersWillBeTargetSpecificMocks = configuredAdapters === undefined
      ? inferredTranscriptionProvider === 'mock'
      : configuredAdaptersAreTargetSpecificMocks;
    const boundary: RelayLanguageBoundaryMode = requestedBoundary ??
      (localComposition &&
        environment === 'local-mock' &&
        loopbackComposition &&
        inferredTranscriptionProvider === 'mock' &&
        generationReadiness.provider === 'mock' &&
        isControlledFixtureTextLanguageClassifier(
          validatedConfig.languageClassifier ?? createControlledFixtureTextLanguageClassifier()
        ) &&
        BUILT_IN_FIXTURE_GENERATION_SERVICES.has(generationService) &&
        adaptersWillBeTargetSpecificMocks
        ? 'fixture'
        : 'deny-all');

    const languageClassifier = validatedConfig.languageClassifier ??
      (boundary === 'fixture'
        ? createControlledFixtureTextLanguageClassifier()
        : boundary === 'deny-all'
          ? createFailClosedDeployedTextLanguageClassifier()
          : undefined);
    if (languageClassifier === undefined) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    const productionApprovedGenerationValidator =
      validatedConfig.productionApprovedGenerationValidator;
    const developmentProvisionalGenerationValidator =
      validatedConfig.developmentProvisionalGenerationValidator;
    const productionApprovedGenerationValidatorMetadata =
      productionApprovedGenerationValidator === undefined
        ? undefined
        : generatedLanguageValidatorMetadata(productionApprovedGenerationValidator);

    if (boundary === 'fixture') {
      if (
        !localComposition ||
        environment !== 'local-mock' ||
        !loopbackComposition ||
        inferredTranscriptionProvider !== 'mock' ||
        generationReadiness.provider !== 'mock' ||
        (!BUILT_IN_FIXTURE_GENERATION_SERVICES.has(generationService) &&
          !(explicitFixtureHarness && generationServiceInfo.validatorId === 'deterministic-language-fixture')) ||
        (!adaptersWillBeTargetSpecificMocks && !explicitFixtureHarness) ||
        (!isControlledFixtureTextLanguageClassifier(languageClassifier) && !explicitFixtureHarness) ||
        productionApprovedGenerationValidator !== undefined ||
        developmentProvisionalGenerationValidator !== undefined ||
        generationServiceInfo.languageValidationMode !== 'production-calibrated' ||
        generationServiceInfo.validatorId !== 'deterministic-language-fixture'
      ) {
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
    } else if (boundary === 'deny-all') {
      if (
        localComposition ||
        !isFailClosedDeployedTextLanguageClassifier(languageClassifier) ||
        productionApprovedGenerationValidator !== undefined ||
        developmentProvisionalGenerationValidator !== undefined ||
        generationServiceInfo.languageValidationMode !== 'production-calibrated' ||
        generationServiceInfo.validatorId !== 'fail-closed-generated-language'
      ) {
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
    } else if (boundary === 'development-provisional') {
      if (
        localComposition ||
        validatedConfig.deploymentSlot !== 'dev' ||
        productionApprovedGenerationValidator !== undefined ||
        developmentProvisionalGenerationValidator === undefined ||
        !isDevelopmentProvisionalTextLanguageClassifier(languageClassifier) ||
        !isDevelopmentProvisionalGeneratedLanguageValidator(
          developmentProvisionalGenerationValidator
        ) ||
        generationServiceInfo.languageValidationMode !== 'development-provisional' ||
        !generationServiceInfo.usesValidator(
          developmentProvisionalGenerationValidator
        )
      ) {
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
    } else if (
      localComposition ||
      productionApprovedGenerationValidator === undefined ||
      developmentProvisionalGenerationValidator !== undefined ||
      isControlledFixtureTextLanguageClassifier(languageClassifier) ||
      isFailClosedDeployedTextLanguageClassifier(languageClassifier) ||
      (productionApprovedGenerationValidator !== undefined &&
        (isDeterministicFixtureLanguageValidator(productionApprovedGenerationValidator) ||
          isFailClosedGeneratedLanguageValidator(productionApprovedGenerationValidator) ||
          generationServiceInfo.validatorId !== productionApprovedGenerationValidatorMetadata?.id ||
          generationServiceInfo.validatorVersion !== productionApprovedGenerationValidatorMetadata?.version)) ||
      generationServiceInfo.validatorId === 'deterministic-language-fixture' ||
      generationServiceInfo.validatorId === 'fail-closed-generated-language' ||
      generationServiceInfo.languageValidationMode !== 'production-calibrated'
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }

    if (
      inferredTranscriptionProvider === 'mock' &&
      !adaptersWillBeTargetSpecificMocks &&
      !explicitFixtureHarness
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }
    if (
      boundary === 'fixture' &&
      explicitFixtureHarness &&
      !adaptersWillBeTargetSpecificMocks &&
      (validatedConfig.languageClassifier === undefined ||
        isControlledFixtureTextLanguageClassifier(validatedConfig.languageClassifier))
    ) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }

    let transcriptionAdapters: Readonly<Record<TargetLanguage, TranscriptionAdapter>>;
    if (configuredAdapters !== undefined) {
      transcriptionAdapters = configuredAdapters;
    } else if (inferredTranscriptionProvider === 'azure-realtime') {
      const endpoint = validatedConfig.azureTranscriptionEndpoint as string;
      const deployment = validatedConfig.azureTranscriptionDeployment as string;
      const adapterFactory = validatedConfig.azureTranscriptionAdapterFactory ??
        ((options: Parameters<RelayAzureTranscriptionAdapterFactory>[0]) =>
          new AzureRealtimeTranscriptionAdapter(options));
      let adapter: TranscriptionAdapter;
      let adapterCandidate: unknown;
      try {
        adapterCandidate = adapterFactory({
          endpoint,
          deployment,
          tokenProvider: sharedTokenProvider as AzureTokenProvider
        });
        adapter = validateTranscriptionAdapter(adapterCandidate);
      } catch {
        const partialClose = optionalDataProperty(adapterCandidate, 'close');
        if (typeof partialClose === 'function') {
          invokeResourceCleanup(() => partialClose.call(adapterCandidate));
        }
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
      const closeAdapter = optionalDataProperty(adapter, 'close');
      if (closeAdapter !== undefined) {
        if (typeof closeAdapter !== 'function') throw new TypeError(RELAY_CONFIGURATION_ERROR);
        acquiredCloseables.push(() => closeAdapter.call(adapter));
      }
      if (!(adapter instanceof AzureRealtimeTranscriptionAdapter)) {
        throw new TypeError(RELAY_CONFIGURATION_ERROR);
      }
      transcriptionAdapters = Object.freeze({ es: adapter, tr: adapter });
    } else {
      transcriptionAdapters = defaultTranscriptionAdapters();
    }

    const adaptersAreTargetSpecificMocks =
      transcriptionAdapters.es instanceof DeterministicMockTranscriptionAdapter &&
      transcriptionAdapters.tr instanceof DeterministicMockTranscriptionAdapter &&
      transcriptionAdapters.es.configuration.fixtureTargetLanguage === 'es' &&
      transcriptionAdapters.tr.configuration.fixtureTargetLanguage === 'tr';
    const adaptersAreAzureShared =
      transcriptionAdapters.es instanceof AzureRealtimeTranscriptionAdapter &&
      transcriptionAdapters.es === transcriptionAdapters.tr;
    if ((inferredTranscriptionProvider === 'mock' &&
        !adaptersAreTargetSpecificMocks && !explicitFixtureHarness) ||
      (inferredTranscriptionProvider === 'azure-realtime' && !adaptersAreAzureShared)) {
      throw new TypeError(RELAY_CONFIGURATION_ERROR);
    }

  const securityRuntime = security.runtime;
  const securityMaintenance = security.maintenance;
  const connections = new Set<RelayConnection>();
  const connectionsByInstallation = new Map<string, Set<RelayConnection>>();
  const leases = new WeakMap<WebSocket, SessionLease>();
  const pendingUpgrades = new Set<PendingUpgrade>();
  const pendingUpgradesByInstallation = new Map<string, Set<PendingUpgrade>>();
  const revokedInstallations = new Set<string>();
  const minimumCredentialVersions = new Map<string, number>();
  const hostAbortController = new AbortController();
  const trackedWork = new Set<Promise<unknown>>();
  let lifecycleState: RelayHostLifecycleState = 'created';
  let stopping = false;
  let startPromise: Promise<{ readonly port: number }> | undefined;
  let stopPromise: Promise<void> | undefined;

  let readinessInFlight: Promise<boolean> | undefined;
  let readinessCache: { readonly ready: boolean; readonly expiresAt: number } | undefined;
  let lastReadinessClock: number | undefined;

  const trackWork = <T>(promise: Promise<T>): Promise<T> => {
    trackedWork.add(promise);
    void promise.then(
      () => trackedWork.delete(promise),
      () => trackedWork.delete(promise)
    );
    return promise;
  };

  const readReadinessClock = (): number | undefined => {
    try {
      const value = clock.nowMonotonicMs();
      if (
        !Number.isFinite(value) ||
        (lastReadinessClock !== undefined && value <= lastReadinessClock)
      ) {
        readinessCache = undefined;
        return undefined;
      }
      lastReadinessClock = value;
      return value;
    } catch {
      readinessCache = undefined;
      return undefined;
    }
  };

  const computeReadiness = async (): Promise<boolean> => {
    const generationCheck = generationReadiness.provider === 'mock'
      ? () => Promise.resolve(true)
      : generationReadiness.check;
    const signal = hostAbortController.signal;
    const checks = [
      boundedReadinessCheck(signal, generationCheck),
      boundedReadinessCheck(signal, async (componentSignal) => {
        const results = await Promise.all(
          [...new Set([transcriptionAdapters.es, transcriptionAdapters.tr])].map((adapter) =>
            adapter.checkReadiness(componentSignal)
          )
        );
        return results.every((result) => result.ready === true);
      }),
      boundedReadinessCheck(signal, async () => {
        await languageClassifier.ready;
        return true;
      }),
      boundedReadinessCheck(signal, async (componentSignal) => {
        await securityMaintenance.checkReadiness(componentSignal);
        return true;
      }),
      boundedReadinessCheck(signal, (componentSignal) =>
        metricSink.checkReadiness(componentSignal))
    ] as const;
    const [generationReady, transcriptionReady, classifierReady, securityReady, telemetryReady] =
      await Promise.all(checks);
    return generationReady && transcriptionReady && classifierReady && securityReady && telemetryReady;
  };

  const checkReadiness = (): Promise<boolean> => {
    if (lifecycleState !== 'running' || hostAbortController.signal.aborted) {
      return Promise.resolve(false);
    }
    if (readinessInFlight !== undefined) return readinessInFlight;
    const now = readReadinessClock();
    if (now === undefined) return Promise.resolve(false);
    if (readinessCache !== undefined && now < readinessCache.expiresAt) {
      return Promise.resolve(readinessCache.ready);
    }
    readinessCache = undefined;
    const computation = computeReadiness().then((ready) => {
      if (lifecycleState !== 'running' || hostAbortController.signal.aborted) {
        readinessCache = undefined;
        return false;
      }
      const completedAt = readReadinessClock();
      if (completedAt === undefined) return false;
      readinessCache = {
        ready,
        expiresAt: completedAt + (ready ? READINESS_SUCCESS_CACHE_MS : READINESS_FAILURE_CACHE_MS)
      };
      return ready;
    }, () => {
      const completedAt = readReadinessClock();
      readinessCache = completedAt === undefined || lifecycleState !== 'running'
        ? undefined
        : { ready: false, expiresAt: completedAt + READINESS_FAILURE_CACHE_MS };
      return false;
    });
    const published = computation.finally(() => {
      readinessInFlight = undefined;
    });
    readinessInFlight = trackWork(published);
    return readinessInFlight;
  };

  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_CONTROL_MESSAGE_BYTES,
    handleProtocols: () => WEBSOCKET_SUBPROTOCOL
  });

  const server = createServer((request, response) => {
    if (stopping || hostAbortController.signal.aborted) {
      writeSensitiveJson(response, 503, REQUEST_REJECTED_BODY);
      return;
    }
    const originDecision = evaluateRequestOrigin(browserOriginPolicy, request);
    if (originDecision.kind === 'rejected') {
      writeSensitiveJson(response, 403, REQUEST_REJECTED_BODY);
      return;
    }
    const corsOrigin = originDecision.kind === 'allowed' ? originDecision.origin : undefined;
    const writeActualJson = (status: number, value: unknown): void => {
      if (corsOrigin === undefined) {
        writeJson(response, status, value);
      } else {
        writeSensitiveJson(response, status, value, corsOrigin);
      }
    };
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      writeActualJson(404, REQUEST_REJECTED_BODY);
      return;
    }

    const route = AUTH_ROUTES[pathname];
    if (request.method === 'OPTIONS') {
      if (route === undefined) {
        if (pathname === '/healthz' || pathname === '/readyz') {
          response.setHeader('allow', 'GET');
          writeSensitiveJson(response, 405, REQUEST_REJECTED_BODY, corsOrigin);
        } else {
          writeActualJson(404, REQUEST_REJECTED_BODY);
        }
        return;
      }
      if (originDecision.kind !== 'allowed' || !validPreflight(request, route)) {
        writeSensitiveJson(response, 400, REQUEST_REJECTED_BODY, corsOrigin, PREFLIGHT_VARY);
        return;
      }
      writePreflight(response, route, originDecision.origin);
      return;
    }

    if (pathname === '/healthz') {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET');
        writeSensitiveJson(response, 405, REQUEST_REJECTED_BODY, corsOrigin);
        return;
      }
      if (corsOrigin === undefined) {
        writeJson(response, 200, { ok: true });
      } else {
        writeSensitiveJson(response, 200, { ok: true }, corsOrigin);
      }
      return;
    }
    if (pathname === '/readyz') {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET');
        writeSensitiveJson(response, 405, REQUEST_REJECTED_BODY, corsOrigin);
        return;
      }
      void trackWork(checkReadiness().then((ready) => {
        writeActualJson(ready ? 200 : 503, { ready });
      }).catch(() => writeActualJson(503, { ready: false })));
      return;
    }
    if (route !== undefined) {
      if (request.method !== route.method) {
        response.setHeader('allow', route.method);
        writeSensitiveJson(response, 405, REQUEST_REJECTED_BODY, corsOrigin);
        return;
      }
      if (route.requiresJsonBody) {
        if (headerValue(request, 'content-type') !== 'application/json') {
          request.resume();
          writeSensitiveJson(response, 400, REQUEST_REJECTED_BODY, corsOrigin);
          return;
        }
        void trackWork(readJsonBody(request).then(async (body) => {
          if (body.status === 'too_large') {
            writeSensitiveJson(response, 413, REQUEST_REJECTED_BODY, corsOrigin);
            return;
          }
          if (body.status !== 'ok') {
            writeSensitiveJson(response, 400, REQUEST_REJECTED_BODY, corsOrigin);
            return;
          }
          try {
            if (pathname === PAIRING_REDEMPTION_PATH) {
              const input = assertRelayRequest(() => assertPairingRedemptionRequest(body.value));
              const trustedSource = trustedSocketSource(request);
              if (trustedSource === undefined) throw new SecurityStateError('invalid-input');
              const redeemed = await securityRuntime.redeemPairing({
                pairingCode: input.pairingCode,
                trustedSource
              });
              const result = assertPairingRedemptionResponse({
                installationId: redeemed.installationId,
                credential: redeemed.credential,
                credentialVersion: redeemed.credentialVersion,
                idleExpiresAt: new Date(redeemed.idleExpiresAt).toISOString(),
                absoluteExpiresAt: new Date(redeemed.absoluteExpiresAt).toISOString()
              });
              writeSensitiveJson(response, 200, result, corsOrigin);
              return;
            }
            if (pathname === SESSION_TICKET_PATH) {
              assertRelayRequest(() => assertSessionTicketRequest(body.value));
              const credential = bearerCredential(request);
              if (credential === undefined) throw new SecurityStateError('invalid-credential');
              const issued = await securityRuntime.issueSessionTicket({
                credential,
                environment,
                audience,
                intent: 'new'
              });
              const result = assertSessionTicketResponse({
                ticket: issued.ticket,
                wssOrigin: origin,
                wssPath: STREAM_PATH,
                protocolVersion: 1,
                expiresAt: new Date(issued.expiresAt).toISOString()
              });
              writeSensitiveJson(response, 200, result, corsOrigin);
              return;
            }
            if (pathname === CREDENTIAL_ROTATION_PATH) {
              assertRelayRequest(() => assertCredentialRotationRequest(body.value));
              const credential = bearerCredential(request);
              if (credential === undefined) throw new SecurityStateError('invalid-credential');
              const pending = await securityRuntime.beginCredentialRotation({ credential });
              const result = assertRotationBeginResponse({
                pendingCredential: pending.pendingCredential,
                pendingCredentialVersion: pending.pendingCredentialVersion,
                pendingCredentialExpiresAt: new Date(pending.pendingExpiresAt).toISOString()
              });
              writeSensitiveJson(response, 200, result, corsOrigin);
              return;
            }
            assertRelayRequest(() => assertCredentialRotationConfirmationRequest(body.value));
            const credential = bearerCredential(request);
            if (credential === undefined) throw new SecurityStateError('invalid-credential');
            const promoted = await securityRuntime.promoteCredential({
              pendingCredential: credential
            });
            await applyPromotionResult(promoted);
            const result = assertRotationConfirmationResponse({
              credentialVersion: promoted.credentialVersion,
              promoted: true,
              confirmedAt: new Date(promoted.confirmedAt).toISOString(),
              expiresAt: new Date(promoted.absoluteExpiresAt).toISOString()
            });
            writeSensitiveJson(response, 200, result, corsOrigin);
          } catch (error) {
            writeSensitiveJson(response, securityHttpStatus(error), REQUEST_REJECTED_BODY, corsOrigin);
          }
        }).catch(() => {
          writeSensitiveJson(response, 400, REQUEST_REJECTED_BODY, corsOrigin);
        }));
        return;
      }
      void trackWork(readNoBody(request).then(async (empty) => {
        if (!empty) {
          writeSensitiveJson(response, 400, REQUEST_REJECTED_BODY, corsOrigin);
          return;
        }
        try {
          const credential = bearerCredential(request);
          if (credential === undefined) throw new SecurityStateError('invalid-credential');
          const revoked = await securityRuntime.revokeCurrentInstallation({ credential });
          await applyRevocationResult(revoked);
          writeNoContent(response, corsOrigin);
        } catch (error) {
          writeSensitiveJson(response, securityHttpStatus(error), REQUEST_REJECTED_BODY, corsOrigin);
        }
      }).catch(() => {
        writeSensitiveJson(response, 400, REQUEST_REJECTED_BODY, corsOrigin);
      }));
      return;
    }
    writeActualJson(404, REQUEST_REJECTED_BODY);
  });

  const closeCoreOnce = (connection: RelayConnection): void => {
    if (connection.coreClosed) {
      return;
    }
    connection.coreClosed = true;
    try {
      connection.core.close();
    } catch {
      // Cleanup is best effort and intentionally content-free.
    }
  };

  const closeConnection = (connection: RelayConnection, code: number, reason: string): void => {
    if (connection.socket.readyState === WebSocket.OPEN) {
      try {
        connection.socket.close(code, reason);
      } catch {
        connection.socket.terminate();
      }
    } else if (connection.socket.readyState === WebSocket.CONNECTING) {
      connection.socket.terminate();
    }
  };

  const leaseAllowed = (lease: SessionLease): boolean => {
    if (revokedInstallations.has(lease.installationId)) return false;
    const minimumVersion = minimumCredentialVersions.get(lease.installationId);
    return minimumVersion === undefined || lease.credentialVersion >= minimumVersion;
  };

  const removePendingUpgrade = (pendingUpgrade: PendingUpgrade): void => {
    pendingUpgrades.delete(pendingUpgrade);
    const lease = pendingUpgrade.preparedLease;
    if (lease === undefined) return;
    const installationPending = pendingUpgradesByInstallation.get(lease.installationId);
    installationPending?.delete(pendingUpgrade);
    if (installationPending !== undefined && installationPending.size === 0) {
      pendingUpgradesByInstallation.delete(lease.installationId);
    }
  };

  const cancelPendingUpgrade = (pendingUpgrade: PendingUpgrade): void => {
    pendingUpgrade.cancelled = true;
    try {
      writeRejectedUpgrade(pendingUpgrade.socket, 401);
    } catch {
      pendingUpgrade.socket.destroy();
    }
    removePendingUpgrade(pendingUpgrade);
  };

  const cancelPendingForInstallation = (
    installationId: string,
    predicate: (lease: SessionLease) => boolean
  ): void => {
    const pending = pendingUpgradesByInstallation.get(installationId);
    if (pending === undefined) return;
    for (const pendingUpgrade of [...pending]) {
      const lease = pendingUpgrade.preparedLease;
      if (lease !== undefined && predicate(lease)) {
        cancelPendingUpgrade(pendingUpgrade);
      }
    }
  };

  const waitForClosedConnections = async (
    installationId: string,
    predicate: (connection: RelayConnection) => boolean
  ): Promise<void> => {
    const affected = [...(connectionsByInstallation.get(installationId) ?? [])].filter(predicate);
    const waits = affected.map((connection) => new Promise<void>((resolve) => {
      if (connection.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      connection.socket.once('close', () => resolve());
      closeCoreOnce(connection);
      closeConnection(connection, 4401, 'authentication_failed');
    }));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(waits),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SOCKET_CLOSE_WAIT_MS);
      })
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    for (const connection of affected) {
      if (connection.socket.readyState !== WebSocket.CLOSED) {
        connection.socket.terminate();
      }
    }
  };

  const applyPromotionResult = async (result: CredentialPromotionResult): Promise<void> => {
    const currentMinimum = minimumCredentialVersions.get(result.installationId) ?? 0;
    if (result.credentialVersion > currentMinimum) {
      minimumCredentialVersions.set(result.installationId, result.credentialVersion);
    }
    cancelPendingForInstallation(
      result.installationId,
      (lease) => lease.credentialVersion < result.credentialVersion
    );
    await waitForClosedConnections(
      result.installationId,
      (connection) => connection.lease.credentialVersion < result.credentialVersion
    );
  };

  const applyRevocationResult = async (result: InstallationRevocationResult): Promise<void> => {
    revokedInstallations.add(result.installationId);
    cancelPendingForInstallation(result.installationId, () => true);
    await waitForClosedConnections(result.installationId, () => true);
  };

  const deliver = async (connection: RelayConnection, result: RelayStepResult): Promise<void> => {
    if (connection.socket.readyState === WebSocket.OPEN) {
      for (const message of result.outgoing) {
        if (beforeServerMessageDelivery !== undefined) {
          await beforeServerMessageDelivery(message);
        }
        connection.socket.send(JSON.stringify(message));
      }
    }
    if (result.close !== undefined) {
      closeConnection(connection, result.close.code, result.close.reason);
    }
  };

  const endDurableSession = (connection: RelayConnection): Promise<void> => {
    if (connection.endPromise !== undefined) return connection.endPromise;
    connection.ended = true;
    if (connection.heartbeat !== undefined) {
      clearInterval(connection.heartbeat);
      connection.heartbeat = undefined;
    }
    const ending = Promise.resolve()
      .then(() => securityRuntime.endSession({ lease: connection.lease }))
      .catch(() => undefined);
    connection.endPromise = trackWork(ending);
    return connection.endPromise;
  };

  const enqueue = (connection: RelayConnection, work: () => Promise<void> | void): void => {
    connection.queue = trackWork(connection.queue.then(async () => {
      if (!connection.closed) {
        await work();
      }
    }).catch(() => {
      if (!connection.closed) {
        closeConnection(connection, 1011, 'server_error');
      }
    }));
  };

  webSocketServer.on('connection', (socket) => {
    const sessionLease = leases.get(socket);
    leases.delete(socket);
    if (sessionLease === undefined) {
      socket.close(1008, 'request_rejected');
      return;
    }

    let requestDrain: () => void = () => undefined;
    const core = new RelaySessionCore({
      sessionLease,
      securityRuntime,
      clock,
      ids,
      transcriptionAdapters,
      languageClassifier,
      generationService,
      languageBoundaryMode: boundary,
      metricSink,
      gatePolicyVersion,
      onAsyncEventsAvailable: () => requestDrain()
    });
    const connection: RelayConnection = {
      socket,
      core,
      queue: Promise.resolve(),
      closed: false,
      coreClosed: false,
      drainScheduled: false,
      lease: sessionLease,
      activated: false,
      ended: false,
      endPromise: undefined,
      heartbeat: undefined,
      audio: undefined,
      limits: undefined
    };
    connections.add(connection);
    const installationConnections = connectionsByInstallation.get(sessionLease.installationId) ??
      new Set<RelayConnection>();
    installationConnections.add(connection);
    connectionsByInstallation.set(sessionLease.installationId, installationConnections);

    const scheduleDrain = (): void => {
      if (connection.closed || connection.drainScheduled) {
        return;
      }
      connection.drainScheduled = true;
      enqueue(connection, async () => {
        try {
          if (connection.socket.readyState === WebSocket.OPEN) {
            await deliver(connection, await core.drainAsyncEvents());
          }
        } finally {
          connection.drainScheduled = false;
        }
        if (
          !connection.closed &&
          connection.socket.readyState === WebSocket.OPEN &&
          core.hasPendingAsyncEvents()
        ) {
          scheduleDrain();
        }
      });
    };
    requestDrain = scheduleDrain;

    const failSecurity = async (error: unknown): Promise<void> => {
      const quota = error instanceof SecurityStateError &&
        (error.category === 'quota-exceeded' || error.category === 'rate-limited');
      await deliver(connection, core.handleSecurityFailure(quota ? 'quota' : 'state'));
    };

    const reserveGrant = async (utteranceId: string, from: number): Promise<AudioGrantMeter> => {
      const grant = await securityRuntime.reserveAudio({
        lease: connection.lease,
        utteranceId: assertCanonicalUuid(utteranceId),
        fromOriginalSampleOffset: from,
        originalSamples: MAX_AUDIO_GRANT_SAMPLES
      });
      return createConnectionAudioGrantMeter({ grant });
    };

    const startHeartbeat = (): void => {
      if (connection.heartbeat !== undefined) return;
      connection.heartbeat = setInterval(() => {
        enqueue(connection, async () => {
          try {
            connection.lease = await securityRuntime.heartbeatSession({
              lease: connection.lease
            });
            core.updateSessionLease(connection.lease);
            await core.heartbeatGeneration();
          } catch (error) {
            await failSecurity(error);
          }
        });
      }, HEARTBEAT_INTERVAL_MS);
    };

    socket.on('message', (data, isBinary) => {
      enqueue(connection, async () => {
        if (connection.socket.readyState !== WebSocket.OPEN) {
          return;
        }
        let result: RelayStepResult;
        if (isBinary) {
          const bytes = rawDataBuffer(data);
          if (bytes === undefined) {
            closeConnection(connection, 1003, 'unsupported_data');
            return;
          }
          try {
            const frame = decodeAudioFrame(new Uint8Array(bytes));
            const secured = connection.audio;
            if (secured === undefined || secured.utteranceId !== frame.utteranceId) {
              result = core.handleSecurityFailure('state');
            } else {
              const accepted = secured.acceptor.accept(frame);
              if (accepted.status === 'accepted') {
                let from = frame.offset;
                const through = frame.offset + accepted.chargeSamples;
                while (from < through) {
                  const snapshot = secured.meter.snapshot();
                  if (snapshot.remainingOriginalSamples === 0) {
                    secured.meter = await reserveGrant(frame.utteranceId, from);
                  }
                  const available = secured.meter.snapshot().remainingOriginalSamples;
                  const next = Math.min(through, from + available);
                  secured.meter.accept({
                    fromOriginalSampleOffset: from,
                    throughOriginalSampleOffset: next
                  });
                  from = next;
                }
              } else if (accepted.status === 'rejected') {
                result = core.handleSecurityFailure('state');
              }
              result ??= core.handleBinary(new Uint8Array(bytes));
            }
          } catch (error) {
            await failSecurity(error);
            return;
          }
        } else {
          const bytes = rawDataBuffer(data);
          if (bytes === undefined) {
            closeConnection(connection, 1003, 'unsupported_data');
            return;
          }
          const text = bytes.toString('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            parsed = undefined;
          }
          try {
            if (!connection.activated) {
              let start: ReturnType<typeof assertSessionStart> | undefined;
              try {
                start = assertSessionStart(parsed);
              } catch {
                start = undefined;
              }
              if (start !== undefined) {
                connection.lease = await securityRuntime.activateSession({
                  lease: connection.lease,
                  message: { type: 'session.start', protocolVersion: start.protocolVersion }
                });
                connection.activated = true;
                connection.limits = negotiateLimits(start.requestedLimits);
                core.updateSessionLease(connection.lease);
                startHeartbeat();
              }
            } else if (
              typeof parsed === 'object' && parsed !== null &&
              (parsed as { readonly type?: unknown }).type === 'utterance.start'
            ) {
              const start = assertUtteranceStart(parsed);
              const limits = connection.limits;
              if (limits === undefined) throw new SecurityStateError('state-unavailable');
              const meter = await reserveGrant(start.utteranceId, 0);
              connection.audio = {
                utteranceId: start.utteranceId,
                meter,
                acceptor: new RelayOrderedFrameAcceptor(start.utteranceId, {
                  maxAudioPayloadBytes: limits.maxAudioPayloadBytes,
                  maxRetainedReplaySamples: limits.maxRetainedReplaySamples,
                  maxUtteranceSamples: limits.maxUtteranceSamples
                })
              };
            }
          } catch (error) {
            await failSecurity(error);
            return;
          }
          result = core.handleText(text);
          const controlMessageType = typeof parsed === 'object' && parsed !== null
            ? String((parsed as { readonly type?: unknown }).type)
            : undefined;
          if (controlMessageType === 'utterance.commit') {
            connection.audio = undefined;
          } else if (
            controlMessageType === 'utterance.cancel' &&
            result.terminatedUtteranceId !== undefined &&
            connection.audio?.utteranceId === result.terminatedUtteranceId
          ) {
            connection.audio = undefined;
          }
          if (
            typeof parsed === 'object' && parsed !== null &&
            (parsed as { readonly type?: unknown }).type === 'session.end'
          ) {
            await endDurableSession(connection);
          }
        }
        await deliver(connection, result);
        if (result.close === undefined && connection.socket.readyState === WebSocket.OPEN) {
          scheduleDrain();
        }
      });
    });
    socket.on('close', () => {
      connection.closed = true;
      if (connection.heartbeat !== undefined) clearInterval(connection.heartbeat);
      void endDurableSession(connection);
      closeCoreOnce(connection);
      connections.delete(connection);
      const installationConnections = connectionsByInstallation.get(connection.lease.installationId);
      installationConnections?.delete(connection);
      if (installationConnections !== undefined && installationConnections.size === 0) {
        connectionsByInstallation.delete(connection.lease.installationId);
      }
    });
    socket.on('error', () => {
      closeCoreOnce(connection);
    });
  });

  server.on('clientError', (_error, errorSocket) => {
    errorSocket.destroy();
  });

  server.on('upgrade', (request, socket, head) => {
    const originDecision = evaluateRequestOrigin(browserOriginPolicy, request);
    if (originDecision.kind === 'rejected') {
      writeRejectedUpgrade(socket, 403);
      return;
    }
    if (stopping) {
      socket.destroy();
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      writeRejectedUpgrade(socket, 404);
      return;
    }
    if (request.method !== 'GET' || pathname !== STREAM_PATH) {
      writeRejectedUpgrade(socket, 404);
      return;
    }

    const pendingUpgrade: PendingUpgrade = {
      socket,
      decision: Promise.resolve(),
      cancelled: false
    };
    pendingUpgrades.add(pendingUpgrade);
    pendingUpgrade.decision = trackWork(prepareStreamUpgrade({
      offeredSubprotocols: offeredSubprotocols(request),
      audience,
      environment,
      securityRuntime
    }).then((prepared) => {
      if (stopping || pendingUpgrade.cancelled) {
        socket.destroy();
        return;
      }
      if (prepared.status === 'rejected') {
        writeRejectedUpgrade(socket, prepared.httpStatus);
        return;
      }
      pendingUpgrade.preparedLease = prepared.sessionLease;
      const installationPending = pendingUpgradesByInstallation.get(
        prepared.sessionLease.installationId
      ) ?? new Set<PendingUpgrade>();
      installationPending.add(pendingUpgrade);
      pendingUpgradesByInstallation.set(
        prepared.sessionLease.installationId,
        installationPending
      );
      if (!leaseAllowed(prepared.sessionLease)) {
        cancelPendingUpgrade(pendingUpgrade);
        return;
      }
      if (stopping || pendingUpgrade.cancelled) {
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        if (stopping || pendingUpgrade.cancelled || !leaseAllowed(prepared.sessionLease)) {
          webSocket.close(4401, 'authentication_failed');
          return;
        }
        leases.set(webSocket, prepared.sessionLease);
        webSocketServer.emit('connection', webSocket, request);
      });
    }).catch(() => {
      if (stopping) {
        socket.destroy();
        return;
      }
      writeRejectedUpgrade(socket, 503);
    }).finally(() => removePendingUpgrade(pendingUpgrade)));
  });

  const closeServer = (): Promise<void> => new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      server.close(() => finish());
      server.closeIdleConnections?.();
      if (!server.listening && lifecycleState !== 'starting') finish();
    } catch {
      finish();
    }
  });

  const settleWithin = async (
    operation: () => Promise<unknown>,
    timeoutMs: number
  ): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operationPromise = Promise.resolve().then(operation).catch(() => undefined);
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([operationPromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const drainTrackedWork = async (): Promise<void> => {
    while (trackedWork.size > 0) {
      const snapshot = [...trackedWork];
      await Promise.allSettled(snapshot);
    }
  };

  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }
    let settleStop: (() => void) | undefined;
    stopPromise = new Promise<void>((resolve) => {
      settleStop = resolve;
    });
    lifecycleState = 'stopping';
    stopping = true;
    readinessCache = undefined;
    hostAbortController.abort();
    const serverClosed = closeServer();
    for (const pendingUpgrade of [...pendingUpgrades]) {
      pendingUpgrade.cancelled = true;
      try {
        writeRejectedUpgrade(pendingUpgrade.socket, 503);
      } catch {
        pendingUpgrade.socket.destroy();
      }
      removePendingUpgrade(pendingUpgrade);
    }
    void (async (): Promise<void> => {
      const connectionSnapshot = [...connections];
      const durableEndings = connectionSnapshot.map((connection) => endDurableSession(connection));
      const closingConnections = connectionSnapshot.map((connection) =>
        new Promise<void>((resolve) => {
          if (connection.socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          connection.socket.once('close', () => resolve());
          closeCoreOnce(connection);
          closeConnection(connection, 1001, 'server_shutdown');
        })
      );
      await settleWithin(async () => {
        await Promise.allSettled(connectionSnapshot.map((connection) => connection.queue));
      }, CONNECTION_WORK_DRAIN_TIMEOUT_MS);
      await settleWithin(async () => {
        await Promise.allSettled(closingConnections);
      }, SOCKET_CLOSE_WAIT_MS);
      for (const connection of connectionSnapshot) {
        if (connection.socket.readyState !== WebSocket.CLOSED) {
          try {
            connection.socket.terminate();
          } catch {
            // Shutdown is best effort and remains content-free.
          }
        }
      }
      try {
        server.closeAllConnections?.();
      } catch {
        // HTTP connection cleanup is best effort.
      }
      await settleWithin(async () => {
        await serverClosed;
      }, SOCKET_CLOSE_WAIT_MS);
      await settleWithin(async () => {
        await Promise.allSettled(durableEndings);
      }, DURABLE_CLEANUP_TIMEOUT_MS);
      await settleWithin(drainTrackedWork, REQUEST_WORK_DRAIN_TIMEOUT_MS);
      for (const closeable of [...acquiredCloseables].reverse()) {
        await settleWithin(async () => {
          await closeable();
        }, RESOURCE_ROLLBACK_TIMEOUT_MS);
      }
      acquiredCloseables.length = 0;
      await settleWithin(() => metricSink.shutdown(), SHUTDOWN_TELEMETRY_TIMEOUT_MS);
      acquiredMetricSink = undefined;
      connections.clear();
      pendingUpgrades.clear();
      pendingUpgradesByInstallation.clear();
      connectionsByInstallation.clear();
      revokedInstallations.clear();
      minimumCredentialVersions.clear();
      readinessCache = undefined;
    })().catch(() => undefined).finally(() => {
      lifecycleState = 'stopped';
      stopping = true;
      settleStop?.();
    });
    return stopPromise;
  };

  const start = (): Promise<{ readonly port: number }> => {
    if (lifecycleState === 'starting' && startPromise !== undefined) return startPromise;
    if (lifecycleState === 'running') {
      const address = server.address();
      return address !== null && typeof address !== 'string'
        ? Promise.resolve({ port: address.port })
        : Promise.reject(new Error('relay_start_failed'));
    }
    if (lifecycleState === 'stopping' || lifecycleState === 'stopped') {
      return Promise.reject(new Error('relay_start_rejected'));
    }
    lifecycleState = 'starting';
    startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
        try {
          hostAbortController.signal.removeEventListener('abort', onAbort);
        } catch {
          // Lifecycle listener cleanup is best effort.
        }
      };
      const rejectAfterStop = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        void stop().then(
          () => reject(new Error('relay_start_failed')),
          () => reject(new Error('relay_start_failed'))
        );
      };
      const onError = (): void => rejectAfterStop();
      const onAbort = (): void => rejectAfterStop();
      const onListening = (): void => {
        if (lifecycleState !== 'starting' || hostAbortController.signal.aborted) {
          rejectAfterStop();
          return;
        }
        const address = server.address();
        if (address === null || typeof address === 'string') {
          rejectAfterStop();
          return;
        }
        settled = true;
        cleanup();
        lifecycleState = 'running';
        resolve({ port: address.port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        hostAbortController.signal.addEventListener('abort', onAbort, { once: true });
        if (hostAbortController.signal.aborted) {
          rejectAfterStop();
          return;
        }
        server.listen(port, bindHost);
      } catch {
        rejectAfterStop();
      }
    });
    return startPromise;
  };

    return {
      server,
      securityRuntime,
      securityMaintenance,
      get lifecycleState(): RelayHostLifecycleState {
        return lifecycleState;
      },
      start,
      stop
    };
  } catch {
    for (const closeable of [...acquiredCloseables].reverse()) {
      invokeResourceCleanup(closeable);
    }
    acquiredCloseables.length = 0;
    if (acquiredMetricSink !== undefined) {
      invokeResourceCleanup(() => acquiredMetricSink?.shutdown());
      acquiredMetricSink = undefined;
    } else if (partialMetricCleanup !== undefined) {
      invokeResourceCleanup(partialMetricCleanup);
      partialMetricCleanup = undefined;
    }
    throw new TypeError(RELAY_CONFIGURATION_ERROR);
  }
}
