import os
import logging
from typing import Optional
from dotenv import load_dotenv

# Load environment variables BEFORE importing tools (they read env vars at import time)
load_dotenv()

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.tools.mcp import MCPClient
from strands_tools import current_time
from mcp.client.streamable_http import streamablehttp_client
from bedrock_agentcore.memory.integrations.strands.config import (
    AgentCoreMemoryConfig,
    RetrievalConfig,
)
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager,
)
from tools.camera_tools import query_camera, get_video
from tools.approval_hooks import HeaterApprovalHook
from sub_agents.temperature_agent import temperature_agent
from streaming import parse_agent_events
from utils import get_user_id

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("workshop-agent")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SYSTEM_PROMPT = """# Instructions
You are a helpful smart home agent.
You have access to several tools that help you answer a home owner's questions regarding their house.
The house is located in North-Pole, Northern Sweden.

# Rules
- Always respond concisely and use your tools when appropriate.
- All responses should be markdown formatted, with images and urls properly formatted.
- Always use timestamps in UTC


"""

# Bedrock models are only available in specific regions - us-east-1 is used for this workshop
model = BedrockModel(
    model_id=os.getenv(
        "AGENT_MODEL_ID", "anthropic.claude-haiku-4-5-20251001-v1:0"
    ),
    max_tokens=4000,
    region_name="us-east-1",
)

def create_session_manager(
    session_id: str, actor_id: str
) -> AgentCoreMemorySessionManager | None:
    """Create a session manager for AgentCore Memory."""
    memory_id = os.getenv("MEMORY_ID")
    if not memory_id:
        logger.warning("MEMORY_ID not set - running without memory")
        return None

    config = AgentCoreMemoryConfig(
        memory_id=memory_id,
        session_id=session_id,
        actor_id=actor_id,
        retrieval_config={
            "/preferences/{actorId}": RetrievalConfig(top_k=5, relevance_score=0.5),
            "/facts/{actorId}": RetrievalConfig(top_k=10, relevance_score=0.3),
            "/summaries/{actorId}": RetrievalConfig(top_k=3, relevance_score=0.5),
        },
    )

    return AgentCoreMemorySessionManager(
        agentcore_memory_config=config,
        region_name=os.getenv("AWS_REGION"),
    )


def get_or_create_agent(session_id: str, user_id: str) -> Agent:
    """Create an agent for the given session/user with AgentCore Memory."""
    logger.info(f"Creating agent for session={session_id} actor={user_id}")
    session_manager = create_session_manager(session_id, user_id)

    tools = [
        current_time,
        query_camera,
        temperature_agent,
        get_video,
    ]

    mcp_url = os.getenv("MCP_SERVER_URL")
    if mcp_url:
        mcp_client = MCPClient(lambda: streamablehttp_client(mcp_url))
        tools.append(mcp_client)
    else:
        logger.warning("MCP_SERVER_URL not set - heater tools unavailable")

    return Agent(
        name="Workshop Smart Home Agent",
        model=model,
        system_prompt=SYSTEM_PROMPT,
        tools=tools,
        hooks=[HeaterApprovalHook()],
        callback_handler=None,
        session_manager=session_manager,
        trace_attributes={
            "session.id": session_id,
            "user.id": user_id,
        },
    )


class InvocationRequest(BaseModel):
    prompt: Optional[str] = None


@app.get("/ping")
def health_check():
    """Health check endpoint"""
    return {"status": "healthy"}


@app.post("/invocations")
async def invocations(payload: InvocationRequest, request: Request):
    """Main agent invocation endpoint with streaming"""
    # Get session and user from headers
    session_id = request.headers.get(
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id", "unknown"
    )
    user_id = get_user_id(request.headers.get("Authorization", ""))

    interrupt_id = request.headers.get(
        "X-Amzn-Bedrock-AgentCore-Runtime-Custom-Interrupt-Id"
    )

    logger.info(
        f"Session: {session_id}, User: {user_id}, "
        f"Interrupt: {interrupt_id}, Prompt: {payload.prompt}"
    )

    if not payload.prompt:
        return {"error": "No prompt provided"}

    if interrupt_id:
        input_message = [
            {
                "interruptResponse": {
                    "interruptId": interrupt_id,
                    "response": payload.prompt,
                }
            }
        ]
    else:
        input_message = payload.prompt

    agent = get_or_create_agent(session_id, user_id)
    agent_stream = agent.stream_async(input_message)
    parsed_stream = parse_agent_events(agent_stream)

    return StreamingResponse(parsed_stream, media_type="application/x-ndjson")
