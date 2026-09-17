import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import { ObjectId } from "mongodb";
import { authenticateAccount, findActiveAccountById } from "../src/auth/accounts.js";
import { createAuthRouter } from "../src/routes/auth.js";
import { createOidcProvider } from "../src/oidc/provider.js";
import { createOidcAccountFinder } from "../src/oidc/account.js";
import { createOidcInteractionRouter } from "../src/oidc/interactions.js";
import { createPortalSessionBridge } from "../src/oidc/portal-session.js";

const password = "test-password-123";
const passwordHash = bcrypt.hashSync(password, 4);
const accounts = ["gwnam", "tester09", "legacy"].map((username, index) => ({
    _id: new ObjectId(`64b64cbb2f67d0e8fdd1a00${index + 1}`),
    ...(username === "legacy" ? {} : { username }),
    email: `${username}@rinolab.org`, name: username,
    status: "ACTIVE", role: "USER", passwordHash
}));
const jwks = { keys: [{
    ...crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }),
    kid: "session-tests", alg: "RS256", use: "sig"
}] };

function testDatabase() {
    const handoffs = new Map();
    const bindings = new Map();
    return {
        bindings,
        collection(name) {
            if (name === "accounts") return {
                async findOne(query) {
                    return accounts.find((account) => Object.entries(query).every(
                        ([key, value]) => String(account[key]) === String(value)
                    ));
                }
            };
            if (name === "oidc_handoffs") return {
                async insertOne(document) { handoffs.set(document._id, document); },
                async findOneAndDelete(query) {
                    const doc = handoffs.get(query._id);
                    if (!doc || doc.uid !== query.uid || doc.expiresAt <= query.expiresAt.$gt) return null;
                    handoffs.delete(query._id);
                    return doc;
                }
            };
            assert.equal(name, "oidc_session_bindings");
            return {
                async updateOne(query, update) {
                    bindings.set(query._id, { _id: query._id, ...update.$set });
                },
                find(query) {
                    return { async toArray() {
                        return [...bindings.values()].filter((doc) => doc.portalSessionId === query.portalSessionId);
                    } };
                },
                async deleteMany(query) {
                    for (const [id, doc] of bindings) {
                        if (doc.portalSessionId === query.portalSessionId) bindings.delete(id);
                    }
                }
            };
        }
    };
}

// A browser-like cookie jar: cookies are isolated by host and path, including signatures.
class Browser {
    cookies = new Map();
    history = [];
    constructor(fixture) { this.fixture = fixture; }
    async request(url, { method = "GET", json, form, headers = {} } = {}) {
        url = new URL(url, this.fixture.issuer);
        this.history.push(`${method} ${url.href}`);
        const cookie = [...this.cookies.values()].filter((item) =>
            item.host === url.host && (url.pathname === item.path ||
                url.pathname.startsWith(item.path.endsWith("/") ? item.path : `${item.path}/`))
        ).map((item) => `${item.name}=${item.value}`).join("; ");
        const body = json ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined;
        const result = await fetch(url.href, {
            method, redirect: "manual", body,
            headers: {
                host: url.host, ...(cookie ? { cookie } : {}),
                ...(json ? { "content-type": "application/json" } : {}),
                ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
                ...headers
            }
        });
        for (const value of result.headers.getSetCookie()) {
            const [pair, ...attributes] = value.split(";").map((part) => part.trim());
            const split = pair.indexOf("=");
            const name = pair.slice(0, split);
            const path = attributes.find((attr) => /^path=/i.test(attr))?.slice(5) ?? "/";
            const key = `${url.host}|${path}|${name}`;
            if (/expires=Thu, 01 Jan 1970|Max-Age=0/i.test(value)) this.cookies.delete(key);
            else this.cookies.set(key, { host: url.host, path, name, value: pair.slice(split + 1) });
        }
        return {
            status: result.status, body: await result.text(), url: url.href,
            location: result.headers.get("location"), headers: result.headers
        };
    }
    async login(username) {
        const response = await this.request(`${this.fixture.portal}/api/auth/login`, {
            method: "POST", json: { email: `${username}@rinolab.org`, password }
        });
        assert.equal(response.status, 200, response.body);
    }
    async logout() {
        const response = await this.request(`${this.fixture.portal}/api/auth/logout`, { method: "POST" });
        assert.equal(response.status, 204, response.body);
    }
}

