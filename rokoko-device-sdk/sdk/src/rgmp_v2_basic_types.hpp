#pragma once

#include <bit>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <stdexcept>
#include <string_view>
#include <type_traits>
#include <vector>

namespace rkk::rgmp::v2 {

// Single library-wide exception type. Every throw in protocol_v2 routes
// through this so consumers can wrap calls in one catch site.
//
// Inherits from std::runtime_error so existing `catch (std::runtime_error&)`
// or `catch (std::exception&)` sites keep working without change. Lookup
// failures (unknown stream key, out-of-range group_id) and shape/validation
// failures all surface as `error` — distinguish via `what()` if needed.
class error : public std::runtime_error {
  public:
    using std::runtime_error::runtime_error;
};

// The wire format mandates IEEE-754 little-endian for FLOAT and DOUBLE. These
// asserts refuse to compile on hosts whose float/double aren't IEEE-754, since
// `bit_cast` would otherwise reinterpret LE-decoded bits as some non-IEEE
// format.
static_assert(sizeof(float) == 4, "float must be 4 bytes for LE payload codec");
static_assert(sizeof(double) == 8, "double must be 8 bytes for LE payload codec");
static_assert(
    std::numeric_limits<float>::is_iec559,
    "RGMP v2 requires IEEE-754 single-precision float"
);
static_assert(
    std::numeric_limits<double>::is_iec559,
    "RGMP v2 requires IEEE-754 double-precision double"
);

enum class msg_prefix : uint32_t {
    stream_definition = 1,
    data              = 2,
    device_disconnect = 3,
};
static_assert(sizeof(msg_prefix) == sizeof(uint32_t));

enum class timestamp_epoch_t : uint8_t {
    unix_epoch,
    device_boot,
};

struct msg_header {
    msg_prefix prefix;
    uint32_t   msg_len;
};

// Guards against accidental field additions; not a wire-layout guarantee —
// every byte is serialized through write_*_le, never via memcpy of the struct.
static_assert(sizeof(msg_header) == 8);

[[nodiscard]] char const* msg_prefix_to_string(msg_prefix);

void write_u32_le(uint32_t value, std::span<std::byte, 4> out) noexcept;
void write_u64_le(uint64_t value, std::span<std::byte, 8> out) noexcept;
[[nodiscard]] uint32_t read_u32_le(std::span<std::byte const, 4> in) noexcept;
[[nodiscard]] uint64_t read_u64_le(std::span<std::byte const, 8> in) noexcept;

void write_msg_header(msg_header const& header, std::span<std::byte, 8> out);
[[nodiscard]] msg_header read_msg_header(std::span<std::byte const, 8> in);

// Wraps `payload` in the canonical 8-byte outer header (msg_prefix + msg_len)
// and returns the resulting wire-ready bytes. Throws rkk::rgmp::v2::error if
// payload.size() exceeds UINT32_MAX, since msg_len is u32.
[[nodiscard]] std::vector<std::byte>
frame_message(msg_prefix prefix, std::span<std::byte const> payload);

// Sugar overload for JSON / text payloads. Equivalent to wrapping the bytes
// of `payload` via the span overload.
[[nodiscard]] std::vector<std::byte>
frame_message(msg_prefix prefix, std::string_view payload);

namespace detail {
template <typename T>
inline constexpr bool is_wire_codec_type_v =
    std::is_same_v<T, int32_t> or std::is_same_v<T, uint32_t>
    or std::is_same_v<T, int64_t> or std::is_same_v<T, uint64_t>
    or std::is_same_v<T, float> or std::is_same_v<T, double>;
} // namespace detail

template <typename T>
[[nodiscard]] T read_le(std::span<std::byte const, sizeof(T)> in) noexcept
{
    static_assert(
        detail::is_wire_codec_type_v<T>,
        "read_le<T> only supports INT32 / UINT32 / INT64 / UINT64 / FLOAT / "
        "DOUBLE"
    );
    if constexpr (std::is_same_v<T, uint32_t>) {
        return read_u32_le(in);
    }
    else if constexpr (std::is_same_v<T, uint64_t>) {
        return read_u64_le(in);
    }
    else if constexpr (std::is_same_v<T, int32_t>) {
        return std::bit_cast<int32_t>(read_u32_le(in));
    }
    else if constexpr (std::is_same_v<T, int64_t>) {
        return std::bit_cast<int64_t>(read_u64_le(in));
    }
    else if constexpr (std::is_same_v<T, float>) {
        return std::bit_cast<float>(read_u32_le(in));
    }
    else { // double
        return std::bit_cast<double>(read_u64_le(in));
    }
}

template <typename T>
void write_le(T value, std::span<std::byte, sizeof(T)> out) noexcept
{
    static_assert(
        detail::is_wire_codec_type_v<T>,
        "write_le<T> only supports INT32 / UINT32 / INT64 / UINT64 / FLOAT / "
        "DOUBLE"
    );
    if constexpr (std::is_same_v<T, uint32_t>) {
        write_u32_le(value, out);
    }
    else if constexpr (std::is_same_v<T, uint64_t>) {
        write_u64_le(value, out);
    }
    else if constexpr (std::is_same_v<T, int32_t>) {
        write_u32_le(std::bit_cast<uint32_t>(value), out);
    }
    else if constexpr (std::is_same_v<T, int64_t>) {
        write_u64_le(std::bit_cast<uint64_t>(value), out);
    }
    else if constexpr (std::is_same_v<T, float>) {
        write_u32_le(std::bit_cast<uint32_t>(value), out);
    }
    else { // double
        write_u64_le(std::bit_cast<uint64_t>(value), out);
    }
}

} // namespace rkk::rgmp::v2
