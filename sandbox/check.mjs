// The check the agent must make pass. Deliberately meaningful: it validates content,
// not just that some command runs.
import { readFileSync } from "node:fs";

const WANT = "hello tinycode";
let actual = "";
try {
  actual = readFileSync("greeting.txt", "utf8").trim();
} catch {
  console.log("FAIL greeting.txt is missing");
  process.exit(1);
}

if (actual === WANT) {
  console.log("PASS greeting.txt = " + JSON.stringify(actual));
  process.exit(0);
}

console.log("FAIL expected " + JSON.stringify(WANT) + " but got " + JSON.stringify(actual));
process.exit(1);
