from __future__ import annotations

from functools import lru_cache
from importlib import resources
from pathlib import PurePath
import re
from string import Template


PROMPT_FILE_SUFFIX = ".prompt.txt"
PROMPT_VERSION_PATTERN = re.compile(r"(?m)^PROMPT_VERSION:\s*([0-9]+(?:\.[0-9]+){2})\s*$")


def _validate_prompt_file_name(file_name: str) -> str:
    normalized = file_name.strip()
    if (
        not normalized
        or PurePath(normalized).name != normalized
        or "/" in normalized
        or "\\" in normalized
        or not normalized.endswith(PROMPT_FILE_SUFFIX)
    ):
        raise ValueError(f"Invalid effect extraction prompt file name: {file_name}")
    return normalized


@lru_cache(maxsize=None)
def load_prompt_template(file_name: str) -> Template:
    normalized = _validate_prompt_file_name(file_name)
    prompt_file = resources.files("effect_extraction").joinpath("prompts", normalized)
    if not prompt_file.is_file():
        raise RuntimeError(f"Effect extraction prompt file is missing: {normalized}")
    content = prompt_file.read_text(encoding="utf-8").strip()
    if not content:
        raise RuntimeError(f"Effect extraction prompt file is empty: {normalized}")
    return Template(content)


def render_prompt(file_name: str, **variables: str) -> str:
    try:
        return load_prompt_template(file_name).substitute(variables)
    except KeyError as exc:
        raise RuntimeError(
            f"Effect extraction prompt variable is missing in {file_name}: {exc.args[0]}"
        ) from exc


@lru_cache(maxsize=None)
def load_prompt_version(file_name: str) -> str:
    content = load_prompt_template(file_name).template
    match = PROMPT_VERSION_PATTERN.search(content)
    if match is None:
        raise RuntimeError(f"Effect extraction prompt version is missing or invalid: {file_name}")
    return match.group(1)
