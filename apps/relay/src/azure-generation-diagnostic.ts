import * as fs from 'node:fs';
import { types as utilTypes } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  createAzureManagedIdentityTokenSource,
  type AzureManagedIdentityTokenSource,
  type AzureTokenProvider,
  type CreateAzureManagedIdentityTokenSourceOptions
} from '@palancar/azure-auth';
import {
  AzureOpenAIChatGenerationProvider,
  createAcceptedTargetTurn,
  GenerationService,
  type AzureOpenAIChatGenerationProviderConfig,
  type GenerationEvidenceRecord,
  type GenerationProvider,
  type GenerationProviderFailureStage
} from '@palancar/generation';

import {
  canonicalAzureClientId,
  canonicalAzureGenerationDeployment,
  canonicalAzureGenerationEndpoint
} from './host.js';
import { createDevelopmentProvisionalLanguageBoundary } from './provisional-language-boundary.js';

const WATCHDOG_MS = 90_000;
const EXIT_OK = 0 as const;
const EXIT_FAILURE = 20 as const;
const PASSED_LINE = 'azure-generation-diagnostic: passed\n';
const TIMEOUT_LINE = 'azure-generation-diagnostic: failed stage=timeout\n';
const FAILURE_PREFIX = 'azure-generation-diagnostic: failed stage=';

const FIXED_TURN = createAcceptedTargetTurn({
  sessionId: '11111111-1111-4111-8111-111111111111',
  sessionEpoch: 1,
  utteranceId: '22222222-2222-4222-8222-222222222222',
  segmentId: 'azure-diagnostic-1',
  acceptedFinalRevision: 1,
  selectedTargetLanguage: 'es',
  decision: 'target',
  targetTranscript: '¿Podrías ayudarme a encontrar la estación de tren, por favor?',
  gatePolicyVersion: '1.0.0'
});

const CANONICAL_PROVIDER_STAGES = [
  'identity',
  'timeout',
  'transport',
  'auth',
  'rate_limit',
  'http',
  'response_size',
  'response_envelope',
  'finish_length',
  'finish_other',
  'completion_json',
  'completion_schema'
] as const;

export const AZURE_GENERATION_DIAGNOSTIC_FAILURE_STAGES = Object.freeze([
  ...CANONICAL_PROVIDER_STAGES,
  'unknown',
  'validation_failure'
] as const);
export const AZURE_GENERATION_DIAGNOSTIC_STAGES = AZURE_GENERATION_DIAGNOSTIC_FAILURE_STAGES;

export type AzureGenerationDiagnosticStage =
  (typeof AZURE_GENERATION_DIAGNOSTIC_STAGES)[number];
export type AzureGenerationDiagnosticFailureStage =
  (typeof AZURE_GENERATION_DIAGNOSTIC_FAILURE_STAGES)[number];

export type AzureGenerationDiagnosticExitCode = typeof EXIT_OK | typeof EXIT_FAILURE;

export interface AzureGenerationDiagnosticEnvironment {
  readonly AZURE_CLIENT_ID?: string;
  readonly PALANCAR_AZURE_GENERATION_ENDPOINT?: string;
  readonly PALANCAR_AZURE_GENERATION_DEPLOYMENT?: string;
  readonly [name: string]: string | undefined;
}

export interface AzureGenerationDiagnosticTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AzureGenerationDiagnosticOutput {
  readonly writeStdout?: (line: string) => void;
  readonly writeSync?: (line: string) => void;
}

export interface AzureGenerationDiagnosticTokenSource {
  readonly tokenProvider: AzureTokenProvider;
  close(): void;
}

export interface AzureGenerationDiagnosticDependencies {
  readonly environment?: AzureGenerationDiagnosticEnvironment;
  readonly clock?: () => number;
  readonly timer?: AzureGenerationDiagnosticTimer;
  readonly output?: AzureGenerationDiagnosticOutput;
  readonly terminate?: (exitCode: AzureGenerationDiagnosticExitCode) => void;
  readonly tokenSourceFactory?: (
    options: CreateAzureManagedIdentityTokenSourceOptions
  ) => AzureGenerationDiagnosticTokenSource;
  readonly providerFactory?: (
    config: AzureOpenAIChatGenerationProviderConfig
  ) => GenerationProvider;
}

