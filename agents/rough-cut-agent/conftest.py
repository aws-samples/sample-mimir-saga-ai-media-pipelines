"""Shared pytest fixtures/stubs for the rough-cut-agent test suite.

pytest imports this before collecting any test module, so it is the right place
to install the external-SDK stubs that every test needs. We stub:

* ``strands`` — with ``tool`` as a PASSTHROUGH decorator so ``@tool`` functions
  remain callable in tests.
* ``bedrock_agentcore.runtime`` — with a fake ``BedrockAgentCoreApp`` whose
  ``entrypoint`` is a PASSTHROUGH decorator, so the agent's ``@app.entrypoint``
  ``invoke()`` stays a real, callable function.

Individual test modules also call ``sys.modules.setdefault(...)`` for these; those
become no-ops once we set them here, so behavior is consistent regardless of
which module is collected first. We intentionally do NOT stub ``prompts`` or
import the agent modules here, leaving each test module free to stub ``prompts``
before it imports the code under test.
"""
import sys
from unittest.mock import MagicMock


def _passthrough_tool(fn):
    """Passthrough replacement for strands.tool — keeps the function callable."""
    fn.tool_handler = fn
    return fn


class _FakeAgentCoreApp:
    """Stand-in for BedrockAgentCoreApp; entrypoint is a passthrough decorator."""

    def entrypoint(self, fn):
        return fn

    def run(self, *args, **kwargs):
        pass


# strands (+ passthrough tool)
_strands = sys.modules.get("strands") or MagicMock()
_strands.tool = _passthrough_tool
sys.modules["strands"] = _strands
sys.modules.setdefault("strands.models", MagicMock())

# bedrock_agentcore.runtime (+ passthrough entrypoint app)
sys.modules.setdefault("bedrock_agentcore", MagicMock())
_runtime = sys.modules.get("bedrock_agentcore.runtime")
if _runtime is None or not hasattr(_runtime, "BedrockAgentCoreApp") or \
        isinstance(getattr(_runtime, "BedrockAgentCoreApp", None), MagicMock):
    _runtime = MagicMock()
    _runtime.BedrockAgentCoreApp = lambda *a, **k: _FakeAgentCoreApp()
    sys.modules["bedrock_agentcore.runtime"] = _runtime
