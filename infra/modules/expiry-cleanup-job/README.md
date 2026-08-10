# Later expiry-cleanup Job interface

The managed daily cleanup Job is deferred with the relay workload because it
requires the same immutable application image. A later workload apply must
accept the Container Apps environment, runtime identity, workload Table
endpoint, `SecurityState`/`RateState` names, and an immutable image digest. It
must run daily, use only the runtime identity, remove expired pairing,
credential, ticket, session, and rate-window rows, and retain revoked
installation tombstones for 30 days.

No placeholder image, Job resource, queue, blob, or Table entity is created by
this foundation. This file is an interface placeholder only.
