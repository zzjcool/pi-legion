# `turn_end could not resolve the persisted assistant entry ID`（#415）

状态：**已复现（场景 ①）+ 已做降级**（2026-11-19；基线 `origin/master` `cef9712` = 6.2.2）
门禁：`flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"` → 2658 tests / 2657 pass / 0 fail / 1 skipped

---

## 0. 一句话结论

现场那行 warn 里的 **`turn_end` handler 不是 legion 注册的**（来自被继承进 child 的 `pi-async`），
**错误记录是 pi 宿主产出的**（`extensionPath: "<boundary>"`）；legion 在这件事里唯一的角色，是
`onError` 这个 sink 把它印成了“扩展错误”，于是**指向了一个完全健康的扩展**。

所以归属是：**pi 宿主（产出记录）+ pi-async（唯一注册者）**。legion 侧能做、且本 issue 已经做的，
是把这条已知诊断**降级成「钩子被跳过」并写清原因**——不抛错、不静默、也不再冒充扩展故障。
真正“修好”需要宿主在 `dispose()` 之后不再收尾那一轮，或至少不要把这条诊断报在 `onError` 通道上。

---

## 1. 现场字符串逐字段解码

`src/supervisor/child-session.ts` 的 `describeExtensionError` 渲染 `${extensionPath} ${event}: ${message}`，
所以那行 warn 的每一段都能落到宿主记录的具体字段上：

| 现场文本 | 来源 | 值 |
|---|---|---|
| `hygiene-doctor` | child 的 `name`（`bindChildSessionExtensions(session, name)` 的 label） | 用户环境里的 agent 卡片名，**legion 仓库内不存在这个名字** |
| `<boundary>` | `record.extensionPath` | 宿主写死的**伪扩展**路径（`agent-session.js:550`） |
| `turn_end` | `record.event` | 宿主事件名 |
| `turn_end could not resolve the persisted assistant entry ID` | `record.error` | 宿主文案（`agent-session.js:552`） |

关键推论：**`<boundary>` 不是一个扩展的名字，是宿主自己的占位符**。所以“某个扩展在 `turn_end` 里报错”
这个第一印象从一开始就是错的。

---

## 2. 复现步骤（原文，可执行）

宿主编译产物：`pi-coding-agent@1.5.2`
`/root/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`

> 复现用的是**宿主的真实函数**（`AgentSession.prototype._dispatchTurnEndBoundary` 与
> `_findPersistedMessageEntryId`），不是照着源码重写一份。伪造的只有 `this` 上那 5 个字段。

### 2.1 宿主侧：三种候选场景 + 一个对照

```js
// /tmp/repro-415.mjs
const HOST = "/root/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";
const { AgentSession } = await import(HOST);
const proto = AgentSession.prototype;

function fakeSession({ persistedEntryIds, projectionEntries, messages, turnEndHandlers }) {
	const emitted = [];
	const branch = projectionEntries.map((e) => e.sourceEntry);
	// Object.create(proto) so the REAL _findPersistedMessageEntryId runs too.
	return Object.assign(Object.create(proto), {
		emitted,
		_entryIdsByMessage: new Map(persistedEntryIds),
		_turnIndex: 3,
		_extensionRunner: {
			hasHandlers: (event) => (event === "turn_end" ? turnEndHandlers : false),
			emitError: (record) => emitted.push(record),
		},
		agent: { state: { messages } },
		sessionManager: {
			getBranch: () => branch,
			buildSessionProjection: () => ({ entries: projectionEntries }),
		},
	});
}

async function run(label, opts) {
	const s = fakeSession(opts);
	const returned = await proto._dispatchTurnEndBoundary.call(s, opts.message, []);
	console.log(`\n--- ${label}`);
	console.log(`  hasHandlers("turn_end") = ${opts.turnEndHandlers}  -> returned ${returned}`);
	console.log(`  emitted ${s.emitted.length} record(s)`);
	for (const r of s.emitted) console.log("  " + JSON.stringify(r));
}

const liveMsg = { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "aborted" };

// ① aborted / disposed turn: message only exists in agent state, nothing persisted.
await run("① aborted turn (dispose() mid-turn)", {
	message: liveMsg,
	persistedEntryIds: [],
	projectionEntries: [], // projection has 0 messages; messageIndex = 0 never reached
	messages: [liveMsg],
	turnEndHandlers: true, // pi-async
});

// ② compaction: message sits at index 3 of agent.state, projection collapsed to 1 message.
{
	const old = [0, 1, 2].map((i) => ({ role: "user", content: `old ${i}` }));
	const msg = { role: "assistant", content: [{ type: "text", text: "post-compact" }] };
	const summaryEntry = {
		sourceEntry: { id: "entry-summary", type: "message", message: { role: "user", content: "summary" } },
		messages: [{ role: "user", content: "summary" }],
	};
	await run("② after compaction", {
		message: msg,
		persistedEntryIds: [],
		projectionEntries: [summaryEntry],
		messages: [...old, msg], // messageIndex = 3
		turnEndHandlers: true,
	});
}

// ③ fork / branch switch: the message belongs to the branch we left.
{
	const msg = { role: "assistant", content: [{ type: "text", text: "on abandoned branch" }] };
	await run("③ after fork/branch", {
		message: msg,
		persistedEntryIds: [],
		projectionEntries: [],
		messages: [{ role: "user", content: "different branch" }], // messageIndex = -1
		turnEndHandlers: true,
	});
}

// Control: the gate. No turn_end handler (legion alone, post-#383) => the host never reaches the error.
await run("control: no turn_end handler", {
	message: liveMsg,
	persistedEntryIds: [],
	projectionEntries: [],
	messages: [liveMsg],
	turnEndHandlers: false,
});
```

