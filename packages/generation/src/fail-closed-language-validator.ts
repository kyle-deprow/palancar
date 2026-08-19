import { isTargetLanguage } from '@palancar/language-registry';

import { GenerationError } from './errors.js';
import type {
  GeneratedLanguage,
  GeneratedLanguageSlot,
  GeneratedLanguageValidationEvidence,
  GeneratedLanguageValidationEvidenceCheck,
  GeneratedLanguageValidationInput,
  GeneratedLanguageValidator
} from './language-validation.js';

const VALIDATORS = new WeakSet<object>();

const VALIDATOR_ID = 'fail-closed-generated-language';
const VALIDATOR_VERSION = '1.0.0';

const CONTEXT_KEYS = new Set(['signal']);
const INPUT_KEYS = new Set(['checks']);
const CHECK_KEYS = new Set(['slot', 'text', 'expectedLanguage']);

const SLOTS: ReadonlySet<GeneratedLanguageSlot> = new Set([
  'translation.english',
  'suggestion[0].english',
  'suggestion[0].target',
  'suggestion[1].english',
  'suggestion[1].target',
  'suggestion[2].english',
  'suggestion[2].target'
]);

const ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted'
)?.get;

type ProxyDetector = (value: unknown) => boolean;

const PROXY_DETECTOR: ProxyDetector | undefined = (() => {
  try {
    const processValue = (globalThis as {
      readonly process?: {
        getBuiltinModule?: (name: string) => unknown;
      };
    }).process;
    const utility = processValue?.getBuiltinModule?.('node:util') as {
      readonly types?: { readonly isProxy?: ProxyDetector };
    } | undefined;
    const detector = utility?.types?.isProxy;
    return typeof detector === 'function' ? (value: unknown) => detector(value) : undefined;
  } catch {
    return undefined;
  }
})();

function failure(): GenerationError {
  return new GenerationError('language-validation-failure');
}

function fail(): never {
  throw failure();
}

function isProxy(value: object): boolean {
  if (PROXY_DETECTOR === undefined) {
    fail();
  }
  try {
    return PROXY_DETECTOR(value);
  } catch {
    fail();
  }
}

type DataDescriptorMode = 'ordinary' | 'frozen';

function dataDescriptorMode(descriptor: PropertyDescriptor): DataDescriptorMode {
  if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
    fail();
  }
  if (descriptor.writable === true && descriptor.configurable === true) {
    return 'ordinary';
  }
  if (descriptor.writable === false && descriptor.configurable === false) {
    return 'frozen';
  }
  fail();
}

function exactObjectDescriptors(
  value: unknown,
  allowedKeys: ReadonlySet<string>
): Record<PropertyKey, PropertyDescriptor> {
  if (
    typeof value !== 'object' ||
    value === null ||
    isProxy(value) ||
    Array.isArray(value)
  ) {
    fail();
  }

  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    fail();
  }

  if (prototype !== Object.prototype && prototype !== null) {
    fail();
  }

  try {
    let mode: DataDescriptorMode | undefined;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        fail();
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined) {
        fail();
      }
      const descriptorMode = dataDescriptorMode(descriptor);
      if (mode !== undefined && descriptorMode !== mode) {
        fail();
      }
      mode = descriptorMode;
    }
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    fail();
  }

  for (const key of allowedKeys) {
    if (!Object.hasOwn(descriptors, key)) {
      fail();
    }
  }
  return descriptors;
}

function exactChecks(value: unknown): readonly unknown[] {
  let isArray: boolean;
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
      fail();
    }
    isArray = Array.isArray(value);
    if (!isArray) {
      fail();
    }
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    fail();
  }

  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (
    prototype !== Array.prototype ||
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    lengthDescriptor.enumerable !== false ||
    lengthDescriptor.configurable !== false ||
    (lengthDescriptor.writable !== true && lengthDescriptor.writable !== false) ||
    (length !== 5 && length !== 7)
  ) {
    fail();
  }

  const copy: unknown[] = [];
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === 'length') {
        continue;
      }
      if (
        typeof key !== 'string' ||
        !/^(?:0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= length
      ) {
        fail();
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true ||
        descriptor.writable !== lengthDescriptor.writable ||
        descriptor.configurable !== lengthDescriptor.writable
      ) {
        fail();
      }
    }

    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        fail();
      }
      copy.push(descriptor.value);
    }
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    fail();
  }
  return copy;
}

