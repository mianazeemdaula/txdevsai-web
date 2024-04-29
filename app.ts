import { Hono } from "hono";
import Groq from "groq-sdk";

import db from "./models/index.ts";
const app = new Hono();
const groq = new Groq({
    apiKey: Bun.env.GROQ_API_KEY,
});
app.get("/", (c) => c.text("Hello, World!"));

app.get("/models", async (c) => {
    const query = db.query("SELECT * FROM models");
    const models = query.all();
    return c.json(models);
});

app.post("/models", async (c) => {
    const body = await c.req.parseBody()
    const model = db.query("SELECT * FROM models WHERE name = $name").get({ '$name': body.name });
    if (model) {
        return c.json({ message: "Model already exists" }, 400);
    }
    const query = db.prepare("INSERT or replace INTO models (name) VALUES ($name)");
    const models = db.transaction(names => {
        for (const name of names) {
            query.run({ '$name': name });
        }
    });
    models([body.name]);
    const newModel = db.query("SELECT * FROM models WHERE name = $name").get({ '$name': body.name });
    return c.json(newModel);
});

// Chat with GROQ
app.post("/chat", async (c) => {
    const body = await c.req.parseBody();
    if (!body.message) {
        return c.json({ message: "Message is required" }, 400);
    }
    const reqModel = body.model || "gemma-7b-it";
    var chatId = body.chatId || 0;
    if (chatId === 0) {
        const q = db.prepare("INSERT INTO chats (name) VALUES ($name)");
        const names = db.transaction(names => {
            for (const name of names) {
                q.run({ '$name': name });
            }
        });
        names([body.message]);
        chatId = db.query("SELECT * FROM chats WHERE name = $name").get({ '$name': body.message }).id;
        const querMsg = db.prepare("INSERT INTO messages (chat_id, role, content) VALUES ($chat_id, $role, $content)");
        const messages = db.transaction(msgs => {
            for (const msg of msgs) {
                querMsg.run({ '$chat_id': chatId, '$role': "user", '$content': msg });
            }
        });
        messages([body.message]);
    } else {
        const querMsg = db.prepare("INSERT INTO messages (chat_id, role, content) VALUES ($chat_id, $role, $content)");
        const messages = db.transaction(msgs => {
            for (const msg of msgs) {
                querMsg.run({ '$chat_id': chatId, '$role': "user", '$content': msg });
            }
        });
        messages([body.message]);
    }
    const chatMessages = db.query("SELECT * FROM messages WHERE chat_id = $chat_id").all({ '$chat_id': chatId });
    const answer = await groq.chat.completions.create({
        model: reqModel.toString(),
        messages: chatMessages.map(msg => { return { role: msg.role, content: msg.content } }),
    });
    const message = answer.choices[0].message.content;
    const querMsg = db.prepare("INSERT INTO messages (chat_id, role, content) VALUES ($chat_id, $role, $content)");
    const messages = db.transaction(msgs => {
        for (const msg of msgs) {
            querMsg.run({ '$chat_id': chatId, '$role': "system", '$content': msg });
        }
    });
    messages([message]);
    return c.json({ message: message, chatId: chatId });
});

app.get("/chat/:chatId", async (c) => {
    const chatId = c.req.param('chatId');
    const chatMessages = db.query("SELECT * FROM messages WHERE chat_id = $chat_id order by created_at").all({ '$chat_id': chatId });
    return c.json(chatMessages);
});

function extractCode(text: string) {
    const regex = /`([^`]+)`/g;
    const matches = text.match(regex);
    if (!matches) {
        return [];
    }
    return matches.map(match => match.slice(1, -1));
}


export default app;