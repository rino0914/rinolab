import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { Duplex } from "node:stream";
import { describe, it } from "node:test";
import { ObjectId } from "mongodb";
import { claimsForAccount, createOidcAccountFinder } from "../src/oidc/account.js";
import { loadOidcConfig } from "../src/oidc/config.js";
import { createOidcProvider } from "../src/oidc/provider.js";

function createTestJwks() {
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048
    });
    return {
        keys: [{
            ...privateKey.export({ format: "jwk" }),
            kid: "test-signing-key",
            use: "sig",
            alg: "RS256"
        }]
    };
}

function createEnvironment(overrides = {}) {
    return {
        NODE_ENV: "development",
        OIDC_ENABLED: "true",
        OIDC_ISSUER: "http://127.0.0.1",
        OIDC_ACCOUNT_ORIGIN: "http://localhost:8080",
        OIDC_SIGNING_KEY: JSON.stringify(createTestJwks()),
        OIDC_COOKIE_KEYS: `${"a".repeat(32)},${"b".repeat(32)}`,
        OIDC_CLIENT_ID: "immich",
        OIDC_CLIENT_NAME: "Immich",
        OIDC_CLIENT_SECRET: "test-client-secret-at-least-32-characters",
        OIDC_REDIRECT_URIS: "http://localhost:2283/auth/login,http://localhost:2283/api/oauth/mobile-redirect",
        OIDC_POST_LOGOUT_REDIRECT_URIS: "http://localhost:2283/",
        OIDC_TOKEN_ENDPOINT_AUTH_METHOD: "client_secret_post",
        ...overrides
    };
}

class MemorySocket extends Duplex {
    constructor() {
        super();
        this.output = "";
    }

    _read() {}

    _write(chunk, encoding, callback) {
        this.output += chunk.toString();
        callback();
    }
}

async function requestProvider(provider, path) {
    const socket = new MemorySocket();
    const request = new http.IncomingMessage(socket);
    request.method = "GET";
    request.url = path;
    request.headers = { host: "127.0.0.1" };
    request.push(null);

    const response = new http.ServerResponse(request);
    response.assignSocket(socket);

    await new Promise((resolve, reject) => {
        response.once("finish", resolve);
        response.once("error", reject);
        provider.callback()(request, response);
    });

    const body = socket.output.split("\r\n\r\n", 2)[1];
    return {
        status: response.statusCode,
        headers: response.getHeaders(),
        body
    };
}

describe("OIDC account claims", () => {
    it("uses the immutable MongoDB id as sub", () => {
        const account = {
            _id: new ObjectId("64b64cbb2f67d0e8fdd1a001"),
            email: "user@rinolab.org",
            name: "홍길동",
            role: "USER"
        };

        assert.deepEqual(claimsForAccount(account), {
            sub: "64b64cbb2f67d0e8fdd1a001",
            email: "user@rinolab.org",
            email_verified: false,
            name: "홍길동",
            preferred_username: "user@rinolab.org",
            rinolab_role: "USER"
        });
    });

    it("does not expose inactive accounts", async () => {
        const findAccount = createOidcAccountFinder(() => ({
            collection() {
                return {
                    async findOne() {
                        return null;
                    }
                };
            }
        }));

        const account = await findAccount(
            undefined,
            "64b64cbb2f67d0e8fdd1a001"
        );
        assert.equal(account, undefined);
    });
});

describe("OIDC configuration", () => {
    it("stays disabled unless explicitly enabled", () => {
        assert.equal(loadOidcConfig({ OIDC_ENABLED: "false" }), undefined);
    });

    it("rejects wildcard redirect URIs", () => {
        assert.throws(
            () => loadOidcConfig(createEnvironment({
                OIDC_REDIRECT_URIS: "https://*.rinolab.org/callback"
            })),
            /wildcard/
        );
    });
});

describe("OIDC discovery", () => {
    it("publishes the required endpoints, scopes, PKCE, and RS256", async () => {
        const config = loadOidcConfig(createEnvironment());
        const provider = createOidcProvider(config, {
            adapter: null,
            findAccount: async () => undefined
        });
        const response = await requestProvider(
            provider,
            "/.well-known/openid-configuration"
        );
        assert.equal(response.status, 200);

        const discovery = JSON.parse(response.body);
        assert.equal(discovery.issuer, "http://127.0.0.1");
        assert.ok(discovery.authorization_endpoint.endsWith("/auth"));
        assert.ok(discovery.token_endpoint.endsWith("/token"));
        assert.ok(discovery.userinfo_endpoint.endsWith("/me"));
        assert.ok(discovery.jwks_uri.endsWith("/jwks"));
        assert.ok(discovery.end_session_endpoint.endsWith("/session/end"));
        assert.equal(discovery.pushed_authorization_request_endpoint, undefined);
        assert.deepEqual(discovery.response_types_supported, ["code"]);
        assert.deepEqual(
            ["openid", "profile", "email"].every((scope) =>
                discovery.scopes_supported.includes(scope)),
            true
        );
        assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
        assert.deepEqual(discovery.id_token_signing_alg_values_supported, ["RS256"]);
        assert.ok(discovery.claims_supported.includes("email"));
        assert.ok(discovery.claims_supported.includes("preferred_username"));
        assert.ok(discovery.claims_supported.includes("rinolab_role"));

        const jwksResponse = await requestProvider(provider, "/jwks");
        assert.equal(jwksResponse.status, 200);
        const publicJwks = JSON.parse(jwksResponse.body);
        assert.equal(publicJwks.keys.length, 1);
        assert.equal(publicJwks.keys[0].alg, "RS256");
        assert.equal(publicJwks.keys[0].d, undefined);
        assert.equal(discovery.pushed_authorization_request_endpoint, undefined);
        assert.deepEqual(discovery.response_types_supported, ["code"]);
    });

    it("rejects authorization code requests without PKCE", async () => {
        const config = loadOidcConfig(createEnvironment());
        const provider = createOidcProvider(config, {
            adapter: null,
            findAccount: async () => undefined
        });
        const query = new URLSearchParams({
            client_id: "immich",
            redirect_uri: "http://localhost:2283/auth/login",
            response_type: "code",
            scope: "openid email profile",
            state: "test-state"
        });

        const response = await requestProvider(provider, `/auth?${query}`);
        assert.equal(response.status, 303, response.body);

        const redirect = new URL(response.headers.location);
        assert.equal(redirect.searchParams.get("error"), "invalid_request");
        assert.match(
            redirect.searchParams.get("error_description"),
            /PKCE|code_challenge/
        );
    });

    it("starts an interaction for a valid S256 authorization request", async () => {
        const config = loadOidcConfig(createEnvironment());
        const provider = createOidcProvider(config, {
            adapter: null,
            findAccount: async () => undefined
        });
        const verifier = "test-pkce-verifier-with-at-least-forty-three-characters";
        const challenge = crypto.createHash("sha256")
            .update(verifier)
            .digest("base64url");
        const query = new URLSearchParams({
            client_id: "immich",
            redirect_uri: "http://localhost:2283/auth/login",
            response_type: "code",
            scope: "openid email profile",
            state: "test-state",
            code_challenge: challenge,
            code_challenge_method: "S256"
        });

        const response = await requestProvider(provider, `/auth?${query}`);
        assert.equal(response.status, 303, response.body);
        assert.match(response.headers.location, /^\/interaction\//);
    });
});
