import { types as utilTypes } from 'node:util';

import { SecurityStateError, type SecurityErrorCategory } from './errors.js';

export type DataSnapshot = Readonly<Record<string, unknown>>;

export function exactDataObject(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
  category: SecurityErrorCategory = 'invalid-input'
): DataSnapshot {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new SecurityStateError(category);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
      throw new SecurityStateError(category);
    }
    for (const key of requiredKeys) {
      if (!Object.hasOwn(descriptors, key)) throw new SecurityStateError(category);
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of ownKeys) {
      if (typeof key !== 'string') throw new SecurityStateError(category);
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true
      ) {
        throw new SecurityStateError(category);
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof SecurityStateError) throw error;
    throw new SecurityStateError(category);
  }
}

export function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

export function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
