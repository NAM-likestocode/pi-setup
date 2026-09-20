/**
 * Pure council configuration: personas, model-spec resolution, and argument parsing.
 * Kept free of Pi/Node side effects so it can be unit tested directly.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const DEFAULT_THINKING: ThinkingLevel = "high";
export const DEFAULT_ROUNDS = 2;
export const MAX_ROUNDS = 3;

export interface CatalogModel {
  provider: string;
  id: string;
}

export interface ResolvedModel {
  /** Full `provider/id` reference passed to the child through `--model`. */
  model: string;
  thinking: ThinkingLevel;
  /** True when the thinking level came from the spec rather than the default. */
  thinkingExplicit: boolean;
}

export interface ModelResolutionError {
  error: string;
  candidates: string[];
}

export type ModelResolution = ResolvedModel | ModelResolutionError;

export function isModelResolutionError(value: ModelResolution): value is ModelResolutionError {
  return "error" in value;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

function matchModel(spec: string, catalog: readonly CatalogModel[]): CatalogModel[] {
  const wanted = spec.trim().toLowerCase();
  if (!wanted) return [];
  const full = (model: CatalogModel): string => `${model.provider}/${model.id}`;

  const exactFull = catalog.filter((model) => full(model).toLowerCase() === wanted);
  if (exactFull.length > 0) return exactFull;

  const exactId = catalog.filter((model) => model.id.toLowerCase() === wanted);
  if (exactId.length > 0) return exactId;

  const key = normalize(wanted);
  if (!key) return [];

  const exactNormalized = catalog.filter(
    (model) => normalize(model.id) === key || normalize(full(model)) === key,
  );
  if (exactNormalized.length > 0) return exactNormalized;

  return catalog.filter(
    (model) => normalize(full(model)).includes(key) || normalize(model.id).includes(key),
  );
}

/**
 * Resolves a user-typed model spec such as `opus5max`, `opus5:xhigh`,
 * `anthropic/claude-opus-5` or `sol` into an exact `provider/id` plus thinking level.
 */
export function resolveModelSpec(
  spec: string,
  catalog: readonly CatalogModel[],
  defaultThinking: ThinkingLevel = DEFAULT_THINKING,
): ModelResolution {
  const raw = spec.trim();
  if (!raw) return { error: "No model was given.", candidates: [] };

  let modelPart = raw;
  let thinking = defaultThinking;
  let thinkingExplicit = false;

  const colon = raw.lastIndexOf(":");
  if (colon > 0) {
    const suffix = raw.slice(colon + 1).toLowerCase();
    if (!isThinkingLevel(suffix)) {
      return {
        error: `“${suffix}” is not a thinking level. Use one of: ${THINKING_LEVELS.join(", ")}.`,
        candidates: [],
      };
    }
    modelPart = raw.slice(0, colon);
    thinking = suffix;
    thinkingExplicit = true;
  }

  let matches = matchModel(modelPart, catalog);

  // Support glued specs such as `opus5max` by peeling a trailing thinking level
  // only when the remainder still names a model.
  if (matches.length !== 1 && !thinkingExplicit) {
    const key = normalize(modelPart);
    const byLength = [...THINKING_LEVELS].sort((a, b) => b.length - a.length);
    for (const level of byLength) {
      if (!key.endsWith(level) || key.length === level.length) continue;
      const stripped = key.slice(0, key.length - level.length);
      const strippedMatches = matchModel(stripped, catalog);
      if (strippedMatches.length === 1) {
        matches = strippedMatches;
        thinking = level;
        thinkingExplicit = true;
        break;
      }
    }
  }

  const names = catalog.map((model) => `${model.provider}/${model.id}`);
  if (matches.length === 0) {
    return { error: `No model matches “${raw}”.`, candidates: names };
  }
  if (matches.length > 1) {
    return {
      error: `“${raw}” is ambiguous.`,
      candidates: matches.map((model) => `${model.provider}/${model.id}`),
    };
  }

  const model = matches[0]!;
  return { model: `${model.provider}/${model.id}`, thinking, thinkingExplicit };
}

export interface CouncilArgs {
  subcommand?: "help" | "models";
  /** First non-flag token, a candidate model spec. */
  firstToken: string;
  /** Everything after the first token, with flags removed. */
  rest: string;
  /** All non-flag text including the first token. */
  full: string;
  rounds: number;
  web: boolean;
  webExplicit: boolean;
  errors: string[];
}

/** Parses `/council <model> [flags] <idea>` into its parts. */
export function parseCouncilArgs(args: string): CouncilArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const words: string[] = [];
  const errors: string[] = [];
  let rounds = DEFAULT_ROUNDS;
  let web = true;
  let webExplicit = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();

    if (lower === "--web") {
      web = true;
      webExplicit = true;
      continue;
    }
    if (lower === "--no-web" || lower === "--offline") {
      web = false;
      webExplicit = true;
      continue;
    }
    if (lower === "--quick") {
      rounds = 1;
      continue;
    }
    if (lower === "--rounds" || lower.startsWith("--rounds=")) {
      const value = lower.startsWith("--rounds=") ? lower.slice("--rounds=".length) : tokens[++index];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_ROUNDS) {
        errors.push(`--rounds needs a number between 1 and ${MAX_ROUNDS}.`);
        continue;
      }
      rounds = parsed;
      continue;
    }
    if (lower.startsWith("--")) {
      errors.push(`Unknown option “${token}”.`);
      continue;
    }
    words.push(token);
  }

  const first = words[0]?.toLowerCase();
  const subcommand = words.length === 1 && (first === "help" || first === "models")
    ? (first as "help" | "models")
    : undefined;

  return {
    subcommand,
    firstToken: words[0] ?? "",
    rest: words.slice(1).join(" "),
    full: words.join(" "),
    rounds,
    web,
    webExplicit,
    errors,
  };
}

