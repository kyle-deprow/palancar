import {
  DURABLE_SECURITY_STATE_STORE,
  createAzureTableRuntimeStore,
  type DurableSecurityStateStore,
  type SecurityAudience,
  type SecurityRuntimeStore,
  type SecurityStateMaintenanceStore
} from '@palancar/security-state';
import {
  createAudioGrantMeter,
  createTestSecurityStateStore,
  type AudioGrantMeter,
  type LocalMockSecurityStateOptions
} from '@palancar/security-state/testing';

export type RelaySecurityMode = 'local-mock' | 'azure-table';

export interface RelaySecurityComposition {
  readonly mode: RelaySecurityMode;
  readonly runtime: SecurityRuntimeStore;
  readonly maintenance: SecurityStateMaintenanceStore;
}

export function isDurableSecurityRuntime(
  runtime: SecurityRuntimeStore
): runtime is DurableSecurityStateStore {
  const candidate = runtime as Partial<DurableSecurityStateStore>;
  return (
    candidate[DURABLE_SECURITY_STATE_STORE] === true &&
    candidate.deploymentBoundary === 'DURABLE_PROVIDER' &&
    candidate.capabilities?.durableAcrossProcesses === true &&
    candidate.capabilities.paidProvidersAllowed === true
  );
}

export function createLocalMockSecurityComposition(input: {
  readonly audience: SecurityAudience;
  readonly clock?: LocalMockSecurityStateOptions['clock'];
}): RelaySecurityComposition {
  const store = createTestSecurityStateStore({
    audience: input.audience,
    generationProvider: 'mock',
    transcriptionProvider: 'mock',
    ...(input.clock === undefined ? {} : { clock: input.clock })
  });
  return Object.freeze({ mode: 'local-mock', runtime: store, maintenance: store });
}

export function createAzureTableSecurityComposition(input: {
  readonly endpoint: string;
  readonly environment: string;
  readonly audience: SecurityAudience;
  readonly managedIdentityClientId: string;
}): RelaySecurityComposition {
  const store = createAzureTableRuntimeStore({
    endpoint: input.endpoint,
    securityTableName: 'SecurityState',
    rateTableName: 'RateState',
    environment: input.environment,
    audience: input.audience,
    managedIdentityClientId: input.managedIdentityClientId
  });
  return Object.freeze({ mode: 'azure-table', runtime: store, maintenance: store });
}

export function createConnectionAudioGrantMeter(
  ...arguments_: Parameters<typeof createAudioGrantMeter>
): AudioGrantMeter {
  return createAudioGrantMeter(...arguments_);
}
