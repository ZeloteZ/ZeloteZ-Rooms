#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <initguid.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {
constexpr std::uint32_t sampleRate = 48000;
constexpr std::uint32_t channels = 2;
constexpr std::uint32_t framesPerBlock = 480;
constexpr std::uint32_t delayFrames = 1920;
constexpr std::uint32_t ringFrames = sampleRate;
constexpr std::uint64_t ticksPerSecond = 10000000;

// AUDIOCLIENT_ACTIVATION_PARAMS from the Windows SDK. Some MinGW SDKs omit
// audioclientactivationparams.h. These documented DWORD fields have a fixed ABI.
struct ProcessActivationParameters {
    DWORD activationType = 1;
    DWORD processId = 0;
    DWORD processLoopbackMode = 0;
};
static_assert(sizeof(ProcessActivationParameters) == 12);

void require(HRESULT result, const char* operation) {
    if (SUCCEEDED(result)) return;
    std::ostringstream message;
    message << operation << " failed (0x" << std::hex << std::setw(8)
            << std::setfill('0') << static_cast<std::uint32_t>(result) << ')';
    throw std::runtime_error(message.str());
}

template<class T> class ComPointer {
public:
    ComPointer() = default;
    explicit ComPointer(T* value) : value_(value) {}
    ~ComPointer() { if (value_) value_->Release(); }
    ComPointer(const ComPointer&) = delete;
    ComPointer& operator=(const ComPointer&) = delete;
    ComPointer(ComPointer&& other) noexcept : value_(std::exchange(other.value_, nullptr)) {}
    ComPointer& operator=(ComPointer&& other) noexcept {
        if (value_) value_->Release();
        value_ = std::exchange(other.value_, nullptr);
        return *this;
    }
    T* get() const { return value_; }
    T* operator->() const { return value_; }
    T** put() {
        if (value_) value_->Release();
        value_ = nullptr;
        return &value_;
    }
private:
    T* value_ = nullptr;
};

class Handle {
public:
    explicit Handle(HANDLE value = nullptr) : value_(value) {}
    ~Handle() { if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    HANDLE get() const { return value_; }
private:
    HANDLE value_;
};

struct ComApartment {
    ComApartment() { require(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM initialization"); }
    ~ComApartment() { CoUninitialize(); }
};

DWORD windowsBuild() {
    using VersionFunction = LONG (WINAPI*)(OSVERSIONINFOW*);
    const FARPROC address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    VersionFunction function = nullptr;
    static_assert(sizeof(function) == sizeof(address));
    std::memcpy(&function, &address, sizeof(function));
    OSVERSIONINFOW version{};
    version.dwOSVersionInfoSize = sizeof(version);
    if (!function || function(&version) != 0 || version.dwMajorVersion < 10) {
        throw std::runtime_error("Windows 10 or later is required");
    }
    return version.dwBuildNumber;
}

std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (!size) throw std::runtime_error("Invalid UTF-16 audio source name");
    std::string result(size, '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), result.data(), size, nullptr, nullptr) != size) {
        throw std::runtime_error("Could not encode audio source name");
    }
    return result;
}

std::string jsonString(const std::string& value) {
    std::ostringstream result;
    result << '"';
    for (const unsigned char character : value) {
        if (character == '"' || character == '\\') result << '\\' << character;
        else if (character < 0x20) result << "\\u00" << std::hex << std::setw(2)
            << std::setfill('0') << static_cast<unsigned int>(character);
        else result << character;
    }
    result << '"';
    return result.str();
}

struct Choice {
    std::string title;
    std::string serial;
    std::string identity;
};

std::string endpointIdentity(const std::string& serial, const std::string& instance, const std::string& title) {
    const std::string input = "[" + jsonString(serial) + "," + jsonString(instance) + "," + jsonString(title) + "]";
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) {
        throw std::runtime_error("Could not initialize the playback identity hash");
    }
    std::array<unsigned char, 32> digest{};
    const NTSTATUS status = BCryptHash(algorithm, nullptr, 0,
        reinterpret_cast<PUCHAR>(const_cast<char*>(input.data())), static_cast<ULONG>(input.size()),
        digest.data(), static_cast<ULONG>(digest.size()));
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (status < 0) throw std::runtime_error("Could not hash the selected playback identity");
    std::ostringstream result;
    result << "endpoint-v1:" << std::hex << std::setfill('0');
    for (const auto byte : digest) result << std::setw(2) << static_cast<unsigned int>(byte);
    return result.str();
}

ComPointer<IMMDeviceEnumerator> deviceEnumerator() {
    ComPointer<IMMDeviceEnumerator> result;
    require(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(result.put())), "Audio device enumeration");
    return result;
}

