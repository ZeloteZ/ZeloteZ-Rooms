"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { test } = require("node:test");
const { hasRoomsPageHeaders, verifyInstance } = require("../instance.cjs");

test("only a current Rooms descriptor and marked HTML on the exact origin pass", async () => {
  let behavior = "rooms";
  let origin;
  const visits = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    visits.push(request.method + " " + url.pathname);
    if (url.pathname === "/api/desktop/instance") {
      if (behavior === "redirect") return response.writeHead(302, { Location: "/redirect-target" }).end();
      if (behavior === "arbitrary") return response.writeHead(200, { "Content-Type": "text/html" }).end("<h1>Other site</h1>");
      const descriptor = {
        product: "zelotez-rooms",
        origin,
        protocol: behavior === "incompatible" ? 2 : 1,
        nonce: behavior === "old" ? "a".repeat(32) : url.searchParams.get("nonce"),
      };
      return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(descriptor));
    }
    const headers = { "Content-Type": "text/html; charset=utf-8" };
    if (behavior !== "unmarked") headers["X-ZeloteZ-Rooms-Client"] = "1";
    return response.writeHead(200, headers).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = "http://127.0.0.1:" + server.address().port;
  try {
    assert.equal(await verifyInstance(origin + "/"), origin);
    assert.deepEqual(visits, ["GET /api/desktop/instance", "HEAD /"]);
    for (const failure of ["redirect", "arbitrary", "unmarked", "old", "incompatible"]) {
      behavior = failure;
      visits.length = 0;
      await assert.rejects(verifyInstance(origin), { code: failure === "incompatible" ? "incompatible" : "not_rooms" });
      assert.deepEqual(visits, ["GET /api/desktop/instance", ...(failure === "unmarked" ? ["HEAD /"] : [])]);
    }
    visits.length = 0;
    for (const address of [origin + "/unrelated", origin + "?query", origin + "#fragment", "http://example.test"]) {
      await assert.rejects(verifyInstance(address), { code: "invalid" });
    }
    assert.deepEqual(visits, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("renderer verification only accepts the expected successful HTML response", () => {
  const headers = { "Content-Type": ["text/html"], "X-ZeloteZ-Rooms-Client": ["1"] };
  assert.equal(hasRoomsPageHeaders(200, headers), true);
  assert.equal(hasRoomsPageHeaders(302, headers), false);
  assert.equal(hasRoomsPageHeaders(200, { ...headers, "Content-Type": ["application/json"] }), false);
  assert.equal(hasRoomsPageHeaders(200, { ...headers, "x-zelotez-rooms-client": ["1"] }), false);
  assert.equal(hasRoomsPageHeaders(200, { "Content-Type": ["text/html"] }), false);
});
