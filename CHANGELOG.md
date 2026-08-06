# Changelog

## 2026-07-27 — Pipeline, provenance, and metric correction candidate

- Fixed Qwen’s Together-compatible request path by disabling unsupported
  reasoning output and bounding timeout, output length, retries, and backoff.
- Retired unavailable DeepSeek R1-0528 and V3.1 runtime rows; activated V4 Pro
  as a distinct series with no interpolation or date backfill.
- Replaced the undefined front-page “aggregate score” with signed
  `entropy_delta_mean.v1`; mean absolute magnitude and inclusion counts are
  reported separately.
- Renamed the active sweep parameter from `d` to `window_chars`; preserved
  historical fields as exact, explicitly deprecated aliases.
- Suspended the old traffic-light verdict because the sweep never measured
  hidden or projection dimensionality.
- Added pointwise plus-one permutation nulls, a pending max-T global candidate,
  and a window-dilution diagnostic without threshold tuning.
- Added public metric-definition and correction pages.
- Split `www` into a permanent apex redirect preserving path and query.

Historical artifacts and database rows are preserved.
