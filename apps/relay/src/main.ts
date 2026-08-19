import { createRelayHost, parseRelayHostConfig } from './host.js';

let host: ReturnType<typeof createRelayHost> | undefined;
try {
  host = createRelayHost(parseRelayHostConfig(process.env));
} catch {
  process.stderr.write('relay failed to start\n');
  process.exitCode = 1;
}

if (host !== undefined) {
  let shutdownPromise: Promise<void> | undefined;

  const removeSignalListeners = (): void => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  };
  const shutdown = (): void => {
    if (shutdownPromise !== undefined) {
      process.exitCode = 1;
      return;
    }
    shutdownPromise = (async (): Promise<void> => {
      await host?.stop().catch(() => undefined);
      removeSignalListeners();
      process.exitCode ??= 0;
    })();
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  void host.start().then(
    ({ port }) => {
      if (shutdownPromise === undefined) {
        process.stdout.write(`relay listening on ${port}\n`);
      }
    },
    async () => {
      if (shutdownPromise !== undefined) {
        await shutdownPromise;
        return;
      }
      await host?.stop().catch(() => undefined);
      removeSignalListeners();
      process.stderr.write('relay failed to start\n');
      process.exitCode = 1;
    }
  );
}
