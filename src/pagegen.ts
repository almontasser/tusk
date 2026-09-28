// New custom Filament pages: a form that edits one record (the signed-in user, or a model's one record, such as
// the company's settings), or a table of a model's records. Filament 4 draws a page from its `content()` schema, so
// no Blade view is needed. No editor imports, so Node tests it.
import { indentCode, phpFile, phpString } from "./phpcode.ts";

export type PageKind = "form" | "table";
export type PageSpec = {
  kind: PageKind;
  namespace: string;
  name: string;
  title: string;
  /** A Heroicon enum case, such as OutlinedCog6Tooth. */
  icon: string | null;
  model: string;
  /** For a form: whose record it edits. */
  record: "user" | "single";
  /** Form fields or table columns, as code with `{{Fqn}}` class names. */
  components: string[];
};

export const PAGE_KINDS: [PageKind, string, string][] = [
  ["form", "Form", "Edits one record: the signed-in user's profile, or a model's single record, such as the company's settings"],
  ["table", "Table", "Lists a model's records, such as overdue invoices"],
];

const list = (items: string[], indent: number) => (items.length ? `\n${items.map((c) => `${" ".repeat(indent)}${indentCode(c, " ".repeat(indent))},`).join("\n")}\n${" ".repeat(indent - 4)}` : "");

export function pageFile(s: PageSpec): string {
  const model = `{{${s.model}}}`;
  const head = [
    s.icon ? `    protected static string | {{BackedEnum}} | null $navigationIcon = {{Filament\\Support\\Icons\\Heroicon}}::${s.icon};\n` : "",
    `    protected static ?string $title = ${phpString(s.title)};\n`,
  ].join("\n");
  if (s.kind === "table")
    return phpFile(
      s.namespace,
      `class ${s.name} extends {{Filament\\Pages\\Page}} implements {{Filament\\Tables\\Contracts\\HasTable}}
{
    use {{Filament\\Tables\\Concerns\\InteractsWithTable}};

${head}
    public function table({{Filament\\Tables\\Table}} $table): {{Filament\\Tables\\Table}}
    {
        return $table
            ->query(fn (): {{Illuminate\\Database\\Eloquent\\Builder}} => ${model}::query())
            ->columns([${list(s.components, 16)}]);
    }

    public function content({{Filament\\Schemas\\Schema}} $schema): {{Filament\\Schemas\\Schema}}
    {
        return $schema
            ->components([
                {{Filament\\Schemas\\Components\\EmbeddedTable}}::make(),
            ]);
    }
}`,
    );
  const record =
    s.record === "user"
      ? `    public function getRecord(): ${model}\n    {\n        return {{Illuminate\\Support\\Facades\\Auth}}::user();\n    }`
      : `    /** The one record the page edits, made when it's first saved. */\n    public function getRecord(): ${model}\n    {\n        return ${model}::query()->firstOrNew();\n    }`;
  return phpFile(
    s.namespace,
    `/**
 * @property-read {{Filament\\Schemas\\Schema}} $form
 */
class ${s.name} extends {{Filament\\Pages\\Page}}
{
${head}
    /** @var array<string, mixed> */
    public ?array $data = [];

    public function mount(): void
    {
        $record = $this->getRecord();
        // A record that isn't saved yet starts from the fields' defaults.
        $this->form->fill($record->exists ? $record->attributesToArray() : null);
    }

${record}

    public function form({{Filament\\Schemas\\Schema}} $schema): {{Filament\\Schemas\\Schema}}
    {
        return $schema
            ->components([${list(s.components, 16)}])
            ->model($this->getRecord())
            ->statePath('data');
    }

    public function content({{Filament\\Schemas\\Schema}} $schema): {{Filament\\Schemas\\Schema}}
    {
        return $schema
            ->components([
                {{Filament\\Schemas\\Components\\Form}}::make([{{Filament\\Schemas\\Components\\EmbeddedSchema}}::make('form')])
                    ->id('form')
                    ->livewireSubmitHandler('save')
                    ->footer([
                        {{Filament\\Schemas\\Components\\Actions}}::make([
                            {{Filament\\Actions\\Action}}::make('save')
                                ->label('Save')
                                ->submit('save')
                                ->keyBindings(['mod+s']),
                        ]),
                    ]),
            ]);
    }

    public function save(): void
    {
        $record = $this->getRecord();
        $record->fill($this->form->getState())->save();
        $this->form->model($record)->saveRelationships();

        {{Filament\\Notifications\\Notification}}::make()
            ->title('Saved')
            ->success()
            ->send();
    }
}`,
  );
}
