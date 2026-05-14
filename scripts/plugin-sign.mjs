import fs from "fs";
import path from "path";
import {
  calculatePluginChecksum,
  deriveKeyId,
  derivePublicKeyPemFromPrivate,
  parseArgs,
  readManifest,
  resolvePluginDir,
  signChecksum,
  writeManifest
} from "./plugin-crypto.mjs";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginDir = resolvePluginDir(args.plugin);
  const privateKeyPath = args["private-key"];
  if (!privateKeyPath || typeof privateKeyPath !== "string") {
    throw new Error("Missing --private-key <path-to-private-pem>.");
  }

  const privateKeyPem = fs.readFileSync(path.resolve(process.cwd(), privateKeyPath), "utf-8");
  const publicKeyPem =
    typeof args["public-key"] === "string"
      ? fs.readFileSync(path.resolve(process.cwd(), args["public-key"]), "utf-8")
      : derivePublicKeyPemFromPrivate(privateKeyPem);
  const keyId = typeof args["key-id"] === "string" ? args["key-id"] : deriveKeyId(publicKeyPem);

  const checksum = calculatePluginChecksum(pluginDir);
  const signature = signChecksum(checksum, privateKeyPem);
  const { manifestPath, manifest } = readManifest(pluginDir);

  manifest.integrity = {
    ...(manifest.integrity || {}),
    algorithm: "sha256",
    checksum,
    signature
  };
  manifest.signer = {
    ...(manifest.signer || {}),
    keyId,
    publicKey: publicKeyPem,
    algorithm: "ed25519"
  };

  writeManifest(manifestPath, manifest);
  console.log(JSON.stringify({ pluginDir, manifestPath, keyId, checksum, signed: true }, null, 2));
}

main();
