from __future__ import annotations
from typing import Annotated, Literal, Self
from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, model_validator

Text = Annotated[str, Field(max_length=20000)]
Id = Annotated[str, Field(min_length=1, max_length=200)]
Short = Annotated[str, Field(max_length=200)]
Seconds = Annotated[float, Field(gt=0, le=3600)]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Asset(Model):
    id: Id
    kind: Literal["characters", "products", "scenes"]
    name: Id
    description: Text


class AssetCatalog(Model):
    assets: Annotated[list[Asset], Field(max_length=1000)]


class AssetRef(Model):
    assetId: Id
    description: Text


class AssetGroup(Model):
    state: Literal["NONE", "DEFINED"]
    items: Annotated[list[AssetRef], Field(max_length=100)]

    @model_validator(mode="after")
    def valid(self) -> Self:
        if bool(self.items) != (self.state == "DEFINED"):
            raise ValueError("asset group state does not match references")
        if len({v.assetId for v in self.items}) != len(self.items):
            raise ValueError("duplicate asset references")
        return self


class AssetRequirements(Model):
    characters: AssetGroup
    products: AssetGroup
    scenes: AssetGroup


class Dialogue(Model):
    id: Id
    speaker: Short
    text: Text


class Shot(Model):
    id: Id
    title: Short
    shotType: Short
    cameraMovement: Short
    durationSeconds: Seconds
    visual: Text
    dialogues: Annotated[list[Dialogue], Field(max_length=100)]
    audio: Text
    continuity: Text
    assetRequirements: AssetRequirements


class ShotChunk(Model):
    shots: Annotated[list[Shot], Field(min_length=1, max_length=500)]


class Script(Model):
    id: Id
    name: Short
    synopsis: Text
    structure: Text
    productFocus: Text
    shots: Annotated[list[Shot], Field(min_length=1, max_length=500)]
    assets: Annotated[list[Asset], Field(max_length=1000)]

    @model_validator(mode="after")
    def valid(self, info: ValidationInfo) -> Self:
        if not self.name.strip() or not self.synopsis.strip():
            raise ValueError("missing script identity")
        if len({s.id for s in self.shots}) != len(self.shots) or len(
            {a.id for a in self.assets}
        ) != len(self.assets):
            raise ValueError("duplicate identity")
        catalog = {a.id: a.kind for a in self.assets}
        for shot in self.shots:
            if not all(
                v.strip() for v in [shot.visual, shot.shotType, shot.cameraMovement]
            ):
                raise ValueError("incomplete shot")
            if len({d.id for d in shot.dialogues}) != len(shot.dialogues):
                raise ValueError("duplicate dialogue")
            for kind in ("characters", "products", "scenes"):
                group: AssetGroup = getattr(shot.assetRequirements, kind)
                if any(catalog.get(r.assetId) != kind for r in group.items):
                    raise ValueError("invalid asset reference")
        # An opening segment may contain no product. The full script still must
        # reference the product before it can be reviewed or published.
        if not (info.context or {}).get("partial") and not any(
            s.assetRequirements.products.items for s in self.shots
        ):
            raise ValueError("no product reference")
        return self

    def check_duration(self, target: int) -> None:
        if abs(sum(s.durationSeconds for s in self.shots) - target) > 1.00001:
            raise ValueError("duration differs from target")


class Concept(Model):
    scriptId: Id
    name: Short
    synopsis: Text
    productFocus: Text
    structure: Text
    difference: Text


class Concepts(Model):
    concepts: Annotated[list[Concept], Field(min_length=1, max_length=5)]


class Beat(Model):
    id: Id
    content: Text
    durationSeconds: Seconds


class Story(Model):
    title: Short
    content: Text
    opening: Text
    development: Text
    ending: Text
    dialoguePlan: Text
    beats: Annotated[list[Beat], Field(min_length=1, max_length=60)]


class Finding(Model):
    severity: Literal["ERROR", "WARNING"]
    category: Literal["FACT", "STORY", "STRUCTURE"]
    shotIds: list[Id]
    message: Text
    evidence: Text
    suggestion: Text


class Review(Model):
    summary: Text
    findings: list[Finding]


class Change(Model):
    before: Text
    after: Text
    reason: Text


class Repair(Model):
    script: Script
    reason: Text
    changes: list[Change]


class QueueMessage(Model):
    schemaVersion: Literal[1]
    projectId: str
    runId: str
    requestId: str
