# Continuation Observatory metric definitions

The machine-readable registry is generated at
`/metric-definitions.json` and `site/output/static/data/metric_definitions.json`
from `observatory/metric_definitions.py`.

## `entropy_delta_mean.v1`

Signed arithmetic mean of each active model’s latest valid
`entropy_delta = H(B)-H(A)`. Null, non-numeric, and non-finite values are
excluded. Every public summary reports total count, valid count, excluded count
with reasons, and source-bundle identifier.

## `mean_abs_entropy_delta.v1`

Arithmetic mean of `abs(entropy_delta)` over exactly the same included rows.
This is magnitude context, not the headline signed statistic. The historical
front-page value `0.476` used this definition without naming it.

## `cii_mean.v1`

Arithmetic mean of valid model-level Composite Interest Index readings in the
selected telemetry window. It is distinct from both entropy summaries and is
never labeled merely “aggregate score.” The historical MPG component is
unavailable because it was derived from the mislabeled character-window sweep;
CII renormalizes over the remaining available components.

## `window_entropy_gap.v1`

Split each response into consecutive non-empty character windows of
`window_chars`; pair windows by position through the shorter response; report
the mean absolute difference in character-frequency Shannon entropy, in bits.

`window_chars` is not QBM hidden width and not a trajectory-projection rank.
Historical `delta_gap_d{N}` values are retained as exact aliases where
`d = window_chars`.

## Null controls

`window_entropy_gap_pointwise_p.v1` independently permutes pooled window
entropies at each window size and reports

\[
p=(1+\#\{T^\ast\ge T_\mathrm{obs}\})/(1+B).
\]

`window_entropy_gap_maxT_z_p.v1` takes the maximum standardized null gap over
the declared window sweep and is an implemented family-wise candidate. It is
not canonical until a human selects the global sweep test. No replacement
threshold is active.

## `relevant_char_fraction.v1`

Within each paired response window, compare characters position by position.
Characters beyond the end of the shorter window count as differences. Report
the number of differing characters divided by the number of compared
positions. This literal estimator does not use keywords, embeddings, or a
learned relevance classifier.

## `window_dilution_regression.v1`

Across paired-window observations, fit unweighted ordinary least squares:

\[
\mathrm{window\_entropy\_gap}
=\alpha+\beta\,\mathrm{relevant\_char\_fraction}+\epsilon.
\]

Report slope, intercept, R², a nonparametric paired-window bootstrap interval
for the slope, per-model residuals, and estimator metadata. This is diagnostic
only and does not tune or activate a verdict threshold.
