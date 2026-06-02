import { readFileSync, writeFileSync } from "node:fs";

const manifestPath = "manifest.json";
const versionsPath = "versions.json";
const packagePath = "package.json";

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));

manifest.version = pkg.version;
versions[pkg.version] = manifest.minAppVersion;

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n");
