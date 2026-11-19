// Native Google Decisions provider (JEV_PROVIDER=google): request mapping, media loading, and the decisions_ask tool.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { toGoogleDecisionsBody, googleModel } from "../dist/provider.js";
import { loadBlock, safePath, mimeFor } from "../dist/media.js";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("toGoogleDecisionsBody: string, object and content-block input", () => {
  assert.equal(toGoogleDecisionsBody("hello", {}, "m").input, "hello");
  assert.equal(toGoogleDecisionsBody({ a: 1 }, {}, "m").input, JSON.stringify({ a: 1 }));
  const blocks = [{ type: "text", text: "x" }, { type: "image", data: "AA==", mime_type: "image/png" }];
  assert.deepEqual(toGoogleDecisionsBody(blocks, {}, "m").input, blocks);
  // an array of plain values is data, not content blocks
  assert.equal(toGoogleDecisionsBody([1, 2], {}, "m").input, "[1,2]");
});

test("toGoogleDecisionsBody: question mapping", () => {
  const { questions } = toGoogleDecisionsBody("s", {
    n: { type: "noul", instructions: "q", criteria: { true: "yes", false: "no" } },
    n2: { type: "noul", instructions: "q" },
    c: { type: "choice", instructions: { task: "t", item: { id: "i" } }, criteria: { a: null, b: "desc" } },
    s: { type: "score", instructions: "q", criteria: ["low", "high"] },
  }, "m");
  assert.deepEqual(questions.n.criteria, { true_description: "yes", false_description: "no" });
  assert.equal(questions.n2.criteria, undefined);
  assert.equal(questions.c.instructions, JSON.stringify({ task: "t", item: { id: "i" } }));
  assert.deepEqual(questions.c.criteria, { a: "", b: "desc" });
  assert.deepEqual(questions.s.criteria, ["low", "high"]);
});

test("googleModel", () => {
  const prev = { g: process.env.JEV_GOOGLE_MODEL };
  delete process.env.JEV_GOOGLE_MODEL;
  assert.equal(googleModel("jev-latest"), "gemini-decision-1");
  assert.equal(googleModel("gemini-decision-2"), "gemini-decision-2");
  process.env.JEV_GOOGLE_MODEL = "custom";
  assert.equal(googleModel("jev-latest"), "custom");
  if (prev.g === undefined) delete process.env.JEV_GOOGLE_MODEL; else process.env.JEV_GOOGLE_MODEL = prev.g;
});

test("media: path guard, mime inference, size and uri rules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jev-media-"));
  const outside = await mkdtemp(path.join(tmpdir(), "jev-outside-"));
  await mkdir(path.join(root, "sub"));
  await writeFile(path.join(root, "sub", "a.png"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(outside, "secret.pdf"), "secret");
  await symlink(path.join(outside, "secret.pdf"), path.join(root, "link.pdf"));
  process.env.JEV_MEDIA_ROOT = root;
  try {
    const ok = await loadBlock({ type: "image", path: "sub/a.png", resolution: "low" });
    assert.deepEqual(ok, { type: "image", resolution: "low", data: Buffer.from([1, 2, 3]).toString("base64"), mime_type: "image/png" });
    await assert.rejects(loadBlock({ type: "document", path: "../" + path.basename(outside) + "/secret.pdf" }), /outside JEV_MEDIA_ROOT|ENOENT/);
    await assert.rejects(safePath("link.pdf"), /outside JEV_MEDIA_ROOT/);
    await assert.rejects(loadBlock({ type: "document", path: "sub/a.png", uri: "https://x/y.pdf" }), /exactly one/);
    await assert.rejects(loadBlock({ type: "audio", uri: "http://x/a.wav", mime_type: "audio/wav" }), /https/);
    await assert.rejects(loadBlock({ type: "audio", data: "AA==" }), /mime_type/);
    await assert.rejects(loadBlock({ type: "audio", path: "sub/a.png", resolution: "low" }), /image and video/);
    process.env.JEV_MEDIA_MAX_BYTES = "2";
    await assert.rejects(loadBlock({ type: "image", path: "sub/a.png" }), /inline cap/);
  } finally {
    delete process.env.JEV_MEDIA_ROOT;
    delete process.env.JEV_MEDIA_MAX_BYTES;
  }
  assert.equal(mimeFor("x.PDF"), "application/pdf");
  assert.equal(mimeFor("x.unknown"), undefined);
});

