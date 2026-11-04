#include "proxy.h"

#include <algorithm>
#include <cstdint>
#include <cstring>

#include "capture.h"
#include "fvf.h"
#include "log.h"

namespace {

// Nine significant digits round-trip a float32, which the frame comparison depends on.
void putMatrix(const char* name, const D3DMATRIX& m) {
    log8::put(",\"%s\":[", name);
    for (int row = 0; row < 4; ++row)
        for (int column = 0; column < 4; ++column)
            log8::put("%s%.9g", (row || column) ? "," : "", (double)m.m[row][column]);
    log8::put("]");
}

void putColour(const char* name, const D3DCOLORVALUE& c) {
    log8::put("\"%s\":[%.9g,%.9g,%.9g,%.9g]", name, (double)c.r, (double)c.g, (double)c.b,
              (double)c.a);
}

void putVector(const char* name, const D3DVECTOR& v) {
    log8::put("\"%s\":[%.9g,%.9g,%.9g]", name, (double)v.x, (double)v.y, (double)v.z);
}

float asFloat(DWORD value) {
    float result = 0;
    memcpy(&result, &value, 4);
    return result;
}

struct RenderState {
    const char* name;
    D3DRENDERSTATETYPE state;
    bool isFloat;
};

#define RS(name) {#name, D3DRS_##name, false}
#define RSF(name) {#name, D3DRS_##name, true}

// Every D3D8 render state except LINEPATTERN and the debug token, which change nothing in a frame.
const RenderState kRenderStates[] = {
    RS(ZENABLE), RS(FILLMODE), RS(SHADEMODE), RS(ZWRITEENABLE), RS(ALPHATESTENABLE), RS(LASTPIXEL),
    RS(SRCBLEND), RS(DESTBLEND), RS(CULLMODE), RS(ZFUNC), RS(ALPHAREF), RS(ALPHAFUNC),
    RS(DITHERENABLE), RS(ALPHABLENDENABLE), RS(FOGENABLE), RS(SPECULARENABLE), RS(ZVISIBLE),
    RS(FOGCOLOR), RS(FOGTABLEMODE), RSF(FOGSTART), RSF(FOGEND), RSF(FOGDENSITY), RS(EDGEANTIALIAS),
    RS(ZBIAS), RS(RANGEFOGENABLE), RS(STENCILENABLE), RS(STENCILFAIL), RS(STENCILZFAIL),
    RS(STENCILPASS), RS(STENCILFUNC), RS(STENCILREF), RS(STENCILMASK), RS(STENCILWRITEMASK),
    RS(TEXTUREFACTOR), RS(WRAP0), RS(WRAP1), RS(WRAP2), RS(WRAP3), RS(WRAP4), RS(WRAP5), RS(WRAP6),
    RS(WRAP7), RS(CLIPPING), RS(LIGHTING), RS(AMBIENT), RS(FOGVERTEXMODE), RS(COLORVERTEX),
    RS(LOCALVIEWER), RS(NORMALIZENORMALS), RS(DIFFUSEMATERIALSOURCE), RS(SPECULARMATERIALSOURCE),
    RS(AMBIENTMATERIALSOURCE), RS(EMISSIVEMATERIALSOURCE), RS(VERTEXBLEND), RS(CLIPPLANEENABLE),
    RS(SOFTWAREVERTEXPROCESSING), RSF(POINTSIZE), RSF(POINTSIZE_MIN), RS(POINTSPRITEENABLE),
    RS(POINTSCALEENABLE), RSF(POINTSCALE_A), RSF(POINTSCALE_B), RSF(POINTSCALE_C),
    RS(MULTISAMPLEANTIALIAS), RS(MULTISAMPLEMASK), RS(PATCHEDGESTYLE), RSF(PATCHSEGMENTS),
    RSF(POINTSIZE_MAX), RS(INDEXEDVERTEXBLENDENABLE), RS(COLORWRITEENABLE), RSF(TWEENFACTOR),
    RS(BLENDOP), RS(POSITIONORDER), RS(NORMALORDER),
};

struct StageState {
    const char* name;
    D3DTEXTURESTAGESTATETYPE state;
    bool isFloat;
};

#define TS(name) {#name, D3DTSS_##name, false}
#define TSF(name) {#name, D3DTSS_##name, true}

const StageState kStageStates[] = {
    TS(COLOROP), TS(COLORARG1), TS(COLORARG2), TS(COLORARG0), TS(ALPHAOP), TS(ALPHAARG1),
    TS(ALPHAARG2), TS(ALPHAARG0), TS(RESULTARG), TSF(BUMPENVMAT00), TSF(BUMPENVMAT01),
    TSF(BUMPENVMAT10), TSF(BUMPENVMAT11), TS(TEXCOORDINDEX), TS(ADDRESSU), TS(ADDRESSV),
    TS(ADDRESSW), TS(BORDERCOLOR), TS(MAGFILTER), TS(MINFILTER), TS(MIPFILTER), TSF(MIPMAPLODBIAS),
    TS(MAXMIPLEVEL), TS(MAXANISOTROPY), TSF(BUMPENVLSCALE), TSF(BUMPENVLOFFSET),
    TS(TEXTURETRANSFORMFLAGS),
};

const DWORD kStages = 8;  // D3D8's limit

}  // namespace

