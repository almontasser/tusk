// Pull requests: what the other pr*.ts modules share. The types, the `gh` runner, Markdown, and small DOM helpers.
import { invoke } from "@tauri-apps/api/core";
import { age, type Check } from "./gitparse";

type Author = { login: string };
export type PullRequest = {
  number: number;
  title: string;
  author: Author;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  reviewDecision: string;
  statusCheckRollup: Check[] | null;
  url: string;
};
type Label = { name: string; color: string };
/** A row of the list, with more than the status bar's lookup needs. */
export type ListedPullRequest = PullRequest & { state: string; labels: Label[]; updatedAt: string; additions: number; deletions: number; reviewRequests: { login?: string; name?: string; slug?: string }[] };
export type Details = ListedPullRequest & {
  id: string;
  body: string;
  headRefOid: string;
  files: { path: string; additions: number; deletions: number }[];
  createdAt: string;
  comments: { author: Author; body: string; url: string; createdAt: string }[];
  reviews: { id: string; author: Author; state: string; body: string; submittedAt: string; commit?: { oid: string } }[];
  latestReviews: { author: Author; state: string }[];
  reviewRequests: { login?: string; name?: string; slug?: string }[];
  commits: { oid: string; messageHeadline: string; committedDate: string; authors: { login: string; name: string }[] }[];
  mergeable: string;
  mergeStateStatus: string;
  autoMergeRequest: { mergeMethod: string } | null;
  assignees: { login: string }[];
  milestone: { title: string } | null;
  closingIssuesReferences: { number: number; url: string; repository: { name: string; owner: { login: string } } }[];
};

/** A comment on a line of the diff. `line` is null when the code it was on has changed since. */
export type ReviewComment = { id: number; path: string; line: number | null; start_line: number | null; side: "LEFT" | "RIGHT"; body: string; user: string; in_reply_to_id: number | null; created_at: string; diff_hunk?: string };
/** A line comment and its replies. `node` is the thread's GraphQL ID, for resolving it. */
export type Thread = ReviewComment & { comments: ReviewComment[]; node?: string; resolved?: boolean };

export type Host = {
  root(): string;
  status(text: string): void;
  showView(name: "prs"): void;
  openAt(path: string, line: number): unknown;
  /** Replaces lines of a file in its editor, if they still read `expected`. False when they don't. */
  replaceLines(path: string, start: number, end: number, expected: string, text: string): Promise<boolean>;
};

export const $ = (id: string) => document.getElementById(id)!;
export const FIELDS = "number,title,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,url";
export const LIST_FIELDS = `${FIELDS},state,labels,updatedAt,additions,deletions,reviewRequests`;
export const DETAIL_FIELDS = `${LIST_FIELDS},id,body,headRefOid,files,comments,reviews,createdAt,latestReviews,reviewRequests,commits,mergeable,mergeStateStatus,autoMergeRequest,assignees,milestone,closingIssuesReferences`;
export const icons = { passed: "✓", failed: "✗", pending: "●", skipped: "–", none: "" };
export const reviews: Record<string, string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" };
export let host: Host;
export const setHost = (h: Host) => (host = h);

export const gh = (...args: string[]) => invoke<string>("run_capture", { cwd: host.root(), program: "gh", args, input: null });
export const openUrl = (url: string) => invoke("open_url", { url: url });

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

// The Markdown parser and sanitizer load with the first pull request you open, not with the app.
let markdownLibraries: { marked: typeof import("marked").marked; DOMPurify: typeof import("dompurify").default } | undefined;
export async function loadMarkdown() {
  if (markdownLibraries) return;
  const [{ marked }, { default: DOMPurify }] = await Promise.all([import("marked"), import("dompurify")]);
  markdownLibraries = { marked, DOMPurify };
}

/**
 * Renders GitHub Markdown. Pull request text comes from other people, and this page can call the app's
 * commands, so the HTML is sanitized, and links open in the browser instead of the app. `#123` and `@name`
 * become links to the repository's issue or pull request and to the person's profile, as on GitHub.
 */
export function markdown(text: string, repo: string): HTMLElement {
  const { marked, DOMPurify } = markdownLibraries!;
  const div = el("div", "pr-body markdown");
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  // <map> and <area> make links out of images, which the handler below wouldn't see as <a>.
  div.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "button", "iframe", "map", "area"], FORBID_ATTR: ["style"] });
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest("a, code, pre")) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    const parts = node.data.split(/(?<![\w/&#])(#\d+|@[A-Za-z0-9](?:-?[A-Za-z0-9])*)\b/);
    if (parts.length === 1) continue;
    node.replaceWith(
      ...parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const a = el("a", "", part);
        a.href = part.startsWith("#") ? `${repo}/issues/${part.slice(1)}` : `https://github.com/${part.slice(1)}`;
        return a;
      }),
    );
  }
  // Every click on a link opens it in the browser, never in the app's window.
  div.onclick = (e) => {
    const link = (e.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    e.preventDefault();
    if (/^https?:/.test(link.href)) openUrl(link.href);
  };
  return div;
}

