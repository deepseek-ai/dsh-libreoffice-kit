// Private one-document process. Stdout is reserved for the final JSON result;
// LibreOffice diagnostics go to stderr. The Node owner cancels by terminating it.
#ifdef __APPLE__
#include <TargetConditionals.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreText/CoreText.h>
#endif
#include <cassert>
#define LOK_USE_UNSTABLE_API
#include <LibreOfficeKit/LibreOfficeKitInit.h>
#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <io.h>
#else
#include <sys/resource.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;
namespace {
struct ConversionError : std::runtime_error {
    const char* code;
    ConversionError(const char* code, const std::string& message) : std::runtime_error(message), code(code) {}
};

struct Request {
    std::string program, input, output, profile;
    std::vector<std::string> fonts;
    unsigned long long maxOutput = 0;
    unsigned int resolution = 0;
};

std::string jsonString(const std::string& value)
{
    std::string result = "\"";
    for (unsigned char ch : value) {
        if (ch == '"' || ch == '\\') { result += '\\'; result += ch; }
        else if (ch < 32) {
            char escaped[7];
            std::snprintf(escaped, sizeof escaped, "\\u%04x", ch);
            result += escaped;
        } else result += ch;
    }
    return result + '"';
}

unsigned long long positiveInteger(const std::string& text)
{
    if (text.empty() || !std::all_of(text.begin(), text.end(), [](char c) { return c >= '0' && c <= '9'; }))
        throw std::runtime_error("Expected a positive integer");
    auto value = std::stoull(text);
    if (value == 0) throw std::runtime_error("Expected a positive integer");
    return value;
}

Request parse(const std::vector<std::string>& args)
{
    Request request;
    for (size_t i = 1; i < args.size(); i += 2) {
        if (i + 1 == args.size()) throw std::runtime_error("Missing worker argument value");
        const auto& option = args[i];
        const auto& value = args[i + 1];
        if (option == "--program-directory") request.program = value;
        else if (option == "--input-path") request.input = value;
        else if (option == "--output-path") request.output = value;
        else if (option == "--profile-directory") request.profile = value;
        else if (option == "--font-file") request.fonts.push_back(value);
        else if (option == "--max-output-bytes") request.maxOutput = positiveInteger(value);
        else if (option == "--max-image-resolution") {
            auto resolution = positiveInteger(value);
            if (resolution > std::numeric_limits<unsigned int>::max()) throw std::runtime_error("Image resolution exceeds uint32");
            request.resolution = static_cast<unsigned int>(resolution);
        } else throw std::runtime_error("Unknown worker argument: " + option);
    }
    for (const auto& path : {request.program, request.input, request.output, request.profile})
        if (path.empty() || !fs::u8path(path).is_absolute()) throw std::runtime_error("Worker requires absolute paths");
    if (!request.maxOutput || !request.resolution) throw std::runtime_error("Worker limits are required");
    if (fs::exists(fs::u8path(request.output))) throw std::runtime_error("Output path already exists");
    return request;
}

std::string fileUrl(const std::string& path)
{
    const auto normalized = fs::u8path(path).generic_u8string();
    std::string result = normalized.front() == '/' ? "file://" : "file:///";
    for (unsigned char c : normalized) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
            || c == '/' || c == ':' || c == '-' || c == '_' || c == '.' || c == '~') result += c;
        else {
            char encoded[4];
            std::snprintf(encoded, sizeof encoded, "%%%02X", c);
            result += encoded;
        }
    }
    return result;
}

void environment(const char* name, const std::string& value)
{
#ifdef _WIN32
    if (_putenv_s(name, value.c_str()) != 0) throw std::runtime_error("Failed to set worker environment");
#else
    if (setenv(name, value.c_str(), 1) != 0) throw std::runtime_error("Failed to set worker environment");
#endif
}

std::string officeError(LibreOfficeKit* office)
{
    char* value = office->pClass->getError(office);
    std::string message = value && *value ? value : "LibreOffice conversion failed";
    office->pClass->freeError(value);
    return message;
}

void registerFont(const std::string& font, LibreOfficeKit* office)
{
    if (!fs::is_regular_file(fs::u8path(font))) throw std::runtime_error("Font is not a regular file");
#ifdef __APPLE__
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(nullptr, reinterpret_cast<const UInt8*>(font.data()), font.size(), false);
    if (!url) throw std::runtime_error("Failed to create font URL");
    CFErrorRef error = nullptr;
    bool registered = CTFontManagerRegisterFontsForURL(url, kCTFontManagerScopeProcess, &error);
    CFRelease(url);
    // A font already registered by the system is available to this process.
    bool duplicate = error && CFErrorGetCode(error) == kCTFontManagerErrorAlreadyRegistered;
    if (error) CFRelease(error);
    if (!registered && !duplicate) throw std::runtime_error("CoreText rejected font: " + font);
#elif defined(_WIN32)
    if (!AddFontResourceExW(fs::u8path(font).c_str(), FR_PRIVATE, nullptr))
        throw std::runtime_error("Windows rejected font: " + font);
#else
    office->pClass->setOption(office, "addfont", font.c_str());
#endif
}

