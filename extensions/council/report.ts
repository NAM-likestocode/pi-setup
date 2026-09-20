/** Pure helpers that turn council answers into the report markdown. */

import type { CouncilMember } from "./members.ts";

export interface MemberOutcome {
  member: CouncilMember;
  rounds: string[];
  failures: string[];
  searches: number;
}

export interface ReportInput {
  idea: string;
  model: string;
  thinking: string;
  rounds: number;
  web: boolean;
  chair: string;
  members: MemberOutcome[];
  costUsd: number;
  durationMs: number;
  notes: string[];
}

const ROUND_TITLES = ["Opening positions", "Rebuttals", "Final statements"];

/** Reads the last `score: N/10` a member stated, which is their most recent position. */
export function extractScore(text: string): number | undefined {
  const matches = [...text.matchAll(/score\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*\/\s*10/gi)];
  const last = matches.at(-1);
  if (!last) return undefined;
  const value = Number.parseFloat((last[1] ?? "").replace(",", "."));
  return Number.isFinite(value) ? Math.min(10, Math.max(0, value)) : undefined;
}

export function memberScore(outcome: MemberOutcome): number | undefined {
  for (const text of [...outcome.rounds].reverse()) {
    const score = extractScore(text);
    if (score !== undefined) return score;
  }
  return undefined;
}

export function scoreLine(members: MemberOutcome[]): string {
  const entries = members
    .map((outcome) => ({ name: outcome.member.shortName, score: memberScore(outcome) }))
    .filter((entry): entry is { name: string; score: number } => entry.score !== undefined);
  if (entries.length === 0) return "";
  const average = entries.reduce((sum, entry) => sum + entry.score, 0) / entries.length;
  const detail = entries.map((entry) => `${entry.name} ${entry.score}`).join(" · ");
  return `Council score ${average.toFixed(1)}/10 — ${detail}`;
}

export function headline(input: ReportInput): string {
  const bits = [
    input.model,
    input.thinking,
    `${input.rounds} round${input.rounds === 1 ? "" : "s"}`,
    input.web ? "web on" : "web off",
    `${Math.round(input.durationMs / 1000)}s`,
  ];
  if (input.costUsd > 0) bits.push(`$${input.costUsd.toFixed(3)}`);
  return bits.join(" · ");
}

export function buildReport(input: ReportInput): { markdown: string; scores: string } {
  const scores = scoreLine(input.members);
  const lines: string[] = [];

  lines.push("# Council verdict");
  lines.push("");
  lines.push(`> **Idea:** ${input.idea.replace(/\s+/g, " ").trim()}`);
  lines.push(`> ${headline(input)}`);
  if (scores) lines.push(`> ${scores}`);
  lines.push("");
  lines.push(input.chair.trim() || "_The chair produced no synthesis._");

  for (let round = 0; round < input.rounds; round++) {
    const title = ROUND_TITLES[round] ?? `Round ${round + 1}`;
    const present = input.members.filter((outcome) => outcome.rounds[round]?.trim());
    if (present.length === 0) continue;
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`## ${title}`);
    for (const outcome of present) {
      const score = extractScore(outcome.rounds[round] ?? "");
      const suffix = score === undefined ? "" : ` — ${score}/10`;
      lines.push("");
      lines.push(`### ${outcome.member.glyph} ${outcome.member.name}${suffix}`);
      lines.push("");
      lines.push((outcome.rounds[round] ?? "").trim());
    }
  }

  const problems = [
    ...input.notes,
    ...input.members.flatMap((outcome) =>
      outcome.failures.map((failure) => `${outcome.member.shortName}: ${failure}`),
    ),
  ];
  if (problems.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## Council notes");
    for (const problem of problems) lines.push(`- ${problem}`);
  }

  return { markdown: lines.join("\n"), scores };
}

/** The transcript handed to the chair. */
export function buildTranscript(members: MemberOutcome[], rounds: number): string {
  const lines: string[] = [];
  for (let round = 0; round < rounds; round++) {
    const present = members.filter((outcome) => outcome.rounds[round]?.trim());
    if (present.length === 0) continue;
    lines.push(`## ${ROUND_TITLES[round] ?? `Round ${round + 1}`}`);
    for (const outcome of present) {
      lines.push("");
      lines.push(`### ${outcome.member.name}`);
      lines.push((outcome.rounds[round] ?? "").trim());
      lines.push("");
    }
  }
  return lines.join("\n").trim();
}
