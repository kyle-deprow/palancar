import { types as utilTypes } from 'node:util';

import { assertCanonical256BitToken, assertCanonicalPairingCode, assertCanonicalUuid } from './crypto.js';
import { SecurityStateError } from './errors.js';
import { exactDataObject } from './schema.js';
import { InMemorySecurityStateStore } from './store.js';
import { LOCAL_MOCK_ENVIRONMENT, LOCAL_MOCK_ONLY, type LocalMockSecurityStateOptions, type SecurityClock, type SecurityIdFactory, type SecurityTokenFactory, type StateAvailability } from './types.js';

export {
  AudioGrantMeter,
  createAudioGrantMeter,
  type AudioGrantMeterOptions,
  type AudioGrantMeterRangeInput,
  type AudioGrantMeterSnapshot
} from './audio-meter.js';
export {
  createAzureTableStoresForTesting,
  type AzureTableBootstrapStore,
  type AzureTableTestingOptions
} from './azure-store.js';
export {
  AZURE_CAS_ATTEMPTS,
  AZURE_SECURITY_SCHEMA_VERSION,
  AZURE_TRANSACTION_LIMIT,
  AzureTableBoundaryError,
  type AzureBoundaryErrorKind,
  type AzureListPageInput,
  type AzureListPageResult,
  type AzureNewEntity,
  type AzureProperties,
  type AzureStoredEntity,
  type AzureTableClientLike,
  type AzureTableMutation
} from './azure-schema.js';
export { createAzureTableClientBoundaryForTesting } from './azure-table-client.js';
export { createAvailableState, createSystemClock, createSystemIdFactory, createSystemTokenFactory } from './clock.js';
export { InMemorySecurityStateStore } from './store.js';
export type {
  LocalMockSecurityStateOptions,
  SecurityClock,
  SecurityIdFactory,
  SecurityTokenFactory,
  StateAvailability
} from './types.js';

export interface FakeClockController {
  readonly clock: SecurityClock;
  readonly now: () => number;
  readonly advance: (milliseconds: number) => void;
  readonly set: (milliseconds: number) => void;
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function createFakeClock(initialNow = 0): FakeClockController {
  if (!validTime(initialNow)) throw new TypeError('Invalid fake clock');
  let current = initialNow;
  const now = (): number => current;
  const clock = Object.freeze({ now });
  return Object.freeze({
    clock,
    now,
    advance: (milliseconds: number): void => {
      if (!validTime(milliseconds)) throw new TypeError('Invalid fake clock');
      const next = current + milliseconds;
      if (!validTime(next)) throw new RangeError('Fake clock overflow');
      current = next;
    },
    set: (milliseconds: number): void => {
      if (!validTime(milliseconds)) throw new TypeError('Invalid fake clock');
      current = milliseconds;
    }
  });
}

export interface MutableAvailability {
  readonly availability: StateAvailability;
  readonly set: (available: boolean) => void;
}

export function createMutableAvailability(initial = true): MutableAvailability {
  if (typeof initial !== 'boolean') throw new SecurityStateError('invalid-input');
  let current = initial;
  const availability = Object.freeze({ isAvailable: (): boolean => current });
  return Object.freeze({
    availability,
    set: (available: boolean): void => { current = available; }
  });
}

function exactSequence(value: unknown): readonly unknown[] {
  try {
    if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new SecurityStateError('invalid-input');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value <= 0 ||
      lengthDescriptor.value > 10_000
    ) throw new SecurityStateError('invalid-input');
    const length = lengthDescriptor.value as number;
    const copy: unknown[] = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) {
        throw new SecurityStateError('invalid-input');
      }
      const index = Number(key);
      const descriptor = descriptors[key];
      if (
        !Number.isSafeInteger(index) || index < 0 || index >= length || descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
      ) throw new SecurityStateError('invalid-input');
      copy[index] = descriptor.value;
    }
    if (copy.length !== length) throw new SecurityStateError('invalid-input');
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(copy, index)) throw new SecurityStateError('invalid-input');
    }
    return Object.freeze(copy);
  } catch (error) {
    if (error instanceof SecurityStateError) throw error;
    throw new SecurityStateError('invalid-input');
  }
}

function cyclic(values: unknown, validator: (value: unknown) => string): () => string {
  const copy = Object.freeze(exactSequence(values).map(validator));
  let index = 0;
  return (): string => {
    const value = copy[index % copy.length];
    index += 1;
    if (value === undefined) throw new TypeError('Deterministic sequence empty');
    return value;
  };
}

export function createDeterministicIdFactory(input: {
  readonly installationIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly grantIds: readonly string[];
  readonly generationClaimIds: readonly string[];
}): SecurityIdFactory {
  const parsed = exactDataObject(input, [
    'installationIds', 'sessionIds', 'grantIds', 'generationClaimIds'
  ]);
  return Object.freeze({
    installationId: cyclic(parsed.installationIds as readonly string[], assertCanonicalUuid),
    sessionId: cyclic(parsed.sessionIds as readonly string[], assertCanonicalUuid),
    grantId: cyclic(parsed.grantIds as readonly string[], assertCanonicalUuid),
    generationClaimId: cyclic(parsed.generationClaimIds as readonly string[], assertCanonicalUuid)
  });
}

export function createDeterministicTokenFactory(input: {
  readonly pairingCodes: readonly string[];
  readonly credentials: readonly string[];
  readonly tickets: readonly string[];
}): SecurityTokenFactory {
  const parsed = exactDataObject(input, ['pairingCodes', 'credentials', 'tickets']);
  return Object.freeze({
    pairingCode: cyclic(parsed.pairingCodes as readonly string[], assertCanonicalPairingCode),
    credential: cyclic(parsed.credentials as readonly string[], assertCanonical256BitToken),
    ticket: cyclic(parsed.tickets as readonly string[], assertCanonical256BitToken)
  });
}

export function createTestSecurityStateStore(
  options: Omit<LocalMockSecurityStateOptions, 'deploymentBoundary' | 'environment'> & {
    readonly environment?: typeof LOCAL_MOCK_ENVIRONMENT;
  }
): InMemorySecurityStateStore {
  const input = exactDataObject(
    options,
    ['audience', 'generationProvider', 'transcriptionProvider'],
    ['environment', 'clock', 'ids', 'tokens', 'availability']
  );
  if (input.environment !== undefined && input.environment !== LOCAL_MOCK_ENVIRONMENT) {
    throw new SecurityStateError('invalid-input');
  }
  if (input.generationProvider !== 'mock' || input.transcriptionProvider !== 'mock') {
    throw new SecurityStateError('invalid-input');
  }
  return new InMemorySecurityStateStore({
    deploymentBoundary: LOCAL_MOCK_ONLY,
    environment: LOCAL_MOCK_ENVIRONMENT,
    audience: input.audience as LocalMockSecurityStateOptions['audience'],
    generationProvider: 'mock',
    transcriptionProvider: 'mock',
    ...(input.clock === undefined ? {} : { clock: input.clock as SecurityClock }),
    ...(input.ids === undefined ? {} : { ids: input.ids as SecurityIdFactory }),
    ...(input.tokens === undefined ? {} : { tokens: input.tokens as SecurityTokenFactory }),
    ...(input.availability === undefined
      ? {}
      : { availability: input.availability as StateAvailability })
  });
}
