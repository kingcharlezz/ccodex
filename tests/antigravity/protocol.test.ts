import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findAntigravity } from "../../src/config.js";
import { AcpFailure, parseFrame, splitLines, startAcp } from "../../src/antigravity/acp.js";
import { expandDiffs, unifiedDiff } from "../../src/antigravity/diff.js";
import { promptBlocks } from "../../src/antigravity/input.js";
import { antigravityDisplayName, antigravityModelId, antigravityModelLabel, cliModelId, defaultEffort, groupModels, isAntigravityModel, mapAntigravityModel, parseModelList } from "../../src/antigravity/models.js";
import { approvalRequest, antigravityMode, permissionOutcome, unaskedDecision } from "../../src/antigravity/permissions.js";
import { failureText, antigravitySpawn } from "../../src/antigravity/session.js";
import { otherProviderRequested, settingsFrom } from "../../src/antigravity/thread.js";

const FAKE_AGY = fileURLToPath(new URL("../fixtures/fakeAntigravity.mjs", import.meta.url));

describe("ACP framing", () => {
  it("splits what was read into whole lines and the unfinished rest", () => {
    expect(splitLines("", '{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' });
    expect(splitLines('{"b"', ':2}\n\n  \n')).toEqual({ lines: ['{"b":2}'], rest: "" });
  });

  it("tells responses, requests and notifications apart, and noise from all of them", () => {
    expect(parseFrame('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({ kind: "response", id: 1, result: { ok: true } });
    expect(parseFrame('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"no"}}')).toEqual({ kind: "response", id: 2, error: { code: -32000, message: "no" } });
    expect(parseFrame('{"jsonrpc":"2.0","id":"a-1","method":"session/request_permission","params":{"x":1}}')).toEqual({ kind: "request", id: "a-1", method: "session/request_permission", params: { x: 1 } });
    expect(parseFrame('{"jsonrpc":"2.0","method":"session/update"}')).toEqual({ kind: "notification", method: "session/update", params: {} });
    expect(parseFrame("Loaded cached credentials.").kind).toBe("noise");
    expect(parseFrame("42").kind).toBe("noise");
  });

  it("speaks with a real child: answers, errors with their code, and the end of the process", async () => {
    const exited = new Promise<string>((resolve) => {
      const acp = startAcp(antigravitySpawn(FAKE_AGY, tmpdir(), { ...process.env, FAKE_AGY_HOME: undefined }), {
        onNotification: () => undefined, onRequest: async () => ({}), onExit: resolve,
      });
      void (async () => {
        expect((await acp.request("initialize", { protocolVersion: 1 })).protocolVersion).toBe(1);
        const failure = await acp.request("session/nope", {}).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AcpFailure);
        expect((failure as AcpFailure).code).toBe(-32601);
        const { sessionId } = await acp.request("session/new", { cwd: tmpdir(), mcpServers: [] });
        const dying = acp.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "crash" }] }).catch((error: Error) => error.message);
        expect(await dying).toMatch(/exited \(code 3\)/u);
        await expect(acp.request("initialize", {})).rejects.toThrow(/not running/u);
      })();
    });
    expect(await exited).toMatch(/exited \(code 3\)/u);
  });
});

describe("starting the Antigravity CLI", () => {
  it("runs `agy acp` in the chat's directory, without CCodex's shim marker", () => {
    const spawned = antigravitySpawn("/home/me/.local/bin/agy", "/work", { PATH: "/bin", CCODEX_SHIM_ACTIVE: "1" });
    expect(spawned).toEqual({ command: "/home/me/.local/bin/agy", args: ["acp"], cwd: "/work", env: { PATH: "/bin" } });
  });

  it("finds the configured CLI, else the first on PATH", () => {
    const bin = mkdtempSync(join(tmpdir(), "ccodex-agy-bin-"));
    writeFileSync(join(bin, "agy"), "#!/bin/sh\n");
    expect(findAntigravity({ antigravityBinary: "/opt/custom/agy" }, bin)).toBe("/opt/custom/agy");
    expect(findAntigravity({}, `/nowhere:${bin}`)).toBe(join(bin, "agy"));
  });

  it("says in words why a turn failed", () => {
    expect(failureText(new AcpFailure(-32000, "Authentication required."))).toMatch(/not signed in.*ccodex auth antigravity.*agy acp --login.*Authentication required/u);
    expect(failureText(new Error("could not start agy: spawn agy ENOENT"))).toMatch(/antigravity\.google\/cli\/install\.sh/u);
    expect(failureText(new Error("quota exhausted"))).toBe("Antigravity: quota exhausted");
  });
});

