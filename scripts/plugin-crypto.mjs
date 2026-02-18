import fs from "fs";
import path from "path";
import crypto from "crypto";

export function resolvePluginDir(rawPath) {
  if (!rawPath) {
    throw new Error("Missing plugin path. Pass --plugin <path-to-plugin-folder>.");
  }
  return path.resolve(process.cwd(), rawPath);
}

export function readManifest(pluginDir) {
  const manifestPath = path.join(pluginDir, "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`plugin.json not found at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  return { manifestPath, manifest };
}

export function writeManifest(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function collectPluginFiles(pluginDir) {
  const files = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store" || entry.name === "node_modules" || entry.name === "plugin.json") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  };
  walk(pluginDir);
  files.sort();
  return files;
}

export function calculatePluginChecksum(pluginDir) {
  const hash = crypto.createHash("sha256");
  const files = collectPluginFiles(pluginDir);
  for (const filePath of files) {
    hash.update(path.relative(pluginDir, filePath));
    hash.update(fs.readFileSync(filePath));
  }
  return hash.digest("hex");
}

export function derivePublicKeyPemFromPrivate(privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKey = crypto.createPublicKey(privateKey);
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

export function deriveKeyId(publicKeyPem) {
  const digest = crypto.createHash("sha256").update(publicKeyPem).digest("hex");
  return `ed25519:${digest.slice(0, 16)}`;
}

export function signChecksum(checksum, privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(checksum, "utf-8"), privateKey);
  return signature.toString("base64");
}

export function verifyChecksumSignature(checksum, signatureBase64, publicKeyPem) {
  const publicKey = crypto.createPublicKey(publicKeyPem);
  return crypto.verify(
    null,
    Buffer.from(checksum, "utf-8"),
    publicKey,
    Buffer.from(signatureBase64, "base64")
  );
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}
