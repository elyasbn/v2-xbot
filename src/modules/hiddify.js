const { v4: uuidv4 } = require("uuid");
const wFetch = require("./wfetch");

module.exports = class Hiddify {
    baseUrl = "https://serhat.marcman.eu/{proxy_path}/api/v2/admin/user/";

    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    async createAccount(plan, server, userChatId, comment = "", options = {}) {
        const url = this.baseUrl;
        const body = {
            added_by_uuid: null,
            comment: comment || null,
            current_usage_GB: 0,
            ed25519_private_key: options.ed25519_private_key || "string",
            ed25519_public_key: options.ed25519_public_key || "string",
            enable: true,
            is_active: true,
            lang: "en",
            last_online: null,
            last_reset_time: null,
            mode: "no_reset",
            name: options.customName || `${server.remark}-${userChatId}-${Date.now()}`,
            package_days: plan.maxDays || 0,
            start_date: new Date().toISOString().split("T")[0],
            telegram_id: userChatId,
            usage_limit_GB: plan.volume || 0,
            uuid: options.uuid || uuidv4(),
            wg_pk: options.wg_pk || "string",
            wg_psk: options.wg_psk || "string",
            wg_pub: options.wg_pub || "string"
        };

        return this.sendRequest(url, 'POST', body);
    }

    async extendAccount(plan, server, userChatId, uuid, options = {}) {
        const url = this.baseUrl + `${uuid}/extend`;
        const body = {
            added_by_uuid: null,
            comment: options.comment || null,
            current_usage_GB: 0,
            ed25519_private_key: options.ed25519_private_key || "string",
            ed25519_public_key: options.ed25519_public_key || "string",
            enable: true,
            is_active: true,
            lang: "en",
            last_online: null,
            last_reset_time: null,
            mode: "no_reset",
            name: options.customName || `${server.remark}-${userChatId}-${Date.now()}`,
            package_days: plan.maxDays || 0,
            start_date: new Date().toISOString().split("T")[0],
            telegram_id: userChatId,
            usage_limit_GB: plan.volume || 0,
            uuid: uuid,
            wg_pk: options.wg_pk || "string",
            wg_psk: options.wg_psk || "string",
            wg_pub: options.wg_pub || "string"
        };

        return this.sendRequest(url, 'POST', body);
    }

    async sendRequest(url, method, body) {
        const options = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Hiddify-API-Key': this.apiKey
            },
            body: JSON.stringify(body)
        };

        try {
            const response = await wFetch(url, options);
            return await response.json();
        } catch (error) {
            console.error('Error during request:', error);
            throw error;
        }
    }
}
