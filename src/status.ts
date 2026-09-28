// How the app tells you what's happening: status bar messages, errors, and progress for long tasks.
//
//   status(text, source?, kind?)   A status bar message. Sources ending in ":progress" show a spinner until
//                                  cleared; others clear after 8 seconds. kind "error" also shows a toast.
//   showError(message, error?)     A failure: a toast, the status bar, and the console. `error` adds its text.
//   errorText(error)               An error's readable text, from an Error, a Tauri command's string, or anything.
//   withProgress(label, task, o?)  Runs `task` with a spinner and `label` in the status bar, and shows a failure
//                                  as an error. With `cancellable`, the status bar shows a Cancel button, which
//                                  aborts the AbortSignal the task gets, and progress(label) updates the label. Resolves to the task's result, or
//                                  undefined when it failed or was canceled.
//   installErrorHandlers()         Shows unhandled promise rejections and errors as toasts, once per message.
import { toast } from "./dom.ts";

const statuses = new Map<string, string>();
const statusTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** The tasks you can cancel, by their status source. */
const cancels = new Map<string, AbortController>();
const $ = (id: string) => document.getElementById(id);

/**
 * Shows a status message. The status bar shows the most recent message that is still set, so one language server
 * finishing a task doesn't clear another's progress. Sources ending in ":progress" are background work and show a
 * spinner until cleared; other messages clear themselves after 8 seconds. `kind` "error" also shows the message as
 * a toast, and "info" never does. Without a kind, a message that reads like a failure ("failed", "can't") toasts,
 * for callers that predate `kind`.
 */
export function status(text: string, source = "app", kind?: "error" | "info") {
  statuses.delete(source);
  if (text) statuses.set(source, text);
  clearTimeout(statusTimers.get(source));
  if (text && !source.endsWith(":progress")) statusTimers.set(source, setTimeout(() => status("", source), 8000));
  const [latestSource, latest] = [...statuses].at(-1) ?? ["", ""];
  const el = $("lsp-status");
  if (el) {
    el.textContent = latest;
    el.classList.toggle("busy", latestSource.endsWith(":progress"));
  }
  const cancel = $("status-cancel");
  if (cancel) {
    cancel.hidden = !cancels.has(latestSource);
    cancel.onclick = () => cancels.get(latestSource)?.abort();
    cancel.title = `Cancel: ${latest}`;
  }
  if (kind === "error" || (!kind && /\b(failed|error|fatal|can't|couldn't|invalid)\b/i.test(text))) toast(text);
}

/**
 * An error's text for a message: an Error's message, or a Tauri command's error string, trimmed, without Git's
 * "hint:" lines or a leading "Error:", on one line, and at most 400 characters.
 */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
  const text = raw
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("hint:"))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^(Uncaught )?(Error|TypeError|RangeError):\s*/, "")
    .trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text || "unknown error";
}

/**
 * Shows a failure: a toast, the status bar, and the console, with the error's text after `message`, such as
 * showError("Can't merge #12", e) for "Can't merge #12: …". The toast can offer an action, such as Retry.
 */
export function showError(message: string, error?: unknown, action?: { label: string; run(): unknown }) {
  const text = error === undefined ? message : `${message}: ${errorText(error)}`;
  if (error !== undefined) console.error(message, error);
  status(text, "app", "info");
  toast(text, { action });
}

let tasks = 0;

/**
 * Runs a task with a spinner and `label`, such as "Merging #12…", in the status bar. A failure shows as an error,
 * starting with `error` (by default "<label> failed"). With `cancellable`, the status bar shows a Cancel button that
 * aborts the task's signal; the task stops when it sees `signal.aborted`, or passes the signal on, such as to fetch.
 * Resolves to the task's result, or undefined when it failed or was canceled. The task can call `progress` with a
 * new label, such as "Deleted 500 of 2,000 keys…", which keeps the spinner and Cancel.
 */
export async function withProgress<T>(
  label: string,
  task: (signal: AbortSignal, progress: (label: string) => void) => Promise<T>,
  options: { cancellable?: boolean; error?: string } = {},
): Promise<T | undefined> {
  const source = `task${++tasks}:progress`;
  const controller = new AbortController();
  if (options.cancellable) cancels.set(source, controller);
  status(label, source);
  try {
    return await task(controller.signal, (text) => status(text, source));
  } catch (e) {
    if (controller.signal.aborted) status(`Canceled: ${label.replace(/…$/, "")}`, "app", "info");
    else showError(options.error ?? `${label.replace(/…$/, "")} failed`, e);
    return undefined;
  } finally {
    cancels.delete(source);
    status("", source);
  }
}

/** Errors that aren't failures you need to hear about: Monaco's canceled requests, aborts, and layout noise. */
const noise = (text: string, error: unknown) =>
  (error instanceof Error && (error.name === "Canceled" || error.name === "AbortError")) ||
  /^(Canceled|ResizeObserver loop|Script error\.?$)/.test(text);

/**
 * Shows unhandled promise rejections, such as an `await invoke(...)` without a catch, and uncaught errors as toasts,
 * so no failure is silent. The same message shows once while its toast is up.
 */
export function installErrorHandlers() {
  const report = (error: unknown) => {
    const text = errorText(error);
    if (noise(text, error)) return;
    console.error("Unhandled:", error);
    toast(`Something went wrong: ${text}`);
  };
  addEventListener("unhandledrejection", (e) => report(e.reason));
  addEventListener("error", (e) => report(e.error ?? e.message));
}
