import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const outputPath = resolve(process.argv[2] ?? ".oidc/oidc-jwks.json");

const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072
});
const key = privateKey.export({ format: "jwk" });
Object.assign(key, {
    use: "sig",
    alg: "RS256",
    kid: crypto.randomUUID()
});

mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(outputPath, `${JSON.stringify({ keys: [key] }, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx"
});
console.log(`OIDC signing JWKS 생성 완료: ${outputPath}`);
