# Git and pull requests

## Git

The **Commit** tab in the sidebar lists merge conflicts, staged changes, and
unstaged changes, including new files, as a tree. Click a file, or press ⏎, to
see its diff; F4 opens the file. Click a group to collapse it. The folder
button in the header groups files by folder. Select several files with ⌘-click
or ⇧-click, or ⇧↑ and ⇧↓, and ⌘A selects every file. Then act on all of them:
Space stages or unstages, ⌥⌘Z rolls back, and right-click (or ⇧F10) shows every
action. Hover over a file for buttons to open, stage, unstage, or roll it back.
**Rollback** asks first: a staged file goes back to the last commit, an
unstaged one to its staged version, and a new file goes to the Trash.

The message box sits at the bottom of the view, and stays in view while a long
list of changes scrolls. Write a message and press ⌘⏎ or click **Commit**. The
buttons are off while the commit runs, and when there's nothing to commit (no
changes, no amend, and no merge to conclude), and the status bar shows progress while
git hooks run. If a hook or git refuses the commit, the message offers **Show
Details** with the full output. **Commit and Push** opens the Push dialog after
committing. With nothing staged, **Commit** offers to stage all the changes and
commit them.

If the folder isn't a git repository, the Commit view says so and offers
**Initialize Repository** (also in the **Git** menu). If git isn't installed,
or can't read the folder, it says that instead, with **Try Again**.

### Push, update, and fetch

**Push…** (⌘⇧K) opens the Push dialog: the commits that will go, the remote
and branch to push to, and **Force push (with lease)**, which overwrites the
remote branch unless someone pushed to it since you last fetched. The first
push of a branch sets its upstream branch. Press ⌘⏎ or click **Push**.

**Update Project** (⌘T) pulls the upstream branch, merging by default; the
**Git** settings can make it rebase, or follow git's `pull.rebase`. Local
changes are stashed and restored around it.

Push, update, and fetch run in the background with progress and **Cancel** in
the status bar, and say what happened, such as "Pushed 3 commits to
origin/main." When they can't finish, the message says why and offers the next
step:

- The remote has commits you don't: **Update and Push** updates, then pushes.
- The update stopped for conflicts: **Resolve** opens the merge tool.
- Git couldn't log in, such as after a canceled or wrong password: **Run in
  Terminal** runs the command in a terminal tab.

When git or ssh needs a password, a username, or a key's passphrase, or asks
you to trust a new host's key, Tusk asks in a dialog. The answer goes straight
to git and isn't kept; to save it, use git's credential helper or your SSH
agent.

To stage part of a file, open its diff from **Changes** and click **Stage
Selected**:

- Click in a change (without selecting) to stage the whole change.
- Select lines to stage only those. On the right, select new or changed lines;
  on the left, select removed lines. A changed line pairs with its new version,
  so selecting the new line stages the replacement.

The rest stays unstaged. In a diff from **Staged**, the button is **Unstage
Selected**, and works the same way.

Three toggles in every diff's header change how it looks: **Inline** shows both
versions in one column, **Ignore whitespace** hides changes to whitespace at the
start and end of lines (on by default), and **Collapse unchanged regions** folds
the lines between changes. Tusk remembers your choice for every diff: changes,
commits, stashes, branches, and pull requests. With whitespace ignored, Stage
Selected doesn't see whitespace-only changes, so they stay unstaged.

The diff of a PNG, JPEG, GIF, SVG, or WebP file shows the old and new pictures
side by side, with their sizes, in place of text. Stash diffs show images as
text.

The editor marks lines that differ from the last commit in the gutter: green
for added lines, blue for changed lines, and a gray triangle where lines were
deleted. The markers update as you type. Click a marker to see the lines as
they are at HEAD in a box below the change. Its buttons move to the previous
or next change, stage the change, or roll it back. Press Esc to close it.
Right-click a changed line for **Show Change**, **Rollback Change**, and
**Stage Change**. Staging a change adds only that change to the index.
**Next Change** (⌃⌥⇧↓) and **Previous Change** (⌃⌥⇧↑) move the cursor between
changes. The line with the cursor shows who
last changed it, when, and the commit message. To show the commit, age, and
author of every line in place of line numbers, run **Annotate with Git Blame**
from ⌘⇧A. Run it again to hide them.

