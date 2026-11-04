<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    public function login(Request $request)
    {
        $data = $request->validate(['pin' => ['required', 'string', 'max:20']]);

        $user = User::findByPin($data['pin']);
        if (! $user || ! $user->is_active) {
            throw ValidationException::withMessages(['pin' => 'wrong_pin']);
        }

        $token = $user->createToken('pin', ['*'], now()->addMinutes((int) config('sanctum.expiration', 720)));

        return ['token' => $token->plainTextToken, 'user' => $this->userPayload($user)];
    }

    public function me(Request $request)
    {
        return ['user' => $this->userPayload($request->user())];
    }

    public function logout(Request $request)
    {
        $request->user()->currentAccessToken()?->delete();

        return response()->noContent();
    }

    private function userPayload(User $user): array
    {
        return ['id' => $user->id, 'name' => $user->name, 'role' => $user->role];
    }
}
