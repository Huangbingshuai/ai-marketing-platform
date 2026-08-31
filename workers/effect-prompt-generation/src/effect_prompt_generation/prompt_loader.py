from __future__ import annotations

import hashlib
import re
from functools import lru_cache
from importlib.resources import files


_VARIABLE = re.compile(r"\{([a-z][a-z0-9_]*)\}")


@lru_cache(maxsize=16)
def load_prompt(name: str) -> str:
    if "/" in name or "\\" in name or not name.endswith(".prompt.txt"):
        raise ValueError("invalid prompt template name")
    return (
        files("effect_prompt_generation.prompts")
        .joinpath(name)
        .read_text(encoding="utf-8")
    )


def load_prompt_hash(name: str) -> str:
    return hashlib.sha256(load_prompt(name).encode("utf-8")).hexdigest()


def render_prompt(name: str, **values: str) -> str:
    template = load_prompt(name)
    required = set(_VARIABLE.findall(template))
    missing = sorted(required.difference(values))
    if missing:
        raise ValueError(f"missing prompt template variable: {missing[0]}")
    return _VARIABLE.sub(lambda match: values[match.group(1)], template)