Clicking an annotation shows its commit in a popup: the message, author,
date, and changed files, with **Show in Git Log**, **Show Diff**, and **Copy
Hash**. Click a file in the popup for its diff in that commit. Right-click an
annotation for the same actions.

Press ⌘9 for the **Git Log** in the bottom panel: the commits of the current
branch, with branch and tag labels and a graph of branches and merges. The
header's filters search through git, not just the loaded commits: type in the
search box to find commits by message or hash, choose a branch or **All
branches**, and filter by author or by path. When nothing matches, the log
says so, with **Clear filters**. The log loads 300 commits at a time; **Load
More** at the end loads more. The graph shows when no filter is set.

Use ↑ and ↓ to move through the commits; the details follow the selection.
Press ⏎ for the commit's diff, → to move to its changed files, and ⌘C to copy
its hash. In the details, click a file, or press ⏎ on it, to see its diff
against the previous commit, and move to the commit's other files with the
arrows in the diff's header. From a commit, you can show its diff, copy its
hash, check it out, create a branch at it, cherry-pick it onto the current
branch, or revert it. To see the commits that changed one file, run **Show File
History**, or right-click the file in the tree and choose **Show History**. File
history follows renames.

### Local history

Each time you save a file, the editor keeps a copy of it, outside the project
and outside git. It also keeps one before another program, such as a
`git checkout`, changes a file you have open, and after another program
changes a project file you don't have open, such as a file an Artisan `make:`
command or a formatter rewrites. The first time that happens to a file, the
version git has staged is kept too, so you can go back to it. Refactorings keep
the text before and after, and deleting a file or folder from the tree keeps
it first. Files git ignores, and `.env` files, aren't kept. Versions older than
14 days are deleted, and each file keeps at most 100. Files over 1,000 KB aren't
kept. **Settings > Local History** changes all three.

To see a file's history, choose **File › Local History › Show Local History**,
right-click the file's tab or the file in the tree, or run it from ⌘⇧A. For a
folder, right-click it in the tree; **Show Project Local History** covers the
whole project, deleted files included. The **Local History** tab opens in the
bottom panel:

- The left side lists the versions, newest first, with the time and what kept
  each one: **Saved**, **External change**, a git command such as
  **Before git checkout**, **Before refactoring** and **Refactoring**,
  **Before delete**, or **Before revert**. A folder's list also shows each
  file, marks deleted files, and has a filter.
- The right side compares the selected version with the file as it is now,
  including unsaved edits. To compare two versions, press Space or ⌘-click one
  to mark it, then select the other.
- **Revert** (⌘⌫ in the list) sets the file back to the selected version,
  after asking. The current text is kept as a version first, and **Undo** in
  the message puts it back. With the file open, ⌘Z in the editor undoes it
  too.
- **Put Label…** (also in the File menu and ⌘⇧A) names the current moment for
  the whole project, such as "Before the upgrade". Labels show among the
  versions; select one and click **Revert** to set the file, or in a folder's
  history every file under it, back to how it was then.
- ↑ and ↓ move through the list, Enter opens the file, and typing jumps to a
  version by what kept it (in a folder, by path).

To get back a deleted file, run **Local History: Deleted Files…** from ⌘⇧A and
choose the file, or find it in a folder's history, then **Revert** to a
version. Its folder is recreated if needed.

### Interactive rebase

