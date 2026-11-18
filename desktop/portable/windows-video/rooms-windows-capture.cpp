#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <roapi.h>
#include <tlhelp32.h>
#include <winstring.h>
#ifdef __MINGW32__
// The generated MinGW foundation header specializes IReference for both BYTE
// and boolean, even though it declares them as the same C++ type.
#define ____FIReference_1_BYTE_INTERFACE_DEFINED__
#endif
#include <windows.graphics.capture.h>
#include <windows.graphics.capture.interop.h>
#include <wrl/client.h>
#if __has_include(<windows.graphics.directx.direct3d11.interop.h>)
#include <windows.graphics.directx.direct3d11.interop.h>
#else
// MinGW provides the capture ABI and D3D11 import library, but is missing this
// Windows SDK header. The two declarations below use the published Win32 ABI.
extern "C" HRESULT WINAPI CreateDirect3D11DeviceFromDXGIDevice(IDXGIDevice*, IInspectable**);
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <stdexcept>
#include <string_view>
#include <utility>

namespace {
using Microsoft::WRL::ComPtr;
namespace capture = ABI::Windows::Graphics::Capture;
namespace graphics = ABI::Windows::Graphics;
namespace directx = ABI::Windows::Graphics::DirectX;
namespace foundation = ABI::Windows::Foundation;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

constexpr auto format = directx::DirectXPixelFormat_B8G8R8A8UIntNormalized;
constexpr int poolSize = 2;
constexpr int slotCount = 3;
constexpr IID surfaceAccessId{0xa9b3d012, 0x3df2, 0x4ee3, {0xb8, 0xd1, 0x86, 0x95, 0xf4, 0x57, 0xd3, 0xc1}};

struct SurfaceAccess : IUnknown {
    virtual HRESULT STDMETHODCALLTYPE GetInterface(REFIID iid, void** value) = 0;
};

void check(HRESULT result, const char* operation) {
    if (SUCCEEDED(result)) return;
    char message[160];
    std::snprintf(message, sizeof(message), "%s (0x%08lx)", operation, static_cast<unsigned long>(result));
    throw std::runtime_error(message);
}

class Handle {
public:
    Handle() = default;
    explicit Handle(HANDLE value) : value_(value) {}
    ~Handle() { reset(); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    HANDLE get() const { return value_; }
    void reset(HANDLE value = nullptr) {
        if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
        value_ = value;
    }

private:
    HANDLE value_ = nullptr;
};

class Runtime {
public:
    Runtime() { check(RoInitialize(RO_INIT_MULTITHREADED), "Initialize Windows Runtime"); }
    ~Runtime() { RoUninitialize(); }
    Runtime(const Runtime&) = delete;
    Runtime& operator=(const Runtime&) = delete;
};

template<class T>
ComPtr<T> factory(const wchar_t* name) {
    HSTRING_HEADER header{};
    HSTRING className{};
    check(WindowsCreateStringReference(name, static_cast<UINT32>(wcslen(name)), &header, &className),
          "Create capture factory name");
    ComPtr<T> object;
    check(RoGetActivationFactory(className, IID_PPV_ARGS(object.GetAddressOf())), "Activate Windows Graphics Capture");
    return object;
}

template<class T>
void closeWinRt(ComPtr<T>& object) {
    if (!object) return;
    ComPtr<foundation::IClosable> closable;
    if (SUCCEEDED(object.As(&closable))) closable->Close();
    object.Reset();
}

template<class T>
T integer(std::string_view value) {
    T result{};
    const auto read = std::from_chars(value.data(), value.data() + value.size(), result);
    if (read.ec != std::errc{} || read.ptr != value.data() + value.size()) throw std::runtime_error("Invalid capture command");
    return result;
}

struct Target {
    HWND window = nullptr;
    HMONITOR monitor = nullptr;