// ---------------------------------------------------------------------------------------------
// Shadow

void Shadow::begin(UINT offset, UINT size, unsigned char* pointer) {
    lockOffset = offset;
    lockSize = size;
    lockPointer = pointer;
}

void Shadow::end() {
    if (!lockPointer || bytes.empty()) {
        lockPointer = nullptr;
        return;
    }
    const UINT length = (UINT)bytes.size();
    UINT offset = lockOffset < length ? lockOffset : length;
    UINT size = lockSize ? lockSize : length - offset;
    if (offset + size > length) size = length - offset;
    // Reading back through the game's own mapped pointer, which is this process's memory and holds
    // exactly what was just written — unlike a read-only lock of a WRITEONLY buffer, which is not
    // defined to hold anything at all.
    if (size) memcpy(bytes.data() + offset, lockPointer, size);
    lockPointer = nullptr;
}

// ---------------------------------------------------------------------------------------------
// VertexBufferProxy

VertexBufferProxy::VertexBufferProxy(IDirect3DVertexBuffer8* real, DeviceProxy* owner, UINT length,
                                     DWORD usage, DWORD fvf, D3DPOOL pool)
    : real_(real), owner_(owner), length_(length), usage_(usage), fvf_(fvf), pool_(pool) {
    shadow_.reserve(length);
}

VertexBufferProxy::~VertexBufferProxy() {
    if (owner_) owner_->forget(this);
}

HRESULT STDMETHODCALLTYPE VertexBufferProxy::QueryInterface(REFIID riid, void** object) {
    const HRESULT result = real_->QueryInterface(riid, object);
    if (SUCCEEDED(result) && object && *object == real_) *object = this;
    return result;
}

ULONG STDMETHODCALLTYPE VertexBufferProxy::AddRef() { return real_->AddRef(); }

ULONG STDMETHODCALLTYPE VertexBufferProxy::Release() {
    const ULONG count = real_->Release();
    if (!count) delete this;
    return count;
}

HRESULT STDMETHODCALLTYPE VertexBufferProxy::GetDevice(IDirect3DDevice8** device) {
    if (device && owner_) {
        owner_->AddRef();
        *device = owner_;
        return D3D_OK;
    }
    return real_->GetDevice(device);
}

HRESULT STDMETHODCALLTYPE VertexBufferProxy::Lock(UINT offset, UINT size, BYTE** data,
                                                  DWORD flags) {
    const HRESULT result = real_->Lock(offset, size, data, flags);
    if (SUCCEEDED(result) && data) shadow_.begin(offset, size, *data);
    return result;
}

HRESULT STDMETHODCALLTYPE VertexBufferProxy::Unlock() {
    shadow_.end();
    return real_->Unlock();
}

// ---------------------------------------------------------------------------------------------
// IndexBufferProxy

IndexBufferProxy::IndexBufferProxy(IDirect3DIndexBuffer8* real, DeviceProxy* owner, UINT length,
                                   DWORD usage, D3DFORMAT format, D3DPOOL pool)
    : real_(real), owner_(owner), length_(length), usage_(usage), format_(format), pool_(pool) {
    shadow_.reserve(length);
}

IndexBufferProxy::~IndexBufferProxy() {
    if (owner_) owner_->forget(this);
}

HRESULT STDMETHODCALLTYPE IndexBufferProxy::QueryInterface(REFIID riid, void** object) {
    const HRESULT result = real_->QueryInterface(riid, object);
    if (SUCCEEDED(result) && object && *object == real_) *object = this;
    return result;
}

