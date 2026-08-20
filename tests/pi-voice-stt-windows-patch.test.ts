import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFfmpegRecorder } from "../npm/node_modules/pi-voice-stt/src/audio/ffmpeg-recorder.ts";
import { patchFfmpegRecorder } from "../scripts/pi-voice-stt-windows-patch.mjs";

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const originalPath = join(
	agentDir,
	"patches",
	"pi-voice-stt-0.6.0",
	"original",
	"ffmpeg-recorder.ts",
);

describe("pi-voice-stt Windows FFmpeg patch", () => {
	it("replaces forceful SIGINT shutdown with FFmpeg's graceful q command idempotently", async () => {
		const original = await readFile(originalPath, "utf8");
		const patched = patchFfmpegRecorder(original);

		expect(patched).toContain("PI_HARNESS_FFMPEG_GRACEFUL_STOP_V1");
		expect(patched).not.toContain('"-nostdin"');
		expect(patched).toContain('stdio: ["pipe", "ignore", "pipe"]');
		expect(patched).toContain('input.write("q")');
		expect(patched).toContain('process.kill("SIGKILL")');
		expect(patchFfmpegRecorder(patched)).toBe(patched);
	});

	it("finalizes a valid nonempty WAV before returning from stop", async () => {
		const recorder = createFfmpegRecorder({
			type: "ffmpeg",
			ffmpegPath: process.env.PI_STT_FFMPEG || "ffmpeg",
			inputFormat: process.env.PI_STT_TEST_FORMAT || "lavfi",
			input: process.env.PI_STT_TEST_INPUT || "sine=frequency=1000:sample_rate=16000",
			sampleRate: 16000,
			channels: 1,
			maxSeconds: 10,
			minBytes: 4096,
		});
		const recording = await recorder.start();

		try {
			await delay(Number(process.env.PI_STT_TEST_DELAY_MS || 500));
			const outputPath = await recording.stop();
			const info = await stat(outputPath);
			const header = await readFile(outputPath);

			expect(info.size).toBeGreaterThan(4096);
			expect(header.subarray(0, 4).toString("ascii")).toBe("RIFF");
			expect(header.subarray(8, 12).toString("ascii")).toBe("WAVE");
		} finally {
			await recording.dispose();
		}
	}, 10_000);
});
