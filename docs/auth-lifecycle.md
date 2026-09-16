# Auth lifecycle implementation evidence

## Supported credential SDK

Verified against installed and development dependency OpenClaw **2026.9.3**:

- Public `openclaw/plugin-sdk/infra-runtime` exports `writePrivateSecretFileAtomic({ rootDir, filePath, content, mode, dirMode })`.
- Public `openclaw/plugin-sdk/secret-file` exports `readSecretFile(path, label, { rejectSymlink, rejectHardlinks, maxBytes })`.
- `api.runtime.state.resolveStateDir()` supplies the supported state location.
- Runtime imports of both public storage exports were exercised. Their declaration files are `dist/plugin-sdk/infra-runtime.d.ts` and `dist/plugin-sdk/secret-file.d.ts` in that release.
- The writer uses `@openclaw/fs-safe` 0.8.5 private file primitives, including atomic replacement, root confinement and safe target validation. Its fallback fsync is best-effort; the adapter explicitly opens and flushes the file and directory ancestry and propagates failures before readback or ACK.

There is no invented `runtime.credentials` interface. `ProtectedStore` is a plugin-internal port implemented by `src/secret-store.ts`, not an SDK claim. Files/directories are owner-private (0600/0700). The reader rejects weakened permissions, foreign ownership, symlinks, hardlinks, nonregular files and oversized/corrupt records. Private-file exceptions are replaced with fixed errors. Construction performs no storage or network I/O during plugin introspection. Windows currently fails closed because the required POSIX privacy/directory-flush guarantee is unavailable in this adapter.

Permission protection does not provide encryption at rest or protection against the host owner/root. Automatic safe storage is supported within that explicit boundary; there is no plaintext config, environment-token or manual-paste fallback.

## Versioned contracts

The reviewed server dependency is `vauxr-ai/vauxr@16968a73b7610c917a9922d94d8c7ef187f7dda3`:

- [Integration v1](https://github.com/vauxr-ai/vauxr/blob/16968a73b7610c917a9922d94d8c7ef187f7dda3/docs/authz/integration-v1.md)
- [Enrollment v1](https://github.com/vauxr-ai/vauxr/blob/16968a73b7610c917a9922d94d8c7ef187f7dda3/docs/authz/enrollment-v1.md)
- [Lifecycle v1](https://github.com/vauxr-ai/vauxr/blob/16968a73b7610c917a9922d94d8c7ef187f7dda3/docs/authz/lifecycle-v1.md)

Checked-in fixture JSON is byte-for-byte from that snapshot. The integration test asserts the exact head and unchanged source/fixtures before importing the real server handlers. It uses a disposable loopback HTTP service, generated owner/device test identities and the production OpenClaw SDK protected-store adapter rooted in disposable test state. No real credentials, owner actions, installed extension or live gateway are used.

Setup persists random request identity/secret, selected HTTP/socket endpoints and the fixed deadline before requesting enrollment. Responses must match request, channel, origin, server identity and deadline. Owner matching codes are derived with the contract's SHA-256 domain and are never bearer credentials. One-time delivery is committed and reread before ACK. Even a readable record from an earlier failed fsync is recommitted and flushed before retrying ACK. Delivered-without-a-saved-credential is an explicit re-pair condition, never connected.

Lifecycle poll/deliver/ACK uses only the integration's own principal. Replacement, operation identity and old slot persist together before replacement-authenticated ACK. The saved operation retries after uncertainty. Completion promotes the replacement, retires old socket turns and reconnects. A queued operation that expires before delivery leaves existing authority usable. A consumed delivery lost before save requires re-pairing. Terminal revoked credentials are not silently revived.

## Verification boundaries

Tests cover real versioned request fields and server handler state transitions, client/server restart, owner denial, expiry, mismatched physical codes, missing proof, scoped grants/denials, lost ACK recovery, save failure before/after publication, private storage enforcement, redacted status/errors, certificate chain/name/expiry, redirect refusal, socket readiness/identity and replacement-authority isolation.

The real contract fixture exercises the shipped enrollment/integration/lifecycle HTTP handlers and policy/store classes. Its policy probe is a fixture endpoint, not a substitute for all live device/media routes. Separate real local socket tests exercise the plugin channel bridge, including certificate validation. Hardware long-press/audio confirmation, live owner UI operation, real channel activation, speech-provider roundtrips and firmware installation remain integration acceptance work. Reserved playback URL operations have no server endpoint and remain unavailable. No merge, deployment or OTA is part of this implementation.
