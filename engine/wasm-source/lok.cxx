// The browser Worker owns one LibreOfficeKit instance and serializes all calls.
// Pointers remain inside that worker's WebAssembly memory.

#define LOK_USE_UNSTABLE_API
#include <LibreOfficeKit/LibreOfficeKit.h>
#include <LibreOfficeKit/LibreOfficeKitEnums.h>

#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <exception>
#include <emscripten.h>

extern "C" LibreOfficeKit* libreofficekit_hook_2(const char*, const char*);
extern "C" bool dsh_lok_yield();

EM_JS(void, dsh_lok_callback, (int type, const char* payload), {
    if (Module['dshOnCallback']) Module['dshOnCallback'](type, payload ? UTF8ToString(payload) : '');
});

namespace {

// Exception diagnostics remain available even when a LOK instance could not be
// created. The fixed buffer also records allocation failures without allocating.
char lastError[4096] = {};

void editorCallback(int type, const char* payload, void*)
{
    dsh_lok_callback(type, payload);
}

template <typename Result, typename Function>
Result guarded(Function function, Result failure) noexcept
{
    lastError[0] = '\0';
    try {
        return function();
    } catch (const std::exception& error) {
        std::snprintf(lastError, sizeof(lastError), "%s", error.what());
    } catch (...) {
        std::snprintf(lastError, sizeof(lastError), "%s", "LibreOfficeKit raised an unknown C++ exception");
    }
    return failure;
}

char* copyLastError() noexcept
{
    const auto length = std::strlen(lastError) + 1;
    auto* result = static_cast<char*>(std::malloc(length));
    if (result != nullptr) std::memcpy(result, lastError, length);
    return result;
}

}

