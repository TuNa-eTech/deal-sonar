import { NATIVE_HOST, PROTOCOL_VERSION, type Request, type Response } from "../protocol";

function send(req: Request): Promise<Response> {
  return chrome.runtime.sendNativeMessage(NATIVE_HOST, req);
}

// Popup (and later content scripts) ask the background worker to reach the desktop app.
chrome.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
  send(msg)
    .then(sendResponse)
    .catch((e: unknown) => sendResponse({ type: "error", message: String(e) } satisfies Response));
  return true; // async response
});

console.log("DealSonar background ready, protocol v" + PROTOCOL_VERSION);
