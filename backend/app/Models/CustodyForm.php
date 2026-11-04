<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class CustodyForm extends Model
{
    protected $fillable = ['name', 'kind', 'file_path', 'original_name', 'layout', 'is_default'];

    protected $casts = ['layout' => 'array', 'is_default' => 'boolean'];

    protected $hidden = ['file_path'];

    /** Word/Excel files are filled by replacing {{tags}}; PDF/images use the visual layout. */
    public function usesTags(): bool
    {
        return in_array($this->kind, ['docx', 'xlsx'], true);
    }
}
