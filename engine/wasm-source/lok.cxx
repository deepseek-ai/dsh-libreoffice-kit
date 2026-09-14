// The browser Worker owns one LibreOfficeKit instance and serializes all calls.
// Pointers remain inside that worker's WebAssembly memory.

#include <LibreOfficeKit/LibreOfficeKit.h>

#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <exception>

extern "C" LibreOfficeKit* libreofficekit_hook_2(const char*, const char*);

namespace {

// Exception diagnostics remain available even when a LOK instance could not be
// created. The fixed buffer also records allocation failures without allocating.
char lastError[4096] = {};

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
        // Synchronous conversion runs on the browser Worker without a GUI event loop.
        ::setenv("SAL_LOK_OPTIONS", "unipoll", 1);
        return libreofficekit_hook_2(installPath, profileUrl);
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
