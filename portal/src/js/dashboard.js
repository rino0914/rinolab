import { requestAPI } from "./api.js";

const accountName = document.querySelector("[data-account-name]");
const logoutButton = document.querySelector("[data-logout]");

/**
 * @description 현재 Account 정보 로드하고 없으면 로그인 페이지로 이동
 */
async function loadCurrentAccount() {
    console.debug("[ACCOUNT] Loading current account");

    try {
        // 횐재 계정 정보 입수
        const result = await requestAPI("/api/auth/me");

        if (accountName instanceof HTMLElement) {
            accountName.textContent = `${result.account.name} (${result.account.email})`;
        }

        if (logoutButton instanceof HTMLButtonElement) {
            logoutButton.disabled = false;
        }

        console.info("[ACCOUNT] Current account loaded");
    } catch (error) {
        if (error instanceof Error && error.status === 401) {
            console.warn("[AUTH] Session expired or unauthorized");
            // 로그인 정보가 없으면 로그인 페이지 이동
            window.location.replace("./login.html");
            return;
        }

        console.error("[ACCOUNT] Failed to load current account:", error);

        if (accountName instanceof HTMLElement) {
            accountName.textContent = "사용자 정보를 불러오지 못했습니다.";
        }
    }
}
/**
 * @description 로그아웃 button click
 */

logoutButton?.addEventListener("click", async () => {
    if (!(logoutButton instanceof HTMLButtonElement)) {
        return;
    }

    console.debug("[AUTH] Logout requested");

    const defaultButtonText = logoutButton.textContent;

    try {
        logoutButton.disabled = true;
        logoutButton.textContent = "로그아웃 중...";

        await requestAPI("/api/auth/logout", {
            method: "POST"
        });

        console.info("[AUTH] Logout successful");
        window.location.replace("./login.html");
    } catch (error) {
        console.error("[AUTH] Logout failed:", error);

        logoutButton.disabled = false;
        logoutButton.textContent = defaultButtonText;

        if (accountName instanceof HTMLElement) {
            accountName.textContent = error instanceof Error
                ? error.message
                : "로그아웃에 실패했습니다.";
        }
    }
});

loadCurrentAccount();