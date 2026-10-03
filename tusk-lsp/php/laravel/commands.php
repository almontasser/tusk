<?php

// The app's Artisan commands, by name and alias, with what their signatures take, and the options every command
// takes from the application, such as `--env` and `--quiet`.

$artisan = app(Illuminate\Contracts\Console\Kernel::class);
$all = $artisan->all();

$argument = fn (Symfony\Component\Console\Input\InputArgument $a) => [
    'name'        => $a->getName(),
    'required'    => $a->isRequired(),
    'array'       => $a->isArray(),
    'description' => $a->getDescription(),
];

$option = fn (Symfony\Component\Console\Input\InputOption $o) => [
    'name'        => $o->getName(),
    'shortcut'    => $o->getShortcut(),
    'value'       => $o->acceptValue(),
    'array'       => $o->isArray(),
    'description' => $o->getDescription(),
];

$commands = [];

foreach ($all as $name => $command) {
    $reflected = new ReflectionClass($command);
    $file = $reflected->getFileName() ?: null;
    $line = $file ? $reflected->getStartLine() : null;
    $definition = $command->getDefinition();

    // A command `Artisan::command()` defines, as in `routes/console.php`: where its closure is.
    if ($command instanceof Illuminate\Foundation\Console\ClosureCommand) {
        $callback = (fn () => $this->callback)->call($command);
        $closure = new ReflectionFunction($callback);
        $file = $closure->getFileName() ?: null;
        $line = $file ? $closure->getStartLine() : null;
    }

    $commands[] = [
        'name'        => $name,
        'alias'       => $name !== $command->getName(),
        'description' => $command->getDescription(),
        'hidden'      => $command->isHidden(),
        'class'       => $reflected->getName(),
        'path'        => $file ? LspHelper::relativePath($file) : null,
        'line'        => $line,
        'arguments'   => array_map($argument, array_values($definition->getArguments())),
        'options'     => array_map($option, array_values($definition->getOptions())),
    ];
}

$application = collect($all)->first()?->getApplication();

echo json_encode([
    'commands' => $commands,
    'global'   => $application ? array_map($option, array_values($application->getDefinition()->getOptions())) : [],
]);
