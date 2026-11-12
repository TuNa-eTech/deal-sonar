import { PROTOCOL_VERSION, type Request, type Response } from "../protocol";

const out = document.getElementById("out")!;

document.getElementById("ping")!.addEventListener("click", async () => {
  const req: Request = { type: "ping", version: PROTOCOL_VERSION };
  const res: Response = await chrome.runtime.sendMessage(req);
  out.textContent = JSON.stringify(res, null, 2);
});
