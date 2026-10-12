# Designers

## The Designers tool window

The **Designers** tool window (its icon is in the tool window bar) is where
the designers start:

- **App designers:** a tile for each of the app's designers, which opens it or
  asks which model, enum, or class to open. The tiles are Models, Enums,
  Access, Notifications, Automations, Schedule, Environment, App settings,
  Record history, and Check the app. Click the heading to hide them.
- **Panels:** each Filament panel, with chips for its **Dashboard**,
  **Navigation**, and **Settings**, then its resources and pages as the
  panel's navigation lists them.

## Filament designer

The designer builds a Filament resource without writing code: its form, table,
infolist, relation managers, pages, and settings. It works with Filament 4 and
later. To open it, do one of the following:

- Open the **Designers** tool window and click a resource. It lists each panel's
  resources by navigation group.
- Click **Open in Designer** above a resource's or relation manager's class, or
  above a Filament 4 schema class such as `PostForm`.
- Run **Filament: Open Resource in Designer…** from the palette.

The designer edits the resource's code, and the code is all it keeps. Each
change is a small edit that's saved at once, with local history, and comments,
closures, and code it doesn't read stay as written. Code it can't show as a
component shows as a **Code** block, which you can still move or delete.
Changes you make in the code editor show in the designer as you type.

### Forms, tables, and infolists

The canvas draws the form, table, or infolist as Filament does: sections,
grids with column spans, tabs, wizards, repeaters, and every field type.

- **Add a component:** drag it from the palette on the left, or click it to add
  it after the selected component. Fields, columns, and filters ask for a name,
  and suggest the model's columns that aren't used yet.
- **Add a model column:** drag it from the model's column list to get the
  component that suits it, already set up. For example, a foreign key becomes a
  searchable relationship select, and a boolean becomes a toggle.
  **Add N** adds every column that's missing.
- **Change a component:** select it and use the inspector on the right. The
  settings people change most come first, then every other setting the class
  has, grouped and searchable. Options come from a list, an enum, or a
  relationship. **Visible when**, **Required when**, and **Disabled when** build
  conditions on other fields, and mark those fields `live()`.
- **Rearrange:** drag components, or use <kbd>⌥↑</kbd> and <kbd>⌥↓</kbd>.
  Right-click a component to duplicate it, wrap it in a section or grid, or show
  it in the code.
- **Tables:** columns sit in the table's header, and filters, row actions, bulk
  actions, and header actions sit in lanes below it. With nothing selected, the
  inspector shows the table's own settings, such as the default sort.

| Key | Action |
| --- | --- |
| <kbd>⌫</kbd> | Delete the selected component |
| <kbd>⌘D</kbd> | Duplicate it |
| <kbd>⌥↑</kbd> / <kbd>⌥↓</kbd> | Move it up or down |
| Arrow keys | Select the previous, next, parent, or first child component |
| <kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd> | Undo or redo the designer's last change |
| <kbd>Esc</kbd> | Select the parent |

Values the designer can't show in full, such as closures, options with keys
written as code, or settings a method decides, show as code you can open. The
designer asks before replacing them. A file with syntax errors opens read-only
until you fix them. When the app can't start, the Designers tool window shows
why, with a link to the file and line, and still lists the resource files.

The palette lists the components the project has: Filament's, plugins', and the
project's own. Each setting's editor comes from its parameter types, so a new
Filament version or a plugin needs no update to Tusk.

### Actions and their forms

- **Page actions:** the **Page actions** tab shows the header actions of the
  resource's list, create, edit, and view pages: the buttons beside the page's
  title. Pick a page at the top, then add, arrange, and set up its actions as
  in a table's lanes. A page without header actions gets them with one click,
  starting with the ones that page usually has.
- **Forms:** select an action, in a table or on a page, and its modal shows
  below: the heading, the description, the form, and the buttons. Drag fields
  or model columns into it, or click them in the palette, as in a form.
