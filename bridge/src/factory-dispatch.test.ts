import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const dispatchPath = fileURLToPath(
  new URL('../skills/factory/factory-template/bin/dispatch.py', import.meta.url),
);

const pipelineDrainProbe = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
import dataclasses
from pathlib import Path

# macOS still ships Python 3.9, while the dispatcher runs under 3.13. Let the
# behavioral probe import the module without weakening its production contract.
real_dataclass = dataclasses.dataclass
dataclasses.dataclass = lambda *args, **kwargs: real_dataclass(
    *args, **{key: value for key, value in kwargs.items() if key != "slots"}
)

fticket = types.ModuleType("fticket")
fticket.FTS = object
errors = types.ModuleType("fticket.errors")
errors.FTSError = type("FTSError", (Exception,), {})
ticket_types = types.ModuleType("fticket.types")

class EventType:
    TICKET_DEAD_LETTER = object()
    TICKET_ORPHANED = object()
    TICKET_CLAIM_EXPIRED = object()
    TICKET_ADVANCED = object()
    TICKET_COMPLETED = object()
    TICKET_REJECTED = object()
    TICKET_RELEASED = object()

class HistoryKind:
    ANNOTATION = object()

class Status:
    DONE = object()
    DEAD_LETTER = object()
    CLAIMED = object()

ticket_types.EventType = EventType
ticket_types.HistoryKind = HistoryKind
ticket_types.Status = Status
yaml = types.ModuleType("yaml")
yaml.safe_load = lambda _text: {}
sys.modules.update({
    "fticket": fticket,
    "fticket.errors": errors,
    "fticket.types": ticket_types,
    "yaml": yaml,
})

spec = importlib.util.spec_from_file_location("factory_dispatch", sys.argv[1])
dispatch = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = dispatch
spec.loader.exec_module(dispatch)

claims = []
spawned = []

class FakeFTS:
    def board(self):
        return [
            types.SimpleNamespace(stage="rca", queued=1, claimed=0, in_progress=0, blocked=0),
            types.SimpleNamespace(stage="fix", queued=1, claimed=0, in_progress=0, blocked=0),
        ]

    def claim(self, stage, _worker_id, *, ttl_ms):
        claims.append(stage)
        ticket_id = 1 if stage == "rca" else 2
        return types.SimpleNamespace(
            ticket=types.SimpleNamespace(id=ticket_id, folder_path=f".ffactory/tickets/{ticket_id}"),
            epoch=1,
        )

    def get_history(self, _ticket_id):
        return []

dispatch.spawn_worker = lambda **kwargs: spawned.append(kwargs["ticket_id"]) or "session-id"

stages = (
    dispatch.StageCfg("rca", "codex", None, 1, "fix", "-", None),
    dispatch.StageCfg("fix", "codex", None, 1, "-", "rca", None),
)
cfg = dispatch.FactoryConfig(
    "project",
    "-",
    dispatch.Limits(1, 3, 1_800_000, 48),
    stages,
)

with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp)
    request = repo / ".ffactory" / "tickets" / "1" / "request.md"
    request.parent.mkdir(parents=True)
    request.write_text("bug report")
    result = dispatch.capacity_spawn(
        FakeFTS(), cfg, {}, repo_root=repo, db_path=repo / ".ffactory" / "factory.db", dry_run=False
    )

print(json.dumps({"claims": claims, "spawned": spawned, "result": result[0]}))
`;

describe('factory dispatcher', () => {
  it('drains a later pipeline stage before admitting another entry-stage ticket', () => {
    const probe = spawnSync('python3', ['-c', pipelineDrainProbe, dispatchPath], {
      encoding: 'utf8',
    });

    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), {
      claims: ['fix'],
      spawned: [2],
      result: [2],
    });
  });
});
