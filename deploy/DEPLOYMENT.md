# Production deployment

## Canonical source

The production application source is `/opt/continuation-observatory/app` on
the VPS. The canonical public origin is
`https://continuationobservatory.org`. `www.continuationobservatory.org` must
return HTTP 308 to the same apex path and query.

## Atomic release procedure

1. Build and test the complete local correction bundle.
2. Copy the candidate to a timestamped release directory.
3. Preserve `/opt/continuation-observatory/data` and the active environment
   file; never package `.env*`, private keys, `.git`, `.roam`, databases, or
   local captures.
4. Validate Python imports, Caddy syntax, generated static output, and service
   definitions in the candidate.
5. Point the application symlink at the candidate, reload Caddy, restart the
   API/web/scheduler units, and run `deploy/smoke_test.sh`.

Rollback re-points the application symlink to the prior timestamped release,
reloads Caddy, restarts all three units, and reruns the same smoke test. Database
rollback is not part of an application rollback; this correction adds no schema
migration and preserves historical rows.
