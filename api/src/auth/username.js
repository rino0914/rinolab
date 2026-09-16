export const usernamePattern = /^[a-z][a-z0-9_-]{2,31}$/;

export function normalizeUsername(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

export function isValidUsername(value) {
    return typeof value === "string" && usernamePattern.test(value);
}
