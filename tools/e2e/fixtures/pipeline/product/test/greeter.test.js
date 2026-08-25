import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGreeting } from "../src/greeter.js";

test("formatGreeting returns Hello, name!", () => {
  assert.equal(formatGreeting("World"), "Hello, World!");
});
