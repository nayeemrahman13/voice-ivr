"""Custom Pipecat frames emitted by `JevMenuProcessor` for observability and downstream hooks."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pipecat.frames.frames import DataFrame


@dataclass
class JevStateFrame(DataFrame):
    """Emitted whenever the active menu node changes or greets the caller."""

    node_id: str = ""
    stack: list[str] = field(default_factory=list)
    script: str = ""
    extracted: dict[str, bool | str] = field(default_factory=dict)


@dataclass
class JevDecisionFrame(DataFrame):
    """Emitted on every committed turn classification (voice or DTMF)."""

    node_id: str = ""
    source: Literal["voice", "dtmf", "error_fallback"] = "voice"
    transcript: str = ""
    raw_choice: str = ""
    outcome_choice: str = ""
    confidence: float = 0.0
    probabilities: dict[str, float] = field(default_factory=dict)
    unclear: bool = False
    spoken_reply: str = ""
    next_node_id: str = ""
    next_stack: list[str] = field(default_factory=list)
    extracted: dict[str, bool | str] = field(default_factory=dict)
    resolved_model: str = ""
    latency_ms: float = 0.0


@dataclass
class JevTransferFrame(DataFrame):
    """Emitted when a `transfer` terminal action commits."""

    target: str = ""
    mode: str = "custom"
    node_id: str = ""
    option_id: str = ""
    extracted: dict[str, bool | str] = field(default_factory=dict)
    metadata: dict[str, str] = field(default_factory=dict)
