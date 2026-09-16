import { readFileSync } from "node:fs";

function required(name, environment) {
    const value = environment[name]?.trim();
    if (!value) {
        throw new Error(`${name} 환경변수가 필요합니다.`);
    }
    return value;
}

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === "") return defaultValue;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error("OIDC_ENABLED는 true 또는 false여야 합니다.");
}

function parseClientBoolean(value, name) {
    if (typeof value !== "boolean") {
        throw new Error(`${name}은 boolean이어야 합니다.`);
    }
    return value;
}

function parseUrl(value, name) {
    if (value.includes("*")) {
        throw new Error(`${name}에는 wildcard를 사용할 수 없습니다.`);
    }

    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${name}에 올바른 절대 URL이 필요합니다.`);
    }

    const localHttp = url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname);
    const supportedProtocol = url.protocol === "https:" || localHttp;

    if (!supportedProtocol || url.hash) {
        throw new Error(`${name}에 허용되지 않은 URL이 포함되어 있습니다.`);
    }

    return value;
}

function parseUrlList(name, environment) {
    const values = required(name, environment)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

    if (values.length === 0) {
        throw new Error(`${name}에 URL을 하나 이상 설정해야 합니다.`);
    }

    return values.map((value, index) =>
        parseUrl(value, `${name}[${index}]`));
}

function validateClient(client, index) {
    const prefix = `clients[${index}]`;
    if (!client || typeof client !== "object" || Array.isArray(client)) {
        throw new Error(`${prefix}는 object여야 합니다.`);
    }

    const clientId = String(client.client_id ?? "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(clientId)) {
        throw new Error(`${prefix}.client_id는 영문, 숫자, _, -만 사용할 수 있습니다.`);
    }
    const clientSecret = String(client.client_secret ?? "").trim();
    if (!clientSecret || /^(CHANGE_ME|REPLACE_ON_SERVER)$/.test(clientSecret)) {
        throw new Error(`${prefix}.client_secret이 필요합니다.`);
    }
    const clientName = String(client.client_name ?? clientId).trim() || clientId;

    const urlList = (name, required = true) => {
        const values = client[name];
        if (!Array.isArray(values) || (required && values.length === 0)) {
            throw new Error(`${prefix}.${name}에 URL을 하나 이상 설정해야 합니다.`);
        }
        return values.map((value, urlIndex) => {
            if (typeof value !== "string") {
                throw new Error(`${prefix}.${name}[${urlIndex}]는 문자열이어야 합니다.`);
            }
            return parseUrl(value.trim(), `${prefix}.${name}[${urlIndex}]`);
        });
    };

    const allowedGrantTypes = new Set(["authorization_code", "refresh_token"]);
    const grantTypes = client.grant_types ?? ["authorization_code"];
    if (!Array.isArray(grantTypes) || grantTypes.length === 0 ||
        grantTypes.some((value) => !allowedGrantTypes.has(value)) ||
        !grantTypes.includes("authorization_code")) {
        throw new Error(`${prefix}.grant_types가 올바르지 않습니다.`);
    }
    const responseTypes = client.response_types ?? ["code"];
    if (!Array.isArray(responseTypes) || responseTypes.length !== 1 ||
        responseTypes[0] !== "code") {
        throw new Error(`${prefix}.response_types는 ["code"]여야 합니다.`);
    }
    const authMethod = client.token_endpoint_auth_method;
    if (!["client_secret_post", "client_secret_basic"].includes(authMethod)) {
        throw new Error(`${prefix}.token_endpoint_auth_method가 올바르지 않습니다.`);
    }

    return {
        metadata: {
            client_id: clientId,
            client_name: clientName,
            client_secret: clientSecret,
            redirect_uris: urlList("redirect_uris"),
            post_logout_redirect_uris: urlList("post_logout_redirect_uris", false),
            grant_types: [...new Set(grantTypes)],
            response_types: responseTypes,
            token_endpoint_auth_method: authMethod,
            id_token_signed_response_alg: "RS256"
        },
        pkceRequired: parseClientBoolean(client.pkce_required, `${prefix}.pkce_required`)
    };
}

export function loadOidcClientRegistry(registryPath) {
    let registry;
    try {
        registry = JSON.parse(readFileSync(registryPath, "utf8"));
    } catch (error) {
        throw new Error(`OIDC client registry를 읽을 수 없습니다: ${error.message}`);
    }
    if (!registry || !Array.isArray(registry.clients) || registry.clients.length === 0) {
        throw new Error("OIDC client registry에 clients 배열이 필요합니다.");
    }

    const clients = registry.clients.map(validateClient);
    const ids = clients.map(({ metadata }) => metadata.client_id);
    if (new Set(ids).size !== ids.length) {
        throw new Error("OIDC client registry의 client_id는 서로 달라야 합니다.");
    }
    return clients;
}

function parseClientRegistry(environment) {
    const registryPath = environment.OIDC_CLIENTS_FILE?.trim();
    return registryPath ? loadOidcClientRegistry(registryPath) : undefined;
}

function parseLegacyClient(environment) {
    const clientId = required("OIDC_CLIENT_ID", environment);
    if (!/^[A-Za-z0-9_-]+$/.test(clientId)) {
        throw new Error("OIDC_CLIENT_ID는 영문, 숫자, _, -만 사용할 수 있습니다.");
    }
    return [{
        metadata: {
            client_id: clientId,
            client_name: environment.OIDC_CLIENT_NAME?.trim() || clientId,
            client_secret: required("OIDC_CLIENT_SECRET", environment),
            redirect_uris: parseUrlList("OIDC_REDIRECT_URIS", environment),
            post_logout_redirect_uris: parseUrlList("OIDC_POST_LOGOUT_REDIRECT_URIS", environment),
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method:
                environment.OIDC_TOKEN_ENDPOINT_AUTH_METHOD?.trim() || "client_secret_post",
            id_token_signed_response_alg: "RS256"
        },
        pkceRequired: true
    }];
}

function parseSigningKeys(environment) {
    const inlineKey = environment.OIDC_SIGNING_KEY?.trim();
    const keyPath = environment.OIDC_SIGNING_KEY_PATH?.trim();

    if (!inlineKey && !keyPath) {
        throw new Error("OIDC_SIGNING_KEY 또는 OIDC_SIGNING_KEY_PATH가 필요합니다.");
    }

    let parsed;
    try {
        parsed = JSON.parse(inlineKey || readFileSync(keyPath, "utf8"));
    } catch (error) {
        throw new Error(`OIDC signing JWK를 읽을 수 없습니다: ${error.message}`);
    }

    const keys = Array.isArray(parsed.keys) ? parsed.keys : [parsed];
    if (keys.length === 0) {
        throw new Error("OIDC signing JWKS에 private key가 필요합니다.");
    }

    const keyIds = new Set();
    for (const key of keys) {
        if (key.kty !== "RSA" || !key.d || key.alg !== "RS256" || !key.kid) {
            throw new Error("OIDC signing key는 kid가 있는 RS256 RSA private JWK여야 합니다.");
        }
        if (keyIds.has(key.kid)) {
            throw new Error("OIDC signing key의 kid는 서로 달라야 합니다.");
        }
        keyIds.add(key.kid);
    }

    return { keys };
}

function parseCookieKeys(environment) {
    const keys = required("OIDC_COOKIE_KEYS", environment)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

    if (keys.length < 2 || keys.some((key) => key.length < 32)) {
        throw new Error("OIDC_COOKIE_KEYS에는 32자 이상의 키를 현재 키부터 두 개 이상 설정해야 합니다.");
    }

    return keys;
}

export function loadOidcConfig(environment = process.env) {
    if (!parseBoolean(environment.OIDC_ENABLED, false)) {
        return undefined;
    }

    const issuer = parseUrl(required("OIDC_ISSUER", environment), "OIDC_ISSUER");
    if (new URL(issuer).pathname !== "/") {
        throw new Error("OIDC_ISSUER는 path가 없는 전용 origin이어야 합니다.");
    }
    const accountOrigin = parseUrl(
        required("OIDC_ACCOUNT_ORIGIN", environment),
        "OIDC_ACCOUNT_ORIGIN"
    );
    const configuredClients = parseClientRegistry(environment) ??
        parseLegacyClient(environment);

    return {
        issuer,
        accountOrigin: new URL(accountOrigin).origin,
        isProduction: environment.NODE_ENV === "production",
        cookieKeys: parseCookieKeys(environment),
        jwks: parseSigningKeys(environment),
        clients: configuredClients.map(({ metadata }) => metadata),
        pkceRequiredByClient: Object.fromEntries(configuredClients.map(
            ({ metadata, pkceRequired }) => [metadata.client_id, pkceRequired]
        ))
    };
}
