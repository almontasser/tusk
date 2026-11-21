// Pull requests: line comment threads, editing your own comments, and the Markdown comment box with @ suggestions.
import { showError } from "./status";
import { mod } from "./platform.ts";
import { el, gh, host, markdown, myLogin, pages, type ReviewComment, type Thread, when } from "./prshared";

let assignable: { root: string; logins: Promise<string[]> } | undefined;

/**
 * Suggests people after "@" in a comment box: the participants of pull request `number` first, then everyone who
 * can be assigned in the repository. ↑ and ↓ choose, Enter or Tab inserts, and Escape closes the list.
 */
export function mentions(text: HTMLTextAreaElement, number: number) {
  if (assignable?.root !== host.root())
    assignable = { root: host.root(), logins: gh("api", "--paginate", "repos/{owner}/{repo}/assignees", "--jq", ".[].login").then((o) => o.split("\n").filter(Boolean), () => []) };
  const list = el("ul", "pr-mentions");
  list.role = "listbox";
  let matches: string[] = [];
  let index = 0;
  const close = () => (list.remove(), (matches = []));
  const query = () => text.value.slice(0, text.selectionStart).match(/(?:^|[\s(])@([\w-]*)$/)?.[1];
  const draw = () => {
    list.replaceChildren(
      ...matches.map((login, i) => {
        const li = el("li", i === index ? "selected" : "", login);
        li.role = "option";
        li.onmousedown = (e) => (e.preventDefault(), insert(login));
        return li;
      }),
    );
    const box = text.getBoundingClientRect();
    list.style.left = `${box.left}px`;
    list.style.top = `${box.bottom + 2}px`;
    if (!list.isConnected) document.body.append(list);
  };
  const insert = (login: string) => {
    const q = query() ?? "";
    const at = text.selectionStart;
    text.setRangeText(`${login} `, at - q.length, at, "end");
    text.dispatchEvent(new Event("input"));
    close();
  };
  text.addEventListener("input", async () => {
    const q = query();
    if (q === undefined) return close();
    const all = [...new Set([...(pages.get(number)?.participants ?? []), ...(await assignable!.logins)])].filter((l) => l !== myLogin);
    if (query() !== q) return; // You typed on while the list loaded.
    matches = all.filter((l) => l.toLowerCase().startsWith(q.toLowerCase())).slice(0, 8);
    index = 0;
    if (!matches.length) return close();
    draw();
  });
  text.addEventListener(
    "keydown",
    (e) => {
      if (!matches.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") index = (index + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length, draw();
      else if (e.key === "Enter" || e.key === "Tab") insert(matches[index]);
      else if (e.key === "Escape") close();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  text.addEventListener("blur", close);
  return text;
}

/** A Markdown text box with Write and Preview tabs, which renders the text as it will show on GitHub. */
export function writer(text: HTMLTextAreaElement, repo: string, number: number) {
  const box = el("div", "pr-writer");
  const tabs = el("div", "pr-writer-tabs");
  const preview = el("div", "pr-writer-preview");
  preview.hidden = true;
  const tab = (label: string, previewing: boolean) => {
    const b = el("button", "", label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(!previewing));
    b.onclick = () => {
      tabs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      if (previewing) preview.replaceChildren(markdown(text.value.trim() || "_Nothing to preview._", repo));
      preview.style.minHeight = `${text.offsetHeight}px`;
      text.hidden = previewing;
      preview.hidden = !previewing;
      if (!previewing) text.focus();
    };
    tabs.append(b);
  };
  tab("Write", false);
  tab("Preview", true);
  tabs.lastElementChild!.setAttribute("aria-pressed", "false");
  box.append(tabs, mentions(text, number), preview);
  return box;
}

/**
 * The pull request's line comments, grouped into threads. GitHub points every reply at the thread's first comment.
 * Whether a thread is resolved is only in GraphQL, keyed there by the first comment's ID.
 */
export async function lineComments(number: number): Promise<Thread[]> {
  const jq = ".[] | {id, path, line, start_line, side, body, user: .user.login, in_reply_to_id, created_at, diff_hunk}";
  const [out, states] = await Promise.all([
    gh("api", "--paginate", `repos/{owner}/{repo}/pulls/${number}/comments`, "--jq", jq),
    threadStates(number).catch(() => new Map<number, { id: string; resolved: boolean }>()),
  ]);
  const comments: ReviewComment[] = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const threads = new Map<number, Thread>();
  for (const c of comments) if (!c.in_reply_to_id) threads.set(c.id, { ...c, comments: [c], node: states.get(c.id)?.id, resolved: states.get(c.id)?.resolved });
  for (const c of comments) if (c.in_reply_to_id) threads.get(c.in_reply_to_id)?.comments.push(c);
  return [...threads.values()];
}

// gh's --paginate follows $endCursor through every page of threads.
const THREADS = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $endCursor) { nodes { id isResolved comments(first: 1) { nodes { databaseId } } } pageInfo { hasNextPage endCursor } } } }
}`;

/** Each thread's GraphQL ID and whether it's resolved, by the REST ID of its first comment. */
async function threadStates(number: number) {
  const jq = ".data.repository.pullRequest.reviewThreads.nodes[] | {id, resolved: .isResolved, first: .comments.nodes[0].databaseId}";
  const out = await gh("api", "graphql", "--paginate", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${number}`, "-f", `query=${THREADS}`, "--jq", jq);
  const lines: { id: string; resolved: boolean; first: number }[] = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return new Map(lines.map((t) => [t.first, { id: t.id, resolved: t.resolved }]));
}

