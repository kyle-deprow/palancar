import { describe, expect, it } from 'vitest';

import { createVirtualClock } from '../src/virtual-clock.js';

describe('virtual clock', () => {
  it('runs same-time events in stable insertion order', () => {
    const clock = createVirtualClock();
    const order: string[] = [];
    clock.schedule(5, () => {
      order.push('first');
      clock.schedule(0, () => order.push('third'));
    });
    clock.schedule(5, () => order.push('second'));

    clock.advanceTo(5);

    expect(order).toEqual(['first', 'second', 'third']);
    expect(clock.nowMs).toBe(5);
    expect(clock.pendingCount).toBe(0);
  });

  it('supports cancellation without disturbing remaining ordering', () => {
    const clock = createVirtualClock();
    const order: number[] = [];
    const cancel = clock.schedule(1, () => order.push(1));
    clock.schedule(1, () => order.push(2));
    cancel();

    clock.advanceBy(1);

    expect(order).toEqual([2]);
    expect(clock.pendingCount).toBe(0);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid advances %s',
    (milliseconds) => {
      const clock = createVirtualClock();
      expect(() => clock.advanceBy(milliseconds)).toThrow(RangeError);
    }
  );

  it('never permits time to move backwards', () => {
    const clock = createVirtualClock();
    clock.advanceTo(2);
    expect(() => clock.advanceTo(1)).toThrow(RangeError);
  });
});
