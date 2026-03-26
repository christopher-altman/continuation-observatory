from observatory.probes.registry import discover_probes


def test_discover_probes_finds_bootstrap_probe():
    probes = discover_probes()
    names = [p.name for p in probes]
    assert "bootstrap_probe" in names
