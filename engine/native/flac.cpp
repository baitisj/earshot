// A C entry point over HamFLAC's in-memory encoder, for the engine's Rust side.
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <span>
#include <string>

#include "hamflac/hamflac.hpp"

extern "C" int earshot_flac_encode(const std::int16_t* samples, std::size_t count, int sample_rate,
                                   std::uint8_t** out, std::size_t* out_len) noexcept {
    try {
        hamflac::EncodeOptions options;
        // Speech at 8 kHz packs best in short blocks; the 48 kHz discriminator keeps the default.
        options.blocksize = sample_rate <= 16000 ? 1024 : 4096;
        const std::string encoded =
            hamflac::encode(std::span<const std::int16_t>(samples, count), 1, sample_rate, options);
        auto* bytes = static_cast<std::uint8_t*>(std::malloc(encoded.size()));
        if (!bytes) return -1;
        std::memcpy(bytes, encoded.data(), encoded.size());
        *out = bytes;
        *out_len = encoded.size();
        return 0;
    } catch (...) {
        return -1;
    }
}

extern "C" void earshot_flac_free(std::uint8_t* bytes) noexcept { std::free(bytes); }