std::wstring property(IMMDevice* device, REFPROPERTYKEY key) {
    ComPointer<IPropertyStore> store;
    require(device->OpenPropertyStore(STGM_READ, store.put()), "Audio device properties");
    PROPVARIANT value{};
    const HRESULT result = store->GetValue(key, &value);
    std::wstring text;
    if (SUCCEEDED(result) && value.vt == VT_LPWSTR && value.pwszVal) text = value.pwszVal;
    PropVariantClear(&value);
    return text;
}

Choice deviceChoice(IMMDevice* device) {
    ComPointer<IMMEndpoint> endpoint;
    require(device->QueryInterface(__uuidof(IMMEndpoint), reinterpret_cast<void**>(endpoint.put())), "Audio endpoint type");
    EDataFlow flow;
    require(endpoint->GetDataFlow(&flow), "Audio endpoint direction");
    if (flow != eRender) throw std::runtime_error("The selected device is not a playback endpoint");
    DWORD state = 0;
    require(device->GetState(&state), "Audio device state");
    if (state != DEVICE_STATE_ACTIVE) throw std::runtime_error("The selected playback device is unavailable");
    LPWSTR identifier = nullptr;
    require(device->GetId(&identifier), "Audio device identifier");
    const std::wstring id(identifier);
    CoTaskMemFree(identifier);
    const std::wstring title = property(device, PKEY_Device_FriendlyName);
    Choice result{utf8(title.empty() ? id : title), utf8(id), {}};
    result.identity = endpointIdentity(result.serial, utf8(property(device, PKEY_Device_InstanceId)), result.title);
    if (result.serial.empty() || result.serial.size() > 1024 || result.identity.size() > 1024) {
        throw std::runtime_error("The playback device identifier is too long");
    }
    return result;
}

std::string processIdentity(HANDLE process) {
    if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT) throw std::runtime_error("The selected process has exited");
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) {
        throw std::runtime_error("Could not read the selected process identity");
    }
    std::ostringstream result;
    result << std::hex << std::setfill('0') << std::setw(8) << created.dwHighDateTime
           << std::setw(8) << created.dwLowDateTime;
    return result.str();
}

std::vector<Choice> listChoices(bool application) {
    auto enumerator = deviceEnumerator();
    ComPointer<IMMDeviceCollection> devices;
    require(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, devices.put()), "Playback device list");
    UINT count = 0;
    require(devices->GetCount(&count), "Playback device count");
    std::vector<Choice> choices;
    std::map<DWORD, bool> included;
    for (UINT index = 0; index < count && choices.size() < 256; ++index) {
        ComPointer<IMMDevice> device;
        if (FAILED(devices->Item(index, device.put()))) continue;
        if (!application) {
            try { choices.push_back(deviceChoice(device.get())); }
            catch (const std::exception&) { /* A device can disappear while its properties are read. */ }
            continue;
        }
        ComPointer<IAudioSessionManager2> manager;
        if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
            reinterpret_cast<void**>(manager.put())))) continue;
        ComPointer<IAudioSessionEnumerator> sessions;
        if (FAILED(manager->GetSessionEnumerator(sessions.put()))) continue;
        int sessionCount = 0;
        if (FAILED(sessions->GetCount(&sessionCount))) continue;
        for (int item = 0; item < sessionCount && choices.size() < 256; ++item) {
            ComPointer<IAudioSessionControl> control;
            if (FAILED(sessions->GetSession(item, control.put()))) continue;
            AudioSessionState state;
            if (FAILED(control->GetState(&state)) || state != AudioSessionStateActive) continue;
            ComPointer<IAudioSessionControl2> session;
            if (FAILED(control->QueryInterface(__uuidof(IAudioSessionControl2), reinterpret_cast<void**>(session.put())))) continue;
            DWORD pid = 0;
            if (session->IsSystemSoundsSession() == S_OK || FAILED(session->GetProcessId(&pid)) || !pid || included.count(pid)) continue;
            Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
            if (!process.get()) continue;
            std::array<wchar_t, 32768> image{};
            DWORD length = static_cast<DWORD>(image.size());
            if (!QueryFullProcessImageNameW(process.get(), 0, image.data(), &length)) continue;
            std::wstring title(image.data(), length);
            title = title.substr(title.find_last_of(L"\\/") + 1);
            LPWSTR displayName = nullptr;
            if (SUCCEEDED(control->GetDisplayName(&displayName)) && displayName) {
                if (*displayName && *displayName != L'@') title = displayName;
                CoTaskMemFree(displayName);
            }
            try {
                choices.push_back({utf8(title) + " (" + std::to_string(pid) + ")", std::to_string(pid), processIdentity(process.get())});
                included.emplace(pid, true);
            } catch (const std::exception&) { /* Ignore a process that exited during enumeration. */ }
        }
    }
    std::sort(choices.begin(), choices.end(), [](const Choice& left, const Choice& right) { return left.title < right.title; });
    return choices;
}