extern "C" {

/**
 * Initializes the module's single office instance after its filesystem is loaded.
 * installPath names the virtual program directory; profileUrl is a file URL.
 * Returns null when initialization fails. The caller must not initialize twice.
 */
LibreOfficeKit* dsh_lok_initialize(const char* installPath, const char* profileUrl)
{
    return guarded([&] {
        // The owning Worker drives nonblocking event slices for editing sessions.
        ::setenv("SAL_LOK_OPTIONS", "unipoll", 1);
        auto* office = libreofficekit_hook_2(installPath, profileUrl);
        if (office != nullptr)
            office->pClass->setOptionalFeatures(office, LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK);
        return office;
    }, static_cast<LibreOfficeKit*>(nullptr));
}

/** Loads a virtual file URL with LOK options; returns null on load failure. */
LibreOfficeKitDocument* dsh_lok_document_load(LibreOfficeKit* office, const char* url,
                                             const char* options)
{
    return guarded([&] {
        return office->pClass->documentLoadWithOptions(office, url, options);
    }, static_cast<LibreOfficeKitDocument*>(nullptr));
}

/** Writes PDF to a virtual file URL; returns nonzero only when LOK reports success. */
int dsh_lok_document_save_pdf(LibreOfficeKitDocument* document, const char* url,
                              const char* filterOptions)
{
    return guarded([&] {
        return document->pClass->saveAs(document, url, "pdf", filterOptions);
    }, 0);
}

/** Export an editable snapshot in its original Office format. */
int dsh_lok_document_save(LibreOfficeKitDocument* document, const char* url, const char* format)
{
    return guarded([&] { return document->pClass->saveAs(document, url, format, "TakeOwnership"); }, 0);
}

/** Register the single owning Worker's document notifications. */
int dsh_lok_document_listen(LibreOfficeKitDocument* document)
{
    return guarded([&] { document->pClass->registerCallback(document, editorCallback, nullptr); return 1; }, 0);
}

/** Process pending VCL events and timers without blocking the Worker message loop. */
int dsh_lok_pump()
{
    return guarded([&] { return dsh_lok_yield() ? 1 : 0; }, -1);
}

int dsh_lok_document_key(LibreOfficeKitDocument* document, int type, int character, int key)
{
    return guarded([&] { document->pClass->postKeyEvent(document, type, character, key); return 1; }, 0);
}

int dsh_lok_document_mouse(LibreOfficeKitDocument* document, int type, int x, int y,
                           int count, int buttons, int modifiers)
{
    return guarded([&] { document->pClass->postMouseEvent(document, type, x, y, count, buttons, modifiers); return 1; }, 0);
}

int dsh_lok_document_composition(LibreOfficeKitDocument* document, int type, const char* text)
{
    return guarded([&] { document->pClass->postWindowExtTextInputEvent(document, 0, type, text); return 1; }, 0);
}

int dsh_lok_document_command(LibreOfficeKitDocument* document, const char* command, const char* arguments)
{
    return guarded([&] { document->pClass->postUnoCommand(document, command, arguments, true); return 1; }, 0);
}

char* dsh_lok_document_command_values(LibreOfficeKitDocument* document, const char* command)
{
    return guarded([&] { return document->pClass->getCommandValues(document, command); }, static_cast<char*>(nullptr));
}

int dsh_lok_document_paste(LibreOfficeKitDocument* document, const char* mime, const char* text, int size)
{
    return guarded([&] { return document->pClass->paste(document, mime, text, size); }, false) ? 1 : 0;
}

char* dsh_lok_document_selection(LibreOfficeKitDocument* document)
{
    return guarded([&] { return document->pClass->getTextSelection(document, "text/plain;charset=utf-8", nullptr); }, static_cast<char*>(nullptr));
}

int dsh_lok_document_part(LibreOfficeKitDocument* document, int part)
{
    return guarded([&] { document->pClass->setPart(document, part); return 1; }, 0);
}

char* dsh_lok_document_part_name(LibreOfficeKitDocument* document, int part)
{
    return guarded([&] { return document->pClass->getPartName(document, part); }, static_cast<char*>(nullptr));
}

int dsh_lok_document_viewport(LibreOfficeKitDocument* document, int pixels, int twips,
                             int x, int y, int width, int height)
{
    return guarded([&] {
        document->pClass->setClientZoom(document, pixels, pixels, twips, twips);
        document->pClass->setClientVisibleArea(document, x, y, width, height);
        return 1;
    }, 0);
}

/** Initializes read-only Writer pages or normal Impress slides for tiled rendering. */
int dsh_lok_document_initialize_rendering(LibreOfficeKitDocument* document)
{
    return guarded([&] {
        document->pClass->initializeForRendering(document, "{\".uno:ShowBorderShadow\":{\"type\":\"boolean\",\"value\":\"false\"}}");
        if (document->pClass->getDocumentType(document) == LOK_DOCTYPE_PRESENTATION)
            document->pClass->setPartMode(document, LOK_PARTMODE_SLIDES);
        return 1;
    }, 0);
}

/** Returns a LibreOfficeKitDocumentType, or -1 when the query throws. */
int dsh_lok_document_type(LibreOfficeKitDocument* document)
{
    return guarded([&] { return document->pClass->getDocumentType(document); }, -1);
}

/** Returns the number of Impress slides, or -1 when the query throws. */
int dsh_lok_document_parts(LibreOfficeKitDocument* document)
{
    return guarded([&] { return document->pClass->getParts(document); }, -1);
}

/** Returns owned Writer page rectangles in twips; free with the exported free function. */
char* dsh_lok_document_page_rectangles(LibreOfficeKitDocument* document)
{
    return guarded([&] { return document->pClass->getPartPageRectangles(document); }, static_cast<char*>(nullptr));
}

/** Writes the selected slide's twip dimensions into two wasm32 longs. */
int dsh_lok_document_size(LibreOfficeKitDocument* document, int part, long* width, long* height)
{
    return guarded([&] {
        document->pClass->setPart(document, part);
        document->pClass->getDocumentSize(document, width, height);
        return 1;
    }, 0);
}

/** Returns the LibreOfficeKitTileMode, or -1 when the query throws. */
int dsh_lok_document_tile_mode(LibreOfficeKitDocument* document)
{
    return guarded([&] { return document->pClass->getTileMode(document); }, -1);
}

/** Paints twip coordinates into a premultiplied RGBA/BGRA buffer; part -1 selects Writer. */
int dsh_lok_document_paint(LibreOfficeKitDocument* document, unsigned char* buffer, int part,
                         int canvasWidth, int canvasHeight, int x, int y, int width, int height)
{
    return guarded([&] {
        if (part < 0)
            document->pClass->paintTile(document, buffer, canvasWidth, canvasHeight, x, y, width, height);
        else
            document->pClass->paintPartTile(document, buffer, part, LOK_PARTMODE_SLIDES,
                                            canvasWidth, canvasHeight, x, y, width, height);
        return 1;
    }, 0);
}

/** Releases a document after conversion; returns zero when destruction throws. */
int dsh_lok_document_destroy(LibreOfficeKitDocument* document)
{
    return guarded([&] {
        document->pClass->destroy(document);
        return 1;
    }, 0);
}

/**
 * Returns an owned UTF-8 error string, released with the exported free function.
 * A null office reads shim exceptions after initialization or teardown failure.
 * Call before another operation; exception messages are limited to 4095 bytes.
 */
char* dsh_lok_error(LibreOfficeKit* office)
{
    if (lastError[0] != '\0') return copyLastError();
    auto* error = guarded([&] {
        return office == nullptr ? nullptr : office->pClass->getError(office);
    }, static_cast<char*>(nullptr));
    return error == nullptr && lastError[0] != '\0' ? copyLastError() : error;
}

/**
 * Releases the office after all documents are destroyed; returns zero on exception.
 * No later operations may use the office, including after destruction fails.
 */
int dsh_lok_destroy(LibreOfficeKit* office)
{
    return guarded([&] {
        office->pClass->destroy(office);
        return 1;
    }, 0);
}

}
