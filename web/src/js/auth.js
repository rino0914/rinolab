import { requestAPI } from "./api.js";

const forms = document.querySelectorAll("[data-auth-form]");
const passwordToggles = document.querySelectorAll("[data-toggle-password]");

function safeLoginReturnUrl() {
    const value = new URLSearchParams(window.location.search).get("returnTo");
    if (!value?.startsWith("/")) return undefined;

    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? url.href : undefined;
}

passwordToggles.forEach((toggle) => {
    toggle.addEventListener("click", () => {
        const input = document.getElementById(toggle.dataset.togglePassword);

        if (!(input instanceof HTMLInputElement)) {
            return;
        }

        const passwordIsVisible = input.type === "text";
        input.type = passwordIsVisible ? "password" : "text";
        toggle.textContent = passwordIsVisible ? "표시" : "숨기기";
        toggle.setAttribute("aria-pressed", String(!passwordIsVisible));
    });
});

forms.forEach((form) => {
    const password = form.querySelector("[name='password']");
    const passwordConfirm = form.querySelector("[name='passwordConfirm']");

    const validatePasswordConfirmation = () => {
        if (!(password instanceof HTMLInputElement) || !(passwordConfirm instanceof HTMLInputElement)) {
            return;
        }

        const passwordsMatch = password.value === passwordConfirm.value;
        passwordConfirm.setCustomValidity(passwordsMatch ? "" : "비밀번호가 일치하지 않습니다.");
    };

    password?.addEventListener("input", validatePasswordConfirmation);
    passwordConfirm?.addEventListener("input", validatePasswordConfirmation);

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        validatePasswordConfirmation();

        if (!form.reportValidity()) {
            return;
        }
        const status = form.querySelector("[data-form-status]");
        const submitButton = form.querySelector("[type='submit']");
        const formData = new FormData(form);
        const authFormType = form.dataset.authForm;
        const defaultButtonText = submitButton?.textContent ?? "";

        let apiUrl;
        let data;
        let redirectUrl;
        let action;
        let pendingText;

        if (authFormType === "signup") {
            apiUrl = "/api/auth/signup";
            data = {
                name: formData.get("name"),
                email: formData.get("email"),
                password: formData.get("password")
            };
            redirectUrl = "./login.html";
            action = "회원가입";
            pendingText = "계정 생성 중...";
        } else if (authFormType === "login") {
            apiUrl = "/api/auth/login";
            data = {
                email: formData.get("email"),
                password: formData.get("password"),
                remember: formData.get("remember") === "on"
            };
            redirectUrl = safeLoginReturnUrl() ?? "./dashboard.html";
            action = "로그인";
            pendingText = "로그인 중...";
        } else {
            return;
        }

        try {
            if (submitButton instanceof HTMLButtonElement) {
                submitButton.disabled = true;
                submitButton.textContent = pendingText;
            }

            if (status instanceof HTMLElement) {
                status.hidden = true;
            }

            await requestAPI(apiUrl, {
                method: "POST",
                body: JSON.stringify(data)
            });

            window.location.href = redirectUrl;
        } catch (error) {
            if (status instanceof HTMLElement) {
                status.textContent =
                    error instanceof Error
                        ? error.message
                        : `${action}에 실패했습니다.`;
                status.hidden = false;
                status.focus();
            }
        } finally {
            if (submitButton instanceof HTMLButtonElement) {
                submitButton.disabled = false;
                submitButton.textContent = defaultButtonText;
            }
        }
    });
});
