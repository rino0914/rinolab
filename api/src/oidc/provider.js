import { Provider } from "oidc-provider";
import { MongoOidcAdapter } from "./adapter.js";
import { createOidcAccountFinder } from "./account.js";

function htmlEscape(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

export function createOidcProvider(config, options = {}) {
    const Adapter = options.adapter === undefined
        ? MongoOidcAdapter
        : options.adapter;
    const findAccount = options.findAccount ?? createOidcAccountFinder();

    const provider = new Provider(config.issuer, {
        ...(Adapter ? { adapter: Adapter } : {}),
        clients: config.clients,
        jwks: config.jwks,
        cookies: {
            keys: config.cookieKeys,
            long: {
                httpOnly: true,
                sameSite: "lax",
                secure: config.isProduction
            },
            short: {
                httpOnly: true,
                sameSite: "lax",
                secure: config.isProduction
            }
        },
        claims: {
            openid: ["sub"],
            email: ["email", "email_verified"],
            profile: ["name", "preferred_username", "username", "rinolab_role"]
        },
        scopes: ["openid", "profile", "email", "offline_access"],
        findAccount,
        interactions: {
            url(context, interaction) {
                return `/interaction/${interaction.uid}`;
            }
        },
        pkce: {
            required(context, client) {
                return config.pkceRequiredByClient[client.clientId] === true;
            }
        },
        clientAuthMethods: ["client_secret_post", "client_secret_basic"],
        responseTypes: ["code"],
        ttl: {
            AccessToken: 60 * 60,
            AuthorizationCode: 60,
            IdToken: 60 * 60,
            Interaction: 10 * 60,
            Grant: 30 * 24 * 60 * 60,
            RefreshToken: 30 * 24 * 60 * 60,
            Session: 30 * 24 * 60 * 60
        },
        renderError(context, error) {
            context.type = "html";
            context.body = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>OIDC 오류 — RinoLab</title></head>
<body><main><h1>인증 요청을 처리하지 못했습니다.</h1>
<p>${htmlEscape(error.error_description || error.error)}</p></main></body></html>`;
        },
        enabledJWA: {
            idTokenSigningAlgValues: ["RS256"]
        },
        features: {
            devInteractions: { enabled: false },
            pushedAuthorizationRequests: { enabled: false },
            requestObjects: { enabled: false },
            registration: { enabled: false },
            rpInitiatedLogout: { enabled: true },
            userinfo: { enabled: true }
        }
    });

    provider.proxy = config.isProduction;
    return provider;
}
