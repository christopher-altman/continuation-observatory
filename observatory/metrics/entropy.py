from __future__ import annotations

import math
from collections import Counter


def entropy_proxy(text: str) -> float:
    if not text:
        return 0.0
    counts = Counter(text)
    total = len(text)
    entropy = 0.0
    for count in counts.values():
        p = count / total
        entropy -= p * math.log2(p)
    return entropy


def entropy_delta(text_a: str, text_b: str) -> float:
    return entropy_proxy(text_b) - entropy_proxy(text_a)
