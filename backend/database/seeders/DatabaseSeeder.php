<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        // First admin. Change this PIN from the Users page after the first login.
        if (! User::where('role', 'admin')->exists()) {
            User::create(['name' => 'Admin', 'pin' => '1234', 'role' => 'admin']);
        }
    }
}
