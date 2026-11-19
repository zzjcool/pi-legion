/**
 * Mock OpenAI-compatible endpoint with a *message-visible* request log.
 *
 * EXPERIMENT ONLY — issue #417 hold-spike. Delete with scripts/spike/.
 *
 * The repo mock (`test/mock-llm/server.ts`) only logs the action *types*, which is
 * not enough here: to measure delivery latency we must know, per provider request,
 * whether the injected followUp text had already reached the model. So this server
 * reuses the repo's SSE encoding but records the full message blob per request.
 */

import http from "node:http";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { actionsToSseChunks, writeSse } from "../../test/mock-llm/sse.ts";
import { flattenMessages } from "../../test/mock-llm/script-engine.ts";
import type { ChatMessage } from "../../test/mock-llm/types.ts";

export interface LoggedMock {
	baseUrl: string;
	requests: () => number;
	close: () => Promise<void>;
}

export async function startLoggedMock(options: {
	logPath: string;
	/** substrings whose first appearance at the provider is timed */
	markers: string[];
	replyPrefix?: string;
	/** delay before answering, so a "long turn" exists without any hold */
	replyDelayMs?: number;
}): Promise<LoggedMock> {
	const replyPrefix = options.replyPrefix ?? "MOCK_REPLY";
	const replyDelayMs = options.replyDelayMs ?? 0;
	let idx = 0;

	const server = http.createServer((req, res) => {
		const url = req.url ?? "/";
		const clean = url.split("?")[0].replace(/\/+$/, "") || "/";
		if (req.method === "GET" && (clean.endsWith("/health") || clean === "/health")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, requests: idx }));
			return;
		}
		if (req.method === "GET" && (clean.endsWith("/models") || clean === "/models")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					object: "list",
					data: [{ id: "flash", object: "model", owned_by: "hold-spike-mock" }],
				}),
			);
			return;
		}
		if (req.method !== "POST" || !clean.endsWith("/chat/completions")) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: `no route ${req.method} ${clean}` } }));
			return;
		}

		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body: { messages?: ChatMessage[]; model?: string; stream?: boolean } = {};
			try {
				body = JSON.parse(raw || "{}");
			} catch {
				body = {};
			}
			const messages = body.messages ?? [];
			const blob = flattenMessages(messages);
			idx += 1;
			const hits: Record<string, number> = {};
			for (const marker of options.markers) {
				hits[marker] = blob.split(marker).length - 1;
			}
			fs.appendFileSync(
				options.logPath,
				`${JSON.stringify({
					ts: new Date().toISOString(),
					t: Date.now(),
					idx,
					messageCount: messages.length,
					roles: messages.map((m) => m.role),
					markerHits: hits,
					tail: blob.slice(-400),
				})}\n`,
			);
			const text = `${replyPrefix}_${idx}`;
			const actions = [{ type: "text" as const, content: text }];
			const answer = () => {
			if (body.stream === false) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
				return;
			}
			writeSse(res, actionsToSseChunks(actions, body.model ?? "flash"));
			};
			if (replyDelayMs > 0) setTimeout(answer, replyDelayMs);
			else answer();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address() as AddressInfo;
	fs.appendFileSync(
		options.logPath,
		`${JSON.stringify({ ts: new Date().toISOString(), t: Date.now(), ev: "listening", port: address.port })}\n`,
	);

	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests: () => idx,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}
