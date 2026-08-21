import type {
  GenerationErrorCategory,
  GenerationProviderFailureStage
} from './types.js';

const PROVIDER_FAILURE_STAGES: ReadonlySet<string> = new Set([
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
  'completion_schema',
  'unknown'
]);
const TRUSTED_GENERATION_ERRORS = new WeakSet<object>();
const TRUSTED_PROVIDER_ERRORS = new WeakSet<object>();
const TRUSTED_GENERATION_ERROR_STAGES = new WeakMap<
  object,
  GenerationProviderFailureStage | undefined
>();
const TRUSTED_PROVIDER_ERROR_STAGES = new WeakMap<
  object,
  GenerationProviderFailureStage | undefined
>();

export function isGenerationProviderFailureStage(
  value: unknown
): value is GenerationProviderFailureStage {
  return typeof value === 'string' && PROVIDER_FAILURE_STAGES.has(value);
}

function trustedProviderFailureStage(value: unknown): GenerationProviderFailureStage | undefined {
  if (isGenerationProviderFailureStage(value)) {
    return value;
  }
  return value === undefined ? undefined : 'unknown';
}

const PUBLIC_MESSAGES: Readonly<Record<GenerationErrorCategory, string>> = Object.freeze({
  'invalid-input': 'Invalid generation input.',
  'forged-value': 'Invalid generation value.',
  'correlation-mismatch': 'Generation correlation mismatch.',
  'invalid-provider': 'Invalid generation provider.',
  'invalid-provider-result': 'Provider returned invalid generation data.',
  'provider-failure': 'Generation provider failed.',
  'invalid-validator': 'Invalid generated-language validator.',
  'invalid-generated-language': 'Generated text failed language validation.',
  'language-validation-failure': 'Generated-language validation failed.',
  'invalid-evidence': 'Invalid generation evidence.'
});

export class GenerationError extends Error {
  readonly category!: GenerationErrorCategory;
  readonly providerFailureStage?: GenerationProviderFailureStage;

  constructor(category: GenerationErrorCategory, providerFailureStage?: unknown) {
    super(PUBLIC_MESSAGES[category]);
    this.name = 'GenerationError';
    Object.defineProperty(this, 'category', {
      configurable: false,
      enumerable: true,
      value: category,
      writable: false
    });
    if (category === 'provider-failure') {
      const trustedStage = trustedProviderFailureStage(providerFailureStage);
      if (trustedStage !== undefined) {
        Object.defineProperty(this, 'providerFailureStage', {
          configurable: false,
          enumerable: true,
          value: trustedStage,
          writable: false
        });
      }
      if (new.target === GenerationError) {
        TRUSTED_GENERATION_ERRORS.add(this);
        TRUSTED_GENERATION_ERROR_STAGES.set(this, trustedStage);
      }
    }
  }
}

/** A provider-boundary error with only a fixed, content-free failure stage. */
export class GenerationProviderError extends Error {
  readonly providerFailureStage?: GenerationProviderFailureStage;

  constructor(providerFailureStage?: unknown) {
    super('Generation provider failed.');
    this.name = 'GenerationProviderError';
    const trustedStage = trustedProviderFailureStage(providerFailureStage);
    if (trustedStage !== undefined) {
      Object.defineProperty(this, 'providerFailureStage', {
        configurable: false,
        enumerable: true,
        value: trustedStage,
        writable: false
      });
    }
    if (new.target === GenerationProviderError) {
      TRUSTED_PROVIDER_ERRORS.add(this);
      TRUSTED_PROVIDER_ERROR_STAGES.set(this, trustedStage);
    }
  }
}

export function trustedGenerationProviderFailureStage(
  value: unknown
): GenerationProviderFailureStage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  try {
    if (TRUSTED_GENERATION_ERRORS.has(value)) {
      return Object.getPrototypeOf(value) === GenerationError.prototype
        ? TRUSTED_GENERATION_ERROR_STAGES.get(value)
        : undefined;
    }
    if (TRUSTED_PROVIDER_ERRORS.has(value)) {
      return Object.getPrototypeOf(value) === GenerationProviderError.prototype
        ? TRUSTED_PROVIDER_ERROR_STAGES.get(value)
        : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function generationError(
  category: GenerationErrorCategory
): GenerationError {
  return new GenerationError(category);
}