export const icon = (name: string, className = "") => el("span", `codicon codicon-${name}${className ? ` ${className}` : ""}`);
const checkIcons: Record<string, string> = { passed: "pass-filled", failed: "error", pending: "loading codicon-modifier-spin", skipped: "circle-slash", none: "circle-outline" };
/** A check state's icon, colored by state. */
export const checkIcon = (state: string) => icon(checkIcons[state], `checks-${state}`);

/** The pull request's state as GitHub shows it: Open, Draft, Merged, or Closed, with its icon and color. */
export function statePill(pr: { state: string; isDraft: boolean }) {
  const [label, name, kind] =
    pr.state === "MERGED" ? ["Merged", "git-merge", "merged"] : pr.state === "CLOSED" ? ["Closed", "git-pull-request-closed", "closed"] : pr.isDraft ? ["Draft", "git-pull-request-draft", "draft"] : ["Open", "git-pull-request", "open"];
  const pill = el("span", `pr-state ${kind}`);
  pill.append(icon(name), label);
  return pill;
}

/** A person's GitHub avatar, from the pull request's own host, or their initial when it doesn't load. */
export function avatar(login: string, repo: string, size = 20) {
  const box = el("span", "pr-avatar", login.slice(0, 1).toUpperCase());
  box.style.setProperty("--size", `${size}px`);
  const img = el("img");
  img.alt = "";
  img.onload = () => box.classList.add("loaded");
  img.onerror = () => img.remove();
  img.src = `${new URL(repo).origin}/${encodeURIComponent(login.replace(/\[bot\]$/, ""))}.png?size=${size * 2}`;
  box.append(img);
  return box;
}

/** Labels as colored chips, in GitHub's colors. */
export function labelRow(labels: Label[]) {
  const row = el("div", "pr-labels");
  row.append(...labels.map(labelChip));
  return row;
}

export function labelChip(l: Label) {
  const chip = el("span", "pr-label", l.name);
  chip.style.setProperty("--label", `#${l.color}`);
  return chip;
}

/**
 * A path for a right-to-left box, which puts the ellipsis of a long path at its start. The left-to-right mark in
 * front keeps the path's own order, so `.env.example` doesn't show as `env.example.`.
 */
export const ltr = (path: string) => `\u200E${path}`;

/** " · 3h ago", with the full date and time on hover. */
export function when(at: string) {
  const time = Date.parse(at);
  const span = el("span", "pr-when", Number.isNaN(time) ? "" : ` · ${age(time / 1000) === "now" ? "just now" : `${age(time / 1000)} ago`}`);
  if (!Number.isNaN(time)) span.title = new Date(time).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  return span;
}

export const repoUrl = (pr: PullRequest) => pr.url.replace(/\/pull\/\d+$/, "");

/** Your GitHub login, so your own comments get Edit and Delete. Empty when `gh` can't tell. */
export let myLogin = "";
let loginLookup: Promise<unknown> | undefined;
export const me = () => (loginLookup ??= gh("api", "user", "--jq", ".login").then((l) => (myLogin = l.trim()), () => (loginLookup = undefined)));

export type Section = "conversation" | "commits" | "checks" | "files";
/**
 * A pull request open in its own editor tab. `el` is the tab's element, made when the tab opens and removed when
 * it closes. `section` is the section it shows, `participants` the people in it (author, reviewers, commenters),
 * suggested first after "@", and `viewed` its files' Viewed states, shared with its diff's Viewed checkbox.
 */
export type Page = { el: HTMLElement; section: Section; participants: string[]; viewed?: Map<string, boolean> };
/**
 * The pull requests open in editor tabs, by number. A project switch closes them all, so numbers from two
 * projects never mix here.
 */
export const pages = new Map<number, Page>();

/**
 * The page's functions that lower modules call, so modules don't import each other in a cycle. prs.ts sets them
 * at startup.
 */
export const hub = {
  showPullRequest: undefined as unknown as (number: number, title?: string) => unknown,
  renderPullRequest: undefined as unknown as (number: number) => Promise<void>,
  threadsChanged: undefined as unknown as (number: number) => Promise<void>,
};