- **What it does:** a custom action can save its form to the record, set a
  column to a value (an enum column offers its cases), delete the record, or,
  on a list page, create a record. It can also send one of the app's
  notifications about the record, to the people you pick (see
  [Notifications designer](#notifications-designer)). It can then show a
  success notification.
  Bulk actions do the same to each selected record. Saving the form also fills
  it with the record's values when it opens. The designer writes these as the
  action's code; an action written otherwise shows as code.

### Access

The **Access** tab decides who can do what with the resource's records, from
the model's policy. Each ability (see the list, view, create, edit, delete, and
under **More abilities** the bulk and soft-delete ones) is **Everyone**,
**Nobody**, or **Only users who…** have a permission, have a role, or own the
record, by a column such as `user_id`. Join conditions with **or** or **and**.
Filament hides what someone can't do. An ability the policy doesn't have is
allowed. A rule written as other code, such as a call to a helper, shows as
code, which you can open or replace.

The same view opens for any model, with or without a resource: click
**Access** in the model designer, **Open in Access** above a policy's class, or
run **Laravel: Model Access…**.

A model without a policy gets one with **Create a policy**, which runs
`make:policy` and starts with everything allowed, so no one is locked out.
New permissions are named as Filament Shield names them, such as `update_post`.
With Shield installed, the Access tab asks Shield for the resource's permission
names, so they match what Shield generates, including the app's own naming
when it has one. When Shield lets its super admin role past every rule, the tab
says so.

With spatie/laravel-permission, **Roles and permissions** shows which roles
have the permissions the rules name. Check a box to grant one, creating the
permission when it's missing, and **New role** adds a role. These change the
app's database.

Custom pages and widgets have **Access** too: who can open the page, or see the
widget, is **Everyone**, **Nobody**, **Only users who…** have a permission or a
role, written in its `canAccess()` or `canView()`, or, with Filament Shield,
**Filament Shield decides**, which adds Shield's `HasPageShield` or
`HasWidgetShield` trait and shows the permission Shield gives it, such as
`page_Settings`, with the roles that have it. A page someone can't open also
leaves their navigation.

With Filament Shield, **Generate with Shield…** runs `shield:generate` for each
panel: **Create the permissions** for every resource, page, and widget, or
**Also write missing policies**, which leaves existing policies alone.

### Languages

When text is written with `__()`, the designer helps translate it:

- **Preview:** pick a language beside the designer's title, and the canvas
  shows each `__()` text, and each label with `translateLabel()`, in that
  language. Arabic, Hebrew, Persian, and Urdu lay out right to left.
  **Add a language…** adds a JSON file for a new one.
- **Translate:** a label, heading, placeholder, or other text shows its
  translation in each of the app's languages below it, to edit in place. A
  missing one shows the text people see instead. Plain text has a
  **Translate** button that writes it with `__()`. Changing a translated text,
  or a label with `translateLabel()`, renames its key in the JSON files too.
- **Make translatable:** with nothing selected, the inspector counts the texts
  written as plain strings, and one click writes them all with `__()`.

Translations go in `lang/<language>.json`, which Laravel reads first for any
key. A translation that's already in a PHP file, such as
`lang/ar/orders.php`, is changed there.

### New resources

**Filament: New Resource…**, the **+** in the Designers tool window, or
**Filament resource** in the model designer opens a wizard:

1. **Model:** pick one of the app's models, or design a new one.
2. **Placement:** the panel, cluster, navigation group, icon, record names,
   title attribute, and pages: separate pages or one page with modals, and a
   View page.
3. **Form:** which columns become fields, the field for each, and whether
   they're required or full width. Tusk proposes them from each column's type,
   cast, and name, so a foreign key is a relationship select.
4. **Table:** the columns and whether each is searchable, sortable, or can be
   hidden, the filters, the row and bulk actions, and the default sort.
5. **Review:** a summary and the form's and table's code.

Filament's generator (`make:filament-resource`) makes the files, so they follow
the project's Filament version and published stubs. The wizard then fills in
the form, table, infolist, and settings, and opens the designer.

### Relation managers, pages, and settings

- **Relations:** lists the resource's relation managers. **Add relation
  manager** creates one for a relationship of the model, with attach or
  associate actions, and registers it. Click one to design its form and table.
- **Pages:** lists the resource's pages and their addresses, and adds View,
  Create, Edit, or custom pages.
- **Settings:** sets the navigation label, icon, group, and order, the record's
  names and title attribute, the URL, a record count badge, and the attributes
  global search looks in.

### Panel settings

Click **Settings** under a panel in the Designers tool window, **Open Panel
Settings** above a panel provider's class, or run **Filament: Panel
Settings…**. Each change is saved to the provider at once, and a preview of
the panel follows it.

- **Brand:** name, logo and dark mode logo (a file in `public/` or a URL),
  logo height, favicon, and font.
- **Colors:** each of Filament's colors from its palettes, or any color.
- **Sign-in:** login, registration, password reset, email verification, and
  the profile page.
- **Layout and features:** top navigation, collapsible sidebar, content width,
  breadcrumbs, dark mode, global search, the notifications bell, single-page
  navigation, and strict authorization.
- **Navigation groups:** their order, icons, and whether they start
  collapsed, with the groups resources use that aren't listed yet.
- **Plugins:** the Filament plugins installed with Composer, added to the
  panel or removed from it.
- **Two-factor sign-in:** codes from an authenticator app, with recovery
  codes, or by email, and whether everyone must use it. **Set it up** gives
  the user model Filament's contracts and traits, adds their columns with a
  migration and runs it, and turns the profile page on, where people set it up.
- **Tenancy:** the tenant model. **Set it up** makes the user model implement
  `HasTenants` through its relationship to the tenant model, and the section
  lists resources' models that don't belong to a tenant yet.

Settings written as code the designer doesn't write, such as a logo from a
closure, show as code and open it.

### Import and export

Add an **ImportAction**, **ExportAction**, or **ExportBulkAction** from the
palette, and its **Importer** or **Exporter** setting picks one of the model's,
or makes a new one from the model's columns with Filament's generator. Click
it, or **Open in Import Designer** above an importer's class, to design it:

- **Columns:** each CSV column's heading; for imports, whether the file must
  have it, how its value is read (text, a number, yes or no, or a list), its
  validation rules, and an example value; for exports, whether it starts
  checked. Add the model's other columns, reorder, and remove.
- **Records:** whether each imported row makes a new record, updates the one
  with the same value in a column (such as `sku`) or makes it, or only
  updates.
- **What it needs:** the tables imports and exports use, with a button that
  creates them, and whether a queue worker must run.

The preview shows the CSV: the example people download before importing, or
the columns an export writes.

### Custom pages

Pages that aren't a resource's are listed under **Pages** in each panel in the
Designers tool window, and open in the designer: their form or table, header
actions, access, and navigation settings (label, icon, group, order, title,
and address). **Open in Designer** shows above a page's class too.

**New page** (the page button on a panel, or **Filament: New Page…**) makes:

- **A form** that edits one record: the signed-in user's, or a model's single
  record, such as the store's settings, made when it's first saved. Its
  fields come from the model's columns, and **Save** saves them.
- **A table** of a model's records, with columns from the model.

New pages draw their content from `content()`, so they need no Blade view.

### Dashboards and widgets

Click **Dashboard** under a panel in the Designers tool window, or run
**Filament: Dashboard…**. The dashboard shows its widgets in a grid, as wide
as each one is.

- **Arrange:** move widgets earlier or later, change how many columns each
  spans, and the dashboard's column count. Hide a widget, and show it again
  from **Hidden widgets**. A dashboard page that lists its own widgets changes
  that list instead.
- **New widget:** a stats overview, a chart, or a table of a model's records.
  It starts useful: a stat that counts the records, a chart of new records per
  month, or a table of the latest ones.
- **Stats:** each stat's label, value, description with its icon, color, and a
  trend of the last 7 days. A value counts a model's records, or sums,
  averages, or finds the lowest or highest of a column, of the records that
  match its conditions, in a time window, shown as it is, as a number, as
  1.2K, or as money.
- **Charts:** the type (line, bar, pie, doughnut, polar area, or radar), the
  heading, color, and height, and the data: a value over the last days, weeks,
  or months, or split by a column's values. Pies get a color per part.
- **Table widgets** open in the designer's table tab.
- **Following the table:** a resource's widget can count the records its list
  page shows, with the table's filters and search, with **Follows the table**.
- **Access:** who can see a widget, as for pages below.
- **Resource pages:** the **Page actions** tab lists the widgets above the
  page, to add, reorder, and remove, and makes new ones for the resource.

The preview runs the widget to show its real numbers, as the first user when
there is one.

### Navigation

Click **Navigation** under a panel in the Designers tool window, run
**Filament: Navigation…**, or click **Navigation…** in the panel settings'
navigation groups. The panel's sidebar shows as Filament builds it: its groups
in order, then each group's pages, resources, and clusters with their icons,
labels, and badges, and items nested under their parent item. A cluster shows
the resources and pages in it below it.

- **Reorder:** drag an item within its group, or select it and press
  <kbd>⌥↑</kbd> or <kbd>⌥↓</kbd>. Each project item in the group gets a
  `$navigationSort` in the new order.
- **Move to another group:** drag the item onto the group, or pick the group
  in the inspector. The group is written the way the project writes it: a
  label, a translated `__()` label, or an enum case. Drop an item on **Drop
  here for a new group** to start one.
- **Reorder groups:** drag a group. The panel's `navigationGroups([...])`
  lists them in the new order, keeping each group's icon and other settings.
  Groups from an enum come in the order of its cases.
- **Rename a group:** select it and change its name. Every file that names it
  changes, and so does the panel's list and, for a translated name, its
  translations.
- **Clusters:** **New cluster** makes one with Filament's generator, after
  adding `discoverClusters()` to the provider when the panel doesn't discover
  clusters yet. Drag a resource or page onto a cluster, or pick the cluster in
  the inspector, to move it in; the files stay where they are.
- **One item:** the inspector changes its label, icon, group, parent item,
  cluster, and whether it shows in the navigation. A hidden item stays in the
  list, crossed out, so you can show it again. Right-click an item for the same
  actions, or double-click it to open it in the designer.

A setting a method decides, such as a `getNavigationSort()` the designer
didn't write, shows as code and the item can't be moved, since a property would
be ignored; the inspector says why and opens the method. Items from packages,
and items the provider adds with `navigationItems()`, are read only. Badges
show what the app returns now, and can't be changed here.

### Sample records and checks

- **Sample records:** **Sample records** in the model designer, or **Laravel:
  Add Sample Records…**, makes as many records as you ask for with the
  model's factory, in the app's database.
- **Translated names:** in a resource's or page's settings, **Translate**
  beside the label, group, record names, or title writes it as a getter that
  returns `__('…')`, with a field for each language. A group's name must be
  translated the same way in the panel's navigation groups for their order to
  apply.
- **When the app stops starting:** after a change to `app/`, the app is read
  again, and a notice says when it can't start, with the file and line; another
  says when it starts again. **Laravel: Check the App (Boot and Tests)**
  loads the routes and runs the tests in a terminal tab.

### Generated tests

**Generate tests** (the beaker in the resource designer's header), **Generate
Tests** in a resource's menu in the Designers tool window, or **Filament:
Generate Resource Tests…** writes tests for a resource to
`tests/Feature/Filament/<Resource>Test.php` and runs them. The New Resource
wizard's last step has the same option. The tests check that:

- The list page shows records and the table's columns.
- A record can be created and edited with the form, and its values are saved.
  An edit also checks that the form shows the record.
- Each required field is required, and each unique field rejects a value
  another record has.
- The View page opens.
- A user the policy refuses can't open the list, create, edit, or view pages.

A simple resource, with one page and modals, is tested through its **New** and
**Edit** actions.

- **Values:** the tests fill the form with the model's factory, and give
  fields the factory doesn't fill a value for their type. When a model the
  tests need has no factory, Tusk offers to make one, with a fake value for
  each column, and adds `HasFactory` to the model.
- **Who acts:** a user from the user model's factory, with the permissions and
  roles the policy's rules ask for. With spatie/laravel-permission, the tests
  create them. A rule Tusk can't read gets a comment that asks you to set the
  user up.
- **Pest or PHPUnit:** a project with Pest gets Pest tests. Without Pest, you
  choose PHPUnit tests or installing Pest first.
- **Your code:** a test file that exists isn't overwritten. Tusk offers to add
  the tests it lacks, such as one for a field that became required, or to open
  it.

The tests run in the Tests tab, and **Laravel: Check the App (Boot and Tests)**
runs them with the app's other tests.

## Model designer

The model designer creates an Eloquent model or changes one and its table. To
open it, click **Open in Model Designer** above a model's class, run
**Laravel: New Model…** or **Laravel: Open Model in Designer…**, or click the
model's name in the Filament designer.

- **Columns:** each column's name, type, length or precision, whether it can be
  null, default, index, whether it's fillable, and its cast, which is chosen
  from the type unless you pick an enum. A foreign key names its table and what
  happens when the other row is deleted. **Quick add** adds common columns, such
  as a slug or a price. Drag rows to reorder them.
- **Relationships:** belongs-to, has-one, has-many, many-to-many, and morph
  relationships. A belongs-to relationship adds its foreign key column, and a
  many-to-many relationship adds its pivot table. You can add the other side of
  the relationship to the related model too.
- **Preview:** the right side shows the migration, the model, and the factory as
  they'll be written.

Changes are staged until you click **Create model** or **Apply changes**, which
is off while neither the table nor the model would change. A new
model gets its class, a migration, and optionally a factory that fakes each
column, a seeder, a policy, and a Filament resource. For an existing model,
Tusk writes a migration with only the changes, such as
`add_description_to_posts_table`, with a `down()` that reverses them. It edits
the model's fillable attributes, casts, soft deletes, and relationships in
place, and keeps everything else. Dropping a column asks first. **Run the
migration** runs `php artisan migrate` afterwards, in Sail when it's up.

### Record history

Record history keeps who created, changed, or deleted each record, and what
changed, with
[spatie/laravel-activitylog](https://github.com/spatie/laravel-activitylog).
To turn it on for a model, open the **History** section at the bottom of the
model designer, or run **Laravel: Record History…** and pick the model.

- **Install:** when the package isn't installed, **Install
  spatie/laravel-activitylog** runs Composer, publishes the package's migration
  and config, and runs the migration, in a terminal tab. When the package is
  installed but its table isn't, the section offers to run the migration.
- **Record history:** adds the `LogsActivity` trait and its
  `getActivitylogOptions()` to the model. The settings are the calls on
  `LogOptions::defaults()`: which attributes it records (chosen ones, the
  fillable ones, all of them, or only the event), **Only changed values**
  (`logOnlyDirty()`), **Skip empty entries**, a log name, and a description
  with `{event}` for created, updated, or deleted. Turning it on picks the
  table's columns without the key, timestamps, and hidden attributes such as a
  password. Unchecking an attribute when it records all of them adds it to
  `logExcept()`.
- **Latest entries:** the section lists the last ten entries for the model's
  records, with who made them and the old and new values, so you can see that
  logging works.

Changes are staged with the model's other changes until you click **Apply
changes**. Calls the designer doesn't know, such as
`dontLogIfAttributesChangedOnly()`, are kept and show as code. So does a
method written as code, such as one with statements before its `return`.

To show a record's history in Filament, turn on **Show history on the
record's page** in the resource designer's **Settings** tab. It writes
`ActivitiesRelationManager`, a read-only relation manager titled **History**,
next to the resource, and adds it to `getRelations()`. It lists each entry
under the edit and view pages: when, who, what happened, and each changed
attribute as `title: Old → New`. It opens in the designer like any other
relation manager. Turning the setting off removes it from `getRelations()` and
keeps its file.

## Enum designer

The enum designer creates a PHP enum or changes one: its cases, their values,
and the labels, colors, icons, and descriptions Filament shows in selects,
badges, and filters. To open it, click **Open in Enum Designer** above an enum,
run **Laravel: New Enum…**, pick **New enum…** as a column's cast in the model
designer, or use the Enum options of a select in the Filament designer, where
**Make an enum of these** turns a list of options into an enum.

- **Cases:** name, value, label, color, and icon for each case. Type several
  values at once, such as `draft, published, archived`. Drag rows to reorder
  them.
- **Filament shows:** turns `HasLabel`, `HasColor`, `HasIcon`, and
  `HasDescription` on or off, which adds or removes the method.
- **Translated:** labels and descriptions go through `__()`. A
  **Translations** card then shows each one in each of the app's languages, to
  fill in. Translations are written with the enum when you apply, and a
  renamed label takes its translations along.

Changes are staged until you click **Create enum** or **Apply changes**, with
the code previewed. A method the designer can't read, such as an icon that
comes from a helper, shows as **In code** and is kept. A renamed case is renamed
there too. When a new case is missing from such a method, the designer says so
and opens the method after applying.

## Environment settings

The environment settings edit the values in `.env` that password reset, email
codes, notifications, and imports and exports depend on. To open them, run
**Laravel: Environment Settings…**, click **Open in Environment Settings**
above the project's `.env`, or click **Environment** under **App designers** in the
Designers tool window. Each change is saved to `.env` at once, like typing it there: comments,
order, and quoting stay as they are, and a new key goes after the others of its
group, such as `MAIL_HOST` after `MAIL_PORT`.

- **App:** name, environment, debug mode, URL, language, and time zone. A
  missing `APP_KEY` can be generated. Laravel 11 and later set the time zone in
  `config/app.php` rather than reading `APP_TIMEZONE`, so the time zone then
  edits `config/app.php`, and **Read it from .env instead** makes it read
  `APP_TIMEZONE`.
- **Mail:** the mailer, from the mailers in `config/mail.php`. SMTP shows the
  host, port, username, password, and scheme; other services, such as Resend,
  Postmark, or SES, show the keys `config/services.php` reads for them. Then
  the from address and name. **Send a test email** sends one with Tinker, using
  the app's own settings; with the log mailer, it opens the log.
- **Queue:** the connection. `sync` gets a warning, since Filament's imports
  and exports need a real queue and a worker; **Run a worker** runs
  `queue:work` in a terminal tab. The database queue offers to create its
  table when it's missing.
- **Storage:** the default disk, with an S3 disk's keys, and **Link it** when
  `public/storage` is missing.
- **Cache and sessions:** the cache store, the session driver, and how long
  sessions last, with their tables for the database drivers.

Passwords and keys are masked, and messages name the key, never its value.
When a value the booted app uses differs from `.env`, the row says so: the
config is cached, or the config file doesn't read the key. With a cached
config, **Clear the config cache** runs `config:clear`. A key new to `.env` can
be added to `.env.example` too, with secrets left empty.

## Automations

Automations are rules such as "when an order's status becomes shipped, email
the customer". Tusk writes them as the model's observer. To open them, click
**Automations** in the model designer, **Open in Automations** above an
observer's class, or run **Laravel: Automations…**.

- **When:** the record is created, updated, deleted, or restored (with soft
  deletes), a field changes, or a field becomes a value, such as an enum case.
- **If:** optional conditions that compare the record's fields with values,
  such as `total` is at least 100. Enum fields offer their cases.
- **Then:** send a notification, or set a field. A notification goes to every
  user, users with a role, the record's user (such as the order's
  `customer`), the signed-in user, or an email address. Pick from the app's
  notifications that take the model, or none, or make one with **New
  notification…**, which opens the Notifications designer.

Each change is saved at once. The first rule creates
`App\Observers\OrderObserver` and registers it on the model with
`#[ObservedBy]`. An observer the app registers elsewhere, such as with
`Order::observe()` in a provider, is used as it is. Fields are set before the
save, in `creating` or `updating`, so they're saved with the record;
notifications are sent after it, in `created` or `updated`. A rule that does
both is written in both methods under the same condition. A queued
notification (one that implements `ShouldQueue`) is sent only while a queue
worker runs, which the rule says. Code in the observer the designer can't read
shows as code you can open, and stays as written.

## Scheduled tasks

The schedule designer shows the app's scheduled tasks and changes them in
Laravel's scheduler: what runs, when, and how. To open it, run **Laravel:
Scheduled Tasks…**, click **Open Scheduled Tasks** in `routes/console.php`, in
`bootstrap/app.php` when it has `withSchedule()`, or in an older
`app/Console/Kernel.php`, or click **Schedule** under **App designers** in the
Designers tool window.

- **Tasks:** an Artisan command with its arguments, picked from the project's
  own commands; one of the app's queued jobs; a notification sent to every
  user, the users with a role, or an email address; or **Delete old records**,
  which schedules `model:prune`. **Add task** writes the new task beside the
  existing ones, or in `routes/console.php`.
- **When:** every few minutes, hourly, daily at a time, weekly on a day at a
  time, monthly on a day at a time, or a cron expression. The next three runs
  show in the task's time zone, or the app's.
- **Options:** a time zone, the environments the task runs in, **Skip while
  still running** (`withoutOverlapping()`), **On one server**
  (`onOneServer()`), and **In the background** (`runInBackground()`).
- **Run now:** runs a command directly, and other tasks with
  `php artisan schedule:test`, in a terminal tab.
- **Old records:** each prunable model with the records `model:prune` deletes:
  those older than some days, by a date column, that match conditions such as
  `status is cancelled`. **Add a model** makes a model prunable with Laravel's
  `Prunable` trait and a `prunable()` query. A model with soft deletes loses
  those records for good.

Laravel runs the tasks only while its scheduler runs. The side panel says so,
runs `php artisan schedule:work` in a terminal tab while you develop, and gives
the line to add to a server's crontab:
`* * * * * cd /path/to/app && php artisan schedule:run >> /dev/null 2>&1`.

Each change is saved in the code as you make it, as in the Filament designer.
A task the designer can't read, such as a closure of the app's own, shows as
code, and you can still change when it runs. Calls it doesn't write, such as
`when()` or `emailOutputTo()`, stay as they are.

## Notifications designer

The notifications designer creates and changes a notification class: what
shows in the panel's bell, and the email. To open it, click **Open in
Notifications Designer** above a notification's class, run **Laravel: New
Notification…** or **Laravel: Open Notification in Designer…**, or click
**Notifications** under **App designers** in the Designers tool window.

- **New notification:** a class name, the model it's about (or none, as for a
  weekly report), and whether it goes to the bell, by email, or both. Tusk
  writes it in `app/Notifications` with a title that names the record and a
  button that opens the record's page.
- **Sent to:** turns the bell and email on or off. Turning one on adds its
  part when the class doesn't have it; turning it off keeps it.
- **Bell:** the title, body, icon, and status, which colors the icon, and
  buttons that open the record's view or edit page, a resource's list, or a
  web address, and can mark the notification as read.
- **Email:** the subject, greeting, lines before and after the button, the
  button, and the salutation.
- **The record's fields:** **+ Field** puts a field in a text, such as
  `Order {number} shipped`, or a related record's field, such as
  `{customer.name}`. Texts written with `__()` stay translated.
- **Preview:** the bell notification and the email, with sample values for the
  record's fields.
- **What it needs:** says when the database lacks the notifications table,
  with **Create it**; when no panel shows the bell, with **Turn it on**; and
  when the app's mailer is `log` or `array`, so emails aren't delivered, with
  a link to `.env`.
- **Sending it:** shows the code that sends it to every user, users with a
  role, the record's user, the signed-in user, or an email address. In the
  Filament designer, an action button sends it with **What it does > Send a
  notification**.

Each change is saved as you make it. Calls the designer doesn't write, such as
`->cc()`, and texts written as other code show as code and are kept.

## Settings designer

The settings designer creates or changes a settings class of
[spatie/laravel-settings](https://github.com/spatie/laravel-settings): app-wide
values, such as a tax rate or the site's name, kept in the database. To open
it, click **Open in Settings Designer** above a settings class, or run
**Laravel: Open Settings in Designer…**, which also offers **New Settings…**.
When the package isn't installed, the designer installs it with Composer, with
Filament's settings page plugin for your Filament version, then publishes its
migration and config and migrates, in a terminal tab.

- **Properties:** each property's name, type (text, whole number, decimal,
  yes or no, list, date and time, or one of the app's enums), and whether it
  can be null. Drag rows to reorder them. A type the designer doesn't write,
  such as a data object, shows as **In code** and stays as written.
- **Group:** the values are stored as `group.property`, such as
  `general.tax_rate`. Changing the group renames the stored values.
- **Stored values:** the value column shows what the app stores now. Change
  one and Apply updates it. A new property's value is its first value.
- **Read it in code:** `app(\App\Settings\GeneralSettings::class)->tax_rate`,
  or the class injected into a controller, job, or command, with a copy
  button. Each property's copy button copies its own line.
- **Settings page:** **Make a settings page**, or **Filament: New Settings
  Page…**, makes a Filament page with a field for each property and opens its
  form in the designer, where the settings' properties are the palette's
  columns. Settings pages are listed under **Pages** in the Designers tool
  window; right-click one to open its settings.

Changes are staged until you click **Create settings** or **Apply changes**,
with the class and the settings migration previewed. Tusk writes a new
settings migration in `database/settings` each time, with `add`, `rename`,
`delete`, and `update` calls, and never edits one that exists, since each runs
once. **Run the migration** runs `php artisan migrate` afterwards. **Add
fields to …** adds a form field for each new property to the class's settings
page. A class outside the folders the package discovers is listed in
`config/settings.php`.

## New Laravel projects and elements

**New Laravel Project…** on the welcome screen, in the **File** menu, in the
project dropdown in the title bar, or in the palette creates a
project with Laravel's own installer. Tusk keeps a copy of `laravel/installer`
in its tools folder and installs it with its bundled Composer the first time,
so nothing is installed globally. The dialog chooses:

- The folder and name. Tusk creates the folder if it doesn't exist, and `~`
  stands for your home folder.
- The starter kit: none, Livewire, React, Vue, Svelte, or a community kit by its
  package name, with Laravel's authentication, WorkOS, or none, and teams.
- The database, the test framework (Pest or PHPUnit), the front-end package
  manager, a Git repository, and Laravel Boost.
- An admin panel: Filament with its first panel and, on SQLite, a first user.

It runs in a terminal tab, where you can follow it, and the project opens when
it succeeds. With no project open, the welcome screen steps aside for the
terminal and returns when you close its tab.

**Laravel: New Element…** lists every `make:` command the project's Artisan
has, Laravel's and packages' alike, such as Filament's, Livewire's, or an MCP
server's. Choosing one opens a form built from the command's own arguments and
options, with the command line it will run, and opens the files it makes. The
model and resource generators open the model designer and the resource wizard
instead; their plain forms are listed too.