function snapshotContext(value: unknown): AbortSignal {
  const descriptors = exactObjectDescriptors(value, CONTEXT_KEYS);
  const signal = descriptors.signal?.value;
  if (
    typeof signal !== 'object' ||
    signal === null ||
    isProxy(signal) ||
    !(signal instanceof AbortSignal)
  ) {
    fail();
  }
  return signal;
}

function isAborted(signal: AbortSignal): boolean {
  if (ABORTED_GETTER === undefined) {
    fail();
  }
  try {
    return ABORTED_GETTER.call(signal) as boolean;
  } catch {
    fail();
  }
}

function snapshotCheck(
  value: unknown
): GeneratedLanguageValidationEvidenceCheck {
  const descriptors = exactObjectDescriptors(value, CHECK_KEYS);
  const slot = descriptors.slot?.value;
  const text = descriptors.text?.value;
  const expectedLanguage = descriptors.expectedLanguage?.value;

  if (
    typeof slot !== 'string' ||
    !SLOTS.has(slot as GeneratedLanguageSlot) ||
    typeof text !== 'string' ||
    (expectedLanguage !== 'en' &&
      (typeof expectedLanguage !== 'string' || !isTargetLanguage(expectedLanguage)))
  ) {
    fail();
  }

  return Object.freeze({
    slot: slot as GeneratedLanguageSlot,
    expectedLanguage: expectedLanguage as GeneratedLanguage,
    detectedLanguage: 'undetermined',
    verdict: 'indeterminate',
    confidenceBasisPoints: null
  });
}

function snapshotEvidence(input: unknown): GeneratedLanguageValidationEvidence {
  const inputDescriptors = exactObjectDescriptors(input, INPUT_KEYS);
  const rawChecks = exactChecks(inputDescriptors.checks?.value);
  const checks: GeneratedLanguageValidationEvidenceCheck[] = [];

  for (const rawCheck of rawChecks) {
    checks.push(snapshotCheck(rawCheck));
  }

  return Object.freeze({
    checks: Object.freeze(checks) as GeneratedLanguageValidationEvidence['checks']
  });
}

function addAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    EventTarget.prototype.addEventListener.call(signal, 'abort', listener, { once: true });
  } catch {
    fail();
  }
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    EventTarget.prototype.removeEventListener.call(signal, 'abort', listener);
  } catch {
    // Cleanup is best effort and never changes the fixed public result.
  }
}

/**
 * A production-safe fallback that can only return indeterminate evidence.
 */
export class FailClosedGeneratedLanguageValidator implements GeneratedLanguageValidator {
  readonly id = VALIDATOR_ID;
  readonly version = VALIDATOR_VERSION;

  constructor() {
    VALIDATORS.add(this);
    Object.freeze(this);
  }

  validate(
    input: GeneratedLanguageValidationInput,
    context: { readonly signal: AbortSignal }
  ): Promise<GeneratedLanguageValidationEvidence> {
    let signal: AbortSignal;
    try {
      signal = snapshotContext(context);
      if (isAborted(signal)) {
        return Promise.reject(failure());
      }
    } catch {
      return Promise.reject(failure());
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const rejectFailure = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        removeAbortListener(signal, onAbort);
        reject(failure());
      };
      const onAbort = (): void => {
        rejectFailure();
      };

      try {
        addAbortListener(signal, onAbort);
        if (isAborted(signal)) {
          rejectFailure();
          return;
        }
      } catch {
        rejectFailure();
        return;
      }

      void Promise.resolve().then(() => {
        if (settled) {
          return;
        }
        let evidence: GeneratedLanguageValidationEvidence;
        try {
          evidence = snapshotEvidence(input);
          if (isAborted(signal)) {
            rejectFailure();
            return;
          }
        } catch {
          rejectFailure();
          return;
        }

        settled = true;
        removeAbortListener(signal, onAbort);
        resolve(evidence);
      });
    });
  }
}

export function isFailClosedGeneratedLanguageValidator(
  value: unknown
): value is FailClosedGeneratedLanguageValidator {
  return typeof value === 'object' && value !== null && VALIDATORS.has(value);
}
