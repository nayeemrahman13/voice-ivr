"""Deterministic voice IVR FrameProcessor and CLI for Pipecat powered by TypeSafe Jev."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .client import (
    JevClient,
    JevClientError,
    NodeClassification,
    build_jev_request,
    parse_jev_payload,
)
from .evaluator import (
    EvalFailure,
    EvalSummary,
    compute_menu_sha256,
    evaluate_menu_graph,
)
from .schema import (
    CONFIDENCE_DEFAULT,
    GLOBAL_BACK,
    GLOBAL_OPERATOR,
    GLOBAL_REPEAT,
    NOUL_NO_DEFAULT,
    NOUL_YES_DEFAULT,
    UNCLEAR,
    ChoiceQuestion,
    EndCallAction,
    FallbackEndCall,
    FallbackGoto,
    FallbackHandoffLlm,
    FallbackTransfer,
    GotoAction,
    HandoffLlmAction,
    MenuEvalCase,
    MenuGlobals,
    MenuGraph,
    MenuNode,
    MenuNodeOption,
    MenuSchemaError,
    NoulQuestion,
    ReplyOnlyAction,
    SecondaryResult,
    TransferAction,
    TurnStepResult,
    WebhookAction,
    load_v2_json_schema,
    migrate_v1_to_v2,
    parse_menu_graph,
    present_deeper,
    present_menu,
    push_node_stack,
    reprompt_text,
    slugify,
    spoken_list,
    step_menu_turn,
)
from .validator import ValidationIssue, ValidationReport, validate_menu_graph

if TYPE_CHECKING:
    from .frames import JevDecisionFrame, JevStateFrame, JevTransferFrame
    from .processor import JevMenuProcessor, OptionSelectedEvent, graph_uses_handoff_llm
    from .transfers import (
        DailySipTransferAdapter,
        FallbackDailySIPReferFrame,
        SimulatedTransferAdapter,
        TransferAdapter,
        TransferContext,
        TransferExecutionError,
        TwilioTransferAdapter,
    )

__version__ = "0.2.0"

_LAZY_EXPORTS: dict[str, tuple[str, str]] = {
    "JevDecisionFrame": (".frames", "JevDecisionFrame"),
    "JevStateFrame": (".frames", "JevStateFrame"),
    "JevTransferFrame": (".frames", "JevTransferFrame"),
    "JevMenuProcessor": (".processor", "JevMenuProcessor"),
    "OptionSelectedEvent": (".processor", "OptionSelectedEvent"),
    "graph_uses_handoff_llm": (".processor", "graph_uses_handoff_llm"),
    "DailySipTransferAdapter": (".transfers", "DailySipTransferAdapter"),
    "FallbackDailySIPReferFrame": (".transfers", "FallbackDailySIPReferFrame"),
    "SimulatedTransferAdapter": (".transfers", "SimulatedTransferAdapter"),
    "TransferAdapter": (".transfers", "TransferAdapter"),
    "TransferContext": (".transfers", "TransferContext"),
    "TransferExecutionError": (".transfers", "TransferExecutionError"),
    "TwilioTransferAdapter": (".transfers", "TwilioTransferAdapter"),
}


def __getattr__(name: str) -> Any:
    target = _LAZY_EXPORTS.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module

    mod = import_module(target[0], __name__)
    val = getattr(mod, target[1])
    globals()[name] = val
    return val


__all__ = [
    "CONFIDENCE_DEFAULT",
    "GLOBAL_BACK",
    "GLOBAL_OPERATOR",
    "GLOBAL_REPEAT",
    "NOUL_NO_DEFAULT",
    "NOUL_YES_DEFAULT",
    "UNCLEAR",
    "ChoiceQuestion",
    "DailySipTransferAdapter",
    "EndCallAction",
    "EvalFailure",
    "EvalSummary",
    "FallbackDailySIPReferFrame",
    "FallbackEndCall",
    "FallbackGoto",
    "FallbackHandoffLlm",
    "FallbackTransfer",
    "GotoAction",
    "HandoffLlmAction",
    "JevClient",
    "JevClientError",
    "JevDecisionFrame",
    "JevMenuProcessor",
    "JevStateFrame",
    "JevTransferFrame",
    "MenuEvalCase",
    "MenuGlobals",
    "MenuGraph",
    "MenuNode",
    "MenuNodeOption",
    "MenuSchemaError",
    "NodeClassification",
    "NoulQuestion",
    "OptionSelectedEvent",
    "ReplyOnlyAction",
    "SecondaryResult",
    "SimulatedTransferAdapter",
    "TransferAction",
    "TransferAdapter",
    "TransferContext",
    "TransferExecutionError",
    "TurnStepResult",
    "TwilioTransferAdapter",
    "ValidationIssue",
    "ValidationReport",
    "WebhookAction",
    "build_jev_request",
    "compute_menu_sha256",
    "evaluate_menu_graph",
    "graph_uses_handoff_llm",
    "load_v2_json_schema",
    "migrate_v1_to_v2",
    "parse_jev_payload",
    "parse_menu_graph",
    "present_deeper",
    "present_menu",
    "push_node_stack",
    "reprompt_text",
    "slugify",
    "spoken_list",
    "step_menu_turn",
    "validate_menu_graph",
]