const DEFAULT_TIMER: AzureGenerationDiagnosticTimer = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number) =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
});

function writeFd1Synchronously(line: string): void {
  const bytes = Buffer.from(line, 'utf8');
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    const written = fs.writeSync(1, bytes, offset, remaining);
    if (
      !Number.isSafeInteger(written) ||
      written <= 0 ||
      written > remaining
    ) {
      throw new Error('Diagnostic output failed.');
    }
    offset += written;
  }
}

const DEFAULT_OUTPUT: AzureGenerationDiagnosticOutput = Object.freeze({
  writeStdout: writeFd1Synchronously
});

const DEFAULT_TERMINATE = (exitCode: AzureGenerationDiagnosticExitCode): void => {
  // The reusable runner must not terminate its host process.
  void exitCode;
};

interface ResolvedOutput {
  readonly writeLine: (line: string) => void;
}

interface ResolvedDependencies {
  readonly environmentCandidate: unknown;
  readonly clock: (() => number) | undefined;
  readonly timer: AzureGenerationDiagnosticTimer;
  readonly output: ResolvedOutput;
  readonly terminate: (exitCode: AzureGenerationDiagnosticExitCode) => void;
  readonly tokenSourceFactory: (
    options: CreateAzureManagedIdentityTokenSourceOptions
  ) => AzureGenerationDiagnosticTokenSource;
  readonly providerFactory: (
    config: AzureOpenAIChatGenerationProviderConfig
  ) => GenerationProvider;
}

interface DiagnosticOutcome {
  readonly exitCode: AzureGenerationDiagnosticExitCode;
  readonly line: string;
}

interface SourceSnapshot {
  readonly tokenProvider: AzureTokenProvider;
  readonly close: () => void;
}

const DEPENDENCY_KEYS = new Set([
  'environment',
  'clock',
  'timer',
  'output',
  'terminate',
  'tokenSourceFactory',
  'providerFactory'
]);

const TIMER_KEYS = new Set(['setTimeout', 'clearTimeout']);
const OUTPUT_KEYS = new Set(['writeStdout', 'writeSync']);
const CANONICAL_STAGE_SET: ReadonlySet<string> = new Set([
  ...CANONICAL_PROVIDER_STAGES,
  'unknown'
]);

function defaultTokenSourceFactory(
  options: CreateAzureManagedIdentityTokenSourceOptions
): AzureManagedIdentityTokenSource {
  return createAzureManagedIdentityTokenSource(options);
}

function defaultProviderFactory(
  config: AzureOpenAIChatGenerationProviderConfig
): AzureOpenAIChatGenerationProvider {
  return new AzureOpenAIChatGenerationProvider(config);
}

function isProxy(value: unknown): boolean {
  if (typeof value !== 'object' && typeof value !== 'function') return false;
  try {
    return utilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function ownDataDescriptors(value: unknown): Record<PropertyKey, PropertyDescriptor> {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    isProxy(value)
  ) {
    throw new TypeError('Invalid diagnostic dependency.');
  }

  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    throw new TypeError('Invalid diagnostic dependency.');
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new TypeError('Invalid diagnostic dependency.');
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      Object.hasOwn(descriptor, 'get') ||
      Object.hasOwn(descriptor, 'set')
    ) {
      throw new TypeError('Invalid diagnostic dependency.');
    }
  }
  return descriptors;
}

function plainDependencyRecord(value: unknown): Record<PropertyKey, PropertyDescriptor> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value)
  ) {
    throw new TypeError('Invalid diagnostic dependency.');
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Invalid diagnostic dependency.');
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Invalid diagnostic dependency.');
  }
  return ownDataDescriptors(value);
}

function assertOnlyKeys(
  descriptors: Record<PropertyKey, PropertyDescriptor>,
  allowed: ReadonlySet<string>
): void {
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError('Invalid diagnostic dependency.');
    }
  }
}

function dataProperty(
  descriptors: Record<PropertyKey, PropertyDescriptor>,
  name: string
): unknown {
  return descriptors[name]?.value;
}

function callable(value: unknown): (() => unknown) | undefined {
  if (typeof value !== 'function' || isProxy(value)) return undefined;
  return value as () => unknown;
}

