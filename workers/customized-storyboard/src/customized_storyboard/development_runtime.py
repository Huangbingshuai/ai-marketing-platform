"""Durable structural validation shared by short creative development strategies."""
from __future__ import annotations
from typing import Any, Callable, TypeVar, TYPE_CHECKING
from .models import Model
if TYPE_CHECKING:
    from .pipeline import Pipeline

T = TypeVar('T', bound=Model)


async def checked_model(p: Pipeline, node: str, key: str, schema: type[T], context: dict[str, Any],
                        instruction: str, partial: dict[str, Any], validate: Callable[[T], None], *, detail: bool = False) -> T:
    """Persist returned business data before validation; one mechanical correction across retries."""
    record = partial.get(key, {})
    await p.step(node, '', 'RUNNING', partial)
    result = schema.model_validate(record['value']) if 'value' in record else await p.model(node, schema, context, instruction, detail=detail)
    partial[key] = {**record, 'value': result.model_dump()}
    await p.step(node, '', 'RUNNING', partial)
    try:
        validate(result)
    except ValueError as error:
        if record.get('corrected'):
            raise ValueError('commerce structural correction exhausted') from error
        result = await p.model(node, schema, {**context, 'previousResult': result.model_dump(), 'validationCode': str(error)},
            instruction + '\n只修正所列身份/引用/数量结构，保留实质评估，不把拒绝变通过，不补造事实。', detail=detail)
        partial[key] = {'value': result.model_dump(), 'corrected': True}
        await p.step(node, '', 'RUNNING', partial)
        validate(result)
    return result
