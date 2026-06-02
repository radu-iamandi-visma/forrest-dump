import json
import logging
import time
from typing import AsyncIterator
from tools.types import SubAgentResult

logger = logging.getLogger("forest-watch")


def _fmt_elapsed(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"


async def parse_agent_events(agent_stream: AsyncIterator) -> AsyncIterator[str]:
    """Parse agent streaming events and yield formatted JSON strings.

    Also emits structured progress logs to stdout so you can see what the agent
    is doing live in `docker compose up` output.
    """
    emitted_tools = set()
    emitted_sub_tools = set()
    pending_tool_starts: dict[str, float] = {}
    pending_sub_tool_starts: dict[str, float] = {}
    text_chars = 0
    step = 0
    started_at = time.monotonic()
    result = None

    def progress(symbol: str, msg: str) -> None:
        nonlocal step
        step += 1
        elapsed = _fmt_elapsed(time.monotonic() - started_at)
        logger.info(f"{symbol} [step {step:>2} | {elapsed}] {msg}")

    progress("▶", "agent_stream_started")

    try:
        async for event in agent_stream:
            if "event" in event and isinstance(event["event"], dict):
                inner_event = event["event"]

                if "contentBlockDelta" in inner_event:
                    delta = inner_event["contentBlockDelta"].get("delta", {})
                    if "text" in delta:
                        text_chars += len(delta["text"])
                        yield json.dumps({
                            "type": "text",
                            "content": delta["text"]
                        }) + "\n"

                if "contentBlockStart" in inner_event:
                    start = inner_event["contentBlockStart"].get("start", {})
                    if "toolUse" in start:
                        tool_use = start["toolUse"]
                        tool_id = tool_use.get("toolUseId")
                        tool_name = tool_use.get("name")

                        if tool_id and tool_id not in emitted_tools:
                            emitted_tools.add(tool_id)
                            pending_tool_starts[tool_id] = time.monotonic()
                            progress("│", f"tool_start name={tool_name}")
                            yield json.dumps({
                                "type": "tool_start",
                                "name": tool_name,
                                "toolUseId": tool_id
                            }) + "\n"

                if "metadata" in inner_event:
                    usage = inner_event["metadata"].get("usage")
                    if usage:
                        yield json.dumps({
                            "type": "usage",
                            "inputTokens": usage.get("inputTokens", 0),
                            "outputTokens": usage.get("outputTokens", 0),
                            "totalTokens": usage.get("totalTokens", 0),
                        }) + "\n"

            if "message" in event:
                message = event["message"]
                if message.get("role") == "assistant" and "content" in message:
                    for content_block in message["content"]:
                        if "toolUse" in content_block:
                            tool_use = content_block["toolUse"]
                            tool_id = tool_use.get("toolUseId")
                            tool_name = tool_use.get("name")
                            tool_input = tool_use.get("input", {})

                            t0 = pending_tool_starts.pop(tool_id, None)
                            dur = f" duration={time.monotonic() - t0:.1f}s" if t0 else ""
                            progress("│", f"tool_done name={tool_name}{dur}")
                            yield json.dumps({
                                "type": "tool",
                                "name": tool_name,
                                "toolUseId": tool_id,
                                "input": tool_input
                            }) + "\n"

            if "tool_stream_event" in event:
                tool_stream = event["tool_stream_event"]
                data = tool_stream.get("data")

                if isinstance(data, SubAgentResult):
                    sub_event = data.event
                    agent_name = data.agent.name

                    if "event" in sub_event and isinstance(sub_event["event"], dict):
                        sub_inner = sub_event["event"]
                        if "contentBlockDelta" in sub_inner:
                            delta = sub_inner["contentBlockDelta"].get("delta", {})
                            if "text" in delta:
                                yield json.dumps({
                                    "type": "sub_text",
                                    "agent": agent_name,
                                    "content": delta["text"]
                                }) + "\n"

                        if "metadata" in sub_inner:
                            usage = sub_inner["metadata"].get("usage")
                            if usage:
                                yield json.dumps({
                                    "type": "usage",
                                    "agent": agent_name,
                                    "inputTokens": usage.get("inputTokens", 0),
                                    "outputTokens": usage.get("outputTokens", 0),
                                    "totalTokens": usage.get("totalTokens", 0),
                                }) + "\n"

                    if "message" in sub_event:
                        message = sub_event["message"]
                        if message.get("role") == "assistant" and "content" in message:
                            for content_block in message["content"]:
                                if "toolUse" in content_block:
                                    tool_use = content_block["toolUse"]
                                    tool_id = tool_use.get("toolUseId")
                                    tool_name = tool_use.get("name")
                                    tool_input = tool_use.get("input", {})

                                    if tool_id and tool_id not in emitted_sub_tools:
                                        emitted_sub_tools.add(tool_id)
                                        pending_sub_tool_starts[tool_id] = time.monotonic()
                                        progress("│ ↳", f"sub_tool_start agent='{agent_name}' name={tool_name}")
                                        yield json.dumps({
                                            "type": "sub_tool",
                                            "agent": agent_name,
                                            "name": tool_name,
                                            "toolUseId": tool_id,
                                            "input": tool_input
                                        }) + "\n"

            if "result" in event:
                result = event["result"]

        # Handle result - check for interrupts
        if result:
            if hasattr(result, "stop_reason") and result.stop_reason == "interrupt":
                # Emit interrupt events for frontend to display confirmation UI
                for interrupt in result.interrupts:
                    progress("│", f"interrupt id={interrupt.id} name={interrupt.name}")
                    yield json.dumps({
                        "type": "interrupt",
                        "interrupt_id": interrupt.id,
                        "name": interrupt.name,
                        "reason": interrupt.reason,
                    }) + "\n"
            else:
                progress("■", f"agent_done text_chars={text_chars} tools_called={len(emitted_tools)} sub_tools={len(emitted_sub_tools)}")
                yield json.dumps({"type": "result", "response": str(result)}) + "\n"
        else:
            progress("■", "agent_done (no result)")

    except Exception as e:
        progress("✗", f"error: {e}")
        yield json.dumps({"type": "error", "error": str(e)}) + "\n"
