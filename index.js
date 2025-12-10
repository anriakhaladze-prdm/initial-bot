const { App, ExpressReceiver } = require("@slack/bolt");
const express = require("express");
const fetch = require("node-fetch");

// Slack receiver (Express wrapper so Render works)
const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Slack app
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver
});

const BETBY_CHANNEL = process.env.BETBY_CHANNEL;

// ----------------------- SLACK URL VERIFICATION ------------------------
receiver.app.post("/slack/events", express.json(), (req, res) => {
    if (req.body.type === "url_verification") {
        console.log("Received Slack challenge");
        return res.status(200).send(req.body.challenge);
    }
    return res.status(200).send();
});

// ----------------------- Utilities ------------------------
function extractExternalPlayerId(body) {
    const match = body.match(/"external_player_id"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
}

// ----------------------- SUMSUB ---------------------------
async function createSumsubLiveness(externalPlayerId) {
    const url = "https://api.sumsub.com/resources/applicants/-/websdkLink";

    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "X-External-User-ID": externalPlayerId,
            "Content-Type": "application/json",
            "X-App-Token": process.env.SUMSUB_APP_TOKEN,
            "X-App-Access-Token": process.env.SUMSUB_SECRET_KEY
        },
        body: JSON.stringify({
            levelName: "liveness-only",
            ttlInSecs: 600
        })
    });

    const data = await resp.json();
    return data.url;
}

// ----------------------- INTERCOM ---------------------------
async function sendIntercomMessage(externalPlayerId, link) {
    const resp = await fetch("https://api.intercom.io/messages", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.INTERCOM_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify({
            message_type: "inapp",
            from: { type: "admin", id: process.env.INTERCOM_ADMIN_ID },
            to: { type: "user", user_id: externalPlayerId },
            body: `For security verification, please complete your liveness check:\n${link}`
        })
    });

    return resp.ok;
}

app.event("message", async ({ event }) => {
    console.log("DEBUG EVENT:", JSON.stringify(event, null, 2));
});


// ----------------------- SLACK EVENT LISTENER ---------------------------
app.event("message", { include_bot_messages: true }, async ({ event, client }) => {

    console.log("EVENT RECEIVED:", event);

    // Ignore messages without text (attachments only)
    if (!event.text) return;

    // Only react in the correct channel
    if (event.channel !== BETBY_CHANNEL) return;

    // Ignore Slack system messages that are not real messages
    const ignoredSubtypes = ["message_changed", "message_deleted", "channel_join", "thread_broadcast"];
    if (ignoredSubtypes.includes(event.subtype)) return;

    // POST BUTTONS
    await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "Send liveness?",
        blocks: [
            {
                type: "section",
                text: { type: "mrkdwn", text: "*Send liveness?*" }
            },
            {
                type: "actions",
                elements: [
                    {
                        type: "button",
                        text: { type: "plain_text", text: "Yes" },
                        action_id: "send_liveness_yes",
                        value: event.text
                    },
                    {
                        type: "button",
                        text: { type: "plain_text", text: "No" },
                        action_id: "send_liveness_no",
                        value: "no"
                    }
                ]
            }
        ]
    });
});


// ----------------------- SLACK BUTTON: YES ---------------------------
app.action("send_liveness_yes", async ({ ack, body, client }) => {
    await ack();

    const rawEmail = body.actions[0].value;
    const externalId = extractExternalPlayerId(rawEmail);

    if (!externalId) {
        await client.chat.postMessage({
            channel: body.channel.id,
            thread_ts: body.message.ts,
            text: "Could not extract external_player_id."
        });
        return;
    }

    const link = await createSumsubLiveness(externalId);
    await sendIntercomMessage(externalId, link);

    await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.ts,
        text: "Liveness link sent to player via Intercom."
    });
});

// ----------------------- SLACK BUTTON: NO ---------------------------
app.action("send_liveness_no", async ({ ack, body, client }) => {
    await ack();

    await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.ts,
        text: "Ok — no liveness will be initiated."
    });
});

// ----------------------- ROOT ENDPOINT ---------------------------
receiver.app.get("/", (req, res) => {
    res.send("Slack Liveness Bot Running");
});

// ----------------------- START SERVER ---------------------------
const PORT = process.env.PORT || 3000;
receiver.app.listen(PORT, () => {
    console.log("Bot running on port " + PORT);
});