To rewrite recent commits, open a commit in the Git Log and choose
**Interactive Rebase from Here…**, or run **Interactive Rebase…** from ⌘⇧A and
choose the commit to rebase onto. The commits after it are listed, oldest
first. For each, choose **Pick**, **Reword** (and edit its message), **Edit**
(stop at it to change its files), **Squash into previous**, **Fixup** (squash
and discard its message), or **Drop**. Reorder them by dragging, with the
arrows, or with ⌥↑ and ⌥↓. As in git's own list, P, R, E, S, F, and D set the
selected commit's action.
If the commits include merges, the merges are kept: the list also shows git's
**Label**, **Reset**, and **Merge** steps, which rebuild each merged branch and
merge it again, and they stay where they are.
**Start Rebase** runs `git rebase -i` in a terminal tab; uncommitted changes
are stashed and restored. If a commit conflicts, resolve it, then click
**Continue** in the Commit view. At an **Edit** commit, the rebase stops and
the Commit view says so: change files, stage what belongs in the commit, and
click **Continue**. The staged changes are added to that commit. To split the
commit into several instead, click **Split Commit**: the commit is undone and
its changes are left unstaged, with its message in the message box. Stage part
of them, even single lines from the diff, commit, and repeat, then click
**Continue**.

### Stash

Run **Stash Changes…** (from ⌘⇧A, the **Git** menu, or the **+** in the
**Stashes** tab) to set your uncommitted changes aside. The dialog takes an
optional message, and has two options: **Keep staged changes** leaves what you
staged in place, and **Include untracked files** stashes new files too.

The **Stashes** tab of the Commit tool window (or **Stashes…** from ⌘⇧A) lists
your stashes, newest first, with the branch each was made on and its age.
Click a stash, or press →, to list its changed files, and click a file, or
press ⏎, to see its diff. ⏎ on a stash opens the whole stash's diff: move
between its files with the arrows in the diff's header, or ⌥⌘← and ⌥⌘→.
Hover over a stash for **Apply** (keep the stash), **Pop** (apply, then drop
it), and **Drop**, or right-click it for these plus **Unstash as New
Branch…**, which checks out a new branch at the commit the stash was made on
and pops the stash there. Press ⌫ to drop the selected stash; dropping asks
first. If a stash applies with conflicts, it's kept, and the message offers
the merge tool.

### Worktrees

Run **Worktrees…** (from ⌘⇧A or the branch menu) to list the repository's
worktrees. Choose one to **Open** it in this window, or **Remove** it (the
folder is deleted, and the branch stays). To create one, type a branch name and
press ⏎: the worktree goes in a folder beside the main one, named after the
branch, such as `app-fix-login` for `fix/login`. An existing branch is checked
out; otherwise a new branch starts from HEAD. A new worktree has no `vendor` or
`node_modules`, so run `composer install` and your package manager in it.

### Merge conflicts

When a merge, rebase, cherry-pick, or revert stops for conflicts, the
**Commit** view shows a banner with **Abort**, plus **Continue** for a rebase,
cherry-pick, or revert. Conflicted files are listed under **Merge Conflicts**.
Hover over a file to keep **Yours** or **Theirs** for the whole file, or ✓ to
mark it resolved as it is.

Click a conflicted file, or run **Resolve Conflicts in Merge Tool** from ⌘⇧A,
to open the merge tool. Your version is on the left
and theirs on the right, each with the lines it changed from the common base
highlighted. The middle pane is the file itself: above each conflict, choose
**Accept Yours**, **Accept Theirs**, or **Accept Both**, or edit it directly.
Where one version has lines the others don't, the others show striped blank
space, so the lines all three share stay side by side. The panes scroll
together.

The header counts the conflicts left and marks the one at the cursor. Move
between conflicts with the arrows or F7 and ⇧F7. **Accept Left** (⌥⇧←),
**Accept Right** (⌥⇧→), and **Accept Both** resolve the conflict at the cursor
and move to the next. **Apply Non-Conflicting Changes** merges every conflict
whose two sides changed different lines, even neighboring ones, and says how
many are left for you. The **⋯** menu has **Accept All Yours** and **Accept All
Theirs**. **Mark Resolved** saves and stages the file when no conflicts are
left, then opens the next conflicted file. When several files conflict, a list
on the left shows each one, with a check mark once it's resolved.

If one side deleted the file and the other changed it, the pane titles say
which, and a bar offers **Keep File** or **Delete File**.

The same links appear when a conflicted file is open in a tab, and saving it
with no conflicts left also marks it resolved.
For a merge, the commit message is filled in, so you can click **Commit** to
finish.

### Branches

