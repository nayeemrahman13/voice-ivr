import json
import subprocess
import sys
import venv
from pathlib import Path

import httpx
import pytest

from pipecat_jev.client import JevClient
from pipecat_jev.evaluator import evaluate_menu_graph
from pipecat_jev.schema import MenuEvalCase, parse_menu_graph

FIXTURES = Path(__file__).resolve().parents[3] / "schemas" / "fixtures"
ROOT = Path(__file__).resolve().parents[1]


def graph():
    return parse_menu_graph(json.loads((FIXTURES / "valid" / "secondary_questions.json").read_text()))


@pytest.mark.asyncio
async def test_client_retries_503_and_preserves_unresolved_extracted_fact():
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(503, json={"message": "retry"})
        return httpx.Response(200, json={"model": "served-model", "answers": {
            "option": {"choice": "help", "confidence": 0.9},
            "eligible": {"noul": 0.5}, "department": {"choice": "billing", "confidence": 0.9},
        }})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    jev = JevClient("key", http_client=client, max_retries=1)
    result = await jev.classify_turn(graph=graph(), node_id="main", turn="help", extracted={"old": True})
    await client.aclose()
    assert calls == 2
    assert result.resolved_model == "served-model"
    assert result.secondary_answers["eligible"].value is None
    assert result.step.extracted["old"] is True
    assert result.step.extracted["department"] == "billing"


@pytest.mark.asyncio
async def test_evaluator_reports_split_model_hash_coverage_and_margin():
    g = graph()
    g.evals = [MenuEvalCase.model_validate(item) for item in [
        {"split": "tune", "node": "main", "say": "help", "expect": "help"},
        {"split": "tune", "node": "main", "say": "other", "expect": "other"},
        {"split": "holdout", "node": "main", "say": "else", "expect": "unclear"},
    ]]
    seen = []
    def handler(request):
        payload = json.loads(request.content)
        seen.append(payload["state"]["turn"])
        turn = payload["state"]["turn"]
        choice = "help" if turn == "help" else "other" if turn == "other" else "unclear"
        return httpx.Response(200, json={"model": "fake-model", "answers": {"option": {"choice": choice, "confidence": 0.99, "probabilities": {choice: 0.99, "help": 0.01}}}})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    jev = JevClient("key", http_client=client)
    report = await evaluate_menu_graph(graph=g, client=jev)
    await client.aclose()
    assert set(seen) == {"help", "other", "else"}
    assert report.resolved_model == "fake-model"
    assert report.menu_sha256
    assert report.total == 3 and report.passed == 3
    assert report.failures == []


