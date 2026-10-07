import { afterAll, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";

beforeAll(async () => {
  await exports.default.fetch("http://warmup/");
}, 30_000);

afterAll(() => new Promise((resolve) => setTimeout(resolve, 100)));
