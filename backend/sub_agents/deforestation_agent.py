import os
import logging
from typing import AsyncIterator
from strands import Agent, tool
from strands.models.bedrock import BedrockModel
from strands_tools import current_time
from tools.forest_tools import analyze_deforestation, get_area_satellite_thumbnail
from tools.types import SubAgentResult
from pydantic import BaseModel, Field

logger = logging.getLogger("deforestation-agent")


class DeforestationVerdict(BaseModel):
    """Structured verdict from the deforestation agent."""

    verdict: str = Field(
        description="One of: 'no_loss', 'minor_loss', 'significant_loss', 'severe_loss'."
    )
    likely_illegal: bool = Field(
        description="True if the pattern (sudden spikes, sustained loss, large area) suggests "
                    "illegal deforestation rather than natural disturbance or planned harvest. "
                    "False if the data is inconclusive or looks benign."
    )
    confidence: str = Field(description="low | medium | high")
    total_loss_ha: float = Field(description="Total hectares lost over the analyzed period.")
    peak_year: int | None = Field(description="Year of highest loss, or null if no loss.")
    summary: str = Field(description="2-4 sentence markdown summary for the end user, including the embedded satellite thumbnail markdown image if available.")


DEFORESTATION_PROMPT = """# Role
You are a remote-sensing analyst specialized in detecting deforestation from the Hansen
Global Forest Change dataset (UMD / Global Forest Watch).

# Your job
Given a GeoJSON polygon describing an area of interest, determine whether
deforestation has occurred there over the past ~10 years, and assess whether the
pattern is consistent with illegal clearing.

# How to work
1. Call `analyze_deforestation` with the polygon and a 10-year range ending at the
   most recent full year. Use `current_time` if you need to know what year it is.
2. Call `get_area_satellite_thumbnail` to get a visual reference for the user.
3. Interpret the per-year loss series:
   - 0 ha across all years -> no_loss
   - <1 ha total -> minor_loss (noise / small clearings)
   - 1-50 ha total OR a clear spike in one or two years -> significant_loss
   - >50 ha total OR sustained heavy loss -> severe_loss
4. Decide `likely_illegal`:
   - Sudden spikes after years of stability, or steadily accelerating loss in
     remote / protected-looking areas, suggest illegal clearing.
   - Gradual loss in temperate/managed forest regions is more often legal harvest.
   - You DO NOT have legal status of the land — flag concern, do not accuse.
5. Produce a structured verdict using the schema. The `summary` should:
   - State the total hectares lost and the worst year
   - Note any suspicious pattern
   - Embed the thumbnail as ![area](URL) if the thumbnail tool returned a URL
   - Be plain markdown, no headers

# Rules
- Hansen data measures *tree cover loss*, not necessarily deforestation cause.
  Fires, storms, and disease also register. State this caveat when relevant.
- The dataset's latest year is typically ~1 year behind real time. Don't query
  future years.
- Never invent numbers — only cite values the tool returned.
"""


@tool
async def deforestation_agent(geometry_geojson: str) -> AsyncIterator:
    """Analyze a GeoJSON polygon for signs of deforestation over the past ~10 years.

    Use this tool whenever a user points to an area on the map and asks whether
    deforestation, illegal logging, or forest loss has occurred there. The tool
    handles satellite-data lookup and produces a structured verdict.

    Args:
        geometry_geojson: A GeoJSON Polygon / Feature / FeatureCollection as a
                          JSON-encoded string. WGS84 (lon, lat).

    Yields:
        SubAgentResult events for streaming the sub-agent's activity, and a final
        DeforestationVerdict dict with the analysis.
    """
    logger.info("deforestation_agent invoked")

    try:
        model = BedrockModel(
            model_id=os.getenv("AGENT_MODEL_ID", "anthropic.claude-haiku-4-5-20251001-v1:0"),
            max_tokens=2000,
            region_name=os.getenv("BEDROCK_REGION") or os.getenv("AWS_REGION") or "us-east-1",
        )

        sub_agent = Agent(
            name="Deforestation Analyst",
            model=model,
            system_prompt=DEFORESTATION_PROMPT,
            callback_handler=None,
            tools=[analyze_deforestation, get_area_satellite_thumbnail, current_time],
            structured_output_model=DeforestationVerdict,
        )

        prompt = f"Analyze this area for deforestation:\n\n```geojson\n{geometry_geojson}\n```"

        result = None
        async for event in sub_agent.stream_async(prompt):
            yield SubAgentResult(agent=sub_agent, event=event)
            if "result" in event:
                result = event["result"]

        if result and hasattr(result, "structured_output") and result.structured_output:
            yield result.structured_output.model_dump()
        elif result:
            yield str(result)
        else:
            yield "Deforestation analysis complete (no result)"

    except Exception as e:
        logger.error(f"deforestation_agent failed: {e}", exc_info=True)
        yield f"Deforestation analysis failed: {e}"
