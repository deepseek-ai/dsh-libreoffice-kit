// Links the built engine's SAL archive; each input is a URL and its Windows path.
#include <osl/file.h>
#include <rtl/ustring.h>
#include <windows.h>
#include <iostream>
#include <string>
#include <vector>

static std::wstring wide(const std::string& text)
{
    int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), text.size(), nullptr, 0);
    std::wstring result(size, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), text.size(), result.data(), size);
    return result;
}

static std::wstring full(const std::wstring& path)
{
    std::vector<wchar_t> buffer(32768);
    DWORD length = GetFullPathNameW(path.c_str(), buffer.size(), buffer.data(), nullptr);
    if (!length || length >= buffer.size()) return L"";
    std::wstring result(buffer.data(), length);
    if (result.starts_with(L"\\\\?\\UNC\\")) result = L"\\\\" + result.substr(8);
    else if (result.starts_with(L"\\\\?\\")) result.erase(0, 4);
    return result;
}

static void hex(const std::wstring& text)
{
    const char* digits = "0123456789abcdef";
    for (wchar_t c : text)
        for (int shift : {12, 8, 4, 0}) std::cout << digits[(c >> shift) & 15];
}

int main()
{
    std::string line;
    while (std::getline(std::cin, line))
    {
        auto separator = line.find('\t');
        if (separator == std::string::npos) return 2;
        auto url = wide(line.substr(0, separator));
        auto original = wide(line.substr(separator + 1));
        rtl_uString* input = nullptr;
        rtl_uString* output = nullptr;
        rtl_uString_newFromStr_WithLength(&input, reinterpret_cast<const sal_Unicode*>(url.data()), url.size());
        auto error = osl_getSystemPathFromFileURL(input, &output);
        std::wstring actual;
        if (output) actual.assign(reinterpret_cast<const wchar_t*>(output->buffer), output->length);
        auto expected = full(original);
        bool equal = !expected.empty() && _wcsicmp(full(actual).c_str(), expected.c_str()) == 0;
        HANDLE file = CreateFileW(actual.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                  nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        DWORD openError = file == INVALID_HANDLE_VALUE ? GetLastError() : 0;
        char marker[8] = {};
        DWORD read = 0;
        bool content = file != INVALID_HANDLE_VALUE && ReadFile(file, marker, 7, &read, nullptr)
                       && read == 7 && std::string(marker, 7) == "fuzz 42";
        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        std::cout << error << '\t' << equal << '\t' << openError << '\t' << content << '\t';
        hex(actual);
        std::cout << '\t';
        hex(expected);
        std::cout << '\n';
        rtl_uString_release(input);
        if (output) rtl_uString_release(output);
    }
}
