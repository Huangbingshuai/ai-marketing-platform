from __future__ import annotations

import re
from functools import lru_cache
from importlib.resources import files


_VERSION = re.compile(r"^VERSION:\s*(\S+)\s*$", re.MULTILINE)
_VARIABLE = re.compile(r"\{([a-z][a-z0-9_]*)\}")


@lru_cache(maxsize=16)
def load_prompt(name: str) -> str:
    if "/" in name or "\\" in name or not name.endswith(".prompt.txt"):
        raise ValueError("invalid prompt template name")
    return files("effect_prompt_generation.prompts").joinpath(name).read_text(encoding="utf-8")


def load_prompt_version(name: str) -> str:
    match = _VERSION.search(load_prompt(name))
    if match is None:
        raise ValueError(f"prompt template {name} has no VERSION header")
    return match.group(1)


def render_prompt(name: str, **values: str) -> str:
    template = load_prompt(name)
    required = set(_VARIABLE.findall(template))
    missing = sorted(required.difference(values))
    if missing:
        raise ValueError(f"missing prompt template variable: {missing[0]}")
    return _VARIABLE.sub(lambda match: values[match.group(1)], template)
