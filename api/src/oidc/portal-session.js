import { getDB } from "../db.js";

// The portal owns authentication. OIDC sessions are only a linked SSO cache.
export function createPortalSessionBridge(sessionStore, getDatabase = getDB) {
    const bindings = () => getDatabase().collection("oidc_session_bindings");

    async function read(portalSessionId, accountId) {
        if (typeof portalSessionId !== "string" || !portalSessionId) return undefined;
        const session = await new Promise((resolve, reject) => {
            sessionStore.get(portalSessionId, (error, value) => {
                if (error) reject(error);
                else resolve(value);
            });
        });
        if (!session || session.accountId !== accountId) return undefined;
        if (session.cookie?.expires && new Date(session.cookie.expires) <= new Date()) {
            return undefined;
        }
        return session;
    }

    return {
        read,
        async verifyAuthorization(context) {
            const { oidc } = context;
            const login = oidc.result?.login;
            // Require a fresh browser round trip to the portal for each authorization.
            // An OP cookie alone cannot tell which portal cookie this browser has now.
            if (!login || login.accountId !== oidc.session.accountId ||
                !await read(login.portalSessionId, login.accountId)) {
                return false;
            }
            await bindings().updateOne({ _id: oidc.session.uid }, {
                $set: {
                    portalSessionId: login.portalSessionId,
                    accountId: login.accountId,
                    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
                }
            }, { upsert: true });
            return true;
        },
        async revoke(provider, portalSessionId) {
            if (!portalSessionId) return;
            const linked = await bindings().find({ portalSessionId }).toArray();
            for (const binding of linked) {
                const session = await provider.Session.findByUid(binding._id);
                if (session) await session.destroy();
            }
            await bindings().deleteMany({ portalSessionId });
        }
    };
}
