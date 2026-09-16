import assert from "node:assert/strict";
import http from "node:http";
import { Duplex } from "node:stream";
import { describe, it } from "node:test";
import express from "express";
import { ObjectId } from "mongodb";
import { createAccountRouter } from "../src/routes/account.js";
import authRouter from "../src/routes/auth.js";

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

function decodeChunkedBody(body) {
    let decoded = "";
    let offset = 0;
    while (offset < body.length) {
        const lineEnd = body.indexOf("\r\n", offset);
        if (lineEnd === -1) return body;
        const size = Number.parseInt(body.slice(offset, lineEnd), 16);
        if (!Number.isFinite(size)) return body;
        if (size === 0) return decoded;
        offset = lineEnd + 2;
        decoded += body.slice(offset, offset + size);
        offset += size + 2;
    }
    return decoded;
}

async function requestRouter(router, { accountId, method = "GET", path = "/me", body } = {}) {
    const app = express();
    app.use((request, response, next) => {
        request.session = { accountId };
        request.body = body;
        next();
    });
    app.use(router);

    const socket = new MemorySocket();
    const request = new http.IncomingMessage(socket);
    request.method = method;
    request.url = path;
    request.headers = { host: "127.0.0.1" };
    request.push(null);

    const response = new http.ServerResponse(request);
    response.assignSocket(socket);
    await new Promise((resolve, reject) => {
        response.once("finish", resolve);
        response.once("error", reject);
        app(request, response);
    });
    const rawBody = socket.output.split("\r\n\r\n", 2)[1] ?? "";
    const decodedBody = /transfer-encoding: chunked/i.test(socket.output)
        ? decodeChunkedBody(rawBody)
        : rawBody;
    const result = {
        status: response.statusCode,
        body: JSON.parse(decodedBody)
    };
    return result;
}

function existingAccount(overrides = {}) {
    return {
        _id: new ObjectId("64b64cbb2f67d0e8fdd1a001"),
        email: "user@rinolab.org",
        passwordHash: "sensitive-password-hash",
        name: "홍길동",
        role: "USER",
        status: "ACTIVE",
        ...overrides
    };
}

function databaseWith({ duplicate = null, updateResult = { modifiedCount: 1 }, updateError } = {}) {
    return {
        collection() {
            return {
                async findOne() {
                    return duplicate;
                },
                async updateOne(filter, update) {
                    if (updateError) throw updateError;
                    databaseWith.lastUpdate = { filter, update };
                    return updateResult;
                }
            };
        }
    };
}

describe("account profile API", () => {
    it("requires an authenticated active account", async () => {
        const response = await requestRouter(createAccountRouter({
            findAccount: async () => undefined
        }));
        assert.equal(response.status, 401);
    });

    it("returns null for a legacy account without username and excludes secrets", async () => {
        const account = existingAccount();
        const response = await requestRouter(createAccountRouter({
            findAccount: async () => account
        }), { accountId: account._id.toString() });

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, {
            success: true,
            account: {
                username: null,
                name: "홍길동",
                email: "user@rinolab.org"
            }
        });
        assert.equal(JSON.stringify(response.body).includes("passwordHash"), false);
    });

    it("sets username once and normalizes it to lowercase", async () => {
        const account = existingAccount();
        const database = databaseWith();
        const response = await requestRouter(createAccountRouter({
            findAccount: async (accountId) => {
                assert.equal(accountId, account._id.toString());
                return account;
            },
            getDatabase: () => database
        }), {
            accountId: account._id.toString(),
            method: "PATCH",
            body: { username: "  User-01  " }
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.account.username, "user-01");
        assert.equal(databaseWith.lastUpdate.filter._id, account._id);
        assert.equal(databaseWith.lastUpdate.update.$set.username, "user-01");
    });

    it("rejects invalid usernames", async () => {
        for (const username of ["ab", "-user", "user@example.com", "홍길동"]) {
            const response = await requestRouter(createAccountRouter({
                findAccount: async () => existingAccount()
            }), {
                accountId: "64b64cbb2f67d0e8fdd1a001",
                method: "PATCH",
                body: { username }
            });
            assert.equal(response.status, 400, username);
        }
    });

    it("rejects a duplicate username", async () => {
        const account = existingAccount();
        const response = await requestRouter(createAccountRouter({
            findAccount: async () => account,
            getDatabase: () => databaseWith({ duplicate: existingAccount({ username: "taken" }) })
        }), {
            accountId: account._id.toString(),
            method: "PATCH",
            body: { username: "taken" }
        });
        assert.equal(response.status, 409);
    });

    it("rejects changes after username is set", async () => {
        const account = existingAccount({ username: "original" });
        const response = await requestRouter(createAccountRouter({
            findAccount: async () => account
        }), {
            accountId: account._id.toString(),
            method: "PATCH",
            body: { username: "changed" }
        });
        assert.equal(response.status, 409);
    });

    it("always updates the session account and ignores another account id", async () => {
        const account = existingAccount();
        const otherId = "64b64cbb2f67d0e8fdd1a002";
        const response = await requestRouter(createAccountRouter({
            findAccount: async (accountId) => {
                assert.equal(accountId, account._id.toString());
                return account;
            },
            getDatabase: () => databaseWith()
        }), {
            accountId: account._id.toString(),
            method: "PATCH",
            body: { username: "my-user", accountId: otherId }
        });
        assert.equal(response.status, 200);
        assert.equal(databaseWith.lastUpdate.filter._id.toString(), account._id.toString());
    });

    it("maps a MongoDB unique-index race to conflict", async () => {
        const error = Object.assign(new Error("duplicate key"), { code: 11000 });
        const account = existingAccount();
        const response = await requestRouter(createAccountRouter({
            findAccount: async () => account,
            getDatabase: () => databaseWith({ updateError: error })
        }), {
            accountId: account._id.toString(),
            method: "PATCH",
            body: { username: "race-user" }
        });
        assert.equal(response.status, 409);
    });
});

describe("signup compatibility", () => {
    it("requires username for new signups", async () => {
        const response = await requestRouter(authRouter, {
            method: "POST",
            path: "/signup",
            body: {
                name: "신규 사용자",
                email: "new@rinolab.org",
                password: "password123"
            }
        });
        assert.equal(response.status, 400);
        assert.match(response.body.message, /사용자 이름/);
    });
});