运行（本机 `node` 不在 PATH，用 nvm 的那个）：

```sh
/root/.nvm/versions/node/v24.13.1/bin/node /tmp/repro-415.mjs
```

实测输出：

```text
--- ① aborted turn (dispose() mid-turn): message in agent.state, nothing persisted
  hasHandlers("turn_end") = true  -> returned false
  emitted 1 record(s)
  {"extensionPath":"<boundary>","event":"turn_end","error":"turn_end could not resolve the persisted assistant entry ID"}

--- ② after compaction: projection collapsed, messageIndex unreachable
  hasHandlers("turn_end") = true  -> returned false
  emitted 1 record(s)
  {"extensionPath":"<boundary>","event":"turn_end","error":"turn_end could not resolve the persisted assistant entry ID"}

--- ③ after fork/branch: message not in this branch nor agent.state
  hasHandlers("turn_end") = true  -> returned false
  emitted 1 record(s)
  {"extensionPath":"<boundary>","event":"turn_end","error":"turn_end could not resolve the persisted assistant entry ID"}

--- control: no turn_end handler (legion-only session, post-#383)
  hasHandlers("turn_end") = false  -> returned false
  emitted 0 record(s)
```

### 2.2 端到端：宿主记录 → legion 的那行 warn

```js
// /tmp/repro-415-e2e.mjs
const HOST = "/root/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";
const LEGION = "/root/code/.pi-worktrees/legion-415/src/supervisor/child-session.ts";
const { AgentSession } = await import(HOST);
const { bindChildSessionExtensions } = await import(LEGION);

// step 1: the real host boundary on an aborted (unpersisted) turn
const liveMsg = { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "aborted" };
const emitted = [];
const hostThis = Object.assign(Object.create(AgentSession.prototype), {
	_entryIdsByMessage: new Map(),
	_turnIndex: 3,
	_extensionRunner: { hasHandlers: (e) => e === "turn_end", emitError: (r) => emitted.push(r) },
	agent: { state: { messages: [liveMsg] } },
	sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ entries: [] }) },
});
await AgentSession.prototype._dispatchTurnEndBoundary.call(hostThis, liveMsg, []);
const record = emitted[0];
console.log("host emitted:", JSON.stringify(record));

// step 2: the child's bound extensions deliver that record to legion's onError
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(" "));
try {
	await bindChildSessionExtensions(
		{ async bindExtensions(bindings) { bindings.onError(record); } }, // = ExtensionRunner's emitError path
		"hygiene-doctor",
	);
} finally {
	console.warn = originalWarn;
}
console.log("\nlegion printed (what the parent's screen shows):");
for (const w of warnings) console.log("  " + w);
```

修复**前**的实测输出（与 issue 现场逐字符一致）：

