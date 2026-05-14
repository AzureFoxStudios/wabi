import {
  calculatePluginChecksum,
  parseArgs,
  readManifest,
  resolvePluginDir,
  verifyChecksumSignature
} from "./plugin-crypto.mjs";

function exitWithFailure(message, details = {}) {
  console.error(JSON.stringify({ ok: false, reason: message, ...details }, null, 2));
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginDir = resolvePluginDir(args.plugin);
  const strict = Boolean(args.strict);
  const { manifest } = readManifest(pluginDir);
  const calculatedChecksum = calculatePluginChecksum(pluginDir);
  const declaredChecksum = manifest.integrity?.checksum;
  const signature = manifest.integrity?.signature;
  const publicKeyPem = manifest.signer?.publicKey;

  if (!declaredChecksum) {
    if (strict) {
      exitWithFailure("Manifest does not declare integrity.checksum", { pluginDir });
    }
  } else if (declaredChecksum !== calculatedChecksum) {
    exitWithFailure("Checksum mismatch", { declaredChecksum, calculatedChecksum, pluginDir });
  }

  let signatureVerified = false;
  if (signature) {
    if (!publicKeyPem) {
      exitWithFailure("Signature exists but signer.publicKey is missing", { pluginDir });
    }
    signatureVerified = verifyChecksumSignature(calculatedChecksum, signature, publicKeyPem);
    if (!signatureVerified) {
      exitWithFailure("Signature verification failed", { pluginDir });
    }
  } else if (strict) {
    exitWithFailure("Strict mode requires integrity.signature", { pluginDir });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        pluginDir,
        checksum: calculatedChecksum,
        checksumDeclared: Boolean(declaredChecksum),
        signatureDeclared: Boolean(signature),
        signatureVerified
      },
      null,
      2
    )
  );
}

main();
