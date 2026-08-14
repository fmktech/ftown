"use client";

import { useState } from "react";
import type { FactoryPaneProps } from "./types";
import { factoryKey } from "./types";
import { useFactory } from "./useFactory";
import { FactoryBoard } from "./FactoryBoard";
import { SkillEditor } from "./SkillEditor";
import { FactoryRuns } from "./FactoryRuns";
import { NewTicketForm } from "./NewTicketForm";

type FactoryTab = "board" | "skills" | "runs";

const TABS: { id: FactoryTab; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "skills", label: "Skills" },
  { id: "runs", label: "Runs" },
];

export function FactoryPane({ factory, bridgeExec, sessions, onOpenSession }: FactoryPaneProps) {
  const [tab, setTab] = useState<FactoryTab>("board");
  const [showNewTicket, setShowNewTicket] = useState(false);
  const {
    snapshot,
    error,
    loading,
    refresh,
    showTicket,
    listTicketArtifacts,
    readTicketArtifact,
    stopTicket,
    requeueTicket,
    listSkills,
    readSkill,
    writeSkill,
    createTicket,
  } = useFactory(factory, bridgeExec);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex items-center gap-3"
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <span aria-hidden style={{ fontSize: 14 }}>
          🏭
        </span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
            whiteSpace: "nowrap",
          }}
        >
          {factory.project}
        </span>
        <span
          title={factory.repoRoot}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-faint)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {factory.repoRoot}
        </span>
        <div
          role="tablist"
          aria-label="Factory sections"
          className="flex items-center"
          style={{
            flexShrink: 0,
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                style={{
                  padding: "4px 12px",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                  border: "none",
                  background: active ? "var(--bg-elevated)" : "transparent",
                  color: active ? "var(--text-primary)" : "var(--text-faint)",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setShowNewTicket(true)}
          disabled={snapshot === null}
          style={{
            flexShrink: 0,
            padding: "4px 10px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--text-faint)",
            opacity: snapshot === null ? 0.5 : 1,
          }}
        >
          ＋ Ticket
        </button>
      </div>

      {showNewTicket && (
        <NewTicketForm
          stages={snapshot?.stages ?? []}
          onCreate={createTicket}
          onClose={() => setShowNewTicket(false)}
        />
      )}

      <div className={tab === "board" ? "flex-1 min-h-0 overflow-hidden" : "hidden"}>
        <FactoryBoard
          factoryIdentity={factoryKey(factory)}
          snapshot={snapshot}
          error={error}
          loading={loading}
          onRefresh={refresh}
          showTicket={showTicket}
          listTicketArtifacts={listTicketArtifacts}
          readTicketArtifact={readTicketArtifact}
          stopTicket={stopTicket}
          requeueTicket={requeueTicket}
        />
      </div>
      <div className={tab === "skills" ? "flex-1 min-h-0 overflow-hidden" : "hidden"}>
        <SkillEditor listSkills={listSkills} readSkill={readSkill} writeSkill={writeSkill} />
      </div>
      <div className={tab === "runs" ? "flex-1 min-h-0 overflow-hidden" : "hidden"}>
        <FactoryRuns factory={factory} sessions={sessions} onOpenSession={onOpenSession} />
      </div>
    </div>
  );
}