```text
host emitted: {"extensionPath":"<boundary>","event":"turn_end","error":"turn_end could not resolve the persisted assistant entry ID"}

legion printed (what the parent's screen shows):
  [pi-legion] in-process child hygiene-doctor extension error: <boundary> turn_end: turn_end could not resolve the persisted assistant entry ID
```

修复**后**同一个脚本出：

```text
  [pi-legion] in-process child hygiene-doctor turn_end hook skipped: turn_end could not resolve the persisted assistant entry ID (this turn's assistant message has no persisted entry, so the host ran no turn_end handler)
```

### 2.3 三个候选场景的判定

三个场景都能到达**同一条**记录（见 2.1），所以“哪一类 turn 会触发”必须用别的证据区分：

| 场景 | 结构上可达 | 是不是现场这一例 | 判据 |
|---|---|---|---|
| ① 被 abort / `dispose()` 收尾的轮 | 是 | **是** | 现场 child 正在被 retire（“刚结束一轮”）；`#383` 的 CHANGELOG 原文已把该类故障写成「`dispose()` 之后仍会收尾一个被 abort 的 turn，message 没落盘」；`pi-async` 的 README 记录同一报错为「task completing **after** the agent settles，woken run 的 `turn_end` boundary 失败」 |
| ② compaction 后第一轮 | 是 | 否 | in-process child 生命周期短、不压缩；且自动压缩发生在上一轮 `finishTurn` **之后**，不影响当轮解析 |
| ③ fork/branch 之后 | 是 | 否 | in-process child 不 fork / 不切分支 |

结论：**复现出来的触发类别是 ①**；②③ 属于「同一分支、不同来路」，留作回归矩阵而不是现场归因。

---

## 3. 归属分析

三个必要条件，缺一不成立：

1. **有人注册了 `turn_end` handler** → 宿主 `hasHandlers("turn_end")` 为真（`agent-session.js:546`，
   这个 gate 严格早于 missing-entry 分支 `:548`）。
   本机确认的注册者是 **`pi-async`**：`/root/.pi/agent/npm/node_modules/pi-async/extensions/index.ts:473`
   `context.on("turn_end", () => { flushPendingNotifications(); return undefined; })`，**无条件注册**
   （`~/.pi/agent/settings.json` 的 `packages` 里有 `npm:pi-async@latest`，经
   `src/runs/extension-inheritance.ts` 继承进 child）。
   legion 自身**一处都没有**——`rg "turn_end"` 全仓只有注释 / 白名单 / 只读事件折叠，
   且有哨兵测试 `test/unit/extension-stale-ctx.test.ts:127` 钉死“不许再注册”。
2. **该轮的 assistant message 没有持久化条目** → 宿主走 missing-entry 分支。
   产生条件见 §2.3（abort/dispose 收尾、compaction、fork）与
   `_findPersistedMessageEntryId` 的两个 `return undefined`（`messageIndex < 0` / 投影走完仍无此下标）。
3. **有人给这个 session 装了 `onError` 监听器** → 记录才可见。legion 在
   `bindChildSessionExtensions` 里装了它（为了 MCP 的 `session_start` 失败不静默），
   于是这条**宿主诊断**被当作**扩展错误**印出来。

**归属**：`turn_end` handler 属于 `pi-async`，诊断属于 pi 宿主。**不是 legion 的 bug**，
但 **legion 的日志语义是 legion 自己的**——把宿主诊断印成“扩展错误”这件事由 legion 负责修。

> `index.ts:2786` 那段注释在 #383 时写的理由不完整：去掉**我们自己**的注册，
> 只是去掉了**一个** handler，挡不住**被继承的其他扩展**注册同一个事件。本 issue 就是这句话的现场反例。
> 注释已在本次改动中补上这一条。

---

## 4. 修复（降级，不是 try/catch）

`src/supervisor/child-session.ts`：

- `skippedTurnEndBoundary(error)`：**三字段全等**地识别宿主这条记录
  （`extensionPath === "<boundary>"`、`event === "turn_end"`、`error === "turn_end could not resolve the persisted assistant entry ID"`）。
- `onError` 命中时改印一条**说明“钩子被跳过”的日志**并 `return`：
  子节点名保留、宿主原因原文保留、补一句为什么（`no persisted entry` → 宿主一个 `turn_end` handler 都没跑）。
- 不命中时行为**完全不变**（`extension error: …`）。