The branch name in the title bar, and again at the right of the status bar,
shows commits ahead (↑) and behind (↓) the upstream branch. Click either, or
run **Branches…** from ⌘⇧A, for the branches popup. Type to search. At the top
are **Update Project…**, **Commit…**, **Push…**, **Fetch**, **New Branch…**,
**Checkout Tag or Revision…**, the stash actions, and **Worktrees…**. Below them
are the local branches, current first, then the remote branches, each with its
ahead and behind counts, its upstream branch, and the age of its last commit.
Type a name that isn't a branch to create it.

Choose a branch for its actions. Press a number to pick one:

- **Checkout.** A remote branch gets a local branch that tracks it. If your
  changes would be overwritten, the message offers **Smart Checkout**, which
  stashes them, checks out, and brings them back.
- **New Branch from…** creates a branch at that branch and checks it out.
- **Checkout and Rebase onto** the current branch.
- **Compare with** the current branch lists the commits on either side in the
  Git Log. **Show Diff with** the current branch lists the files that differ,
  as a diff you can step through.
- **Rebase** the current branch onto it, or **Merge** it into the current
  branch. If that stops for conflicts, the message offers the merge tool.
- **Push…**, **Rename…**, **Set Upstream Branch…** (or **Track Another
  Branch…**), and **Stop Tracking**.
- **Delete…**. A branch with commits that aren't merged asks before a force
  delete, and the message after deleting offers **Restore**. Deleting a remote
  branch deletes it on the remote, after asking.

**Fetch** (the popup, the **Git** menu, or the Commit view's header) fetches
every remote, prunes branches deleted there, and says how many branches
changed. Long operations show progress in the status bar, with **Cancel** for
the ones that talk to a remote.

## Pull requests

The **Pull Requests** tab lists the repository's pull requests through the
GitHub CLI. Filter by open pull requests, ones you created, ones waiting for
your review, or closed, merged, or all pull requests, and type in the search
box to search them with GitHub's search syntax, such as `fix label:bug`. Each
row shows check status (✓ passed, ✗ failed, ● running), the review decision,
the lines added and removed, when it last changed, and its labels. The check
status fills in as rows scroll into view, and again when you refresh. The **Open** list, without a search or filters, is split into a review
queue: **Waiting for your review**, **Yours**, and **Everyone else**. The list
shows 50 at a time; **Load More** at the end shows 50 more. If the GitHub CLI
isn't installed, or you aren't logged in, the tab says so and offers to fix it.

Click the funnel icon to sort by newest, recently
updated, or most commented, and to filter by draft state, label, author,
assignee, or base branch. Type `@me` for yourself. The filters show under the
search box; click them to change them, or click × to clear them. Tusk remembers
the sort and filters per project. To keep a search, choose **Save This
Search…** and name it: the saved search, with its text and filters, then shows
in the same menu. Choose **Delete a Saved Search…** to remove one.

Click the globe icon to list your open pull requests in every
repository: the ones waiting for your review, your own, and the ones assigned
to you. A pull request from this project's repository opens in a tab; one from
another repository opens in your browser. Click the icon again to go back to
this repository's list.

The badge on the **Pull Requests** icon in the activity bar counts this
repository's open pull requests waiting for your review. It updates with the
list, when you switch branches or projects, and every 5 minutes while Tusk has
focus.

In the list, press **J** and **K** to move down and up, **Enter** to open a pull
request, and **⌘Enter** to open it in the next editor pane, splitting the
editor when there's only one.

While the current branch's pull request has checks running, its status bar
button checks again every 30 seconds while Tusk has focus, so its icon changes
when the checks finish.

Click a pull request to open it in an editor tab, beside your files. Each pull
request opens in its own tab, so you can keep several open at once and switch
between them; clicking one that's already open brings its tab to the front. The
list marks every pull request that has a tab open. Each tab keeps its own
section, scroll position, and unsent comment, and keeps watching its checks
while it's in the background. The header shows the title, the state (Open, Draft,
Merged, or Closed), the author, the branches (click one to copy its name), and
the buttons: **Refresh**, **Open in Browser**, **More Actions**, **Check Out**,
and **Merge…**. Tabs switch between **Conversation**, **Commits**, **Checks**,
and **Files**, each with a count; refreshing keeps the tab and your place in
it. In a narrow pane, such as a split editor, the page becomes one column.

