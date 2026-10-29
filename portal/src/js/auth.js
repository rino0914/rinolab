/**
 * @file auth.js
 * @description 회원가입·로그인 폼의 입력 검증, API 요청, 결과 안내 및 페이지 이동을 처리
 */
import { requestAPI } from "./api.js";

// data-auth-form="signup" 또는 "login"으로 지정된 폼을 찾아 공통으로 처리
const forms = document.querySelectorAll("[data-auth-form]");
// data-toggle-password에 표시/숨김 대상 입력란의 id가 지정된 버튼 목록
const passwordToggles = document.querySelectorAll("[data-toggle-password]");

// 로그인 후 돌아갈 주소는 현재 사이트와 같은 출처의 경로만 허용
function safeLoginReturnUrl() {
    // 예: login.html?returnTo=/pages/account.html에서 복귀 경로를 읽는다.
    const value = new URLSearchParams(window.location.search).get("returnTo");
    // 복귀 경로가 없거나 /로 시작하지 않으면 호출부에서 기본 화면을 사용한다.
    if (!value?.startsWith("/")) return undefined;

    const url = new URL(value, window.location.origin);
    // //example.com처럼 /로 시작해도 외부 사이트로 연결되는 주소는 제외한다.
    return url.origin === window.location.origin ? url.href : undefined;
}

// 비밀번호 표시 버튼과 연결된 입력란의 표시 상태 및 접근성 속성을 함께 갱신
passwordToggles.forEach((toggle) => {
    toggle.addEventListener("click", () => {
        // 버튼의 data-toggle-password 값을 이용해 연결된 비밀번호 입력란을 찾는다.
        const input = document.getElementById(toggle.dataset.togglePassword);

        // 연결된 요소가 없거나 input이 아니면 해당 클릭은 처리하지 않는다.
        if (!(input instanceof HTMLInputElement)) {
            return;
        }

        const passwordIsVisible = input.type === "text";
        input.type = passwordIsVisible ? "password" : "text";
        toggle.textContent = passwordIsVisible ? "표시" : "숨기기";
        // 스크린 리더에도 전환 후 비밀번호 표시 상태를 전달한다.
        toggle.setAttribute("aria-pressed", String(!passwordIsVisible));
    });
});