    bool valid() const {
        if (window) return IsWindow(window) != FALSE;
        MONITORINFO info{};
        info.cbSize = sizeof(info);
        return monitor && GetMonitorInfoW(monitor, &info);
    }
};

bool validSize(graphics::SizeInt32 size) {
    return size.Width > 0 && size.Height > 0 && size.Width <= 8192 && size.Height <= 8192
        && int64_t{size.Width} * int64_t{size.Height} <= 33'554'432;
}

using ClosedHandler = foundation::ITypedEventHandler<capture::GraphicsCaptureItem*, IInspectable*>;

class SourceClosed final : public ClosedHandler {
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
        if (!value) return E_POINTER;
        *value = nullptr;
        if (id != __uuidof(IUnknown) && id != __uuidof(ClosedHandler) && id != __uuidof(IAgileObject)) return E_NOINTERFACE;
        *value = static_cast<ClosedHandler*>(this);
        AddRef();
        return S_OK;
    }

    ULONG STDMETHODCALLTYPE AddRef() override { return ++count_; }

    ULONG STDMETHODCALLTYPE Release() override {
        const auto count = --count_;
        if (!count) delete this;
        return count;
    }

    HRESULT STDMETHODCALLTYPE Invoke(capture::IGraphicsCaptureItem*, IInspectable*) override {
        closed = true;
        return S_OK;
    }

    std::atomic<bool> closed{false};

private:
    std::atomic<ULONG> count_{1};
};

class Capture {
public:
    Capture() {
        auto support = factory<capture::IGraphicsCaptureSessionStatics>(L"Windows.Graphics.Capture.GraphicsCaptureSession");
        boolean supported = false;
        check(support->IsSupported(&supported), "Check Windows Graphics Capture support");
        if (!supported) throw std::runtime_error("Windows Graphics Capture is not available");
        frameFactory_ = factory<capture::IDirect3D11CaptureFramePoolStatics2>(
            L"Windows.Graphics.Capture.Direct3D11CaptureFramePool");
        itemFactory_ = factory<IGraphicsCaptureItemInterop>(L"Windows.Graphics.Capture.GraphicsCaptureItem");
        check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                nullptr, 0, D3D11_SDK_VERSION, device.GetAddressOf(), nullptr, context.GetAddressOf()),
              "Create D3D11 capture device");
        ComPtr<ID3D11Multithread> threadLock;
        if (SUCCEEDED(context.As(&threadLock))) threadLock->SetMultithreadProtected(TRUE);
        ComPtr<IDXGIDevice> dxgi;
        check(device.As(&dxgi), "Get DXGI capture device");
        ComPtr<IInspectable> inspectable;
        check(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), inspectable.GetAddressOf()), "Share D3D11 device with Windows Runtime");
        check(inspectable.As(&runtimeDevice_), "Get Windows Runtime D3D11 device");
    }

    ~Capture() {
        if (subscribed_) item_->remove_Closed(closedToken_);
        closeWinRt(session_);
        closeWinRt(pool_);
    }

    void open(Target target) {
        if (!target.valid()) throw std::runtime_error("The approved source is no longer available");
        check(target.window
            ? itemFactory_->CreateForWindow(target.window, IID_PPV_ARGS(item_.GetAddressOf()))
            : itemFactory_->CreateForMonitor(target.monitor, IID_PPV_ARGS(item_.GetAddressOf())),
            "Open approved capture source");
        closed_.Attach(new SourceClosed());
        check(item_->add_Closed(closed_.Get(), &closedToken_), "Track screen capture closure");
        subscribed_ = true;
        check(item_->get_Size(&size_), "Read capture dimensions");
        if (!validSize(size_)) throw std::runtime_error("Capture dimensions are unsupported");
        check(frameFactory_->CreateFreeThreaded(runtimeDevice_.Get(), format, poolSize, size_, pool_.GetAddressOf()),
              "Create frame pool");
        check(pool_->CreateCaptureSession(item_.Get(), session_.GetAddressOf()), "Create screen capture session");
        check(session_->StartCapture(), "Start screen capture");
    }

    bool closed() const { return closed_->closed.load(); }

    ComPtr<capture::IDirect3D11CaptureFrame> latest() {
        ComPtr<capture::IDirect3D11CaptureFrame> frame;
        for (int index = 0; index < poolSize; ++index) {
            ComPtr<capture::IDirect3D11CaptureFrame> next;
            check(pool_->TryGetNextFrame(next.GetAddressOf()), "Read screen capture frame");
            if (!next) break;
            closeWinRt(frame);
            frame = std::move(next);
        }
        return frame;
    }

    bool needsResize(graphics::SizeInt32 size) const { return size.Width != size_.Width || size.Height != size_.Height; }

    void resize(graphics::SizeInt32 size) {
        check(pool_->Recreate(runtimeDevice_.Get(), format, poolSize, size), "Resize frame pool");
        size_ = size;
    }

    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;

