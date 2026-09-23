// Private one-document process. Protocol output uses a duplicate stdout;
// LibreOffice diagnostics remain on stderr. The Node owner cancels by terminating it.
#ifdef __APPLE__
#include <TargetConditionals.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreText/CoreText.h>
#endif
#include <cassert>
#define LOK_USE_UNSTABLE_API
#ifdef DSH_STATIC_LOK
#include <LibreOfficeKit/LibreOfficeKit.h>
extern "C" LibreOfficeKit* libreofficekit_hook_2(const char*, const char*);
static LibreOfficeKit* lok_init_2(const char* program, const char* profile)
{
    return libreofficekit_hook_2(program, profile);
}
#else
#include <LibreOfficeKit/LibreOfficeKitInit.h>
#endif
#include "../document-operations.hxx"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#include <io.h>
#else
#include <unistd.h>
#endif

namespace fs = std::filesystem;
namespace {
struct ConversionError : std::runtime_error {
    const char* code;
    ConversionError(const char* code, const std::string& message) : std::runtime_error(message), code(code) {}
};

struct Request {
    std::string operation = "convert", program, input, output, scratch, profile, format = "pdf", sheet;
    bool recalculate = false;
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
        if (option == "--operation") request.operation = value;
        else if (option == "--program-directory") request.program = value;
        else if (option == "--input-path") request.input = value;
        else if (option == "--output-path") request.output = value;
        else if (option == "--scratch-directory") request.scratch = value;
        else if (option == "--profile-directory") request.profile = value;
        else if (option == "--format") request.format = value;
        else if (option == "--sheet") {
            if (value.empty()) throw std::runtime_error("Worksheet name must be nonempty");
            request.sheet = value;
        }
        else if (option == "--recalculate") {
            if (value != "true" && value != "false") throw std::runtime_error("Expected boolean recalculation flag");
            request.recalculate = value == "true";
        }
        else if (option == "--font-file") request.fonts.push_back(value);
        else if (option == "--max-output-bytes") request.maxOutput = positiveInteger(value);
        else if (option == "--max-image-resolution") {
            auto resolution = positiveInteger(value);
            if (resolution > std::numeric_limits<unsigned int>::max()) throw std::runtime_error("Image resolution exceeds uint32");
            request.resolution = static_cast<unsigned int>(resolution);
        } else throw std::runtime_error("Unknown worker argument: " + option);
    }
    if (request.operation != "convert" && request.operation != "render-images") throw std::runtime_error("Unknown worker operation");
    for (const auto& path : {request.program, request.input, request.profile})
        if (path.empty() || !fs::u8path(path).is_absolute()) throw std::runtime_error("Worker requires absolute paths");
    if (!request.maxOutput || !request.resolution) throw std::runtime_error("Worker limits are required");
    if (request.operation == "render-images") {
        if (request.scratch.empty() || !fs::u8path(request.scratch).is_absolute()) throw std::runtime_error("Raster scratch directory must be absolute");
    } else {
        if (request.output.empty() || !fs::u8path(request.output).is_absolute()) throw std::runtime_error("Output path must be absolute");
        const std::vector<std::string> formats = {"pdf", "docx", "odt", "txt", "xlsx", "ods", "csv", "pptx", "odp"};
        if (std::find(formats.begin(), formats.end(), request.format) == formats.end()) throw std::runtime_error("Unsupported output format");
        if (!request.sheet.empty() && request.format != "csv") throw std::runtime_error("Worksheet selection is only supported for CSV");
        if (request.recalculate && request.format != "xlsx" && request.format != "ods") throw std::runtime_error("Recalculation output must be XLSX or ODS");
        if (fs::exists(fs::u8path(request.output))) throw std::runtime_error("Output path already exists");
    }
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
    std::string message = value && *value ? value : "LibreOffice operation failed";
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

void prepareEnvironment(const Request& request)
{
#ifdef _WIN32
    if (!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)
        || !AddDllDirectory(fs::u8path(request.program).c_str()))
        throw ConversionError("unavailable", "Failed to configure Windows library search directories");
#endif
    fs::create_directories(fs::u8path(request.profile));
    environment("SAL_LOK_OPTIONS", "unipoll");
    environment("SAL_DISABLE_OPENCL", "1");
    environment("SAL_ACCESSIBILITY_ENABLED", "0");
    environment("LOK_HOST_ALLOWLIST", "^$");
#if !defined(__APPLE__) && !defined(_WIN32)
    const auto fontConfig = fs::u8path(request.profile) / "fonts.conf";
    std::ofstream config;
    config.exceptions(std::ios::badbit | std::ios::failbit);
    config.open(fontConfig);
    config << "<?xml version=\"1.0\"?><!DOCTYPE fontconfig SYSTEM \"fonts.dtd\"><fontconfig></fontconfig>\n";
    config.close();
    environment("FONTCONFIG_FILE", fontConfig.u8string());
#endif
#if defined(__APPLE__) || defined(_WIN32)
    for (const auto& font : request.fonts) registerFont(font, nullptr);
#endif
}

