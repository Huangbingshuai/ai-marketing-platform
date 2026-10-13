from typing import Annotated, Literal
from pydantic import Field
from .models import Model, Text, Id

Kind = Literal['PRODUCT', 'CHARACTER', 'SCENE', 'PROP']
FieldName = Literal['name', 'description', 'knownFacts', 'designNotes', 'sourceText', 'imageRequirements', 'preparation']
DETAIL_KEYS = {'PRODUCT': ('structure', 'material', 'markings'), 'CHARACTER': ('appearance', 'styling'),
               'SCENE': ('layout', 'lighting'), 'PROP': ('appearance', 'material')}

class Evidence(Model):
    source: Literal['BRIEF', 'SCRIPT']
    path: Id
    quote: Annotated[str, Field(min_length=1, max_length=20000)]
    field: Id

class Candidate(Model):
    key: Id
    existingId: str | None
    name: Id
    kind: Kind
    aliases: Annotated[list[Id], Field(max_length=30)]
    usage: Text
    treatment: Literal['INDEPENDENT', 'SCENE_DETAIL', 'CHARACTER_DETAIL']
    parentKey: str | None
    sources: Annotated[list[Evidence], Field(min_length=1, max_length=100)]

class Inventory(Model):
    objects: Annotated[list[Candidate], Field(min_length=1, max_length=1000)]

class Detail(Model):
    key: Literal['structure', 'material', 'markings', 'appearance', 'styling', 'layout', 'lighting']
    value: Text

class Question(Model):
    field: Id
    question: Text
    impact: Text

class ImageNeed(Model):
    name: Id
    purpose: Text
    requirements: Text

class Preparation(Model):
    aliases: list[Id]
    usage: Text
    treatment: Literal['INDEPENDENT', 'SCENE_DETAIL', 'CHARACTER_DETAIL']
    parentId: str | None
    sources: Annotated[list[Evidence], Field(min_length=1, max_length=100)]
    details: Annotated[list[Detail], Field(max_length=7)]
    questions: Annotated[list[Question], Field(max_length=100)]
    images: Annotated[list[ImageNeed], Field(max_length=30)]

class AssetDefinition(Model):
    id: Id
    kind: Kind
    name: Id
    description: Text
    knownFacts: Text
    designNotes: Text
    sourceText: Text
    imageRequirements: Text
    preparation: Preparation

class Definitions(Model):
    assets: Annotated[list[AssetDefinition], Field(min_length=1, max_length=1000)]

class Finding(Model):
    assetId: Id
    field: FieldName
    issue: Text
    basis: Text
    severity: Literal['REQUIRED', 'SUGGESTION']

class AssetAudit(Model):
    summary: Text
    findings: Annotated[list[Finding], Field(max_length=1000)]

class FieldPatch(Model):
    assetId: Id
    field: FieldName
    text: Text | None
    preparation: Preparation | None

class AssetRepair(Model):
    patches: Annotated[list[FieldPatch], Field(min_length=1, max_length=1000)]
