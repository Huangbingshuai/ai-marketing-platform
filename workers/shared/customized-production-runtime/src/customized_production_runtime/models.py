from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field
Text = Annotated[str, Field(max_length=20000)]
Id = Annotated[str, Field(min_length=1, max_length=200)]
Short = Annotated[str, Field(max_length=200)]
Seconds = Annotated[float, Field(gt=0, le=3600)]
class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
class QueueMessage(Model):
    schemaVersion: Literal[1]
    projectId: str
    runId: str
    requestId: str
