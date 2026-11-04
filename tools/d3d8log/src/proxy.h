/**
 * COM wrappers over the interfaces the capture needs to see through.
 *
 * These are full wrapper objects rather than vtable patches, because a class deriving from
 * `IDirect3DDevice8` is *checked by the compiler*: a method missed or a signature mistyped is a
 * build error rather than a call landing on the wrong slot at runtime.
 *
 * Vertex and index buffers are wrapped for one reason: **a dynamic buffer is created `WRITEONLY`
 * and locking one for reading is undefined.** The data is taken where the game writes it, between
 * its own `Lock` and `Unlock`, into a shadow copy.
 *
 * Everything else about a draw is read back from the device with `Get*` when it is logged. That
 * needs a non-pure device; RP8 asks for one unless a `PUREDEVICE` profile key says otherwise
 * (`FDirectX8` device creation, RP8.cpp:2615), and the device line records the behaviour flags.
 * So state set before the key press, or never set, is still the true value.
 */
#pragma once

#include <d3d8.h>

#include <vector>

class DeviceProxy;

/** What the game last wrote into a buffer, taken at `Unlock`. */
struct Shadow {
    std::vector<unsigned char> bytes;
    UINT lockOffset = 0;
    UINT lockSize = 0;
    unsigned char* lockPointer = nullptr;

    void reserve(UINT length) { bytes.assign(length, 0); }
    void begin(UINT offset, UINT size, unsigned char* pointer);
    void end();
};

class VertexBufferProxy final : public IDirect3DVertexBuffer8 {
   public:
    VertexBufferProxy(IDirect3DVertexBuffer8* real, DeviceProxy* owner, UINT length, DWORD usage,
                      DWORD fvf, D3DPOOL pool);
    ~VertexBufferProxy();

    IDirect3DVertexBuffer8* real() const { return real_; }
    const Shadow& shadow() const { return shadow_; }
    UINT length() const { return length_; }
    DWORD usage() const { return usage_; }
    DWORD fvf() const { return fvf_; }
    D3DPOOL pool() const { return pool_; }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;

    HRESULT STDMETHODCALLTYPE GetDevice(IDirect3DDevice8** device) override;
    HRESULT STDMETHODCALLTYPE SetPrivateData(REFGUID guid, const void* data, DWORD size,
                                             DWORD flags) override {
        return real_->SetPrivateData(guid, data, size, flags);
    }
    HRESULT STDMETHODCALLTYPE GetPrivateData(REFGUID guid, void* data, DWORD* size) override {
        return real_->GetPrivateData(guid, data, size);
    }
    HRESULT STDMETHODCALLTYPE FreePrivateData(REFGUID guid) override {
        return real_->FreePrivateData(guid);
    }
    DWORD STDMETHODCALLTYPE SetPriority(DWORD priority) override {
        return real_->SetPriority(priority);
    }
    DWORD STDMETHODCALLTYPE GetPriority() override { return real_->GetPriority(); }
    void STDMETHODCALLTYPE PreLoad() override { real_->PreLoad(); }
    D3DRESOURCETYPE STDMETHODCALLTYPE GetType() override { return real_->GetType(); }

    HRESULT STDMETHODCALLTYPE Lock(UINT offset, UINT size, BYTE** data, DWORD flags) override;
    HRESULT STDMETHODCALLTYPE Unlock() override;
    HRESULT STDMETHODCALLTYPE GetDesc(D3DVERTEXBUFFER_DESC* desc) override {
        return real_->GetDesc(desc);
    }

   private:
    IDirect3DVertexBuffer8* real_;
    DeviceProxy* owner_;
    Shadow shadow_;
    UINT length_;
    DWORD usage_;
    DWORD fvf_;
    D3DPOOL pool_;
};

class IndexBufferProxy final : public IDirect3DIndexBuffer8 {
   public:
    IndexBufferProxy(IDirect3DIndexBuffer8* real, DeviceProxy* owner, UINT length, DWORD usage,
                     D3DFORMAT format, D3DPOOL pool);
    ~IndexBufferProxy();

