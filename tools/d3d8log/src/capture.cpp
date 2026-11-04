#include "capture.h"

#include <cstdint>
#include <cstdio>
#include <vector>

#include "log.h"

namespace {

/** CRC-32 and FNV-1a side by side: 64 bits, and both cheap to reproduce in JavaScript. */
struct Hash {
    uint32_t crc = 0xffffffffu;
    uint32_t fnv = 0x811c9dc5u;

    void add(const unsigned char* bytes, size_t length) {
        static uint32_t table[256];
        static bool ready = false;
        if (!ready) {
            for (uint32_t i = 0; i < 256; ++i) {
                uint32_t c = i;
                for (int bit = 0; bit < 8; ++bit) c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1;
                table[i] = c;
            }
            ready = true;
        }
        for (size_t i = 0; i < length; ++i) {
            crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >> 8);
            fnv = (fnv ^ bytes[i]) * 0x01000193u;
        }
    }
};

/** Bytes per row and row count for a level, or false for a format not worth guessing at. */
bool layoutOf(D3DFORMAT format, UINT width, UINT height, UINT& rowBytes, UINT& rows) {
    rows = height;
    switch (format) {
        case D3DFMT_DXT1:
            rowBytes = ((width + 3) / 4) * 8;
            rows = (height + 3) / 4;
            return true;
        case D3DFMT_DXT2:
        case D3DFMT_DXT3:
        case D3DFMT_DXT4:
        case D3DFMT_DXT5:
            rowBytes = ((width + 3) / 4) * 16;
            rows = (height + 3) / 4;
            return true;
        case D3DFMT_A8R8G8B8:
        case D3DFMT_X8R8G8B8: rowBytes = width * 4; return true;
        case D3DFMT_R8G8B8: rowBytes = width * 3; return true;
        case D3DFMT_R5G6B5:
        case D3DFMT_X1R5G5B5:
        case D3DFMT_A1R5G5B5:
        case D3DFMT_A4R4G4B4:
        case D3DFMT_X4R4G4B4:
        case D3DFMT_A8L8: rowBytes = width * 2; return true;
        case D3DFMT_A8:
        case D3DFMT_L8:
        case D3DFMT_P8: rowBytes = width; return true;
        default: return false;
    }
}

/** Hashes tightly packed rows, so that pitch, which is the driver's business, cannot matter. */
void addRows(Hash& hash, const D3DLOCKED_RECT& locked, UINT rowBytes, UINT rows) {
    const unsigned char* row = (const unsigned char*)locked.pBits;
    for (UINT y = 0; y < rows; ++y, row += locked.Pitch) hash.add(row, rowBytes);
}

void putHash(const Hash& hash) {
    log8::put("\"%08lx%08lx\"", (unsigned long)~hash.crc, (unsigned long)hash.fnv);
}

const DWORD kReadOnly = D3DLOCK_READONLY | D3DLOCK_NOSYSLOCK;

void writeFlat(IDirect3DTexture8* texture, UINT levels) {
    for (UINT level = 0; level < levels; ++level) {
        D3DSURFACE_DESC desc{};
        D3DLOCKED_RECT locked{};
        UINT rowBytes = 0, rows = 0;
        log8::put(level ? "," : "");
        if (FAILED(texture->GetLevelDesc(level, &desc)) ||
            !layoutOf(desc.Format, desc.Width, desc.Height, rowBytes, rows) ||
            FAILED(texture->LockRect(level, &locked, nullptr, kReadOnly))) {
            log8::put("null");
            continue;
        }
        Hash hash;
        addRows(hash, locked, rowBytes, rows);
        texture->UnlockRect(level);
        putHash(hash);
    }
}

/** All six faces go into one hash per level. */
void writeCube(IDirect3DCubeTexture8* texture, UINT levels) {
    for (UINT level = 0; level < levels; ++level) {
        D3DSURFACE_DESC desc{};
        UINT rowBytes = 0, rows = 0;
        log8::put(level ? "," : "");
        if (FAILED(texture->GetLevelDesc(level, &desc)) ||
            !layoutOf(desc.Format, desc.Width, desc.Height, rowBytes, rows)) {
            log8::put("null");
            continue;
        }
        Hash hash;
        bool complete = true;
        for (int face = 0; face < 6 && complete; ++face) {
            D3DLOCKED_RECT locked{};
            if (FAILED(texture->LockRect((D3DCUBEMAP_FACES)face, level, &locked, nullptr, kReadOnly))) {
                complete = false;
                break;
            }
            addRows(hash, locked, rowBytes, rows);
            texture->UnlockRect((D3DCUBEMAP_FACES)face, level);
        }
        if (complete) putHash(hash);
        else log8::put("null");
    }
}

