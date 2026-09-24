#!/bin/sh
# Creates fixtures/demo: a Laravel 12 app with Filament 4 and a small blog
# domain, used to test navigation, rename, and Filament features by hand.
set -eu
cd "$(dirname "$0")/.."
[ -d fixtures/demo ] && { echo "fixtures/demo already exists"; exit 0; }
mkdir -p fixtures
composer create-project --no-interaction laravel/laravel:^12 fixtures/demo
cd fixtures/demo
composer require --no-interaction filament/filament:^4
php artisan filament:install --panels --no-interaction

cat > app/Models/Author.php <<'PHP'
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Author extends Model
{
    protected $fillable = ['name'];

    public function posts(): HasMany
    {
        return $this->hasMany(Post::class);
    }
}
PHP

cat > app/Models/Post.php <<'PHP'
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Post extends Model
{
    protected $fillable = ['title', 'body', 'published', 'author_id'];

    public function author(): BelongsTo
    {
        return $this->belongsTo(Author::class);
    }

    public function scopePublished(Builder $query): Builder
    {
        return $query->where('published', true);
    }
}
PHP

cat > database/migrations/2026_01_01_000000_create_blog_tables.php <<'PHP'
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('authors', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->timestamps();
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('author_id')->constrained();
            $table->string('title');
            $table->text('body');
            $table->boolean('published')->default(false);
            $table->timestamps();
        });
    }
};
PHP

php artisan migrate --no-interaction
php artisan make:filament-resource Post --generate --no-interaction
php artisan make:filament-resource Author --generate --no-interaction
php artisan make:filament-relation-manager AuthorResource posts title --no-interaction
php -r '$f = "app/Filament/Resources/Authors/AuthorResource.php"; $s = file_get_contents($f);
  $s = str_replace("use App\\Models\\Author;", "use App\\Filament\\Resources\\Authors\\RelationManagers\\PostsRelationManager;\nuse App\\Models\\Author;", $s);
  file_put_contents($f, preg_replace("/(getRelations\(\): array\s*\{\s*return \[)\s*\/\/\s*/", "$1\n            PostsRelationManager::class,\n        ", $s));'

# Pest, which also runs the PHPUnit tests, with one Pest test file.
composer require pestphp/pest pestphp/pest-plugin-laravel --dev --with-all-dependencies --no-interaction
cat > tests/Pest.php <<'PHP'
<?php

pest()->extend(Tests\TestCase::class)->in('Feature');
PHP
cat > tests/Feature/PostTest.php <<'PHP'
<?php

use App\Models\Post;

it('has a fillable title', function () {
    expect((new Post)->isFillable('title'))->toBeTrue();
});

describe('home page', function () {
    it('loads', function () {
        $this->get('/')->assertOk();
    });
});
PHP

# Its own repository, for testing the git features.
git init --quiet --initial-branch=main
git add --all
git -c user.name="Fixture" -c user.email="fixture@example.com" commit --quiet -m "Initial commit"