    IDirect3DIndexBuffer8* real() const { return real_; }
    const Shadow& shadow() const { return shadow_; }
    D3DFORMAT format() const { return format_; }
    UINT length() const { return length_; }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;

    HRESULT STDMETHODCALLTYPE GetDevice(IDirect3DDevice8** device) override;
    HRESULT STDMETHODCALLTYPE SetPrivateData(REFGUID guid, const void* data, DWORD size,
                                             DWORD flags) override {
        return real_->SetPrivateData(guid, data, size, flags);
    }
    HRESULT STDMETHODCALLTYPE GetPrivateData(REFGUID guid, void* data, DWORD* size) override {
        return real_->GetPrivateData(guid, data, size);
    }
    HRESULT STDMETHODCALLTYPE FreePrivateData(REFGUID guid) override {
        return real_->FreePrivateData(guid);
    }
    DWORD STDMETHODCALLTYPE SetPriority(DWORD priority) override {
        return real_->SetPriority(priority);
    }
    DWORD STDMETHODCALLTYPE GetPriority() override { return real_->GetPriority(); }
    void STDMETHODCALLTYPE PreLoad() override { real_->PreLoad(); }
    D3DRESOURCETYPE STDMETHODCALLTYPE GetType() override { return real_->GetType(); }

    HRESULT STDMETHODCALLTYPE Lock(UINT offset, UINT size, BYTE** data, DWORD flags) override;
    HRESULT STDMETHODCALLTYPE Unlock() override;
    HRESULT STDMETHODCALLTYPE GetDesc(D3DINDEXBUFFER_DESC* desc) override {
        return real_->GetDesc(desc);
    }

   private:
    IDirect3DIndexBuffer8* real_;
    DeviceProxy* owner_;
    Shadow shadow_;
    UINT length_;
    DWORD usage_;
    D3DFORMAT format_;
    D3DPOOL pool_;
};

class DeviceProxy final : public IDirect3DDevice8 {
   public:
    DeviceProxy(IDirect3DDevice8* real, IDirect3D8* parent);

    IDirect3DDevice8* real() const { return real_; }
    void forget(VertexBufferProxy* buffer);
    void forget(IndexBufferProxy* buffer);

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;

