/**
 * Enough FVF decoding to name the fields of a captured vertex.
 *
 * Position is always at offset 0 and the stride is whatever `SetStreamSource` was given, so nothing
 * that matters for measuring a quad depends on getting this right — it decides which *extra* fields
 * get logged beside the position, and mis-decoding degrades to logging fewer of them.
 *
 * The one field it is load-bearing for is the position *type*: a `D3DFVF_XYZRHW` vertex is already
 * in screen space, which is how HUD quads are told apart from particle quads without knowing
 * anything about either.
 */
#pragma once

#include <d3d8.h>

namespace fvf {

struct Layout {
    bool transformed = false;  // D3DFVF_XYZRHW — position is already in screen space
    int positionFloats = 0;    // 3, or 4 when transformed
    int normal = -1;           // byte offset, or -1
    int diffuse = -1;          // byte offset, or -1
    int specular = -1;
    int textures = 0;
    int texture[8]{};       // byte offset per set
    int textureFloats[8]{};  // 1..4 floats per set
    int stride = 0;         // as the FVF describes it, which need not be the stream stride
};

inline Layout decode(DWORD code) {
    Layout layout;
    int at = 0;

    switch (code & D3DFVF_POSITION_MASK) {
        case D3DFVF_XYZ: layout.positionFloats = 3; at = 12; break;
        case D3DFVF_XYZRHW:
            layout.positionFloats = 4;
            layout.transformed = true;
            at = 16;
            break;
        case D3DFVF_XYZB1: layout.positionFloats = 3; at = 12 + 4; break;
        case D3DFVF_XYZB2: layout.positionFloats = 3; at = 12 + 8; break;
        case D3DFVF_XYZB3: layout.positionFloats = 3; at = 12 + 12; break;
        case D3DFVF_XYZB4: layout.positionFloats = 3; at = 12 + 16; break;
        case D3DFVF_XYZB5: layout.positionFloats = 3; at = 12 + 20; break;
        default: return layout;  // a vertex shader handle, or nothing we know
    }

    if (code & D3DFVF_NORMAL) { layout.normal = at; at += 12; }
    if (code & D3DFVF_PSIZE) at += 4;
    if (code & D3DFVF_DIFFUSE) { layout.diffuse = at; at += 4; }
    if (code & D3DFVF_SPECULAR) { layout.specular = at; at += 4; }

    layout.textures = (int)((code & D3DFVF_TEXCOUNT_MASK) >> D3DFVF_TEXCOUNT_SHIFT);
    if (layout.textures > 8) layout.textures = 8;

    for (int set = 0; set < layout.textures; ++set) {
        // Two bits per set in the high word: 0 → 2 floats, 1 → 3, 2 → 4, 3 → 1.
        static const int floats[4] = {2, 3, 4, 1};
        const int bits = (int)((code >> (16 + set * 2)) & 3);
        layout.texture[set] = at;
        layout.textureFloats[set] = floats[bits];
        at += floats[bits] * 4;
    }

    layout.stride = at;
    return layout;
}

/** Whether a handle passed to `SetVertexShader` looks like an FVF rather than a shader. */
inline bool isFVF(DWORD handle) {
    const DWORD position = handle & D3DFVF_POSITION_MASK;
    return position >= D3DFVF_XYZ && position <= D3DFVF_XYZB5;
}

inline int verticesFor(D3DPRIMITIVETYPE type, UINT primitives) {
    switch (type) {
        case D3DPT_POINTLIST: return (int)primitives;
        case D3DPT_LINELIST: return (int)primitives * 2;
        case D3DPT_LINESTRIP: return (int)primitives + 1;
        case D3DPT_TRIANGLELIST: return (int)primitives * 3;
        case D3DPT_TRIANGLESTRIP: return (int)primitives + 2;
        case D3DPT_TRIANGLEFAN: return (int)primitives + 2;
        default: return 0;
    }
}

inline const char* nameOf(D3DPRIMITIVETYPE type) {
    switch (type) {
        case D3DPT_POINTLIST: return "points";
        case D3DPT_LINELIST: return "lines";
        case D3DPT_LINESTRIP: return "linestrip";
        case D3DPT_TRIANGLELIST: return "trilist";
        case D3DPT_TRIANGLESTRIP: return "tristrip";
        case D3DPT_TRIANGLEFAN: return "trifan";
        default: return "?";
    }
}

}  // namespace fvf