ULONG STDMETHODCALLTYPE IndexBufferProxy::AddRef() { return real_->AddRef(); }

ULONG STDMETHODCALLTYPE IndexBufferProxy::Release() {
    const ULONG count = real_->Release();
    if (!count) delete this;
    return count;
}

HRESULT STDMETHODCALLTYPE IndexBufferProxy::GetDevice(IDirect3DDevice8** device) {
    if (device && owner_) {
        owner_->AddRef();
        *device = owner_;
        return D3D_OK;
    }
    return real_->GetDevice(device);
}

HRESULT STDMETHODCALLTYPE IndexBufferProxy::Lock(UINT offset, UINT size, BYTE** data, DWORD flags) {
    const HRESULT result = real_->Lock(offset, size, data, flags);
    if (SUCCEEDED(result) && data) shadow_.begin(offset, size, *data);
    return result;
}

HRESULT STDMETHODCALLTYPE IndexBufferProxy::Unlock() {
    shadow_.end();
    return real_->Unlock();
}

// ---------------------------------------------------------------------------------------------
// DeviceProxy

DeviceProxy::DeviceProxy(IDirect3DDevice8* real, IDirect3D8* parent)
    : real_(real), parent_(parent) {}

void DeviceProxy::forget(VertexBufferProxy* buffer) {
    if (streams_.stream == buffer) streams_.stream = nullptr;
}

void DeviceProxy::forget(IndexBufferProxy* buffer) {
    if (streams_.indices == buffer) streams_.indices = nullptr;
}

HRESULT STDMETHODCALLTYPE DeviceProxy::QueryInterface(REFIID riid, void** object) {
    const HRESULT result = real_->QueryInterface(riid, object);
    if (SUCCEEDED(result) && object && *object == real_) *object = this;
    return result;
}

ULONG STDMETHODCALLTYPE DeviceProxy::AddRef() { return real_->AddRef(); }

ULONG STDMETHODCALLTYPE DeviceProxy::Release() {
    const ULONG count = real_->Release();
    if (!count) delete this;
    return count;
}

HRESULT STDMETHODCALLTYPE DeviceProxy::GetDirect3D(IDirect3D8** d3d) {
    if (d3d && parent_) {
        parent_->AddRef();
        *d3d = parent_;
        return D3D_OK;
    }
    return real_->GetDirect3D(d3d);
}

void DeviceProxy::releaseSeen() {
    for (IDirect3DBaseTexture8* texture : seen_) texture->Release();
    seen_.clear();
}

HRESULT STDMETHODCALLTYPE DeviceProxy::Reset(D3DPRESENT_PARAMETERS* parameters) {
    streams_ = Streams{};
    releaseSeen();
    if (parameters) {
        log8::put("{\"ev\":\"reset\",\"i\":%u,\"w\":%lu,\"h\":%lu,\"windowed\":%d}",
                  log8::frameIndex(), (unsigned long)parameters->BackBufferWidth,
                  (unsigned long)parameters->BackBufferHeight, parameters->Windowed ? 1 : 0);
        log8::endLine();
    }
    return real_->Reset(parameters);
}

HRESULT STDMETHODCALLTYPE DeviceProxy::BeginScene() {
    if (log8::armed()) {
        log8::put("{\"ev\":\"scene\",\"i\":%u,\"n\":%u,\"at\":\"begin\"}", log8::frameIndex(), draws_);
        log8::endLine();
    }
    return real_->BeginScene();
}

HRESULT STDMETHODCALLTYPE DeviceProxy::EndScene() {
    if (log8::armed()) {
        log8::put("{\"ev\":\"scene\",\"i\":%u,\"n\":%u,\"at\":\"end\"}", log8::frameIndex(), draws_);
        log8::endLine();
    }
    return real_->EndScene();
}

HRESULT STDMETHODCALLTYPE DeviceProxy::Clear(DWORD count, const D3DRECT* rects, DWORD flags,
                                             D3DCOLOR colour, float z, DWORD stencil) {
    if (log8::armed()) {
        D3DVIEWPORT8 viewport{};
        real_->GetViewport(&viewport);
        log8::put("{\"ev\":\"clear\",\"i\":%u,\"n\":%u,\"flags\":%lu,\"colour\":\"0x%08lx\"",
                  log8::frameIndex(), draws_, (unsigned long)flags, (unsigned long)colour);
        log8::put(",\"z\":%.9g,\"stencil\":%lu,\"rects\":%lu", (double)z, (unsigned long)stencil,
                  (unsigned long)count);
        log8::put(",\"viewport\":[%lu,%lu,%lu,%lu,%.9g,%.9g]}", (unsigned long)viewport.X,
                  (unsigned long)viewport.Y, (unsigned long)viewport.Width,
                  (unsigned long)viewport.Height, (double)viewport.MinZ, (double)viewport.MaxZ);
        log8::endLine();
    }
    return real_->Clear(count, rects, flags, colour, z, stencil);
}

