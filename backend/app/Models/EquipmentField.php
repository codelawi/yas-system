<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class EquipmentField extends Model
{
    public $timestamps = false;

    protected $fillable = ['equipment_id', 'key', 'value', 'sort_order'];
}
