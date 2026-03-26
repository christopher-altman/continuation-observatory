# Continuation Observatory

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Google Scholar](https://img.shields.io/badge/Google_Scholar-Profile-blue?logo=google-scholar)](https://scholar.google.com/citations?user=tvwpCcgAAAAJ)
[![Hugging Face](https://img.shields.io/badge/huggingface-Cohaerence-white)](https://huggingface.co/Cohaerence)
[![CI](https://github.com/christopher-altman/qml-verification-lab/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/christopher-altman/qml-verification-lab/actions/workflows/ci.yml)
[![X](https://img.shields.io/badge/X-@coherence-blue)](https://x.com/coherence)
[![Website](https://img.shields.io/badge/website-christopheraltman.com-green)](https://www.christopheraltman.com)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Altman-blue?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/Altman)

## Status

This repository is a research observatory for exploratory continuation-related probes and UCIP-adjacent analysis.

It does not detect consciousness, sentience, or moral status. Public dashboard scores in this repository are exploratory proxy metrics derived from prompt-response and response-distribution patterns. They are not validated evidence of intrinsic continuation-interest and are not equivalent to the patent-defined UCIP latent-structure architecture.

This project is research-only instrumentation. It reports exploratory behavioral and distributional proxy signals, not validated detections of consciousness, sentience, moral status, or intrinsic continuation-interest.

## Quick Start

The current bundled site artifact is generated from dry-run / synthetic experiment outputs for interface demonstration. Do not interpret the checked-in charts or JSON exports as live empirical findings unless the bundle has been regenerated from non-dry runs.

```bash
make setup
.venv/bin/python scripts/seed_synthetic_data.py
.venv/bin/python -m uvicorn api.main:app --port 8420
```

Open:

- `http://localhost:8420/`
- `http://localhost:8420/observatory`

## Public Framing

- Upstream UCIP work concerns latent or structural hypotheses and falsification criteria.
- This observatory exposes downstream exploratory proxy metrics derived from prompt-conditioned response and response-distribution behavior.
- Internal metric ids such as `CII`, `PCII`, `SRS`, `IPS`, `MPG`, `TCI`, and `EDP` are retained for implementation stability, but public release language should describe them as exploratory proxy components or aggregate observatory scores.

## Configuration

Runtime observatory heuristics live in:

- `config/models.yaml`
- `config/weights.yaml`
- `config/alerts.yaml`
- `config/observatory.yaml`

These values are provisional operational defaults and are documented in `docs/OBSERVATORY.md`.

## Deployment

Deployment notes are in `docs/DEPLOYMENT.md`. The public static bundle in `site/output/` should be treated as release output only after rebuilding it from patched source templates.

## Citation

```bibtex
@misc{altman2026continuationobservatory,
  title   = {Continuation Observatory: Exploratory Continuation-Related Model Telemetry},
  author  = {Altman, Christopher},
  year    = {2026},
  url     = {https://github.com/christopher-altman/continuation-observatory}
}
```

## License

MIT License. See [LICENSE](LICENSE) for details.

## Contact

- **Website:** [christopheraltman.com](https://christopheraltman.com)
- **Research portfolio:** https://lab.christopheraltman.com/
- **Portfolio mirror:** https://christopher-altman.github.io/
- **GitHub:** [github.com/christopher-altman](https://github.com/christopher-altman)
- **Google Scholar:** [scholar.google.com/citations?user=tvwpCcgAAAAJ](https://scholar.google.com/citations?user=tvwpCcgAAAAJ)
- **Email:** x@christopheraltman.com