void writeAll(const void* data, std::size_t size) {
    const auto* bytes = static_cast<const unsigned char*>(data);
    while (size) {
        DWORD written = 0;
        if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes, static_cast<DWORD>(size), &written, nullptr) || !written) {
            throw std::runtime_error("The audio output pipe closed");
        }
        bytes += written;
        size -= written;
    }
}

void printChoices(const std::vector<Choice>& choices) {
    std::string result = "[";
    for (const Choice& choice : choices) {
        const std::string item = "{\"title\":" + jsonString(choice.title) + ",\"serial\":" + jsonString(choice.serial)
            + ",\"identity\":" + jsonString(choice.identity) + "}";
        if (result.size() + item.size() + 3 > 512 * 1024) break;
        if (result.size() > 1) result += ',';
        result += item;
    }
    result += "]\n";
    writeAll(result.data(), result.size());
}

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler {
public:
    explicit ActivationHandler(DWORD pid) : completed_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
        if (!completed_.get()) throw std::runtime_error("Could not create audio activation event");
        require(CoCreateFreeThreadedMarshaler(this, marshaler_.put()), "Audio activation marshaler");
        parameters_.processId = pid;
        variant_.vt = VT_BLOB;
        variant_.blob.cbSize = sizeof(parameters_);
        variant_.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters_);
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** output) override {
        if (!output) return E_POINTER;
        *output = nullptr;
        if (id == __uuidof(IUnknown) || id == __uuidof(IActivateAudioInterfaceCompletionHandler) || id == __uuidof(IAgileObject)) {
            *output = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        if (id == __uuidof(IMarshal)) return marshaler_->QueryInterface(id, output);
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining = --references_;
        if (!remaining) delete this;
        return remaining;
    }
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activation = E_FAIL;
        ComPointer<IUnknown> result;
        result_ = operation->GetActivateResult(&activation, result.put());
        if (SUCCEEDED(result_)) result_ = activation;
        if (SUCCEEDED(result_)) result_ = result->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(client_.put()));
        SetEvent(completed_.get());
        return S_OK;
    }
    PROPVARIANT* parameters() { return &variant_; }
    ComPointer<IAudioClient> wait(HANDLE process) {
        HANDLE handles[] = {process, completed_.get()};
        if (WaitForMultipleObjects(2, handles, FALSE, 3000) != WAIT_OBJECT_0 + 1) {
            throw std::runtime_error("Process audio activation timed out or the selected process exited");
        }
        require(result_, "Process audio activation");
        return std::move(client_);
    }
private:
    std::atomic<ULONG> references_{1};
    Handle completed_;
    ComPointer<IUnknown> marshaler_;
    ComPointer<IAudioClient> client_;
    ProcessActivationParameters parameters_{};
    PROPVARIANT variant_{};
    HRESULT result_ = E_FAIL;
};

std::uint64_t clockTicks() {
    LARGE_INTEGER counter{}, frequency{};
    if (!QueryPerformanceCounter(&counter) || !QueryPerformanceFrequency(&frequency) || frequency.QuadPart <= 0) {
        throw std::runtime_error("The audio clock is unavailable");
    }
    return static_cast<std::uint64_t>(counter.QuadPart / frequency.QuadPart) * ticksPerSecond
        + static_cast<std::uint64_t>(counter.QuadPart % frequency.QuadPart) * ticksPerSecond / frequency.QuadPart;
}

