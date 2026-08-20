import { describe, expect, it, vi } from 'vitest';

import {
  FailClosedGeneratedLanguageValidator,
  GenerationError,
  isAcceptedGeneratedLanguageEvidence,
  isFailClosedGeneratedLanguageValidator
} from '../src/index.js';
import type {
  GeneratedLanguageValidationCheck,
  GeneratedLanguageValidationEvidence,
  GeneratedLanguageValidationInput
} from '../src/index.js';

const FAILURE = Object.freeze({
  category: 'language-validation-failure',
  message: 'Generated-language validation failed.'
});

function validationInput(
  count: 5 | 7,
  target: 'es' | 'tr' = 'es',
  canary = 'generated-text-canary'
): GeneratedLanguageValidationInput {
  const checks: GeneratedLanguageValidationCheck[] = [
    { slot: 'translation.english', text: `${canary}-translation`, expectedLanguage: 'en' },
    { slot: 'suggestion[0].english', text: `${canary}-0-en`, expectedLanguage: 'en' },
    { slot: 'suggestion[0].target', text: `${canary}-0-target`, expectedLanguage: target },
    { slot: 'suggestion[1].english', text: `${canary}-1-en`, expectedLanguage: 'en' },
    { slot: 'suggestion[1].target', text: `${canary}-1-target`, expectedLanguage: target }
  ];
  if (count === 7) {
    checks.push(
      { slot: 'suggestion[2].english', text: `${canary}-2-en`, expectedLanguage: 'en' },
      { slot: 'suggestion[2].target', text: `${canary}-2-target`, expectedLanguage: target }
    );
  }
  return Object.freeze({
    checks: Object.freeze(checks.map((check) => Object.freeze(check))) as
      GeneratedLanguageValidationInput['checks']
  });
}

function mutableValidationInput(
  count: 5 | 7,
  canary = 'mutable-generated-text-canary'
): GeneratedLanguageValidationInput {
  const frozen = validationInput(count, 'es', canary);
  return {
    checks: frozen.checks.map((check) => ({ ...check })) as unknown as
      GeneratedLanguageValidationInput['checks']
  };
}

const NON_ENUMERABLE_INDEX_CASES = ([5, 7] as const).flatMap((count) =>
  Array.from({ length: count }, (_value, index) => ({ count, index }))
);

function controllerContext(controller = new AbortController()): {
  readonly controller: AbortController;
  readonly context: { readonly signal: AbortSignal };
} {
  return {
    controller,
    context: Object.freeze({ signal: controller.signal })
  };
}

async function fixedFailure(operation: Promise<unknown>, canary?: string): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GenerationError);
  expect(error).toMatchObject(FAILURE);
  expect((error as { readonly cause?: unknown }).cause).toBeUndefined();
  const publicError = String(error) + JSON.stringify(error);
  if (canary !== undefined) {
    expect(publicError).not.toContain(canary);
  }
}

function expectExactFrozenEvidence(
  evidence: GeneratedLanguageValidationEvidence,
  input: GeneratedLanguageValidationInput
): void {
  expect(evidence).toEqual({
    checks: input.checks.map(({ slot, expectedLanguage }) => ({
      slot,
      expectedLanguage,
      detectedLanguage: 'undetermined',
      verdict: 'indeterminate',
      evidenceType: 'calibrated',
      confidenceBasisPoints: null,
      provisionalScoreBasisPoints: null
    }))
  });
  expect(Reflect.ownKeys(evidence)).toEqual(['checks']);
  expect(Object.isFrozen(evidence)).toBe(true);
  expect(Object.isFrozen(evidence.checks)).toBe(true);
  for (const check of evidence.checks) {
    expect(Reflect.ownKeys(check)).toEqual([
      'slot',
      'expectedLanguage',
      'detectedLanguage',
      'verdict',
      'evidenceType',
      'confidenceBasisPoints',
      'provisionalScoreBasisPoints'
    ]);
    expect(Object.isFrozen(check)).toBe(true);
  }
}

function structurallyReferences(root: object, sought: object): boolean {
  const pending: object[] = [root];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    if (current === sought) {
      return true;
    }
    visited.add(current);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if (
        Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'object' &&
        descriptor.value !== null
      ) {
        pending.push(descriptor.value as object);
      }
    }
  }
  return false;
}