private:
    ComPtr<directx::Direct3D11::IDirect3DDevice> runtimeDevice_;
    ComPtr<capture::IDirect3D11CaptureFramePoolStatics2> frameFactory_;
    ComPtr<IGraphicsCaptureItemInterop> itemFactory_;
    ComPtr<capture::IGraphicsCaptureItem> item_;
    ComPtr<SourceClosed> closed_;
    EventRegistrationToken closedToken_{};
    bool subscribed_ = false;
    ComPtr<capture::IDirect3D11CaptureFramePool> pool_;
    ComPtr<capture::IGraphicsCaptureSession> session_;
    graphics::SizeInt32 size_{};
};

bool isParent(DWORD parent) {
    const Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (snapshot.get() == INVALID_HANDLE_VALUE) return false;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    for (BOOL found = Process32FirstW(snapshot.get(), &entry); found; found = Process32NextW(snapshot.get(), &entry)) {
        if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID == parent;
    }
    return false;
}

struct Slot {
    void prepare(ID3D11Device* device, graphics::SizeInt32 desired) {
        if (texture && size.Width == desired.Width && size.Height == desired.Height) return;
        shared.reset();
        mutex.Reset();
        texture.Reset();
        query.Reset();
        size = desired;
        D3D11_TEXTURE2D_DESC desc{};
        desc.Width = static_cast<UINT>(size.Width);
        desc.Height = static_cast<UINT>(size.Height);
        desc.MipLevels = 1;
        desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_DEFAULT;
        desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
        desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
        check(device->CreateTexture2D(&desc, nullptr, texture.GetAddressOf()), "Create GPU share texture");
        check(texture.As(&mutex), "Get GPU share texture mutex");
        ComPtr<IDXGIResource1> resource;
        check(texture.As(&resource), "Get DXGI share resource");
        HANDLE handle = nullptr;
        check(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &handle),
              "Create GPU share handle");
        shared.reset(handle);
        const D3D11_QUERY_DESC fence{D3D11_QUERY_EVENT, 0};
        check(device->CreateQuery(&fence, query.GetAddressOf()), "Create GPU completion query");
    }

    void returnToPool(HANDLE parent) {
        if (!remote) return;
        HANDLE local = nullptr;
        // Electron duplicates the input HANDLE. Only the helper closes the
        // original copy it placed in the parent, after acknowledgement.
        if (DuplicateHandle(parent, remote, GetCurrentProcess(), &local, 0, FALSE,
                            DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS)) CloseHandle(local);
        remote = nullptr;
    }

    ComPtr<ID3D11Texture2D> texture;
    ComPtr<IDXGIKeyedMutex> mutex;
    ComPtr<ID3D11Query> query;
    ComPtr<capture::IDirect3D11CaptureFrame> pending;
    Handle shared;
    HANDLE remote = nullptr;
    graphics::SizeInt32 size{};
    uint64_t sequence = 0;
    uint64_t timestamp = 0;
};

