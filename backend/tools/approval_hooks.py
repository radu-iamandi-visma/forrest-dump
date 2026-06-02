from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry


class HeaterApprovalHook(HookProvider):
    """Requires explicit user approval before modifying the heater setpoint."""

    def register_hooks(self, registry: HookRegistry, **kwargs):
        registry.add_callback(BeforeToolCallEvent, self.request_approval)

    def request_approval(self, event: BeforeToolCallEvent):
        if event.tool_use["name"] != "modify_setpoint":
            return

        temperature = event.tool_use["input"].get("temperature")

        approval = event.interrupt(
            name="heater-approval",
            reason={
                "tool": "modify_setpoint",
                "temperature": temperature,
                "message": f"Set heater to {temperature}°C?",
            },
        )

        if approval.lower() not in ["yes", "approve", "confirmed", "ok"]:
            event.cancel_tool = f"User denied: {approval}"
