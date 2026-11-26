import { readFileSync } from "node:fs";

function readPackageVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("version" in parsed) ||
    typeof parsed.version !== "string"
  ) {
    throw new Error("The package manifest does not declare a valid version.");
  }
  return parsed.version;
}

export const packageVersion = readPackageVersion();
