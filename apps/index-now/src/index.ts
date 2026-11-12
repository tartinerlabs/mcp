#!/usr/bin/env node
import { createProgram } from "./cli.ts";
import { indexNowClient } from "./indexnow/client.ts";

// Runs on the user's machine so IndexNow sees their IP: cloud egress IPs are
// shared with every other tenant and IndexNow rate-limits them permanently.
await createProgram(indexNowClient).parseAsync();
