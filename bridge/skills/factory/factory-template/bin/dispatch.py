#!/usr/bin/env python3
"""No-LLM factory dispatcher — one tick per invocation, then exit.

Run by an ftown interval loop from a deployed project's repo root:

    uv run --with fticket,pyyaml python factory/bin/dispatch.py [--dry-run]

Responsibilities in a single tick: run the fticket scheduler, dead-letter stragglers,
claim queued tickets up to capacity and spawn one worker session per claim, and forward
dead-letter/orphan events to the operator session. All coordination is server-side and
atomic (claims fence), so two dispatchers may race safely with no lockfile.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
import traceback
import uuid
from dataclasses import dataclass
from pathlib import Path

import yaml

from fticket import FTS
from fticket.errors import FTSError
from fticket.types import EventType, Status

# The ftown spawn CLI. Overridable (a test may point it at a stub script).
FTOWN_CLI = str(Path("~/.ftown/ftown-sessions").expanduser())

TERMINAL_STATUSES = (Status.DONE, Status.DEAD_LETTER)
FORWARD_EVENTS = (EventType.TICKET_DEAD_LETTER, EventType.TICKET_ORPHANED)
CURSOR_FILE = Path(".ffactory") / "dispatch.cursor"
DEAD_LETTER_ACTOR = "dispatcher"


@dataclass(frozen=True, slots=True)
class StageCfg:
    name: str
    harness: str
    model: str | None
    max_workers: int
    next: str
    bounce: str
    claim_ttl_ms: int | None


@dataclass(frozen=True, slots=True)
class Limits:
    max_sessions: int
    bounce_limit: int
    claim_ttl_ms: int
    max_ticket_age_h: int


@dataclass(frozen=True, slots=True)
class FactoryConfig:
    project: str
    operator_session: str
    limits: Limits
    stages: tuple[StageCfg, ...]


def load_config(yaml_path: Path) -> FactoryConfig:
    raw = yaml.safe_load(yaml_path.read_text())
    limits_raw = raw.get("limits", {})
    limits = Limits(
        max_sessions=int(limits_raw.get("max_sessions", 1)),
        bounce_limit=int(limits_raw.get("bounce_limit", 3)),
        claim_ttl_ms=int(limits_raw.get("claim_ttl_ms", 1_800_000)),
        max_ticket_age_h=int(limits_raw.get("max_ticket_age_h", 48)),
    )
    stages = tuple(
        StageCfg(
            name=str(s["name"]),
            harness=str(s["harness"]),
            model=(str(s["model"]) if s.get("model") else None),
            max_workers=int(s.get("max_workers", 1)),
            next=str(s.get("next", "-")),
            bounce=str(s.get("bounce", "-")),
            claim_ttl_ms=(int(s["claim_ttl_ms"]) if s.get("claim_ttl_ms") else None),
        )
        for s in raw.get("stages", [])
    )
    return FactoryConfig(
        project=str(raw.get("project", "factory")),
        operator_session=str(raw.get("operator_session", "-")),
        limits=limits,
        stages=stages,
    )


def compose_briefing(
    *,
    ticket_id: int,
    stage: StageCfg,
    db_path: Path,
    ticket_dir: Path,
    repo_root: Path,
    epoch: int,
    worker_id: str,
    operator_session: str,
) -> str:
    lines = [
        f"TICKET_ID={ticket_id}",
        f"STAGE={stage.name}",
        f"NEXT_STAGE={stage.next or '-'}",
        f"BOUNCE_STAGE={stage.bounce or '-'}",
        f"FTS_DB={db_path}",
        f"TICKET_DIR={ticket_dir}",
        f"REPO_ROOT={repo_root}",
        f"EPOCH={epoch}",
        f"WORKER_ID={worker_id}",
        "",
        "Task: Read and follow $REPO_ROOT/factory/skills/_protocol.md, "
        f"then execute your stage per $REPO_ROOT/factory/skills/{stage.name}.md.",
    ]
    if operator_session == "-":
        lines.append(
            "You have no parent session: skip the ftown mail step and end your "
            "final message with the one-line result instead."
        )
    return "\n".join(lines)


def spawn_worker(
    *, cfg: FactoryConfig, stage: StageCfg, ticket_id: int, briefing: str, repo_root: Path
) -> bool:
    """Fire an ftown worker session. Returns True on success; never retries in a tick."""
    cmd: list[str] = [FTOWN_CLI, "create", "--shell", stage.harness]
    if stage.model:
        cmd += ["--model", stage.model]
    cmd += ["--workdir", str(repo_root), "--name", f"{cfg.project}-t{ticket_id}-{stage.name}"]
    if cfg.operator_session != "-":
        cmd += ["--parent-id", cfg.operator_session]
    cmd += ["--prompt", briefing]
    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        print(f"spawn failed for ticket {ticket_id} stage {stage.name}: {detail}", file=sys.stderr)
        return False


def ftown_tell(session_id: str, message: str) -> None:
    cmd = [FTOWN_CLI, "tell", session_id, "--type", "task", message]
    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        print(f"tell failed for session {session_id}: {detail}", file=sys.stderr)


def run_scheduler(fts: FTS) -> tuple[int, int]:
    """Drain the scheduler up to 5 rounds. Returns (requeued, promoted)."""
    requeued = 0
    promoted = 0
    for _ in range(5):
        report = fts.tick()
        requeued += report.claims_expired
        promoted += report.tickets_unblocked
        if not report.more_pending:
            break
    return requeued, promoted


def sweep_stragglers(fts: FTS, cfg: FactoryConfig) -> int:
    """Dead-letter every non-terminal ticket older than max_ticket_age_h. Runs in dry-run too."""
    now_ms = int(time.time() * 1000)
    max_age_ms = cfg.limits.max_ticket_age_h * 3_600_000
    deadlettered = 0
    for node in fts.dag().nodes:
        if node.status in TERMINAL_STATUSES:
            continue
        try:
            ticket = fts.get_ticket(node.id)
        except FTSError as exc:
            print(f"straggler read failed for ticket {node.id}: {exc}", file=sys.stderr)
            continue
        if now_ms - ticket.created_at_ms <= max_age_ms:
            continue
        try:
            fts.dead_letter(ticket.id, actor=DEAD_LETTER_ACTOR, reason="max_ticket_age exceeded")
            deadlettered += 1
        except FTSError as exc:
            print(f"dead_letter failed for ticket {ticket.id}: {exc}", file=sys.stderr)
    return deadlettered


def capacity_spawn(
    fts: FTS, cfg: FactoryConfig, *, repo_root: Path, db_path: Path, dry_run: bool
) -> tuple[list[int], int]:
    """Claim + spawn up to capacity, stages in yaml order. Returns (spawned_ids, active_total)."""
    depths = {d.stage: d for d in fts.board()}

    def active_of(name: str) -> int:
        d = depths.get(name)
        return (d.claimed + d.in_progress + d.blocked) if d is not None else 0

    active_total = sum(active_of(s.name) for s in cfg.stages)
    budget = cfg.limits.max_sessions - active_total
    spawned: list[int] = []

    for stage in cfg.stages:
        free = min(stage.max_workers - active_of(stage.name), budget)
        if free <= 0:
            continue
        ttl = stage.claim_ttl_ms or cfg.limits.claim_ttl_ms

        if dry_run:
            depth = depths.get(stage.name)
            queued = depth.queued if depth is not None else 0
            would = min(free, queued)
            if would > 0:
                print(f"[dry-run] would claim up to {would} ticket(s) in stage {stage.name}")
                budget -= would
            continue

        for _ in range(free):
            worker_id = f"{cfg.project}-{stage.name}-{uuid.uuid4().hex[:8]}"
            try:
                result = fts.claim(stage.name, worker_id, ttl_ms=ttl)
            except FTSError as exc:
                print(f"claim failed for stage {stage.name}: {exc}", file=sys.stderr)
                break
            if result is None:
                break
            ticket = result.ticket
            ticket_dir = (repo_root / ticket.folder_path).resolve()
            briefing = compose_briefing(
                ticket_id=ticket.id,
                stage=stage,
                db_path=db_path,
                ticket_dir=ticket_dir,
                repo_root=repo_root,
                epoch=result.epoch,
                worker_id=worker_id,
                operator_session=cfg.operator_session,
            )
            if spawn_worker(
                cfg=cfg, stage=stage, ticket_id=ticket.id, briefing=briefing, repo_root=repo_root
            ):
                spawned.append(ticket.id)
            budget -= 1
            if budget <= 0:
                break
        if budget <= 0:
            break
    return spawned, active_total


def bridge_events(fts: FTS, cfg: FactoryConfig, *, repo_root: Path, dry_run: bool) -> int:
    """Forward dead-letter/orphan events to the operator; advance the cursor past all events."""
    cursor_path = repo_root / CURSOR_FILE
    try:
        cursor = int(cursor_path.read_text().strip())
    except (OSError, ValueError):
        cursor = 0
    events = fts.poll_events(after_cursor=cursor)
    for ev in events:
        if ev.type not in FORWARD_EVENTS:
            continue
        msg = f"[{cfg.project}] {ev.type} ticket={ev.ticket_id} (cursor {ev.cursor})"
        if dry_run or cfg.operator_session == "-":
            print(f"[event] {msg}")
        else:
            ftown_tell(cfg.operator_session, msg)
    if events and not dry_run:
        cursor_path.write_text(str(events[-1].cursor))
    return len(events)


def run_tick(repo_root: Path, *, dry_run: bool) -> int:
    yaml_path = repo_root / "factory" / "factory.yaml"
    if not yaml_path.is_file():
        print(f"error: {yaml_path} not found (run from the project repo root)", file=sys.stderr)
        return 2
    db_path = (repo_root / ".ffactory" / "factory.db").resolve()
    if not db_path.is_file():
        print(f"error: {db_path} not found (run `factory init` first)", file=sys.stderr)
        return 2

    cfg = load_config(yaml_path)
    fts = FTS(db_path)
    try:
        requeued, promoted = run_scheduler(fts)
        deadlettered = sweep_stragglers(fts, cfg)
        spawned, active_total = capacity_spawn(
            fts, cfg, repo_root=repo_root, db_path=db_path, dry_run=dry_run
        )
        events = bridge_events(fts, cfg, repo_root=repo_root, dry_run=dry_run)
    finally:
        fts.close()

    spawned_str = ",".join(str(i) for i in spawned) if spawned else "0"
    print(
        f"tick: requeued={requeued} promoted={promoted} spawned={spawned_str} "
        f"deadlettered={deadlettered} events={events} "
        f"active={active_total}/{cfg.limits.max_sessions}"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="No-LLM factory dispatcher (one tick).")
    parser.add_argument("--dry-run", action="store_true", help="Never claim or spawn; print plan.")
    args = parser.parse_args()
    repo_root = Path.cwd().resolve()
    try:
        return run_tick(repo_root, dry_run=args.dry_run)
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
