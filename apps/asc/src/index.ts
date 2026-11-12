#!/usr/bin/env node
import { createAscClient } from "./asc/client.ts";
import { readCredentials } from "./asc/credentials.ts";
import { createProgram } from "./cli.ts";

await createProgram(async (options) =>
  createAscClient(await readCredentials(options)),
).parseAsync();
