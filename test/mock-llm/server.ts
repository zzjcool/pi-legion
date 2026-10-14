import http from "node:http";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { pickActions, resolveContext } from "./script-engine.ts";
import { resolveScenario } from "./scenarios.ts";
import { actionsToJsonCompletion, actionsToSseChunks, writeSse } from "./sse.ts";
import type {
	ChatCompletionRequest,
	MockScript,
	MockServerOptions,
} from "./types.ts";

export interface MockLlmHandle {
	baseUrl: string;
	port: number;
	host: string;
	scenario: string;
	script: MockScript;
	requestCount: () => number;
	close: () => Promise<void>;
	url: (path?: string) => string;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function appendLog(logPath: string | undefined, line: string): void {
	if (!logPath) return;
	try {
		fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* ignore logging failures */
	}
}

function normalizePath(url: string | undefined): string {
	if (!url) return "/";
	const q = url.indexOf("?");
	const path = q === -1 ? url : url.slice(0, q);
	return path.replace(/\/+$/, "") || "/";
}

function scenarioFromRequest(
	req: http.IncomingMessage,
	fallback: string,
): string {
	const header = req.headers["x-mock-scenario"];
	if (typeof header === "string" && header.trim()) return header.trim();
	try {
		const u = new URL(req.url ?? "/", "http://127.0.0.1");
		const q = u.searchParams.get("scenario");
		if (q?.trim()) return q.trim();
	} catch {
		/* ignore */
	}
	return fallback;
}

export async function startMockLlm(options: MockServerOptions = {}): Promise<MockLlmHandle> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	const scenarioName = options.scenario ?? process.env.MOCK_LLM_SCENARIO ?? "echo";
	const script =
		options.script ??
		resolveScenario(scenarioName, {
			toolName: options.defaultToolName ?? process.env.MOCK_TOOL_NAME,
			toolArgs: options.defaultToolArgs ?? process.env.MOCK_TOOL_ARGS,
			script: options.script,
		});
	const logPath = options.logPath ?? process.env.MOCK_LLM_LOG;
	let requests = 0;

	const server = http.createServer(async (req, res) => {
		const path = normalizePath(req.url);
		if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, scenario: scenarioName, requests }));
			return;
		}
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
			const models = script.models ?? [{ id: "flash", name: "Mock Flash" }];
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					object: "list",
					data: models.map((m) => ({
						id: m.id,
						object: "model",
						owned_by: "pi-legion-mock",
					})),
				}),
			);
			return;
		}

		const isChat =
			req.method === "POST" &&
			(path === "/v1/chat/completions" ||
				path === "/chat/completions" ||
				path.endsWith("/chat/completions"));
		if (!isChat) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: `no route ${req.method} ${path}` } }));
			return;
		}

		const raw = await readBody(req);
		let body: ChatCompletionRequest = {};
		try {
			body = JSON.parse(raw.toString("utf8") || "{}") as ChatCompletionRequest;
		} catch {
			body = {};
		}
		requests += 1;
		const activeScenario = scenarioFromRequest(req, scenarioName);
		let activeScript = script;
		if (activeScenario !== scenarioName) {
			try {
				activeScript = resolveScenario(activeScenario, {
					toolName: options.defaultToolName ?? process.env.MOCK_TOOL_NAME,
					toolArgs: options.defaultToolArgs ?? process.env.MOCK_TOOL_ARGS,
				});
			} catch (error) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: {
							message: error instanceof Error ? error.message : String(error),
						},
					}),
				);
				return;
			}
		}

		const ctx = resolveContext(body, activeScenario);
		const actions = pickActions(activeScript, ctx);
		appendLog(
			logPath,
			JSON.stringify({
				scenario: activeScenario,
				model: ctx.model,
				role: ctx.role,
				hasToolResult: ctx.hasToolResult,
				turnIndex: ctx.turnIndex,
				actions: actions.map((a) => a.type),
			}),
		);

		const first = actions[0];
		if (first?.type === "error") {
			res.writeHead(first.status ?? 500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: first.message, type: "mock_error" } }));
			return;
		}

		const wantStream = body.stream !== false;
		if (wantStream) {
			writeSse(res, actionsToSseChunks(actions, ctx.model));
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(actionsToJsonCompletion(actions, ctx.model)));
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});

	const address = server.address() as AddressInfo;
	const baseUrl = `http://${host}:${address.port}/v1`;
	appendLog(logPath, `listening ${baseUrl} scenario=${scenarioName}`);

	return {
		baseUrl,
		port: address.port,
		host,
		scenario: scenarioName,
		script,
		requestCount: () => requests,
		url: (p = "") => `${baseUrl}${p.startsWith("/") ? p : `/${p}`}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}
