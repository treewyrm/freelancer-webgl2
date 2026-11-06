#include "log.h"

#include <cstdarg>
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
    bool finished = false;
    if (remaining > 0) {
        put("{\"ev\":\"frame\",\"i\":%u,\"draws\":%u}", frame, draws);
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
