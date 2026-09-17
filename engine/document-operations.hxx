// Operations shared by the native helper and the Node WASM shim.
#pragma once
#ifndef LOK_USE_UNSTABLE_API
#define LOK_USE_UNSTABLE_API
#endif
#include <LibreOfficeKit/LibreOfficeKit.h>
#include <LibreOfficeKit/LibreOfficeKitEnums.h>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <string>

namespace dsh {
inline void checkError(LibreOfficeKit* office)
{
    std::unique_ptr<char, decltype(&std::free)> error(office->pClass->getError(office), std::free);
    if (error && error.get()[0]) throw std::runtime_error(error.get());
}

// The model API returns after the full calculation, before any output is saved.
inline void recalculate(LibreOfficeKit* office, LibreOfficeKitDocument* document)
{
    if (document->pClass->getDocumentType(document) != LOK_DOCTYPE_SPREADSHEET)
        throw std::runtime_error("Recalculation requires a spreadsheet");
    if (!LIBREOFFICEKIT_DOCUMENT_HAS(document, calculateAll))
        throw std::runtime_error("Installed engine does not support synchronous workbook calculation");
    if (!document->pClass->calculateAll(document)) {
        checkError(office);
        throw std::runtime_error("Workbook calculation did not complete");
    }
}

inline void selectCsvSheet(LibreOfficeKit* office, LibreOfficeKitDocument* document, const char* sheet)
{
    if (document->pClass->getDocumentType(document) != LOK_DOCTYPE_SPREADSHEET)
        throw std::runtime_error("CSV export requires a spreadsheet");
    const int count = document->pClass->getParts(document);
    if (!sheet && count != 1) throw std::runtime_error("CSV export of a multi-sheet workbook requires --sheet with an exact worksheet name");
    int selected = sheet ? -1 : 0;
    if (sheet) {
        for (int i = 0; i < count; ++i) {
            std::unique_ptr<char, decltype(&std::free)> name(document->pClass->getPartName(document, i), std::free);
            if (name && std::string(name.get()) == sheet) { selected = i; break; }
        }
    }
    if (selected < 0) throw std::runtime_error("CSV worksheet was not found");
    document->pClass->setPart(document, selected);
    checkError(office);
    if (document->pClass->getPart(document) != selected) throw std::runtime_error("Could not select the CSV worksheet");
}
}
