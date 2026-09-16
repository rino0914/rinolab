import express from "express";
import { findActiveAccountById } from "../auth/accounts.js";
import { isValidUsername, normalizeUsername } from "../auth/username.js";
import { getDB } from "../db.js";

function publicAccount(account) {
    return {
        username: typeof account.username === "string" ? account.username : null,
        name: account.name,
        email: account.email
    };
}

export function createAccountRouter(options = {}) {
    const findAccount = options.findAccount ?? findActiveAccountById;
    const getDatabase = options.getDatabase ?? getDB;
    const router = express.Router();

    router.use((request, response, next) => {
        response.set("Cache-Control", "no-store");
        next();
    });

    router.get("/me", async (request, response) => {
        try {
            const account = await findAccount(request.session.accountId);
            if (!account) {
                return response.status(401).json({ message: "로그인이 필요합니다." });
            }

            return response.json({
                success: true,
                account: publicAccount(account)
            });
        } catch (error) {
            console.error("회원정보 조회 실패:", error);
            return response.status(500).json({ message: "서버 오류가 발생했습니다." });
        }
    });

    router.patch("/me", async (request, response) => {
        try {
            const username = normalizeUsername(request.body?.username);
            if (!isValidUsername(username)) {
                return response.status(400).json({
                    message: "서비스 아이디는 영문 소문자로 시작하고 영문 소문자, 숫자, _, -만 사용해 3~32자로 입력해주세요."
                });
            }

            const account = await findAccount(request.session.accountId);
            if (!account) {
                return response.status(401).json({ message: "로그인이 필요합니다." });
            }
            if (typeof account.username === "string") {
                return response.status(409).json({
                    message: "서비스 아이디는 이미 설정되어 변경할 수 없습니다."
                });
            }

            const accounts = getDatabase().collection("accounts");
            const duplicate = await accounts.findOne({ username });
            if (duplicate) {
                return response.status(409).json({
                    message: "이미 사용 중인 서비스 아이디입니다."
                });
            }

            const result = await accounts.updateOne({
                _id: account._id,
                status: "ACTIVE",
                $or: [
                    { username: { $exists: false } },
                    { username: null }
                ]
            }, {
                $set: { username, updatedAt: new Date() }
            });

            if (result.modifiedCount !== 1) {
                return response.status(409).json({
                    message: "서비스 아이디는 이미 설정되어 변경할 수 없습니다."
                });
            }

            return response.json({
                success: true,
                account: publicAccount({ ...account, username })
            });
        } catch (error) {
            if (error?.code === 11000) {
                return response.status(409).json({
                    message: "이미 사용 중인 서비스 아이디입니다."
                });
            }
            console.error("서비스 아이디 설정 실패:", error);
            return response.status(500).json({ message: "서버 오류가 발생했습니다." });
        }
    });

    return router;
}

export default createAccountRouter();