function dataMethod(
  value: object,
  name: string
): ((...args: readonly unknown[]) => unknown) | undefined {
  if (isProxy(value)) return undefined;
  const visited = new Set<object>();
  let current: object | null = value;
  try {
    while (current !== null) {
      if (isProxy(current)) return undefined;
      if (visited.has(current)) return undefined;
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        if (
          !Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'function' ||
          isProxy(descriptor.value)
        ) {
          return undefined;
        }
        return (...args: readonly unknown[]): unknown =>
          Reflect.apply(
            descriptor.value as (...items: readonly unknown[]) => unknown,
            value,
            args
          );
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function inheritedDataProperty(value: object, name: string): unknown {
  if (isProxy(value)) throw new TypeError('Invalid diagnostic dependency.');
  const visited = new Set<object>();
  let current: object | null = value;
  try {
    while (current !== null) {
      if (isProxy(current)) throw new TypeError('Invalid diagnostic dependency.');
      if (visited.has(current)) throw new TypeError('Invalid diagnostic dependency.');
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('Invalid diagnostic dependency.');
        }
        return descriptor.value;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Invalid diagnostic dependency.');
  }
  return undefined;
}

function resolveTimer(value: unknown): AzureGenerationDiagnosticTimer {
  const timer = value === undefined ? DEFAULT_TIMER : value;
  const descriptors = ownDataDescriptors(timer);
  assertOnlyKeys(descriptors, TIMER_KEYS);
  if (typeof timer !== 'object' || timer === null || Array.isArray(timer)) {
    throw new TypeError('Invalid diagnostic dependency.');
  }
  const setTimeout = dataMethod(timer, 'setTimeout');
  const clearTimeout = dataMethod(timer, 'clearTimeout');
  if (setTimeout === undefined || clearTimeout === undefined) {
    throw new TypeError('Invalid diagnostic dependency.');
  }
  return Object.freeze({
    setTimeout: (callback: () => void, delayMs: number): unknown =>
      setTimeout(callback, delayMs),
    clearTimeout: (handle: unknown): void => {
      void clearTimeout(handle);
    }
  });
}

function resolveOutput(value: unknown): ResolvedOutput {
  const output = value === undefined ? DEFAULT_OUTPUT : value;
  const descriptors = ownDataDescriptors(output);
  assertOnlyKeys(descriptors, OUTPUT_KEYS);
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    throw new TypeError('Invalid diagnostic dependency.');
  }
  void inheritedDataProperty(output, 'writeStdout');
  void inheritedDataProperty(output, 'writeSync');
  const writeSync = dataMethod(output, 'writeSync');
  const writeStdout = dataMethod(output, 'writeStdout');
  const writeLine = writeStdout ?? writeSync;
  if (writeLine === undefined) {
    throw new TypeError('Invalid diagnostic dependency.');
  }
  return Object.freeze({
    writeLine: (line: string): void => {
      void writeLine(line);
    }
  });
}

function resolveDependencies(
  input: AzureGenerationDiagnosticDependencies | undefined
): ResolvedDependencies {
  const candidate: unknown = input === undefined ? Object.freeze({}) : input;
  const descriptors = plainDependencyRecord(candidate);
  assertOnlyKeys(descriptors, DEPENDENCY_KEYS);

  const clockValue = dataProperty(descriptors, 'clock');
  const terminateValue = dataProperty(descriptors, 'terminate');
  const tokenSourceFactoryValue = dataProperty(descriptors, 'tokenSourceFactory');
  const providerFactoryValue = dataProperty(descriptors, 'providerFactory');
  const clock = clockValue === undefined ? undefined : callable(clockValue);
  const terminate = callable(terminateValue);
  const tokenSourceFactory = callable(tokenSourceFactoryValue);
  const providerFactory = callable(providerFactoryValue);
  if (
    (clockValue !== undefined && clock === undefined) ||
    (terminateValue !== undefined && terminate === undefined) ||
    (tokenSourceFactoryValue !== undefined && tokenSourceFactory === undefined) ||
    (providerFactoryValue !== undefined && providerFactory === undefined)
  ) {
    throw new TypeError('Invalid diagnostic dependency.');
  }

  return {
    environmentCandidate:
      descriptors.environment === undefined
        ? process.env
        : descriptors.environment.value,
    clock: clock as (() => number) | undefined,
    timer: resolveTimer(dataProperty(descriptors, 'timer')),
    output: resolveOutput(dataProperty(descriptors, 'output')),
    terminate: (terminate ?? DEFAULT_TERMINATE) as (
      exitCode: AzureGenerationDiagnosticExitCode
    ) => void,
    tokenSourceFactory: (tokenSourceFactory ?? defaultTokenSourceFactory) as (
      options: CreateAzureManagedIdentityTokenSourceOptions
    ) => AzureGenerationDiagnosticTokenSource,
    providerFactory: (providerFactory ?? defaultProviderFactory) as (
      config: AzureOpenAIChatGenerationProviderConfig
    ) => GenerationProvider
  };
}

function snapshotEnvironment(value: unknown): AzureGenerationDiagnosticEnvironment {
  const descriptors = ownDataDescriptors(value);
  const snapshot: Record<string, string | undefined> = Object.create(null) as Record<
    string,
    string | undefined
  >;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new TypeError('Invalid diagnostic configuration.');
    }
    const item = descriptors[key];
    if (item === undefined || (item.value !== undefined && typeof item.value !== 'string')) {
      throw new TypeError('Invalid diagnostic configuration.');
    }
    snapshot[key] = item.value as string | undefined;
  }
  return Object.freeze(snapshot) as AzureGenerationDiagnosticEnvironment;
}

