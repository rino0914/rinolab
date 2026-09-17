export async function regenerateSession(request) {
    const previousId = request.sessionID;
    await new Promise((resolve, reject) => {
        request.session.regenerate((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
    await request.app.locals.revokeOidcSessions?.(previousId);
}

export function saveSession(request) {
    return new Promise((resolve, reject) => {
        request.session.save((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

export async function destroySession(request) {
    const previousId = request.sessionID;
    await new Promise((resolve, reject) => {
        request.session.destroy((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
    await request.app.locals.revokeOidcSessions?.(previousId);
}
