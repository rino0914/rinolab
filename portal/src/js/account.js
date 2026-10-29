// 회원정보 페이지: 기존 계정을 조회하고, 서비스 아이디가 없는 계정에 아이디를 등록한다.
// 회원가입 폼의 제출은 portal/src/js/auth.js에서 처리한다.
import { requestAPI } from "./api.js";

const pageStatus = document.querySelector("[data-page-status]");
const panels = document.querySelectorAll("[data-account-panel]");
const usernameForm = document.querySelector("[data-username-form]");
const usernameReadonly = document.querySelector("[data-username-readonly]");
const formStatus = document.querySelector("[data-form-status]");
const driveReturn = document.querySelector("[data-drive-return]");

function showAccount(account) {
    document.querySelector("[data-account-name]").textContent = account.name;
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

async function loadAccount() {
    try {
        const result = await requestAPI("/api/account/me");
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

// '최초 설정' 버튼: 로그인한 계정에 서비스 아이디를 등록한다(PATCH /api/account/me).
usernameForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!usernameForm.reportValidity()) return;

    const submit = usernameForm.querySelector("[type='submit']");
    const username = new FormData(usernameForm).get("username");
    try {
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
