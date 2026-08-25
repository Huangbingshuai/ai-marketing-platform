import pytest
from pydantic import ValidationError

from effect_extraction.models import ExtractionRequest


def test_queue_message_accepts_ids_only() -> None:
    message = ExtractionRequest.model_validate(
        {
            "schemaVersion": 2,
            "runId": "run-1",
            "projectId": "project-1",
            "requestId": "request-1",
        }
    )
    assert set(message.model_dump(by_alias=True)) == {
        "schemaVersion",
        "runId",
        "projectId",
        "requestId",
    }
    with pytest.raises(ValidationError):
        ExtractionRequest.model_validate(
            {
                **message.model_dump(by_alias=True),
                "sourceFingerprint": "must-not-be-in-message",
            }
        )
