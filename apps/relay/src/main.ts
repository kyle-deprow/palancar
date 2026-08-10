import { createRelayHost, parseRelayHostConfig } from './host.js';

let host: ReturnType<typeof createRelayHost> | undefined;
try {
  host = createRelayHost(parseRelayHostConfig(process.env));
} catch {
  process.stderr.write('relay failed to start\n');
  process.exitCode = 1;
}

if (host !== undefined) {
  let shuttingDown = false;

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void host?.stop().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  void host.start().then(
    ({ port }) => {
      process.stdout.write(`relay listening on ${port}\n`);
    },
    () => {
      process.stderr.write('relay failed to start\n');
      process.exitCode = 1;
    }
  );
}
