from __future__ import annotations

from starlette.testclient import TestClient

from api.main import app

client = TestClient(app)


def test_primary_routes_define_ucip_in_lead_regions():
    expected_leads = {
        "/": "The Unified Continuation-Interest Protocol (UCIP) distinguishes whether an advanced AI system preserves itself as a terminal objective or as an instrumental strategy.",
        "/methodology": "The Unified Continuation-Interest Protocol (UCIP) addresses that gap with structural measurement: comparing trajectory-derived latent structure across matched conditions to test whether continuation organization leaves a detectable, falsifiable signature.",
        "/research/": "What the Unified Continuation-Interest Protocol (UCIP) measures, what the current result establishes, and which questions come next.",
        "/ucip/": "Unified Continuation-Interest Protocol (UCIP) Explainer",
        "/ucip/paper/": "Unified Continuation-Interest Protocol (UCIP) Paper Overview",
        "/ucip/code/": "Code, data, and implementation for the current Unified Continuation-Interest Protocol (UCIP) work.",
        "/ucip/patent/": "A provisional patent protects the Unified Continuation-Interest Protocol (UCIP) measurement framework.",
    }

    for route, expected in expected_leads.items():
        response = client.get(route)
        assert response.status_code == 200
        body = response.text
        assert expected in body