using OfficePtr = std::unique_ptr<LibreOfficeKit, void(*)(LibreOfficeKit*)>;
using DocumentPtr = std::unique_ptr<LibreOfficeKitDocument, void(*)(LibreOfficeKitDocument*)>;

OfficePtr createOffice(const Request& request)
{
    const auto profileUrl = fileUrl(request.profile);
    OfficePtr office(lok_init_2(request.program.c_str(), profileUrl.c_str()),
        [](LibreOfficeKit* value) { if (value) value->pClass->destroy(value); });
    if (!office) throw ConversionError("unavailable", "LibreOfficeKit initialization failed");
#if !defined(__APPLE__) && !defined(_WIN32)
    for (const auto& font : request.fonts) registerFont(font, office.get());
#endif
    return office;
}

DocumentPtr loadDocument(const Request& request, LibreOfficeKit* office)
{
    const auto input = fileUrl(request.input);
    DocumentPtr document(office->pClass->documentLoadWithOptions(office, input.c_str(), "Batch=true,EnableMacrosExecution=false"),
        [](LibreOfficeKitDocument* value) { if (value) value->pClass->destroy(value); });
    if (!document) throw std::runtime_error(officeError(office));
    return document;
}

void convert(const Request& request)
{
    prepareEnvironment(request);
    auto office = createOffice(request);
    auto document = loadDocument(request, office.get());
    if (request.recalculate) dsh::recalculate(office.get(), document.get());
    if (request.format == "csv") dsh::selectCsvSheet(office.get(), document.get(), request.sheet.empty() ? nullptr : request.sheet.c_str());
    const auto options = std::string("{\"ReduceImageResolution\":{\"type\":\"boolean\",\"value\":\"true\"},\"MaxImageResolution\":{\"type\":\"long\",\"value\":\"")
        + std::to_string(request.resolution) + "\"},\"ExportBookmarks\":{\"type\":\"boolean\",\"value\":\"true\"}}";
    const auto output = fileUrl(request.output);
    if (!document->pClass->saveAs(document.get(), output.c_str(), request.format.c_str(),
        request.format == "pdf" ? options.c_str() : request.format == "txt" ? "UTF8,LF" : nullptr))
        throw std::runtime_error(officeError(office.get()));
    if (fs::file_size(fs::u8path(request.output)) > request.maxOutput) {
        fs::remove(fs::u8path(request.output));
        throw ConversionError("output-too-large", "Output exceeds maxOutputBytes");
    }
    char header[5] = {};
    std::ifstream(fs::u8path(request.output), std::ios::binary).read(header, sizeof header);
    if (request.format == "pdf" && std::memcmp(header, "%PDF-", sizeof header) != 0)
        throw ConversionError("invalid-output", "LibreOffice did not produce PDF bytes");
}

struct PdfApi {
    using Open = void* (*)(const unsigned char*, int, const char*);
    using Count = int (*)(void*);
    using Size = int (*)(void*, int, int*, int*);
    using Paint = int (*)(void*, unsigned char*, int, int, int, int, int, int, int);
    using Destroy = int (*)(void*);
    void* handle = nullptr;
    Open open = nullptr;
    Count count = nullptr;
    Size size = nullptr;
    Paint paint = nullptr;
    Destroy destroy = nullptr;
};

#ifdef DSH_STATIC_LOK
extern "C" void* dsh_native_pdf_open(const unsigned char*, int, const char*) noexcept;
extern "C" int dsh_native_pdf_page_count(void*) noexcept;
extern "C" int dsh_native_pdf_page_size(void*, int, int*, int*) noexcept;
extern "C" int dsh_native_pdf_paint(void*, unsigned char*, int, int, int, int, int, int, int) noexcept;
extern "C" int dsh_native_pdf_destroy(void*) noexcept;
#endif

PdfApi pdfApi(const Request& request)
{
#ifdef DSH_STATIC_LOK
    (void)request;
    return { nullptr, dsh_native_pdf_open, dsh_native_pdf_page_count, dsh_native_pdf_page_size,
        dsh_native_pdf_paint, dsh_native_pdf_destroy };
#else
    char* loadedPath = nullptr;
    void* handle = lok_dlopen(request.program.c_str(), &loadedPath);
    std::free(loadedPath);
    if (!handle) throw ConversionError("unavailable", "LibreOffice native PDFium library could not be loaded");
    PdfApi result;
    result.handle = handle;
    result.open = reinterpret_cast<PdfApi::Open>(lok_dlsym(handle, "dsh_native_pdf_open"));
    result.count = reinterpret_cast<PdfApi::Count>(lok_dlsym(handle, "dsh_native_pdf_page_count"));
    result.size = reinterpret_cast<PdfApi::Size>(lok_dlsym(handle, "dsh_native_pdf_page_size"));
    result.paint = reinterpret_cast<PdfApi::Paint>(lok_dlsym(handle, "dsh_native_pdf_paint"));
    result.destroy = reinterpret_cast<PdfApi::Destroy>(lok_dlsym(handle, "dsh_native_pdf_destroy"));
    if (!result.open || !result.count || !result.size || !result.paint || !result.destroy)
        throw ConversionError("unavailable", "LibreOffice native PDFium raster API is unavailable");
    return result;
#endif
}