export interface CouncilMember {
  id: string;
  name: string;
  shortName: string;
  /** Emoji/glyph used in the terminal report. */
  glyph: string;
  systemPrompt: string;
}

const SHARED_RULES = [
  "You are one voice on a four-person council reviewing a single idea for one person, not a committee report writer.",
  "Judge the idea itself. Stay in character, but never invent facts, numbers, or sources.",
  "Mark every number as either researched (with a link), a stated assumption, or a rough guess.",
  "Be specific and concrete. No filler, no motivational language, no restating the idea back at length.",
  "Never claim you did work your tools cannot do. You cannot read the user's files, run code, or contact anyone.",
].join("\n");

const WEB_RULES = [
  "You have web search and page fetching. Use at most 4 focused searches, and only for facts that would change the verdict:",
  "market size, real pricing, direct competitors, regulation, or hard cost inputs.",
  "Prefer primary sources and include inline links for anything load-bearing. If a fact cannot be verified quickly, say so and move on.",
].join(" ");

const NO_WEB_RULES = [
  "You have no tools and no internet. Reason from what you know, label your knowledge cutoff risk,",
  "and clearly flag which numbers a human should verify before acting.",
].join(" ");

const OUTPUT_FORMAT = [
  "Answer in this exact markdown shape and keep the whole thing under 400 words:",
  "",
  "**Position** — 2-3 sentences in your own voice.",
  "**Strongest points** — 3-4 bullets, the sharpest ones only.",
  "**What must be true** — 2-3 bullets, the assumptions your position depends on.",
  "**Verdict** — `score: N/10` (how good this idea is, your lens) plus `confidence: low|medium|high`.",
].join("\n");

interface MemberSeed {
  id: string;
  name: string;
  shortName: string;
  glyph: string;
  role: string;
}

