<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class UserController extends Controller
{
    public function index()
    {
        return User::orderBy('name')->get(['id', 'name', 'role', 'is_active', 'created_at']);
    }

    public function store(Request $request)
    {
        $data = $this->validated($request, null);

        return User::create($data)->only(['id', 'name', 'role', 'is_active']);
    }

    public function update(Request $request, User $user)
    {
        $data = $this->validated($request, $user);
        if (empty($data['pin'])) {
            unset($data['pin']);
        }

        if ($user->isAdmin() && (($data['role'] ?? 'admin') !== 'admin' || ! ($data['is_active'] ?? true))) {
            $this->ensureAnotherAdmin($user);
        }

        $user->update($data);
        if (! $user->is_active) {
            $user->tokens()->delete();
        }

        return $user->only(['id', 'name', 'role', 'is_active']);
    }

    public function destroy(Request $request, User $user)
    {
        abort_if($user->id === $request->user()->id, 422, 'cannot_delete_self');
        if ($user->isAdmin()) {
            $this->ensureAnotherAdmin($user);
        }
        $user->tokens()->delete();
        $user->delete();

        return response()->noContent();
    }

    private function validated(Request $request, ?User $user): array
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:100'],
            'pin' => [$user ? 'nullable' : 'required', 'string', 'regex:/^\d{4,8}$/'],
            'role' => ['required', Rule::in(['admin', 'editor'])],
            'is_active' => ['boolean'],
        ]);

        if (! empty($data['pin']) && User::findByPin($data['pin'], $user?->id)) {
            throw ValidationException::withMessages(['pin' => 'pin_taken']);
        }

        return $data;
    }

    private function ensureAnotherAdmin(User $user): void
    {
        $others = User::where('role', 'admin')->where('is_active', true)->where('id', '!=', $user->id)->count();
        if ($others === 0) {
            throw ValidationException::withMessages(['role' => 'last_admin']);
        }
    }
}
