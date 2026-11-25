/**
 * Writes public/config.local.json for local development, with the deployed relay's address.
 *
 *   npm run config -w @sundo/client          (needs `aws login` first)
 *
 * Reads the WebSocketUrl output of the SundoRealtime-dev stack with the AWS CLI. The file is
 * git-ignored: it's specific to my AWS account.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stack = process.argv[2] ?? "SundoRealtime-dev";
const wsUrl = execFileSync(
  "aws",
  [
    "cloudformation",
    "describe-stacks",
    "--region",
    "ap-southeast-1",
    "--stack-name",
    stack,
    "--query",
    "Stacks[0].Outputs[?OutputKey=='WebSocketUrl'].OutputValue",
    "--output",
    "text",
  ],
  { encoding: "utf8" },
).trim();
if (!wsUrl.startsWith("wss://"))
  throw new Error(`no WebSocketUrl output on ${stack} (got "${wsUrl}")`);

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "config.local.json");
writeFileSync(file, JSON.stringify({ wsUrl }, null, 2) + "\n");
console.log(`wrote ${file}: ${wsUrl}`);