/** The comment being edited, and the one whose delete waits for a second click, by their targets' keys. */
let editing = "";
let deleting = "";

/** How to change a comment on GitHub: `key` names it, and a review's summary has no `remove`, since GitHub keeps it. */
export type Target = { key: string; save(body: string): Promise<unknown>; remove?(): Promise<unknown> };
export const restTarget = (api: string): Target => ({ key: api, save: (body) => gh("api", "--method", "PATCH", "-f", `body=${body}`, api), remove: () => gh("api", "--method", "DELETE", api) });
export const reviewTarget = (id: string): Target => ({
  key: id,
  save: (body) => gh("api", "graphql", "-f", "query=mutation($id: ID!, $body: String!) { updatePullRequestReview(input: { pullRequestReviewId: $id, body: $body }) { clientMutationId } }", "-f", `id=${id}`, "-f", `body=${body}`),
});

/**
 * A comment on pull request `number`: its author and text, with Edit and Delete when it's yours. `target` changes it
 * on GitHub. `redraw` draws it again after you start or cancel an edit, and `reload` fetches everything after GitHub changed it.
 */
export function commentBlock(number: number, user: string, body: string, target: Target, repo: string, redraw: () => void, reload: () => unknown, at?: string, label = ""): HTMLElement[] {
  const meta = el("div", "pr-meta", `${user}${label ? ` · ${label}` : ""}`);
  const api = target.key;
  if (at) meta.append(when(at));
  if (!myLogin || user !== myLogin) return [meta, markdown(body, repo)];
  const link = (label: string, run: () => unknown) => {
    const b = el("button", "link", label);
    b.onclick = run;
    meta.append(" · ", b);
  };
  const change = async (request: () => Promise<unknown>, what: string) => {
    try {
      await request();
      editing = deleting = "";
      await reload();
    } catch (e) {
      showError(`Can't ${what} the comment`, e);
    }
  };
  if (editing === api) {
    const box = el("div", "pr-comment-form");
    const text = mentions(el("textarea"), number);
    text.rows = 4;
    text.value = body;
    const buttons = el("div", "pr-actions");
    const save = el("button", "primary", "Save");
    save.onclick = () => text.value.trim() && change(() => target.save(text.value.trim()), "edit");
    const cancel = el("button", "", "Cancel");
    cancel.onclick = () => ((editing = ""), redraw());
    text.onkeydown = (e) => {
      if (e.key === "Enter" && mod(e)) save.click();
      if (e.key === "Escape") cancel.click();
    };
    buttons.append(save, cancel);
    box.append(text, buttons);
    requestAnimationFrame(() => text.focus());
    return [meta, box];
  }
  if (deleting === api) {
    meta.append(" · Delete this comment on GitHub?");
    link("Delete", () => change(target.remove!, "delete"));
    link("Cancel", () => ((deleting = ""), redraw()));
  } else {
    link("Edit", () => ((editing = api), (deleting = ""), redraw()));
    if (target.remove) link("Delete", () => ((deleting = api), (editing = ""), redraw()));
  }
  return [meta, markdown(body, repo)];
}

/** Resolved threads you opened with Show, by thread ID. */
export const expanded = new Set<number>();
