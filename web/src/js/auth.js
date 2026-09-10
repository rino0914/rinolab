const forms = document.querySelectorAll("[data-auth-form]");
const passwordToggles = document.querySelectorAll("[data-toggle-password]");

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

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        validatePasswordConfirmation();

        if (!form.reportValidity()) {
            return;
        }

        const status = form.querySelector("[data-form-status]");
        if (status instanceof HTMLElement) {
            status.hidden = false;
            status.focus();
        }
    });
});