为什么不是 try/catch：没有任何东西被“兜住”——记录不是异常，宿主也没有让它穿过谁的调用栈。
真正要改的是**语义**：把一条已知、预期、由宿主产生的**跳过**，从“某个扩展坏了”里分出来。

为什么宽窄要卡死：匹配放宽（子串 / 只看 `extensionPath`）会把**真的** `turn_end` 扩展故障
也降级成“跳过”，那是本 bug 的镜像错误。所以第二个测试专门钉住匹配宽度。

**为什么不在 legion 侧彻底消掉这条记录**：做不到。#383 的解法（不注册）只覆盖 legion 自己那一个
handler；`hasHandlers` 是整个扩展集合的属性，`pi-async` 出于 steer 投递的正当需要必须注册它。
legion 也不能因此就把宿主扩展从 child 里剔掉（MCP 等继承是设计前提）。

---

## 5. 测试与变异

`test/unit/child-session.test.ts` 新增两例（沿用文件自带 `fakeSession()` + `captureWarnings`）：

1. `#415: a skipped turn_end boundary is reported as a skip, not as an extension error`
   - 喂**逐字段一致**的宿主记录
   - `assert.doesNotThrow`：降级不抛
   - 恰好 1 行：跳过 ≠ 静默
   - `doesNotMatch(/extension error/)` 且 `match(/turn_end hook skipped/)`
   - 宿主的原始原因仍在（可追溯），并解释了为什么
2. `#415: the degrade is exact — anything else still says "extension error"`
   - 同伪扩展不同原因、同原因不同扩展、近似路径 → 三者都仍走 `extension error`

**变异检验**（把 `if (skipped !== undefined)` 改成 `if (false && …)`，其余不动）：

```text
✖ #415: a skipped turn_end boundary is reported as a skip, not as an extension error
  AssertionError [ERR_ASSERTION]: the log says the HOOK was skipped
    actual: '[pi-legion] in-process child hygiene-doctor extension error: <boundary> turn_end: turn_end could not resolve the persisted assistant entry ID'
ℹ tests 15 / pass 14 / fail 1
```

变异后输出与 issue 现场**逐字符一致**——这条断言红的正是现场的 bug，不是一条自造的字符串。
已还原（`diff` 与备份逐字节相同）。

门禁：`flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"` → exit 0，
2658 tests / 2657 pass / **0 fail** / 1 skipped。

---

## 6. 未实测清单（诚实边界）

1. **报告环境里 child 的扩展集合未实测**。本机确认“被继承扩展里只有 `pi-async` 注册 `turn_end`”
   （宿主 builtin `codemode`/`mcp`/`tool-search`/`llama`、`pi-sysmon`、`pi-any-endpoint`、
   `~/.pi/agent/extensions/*.ts` 全部零命中）。若报告者机器上那个 child 的 agent 卡片设了
   `inheritExtensions: false` 或排除了 `pi-async`，注册者就要另找——但**结论不变**（不是 legion）。
2. **`hygiene-doctor` 的卡片定义不在本仓库**，无法确认它的 `utility` / `inheritExtensions` 取值。
3. **“同一 `Agent` 被两个 `AgentSession` 包装 / 已 `dispose()` 的 session 的 `finishTurn` 钩子仍在链上”**
   是宿主源码里唯一能让三种场景同时落空的结构性路径（`dispose()` 不清 `finishTurn`、
   `invalidate()` 不清 `extensions`/`errorListeners`）。这条**未实测**——它发生在 legion 之外的宿主内部，
   不影响本次的降级与测试。
4. 宿主 1.5.1 与 1.5.2 的 `agent-session.js` / `runner.js` **逐字节相同**，故本结论对两个版本同时成立；
   更高版本未核对。
5. 现场那台机器上的实际扩展清单未采集（应在那台机器上对继承路径逐个 `rg 'on\("turn_end"'`）。

---

## 7. 给上游的建议（不在本仓库范围）

- 宿主：`dispose()` 之后不要再收尾那一轮；或至少把“条目未落盘”报在**诊断**通道而不是 `onError`
  （后者语义是“某个扩展失败了”，而这里一个扩展都没失败）。
- `pi-async`：`turn_end` 的 flush 在“条目未落盘”时是纯 no-op，可考虑只在 `agent_before_settle` /
  `agent_settled` 上 flush，从而让 `hasHandlers("turn_end")` 保持为假；这会从源头消掉这条记录。