function requiredEnvironmentValue(
  environment: AzureGenerationDiagnosticEnvironment,
  name: string
): string {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Invalid diagnostic configuration.');
  }
  return value;
}

function forbiddenEnvironmentFamily(name: string): boolean {
  const normalized = name.toUpperCase();
  return (
    normalized.includes('API_KEY') ||
    normalized === 'AZURE_APIKEY' ||
    normalized.startsWith('OPENROUTER_') ||
    normalized.startsWith('LITELLM_') ||
    normalized.startsWith('PALANCAR_LITELLM_') ||
    normalized.startsWith('OPENAI_') ||
    normalized.startsWith('AZURE_OPENAI_') ||
    normalized === 'AZURE_FOUNDRY_TOKEN_SCOPE' ||
    normalized === 'AZURE_TOKEN_SCOPE' ||
    normalized === 'OPENAI_SCOPE' ||
    normalized.endsWith('_SCOPE') ||
    normalized.endsWith('_API_VERSION') ||
    (normalized.endsWith('_VERSION') &&
      (normalized.startsWith('AZURE_') ||
        normalized.startsWith('OPENAI_') ||
        normalized.startsWith('PALANCAR_AZURE_') ||
        normalized.startsWith('PALANCAR_OPENAI_') ||
        normalized.startsWith('LITELLM_') ||
        normalized.startsWith('OPENROUTER_'))) ||
    normalized === 'AZURE_LOG_LEVEL' ||
    normalized.endsWith('_LOG_LEVEL') ||
    normalized.startsWith('PALANCAR_OTLP') ||
    normalized.startsWith('OTEL_EXPORTER')
  );
}

function rejectForbiddenEnvironmentFamilies(
  environment: AzureGenerationDiagnosticEnvironment
): void {
  for (const name of Object.keys(environment)) {
    if (environment[name] !== undefined && forbiddenEnvironmentFamily(name)) {
      throw new TypeError('Invalid diagnostic configuration.');
    }
  }
}

function snapshotTokenSource(value: unknown): SourceSnapshot {
  const descriptors = ownDataDescriptors(value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid diagnostic token source.');
  }
  void descriptors;
  const tokenProvider = inheritedDataProperty(value, 'tokenProvider');
  const close = dataMethod(value, 'close');
  if (
    typeof tokenProvider !== 'function' ||
    isProxy(tokenProvider) ||
    close === undefined
  ) {
    throw new TypeError('Invalid diagnostic token source.');
  }
  return Object.freeze({
    tokenProvider: tokenProvider as AzureTokenProvider,
    close: (): void => {
      void close();
    }
  });
}

