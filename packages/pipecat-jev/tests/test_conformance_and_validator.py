import json
from pathlib import Path

import pytest

from pipecat_jev.schema import MenuSchemaError, parse_menu_graph
from pipecat_jev.validator import validate_menu_graph

FIXTURES = Path(__file__).resolve().parents[3] / "schemas" / "fixtures"


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_shared_valid_v2_fixtures_parse():
    for path in sorted((FIXTURES / "valid").glob("*.json")):
        parse_menu_graph(read(path))


def test_shared_invalid_v2_fixtures_reject():
    for path in sorted((FIXTURES / "invalid").glob("*.json")):
        with pytest.raises(MenuSchemaError, match="."):
            parse_menu_graph(read(path))


def test_v1_migrations_match_canonical_fixtures():
    for path in sorted((FIXTURES / "v1-migration").glob("*.json")):
        if path.name.endswith(".expected.json"):
            continue
        actual = parse_menu_graph(read(path)).model_dump(exclude_none=True)
        expected = read(path.with_name(path.stem + ".expected.json"))
        assert actual == expected, path.name


def test_validator_reports_orphans_trapped_cycles_and_voice_ux_warnings():
    graph = parse_menu_graph(read(FIXTURES / "valid" / "pure_ivr.json"))
    graph.nodes["orphan"] = graph.nodes["main"].model_copy(update={"id": "orphan", "name": "Orphan"})
    report = validate_menu_graph(graph)
    assert any(issue.code == "orphan_node" for issue in report.errors)

    cycle = parse_menu_graph(read(FIXTURES / "valid" / "pure_ivr.json"))
    cycle.nodes["main"].options = [
        option.model_copy(update={"action": {"type": "goto", "target": "main"}})
        for option in cycle.nodes["main"].options
    ]
    assert any(issue.code == "trapped_cycle" for issue in validate_menu_graph(cycle).errors)

    ux = parse_menu_graph(read(FIXTURES / "valid" / "pure_ivr.json"))
    ux.nodes["main"].options[0].hints = ""
    codes = {issue.code for issue in validate_menu_graph(ux).warnings}
    assert "empty_hints" in codes
    assert "no_evals" in codes


def test_fallback_goto_provides_cycle_exit():
    graph = parse_menu_graph(read(FIXTURES / "valid" / "pure_ivr.json"))
    from pipecat_jev.schema import EndCallAction, FallbackGoto, GotoAction, MenuNode

    graph.nodes["main"].options = [
        option.model_copy(update={"action": GotoAction(target="main")})
        for option in graph.nodes["main"].options
    ]
    graph.nodes["billing"] = MenuNode(
        id="billing", name="Billing", script="Billing.",
        options=[{"id": "done", "title": "Done", "hints": "finish", "reply": "Done.", "action": EndCallAction()}],
    )
    graph.fallbackAction = FallbackGoto(target="billing")
    report = validate_menu_graph(graph)
    assert not any(issue.code == "trapped_cycle" for issue in report.errors)
