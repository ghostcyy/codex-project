import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

const candidates = [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
  resolve(process.cwd(), "apps/backend/.env")
];

for (const path of candidates) {
  if (existsSync(path)) {
    config({ path });
    break;
  }
}