function snapshotProvider(value: unknown): GenerationProvider {
  ownDataDescriptors(value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid diagnostic provider.');
  }
  const id = inheritedDataProperty(value, 'id');
  const version = inheritedDataProperty(value, 'version');
  const complete = dataMethod(value, 'complete');
  if (
    typeof id !== 'string' ||
    typeof version !== 'string' ||
    complete === undefined
  ) {
    throw new TypeError('Invalid diagnostic provider.');
  }
  const snapshot = Object.create(null) as {
    id: string;
    version: string;
    complete: (...args: readonly unknown[]) => unknown;
  };
  Object.defineProperties(snapshot, {
    id: { enumerable: true, value: id },
    version: { enumerable: true, value: version },
    complete: { enumerable: true, value: complete }
  });
  return Object.freeze(snapshot) as GenerationProvider;
}

function isProviderStage(value: unknown): value is GenerationProviderFailureStage {
  return typeof value === 'string' && CANONICAL_STAGE_SET.has(value);
}

function latestEvidence(service: GenerationService | undefined): GenerationEvidenceRecord | undefined {
  if (service === undefined) return undefined;
  try {
    const records = service.evidence;
    return records.length === 0 ? undefined : records[records.length - 1];
  } catch {
    return undefined;
  }
}

function failureOutcomeFromService(service: GenerationService | undefined): DiagnosticOutcome {
  const evidence = latestEvidence(service);
  const providerStage = evidence?.providerFailureStage;
  if (isProviderStage(providerStage)) {
    return {
      exitCode: EXIT_FAILURE,
      line: `${FAILURE_PREFIX}${providerStage}\n`
    };
  }
  if (
    evidence?.failureCategory === 'invalid-generated-language' ||
    evidence?.failureCategory === 'language-validation-failure' ||
    evidence?.languageValidationStatus === 'rejected' ||
    evidence?.languageValidationStatus === 'failed'
  ) {
    return {
      exitCode: EXIT_FAILURE,
      line: `${FAILURE_PREFIX}validation_failure\n`
    };
  }
  return {
    exitCode: EXIT_FAILURE,
    line: `${FAILURE_PREFIX}unknown\n`
  };
}

function unknownFailure(): DiagnosticOutcome {
  return {
    exitCode: EXIT_FAILURE,
    line: `${FAILURE_PREFIX}unknown\n`
  };
}

function timeoutOutcome(): DiagnosticOutcome {
  return { exitCode: EXIT_FAILURE, line: TIMEOUT_LINE };
}

function writeContentFree(output: ResolvedOutput, line: string): void {
  try {
    output.writeLine(line);
  } catch {
    // Output failures cannot be allowed to create a second diagnostic line.
  }
}

function terminateContentFree(
  terminate: (exitCode: AzureGenerationDiagnosticExitCode) => void,
  exitCode: AzureGenerationDiagnosticExitCode
): void {
  try {
    terminate(exitCode);
  } catch {
    // A reusable runner contains termination failures.
  }
}

function closeContentFree(close: (() => void) | undefined): void {
  if (close === undefined) return;
  try {
    close();
  } catch {
    // Resource cleanup is exact-once and content-free.
  }
}

