from __future__ import annotations
import json
import asyncio
from typing import Any
import pytest
from aio_pika.message import ProcessContext
from ai_runtime.http import InternalApiError
from customized_production_runtime import consumer


@pytest.mark.asyncio
async def test_requeued_message_is_not_acked_again_and_next_message_still_runs(monkeypatch: Any) -> None:
    class Message:
        def __init__(self) -> None:
            self.body=json.dumps({'schemaVersion':1,'projectId':'p','runId':'t','requestId':'r'}).encode()
            self.processed=False;self.acks=0;self.nacks=0;self.redelivered=False
        def process(self, **options: Any) -> ProcessContext:
            return ProcessContext(self,reject_on_redelivered=False,**options)  # type: ignore[arg-type]
        async def ack(self) -> None:
            assert not self.processed, 'message was processed twice'
            self.processed=True;self.acks+=1
        async def nack(self, *, requeue: bool) -> None:
            assert requeue and not self.processed
            self.processed=True;self.nacks+=1
    first,second=Message(),Message()
    class Messages:
        def __init__(self) -> None:
            self.values=iter([first,second])
        async def __aenter__(self) -> Messages:return self
        async def __aexit__(self,*args:Any) -> None:pass
        def __aiter__(self) -> Messages:return self
        async def __anext__(self) -> Message:
            try:return next(self.values)
            except StopIteration:raise StopAsyncIteration from None
    class Queue:
        def iterator(self) -> Messages:return Messages()
    class Connection:
        async def channel(self,**kwargs:Any) -> Connection:return self
        async def set_qos(self,**kwargs:Any) -> None:pass
        async def declare_queue(self,*args:Any,**kwargs:Any) -> Queue:return Queue()
        async def close(self) -> None:pass
    class Adapter:
        def __init__(self,*args:Any,**kwargs:Any) -> None:pass
        async def close(self) -> None:pass
    async def connect(*args:Any,**kwargs:Any) -> Connection:return Connection()
    calls=[]
    both_started = asyncio.Event()
    async def execute(*args:Any) -> None:
        calls.append(1)
        first_call = len(calls) == 1
        if len(calls) == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=1)
        if first_call:raise InternalApiError('temporary',retryable=True)
    async def no_sleep(*args:Any) -> None:pass
    monkeypatch.setattr(consumer,'required',lambda name:'controlled-test')
    monkeypatch.setattr(consumer,'Provider',Adapter)
    monkeypatch.setattr(consumer,'Api',Adapter)
    monkeypatch.setattr(consumer.aio_pika,'connect_robust',connect)
    monkeypatch.setattr(consumer,'execute',execute)
    monkeypatch.setattr(consumer.asyncio,'sleep',no_sleep)
    await consumer.consume('VIDEO')
    assert len(calls)==2 and first.nacks==1 and first.acks==0
    assert second.acks==1 and second.nacks==0
