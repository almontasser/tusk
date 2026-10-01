// A live preview of a Markdown file, as an editor tab. It renders as you type and scrolls with the editor.
import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import * as monaco from "monaco-editor";
import { resolveLink } from "./links";
import { markdownBlocks, previewScrollTop } from "./markdown";
import { closeView, showEditorView } from "./terminal";

type Preview = { el: HTMLElement; sync(ed: monaco.editor.ICodeEditor): void; close(): void };
/** Open previews, by their model's URI. */
const previews = new Map<string, Preview>();
const openUrl = (url: string) => invoke("open_url", { url: url });

// Each editor showing a previewed file scrolls its preview. Editors are hooked once, as they're created.
const hooked = new WeakSet<monaco.editor.ICodeEditor>();
const hook = (ed: monaco.editor.ICodeEditor) => {
  if (hooked.has(ed)) return;
  hooked.add(ed);
  ed.onDidScrollChange((e) => e.scrollTopChanged && previews.get(ed.getModel()?.uri.toString() ?? "")?.sync(ed));
};
let hooking = false;

export const hasMarkdownPreview = (model: monaco.editor.ITextModel) => previews.has(model.uri.toString());

/** Shows a Markdown model's preview as an editor tab in the focused pane, or where it already is. */
export function showMarkdownPreview(model: monaco.editor.ITextModel, host: { openFile(path: string): void }) {
  if (!hooking) (hooking = true), monaco.editor.getEditors().forEach(hook), monaco.editor.onDidCreateEditor(hook);
  const key = model.uri.toString();
  const path = model.uri.path;
  const name = path.slice(path.lastIndexOf("/") + 1);
  let preview = previews.get(key);
  if (!preview) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const el = document.createElement("div");
    el.className = "markdown-preview";
    const body = document.createElement("div");
    body.className = "markdown";
    el.append(body);
    // ponytail: images are read once per preview, so an image changed on disk shows after you reopen the preview.
    const images = new Map<string, Promise<string>>();
    let last: monaco.editor.ICodeEditor | undefined;
    const sync = (ed: monaco.editor.ICodeEditor) => {
      last = ed;
      if (!el.offsetParent) return;
      const blocks = [...body.children].map((b) => ({ line: Number((b as HTMLElement).dataset.line), top: (b as HTMLElement).offsetTop }));
      blocks.push({ line: model.getLineCount(), top: el.scrollHeight - el.clientHeight });
      el.scrollTop = previewScrollTop(blocks, (ed.getVisibleRanges()[0]?.startLineNumber ?? 1) - 1);
    };
    // The file is yours, but a README can come from anywhere, and this page can call the app's commands.
    const render = () => {
      const fragment = DOMPurify.sanitize(markdownBlocks(model.getValue()), {
        FORBID_TAGS: ["style", "form", "button", "iframe", "map", "area"],
        FORBID_ATTR: ["style"],
        RETURN_DOM_FRAGMENT: true,
      });
      // Images in the project load from disk, before the page could ask the dev server for them.
      for (const img of fragment.querySelectorAll("img")) {
        const file = resolveLink(dir, img.getAttribute("src") ?? "");
        if (!file) continue;
        img.removeAttribute("src");
        if (!images.has(file)) {
          const type = file.endsWith(".svg") ? "image/svg+xml" : "";
          images.set(file, invoke<ArrayBuffer>("read_file_bytes", { path: file }).then((b) => URL.createObjectURL(new Blob([b], { type })), () => ""));
        }
        images.get(file)!.then((url) => url && (img.src = url));
      }
      body.replaceChildren(fragment);
      if (last?.getModel() === model) sync(last);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changes = model.onDidChangeContent(() => (clearTimeout(timer), (timer = setTimeout(render, 150))));
    const disposed = model.onWillDispose(() => closeView(el));
    // Links to files open them in the editor, and other links in the browser, never in the app's window.
    body.onclick = (e) => {
      const link = (e.target as Element).closest("a[href]");
      if (!link) return;
      e.preventDefault();
      const href = link.getAttribute("href")!;
      const file = resolveLink(dir, href);
      if (file) host.openFile(file);
      else if (/^(https?|mailto):/i.test(href)) openUrl(href);
    };
    preview = {
      el,
      sync,
      close() {
        clearTimeout(timer);
        changes.dispose();
        disposed.dispose();
        images.forEach((p) => p.then((url) => url && URL.revokeObjectURL(url)));
        previews.delete(key);
        el.remove();
      },
    };
    previews.set(key, preview);
    render();
  }
  showEditorView(`${name} (preview)`, preview.el, "open-preview", preview.close);
}