class Producer {
public:
    explicit Producer(DWORD pid) {
        static_assert(sizeof(void*) == 8, "The Rooms Windows client requires a 64-bit helper");
        if (!pid || !isParent(pid)) throw std::runtime_error("The capture process must be launched by its consumer");
        parent_.reset(OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, pid));
        if (!parent_.get()) throw std::runtime_error("Open capture consumer process");
        input_ = GetStdHandle(STD_INPUT_HANDLE);
        output_ = GetStdHandle(STD_OUTPUT_HANDLE);
        if (GetFileType(input_) != FILE_TYPE_PIPE || GetFileType(output_) != FILE_TYPE_PIPE) {
            throw std::runtime_error("Windows capture requires its private transport");
        }
    }

    ~Producer() {
        for (auto& slot : slots_) {
            slot.returnToPool(parent_.get());
            closeWinRt(slot.pending);
        }
    }

    bool running() {
        if (WaitForSingleObject(parent_.get(), 0) != WAIT_TIMEOUT) return false;
        DWORD count = 0;
        if (!PeekNamedPipe(input_, nullptr, 0, nullptr, &count, nullptr)) return false;
        if (!count) return true;
        char buffer[256];
        count = (std::min)(count, static_cast<DWORD>(sizeof(buffer)));
        DWORD read = 0;
        if (!ReadFile(input_, buffer, count, &read, nullptr) || !read) return false;
        for (DWORD index = 0; index < read; ++index) {
            const char letter = buffer[index];
            if (letter != '\n') {
                if (commandSize_ == command_.size()) throw std::runtime_error("Capture command is too long");
                command_[commandSize_++] = letter;
                continue;
            }
            const std::string_view command(command_.data(), commandSize_);
            commandSize_ = 0;
            if (command == "stop") return false;
            if (command == "fps 30" || command == "fps 60") {
                interval = command == "fps 30" ? 1'000'000us / 30 : 1'000'000us / 60;
                continue;
            }
            if (command.substr(0, 4) != "ack ") throw std::runtime_error("Invalid capture command");
            const auto seq = integer<uint64_t>(command.substr(4));
            for (auto& slot : slots_) {
                if (slot.remote && slot.sequence == seq) slot.returnToPool(parent_.get());
            }
        }
        return true;
    }

    bool publishCompleted(ID3D11DeviceContext* context) {
        for (auto& slot : slots_) {
            if (!slot.pending) continue;
            const HRESULT result = context->GetData(slot.query.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
            if (result == S_FALSE) continue;
            check(result, "Finish copying the capture frame");
            closeWinRt(slot.pending);
            if (!DuplicateHandle(GetCurrentProcess(), slot.shared.get(), parent_.get(), &slot.remote, 0, FALSE,
                                 DUPLICATE_SAME_ACCESS)) throw std::runtime_error("Share capture frame with its consumer");
            slot.sequence = ++sequence_;
            char line[224];
            const auto sequence = static_cast<unsigned long long>(slot.sequence);
            const auto handle = static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(slot.remote));
            const auto timestamp = static_cast<unsigned long long>(slot.timestamp);
            const int length = std::snprintf(line, sizeof(line),
                "{\"type\":\"frame\",\"sequence\":%llu,\"width\":%d,\"height\":%d,\"handle\":\"%llx\",\"timestamp\":%llu}\n",
                sequence, slot.size.Width, slot.size.Height, handle, timestamp);
            DWORD written = 0;
            if (length <= 0 || static_cast<size_t>(length) >= sizeof(line) ||
                !WriteFile(output_, line, static_cast<DWORD>(length), &written, nullptr) ||
                written != static_cast<DWORD>(length)) return false;
        }
        return true;
    }

    void captureLatest(Capture& source) {
        Slot* slot = nullptr;
        bool copying = false;
        for (auto& candidate : slots_) {
            if (candidate.pending) copying = true;
            if (!slot && !candidate.pending && !candidate.remote) slot = &candidate;
        }
        if (copying || !slot) return;
        auto frame = source.latest();
        if (!frame) return;
        graphics::SizeInt32 size{};
        check(frame->get_ContentSize(&size), "Read captured frame dimensions");
        if (!validSize(size)) {
            closeWinRt(frame);
            if (size.Width > 0 && size.Height > 0) throw std::runtime_error("Captured frame exceeds the GPU limit");
            return;
        }
        if (source.needsResize(size)) {
            closeWinRt(frame);
            source.resize(size);
            return;
        }
        ComPtr<directx::Direct3D11::IDirect3DSurface> surface;
        check(frame->get_Surface(surface.GetAddressOf()), "Read capture surface");
        ComPtr<SurfaceAccess> access;
        check(surface->QueryInterface(surfaceAccessId, reinterpret_cast<void**>(access.GetAddressOf())),
              "Get Direct3D surface access");
        ComPtr<ID3D11Texture2D> texture;
        check(access->GetInterface(IID_PPV_ARGS(texture.GetAddressOf())), "Get the capture texture");
        D3D11_TEXTURE2D_DESC desc{};
        texture->GetDesc(&desc);
        const auto width = static_cast<UINT>(size.Width);
        const auto height = static_cast<UINT>(size.Height);
        if (desc.Width < width || desc.Height < height || desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
            throw std::runtime_error("Unexpected capture texture format");
        }
        foundation::TimeSpan time{};
        check(frame->get_SystemRelativeTime(&time), "Read capture timestamp");
        slot->prepare(source.device.Get(), size);
        const HRESULT acquired = slot->mutex->AcquireSync(0, 0);
        if (acquired == WAIT_TIMEOUT) {
            closeWinRt(frame);
            return;
        }
        if (acquired != S_OK) throw std::runtime_error("GPU share texture is unavailable");
        const D3D11_BOX region{0, 0, 0, width, height, 1};
        source.context->CopySubresourceRegion(slot->texture.Get(), 0, 0, 0, 0, texture.Get(), 0, &region);
        check(slot->mutex->ReleaseSync(0), "Release GPU share texture mutex");
        source.context->End(slot->query.Get());
        source.context->Flush();
        slot->timestamp = time.Duration > 0 ? static_cast<uint64_t>(time.Duration / 10) : 0;
        slot->pending = std::move(frame);
    }

    bool gpuBusy() const {
        return std::any_of(slots_.begin(), slots_.end(), [](const auto& slot) { return static_cast<bool>(slot.pending); });
    }

    Clock::duration interval = 1'000'000us / 60;

