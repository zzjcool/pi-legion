import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startMockLlm, writeMockPiHome, MOCK_API_KEY } from "../mock-llm/index.ts";

async function readSseText(res: Response): Promise<string> {
	const raw = await res.text();
	const parts: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const data = line.slice(6).trim();
		if (data === "[DONE]") continue;
		const json = JSON.parse(data) as {
			choices?: Array<{ delta?: { content?: string } }>;
		};
		const content = json.choices?.[0]?.delta?.content;
		if (typeof content === "string") parts.push(content);
	}
	return parts.join("");
}

test("mock server health, models, streaming chat, and non-stream", async () => {
	const mock = await startMockLlm({ scenario: "echo", port: 0 });
	try {
		const health = await fetch(`http://127.0.0.1:${mock.port}/health`);
		assert.equal(health.ok, true);
		const healthBody = (await health.json()) as { ok: boolean };
		assert.equal(healthBody.ok, true);

		const models = await fetch(mock.url("/models"));
		assert.equal(models.ok, true);
		const modelsBody = (await models.json()) as { data: Array<{ id: string }> };
		assert.equal(modelsBody.data[0]?.id, "flash");

		const streamed = await fetch(mock.url("/chat/completions"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "flash",
				stream: true,
				messages: [{ role: "user", content: "MOCK_SAY: stream-hi" }],
			}),
		});
		assert.equal(streamed.ok, true);
		assert.match(streamed.headers.get("content-type") ?? "", /text\/event-stream/);
		assert.equal(await readSseText(streamed), "stream-hi");

		const plain = await fetch(mock.url("/chat/completions"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "flash",
				stream: false,
				messages: [{ role: "user", content: "MOCK_SAY: json-hi" }],
			}),
		});
		assert.equal(plain.ok, true);
		const plainBody = (await plain.json()) as {
			choices: Array<{ message: { content: string }; finish_reason: string }>;
		};
		assert.equal(plainBody.choices[0]?.message.content, "json-hi");
		assert.equal(plainBody.choices[0]?.finish_reason, "stop");
		assert.ok(mock.requestCount() >= 2);
	} finally {
		await mock.close();
	}
});

test("tool_call streaming emits finish_reason tool_calls", async () => {
	const mock = await startMockLlm({
		scenario: "tool-once",
		port: 0,
		defaultToolName: "bash",
		defaultToolArgs: '{"command":"pwd"}',
	});
	try {
		const res = await fetch(mock.url("/chat/completions"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "flash",
				stream: true,
				messages: [{ role: "user", content: "run" }],
			}),
		});
		const raw = await res.text();
		assert.match(raw, /"finish_reason":"tool_calls"/);
		assert.match(raw, /"name":"bash"/);
	} finally {
		await mock.close();
	}
});

test("writeMockPiHome uses dummy key only", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mock-pi-home-"));
	try {
		const home = writeMockPiHome({
			dir,
			baseUrl: "http://127.0.0.1:8765/v1",
			packages: ["/plugin"],
		});
		const models = JSON.parse(
			readFileSync(path.join(home.agentDir, "models.json"), "utf8"),
		) as { providers: { mock: { apiKey: string; baseUrl: string } } };
		assert.equal(models.providers.mock.apiKey, MOCK_API_KEY);
		assert.equal(models.providers.mock.apiKey, "mock");
		assert.equal(models.providers.mock.baseUrl, "http://127.0.0.1:8765/v1");
		assert.equal(home.modelRef, "mock/flash");
		// Never write host credentials into the mock home.
		assert.equal(existsSync(path.join(home.agentDir, "auth.json")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
