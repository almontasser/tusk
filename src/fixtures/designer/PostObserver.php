<?php

namespace App\Observers;

use App\Enums\PostStatus;
use App\Models\Post;
use App\Models\User;
use App\Notifications\PostPublished;
use Illuminate\Support\Facades\Notification;

class PostObserver
{
    public function created(Post $post): void
    {
        Notification::send(User::role('admin')->get(), new PostPublished($post));
    }

    public function updating(Post $post): void
    {
        if ($post->isDirty('status') && $post->status === PostStatus::Published) {
            $post->published_at = now();
        }
    }

    public function updated(Post $post): void
    {
        if ($post->wasChanged('status') && $post->status === PostStatus::Published) {
            $post->user?->notify(new PostPublished($post));
            logger()->info('Published');
        }

        // Kept as written.
        if ($post->views > 100 || $post->featured) {
            cache()->forget('popular');
        }
    }

    public function deleted(Post $post): void
    {
        if ($post->published == true && $post->views >= 10) {
            Notification::route('mail', 'ops@example.com')->notify(new PostPublished($post));
        }
    }

    public function forceDeleted(Post $post): void
    {
        //
    }
}
