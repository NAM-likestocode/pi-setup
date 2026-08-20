import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ANYWHERE_PROTOCOL_VERSION,
	createPairingUri,
	isInternalFrame,
	isPairingQrPayload,
	isPairRequest,
	isSendMessageRequest,
	parsePairingUri,
	validatePageSize,
	validatePromptAnswer,
} from "../packages/anywhere-protocol/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
	return JSON.parse(
		readFileSync(
			join(here, "..", "packages", "anywhere-protocol", "fixtures", name),
			"utf8",
		),
	);
}

describe("Pi Anywhere protocol v2", () => {
	it("accepts the valid pairing fixture and rejects v1", () => {
		expect(isPairingQrPayload(fixture("valid-pairing.json"))).toBe(true);
		expect(isPairingQrPayload(fixture("invalid-v1.json"))).toBe(false);
	});

	it("round-trips the pairing URI without putting the token in query parameters", () => {
		const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const uri = createPairingUri({
			hostId: "host-1",
			baseUrl: "https://host-1.example.ts.net",
			machineName: "desktop",
			token,
		});
		expect(uri).toContain("pi-anywhere://pair");
		expect(uri).toContain(`#${token}`);
		expect(uri).not.toContain(`token=${token}`);
		expect(parsePairingUri(uri)).toEqual({
			version: ANYWHERE_PROTOCOL_VERSION,
			hostId: "host-1",
			baseUrl: "https://host-1.example.ts.net",
			machineName: "desktop",
			token,
		});
		expect(parsePairingUri(` URL: ${uri} `)).toEqual({
			version: ANYWHERE_PROTOCOL_VERSION,
			hostId: "host-1",
			baseUrl: "https://host-1.example.ts.net",
			machineName: "desktop",
			token,
		});
		expect(
			parsePairingUri(
				"pi-anywhere://pair?v=2&host=host-1&base=https%3A%2F%2Fhost-1.example.ts.net&name=desktop#token-with_underscores-123",
			),
		).toEqual({
			version: ANYWHERE_PROTOCOL_VERSION,
			hostId: "host-1",
			baseUrl: "https://host-1.example.ts.net",
			machineName: "desktop",
			token: "token-with_underscores-123",
		});
	});

	it("rejects unknown keys and malformed requests", () => {
		expect(
			isPairRequest({
				version: 1,
				token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			}),
		).toBe(false);
		expect(
			isSendMessageRequest({
				version: ANYWHERE_PROTOCOL_VERSION,
				idempotencyKey: "request-1",
				text: "hello",
				delivery: "followUp",
				unexpected: true,
			}),
		).toBe(false);
	});

	it("rejects v1 and malformed internal frames before dispatch", () => {
		expect(
			isInternalFrame({
				type: "heartbeat",
				version: 1,
				instance: {},
				state: {},
			}),
		).toBe(false);
		expect(
			isInternalFrame({
				type: "message",
				version: 2,
				instanceId: "i",
				requestId: "r",
				text: "x",
				delivery: "followUp",
				extra: true,
			}),
		).toBe(false);
		expect(
			isInternalFrame({
				type: "message",
				version: 2,
				instanceId: "i",
				requestId: "r",
				text: "x",
				delivery: "followUp",
			}),
		).toBe(true);
	});

	it("accepts companion history commands with nullable optional fields", () => {
		expect(
			isInternalFrame({
				type: "command",
				version: 2,
				requestId: "history-1",
				instanceId: "instance-1",
				command: "history",
				enabled: null,
				cursor: null,
				limit: 100,
			}),
		).toBe(true);
		expect(
			isInternalFrame({
				type: "command",
				version: 2,
				requestId: "detach-1",
				instanceId: "instance-1",
				command: "detach",
			}),
		).toBe(true);
	});

	it("accepts companion command results with nullable optional fields", () => {
		expect(
			isInternalFrame({
				type: "command_result",
				version: 2,
				requestId: "status-1",
				ok: true,
				message: "Companion is running.",
				pairingUri: null,
				instances: [],
				history: null,
				state: null,
			}),
		).toBe(true);
		expect(
			isInternalFrame({
				type: "command_result",
				version: 2,
				requestId: "status-1",
				ok: true,
				message: "Companion is running.",
				unexpected: true,
			}),
		).toBe(false);
	});

	it("validates prompt answers against server-advertised constraints", () => {
		const prompt = {
			options: [{ title: "one" }, { title: "two" }],
			allowMultiple: false,
			allowFreeform: false,
			allowComment: true,
		} as const;
		expect(
			validatePromptAnswer(prompt, {
				kind: "selection",
				selections: ["one"],
				comment: "why",
			}),
		).toEqual({
			kind: "selection",
			selections: ["one"],
			comment: "why",
		});
		expect(
			validatePromptAnswer(prompt, {
				kind: "selection",
				selections: ["one", "two"],
			}),
		).toBeUndefined();
		expect(
			validatePromptAnswer(prompt, { kind: "freeform", text: "not allowed" }),
		).toBeUndefined();
	});

	it("clamps page sizes to the protocol range", () => {
		expect(validatePageSize(undefined)).toBe(50);
		expect(validatePageSize(0)).toBe(1);
		expect(validatePageSize(500)).toBe(100);
		expect(validatePageSize(25)).toBe(25);
	});
});