private:
    Handle parent_;
    HANDLE input_ = nullptr;
    HANDLE output_ = nullptr;
    std::array<Slot, slotCount> slots_{};
    std::array<char, 64> command_{};
    size_t commandSize_ = 0;
    uint64_t sequence_ = 0;
};

void record(DWORD parent, Target target) {
    Capture source;
    Producer producer(parent);
    source.open(target);
    const Handle tick(CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                            TIMER_MODIFY_STATE | SYNCHRONIZE));
    auto next = Clock::now();
    auto verify = next;
    while (!source.closed() && producer.running() && producer.publishCompleted(source.context.Get())) {
        const auto now = Clock::now();
        if (now >= verify) {
            if (!target.valid()) break;
            verify = now + 500ms;
        }
        if (now >= next) {
            producer.captureLatest(source);
            next = now + producer.interval;
        }
        const auto untilNext = std::chrono::duration_cast<std::chrono::milliseconds>(next - Clock::now());
        const auto wait = producer.gpuBusy() ? 1ms : std::clamp(untilNext, 1ms, 6ms);
        LARGE_INTEGER delay{};
        delay.QuadPart = -10'000 * wait.count();
        if (tick.get() && SetWaitableTimer(tick.get(), &delay, 0, nullptr, nullptr, FALSE)) {
            WaitForSingleObject(tick.get(), INFINITE);
        } else Sleep(static_cast<DWORD>(wait.count()));
    }
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc == 2 && std::string_view(argv[1]) == "--version") {
            std::puts("rooms-windows-capture 1");
            return 0;
        }
        const Runtime runtime;
        if (argc == 2 && std::string_view(argv[1]) == "--probe") {
            const Capture source;
            Slot test;
            test.prepare(source.device.Get(), {16, 16});
            std::puts("ok");
            return 0;
        }
        if ((argc != 5 && argc != 6) || std::string_view(argv[1]) != "capture") {
            throw std::runtime_error("Usage: rooms-windows-capture capture <parent-pid> window <hwnd> | monitor <x> <y>");
        }
        const DWORD parent = integer<DWORD>(argv[2]);
        const std::string_view kind = argv[3];
        Target target;
        if (kind == "window" && argc == 5) {
            target.window = reinterpret_cast<HWND>(integer<uintptr_t>(argv[4]));
        } else if (kind == "monitor" && argc == 6) {
            if (!SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
                throw std::runtime_error("Set physical screen coordinates");
            }
            const POINT point{integer<LONG>(argv[4]), integer<LONG>(argv[5])};
            target.monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONULL);
        } else {
            throw std::runtime_error("Invalid capture target");
        }
        record(parent, target);
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
