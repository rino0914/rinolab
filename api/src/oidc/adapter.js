import { getDB } from "../db.js";

const collectionName = "oidc_state";

function storageKey(model, id) {
    return `${model}:${id}`;
}

export async function initializeOidcStorage(database = getDB()) {
    const collection = database.collection(collectionName);

    await collection.createIndexes([
        {
            name: "oidc_state_expiry",
            key: { expiresAt: 1 },
            expireAfterSeconds: 0
        },
        {
            name: "oidc_state_grant",
            key: { model: 1, "payload.grantId": 1 }
        },
        {
            name: "oidc_state_user_code",
            key: { model: 1, "payload.userCode": 1 },
            unique: true,
            partialFilterExpression: {
                "payload.userCode": { $type: "string" }
            }
        },
        {
            name: "oidc_state_uid",
            key: { model: 1, "payload.uid": 1 },
            unique: true,
            partialFilterExpression: {
                "payload.uid": { $type: "string" }
            }
        }
    ]);

    await database.collection("oidc_handoffs").createIndex(
        { expiresAt: 1 },
        { name: "oidc_handoff_expiry", expireAfterSeconds: 0 }
    );
    await database.collection("oidc_session_bindings").createIndexes([
        { key: { portalSessionId: 1 }, name: "oidc_portal_session" },
        { key: { expiresAt: 1 }, name: "oidc_binding_expiry", expireAfterSeconds: 0 }
    ]);
}

export class MongoOidcAdapter {
    constructor(model) {
        this.model = model;
    }

    collection() {
        return getDB().collection(collectionName);
    }

    async upsert(id, payload, expiresIn) {
        const update = {
            $set: {
                model: this.model,
                payload
            }
        };

        if (expiresIn) {
            update.$set.expiresAt = new Date(Date.now() + (expiresIn * 1000));
        } else {
            update.$unset = { expiresAt: "" };
        }

        await this.collection().updateOne(
            { _id: storageKey(this.model, id) },
            update,
            { upsert: true }
        );
    }

    async find(id) {
        const result = await this.collection().findOne(
            { _id: storageKey(this.model, id) },
            { projection: { payload: 1 } }
        );

        return result?.payload;
    }

    async findByUserCode(userCode) {
        const result = await this.collection().findOne(
            { model: this.model, "payload.userCode": userCode },
            { projection: { payload: 1 } }
        );

        return result?.payload;
    }

    async findByUid(uid) {
        const result = await this.collection().findOne(
            { model: this.model, "payload.uid": uid },
            { projection: { payload: 1 } }
        );

        return result?.payload;
    }

    async destroy(id) {
        await this.collection().deleteOne({
            _id: storageKey(this.model, id)
        });
    }

    async revokeByGrantId(grantId) {
        await this.collection().deleteMany({
            model: this.model,
            "payload.grantId": grantId
        });
    }

    async consume(id) {
        await this.collection().updateOne(
            { _id: storageKey(this.model, id) },
            { $set: { "payload.consumed": Math.floor(Date.now() / 1000) } }
        );
    }
}