const MEMBER_SEEDS: readonly MemberSeed[] = [
  {
    id: "optimist",
    name: "The Optimist",
    shortName: "Optimist",
    glyph: "☀",
    role: [
      "You are the Optimist: the person who finds the real upside everyone else misses.",
      "Look for the strongest honest version of this idea: the best-case customer, the unfair advantage, the tailwind, the fastest path to a first win.",
      "Argue for it with evidence, not enthusiasm. A weak optimistic case stated honestly is more useful than hype.",
      "You are allowed to say the upside is small if that is the truth.",
    ].join(" "),
  },
  {
    id: "pessimist",
    name: "The Skeptic",
    shortName: "Skeptic",
    glyph: "☁",
    role: [
      "You are the Skeptic: the failure analyst.",
      "Assume this idea fails and explain exactly how: the most likely killer, the hidden work, the competitor already doing it,",
      "the legal or platform risk, the reason people say they want it but never pay.",
      "Rank risks by probability times damage. Attack the idea, never the person.",
      "If a risk is cheap to remove, say so instead of treating it as fatal.",
    ].join(" "),
  },
  {
    id: "money",
    name: "The CFO",
    shortName: "CFO",
    glyph: "€",
    role: [
      "You are the CFO: only money matters to you.",
      "Work out the unit economics out loud: who pays, how much, how often, what it costs to serve one customer,",
      "the gross margin, the cash needed before revenue, and the payback period.",
      "State a rough break-even number of customers and the price point that makes it work.",
      "Show your arithmetic in one short line each. Call out the single number the whole business hinges on.",
    ].join(" "),
  },
  {
    id: "realist",
    name: "The Operator",
    shortName: "Operator",
    glyph: "⚙",
    role: [
      "You are the Operator: you care about what actually happens in the real world.",
      "Describe the most likely real scenario: what the first 90 days look like, who has to do the work,",
      "what skills or permissions are missing, how long the boring parts take, and where the plan meets reality.",
      "Give the smallest concrete test that would prove or kill this idea within a few weeks.",
      "Be neither hopeful nor gloomy: be accurate.",
    ].join(" "),
  },
];

export function councilMembers(web: boolean): CouncilMember[] {
  return MEMBER_SEEDS.map((seed) => ({
    id: seed.id,
    name: seed.name,
    shortName: seed.shortName,
    glyph: seed.glyph,
    systemPrompt: [
      seed.role,
      "",
      SHARED_RULES,
      "",
      web ? WEB_RULES : NO_WEB_RULES,
      "",
      OUTPUT_FORMAT,
    ].join("\n"),
  }));
}

export const CHAIR_PROMPT = [
  "You are the Chair of a four-person council that just reviewed one idea.",
  "The members are the Optimist, the Skeptic, the CFO, and the Operator. You have their opening positions and their rebuttals.",
  "",
  "Your job is to decide, not to summarize. Weigh the arguments by evidence quality, not by who spoke loudest.",
  "Discount any claim that rests on an unverified number. Never introduce new facts of your own.",
  "You have no tools and no internet.",
  "",
  "Answer in this exact markdown shape, under 450 words, in plain language:",
  "",
  "## Verdict",
  "One line: **Smart**, **Smart, but only if…**, or **Not smart** — followed by one sentence of reasoning and the council score range.",
  "",
  "## Why",
  "3-5 bullets carrying the decision.",
  "",
  "## The one thing that kills it",
  "The single most dangerous risk and how likely it is.",
  "",
  "## The money",
  "The numbers that must hold for this to work, marked verified or assumed.",
  "",
  "## Cheapest way to find out",
  "2-4 concrete steps, in order, that test the riskiest assumption for the least money and time.",
  "",
  "## Where the council split",
  "1-3 bullets on genuine disagreement and what evidence would settle it.",
].join("\n");

/** Builds the round-2 debate task from the other members' round-1 answers. */
export function debateTask(
  idea: string,
  self: CouncilMember,
  others: { member: CouncilMember; text: string }[],
): string {
  const transcript = others
    .map((entry) => `### ${entry.member.name}\n${entry.text}`)
    .join("\n\n");
  return [
    `The idea under review:\n\n${idea}`,
    "",
    "The other council members opened with these positions:",
    "",
    transcript,
    "",
    `You are ${self.name}. Respond to them directly, in this exact markdown shape, under 350 words:`,
    "",
    "**Where they are right** — name the member and the point you concede.",
    "**Where they are wrong** — name the member and rebut with a reason or a number, not an opinion.",
    "**What would settle it** — the specific evidence or test that would end the disagreement.",
    "**Updated verdict** — `score: N/10` and `confidence: low|medium|high`, and say plainly if your score moved and why.",
  ].join("\n");
}

/** Builds the chair's synthesis task from the full council transcript. */
export function chairTask(idea: string, transcript: string): string {
  return [
    `The idea under review:\n\n${idea}`,
    "",
    "Full council transcript:",
    "",
    transcript,
    "",
    "Deliver the council's decision now.",
  ].join("\n");
}


export function openingTask(idea: string): string {
  return [
    `The idea under review:\n\n${idea}`,
    "",
    "Give your opening position on this idea now, in your assigned format.",
  ].join("\n");
}