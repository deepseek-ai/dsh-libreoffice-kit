// The browser Worker owns one LibreOfficeKit instance and serializes all calls.
// Pointers remain inside that worker's WebAssembly memory.

#include "dsh_document_operations.hxx"

#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <exception>
#include <emscripten.h>
#include <cmath>
#include <limits>
#include <memory>
#include <stdexcept>
#include <vector>
#include <basegfx/vector/b2dsize.hxx>
#include <vcl/filter/PDFiumLibrary.hxx>
#include <vcl/pdf/PDFBitmapType.hxx>

extern "C" LibreOfficeKit* libreofficekit_hook_2(const char*, const char*);
extern "C" bool dsh_lok_yield();

EM_JS(void, dsh_lok_callback, (int type, const char* payload), {
    if (Module['dshOnCallback']) Module['dshOnCallback'](type, payload ? UTF8ToString(payload) : '');
});

namespace {

// Exception diagnostics remain available even when a LOK instance could not be
// created. The fixed buffer also records allocation failures without allocating.
char lastError[4096] = {};

// PDFium retains the original input and its library for the document lifetime.
struct PdfDocument {
    std::vector<unsigned char> bytes;
    std::shared_ptr<vcl::pdf::PDFium> library;
    std::unique_ptr<vcl::pdf::PDFiumDocument> document;
};

int checkedTwips(double points)
{
    const double twips = std::round(points * 20.0);
    if (!std::isfinite(twips) || twips < 1 || twips > std::numeric_limits<int>::max())
        throw std::runtime_error("PDF page dimensions exceed the supported coordinate range");
    return static_cast<int>(twips);
}

basegfx::B2DSize pdfPageSize(PdfDocument* pdf, int page)
{
    if (!pdf || !pdf->document || page < 0 || page >= pdf->document->getPageCount())
        throw std::runtime_error("PDF page index is outside the document");
    return pdf->document->getPageSize(page);
}

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

/** Part metadata includes Calc's actual data area, visibility, and RTL layout. */
char* dsh_lok_document_part_info(LibreOfficeKitDocument* document, int part)
{
    return guarded([&] { return document->pClass->getPartInfo(document, part); }, static_cast<char*>(nullptr));
}

/** A capture view is separate from the user's active edit/IME view. */
int dsh_lok_document_create_view(LibreOfficeKitDocument* document)
{
    return guarded([&] {
        const int view = document->pClass->createView(document);
        if (view >= 0) document->pClass->setViewReadOnly(document, view, true);
        return view;
    }, -1);
}

int dsh_lok_document_get_view(LibreOfficeKitDocument* document)
{
    return guarded([&] { return document->pClass->getView(document); }, -1);
}

int dsh_lok_document_set_view(LibreOfficeKitDocument* document, int view)
{
    return guarded([&] {
        if (view < 0) throw std::runtime_error("Invalid document view");
        document->pClass->setView(document, view);
        return document->pClass->getView(document) == view ? 1 : 0;
    }, 0);
}

int dsh_lok_document_destroy_view(LibreOfficeKitDocument* document, int view)
{
    return guarded([&] {
        if (view < 0) throw std::runtime_error("Invalid document view");
        document->pClass->destroyView(document, view);
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
        // Writer's part setter navigates to a page and moves its selection.
        // Measuring the retained reading view must have no navigation effects.
        if (document->pClass->getDocumentType(document) != LOK_DOCTYPE_TEXT)
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

/** Export any supported format after synchronous calculation and CSV selection. */
int dsh_lok_document_export(LibreOfficeKit* office, LibreOfficeKitDocument* document,
    const char* url, const char* format, const char* filterOptions, int calculate, const char* sheet)
{
    return guarded([&] {
        if (calculate) dsh::recalculate(office, document);
        if (std::strcmp(format, "csv") == 0) dsh::selectCsvSheet(office, document, sheet && sheet[0] ? sheet : nullptr);
        return document->pClass->saveAs(document, url, format, filterOptions);
    }, 0);
}

/** Open PDF directly in PDFium; never import it as an editable Draw document. */
PdfDocument* dsh_pdf_open(const unsigned char* bytes, int length, const char* password)
{
    return guarded([&] {
        if (!bytes || length < 5 || std::memcmp(bytes, "%PDF-", 5) != 0)
            throw std::runtime_error("Input does not contain a PDF header");
        auto pdf = std::make_unique<PdfDocument>();
        pdf->bytes.assign(bytes, bytes + length);
        pdf->library = vcl::pdf::PDFiumLibrary::get();
        if (!pdf->library) throw std::runtime_error("This engine has no PDFium support");
        pdf->document = pdf->library->openDocument(pdf->bytes.data(), length, OString(password ? password : ""));
        if (!pdf->document) throw std::runtime_error("PDFium could not open the PDF (invalid, unsupported, or password-protected)");
        return pdf.release();
    }, static_cast<PdfDocument*>(nullptr));
}

int dsh_pdf_page_count(PdfDocument* pdf)
{
    return guarded([&] {
        if (!pdf || !pdf->document) throw std::runtime_error("Invalid PDF handle");
        return pdf->document->getPageCount();
    }, -1);
}

/** Coordinates use int32 twips, consistent with the LOK raster ABI. */
int dsh_pdf_page_size(PdfDocument* pdf, int page, int* width, int* height)
{
    return guarded([&] {
        const auto size = pdfPageSize(pdf, page);
        *width = checkedTwips(size.getWidth());
        *height = checkedTwips(size.getHeight());
        return 1;
    }, 0);
}

/** Paint an opaque white PDF page/crop as owned straight RGBA at the requested scale. */
int dsh_pdf_paint(PdfDocument* pdf, unsigned char* buffer, int page, int canvasWidth,
                  int canvasHeight, int x, int y, int width, int height)
{
    return guarded([&] {
        const auto size = pdfPageSize(pdf, page);
        const int pageWidth = checkedTwips(size.getWidth());
        const int pageHeight = checkedTwips(size.getHeight());
        if (!buffer || canvasWidth < 1 || canvasHeight < 1
            || static_cast<long long>(canvasWidth) * canvasHeight > 16 * 1024 * 1024
            || x < 0 || y < 0 || width < 1 || height < 1
            || static_cast<long long>(x) + width > pageWidth
            || static_cast<long long>(y) + height > pageHeight)
            throw std::runtime_error("PDF tile dimensions exceed their bounds");
        const double scaleX = static_cast<double>(canvasWidth) / width;
        const double scaleY = static_cast<double>(canvasHeight) / height;
        const double fullWidth = std::round(pageWidth * scaleX);
        const double fullHeight = std::round(pageHeight * scaleY);
        if (fullWidth > std::numeric_limits<int>::max() || fullHeight > std::numeric_limits<int>::max())
            throw std::runtime_error("PDF scaled page exceeds the coordinate range");
        auto loadedPage = pdf->document->openPage(page);
        if (!loadedPage) throw std::runtime_error("PDFium could not load the selected page");
        int actualWidth = canvasWidth;
        int actualHeight = canvasHeight;
        auto bitmap = pdf->library->createBitmap(actualWidth, actualHeight, 1);
        if (!bitmap || actualWidth != canvasWidth || actualHeight != canvasHeight
            || bitmap->getFormat() != vcl::pdf::PDFBitmapType::BGRA)
            throw std::runtime_error("PDFium could not allocate the requested tile");
        bitmap->fillRect(0, 0, canvasWidth, canvasHeight, 0xffffffff);
        bitmap->renderPageBitmap(pdf->document.get(), loadedPage.get(),
            -static_cast<int>(std::round(x * scaleX)), -static_cast<int>(std::round(y * scaleY)),
            static_cast<int>(fullWidth), static_cast<int>(fullHeight));
        const auto* pixels = bitmap->getBuffer();
        const int stride = bitmap->getStride();
        if (!pixels || stride < canvasWidth * 4) throw std::runtime_error("PDFium returned an invalid bitmap");
        for (int row = 0; row < canvasHeight; ++row) {
            for (int col = 0; col < canvasWidth; ++col) {
                const auto* source = pixels + row * stride + col * 4;
                auto* target = buffer + (row * canvasWidth + col) * 4;
                target[0] = source[2]; target[1] = source[1]; target[2] = source[0]; target[3] = 255;
            }
        }
        return 1;
    }, 0);
}

int dsh_pdf_destroy(PdfDocument* pdf)
{
    return guarded([&] { delete pdf; return 1; }, 0);
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