describe("Antigravity models in the picker", () => {
  const listing = `Fetching available models...
gemini-4-carbon-medium\tGemini 4 Carbon (Medium)
gemini-4-carbon-high\tGemini 4 Carbon (High)
gemini-4-carbon-low\tGemini 4 Carbon (Low)
gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)
gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)
gemini-pro-orchestrator\tOrchestrator (Carbon)
gemini-pro-orchestrator-argon\tOrchestrator (Argon)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;
  const models = groupModels(parseModelList(listing));

  it("reads `agy models`, passing over its progress note", () => {
    expect(parseModelList(listing)).toHaveLength(9);
    expect(parseModelList(listing)[0]).toEqual({ modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" });
  });

  it("lists one model per CLI model, with the efforts it has ids for, in order", () => {
    expect(models).toEqual([
      { id: "gemini-4-carbon", name: "Gemini 4 Carbon", efforts: ["low", "medium", "high"] },
      { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", efforts: ["high", "xhigh"] },
      { id: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)", efforts: [] },
      { id: "gemini-pro-orchestrator-argon", name: "Orchestrator (Argon)", efforts: [] },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low"] },
      { id: "gpt-oss-120b", name: "GPT-OSS 120B", efforts: ["medium"] },
    ]);
  });

  it("runs a model at the effort picked, else at its default; one without efforts by its own id", () => {
    expect(cliModelId(models, "gemini-4-carbon", "high")).toBe("gemini-4-carbon-high");
    expect(cliModelId(models, "gemini-4-carbon", null)).toBe("gemini-4-carbon-medium");
    expect(cliModelId(models, "gemini-4-carbon", "xhigh")).toBe("gemini-4-carbon-medium");
    expect(cliModelId(models, "gemini-4-hydrogen", null)).toBe("gemini-4-hydrogen-high");
    expect(cliModelId(models, "gemini-pro-orchestrator", "high")).toBe("gemini-pro-orchestrator");
    expect(cliModelId(models, "not-listed", "high")).toBe("not-listed");
    expect(defaultEffort(models[0]!)).toBe("medium");
    expect(defaultEffort(models[2]!)).toBeNull();
  });

  it("lists a model as stock lists one, another maker's said to be Antigravity's", () => {
    expect(mapAntigravityModel(models[0]!, "antigravity:")).toMatchObject({
      id: "antigravity:gemini-4-carbon", model: "antigravity:gemini-4-carbon", displayName: "Gemini 4 Carbon", hidden: false, isDefault: false,
      defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
    });
    expect(antigravityDisplayName(models[2]!)).toBe("Orchestrator (Carbon)");
    expect(antigravityDisplayName(models[4]!)).toBe("Claude Opus 5.5 (Antigravity)");
    expect(antigravityModelLabel("gemini-4-carbon", models)).toBe("Gemini 4 Carbon");
    expect(antigravityModelLabel("gemini-9-unknown")).toBe("Gemini 9 Unknown");
  });

  it("tells its models by their prefix", () => {
    expect(isAntigravityModel("antigravity:gemini-4-carbon", "antigravity:")).toBe(true);
    expect(isAntigravityModel("claude:opus", "antigravity:")).toBe(false);
    expect(isAntigravityModel(null, "antigravity:")).toBe(false);
    expect(antigravityModelId("antigravity:gemini-4-carbon", "antigravity:")).toBe("gemini-4-carbon");
  });
});

describe("the App's permissions as Antigravity's modes", () => {
  it("maps each App control to a mode, and to the default one where the CLI offers no such mode", () => {
    expect(antigravityMode({ permissionMode: "bypassPermissions", plan: false })).toBe("auto");
    expect(antigravityMode({ permissionMode: "auto", plan: false })).toBe("auto");
    expect(antigravityMode({ permissionMode: "default", plan: false })).toBe("default");
    expect(antigravityMode({ permissionMode: "dontAsk", plan: false })).toBe("default");
    expect(antigravityMode({ permissionMode: "bypassPermissions", plan: true })).toBe("plan");
    expect(antigravityMode({ permissionMode: "bypassPermissions", plan: true }, ["default", "auto"])).toBe("auto");
    expect(antigravityMode({ permissionMode: "bypassPermissions", plan: false }, ["default"])).toBe("default");
  });

  it("answers the CLI's permission prompt with the option the App's decision means", () => {
    // Gemini-CLI-style options; Antigravity offers only `allow` (allow_once) and `deny` (reject_once).
    const options = [
      { optionId: "proceed_always", kind: "allow_always" }, { optionId: "proceed_once", kind: "allow_once" }, { optionId: "cancel", kind: "reject_once" },
    ];
    expect(permissionOutcome("acceptForSession", [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }])).toEqual({ outcome: "selected", optionId: "allow" });
    expect(permissionOutcome("accept", options)).toEqual({ outcome: "selected", optionId: "proceed_once" });
    expect(permissionOutcome("acceptForSession", options)).toEqual({ outcome: "selected", optionId: "proceed_always" });
    expect(permissionOutcome({ acceptWithExecpolicyAmendment: {} }, options)).toEqual({ outcome: "selected", optionId: "proceed_always" });
    expect(permissionOutcome("decline", options)).toEqual({ outcome: "selected", optionId: "cancel" });
    expect(permissionOutcome("cancel", options)).toEqual({ outcome: "cancelled" });
    // No session-wide option offered: once.
    expect(permissionOutcome("acceptForSession", options.slice(1))).toEqual({ outcome: "selected", optionId: "proceed_once" });
    expect(permissionOutcome("accept", [])).toEqual({ outcome: "cancelled" });
  });

  it("decides without asking only where the chat's permissions say so", () => {
    expect(unaskedDecision("dontAsk")).toBe("decline");
    expect(unaskedDecision("bypassPermissions")).toBe("accept");
    expect(unaskedDecision("default")).toBeUndefined();
    expect(unaskedDecision("auto")).toBeUndefined();
  });

  it("asks about a file change on its item, about anything else as a command", () => {
    const context = { threadId: "t", turnId: "turn", itemId: "i", cwd: "/work", title: "Edit a.ts", startedAtMs: 5 };
    expect(approvalRequest({ type: "fileChange", id: "i", changes: [], status: "inProgress" }, context)).toEqual({
      method: "item/fileChange/requestApproval", params: { threadId: "t", turnId: "turn", itemId: "i", startedAtMs: 5, reason: "Edit a.ts", grantRoot: null },
    });
    const command = approvalRequest(undefined, { ...context, title: "rm -rf build" });
    expect(command.method).toBe("item/commandExecution/requestApproval");
    expect(command.params).toMatchObject({ command: "rm -rf build", cwd: "/work", commandActions: [{ type: "unknown", command: "rm -rf build" }], availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] });
  });

  it("takes a chat's settings from a request, and knows another provider's model", () => {
    const current = { cwd: "/work", model: "gemini-4-carbon", effort: null, permissionMode: "default" as const, plan: false };
    expect(settingsFrom({ model: "antigravity:gemini-3.8-flash", effort: "high", cwd: "/other", approvalPolicy: "never", sandbox: "danger-full-access" }, current, "antigravity:"))
      .toEqual({ cwd: "/other", model: "gemini-3.8-flash", effort: "high", permissionMode: "bypassPermissions", plan: false });
    expect(settingsFrom({ collaborationMode: { mode: "plan", settings: { model: "antigravity:gemini-4-carbon", reasoning_effort: "low" } } }, current, "antigravity:"))
      .toEqual({ ...current, effort: "low", plan: true });
    expect(settingsFrom({}, current, "antigravity:")).toEqual(current);
    expect(otherProviderRequested({ model: "gpt-6" }, "antigravity:")).toBe(true);
    expect(otherProviderRequested({ collaborationMode: { settings: { model: "claude:opus" } } }, "antigravity:")).toBe(true);
    expect(otherProviderRequested({ model: "antigravity:gemini-4-carbon" }, "antigravity:")).toBe(false);
    expect(otherProviderRequested({}, "antigravity:")).toBe(false);
  });
});

describe("a file's old and new text as a unified diff", () => {
  it("shows a change with its context and line numbers", () => {
    const before = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 5", "LINE FIVE");
    expect(unifiedDiff(`${before}\n`, `${after}\n`)).toBe("@@ -2,7 +2,7 @@\n line 2\n line 3\n line 4\n-line 5\n+LINE FIVE\n line 6\n line 7\n line 8");
  });

  it("gives far-apart changes hunks of their own, near ones a shared hunk", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `l${index + 1}`);
    const far = lines.map((line, index) => index === 1 || index === 25 ? `${line}!` : line);
    expect(unifiedDiff(lines.join("\n"), far.join("\n")).match(/^@@/gmu)).toHaveLength(2);
    const near = lines.map((line, index) => index === 10 || index === 13 ? `${line}!` : line);
    expect(unifiedDiff(lines.join("\n"), near.join("\n")).match(/^@@/gmu)).toHaveLength(1);
  });

  it("handles additions, removals, and no change", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\nc\n")).toBe("@@ -1,2 +1,3 @@\n a\n b\n+c");
    expect(unifiedDiff("a\nb\nc\n", "a\nc\n")).toBe("@@ -1,3 +1,2 @@\n a\n-b\n c");
    expect(unifiedDiff("", "new\n")).toBe("@@ -0,0 +1,1 @@\n+new");
    expect(unifiedDiff("same\n", "same\n")).toBe("");
  });
});

describe("a proposed change made whole, from the file as it is", () => {
  const files: Record<string, string> = { "/work/a.txt": "one\ntwo\nthree\n", "/work/twice.txt": "x\nx\n" };
  const read = (path: string) => files[path];

  it("places an edit's snippet in the file", () => {
    expect(expandDiffs([{ type: "diff", path: "/work/a.txt", oldText: "two", newText: "2" }], read))
      .toEqual([{ type: "diff", path: "/work/a.txt", oldText: "one\ntwo\nthree\n", newText: "one\n2\nthree\n", _meta: { kind: "modify" } }]);
  });

  it("gives a write over an existing file that file as its old text, and leaves a new file's write as it is", () => {
    expect(expandDiffs([{ type: "diff", path: "/work/a.txt", newText: "fresh" }], read)[0]).toMatchObject({ oldText: "one\ntwo\nthree\n", newText: "fresh", _meta: { kind: "modify" } });
    const created = { type: "diff", path: "/work/new.txt", newText: "hi" };
    expect(expandDiffs([created], read)).toEqual([created]);
  });

  it("leaves what it can't place: a snippet found twice or not at all, a whole-file diff, anything not a diff", () => {
    const entries = [
      { type: "diff", path: "/work/twice.txt", oldText: "x", newText: "y" },
      { type: "diff", path: "/work/a.txt", oldText: "nowhere", newText: "y" },
      { type: "diff", path: "/work/a.txt", oldText: "one\ntwo\nthree\n", newText: "all new\n" },
      { type: "content", content: { type: "text", text: "x" } },
    ];
    expect(expandDiffs(entries, read)).toEqual(entries);
  });
});

describe("the App's input as an ACP prompt", () => {
  it("puts the context before the message, files as links the CLI reads, images inline", async () => {
    const read = async (path: string) => Buffer.from(`bytes of ${path}`);
    const blocks = await promptBlocks([
      { type: "text", text: "look at this" },
      { type: "mention", name: "a.ts", path: "src/a.ts" },
      { type: "image", url: "data:image/PNG;base64,QUJD\n" },
      { type: "image", url: "https://example.com/x.png" },
      { type: "localImage", path: "shot.jpg" },
      { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
    ], "/work", ["earlier", ""], read);
    expect(blocks).toEqual([
      { type: "text", text: "earlier" },
      { type: "text", text: "look at this" },
      { type: "resource_link", uri: "file:///work/src/a.ts", name: "a.ts" },
      { type: "image", mimeType: "image/png", data: "QUJD" },
      { type: "resource_link", uri: "https://example.com/x.png", name: "image" },
      { type: "image", mimeType: "image/jpeg", data: Buffer.from("bytes of /work/shot.jpg").toString("base64") },
      { type: "text", text: "$review (/skills/review/SKILL.md)" },
    ]);
  });

  it("refuses what the CLI can't take", async () => {
    await expect(promptBlocks([{ type: "localImage", path: "a.bmp" }], "/work")).rejects.toThrow(/Unsupported image type/u);
    await expect(promptBlocks([{ type: "audio", url: "x" }], "/work")).rejects.toThrow(/Audio input/u);
  });
});