describe('FailClosedGeneratedLanguageValidator', () => {
  it('has fixed bounded identity and an unforgeable instance brand', () => {
    const validator = new FailClosedGeneratedLanguageValidator();
    const second = new FailClosedGeneratedLanguageValidator();
    const ignoredConfiguration = new (
      FailClosedGeneratedLanguageValidator as unknown as new (value: unknown) =>
        FailClosedGeneratedLanguageValidator
    )({ id: 'caller-controlled', version: 'caller-controlled' });
    const lookalike = {
      id: validator.id,
      version: validator.version,
      validate: validator.validate.bind(validator)
    };
    const inheritedLookalike = Object.create(
      FailClosedGeneratedLanguageValidator.prototype
    ) as object;
    const proxy = new Proxy(validator, {
      getPrototypeOf: () => {
        throw new Error('brand-proxy-canary');
      }
    });
    const revoked = Proxy.revocable(validator, {});
    revoked.revoke();

    expect(validator.id).toBe('fail-closed-generated-language');
    expect(validator.version).toBe('1.0.0');
    expect(validator.id).toBe(second.id);
    expect(validator.version).toBe(second.version);
    expect(ignoredConfiguration.id).toBe(validator.id);
    expect(ignoredConfiguration.version).toBe(validator.version);
    expect(validator.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
    expect(validator.version).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
    expect(Object.isFrozen(validator)).toBe(true);
    expect(isFailClosedGeneratedLanguageValidator(validator)).toBe(true);
    expect(isFailClosedGeneratedLanguageValidator(second)).toBe(true);
    expect(isFailClosedGeneratedLanguageValidator(ignoredConfiguration)).toBe(true);
    expect(isFailClosedGeneratedLanguageValidator(lookalike)).toBe(false);
    expect(isFailClosedGeneratedLanguageValidator(inheritedLookalike)).toBe(false);
    expect(isFailClosedGeneratedLanguageValidator(proxy)).toBe(false);
    expect(isFailClosedGeneratedLanguageValidator(revoked.proxy)).toBe(false);
    expect(isFailClosedGeneratedLanguageValidator(null)).toBe(false);
  });

  it.each([
    [5, 'es'],
    [7, 'tr']
  ] as const)(
    'returns exact deeply frozen indeterminate evidence for %d checks',
    async (count, target) => {
      const canary = `generated-${count}-check-canary`;
      const input = validationInput(count, target, canary);
      const validator = new FailClosedGeneratedLanguageValidator();
      const { context } = controllerContext();

      const evidence = await validator.validate(input, context);

      expectExactFrozenEvidence(evidence, input);
      expect(evidence.checks).toHaveLength(count);
      expect(evidence.checks.every((check) => check.verdict !== 'match')).toBe(true);
      expect(isAcceptedGeneratedLanguageEvidence(evidence)).toBe(false);
      expect(JSON.stringify(evidence)).not.toContain(canary);
      expect(JSON.stringify(evidence)).not.toContain('text');
    }
  );

  it('preserves support for ordinary enumerable mutable input descriptors', async () => {
    const input = mutableValidationInput(5);
    const evidence = await new FailClosedGeneratedLanguageValidator().validate(
      input,
      { signal: new AbortController().signal }
    );

    expectExactFrozenEvidence(evidence, input);
    expect(isAcceptedGeneratedLanguageEvidence(evidence)).toBe(false);
  });

  it('honors an already-aborted signal before inspecting input', async () => {
    const canary = 'pre-abort-getter-canary';
    let getterCalls = 0;
    const hostileInput = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostileInput, 'checks', {
      get: () => {
        getterCalls += 1;
        throw new Error(canary);
      }
    });
    const { controller, context } = controllerContext();
    controller.abort(canary);

    await fixedFailure(
      new FailClosedGeneratedLanguageValidator().validate(
        hostileInput as unknown as GeneratedLanguageValidationInput,
        context
      ),
      canary
    );
    expect(getterCalls).toBe(0);
  });

  it('settles an abort race with the same fixed content-free failure', async () => {
    const canary = 'abort-race-reason-canary';
    const { controller, context } = controllerContext();
    const operation = new FailClosedGeneratedLanguageValidator().validate(
      validationInput(7, 'tr', canary),
      context
    );

    controller.abort(canary);

    await fixedFailure(operation, canary);
  });

  it('uses no model, network, or timer and never produces accepted evidence', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const evidence = await new FailClosedGeneratedLanguageValidator().validate(
        validationInput(5),
        controllerContext().context
      );

      expect(timeout).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(isAcceptedGeneratedLanguageEvidence(evidence)).toBe(false);
    } finally {
      timeout.mockRestore();
      fetch.mockRestore();
    }
  });

  it('retains neither the input graph nor generated text in observable output state', async () => {
    const canary = 'non-retention-generated-canary';
    const input = validationInput(7, 'es', canary);
    const checks = input.checks;
    const firstCheck = checks[0];
    const inputReference = new WeakRef(input);
    const validator = new FailClosedGeneratedLanguageValidator();
    const evidence = await validator.validate(input, controllerContext().context);

    expect(inputReference.deref()).toBe(input);
    expect(Object.keys(validator)).toEqual(['id', 'version']);
    expect(Reflect.ownKeys(validator)).toEqual(['id', 'version']);
    expect('input' in validator).toBe(false);
    expect('inputs' in validator).toBe(false);
    expect('text' in validator).toBe(false);
    expect(structurallyReferences(validator, input)).toBe(false);
    expect(structurallyReferences(validator, checks)).toBe(false);
    expect(structurallyReferences(evidence, input)).toBe(false);
    expect(structurallyReferences(evidence, checks)).toBe(false);
    expect(structurallyReferences(evidence, firstCheck)).toBe(false);
    expect(JSON.stringify(validator) + JSON.stringify(evidence)).not.toContain(canary);
  });

  it.each([
    ['outer object', 'checks'],
    ['check object', 'text']
  ] as const)('rejects a throwing %s accessor without invoking it', async (kind, field) => {
    const canary = `accessor-${kind}-canary`;
    let getterCalls = 0;
    let hostile: unknown;
    let accessorTarget: object;
    if (kind === 'outer object') {
      const outer = Object.create(null) as Record<string, unknown>;
      hostile = outer;
      accessorTarget = outer;
    } else {
      const checks: object[] = validationInput(5).checks.map((check) => ({ ...check }));
      const first = checks[0];
      if (first === undefined) {
        throw new Error('missing test target');
      }
      hostile = { checks };
      accessorTarget = first;
    }
    Object.defineProperty(accessorTarget, field, {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error(canary);
      }
    });

    await fixedFailure(
      new FailClosedGeneratedLanguageValidator().validate(
        hostile as unknown as GeneratedLanguageValidationInput,
        controllerContext().context
      ),
      canary
    );
    expect(getterCalls).toBe(0);
  });

  it('rejects a non-enumerable root checks descriptor with a content-free error', async () => {
    const canary = 'non-enumerable-root-checks-canary';
    const hostile = {};
    Object.defineProperty(hostile, 'checks', {
      value: validationInput(5, 'es', canary).checks,
      enumerable: false,
      writable: false,
      configurable: false
    });

    await fixedFailure(
      new FailClosedGeneratedLanguageValidator().validate(
        hostile as GeneratedLanguageValidationInput,
        controllerContext().context
      ),
      canary
    );
  });

  it.each(['slot', 'text', 'expectedLanguage'] as const)(
    'rejects a non-enumerable check %s descriptor with a content-free error',
    async (field) => {
      const canary = `non-enumerable-check-${field}-canary`;
      const hostile = mutableValidationInput(5, canary);
      const first = hostile.checks[0] as GeneratedLanguageValidationCheck;
      const value = first[field];
      Object.defineProperty(first, field, {
        value,
        enumerable: false,
        writable: true,
        configurable: true
      });

      await fixedFailure(
        new FailClosedGeneratedLanguageValidator().validate(
          hostile,
          controllerContext().context
        ),
        canary
      );
    }
  );

  it.each(NON_ENUMERABLE_INDEX_CASES)(
    'rejects non-enumerable index $index in a $count-check array content-free',
    async ({ count, index }) => {
      const canary = `non-enumerable-${count}-check-index-${index}-canary`;
      const hostile = mutableValidationInput(count, canary);
      const check = hostile.checks[index];
      if (check === undefined) {
        throw new Error('missing test target');
      }
      Object.defineProperty(hostile.checks, String(index), {
        value: check,
        enumerable: false,
        writable: true,
        configurable: true
      });

      await fixedFailure(
        new FailClosedGeneratedLanguageValidator().validate(
          hostile,
          controllerContext().context
        ),
        canary
      );
    }
  );

  it.each(['root', 'check', 'index'] as const)(
    'rejects inconsistent %s data-descriptor flags content-free',
    async (location) => {
      const canary = `inconsistent-${location}-descriptor-canary`;
      const hostile = mutableValidationInput(5, canary);
      if (location === 'root') {
        Object.defineProperty(hostile, 'checks', {
          value: hostile.checks,
          enumerable: true,
          writable: true,
          configurable: false
        });
      } else if (location === 'check') {
        const first = hostile.checks[0];
        if (first === undefined) {
          throw new Error('missing test target');
        }
        Object.defineProperty(first, 'text', {
          value: first.text,
          enumerable: true,
          writable: false,
          configurable: true
        });
      } else {
        const first = hostile.checks[0];
        if (first === undefined) {
          throw new Error('missing test target');
        }
        Object.defineProperty(hostile.checks, '0', {
          value: first,
          enumerable: true,
          writable: false,
          configurable: false
        });
      }

      await fixedFailure(
        new FailClosedGeneratedLanguageValidator().validate(
          hostile,
          controllerContext().context
        ),
        canary
      );
    }
  );

  it.each(['outer', 'array', 'check'] as const)(
    'rejects symbol and extra keys on the %s snapshot boundary',
    async (location) => {
      const canary = `extra-${location}-canary`;
      const base = validationInput(5);
      const checks: object[] = base.checks.map((check) => ({ ...check }));
      const hostile = { checks } as Record<PropertyKey, unknown>;
      const target: object | undefined = location === 'outer'
        ? hostile
        : location === 'array'
          ? checks
          : checks[0];
      if (target === undefined) {
        throw new Error('missing test target');
      }
      Object.defineProperty(target, 'extra', { value: canary, enumerable: true });
      Object.defineProperty(target, Symbol(canary), { value: canary, enumerable: true });

      await fixedFailure(
        new FailClosedGeneratedLanguageValidator().validate(
          hostile as unknown as GeneratedLanguageValidationInput,
          controllerContext().context
        ),
        canary
      );
    }
  );

  it('normalizes throwing and revoked input proxies without leaking trap text', async () => {
    const canary = 'input-proxy-trap-canary';
    const throwing = new Proxy(validationInput(5), {
      ownKeys: () => {
        throw new Error(canary);
      }
    });
    const revoked = Proxy.revocable(validationInput(7), {});
    revoked.revoke();
    const validator = new FailClosedGeneratedLanguageValidator();

    await fixedFailure(
      validator.validate(throwing, controllerContext().context),
      canary
    );
    await fixedFailure(
      validator.validate(revoked.proxy, controllerContext().context),
      canary
    );
  });

  it.each(['outer', 'array', 'check'] as const)(
    'rejects a transparent proxy at the %s snapshot boundary',
    async (location) => {
      const base = validationInput(5);
      const checks: GeneratedLanguageValidationCheck[] = [...base.checks];
      let hostile: unknown;
      if (location === 'outer') {
        hostile = new Proxy(base, {});
      } else if (location === 'array') {
        hostile = { checks: new Proxy(checks, {}) };
      } else {
        const first = checks[0];
        if (first === undefined) {
          throw new Error('missing test target');
        }
        checks[0] = new Proxy(first, {});
        hostile = { checks };
      }

      await fixedFailure(
        new FailClosedGeneratedLanguageValidator().validate(
          hostile as GeneratedLanguageValidationInput,
          controllerContext().context
        )
      );
    }
  );

  it.each([
    ['wrong length', () => ({ checks: validationInput(5).checks.slice(0, 4) })],
    ['invalid slot', () => {
      const checks = [...validationInput(5).checks];
      checks[0] = {
        ...checks[0] as GeneratedLanguageValidationCheck,
        slot: 'invalid-slot' as GeneratedLanguageValidationCheck['slot']
      };
      return { checks };
    }],
    ['invalid expected language', () => {
      const checks = [...validationInput(5).checks];
      checks[4] = {
        ...checks[4] as GeneratedLanguageValidationCheck,
        expectedLanguage: 'fr' as GeneratedLanguageValidationCheck['expectedLanguage']
      };
      return { checks };
    }],
    ['non-string text', () => {
      const checks = [...validationInput(5).checks] as unknown as Array<
        Record<string, unknown>
      >;
      checks[0] = { ...checks[0], text: 1 };
      return { checks };
    }]
  ] as const)('rejects malformed exact input: %s', async (_name, createInput) => {
    await fixedFailure(
      new FailClosedGeneratedLanguageValidator().validate(
        createInput() as unknown as GeneratedLanguageValidationInput,
        controllerContext().context
      )
    );
  });

  it('rejects hostile context structure and AbortSignal proxies with fixed errors', async () => {
    const canary = 'hostile-context-canary';
    let getterCalls = 0;
    const accessorContext = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorContext, 'signal', {
      get: () => {
        getterCalls += 1;
        throw new Error(canary);
      }
    });
    const proxiedSignal = new Proxy(new AbortController().signal, {});
    const revokedSignal = Proxy.revocable(new AbortController().signal, {});
    revokedSignal.revoke();
    const validator = new FailClosedGeneratedLanguageValidator();

    await fixedFailure(
      validator.validate(validationInput(5), accessorContext as { signal: AbortSignal }),
      canary
    );
    await fixedFailure(
      validator.validate(validationInput(5), { signal: proxiedSignal }),
      canary
    );
    await fixedFailure(
      validator.validate(validationInput(5), { signal: revokedSignal.proxy }),
      canary
    );
    expect(getterCalls).toBe(0);
  });
});
