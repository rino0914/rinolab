import { ObjectId } from "mongodb";
import { getDB } from "../db.js";

export function claimsForAccount(account) {
    const subject = account._id.toString();

    return {
        sub: subject,
        email: account.email,
        email_verified: false,
        name: account.name,
        preferred_username: account.email,
        rinolab_role: account.role
    };
}

export function createOidcAccountFinder(getDatabase = getDB) {
    return async function findAccount(context, subject) {
        if (!ObjectId.isValid(subject)) {
            return undefined;
        }

        const account = await getDatabase().collection("accounts").findOne({
            _id: new ObjectId(subject),
            status: "ACTIVE"
        });

        if (!account) {
            return undefined;
        }

        return {
            accountId: subject,
            async claims() {
                return claimsForAccount(account);
            }
        };
    };
}
