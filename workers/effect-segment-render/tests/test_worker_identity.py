from importlib.metadata import distribution
from pathlib import Path
import tomllib


WORKER_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = WORKER_ROOT.parents[1]


def test_worker_identity_matches_effect_node_convention() -> None:
    config = tomllib.loads((WORKER_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert WORKER_ROOT.name == "effect-segment-render"
    assert config["project"]["name"] == "effect-segment-render-worker"
    assert config["project"]["scripts"] == {
        "effect-segment-render-worker": "effect_segment_render.main:main"
    }
    assert config["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == [
        "src/effect_segment_render"
    ]
    entry_points = distribution("effect-segment-render-worker").entry_points
    entry_point = next(entry for entry in entry_points if entry.name == "effect-segment-render-worker")
    assert entry_point.load().__module__ == "effect_segment_render.main"


def test_compose_and_container_entry_use_the_same_worker_identity() -> None:
    compose = (REPOSITORY_ROOT / "compose.yaml").read_text(encoding="utf-8")
    assert "\n  effect-segment-render-worker:\n" in compose
    assert "\n  seedance-worker:\n" not in compose
    assert "context: ./workers/effect-segment-render\n" in compose
    assert 'CMD ["/app/.venv/bin/effect-segment-render-worker"]' in (
        WORKER_ROOT / "Dockerfile"
    ).read_text(encoding="utf-8")
