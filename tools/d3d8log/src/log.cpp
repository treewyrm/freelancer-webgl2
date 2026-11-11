#include "log.h"

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace log8 {
namespace {

Config settings{};
FILE* output = nullptr;

// Far above any real line. One that still overflows is replaced by a marker in endLine, because a
// cut line would be invalid JSON.
char line[1 << 20];
size_t used = 0;
bool overflowed = false;

unsigned frame = 0;
int remaining = 0;   // frames still to capture
bool keyWasDown = false;

LARGE_INTEGER frequency{};
LARGE_INTEGER lastPresent{};

// Freelancer.exe 1.1's frame clock (FUN_0042d770), read where the game keeps it. Its accessor
// FUN_0042d680 gives TickClientFrame (FUN_005b2890) the capped dt, or 0 while paused, after the
// tick at 0x005b3342 and before the frame, so at Present these hold the dt that frame stepped by.
struct GameClock {
    const double* elapsed;   // 0x667d38, the sum of capped dt
    const double* capped;    // 0x667d40, dt clamped to a second
    const double* raw;       // 0x667d48, dt as measured
    const unsigned* ticks;   // 0x667d50, frames ticked
    const int* paused;       // 0x667d68, pause depth: nonzero gives the frame 0
};
GameClock clock{};
bool clockResolved = false;

bool readable(const void* address, size_t size) {
    MEMORY_BASIC_INFORMATION info{};
    if (!VirtualQuery(address, &info, sizeof(info)) || info.State != MEM_COMMIT) return false;
    if (info.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return false;
    const char* end = (const char*)info.BaseAddress + info.RegionSize;
    return (const char*)address + size <= end;
}

bool codeIs(uintptr_t address, const unsigned char* bytes, size_t size) {
    return readable((const void*)address, size) && memcmp((const void*)address, bytes, size) == 0;
}

// Only on the build whose stores these are; any other leaves the frame line without them. Checked
// at the first capture, as SafeDisc decrypts .text only once the game runs.
void resolveClock() {
    clockResolved = true;
    if ((uintptr_t)GetModuleHandleA(nullptr) != 0x400000) return;
    static const unsigned char storeRaw[] = {0xdd, 0x15, 0x48, 0x7d, 0x66, 0x00};     // 0x42d7cd
    static const unsigned char storeCapped[] = {0xdd, 0x15, 0x40, 0x7d, 0x66, 0x00};  // 0x42d7fa
    static const unsigned char readPaused[] = {0xa1, 0x68, 0x7d, 0x66, 0x00};         // 0x42d680
    if (!codeIs(0x42d7cd, storeRaw, sizeof(storeRaw)) ||
        !codeIs(0x42d7fa, storeCapped, sizeof(storeCapped)) ||
        !codeIs(0x42d680, readPaused, sizeof(readPaused)) || !readable((void*)0x667d38, 0x34))
        return;
    clock = {(const double*)0x667d38, (const double*)0x667d40, (const double*)0x667d48,
             (const unsigned*)0x667d50, (const int*)0x667d68};
}

}  // namespace

void resolve(char* buffer, size_t size, const char* name) {
    char module[MAX_PATH]{};
    GetModuleFileNameA(nullptr, module, MAX_PATH);
    char* slash = strrchr(module, '\\');
    if (slash) *(slash + 1) = 0;
    else module[0] = 0;
    _snprintf(buffer, size, "%s%s", module, name);
    buffer[size - 1] = 0;
}

const Config& config() { return settings; }

void init() {
    char ini[MAX_PATH]{};
    resolve(ini, MAX_PATH, "d3d8log.ini");

    char name[MAX_PATH]{};
    GetPrivateProfileStringA("log", "file", "d3d8log.jsonl", name, MAX_PATH, ini);
    resolve(settings.file, MAX_PATH, name);

    settings.key = GetPrivateProfileIntA("log", "key", VK_F11, ini);
    settings.frames = GetPrivateProfileIntA("log", "frames", 3, ini);
    settings.vertsMax = GetPrivateProfileIntA("log", "verts_max", 64, ini);
    settings.matrices = GetPrivateProfileIntA("log", "matrices", 1, ini) != 0;
    settings.allDraws = GetPrivateProfileIntA("log", "all_draws", 1, ini) != 0;

    QueryPerformanceFrequency(&frequency);
    QueryPerformanceCounter(&lastPresent);

    output = fopen(settings.file, "wb");
    if (!output) return;

    char exe[MAX_PATH]{};
    GetModuleFileNameA(nullptr, exe, MAX_PATH);

    SYSTEMTIME now{};
    GetLocalTime(&now);

    put("{\"ev\":\"open\",\"exe\":");
    putString(exe);
    put(",\"time\":\"%04u-%02u-%02uT%02u:%02u:%02u\"", now.wYear, now.wMonth, now.wDay, now.wHour,
        now.wMinute, now.wSecond);
    put(",\"key\":%d,\"frames\":%d,\"verts_max\":%d}", settings.key, settings.frames,
        settings.vertsMax);
    endLine();
    flush();
}

void shutdown() {
    if (!output) return;
    put("{\"ev\":\"close\",\"frames\":%u}", frame);
    endLine();
    fclose(output);
    output = nullptr;
}

bool armed() { return remaining > 0; }

unsigned frameIndex() { return frame; }

bool framePresented(unsigned draws) {
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    const double wall = (double)(now.QuadPart - lastPresent.QuadPart) / (double)frequency.QuadPart;
    lastPresent = now;

    bool finished = false;
    if (remaining > 0) {
        if (!clockResolved) resolveClock();
        put("{\"ev\":\"frame\",\"i\":%u,\"draws\":%u,\"wall\":%.9g", frame, draws, wall);
        if (clock.capped)
            put(",\"dt\":%.17g,\"raw\":%.17g,\"paused\":%d,\"t\":%.17g,\"tick\":%u", *clock.capped,
                *clock.raw, *clock.paused, *clock.elapsed, *clock.ticks);
        put("}");
        endLine();
        flush();
        finished = --remaining == 0;
    }

    // Edge-triggered, so holding the key does not re-arm every frame.
    const bool down = (GetAsyncKeyState(settings.key) & 0x8000) != 0;
    if (down && !keyWasDown && !remaining && !finished) remaining = settings.frames;
    keyWasDown = down;

    ++frame;
    return finished;
}

void put(const char* format, ...) {
    va_list args;
    va_start(args, format);
    const size_t room = sizeof(line) - used - 1;
    const int written = _vsnprintf(line + used, room, format, args);
    va_end(args);
    // Negative or room-sized both mean cut, depending on the CRT.
    if (written < 0 || (size_t)written >= room) overflowed = true;
    else used += (size_t)written;
}

void putString(const char* value) {
    put("\"");
    for (const char* c = value; *c; ++c) {
        switch (*c) {
            case '"': put("\\\""); break;
            case '\\': put("\\\\"); break;
            case '\n': put("\\n"); break;
            case '\r': put("\\r"); break;
            case '\t': put("\\t"); break;
            default:
                if ((unsigned char)*c < 0x20) put("\\u%04x", (unsigned)(unsigned char)*c);
                else put("%c", *c);
        }
    }
    put("\"");
}

void endLine() {
    if (output && used) {
        line[used] = 0;
        if (overflowed) fputs("{\"ev\":\"truncated\"}", output);
        else fputs(line, output);
        fputc('\n', output);
    }
    used = 0;
    overflowed = false;
}

void flush() {
    if (output) fflush(output);
}

}  // namespace log8