    HRESULT STDMETHODCALLTYPE TestCooperativeLevel() override {
        return real_->TestCooperativeLevel();
    }
    UINT STDMETHODCALLTYPE GetAvailableTextureMem() override {
        return real_->GetAvailableTextureMem();
    }
    HRESULT STDMETHODCALLTYPE ResourceManagerDiscardBytes(DWORD bytes) override {
        return real_->ResourceManagerDiscardBytes(bytes);
    }
    HRESULT STDMETHODCALLTYPE GetDirect3D(IDirect3D8** d3d) override;
    HRESULT STDMETHODCALLTYPE GetDeviceCaps(D3DCAPS8* caps) override {
        return real_->GetDeviceCaps(caps);
    }
    HRESULT STDMETHODCALLTYPE GetDisplayMode(D3DDISPLAYMODE* mode) override {
        return real_->GetDisplayMode(mode);
    }
    HRESULT STDMETHODCALLTYPE GetCreationParameters(
        D3DDEVICE_CREATION_PARAMETERS* parameters) override {
        return real_->GetCreationParameters(parameters);
    }
    HRESULT STDMETHODCALLTYPE SetCursorProperties(UINT x, UINT y,
                                                  IDirect3DSurface8* bitmap) override {
        return real_->SetCursorProperties(x, y, bitmap);
    }
    void STDMETHODCALLTYPE SetCursorPosition(UINT x, UINT y, DWORD flags) override {
        real_->SetCursorPosition(x, y, flags);
    }
    WINBOOL STDMETHODCALLTYPE ShowCursor(WINBOOL show) override { return real_->ShowCursor(show); }
    HRESULT STDMETHODCALLTYPE CreateAdditionalSwapChain(D3DPRESENT_PARAMETERS* parameters,
                                                        IDirect3DSwapChain8** chain) override {
        return real_->CreateAdditionalSwapChain(parameters, chain);
    }
    HRESULT STDMETHODCALLTYPE Reset(D3DPRESENT_PARAMETERS* parameters) override;
    HRESULT STDMETHODCALLTYPE Present(const RECT* source, const RECT* destination, HWND window,
                                      const RGNDATA* dirty) override;
    HRESULT STDMETHODCALLTYPE GetBackBuffer(UINT index, D3DBACKBUFFER_TYPE type,
                                            IDirect3DSurface8** surface) override {
        return real_->GetBackBuffer(index, type, surface);
    }
    HRESULT STDMETHODCALLTYPE GetRasterStatus(D3DRASTER_STATUS* status) override {
        return real_->GetRasterStatus(status);
    }
    void STDMETHODCALLTYPE SetGammaRamp(DWORD flags, const D3DGAMMARAMP* ramp) override {
        real_->SetGammaRamp(flags, ramp);
    }
    void STDMETHODCALLTYPE GetGammaRamp(D3DGAMMARAMP* ramp) override { real_->GetGammaRamp(ramp); }
    HRESULT STDMETHODCALLTYPE CreateTexture(UINT width, UINT height, UINT levels, DWORD usage,
                                            D3DFORMAT format, D3DPOOL pool,
                                            IDirect3DTexture8** texture) override {
        return real_->CreateTexture(width, height, levels, usage, format, pool, texture);
    }
    HRESULT STDMETHODCALLTYPE CreateVolumeTexture(UINT width, UINT height, UINT depth, UINT levels,
                                                  DWORD usage, D3DFORMAT format, D3DPOOL pool,
                                                  IDirect3DVolumeTexture8** texture) override {
        return real_->CreateVolumeTexture(width, height, depth, levels, usage, format, pool,
                                          texture);
    }
    HRESULT STDMETHODCALLTYPE CreateCubeTexture(UINT edge, UINT levels, DWORD usage,
                                                D3DFORMAT format, D3DPOOL pool,
                                                IDirect3DCubeTexture8** texture) override {
        return real_->CreateCubeTexture(edge, levels, usage, format, pool, texture);
    }
    HRESULT STDMETHODCALLTYPE CreateVertexBuffer(UINT length, DWORD usage, DWORD fvf, D3DPOOL pool,
                                                 IDirect3DVertexBuffer8** buffer) override;
    HRESULT STDMETHODCALLTYPE CreateIndexBuffer(UINT length, DWORD usage, D3DFORMAT format,
                                                D3DPOOL pool,
                                                IDirect3DIndexBuffer8** buffer) override;
    HRESULT STDMETHODCALLTYPE CreateRenderTarget(UINT width, UINT height, D3DFORMAT format,
                                                 D3DMULTISAMPLE_TYPE samples, WINBOOL lockable,
                                                 IDirect3DSurface8** surface) override {
        return real_->CreateRenderTarget(width, height, format, samples, lockable, surface);
    }
    HRESULT STDMETHODCALLTYPE CreateDepthStencilSurface(UINT width, UINT height, D3DFORMAT format,
                                                        D3DMULTISAMPLE_TYPE samples,
                                                        IDirect3DSurface8** surface) override {
        return real_->CreateDepthStencilSurface(width, height, format, samples, surface);
    }
    HRESULT STDMETHODCALLTYPE CreateImageSurface(UINT width, UINT height, D3DFORMAT format,
                                                 IDirect3DSurface8** surface) override {
        return real_->CreateImageSurface(width, height, format, surface);
    }
    HRESULT STDMETHODCALLTYPE CopyRects(IDirect3DSurface8* source, const RECT* sourceRects,
                                        UINT count, IDirect3DSurface8* destination,
                                        const POINT* points) override;
    HRESULT STDMETHODCALLTYPE UpdateTexture(IDirect3DBaseTexture8* source,
                                            IDirect3DBaseTexture8* destination) override {
        return real_->UpdateTexture(source, destination);
    }
    HRESULT STDMETHODCALLTYPE GetFrontBuffer(IDirect3DSurface8* destination) override {
        return real_->GetFrontBuffer(destination);
    }
    HRESULT STDMETHODCALLTYPE SetRenderTarget(IDirect3DSurface8* target,
                                              IDirect3DSurface8* stencil) override;
    HRESULT STDMETHODCALLTYPE GetRenderTarget(IDirect3DSurface8** target) override {
        return real_->GetRenderTarget(target);
    }
    HRESULT STDMETHODCALLTYPE GetDepthStencilSurface(IDirect3DSurface8** stencil) override {
        return real_->GetDepthStencilSurface(stencil);
    }
    HRESULT STDMETHODCALLTYPE BeginScene() override;
    HRESULT STDMETHODCALLTYPE EndScene() override;
    HRESULT STDMETHODCALLTYPE Clear(DWORD count, const D3DRECT* rects, DWORD flags, D3DCOLOR colour,
                                    float z, DWORD stencil) override;
    HRESULT STDMETHODCALLTYPE SetTransform(D3DTRANSFORMSTATETYPE state,
                                           const D3DMATRIX* matrix) override {
        return real_->SetTransform(state, matrix);
    }
    HRESULT STDMETHODCALLTYPE GetTransform(D3DTRANSFORMSTATETYPE state,
                                           D3DMATRIX* matrix) override {
        return real_->GetTransform(state, matrix);
    }
    HRESULT STDMETHODCALLTYPE MultiplyTransform(D3DTRANSFORMSTATETYPE state,
                                                const D3DMATRIX* matrix) override {
        return real_->MultiplyTransform(state, matrix);
    }
    HRESULT STDMETHODCALLTYPE SetViewport(const D3DVIEWPORT8* viewport) override {
        return real_->SetViewport(viewport);
    }
    HRESULT STDMETHODCALLTYPE GetViewport(D3DVIEWPORT8* viewport) override {
        return real_->GetViewport(viewport);
    }
    HRESULT STDMETHODCALLTYPE SetMaterial(const D3DMATERIAL8* material) override {
        return real_->SetMaterial(material);
    }
    HRESULT STDMETHODCALLTYPE GetMaterial(D3DMATERIAL8* material) override {
        return real_->GetMaterial(material);
    }
    HRESULT STDMETHODCALLTYPE SetLight(DWORD index, const D3DLIGHT8* light) override {
        if (index > lastLight_) lastLight_ = index;
        return real_->SetLight(index, light);
    }
    HRESULT STDMETHODCALLTYPE GetLight(DWORD index, D3DLIGHT8* light) override {
        return real_->GetLight(index, light);
    }
    HRESULT STDMETHODCALLTYPE LightEnable(DWORD index, WINBOOL enable) override {
        return real_->LightEnable(index, enable);
    }
    HRESULT STDMETHODCALLTYPE GetLightEnable(DWORD index, WINBOOL* enable) override {
        return real_->GetLightEnable(index, enable);
    }
    HRESULT STDMETHODCALLTYPE SetClipPlane(DWORD index, const float* plane) override {
        return real_->SetClipPlane(index, plane);
    }
    HRESULT STDMETHODCALLTYPE GetClipPlane(DWORD index, float* plane) override {
        return real_->GetClipPlane(index, plane);
    }
    HRESULT STDMETHODCALLTYPE SetRenderState(D3DRENDERSTATETYPE state, DWORD value) override {
        return real_->SetRenderState(state, value);
    }
    HRESULT STDMETHODCALLTYPE GetRenderState(D3DRENDERSTATETYPE state, DWORD* value) override {
        return real_->GetRenderState(state, value);
    }
    HRESULT STDMETHODCALLTYPE BeginStateBlock() override { return real_->BeginStateBlock(); }
    HRESULT STDMETHODCALLTYPE EndStateBlock(DWORD* token) override {
        return real_->EndStateBlock(token);
    }
    HRESULT STDMETHODCALLTYPE ApplyStateBlock(DWORD token) override {
        return real_->ApplyStateBlock(token);
    }
    HRESULT STDMETHODCALLTYPE CaptureStateBlock(DWORD token) override {
        return real_->CaptureStateBlock(token);
    }
    HRESULT STDMETHODCALLTYPE DeleteStateBlock(DWORD token) override {
        return real_->DeleteStateBlock(token);
    }
    HRESULT STDMETHODCALLTYPE CreateStateBlock(D3DSTATEBLOCKTYPE type, DWORD* token) override {
        return real_->CreateStateBlock(type, token);
    }
    HRESULT STDMETHODCALLTYPE SetClipStatus(const D3DCLIPSTATUS8* status) override {
        return real_->SetClipStatus(status);
    }
    HRESULT STDMETHODCALLTYPE GetClipStatus(D3DCLIPSTATUS8* status) override {
        return real_->GetClipStatus(status);
    }
    HRESULT STDMETHODCALLTYPE GetTexture(DWORD stage, IDirect3DBaseTexture8** texture) override {
        return real_->GetTexture(stage, texture);
    }
    HRESULT STDMETHODCALLTYPE SetTexture(DWORD stage, IDirect3DBaseTexture8* texture) override {
        return real_->SetTexture(stage, texture);
    }
    HRESULT STDMETHODCALLTYPE GetTextureStageState(DWORD stage, D3DTEXTURESTAGESTATETYPE type,
                                                   DWORD* value) override {
        return real_->GetTextureStageState(stage, type, value);
    }
    HRESULT STDMETHODCALLTYPE SetTextureStageState(DWORD stage, D3DTEXTURESTAGESTATETYPE type,
                                                   DWORD value) override {
        return real_->SetTextureStageState(stage, type, value);
    }
    HRESULT STDMETHODCALLTYPE ValidateDevice(DWORD* passes) override {
        return real_->ValidateDevice(passes);
    }
    HRESULT STDMETHODCALLTYPE GetInfo(DWORD id, void* structure, DWORD size) override {
        return real_->GetInfo(id, structure, size);
    }
    HRESULT STDMETHODCALLTYPE SetPaletteEntries(UINT palette,
                                                const PALETTEENTRY* entries) override {
        return real_->SetPaletteEntries(palette, entries);
    }
    HRESULT STDMETHODCALLTYPE GetPaletteEntries(UINT palette, PALETTEENTRY* entries) override {
        return real_->GetPaletteEntries(palette, entries);
    }
    HRESULT STDMETHODCALLTYPE SetCurrentTexturePalette(UINT palette) override {
        return real_->SetCurrentTexturePalette(palette);
    }
    HRESULT STDMETHODCALLTYPE GetCurrentTexturePalette(UINT* palette) override {
        return real_->GetCurrentTexturePalette(palette);
    }
    HRESULT STDMETHODCALLTYPE DrawPrimitive(D3DPRIMITIVETYPE type, UINT start,
                                            UINT primitives) override;
    HRESULT STDMETHODCALLTYPE DrawIndexedPrimitive(D3DPRIMITIVETYPE type, UINT minIndex,
                                                   UINT vertices, UINT start,
                                                   UINT primitives) override;
    HRESULT STDMETHODCALLTYPE DrawPrimitiveUP(D3DPRIMITIVETYPE type, UINT primitives,
                                              const void* data, UINT stride) override;
    HRESULT STDMETHODCALLTYPE DrawIndexedPrimitiveUP(D3DPRIMITIVETYPE type, UINT minIndex,
                                                     UINT vertices, UINT primitives,
                                                     const void* indices, D3DFORMAT indexFormat,
                                                     const void* data, UINT stride) override;
    HRESULT STDMETHODCALLTYPE ProcessVertices(UINT start, UINT destination, UINT count,
                                              IDirect3DVertexBuffer8* buffer, DWORD flags) override;
    HRESULT STDMETHODCALLTYPE CreateVertexShader(const DWORD* declaration, const DWORD* code,
                                                 DWORD* shader, DWORD usage) override {
        return real_->CreateVertexShader(declaration, code, shader, usage);
    }
    HRESULT STDMETHODCALLTYPE SetVertexShader(DWORD handle) override {
        return real_->SetVertexShader(handle);
    }
    HRESULT STDMETHODCALLTYPE GetVertexShader(DWORD* handle) override {
        return real_->GetVertexShader(handle);
    }
    HRESULT STDMETHODCALLTYPE DeleteVertexShader(DWORD handle) override {
        return real_->DeleteVertexShader(handle);
    }
    HRESULT STDMETHODCALLTYPE SetVertexShaderConstant(DWORD index, const void* data,
                                                      DWORD count) override {
        return real_->SetVertexShaderConstant(index, data, count);
    }
    HRESULT STDMETHODCALLTYPE GetVertexShaderConstant(DWORD index, void* data,
                                                      DWORD count) override {
        return real_->GetVertexShaderConstant(index, data, count);
    }
    HRESULT STDMETHODCALLTYPE GetVertexShaderDeclaration(DWORD handle, void* data,
                                                         DWORD* size) override {
        return real_->GetVertexShaderDeclaration(handle, data, size);
    }
    HRESULT STDMETHODCALLTYPE GetVertexShaderFunction(DWORD handle, void* data,
                                                      DWORD* size) override {
        return real_->GetVertexShaderFunction(handle, data, size);
    }
    HRESULT STDMETHODCALLTYPE SetStreamSource(UINT stream, IDirect3DVertexBuffer8* buffer,
                                              UINT stride) override;
    HRESULT STDMETHODCALLTYPE GetStreamSource(UINT stream, IDirect3DVertexBuffer8** buffer,
                                              UINT* stride) override;
    HRESULT STDMETHODCALLTYPE SetIndices(IDirect3DIndexBuffer8* buffer, UINT baseVertex) override;
    HRESULT STDMETHODCALLTYPE GetIndices(IDirect3DIndexBuffer8** buffer, UINT* baseVertex) override;
    HRESULT STDMETHODCALLTYPE CreatePixelShader(const DWORD* code, DWORD* shader) override {
        return real_->CreatePixelShader(code, shader);
    }
    HRESULT STDMETHODCALLTYPE SetPixelShader(DWORD handle) override {
        return real_->SetPixelShader(handle);
    }
    HRESULT STDMETHODCALLTYPE GetPixelShader(DWORD* handle) override {
        return real_->GetPixelShader(handle);
    }
    HRESULT STDMETHODCALLTYPE DeletePixelShader(DWORD handle) override {
        return real_->DeletePixelShader(handle);
    }
    HRESULT STDMETHODCALLTYPE SetPixelShaderConstant(DWORD index, const void* data,
                                                     DWORD count) override {
        return real_->SetPixelShaderConstant(index, data, count);
    }
    HRESULT STDMETHODCALLTYPE GetPixelShaderConstant(DWORD index, void* data,
                                                     DWORD count) override {
        return real_->GetPixelShaderConstant(index, data, count);
    }
    HRESULT STDMETHODCALLTYPE GetPixelShaderFunction(DWORD handle, void* data,
                                                     DWORD* size) override {
        return real_->GetPixelShaderFunction(handle, data, size);
    }
    HRESULT STDMETHODCALLTYPE DrawRectPatch(UINT handle, const float* segments,
                                            const D3DRECTPATCH_INFO* info) override {
        return real_->DrawRectPatch(handle, segments, info);
    }
    HRESULT STDMETHODCALLTYPE DrawTriPatch(UINT handle, const float* segments,
                                           const D3DTRIPATCH_INFO* info) override {
        return real_->DrawTriPatch(handle, segments, info);
    }
    HRESULT STDMETHODCALLTYPE DeletePatch(UINT handle) override {
        return real_->DeletePatch(handle);
    }

