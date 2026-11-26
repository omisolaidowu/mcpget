/* global process, console, URL, setInterval, setTimeout */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../../dist/", import.meta.url);
const { withFileLock } = await import(new URL("installers/file-lock.js", root));
const { installManagedNpm, releaseManagedAssociation, updateManagedMetadata } =
  await import(new URL("installers/managed-npm.js", root));
const [action, ...args] = process.argv.slice(2);

if (action === "hold") {
  await withFileLock(args[0], async () => {
    console.log("LOCK_ACQUIRED");
    await new Promise(() => setInterval(() => {}, 1_000));
  });
} else if (action === "metadata-add") {
  const directory = args[0];
  const metadata = JSON.parse(
    await readFile(join(directory, "mcpget-installation.json"), "utf8"),
  );
  await updateManagedMetadata(
    {
      directory,
      packageIdentifier: metadata.packageIdentifier,
      installedVersion: metadata.installedVersion,
      command: process.execPath,
      args: ["server.js"],
      reused: true,
      lifecycleScriptsEnabled: metadata.lifecycleScriptsEnabled === true,
    },
    {
      serverIdentifier: args[1],
      serverName: args[1],
      client: args[2],
      configurationEntry: args[3],
      verificationStatus: "pending",
    },
  );
} else if (action === "metadata-remove") {
  console.log(
    JSON.stringify(
      await releaseManagedAssociation(args[0], args[1], args[2], args[3]),
    ),
  );
} else if (action === "metadata-interrupt") {
  await withFileLock(args[0], async () => {
    await writeFile(join(args[0], "interrupted.tmp"), "partial");
    console.log("METADATA_LOCK_ACQUIRED");
    await new Promise(() => setInterval(() => {}, 1_000));
  });
} else if (action === "cleanup-interrupt") {
  await withFileLock(args[0], async () => {
    await rm(args[0], { recursive: true, force: true });
    console.log("PACKAGE_REMOVED");
    await new Promise(() => setInterval(() => {}, 1_000));
  });
} else if (action === "install") {
  const [installRoot, identifier, version, delayMs = "0"] = args;
  await installManagedNpm(identifier, version, 30_000, {
    installRoot,
    runInstaller: async (directory) => {
      await new Promise((resolve) => setTimeout(resolve, Number(delayMs)));
      const packageDirectory = join(
        directory,
        "node_modules",
        ...identifier.split("/"),
      );
      await mkdir(join(packageDirectory, "dist"), { recursive: true });
      await writeFile(
        join(packageDirectory, "package.json"),
        JSON.stringify({
          name: identifier,
          version,
          bin: "dist/cli.js",
        }),
      );
      await writeFile(
        join(packageDirectory, "dist", "cli.js"),
        "process.exit(0)",
      );
    },
  });
  console.log("INSTALL_COMPLETE");
} else {
  throw new Error(`Unknown worker action: ${action}`);
}
