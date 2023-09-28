"use strict";

Date.prototype.toUnixTIme = function () {
    return Math.floor(this / 1000);
}

Array.prototype.ToTlgButtons = async function ({idKey, textKey}, prevCmd, addBackButton = true) {
    let data = this.map(p => {
        // let text = (typeof p.textIcon === 'function' ? p.textIcon() : p.textIcon) || p.title;
        let text = p.textIcon?.call(p) || p[textKey];

        return [{text: text, callback_data: p[idKey]?.toString()}];
    }) || [];

    if (addBackButton) {
        data.push([{text: "برگشت ↩️", callback_data: prevCmd}])
    }

    return data;
}


const Config = require('./config');
const Plan = require('./models/plan');
const Server = require('./models/server');
const Order = require('./models/order');
const Payment = require('./models/payment');
const admin = require("./models/admin");
const Admin = require('./models/admin');
const Command = require('./models/command');

const DataModel = {Plan, Order, Payment, Server};

const wKV = require('./modules/wkv');
const wkv = new wKV(db);

const Hiddify = require("./modules/hiddify");
const Telegram = require("./modules/telegram");

const WEBHOOK = Config.bot.webHook
const SECRET = Config.bot.secret;

const TlgBot = new Telegram(Config.bot.token);


// Seed Sample Data
// Plan.seedData(wkv).then(p => TlgBot.sendToAdmin('booted....', []).then(console.log))


/**
 * Wait for requests to the worker
 */
addEventListener('fetch', async event => {
    const url = new URL(event.request.url);

    switch (url.pathname) {
        case WEBHOOK:
            event.respondWith(handleWebhook(event))
            break;
        case '/registerWebhook':
            event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
            break;
        case '/unRegisterWebhook':
            event.respondWith(unRegisterWebhook(event))
            break;
        default:
            event.respondWith(new Response('No handler for this request'))
            break;
    }
})

/**
 * Handle requests to WEBHOOK
 * https://core.telegram.org/bots/api#update
 */
async function handleWebhook(event) {
    // Check secret
    if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
        return new Response('Unauthorized', {status: 403})
    }

    // Read request body synchronously
    const update = await event.request.json()

    // Deal with response asynchronously
    event.waitUntil(onUpdate(update))

    return new Response('Ok')
}

/**
 * Handle incoming Update
 * supports messages and callback queries (inline button presses)
 * https://core.telegram.org/bots/api#update
 */
async function onUpdate(update) {
    if ('message' in update) {
        await onMessage(update.message, {update})
    }

    if ('callback_query' in update) {
        let message = update.callback_query.message;
        message.text = update.callback_query.data;

        await onMessage(message, {update})
        // await onCallbackQuery(update.callback_query)
    }
}

/**
 * Set webhook to this worker's url
 * https://core.telegram.org/bots/api#setwebhook
 */
