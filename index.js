const { App, ExpressReceiver } = require("@slack/bolt");
const express = require("express");
const fetch = require("node-fetch");

// Slack receiver (so Render can run Express)
const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Slack App
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver
});

const BETBY_CHANNEL = process.env.BETBY_CHANNEL;

// ----------- UTIL: Extract external_player_id from email text -------------
function extractExternalPlayerId(body) {
    const match = body.match(/"external_player_id"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
}

// ----------- SUMSUB: Create liveness link -------------------------------
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

// ----------- INTERCOM: Send message to player ---------------------------
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

// ------------------------- SLACK EVENT: NEW MESSAGE ---------------------
app.event("message", async ({ event, client }) => {
    if (event.channel !== BETBY_CHANNEL) return;

    const rawEmailText = event.text;

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
                        value: rawEmailText
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

// ------------------------ SLACK ACTION: YES -----------------------------
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

    // Create Sumsub link
    const link = await createSumsubLiveness(externalId);

    // Send to Intercom
    await sendIntercomMessage(externalId, link);

    await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.ts,
        text: `Liveness link sent to player via Intercom.`
    });
});

// ------------------------ SLACK ACTION: NO ------------------------------
app.action("send_liveness_no", async ({ ack, body, client }) => {
    await ack();

    await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.ts,
        text: "Ok — no liveness will be initiated."
    });
});

// ------------------------- START EXPRESS SERVER -------------------------
receiver.app.get("/", (req, res) => {
    res.send("Slack Liveness Bot Running");
});

const PORT = process.env.PORT || 3000;
receiver.app.listen(PORT, () => {
    console.log("Bot running on port " + PORT);
});