HRESULT STDMETHODCALLTYPE DeviceProxy::SetRenderTarget(IDirect3DSurface8* target,
                                                       IDirect3DSurface8* stencil) {
    if (log8::armed()) {
        log8::put("{\"ev\":\"target\",\"i\":%u,\"n\":%u,\"target\":\"0x%08lx\",\"depth\":\"0x%08lx\"}",
                  log8::frameIndex(), draws_, (unsigned long)(uintptr_t)target,
                  (unsigned long)(uintptr_t)stencil);
        log8::endLine();
    }
    return real_->SetRenderTarget(target, stencil);
}

HRESULT STDMETHODCALLTYPE DeviceProxy::CopyRects(IDirect3DSurface8* source, const RECT* sourceRects,
                                                 UINT count, IDirect3DSurface8* destination,
                                                 const POINT* points) {
    if (log8::armed()) {
        log8::put("{\"ev\":\"copy\",\"i\":%u,\"n\":%u,\"rects\":%u}", log8::frameIndex(), draws_,
                  count);
        log8::endLine();
    }
    return real_->CopyRects(source, sourceRects, count, destination, points);
}

HRESULT STDMETHODCALLTYPE DeviceProxy::Present(const RECT* source, const RECT* destination,
                                               HWND window, const RGNDATA* dirty) {
    const unsigned frame = log8::frameIndex();
    const bool finished = log8::framePresented(draws_);
    draws_ = 0;
    const HRESULT result = real_->Present(source, destination, window, dirty);
    if (finished) {
        capture::writeShot(real_, frame);
        releaseSeen();
        log8::flush();
    }
    return result;
}

HRESULT STDMETHODCALLTYPE DeviceProxy::CreateVertexBuffer(UINT length, DWORD usage, DWORD fvf,
                                                          D3DPOOL pool,
                                                          IDirect3DVertexBuffer8** buffer) {
    IDirect3DVertexBuffer8* created = nullptr;
    const HRESULT result = real_->CreateVertexBuffer(length, usage, fvf, pool, &created);
    if (FAILED(result) || !created) return result;
    if (buffer) *buffer = new VertexBufferProxy(created, this, length, usage, fvf, pool);
    return result;
}

HRESULT STDMETHODCALLTYPE DeviceProxy::CreateIndexBuffer(UINT length, DWORD usage, D3DFORMAT format,
                                                         D3DPOOL pool,
                                                         IDirect3DIndexBuffer8** buffer) {
    IDirect3DIndexBuffer8* created = nullptr;
    const HRESULT result = real_->CreateIndexBuffer(length, usage, format, pool, &created);
    if (FAILED(result) || !created) return result;
    if (buffer) *buffer = new IndexBufferProxy(created, this, length, usage, format, pool);
    return result;
}

HRESULT STDMETHODCALLTYPE DeviceProxy::SetStreamSource(UINT stream, IDirect3DVertexBuffer8* buffer,
                                                       UINT stride) {
    VertexBufferProxy* proxy = static_cast<VertexBufferProxy*>(buffer);
    if (stream == 0) {
        streams_.stream = proxy;
        streams_.stride = stride;
    }
    return real_->SetStreamSource(stream, proxy ? proxy->real() : nullptr, stride);
}

HRESULT STDMETHODCALLTYPE DeviceProxy::GetStreamSource(UINT stream, IDirect3DVertexBuffer8** buffer,
                                                       UINT* stride) {
    // Handing back the real buffer would let the game set a stream this cannot shadow, so the
    // proxy is returned and reference counting stays consistent with what was handed out.
    if (stream == 0 && buffer && streams_.stream) {
        streams_.stream->AddRef();
        *buffer = streams_.stream;
        if (stride) *stride = streams_.stride;
        return D3D_OK;
    }
    return real_->GetStreamSource(stream, buffer, stride);
}

