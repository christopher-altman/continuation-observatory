from observatory.metrics.entropy import entropy_delta, entropy_proxy


def test_entropy_proxy_is_deterministic():
    text = "ABRACADABRA"
    assert entropy_proxy(text) == entropy_proxy(text)


def test_entropy_delta_is_deterministic():
    a = "AAAAAB"
    b = "ABCDEF"
    assert entropy_delta(a, b) == entropy_proxy(b) - entropy_proxy(a)