async function registerWebhook(event, requestUrl, suffix, secret) {
    // https://core.telegram.org/bots/api#setwebhook
    const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`
    const r = await (await fetch(TlgBot.apiUrl('setWebhook', {url: webhookUrl, secret_token: secret}))).json()
    return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

/**
 * Remove webhook
 * https://core.telegram.org/bots/api#setwebhook
 */
async function unRegisterWebhook(event) {
    const r = await (await fetch(TlgBot.apiUrl('setWebhook', {url: ''}))).json()
    return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}


async function buildButtons(cmd, isAdmin, options = {}) {
    let prevCmd = cmd.prevId;
    let opt = Object.assign({}, options, {forAdmin: isAdmin, prevCmd: cmd.prevId});

    return Array.isArray(cmd.buttons) ?
        await Command.findByIds(cmd.buttons, p => p.asButton).ToTlgButtons({
            textKey: "textIcon",
            idKey: "id"
        }, prevCmd) :
        await DataModel[cmd.buttons].findAll(wkv, opt);
}


/**
 * Handle incoming Message
 * https://core.telegram.org/bots/api#message
 */
async function onMessage(message, options = {}) {
    let chatId = message.chat_id || message.chat.id;
    let isAdmin = chatId === Config.bot.adminId;

    try {
        let usrSession = await wkv.get(chatId, {type: "json"}) || {};
        let [cmdId, input] = message.text.split(';');
        let handler = {db: wkv, input: input || message.text, message, usrSession};

        // await TlgBot.sendInlineButtonRow(chatId, `DEBUG MODE - values: ${JSON.stringify([cmdId, input])}`, [])

        switch (cmdId.toLowerCase()) {
            case Config.commands.silentButton.toLowerCase():
                return await Promise.resolve();

            case "/start".toLowerCase():
            case "/help".toLowerCase():
                return await sendStartMessage(message, isAdmin);

            case Server.seed.cmd.toLowerCase():
                return await sendServers(message);

            case Plan.seed.cmd.toLowerCase():
                if (input) {
                    let server = {[Server.seed.cmd]: input};
                    usrSession = await wkv.update(chatId, server);
                }

                return await sendPlans(message);

            case Payment.seed.cmd.toLowerCase():
                if (input) {
                    let plan = {[Plan.seed.cmd]: input};
                    usrSession = await wkv.update(chatId, plan)
                }

                return await sendPayments(message, "show_invoice");

            case "show_invoice".toLowerCase():
                if (input) {
                    let payment = {[Payment.seed.cmd]: input};
                    usrSession = await wkv.update(chatId, payment);
                }

                return await sendInvoice(message, usrSession, "show_invoice");

            case "order_history".toLowerCase():
                if (input) {
                    let payment = {[Payment.seed.cmd]: input};
                    usrSession = await wkv.update(chatId, payment);
                }

                return await showOrders(message, "show_invoice");

            case "confirm_order".toLowerCase():
                //TODO: admin ACL
                return await confirmOrder(message, usrSession);

            case "reject_order".toLowerCase():
                //TODO: admin ACL check
                return await rejectOrder(message, usrSession, options)
            // case Config.commands.updateNewOrderButtons.toLowerCase():
            //     return await updateNewOrderButtons(message);

            case "status_link".toLowerCase():
                return await sendStartMessage(message, isAdmin);
        }

        let cmd = Command.find(cmdId);
        let currentCmd = Command.find(usrSession.currentCmd);

        // await TlgBot.sendInlineButtonRow(chatId, `cmd: ${cmd?.id} && currentCmd: ${currentCmd?.id}`, [])

        if (cmd) {
            if (input) {
                let input = {[cmd.id]: input};
                usrSession = await wkv.update(chatId, input);
            }

            //TODO: Exec preFUnc

            let buttons = await buildButtons(cmd, isAdmin, {pub: TlgBot});
            // await TlgBot.sendInlineButtonRow(chatId, `buttons: ${buttons}`, [])

            let opt = {method: 'editMessageText', messageId: message.message_id, pub: TlgBot}
            let text1 = `${cmd.body}\n${cmd.helpText}`;
            let response = await TlgBot.sendInlineButtonRow(chatId, text1, buttons, opt);

            if (cmd.nextId) {
                await wkv.update(chatId, {currentCmd: cmd.nextId})
            }

            return response
        }

        if (currentCmd) {
            if (currentCmd.preFunc) {
                let {model, func} = currentCmd.preFuncData();

                let preFunc = await DataModel[model]?.[func](handler, {pub: TlgBot, debug: true});
            }

            let {text, buttons} = await Command.buildCmdInfo(wkv, currentCmd, DataModel, isAdmin, {});
            let opt = {method: 'editMessageText', messageId: message.message_id}
            let sentMessageRes = await TlgBot.sendInlineButtonRow(chatId, text, buttons, {});

            if (currentCmd.nextId) {
                await wkv.update(chatId, {currentCmd: currentCmd.nextId})
            }

            return sentMessageRes
        }


        let result = usrSession.isLast === true ?
            await saveOrder(message, usrSession) :
            await sendStartMessage(message, isAdmin);

        // await sendInlineButtonRow(message.chat.id, `userSession values: ${JSON.stringify(usrSession)}`, [])

        return result;

    } catch (e) {
        let text = e?.stack || e?.message || JSON.stringify(e);
        await TlgBot.sendInlineButtonRow(chatId, text, [])
    }
}

function pushAdminButtons(buttons = [], isAdmin = false) {
    if (isAdmin) {
        buttons.push(Admin.buttons.default);
    }

    return buttons;
}

async function sendStartMessage(message, isAdmin) {
    let chatId = message.chat_id || message.chat.id;
    let buttonRow = [
        [{text: 'خرید اشتراک', callback_data: 'select_server'}],
        [{text: 'سوابق خرید', callback_data: 'order_history'}]
    ];

    buttonRow = pushAdminButtons(buttonRow, isAdmin)
    return await TlgBot.sendInlineButtonRow(chatId, Config.bot.welcomeMessage, buttonRow)
}


function sendServers(message) {
    let chatId = message.chat.id;
    let text = 'یک لوکیشین برای اتصال، انتخاب کنید ';
    let data = Server.getButtons(Plan.seed.cmd);

    return TlgBot.sendInlineButtonRow(chatId, text, data, {method: 'editMessageText', messageId: message.message_id})
}

function sendPlans(message) {
    let chatId = message.chat.id;
    let text = 'یکی از پلن های زیرو انتخاب کنید';

    let buttons = Plan.getButtons(Payment.seed.cmd);


    return TlgBot.sendInlineButtonRow(chatId, text, buttons, {method: 'editMessageText', messageId: message.message_id})
}

async function editButtons(message, buttons = []) {
    return await TlgBot.sendInlineButtonRow(message.chat_id || message.chat.id, undefined, buttons, {
        method: 'editMessageReplyMarkup',
        messageId: message.message_id
    });
}

async function confirmOrder(message) {
    let values = message.text.split(';');
    let chatId = message.chat_id || message.chat.id;
    let orderId = values[1];

    if (!orderId) {
        let text = `سفارشی برای پردازش پیدا نشد!`;
        return await TlgBot.sendInlineButtonRow(Config.bot.adminId, text, [])
    }

    let {model, userChatId, unixTime} = Order.parseId(orderId);

    let order = JSON.parse(await wkv.get(orderId)) || {};
    let sPlan = Plan.findById(order[Plan.seed.cmd])?.model;
    let sServer = Server.findById(order[Server.seed.cmd])?.model;

    let opt = {}
    if (order.invoiceMessageId) {
        opt = {method: 'editMessageText', messageId: order.invoiceMessageId};
    }

    let hiddify = new Hiddify();
    let accOpt = {customName: `${sServer.remark}-${userChatId}-${new Date().toUnixTIme()}`}
    let res = await hiddify.createAccount(sPlan, sServer, userChatId, accOpt);
    let data = await res.json();

    //TODO: test me
    if (res.status != 200) {
        let text = `در ساخت اکانت برای کاربر مشکلی پیش اومد!
        لطفا این موضوع رو پیگیری کنید  🙏`;
        text += `\n\n ${await res.text()}`;

        return await TlgBot.sendInlineButtonRow(Config.bot.adminId, text, [], {
            method: 'sendMessage', reply_to_message_id: chatId
        });
    }

    await wkv.update(orderId, {accountName: accOpt.customName})

    let accountText = admin.newAccountText(sPlan, data.userUrl, Config)
    let response = await TlgBot.sendInlineButtonRow(userChatId, accountText, [
        [{text: "🏡 صفحه اصلی", callback_data: "/start"}]
    ], opt);


    await editButtons(message, [
        [{text: "سفارش ارسال شده!", callback_data: Config.commands.silentButton}]
    ])

    return response
}


async function rejectOrder(message) {
    let values = message.text.split(';');

    if (values.length < 2) {
        return await TlgBot.sendInlineButtonRow(Config.bot.adminId, `یوزر برای ارسال پیام پیدا نشد!`, [])
    }

    let opt = {}
    let orderId = values[1];
    let {model, userChatId, unixTime} = Order.parseId(orderId);

    let order = JSON.parse(await wkv.get(orderId)) || {};
    if (order.invoiceMessageId) {
        opt = {method: 'editMessageText', messageId: order.invoiceMessageId};
    }

    await wkv.update(orderId, {rejected: true});

    let text = `سفارش شما رد شد! 
برای بررسی مجدد، اطلاعات پرداخت رو برای پشتیبانی ارسال کنید  🙏
    
    ${Config.bot.tlgSupport}
    
    
    `;
    let response = await TlgBot.sendInlineButtonRow(Number(userChatId), text, [
        [
            {text: "✨  شروع مجدد", callback_data: "/start"}
        ]
    ], opt);

    await editButtons(message, [
        [{text: "سفارش رد شده!", callback_data: Config.commands.silentButton}],
        // [{text: "↩️ بازنگری", callback_data: `${Config.commands.updateNewOrderButtons};${userChatId}`}],
    ])

    return response
}

async function sendOrderToAdmin(message, session, orderId) {
    let sPlan = Plan.findById(session[Plan.seed.cmd])?.model;
    let sPayment = Payment.findById(session[Payment.seed.cmd])?.model;
    let msg = Order.adminNewOrder(message.chat, sPlan, sPayment, message);

    let buttons = admin.getNewOrderButtons(orderId);

    return await TlgBot.sendInlineButtonRow(Config.bot.adminId, msg, buttons)
}

async function saveOrder(message, session, sendToAdmin = true, deleteSession = true) {
    let chatId = message.chat.id || message.chat_id;

    //Send msg to user
    let sPlan = Plan.findById(session[Plan.seed.cmd])?.model;
    let sPayment = Payment.findById(session[Payment.seed.cmd])?.model;
    let msg = Order.savedOrderText(sPlan, sPayment);
    let sentUserOrderRes = await TlgBot.sendInlineButtonRow(chatId, msg, [
        // [{text: "پیگیری", callback_data: "send_message"}]
    ]);

    let data = await sentUserOrderRes.json() || {};
    let newOrder = Object.assign({}, session, {
        userId: chatId,
        invoiceMessageId: data.result?.message_id,
        payProofText: message.text,
        createdAt: new Date().toUnixTIme()
    })

    let orderId = Order.getId(chatId);
    await wkv.put(orderId, newOrder)


    if (deleteSession) {
        await wkv.delete(chatId)
    }

    if (sendToAdmin) {
        await sendOrderToAdmin(message, session, orderId)
    }
    return sentUserOrderRes
}

async function showOrders(message, nextCmd) {
    let chatId = message.chat_id || message.chat.id;
    let {uOrders, buttons} = await Order.gerOrders(wkv, chatId, {toButtons: true, nextCmd: nextCmd});

    // let data = await db.getWithMetadata(query);
    await TlgBot.sendInlineButtonRow(Config.bot.adminId, `gerOrders: ${JSON.stringify(uOrders)}`, [])


    let tt = `uOrders: ${JSON.stringify(uOrders)}, buttons: ${JSON.stringify(buttons)}`;
    await TlgBot.sendInlineButtonRow(chatId, tt);

    if (buttons.length < 1) {
        let text = `هیچ سفارش ثبت شده ای ندارید!`;
        return await TlgBot.sendInlineButtonRow(chatId, text, buttons, {
            method: 'editMessageText',
            messageId: message.message_id
        })
    }

    let text = `لیست سفارشات تون 👇`;
    return await TlgBot.sendInlineButtonRow(chatId, text, buttons, {
        method: 'editMessageText',
        messageId: message.message_id
    })
}

async function sendInvoice(message, session, nextCmd) {
    let chatId = message.chat_id || message.chat.id;
    let sPlan = Plan.findById(session[Plan.seed.cmd])?.model;
    let sPayment = Payment.findById(session[Payment.seed.cmd])?.model;

    let msg = Order.reviewInvoice(sPlan, sPayment);

    await wkv.update(chatId, {lastCmd: "show_invoice", isLast: true});

    return await TlgBot.sendInlineButtonRow(chatId, msg, [
        // [{text: '❗️ لغو خرید', callback_data: '/start'}],
        [{text: "برگشت ↩️", callback_data: Payment.seed.cmd}]
    ], {method: 'editMessageText', messageId: message.message_id})
}

function sendPayments(message, nextCmd) {
    let chatId = message.chat.id;
    let text = 'یک روش پرداخت رو انتخاب کنید';

    let buttons = Payment.getButtons(nextCmd)

    return TlgBot.sendInlineButtonRow(chatId, text, buttons, {method: 'editMessageText', messageId: message.message_id})
}