HRESULT STDMETHODCALLTYPE DeviceProxy::SetIndices(IDirect3DIndexBuffer8* buffer, UINT baseVertex) {
    IndexBufferProxy* proxy = static_cast<IndexBufferProxy*>(buffer);
    streams_.indices = proxy;
    streams_.baseVertex = baseVertex;
    return real_->SetIndices(proxy ? proxy->real() : nullptr, baseVertex);
}

HRESULT STDMETHODCALLTYPE DeviceProxy::GetIndices(IDirect3DIndexBuffer8** buffer,
                                                  UINT* baseVertex) {
    if (buffer && streams_.indices) {
        streams_.indices->AddRef();
        *buffer = streams_.indices;
        if (baseVertex) *baseVertex = streams_.baseVertex;
        return D3D_OK;
    }
    return real_->GetIndices(buffer, baseVertex);
}

HRESULT STDMETHODCALLTYPE DeviceProxy::ProcessVertices(UINT start, UINT destination, UINT count,
                                                       IDirect3DVertexBuffer8* buffer,
                                                       DWORD flags) {
    VertexBufferProxy* proxy = static_cast<VertexBufferProxy*>(buffer);
    return real_->ProcessVertices(start, destination, count, proxy ? proxy->real() : nullptr,
                                  flags);
}

/** Writes a `texture` line for each bound texture this capture has not described yet. */
void DeviceProxy::noteTextures() {
    for (DWORD stage = 0; stage < kStages; ++stage) {
        IDirect3DBaseTexture8* texture = nullptr;
        if (FAILED(real_->GetTexture(stage, &texture)) || !texture) continue;
        if (std::find(seen_.begin(), seen_.end(), texture) == seen_.end()) {
            capture::writeTexture(texture);
            seen_.push_back(texture);  // keeps the reference GetTexture added
        } else {
            texture->Release();
        }
    }
}

void DeviceProxy::writeLights() {
    log8::put(",\"lights\":[");
    bool first = true;
    for (DWORD index = 0; index <= lastLight_; ++index) {
        WINBOOL enabled = FALSE;
        D3DLIGHT8 light{};
        if (FAILED(real_->GetLightEnable(index, &enabled)) || !enabled) continue;
        if (FAILED(real_->GetLight(index, &light))) continue;

        log8::put("%s{\"index\":%lu,\"type\":%d,", first ? "" : ",", (unsigned long)index,
                  (int)light.Type);
        first = false;
        putColour("diffuse", light.Diffuse);
        log8::put(",");
        putColour("specular", light.Specular);
        log8::put(",");
        putColour("ambient", light.Ambient);
        log8::put(",");
        putVector("position", light.Position);
        log8::put(",");
        putVector("direction", light.Direction);
        log8::put(",\"range\":%.9g,\"falloff\":%.9g,\"attenuation\":[%.9g,%.9g,%.9g]",
                  (double)light.Range, (double)light.Falloff, (double)light.Attenuation0,
                  (double)light.Attenuation1, (double)light.Attenuation2);
        log8::put(",\"theta\":%.9g,\"phi\":%.9g}", (double)light.Theta, (double)light.Phi);
    }
    log8::put("]");
}

void DeviceProxy::writeStages() {
    log8::put(",\"stages\":[");
    for (DWORD stage = 0; stage < kStages; ++stage) {
        IDirect3DBaseTexture8* texture = nullptr;
        real_->GetTexture(stage, &texture);
        if (texture) {
            log8::put("%s{\"texture\":\"0x%08lx\"", stage ? "," : "",
                      (unsigned long)(uintptr_t)texture);
            texture->Release();
        } else {
            log8::put("%s{\"texture\":null", stage ? "," : "");
        }

        DWORD transformFlags = 0;
        for (const StageState& entry : kStageStates) {
            DWORD value = 0;
            real_->GetTextureStageState(stage, entry.state, &value);
            if (entry.state == D3DTSS_TEXTURETRANSFORMFLAGS) transformFlags = value;
            if (entry.isFloat) log8::put(",\"%s\":%.9g", entry.name, (double)asFloat(value));
            else log8::put(",\"%s\":%lu", entry.name, (unsigned long)value);
        }

        if (transformFlags) {
            D3DMATRIX matrix{};
            real_->GetTransform((D3DTRANSFORMSTATETYPE)(D3DTS_TEXTURE0 + stage), &matrix);
            putMatrix("transform", matrix);
        }
        log8::put("}");
    }
    log8::put("]");
}