When the tab has focus and you aren't typing, press **1** to **4** to switch
sections, **R** to refresh, **C** to go to the comment box, and **O** to open
the pull request in your browser.

A dot and a bold title in the list mark a pull request that changed since you
last opened it, such as a new comment, review, or push. Pull requests you
haven't opened aren't marked.

The column beside the tabs shows the status box, the reviewers (✓ approved,
✗ changes requested, ● still asked to review), the assignees, and the labels,
then the issues the pull request closes when it merges and its milestone, when
it has them. The gear next to **Reviewers** requests a review, the one next to
**Assignees** assigns or unassigns someone, and the one next to **Labels** adds
or removes labels. Click a closed issue's number to open it in your browser.

The status box tells you what stands between the pull request and merging, as
GitHub's merge box does: the checks (with **Details**, which opens the Checks
tab), the review decision, and whether it can merge, with a button that deals
with it:

- **Draft**: click **Ready for Review**.
- **Conflicts** with the base branch: click **Resolve Conflicts…** to merge
  the base into the branch here. See [Merging](#merging).
- **Behind** the base branch: click **Update Branch** to merge the base into
  it, or rebase onto it, on GitHub.
- **Blocked** by a missing approval, requested changes, or a required check.
- **Auto-merge is on**: click **Turn Off** to stop it. This line shows even
  while conflicts or a branch that's behind hold the merge up.
- **Queued to merge**: the pull request is in the merge queue. Click
  **Remove…** to take it out.

A merged or closed pull request's box offers **Revert…**, **Delete Branch…**, or
**Restore Branch…** when they apply. See [Merging](#merging).

In the **Reviewers** list, the ↻ button next to someone who already reviewed
asks them to review again. GitHub notifies them, so you confirm first.

### Checks

Checks are grouped by workflow, with the workflows that have failures first,
and the bar above them counts them by state. A workflow whose checks all passed
folds into one line; click it to open it. Each check shows how long it ran, or
has been running. While checks run, and for the first two minutes of a new pull request, before
GitHub queues its checks, the tab checks them every 15 seconds and redraws when
they finish or the merge state changes, so the checks, the status box, and the
counts stay current; it waits while you type a comment. When the checks finish,
the status bar says whether they passed, and if you're in another tab, a
message with **Open #123** tells you too.

Checks that the base branch requires for merging say **Required** and come
first in their state. When the base branch requires checks, a failing check
that isn't required reads dimmer, since it doesn't block the merge, and the bar
counts how many failures are required.

Click a check to open its log, if it failed in GitHub Actions, or else its page
in your browser. The log button on a failed job shows the log of its failed
steps in the editor, without the timestamps, scrolled to the first error, such
as PHPUnit's `There were 2 failures`. File paths in the log that exist in the
project, such as `tests/Feature/OrderTest.php:42`, are links: click one to open
the file at that line.

#### Annotations

Tools such as PHPStan, Pint, and PHPUnit report problems on lines of files as
check annotations. Each check lists its annotations under it: click one to
open the file at its line. Annotations show as errors and warnings in two more
places:

- In the editor, when the pull request's branch is checked out, in its files
  and the **Problems** panel. The lines are the pull request's, so edits you
  haven't pushed can put them a few lines off.
- In the pull request's diff, on the new side.

Paths from CI, such as `/home/runner/work/app/app/src/Order.php`, map to the
project's files. The first 50 annotations of each check show; a row links to
the rest on GitHub.

#### Running jobs

GitHub has no log for a job until it ends. The steps button on a running job
shows its steps, each with its state and how long it ran, and updates them
every 5 seconds. If the job fails, the log of its failed steps replaces them.

#### Run controls

- **Re-run Failed** in the bar runs the failed jobs again.
- The re-run button on a finished job runs it again, with the jobs it needs.
- **Cancel Run** stops a running workflow run. With more than one running, you
  pick which.
- **Approve Runs** appears when a first-time contributor's workflow runs wait
  for a maintainer. Review the changes to workflows and scripts first, since
  the runs can use the repository's secrets.
- **Artifacts…** lists the files the workflow runs uploaded. Pick one and a
  folder, and it downloads into a folder named for it, which then opens in
  your file manager.

Each of these, except **Artifacts…**, asks you to confirm
first.

#### Deployments

Deployments of the pull request's head follow the checks: the latest one to
each environment, with its state. Click one to open the deployed site.

### Files and commits

Click a changed file to see its diff without checking out the branch. ⌥⌘← and
⌥⌘→, or the arrows in the diff's header, move to the previous or next file of
the pull request, with its comments. A comment count marks files with line
comments; it's yellow while a thread there is unresolved. Each file has
GitHub's **Viewed** checkbox, so the files you've read are the same here and in
the browser, and a bar above the files shows how many you've viewed. The diff's
header has the checkbox too: tick **Viewed** when you've read a file, and the
diff moves on to the next file you haven't viewed. Viewed files show ✓ in the
diff's file list.

To work through a large pull request:

- Click **Next Unviewed**, or press V in the pull request's tab, to open the
  first file you haven't viewed.
- Tick **Hide viewed** to list only the files you haven't viewed yet. Tusk
  remembers the choice.
- Click **Mark All Viewed** to mark every file in the list as viewed on GitHub.
  It asks first, because it changes each file's Viewed state on GitHub.

Click a commit to see its own diff.

After you've reviewed a pull request and its author pushed again, the Files
tab offers **Since your review**, as GitHub's "changes since your last review":
it lists only the files that the pull request changed after the commit you
reviewed. When the author merged the base branch in, or rebased onto it, since
your review, the diffs leave out the base branch's changes and show only the
pull request's own. A file where the base's changes conflict with the version
you reviewed shows its whole change since your review. **All changes** goes
back to the whole pull request.

With more than five files, the Files tab groups them under their folders, and
with more than eight it has a box that filters them by path. Press ↓ in the box
to move to the list. A pull request with more than 100 files or commits lists
all of them.

### Conversation

Descriptions and comments render as GitHub Markdown, and their links open in
your browser. The comment box and the reply boxes in the conversation have
**Write** and **Preview** tabs; **Preview** shows your text as GitHub will.
Type `@` in any comment box to pick a person: the pull request's participants
come first, then everyone who can be assigned in the repository. ↑ and ↓
choose, Enter or Tab inserts, and Escape closes the list. A comment you haven't
sent stays in the box when you close the tab or restart Tusk. `#123` links to that issue or pull request, and
`@name` to that person's profile. Emoji shortcodes such as `:+1:` and `:tada:`
show as emoji, as on GitHub.

The conversation is GitHub's timeline. Between the comments and reviews, one-line
events show what happened: commits pushed (each run of commits as one entry,
with a line per commit that opens its changes), force pushes, labels added or
removed, review requests, title changes, draft and ready-for-review changes,
closing, reopening, merging, deleting the branch, dismissed reviews, and
mentions in other issues and pull requests. A long conversation shows its first
and last items; click **Show more** in the middle to read the rest, a page at a
time.

Reactions show under the description, comments, review summaries, and line
comments, with yours highlighted. Click a reaction to add or remove yours, or
click the smiley button to pick one. Click **Quote** on any comment to put it
in the comment box as a `>` quote. To quote part of a comment, select that text
first.

The bookmark button beside the comment box inserts a saved reply where the
cursor is. It also saves the comment you typed as a new reply. To add, rename,
change, or delete saved replies, click **Manage saved replies**, which opens
**Saved replies** in Settings. Saved replies are yours, in every project.

If you can moderate the repository, comments and review summaries have
**Hide**, which asks for a reason (such as spam or off topic) and asks you to
confirm. A hidden comment shows folded, with its reason; click **Show comment**
to read it, or **Unhide** to show it to everyone again. If you can write to the
repository, approvals and change requests have **Dismiss**, which asks for the
message GitHub shows in the timeline, then asks you to confirm.

Line comments appear in the conversation under the file and lines they're on,
with the last lines of code they're about. Click the file name to open the diff
at that line. Resolved threads are folded; click **Show resolved comments** to
read them. Each thread has **Reply** and **Resolve** links, as in the diff, so
you can answer a thread without opening the code. If you wrote the pull
request, its description has **Edit** too. In the diff, each thread shows under
its line, with **Reply** and **Resolve** links. A resolved thread shows as one
line; click **Show** to read it or **Unresolve** to reopen it. In the Files
tab, **Go to Unresolved** opens the first unresolved thread, and **Next
Unresolved** under a thread goes on to the next, across files. Your own
comments, in the diff and in the conversation, have **Edit** and **Delete**
links, and your own review summaries have **Edit**.
Deleting asks you to click **Delete** again to confirm.

To comment on code in the diff:

1. Point at a line, on the new side or the old side, and click the blue **+**
   in its gutter. To comment on several lines, press the **+** and drag across
   them, or select them first and click the **+** of one of them. You can also
   select the lines and click **Comment on Line** in the diff's header.
2. A comment box opens under the line.
3. Write the comment (Markdown, on as many lines as you like). **Preview**
   shows it as GitHub will. Then click **Add to Review** to keep it for your
   review, or **Comment Now** to post it at once. ⌘⏎ adds it to the review,
   and Escape closes the box. On the new side, **Suggest Change** puts the
   selected lines in a `suggestion` block for you to edit, as GitHub does.

GitHub takes comments only on the lines of the diff: the changed lines and the
3 lines around each change. Other lines have no **+**; point at their gutter to
see why. A range has to stay inside one group of changes, so a drag stops at
its edge. In **Since your review**, only the new side takes comments.

To comment on the whole file rather than on its lines, click **Comment on
File** beside the diff's file list. Comments on the file show above its first
line.

A comment with a suggestion has an **Apply Suggestion Locally** link. With the
pull request's branch checked out, it opens the file and replaces the lines in
the editor, where you can review it, undo it, or save it. If the lines changed
since the suggestion was made, it says so and changes nothing.

To apply several suggestions at once, check **Select** under each one, in this
file or in others, then click **Apply 2 Selected Suggestions** (with your
count) under any of them. Suggestions that
change the same lines can't go in together. After applying, Tusk offers to
save the files and commit them as "Apply suggestions from code review". The
commit includes every change in those files, and only those files. Tusk never
pushes it; push when you're ready.

**Add to Review** puts the comment in your pending review on GitHub, which only
you can see until you submit it. It's the same review as in the browser: a
review you started on GitHub shows here, and one started here shows there.
Pending comments show in the diff with a yellow edge and on the pull request's
page under **Pending review**, where you can delete them. While you have a
pending review, replies join it too, and **Comment Now** isn't offered, since
GitHub takes no comment outside the review. To submit, write an optional summary
in the comment box, which stays at the bottom of the Conversation tab, and click **Submit Review**, **Approve**, or **Request
Changes**. Without a pending review, **Comment** adds a comment to the
conversation, and **Request Changes** needs one. On your own pull request,
only **Comment** shows, since GitHub doesn't let you approve or request changes
on it.

Click **Check Out** to switch to the branch. On the pull request's branch,
the button reads **Checked Out**, or **Pull** when the pull request's head on
GitHub differs from your branch; **Pull** fast-forwards to GitHub's commits.

On the branch of a pull request, its line comments show in the editor too, on
the lines they're about: a comment icon in the gutter (yellow while the thread
is unresolved), a faint highlight on the line, and the latest comment after the
line's end. Hover the icon to read the whole thread, and click it, or **Open in
#123** in the hover, to open the thread in the pull request's diff. When your branch has commits or edits that the pull request doesn't, each comment moves to its line in your copy, and a comment whose line you deleted doesn't show. When the current branch has a pull
request, its number and check status appear next to the branch name in the
status bar.

**More Actions** (the **…** button) edits the title, requests a review, adds or removes labels, converts
the pull request to a draft or marks it ready, updates the branch, closes or
reopens it, and copies its link or branch name.

### Merging

**Merge…** asks how to merge (a merge commit, squash, or rebase). It offers
only the methods the repository allows, when GitHub tells you (it tells
repository admins), and puts the one you used last first.

For a merge commit or a squash, a dialog then shows the commit's subject and
message, filled in the way GitHub fills them in from the repository's settings,
such as the title with ` (#12)` and the commit list for a squash. Edit them,
then click **Continue** (or press ⌘↩). A rebase keeps the branch's commits, so
it has no message to edit.

You then confirm in the palette. Besides merging, it offers to merge and delete
the branch, and, while checks or reviews are still missing and the repository
allows it, **Merge When Ready**, which turns on GitHub's auto-merge. When you're
a repository admin and the branch's rules block the merge, it also offers
**Merge without waiting for requirements**, which merges with your admin rights
and skips the required reviews and checks.

When the base branch uses a merge queue, **Merge…** offers **Add to Merge
Queue** instead of the methods, since the queue merges with the method its rules
set. If required checks are still running, GitHub turns on auto-merge instead,
and queues the pull request once they pass; the status bar says which happened.
While the pull request is queued, the status box shows **Queued to merge** with
its position and state, and **Merge…** or **Remove…** takes it out of the queue.
An admin can also choose **Merge Without the Queue…**.

While auto-merge is on, the page checks the pull request every 15 seconds, so
it shows the merge when GitHub makes it.

When the pull request conflicts with its base, **Resolve Conflicts…** checks out
its branch (unless it's checked out already), fetches the base, and merges it
into the branch here. The merge tool opens on the first conflicted file; see
[Merge conflicts](#merge-conflicts). When you're done, commit the merge and push
it from the Commit tab. Nothing is pushed for you.

After a pull request merges or closes, its status box offers:

- **Revert…**: creates a pull request on GitHub that undoes a merged pull
  request, then opens it. Nothing changes until you merge it.
- **Delete Branch…**: deletes the pull request's branch on GitHub. Your local
  branch stays.
- **Restore Branch…**: recreates a deleted branch on GitHub at the pull
  request's last commit.

Each of these asks you to confirm first. The branch actions aren't offered for
a pull request from a fork, whose branch is in another repository, and
**Delete Branch…** isn't offered when the branch has commits the pull request
doesn't have.

### Creating a pull request

Click **+** in the Pull Requests tab, or choose **Create Pull Request…** from
the actions, to open a form for the current branch in an editor tab. Pick the
base branch (the repository's default branch at first), then check the title
and description. The title starts as the commit's subject when the branch has
one commit, or as the branch's name; the description starts as the
repository's pull request template, if it has one, or as a list of the
commits. The title shows a warning when you leave it empty. The description
has **Write** and **Preview** tabs, and suggests people after `@`.

If the repository has several templates (in a `PULL_REQUEST_TEMPLATE` folder),
choose one from **Template**, or choose **None**. Switching templates replaces
the description only while you haven't edited it.

Click **+** next to **Reviewers**, **Assignees**, **Labels**, or **Milestone**
to add one from the base repository, and click **×** on a chip to remove it.
To ask a team for a review, type its `org/team` name in the reviewer list.

Below the form, you see the commits the pull request adds and the files it
changes since the branch left its base, with the lines each adds and removes.
Click a file to see its diff. Tick **Create as a draft** for a draft, then
click **Create Pull Request** (or press ⌘⏎). If the remote doesn't have the
branch's commits yet, Tusk pushes it first. The new pull request opens in its
tab. If the branch already has an open pull request, the form says so and
offers to open it instead.

The form keeps what you type, per project and branch, so closing the tab or
restarting Tusk doesn't lose it. Tusk clears it once the pull request exists.

#### From a fork

When the branch pushes to a fork, the pull request goes to the fork's parent
repository by default, as on GitHub. To pick another, such as the fork itself,
use the repository list next to the base branch. To list the commits and files
for a parent repository, add a remote for it (for example,
`git remote add upstream <url>`) and fetch it. The GitHub CLI can't create a
pull request from a fork that an organization owns, so the form warns you to
create that one on GitHub.

Pull requests need the GitHub CLI (`gh`), signed in with `gh auth login`.

