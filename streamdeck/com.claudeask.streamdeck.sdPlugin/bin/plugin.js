"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const render = require("./render.js");

const PROFILE_NAME = "Claude Ask";
const OPTION_UUID = "com.claudeask.streamdeck.option";
const QUESTION_UUID = "com.claudeask.streamdeck.question";
const CANCEL_UUID = "com.claudeask.streamdeck.cancel";
const CONTEXT_UUID = "com.claudeask.streamdeck.context";

const STATE_DIR = path.join(os.homedir(), ".claude-ask");
const QUESTION_FILE = path.join(STATE_DIR, "question.json");
const ANSWER_FILE = path.join(STATE_DIR, "answer.json");

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 2) {
  args[argv[i].replace(/^-+/, "")] = argv[i + 1];
}
const info = JSON.parse(args.info || "{}");

const contexts = new Map(); // context -> { uuid, slot }
const devices = new Map(); // deviceId -> device info
let question = null;
let questionShown = false;

function log(message) {
  send({ event: "logMessage", payload: { message: `[claude-ask] ${message}` } });
}

let ws = null;
function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function setImage(context, image) {
  send({ event: "setImage", context, payload: { image, target: 0 } });
}

// A 5x3 Stream Deck is the only layout the bundled profile targets.
function keypadDeviceId() {
  for (const [id, device] of devices) {
    const size = device.size || {};
    if (device.type === 0 || (size.columns === 5 && size.rows === 3)) return id;
  }
  return devices.keys().next().value;
}

function switchToAskProfile() {
  const device = keypadDeviceId();
  if (!device) return;
  send({
    event: "switchToProfile",
    context: args.pluginUUID,
    device,
    payload: { profile: PROFILE_NAME, page: 0 },
  });
}

// Omitting the profile name returns the deck to whatever profile was active before.
function switchToPreviousProfile() {
  const device = keypadDeviceId();
  if (!device) return;
  send({ event: "switchToProfile", context: args.pluginUUID, device, payload: {} });
}

function paint(context, entry) {
  if (entry.uuid === QUESTION_UUID) {
    setImage(context, question ? render.questionKey(question.header || "Question") : render.idleQuestionKey());
    return;
  }
  if (entry.uuid === CANCEL_UUID) {
    setImage(context, render.cancelKey());
    return;
  }
  if (entry.uuid === CONTEXT_UUID) {
    const label = question && question.context;
    setImage(context, label ? render.contextKey(label) : render.idleContextKey());
    return;
  }
  const option = question && question.options ? question.options[entry.slot] : null;
  setImage(context, option ? render.optionKey(entry.slot + 1, option.label) : render.emptyKey());
}

function paintAll() {
  for (const [context, entry] of contexts) paint(context, entry);
}

function writeAnswer(answer) {
  if (!question) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    ANSWER_FILE,
    JSON.stringify({ id: question.id, ...answer, answeredAt: new Date().toISOString() }, null, 2)
  );
  question = null;
  questionShown = false;
  paintAll();
  switchToPreviousProfile();
}

function readQuestion() {
  let next = null;
  try {
    const raw = fs.readFileSync(QUESTION_FILE, "utf8");
    if (raw.trim()) next = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") log(`cannot read question: ${err.message}`);
    next = null;
  }

  const currentId = question ? question.id : null;
  const nextId = next && next.id ? next.id : null;
  if (currentId === nextId) return;

  question = nextId ? next : null;
  paintAll();

  if (question && !questionShown) {
    questionShown = true;
    switchToAskProfile();
    log(`asking: ${question.header || question.question || ""}`);
  } else if (!question && questionShown) {
    // The question was withdrawn (timeout or cancel from the CLI side).
    questionShown = false;
    switchToPreviousProfile();
  }
}

function watchQuestionFile() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.watchFile(QUESTION_FILE, { interval: 200 }, readQuestion);
  readQuestion();
}

function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.event) {
    case "deviceDidConnect":
      devices.set(msg.device, msg.deviceInfo || {});
      break;
    case "deviceDidDisconnect":
      devices.delete(msg.device);
      break;
    case "willAppear": {
      const settings = (msg.payload && msg.payload.settings) || {};
      const coords = (msg.payload && msg.payload.coordinates) || {};
      const slot =
        typeof settings.slot === "number"
          ? settings.slot
          : Math.max(0, (coords.row - 1) * 5 + coords.column);
      contexts.set(msg.context, { uuid: msg.action, slot });
      paint(msg.context, contexts.get(msg.context));
      break;
    }
    case "willDisappear":
      contexts.delete(msg.context);
      break;
    case "keyDown": {
      const entry = contexts.get(msg.context);
      if (!entry || !question) break;
      if (entry.uuid === CANCEL_UUID) {
        writeAnswer({ cancelled: true });
      } else if (entry.uuid === OPTION_UUID) {
        const option = question.options && question.options[entry.slot];
        if (option) writeAnswer({ index: entry.slot, label: option.label, cancelled: false });
      }
      break;
    }
    default:
      break;
  }
}

for (const device of info.devices || []) devices.set(device.id, device);

ws = new WebSocket(`ws://127.0.0.1:${args.port}`);
ws.on("open", () => {
  send({ event: args.registerEvent, uuid: args.pluginUUID });
  log("registered");
  watchQuestionFile();
});
ws.on("message", onMessage);
ws.on("error", (err) => process.stderr.write(`claude-ask ws error: ${err.message}\n`));
ws.on("close", () => process.exit(0));
