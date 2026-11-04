/**
 * The `d3d8.dll` a game finds in its own directory before the system one.
 *
 * Forwards the four exports the real DLL has, and returns a wrapped `IDirect3D8` from
 * `Direct3DCreate8` so that everything downstream of it can be watched. Nothing here decides what
 * is interesting — that is the log's job, and the first capture is meant to be unfiltered.
 */
#include <windows.h>

#include <d3d8.h>

#include "log.h"
#include "proxy.h"

namespace {

HMODULE real = nullptr;

using Create = IDirect3D8*(WINAPI*)(UINT);
using Mute = void(WINAPI*)(BOOL);
using Validate = HRESULT(WINAPI*)(DWORD*, DWORD*, DWORD, DWORD*);

Create createReal = nullptr;
Mute muteReal = nullptr;
Validate validatePixelReal = nullptr;
Validate validateVertexReal = nullptr;

void load() {
    if (real) return;

    char path[MAX_PATH]{};
    const UINT length = GetSystemDirectoryA(path, MAX_PATH);
    if (!length || length > MAX_PATH - 12) return;
    lstrcatA(path, "\\d3d8.dll");

    real = LoadLibraryA(path);
    if (!real) return;

    // Through void*, because a FARPROC is not any of these and the compiler is right to say so.
    createReal = (Create)(void*)GetProcAddress(real, "Direct3DCreate8");
    muteReal = (Mute)(void*)GetProcAddress(real, "DebugSetMute");
    validatePixelReal = (Validate)(void*)GetProcAddress(real, "ValidatePixelShader");
    validateVertexReal = (Validate)(void*)GetProcAddress(real, "ValidateVertexShader");
}

}  // namespace

extern "C" {

IDirect3D8* WINAPI Direct3DCreate8(UINT version) {
    load();
    if (!createReal) return nullptr;

    IDirect3D8* created = createReal(version);
    if (!created) return nullptr;

    return new Direct3DProxy(created);
}

void WINAPI DebugSetMute(BOOL mute) {
    load();
    if (muteReal) muteReal(mute);
}

HRESULT WINAPI ValidatePixelShader(DWORD* shader, DWORD* reserved, DWORD flags, DWORD* result) {
    load();
    return validatePixelReal ? validatePixelReal(shader, reserved, flags, result) : E_FAIL;
}

HRESULT WINAPI ValidateVertexShader(DWORD* shader, DWORD* declaration, DWORD flags, DWORD* result) {
    load();
    return validateVertexReal ? validateVertexReal(shader, declaration, flags, result) : E_FAIL;
}

}  // extern "C"

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
    switch (reason) {
        case DLL_PROCESS_ATTACH:
            DisableThreadLibraryCalls(instance);
            log8::init();
            break;
        case DLL_PROCESS_DETACH: log8::shutdown(); break;
        default: break;
    }
    return TRUE;
}