async function fixture(t) {
    const database = testDatabase();
    const store = new session.MemoryStore();
    const app = express();
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    const port = server.address().port;
    const issuer = `http://localhost:${port}`;
    const portal = `http://127.0.0.1:${port}`;
    const clients = ["immich", "rinolab-drive"].map((id) => ({
        client_id: id, client_secret: `test-${id}-secret`,
        redirect_uris: [`https://${id}.example/callback`],
        post_logout_redirect_uris: [`https://${id}.example/`],
        grant_types: ["authorization_code"], response_types: ["code"],
        token_endpoint_auth_method: id === "immich" ? "client_secret_post" : "client_secret_basic"
    }));
    const config = {
        issuer, accountOrigin: portal, isProduction: false, jwks,
        cookieKeys: ["a".repeat(32), "b".repeat(32)], clients,
        pkceRequiredByClient: { immich: true, "rinolab-drive": false }
    };
    const portalSessions = createPortalSessionBridge(store, () => database);
    const provider = createOidcProvider(config, {
        adapter: null, portalSessions, findAccount: createOidcAccountFinder(() => database)
    });
    app.locals.revokeOidcSessions = (id) => portalSessions.revoke(provider, id);
    app.use(express.json());
    app.use(session({
        name: "rinus.sid", secret: "portal-session-test-secret", store,
        resave: false, saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: "lax", path: "/" }
    }));
    app.use("/api/auth", createAuthRouter({
        authenticate: (email, secret) => authenticateAccount(email, secret, database),
        findAccount: (id) => findActiveAccountById(id, database)
    }));
    app.use(createOidcInteractionRouter(provider, config, {
        portalSessions, getDatabase: () => database,
        findAccount: (id) => findActiveAccountById(id, database)
    }));
    app.use(provider.callback());
    return { issuer, portal, port, provider, database, store, portalSessions, clients };
}

function authorization(f, clientId, extra = {}) {
    const verifier = "test-verifier-at-least-forty-three-characters-long";
    const query = new URLSearchParams({
        client_id: clientId, redirect_uri: `https://${clientId}.example/callback`,
        response_type: "code", scope: "openid email profile", state: crypto.randomUUID(),
        ...(clientId === "immich" ? {
            code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256"
        } : {}), ...extra
    });
    return `${f.issuer}/auth?${query}`;
}

