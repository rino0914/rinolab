/**
 * @file api.js
 * @description 서버 API 호출 시 사용하는 공통 모듈
 */

/**
 * 서버에 요청을 보내고 JSON 응답을 반환한다.
 * @param {string} path - 요청할 APIwnth
 * @param {ReqeustInit} [options={}] 옵션
 * @returns {Promise<*>} - Json 응답 데이터
 */
export async function requestAPI(path, options = {}) {
    const response = await fetch(path, {
        credentials: "include",
        ...options,
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...options.headers
        }
    });

    // 응담코드 204 또는 Json이 아닌 응답은 파싱 생략
    const contentType = response.headers.get("content-type") ?? "";
    const result = response.status !== 204 && contentType.includes("application/json")
        ? await response.json()
        : null;

    if (!response.ok) {
        const error = new Error(result?.message ?? "요청 처리에 실패했습니다.");
        error.status = response.status;
        throw error;
    }

    return result;
}
