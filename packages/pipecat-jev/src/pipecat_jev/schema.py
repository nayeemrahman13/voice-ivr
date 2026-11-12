"""Canonical v2 IVR graph schema, v1 auto-migration, and pure turn reducer."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any, Literal

import jsonschema
from pydantic import BaseModel, ConfigDict, Field

CONFIDENCE_DEFAULT = 0.55
NOUL_YES_DEFAULT = 0.70
NOUL_NO_DEFAULT = 0.30

UNCLEAR = "unclear"
GLOBAL_BACK = "global_back"
GLOBAL_REPEAT = "global_repeat"
GLOBAL_OPERATOR = "global_operator"

RESERVED_OPTION_IDS = frozenset({UNCLEAR, GLOBAL_BACK, GLOBAL_REPEAT, GLOBAL_OPERATOR})
VALID_DTMF = frozenset({"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#"})
ID_RE = re.compile(r"^[a-z0-9_]+$")
QUESTION_KEY_RE = re.compile(r"^[a-zA-Z0-9_]+$")

DEFAULT_BACK_HINTS = "Go back, previous menu, return to the previous options"
DEFAULT_REPEAT_HINTS = "Repeat the options, say that again, what were the choices"
DEFAULT_OPERATOR_HINTS = "Operator, representative, human agent, speak to a person"

DtmfKey = Literal["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#"]
TransferMode = Literal["twilio_dial", "daily_sip_refer", "custom"]


class MenuSchemaError(ValueError):
    """Raised when a menu payload fails schema or semantic validation."""


def load_v2_json_schema() -> dict[str, Any]:
    """Load the bundled canonical v2 JSON Schema via importlib.resources."""
    schema_file = resources.files("pipecat_jev.schemas").joinpath("menu.v2.schema.json")
    return json.loads(schema_file.read_text(encoding="utf-8"))


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return slug or "option"


def with_unique_ids(options: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set(RESERVED_OPTION_IDS)
    result: list[dict[str, Any]] = []
    for opt in options:
        opt_id = slugify(str(opt.get("id") or opt.get("title") or ""))
        if opt_id in RESERVED_OPTION_IDS:
            opt_id = f"{opt_id}_option"
        base = opt_id
        n = 2
        while opt_id in seen:
            opt_id = f"{base}_{n}"
            n += 1
        seen.add(opt_id)
        result.append({**opt, "id": opt_id})
    return result


def spoken_list(items: list[str]) -> str:
    if len(items) <= 1:
        return items[0] if items else ""
    if len(items) == 2:
        return f"{items[0]} or {items[1]}"
    return f"{', '.join(items[:-1])}, or {items[-1]}"


def present_menu(name: str, titles: list[str]) -> str:
    clean_name = name.strip()
    intro = f"Thanks for calling {clean_name}." if clean_name else "Thanks for calling."
    clean_titles = [t.strip() for t in titles if t.strip()]
    if not clean_titles:
        return intro
    return f"{intro} You can say {spoken_list(clean_titles)}."


def present_deeper(name: str, titles: list[str]) -> str:
    place = name.strip() or "This menu"
    clean_titles = [t.strip() for t in titles if t.strip()]
    if not clean_titles:
        return f"{place}."
    return f"{place}. You can say {spoken_list(clean_titles)}."


def reprompt_text(titles: list[str]) -> str:
    clean_titles = [t.strip() for t in titles if t.strip()]
    if not clean_titles:
        return "Sorry, I didn't catch that."
    return f"Sorry, I didn't catch that. You can say {spoken_list(clean_titles)}."


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class GotoAction(StrictModel):
    type: Literal["goto"] = "goto"
    target: str


class ReplyOnlyAction(StrictModel):
    type: Literal["reply_only"] = "reply_only"


class EndCallAction(StrictModel):
    type: Literal["end_call"] = "end_call"


class TransferAction(StrictModel):
    type: Literal["transfer"] = "transfer"
    target: str
    mode: TransferMode | None = None
    metadata: dict[str, str] | None = None


class HandoffLlmAction(StrictModel):
    type: Literal["handoff_llm"] = "handoff_llm"
    systemPrompt: str | None = None


class FallbackEndCall(StrictModel):
    type: Literal["end_call"] = "end_call"
    reply: str | None = None


class FallbackGoto(StrictModel):
    type: Literal["goto"] = "goto"
    target: str
    reply: str | None = None


class FallbackTransfer(StrictModel):
    type: Literal["transfer"] = "transfer"
    target: str
    mode: TransferMode | None = None
    reply: str | None = None
    metadata: dict[str, str] | None = None


class FallbackHandoffLlm(StrictModel):
    type: Literal["handoff_llm"] = "handoff_llm"
    systemPrompt: str | None = None
    reply: str | None = None


FallbackAction = FallbackEndCall | FallbackGoto | FallbackTransfer | FallbackHandoffLlm
WebhookNextAction = EndCallAction | GotoAction | HandoffLlmAction


class WebhookAction(StrictModel):
    type: Literal["webhook"] = "webhook"
    url: str
    method: Literal["POST", "PUT"] = "POST"
    headers: dict[str, str] | None = None
    timeoutMs: int = 4000
    failureReply: str | None = None
    onFailure: FallbackAction | None = None
    next: WebhookNextAction


MenuAction = (
    GotoAction
    | ReplyOnlyAction
    | EndCallAction
    | TransferAction
    | WebhookAction
    | HandoffLlmAction
)


class NoulQuestion(StrictModel):
    type: Literal["noul"] = "noul"
    instructions: str
    criteria: dict[str, str] | None = None
    yesThreshold: float = NOUL_YES_DEFAULT
    noThreshold: float = NOUL_NO_DEFAULT


class ChoiceQuestion(StrictModel):
    type: Literal["choice"] = "choice"
    instructions: str
    criteria: dict[str, str]
    confidenceThreshold: float = CONFIDENCE_DEFAULT


SecondaryQuestion = NoulQuestion | ChoiceQuestion


class GlobalToggleObject(StrictModel):
    hints: str | None = None
    dtmf: DtmfKey | None = None


class GlobalOperatorObject(StrictModel):
    hints: str | None = None
    dtmf: DtmfKey | None = None
    reply: str | None = None
    action: FallbackAction


class MenuGlobals(StrictModel):
    back: bool | GlobalToggleObject = True
    repeat: bool | GlobalToggleObject = True
    operator: Literal[False] | GlobalOperatorObject | None = None


class MenuNodeOption(StrictModel):
    id: str
    title: str
    hints: str = ""
    dtmf: DtmfKey | None = None
    reply: str = ""
    action: MenuAction


class MenuNode(StrictModel):
    id: str
    name: str
    script: str = ""
    reprompt: str | None = None
    confidenceThreshold: float | None = None
    questions: dict[str, SecondaryQuestion] | None = None
    options: list[MenuNodeOption]


class EvalTurnMessage(StrictModel):
    role: Literal["user", "assistant"]
    text: str


class MenuEvalCase(StrictModel):
    id: str | None = None
    split: Literal["tune", "holdout"] = "tune"
    node: str
    stack: list[str] | None = None
    history: list[EvalTurnMessage] | None = None
    say: str
    expect: str
    expectExtracted: dict[str, bool | str | None] | None = None


class MenuGraph(StrictModel):
    version: Literal[2] = 2
    id: str
    name: str
    entry: str
    initialStack: list[str] | None = Field(default=None)
    confidenceThreshold: float = CONFIDENCE_DEFAULT
    maxUnclearTurns: int = 2
    fallbackAction: FallbackAction | None = None
    globals: MenuGlobals = Field(default_factory=MenuGlobals)
    nodes: dict[str, MenuNode]
    evals: list[MenuEvalCase] | None = None

    @classmethod
    def from_file(cls, path: str | Path) -> MenuGraph:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        return parse_menu_graph(raw)


@dataclass(frozen=True)
class SecondaryResult:
    value: bool | str | None
    raw: float


@dataclass
class TurnStepResult:
    outcome_choice: str
    matched_title: str
    unclear: bool
    spoken_reply: str
    next_node_id: str
    next_stack: list[str]
    next_unclear_streak: int
    extracted: dict[str, bool | str]
    terminal_action: MenuAction | FallbackAction | None


def parse_menu_graph(value: Any) -> MenuGraph:
    """Parse and strictly validate a canonical v2 MenuGraph, or migrate a legacy v1 menu."""
    if not isinstance(value, dict):
        raise MenuSchemaError("Menu payload must be a JSON object.")

    if "version" in value and value["version"] is not None:
        if value["version"] != 2:
            raise MenuSchemaError(f"Unsupported menu version: {value['version']!r}. Expected 2.")
        return _parse_canonical_v2(value)

    if isinstance(value.get("options"), list):
        return migrate_v1_to_v2(value)

    raise MenuSchemaError("Menu must be a canonical v2 graph (version: 2) or a legacy v1 menu.")


def _parse_canonical_v2(raw: dict[str, Any]) -> MenuGraph:
    schema = load_v2_json_schema()
    try:
        jsonschema.validate(instance=raw, schema=schema)
    except jsonschema.ValidationError as exc:
        loc = ".".join(str(p) for p in exc.absolute_path) or "root"
        raise MenuSchemaError(f"Schema error at {loc}: {exc.message}") from exc

    # Normalize trimmed string fields without mutating IDs
    entry = str(raw["entry"]).strip()
    root_name = str(raw["name"]).strip()
    globals_cfg = MenuGlobals.model_validate(raw.get("globals") or {})

    # Global DTMF collision check
    global_dtmfs: set[str] = set()
    for label, g_dtmf in _iter_global_dtmfs(globals_cfg):
        if g_dtmf in global_dtmfs:
            raise MenuSchemaError(f"Duplicate global DTMF key {g_dtmf!r} at {label}.")
        global_dtmfs.add(g_dtmf)

    raw_nodes: dict[str, Any] = raw["nodes"]
    parsed_nodes: dict[str, MenuNode] = {}
    for key, n_val in raw_nodes.items():
        node_id = str(n_val["id"]).strip()
        if node_id != key:
            raise MenuSchemaError(f"Node {key!r} has mismatched id {node_id!r}.")

        seen_opt_ids: set[str] = set()
        seen_dtmfs: set[str] = set(global_dtmfs)
        opts: list[MenuNodeOption] = []

        for idx, o_val in enumerate(n_val["options"]):
            opt_id = str(o_val["id"]).strip()
            if opt_id in RESERVED_OPTION_IDS:
                raise MenuSchemaError(f"nodes.{key}.options[{idx}].id {opt_id!r} is reserved.")
            if opt_id in seen_opt_ids:
                raise MenuSchemaError(f"Duplicate option id {opt_id!r} in node {key!r}.")
            seen_opt_ids.add(opt_id)

            title = str(o_val["title"]).strip()
            if not title:
                raise MenuSchemaError(f"nodes.{key}.options[{idx}].title cannot be blank.")

            dtmf = o_val.get("dtmf")
            if dtmf:
                if dtmf in seen_dtmfs:
                    raise MenuSchemaError(
                        f"Duplicate DTMF key {dtmf!r} in node {key!r} (or colliding with globals)."
                    )
                seen_dtmfs.add(dtmf)

            action = _validate_action_dict(o_val["action"], f"nodes.{key}.options[{idx}].action")
            opts.append(
                MenuNodeOption(
                    id=opt_id,
                    title=title,
                    hints=str(o_val.get("hints") or "").strip(),
                    dtmf=dtmf or None,
                    reply=str(o_val.get("reply") or "").strip(),
                    action=action,
                )
            )

        questions: dict[str, SecondaryQuestion] | None = None
        if n_val.get("questions") is not None:
            questions = {}
            for q_key, q_raw in n_val["questions"].items():
                if q_key == "option" or not QUESTION_KEY_RE.match(q_key):
                    raise MenuSchemaError(f"Invalid or reserved question key {q_key!r} in node {key!r}.")
                if q_raw["type"] == "noul":
                    q_obj = NoulQuestion.model_validate(q_raw)
                    if not q_obj.instructions.strip():
                        raise MenuSchemaError(f"nodes.{key}.questions.{q_key}.instructions is blank.")
                    if q_obj.noThreshold >= q_obj.yesThreshold:
                        raise MenuSchemaError(
                            f"nodes.{key}.questions.{q_key} requires noThreshold < yesThreshold."
                        )
                    questions[q_key] = q_obj
                else:
                    q_obj_c = ChoiceQuestion.model_validate(q_raw)
                    if not q_obj_c.instructions.strip():
                        raise MenuSchemaError(f"nodes.{key}.questions.{q_key}.instructions is blank.")
                    questions[q_key] = q_obj_c

        node_name = str(n_val["name"]).strip()
        raw_script = str(n_val.get("script") or "").strip()
        titles = [o.title for o in opts]
        script = raw_script or (
            present_menu(node_name or root_name, titles)
            if key == entry
            else present_deeper(node_name, titles)
        )
        reprompt_str = str(n_val.get("reprompt") or "").strip() or None

        parsed_nodes[key] = MenuNode(
            id=key,
            name=node_name,
            script=script,
            reprompt=reprompt_str,
            confidenceThreshold=n_val.get("confidenceThreshold"),
            questions=questions or None,
            options=opts,
        )

    if entry not in parsed_nodes:
        raise MenuSchemaError(f"Entry node {entry!r} does not exist in nodes.")

    initial_stack: list[str] | None = None
    if raw.get("initialStack") is not None:
        initial_stack = []
        for idx, sid in enumerate(raw["initialStack"]):
            if sid not in parsed_nodes:
                raise MenuSchemaError(f"initialStack[{idx}] references unknown node {sid!r}.")
            initial_stack.append(sid)
        if not initial_stack:
            initial_stack = None

    fallback = (
        _validate_fallback_dict(raw["fallbackAction"], "fallbackAction")
        if raw.get("fallbackAction") is not None
        else None
    )

    # Referential integrity of all goto targets
    _assert_fallback_target(fallback, parsed_nodes, "fallbackAction")
    if isinstance(globals_cfg.operator, GlobalOperatorObject):
        _assert_fallback_target(globals_cfg.operator.action, parsed_nodes, "globals.operator.action")

    for node in parsed_nodes.values():
        for opt in node.options:
            _assert_action_targets(opt.action, parsed_nodes, f"nodes.{node.id}.options.{opt.id}.action")

    evals: list[MenuEvalCase] | None = None
    if raw.get("evals") is not None:
        evals = []
        for idx, ev_raw in enumerate(raw["evals"]):
            ev_node = str(ev_raw.get("node") or entry).strip()
            if ev_node not in parsed_nodes:
                raise MenuSchemaError(f"evals[{idx}].node references unknown node {ev_node!r}.")
            ev_stack: list[str] | None = None
            if ev_raw.get("stack") is not None:
                ev_stack = []
                for s_idx, s_id in enumerate(ev_raw["stack"]):
                    if s_id not in parsed_nodes:
                        raise MenuSchemaError(
                            f"evals[{idx}].stack[{s_idx}] references unknown node {s_id!r}."
                        )
                    ev_stack.append(s_id)
            elif ev_node == entry and initial_stack:
                ev_stack = list(initial_stack)

            depth = len(ev_stack or [])
            expect_val = str(ev_raw["expect"]).strip()
            valid_opts = {o.id for o in parsed_nodes[ev_node].options}
            valid_globals = {UNCLEAR}
            if globals_cfg.repeat is not False:
                valid_globals.add(GLOBAL_REPEAT)
            if depth > 0 and globals_cfg.back is not False:
                valid_globals.add(GLOBAL_BACK)
            if isinstance(globals_cfg.operator, GlobalOperatorObject):
                valid_globals.add(GLOBAL_OPERATOR)

            if expect_val not in valid_opts and expect_val not in valid_globals:
                raise MenuSchemaError(
                    f"evals[{idx}].expect {expect_val!r} is not a valid option or active global in node {ev_node!r}."
                )

            say_str = str(ev_raw["say"]).strip()
            if not say_str:
                raise MenuSchemaError(f"evals[{idx}].say cannot be blank.")

            evals.append(
                MenuEvalCase(
                    id=str(ev_raw["id"]).strip() if ev_raw.get("id") else None,
                    split=ev_raw.get("split", "tune"),
                    node=ev_node,
                    stack=ev_stack,
                    history=[EvalTurnMessage.model_validate(h) for h in ev_raw["history"]]
                    if ev_raw.get("history") is not None
                    else None,
                    say=say_str,
                    expect=expect_val,
                    expectExtracted=ev_raw.get("expectExtracted"),
                )
            )

    return MenuGraph(
        version=2,
        id=str(raw["id"]).strip(),
        name=root_name,
        entry=entry,
        initialStack=initial_stack,
        confidenceThreshold=float(raw.get("confidenceThreshold", CONFIDENCE_DEFAULT)),
        maxUnclearTurns=int(raw.get("maxUnclearTurns", 2)),
        fallbackAction=fallback,
        globals=globals_cfg,
        nodes=parsed_nodes,
        evals=evals,
    )


def migrate_v1_to_v2(raw: dict[str, Any]) -> MenuGraph:
    """Losslessly convert a legacy v1 nested tree menu into a canonical v2 MenuGraph."""
    root_name = str(raw.get("name") or "").strip()
    graph_id = slugify(root_name or "ivr")
    nodes: dict[str, MenuNode] = {}
    used_node_ids = {"main"}
    transitions_by_node: dict[str, list[dict[str, str]]] = {}

    def alloc_node_id(hint: str) -> str:
        base = slugify(hint or "menu")
        if base in RESERVED_OPTION_IDS:
            base = f"{base}_menu"
        candidate = base
        n = 2
        while candidate in used_node_ids:
            candidate = f"{base}_{n}"
            n += 1
        used_node_ids.add(candidate)
        return candidate

    def visit(menu_obj: dict[str, Any], node_id: str, is_root: bool) -> None:
        raw_opts = menu_obj.get("options")
        if not isinstance(raw_opts, list) or len(raw_opts) == 0:
            raise MenuSchemaError(
                "Add at least one option." if is_root else "Add at least one option to the nested menu."
            )

        prepared: list[dict[str, Any]] = []
        for idx, item in enumerate(raw_opts):
            if not isinstance(item, dict):
                raise MenuSchemaError(f"Option {idx + 1} is incomplete.")
            title = str(item.get("title") or "").strip()
            if not title:
                raise MenuSchemaError(f"Option {idx + 1} needs a title.")
            raw_id = str(item.get("id") or "").strip() or slugify(title)
            nested = item.get("menu") if isinstance(item.get("menu"), dict) else None
            prepared.append(
                {
                    "raw_id": raw_id,
                    "id": raw_id,
                    "title": title,
                    "hints": str(item.get("hints") or "").strip(),
                    "reply": str(item.get("reply") or "").strip(),
                    "nested": nested,
                }
            )

        unique_items = with_unique_ids(prepared)
        node_transitions: list[dict[str, str]] = []
        node_options: list[MenuNodeOption] = []

        for item in unique_items:
            if item["nested"] is not None:
                child_id = alloc_node_id(item["id"] or item["title"])
                visit(item["nested"], child_id, False)
                node_transitions.append(
                    {
                        "raw_id": item["raw_id"],
                        "repaired_id": item["id"],
                        "child_node_id": child_id,
                    }
                )
                node_options.append(
                    MenuNodeOption(
                        id=item["id"],
                        title=item["title"],
                        hints=item["hints"],
                        reply="",
                        action=GotoAction(target=child_id),
                    )
                )
            else:
                node_options.append(
                    MenuNodeOption(
                        id=item["id"],
                        title=item["title"],
                        hints=item["hints"],
                        reply=item["reply"],
                        action=ReplyOnlyAction(),
                    )
                )

        transitions_by_node[node_id] = node_transitions
        node_name = str(menu_obj.get("name") or "").strip()
        raw_script = str(menu_obj.get("script") or "").strip()
        titles = [o.title for o in node_options]
        nodes[node_id] = MenuNode(
            id=node_id,
            name=node_name,
            script=raw_script
            or (present_menu(node_name, titles) if is_root else present_deeper(node_name, titles)),
            options=node_options,
        )

    visit(raw, "main", True)

    entry = "main"
    initial_stack: list[str] = []
    raw_start = raw.get("start")
    if isinstance(raw_start, list):
        for step_val in raw_start:
            if not isinstance(step_val, str) or not step_val.strip():
                continue
            step = step_val.strip()
            candidates = transitions_by_node.get(entry, [])
            matched = next(
                (
                    c
                    for c in candidates
                    if c["repaired_id"] == step
                    or c["raw_id"] == step
                    or slugify(step) == c["repaired_id"]
                ),
                None,
            )
            if not matched:
                break
            initial_stack.append(entry)
            entry = matched["child_node_id"]

    return MenuGraph(
        version=2,
        id=graph_id,
        name=root_name,
        entry=entry,
        initialStack=initial_stack or None,
        confidenceThreshold=CONFIDENCE_DEFAULT,
        maxUnclearTurns=2,
        globals=MenuGlobals(back=True, repeat=True),
        nodes=nodes,
    )


def active_globals_for_node(
    graph: MenuGraph,
    stack_depth: int,
) -> dict[str, dict[str, str | None]]:
    active: dict[str, dict[str, str | None]] = {}
    if stack_depth > 0 and graph.globals.back is not False:
        hints = (
            graph.globals.back.hints.strip()
            if isinstance(graph.globals.back, GlobalToggleObject) and graph.globals.back.hints
            else DEFAULT_BACK_HINTS
        )
        dtmf = graph.globals.back.dtmf if isinstance(graph.globals.back, GlobalToggleObject) else None
        active[GLOBAL_BACK] = {"title": "Back", "hints": hints, "dtmf": dtmf}

    if graph.globals.repeat is not False:
        hints = (
            graph.globals.repeat.hints.strip()
            if isinstance(graph.globals.repeat, GlobalToggleObject) and graph.globals.repeat.hints
            else DEFAULT_REPEAT_HINTS
        )
        dtmf = (
            graph.globals.repeat.dtmf
            if isinstance(graph.globals.repeat, GlobalToggleObject)
            else None
        )
        active[GLOBAL_REPEAT] = {"title": "Repeat", "hints": hints, "dtmf": dtmf}

    if isinstance(graph.globals.operator, GlobalOperatorObject):
        hints = (
            graph.globals.operator.hints.strip()
            if graph.globals.operator.hints
            else DEFAULT_OPERATOR_HINTS
        )
        active[GLOBAL_OPERATOR] = {
            "title": "Operator",
            "hints": hints,
            "dtmf": graph.globals.operator.dtmf,
        }

    return active


def step_menu_turn(
    *,
    graph: MenuGraph,
    node_id: str,
    stack: list[str] | None = None,
    unclear_streak: int = 0,
    extracted: dict[str, bool | str] | None = None,
    choice: str,
    confidence: float,
    secondary_answers: dict[str, SecondaryResult] | None = None,
) -> TurnStepResult:
    """Pure state-machine transition identical to TypeScript `stepMenuTurn`."""
    node = graph.nodes.get(node_id)
    if node is None:
        raise MenuSchemaError(f"Unknown menu node {node_id!r}.")

    cur_stack = list(stack or [])
    merged_extracted: dict[str, bool | str] = dict(extracted or {})
    if secondary_answers:
        for k, res in secondary_answers.items():
            if res.value is not None:
                merged_extracted[k] = res.value

    threshold = (
        node.confidenceThreshold
        if node.confidenceThreshold is not None
        else graph.confidenceThreshold
    )
    globals_map = active_globals_for_node(graph, len(cur_stack))
    is_confident = choice != UNCLEAR and confidence >= threshold

    if is_confident and choice == GLOBAL_REPEAT and GLOBAL_REPEAT in globals_map:
        return TurnStepResult(
            outcome_choice=GLOBAL_REPEAT,
            matched_title="Repeat",
            unclear=False,
            spoken_reply=node.script,
            next_node_id=node.id,
            next_stack=cur_stack,
            next_unclear_streak=0,
            extracted=merged_extracted,
            terminal_action=None,
        )

    if is_confident and choice == GLOBAL_BACK and GLOBAL_BACK in globals_map and cur_stack:
        parent_id = cur_stack[-1]
        next_stack = cur_stack[:-1]
        parent_node = graph.nodes.get(parent_id, node)
        return TurnStepResult(
            outcome_choice=GLOBAL_BACK,
            matched_title="Back",
            unclear=False,
            spoken_reply=parent_node.script,
            next_node_id=parent_node.id,
            next_stack=next_stack,
            next_unclear_streak=0,
            extracted=merged_extracted,
            terminal_action=None,
        )

    if (
        is_confident
        and choice == GLOBAL_OPERATOR
        and GLOBAL_OPERATOR in globals_map
        and isinstance(graph.globals.operator, GlobalOperatorObject)
    ):
        op = graph.globals.operator
        return _apply_fallback_action(
            graph=graph,
            node=node,
            stack=cur_stack,
            extracted=merged_extracted,
            outcome_choice=GLOBAL_OPERATOR,
            matched_title="Operator",
            unclear=False,
            fallback=op.action,
            override_reply=op.reply,
        )

    matched_opt = (
        next((o for o in node.options if o.id == choice), None) if is_confident else None
    )
    if matched_opt is None:
        next_streak = unclear_streak + 1
        if next_streak >= graph.maxUnclearTurns and graph.fallbackAction is not None:
            return _apply_fallback_action(
                graph=graph,
                node=node,
                stack=cur_stack,
                extracted=merged_extracted,
                outcome_choice=UNCLEAR,
                matched_title="Unclear (Fallback)",
                unclear=True,
                fallback=graph.fallbackAction,
            )
        reprompt_line = (
            node.reprompt.strip()
            if node.reprompt and node.reprompt.strip()
            else reprompt_text([o.title for o in node.options])
        )
        return TurnStepResult(
            outcome_choice=UNCLEAR,
            matched_title="Unclear",
            unclear=True,
            spoken_reply=reprompt_line,
            next_node_id=node.id,
            next_stack=cur_stack,
            next_unclear_streak=next_streak,
            extracted=merged_extracted,
            terminal_action=None,
        )

    if isinstance(matched_opt.action, GotoAction):
        target_node = graph.nodes[matched_opt.action.target]
        next_stack = push_node_stack(cur_stack, node.id, target_node.id)
        parts = [p for p in (matched_opt.reply.strip(), target_node.script.strip()) if p]
        return TurnStepResult(
            outcome_choice=matched_opt.id,
            matched_title=matched_opt.title,
            unclear=False,
            spoken_reply=" ".join(parts),
            next_node_id=target_node.id,
            next_stack=next_stack,
            next_unclear_streak=0,
            extracted=merged_extracted,
            terminal_action=None,
        )

    if isinstance(matched_opt.action, HandoffLlmAction):
        return TurnStepResult(
            outcome_choice=matched_opt.id,
            matched_title=matched_opt.title,
            unclear=False,
            spoken_reply=matched_opt.reply.strip(),
            next_node_id=node.id,
            next_stack=cur_stack,
            next_unclear_streak=0,
            extracted=merged_extracted,
            terminal_action=matched_opt.action,
        )

    spoken = matched_opt.reply.strip() or f"Okay. {matched_opt.title}."
    next_node_id = node.id
    next_stack = cur_stack
    if isinstance(matched_opt.action, WebhookAction) and isinstance(
        matched_opt.action.next, GotoAction
    ):
        target_node = graph.nodes[matched_opt.action.next.target]
        next_stack = push_node_stack(cur_stack, node.id, target_node.id)
        next_node_id = target_node.id

    return TurnStepResult(
        outcome_choice=matched_opt.id,
        matched_title=matched_opt.title,
        unclear=False,
        spoken_reply=spoken,
        next_node_id=next_node_id,
        next_stack=next_stack,
        next_unclear_streak=0,
        extracted=merged_extracted,
        terminal_action=matched_opt.action,
    )


def _apply_fallback_action(
    *,
    graph: MenuGraph,
    node: MenuNode,
    stack: list[str],
    extracted: dict[str, bool | str],
    outcome_choice: str,
    matched_title: str,
    unclear: bool,
    fallback: FallbackAction,
    override_reply: str | None = None,
) -> TurnStepResult:
    custom_reply = (override_reply if override_reply is not None else (fallback.reply or "")).strip()
    if isinstance(fallback, FallbackGoto):
        target = graph.nodes[fallback.target]
        next_stack = push_node_stack(stack, node.id, target.id)
        parts = [p for p in (custom_reply, target.script.strip()) if p]
        return TurnStepResult(
            outcome_choice=outcome_choice,
            matched_title=matched_title,
            unclear=unclear,
            spoken_reply=" ".join(parts),
            next_node_id=target.id,
            next_stack=next_stack,
            next_unclear_streak=0,
            extracted=extracted,
            terminal_action=None,
        )

    default_line = "" if isinstance(fallback, FallbackHandoffLlm) else "Let me connect you."
    return TurnStepResult(
        outcome_choice=outcome_choice,
        matched_title=matched_title,
        unclear=unclear,
        spoken_reply=custom_reply or default_line,
        next_node_id=node.id,
        next_stack=stack,
        next_unclear_streak=0,
        extracted=extracted,
        terminal_action=fallback,
    )


def push_node_stack(stack: list[str], from_id: str, target_id: str) -> list[str]:
    if from_id == target_id:
        return list(stack)
    if target_id in stack:
        idx = stack.index(target_id)
        return stack[:idx]
    return [*stack, from_id]


def _iter_global_dtmfs(globals_cfg: MenuGlobals) -> list[tuple[str, str]]:
    items: list[tuple[str, str]] = []
    if isinstance(globals_cfg.back, GlobalToggleObject) and globals_cfg.back.dtmf:
        items.append(("globals.back.dtmf", globals_cfg.back.dtmf))
    if isinstance(globals_cfg.repeat, GlobalToggleObject) and globals_cfg.repeat.dtmf:
        items.append(("globals.repeat.dtmf", globals_cfg.repeat.dtmf))
    if isinstance(globals_cfg.operator, GlobalOperatorObject) and globals_cfg.operator.dtmf:
        items.append(("globals.operator.dtmf", globals_cfg.operator.dtmf))
    return items


def _validate_action_dict(raw: dict[str, Any], path: str) -> MenuAction:
    t = raw.get("type")
    if t == "goto":
        return GotoAction.model_validate(raw)
    if t == "reply_only":
        return ReplyOnlyAction.model_validate(raw)
    if t == "end_call":
        return EndCallAction.model_validate(raw)
    if t == "transfer":
        if not str(raw.get("target") or "").strip():
            raise MenuSchemaError(f"{path}.target cannot be blank.")
        return TransferAction.model_validate(raw)
    if t == "webhook":
        url = str(raw.get("url") or "").strip()
        if not url.startswith(("https://", "http://")):
            raise MenuSchemaError(f"{path}.url must start with http:// or https://.")
        return WebhookAction.model_validate(raw)
    if t == "handoff_llm":
        return HandoffLlmAction.model_validate(raw)
    raise MenuSchemaError(f"Unsupported action type {t!r} at {path}.")


def _validate_fallback_dict(raw: dict[str, Any], path: str) -> FallbackAction:
    t = raw.get("type")
    if t == "end_call":
        return FallbackEndCall.model_validate(raw)
    if t == "goto":
        return FallbackGoto.model_validate(raw)
    if t == "transfer":
        if not str(raw.get("target") or "").strip():
            raise MenuSchemaError(f"{path}.target cannot be blank.")
        return FallbackTransfer.model_validate(raw)
    if t == "handoff_llm":
        return FallbackHandoffLlm.model_validate(raw)
    raise MenuSchemaError(f"Unsupported fallback action type {t!r} at {path}.")


def _assert_fallback_target(
    action: FallbackAction | None,
    nodes: dict[str, MenuNode],
    path: str,
) -> None:
    if isinstance(action, FallbackGoto) and action.target not in nodes:
        raise MenuSchemaError(f"{path}.target references unknown node {action.target!r}.")


def _assert_action_targets(
    action: MenuAction,
    nodes: dict[str, MenuNode],
    path: str,
) -> None:
    if isinstance(action, GotoAction) and action.target not in nodes:
        raise MenuSchemaError(f"{path}.target references unknown node {action.target!r}.")
    if isinstance(action, WebhookAction):
        if isinstance(action.next, GotoAction) and action.next.target not in nodes:
            raise MenuSchemaError(
                f"{path}.next.target references unknown node {action.next.target!r}."
            )
        _assert_fallback_target(action.onFailure, nodes, f"{path}.onFailure")