export async function runAzureGenerationDiagnostic(
  input?: AzureGenerationDiagnosticDependencies
): Promise<AzureGenerationDiagnosticExitCode> {
  let dependencies: ResolvedDependencies;
  try {
    dependencies = resolveDependencies(input);
  } catch {
    writeContentFree(
      { writeLine: (line: string): void => writeFd1Synchronously(line) },
      unknownFailure().line
    );
    return EXIT_FAILURE;
  }

  const controller = new AbortController();
  let finished = false;
  let timedOut = false;
  let timerInstalled = false;
  let watchdogHandle: unknown;
  let sourceClose: (() => void) | undefined;
  let sourceClosed = false;
  let service: GenerationService | undefined;
  let resolveFinished!: (outcome: DiagnosticOutcome) => void;
  const finishedOutcome = new Promise<DiagnosticOutcome>((resolvePromise) => {
    resolveFinished = resolvePromise;
  });

  const closeSourceOnce = (): void => {
    if (sourceClosed || sourceClose === undefined) return;
    sourceClosed = true;
    closeContentFree(sourceClose);
  };

  const finishOnce = (outcome: DiagnosticOutcome, isTimeout: boolean): void => {
    if (finished) return;
    finished = true;
    timedOut = isTimeout;
    try {
      controller.abort();
    } catch {
      // Abort is best effort; the finish latch remains authoritative.
    }
    closeSourceOnce();
    if (!isTimeout && timerInstalled) {
      try {
        dependencies.timer.clearTimeout(watchdogHandle);
      } catch {
        // A hostile timer cannot create a second result.
      }
    }
    writeContentFree(dependencies.output, outcome.line);
    if (isTimeout) {
      terminateContentFree(dependencies.terminate, EXIT_FAILURE);
    }
    resolveFinished(outcome);
  };

  const onWatchdog = (): void => {
    try {
      finishOnce(timeoutOutcome(), true);
    } catch {
      // Inline or hostile timer callbacks remain content-free and latched.
    }
  };

  try {
    watchdogHandle = dependencies.timer.setTimeout(onWatchdog, WATCHDOG_MS);
    timerInstalled = true;
  } catch {
    if (!finished) finishOnce(unknownFailure(), false);
    return (await finishedOutcome).exitCode;
  }

  if (finished) {
    return (await finishedOutcome).exitCode;
  }

  const work = async (): Promise<DiagnosticOutcome> => {
    let candidate: unknown;
    try {
      if (finished) return timeoutOutcome();
      const environment = snapshotEnvironment(dependencies.environmentCandidate);
      if (finished) return timeoutOutcome();
      rejectForbiddenEnvironmentFamilies(environment);
      const clientId = canonicalAzureClientId(
        requiredEnvironmentValue(environment, 'AZURE_CLIENT_ID')
      );
      const endpoint = canonicalAzureGenerationEndpoint(
        requiredEnvironmentValue(environment, 'PALANCAR_AZURE_GENERATION_ENDPOINT')
      );
      const deployment = canonicalAzureGenerationDeployment(
        requiredEnvironmentValue(environment, 'PALANCAR_AZURE_GENERATION_DEPLOYMENT')
      );
      if (finished) return timeoutOutcome();

      const sourceOptions: CreateAzureManagedIdentityTokenSourceOptions =
        dependencies.clock === undefined
          ? { clientId }
          : { clientId, now: dependencies.clock };
      candidate = dependencies.tokenSourceFactory(sourceOptions);
      if (finished) {
        if (sourceClose === undefined) sourceClose = dataMethod(candidate as object, 'close');
        closeSourceOnce();
        return timeoutOutcome();
      }
      const source = snapshotTokenSource(candidate);
      sourceClose = source.close;
      if (finished) {
        closeSourceOnce();
        return timeoutOutcome();
      }

      const providerCandidate = dependencies.providerFactory({
        endpoint,
        deployment,
        tokenProvider: source.tokenProvider
      });
      if (finished) return timeoutOutcome();
      const provider = snapshotProvider(providerCandidate);
      if (finished) return timeoutOutcome();

      const boundary = createDevelopmentProvisionalLanguageBoundary();
      if (finished) return timeoutOutcome();
      service = new GenerationService({
        provider,
        validator: boundary.generatedLanguageValidator,
        languageValidationMode: 'development-provisional'
      });
      if (finished) return timeoutOutcome();
      await service.complete(FIXED_TURN, { signal: controller.signal });
      return finished ? timeoutOutcome() : {
        exitCode: EXIT_OK,
        line: PASSED_LINE
      };
    } catch {
      if (finished || timedOut) return timeoutOutcome();
      return failureOutcomeFromService(service);
    } finally {
      if (candidate !== undefined && sourceClose === undefined) {
        sourceClose = dataMethod(candidate as object, 'close');
      }
      closeSourceOnce();
    }
  };

  void work().then(
    (outcome) => finishOnce(outcome, false),
    () => finishOnce(failureOutcomeFromService(service), false)
  );
  return (await finishedOutcome).exitCode;
}

async function directEntry(): Promise<void> {
  let exited = false;
  const exitOnce = (exitCode: AzureGenerationDiagnosticExitCode): void => {
    if (exited) return;
    exited = true;
    process.exit(exitCode);
  };
  const exitCode = await runAzureGenerationDiagnostic({ terminate: exitOnce });
  exitOnce(exitCode);
}

function isDirectEntry(): boolean {
  try {
    const argument = process.argv[1];
    return argument !== undefined && resolve(argument) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  void directEntry().catch(() => {
    // The diagnostic protocol has already latched its bounded result.
  });
}