function hidden(body, name) {
    const value = body.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`))?.[1];
    assert.ok(value, `Missing ${name}: ${body}`);
    return value;
}

async function handoff(browser, clientId = "rinolab-drive") {
    const started = await browser.request(authorization(browser.fixture, clientId));
    const interaction = await browser.request(started.location);
    const page = await browser.request(interaction.location);
    const uid = new URL(interaction.location).searchParams.get("uid");
    assert.equal(page.status, 200, page.body);
    return { uid, token: hidden(page.body, "token") };
}

async function complete(browser, initial) {
    let response = typeof initial === "string" ? await browser.request(initial) : initial;
    for (let step = 0; step < 20; step++) {
        if (response.location?.startsWith("https://")) return response;
        if (response.location) {
            response = await browser.request(new URL(response.location, response.url));
            continue;
        }
        assert.equal(response.status, 200, `${response.body}\n${browser.history.join("\n")}`);
        const action = response.body.match(/<form[^>]*action="([^"]+)"/)?.[1];
        assert.ok(action, response.body);
        let form;
        if (response.body.includes('name="token"')) form = { token: hidden(response.body, "token") };
        else if (response.body.includes('name="csrfToken"')) form = {
            csrfToken: hidden(response.body, "csrfToken"), decision: "allow"
        };
        else form = { xsrf: hidden(response.body, "xsrf"), logout: "yes" };
        response = await browser.request(new URL(action, response.url), { method: "POST", form });
    }
    assert.fail("Authorization did not terminate");
}

async function signIn(browser, clientId) {
    const f = browser.fixture;
    const response = await complete(browser, authorization(f, clientId));
    const redirect = new URL(response.location);
    assert.equal(redirect.searchParams.get("error"), null, response.location);
    const code = redirect.searchParams.get("code");
    assert.ok(code, response.location);
    const form = {
        grant_type: "authorization_code", code,
        redirect_uri: `https://${clientId}.example/callback`,
        ...(clientId === "immich" ? {
            client_id: clientId, client_secret: `test-${clientId}-secret`,
            code_verifier: "test-verifier-at-least-forty-three-characters-long"
        } : {})
    };
    const tokenResponse = await browser.request("/token", {
        method: "POST", form, headers: clientId === "immich" ? {} : {
            authorization: `Basic ${Buffer.from(`${clientId}:test-${clientId}-secret`).toString("base64")}`
        }
    });
    assert.equal(tokenResponse.status, 200, tokenResponse.body);
    const tokens = JSON.parse(tokenResponse.body);
    const userinfo = await browser.request("/me", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(userinfo.status, 200, userinfo.body);
    const claims = JSON.parse(userinfo.body);
    const [header, payload, signature] = tokens.id_token.split(".");
    const idToken = JSON.parse(Buffer.from(payload, "base64url"));
    assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${header}.${payload}`),
        crypto.createPublicKey({ key: jwks.keys[0], format: "jwk" }),
        Buffer.from(signature, "base64url")));
    assert.equal(idToken.iss, f.issuer);
    assert.equal(idToken.aud, clientId);
    assert.equal(idToken.sub, claims.sub);
    return { tokens, claims };
}

function assertAccount(claims, username) {
    const account = accounts.find((item) => item.name === username);
    assert.equal(claims.sub, account._id.toString());
    assert.equal(claims.username, account.username);
    assert.equal(claims.preferred_username, account.email);
}

describe("portal and OIDC session lifecycle", () => {
    for (const [first, second] of [["gwnam", "tester09"], ["tester09", "gwnam"]]) {
        it(`${first} → portal logout → ${second}: Drive and Immich use the new account`, async (t) => {
            const f = await fixture(t);
            const browser = new Browser(f);
            await browser.login(first);
            assertAccount((await signIn(browser, "immich")).claims, first);
            assertAccount((await signIn(browser, "rinolab-drive")).claims, first);
            const binding = [...f.database.bindings.values()][0];
            assert.ok(await f.provider.Session.findByUid(binding._id));
            await browser.logout();
            assert.equal(await f.provider.Session.findByUid(binding._id), undefined);
            await browser.login(second);
            assertAccount((await signIn(browser, "rinolab-drive")).claims, second);
            assertAccount((await signIn(browser, "immich")).claims, second);
        });
    }

    it("preserves SSO and consent for an unchanged portal account", async (t) => {
        const browser = new Browser(await fixture(t));
        await browser.login("gwnam");
        await signIn(browser, "immich");
        browser.history = [];
        assertAccount((await signIn(browser, "immich")).claims, "gwnam");
        assert.ok(browser.history.some((url) => url.includes("/api/oidc/handoff")));
        assert.ok(!browser.history.some((url) => /\/consent|\/pages\/login|\/api\/auth\/login/.test(url)));
    });

    it("invalidates the previous provider session on direct portal account switching", async (t) => {
        const f = await fixture(t);
        const browser = new Browser(f);
        await browser.login("gwnam");
        await signIn(browser, "rinolab-drive");
        const binding = [...f.database.bindings.values()][0];
        await browser.login("tester09");
        assert.equal(await f.provider.Session.findByUid(binding._id), undefined);
        assertAccount((await signIn(browser, "rinolab-drive")).claims, "tester09");
    });

    it("synchronizes even if only the portal cookie was deleted, using provider logout on account change", async (t) => {
        const f = await fixture(t);
        const browser = new Browser(f);
        await browser.login("gwnam");
        await signIn(browser, "rinolab-drive");
        const binding = [...f.database.bindings.values()][0];
        for (const [key, value] of browser.cookies) {
            if (value.name === "rinus.sid") browser.cookies.delete(key);
        }
        await browser.login("tester09");
        assert.ok(await f.provider.Session.findByUid(binding._id));
        browser.history = [];
        assertAccount((await signIn(browser, "rinolab-drive")).claims, "tester09");
        assert.ok(browser.history.some((url) => url.includes("/session/end/confirm")));
        assert.equal(await f.provider.Session.findByUid(binding._id), undefined);
    });

    it("rejects silent authorization with a stale cookie and no fresh portal verification", async (t) => {
        const f = await fixture(t);
        const browser = new Browser(f);
        await browser.login("gwnam");
        await signIn(browser, "rinolab-drive");
        await browser.logout();
        const response = await browser.request(authorization(f, "rinolab-drive", { prompt: "none" }));
        assert.equal(new URL(response.location).searchParams.get("error"), "login_required");
        assert.equal(new URL(response.location).searchParams.get("code"), null);
    });

    it("rejects a handoff issued before logout and account switching", async (t) => {
        const f = await fixture(t);
        const browser = new Browser(f);
        await browser.login("gwnam");
        const pending = await handoff(browser);
        await browser.logout();
        await browser.login("tester09");
        const response = await browser.request(`/interaction/${pending.uid}/handoff`, {
            method: "POST", form: { token: pending.token }
        });
        assert.equal(response.status, 401);
        assert.equal(response.location, null);
        assertAccount((await signIn(browser, "rinolab-drive")).claims, "tester09");
    });

    it("rejects replayed handoffs and tokens for another browser's interaction", async (t) => {
        const f = await fixture(t);
        const alice = new Browser(f);
        const bob = new Browser(f);
        await alice.login("gwnam");
        await bob.login("tester09");
        const first = await handoff(alice);
        const second = await handoff(bob);
        const foreign = await bob.request(`/interaction/${second.uid}/handoff`, {
            method: "POST", form: { token: first.token }
        });
        assert.equal(foreign.status, 401);
        const valid = await alice.request(`/interaction/${first.uid}/handoff`, {
            method: "POST", form: { token: first.token }
        });
        assert.equal(valid.status, 303);
        const replay = await alice.request(`/interaction/${first.uid}/handoff`, {
            method: "POST", form: { token: first.token }
        });
        assert.equal(replay.status, 401);
        assertAccount((await signIn(bob, "rinolab-drive")).claims, "tester09");
    });

    it("revalidates portal login after handoff completion but before authorization resume", async (t) => {
        const f = await fixture(t);
        const browser = new Browser(f);
        await browser.login("gwnam");
        const pending = await handoff(browser);
        const finished = await browser.request(`/interaction/${pending.uid}/handoff`, {
            method: "POST", form: { token: pending.token }
        });
        await browser.logout();
        await browser.login("tester09");
        const resumed = await browser.request(finished.location);
        assert.ok(!resumed.location?.startsWith("https://rinolab-drive.example"));
        assert.equal((await complete(browser, resumed)).status, 303);
        assertAccount((await signIn(browser, "rinolab-drive")).claims, "tester09");
    });

    it("an expired portal session cannot authorize from a still-valid OP cookie", async (t) => {
        const f = await fixture(t);
        const browser = new Browser(f);
        await browser.login("gwnam");
        await signIn(browser, "rinolab-drive");
        const binding = [...f.database.bindings.values()][0];
        await new Promise((resolve, reject) => f.store.destroy(binding.portalSessionId,
            (error) => error ? reject(error) : resolve()));
        assert.ok(await f.provider.Session.findByUid(binding._id));
        const start = await browser.request(authorization(f, "rinolab-drive"));
        const interaction = await browser.request(start.location);
        const portal = await browser.request(interaction.location);
        assert.equal(new URL(portal.location).pathname, "/pages/login.html");
        assert.equal(new URL(portal.location).origin, f.portal);
    });

    it("does not accept the previous account's pending consent after switching accounts", async (t) => {
        const f = await fixture(t);
        const browser = new Browser(f);
        await browser.login("gwnam");
        const pending = await handoff(browser);
        const finished = await browser.request(`/interaction/${pending.uid}/handoff`, {
            method: "POST", form: { token: pending.token }
        });
        const resumed = await browser.request(finished.location);
        const consent = await browser.request(resumed.location);
        assert.equal(consent.status, 200);
        const csrfToken = hidden(consent.body, "csrfToken");
        await browser.logout();
        await browser.login("tester09");
        const stale = await browser.request(`${resumed.location}/consent`, {
            method: "POST", form: { csrfToken, decision: "allow" }
        });
        assert.equal(stale.status, 400);
        assert.equal(stale.location, null);
        assertAccount((await signIn(browser, "rinolab-drive")).claims, "tester09");
    });

    it("logs out only the linked portal session, leaving another browser's SSO intact", async (t) => {
        const f = await fixture(t);
        const first = new Browser(f);
        const second = new Browser(f);
        await first.login("gwnam");
        await second.login("gwnam");
        await signIn(first, "immich");
        await signIn(second, "immich");
        const linked = [...f.database.bindings.values()];
        await first.logout();
        assert.equal(await f.provider.Session.findByUid(linked[0]._id), undefined);
        assert.ok(await f.provider.Session.findByUid(linked[1]._id));
        assertAccount((await signIn(second, "immich")).claims, "gwnam");
    });

    it("preserves legacy Immich login and requires username for Drive", async (t) => {
        const f = await fixture(t);
        const browser = new Browser(f);
        await browser.login("legacy");
        assertAccount((await signIn(browser, "immich")).claims, "legacy");
        const pending = await handoff(browser);
        const response = await browser.request(`/interaction/${pending.uid}/handoff`, {
            method: "POST", form: { token: pending.token }
        });
        assert.equal(response.status, 403);
        assert.ok(response.body.includes("/pages/account.html"));
        assert.equal(response.location, null);
    });

    it("keeps RP-Initiated Logout with CSRF checks and registered redirect validation", async (t) => {
        const f = await fixture(t);
        const browser = new Browser(f);
        await browser.login("gwnam");
        const { tokens } = await signIn(browser, "immich");
        const invalid = await browser.request(`/session/end?${new URLSearchParams({
            id_token_hint: tokens.id_token, post_logout_redirect_uri: "https://unregistered.example/"
        })}`);
        assert.equal(invalid.status, 400);
        const page = await browser.request(`/session/end?${new URLSearchParams({
            id_token_hint: tokens.id_token, post_logout_redirect_uri: "https://immich.example/", state: "logout-state"
        })}`);
        const failed = await browser.request("/session/end/confirm", {
            method: "POST", form: { xsrf: "wrong-xsrf", logout: "yes" }
        });
        assert.equal(failed.status, 400);
        const binding = [...f.database.bindings.values()][0];
        const result = await complete(browser, page);
        assert.equal(result.location, "https://immich.example/?state=logout-state");
        assert.equal(await f.provider.Session.findByUid(binding._id), undefined);
        assertAccount((await signIn(browser, "immich")).claims, "gwnam");
    });
});
