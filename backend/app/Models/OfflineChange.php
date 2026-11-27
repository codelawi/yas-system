<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** A change a phone made without a connection, saved when it synced, with the answer it got. */
class OfflineChange extends Model
{
    protected $fillable = ['key', 'user_id', 'synced_by', 'method', 'path', 'status', 'response', 'done_at'];

    protected $casts = ['done_at' => 'datetime', 'status' => 'integer'];
}