std::int64_t framesAt(std::int64_t ticks) {
    return ticks / static_cast<std::int64_t>(ticksPerSecond) * sampleRate
        + ticks % static_cast<std::int64_t>(ticksPerSecond) * sampleRate / static_cast<std::int64_t>(ticksPerSecond);
}

void checkSource(HANDLE process, IMMDevice* device) {
    if (process && WaitForSingleObject(process, 0) != WAIT_TIMEOUT) throw std::runtime_error("The selected process has exited");
    if (device) {
        DWORD state = 0;
        require(device->GetState(&state), "Playback device availability");
        if (state != DEVICE_STATE_ACTIVE) throw std::runtime_error("The selected playback device is unavailable");
    }
}

void capture(IAudioClient* client, HANDLE process, IMMDevice* device) {
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = channels;
    format.nSamplesPerSec = sampleRate;
    format.wBitsPerSample = 16;
    format.nBlockAlign = channels * sizeof(std::int16_t);
    format.nAvgBytesPerSec = sampleRate * format.nBlockAlign;
    Handle sampleReady(CreateEventW(nullptr, FALSE, FALSE, nullptr));
    if (!sampleReady.get()) throw std::runtime_error("Could not create the audio sample event");
    require(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        0, 0, &format, nullptr), "48 kHz stereo PCM loopback");
    ComPointer<IAudioCaptureClient> packets;
    require(client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(packets.put())), "Audio capture service");
    require(client->SetEventHandle(sampleReady.get()), "Audio sample event");
    Handle timer(CreateWaitableTimerW(nullptr, FALSE, nullptr));
    LARGE_INTEGER due{};
    due.QuadPart = -100000;
    if (!timer.get() || !SetWaitableTimer(timer.get(), &due, 10, nullptr, nullptr, FALSE)) {
        throw std::runtime_error("Could not start the audio output clock");
    }
    checkSource(process, device);
    require(client->Start(), "Audio capture start");
    const std::uint64_t started = clockTicks();
    std::vector<std::int16_t> ring(ringFrames * channels, 0);
    std::uint64_t emitted = 0;
    try {
        for (;;) {
            std::array<HANDLE, 3> handles{};
            DWORD count = 0;
            if (process) handles[count++] = process;
            handles[count++] = sampleReady.get();
            handles[count++] = timer.get();
            const DWORD wait = WaitForMultipleObjects(count, handles.data(), FALSE, 1000);
            if (wait == WAIT_FAILED || wait == WAIT_TIMEOUT) throw std::runtime_error("Audio output clock stopped");
            checkSource(process, device);
            const auto elapsed = static_cast<std::uint64_t>(framesAt(static_cast<std::int64_t>(clockTicks() - started)));
            if (elapsed > emitted + ringFrames) {
                // A paused receiver must resume at the current clock, without an old-audio burst.
                emitted = elapsed - elapsed % framesPerBlock;
                std::fill(ring.begin(), ring.end(), 0);
            }
            UINT32 available = 0;
            require(packets->GetNextPacketSize(&available), "Audio packet availability");
            while (available) {
                BYTE* data = nullptr;
                UINT32 frames = 0;
                DWORD flags = 0;
                UINT64 timestamp = 0;
                require(packets->GetBuffer(&data, &frames, &flags, nullptr, &timestamp), "Audio capture packet");
                const auto received = clockTicks();
                if ((flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) || !timestamp || timestamp > received + ticksPerSecond
                    || (received > ticksPerSecond && timestamp < received - ticksPerSecond)) {
                    // WASAPI can flag transient startup timestamps. The source remains unchanged.
                    timestamp = received - static_cast<std::uint64_t>(frames) * ticksPerSecond / sampleRate;
                }
                const std::int64_t first = framesAt(static_cast<std::int64_t>(timestamp) - static_cast<std::int64_t>(started)) + delayFrames;
                for (UINT32 frame = 0; frame < frames; ++frame) {
                    const std::int64_t position = first + frame;
                    if (position < static_cast<std::int64_t>(emitted)
                        || position >= static_cast<std::int64_t>(emitted + ringFrames)) continue;
                    const auto index = static_cast<std::uint64_t>(position) % ringFrames * channels;
                    for (UINT32 channel = 0; channel < channels; ++channel) {
                        ring[index + channel] = flags & AUDCLNT_BUFFERFLAGS_SILENT ? 0
                            : reinterpret_cast<const std::int16_t*>(data)[frame * channels + channel];
                    }
                }
                require(packets->ReleaseBuffer(frames), "Audio capture release");
                require(packets->GetNextPacketSize(&available), "Audio packet availability");
            }
            while (elapsed >= emitted + framesPerBlock) {
                checkSource(process, device);
                std::array<std::int16_t, framesPerBlock * channels> block{};
                for (UINT32 frame = 0; frame < framesPerBlock; ++frame) {
                    const auto index = (emitted + frame) % ringFrames * channels;
                    for (UINT32 channel = 0; channel < channels; ++channel) {
                        block[frame * channels + channel] = std::exchange(ring[index + channel], 0);
                    }
                }
                writeAll(block.data(), block.size() * sizeof(std::int16_t));
                emitted += framesPerBlock;
            }
        }
    } catch (...) {
        client->Stop();
        throw;
    }
}