   private:
    /** Only what `Get*` cannot give: the wrapped buffers, whose shadows hold the vertex data. */
    struct Streams {
        VertexBufferProxy* stream = nullptr;
        UINT stride = 0;
        IndexBufferProxy* indices = nullptr;
        UINT baseVertex = 0;
    };

    struct Draw {
        const char* call;
        D3DPRIMITIVETYPE type;
        UINT primitives;
        int vertexCount;
        const unsigned char* vertices;  // the declared window's first vertex, when available
        UINT stride;
        const void* indices;
        D3DFORMAT indexFormat;
        UINT indexCount;
        bool indexed;  // through a stream and index buffer, so the three fields below apply
        UINT minIndex;
        UINT startIndex;
        UINT baseVertex;
    };

    void note(const Draw& draw);
    void noteTextures();
    void releaseSeen();
    void writeState(UINT stride);
    void writeLights();
    void writeStages();
    void writeVertices(const unsigned char* base, UINT stride, int count, DWORD fvf);

    IDirect3DDevice8* real_;
    IDirect3D8* parent_;
    Streams streams_;
    // Held for the length of a capture, so that an address cannot be reused while it identifies one.
    std::vector<IDirect3DBaseTexture8*> seen_;
    DWORD lastLight_ = 7;
    unsigned draws_ = 0;
};