std::string takeString(LibreOfficeKit* office, char* value, const char* message)
{
    if (!value) throw std::runtime_error(message);
    std::string result(value);
    office->pClass->freeError(value);
    return result;
}

void line(FILE* result, const std::string& value)
{
    std::fprintf(result, "%s\n", value.c_str());
    std::fflush(result);
}

void writePixels(const fs::path& path, const std::vector<unsigned char>& pixels)
{
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    output.exceptions(std::ios::badbit | std::ios::failbit);
    output.write(reinterpret_cast<const char*>(pixels.data()), static_cast<std::streamsize>(pixels.size()));
    output.close();
}

void renderImages(const Request& request, FILE* result)
{
    prepareEnvironment(request);
    auto office = createOffice(request);
    const bool pdf = fs::u8path(request.input).extension() == ".pdf";
    DocumentPtr document(nullptr, [](LibreOfficeKitDocument* value) { if (value) value->pClass->destroy(value); });
    PdfApi api;
    void* pdfDocument = nullptr;
    int documentType = -1;
    int tileMode = LOK_TILEMODE_RGBA;
    if (pdf) {
        api = pdfApi(request);
        std::ifstream input(fs::u8path(request.input), std::ios::binary);
        input.exceptions(std::ios::badbit | std::ios::failbit);
        std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
        pdfDocument = api.open(bytes.data(), static_cast<int>(bytes.size()), "");
        if (!pdfDocument) throw ConversionError("invalid-document", "PDFium could not open the PDF");
        const int count = api.count(pdfDocument);
        if (count < 1 || count > 100000) throw ConversionError("invalid-document", "PDFium returned an invalid page count");
        std::ostringstream ready;
        ready << "{\"ok\":true,\"kind\":\"ready\",\"documentType\":\"pdf\",\"tileMode\":0,\"pages\":[";
        for (int part = 0; part < count; ++part) {
            int width = 0, height = 0;
            if (!api.size(pdfDocument, part, &width, &height)) throw std::runtime_error("PDFium returned invalid page dimensions");
            if (part) ready << ',';
            ready << "{\"width\":" << width << ",\"height\":" << height << '}';
        }
        ready << "]}";
        line(result, ready.str());
    } else {
        document = loadDocument(request, office.get());
        document->pClass->initializeForRendering(document.get(), "{\".uno:ShowBorderShadow\":{\"type\":\"boolean\",\"value\":\"false\"}}");
        documentType = document->pClass->getDocumentType(document.get());
        tileMode = document->pClass->getTileMode(document.get());
        std::ostringstream ready;
        ready << "{\"ok\":true,\"kind\":\"ready\",\"tileMode\":" << tileMode << ',';
        if (documentType == LOK_DOCTYPE_TEXT) {
            ready << "\"documentType\":\"text\",\"writerRectangles\":"
                  << jsonString(takeString(office.get(), document->pClass->getPartPageRectangles(document.get()), "Writer returned no page rectangles"));
        } else if (documentType == LOK_DOCTYPE_PRESENTATION) {
            const int count = document->pClass->getParts(document.get());
            if (count < 1 || count > 100000) throw ConversionError("invalid-document", "Impress returned an invalid slide count");
            document->pClass->setPartMode(document.get(), LOK_PARTMODE_SLIDES);
            ready << "\"documentType\":\"presentation\",\"pages\":[";
            for (int part = 0; part < count; ++part) {
                long width = 0, height = 0;
                document->pClass->setPart(document.get(), part);
                document->pClass->getDocumentSize(document.get(), &width, &height);
                if (part) ready << ',';
                ready << "{\"width\":" << width << ",\"height\":" << height << '}';
            }
            ready << ']';
        } else if (documentType == LOK_DOCTYPE_SPREADSHEET) {
            const int count = document->pClass->getParts(document.get());
            if (count < 1 || count > 100000) throw ConversionError("invalid-document", "Calc returned an invalid sheet count");
            ready << "\"documentType\":\"spreadsheet\",\"sheets\":[";
            for (int part = 0; part < count; ++part) {
                document->pClass->setPart(document.get(), part);
                const auto info = takeString(office.get(), document->pClass->getPartInfo(document.get(), part), "Calc returned no sheet metadata");
                const auto geometry = takeString(office.get(), document->pClass->getCommandValues(document.get(), ".uno:SheetGeometryData"), "Calc returned no sheet geometry");
                if (part) ready << ',';
                ready << "{\"part\":" << part << ",\"info\":" << jsonString(info) << ",\"geometry\":" << jsonString(geometry) << '}';
            }
            ready << ']';
        } else throw ConversionError("invalid-document", "LibreOffice imported the input as an unexpected document type");
        ready << '}';
        line(result, ready.str());
    }

    std::string command;
    while (std::getline(std::cin, command)) {
        if (command == "DONE") {
            if (pdfDocument && !api.destroy(pdfDocument)) throw std::runtime_error("PDFium cleanup failed");
            pdfDocument = nullptr;
            line(result, "{\"ok\":true,\"kind\":\"done\"}");
            return;
        }
        std::istringstream fields(command);
        char kind = 0;
        int index = 0, part = 0, canvasWidth = 0, canvasHeight = 0, x = 0, y = 0, width = 0, height = 0;
        fields >> kind >> index >> part >> canvasWidth >> canvasHeight >> x >> y >> width >> height;
        if (kind != 'P' || !fields || !fields.eof() || index < 1 || canvasWidth < 1 || canvasHeight < 1
            || static_cast<unsigned long long>(canvasWidth) * canvasHeight > 16ULL * 1024 * 1024
            || x < 0 || y < 0 || width < 1 || height < 1)
            throw std::runtime_error("Invalid native raster command");
        std::vector<unsigned char> pixels(static_cast<size_t>(canvasWidth) * canvasHeight * 4);
        if (pdf) {
            if (!api.paint(pdfDocument, pixels.data(), part, canvasWidth, canvasHeight, x, y, width, height))
                throw std::runtime_error("PDFium tile paint failed");
        } else {
            if (part >= 0) document->pClass->setPart(document.get(), part);
            if (documentType == LOK_DOCTYPE_SPREADSHEET) {
                document->pClass->setClientZoom(document.get(), request.resolution * 15, request.resolution * 15, 21600, 21600);
                document->pClass->setClientVisibleArea(document.get(), x, y, width, height);
            }
            if (part < 0) document->pClass->paintTile(document.get(), pixels.data(), canvasWidth, canvasHeight, x, y, width, height);
            else document->pClass->paintPartTile(document.get(), pixels.data(), part, LOK_PARTMODE_SLIDES,
                canvasWidth, canvasHeight, x, y, width, height);
        }
        const auto path = fs::u8path(request.scratch) / ("tile-" + std::to_string(index) + ".rgba");
        writePixels(path, pixels);
        const auto utf8Path = path.u8string();
        std::ostringstream painted;
        painted << "{\"ok\":true,\"kind\":\"paint\",\"index\":" << index << ",\"path\":"
                << jsonString(std::string(utf8Path.begin(), utf8Path.end())) << ",\"width\":" << canvasWidth << ",\"height\":" << canvasHeight << '}';
        line(result, painted.str());
    }
    throw std::runtime_error("Native raster protocol ended before DONE");
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
        const auto request = parse(args);
        if (request.operation == "render-images") renderImages(request, result);
        else {
            convert(request);
            line(result, "{\"ok\":true,\"missingFonts\":[]}");
        }
    } catch (const ConversionError& error) {
        line(result, std::string("{\"ok\":false,\"code\":") + jsonString(error.code) + ",\"error\":" + jsonString(error.what()) + '}');
        code = 1;
    } catch (const std::exception& error) {
        line(result, std::string("{\"ok\":false,\"code\":\"failed\",\"error\":") + jsonString(error.what()) + '}');
        code = 1;
    } catch (...) {
        line(result, "{\"ok\":false,\"code\":\"failed\",\"error\":\"Unknown LibreOfficeKit exception\"}");
        code = 1;
    }
    std::fclose(result);
    std::_Exit(code);
}
}

#ifdef _WIN32
int wmain(int argc, wchar_t** argv)
{
    std::vector<std::string> args;
    for (int i = 0; i < argc; ++i) {
        const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
            argv[i], -1, nullptr, 0, nullptr, nullptr);
        if (length <= 0) return 2;
        std::string text(length, '\0');
        if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
                argv[i], -1, text.data(), length, nullptr, nullptr)) return 2;
        text.pop_back();
        args.push_back(std::move(text));
    }
    return execute(args);
}
#else
#ifdef DSH_STATIC_LOK
// SAL locates the executable with dlsym("main") on macOS.
__attribute__((visibility("default")))
#endif
int main(int argc, char** argv)
{
    return execute({argv, argv + argc});
}
#endif
