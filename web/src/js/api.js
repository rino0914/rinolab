export async function requestAPI(path, options = {}) {
    const response = await fetch(path, {
        credentials: "include",
        ...options,
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...options.headers
        }
    });

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