class Direct3DProxy final : public IDirect3D8 {
   public:
    explicit Direct3DProxy(IDirect3D8* real) : real_(real) {}

    IDirect3D8* real() const { return real_; }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;

    HRESULT STDMETHODCALLTYPE RegisterSoftwareDevice(void* initialize) override {
        return real_->RegisterSoftwareDevice(initialize);
    }
    UINT STDMETHODCALLTYPE GetAdapterCount() override { return real_->GetAdapterCount(); }
    HRESULT STDMETHODCALLTYPE GetAdapterIdentifier(UINT adapter, DWORD flags,
                                                   D3DADAPTER_IDENTIFIER8* identifier) override {
        return real_->GetAdapterIdentifier(adapter, flags, identifier);
    }
    UINT STDMETHODCALLTYPE GetAdapterModeCount(UINT adapter) override {
        return real_->GetAdapterModeCount(adapter);
    }
    HRESULT STDMETHODCALLTYPE EnumAdapterModes(UINT adapter, UINT mode,
                                               D3DDISPLAYMODE* display) override {
        return real_->EnumAdapterModes(adapter, mode, display);
    }
    HRESULT STDMETHODCALLTYPE GetAdapterDisplayMode(UINT adapter,
                                                    D3DDISPLAYMODE* display) override {
        return real_->GetAdapterDisplayMode(adapter, display);
    }
    HRESULT STDMETHODCALLTYPE CheckDeviceType(UINT adapter, D3DDEVTYPE type, D3DFORMAT display,
                                              D3DFORMAT backBuffer, WINBOOL windowed) override {
        return real_->CheckDeviceType(adapter, type, display, backBuffer, windowed);
    }
    HRESULT STDMETHODCALLTYPE CheckDeviceFormat(UINT adapter, D3DDEVTYPE type, D3DFORMAT display,
                                                DWORD usage, D3DRESOURCETYPE resource,
                                                D3DFORMAT check) override {
        return real_->CheckDeviceFormat(adapter, type, display, usage, resource, check);
    }
    HRESULT STDMETHODCALLTYPE CheckDeviceMultiSampleType(UINT adapter, D3DDEVTYPE type,
                                                         D3DFORMAT surface, WINBOOL windowed,
                                                         D3DMULTISAMPLE_TYPE samples) override {
        return real_->CheckDeviceMultiSampleType(adapter, type, surface, windowed, samples);
    }
    HRESULT STDMETHODCALLTYPE CheckDepthStencilMatch(UINT adapter, D3DDEVTYPE type,
                                                     D3DFORMAT display, D3DFORMAT target,
                                                     D3DFORMAT stencil) override {
        return real_->CheckDepthStencilMatch(adapter, type, display, target, stencil);
    }
    HRESULT STDMETHODCALLTYPE GetDeviceCaps(UINT adapter, D3DDEVTYPE type,
                                            D3DCAPS8* caps) override {
        return real_->GetDeviceCaps(adapter, type, caps);
    }
    HMONITOR STDMETHODCALLTYPE GetAdapterMonitor(UINT adapter) override {
        return real_->GetAdapterMonitor(adapter);
    }
    HRESULT STDMETHODCALLTYPE CreateDevice(UINT adapter, D3DDEVTYPE type, HWND focus,
                                           DWORD behaviour,
                                           D3DPRESENT_PARAMETERS* presentation,
                                           IDirect3DDevice8** device) override;

   private:
    IDirect3D8* real_;
};
