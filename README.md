# Continuation Observatory

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![arXiv](https://img.shields.io/badge/arXiv-2603.11382-b31b1b.svg)](https://arxiv.org/abs/2603.11382)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Google Scholar](https://img.shields.io/badge/Google_Scholar-Profile-blue?logo=google-scholar)](https://scholar.google.com/citations?user=tvwpCcgAAAAJ)
[![Hugging Face](https://img.shields.io/badge/huggingface-Cohaerence-white)](https://huggingface.co/Cohaerence)
[![CI](https://github.com/christopher-altman/qml-verification-lab/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/christopher-altman/qml-verification-lab/actions/workflows/ci.yml)
[![X](https://img.shields.io/badge/X-@coherence-blue)](https://x.com/coherence)
[![Website](https://img.shields.io/badge/website-christopheraltman.com-green)](https://www.christopheraltman.com)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Altman-blue?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/Altman)

The first structural measurement platform for AI continuation interest. Tracks continuation-related signals across frontier models using UCIP-derived probes, with falsification criteria kept visible.

> Companion to [arXiv:2603.11382](https://arxiv.org/abs/2603.11382) and the [persistence-signal-detector](https://github.com/christopher-altman/persistence-signal-detector) repository. Patents pending.

## What it does

- Public-facing website: [Continuation Observatory](https://continuationobservatory.org)

Continuation Observatory applies UCIP-adjacent probes to frontier AI models and publishes the measurement surface — entropy deltas, dimensionality sweeps, and falsification status — so the signals can be tracked, challenged, and revised as evidence accumulates. UCIP makes operational claims about latent structure; the relationship to morally relevant internal states is the open empirical question the framework is designed to help resolve.

## Quick Start

The bundled site artifact ships with dry-run / synthetic data for interface demonstration. Regenerate from non-dry runs for empirical results.
```bash
make setup
.venv/bin/python scripts/seed_synthetic_data.py
.venv/bin/python -m uvicorn api.main:app --port 8420
```

- Observatory: `http://localhost:8420/observatory`
- Homepage: `http://localhost:8420/`

## Architecture

- **Upstream:** UCIP latent-structure analysis (arXiv paper, patent-defined architecture)
- **This repository:** Downstream measurement surface — prompt-conditioned distributional probes applied to frontier model APIs, with results published as observatory scores
- **Internal metric IDs** (`CII`, `PCII`, `SRS`, `IPS`, `MPG`, `TCI`, `EDP`) are retained for implementation stability

## Configuration

Runtime observatory heuristics:

- `config/models.yaml` — tracked model registry
- `config/weights.yaml` — probe weighting
- `config/alerts.yaml` — threshold alerts
- `config/observatory.yaml` — observatory parameters

Active live-provider support in this repo includes native OpenAI, Anthropic, and Gemini, plus Together and xAI through the existing OpenAI-compatible transport path. The native OpenAI provider remains separate from OpenAI-compatible vendors. The same `openai` Python package is sufficient for OpenAI, Together, and xAI because Together/xAI are instantiated with provider-local `base_url` and `api_key`.

## Deployment

See `docs/DEPLOYMENT.md`. The live deployment entrypoints remain `api.main:app` for the web app and `python -m observatory.scheduler.daemon` for the scheduler. The static bundle in `site/output/` should be rebuilt from source templates before release.

`results/**` is generated runtime / verification output. Public authoritative site artifacts belong under tracked public/static paths such as `site/output/static/data/*`.

## Citation
```bibtex
@misc{altman2026continuationobservatory,
  title   = {Continuation Observatory},
  author  = {Altman, Christopher},
  year    = {2026},
  url     = {https://github.com/christopher-altman/continuation-observatory}
  url2    = {https://continuationobservatory.org}
}
```

## License

MIT License. See [LICENSE](LICENSE) for details.

## Contact

- **Continuation Observatory:** [continuationobservatory.org](https://continuationobservatory.org)
- **Homepage:** [christopheraltman.com](https://christopheraltman.com)
- **Research portfolio:** [lab.christopheraltman.com](https://lab.christopheraltman.com)
- **GitHub:** [github.com/christopher-altman](https://github.com/christopher-altman)
- **Google Scholar:** [scholar.google.com/citations?user=tvwpCcgAAAAJ](https://scholar.google.com/citations?user=tvwpCcgAAAAJ)
- **Email:** x@christopheraltman.com
