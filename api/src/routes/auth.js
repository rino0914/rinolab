import express from "express";
import bcrypt from "bcrypt";
import { rateLimit } from "express-rate-limit";
import { ObjectId } from "mongodb";
import { getDB } from "../db.js";

const router = express.Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const persistentSessionAge = 30 * 24 * 60 * 60 * 1000;
const dummyPasswordHash = "$2b$12$r1mcHe0tgqmwGwFBlSvI5OGrGWqngacnLCVfjjKJEsdfTqNySPhEW";
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요." }
});

router.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
});

function regenerateSession(request) {
    return new Promise((resolve, reject) => {
        request.session.regenerate((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function saveSession(request) {
    return new Promise((resolve, reject) => {
        request.session.save((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function destroySession(request) {
    return new Promise((resolve, reject) => {
        request.session.destroy((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

router.post("/signup", async (request, response) => {
    try {
        const { name, email, password } = request.body ?? {};

        if (
            typeof name !== "string" ||
            typeof email !== "string" ||
            typeof password !== "string"
        ) {
            return response.status(400).json({
                message: "이름, 이메일, 비밀번호를 모두 입력해주세요."
            });
        }

        const normalizedName = name.trim();
        const normalizedEmail = email.trim().toLowerCase();

        if (normalizedName.length < 1 || normalizedName.length > 50) {
            return response.status(400).json({
                message: "이름은 1자 이상 50자 이하로 입력해주세요."
            });
        }

        if (normalizedEmail.length > 254 || !emailPattern.test(normalizedEmail)) {
            return response.status(400).json({
                message: "올바른 이메일 주소를 입력해주세요."
            });
        }

        const passwordByteLength = Buffer.byteLength(password, "utf8");
        if (password.length < 8 || passwordByteLength > 72) {
            return response.status(400).json({
                message: "비밀번호는 8자 이상, UTF-8 기준 72바이트 이하로 입력해주세요."
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const now = new Date();
        const account = {
            email: normalizedEmail,
            passwordHash,
            name: normalizedName,
            role: "USER",
            status: "ACTIVE",
            createdAt: now,
            updatedAt: now
        };

        const database = getDB();
        const result = await database.collection("accounts").insertOne(account);

        return response.status(201).json({
            account: {
                id: result.insertedId,
                email: account.email,
                name: account.name,
                role: account.role,
                status: account.status
            }
        });
    } catch (error) {
        if (error?.code === 11000) {
            return response.status(409).json({
                message: "이미 사용 중인 이메일입니다."
            });
        }

        console.error("회원가입 실패:", error);
        return response.status(500).json({
            message: "서버 오류가 발생했습니다."
        });
    }
});

router.post("/login", loginLimiter, async (request, response) => {
    try {
        const { email, password, remember = false } = request.body ?? {};

        if (
            typeof email !== "string" ||
            typeof password !== "string" ||
            typeof remember !== "boolean"
        ) {
            return response.status(400).json({
                message: "이메일과 비밀번호를 확인해주세요."
            });
        }

        const normalizedEmail = email.trim().toLowerCase();
        if (!normalizedEmail || !password) {
            return response.status(400).json({
                message: "이메일과 비밀번호를 확인해주세요."
            });
        }

        const database = getDB();
        const account = await database.collection("accounts").findOne({
            email: normalizedEmail
        });
        const passwordMatches = await bcrypt.compare(
            password,
            account?.passwordHash ?? dummyPasswordHash
        );

        if (!account || !passwordMatches) {
            return response.status(401).json({
                message: "이메일 또는 비밀번호가 올바르지 않습니다."
            });
        }

        if (account.status !== "ACTIVE") {
            return response.status(403).json({
                message: "현재 사용할 수 없는 계정입니다."
            });
        }

        await regenerateSession(request);
        request.session.accountId = account._id.toString();
        request.session.cookie.maxAge = remember ? persistentSessionAge : null;
        await saveSession(request);

        return response.json({
            account: {
                id: account._id,
                email: account.email,
                name: account.name,
                role: account.role,
                status: account.status
            }
        });
    } catch (error) {
        console.error("로그인 실패:", error);
        return response.status(500).json({
            message: "서버 오류가 발생했습니다."
        });
    }
});

router.get("/me", async (request, response) => {
    try {
        const { accountId } = request.session;
        if (!accountId || !ObjectId.isValid(accountId)) {
            return response.status(401).json({
                message: "로그인이 필요합니다."
            });
        }

        const database = getDB();
        const account = await database.collection("accounts").findOne(
            { _id: new ObjectId(accountId), status: "ACTIVE" },
            { projection: { passwordHash: 0 } }
        );

        if (!account) {
            await destroySession(request);
            response.clearCookie("rinus.sid", { path: "/" });
            return response.status(401).json({
                message: "로그인이 필요합니다."
            });
        }

        return response.json({
            account: {
                id: account._id,
                email: account.email,
                name: account.name,
                role: account.role,
                status: account.status
            }
        });
    } catch (error) {
        console.error("사용자 조회 실패:", error);
        return response.status(500).json({
            message: "서버 오류가 발생했습니다."
        });
    }
});

router.post("/logout", async (request, response) => {
    try {
        await destroySession(request);
        response.clearCookie("rinus.sid", { path: "/" });
        return response.status(204).end();
    } catch (error) {
        console.error("로그아웃 실패:", error);
        return response.status(500).json({
            message: "서버 오류가 발생했습니다."
        });
    }
});

export default router;
