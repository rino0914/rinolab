import crypto from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { findActiveAccountById } from "../accounts.js";
import { getDB } from "../db.js";

const handoffLifetimeMs = 2 * 60 * 1000;
const interactionUidPattern = /^[A-Za-z0-9_-]{16,200}$/;
const interactionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false
});

function htmlEscape(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function tokenHash(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function constantTimeEqual(left, right) {
    if (typeof left !== "string" || typeof right !== "string") return false;
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length &&
        crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(request) {
    const cookies = new Map();
    for (const part of (request.headers.cookie ?? "").split(";")) {
        const separator = part.indexOf("=");
        if (separator === -1) continue;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        cookies.set(name, value);
    }
    return cookies;
}

function csrfCookieName(uid) {
    return `rinus_oidc_csrf_${uid}`;
}

function setCsrfCookie(response, uid, token, secure) {
    const attributes = [
        `${csrfCookieName(uid)}=${token}`,
        `Path=/interaction/${uid}`,
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=600"
    ];
    if (secure) attributes.push("Secure");
    response.append("Set-Cookie", attributes.join("; "));
}

function clearCsrfCookie(response, uid, secure) {
    const attributes = [
        `${csrfCookieName(uid)}=`,
        `Path=/interaction/${uid}`,
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=0"
    ];
    if (secure) attributes.push("Secure");
    response.append("Set-Cookie", attributes.join("; "));
}

function validateCsrf(request, uid) {
    const cookieToken = parseCookies(request).get(csrfCookieName(uid));
    return constantTimeEqual(cookieToken, request.body.csrfToken);
}

function renderPage({ title, body }) {
    return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${htmlEscape(title)} — RinoLab</title>
    <style>
        :root { color-scheme: light; font-family: system-ui, sans-serif; background: #f7f7f5; color: #20201d; }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
        main { width: min(34rem, calc(100% - 2rem)); background: white; border: 1px solid #deded8; border-radius: 1rem; padding: 2rem; box-sizing: border-box; box-shadow: 0 1rem 3rem rgb(0 0 0 / 8%); }
        h1 { margin-top: 0; font-size: 1.6rem; }
        p, li { line-height: 1.6; }
        ul { padding-left: 1.25rem; }
        .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
        button { border: 0; border-radius: .6rem; padding: .8rem 1rem; font: inherit; cursor: pointer; }
        .primary { background: #20201d; color: white; }
        .secondary { background: #ecece7; color: #20201d; }
    </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function renderConsent({ uid, client, scopes, csrfToken }) {
    const scopeItems = scopes
        .map((scope) => `<li><code>${htmlEscape(scope)}</code></li>`)
        .join("");

    return renderPage({
        title: "접근 권한 확인",
        body: `
            <h1>${htmlEscape(client.clientName || client.clientId)} 연결</h1>
            <p>다음 RinoLab 계정 정보에 대한 접근을 요청했습니다.</p>
            <ul>${scopeItems}</ul>
            <form method="post" action="/interaction/${htmlEscape(uid)}/consent">
                <input type="hidden" name="csrfToken" value="${htmlEscape(csrfToken)}">
                <div class="actions">
                    <button class="primary" type="submit" name="decision" value="allow">허용</button>
                    <button class="secondary" type="submit" name="decision" value="deny">거부</button>
                </div>
            </form>`
    });
}

function renderHandoffForm({ issuer, uid, token, scriptNonce }) {
    const action = new URL(`/interaction/${uid}/handoff`, issuer).href;

    return renderPage({
        title: "통합 로그인 연결",
        body: `
            <h1>RinoLab 통합 로그인</h1>
            <p>로그인 상태를 안전하게 연결하고 있습니다.</p>
            <form id="handoff" method="post" action="${htmlEscape(action)}">
                <input type="hidden" name="token" value="${htmlEscape(token)}">
                <button class="primary" type="submit">계속</button>
            </form>
            <script nonce="${htmlEscape(scriptNonce)}">document.getElementById("handoff").submit();</script>`
    });
}

async function saveHandoff(accountId, uid) {
    const token = crypto.randomBytes(32).toString("base64url");
    await getDB().collection("oidc_handoffs").insertOne({
        _id: tokenHash(token),
        accountId,
        uid,
        expiresAt: new Date(Date.now() + handoffLifetimeMs)
    });
    return token;
}

async function consumeHandoff(token, uid) {
    if (typeof token !== "string" || token.length > 200) return undefined;

    const handoff = await getDB().collection("oidc_handoffs").findOneAndDelete({
        _id: tokenHash(token),
        uid,
        expiresAt: { $gt: new Date() }
    });

    return handoff?.accountId;
}

function loginReturnPath(uid) {
    return `/api/oidc/handoff?uid=${encodeURIComponent(uid)}`;
}

export function createOidcInteractionRouter(provider, config) {
    const router = express.Router();
    const parseForm = express.urlencoded({ extended: false, limit: "8kb" });
    const noStore = (request, response, next) => {
        response.set("Cache-Control", "no-store");
        next();
    };

    router.use("/api/oidc/handoff", interactionLimiter, noStore);
    router.use("/interaction", interactionLimiter, noStore);

    router.get("/api/oidc/handoff", async (request, response) => {
        const uid = request.query.uid;
        if (typeof uid !== "string" || !interactionUidPattern.test(uid)) {
            return response.status(400).send("잘못된 OIDC 요청입니다.");
        }

        const account = await findActiveAccountById(request.session.accountId);
        if (!account) {
            const loginUrl = new URL("/pages/login.html", config.accountOrigin);
            loginUrl.searchParams.set("returnTo", loginReturnPath(uid));
            return response.redirect(303, loginUrl.href);
        }

        const token = await saveHandoff(account._id.toString(), uid);
        const scriptNonce = crypto.randomBytes(18).toString("base64url");
        response.set(
            "Content-Security-Policy",
            `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; form-action ${config.issuer}; base-uri 'none'; frame-ancestors 'none'`
        );
        response.set("Referrer-Policy", "no-referrer");
        return response.send(renderHandoffForm({
            issuer: config.issuer,
            uid,
            token,
            scriptNonce
        }));
    });

    router.get("/interaction/:uid", async (request, response) => {
        const details = await provider.interactionDetails(request, response);
        const { prompt, params, uid } = details;

        if (prompt.name === "login") {
            if (params.prompt?.split(" ").includes("none")) {
                return provider.interactionFinished(request, response, {
                    error: "login_required",
                    error_description: "로그인이 필요합니다."
                }, { mergeWithLastSubmission: false });
            }

            const handoffUrl = new URL("/api/oidc/handoff", config.accountOrigin);
            handoffUrl.searchParams.set("uid", uid);
            return response.redirect(303, handoffUrl.href);
        }

        if (prompt.name === "consent") {
            if (params.prompt?.split(" ").includes("none")) {
                return provider.interactionFinished(request, response, {
                    error: "consent_required",
                    error_description: "사용자 동의가 필요합니다."
                }, { mergeWithLastSubmission: false });
            }

            const client = await provider.Client.find(params.client_id);
            const csrfToken = crypto.randomBytes(32).toString("base64url");
            setCsrfCookie(response, uid, csrfToken, config.isProduction);
            const scopes = (prompt.details.missingOIDCScope ?? [])
                .filter((scope) => scope !== "openid");

            return response.send(renderConsent({
                uid,
                client,
                scopes,
                csrfToken
            }));
        }

        return response.status(501).send("지원하지 않는 OIDC interaction입니다.");
    });

    router.post("/interaction/:uid/handoff", parseForm, async (request, response) => {
        const details = await provider.interactionDetails(request, response);
        if (details.prompt.name !== "login" || details.uid !== request.params.uid) {
            return response.status(400).send("로그인 interaction이 아닙니다.");
        }

        const accountId = await consumeHandoff(request.body.token, details.uid);
        const account = await findActiveAccountById(accountId);
        if (!account) {
            return response.status(401).send("로그인 연결이 만료되었습니다. 다시 시도해주세요.");
        }

        return provider.interactionFinished(request, response, {
            login: {
                accountId: account._id.toString(),
                amr: ["pwd"],
                remember: true
            }
        }, { mergeWithLastSubmission: false });
    });

    router.post("/interaction/:uid/consent", parseForm, async (request, response) => {
        const details = await provider.interactionDetails(request, response);
        const { prompt, params, session, grantId, uid } = details;

        if (prompt.name !== "consent" || uid !== request.params.uid) {
            return response.status(400).send("동의 interaction이 아닙니다.");
        }
        if (!validateCsrf(request, uid)) {
            return response.status(403).send("요청 검증에 실패했습니다.");
        }
        clearCsrfCookie(response, uid, config.isProduction);

        if (request.body.decision !== "allow") {
            return provider.interactionFinished(request, response, {
                error: "access_denied",
                error_description: "사용자가 접근을 거부했습니다."
            }, { mergeWithLastSubmission: false });
        }

        let grant;
        if (grantId) {
            grant = await provider.Grant.find(grantId);
        } else {
            grant = new provider.Grant({
                accountId: session.accountId,
                clientId: params.client_id
            });
        }

        if (prompt.details.missingOIDCScope) {
            grant.addOIDCScope(prompt.details.missingOIDCScope.join(" "));
        }
        if (prompt.details.missingOIDCClaims) {
            grant.addOIDCClaims(prompt.details.missingOIDCClaims);
        }
        if (prompt.details.missingResourceScopes) {
            for (const [indicator, scopes] of
                Object.entries(prompt.details.missingResourceScopes)) {
                grant.addResourceScope(indicator, scopes.join(" "));
            }
        }

        return provider.interactionFinished(request, response, {
            consent: { grantId: await grant.save() }
        });
    });

    router.use((error, request, response, next) => {
        console.error("OIDC interaction 실패:", error);
        if (response.headersSent) return next(error);
        return response.status(500).send("OIDC 요청을 처리하지 못했습니다.");
    });

    return router;
}
