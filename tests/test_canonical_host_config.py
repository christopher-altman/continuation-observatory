from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_www_is_a_dedicated_permanent_apex_redirect():
    caddyfile = (ROOT / "deploy" / "Caddyfile.example").read_text()
    www_block, apex_block = caddyfile.split(
        "\ncontinuationobservatory.org {",
        maxsplit=1,
    )
    assert "www.continuationobservatory.org {" in www_block
    assert "redir https://continuationobservatory.org{uri} 308" in www_block
    assert "reverse_proxy" not in www_block
    assert "reverse_proxy 127.0.0.1:8420" in apex_block


def test_smoke_test_preserves_path_and_query():
    script = (ROOT / "deploy" / "smoke_test.sh").read_text()
    assert "$www/models?canonical-smoke=1" in script
    assert "308" in script
    assert "continuationobservatory\\.org/models" in script