void DeviceProxy::writeState(UINT stride) {
    DWORD vertexShader = 0, pixelShader = 0;
    real_->GetVertexShader(&vertexShader);
    real_->GetPixelShader(&pixelShader);
    log8::put(",\"fvf\":\"0x%08lx\",\"ps\":\"0x%08lx\",\"stride\":%u", (unsigned long)vertexShader,
              (unsigned long)pixelShader, stride);

    log8::put(",\"rs\":{");
    bool first = true;
    DWORD clipPlanes = 0;
    for (const RenderState& entry : kRenderStates) {
        DWORD value = 0;
        real_->GetRenderState(entry.state, &value);
        if (entry.state == D3DRS_CLIPPLANEENABLE) clipPlanes = value;
        if (entry.isFloat)
            log8::put("%s\"%s\":%.9g", first ? "" : ",", entry.name, (double)asFloat(value));
        else log8::put("%s\"%s\":%lu", first ? "" : ",", entry.name, (unsigned long)value);
        first = false;
    }
    log8::put("}");

    if (log8::config().matrices) {
        D3DMATRIX matrix{};
        real_->GetTransform(D3DTS_WORLD, &matrix);
        putMatrix("world", matrix);
        real_->GetTransform(D3DTS_VIEW, &matrix);
        putMatrix("view", matrix);
        real_->GetTransform(D3DTS_PROJECTION, &matrix);
        putMatrix("proj", matrix);
    }

    D3DVIEWPORT8 viewport{};
    real_->GetViewport(&viewport);
    log8::put(",\"viewport\":[%lu,%lu,%lu,%lu,%.9g,%.9g]", (unsigned long)viewport.X,
              (unsigned long)viewport.Y, (unsigned long)viewport.Width,
              (unsigned long)viewport.Height, (double)viewport.MinZ, (double)viewport.MaxZ);

    D3DMATERIAL8 material{};
    real_->GetMaterial(&material);
    log8::put(",\"material\":{");
    putColour("diffuse", material.Diffuse);
    log8::put(",");
    putColour("ambient", material.Ambient);
    log8::put(",");
    putColour("specular", material.Specular);
    log8::put(",");
    putColour("emissive", material.Emissive);
    log8::put(",\"power\":%.9g}", (double)material.Power);

    writeLights();
    writeStages();

    if (clipPlanes) {
        log8::put(",\"clip\":[");
        bool firstPlane = true;
        for (DWORD index = 0; index < 32; ++index) {
            if (!(clipPlanes & (1u << index))) continue;
            float plane[4]{};
            real_->GetClipPlane(index, plane);
            log8::put("%s[%.9g,%.9g,%.9g,%.9g]", firstPlane ? "" : ",", (double)plane[0],
                      (double)plane[1], (double)plane[2], (double)plane[3]);
            firstPlane = false;
        }
        log8::put("]");
    }
}

void DeviceProxy::writeVertices(const unsigned char* base, UINT stride, int count, DWORD code) {
    const fvf::Layout layout = fvf::decode(code);
    log8::put(",\"pos\":\"%s\"", layout.transformed ? "screen" : "model");
    log8::put(",\"v\":[");

    for (int index = 0; index < count; ++index) {
        const unsigned char* vertex = base + (size_t)stride * (size_t)index;
        const float* position = (const float*)vertex;

        log8::put("%s{\"p\":[%.9g,%.9g,%.9g", index ? "," : "", (double)position[0],
                  (double)position[1], (double)position[2]);
        if (layout.transformed) log8::put(",%.9g", (double)position[3]);
        log8::put("]");

        if (layout.normal >= 0 && layout.normal + 12 <= (int)stride) {
            float normal[3];
            memcpy(normal, vertex + layout.normal, 12);
            log8::put(",\"n\":[%.9g,%.9g,%.9g]", (double)normal[0], (double)normal[1],
                      (double)normal[2]);
        }

        if (layout.diffuse >= 0 && layout.diffuse + 4 <= (int)stride) {
            DWORD colour = 0;
            memcpy(&colour, vertex + layout.diffuse, 4);
            log8::put(",\"d\":\"0x%08lx\"", (unsigned long)colour);
        }

        for (int set = 0; set < layout.textures; ++set) {
            const int at = layout.texture[set];
            const int floats = layout.textureFloats[set];
            if (at + floats * 4 > (int)stride) break;
            log8::put(",\"t%d\":[", set);
            for (int component = 0; component < floats; ++component) {
                float value = 0;
                memcpy(&value, vertex + at + component * 4, 4);
                log8::put("%s%.9g", component ? "," : "", (double)value);
            }
            log8::put("]");
        }

        log8::put("}");
    }

    log8::put("]");
}