@pytest.mark.parametrize("command,expected", [("schema", 0), ("validate", 0)])
def test_cli_success_exit_codes(command, expected):
    fixture = FIXTURES / "valid" / "pure_ivr.json"
    args = [sys.executable, "-m", "pipecat_jev.cli", command]
    if command == "validate":
        args.append(str(fixture))
    result = subprocess.run(args, check=False, cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == expected, result.stderr


def test_cli_invalid_and_bad_usage_exit_codes(tmp_path):
    bad = FIXTURES / "invalid" / "unsupported_version.json"
    invalid = subprocess.run([sys.executable, "-m", "pipecat_jev.cli", "validate", str(bad), "--json"], check=False, cwd=ROOT, capture_output=True, text=True)
    assert invalid.returncode == 1
    usage = subprocess.run([sys.executable, "-m", "pipecat_jev.cli", "validate"], check=False, cwd=ROOT, capture_output=True, text=True)
    assert usage.returncode == 2


def test_built_wheel_bundles_schema_and_cli_runs_outside_repo(tmp_path):
    dist = tmp_path / "dist"
    built = subprocess.run(["uv", "build", "--wheel", "--out-dir", str(dist)], check=False, cwd=ROOT, capture_output=True, text=True)
    assert built.returncode == 0, built.stderr
    wheel = next(dist.glob("*.whl"))
    env = tmp_path / "venv"
    venv.EnvBuilder(with_pip=True).create(env)
    python = env / "bin" / "python"
    scripts = env / "bin"
    install = subprocess.run([str(python), "-m", "pip", "install", str(wheel)], check=False, capture_output=True, text=True)
    assert install.returncode == 0, install.stderr
    schema = subprocess.run([str(scripts / "jev-ivr"), "schema"], check=False, cwd=tmp_path, capture_output=True, text=True)
    assert schema.returncode == 0, schema.stderr
    assert '"$schema"' in schema.stdout
    fixture = FIXTURES / "valid" / "pure_ivr.json"
    validated = subprocess.run([str(scripts / "jev-ivr"), "validate", str(fixture)], check=False, cwd=tmp_path, capture_output=True, text=True)
    assert validated.returncode == 0, validated.stderr


@pytest.mark.asyncio
async def test_evaluator_split_filter_coverage_and_collision_margin():
    g = graph()

    g.evals = [
        MenuEvalCase.model_validate({"split": "tune", "node": "main", "say": "help", "expect": "help"}),
        MenuEvalCase.model_validate({"split": "holdout", "node": "main", "say": "other", "expect": "other"}),
    ]

    def handler(request):
        return httpx.Response(200, json={"answers": {"option": {
            "choice": "other", "confidence": 0.8,
            "probabilities": {"other": 0.6, "help": 0.4},
        }}})

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = JevClient("key", http_client=http_client)
    tune = await evaluate_menu_graph(graph=g, client=client, split="tune", require_full_coverage=False)
    assert tune.total == 1 and tune.split == "tune"
    failure = tune.failures[0]
    assert failure.collision_with == "other"
    assert failure.margin == -0.2
    missing = await evaluate_menu_graph(graph=g, client=client, split="holdout", require_full_coverage=True)
    assert missing.coverage_errors
    await http_client.aclose()


def test_cli_eval_missing_credentials_returns_failure_code(tmp_path, monkeypatch):
    from pipecat_jev.cli import main

    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.delenv("JEV_API_KEY", raising=False)
    menu_file = tmp_path / "menu.json"
    menu_file.write_text((FIXTURES / "valid" / "pure_ivr.json").read_text(), encoding="utf-8")
    assert main(["eval", str(menu_file), "--json"]) == 1


@pytest.mark.parametrize("incorrect,expected_code", [(False, 0), (True, 2)])
def test_cli_eval_exit_codes_with_stubbed_jev_client(tmp_path, monkeypatch, capsys, incorrect, expected_code):
    from pipecat_jev import cli
    from pipecat_jev.client import parse_jev_payload

    raw = json.loads((FIXTURES / "valid" / "pure_ivr.json").read_text())
    raw["evals"] = [
        {"split": "tune", "node": "main", "say": "case-help", "expect": "help"},
        {"split": "tune", "node": "main", "say": "case-other", "expect": "other"},
        {"split": "tune", "node": "main", "say": "case-unclear", "expect": "unclear"},
    ]
    menu_file = tmp_path / "cli-eval-menu.json"
    menu_file.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-key")

    class StubJevClient:
        def __init__(self, _api_key, *, model):
            self.model = model

        async def classify_turn(self, *, graph, node_id, stack, turn, history):
            choice = "help" if "help" in turn else "other" if "other" in turn else "unclear"
            if incorrect and turn == "case-help":
                choice = "other"
            confidence = 0.0 if choice == "unclear" else 0.99
            return parse_jev_payload(
                payload={"model": "cli-stub", "answers": {"option": {"choice": choice, "confidence": confidence}}},
                graph=graph,
                node_id=node_id,
                stack=stack,
                latency_ms=0.1,
            )

        async def aclose(self):
            return None

    monkeypatch.setattr(cli, "JevClient", StubJevClient)
    result = cli.main(["eval", str(menu_file), "--json"])
    output = json.loads(capsys.readouterr().out)
    assert result == expected_code
    assert output["ok"] is (expected_code == 0)
