import {
  Activity,
  Archive,
  ArchiveX,
  Beaker,
  CircleHelp,
  CircleX,
  Clock3,
  FileCheck2,
  FileQuestion,
  FileX2,
  GitCompareArrows,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  type LucideIcon,
} from "lucide-react";

import type { SpineNode } from "./types";

export type EvidenceNodeTone = "good" | "bad" | "warn" | "neutral";

type EvidenceNodeIconDefinition = {
  key: string;
  icon: LucideIcon;
};

const defaultIconByKind = {
  run: { key: "activity", icon: Activity },
  gate: { key: "shield-check", icon: ShieldCheck },
  iteration: { key: "git-compare-arrows", icon: GitCompareArrows },
  case: { key: "beaker", icon: Beaker },
  assertion: { key: "file-check", icon: FileCheck2 },
  artifact: { key: "archive", icon: Archive },
} satisfies Record<SpineNode["kind"], EvidenceNodeIconDefinition>;

const failedIconByKind = {
  run: { key: "circle-x", icon: CircleX },
  gate: { key: "shield-x", icon: ShieldX },
  iteration: { key: "circle-x", icon: CircleX },
  case: { key: "circle-x", icon: CircleX },
  assertion: { key: "file-x", icon: FileX2 },
  artifact: { key: "archive-x", icon: ArchiveX },
} satisfies Record<SpineNode["kind"], EvidenceNodeIconDefinition>;

const pendingIconByKind = {
  run: { key: "clock", icon: Clock3 },
  gate: { key: "shield-question", icon: ShieldQuestion },
  iteration: { key: "circle-help", icon: CircleHelp },
  case: { key: "circle-help", icon: CircleHelp },
  assertion: { key: "file-question", icon: FileQuestion },
  artifact: { key: "circle-help", icon: CircleHelp },
} satisfies Record<SpineNode["kind"], EvidenceNodeIconDefinition>;

export function resolveEvidenceNodeIcon(
  kind: SpineNode["kind"],
  tone: EvidenceNodeTone,
): EvidenceNodeIconDefinition {
  if (tone === "bad") return failedIconByKind[kind];
  if (tone === "warn") return pendingIconByKind[kind];
  return defaultIconByKind[kind];
}

export function EvidenceNodeIcon({
  kind,
  tone,
}: {
  kind: SpineNode["kind"];
  tone: EvidenceNodeTone;
}) {
  const definition = resolveEvidenceNodeIcon(kind, tone);
  const Icon = definition.icon;

  return (
    <span
      className="node-icon"
      data-evidence-icon={definition.key}
      data-evidence-icon-state={tone}
      aria-hidden="true"
    >
      <Icon size={16} strokeWidth={tone === "bad" ? 2.2 : 1.8} />
    </span>
  );
}