void convert(const Request& request)
{
    fs::create_directories(fs::u8path(request.profile));
#ifdef __APPLE__
    environment("SAL_LOK_OPTIONS", "unipoll");
#else
    environment("SAL_LOK_OPTIONS", "");
#endif
    environment("SAL_DISABLE_OPENCL", "1");
    environment("LOK_HOST_ALLOWLIST", "^$");
#ifndef _WIN32
    // Limit individual writes, including the PDF, even when an export grows unexpectedly.
    struct rlimit limit;
    if (getrlimit(RLIMIT_FSIZE, &limit) != 0) throw std::runtime_error("Cannot inspect worker file-size limit");
    limit.rlim_cur = std::min<rlim_t>(limit.rlim_max, request.maxOutput);
    if (setrlimit(RLIMIT_FSIZE, &limit) != 0) throw std::runtime_error("Cannot enforce worker file-size limit");
#endif
#if !defined(__APPLE__) && !defined(_WIN32)
    const auto fontConfig = fs::u8path(request.profile) / "fonts.conf";
    std::ofstream config;
    config.exceptions(std::ios::badbit | std::ios::failbit);
    config.open(fontConfig);
    config << "<?xml version=\"1.0\"?><!DOCTYPE fontconfig SYSTEM \"fonts.dtd\"><fontconfig></fontconfig>\n";
    config.close();
    environment("FONTCONFIG_FILE", fontConfig.u8string());
#endif
    const auto profileUrl = fileUrl(request.profile);
#if defined(__APPLE__) || defined(_WIN32)
    // Core enumerates these process-local fonts while initializing its first font collection.
    for (const auto& font : request.fonts) registerFont(font, nullptr);
#endif
    std::unique_ptr<LibreOfficeKit, void(*)(LibreOfficeKit*)> office(lok_init_2(request.program.c_str(), profileUrl.c_str()),
        [](LibreOfficeKit* value) { value->pClass->destroy(value); });
    if (!office) throw ConversionError("unavailable", "LibreOfficeKit initialization failed");
#if !defined(__APPLE__) && !defined(_WIN32)
    for (const auto& font : request.fonts) registerFont(font, office.get());
#endif
    const auto input = fileUrl(request.input);
    std::unique_ptr<LibreOfficeKitDocument, void(*)(LibreOfficeKitDocument*)> document(
        office->pClass->documentLoadWithOptions(office.get(), input.c_str(), "Batch=true,EnableMacrosExecution=false"),
        [](LibreOfficeKitDocument* value) { value->pClass->destroy(value); });
    if (!document) throw std::runtime_error(officeError(office.get()));
    const auto options = std::string("{\"ReduceImageResolution\":{\"type\":\"boolean\",\"value\":\"true\"},\"MaxImageResolution\":{\"type\":\"long\",\"value\":\"")
        + std::to_string(request.resolution) + "\"},\"ExportBookmarks\":{\"type\":\"boolean\",\"value\":\"true\"}}";
    const auto output = fileUrl(request.output);
    if (!document->pClass->saveAs(document.get(), output.c_str(), "pdf", options.c_str()))
        throw std::runtime_error(officeError(office.get()));
    if (fs::file_size(fs::u8path(request.output)) > request.maxOutput) {
        fs::remove(fs::u8path(request.output));
        throw ConversionError("output-too-large", "PDF exceeds maxOutputBytes");
    }
    char header[5] = {};
    std::ifstream(fs::u8path(request.output), std::ios::binary).read(header, sizeof header);
    if (std::memcmp(header, "%PDF-", sizeof header) != 0) throw ConversionError("invalid-output", "LibreOffice did not produce PDF bytes");
}

int execute(const std::vector<std::string>& args)
{
#ifdef _WIN32
    int resultFd = _dup(_fileno(stdout));
    if (resultFd < 0 || _dup2(_fileno(stderr), _fileno(stdout)) != 0) return 2;
    FILE* result = _fdopen(resultFd, "w");
#else
    int resultFd = dup(fileno(stdout));
    if (resultFd < 0 || dup2(fileno(stderr), fileno(stdout)) < 0) return 2;
    FILE* result = fdopen(resultFd, "w");
#endif
    if (!result) return 2;
    int code = 0;
    try {
        convert(parse(args));
        std::fprintf(result, "{\"ok\":true,\"missingFonts\":[]}\n");
    } catch (const ConversionError& error) {
        std::fprintf(result, "{\"ok\":false,\"code\":%s,\"error\":%s}\n", jsonString(error.code).c_str(), jsonString(error.what()).c_str());
        code = 1;
    } catch (const std::exception& error) {
        std::fprintf(result, "{\"ok\":false,\"code\":\"failed\",\"error\":%s}\n", jsonString(error.what()).c_str());
        code = 1;
    } catch (...) {
        std::fprintf(result, "{\"ok\":false,\"code\":\"failed\",\"error\":\"Unknown LibreOfficeKit exception\"}\n");
        code = 1;
    }
    std::fclose(result);
    return code;
}
}

#ifdef _WIN32
int wmain(int argc, wchar_t** argv)
{
    std::vector<std::string> args;
    for (int i = 0; i < argc; ++i) {
        char* text = lok_wide_string_to_string(argv[i]);
        if (!text) return 2;
        args.emplace_back(text);
        std::free(text);
    }
    return execute(args);
}
#else
int main(int argc, char** argv)
{
    const int code = execute({argv, argv + argc});
#ifdef __APPLE__
    // Document/office handles and result output are closed by execute(). The
    // app-loop-free Mac process cannot run Writer's clipboard static teardown
    // after LOK has released its singleton; process exit releases those globals.
    std::_Exit(code);
#else
    return code;
#endif
}
#endif