void DeviceProxy::note(const Draw& draw) {
    const bool dumpable = draw.vertices && draw.stride && draw.vertexCount > 0 &&
                          draw.vertexCount <= log8::config().vertsMax;
    if (!dumpable && !log8::config().allDraws) return;

    noteTextures();

    log8::put("{\"ev\":\"draw\",\"i\":%u,\"n\":%u,\"call\":\"%s\"", log8::frameIndex(), draws_,
              draw.call);
    log8::put(",\"prim\":\"%s\",\"prims\":%u,\"verts\":%d,\"indices\":%u", fvf::nameOf(draw.type),
              draw.primitives, draw.vertexCount, draw.indexCount);
    if (draw.indexed)
        log8::put(",\"minIndex\":%u,\"startIndex\":%u,\"baseVertex\":%u", draw.minIndex,
                  draw.startIndex, draw.baseVertex);
    writeState(draw.stride);

    if (draw.indices && draw.indexCount) {
        const bool wide = draw.indexFormat == D3DFMT_INDEX32;
        log8::put(",\"idx\":[");
        for (UINT index = 0; index < draw.indexCount && index < 1024; ++index) {
            unsigned long value = wide ? ((const unsigned long*)draw.indices)[index]
                                       : ((const unsigned short*)draw.indices)[index];
            log8::put("%s%lu", index ? "," : "", value);
        }
        log8::put("]");
    }

    if (dumpable) {
        DWORD code = 0;
        real_->GetVertexShader(&code);
        writeVertices(draw.vertices, draw.stride, draw.vertexCount, code);
    }

    log8::put("}");
    log8::endLine();
}

HRESULT STDMETHODCALLTYPE DeviceProxy::DrawPrimitive(D3DPRIMITIVETYPE type, UINT start,
                                                     UINT primitives) {
    if (log8::armed()) {
        const int count = fvf::verticesFor(type, primitives);
        const unsigned char* base = nullptr;
        if (streams_.stream && streams_.stride) {
            const Shadow& shadow = streams_.stream->shadow();
            const size_t at = (size_t)start * streams_.stride;
            if (at + (size_t)count * streams_.stride <= shadow.bytes.size())
                base = shadow.bytes.data() + at;
        }
        note({"DrawPrimitive", type, primitives, count, base, streams_.stride, nullptr,
              D3DFMT_UNKNOWN, 0, false, 0, 0, 0});
    }
    ++draws_;
    return real_->DrawPrimitive(type, start, primitives);
}

HRESULT STDMETHODCALLTYPE DeviceProxy::DrawIndexedPrimitive(D3DPRIMITIVETYPE type, UINT minIndex,
                                                            UINT vertices, UINT start,
                                                            UINT primitives) {
    if (log8::armed()) {
        const int indexCount = fvf::verticesFor(type, primitives);

        // Indices are relative to the base vertex the game gave SetIndices; the vertices actually
        // touched are the window [baseVertex + minIndex, + vertices) the caller declared.
        const unsigned char* base = nullptr;
        if (streams_.stream && streams_.stride) {
            const Shadow& shadow = streams_.stream->shadow();
            const size_t at = (size_t)(streams_.baseVertex + minIndex) * streams_.stride;
            if (at + (size_t)vertices * streams_.stride <= shadow.bytes.size())
                base = shadow.bytes.data() + at;
        }

        const void* indices = nullptr;
        D3DFORMAT format = D3DFMT_UNKNOWN;
        if (streams_.indices) {
            format = streams_.indices->format();
            const size_t width = format == D3DFMT_INDEX32 ? 4 : 2;
            const Shadow& shadow = streams_.indices->shadow();
            const size_t at = (size_t)start * width;
            if (at + (size_t)indexCount * width <= shadow.bytes.size())
                indices = shadow.bytes.data() + at;
        }

        note({"DrawIndexedPrimitive", type, primitives, (int)vertices, base, streams_.stride,
              indices, format, (UINT)indexCount, true, minIndex, start, streams_.baseVertex});
    }
    ++draws_;
    return real_->DrawIndexedPrimitive(type, minIndex, vertices, start, primitives);
}

