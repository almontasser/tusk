<?php

namespace App\Enums;

enum Status: string
{
    case Draft = 'draft';
    // Shown to editors only.
    case Review = 'review';

    const DEFAULT = self::Draft;

    case Published = 'published';
}
