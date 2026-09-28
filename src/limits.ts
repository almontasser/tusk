// Limits you can tune in Settings: how much Tusk keeps and shows. Each module reads `limits` when it needs a value,
// so a change applies the next time.
import { registerSettings } from "./settings";

export const limits = registerSettings(
  "Limits",
  { recentProjects: 12, searchMatches: 20_000, httpHistory: 100, httpShownMB: 5 },
  [
    { key: "recentProjects", label: "Recent projects to remember", type: "number", min: 1, max: 100 },
    { key: "searchMatches", label: "Most matches for Find in Files and TODO", type: "number", min: 100, max: 1_000_000, help: "Replace All still changes every matching file." },
    { key: "httpHistory", label: "HTTP requests to keep in the history", type: "number", min: 10, max: 5000, help: "Per project, besides pinned requests." },
    { key: "httpShownMB", label: "Largest HTTP response to show, in MB", type: "number", min: 1, max: 200, help: "A larger body opens in an editor tab instead." },
  ],
);

export const localHistory = registerSettings(
  "Local History",
  { localHistoryDays: 14, localHistoryVersions: 100, localHistoryMaxKB: 1000 },
  [
    { key: "localHistoryDays", label: "Days to keep versions", type: "number", min: 1, max: 365 },
    { key: "localHistoryVersions", label: "Versions to keep per file", type: "number", min: 1, max: 1000 },
    { key: "localHistoryMaxKB", label: "Largest file to keep, in KB", type: "number", min: 10, max: 100_000, help: "Larger files get no local history." },
  ],
);