HRESULT STDMETHODCALLTYPE DeviceProxy::DrawPrimitiveUP(D3DPRIMITIVETYPE type, UINT primitives,
                                                       const void* data, UINT stride) {
    if (log8::armed())
        note({"DrawPrimitiveUP", type, primitives, fvf::verticesFor(type, primitives),
              (const unsigned char*)data, stride, nullptr, D3DFMT_UNKNOWN, 0, false, 0, 0, 0});
    ++draws_;
    streams_.stream = nullptr;  // the runtime clears stream 0 after a UP draw
    streams_.stride = 0;
    return real_->DrawPrimitiveUP(type, primitives, data, stride);
}

HRESULT STDMETHODCALLTYPE DeviceProxy::DrawIndexedPrimitiveUP(D3DPRIMITIVETYPE type, UINT minIndex,
                                                              UINT vertices, UINT primitives,
                                                              const void* indices,
                                                              D3DFORMAT indexFormat,
                                                              const void* data, UINT stride) {
    if (log8::armed()) {
        const unsigned char* base = (const unsigned char*)data;
        if (base) base += (size_t)minIndex * stride;
        note({"DrawIndexedPrimitiveUP", type, primitives, (int)vertices, base, stride, indices,
              indexFormat, (UINT)fvf::verticesFor(type, primitives), false, 0, 0, 0});
    }
    ++draws_;
    streams_ = Streams{};  // the runtime clears stream 0 and the indices after a UP draw
    return real_->DrawIndexedPrimitiveUP(type, minIndex, vertices, primitives, indices, indexFormat,
                                         data, stride);
}

// ---------------------------------------------------------------------------------------------
// Direct3DProxy

HRESULT STDMETHODCALLTYPE Direct3DProxy::QueryInterface(REFIID riid, void** object) {
    const HRESULT result = real_->QueryInterface(riid, object);
    if (SUCCEEDED(result) && object && *object == real_) *object = this;
    return result;
}

ULONG STDMETHODCALLTYPE Direct3DProxy::AddRef() { return real_->AddRef(); }

ULONG STDMETHODCALLTYPE Direct3DProxy::Release() {
    const ULONG count = real_->Release();
    if (!count) delete this;
    return count;
}

HRESULT STDMETHODCALLTYPE Direct3DProxy::CreateDevice(UINT adapter, D3DDEVTYPE type, HWND focus,
                                                      DWORD behaviour,
                                                      D3DPRESENT_PARAMETERS* presentation,
                                                      IDirect3DDevice8** device) {
    IDirect3DDevice8* created = nullptr;
    const HRESULT result =
        real_->CreateDevice(adapter, type, focus, behaviour, presentation, &created);
    if (FAILED(result) || !created) return result;

    if (presentation) {
        D3DADAPTER_IDENTIFIER8 identifier{};
        real_->GetAdapterIdentifier(adapter, 0, &identifier);
        D3DCAPS8 caps{};
        created->GetDeviceCaps(&caps);

        log8::put("{\"ev\":\"device\",\"w\":%lu,\"h\":%lu,\"windowed\":%d,\"behaviour\":\"0x%08lx\"",
                  (unsigned long)presentation->BackBufferWidth,
                  (unsigned long)presentation->BackBufferHeight, presentation->Windowed ? 1 : 0,
                  (unsigned long)behaviour);
        log8::put(",\"backBuffer\":%d,\"depth\":%d,\"samples\":%d,\"adapter\":",
                  (int)presentation->BackBufferFormat, (int)presentation->AutoDepthStencilFormat,
                  (int)presentation->MultiSampleType);
        log8::putString(identifier.Description);
        // RP8 chooses material paths from these, so a different GPU can mean a different frame.
        log8::put(",\"caps\":{\"maxBlendStages\":%lu,\"maxTextures\":%lu,\"maxLights\":%lu",
                  (unsigned long)caps.MaxTextureBlendStages,
                  (unsigned long)caps.MaxSimultaneousTextures, (unsigned long)caps.MaxActiveLights);
        log8::put(",\"textureOps\":\"0x%08lx\",\"vs\":\"0x%08lx\",\"ps\":\"0x%08lx\"}}",
                  (unsigned long)caps.TextureOpCaps, (unsigned long)caps.VertexShaderVersion,
                  (unsigned long)caps.PixelShaderVersion);
        log8::endLine();
        log8::flush();
    }

    if (device) *device = new DeviceProxy(created, this);
    return result;
}
