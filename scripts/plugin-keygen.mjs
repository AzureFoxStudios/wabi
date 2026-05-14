import fs from "fs";
import path from "path";
import crypto from "crypto";
import { deriveKeyId, parseArgs } from "./plugin-crypto.mjs";

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(process.cwd(), args["out-dir"] || ".wabi-keys");

  ensureDir(outDir);

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const keyId = typeof args["key-id"] === "string" ? args["key-id"] : deriveKeyId(publicKeyPem);
  const fileBase = keyId.replace(/[^a-zA-Z0-9._-]/g, "_");

  const privateKeyPath = path.join(outDir, `${fileBase}.private.pem`);
  const publicKeyPath = path.join(outDir, `${fileBase}.public.pem`);
  const metadataPath = path.join(outDir, `${fileBase}.json`);

  fs.writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, publicKeyPem);
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        keyId,
        algorithm: "ed25519",
        publicKeyPath,
        privateKeyPath,
        createdAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );

  console.log(JSON.stringify({ keyId, publicKeyPath, privateKeyPath, metadataPath }, null, 2));
}

main();
