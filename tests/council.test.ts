import { afterEach, describe, expect, it } from "vitest";
import {
  chairTask,
  councilMembers,
  debateTask,
  isModelResolutionError,
  parseCouncilArgs,
  resolveModelSpec,
  type CatalogModel,
} from "../extensions/council/members.ts";
import {
  buildReport,
  buildTranscript,
  extractScore,
  memberScore,
  scoreLine,
  type MemberOutcome,
} from "../extensions/council/report.ts";
import { runCouncilChild } from "../extensions/council/run.ts";

const CATALOG: CatalogModel[] = [
  { provider: "anthropic", id: "claude-opus-4-5" },
  { provider: "anthropic", id: "claude-opus-4-8" },
  { provider: "anthropic", id: "claude-opus-5" },
  { provider: "anthropic", id: "claude-sonnet-4-5" },
  { provider: "anthropic", id: "claude-sonnet-5" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "openai-codex", id: "gpt-5.6-sol" },
  { provider: "openai-codex", id: "gpt-5.5" },
];

function resolved(spec: string) {
  const result = resolveModelSpec(spec, CATALOG);
  if (isModelResolutionError(result)) throw new Error(`expected a match for ${spec}: ${result.error}`);
  return result;
}

describe("council model specs", () => {
  it("resolves a glued thinking suffix like opus5max", () => {
    expect(resolved("opus5max")).toEqual({
      model: "anthropic/claude-opus-5",
      thinking: "max",
      thinkingExplicit: true,
    });
  });

  it("does not confuse opus5 with opus-4-5", () => {
    expect(resolved("opus5").model).toBe("anthropic/claude-opus-5");
    expect(resolved("sonnet5").model).toBe("anthropic/claude-sonnet-5");
  });

  it("defaults the thinking level when none is given", () => {
    expect(resolved("opus5")).toMatchObject({ thinking: "high", thinkingExplicit: false });
  });

  it("accepts colon syntax and full provider ids", () => {
    expect(resolved("opus5:xhigh")).toMatchObject({
      model: "anthropic/claude-opus-5",
      thinking: "xhigh",
      thinkingExplicit: true,
    });
    expect(resolved("anthropic/claude-opus-4-8").model).toBe("anthropic/claude-opus-4-8");
    expect(resolved("sol").model).toBe("openai-codex/gpt-5.6-sol");
  });

  it("reports ambiguity with candidates instead of guessing", () => {
    const result = resolveModelSpec("opus", CATALOG);
    if (!isModelResolutionError(result)) throw new Error("expected an ambiguity error");
    expect(result.candidates).toContain("anthropic/claude-opus-5");
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it("rejects unknown models and invalid thinking levels", () => {
    expect(isModelResolutionError(resolveModelSpec("gemini9", CATALOG))).toBe(true);
    const bad = resolveModelSpec("opus5:turbo", CATALOG);
    expect(isModelResolutionError(bad) && bad.error).toContain("thinking level");
  });
});

describe("council argument parsing", () => {
  it("splits the model from the idea", () => {
    const parsed = parseCouncilArgs("opus5max should I start a bakery in Vienna?");
    expect(parsed.firstToken).toBe("opus5max");
    expect(parsed.rest).toBe("should I start a bakery in Vienna?");
    expect(parsed.rounds).toBe(2);
    expect(parsed.web).toBe(true);
  });

  it("reads flags anywhere in the line and keeps the idea intact", () => {
    const parsed = parseCouncilArgs("sonnet5 --no-web launch a paid --rounds 3 newsletter");
    expect(parsed.rest).toBe("launch a paid newsletter");
    expect(parsed.rounds).toBe(3);
    expect(parsed.web).toBe(false);
    expect(parsed.webExplicit).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it("supports --quick and --rounds=N", () => {
    expect(parseCouncilArgs("opus5 --quick idea here").rounds).toBe(1);
    expect(parseCouncilArgs("opus5 --rounds=1 idea here").rounds).toBe(1);
  });

  it("rejects bad options and out-of-range rounds", () => {
    expect(parseCouncilArgs("opus5 --rounds 9 idea").errors).toHaveLength(1);
    expect(parseCouncilArgs("opus5 --turbo idea").errors[0]).toContain("--turbo");
  });

  it("recognises the bare subcommands only on their own", () => {
    expect(parseCouncilArgs("models").subcommand).toBe("models");
    expect(parseCouncilArgs("help").subcommand).toBe("help");
    expect(parseCouncilArgs("help me price my app").subcommand).toBeUndefined();
  });
});

describe("council members", () => {
  it("seats four distinct personas", () => {
    const members = councilMembers(true);
    expect(members.map((member) => member.id)).toEqual(["optimist", "pessimist", "money", "realist"]);
    for (const member of members) expect(member.systemPrompt).toContain("score: N/10");
  });

  it("swaps the tool rules with the web setting", () => {
    expect(councilMembers(true)[0]!.systemPrompt).toContain("web search");
    expect(councilMembers(false)[0]!.systemPrompt).toContain("no tools and no internet");
  });

  it("gives a debating member the other three positions and its own name", () => {
    const [optimist, skeptic, cfo] = councilMembers(false);
    const task = debateTask("sell socks online", optimist!, [
      { member: skeptic!, text: "too crowded" },
      { member: cfo!, text: "margins are thin" },
    ]);
    expect(task).toContain("sell socks online");
    expect(task).toContain("The Skeptic");
    expect(task).toContain("margins are thin");
    expect(task).toContain("You are The Optimist");
  });

  it("hands the chair the idea and the transcript", () => {
    const task = chairTask("sell socks online", "## Opening positions\n### The Optimist\nfine");
    expect(task).toContain("sell socks online");
    expect(task).toContain("The Optimist");
  });
});

describe("council child guard", () => {
  const previous = process.env.PI_COUNCIL_MEMBER;

  afterEach(() => {
    if (previous === undefined) delete process.env.PI_COUNCIL_MEMBER;
    else process.env.PI_COUNCIL_MEMBER = previous;
  });

  it("refuses to spawn anything from inside a council member", async () => {
    process.env.PI_COUNCIL_MEMBER = "1";
    const result = await runCouncilChild({
      cwd: process.cwd(),
      model: "anthropic/claude-haiku-4-5",
      thinking: "low",
      systemPrompt: "unused",
      task: "unused",
      timeoutMs: 1_000,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("nested council child");
    expect(result.durationMs).toBe(0);
  });
});

function outcome(name: string, rounds: string[], failures: string[] = []): MemberOutcome {
  const member = councilMembers(false).find((entry) => entry.shortName === name);
  if (!member) throw new Error(`unknown member ${name}`);
  return { member, rounds, failures, searches: 0 };
}

describe("council report", () => {
  it("takes the most recent score a member stated", () => {
    expect(extractScore("score: 7/10 ... updated score: 4/10")).toBe(4);
    expect(extractScore("score = 8.5 / 10")).toBe(8.5);
    expect(extractScore("no verdict here")).toBeUndefined();
    expect(memberScore(outcome("Optimist", ["score: 9/10", "no number this time"]))).toBe(9);
  });

  it("averages the council and names each member", () => {
    const line = scoreLine([
      outcome("Optimist", ["score: 8/10"]),
      outcome("Skeptic", ["score: 4/10"]),
    ]);
    expect(line).toContain("6.0/10");
    expect(line).toContain("Optimist 8");
    expect(line).toContain("Skeptic 4");
  });

  it("puts the chair first and the debate below, and surfaces failures", () => {
    const report = buildReport({
      idea: "sell socks online",
      model: "anthropic/claude-opus-5",
      thinking: "max",
      rounds: 2,
      web: true,
      chair: "## Verdict\n**Smart, but only if…**",
      members: [
        outcome("Optimist", ["score: 8/10", "still score: 7/10"]),
        outcome("Skeptic", ["score: 3/10"], ["round 2 failed — timed out after 480s"]),
      ],
      costUsd: 1.234,
      durationMs: 65_000,
      notes: [],
    });
    const verdictAt = report.markdown.indexOf("**Smart, but only if…**");
    const openingAt = report.markdown.indexOf("## Opening positions");
    expect(verdictAt).toBeGreaterThan(-1);
    expect(openingAt).toBeGreaterThan(verdictAt);
    expect(report.markdown).toContain("## Rebuttals");
    expect(report.markdown).toContain("$1.234");
    expect(report.markdown).toContain("Skeptic: round 2 failed");
    expect(report.scores).toContain("/10");
  });

  it("builds a transcript that only includes rounds that happened", () => {
    const transcript = buildTranscript([outcome("Optimist", ["opening only"])], 2);
    expect(transcript).toContain("## Opening positions");
    expect(transcript).not.toContain("## Rebuttals");
  });
});
