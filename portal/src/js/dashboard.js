import { requestAPI } from "./api.js";

const accountName = document.querySelector("[data-account-name]");
const logoutButton = document.querySelector("[data-logout]");

async function loadCurrentAccount() {
    try {
        const result = await requestAPI("/api/auth/me");

        if (accountName instanceof HTMLElement) {
            accountName.textContent = `${result.account.name} (${result.account.email})`;
        }

        if (logoutButton instanceof HTMLButtonElement) {
            logoutButton.disabled = false;
        }
    } catch (error) {
        if (error instanceof Error && error.status === 401) {
            window.location.replace("./login.html");
            return;
        }

        if (accountName instanceof HTMLElement) {
            accountName.textContent = "사용자 정보를 불러오지 못했습니다.";
        }
    }
}

logoutButton?.addEventListener("click", async () => {
    if (!(logoutButton instanceof HTMLButtonElement)) {
        return;
    }

    const defaultButtonText = logoutButton.textContent;

    try {
        logoutButton.disabled = true;
        logoutButton.textContent = "로그아웃 중...";

        await requestAPI("/api/auth/logout", {
            method: "POST"
        });

        window.location.replace("./login.html");
    } catch (error) {
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
