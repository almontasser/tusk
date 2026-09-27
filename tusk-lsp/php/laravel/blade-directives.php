<?php

use Illuminate\View\Compilers\BladeCompiler;

echo collect(app(BladeCompiler::class)->getCustomDirectives())
    ->map(function (mixed $customDirective, string $name): ?array {
        if ($customDirective instanceof Closure) {
            return [
                'name'      => $name,
                'hasParams' => (new ReflectionFunction($customDirective))->getNumberOfParameters() >= 1,
            ];
        }

        if (is_array($customDirective)) {
            return [
                'name'      => $name,
                'hasParams' => (new ReflectionMethod($customDirective[0], $customDirective[1]))->getNumberOfParameters() >= 1,
            ];
        }

        return null;
    })
    ->filter()
    ->values()
    ->toJson();
