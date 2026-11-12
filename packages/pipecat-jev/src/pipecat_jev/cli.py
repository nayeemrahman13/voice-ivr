"""Non-interactive `jev-ivr` CLI for coding agents and CI."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from .client import JevClient, JevClientError
from .evaluator import evaluate_menu_graph
from .schema import MenuSchemaError, load_v2_json_schema, parse_menu_graph
from .validator import validate_menu_graph


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jev-ivr",
        description="Validate and evaluate canonical v2 deterministic IVR graphs against TypeSafe Jev.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    schema_p = sub.add_parser("schema", help="Print the canonical v2 menu.json JSON Schema.")
    schema_p.add_argument("--compact", action="store_true", help="Print single-line JSON.")

    val_p = sub.add_parser("validate", help="Validate schema, graph integrity, and voice-UX rules.")
    val_p.add_argument("menu_file", type=Path, help="Path to .menu.json file.")
    val_p.add_argument("--json", action="store_true", dest="as_json", help="Emit JSON output.")
    val_p.add_argument(
        "--strict",
        action="store_true",
        help="Treat UX/eval warnings as non-zero exit errors.",
    )

    eval_p = sub.add_parser(
        "eval",
        help="Run menu evals[] against TypeSafe Jev (/v1/systemone) using runtime threshold rules.",
    )
    eval_p.add_argument("menu_file", type=Path, help="Path to .menu.json file.")
    eval_p.add_argument(
        "--split",
        choices=["all", "tune", "holdout"],
        default="all",
        help="Which eval split to run (default: all).",
    )
    eval_p.add_argument("--node", default=None, help="Filter evals to a single node ID.")
    eval_p.add_argument(
        "--concurrency",
        type=int,
        default=8,
        help="Max concurrent Jev HTTP requests (default: 8).",
    )
    eval_p.add_argument(
        "--model",
        default="jev-latest",
        help="TypeSafe model name or alias (default: jev-latest).",
    )
    eval_p.add_argument(
        "--allow-partial-coverage",
        action="store_true",
        help="Allow running a subset without requiring every option + unclear to be covered.",
    )
    eval_p.add_argument("--json", action="store_true", dest="as_json", help="Emit JSON output.")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "schema":
        schema = load_v2_json_schema()
        if args.compact:
            print(json.dumps(schema))
        else:
            print(json.dumps(schema, indent=2))
        return 0

    if args.command == "validate":
        return _cmd_validate(args.menu_file, as_json=args.as_json, strict=args.strict)

    if args.command == "eval":
        return asyncio.run(
            _cmd_eval(
                args.menu_file,
                split=args.split,
                node_filter=args.node,
                concurrency=args.concurrency,
                model=args.model,
                allow_partial=args.allow_partial_coverage,
                as_json=args.as_json,
            )
        )

    return 1


def _cmd_validate(menu_file: Path, *, as_json: bool, strict: bool) -> int:
    try:
        raw = json.loads(menu_file.read_text(encoding="utf-8"))
        graph = parse_menu_graph(raw)
    except (OSError, json.JSONDecodeError, MenuSchemaError) as exc:
        payload = {
            "valid": False,
            "errors": [{"code": "schema_error", "path": "root", "message": str(exc)}],
            "warnings": [],
        }
        if as_json:
            print(json.dumps(payload, indent=2))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    report = validate_menu_graph(graph)
    ok = report.valid and (not strict or len(report.warnings) == 0)

    if as_json:
        out = report.to_dict()
        out["valid"] = ok
        out["menu_id"] = graph.id
        out["node_count"] = len(graph.nodes)
        print(json.dumps(out, indent=2))
    else:
        status = "VALID" if ok else "INVALID"
        print(f"{status}: {graph.name or graph.id} ({len(graph.nodes)} nodes)")
        for err in report.errors:
            print(f"  [error] {err.path}: {err.message}")
        for warn in report.warnings:
            print(f"  [warn]  {warn.path}: {warn.message}")

    return 0 if ok else 1


async def _cmd_eval(
    menu_file: Path,
    *,
    split: str,
    node_filter: str | None,
    concurrency: int,
    model: str,
    allow_partial: bool,
    as_json: bool,
) -> int:
    try:
        raw = json.loads(menu_file.read_text(encoding="utf-8"))
        graph = parse_menu_graph(raw)
    except (OSError, json.JSONDecodeError, MenuSchemaError) as exc:
        if as_json:
            print(json.dumps({"ok": False, "error": str(exc)}, indent=2))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    val_report = validate_menu_graph(graph)
    if not val_report.valid:
        if as_json:
            print(json.dumps({"ok": False, "validation": val_report.to_dict()}, indent=2))
        else:
            for err in val_report.errors:
                print(f"ERROR [{err.path}]: {err.message}", file=sys.stderr)
        return 1

    api_key = (os.environ.get("TYPESAFE_API_KEY") or os.environ.get("JEV_API_KEY") or "").strip()
    if not api_key:
        msg = "TYPESAFE_API_KEY is not set in the environment."
        if as_json:
            print(json.dumps({"ok": False, "error": msg}, indent=2))
        else:
            print(f"ERROR: {msg}", file=sys.stderr)
        return 1

    client = JevClient(api_key, model=model)
    try:
        summary = await evaluate_menu_graph(
            graph=graph,
            client=client,
            split=split,  # type: ignore[arg-type]
            node_filter=node_filter,
            concurrency=concurrency,
            require_full_coverage=not allow_partial,
        )
    except JevClientError as exc:
        if as_json:
            print(json.dumps({"ok": False, "error": str(exc)}, indent=2))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        await client.aclose()

    if as_json:
        print(json.dumps(summary.to_dict(), indent=2))
    else:
        print(
            f"Eval [{summary.split}] model={summary.resolved_model}: "
            f"{summary.passed}/{summary.total} passed ({summary.pass_rate * 100:.1f}%)"
        )
        for cov in summary.coverage_errors:
            print(f"  [coverage] {cov}")
        for fail in summary.failures:
            rival = (
                f" (collided with {fail.collision_with}, margin={fail.margin:+.2f})"
                if fail.collision_with and fail.margin is not None
                else ""
            )
            print(
                f"  [FAIL] node={fail.node} say={fail.say!r}: "
                f"expected={fail.expected} actual={fail.actual} conf={fail.confidence:.2f}{rival}"
            )

    return 0 if summary.ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