test("google provider end to end against a mock: tool list, jev_noul mapping, decisions_ask multimodal", async () => {
  const seen = [];
  const mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, key: req.headers["x-goog-api-key"], body });
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [
        id,
        q.type === "noul" ? { type: "noul", noul: 0.95, confidence: 0.95 }
          : q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria)[0], probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 0.6 : 0.4 / (Object.keys(q.criteria).length - 1)])), confidence: 0.6 }
            : { type: "score", score: 1, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 }, confidence: 0.8 },
      ]));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ answers, usage: { total_input_tokens: 42, total_output_tokens: 0 } }));
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(tmpdir(), "jev-e2e-"));
  await writeFile(path.join(root, "p.png"), Buffer.from([9, 9]));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { PATH: process.env.PATH, JEV_PROVIDER: "google", GEMINI_API_KEY: "test-key", JEV_GOOGLE_BASE_URL: `http://127.0.0.1:${mock.address().port}`, JEV_MEDIA_ROOT: root },
  });
  const client = new Client({ name: "t", version: "0" });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(names.length, 13);
    assert.ok(names.includes("decisions_ask"));

    const noulRes = await client.callTool({ name: "jev_noul", arguments: { propositions: ["The sky is blue."] } });
    const noulJson = JSON.parse(noulRes.content[0].text);
    assert.equal(noulJson.provider, "google");
    assert.equal(noulJson.model, "gemini-decision-1");
    assert.equal(noulJson.results[0].label, "likely");
    assert.equal(seen[0].url, "/v1beta/decisions");
    assert.equal(seen[0].key, "test-key");
    assert.equal(seen[0].body.model, "gemini-decision-1");
    assert.ok(seen[0].body.questions.p_proposition0.criteria.true_description);

    const ask = await client.callTool({ name: "decisions_ask", arguments: {
      input: [{ type: "image", path: "p.png", resolution: "low" }, { type: "text", text: "\nPage 1" }],
      questions: {
        a: { type: "noul", instructions: "Is there a logo?" },
        b: { type: "choice", instructions: "Topic?", criteria: { rounding: "", other: "" } },
        c: { type: "score", instructions: "How filled in?", criteria: ["none", "some", "most"] },
      },
    } });
    assert.ok(!ask.isError, ask.content?.[0]?.text);
    const j = JSON.parse(ask.content[0].text);
    assert.deepEqual(seen[1].body.input[0], { type: "image", resolution: "low", data: Buffer.from([9, 9]).toString("base64"), mime_type: "image/png" });
    assert.deepEqual(seen[1].body.input[1], { type: "text", text: "\nPage 1" });
    assert.equal(j.results.find((r) => r.id === "a").decision, "auto");
    assert.equal(j.results.find((r) => r.id === "b").decision, "review");
    assert.equal(j.usage.input_tokens, 42);

    const bad = await client.callTool({ name: "decisions_ask", arguments: { input: [{ type: "image", path: "../../etc/hosts" }], questions: { a: { type: "noul", instructions: "x" } } } });
    assert.ok(bad.isError);
  } finally {
    await client.close();
    mock.close();
  }
});

test("decisions_ask is not registered for other providers", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { PATH: process.env.PATH, JEV_PROVIDER: "compatible", JEV_API_KEY: "k", JEV_API_BASE_URL: "http://127.0.0.1:1/v1/systemone" } });
  const client = new Client({ name: "t", version: "0" });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(names.length, 12);
    assert.ok(!names.includes("decisions_ask"));
  } finally {
    await client.close();
  }
});