void writeBitmap(const char* path, const D3DLOCKED_RECT& locked, UINT width, UINT height) {
    FILE* file = fopen(path, "wb");
    if (!file) return;

    const UINT stride = (width * 3 + 3) & ~3u;
    const uint32_t size = 54 + stride * height;
    unsigned char header[54]{};
    header[0] = 'B';
    header[1] = 'M';
    const auto put32 = [&](int at, uint32_t value) {
        for (int i = 0; i < 4; ++i) header[at + i] = (unsigned char)(value >> (i * 8));
    };
    put32(2, size);
    put32(10, 54);
    put32(14, 40);
    put32(18, width);
    put32(22, height);  // positive: bottom-up
    header[26] = 1;
    header[28] = 24;
    put32(34, stride * height);
    fwrite(header, 1, sizeof(header), file);

    std::vector<unsigned char> row(stride, 0);
    for (UINT y = height; y-- > 0;) {
        const unsigned char* source = (const unsigned char*)locked.pBits + (size_t)y * locked.Pitch;
        for (UINT x = 0; x < width; ++x) {
            row[x * 3] = source[x * 4];
            row[x * 3 + 1] = source[x * 4 + 1];
            row[x * 3 + 2] = source[x * 4 + 2];
        }
        fwrite(row.data(), 1, stride, file);
    }
    fclose(file);
}

void putRamp(const char* name, const WORD* ramp) {
    log8::put(",\"%s\":[", name);
    for (int i = 0; i < 256; ++i) log8::put("%s%u", i ? "," : "", (unsigned)ramp[i]);
    log8::put("]");
}

}  // namespace

namespace capture {

void writeTexture(IDirect3DBaseTexture8* texture) {
    const D3DRESOURCETYPE type = texture->GetType();
    const UINT levels = texture->GetLevelCount();

    log8::put("{\"ev\":\"texture\",\"p\":\"0x%08lx\",\"levels\":%u", (unsigned long)(uintptr_t)texture,
              levels);

    D3DSURFACE_DESC desc{};
    HRESULT described = E_FAIL;
    if (type == D3DRTYPE_TEXTURE)
        described = static_cast<IDirect3DTexture8*>(texture)->GetLevelDesc(0, &desc);
    else if (type == D3DRTYPE_CUBETEXTURE)
        described = static_cast<IDirect3DCubeTexture8*>(texture)->GetLevelDesc(0, &desc);

    log8::put(",\"type\":\"%s\"", type == D3DRTYPE_TEXTURE       ? "2d"
                                  : type == D3DRTYPE_CUBETEXTURE ? "cube"
                                                                 : "volume");
    if (SUCCEEDED(described))
        log8::put(",\"w\":%u,\"h\":%u,\"fmt\":%d,\"usage\":%lu,\"pool\":%d", desc.Width, desc.Height,
                  (int)desc.Format, (unsigned long)desc.Usage, (int)desc.Pool);

    log8::put(",\"hash\":[");
    if (type == D3DRTYPE_TEXTURE) writeFlat(static_cast<IDirect3DTexture8*>(texture), levels);
    else if (type == D3DRTYPE_CUBETEXTURE)
        writeCube(static_cast<IDirect3DCubeTexture8*>(texture), levels);
    log8::put("]}");
    log8::endLine();
}

void writeShot(IDirect3DDevice8* device, unsigned frame) {
    log8::put("{\"ev\":\"shot\",\"i\":%u", frame);

    D3DGAMMARAMP ramp{};
    device->GetGammaRamp(&ramp);
    putRamp("red", ramp.red);
    putRamp("green", ramp.green);
    putRamp("blue", ramp.blue);

    D3DDISPLAYMODE mode{};
    IDirect3DSurface8* surface = nullptr;
    HRESULT result = device->GetDisplayMode(&mode);
    if (SUCCEEDED(result))
        result = device->CreateImageSurface(mode.Width, mode.Height, D3DFMT_A8R8G8B8, &surface);
    if (SUCCEEDED(result)) result = device->GetFrontBuffer(surface);

    D3DLOCKED_RECT locked{};
    if (SUCCEEDED(result)) result = surface->LockRect(&locked, nullptr, D3DLOCK_READONLY);
    if (SUCCEEDED(result)) {
        char name[64];
        _snprintf(name, sizeof(name), "d3d8log.f%u.bmp", frame);
        name[sizeof(name) - 1] = 0;
        char path[MAX_PATH]{};
        log8::resolve(path, MAX_PATH, name);
        writeBitmap(path, locked, mode.Width, mode.Height);
        surface->UnlockRect();
        log8::put(",\"file\":\"%s\",\"w\":%u,\"h\":%u", name, mode.Width, mode.Height);
    } else {
        log8::put(",\"hr\":\"0x%08lx\"", (unsigned long)result);
    }
    if (surface) surface->Release();

    log8::put("}");
    log8::endLine();
}

}  // namespace capture
