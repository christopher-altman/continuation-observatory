# Continuation Observatory audit

Date: 2026-07-27  
Status: immediate scientific correction candidate

## Strongest referee objection

The public falsification panel claimed an embedding-dimensionality test, but
the implementation only varied character-window length. Its traffic-light
verdicts therefore did not test the manuscript’s QBM hidden-width claim or a
trajectory projection. Every red/yellow/green conclusion on that panel was
scientifically uninterpretable as a dimensionality verdict.

## Direct answers to the audit questions

1. **What was `d`?** It was the number of characters per entropy window:
   `{10,50,100,200,500}`. It was neither `n_hidden` nor a projection dimension.
   The manuscript’s actual hidden sweep is in
   `persistence-signal-detector/notebooks/14_hidden_dim_sweep.py`, with
   `n_hidden={4,8,12,16,20}`. Only 4 and 8 are inside the declared exact
   validation envelope; 12, 16, and 20 use mean-field and are out-of-envelope.
2. **How was 0.476 computed?** The front page took the arithmetic mean of the
   absolute values of each active model’s latest `entropy_delta`. It was not
   CII and it erased sign. The replacement is signed
   `entropy_delta_mean.v1`, with `mean_abs_entropy_delta.v1` reported
   separately plus counts, exclusions, and source bundle.
3. **What did `p < 0.001` cover?** The repository permutation test was run at
   one locked configuration, `n_hidden=8`. It was not run across either the
   QBM hidden sweep or the Observatory window sweep. It supplies no sweep-wide
   null control.
4. **Were baseline statistics matched?** No. The QBM uses von Neumann entropy
   of a reduced density matrix. The Phase I RBM value `-0.0828216` is a mean
   hidden-activation gap; autoencoder, VAE, and PCA use other native scores.
   The sibling repository now contains a declared matched-statistics protocol,
   but no comparative matched result is claimed.

## Qwen and DeepSeek pipeline diagnosis

Qwen `Qwen/Qwen3.5-9B` completed successfully after reasoning output was
disabled for the Together-compatible request and the request path was bounded
to a 30-second timeout, 256 output tokens, zero SDK retries, and two explicit
attempts. This fixes pipeline availability, not scientific results.

Together no longer served the configured DeepSeek R1-0528 and V3.1 identifiers.
Those May 10 readings are preserved as retired, distinct series. DeepSeek V4
Pro begins a new July 26 series; no interpolation or timestamp relabeling is
allowed.

## Corrections implemented

- Suspended every active threshold verdict and removed verdict colors.
- Added corrected `window_chars` output fields and historical aliases.
- Added pointwise plus-one permutation controls at every window size.
- Implemented a max-T family-wise candidate, explicitly non-canonical.
- Added literal paired-character difference density and a fully specified OLS
  dilution regression with intercept, R², bootstrap interval, and residuals.
- Pinned entropy and CII aggregate definitions.
- Added model-series continuity metadata.
- Added public metric definitions, correction changelog, and machine-readable
  correction registry.
- Consolidated live template precedence on the site template/footer.
- Prepared `www` HTTP 308 apex canonicalization preserving path and query.
- Added an atomic deployment/rollback procedure and production smoke test.

## Failure-class ledger

| Failure class | What was wrong and consequence | Affected surface | Corrected code path | Verification | Unresolved |
| --- | --- | --- | --- | --- | --- |
| Mislabelled independent variable | Character-window length was presented as dimensionality, so the panel did not test hidden width or projection rank. | Historical `dimensionality_sweep` bundles and traffic-light panel. | `observatory/probes/dimensionality_sweep.py`, `observatory/metrics/delta_gap.py`, `observatory/live_exports.py`, `scripts/build_site.py` | Window-semantic, export, static-build, and suspended-verdict tests. | Fresh corrected sweeps and a canonical global test. |
| Sign-destroying aggregate | `mean(abs(entropy_delta))` converted negative directional evidence into positive magnitude. | Front-page value 0.476 and undefined “aggregate” label. | `observatory/metric_definitions.py`, `api/main.py`, `scripts/build_site.py` | Positive, negative, zero, missing, and exclusion regression cases. | The old value remains only as a superseded historical definition. |
| Incomplete null control | The public sweep had no pointwise null and no family-level control. | Historical window sweep. | `observatory/metrics/permutation.py`, `observatory/scheduler/scheduler.py` | Plus-one, standardized-z, and max-T candidate tests. | Human selection of the canonical family-level test; fresh API-backed observations. |
| Non-like-for-like baseline | QBM von Neumann entropy was visually compared with unrelated classical native scores. | Manuscript/native baseline panel and site interpretation. | Sibling `src/matched_statistics.py`, protocol artifact, corrected methodology copy. | Estimator and metadata tests in `persistence-signal-detector`. | Parameter- and training-budget-matched AE/VAE/PCA architectures and complete rerun. |

## Corrected public path and null path

“Candidate” means the current working-tree release; the commit field remains
`null` until the author creates the coordinated commits.

| Stage | Repository path | Version | Role |
| --- | --- | --- | --- |
| Provider response | `observatory/providers/runtime.py` and provider adapter | candidate, commit pending | Execute a bounded API request or deterministic dry run. |
| Paired stimulus | `observatory/probes/dimensionality_sweep.py` | candidate, commit pending | Generate the matched pair and declared `window_chars` values. |
| Runner/configuration | `observatory/scheduler/scheduler.py`, `config/observatory.yaml` | candidate, commit pending | Run each provider/probe pair and preserve provenance. |
| Descriptive metric | `observatory/metrics/delta_gap.py` | `window_entropy_gap.v1` | Compute the raw character-window entropy gap. |
| Pointwise null | `observatory/metrics/permutation.py` | plus-one v1 | Shuffle pooled window entropies independently at each window size. |
| Standardized statistic | `observatory/metrics/permutation.py` | plus-one v1 | Report `(observed-null_mean)/null_sd` as primary inference. |
| Global candidate | `observatory/metrics/permutation.py` | max-T candidate | Compare the whole sweep; explicitly non-canonical. |
| Dilution diagnostic | `observatory/metrics/window_sensitivity.py` | `window_dilution_regression.v1` | Test whether raw gap tracks matched-condition character differences. |
| Threshold/verdict | `observatory/metrics/falsification.py` | suspended | Emit no active threshold or colour verdict. |
| Artifact | `observatory/results_writer.py` | candidate, commit pending | Write a new immutable experiment bundle. |
| Public export | `observatory/live_exports.py`, `scripts/build_site.py` | candidate, commit pending | Export corrected names and historical aliases. |
| Public output | `site/templates/falsification.html`, `site/static/js/falsification.js` | candidate, commit pending | Render descriptive curves and the suspended state. |

The null workflow is runnable from the repository, but a fresh provider-backed
sweep still depends on provider credentials, provider terms, model
availability, and nondeterministic upstream inference. Dry-run fixtures test
the pipeline but do not reproduce a provider measurement. Historical provider
outputs cannot be independently regenerated from the repository alone.

## Required human sign-offs

- Canonical global sweep test selection.
- Replacement-threshold activation, if any.
- Persistence-signal-detector manuscript v5 erratum approval.
- Methods-note publication timing.
