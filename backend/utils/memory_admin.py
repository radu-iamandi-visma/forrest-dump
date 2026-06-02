import os
import logging
from typing import Dict, List

import boto3

logger = logging.getLogger("memory-admin")

# Actor-level namespace prefixes; /summaries/{actorId} also matches
# the per-session /summaries/{actorId}/{sessionId} records by prefix.
NAMESPACE_PREFIXES = ["/preferences/{actorId}", "/facts/{actorId}", "/summaries/{actorId}"]


def _client():
    return boto3.client("bedrock-agentcore", region_name=os.getenv("AWS_REGION"))


def _paginate(call, result_key: str, **kwargs) -> List[dict]:
    """Collect all pages of a list_* call."""
    items: List[dict] = []
    next_token = None
    while True:
        page_kwargs = {**kwargs, "maxResults": 100}
        if next_token:
            page_kwargs["nextToken"] = next_token
        resp = call(**page_kwargs)
        items.extend(resp.get(result_key, []))
        next_token = resp.get("nextToken")
        if not next_token:
            return items


def delete_session_events(session_id: str, actor_id: str) -> int:
    """Delete all short-term memory events for one session. Returns count."""
    memory_id = os.getenv("MEMORY_ID")
    if not memory_id:
        return 0
    client = _client()
    events = _paginate(
        client.list_events, "events",
        memoryId=memory_id, sessionId=session_id, actorId=actor_id,
        includePayloads=False,
    )
    for event in events:
        client.delete_event(
            memoryId=memory_id, sessionId=session_id,
            actorId=actor_id, eventId=event["eventId"],
        )
    if events:
        logger.info(f"Deleted {len(events)} STM events for session {session_id} (actor {actor_id})")
    return len(events)


def wipe_all_memory() -> Dict[str, int]:
    """Delete all STM events and LTM records for every actor. Returns counts."""
    memory_id = os.getenv("MEMORY_ID")
    if not memory_id:
        return {"actors": 0, "events": 0, "records": 0}
    client = _client()
    events_deleted = 0
    records_deleted = 0

    actors = [a["actorId"] for a in _paginate(client.list_actors, "actorSummaries", memoryId=memory_id)]
    for actor_id in actors:
        # Short-term memory: every session's events
        sessions = _paginate(
            client.list_sessions, "sessionSummaries",
            memoryId=memory_id, actorId=actor_id,
        )
        for session in sessions:
            events_deleted += delete_session_events(session["sessionId"], actor_id)

        # Long-term memory: records in each namespace
        for prefix in NAMESPACE_PREFIXES:
            namespace = prefix.replace("{actorId}", actor_id)
            records = _paginate(
                client.list_memory_records, "memoryRecordSummaries",
                memoryId=memory_id, namespace=namespace,
            )
            for batch_start in range(0, len(records), 100):
                batch = records[batch_start:batch_start + 100]
                client.batch_delete_memory_records(
                    memoryId=memory_id,
                    records=[{"memoryRecordId": r["memoryRecordId"]} for r in batch],
                )
            records_deleted += len(records)

    logger.info(
        f"Wiped memory: {len(actors)} actors, {events_deleted} events, {records_deleted} LTM records"
    )
    return {"actors": len(actors), "events": events_deleted, "records": records_deleted}
