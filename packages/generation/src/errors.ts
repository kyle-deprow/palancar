import type { GenerationErrorCategory } from './types.js';

const PUBLIC_MESSAGES: Readonly<Record<GenerationErrorCategory, string>> = Object.freeze({
  'invalid-input': 'Invalid generation input.',
  'forged-value': 'Invalid generation value.',
  'correlation-mismatch': 'Generation correlation mismatch.',
  'invalid-provider': 'Invalid generation provider.',
  'invalid-provider-result': 'Provider returned invalid generation data.',
  'provider-failure': 'Generation provider failed.',
  'invalid-evidence': 'Invalid generation evidence.'
});

export class GenerationError extends Error {
  readonly category: GenerationErrorCategory;

  constructor(category: GenerationErrorCategory, cause?: unknown) {
    super(PUBLIC_MESSAGES[category]);
    this.name = 'GenerationError';
    this.category = category;
    void cause;
  }
}

export function generationError(
  category: GenerationErrorCategory
): GenerationError {
  return new GenerationError(category);
}
