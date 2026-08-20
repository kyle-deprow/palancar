import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isImmutableImageReference,
  parseSmokeArguments,
  runDocker,
  waitForHealth
} from './smoke-container.mjs';

const digest = 'a'.repeat(64);

test('waits for a running and healthy container', async () => {
  let inspected = 0;
  await waitForHealth('container-id', {
    clock: () => 1_000,
    inspect: () => {
      inspected += 1;
      return { running: true, healthStatus: 'healthy' };
    }
  });
  assert.equal(inspected, 1);
});

test('rejects an exited container even when its retained health is healthy', async () => {
  await assert.rejects(
    waitForHealth('container-id', {
      clock: () => 1_000,
      inspect: () => ({ running: false, healthStatus: 'healthy' })
    }),
    (error) => error?.code === 'container_not_running'
  );
});

test('bounds a stalled Docker invocation by the remaining deadline', () => {
  let invocation;
  const deadline = 5_000;
  assert.throws(
    () => runDocker(['inspect', 'container-id'], {
      clock: () => 1_000,
      deadline,
      spawnSync: (_command, _args, options) => {
        invocation = options;
        return {
          error: Object.assign(new Error(), { code: 'ETIMEDOUT' }),
          signal: 'SIGTERM',
          status: null,
          stdout: ''
        };
      }
    }),
    (error) => error?.code === 'docker_command_timeout'
  );
  assert.equal(invocation.timeout, deadline - 1_000);
});

test('accepts only a single digest-qualified immutable image reference', () => {
  const image = `ghcr.io/palancar/relay@sha256:${digest}`;
  assert.deepEqual(parseSmokeArguments([]), {
    image: 'palancar-relay:local',
    shouldBuild: true
  });
  assert.deepEqual(parseSmokeArguments([image]), {
    image,
    shouldBuild: false
  });
  assert.equal(isImmutableImageReference('palancar-relay:local'), false);
  assert.equal(isImmutableImageReference(`ghcr.io/palancar/relay@sha256:${digest.toUpperCase()}`), false);
  assert.throws(() => parseSmokeArguments([image, image]), /invalid_image_reference/);
  assert.throws(() => parseSmokeArguments(['palancar-relay:local']), /invalid_image_reference/);
});

if (process.env.VITEST !== undefined || process.argv.some((arg) => arg.includes('/vitest'))) {
  const { describe, it } = await import('vitest');

  describe('container smoke helpers', () => {
    it('accepts running and healthy', async () => {
      await waitForHealth('container-id', {
        clock: () => 1_000,
        inspect: () => ({ running: true, healthStatus: 'healthy' })
      });
    });

    it('rejects exited but healthy', async () => {
      await assert.rejects(
        waitForHealth('container-id', {
          clock: () => 1_000,
          inspect: () => ({ running: false, healthStatus: 'healthy' })
        }),
        (error) => error?.code === 'container_not_running'
      );
    });

    it('bounds stalled Docker invocation', () => {
      assert.throws(
        () => runDocker(['inspect', 'container-id'], {
          clock: () => 1_000,
          deadline: 5_000,
          spawnSync: () => ({
            error: Object.assign(new Error(), { code: 'ETIMEDOUT' }),
            signal: 'SIGTERM',
            status: null,
            stdout: ''
          })
        }),
        (error) => error?.code === 'docker_command_timeout'
      );
    });

    it('validates immutable image references', () => {
      assert.equal(isImmutableImageReference('palancar-relay:local'), false);
      assert.equal(
        isImmutableImageReference(`ghcr.io/palancar/relay@sha256:${digest}`),
        true
      );
    });
  });
}