forms.forEach((form) => {
    // 각 폼 내부에서만 입력란을 찾아 다른 폼의 값과 섞이지 않도록 한다.
    const password = form.querySelector("[name='password']");
    const passwordConfirm = form.querySelector("[name='passwordConfirm']");

    // 회원가입의 비밀번호 확인란을 검증. 확인란이 없는 로그인 폼은 건너뛴다.
    const validatePasswordConfirmation = () => {
        if (!(password instanceof HTMLInputElement) || !(passwordConfirm instanceof HTMLInputElement)) {
            return;
        }

        const passwordsMatch = password.value === passwordConfirm.value;
        // 빈 문자열은 검증 오류 해제, 오류 메시지는 해당 입력란을 유효하지 않은 상태로 만든다.
        passwordConfirm.setCustomValidity(passwordsMatch ? "" : "비밀번호가 일치하지 않습니다.");
    };

    // 비밀번호와 확인값 중 어느 쪽을 수정해도 일치 여부를 다시 검사한다.
    password?.addEventListener("input", validatePasswordConfirmation);
    passwordConfirm?.addEventListener("input", validatePasswordConfirmation);

    // 기본 폼 전송을 막고, 브라우저 입력 검증을 통과한 경우에만 API를 호출한다.
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        validatePasswordConfirmation();

        // required, minlength, pattern과 비밀번호 일치 여부를 검사하고 오류를 화면에 표시한다.
        if (!form.reportValidity()) {
            console.warn("[AUTH] 입력 검증 실패로 제출을 중단했습니다.");
            return;
        }
        const status = form.querySelector("[data-form-status]");
        const submitButton = form.querySelector("[type='submit']");
        // 입력 요소의 name을 키로 값을 읽는다. id나 화면에 표시된 라벨을 사용하지 않는다.
        const formData = new FormData(form);
        // HTML의 data-auth-form 값으로 회원가입과 로그인 요청을 구분한다.
        const authFormType = form.dataset.authForm;
        // 요청 종료 후 버튼 문구를 되돌리기 위해 제출 전 값을 보관한다.
        const defaultButtonText = submitButton?.textContent ?? "";

        // 폼 종류에 따라 API 주소, 전송 데이터, 성공 후 이동할 화면과 안내 문구를 정한다.
        let apiUrl;
        let data;
        let redirectUrl;
        let action;
        let pendingText;

        if (authFormType === "signup") {
            // 회원가입 submit → POST /api/auth/signup → api/src/routes/auth.js에서 새 계정 생성.
            apiUrl = "/api/auth/signup";
            // name은 표시 이름, username은 서비스 아이디. 비밀번호 확인값은 화면 검증에만 사용한다.
            data = {
                name: formData.get("name"),
                username: formData.get("username"),
                email: formData.get("email"),
                password: formData.get("password")
            };
            redirectUrl = "./login.html";
            action = "회원가입";
            pendingText = "계정 생성 중...";
        } else if (authFormType === "login") {
            // 로그인 submit → POST /api/auth/login → 서버에서 계정 확인 및 세션 생성.
            apiUrl = "/api/auth/login";
            data = {
                email: formData.get("email"),
                password: formData.get("password"),
                // 체크박스의 "on" 값을 서버가 기대하는 boolean으로 변환한다.
                remember: formData.get("remember") === "on"
            };
            // 허용된 복귀 경로가 없으면 기본 로그인 완료 화면인 대시보드로 이동한다.
            redirectUrl = safeLoginReturnUrl() ?? "./dashboard.html";
            action = "로그인";
            pendingText = "로그인 중...";
        } else {
            console.warn("[AUTH] 지원하지 않는 인증 폼이므로 제출을 중단했습니다.");
            return;
        }

        try {
            console.debug(`[AUTH] ${action} 요청 시작`);

            // 요청 중 제출 버튼을 잠그고 이전 오류 안내를 숨긴다.
            if (submitButton instanceof HTMLButtonElement) {
                submitButton.disabled = true;
                submitButton.textContent = pendingText;
            }

            if (status instanceof HTMLElement) {
                status.hidden = true;
            }

            // JSON 본문으로 전송한다. API가 오류 응답을 보내면 requestAPI가 예외를 던져 catch로 이동한다.
            await requestAPI(apiUrl, {
                method: "POST",
                body: JSON.stringify(data)
            });

            console.info(`[AUTH] ${action} 성공`);
            // 가입 성공 시 로그인 화면으로, 로그인 성공 시 복귀 경로나 대시보드로 이동한다.
            window.location.href = redirectUrl;
        } catch (error) {
            // HTTP 상태를 알 수 없는 오류는 null로 기록하며 입력값이나 오류 객체 전체는 출력하지 않는다.
            console.error(`[AUTH] ${action} 실패`, {
                status: error instanceof Error && typeof error.status === "number" ? error.status : null
            });

            // 서버 오류 안내를 폼에 표시하고 포커스를 옮겨 사용자가 바로 확인할 수 있게 한다.
            if (status instanceof HTMLElement) {
                // Error 객체이면 전달된 메시지를 사용하고, 그 외에는 작업별 기본 안내를 표시한다.
                status.textContent =
                    error instanceof Error
                        ? error.message
                        : `${action}에 실패했습니다.`;
                status.hidden = false;
                status.focus();
            }
        } finally {
            // 성공·실패 여부와 관계없이 제출 버튼을 원래 상태로 복구한다.
            if (submitButton instanceof HTMLButtonElement) {
                submitButton.disabled = false;
                submitButton.textContent = defaultButtonText;
            }
        }
    });
});
