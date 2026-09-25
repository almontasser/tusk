// Parses a profile off the main thread, so a large one doesn't freeze the window. The result's functions refer to
// each other as callers and callees; structured cloning keeps those references.
import { parseCachegrind } from "./cachegrind";

self.onmessage = (e: MessageEvent<string>) => self.postMessage(parseCachegrind(e.data));