void record(bool application, const std::wstring& serial, const std::string& identity) {
    if (identity.empty() || identity.size() > 1024 || serial.empty() || utf8(serial).size() > 1024) {
        throw std::runtime_error("Invalid selected source identity");
    }
    if (application) {
        if (serial.size() > 10 || serial.front() == L'0' || serial.find_first_not_of(L"0123456789") != std::wstring::npos) {
            throw std::runtime_error("Invalid selected process identifier");
        }
        const auto number = std::stoull(serial);
        if (number > MAXDWORD) throw std::runtime_error("Invalid selected process identifier");
        const DWORD pid = static_cast<DWORD>(number);
        Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
        if (!process.get() || processIdentity(process.get()) != identity) throw std::runtime_error("The selected process identity changed");
        ComPointer<ActivationHandler> handler(new ActivationHandler(pid));
        ComPointer<IActivateAudioInterfaceAsyncOperation> operation;
        require(ActivateAudioInterfaceAsync(L"VAD\\Process_Loopback", __uuidof(IAudioClient),
            handler->parameters(), handler.get(), operation.put()), "Process loopback activation");
        auto client = handler->wait(process.get());
        if (processIdentity(process.get()) != identity) throw std::runtime_error("The selected process identity changed");
        capture(client.get(), process.get(), nullptr);
    } else {
        auto enumerator = deviceEnumerator();
        ComPointer<IMMDevice> device;
        require(enumerator->GetDevice(serial.c_str(), device.put()), "Selected playback device");
        if (deviceChoice(device.get()).identity != identity) throw std::runtime_error("The selected playback device identity changed");
        ComPointer<IAudioClient> client;
        require(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
            reinterpret_cast<void**>(client.put())), "Selected playback device activation");
        capture(client.get(), nullptr, device.get());
    }
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc == 2 && std::wstring(argv[1]) == L"--version") {
            std::cout << "rooms-windows-audio 1\n";
            return 0;
        }
        if (argc == 2 && std::wstring(argv[1]) == L"--help") {
            std::cout << "rooms-windows-audio list application|system\n"
                         "rooms-windows-audio record application|system <serial> <identity>\n"
                         "record emits 48000 Hz stereo signed 16-bit little-endian PCM.\n";
            return 0;
        }
        if ((argc != 3 && argc != 5) || (std::wstring(argv[2]) != L"application" && std::wstring(argv[2]) != L"system")
            || (argc == 3 && std::wstring(argv[1]) != L"list") || (argc == 5 && std::wstring(argv[1]) != L"record")) {
            throw std::runtime_error("Invalid arguments. Use --help for usage");
        }
        const bool application = std::wstring(argv[2]) == L"application";
        const DWORD build = windowsBuild();
        if (application && build < 22000) throw std::runtime_error("Application audio requires Windows 11 build 22000 or later");
        ComApartment apartment;
        if (argc == 3) printChoices(listChoices(application));
        else record(application, argv[3], utf8(argv[4]));
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
