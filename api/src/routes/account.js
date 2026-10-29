/**
 * @file account.js
 * @description 회원정보 페이지에서 사용하는 계정 조회 및 서비스 아이디 등록 API
 * 신규 회원가입은 auth.js의 POST /api/auth/signup에서 계정과 서비스 아이디를 함께 생성한다.
 * 이 파일은 로그인한 회원의 정보를 조회하고, 서비스 아이디가 없는 기존 계정에 아이디를 등록한다.
 */

import express from "express";
import { findActiveAccountById } from "../auth/accounts.js";
import { isValidUsername, normalizeUsername } from "../auth/username.js";
import { getDB } from "../db.js";

/**
 * @description 응답에 필요한 회원정보만 반환하며, 미설정 서비스 아이디는 null로 통일
 */
function publicAccount(account) {
    return {
        username: typeof account.username === "string" ? account.username : null,
        name: account.name,
        email: account.email
    };
}

/**
 * @description 회원정보 조회 및 서비스 아이디 설정 라우터 생성
 * @param {Object} [options={}] 회원 조회 및 DB 접근 함수를 대체할 수 있는 옵션
 * @returns {express.Router} 회원정보 라우터
 */
export function createAccountRouter(options = {}) {
    const findAccount = options.findAccount ?? findActiveAccountById;
    const getDatabase = options.getDatabase ?? getDB;
    const router = express.Router();

    /**
     * 공통 미들웨어: 이 라우터의 모든 응답에 Cache-Control: no-store를 설정한다.
     * 회원 개인정보가 브라우저나 중간 캐시에 저장되지 않도록 한다.
     */
    router.use((request, response, next) => {
        response.set("Cache-Control", "no-store");
        next();
    });

    /**
     * GET /api/account/me — 회원정보 페이지에 표시할 로그인 회원의 정보 조회
     * 세션의 accountId로 활성 계정을 조회하고 서비스 아이디, 이름, 이메일을 반환한다.
     * 응답: 200 조회 성공, 401 활성 계정 없음, 500 서버 오류.
     */
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

    /**
     * PATCH /api/account/me — 서비스 아이디가 없는 기존 계정에 아이디 등록
     * 회원정보 페이지의 '최초 설정' 버튼에서 호출하며, 로그인한 계정의 username만 갱신한다.
     * 이미 설정된 아이디의 변경과 다른 계정에서 사용 중인 아이디의 등록은 허용하지 않는다.
     * 응답: 200 설정 후 회원정보 반환, 400 형식 오류, 401 활성 계정 없음,
     *       409 이미 설정되었거나 중복된 아이디 또는 갱신 조건 불충족, 500 서버 오류.
     */
    router.patch("/me", async (request, response) => {
        try {
            // 입력한 서비스 아이디의 형식을 검사한다.
            const requestedUsername = normalizeUsername(request.body?.username);
            if (!isValidUsername(requestedUsername)) {
                return response.status(400).json({
                    message: "서비스 아이디는 영문 소문자로 시작하고 영문 소문자, 숫자, _, -만 사용해 3~32자로 입력해주세요."
                });
            }
            // 세션으로 로그인한 활성 계정을 조회한다.
            const account = await findAccount(request.session.accountId);
            if (!account) {
                return response.status(401).json({ message: "로그인이 필요합니다." });
            }
            // 내 계정에 기존 아이디가 있으면 재등록을 막는다.
            if (typeof account.username === "string") {
                return response.status(409).json({
                    message: "이 계정에는 서비스 아이디가 이미 등록되어 있습니다. 등록한 아이디는 변경할 수 없습니다."
                });
            }

            // 입력한 아이디를 다른 계정에서 사용 중인지 확인한다.
            const accounts = getDatabase().collection("accounts");
            const usernameOwner = await accounts.findOne({ username: requestedUsername });
            if (usernameOwner) {
                return response.status(409).json({
                    message: "이미 사용 중인 서비스 아이디입니다."
                });
            }

            // 동시에 설정 요청이 들어와도 덮어쓰지 않도록 미설정 여부를 갱신 조건에 포함한다.
            const result = await accounts.updateOne({
                _id: account._id,
                status: "ACTIVE",
                $or: [
                    { username: { $exists: false } },
                    { username: null }
                ]
            }, {
                $set: { username: requestedUsername, updatedAt: new Date() }
            });

            if (result.modifiedCount !== 1) {
                return response.status(409).json({
                    message: "계정 상태가 변경되어 서비스 아이디를 등록하지 못했습니다. 회원정보를 새로고침해주세요."
                });
            }

            return response.json({
                success: true,
                account: publicAccount({ ...account, username: requestedUsername })
            });
        } catch (error) {
            // 사전 중복 조회 이후 발생한 동시 등록 충돌도 MongoDB 중복 키 오류로 처리한다.
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
