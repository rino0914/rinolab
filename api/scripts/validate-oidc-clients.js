#!/usr/bin/env node

import { loadOidcClientRegistry } from "../src/oidc/config.js";

const registryPath = process.argv[2];
if (!registryPath) {
    console.error("Usage: validate-oidc-clients.js <registry-path>");
    process.exit(2);
}

const clients = loadOidcClientRegistry(registryPath);
console.log(`Validated ${clients.length} OIDC client(s).`);
