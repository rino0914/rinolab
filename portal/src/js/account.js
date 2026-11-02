/**
 * @file account.js
 * @description 회원정보 페이지 : 기존 게정을 조회 및 등록. 폼 재출은  portal/src/js/auth.js에서 처리
 */

import { requestAPI } from "./api.js";

const pageStatus = document.querySelector("[data-page-status]");
const panels = document.querySelectorAll("[data-account-panel]");
const usernameForm = document.querySelector("[data-username-form]");
const usernameReadonly = document.querySelector("[data-username-readonly]");
const formStatus = document.querySelector("[data-form-status]");
const driveReturn = document.querySelector("[data-drive-return]");

/**
 * Account 화면 표시 및 상태 갱신
 * @param {Object} account - 회원정보
 */
function showAccount(account) {
    document.querySelector("[data-account-email]").textContent = account.email;
    panels.forEach((panel) => { panel.hidden = false; });
    pageStatus.hidden = true;

    if (account.username) {
        document.querySelector("[data-account-username]").textContent = account.username;
        usernameReadonly.hidden = false;
        usernameForm.hidden = true;
    } else {
        usernameReadonly.hidden = true;
        usernameForm.hidden = false;
    }
}

function hasDriveReturn() {
    const value = new URLSearchParams(window.location.search).get("returnTo");
    if (!value) return false;
    try {
        return new URL(value).origin === "https://drive.rinolab.org";
    } catch {
        return false;
    }
}

/**
 * Account 로드
 */
async function loadAccount() {
    try {
        // RestAPI 호출
        const result = await requestAPI("/api/account/me");
        // Account 표출 및 갱신
        showAccount(result.account);
        if (result.account.username && hasDriveReturn()) driveReturn.hidden = false;
    } catch (error) {
        if (error instanceof Error && error.status === 401) {
            const returnTo = `${window.location.pathname}${window.location.search}`;
            window.location.replace(`./login.html?returnTo=${encodeURIComponent(returnTo)}`);
            return;
        }
        pageStatus.textContent = error instanceof Error
            ? error.message
            : "회원정보를 불러오지 못했습니다.";
    }
}

/** 서비스 아이디 설정 폼을 제출하면, 입력한 아이디를 서버에 저장하고 화면을 갱신하는 이벤트 처리 코드
 * usernameForm이 존재하면 제출 이벤트를 연결
 */
usernameForm?.addEventListener("submit", async (event) => {
    // 기본 제출 막기
    event.preventDefault();
    // 입력값 유효성 체크
    if (!usernameForm.reportValidity()) return;

    const submit = usernameForm.querySelector("[type='submit']");
    // 서비스 아이드 추출
    const username = new FormData(usernameForm).get("username");
    try {
        // 서버 저장 요청
        submit.disabled = true;
        formStatus.hidden = true;
        const result = await requestAPI("/api/account/me", {
            method: "PATCH",
            body: JSON.stringify({ username })
        });
        showAccount(result.account);
        if (hasDriveReturn()) driveReturn.hidden = false;
    } catch (error) {
        formStatus.textContent = error instanceof Error
            ? error.message
            : "서비스 아이디를 설정하지 못했습니다.";
        formStatus.hidden = false;
    } finally {
        submit.disabled = false;
    }
});

document.querySelector("[data-password-entry]")?.addEventListener("click", () => {
    document.querySelector("[data-password-status]").hidden = false;
});

document.querySelector("[data-logout]")?.addEventListener("click", async () => {
    await requestAPI("/api/auth/logout", { method: "POST" });
    window.location.replace("./login.html");
});

loadAccount();
